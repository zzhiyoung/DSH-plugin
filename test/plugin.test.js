import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'

register(new URL('./support/hooks.mjs', import.meta.url).href)

const hub = await import('../src/index.js')

function config(overrides = {}) {
  return {
    agents: [
      { id: 'codex', title: 'Codex', command: 'node.exe', args: [], env: [] },
      { id: 'qoder', title: 'Qoder', command: 'qodercli.exe', args: ['--acp'], env: [] },
    ],
    execution: 'released',
    tools: [],
    ...overrides,
  }
}

function background() {
  const listeners = []
  const provided = new Map()
  const effects = []
  const adapters = []
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    provide(target, value) {
      provided.set(target, value)
    },
    effect(fn, label) {
      effects.push({ fn, label })
    },
    get() {
      return undefined
    },
    llm: {
      registerAdapter(providers, adapter) {
        adapters.push({ providers: [...providers], adapter })
      },
    },
  }
  return { ctx, listeners, provided, effects, adapters }
}

test('declares the ACP provider contract', () => {
  assert.equal(hub.name, 'acp-agent-hub')
  assert.deepEqual(hub.inject, ['agents', 'sessions', 'tools', 'subprocess', 'llm'])
  assert.ok(hub.Config !== undefined)
})

test('registers one model provider per configured agent', () => {
  const { ctx, adapters } = background()

  hub.apply(ctx, config())

  assert.equal(adapters.length, 1)
  assert.deepEqual(adapters[0].providers, ['acp-codex', 'acp-qoder'])
  assert.equal(adapters[0].adapter.providerInfo('acp-qoder').name, 'Qoder')
})

test('released execution streams through the LLM waterfall instead of providing a driver', () => {
  const { ctx, listeners, provided } = background()

  hub.apply(ctx, config())

  assert.equal(provided.has('agentTurnDriver'), false)
  assert.deepEqual(listeners.map((entry) => entry.event).filter((event) => event === 'llm/stream').length, 1)
})

test('driver execution provides a root-turn driver that only handles its own providers', () => {
  const { ctx, provided } = background()

  hub.apply(ctx, config({ execution: 'driver' }))

  const driver = provided.get('agentTurnDriver')
  assert.equal(driver.handles({ provider: 'acp-codex' }), true)
  assert.equal(driver.handles({ provider: 'acp' }), true)
  assert.equal(driver.handles({ provider: 'deepseek' }), false)
})

test('reports the Default model entry when the agent cannot be discovered', async () => {
  const { ctx, adapters } = background()
  hub.apply(ctx, config())

  const models = await adapters[0].adapter.listModels('acp-codex')

  assert.deepEqual(models.map((model) => model.id), ['@default'])
  assert.equal(models[0].name, 'Codex · Default model')
})

test('rejects duplicate agent ids, malformed ids, and tools in released execution', () => {
  const { ctx } = background()

  assert.throws(
    () => hub.apply(ctx, config({ agents: [config().agents[0], config().agents[0]] })),
    /unique agent ids/,
  )
  assert.throws(
    () => hub.apply(ctx, config({ agents: [{ id: 'Bad Id', title: 'Bad', command: 'x', args: [], env: [] }] })),
    /unique agent ids/,
  )
  assert.throws(
    () => hub.apply(ctx, config({ tools: ['read'] })),
    /does not support the ACP tool gateway/,
  )
})
