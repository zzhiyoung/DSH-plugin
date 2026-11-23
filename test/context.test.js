import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectContext, projectPrompt } from '../src/context.js'

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

test('durable current and historical images are sent with association and verified bytes', async () => {
  const ref = { bytes: 3, mediaType: 'image/png' }
  const earlier = message(1, 'user', 'before'), current = message(2, 'user', 'now')
  earlier.content.push({ type: 'image', attachment: ref })
  current.content.push({ type: 'image', attachment: ref })
  const turn = { agent: { session: sessionOf([{ seq: 1, message: earlier }, { seq: 2, message: current }]) }, inputs: [{ seq: 2, message: current }] }
  const cfg = { maxContextBytes: 4096, maxImageBytes: 6 }
  const attachments = { readImage: async (r) => ({ ref: r, data: new Uint8Array([1, 2, 3]) }) }
  const signal = new AbortController().signal
  const prompt = await projectPrompt(turn, undefined, new Set(), false, cfg, attachments, signal)
  assert.equal(prompt.length, 3)
  assert.equal(prompt[1].data, 'AQID')
  assert.match(prompt[0].text, /Image 1, message 2/)
  assert.match(prompt[0].text, /Image 2, message 1/)
  assert.equal((await projectPrompt(turn, 2, new Set(), false, cfg, attachments, signal)).length, 2)
  const limited = await projectPrompt(turn, undefined, new Set(), false, { ...cfg, maxImageBytes: 5 }, attachments, signal)
  assert.equal(limited.length, 2)
  assert.match(limited[0].text, /Image omitted/)
  await assert.rejects(projectPrompt(turn, undefined, new Set(), false, { ...cfg, maxImageBytes: 2 }, attachments, signal), /byte limit/)
  await assert.rejects(projectPrompt(turn, undefined, new Set(), false, cfg, undefined, signal), /storage is unavailable/)
})

test('keeps recent UTF-8 history and current input within the same budget as the tool guide', async () => {
  const earlier = message(1, 'user', '"\\旧'.repeat(600))
  earlier.content.push({ type: 'image', attachment: { bytes: 3, mediaType: 'image/png' } })
  const recent = message(2, 'assistant', '最近一条回复')
  const current = message(3, 'user', '继续')
  const inputs = [{ seq: 3, message: current }]
  const turn = (rows) => ({ agent: { session: sessionOf(rows) }, inputs })
  const latest = [{ seq: 2, message: recent }, ...inputs]
  const all = turn([{ seq: 1, message: earlier }, ...latest])
  const guide = '工具指南'
  const text = projectContext(turn(latest), undefined, new Set(), false, 0)
  const maxContextBytes = Buffer.byteLength(text + '\n' + guide)
  const signal = new AbortController().signal
  let attachmentReads = 0
  const attachments = { readImage: async () => { attachmentReads++ } }
  const [block] = await projectPrompt(all, undefined, new Set(), false, { maxContextBytes, maxImageBytes: 6 }, attachments, signal, { guide })
  assert.equal(attachmentReads, 0)

  assert.equal(block.text, text + '\n' + guide)
  assert.equal(payload(projectContext(all, undefined, new Set(), false, 0)).history.length, 2)
})

test('outdated images cannot consume current image budget or block text-only agents', async () => {
  const earlier = message(1, 'user', 'earlier')
  const recent = message(2, 'user', 'recent')
  const current = message(3, 'user', 'now')
  const imageBlock = (id) => ({ type: 'image', attachment: { id, bytes: 3, mediaType: 'image/png' } })
  earlier.content.push(imageBlock(1))
  recent.content.push(imageBlock(2))
  current.content.push(imageBlock(3))
  const turn = {
    agent: { session: sessionOf([{ seq: 1, message: earlier }, { seq: 2, message: recent }, { seq: 3, message: current }]) },
    inputs: [{ seq: 3, message: current }],
  }
  const seen = []
  const attachments = {
    readImage: async (ref) => {
      seen.push(ref.id)
      if (ref.id === 1) throw new Error('Old attachment has disappeared')
      return { ref, data: new Uint8Array(3).fill(ref.id) }
    },
  }
  const signal = new AbortController().signal
  const config = { maxContextBytes: 4096, maxImageBytes: 6 }
  const prompt = await projectPrompt(turn, undefined, new Set(), false, config, attachments, signal)
  assert.deepEqual(seen, [3, 2])
  assert.deepEqual(prompt.slice(1).map(({ data }) => data), ['AwMD', 'AgIC'])
  assert.match(payload(prompt[0].text).history[0].text, /Image omitted/)
  assert.match(payload(prompt[0].text).history[1].text, /Image 2, message 2/)

  const missing = await projectPrompt(turn, undefined, new Set(), false, { ...config, maxImageBytes: 9 }, attachments, signal)
  assert.deepEqual(seen, [3, 2, 3, 2, 1])
  assert.equal(missing.length, 3)
  assert.match(payload(missing[0].text).history[0].text, /Image omitted/)

  await assert.rejects(projectPrompt(turn, undefined, new Set(), false, config, attachments, signal, { imageInput: false }), /does not advertise image/)
  current.content.pop()
  const textOnly = await projectPrompt(turn, undefined, new Set(), false, config, attachments, signal, { imageInput: false })
  assert.equal(textOnly.length, 1)
  assert.match(payload(textOnly[0].text).history[1].text, /Image omitted/)
  assert.deepEqual(seen, [3, 2, 3, 2, 1])
})

test('enforces actual image bytes and propagates cancellation from a historical read', async () => {
  const earlier = message(1, 'user', 'before')
  const current = message(2, 'user', 'now')
  const ref = { bytes: 1, mediaType: 'image/png' }
  earlier.content.push({ type: 'image', attachment: ref })
  current.content.push({ type: 'image', attachment: ref })
  const turn = {
    agent: { session: sessionOf([{ seq: 1, message: earlier }, { seq: 2, message: current }]) },
    inputs: [{ seq: 2, message: current }],
  }
  const config = { maxContextBytes: 4096, maxImageBytes: 2 }
  const signal = new AbortController().signal
  const attachments = { readImage: async () => ({ ref, data: new Uint8Array(3) }) }
  await assert.rejects(projectPrompt(turn, undefined, new Set(), false, config, attachments, signal), /byte limit/)

  current.content.pop()
  const [block] = await projectPrompt(turn, undefined, new Set(), false, config, attachments, signal)
  assert.match(payload(block.text).history[0].text, /Image omitted/)

  const controller = new AbortController()
  const cancelled = { readImage: async () => { controller.abort(); return { ref, data: new Uint8Array(1) } } }
  await assert.rejects(projectPrompt(turn, undefined, new Set(), false, config, cancelled, controller.signal), { name: 'AbortError' })
})
