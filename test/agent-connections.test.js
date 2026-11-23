import assert from 'node:assert/strict'
import { register } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { setClientFactory, RequestError } = await import('@agentclientprotocol/sdk')
const { AgentConnections } = await import('../src/agent-connections.js')
const { Catalog } = await import('../src/catalog.js')
const { streamReleasedTurn } = await import('../src/released.js')

function fixture(t, { loggedIn = false, loginWorks = true, failAtSession = false, loginGate, backendError, beforeSession, startupMs, waitForExit = true } = {}) {
  const calls = [], phases = [], children = [], shutdown = new AbortController()
  let spawns = 0, killed = 0
  setClientFactory(() => {
    const processNumber = spawns, childExit = children.at(-1)
    let authenticated = loggedIn, update, sessionId, sessionCount = 0
    return {
      onNotification(_, fn) { update = fn; return this }, onRequest() { return this },
      connect() { return { closed: new Promise(() => {}), close() {}, agent: { request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'internal' }] }
        if (method === 'authenticate') { await loginGate; authenticated = loginWorks; return {} }
        if (method === 'session/new') {
          await beforeSession?.({ processNumber, completedSessions: sessionCount, childExit })
          if (failAtSession && !authenticated) throw new RequestError(-32000)
          sessionId = 'session-' + ++sessionCount
          return { sessionId }
        }
        if (method === 'session/prompt') {
          if (!authenticated || backendError) return { stopReason: 'refusal', _meta: { 'codebuddy.ai/errorMessage': JSON.stringify({ message: backendError ?? 'Authentication required', data: { category: backendError ? 'server' : 'auth' } }) } }
          await update({ params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })
          return { stopReason: 'end_turn' }
        }
      }, notify: async () => {} } } },
    }
  })
  const ctx = { subprocess: { spawn() {
    spawns++
    const childExit = Promise.withResolvers()
    children.push(childExit)
    return { stdin: new PassThrough(), stdout: new PassThrough(), done: childExit.promise, terminate() { killed++ }, waitForExit: async () => waitForExit }
  } } }
  const config = { discoveryMs: 1000, loginMs: 1000, cancelGraceMs: 10, startupMs }
  const pool = new AgentConnections(ctx, config, shutdown.signal, (_, phase) => phases.push(phase))
  const command = { id: 'workbuddy', title: 'WorkBuddy', command: 'fake', args: [], env: [], auth: 'internal', authMode: 'existing' }
  t.after(async () => { shutdown.abort(); await pool.close(); setClientFactory(undefined) })
  return { pool, command, ctx, calls, phases, shutdown, get spawns() { return spawns }, get killed() { return killed } }
}

test('startup connects once without model requests or authentication and retains its process', async (t) => {
  const f = fixture(t)
  const catalog = new Catalog(new Map([['acp-workbuddy', f.command]]), (cmd, options) => f.pool.inspect(cmd, options), 1000)
  await catalog.start(); await catalog.cache.get('acp-workbuddy').pending
  assert.deepEqual(f.calls.map((c) => c.method), ['initialize', 'session/new'])
  assert.equal(f.spawns, 1)
  assert.equal(f.killed, 0)
})

test('plugin apply starts every configured provider without waiting for the model menu', async (t) => {
  const { apply } = await import('../src/index.js')
  const f = fixture(t)
  let catalog, dispose
  const ctx = { ...f.ctx, on() {}, get() {}, effect(fn) { dispose = fn() }, logger: { warn() {} }, sessions: { flush: async () => true }, llm: { registerAdapter(_, adapter) { catalog = adapter } } }
  apply(ctx, { agents: [f.command, { ...f.command, id: 'other' }], execution: 'released', tools: [], maxContextBytes: 10000, cancelGraceMs: 10 })
  try {
    await Promise.all([...catalog.cache.values()].map((entry) => entry.pending))
    assert.equal(f.spawns, 2)
    assert.equal(f.calls.filter((c) => c.method === 'initialize').length, 2)
    assert.equal(f.calls.some((c) => c.method === 'authenticate' || c.method === 'session/prompt'), false)
  } finally { await dispose() }
})

for (const failAtSession of [false, true]) test(`manual refresh logs in once and verifies in the same process (session auth=${failAtSession})`, async (t) => {
  const f = fixture(t, { failAtSession })
  const result = await f.pool.inspect(f.command, { interactive: true, verify: true })
  assert.equal(result.verifiedModel, '@default')
  assert.equal(f.calls.filter((c) => c.method === 'authenticate').length, 1)
  assert.equal(f.spawns, 1)
  assert.equal(f.killed, 0)
  assert.ok(f.phases.includes('等待登录…'))
})

test('an already signed-in refresh does not initiate login', async (t) => {
  const f = fixture(t, { loggedIn: true })
  await f.pool.inspect(f.command, { interactive: true, verify: true })
  assert.equal(f.calls.some((c) => c.method === 'authenticate'), false)
})

test('a login waiting on one provider does not block another provider', async (t) => {
  const gate = Promise.withResolvers(), f = fixture(t, { loginGate: gate.promise })
  const pending = f.pool.inspect(f.command, { interactive: true, verify: true })
  const other = { ...f.command, id: 'other' }
  await f.pool.inspect(other)
  assert.equal(f.spawns, 2)
  gate.resolve()
  await pending
})

test('shutdown aborts an unfinished login and terminates the retained process', async (t) => {
  const f = fixture(t, { loginGate: new Promise(() => {}) })
  const pending = f.pool.inspect(f.command, { interactive: true, verify: true })
  while (!f.phases.includes('等待登录…')) await new Promise((r) => setTimeout(r, 1))
  f.pool.signal.throwIfAborted()
  // Simulate plugin disposal; authentication awaits the owning signal.
  f.shutdown.abort(new Error('plugin disposed'))
  await assert.rejects(pending, /plugin disposed/)
  await f.pool.close()
  assert.equal(f.killed, 1)
})

test('failed login is attempted once per click and leaves an explicit auth failure', async (t) => {
  const f = fixture(t, { loginWorks: false })
  await assert.rejects(f.pool.inspect(f.command, { interactive: true, verify: true }), (e) => e.code === 'AUTH')
  assert.equal(f.calls.filter((c) => c.method === 'authenticate').length, 1)
})

test('backend quota failures never trigger interactive authentication', async (t) => {
  const f = fixture(t, { loggedIn: true, backendError: 'quota exhausted' })
  await assert.rejects(f.pool.inspect(f.command, { interactive: true, verify: true }), (e) => e.code === 'QUOTA')
  assert.equal(f.calls.some((c) => c.method === 'authenticate'), false)
})

test('concurrent refresh clicks share one login and one verification operation', async (t) => {
  const gate = Promise.withResolvers(), f = fixture(t, { loginGate: gate.promise })
  const catalog = new Catalog(new Map([['acp-workbuddy', f.command]]), (cmd, options) => f.pool.inspect(cmd, options), 1000)
  const one = catalog.refresh('acp-workbuddy'), two = catalog.refresh('acp-workbuddy')
  assert.equal(one, two)
  gate.resolve()
  await one
  assert.equal(f.calls.filter((c) => c.method === 'authenticate').length, 1)
  assert.match((await catalog.listModels('acp-workbuddy'))[0].name, /对话已验证/)
})

test('a real released turn reuses process-local login but creates a fresh workspace session', async (t) => {
  const f = fixture(t)
  await f.pool.inspect(f.command, { interactive: true, verify: true })
  const message = { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  const session = { id: 'dsh-session', seq: 1, header: { cwd: process.cwd() }, surface: { nodes: [0] }, eventAt: () => ({ type: 'user/message', data: message }), deriveEventMessage: (e) => e.data }
  const ctx = { ...f.ctx, get() {}, agents: { currentInitiator: () => ({ session }) }, sessions: { flush: async () => true } }
  const chunks = []
  for await (const chunk of streamReleasedTurn(ctx, { toolSource: 'external', maxBindings: 1, maxContextBytes: 10000, maxOutputBytes: 1000 }, f.command, { sessionId: session.id, provider: 'acp-workbuddy', model: '@default' }, new AbortController().signal, new Set(), new Set(), undefined, f.pool)) chunks.push(chunk)
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'OK'))
  assert.equal(f.spawns, 1)
  assert.equal(f.calls.filter((c) => c.method === 'authenticate').length, 1)
  assert.equal(f.calls.filter((c) => c.method === 'session/new').at(-1).params.cwd, process.cwd())
  const prompts = f.calls.filter((c) => c.method === 'session/prompt')
  assert.notEqual(prompts.at(-1).params.sessionId, prompts.at(-2).params.sessionId)
})

test('a queued conversation gets its full setup deadline after taking the lease', async (t) => {
  const f = fixture(t, { startupMs: 150 })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const options = { cwd: process.cwd(), mcpTools: new Set(), signal: new AbortController().signal }
  const first = f.pool.use(f.command, options, async (_, startup) => { entered.resolve(startup); await release.promise })
  const firstStartup = await entered.promise
  const second = f.pool.use(f.command, options, (_, startup) => startup.aborted)
  await delay(170)
  assert.equal(firstStartup.aborted, true)
  release.resolve()
  await first
  assert.equal(await second, false)
  assert.equal(f.spawns, 1)
})

test('an expired session-start RPC discards the connection and retains its phase when cleanup fails', async (t) => {
  const f = fixture(t, {
    startupMs: 50, waitForExit: false,
    beforeSession: () => new Promise(() => {}),
  })
  const options = { cwd: process.cwd(), mcpTools: new Set(), signal: new AbortController().signal }
  const attempt = () => f.pool.use(f.command, options, () => assert.fail('should not start a user prompt'))
  const isTimeout = (error) => error.name === 'TimeoutError' && error.acpStage === 'session/new' && /session\/new/.test(error.message)
  await Promise.all([assert.rejects(attempt(), isTimeout), delay(70)])
  await Promise.all([assert.rejects(attempt(), isTimeout), delay(70)])
  assert.equal(f.spawns, 2)
  assert.equal(f.killed, 2)
})

test('a stale retained process is replaced once before a prompt starts', async (t) => {
  const f = fixture(t, { beforeSession: ({ processNumber, completedSessions, childExit }) => {
    if (processNumber !== 1 || completedSessions === 0) return
    childExit.resolve()
    return new Promise(() => {})
  } })
  await f.pool.inspect(f.command)
  const options = { cwd: process.cwd(), mcpTools: new Set(), signal: new AbortController().signal }
  let prompts = 0
  await f.pool.use(f.command, options, () => { prompts++ })
  assert.equal(prompts, 1)
  assert.equal(f.spawns, 2)
  assert.equal(f.killed, 1)
})

test('abort settles queued work immediately and keeps the active lease until cleanup', async (t) => {
  const f = fixture(t)
  const active = new AbortController(), queued = new AbortController()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const options = { cwd: process.cwd(), mcpTools: new Set(), signal: active.signal }
  const first = f.pool.use(f.command, options, async () => { entered.resolve(); await release.promise; active.signal.throwIfAborted() })
  let finished = false
  const firstRejection = assert.rejects(first, /active abort/).then(() => { finished = true })
  await entered.promise
  const second = f.pool.use(f.command, { ...options, signal: queued.signal }, () => assert.fail('cancelled queued task started'))
  queued.abort(new Error('queued abort'))
  await assert.rejects(second, /queued abort/)
  active.abort(new Error('active abort'))
  await tick()
  assert.equal(finished, false)
  release.resolve()
  await firstRejection
  assert.equal(f.killed, 1)
})
