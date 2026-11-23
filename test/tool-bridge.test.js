import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { DshTools, recordDshCall } = await import('../src/tool-bridge.js')
const { dshToolDecision } = await import('../src/approval.js')
const { Gateway } = await import('../src/gateway.js')
const { configSnapshot, apply } = await import('../src/index.js')

function runtime({ ptc = false, allow = [] } = {}) {
  const agent = {}, signal = new AbortController().signal
  const read = { name: 'read', parameters: { type: 'object' } }, skill = { name: 'skill', parameters: { type: 'object' } }, mcp = { name: 'mcp__existing__query', parameters: { type: 'object' } }
  const defs = new Map([read, skill, mcp].map((d) => [d.name, d]))
  let disposals = 0
  const ctx = { tools: {
    resolve: async () => { let closed = false; return { view: (scope) => scope === agent && !closed ? new Map(defs) : new Map(), dispose() { closed = true; disposals++ } } },
    definitions: (owner, set) => [...set.view(owner).values()],
    selectExecutor: () => ptc ? { describe: () => ({ schemas: [{ name: 'run_code', description: 'program', parameters: { type: 'object' } }] }), renderSdk: (defs) => defs.map((d) => d.name).join(',') } : { describe: (defs) => ({ schemas: defs }) },
  } }
  return { ctx, agent, signal, defs, get disposals() { return disposals }, bridge: new DshTools(ctx, agent, { tools: allow }, { provider: 'acp-fake', model: '@default' }, signal) }
}
test('bridge lists scoped DSH, MCP and skill tools and renews admission after changes', async () => {
  const r = runtime()
  assert.deepEqual((await r.bridge.refresh()).map((s) => s.name), ['read', 'skill', 'mcp__existing__query'])
  assert.equal(r.bridge.hasSkill, true)
  assert.equal(r.bridge.toolSet.view({}).size, 0)
  r.defs.set('office_render', { name: 'office_render', parameters: { type: 'object' } })
  assert.ok((await r.bridge.refresh()).some((s) => s.name === 'office_render'))
  assert.equal(r.disposals, 1)
  r.bridge.dispose(); assert.equal(r.disposals, 2)
})
test('PTC retains run_code as entry, with a scoped SDK and nested allowlist', async () => {
  const r = runtime({ ptc: true, allow: ['skill', 'mcp__existing__query'] })
  assert.deepEqual((await r.bridge.refresh()).map((s) => s.name), ['run_code'])
  assert.match(r.bridge.schemas[0].description, /mcp__existing__query/)
  assert.equal(r.bridge.toolSet.view(r.agent).has('read'), false)
  r.bridge.dispose()
})
test('volatile plugin choices are snapshotted for a turn', () => {
  let current = 'rules'
  const config = { toolApproval: { get: () => current }, toolSource: { get: () => 'dsh' }, tools: { get: () => [] } }
  const before = configSnapshot(config); current = 'ask'
  assert.equal(before.toolApproval, 'rules')
  assert.equal(configSnapshot(config).toolApproval, 'ask')
})
test('rules mode preserves DSH allow/ask/deny; ask mode never weakens deny', async () => {
  for (const toolApproval of ['rules', 'ask']) {
    let hook
    const ctx = { on: (event, fn) => { if (event === 'tools/pre-execute') hook = fn }, llm: { registerAdapter() {} }, provide() {}, effect() {} }
    ctx.subprocess = { spawn() {} }
    ctx.sessions = { flush: async () => true }
    apply(ctx, { connectOnStart: false, agents: [{ id: 'fake', title: 'Fake', command: 'x', args: [], env: [] }], tools: [], toolApproval })
    for (const kind of ['allow', 'ask', 'deny']) assert.equal((await hook({ callId: 'unrelated' }, async () => ({ kind }))).kind, kind)
  }
})
test('gateway executes in the owning DSH scope and records calls before results', async () => {
  const records = [], gated = new Set(), agent = { session: { append: (type) => records.push(type) } }
  let seen
  const ctx = { agents: { withInitiator: (a, fn) => { assert.equal(a, agent); return fn() } }, tools: { execute: async (input) => { seen = input; assert.equal(gated.has(input.calls[0].id), true); return { results: [{ result: { content: [{ type: 'text', text: 'MCP result' }] } }], additionalContexts: [] } } }, sessions: { flush: async () => true } }
  const g = new Gateway(ctx, [{ name: 'mcp__existing__query', parameters: {} }], gated)
  g.begin({ agent, signal: new AbortController().signal, turn: 1, step: 2, toolSet: 'admitted', recordToolCall: (call) => recordDshCall(agent.session, { turn: 1, step: 2 }, { provider: 'acp-fake', model: '@default' }, call) })
  const result = await g.call(g.active, 'mcp__existing__query', { q: 'hello' }, 1, new AbortController().signal)
  assert.equal(result.content[0].text, 'MCP result')
  assert.equal(seen.toolSet, 'admitted')
  assert.equal(seen.agent, agent)
  assert.deepEqual(records, ['assistant/message'])
  assert.equal(gated.size, 0)
  assert.equal(await g.end(), true)
  await g.close()
})
test('gateway returns a DSH denial and rejects withdrawn or unlisted tools', async () => {
  let executed = 0
  const ctx = { agents: { withInitiator: (_, fn) => fn() }, tools: { execute: async () => { executed++; return { results: [{ result: { isError: true, content: [{ type: 'text', text: 'permission denied' }] } }], additionalContexts: [] } } }, sessions: { flush: async () => true } }
  const g = new Gateway(ctx, [{ name: 'write', parameters: {} }], new Set())
  g.begin({ agent: { session: {} }, signal: new AbortController().signal, recordToolCall() {} })
  assert.equal((await g.call(g.active, 'write', {}, 1, new AbortController().signal)).isError, true)
  g.setTools([])
  assert.equal((await g.call(g.active, 'write', {}, 2, new AbortController().signal)).isError, true)
  assert.equal(executed, 1)
  await g.close()
})

test('confirmation applies to bridged roots and nested calls without weakening denial', () => {
  const gated = new Set(['root'])
  for (const execution of [{ callId: 'root' }, { callId: 'nested', parent: { callId: 'root' } }]) {
    assert.equal(dshToolDecision('rules', execution, { kind: 'allow' }, gated).kind, 'allow')
    assert.equal(dshToolDecision('ask', execution, { kind: 'allow' }, gated).kind, 'ask')
    assert.equal(dshToolDecision('ask', execution, { kind: 'deny' }, gated).kind, 'deny')
  }
})
test('gateway propagates cancellation to a pending DSH tool before closing', async () => {
  let started, cancelled = false
  const ready = new Promise((r) => { started = r })
  const ctx = { agents: { withInitiator: (_, fn) => fn() }, tools: { execute: ({ signal }) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true }) }) } }
  const g = new Gateway(ctx, [{ name: 'read', parameters: {} }], new Set())
  g.begin({ agent: { session: {} }, signal: new AbortController().signal, recordToolCall() {} })
  const pending = g.call(g.active, 'read', {}, 1, new AbortController().signal)
  const queued = g.call(g.active, 'read', {}, 2, new AbortController().signal)
  await ready
  await g.close()
  assert.equal(cancelled, true)
  assert.equal((await pending).isError, true)
  assert.match((await queued).content[0].text, /cancelled/)
})

test('parallel MCP requests execute in order and checkpoint each tool result once', async () => {
  const first = Promise.withResolvers(), started = Promise.withResolvers()
  const executions = []
  let flushes = 0
  const ctx = {
    agents: { withInitiator: (_, fn) => fn() }, sessions: { flush: async () => { flushes++; return true } },
    tools: { async execute({ calls }) {
      const { order } = JSON.parse(calls[0].arguments)
      executions.push(order)
      if (order === 1) { started.resolve(); await first.promise }
      return { results: [{ result: { content: [{ type: 'text', text: 'ok' }] } }], additionalContexts: [] }
    } },
  }
  const g = new Gateway(ctx, [{ name: 'read', parameters: {} }], new Set())
  const signal = new AbortController().signal
  g.begin({ agent: { session: {} }, signal, recordToolCall() {} })
  const a = g.call(g.active, 'read', { order: 1 }, 1, signal)
  const b = g.call(g.active, 'read', { order: 2 }, 2, signal)
  assert.equal((await g.call(g.active, 'read', { order: 3 }, 2, signal)).isError, true)
  await started.promise
  assert.deepEqual(executions, [1])
  first.resolve()
  assert.ok((await Promise.all([a, b])).every((result) => result.content[0].text === 'ok'))
  assert.deepEqual(executions, [1, 2])
  assert.equal(flushes, 2)
  assert.equal(await g.end(), true)
  await g.close()
})
