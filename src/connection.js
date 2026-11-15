import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, client, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import { promptFailure } from './acp-result.js'

/** ACP v1 over a DSH-managed subprocess. */
/** Race an operation with a deadline, releasing the listener at settlement. */
async function until(start, signal) {
	signal.throwIfAborted();
	const aborted = Promise.withResolvers();
	const cancel = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	try {
		return await Promise.race([start(), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
function modelConfig(options) {
	return options?.find((option) => option.type === "select" && option.category === "model") ?? options?.find((option) => option.type === "select" && option.category == null && option.id === "model");
}
/**
* Expand configured environment entries for one child process.
* A bare name passes the DSH host value through; `NAME=VALUE` pins a literal.
* @param entries - environment names and assignments from the agent row.
* @returns the environment object handed to the subprocess.
*/
export function commandEnvironment(entries) {
	const environment = {};
	for (const entry of entries) {
		const at = entry.indexOf("=");
		if (at < 0) environment[entry] = process.env[entry];
		else environment[entry.slice(0, at)] = entry.slice(at + 1);
	}
	return environment;
}
/** Live connection and one ACP Session. Its owner retires it after any uncertain prompt. */
export class AcpConnection {
	cancelGraceMs;
	mcpTools;
	connection;
	sessionId;
	mcpName;
	model;
	initialModel;
	permissionConfig;
	modes;
	auth;
	promptSignal;
	permission;
	imageInput = false;
	pendingMcpCalls = /* @__PURE__ */ new Set();
	output;
	thought;
	outputError;
	closeWork;
	closed = false;
	child;
	constructor(subprocess, command, cwd, cancelGraceMs, mcpTools) {
		this.cancelGraceMs = cancelGraceMs;
		this.mcpTools = mcpTools;
		this.authMode = command.authMode;
		this.authMethod = command.auth;
		this.title = command.title ?? command.id;
		this.auth = command.authMode === 'existing' ? undefined : command.auth;
		const env = commandEnvironment(command.env);
		this.child = subprocess.spawn({
			argv: [command.command, ...command.args],
			cwd,
			env,
			graceMs: cancelGraceMs,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: { maxBytes: 8192 }
			}
		});
		this.child.done.then(() => {
			this.closed = true;
		}, () => {
			this.closed = true;
		});
		const { stdin, stdout } = this.child;
		if (stdin === void 0 || stdout === void 0) {
			this.child.terminate();
			throw new Error("ACP subprocess did not provide protocol pipes.");
		}
		let lineBytes = 0;
		const input = Readable.toWeb(stdout).pipeThrough(new TransformStream({ transform: (chunk, controller) => {
			for (const byte of chunk) {
				lineBytes = byte === 10 ? 0 : lineBytes + 1;
				if (lineBytes > 1024 * 1024) {
					this.child.terminate();
					controller.error(/* @__PURE__ */ new Error("ACP response line exceeds 1 MiB."));
					return;
				}
			}
			controller.enqueue(chunk);
		} }));
		this.connection = client({ name: "deepseek-harness-agent-hub" }).onNotification(methods.client.session.update, ({ params }) => {
			if (params.sessionId !== this.sessionId) return Promise.resolve();
			const update = params.update;
			if (update.sessionUpdate === "config_option_update") {
				this.model = modelConfig(update.configOptions);
				this.permissionConfig = update.configOptions?.find((o) => o.type === 'select' && (o.category === 'mode' || o.id === 'mode'));
			}
			if (this.promptSignal?.aborted !== false) return Promise.resolve();
			if (update.sessionUpdate === "tool_call" && update._meta?.["is_mcp_tool_call"] === true) {
				const input = update.rawInput;
				if (this.mcpName !== void 0 && typeof input === "object" && input !== null && "server" in input && input.server === this.mcpName && "tool" in input && typeof input.tool === "string" && this.mcpTools.has(input.tool) && this.pendingMcpCalls.size < 64) this.pendingMcpCalls.add(update.toolCallId);
			}
			if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) this.pendingMcpCalls.delete(update.toolCallId);
			if (this.outputError === void 0 && update.content?.type === "text") {
				if (update.sessionUpdate === "agent_message_chunk") this.emit(this.output, update.content.text);
				else if (update.sessionUpdate === "agent_thought_chunk") this.emit(this.thought, update.content.text);
			}
			return Promise.resolve();
		}).onRequest(methods.client.session.requestPermission, async ({ params }) => {
			if (this.promptSignal?.aborted === false && params.sessionId === this.sessionId && params._meta?.["is_mcp_tool_approval"] === true && this.pendingMcpCalls.delete(params.toolCall.toolCallId)) {
				const allow = params.options.find((option) => option.kind === "allow_once");
				if (allow !== void 0) return Promise.resolve({ outcome: {
					outcome: "selected",
					optionId: allow.optionId
				} });
			}
			if (this.promptSignal?.aborted === false && params.sessionId === this.sessionId && this.permission) {
				const signal = this.promptSignal;
				const ask = this.permission;
				let outcome;
				try { outcome = await until(() => ask(params, signal), signal); }
				catch { outcome = 'unavailable'; }
				if (outcome === 'allowed-once' && this.promptSignal === signal && !signal.aborted) {
					const allow = params.options.find((option) => option.kind === 'allow_once');
					if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
				}
			}
			const reject = params.options.find((option) => option.kind === "reject_once");
			return Promise.resolve(reject === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: {
				outcome: "selected",
				optionId: reject.optionId
			} });
		}).connect(ndJsonStream(Writable.toWeb(stdin), input));
		this.connection.closed.then(() => {
			this.closed = true;
		});
	}
	get available() {
		return !this.closed;
	}
	/**
	* Deliver one streamed fragment to its sink, remembering a consumer failure.
	* @param sink - text or reasoning sink configured by the owning prompt.
	* @param text - fragment for that sink.
	*/
	emit(sink, text) {
		if (sink === undefined) return;
		try {
			sink(text);
		} catch (error) {
			this.outputError = error;
			this.child.terminate();
		}
	}
	/** Initialize once; interactive login is a separate, explicitly requested operation. */
	async initialize(signal) {
		if (this.initialized) return;
		this.stage = 'initialize';
		const result = await until(() => this.connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
			clientInfo: { name: 'dsh-agent-hub', title: 'DSH Agent Hub', version: '0.8.3' },
		}), signal);
		if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported ACP protocol version.');
		this.imageInput = result.agentCapabilities?.promptCapabilities?.image === true;
		this.httpMcp = result.agentCapabilities?.mcpCapabilities?.http === true;
		this.sessionCapabilities = result.agentCapabilities?.sessionCapabilities ?? {};
		this.authMethods = result.authMethods ?? [];
		this.initialized = true;
	}
	async authenticate(signal, method = this.authMethod) {
		await this.initialize(signal);
		const available = this.authMethods.map((m) => m.id);
		method ??= ['internal', 'qodercli-login', 'qoderclicn-login', 'chat-gpt'].find((id) => available.includes(id));
		if (!method && available.length === 1) method = available[0];
		if (!method || (available.length && !available.includes(method))) throw promptFailure({ errorMessage: { code: -32000 } }, this.title);
		this.stage = 'authenticate';
		try { await until(() => this.connection.agent.request(methods.agent.authenticate, { methodId: method }), signal); }
		catch (error) {
			if (error instanceof RequestError) throw promptFailure({ errorMessage: { code: error.code, message: error.message, data: error.data } }, this.title);
			throw error;
		}
	}
	/** A new ACP session for each DSH request avoids sharing another conversation's history. */
	async newSession(cwd, mcp, signal) {
		await this.initialize(signal);
		if (mcp !== undefined && !this.httpMcp) throw new Error('This ACP agent does not advertise HTTP MCP.');
		try {
			if (this.sessionId && this.sessionCapabilities.close) {
				this.stage = 'session/close';
				await until(() => this.connection.agent.request('session/close', { sessionId: this.sessionId }), signal);
			}
			this.sessionId = undefined;
			this.model = undefined;
			this.stage = 'session/new';
			const session = await until(() => this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: mcp === undefined ? [] : [mcp] }), signal);
			if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('ACP returned an empty session id.');
			this.sessionId = session.sessionId;
			this.mcpName = mcp?.name;
			this.model = modelConfig(session.configOptions);
			this.initialModel = this.model?.currentValue;
			this.permissionConfig = session.configOptions?.find((o) => o.type === 'select' && (o.category === 'mode' || o.id === 'mode'));
			this.modes = session.modes;
		} catch (error) {
			if (error instanceof RequestError) throw promptFailure({ errorMessage: { code: error.code, message: error.message, data: error.data } }, this.title);
			throw error;
		}
	}
	async open(cwd, mcp, signal) {
		await this.initialize(signal);
		if (this.auth !== undefined) await this.authenticate(signal, this.auth);
		await this.newSession(cwd, mcp, signal);
	}
	/** Return the models advertised for this ACP Session. */
	get models() {
		return this.model?.options.flatMap((option) => "options" in option ? option.options : [option]) ?? [];
	}
	/**
	* Apply an explicit selection, or restore the model initially chosen by the agent.
	* @param requested - advertised model id, or undefined for the agent default.
	* @param signal - owning turn and configuration deadline.
	*/
	async selectModel(requested, signal) {
		const value = requested ?? this.initialModel;
		const model = this.model;
		if (value === void 0 || model?.currentValue === value) return;
		if (model === void 0 || !this.models.some((option) => option.value === value)) throw new Error("The ACP agent no longer offers the selected model. Choose a model from its current list.");
		const sessionId = this.sessionId;
		if (sessionId === void 0) throw new Error("ACP session is unavailable.");
		const response = await until(() => this.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId: model.id,
			value
		}), signal);
		this.model = modelConfig(response.configOptions);
		if (this.model?.currentValue !== value) throw new Error("The ACP agent did not confirm the selected model.");
	}
	/** Select only a mode actually advertised by this CLI; never guess an approval flag. */
	async selectPermissionMode(value, signal) {
		if (!value) return;
		const option = this.permissionConfig;
		if (option) {
			if (option.currentValue === value) return;
			const choices = option.options.flatMap((o) => o.options ?? [o]);
			if (!choices.some((o) => o.value === value)) throw new Error(`ACP permission mode ${value} is unavailable; available: ${choices.map((o) => o.value).join(', ')}`);
			const response = await until(() => this.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: option.id, value }), signal);
			this.permissionConfig = response.configOptions?.find((o) => o.id === option.id);
			if (this.permissionConfig?.currentValue !== value) throw new Error('ACP agent did not confirm the permission mode.');
			return;
		}
		if (!this.modes?.availableModes?.some((m) => m.id === value)) throw new Error(`This ACP agent does not advertise permission mode ${value}.`);
		await until(() => this.connection.agent.request(methods.agent.session.setMode, { sessionId: this.sessionId, modeId: value }), signal);
	}

	/**
	* Send one prompt. On cancellation, notify the ACP agent before process cleanup.
	* @param text - complete prompt text.
	* @param handlers - streamed text and reasoning sinks plus the owning abort signal.
	*/
	async prompt(text, { onText, onThought, onPermission, signal }) {
		const sessionId = this.sessionId;
		if (sessionId === void 0 || this.closed) throw new Error("ACP session is unavailable.");
		signal.throwIfAborted();
		const agent = this.connection.agent;
		const prompt = typeof text === 'string' ? [{ type: 'text', text }] : text;
		if (prompt.some((block) => block.type === 'image') && !this.imageInput) throw new Error('This ACP agent does not advertise image prompt support.');
		this.permission = onPermission;
		this.promptSignal = signal;
		this.output = onText;
		this.thought = onThought;
		this.outputError = void 0;
		this.stage = 'session/prompt';
		const pending = agent.request(methods.agent.session.prompt, {
			sessionId,
			prompt
		});
		try {
			const result = await until(() => pending, signal);
			if (this.outputError !== void 0) throw this.outputError;
			const failure = promptFailure(result, this.title);
			if (failure) throw failure;
			return result.stopReason;
		} catch (error) {
			if (signal.aborted && !this.closed) {
				agent.notify(methods.agent.session.cancel, { sessionId }).catch((_error) => {});
				try {
					await until(() => pending, AbortSignal.timeout(this.cancelGraceMs));
				} catch (_error) {}
			}
			if (this.outputError !== void 0) throw this.outputError;
			if (error instanceof RequestError) throw promptFailure({ errorMessage: { code: error.code, message: error.message, data: error.data } }, this.title);
			throw error;
		} finally {
			this.permission = void 0;
			this.promptSignal = void 0;
			this.pendingMcpCalls.clear();
			this.output = void 0;
			this.thought = void 0;
		}
	}
	/** Wait for the managed range, including children, to exit within the configured grace. */
	close() {
		return this.closeWork ??= (async () => {
			this.closed = true;
			this.child.terminate();
			this.connection.close();
			if (!await this.child.waitForExit(AbortSignal.timeout(this.cancelGraceMs * 2))) throw new Error("ACP process range did not exit before the cleanup deadline.");
		})();
	}
}
