import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Partial catalogs keep stale data while sharing one background probe per provider. */
export class Catalog extends LlmAdapter {
	cache = new Map();
	constructor(providers, discover, releasedContextWindow, { waitMs = 800, ttlMs = 300000, retryMs = 30000, onChanged = () => {} } = {}) {
		super();
		Object.assign(this, { providers, discover, releasedContextWindow, waitMs, ttlMs, retryMs, onChanged });
	}
	providerInfo(provider) { return { id: provider, name: this.providers.get(provider)?.title ?? provider }; }
	async resolveModel(provider, model, signal) {
		if (this.releasedContextWindow === undefined) return super.resolveModel(provider, model, signal);
		signal?.throwIfAborted();
		const models = await this.listModels(provider);
		signal?.throwIfAborted();
		return { provider, id: model, name: model, inputModalities: models.find((row) => row.id === model)?.inputModalities ?? ['text'], context: { contextWindow: this.releasedContextWindow } };
	}
	fallback(provider, entry) {
		return [{ id: '@default', provider, name: `${this.providerInfo(provider).name} · ${entry.pending || entry.refreshing ? entry.phase ?? '检测中…' : entry.runtimeError?.code === 'AUTH' ? '需要登录' : entry.failed ? '检测失败' : '检测中…'}`, inputModalities: ['text'],
			description: entry.failed && !entry.pending ? `模型目录暂不可用；${entry.diagnostic ?? '请检查 CLI 路径和登录状态，稍后刷新。'} 默认模型入口不代表连接已通过验证。` : '模型目录正在后台加载；默认模型入口不代表连接已通过验证。' }];
	}
	rows(provider, entry) {
		if (!entry.models) return this.fallback(provider, entry);
		const status = entry.pending || entry.refreshing ? entry.phase ?? '检测中…' : entry.runtimeError?.code === 'AUTH' ? '需要登录' : entry.failed ? '刷新失败（保留可用模型）' : entry.runtimeError ? '上次对话失败' : entry.verifiedModel ? '对话已验证' : '目录已连接';
		return entry.models.map((m, i) => i ? m : { ...m, name: `${this.providerInfo(provider).name} · Default model · ${status}`,
			description: entry.runtimeError?.message ?? (entry.failed ? m.description : entry.verifiedModel ? `最近成功请求的模型选择：${entry.verifiedModel}；不代表所有模型均已验证。` : 'ACP 会话和模型目录已连接，尚未验证实际模型响应；登录或额度问题可能在发消息时才返回。') });
	}
	acceptConnection(provider, { models, imageInput }) {
		let entry = this.cache.get(provider);
		if (!entry) { entry = {}; this.cache.set(provider, entry); }
		entry.revision = (entry.revision ?? 0) + 1;
		const inputModalities = imageInput ? ['text', 'image'] : ['text'];
		const title = this.providerInfo(provider).name;
		entry.models = [{ id: '@default', provider, name: `${title} · Default model`, inputModalities }, ...models.map((m) => ({ id: 'model:' + m.value, provider, name: `${title} · ${m.name}`, description: m.description, inputModalities }))];
		entry.failed = false;
		entry.expires = Date.now() + this.ttlMs;
		this.publish(provider);
	}
	recordOutcome(provider, model, error) {
		const entry = this.cache.get(provider);
		if (!entry) return;
		entry.runtimeError = error ? { code: error.code, message: error.code ? error.message : '上次对话未成功，请检查 CLI 或稍后重试。' } : undefined;
		if (!error) entry.verifiedModel = model;
		this.publish(provider);
	}
	setPhase(provider, phase) {
		const entry = this.cache.get(provider);
		if (entry) { entry.phase = phase; this.publish(provider); }
	}
	start() { return Promise.all([...this.providers.keys()].map((provider) => this.listModels(provider))); }
	refresh(provider) {
		if (!this.providers.has(provider)) throw new Error('Unknown ACP provider.');
		let entry = this.cache.get(provider);
		if (!entry) { entry = { expires: 0 }; this.cache.set(provider, entry); }
		if (entry.refreshing) return entry.refreshing;
		entry.refreshing = Promise.resolve().then(async () => {
			await entry.pending;
			entry.expires = 0;
			await this.listModels(provider, { interactive: true, verify: true });
			await entry.pending;
			return this.rows(provider, entry);
		}).finally(() => { entry.refreshing = undefined; entry.phase = undefined; this.publish(provider); });
		return entry.refreshing;
	}
	publish(provider) {
		// Even an unchanged catalog must clear a visible loading state. The TTL prevents reload loops.
		try { this.onChanged(provider)?.catch?.(() => {}); } catch { /* UI listeners cannot invalidate the cache. */ }
	}
	async listModels(provider, options = {}) {
		const harness = this.providers.get(provider);
		if (!harness) return [];
		let entry = this.cache.get(provider);
		if (!entry) { entry = { expires: 0 }; this.cache.set(provider, entry); }
		if (!entry.pending && entry.expires <= Date.now()) {
			const revision = entry.revision;
			entry.phase = undefined;
			entry.pending = Promise.resolve().then(() => this.discover(harness, options)).then(({ models, imageInput, verifiedModel }) => {
				if (entry.revision !== revision) return;
				const modalities = imageInput ? ['text', 'image'] : ['text'];
				entry.models = [
					{ id: '@default', provider, name: `${harness.title} · Default model`, inputModalities: modalities },
					...models.map((m) => ({ id: 'model:' + m.value, provider, name: `${harness.title} · ${m.name}`, ...(m.description == null ? {} : { description: m.description }), inputModalities: modalities })),
				];
				entry.failed = false;
				entry.diagnostic = undefined;
				if (verifiedModel) { entry.verifiedModel = verifiedModel; entry.runtimeError = undefined; }
			}).catch((error) => {
				if (entry.revision !== revision) return;
				if (error?.catalog) {
					const { models, imageInput } = error.catalog;
					const inputModalities = imageInput ? ['text', 'image'] : ['text'];
					entry.models = [{ id: '@default', provider, name: `${harness.title} · Default model`, inputModalities }, ...models.map((m) => ({ id: 'model:' + m.value, provider, name: `${harness.title} · ${m.name}`, inputModalities }))];
				}
				if ((options.verify || error?.code === 'AUTH') && error?.code) entry.runtimeError = { code: error.code, message: error.message };
				entry.failed = true;
				entry.diagnostic = error?.discoveryDiagnostic;
				if (entry.models) entry.models = entry.models.map((m, i) => i ? m : { ...m, description: `本次目录刷新失败，当前保留上次成功列表；${entry.diagnostic ?? '请检查 CLI 登录状态，稍后重试。'}` });
			}).then(() => {
				if (entry.revision === revision) entry.expires = Date.now() + (entry.failed ? this.retryMs : this.ttlMs);
			}).finally(() => {
				entry.pending = undefined;
				this.publish(provider);
			});
		}
		if (entry.models || !entry.pending) return this.rows(provider, entry);
		let timer;
		try {
			await Promise.race([entry.pending, new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs); })]);
		} finally { clearTimeout(timer); }
		return this.rows(provider, entry);
	}
	async *stream() {
		yield { type: 'finish', reason: { kind: 'error', failure: { message: 'ACP routes run only as root conversation agents.', code: 'UNKNOWN' } } };
	}
}
