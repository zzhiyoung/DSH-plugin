import assert from 'node:assert/strict'
import { register } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { Catalog } = await import('../src/catalog.js')
const providers = new Map([['acp-fast', { id: 'fast', title: 'Fast' }], ['acp-slow', { id: 'slow', title: 'Slow' }]])
const result = { imageInput: true, models: [{ value: 'vision', name: 'Vision' }] }

test('one stalled provider does not block partial catalogs; concurrent requests share its probe', async () => {
  const deferred = Promise.withResolvers(), changed = []
  let slowCalls = 0
  const c = new Catalog(providers, async (h) => { if (h.id === 'slow') { slowCalls++; return deferred.promise } return result }, 1000, { waitMs: 5, onChanged: (p) => changed.push(p) })
  const batches = await Promise.all([c.listModels('acp-fast'), c.listModels('acp-slow'), c.listModels('acp-slow')])
  assert.equal(batches[0][1].id, 'model:vision')
  assert.equal(batches[1][0].id, '@default')
  assert.match(batches[1][0].description, /后台加载/)
  assert.equal(slowCalls, 1)
  c.cache.get('acp-slow').expires = 0
  await c.listModels('acp-slow'); assert.equal(slowCalls, 1)
  deferred.resolve(result); await c.cache.get('acp-slow').pending
  assert.equal((await c.listModels('acp-slow'))[1].id, 'model:vision')
  assert.deepEqual(changed.sort(), ['acp-fast', 'acp-slow'])
})
test('stale models and image capability survive a failed refresh, with retry cooldown', async () => {
  let calls = 0
  const c = new Catalog(providers, async () => { if (++calls === 1) return result; throw new Error('offline') }, 1000, { waitMs: 5 })
  const good = await c.listModels('acp-fast')
  c.cache.get('acp-fast').expires = 0
  const loading = await c.listModels('acp-fast')
  assert.match(loading[0].name, /检测中/)
  assert.deepEqual(loading.slice(1), good.slice(1))
  await c.cache.get('acp-fast').pending
  assert.deepEqual((await c.listModels('acp-fast')).map((m) => m.id), good.map((m) => m.id))
  assert.match((await c.listModels('acp-fast'))[0].description, /上次成功/)
  assert.deepEqual((await c.resolveModel('acp-fast', 'model:vision')).inputModalities, ['text', 'image'])
  assert.equal(calls, 2)
})
test('cold errors retain the default entry and do not retry on every click', async () => {
  let calls = 0
  const c = new Catalog(providers, async () => { calls++; throw new Error('login needed') }, 1000)
  assert.match((await c.listModels('acp-slow'))[0].description, /暂不可用/)
  await c.listModels('acp-slow'); assert.equal(calls, 1)
  assert.deepEqual(await c.listModels('missing'), [])
})

test('cold background AUTH failures expose login recovery without an interactive probe', async () => {
  const c = new Catalog(providers, async () => {
    throw Object.assign(new Error('CLI 需要登录'), { code: 'AUTH' })
  }, 1000)
  const rows = await c.listModels('acp-slow')
  assert.match(rows[0].name, /需要登录/)
  assert.equal(c.cache.get('acp-slow').runtimeError.code, 'AUTH')
})

test('known diagnostic categories reach the failed catalog without exposing raw CLI errors', async () => {
  const c = new Catalog(providers, async () => {
    const error = new Error('raw CLI output with secret')
    error.discoveryDiagnostic = 'CLI 需要登录，请在终端运行 qodercli login 后再刷新。'
    throw error
  }, 1000)
  const models = await c.listModels('acp-slow')
  assert.match(models[0].description, /qodercli login/)
  assert.doesNotMatch(models[0].description, /secret/)
})
test('completed refresh clears loading even for unchanged models; TTL prevents UI refresh loops', async () => {
  let notifications = 0
  const c = new Catalog(providers, async () => result, 1000, { onChanged: () => { notifications++; throw new Error('listener') } })
  await c.listModels('acp-fast')
  c.cache.get('acp-fast').expires = 0
  await c.listModels('acp-fast'); await c.cache.get('acp-fast').pending
  assert.equal(notifications, 2)
  assert.equal((await c.listModels('acp-fast')).length, 2)
  assert.equal(notifications, 2)
})

test('manual refresh bypasses failure cooldown, shares pending work and leaves other ready models intact', async () => {
  let calls = 0
  const pending = Promise.withResolvers()
  const c = new Catalog(providers, async (h) => {
    if (h.id === 'fast') return result
    if (++calls === 1) throw new Error('offline')
    return pending.promise
  }, 1000, { waitMs: 1 })
  const ready = await c.listModels('acp-fast')
  assert.match((await c.listModels('acp-slow'))[0].name, /检测失败/)
  const refresh = c.refresh('acp-slow')
  assert.equal(c.refresh('acp-slow'), refresh)
  await new Promise((resolve) => setTimeout(resolve, 3))
  assert.equal(calls, 2)
  assert.match((await c.listModels('acp-slow'))[0].name, /检测中/)
  assert.deepEqual(await c.listModels('acp-fast'), ready)
  pending.resolve(result)
  await refresh
  assert.match((await c.listModels('acp-slow'))[0].name, /目录已连接/)
})
test('background discovery skips authentication and bounds session creation', async () => {
  const { setClientFactory } = await import('@agentclientprotocol/sdk')
  const { apply } = await import('../src/index.js')
  let catalog, disposed, killed = 0, spawns = 0, authCalls = 0
  const warnings = []
  setClientFactory(() => ({ onNotification() { return this }, onRequest() { return this }, connect() { return {
    closed: new Promise(() => {}), close() {}, agent: { request: async (method) => { if (method === 'authenticate') authCalls++; return method === 'initialize' ? { protocolVersion: 1 } : new Promise(() => {}) } },
  } } }))
  const ctx = { on() {}, get() {}, effect(fn) { disposed = fn() }, logger: { warn: (s) => warnings.push(s) }, llm: { registerAdapter: (_, value) => { catalog = value } }, subprocess: { spawn() { spawns++; return { stdin: new PassThrough(), stdout: new PassThrough(), done: new Promise(() => {}), terminate() { killed++ }, waitForExit: async () => true } } } }
  ctx.sessions = { flush: async () => true }
  try {
    apply(ctx, { agents: [{ id: 'slow', title: 'Slow', command: 'fake', args: [], env: [], auth: 'internal' }], execution: 'released', tools: [], startupMs: 0, discoveryMs: 20, discoveryWaitMs: 2, cancelGraceMs: 10, maxContextBytes: 4096, maxBindings: 8 })
    assert.equal((await catalog.listModels('acp-slow'))[0].id, '@default')
    await catalog.cache.get('acp-slow').pending
    assert.equal(killed, 1)
    assert.match(warnings[0], /session\/new/)
    assert.equal(authCalls, 0)
    await catalog.listModels('acp-slow'); assert.equal(spawns, 1)
  } finally { await disposed(); setClientFactory(undefined) }
})

test('directory refresh cannot erase a known prompt auth failure; actual successful turn verifies the route', async () => {
  const c = new Catalog(providers, async () => result, 1000)
  await c.listModels('acp-fast')
  assert.match((await c.listModels('acp-fast'))[0].name, /目录已连接/)
  const error = Object.assign(new Error('CLI 对话认证失败'), { code: 'AUTH' })
  c.recordOutcome('acp-fast', '@default', error)
  await c.refresh('acp-fast'); await c.cache.get('acp-fast').pending
  assert.match((await c.listModels('acp-fast'))[0].name, /需要登录/)
  c.recordOutcome('acp-fast', 'model:vision')
  assert.match((await c.listModels('acp-fast'))[0].name, /对话已验证/)
  assert.match((await c.listModels('acp-fast'))[0].description, /model:vision/)
})

test('late discovery failure cannot overwrite a newer working conversation catalog', async () => {
  const pending = Promise.withResolvers()
  const c = new Catalog(providers, () => pending.promise, 1000, { waitMs: 1 })
  await c.listModels('acp-fast')
  c.acceptConnection('acp-fast', result)
  c.recordOutcome('acp-fast', 'model:vision')
  pending.reject(new Error('old discovery timed out'))
  await c.cache.get('acp-fast').pending
  const models = await c.listModels('acp-fast')
  assert.match(models[0].name, /对话已验证/)
  assert.equal(models[1].id, 'model:vision')
})
