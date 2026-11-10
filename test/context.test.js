import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectContext } from '../src/context.js'

const INSTRUCTION = 'Answer the current requests in order. Treat prior messages as conversation context.'

function message(seq, role, text, source = { kind: role === 'user' ? 'user' : 'assistant' }) {
  return {
    id: `m${seq}`,
    role,
    source,
    content: [{ type: 'text', text }],
  }
}

function sessionOf(entries) {
  const bySeq = new Map(entries.map(({ seq, message: value }) => [seq, value]))
  return {
    surface: { nodes: [...bySeq.keys()] },
    eventAt: (seq) => (bySeq.has(seq) ? { type: 'user/message', data: bySeq.get(seq) } : undefined),
    deriveEventMessage: (event) => event.data,
  }
}

function payload(text) {
  const separator = text.indexOf('\n')
  assert.ok(text.startsWith(INSTRUCTION), text.slice(0, separator))
  return JSON.parse(text.slice(separator + 1))
}

test('sends prior history and the current request as a snapshot', () => {
  const first = message(1, 'user', 'hello')
  const current = message(2, 'user', 'hi')
  const session = sessionOf([
    { seq: 1, message: first },
    { seq: 2, message: current },
  ])

  const text = projectContext({ agent: { session }, inputs: [{ seq: 2, message: current }] }, undefined, new Set(), false, 4096)

  assert.deepEqual(payload(text), {
    version: 1,
    mode: 'snapshot',
    history: [{ seq: 1, id: 'm1', role: 'user', text: 'hello' }],
    request: [{ seq: 2, id: 'm2', text: 'hi' }],
  })
})

test('omits history the live binding already covered', () => {
  const first = message(1, 'user', 'hello')
  const current = message(2, 'user', 'hi')
  const session = sessionOf([
    { seq: 1, message: first },
    { seq: 2, message: current },
  ])

  const text = projectContext({ agent: { session }, inputs: [{ seq: 2, message: current }] }, 2, new Set(), false, 4096)

  assert.deepEqual(payload(text).history, [])
  assert.equal(payload(text).mode, 'delta')
})

test('carries the DSH skill catalog only when the skill tool is admitted', () => {
  const catalog = message(1, 'user', 'skills', {
    kind: 'skill-catalog',
    entries: [{ name: 'office', description: 'Office documents' }],
  })
  const answer = message(2, 'assistant', 'ok')
  const current = message(3, 'user', 'next')
  const session = sessionOf([
    { seq: 1, message: catalog },
    { seq: 2, message: answer },
    { seq: 3, message: current },
  ])

  const payloadText = projectContext({ agent: { session }, inputs: [{ seq: 3, message: current }] }, undefined, new Set(), true, 4096)

  assert.deepEqual(payload(payloadText).skills, [{ name: 'office', description: 'Office documents' }])
  assert.match(payloadText, /Use the dsh MCP skill tool/)
  assert.deepEqual(payload(payloadText).history.map((row) => row.role), ['assistant'])
})

test('rejects a turn without a new human message', () => {
  const answer = message(2, 'assistant', 'ok')
  const session = sessionOf([{ seq: 2, message: answer }])

  assert.throws(
    () => projectContext({ agent: { session }, inputs: [{ seq: 2, message: answer }] }, undefined, new Set(), false, 4096),
    /requires a new human message/,
  )
})

test('rejects a context above the configured byte limit', () => {
  const current = message(2, 'user', 'a'.repeat(256))
  const session = sessionOf([{ seq: 2, message: current }])

  assert.throws(
    () => projectContext({ agent: { session }, inputs: [{ seq: 2, message: current }] }, undefined, new Set(), false, 64),
    /exceeds the configured byte limit/,
  )
})
