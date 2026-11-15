import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

test('client slot shows independent loading states and refreshes through the host command API', async () => {
  let plugin, Panel, injection, call, position = 0
  const contributions = new Map()
  const states = []
  const completed = Promise.withResolvers()
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_, snapshot) => snapshot(),
    useState: (initial) => {
      const i = position++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
  }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (row) => { plugin = row.factory(() => React) } } },
  })
  const groups = [
    { id: 'acp-ready', name: 'Ready', models: [{ id: '@default', name: 'Ready · 已就绪' }] },
    { id: 'acp-slow', name: 'Slow', models: [{ id: '@default', name: 'Slow · 检测中…' }] },
    { id: 'acp-failed', name: 'Failed', models: [{ id: '@default', name: 'Failed · 检测失败' }] },
  ]
  plugin.apply({
    slots: { inject: (_, fn) => fn(), register: (options, component) => { contributions.set(options.name, { component, inject: options.inject }) } },
    modelDirectories: { directoryFor: () => ({ store: { subscribe() {}, getSnapshot: () => ({ groups }) } }) },
    remote: { commands: { execute: (...args) => { call = args; return completed.promise } } },
  })
  ;({ component: Panel, inject: injection } = contributions.get('conversation.input.model.options'))
  // The host skips model.options for an unselected session. Its resident toolbar
  // must still offer the same status panel and refresh command.
  const toolbar = contributions.get('conversation.input.right')
  assert.ok(toolbar)
  const menu = toolbar.component(toolbar.inject('session-1'))
  assert.equal(menu.type, 'details')
  assert.equal(menu.children[0].props['aria-label'], 'ACP 连接')
  assert.equal(menu.children[1].children[0].type, Panel)
  const props = injection('session-1')
  const render = () => { position = 0; return Panel({ ...props, locked: false }) }
  const nodes = (node) => node == null || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  let tree = nodes(render())
  const buttons = () => tree.filter((node) => node.type === 'button')
  assert.equal(buttons()[0].props.disabled, false)
  assert.equal(buttons()[1].props.disabled, true)
  assert.equal(tree.filter((node) => node.props.style?.animation).length, 1)
  groups[1].models[0].name = 'Slow · 等待登录…'
  tree = nodes(render())
  assert.ok(tree.some((node) => node.props.role === 'status' && node.children.includes('等待登录…')))
  assert.equal(buttons()[0].props.disabled, false)
  assert.equal(buttons()[1].props.disabled, true)
  const work = buttons()[2].props.onClick()
  assert.equal(call[0], 'session-1')
  assert.equal(call[1], '/acp-refresh acp-failed')
  assert.equal(call[2].length, 0)
  tree = nodes(render())
  assert.equal(buttons()[0].props.disabled, false)
  assert.equal(buttons()[2].props.disabled, true)
  completed.resolve({ ok: true, value: { result: { kind: 'success' } } })
  await work
  tree = nodes(render())
  assert.equal(buttons()[2].props.disabled, false)
})
