import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBlockWriter } from '../src/stream-blocks.js'

test('streams one text block and closes it', () => {
  const chunks = []
  const write = createBlockWriter((chunk) => chunks.push(chunk))

  write.text('Hel')
  write.text('lo')
  write.flush()

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
  ])
})

test('closes the open block when the fragment kind changes', () => {
  const chunks = []
  const write = createBlockWriter((chunk) => chunks.push(chunk))

  write.reasoning('Thinking')
  write.text('Answer')
  write.flush()

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Answer' } },
  ])
})

test('ignores empty fragments and flushes nothing while idle', () => {
  const chunks = []
  const write = createBlockWriter((chunk) => chunks.push(chunk))

  write.text('')
  write.reasoning('')
  write.flush()

  assert.deepEqual(chunks, [])
})

test('flushing twice closes only the block that is open', () => {
  const chunks = []
  const write = createBlockWriter((chunk) => chunks.push(chunk))

  write.text('once')
  write.flush()
  write.flush()

  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end').length, 1)
})
