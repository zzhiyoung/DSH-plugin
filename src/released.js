import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { AcpConnection } from './connection.js'
import { projectContext } from './context.js'
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
export async function* streamReleasedTurn(ctx, config, command, request, shutdown, active) {
	const agent = ctx.agents.currentInitiator();
	if (!isAgentLoopRequest(request) || request.purpose !== void 0 || agent === void 0 || agent.session.header.origin === "subagent" || request.sessionId !== agent.session.id) throw new Error("ACP models are available only for root DSH conversations.");
	if (active.size >= config.maxBindings) throw new Error("ACP Hub has reached its connection limit.");
	const session = agent.session;
	const inputs = [];
	for (let i = session.seq - 1; i >= 0; i--) {
		const seq = SessionSeq(i);
		const event = session.eventAt(seq);
		if (event?.type === "step/start") break;
		if (event?.type === "user/message" && event.data.source.kind === "user") inputs.push({
			seq,
			message: event.data
		});
	}
	const text = projectContext({
		agent,
		inputs: inputs.reverse()
	}, void 0, /* @__PURE__ */ new Set(), false, config.maxContextBytes);
	const model = request.model === "@default" ? void 0 : request.model.slice(6);
	if (model !== void 0 && (!request.model.startsWith("model:") || model === "")) throw new Error("Choose a model from the ACP agent’s model list.");
	const controller = new AbortController();
	const signal = AbortSignal.any([
		controller.signal,
		shutdown,
		AbortSignal.timeout(config.promptMs),
		...request.signal === void 0 ? [] : [request.signal]
	]);
	const chunks = new Readable({
		objectMode: true,
		read() {}
	});
	const write = createBlockWriter((chunk) => chunks.push(chunk));
	const done = (async () => {
		const originalCwd = session.header.cwd;
		if (originalCwd === void 0 || !isAbsolute(originalCwd)) throw new Error("Select a DSH workspace before using an ACP agent.");
		const cwd = await realpath(ctx.get("workingDirectory")?.get(session) ?? originalCwd);
		if (!(await stat(cwd)).isDirectory()) throw new Error("The DSH workspace is not a directory.");
		if (!await ctx.sessions.flush(session)) throw new Error("ACP Hub requires an active DSH session persistence listener.");
		signal.throwIfAborted();
		const connection = new AcpConnection(ctx.subprocess, command, cwd, config.cancelGraceMs, /* @__PURE__ */ new Set());
		try {
			const startup = AbortSignal.any([signal, AbortSignal.timeout(config.startupMs)]);
			await connection.open(cwd, void 0, startup);
			await connection.selectModel(model, startup);
			let outputBytes = 0;
			const account = (chunk) => {
				outputBytes += Buffer.byteLength(chunk);
				if (outputBytes > config.maxOutputBytes) throw new Error("ACP response exceeds the configured byte limit.");
			};
			return await connection.prompt(text, {
				onText: (chunk) => {
					account(chunk);
					write.text(chunk);
				},
				onThought: config.showThoughts ? (chunk) => {
					account(chunk);
					write.reasoning(chunk);
				} : void 0,
				signal
			});
		} finally {
			await connection.close();
		}
	})().then((stop) => ({
		ok: true,
		stop
	}), (error) => ({
		ok: false,
		error
	})).then((result) => {
		if (result.ok) write.flush();
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
		if (!result.ok) throw result.error;
		signal.throwIfAborted();
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
