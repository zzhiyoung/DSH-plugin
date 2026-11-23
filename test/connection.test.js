import assert from 'node:assert/strict'
import { register } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { RequestError, setClientFactory } = await import('@agentclientprotocol/sdk')
const { AcpConnection } = await import('../src/connection.js')
const { permissionHandler } = await import('../src/approval.js')
const { streamReleasedTurn } = await import('../src/released.js')

function harness({ image = true, sessionCapabilities, newSession = async () => ({ sessionId: 's1' }), run = async () => ({ stopReason: 'end_turn' }) } = {}) {
  const handlers = new Map(), calls = []
  const childExit = Promise.withResolvers()
  const agent = { async request(method, params) {
    calls.push({ method, params })
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image }, mcpCapabilities: { http: true }, sessionCapabilities } }
    if (method === 'session/new') return newSession(params)
    return run(handlers, params, method)
  }, notify: async () => {} }
  setClientFactory(() => ({
    onNotification(method, handler) { handlers.set(method, handler); return this },
    onRequest(method, handler) { handlers.set(method, handler); return this },
    connect() { return { agent, closed: new Promise(() => {}), close() {} } },
  }))
  let terminated = false
  const subprocess = { spawn: () => ({ stdin: new PassThrough(), stdout: new PassThrough(), done: childExit.promise, terminate() { terminated = true }, waitForExit: async () => true }) }
  const command = { id: 'fake', title: 'Fake', command: 'fake', args: [], env: [] }
  return { calls, subprocess, command, childExit, get terminated() { return terminated }, connection: new AcpConnection(subprocess, command, process.cwd(), 10, new Set()) }
}
async function textReply(handlers, { sessionId }) {
  await handlers.get('session/update')({ params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })
  return { stopReason: 'end_turn' }
}
const permission = { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'write file', rawInput: { path: 'a.txt' } }, options: [{ kind: 'allow_once', optionId: 'a' }, { kind: 'reject_once', optionId: 'r' }] }
for (const outcome of ['allowed-once', 'rejected', 'unavailable', 'cancelled', 'unexpected']) {
  test(`native permission maps ${outcome} without blanket approval`, async () => {
    let answer
    const h = harness({ run: async (handlers) => { answer = await handlers.get('session/request_permission')({ params: permission }); return { stopReason: 'end_turn' } } })
    const signal = new AbortController().signal
    await h.connection.open(process.cwd(), undefined, signal)
    await h.connection.prompt('hi', { signal, onPermission: async () => outcome })
    assert.equal(answer.outcome.optionId, outcome === 'allowed-once' ? 'a' : 'r')
    await h.connection.close()
  })
}
test('approval service receives owning agent, action details and live signal', async () => {
  const agent = { session: {} }, signal = new AbortController().signal
  let seen
  const ctx = { get: () => ({ request: async (req) => { seen = req; return 'allowed-once' } }), agents: { withInitiator: (owner, fn) => { assert.equal(owner, agent); return fn() } } }
  assert.equal(await permissionHandler(ctx, agent, 'fake')(permission, signal), 'allowed-once')
  assert.equal(seen.agent, agent)
  assert.equal(seen.signal, signal)
  assert.match(seen.reason, /a.txt/)
})
test('missing approval service fails closed', async () => {
  assert.equal(await permissionHandler({ get() {} }, {}, 'fake')(permission, new AbortController().signal), 'unavailable')
})
test('ACP image capability gates actual image prompts', async () => {
  for (const image of [true, false]) {
    const h = harness({ image }), signal = new AbortController().signal
    await h.connection.open(process.cwd(), undefined, signal)
    const prompt = [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]
    if (image) { await h.connection.prompt(prompt, { signal }); assert.deepEqual(h.calls.at(-1).params.prompt, prompt) }
    else await assert.rejects(h.connection.prompt(prompt, { signal }), /does not advertise image/)
    await h.connection.close()
  }
})
test('released turn ignores legacy prompt deadline but honors user cancellation', async () => {
  const h = harness({ run: async (handlers, params) => { await new Promise((r) => setTimeout(r, 30)); return textReply(handlers, params) } })
  const message = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 's', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const agent = { session }, active = new Set()
  const ctx = { agents: { currentInitiator: () => agent }, sessions: { flush: async () => true }, subprocess: h.subprocess, get() {} }
  const cfg = { maxBindings: 8, maxContextBytes: 10000, promptMs: 1, startupMs: 0, cancelGraceMs: 10, maxOutputBytes: 1000 }
  const request = { sessionId: 's', model: '@default' }
  const results = []
  for await (const item of streamReleasedTurn(ctx, cfg, h.command, request, new AbortController().signal, active)) results.push(item)
  assert.equal(results.at(-1).type, 'finish')
  assert.equal(results.at(-1).reason.kind, 'stop')
  assert.equal(active.size, 0)
  const abort = new AbortController(); abort.abort(new Error('user cancelled'))
  await assert.rejects(async () => { for await (const item of streamReleasedTurn(ctx, cfg, h.command, { ...request, signal: abort.signal }, new AbortController().signal, active)) {} }, /user cancelled/)
})

test('driver has no legacy prompt deadline and catalog preserves advertised images', async () => {
  const { apply } = await import('../src/index.js')
  const h = harness({ run: async () => { await new Promise((r) => setTimeout(r, 25)); return { stopReason: 'end_turn' } } })
  let driver, catalog, dispose
  const msg = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0], contentGeneration: 0 }, eventAt: () => ({ type: 'user/message', data: msg }), deriveEventMessage: (e) => e.data }
  const ctx = { on() {}, provide: (name, value) => { driver = value }, effect: (fn) => { dispose = fn() }, llm: { registerAdapter: (providers, value) => { catalog = value } }, get() {}, tools: { schemas: () => [] }, sessions: { flush: async () => true }, subprocess: h.subprocess, logger: { warn() {} } }
  const cfg = { agents: [h.command], execution: 'driver', connectOnStart: false, tools: [], maxBindings: 8, maxContextBytes: 10000, promptMs: 1, startupMs: 0, cancelGraceMs: 10, maxOutputBytes: 1000, idleMs: 10000 }
  apply(ctx, cfg)
  assert.equal(await driver.run({ agent: { session }, selection: { provider: 'acp-fake', model: '@default' }, inputs: [{ seq: 0, message: msg }], signal: new AbortController().signal, emitText() {}, commitText() {} }), 'completed')
  await dispose()
  const released = { ...ctx, effect() {} }
  apply(released, { ...cfg, execution: 'released' })
  assert.deepEqual((await catalog.resolveModel('acp-fake', '@default')).inputModalities, ['text', 'image'])
})

test('pending discovery does not consume the released conversation limit', async () => {
  const { apply } = await import('../src/index.js')
  const pending = Promise.withResolvers()
  const h = harness({ newSession: (params) => params.cwd.includes('dsh-acp-slow-') ? pending.promise : { sessionId: 's1' }, run: textReply })
  let stream, catalog, dispose
  const message = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 's', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const ctx = {
    on: (name, handler) => { if (name === 'llm/stream') stream = handler },
    effect: (fn) => { dispose = fn() }, get() {}, logger: { warn() {} },
    llm: { registerAdapter: (_, value) => { catalog = value } },
    agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true }, subprocess: h.subprocess,
  }
  apply(ctx, { agents: [h.command, { ...h.command, id: 'slow' }], execution: 'released', connectOnStart: false, toolSource: 'external', tools: [], maxBindings: 1, maxContextBytes: 10000, maxOutputBytes: 1000, startupMs: 0, discoveryWaitMs: 1, cancelGraceMs: 10 })
  try {
    await catalog.listModels('acp-slow')
    assert.ok(catalog.cache.get('acp-slow').pending)
    const chunks = []
    for await (const chunk of stream({ sessionId: 's', provider: 'acp-fake', model: '@default' }, () => {})) chunks.push(chunk)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.ok(catalog.cache.get('acp-slow').pending)
  } finally {
    pending.resolve({ sessionId: 'discovery' })
    await dispose()
  }
})

test('native approval never selects allow_always and discards approval after cancellation', async () => {
  for (const cancel of [false, true]) {
    let answer
    const controller = new AbortController()
    const params = cancel ? permission : { ...permission, options: [{ kind: 'allow_always', optionId: 'forever' }] }
    const h = harness({ run: async (handlers) => { answer = await handlers.get('session/request_permission')({ params }); return { stopReason: 'end_turn' } } })
    await h.connection.open(process.cwd(), undefined, controller.signal)
    const work = h.connection.prompt('hi', { signal: controller.signal, onPermission: async () => { if (cancel) controller.abort(new Error('cancelled')); return 'allowed-once' } })
    if (cancel) { await assert.rejects(work, /cancelled/); assert.equal(answer.outcome.outcome, 'cancelled') }
    else { await work; assert.equal(answer.outcome.outcome, 'cancelled') }
    await h.connection.close()
  }
})

test('a subprocess exit ends an in-flight prompt even when the protocol transport stays open', async () => {
  const requested = Promise.withResolvers()
  const h = harness({ run: () => { requested.resolve(); return new Promise(() => {}) } })
  const signal = new AbortController().signal
  await h.connection.open(process.cwd(), undefined, signal)
  const work = h.connection.prompt('hi', { signal })
  await requested.promise
  h.childExit.reject(new Error('upstream details should be redacted'))
  await assert.rejects(work, (error) => error.code === 'ACP_TRANSPORT' && error.acpStage === 'session/prompt' && error.message === 'ACP subprocess failed.')
  assert.equal(h.connection.available, false)
  assert.equal(h.calls.filter(({ method }) => method === 'session/prompt').length, 1)
  await h.connection.close()
})

for (const code of [-32002, -32601]) test(`session close error ${code} does not block the next session`, async () => {
  let sessions = 0
  const h = harness({
    sessionCapabilities: { close: {} },
    newSession: () => ({ sessionId: 's' + ++sessions }),
    run: (_, __, method) => { assert.equal(method, 'session/close'); throw new RequestError(code) },
  })
  const signal = new AbortController().signal
  for (let i = 0; i < 3; i++) await h.connection.newSession(process.cwd(), undefined, signal)
  assert.equal(h.connection.sessionId, 's3')
  assert.equal(h.calls.filter(({ method }) => method === 'session/close').length, code === -32601 ? 1 : 2)
  await h.connection.close()
})

test('external permissions select only an advertised mode and require confirmation', async () => {
  const h = harness(), signal = new AbortController().signal
  await h.connection.open(process.cwd(), undefined, signal)
  await assert.rejects(h.connection.selectPermissionMode('agent', signal), /does not advertise/)
  h.connection.permissionConfig = { id: 'mode', type: 'select', options: [{ value: 'agent', name: 'Auto review' }] }
  await assert.rejects(h.connection.selectPermissionMode('full-access', signal), /unavailable/)
  h.connection.connection.agent.request = async (method, params) => { assert.equal(params.value, 'agent'); return { configOptions: [{ id: 'mode', currentValue: 'agent' }] } }
  await h.connection.selectPermissionMode('agent', signal)
  await h.connection.close()
})
test('released bridge performs DSH skill and existing MCP calls without replaying them in the outer stream', async () => {
  const { Gateway } = await import('../src/gateway.js')
  const oldListen = Gateway.prototype.listen
  let gateway
  Gateway.prototype.listen = async function () { gateway = this; return { name: 'dsh', type: 'http', url: 'http://127.0.0.1/fake', headers: [] } }
  const executions = [], events = [{ type: 'step/start', data: { turn: 0, step: 0 } }, { type: 'user/message', data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'use DSH' }] } }]
  const session = { id: 's', get seq() { return events.length }, header: { cwd: process.cwd() }, surface: { nodes: [1] }, eventAt: (seq) => events[seq], deriveEventMessage: (e) => e.data, append(type, data) { events.push({ type, data }); return { seq: events.length - 1 } } }
  const agent = { session }, schemas = ['skill', 'mcp__existing__query'].map((name) => ({ name, parameters: { type: 'object' } }))
  const h = harness({ run: async (handlers, params) => {
    for (const [id, name] of ['skill', 'mcp__existing__query'].entries()) {
      const result = await gateway.call(gateway.active, name, {}, id, new AbortController().signal)
      assert.equal(result.isError, undefined)
    }
    return textReply(handlers, params)
  } })
  const ctx = { get() {}, subprocess: h.subprocess, agents: { currentInitiator: () => agent, withInitiator: (_, fn) => fn() }, sessions: { flush: async () => true }, tools: {
    resolve: async () => ({ view: (scope) => scope === agent ? new Map(schemas.map((s) => [s.name, s])) : new Map(), dispose() {} }),
    definitions: (scope, set) => [...set.view(scope).values()], selectExecutor: () => ({ describe: (defs) => ({ schemas: defs }) }),
    execute: async (input) => { executions.push(input.calls[0].name); return { results: [{ result: { content: [{ type: 'text', text: 'ok' }] } }], additionalContexts: [] } },
  } }
  try {
    const chunks = []
    for await (const chunk of streamReleasedTurn(ctx, { toolSource: 'dsh', tools: [], maxBindings: 8, maxContextBytes: 20000, maxOutputBytes: 1000, startupMs: 0, cancelGraceMs: 10 }, h.command, { sessionId: 's', provider: 'acp-fake', model: '@default' }, new AbortController().signal, new Set())) chunks.push(chunk)
    assert.deepEqual(executions, ['skill', 'mcp__existing__query'])
    assert.equal(events.filter((e) => e.type === 'assistant/message').length, 2)
    assert.equal(chunks.some((c) => c.blockType === 'tool-call'), false)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally { Gateway.prototype.listen = oldListen }
})

test('existing credential mode never calls authenticate even with a legacy auth method', async () => {
  const h = harness(), signal = new AbortController().signal
  const c = new AcpConnection(h.subprocess, { ...h.command, auth: 'internal', authMode: 'existing' }, process.cwd(), 10, new Set())
  await c.open(process.cwd(), undefined, signal)
  assert.equal(h.calls.some((call) => call.method === 'authenticate'), false)
  await c.close(); await h.connection.close()
})
test('explicit authentication remains available for an operator-requested login', async () => {
  const h = harness(), signal = new AbortController().signal
  const c = new AcpConnection(h.subprocess, { ...h.command, auth: 'internal', authMode: 'authenticate' }, process.cwd(), 10, new Set())
  await c.open(process.cwd(), undefined, signal)
  assert.equal(h.calls.filter((call) => call.method === 'authenticate').length, 1)
  await c.close(); await h.connection.close()
})

test('WorkBuddy lazy authentication failure is preserved through the released stream and status observer', async () => {
  const h = harness({ run: async () => ({ stopReason: 'refusal', _meta: { 'codebuddy.ai/errorMessage': JSON.stringify({ code: -32000, message: 'Authentication required', data: { category: 'auth', details: 'login https://example.com/?token=SECRET' } }) } }) })
  const message = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 's', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const ctx = { agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true }, subprocess: h.subprocess, get() {} }
  const observed = [], active = new Set()
  const chunks = []
  for await (const chunk of streamReleasedTurn(ctx, { toolSource: 'external', maxBindings: 1, maxContextBytes: 10000, startupMs: 0, cancelGraceMs: 10, maxOutputBytes: 1000 }, h.command, { provider: 'acp-fake', sessionId: 's', model: '@default' }, new AbortController().signal, active, new Set(), (event) => observed.push(event))) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  assert.match(chunks.at(-1).reason.failure.message, /对话认证失败/)
  assert.doesNotMatch(chunks.at(-1).reason.failure.message, /SECRET/)
  assert.equal(observed[0].type, 'connected')
  assert.equal(observed.at(-1).error.code, 'AUTH')
  assert.equal(active.size, 0)
  assert.equal(h.terminated, true)
})

test('a pooled session-start failure still closes the per-turn MCP gateway exactly once', async () => {
  const { Gateway } = await import('../src/gateway.js')
  const listen = Gateway.prototype.listen, close = Gateway.prototype.close
  let closes = 0
  Gateway.prototype.listen = async () => ({ name: 'dsh', type: 'http', url: 'http://127.0.0.1/fake', headers: [] })
  Gateway.prototype.close = async () => { closes++; throw new Error('private cleanup details') }
  const events = [{ type: 'step/start', data: { turn: 0, step: 0 } }, { type: 'user/message', data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } }]
  const session = { id: 's', seq: 2, header: { cwd: process.cwd() }, surface: { nodes: [1] }, eventAt: (seq) => events[seq], deriveEventMessage: (e) => e.data }
  const ctx = { get() {}, agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true }, tools: {
    resolve: async () => ({ view: () => new Map(), dispose() {} }), definitions: () => [{ name: 'read' }], selectExecutor: () => ({ describe: () => ({ schemas: [{ name: 'read', parameters: {} }] }) }),
  } }
  try {
    const chunks = await Array.fromAsync(streamReleasedTurn(ctx, { toolSource: 'dsh', tools: [], maxBindings: 1, maxContextBytes: 10000 }, { id: 'test' }, { provider: 'acp-test', sessionId: 's', model: '@default' }, new AbortController().signal, new Set(), new Set(), undefined, { use: async () => { throw new Error('private session details') } }))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /session\/new/)
    assert.doesNotMatch(chunks.at(-1).reason.failure.message, /private/)
    assert.equal(closes, 1)
  } finally { Gateway.prototype.listen = listen; Gateway.prototype.close = close }
})

test('released turn without DSH tools can use an ACP agent without HTTP MCP', async () => {
  const h = harness()
  let sentPrompt
  const connection = {
    models: [], imageInput: false,
    async selectModel() {},
    async prompt(prompt, { onText }) { sentPrompt = prompt; onText('OK'); return 'end_turn' },
  }
  const message = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 's', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const ctx = {
    get() {}, agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true },
    tools: { resolve: async () => ({ view: () => new Map(), dispose() {} }), definitions: () => [], selectExecutor: () => ({ describe: () => ({ schemas: [] }) }) },
  }
  const connections = { async use(_command, { mcp, signal }, task) { assert.equal(mcp, undefined); return task(connection, signal) } }
  const chunks = await Array.fromAsync(streamReleasedTurn(ctx, { toolSource: 'dsh', tools: [], maxBindings: 1, maxContextBytes: 10000, maxOutputBytes: 1000 }, h.command, { provider: 'acp-fake', sessionId: 's', model: '@default' }, new AbortController().signal, new Set(), new Set(), undefined, connections))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.doesNotMatch(sentPrompt[0].text, /dsh MCP/)
  await h.connection.close()
})

test('released turn reports an empty response without marking the model as verified', async () => {
  const h = harness()
  const message = { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 's', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const ctx = { get() {}, subprocess: h.subprocess, agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true } }
  const outcomes = []
  const chunks = await Array.fromAsync(streamReleasedTurn(ctx, { toolSource: 'external', maxBindings: 1, maxContextBytes: 10000, cancelGraceMs: 10 }, h.command, { provider: 'acp-fake', sessionId: 's', model: '@default' }, new AbortController().signal, new Set(), new Set(), (event) => outcomes.push(event)))
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
  assert.equal(outcomes.at(-1).error.code, 'EMPTY_RESPONSE')
  await h.connection.close()
})
