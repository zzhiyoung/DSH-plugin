import { createAssistantMessage } from '@deepseek-ai/dsh-llm'

/** A scoped, renewable admission owned by one released ACP turn. */
export class DshTools {
	disposed = false;
	constructor(ctx, agent, config, selection, signal) {
		Object.assign(this, { ctx, agent, config, selection, signal });
	}
	refresh() {
		const work = (this.refreshing ?? Promise.resolve()).then(() => this.update());
		this.refreshing = work.catch(() => {});
		return work;
	}
	async update() {
		this.signal.throwIfAborted();
		if (this.disposed) throw new Error('DSH tool admission has closed.');
		const admission = await this.ctx.tools.resolve({ agent: this.agent, modelSelection: this.selection, signal: this.signal });
		const allow = new Set(this.config.tools);
		const toolSet = { view: (scope) => new Map([...admission.view(scope)].filter(([name]) => allow.size === 0 || allow.has(name))) };
		try {
			if (this.disposed) throw new Error('DSH tool admission has closed.');
			const definitions = this.ctx.tools.definitions(this.agent, toolSet);
			const executor = this.ctx.tools.selectExecutor(this.agent);
			let schemas = definitions.length ? executor.describe(definitions).schemas : [];
			// PTC exposes run_code; its SDK describes the admitted nested DSH/MCP tools.
			const guide = schemas.length && typeof executor.renderSdk === 'function' ? executor.renderSdk(definitions) : '';
			if (guide) schemas = schemas.map((s) => ({ ...s, description: s.description + '\n' + guide }));
			const hasSkill = definitions.some((d) => d.name === 'skill');
			this.signal.throwIfAborted();
			this.admission?.dispose();
			Object.assign(this, { admission, toolSet, schemas, hasSkill });
			return schemas;
		} catch (error) { admission.dispose(); throw error; }
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.admission?.dispose();
	}
}

/** Record requests separately from the outer assistant stream, avoiding re-execution by AgentLoop. */
export function recordDshCall(session, position, selection, call) {
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments },
		{ type: 'block-end', index: 0, block: call },
		{ type: 'finish', reason: { kind: 'stop' } },
	];
	session.append('assistant/message', {
		...position,
		message: createAssistantMessage({ content: [call], source: selection }),
		stream: chunks.map((chunk) => ({ type: 'chunk', time: Date.now(), chunk })),
	}, { surfaceOp: 'append' });
}

export const toolGuide = 'Use the dsh MCP server for tools, including configured MCP services and the skill loader. Prefer these tools to your own built-in tools. Follow DSH permission decisions; do not retry a denied DSH operation using another tool. Refresh tools/list after loading a skill. For run_code, use the SDK documented in the tool description.';
