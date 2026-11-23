import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
register(new URL('./support/hooks.mjs', import.meta.url).href)
const { AgentConnections } = await import('../src/agent-connections.js')

function realConnections() {
  let spawns = 0
  const shutdown = new AbortController()
  const ctx = { subprocess: { spawn({ argv, cwd, env }) {
    spawns++
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const done = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
    return { stdin: child.stdin, stdout: child.stdout, done, terminate: () => child.kill(), waitForExit: async () => { await done; return true } }
  } } }
  const pool = new AgentConnections(ctx, { discoveryMs: 3000, loginMs: 3000, cancelGraceMs: 100 }, shutdown.signal)
  const cmd = { id: 'test', title: 'Test agent', command: process.execPath, args: [fileURLToPath(new URL('./support/fake-acp-agent.mjs', import.meta.url))], env: [] }
  return { pool, cmd, shutdown, get spawns() { return spawns } }
}

test('real ACP SDK preserves vendor auth errors and reuses an authenticated child across sessions', { skip: !process.env.DSH_TEST_ACP_ROOT }, async () => {
  const f = realConnections()
  const { pool, cmd, shutdown } = f
  try {
    await pool.inspect(cmd)
    await assert.rejects(pool.inspect(cmd, { verify: true }), (error) => error.code === 'AUTH')
    assert.equal((await pool.inspect(cmd, { verify: true, interactive: true })).verifiedModel, '@default')
    assert.equal((await pool.inspect(cmd, { verify: true })).verifiedModel, '@default')
    assert.equal(f.spawns, 1)
  } finally { shutdown.abort(); await pool.close() }
})

test('real ACP transport exits during an unbounded prompt without replaying it', { skip: !process.env.DSH_TEST_ACP_ROOT, timeout: 5000 }, async () => {
  const f = realConnections()
  const { pool, cmd, shutdown } = f
  cmd.args.push('--exit-on-prompt')
  try {
    const options = { cwd: process.cwd(), mcpTools: new Set(), signal: shutdown.signal }
    let prompts = 0
    const prompt = pool.use(cmd, options, (connection) => {
      prompts++
      return connection.prompt('hello', { signal: shutdown.signal })
    })
    await assert.rejects(prompt, (error) => error.code === 'ACP_TRANSPORT' && error.acpStage === 'session/prompt')
    assert.equal(f.spawns, 1)
    assert.equal(prompts, 1)
  } finally { shutdown.abort(); await pool.close() }
})
