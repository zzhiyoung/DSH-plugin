import { DshTools, toolGuide } from './tool-bridge.js'
import { permissionHandler, dshToolDecision } from './approval.js'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Catalog } from './catalog.js'
import { AgentConnections } from './agent-connections.js'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { AcpConnection } from './connection.js'
import { projectPrompt } from './context.js'
import { Gateway } from './gateway.js'
import { streamReleasedTurn } from './released.js'

/** Opt-in ACP driver for DSH root conversations. */
const name = "acp-agent-hub";
const inject = [
	"agents",
	"sessions",
	"tools",
	"subprocess",
	"llm"
];
/** Each command is explicitly enabled by the operator. */
const Config = z.object({
	agents: z.array(z.object({
		id: z.string().required(),
		title: z.string().required(),
		command: z.string().required(),
		args: z.array(z.string()).default([]),
		env: z.array(z.string()).default([]),
		auth: z.string(),
		authMode: z.union([z.const('existing'), z.const('authenticate')]).description('existing 仅使用已有 CLI 凭据；authenticate 显式重新认证，WorkBuddy 可能使桌面登录失效'),
		permissionMode: z.string().description('外部 agent 的权限模式 ID；仅选择其实际声明支持的模式')
	})).required(),
	execution: z.union([z.const("driver"), z.const("released")]).default("released"),
	toolSource: z.union([z.const('dsh'), z.const('external')]).default('dsh').volatile().description('工具来源：dsh 优先使用当前 DSH 工具、MCP 和技能；external 使用外部 CLI 工具'),
	tools: z.array(z.string()).default([]).volatile().description('DSH 工具白名单；空列表表示当前会话可用的全部工具'),
	toolApproval: z.union([z.const('rules'), z.const('ask')]).default('rules').volatile().description('DSH 工具按现有权限规则处理，或每次都询问'),
	nativeApproval: z.union([z.const('dsh'), z.const('agent'), z.const('deny')]).default('dsh').volatile().description('原生工具：DSH 确认 / 跟随外部 agent 权限模式 / 拒绝 ACP 审批'),
	permissionMode: z.string().default('').volatile().description('外部 agent 权限模式 ID；留空沿用当前模式；例如 Codex 的 agent 是 Auto review，不是全量放行'),
	startupMs: z.natural().max(12e4).default(0),
	connectOnStart: z.boolean().default(true).description('插件启动后自动连接各 agent 一次；不自动登录'),
	loginMs: z.natural().min(1000).max(600000).default(180000).description('手动刷新发起登录的最长等待毫秒'),
	discoveryMs: z.natural().min(1).max(12e4).default(60000).description('后台模型目录探测截止毫秒；独立于对话运行时间，冷启动可能超过 15 秒'),
	discoveryWaitMs: z.natural().max(3000).default(800).description('菜单首次等候目录的毫秒预算，超出先显示默认模型'),
	// Accepted for existing installations; no prompt deadline is applied.
	promptMs: z.natural().default(0),
	maxImageBytes: z.natural().min(1024).max(64 * 1024 * 1024).default(20 * 1024 * 1024),
	cancelGraceMs: z.natural().min(1).max(3e4).default(5e3),
	idleMs: z.natural().min(1).max(36e5).default(9e5),
	maxBindings: z.natural().min(1).max(100).default(8),
	maxContextBytes: z.natural().min(1024).max(1024 * 1024).default(128 * 1024),
	maxOutputBytes: z.natural().min(1024).max(1024 * 1024).default(256 * 1024),
	showThoughts: z.boolean().default(true)
});
const LEGACY_PROVIDER = "acp";
const PROVIDER_PREFIX = "acp-";
const DEFAULT_MODEL = "@default";
const MODEL_PREFIX = "model:";
const DELIVERY_RECORD = "plugin:acp-agent-hub/delivery";
const RELEASED_HOST_HEADROOM_TOKENS = 65536;
async function close(binding) {
	clearTimeout(binding.idle);
	const outcomes = await Promise.allSettled([binding.gateway?.close(), binding.connection.close()]);
	for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}
/**
* Register the ACP model directory and the root-turn driver. Bindings are kept only while their process is live.
* @param ctx - Cordis context owning the driver, catalog, and gateway policy.
* @param config - local commands, tool allowlist, and resource limits.
*/
const option = (value, fallback) => value?.get instanceof Function ? value.get() : value ?? fallback;
export function configSnapshot(config) {
	return { ...config,
		toolSource: option(config.toolSource, config.tools?.length ? 'dsh' : 'external'),
		tools: [...option(config.tools, [])],
		toolApproval: option(config.toolApproval, 'rules'),
		nativeApproval: option(config.nativeApproval, 'dsh'),
		permissionMode: option(config.permissionMode, ''),
	};
}
function apply(ctx, config) {
	const missing = [];
	for (const [label, fn] of [['ctx.on', ctx.on], ['ctx.effect', ctx.effect], ['llm.registerAdapter', ctx.llm?.registerAdapter], ['subprocess.spawn', ctx.subprocess?.spawn], ['sessions.flush', ctx.sessions?.flush], ['session.appendPluginRecord', appendPluginRecord], ...(config.execution === 'driver' ? [['ctx.provide', ctx.provide]] : [])]) {
		if (typeof fn !== 'function') missing.push(label);
	}
	if (missing.length) throw new Error(`ACP Hub 宿主接口自检失败：${missing.join(', ')}。当前 DSH 缺少必要能力，请更新插件或宿主。`);
	const byId = new Map(config.agents.map((agent) => [agent.id, agent]));
	if (byId.size === 0 || byId.size !== config.agents.length || config.agents.some((agent) => !/^[a-z0-9][a-z0-9_-]*$/.test(agent.id) || agent.command.trim() === "" || agent.title.trim() === "" || agent.env.some((entry) => !/^[A-Za-z_][A-Za-z0-9_]*(?:=[\s\S]*)?$/.test(entry)))) throw new Error("ACP Hub requires unique agent ids, nonempty commands and titles, and environment entries that are variable names or NAME=VALUE pairs.");
	const providers = new Map(config.agents.map((agent) => [PROVIDER_PREFIX + agent.id, agent]));


	const bindings = /* @__PURE__ */ new Map();
	const retirements = /* @__PURE__ */ new Map();
	const active = /* @__PURE__ */ new Set();
	const discoveries = new Set();
	const shutdown = new AbortController();
	const gated = /* @__PURE__ */ new Set();
	const retire = (agent) => {
		const binding = bindings.get(agent);
		if (binding === void 0) return retirements.get(agent) ?? Promise.resolve();
		bindings.delete(agent);
		const disposal = close(binding).then(() => {
			retirements.delete(agent);
		});
		retirements.set(agent, disposal);
		return disposal;
	};
	const retireObserved = (agent) => {
		retire(agent).catch((_error) => ctx.logger.warn("ACP Hub could not confirm complete binding cleanup."));
	};
	ctx.on("agent/disposed", ({ agent }) => {
		retireObserved(agent);
	});
	ctx.on("tools/pre-execute", async (execution, next) => {
		return dshToolDecision(option(config.toolApproval, 'rules'), execution, await next(), gated);
	}, { prepend: true });
	const flush = async (input) => {
		if (!await ctx.sessions.flush(input.agent.session)) throw new Error("ACP Hub requires an active DSH session persistence listener.");
	};
	const snapshot = () => configSnapshot(config);
	const run = async (input) => {
		const config = snapshot();
		const allow = new Set(config.tools);
		const { agent, selection, turn, step } = input;
		const session = agent.session;
		const legacy = selection.provider === LEGACY_PROVIDER;
		const command = legacy ? byId.get(selection.model) : providers.get(selection.provider);
		if (command === void 0) throw new Error("This ACP agent is absent from the current Hub configuration.");
		const model = legacy || selection.model === DEFAULT_MODEL ? void 0 : selection.model.slice(6);
		if (model !== void 0 && (!selection.model.startsWith(MODEL_PREFIX) || model === "")) throw new Error("Choose a model from the ACP agent’s model list.");
		const signal = AbortSignal.any([
			input.signal,
			shutdown.signal
		]);
		const originalCwd = session.header.cwd;
		if (originalCwd === void 0 || !isAbsolute(originalCwd)) throw new Error("Select a DSH workspace before using an ACP agent.");
		const cwd = await realpath(ctx.get("workingDirectory")?.get(session) ?? originalCwd);
		const info = await stat(cwd, { bigint: true });
		if (!info.isDirectory()) throw new Error("The DSH workspace is not a directory.");
		const directory = `${info.dev}:${info.ino}`;
		let turnBridge;
		try {
			if (config.toolSource === 'dsh') turnBridge = new DshTools(ctx, agent, config, selection, signal);
			const schemas = turnBridge ? await turnBridge.refresh() : config.toolSource === 'external' ? [] : ctx.tools.schemas(agent, input.toolSet).filter((schema) => allow.has(schema.name));
			const toolCatalog = JSON.stringify(schemas);
			const policyKey = JSON.stringify([config.nativeApproval, config.permissionMode || command.permissionMode]);
			const generation = session.surface.contentGeneration;
			await retirements.get(agent);
			let binding = bindings.get(agent);
			if (binding !== void 0 && (!binding.connection.available || binding.harness !== command.id || binding.cwd !== cwd || binding.directory !== directory || binding.generation !== generation || binding.catalog !== toolCatalog || binding.policyKey !== policyKey)) {
				await retire(agent);
				binding = void 0;
			}
			signal.throwIfAborted();
			const shared = /* @__PURE__ */ new Set();
			for (const seq of session.surface.nodes) {
				const event = session.eventAt(seq);
				if (event?.type === "tool/result" && event.data.message.toolCallId.startsWith("acp-hub-")) shared.add(event.data.message.toolCallId);
			}
			if (binding) clearTimeout(binding.idle);
			const prompt = await projectPrompt(input, binding?.coveredTo, shared, turnBridge?.hasSkill ?? schemas.some((schema) => schema.name === "skill"), config, ctx.get('attachments'), signal);
			if (turnBridge) {
				prompt[0].text += '\n' + toolGuide(turnBridge.guide);
				if (Buffer.byteLength(prompt[0].text) > config.maxContextBytes) throw new Error('ACP context including the DSH tool guide exceeds the configured byte limit.');
			}
			if (binding === void 0) {
				if (bindings.size + retirements.size >= config.maxBindings) throw new Error("ACP Hub has reached its connection limit. Close an active conversation or wait for an idle binding to expire.");
				const gateway = schemas.length === 0 ? void 0 : new Gateway(ctx, schemas, gated, config.maxImageBytes);
				const connection = new AcpConnection(ctx.subprocess, command, cwd, config.cancelGraceMs, gateway?.names ?? new Set());
				binding = {
					harness: command.id,
					cwd,
					directory,
					generation,
					catalog: toolCatalog,
					policyKey,
					connection,
					gateway,
					coveredTo: void 0,
					idle: void 0
				};
				bindings.set(agent, binding);
				const mcp = await gateway?.listen();
				await connection.open(cwd, mcp, AbortSignal.any([signal, ...(config.startupMs > 0 ? [AbortSignal.timeout(config.startupMs)] : [])]));
			}
			clearTimeout(binding.idle);
			await binding.connection.selectModel(model, AbortSignal.any([signal, ...(config.startupMs > 0 ? [AbortSignal.timeout(config.startupMs)] : [])]));
			catalog.acceptConnection(legacy ? PROVIDER_PREFIX + command.id : selection.provider, { models: binding.connection.models, imageInput: binding.connection.imageInput });
			if (config.nativeApproval === 'agent') await binding.connection.selectPermissionMode(config.permissionMode || command.permissionMode, signal);
			const prepared = appendPluginRecord(session, DELIVERY_RECORD, {
				phase: "prepared",
				turn,
				step,
				harness: command.id,
				text: prompt[0].text
			});
			await flush(input);
			signal.throwIfAborted();
			binding.gateway?.begin({
				...input,
				signal,
				toolSet: turnBridge?.toolSet ?? input.toolSet,
				...(turnBridge ? { refreshTools: async () => {
					const next = await turnBridge.refresh();
					binding.gateway.active.input.toolSet = turnBridge.toolSet;
					binding.gateway.setTools(next);
				} } : {}),
			});
			let outputBytes = 0;
			let stop;
			try {
				stop = await binding.connection.prompt(prompt, {
					onPermission: permissionHandler(ctx, agent, command.id, config.nativeApproval),
					onText: (chunk) => {
						outputBytes += Buffer.byteLength(chunk);
						if (outputBytes > config.maxOutputBytes) throw new Error("ACP response exceeds the configured byte limit.");
						input.emitText(chunk);
					},
					signal
				});
			} finally {
				if (await binding.gateway?.end() === false && !signal.aborted) throw new Error("ACP tool delivery did not settle normally. Review the DSH transcript before continuing.");
			}
			signal.throwIfAborted();
			if (stop !== "end_turn" && stop !== "max_tokens") throw new Error(`ACP agent stopped with ${stop}. Review the conversation before continuing.`);
			input.commitText();
			appendPluginRecord(session, DELIVERY_RECORD, {
				phase: "settled",
				prepared,
				stop
			});
			await flush(input);
			binding.coveredTo = session.seq;
			binding.idle = setTimeout(() => {
				retireObserved(agent);
			}, config.idleMs);
			binding.idle.unref();
			catalog.recordOutcome(legacy ? PROVIDER_PREFIX + command.id : selection.provider, selection.model);
			return stop === "max_tokens" ? "max-tokens" : "completed";
		} catch (error) {
			catalog.recordOutcome(legacy ? PROVIDER_PREFIX + command.id : selection.provider, selection.model, error);
			try {
				await retire(agent);
			} catch (cleanupError) {
				ctx.logger.warn("ACP Hub could not confirm complete binding cleanup.");
				throw new AggregateError([error, cleanupError], "ACP turn and binding cleanup both failed.", { cause: error });
			}
			throw error;
		} finally { turnBridge?.dispose(); }
	};
	const driver = {
		handles: (selection) => selection.provider === LEGACY_PROVIDER || providers.has(selection.provider),
		run(input) {
			shutdown.signal.throwIfAborted();
			const work = run(input).finally(() => {
				active.delete(work);
			});
			active.add(work);
			return work;
		}
	};
	if (config.execution === "released") ctx.on("llm/stream", (request, next) => {
		const command = providers.get(request.provider);
		if (command === void 0) return next();
		const turnConfig = snapshot();
		return streamReleasedTurn(ctx, turnConfig, { ...command, permissionMode: turnConfig.permissionMode || command.permissionMode }, request, shutdown.signal, active, gated, (event) => {
			if (event.type === 'connected') catalog.acceptConnection(request.provider, event);
			else catalog.recordOutcome(request.provider, event.model, event.error);
		}, connections);
	});
	else ctx.provide("agentTurnDriver", driver);
	const discover = async (command, options) => {
		try {
			return await connections.inspect(command, options);
		} catch (error) {
			// Use known categories rather than exposing CLI output, which may contain credentials.
			const message = error instanceof Error ? error.message : '';
			const diagnostic = error?.code === 'AUTH' || /authentication is required|authentication required/i.test(message)
				? 'CLI 需要登录；点击刷新可发起一次登录并验证。'
				: error?.code === 'ENOENT' ? '未找到 CLI，请检查安装位置或启动路径。'
				: error?.name === 'TimeoutError' ? `检测超时（阶段：${error.acpStage ?? '连接/验证'}），可稍后刷新。`
				: `CLI 检测失败（阶段：${error.acpStage ?? '连接/验证'}），请检查路径和登录状态。`;
			if (error instanceof Error) error.discoveryDiagnostic = diagnostic;
			if (!shutdown.signal.aborted) ctx.logger.warn(`ACP model discovery for ${command.id} did not complete at ${error.acpStage ?? 'connection/check'}; check CLI path/login and retry after the cooldown.`);
			throw error;
		}
	};
	const contextWindow = config.execution === "released" ? RELEASED_HOST_HEADROOM_TOKENS + Math.max(16384, Math.floor(config.maxContextBytes / 4)) : void 0;
	const connections = new AgentConnections(ctx, config, shutdown.signal, (id, phase) => catalog.setPhase(PROVIDER_PREFIX + id, phase));
	const catalog = new Catalog(providers, (command, options) => {
		const work = discover(command, options).finally(() => {
			discoveries.delete(work);
		});
		discoveries.add(work);
		return work;
	}, contextWindow, {
		waitMs: config.discoveryWaitMs ?? 800,
		onChanged: (provider) => { if (!shutdown.signal.aborted) ctx.emit?.('llm/models-updated', provider); },
	});
	ctx.llm.registerAdapter([...providers.keys()], catalog);
	if (config.connectOnStart !== false) catalog.start().catch(() => ctx.logger.warn('ACP startup discovery did not complete.'));
	ctx.inject?.(['commands'], (scope) => {
		scope.commands.register({
			name: 'acp-refresh', description: '刷新 ACP 模型连接和目录（不影响已有会话）',
			input: { hint: '提供方 ID，例如 acp-codex' },
			handler: async ({ rawInput }) => {
				shutdown.signal.throwIfAborted();
				const provider = rawInput.trim();
				if (!providers.has(provider)) return { kind: 'error', text: '请选择当前配置中的 ACP 提供方。' };
				const loading = catalog.refresh(provider);
				ctx.emit?.('llm/models-updated', provider);
				await loading;
				await catalog.cache.get(provider)?.pending;
				const entry = catalog.cache.get(provider);
				if (entry?.runtimeError?.code === 'AUTH') return { kind: 'error', text: `${providers.get(provider).title}：目录已连接，但最近一次对话认证失败；刷新目录不代表已恢复登录，请先完成 CLI 登录后重试对话。` };
				return entry?.failed
					? { kind: 'error', text: `${providers.get(provider).title}：${entry.diagnostic ?? '检测失败，请检查 CLI 路径和登录状态。'}${entry.models ? '已保留上次可用模型。' : '尚未获得可用模型列表。'}` }
					: { kind: 'success', text: '模型目录已刷新；实际对话能力以发送消息后的结果为准。' };
			},
		});
	});
	ctx.effect(() => async () => {
		shutdown.abort();
		await Promise.allSettled([...active, ...discoveries]);
		await connections.close();
		if ((await Promise.allSettled([...Array.from(bindings.keys(), retire), ...retirements.values()])).some((result) => result.status === "rejected")) throw new Error("ACP Hub shutdown could not confirm complete binding cleanup.");
	}, "acpAgentHub.bindings()");
}

export { Config, apply, inject, name }
