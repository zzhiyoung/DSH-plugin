import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { promptFailure } = await import('../src/acp-result.js')

test('vendor backend errors are classified without disclosing raw details or URLs', () => {
  for (const [message, code] of [['Authentication required', 'AUTH'], ['quota exhausted', 'QUOTA'], ['too many requests 429', 'RATE_LIMIT'], ['backend exploded secret=ABC https://example.com/token', 'SERVER']]) {
    const error = promptFailure({ stopReason: 'refusal', _meta: { 'codebuddy.ai/errorMessage': JSON.stringify({ message }) } }, 'WorkBuddy')
    assert.equal(error.code, code)
    assert.doesNotMatch(error.message, /ABC|https:/)
  }
})

test('plain refusal is distinguished from backend authentication, and successful turns stay successful', () => {
  assert.equal(promptFailure({ stopReason: 'refusal' }, 'Qoder').code, 'ACP_REFUSAL')
  assert.equal(promptFailure({ stopReason: 'end_turn' }, 'Codex'), undefined)
})
