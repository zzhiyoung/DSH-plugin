import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** Authenticated Streamable HTTP MCP for one live ACP binding. */
/** Prefix reserved by the gateway for call ids recorded by the host executor. */
const TOOL_ID_PREFIX = "acp-hub-";
const toolError = (text) => ({
	isError: true,
	content: [{
		type: "text",
		text
	}]
});
/** One listener and one unguessable lease. Tool execution is admitted only during its owning prompt. */
export class Gateway {
	ctx;
	gated;
	bearer = Buffer.from(`Bearer ${randomBytes(32).toString("base64url")}`);
	listener = createServer({
		requestTimeout: 1e4,
		maxHeaderSize: 8192
	});
	host = "";
	active;
	tools;
	names;
	constructor(ctx, schema, gated, maxImageBytes = 20 * 1024 * 1024) {
		this.maxImageBytes = maxImageBytes;
		this.ctx = ctx;
		this.gated = gated;
		this.setTools(schema);
		this.listener.maxConnections = 16;
		this.listener.on("request", (req, res) => {
			this.handle(req, res).catch((_error) => {
				if (res.headersSent) res.destroy();
				else res.writeHead(400).end();
			});
		});
	}
	setTools(schema) {
		this.tools = schema.map(({ name, description, parameters }) => ({
			name,
			description,
			inputSchema: {
				...parameters,
				type: "object"
			}
		}));
		this.names ??= new Set();
		this.names.clear();
		for (const tool of this.tools) this.names.add(tool.name);
	}

	/** Bind to a private loopback port and return the ACP server declaration. */
	async listen() {
		await new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			this.listener.once("error", onError);
			this.listener.listen(0, "127.0.0.1", () => {
				this.listener.off("error", onError);
				resolve();
			});
		});
		const address = this.listener.address();
		if (address === null || typeof address === "string") throw new Error("ACP MCP listener has no loopback address.");
		this.host = `127.0.0.1:${address.port}`;
		return {
			type: "http",
			name: "dsh",
			url: `http://${this.host}/mcp`,
			headers: [{
				name: "Authorization",
				value: this.bearer.toString()
			}]
		};
	}
	/** Open execution admission for one prompt. */
	begin(input) {
		this.active = {
			input,
			abort: new AbortController(),
			ids: /* @__PURE__ */ new Set()
		};
	}
	/** Reject new calls, abort a pending tool or approval, and await executor settlement. */
	async end() {
		const active = this.active;
		this.active = void 0;
		if (active === void 0) return true;
		const inFlight = active.work;
		active.abort.abort();
		await inFlight;
		return inFlight === void 0 && !active.failed;
	}
	/** Revoke the lease before awaiting outstanding executor work. */
	async close() {
		this.bearer.fill(0);
		const stopped = this.listener.listening ? new Promise((resolve, reject) => {
			this.listener.close((error) => error === void 0 ? resolve() : reject(error));
			this.listener.closeAllConnections();
		}) : Promise.resolve();
		await Promise.all([this.end(), stopped]);
	}
	async handle(req, res) {
		const auth = Buffer.from(req.headers.authorization ?? "");
		if (req.url !== "/mcp" || req.headers.host !== this.host || req.headers.origin !== void 0 || auth.length !== this.bearer.length || !timingSafeEqual(auth, this.bearer)) {
			res.writeHead(403).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST" }).end();
			return;
		}
		const admission = this.active;
		const body = [];
		let bytes = 0;
		for await (const value of req) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
			bytes += chunk.length;
			if (bytes > 64 * 1024) {
				res.writeHead(413).end();
				return;
			}
			body.push(chunk);
		}
		const payload = JSON.parse(Buffer.concat(body).toString("utf8"));
		if (Array.isArray(payload)) {
			res.writeHead(400).end();
			return;
		}
		const server = new Server({
			name: "dsh",
			version: "0.2.2-rc.1"
		}, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, async () => {
			if (admission && this.active === admission && !admission.work) await admission.input.refreshTools?.();
			return { tools: this.tools };
		});
		server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => this.call(admission, params.name, params.arguments ?? {}, extra.requestId, extra.signal));
		const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, payload);
		} finally {
			await server.close();
		}
	}
	async call(active, name, args, requestId, clientSignal) {
		if (active === void 0 || this.active !== active) return toolError("DSH tool calls require an active ACP turn.");
		if (!this.names.has(name)) return toolError("This DSH tool is unavailable in the current turn.");
		const { input, ids } = active;
		const signal = AbortSignal.any([
			input.signal,
			active.abort.signal,
			clientSignal
		]);
		if (signal.aborted) return toolError("The DSH tool request was cancelled.");
		if (active.work !== void 0 || ids.has(requestId) || ids.size >= 64) return toolError("DSH tool request is busy, repeated, or over the turn limit.");
		ids.add(requestId);
		const work = this.execute(active, name, args, signal);
		active.work = work;
		try {
			return await work;
		} finally {
			delete active.work;
		}
	}
	async execute(active, name, args, signal) {
		const { input } = active;
		const id = ToolCallId(TOOL_ID_PREFIX + randomUUID());
		const call = {
			type: "tool-call",
			id,
			name,
			arguments: JSON.stringify(args)
		};
		this.gated.add(id);
		try {
			await input.refreshTools?.();
			if (!this.names.has(name)) return toolError("This DSH tool is no longer available.");
			input.recordToolCall(call);
			const result = await this.ctx.agents.withInitiator(input.agent, () => this.ctx.tools.execute({
				agent: input.agent,
				toolSet: input.toolSet,
				signal,
				log: {
					turn: input.turn,
					step: input.step
				},
				calls: [call]
			}));
			// Checkpoint the DSH outcome before converting or bounding an external response.
			if (!await this.ctx.sessions.flush(input.agent.session)) throw new Error('DSH tool outcome could not be checkpointed.');
			const item = result.results[0]?.result;
			if (item === void 0) return toolError("DSH did not report a tool result.");
			const content = [];
			let imageBytes = 0;
			for (const block of item.content) {
				if (block.type === 'text') content.push({ type: 'text', text: block.text });
				else if (block.type === 'image') {
					imageBytes += block.attachment?.bytes;
					if (!Number.isSafeInteger(imageBytes) || imageBytes > this.maxImageBytes) return toolError('DSH tool images exceed the transfer limit.');
					const image = await this.ctx.get('attachments')?.readImage(block.attachment, signal);
					if (!image) throw new Error('DSH image tool output is unavailable.');
					content.push({ type: 'image', mimeType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') });
				} else content.push({ type: 'text', text: `[DSH tool returned unsupported content: ${block.type}]` });
			}
			for (const context of result.additionalContexts) {
				input.agent.session.append("user/message", context, { surfaceOp: "append" });
				for (const block of context.content) if (block.type === "text") content.push({
					type: "text",
					text: block.text
				});
			}
			if (!await this.ctx.sessions.flush(input.agent.session)) throw new Error("DSH tool result could not be checkpointed.");
			if (result.concluded) {
				active.failed = true;
				active.abort.abort();
			}
			return Buffer.byteLength(JSON.stringify(content.filter((b) => b.type !== 'image'))) > 128 * 1024 ? toolError("DSH tool output exceeds the ACP transfer limit. Read a smaller result.") : {
				isError: item.isError,
				content
			};
		} catch (_error) {
			active.failed = true;
			active.abort.abort();
			return toolError("DSH tool execution did not settle normally. Check the DSH transcript before retrying.");
		} finally {
			this.gated.delete(id);
		}
	}
}
