/** Route each native ACP action through the owning DSH session approval service. */
export function permissionHandler(ctx, agent, harness, policy = 'dsh') {
	return async (params, signal) => {
		if (policy === 'deny') return 'rejected';
		// In agent mode, the CLI handles its own decisions. Any request it still
		// delegates to this client requires DSH confirmation, never blanket allow.
		const approval = ctx.get('approval');
		if (!approval?.request) return 'unavailable';
		const tool = params.toolCall;
		const details = JSON.stringify({ title: tool.title, kind: tool.kind, locations: tool.locations, input: tool.rawInput });
		return ctx.agents.withInitiator(agent, () => approval.request({
			agent,
			toolName: `acp-${harness}: ${tool.title ?? tool.kind ?? 'tool'}`,
			reason: `External agent action (not executed by the DSH sandbox): ${details.slice(0, 16384)}`,
			signal,
		}));
	};
}

/** Keep DSH decisions intact unless the operator explicitly requests per-call confirmation. */
export function dshToolDecision(policy, execution, decision, gated) {
	let root = execution;
	while (root.parent) root = root.parent;
	const bridged = gated.has(root.rootCallId ?? root.callId);
	return policy === 'ask' && bridged && decision.kind === 'allow'
		? { kind: 'ask', reason: 'An external ACP agent requested this DSH tool.' }
		: decision;
}
