import { Gateway } from './gateway.js'
import { DshTools, recordDshCall, toolGuide } from './tool-bridge.js'
import { permissionHandler } from './approval.js'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { HarnessError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { AcpConnection } from './connection.js'
import { projectPrompt } from './context.js'
import { createBlockWriter } from './stream-blocks.js'

/** ACP text streaming through the public LLM waterfall in released DSH hosts. */
/**
* Stream a fresh ACP prompt from the current released AgentLoop step. The host commits its own transcript.
* @param ctx - installed DSH services.
* @param config - process and transfer limits.
* @param command - configured ACP command for the selected provider.
* @param request - immutable root loop model request.
* @param shutdown - plugin lifetime signal.
* @param active - operations awaited when the plugin unloads.
* @returns a DSH stream containing only visible assistant text.
*/
export async function* streamReleasedTurn(ctx, config, command, request, shutdown, active, gated = new Set(), observe = () => {}, connections) {
	const agent = ctx.agents.currentInitiator();
	if (!isAgentLoopRequest(request) || request.purpose !== void 0 || agent === void 0 || agent.session.header.origin === "subagent" || request.sessionId !== agent.session.id) throw new Error("ACP models are available only for root DSH conversations.");
	if (active.size >= config.maxBindings) throw new Error("ACP Hub has reached its connection limit.");
	const session = agent.session;
	const inputs = [];
	let position;
	for (let i = session.seq - 1; i >= 0; i--) {
		const seq = SessionSeq(i);
		const event = session.eventAt(seq);
		if (event?.type === 'step/start') {
			position = { turn: event.data.turn, step: event.data.step };
			break;
		}
		if (event?.type === "user/message" && event.data.source.kind === "user") inputs.push({
			seq,
			message: event.data
		});
	}
	const shared = new Set();
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event?.type === 'tool/result' && event.data.message.toolCallId?.startsWith('acp-hub-')) shared.add(event.data.message.toolCallId);
	}
	const contextTurn = {
		agent,
		inputs: inputs.reverse()
	};
	const model = request.model === "@default" ? void 0 : request.model.slice(6);
	if (model !== void 0 && (!request.model.startsWith("model:") || model === "")) throw new Error("Choose a model from the ACP agent’s model list.");
	const controller = new AbortController();
	const signal = AbortSignal.any([
		controller.signal,
		shutdown,
		...request.signal === void 0 ? [] : [request.signal]
	]);
	let bridge;
	let gateway;
	let gatewayClosed = false;
	const closeGateway = async () => {
		if (gatewayClosed) return;
		gatewayClosed = true;
		await gateway?.close();
	};
	let connection;
	const chunks = new Readable({
		objectMode: true,
		read() {}
	});
	const write = createBlockWriter((chunk) => chunks.push(chunk));
	const done = (async () => {
		let stage = 'workspace';
		let failed = false;
		try {
			signal.throwIfAborted();
			const originalCwd = session.header.cwd;
			if (originalCwd === void 0 || !isAbsolute(originalCwd)) throw new Error("Select a DSH workspace before using an ACP agent.");
			const cwd = await realpath(ctx.get("workingDirectory")?.get(session) ?? originalCwd);
			if (!(await stat(cwd)).isDirectory()) throw new Error("The DSH workspace is not a directory.");
			stage = 'session persistence';
			if (!await ctx.sessions.flush(session)) throw new Error("ACP Hub requires an active DSH session persistence listener.");
			signal.throwIfAborted();
			const useDsh = config.toolSource === 'dsh' || (config.toolSource === undefined && config.tools?.length > 0);
			if (useDsh) {
				stage = 'tool discovery';
				bridge = new DshTools(ctx, agent, config, { provider: request.provider, model: request.model }, signal);
				const schemas = await bridge.refresh();
				if (schemas.length) {
					if (!position) throw new Error('DSH tools require an active session step.');
					gateway = new Gateway(ctx, schemas, gated, config.maxImageBytes);
				}
			}
			stage = 'MCP gateway';
			const mcp = await gateway?.listen();
			stage = 'session/new';
			const perform = async (connection, startup) => {
				stage = 'model selection';
				await connection.selectModel(model, startup);
				observe({ type: 'connected', models: connection.models, imageInput: connection.imageInput });
				stage = 'permission mode';
				if (config.nativeApproval === 'agent') await connection.selectPermissionMode(command.permissionMode, startup);
				stage = 'prompt preparation';
				const prompt = await projectPrompt(contextTurn, undefined, shared, !!gateway && bridge.hasSkill, config, ctx.get('attachments'), signal, {
					guide: gateway ? toolGuide : undefined,
					imageInput: connection.imageInput,
				});
				let outputBytes = 0;
				let hasText = false;
				const account = (chunk) => {
					outputBytes += Buffer.byteLength(chunk);
					if (outputBytes > config.maxOutputBytes) throw Object.assign(new Error('ACP response exceeds the configured byte limit.'), { code: 'ACP_OUTPUT_LIMIT' });
			};
				gateway?.begin({
					agent, ...position, signal,
					toolSet: bridge?.toolSet,
					recordToolCall: (call) => recordDshCall(session, position, { provider: request.provider, model: request.model }, call),
					refreshTools: async () => {
						const schemas = await bridge.refresh();
						if (!gateway.active) return;
						gateway.active.input.toolSet = bridge.toolSet;
						gateway.setTools(schemas);
					},
				});
				stage = 'session/prompt';
				const stop = await connection.prompt(prompt, {
					onPermission: permissionHandler(ctx, agent, command.id, config.nativeApproval),
					onText: (chunk) => {
						account(chunk);
						hasText ||= /\S/u.test(chunk);
						write.text(chunk);
					},
					onThought: config.showThoughts ? (chunk) => {
						account(chunk);
						write.reasoning(chunk);
					} : void 0,
					signal
				});
				stage = 'tool settlement';
				if (await gateway?.end() === false && !signal.aborted) throw new Error('DSH tool execution did not settle normally.');
				stage = 'session/prompt';
				if (stop === 'end_turn' && !hasText) throw new HarnessError('ACP 智能体结束了本轮，未返回可见文本。请先查看会话中的工具执行结果，再决定是否重试。', 'EMPTY_RESPONSE');
				return stop;
			};
			if (connections) return await connections.use(command, { cwd, mcp, mcpTools: gateway?.names ?? new Set(), signal }, async (live, startup) => {
				try { return await perform(live, startup); }
				catch (error) {
					failed = true;
					throw error;
				} finally {
					await finishCleanup(closeGateway, failed, ctx.logger);
				}
			});
			const startup = config.startupMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(config.startupMs)]) : signal;
			connection = new AcpConnection(ctx.subprocess, command, cwd, config.cancelGraceMs, gateway?.names ?? new Set());
			try { await connection.open(cwd, mcp, startup); }
			catch (error) { stage = connection.stage ?? stage; throw error; }
			return await perform(connection, startup);
		} catch (error) {
			failed = true;
			if (!signal.aborted) {
				stage = error?.acpStage ?? stage;
				const failure = turnFailure(error, stage);
				ctx.logger?.warn(`ACP turn for ${command.id} failed during ${stage} (${failure.code}).`);
				throw failure;
			}
			throw error;
		} finally {
			await finishCleanup(async () => {
				try { await closeGateway(); }
				finally { try { await connection?.close(); } finally { bridge?.dispose(); } }
			}, failed, ctx.logger);
		}
	})().then((stop) => ({
		ok: true,
		stop
	}), (error) => ({
		ok: false,
		error
	})).then((result) => {
		write.flush();
		if (!signal.aborted) observe({ type: 'outcome', model: request.model, error: result.ok ? (['end_turn', 'max_tokens'].includes(result.stop) ? undefined : new Error('ACP turn stopped unexpectedly.')) : result.error });
		return result;
	}).finally(() => {
		active.delete(done);
		chunks.push(null);
	});
	active.add(done);
	try {
		for await (const chunk of chunks) {
			signal.throwIfAborted();
			yield chunk;
		}
		const result = await done;
		signal.throwIfAborted();
		if (!result.ok) {
			// The plugin may resolve a different HarnessError class instance than the host.
			// Carry normalized codes on the stream instead of relying on cross-package instanceof.
			yield { type: 'finish', reason: { kind: 'error', failure: { code: result.error.code, message: result.error.message } } };
			return;
		}
		if (result.stop !== "end_turn" && result.stop !== "max_tokens") throw new Error("ACP agent stopped with " + result.stop + ". Review the conversation before continuing.");
		yield {
			type: "finish",
			reason: { kind: result.stop === "max_tokens" ? "max-tokens" : "stop" }
		};
	} finally {
		controller.abort();
		chunks.destroy();
		await done;
	}
}

function turnFailure(error, stage) {
	if (['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'ACP_REFUSAL', 'EMPTY_RESPONSE'].includes(error?.code)) return error;
	if (error?.name === 'TimeoutError') return new HarnessError(`ACP 启动超时（${stage}）。请检查 CLI 状态后重试。`, 'UNKNOWN');
	if (error?.code === 'ACP_TRANSPORT') return new HarnessError(`ACP CLI 连接中断（${stage}）。请检查 CLI 状态及会话中已执行的操作。`, 'UNKNOWN');
	if (error?.code === 'ACP_OUTPUT_LIMIT') return new HarnessError('ACP 回复超出 maxOutputBytes。请检查已输出的内容和工具结果，可缩小单轮输出或调整配置。', 'UNKNOWN');
	if (error?.code === 'ENOENT' && stage !== 'workspace') return new HarnessError(`找不到 ACP CLI 或其启动文件（${stage}）。请检查安装路径。`, 'UNKNOWN');
	if (error?.message === 'This ACP agent does not advertise HTTP MCP.') return new HarnessError('当前 ACP CLI 未声明 HTTP MCP 能力。可选择支持 HTTP MCP 的 CLI，或将工具来源设为 external 后使用该 CLI 的原生工具。', 'UNKNOWN');
	if (stage === 'prompt preparation' || stage === 'model selection' || stage === 'permission mode') {
		// Only plugin-generated diagnostics are safe to forward verbatim.
		if (/^(?:ACP Hub |ACP images |DSH image attachment |This ACP agent does not advertise image|The ACP agent no longer offers)/.test(error?.message ?? '')) {
			return new HarnessError(error.message, 'UNKNOWN');
		}
	}
	const details = {
		workspace: '请检查当前 DSH 工作区目录是否可访问。',
		'session persistence': '请检查 DSH 能否保存当前会话。',
		'tool discovery': '请检查当前会话的 DSH 工具配置。',
		'MCP gateway': '请检查本机回环端口是否可用。',
		'model selection': '请刷新 ACP 模型目录并重新选择模型。',
		'permission mode': '请核对 CLI 实际支持的权限模式。',
		'prompt preparation': '请检查本轮输入、附件及上下文配置。',
		'tool settlement': '请先检查会话中已执行的工具，再决定是否重试。',
	};
	return new HarnessError(`ACP 任务失败（${stage}）。${details[stage] ?? '请检查 ACP 连接和 CLI 状态，并核对会话中已执行的操作。'}`, 'UNKNOWN');
}

async function finishCleanup(cleanup, failed, logger) {
	try { await cleanup(); }
	catch {
		logger?.warn('ACP turn cleanup did not complete.');
		if (!failed) throw new HarnessError('ACP 任务清理失败。请先检查会话中已执行的操作，再决定是否重试。', 'UNKNOWN');
	}
}
