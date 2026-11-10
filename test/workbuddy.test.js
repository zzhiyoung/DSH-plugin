import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { register } from 'node:module'
import { test } from 'node:test'

register(new URL('./support/hooks.mjs', import.meta.url).href)

const entry = await import('../index.js')
const { commandEnvironment } = await import('../src/connection.js')

function row(overrides = {}) {
  return { id: 'workbuddy', title: 'WorkBuddy', command: 'node.exe', args: [], env: [], ...overrides }
}

function background() {
  const warnings = []
  const adapters = []
  const ctx = {
    logger: { warn(message) { warnings.push(message) } },
    on() {
      return () => {}
    },
    provide() {},
    effect() {},
    get() {
      return undefined
    },
    llm: {
      registerAdapter(providers, adapter) {
        adapters.push({ providers: [...providers], adapter })
      },
    },
  }
  return { ctx, warnings, adapters }
}

async function layout(t, distFiles) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin')
  const dist = join(root, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist')
  await mkdir(bin, { recursive: true })
  await mkdir(dist, { recursive: true })
  for (const name of distFiles) await writeFile(join(dist, name), '')
  const cli = join(bin, 'codebuddy')
  await writeFile(cli, '#!/usr/bin/env node\n')
  return cli
}

test('the desktop package is launched through --serve so ACP reaches stdio', async (t) => {
  const cli = await layout(t, ['codebuddy-lite-wb.mjs'])

  const planned = entry.planWorkBuddy(row(), cli)

  assert.equal(planned.command, 'node.exe')
  assert.deepEqual(planned.args, [cli, '--serve', '--acp', '--acp-transport', 'stdio', '--port', '0'])
  assert.deepEqual(planned.env, ['CODEBUDDY_FORCE_LITE_WB_BUNDLE=1'])
})

test('a standalone CLI keeps the plain ACP entry and no forced bundle', async (t) => {
  const cli = await layout(t, ['codebuddy-headless.js'])

  const planned = entry.planWorkBuddy(row({ env: ['CODEBUDDY_API_KEY'] }), cli)

  assert.deepEqual(planned.args, [cli, '--acp', '--acp-transport', 'stdio'])
  assert.deepEqual(planned.env, ['CODEBUDDY_API_KEY'])
})

test('an executable launcher replaces the Node command', async (t) => {
  const cli = await layout(t, [])

  const planned = entry.planWorkBuddy(row(), `${cli}.exe`)

  assert.equal(planned.command, `${cli}.exe`)
  assert.deepEqual(planned.args, ['--acp', '--acp-transport', 'stdio'])
})

test('a bare command on PATH is launched directly', () => {
  const planned = entry.planWorkBuddy(row(), 'codebuddy')

  assert.equal(planned.command, 'codebuddy')
  assert.deepEqual(planned.args, ['--acp', '--acp-transport', 'stdio'])
})

test('operator arguments are left alone and a missing CLI plans nothing', async (t) => {
  const cli = await layout(t, ['codebuddy-lite-wb.mjs'])

  assert.equal(entry.planWorkBuddy(row({ args: ['--custom'] }), cli).args[0], '--custom')
  assert.equal(entry.planWorkBuddy(row(), undefined), undefined)
})

test('the entry point registers WorkBuddy when its CLI path is overridden', async (t) => {
  const cli = await layout(t, ['codebuddy-lite-wb.mjs'])
  const previous = process.env.DSH_ACP_WORKBUDDY
  process.env.DSH_ACP_WORKBUDDY = cli
  try {
    const { ctx, adapters } = background()
    entry.apply(ctx, {
      agents: [row()],
      execution: 'released',
      tools: [],
    })
    assert.deepEqual(adapters[0].providers, ['acp-workbuddy'])
    assert.equal(adapters[0].adapter.providerInfo('acp-workbuddy').name, 'WorkBuddy')
  } finally {
    if (previous === undefined) delete process.env.DSH_ACP_WORKBUDDY
    else process.env.DSH_ACP_WORKBUDDY = previous
  }
})

test('the entry point drops WorkBuddy when no CLI can be found', () => {
  const previous = process.env.DSH_ACP_WORKBUDDY
  process.env.DSH_ACP_WORKBUDDY = 'C:\\no-such-workbuddy\\cli\\bin\\codebuddy'
  try {
    const { ctx, warnings, adapters } = background()
    entry.apply(ctx, {
      agents: [row(), { id: 'codex', title: 'Codex', command: 'node.exe', args: ['--import', 'x'], env: [] }],
      execution: 'released',
      tools: [],
    })
    assert.deepEqual(adapters[0].providers, ['acp-codex'])
    assert.match(warnings[0], /skipped WorkBuddy/)
  } finally {
    if (previous === undefined) delete process.env.DSH_ACP_WORKBUDDY
    else process.env.DSH_ACP_WORKBUDDY = previous
  }
})

test('registry values yield the launcher of the installed desktop app', async (t) => {
  const cli = await layout(t, ['codebuddy-lite-wb.mjs'])
  const root = dirname(dirname(dirname(dirname(dirname(dirname(cli))))))

  assert.equal(entry.iconPath(`"${join(root, 'WorkBuddy', 'WorkBuddy.exe')}",0`), cli)
  assert.equal(entry.iconPath(`"${join(root, 'WorkBuddy', 'Uninstall WorkBuddy.exe')}" /allusers`), cli)
  assert.equal(entry.iconPath('C:\\nowhere\\WorkBuddy.exe,0'), undefined)
})

test('environment entries pass host values through or pin literals', () => {
  process.env.DSH_ACP_TEST_TOKEN = 'host-token'
  try {
    assert.deepEqual(
      commandEnvironment(['DSH_ACP_TEST_TOKEN', 'CODEBUDDY_FORCE_LITE_WB_BUNDLE=1']),
      { DSH_ACP_TEST_TOKEN: 'host-token', CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' },
    )
  } finally {
    delete process.env.DSH_ACP_TEST_TOKEN
  }
})
