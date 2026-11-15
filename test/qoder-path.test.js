import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { planQoder } from '../src/qoder-path.js'

const row = { id: 'qoder', title: 'Qoder', command: 'qodercli', args: ['--acp'], env: [] }
function layout({ bin = 'bundle/qodercli.js', env = {} } = {}) {
  const prefix = join(process.cwd(), 'fake npm prefix')
  const root = join(prefix, 'node_modules', '@qoder-ai', 'qodercli')
  const entry = join(root, 'bundle', 'qodercli.js')
  return { prefix, entry, options: { env: { APPDATA: '', npm_config_prefix: prefix, ...env },
    exists: (path) => path === entry,
    read: (path) => { assert.equal(path, join(root, 'package.json')); return JSON.stringify({ bin: { qodercli: bin } }) },
  } }
}

test('npm Qoder resolves to Node plus its declared JS entry, without spawning a cmd shim', () => {
  const { options, entry } = layout()
  const result = planQoder(row, options)
  assert.equal(result.command, 'node.exe')
  assert.deepEqual(result.args, [entry, '--acp'])
})

test('an existing legacy configuration discovers the npm install when its exe is gone', () => {
  const { options, entry } = layout()
  const result = planQoder({ ...row, command: 'C:/Users/Test/.qoder/bin/qodercli/qodercli.exe' }, options)
  assert.deepEqual(result.args, [entry, '--acp'])
})

test('explicit npm cmd override resolves to its JS entry and preserves custom arguments', () => {
  const { options, prefix, entry } = layout()
  options.env.DSH_ACP_QODER = join(prefix, 'qodercli.cmd')
  options.env.DSH_ACP_NODE = 'custom-node.exe'
  const result = planQoder({ ...row, args: ['--acp', '--custom'] }, options)
  assert.equal(result.command, 'custom-node.exe')
  assert.deepEqual(result.args, [entry, '--acp', '--custom'])
})

test('custom executables and missing explicit overrides are not silently replaced', () => {
  const { options } = layout()
  assert.equal(planQoder({ ...row, command: 'D:/tools/qoder-custom.exe' }, options).command, 'D:/tools/qoder-custom.exe')
  options.env.DSH_ACP_QODER = 'D:/missing/qodercli.exe'
  assert.equal(planQoder(row, options).command, options.env.DSH_ACP_QODER)
})

test('native legacy install is preserved; absent installations retain a PATH fallback', () => {
  const command = 'C:/Users/Test/.qoder/bin/qodercli/qodercli.exe'
  assert.equal(planQoder({ ...row, command }, { env: {}, exists: (p) => p === command }).command, command)
  assert.equal(planQoder(row, { env: {}, exists: () => false }).command, 'qodercli')
})

test('npm entries cannot escape the Qoder package directory', () => {
  const { options } = layout({ bin: '../outside.js' })
  assert.equal(planQoder(row, options).command, 'qodercli')
})
