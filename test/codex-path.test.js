import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { resolveCodexPath, hasCodeModeHost } from '../src/codex-path.js'

/** Create an empty file and give it a fixed modification time. */
async function touch(path, seconds) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '')
  await utimes(path, seconds, seconds)
}

/** The layout `npm install -g @openai/codex` produces on win32. */
async function npmLayout(root, { host = true, seconds = 100 } = {}) {
  const bin = join(root, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
  const executable = join(bin, 'codex.exe')
  await touch(executable, seconds)
  if (host) await touch(join(bin, 'codex-code-mode-host.exe'), seconds)
  return executable
}

/** One versioned Codex Desktop unpack directory. */
async function desktopLayout(root, hash, { host = true, seconds = 100 } = {}) {
  const bin = join(root, 'OpenAI', 'Codex', 'bin', hash)
  const executable = join(bin, 'codex.exe')
  await touch(executable, seconds)
  if (host) await touch(join(bin, 'codex-code-mode-host.exe'), seconds)
  return executable
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    env(overrides = {}) {
      return { APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'local'), ...overrides }
    },
  }
}

test('hasCodeModeHost only accepts a sibling helper', async (t) => {
  const fs = await sandbox(t)
  const complete = await desktopLayout(fs.env().LOCALAPPDATA, 'a')
  const incomplete = await desktopLayout(fs.env().LOCALAPPDATA, 'b', { host: false })
  assert.equal(hasCodeModeHost(complete), true)
  assert.equal(hasCodeModeHost(incomplete), false)
  assert.equal(hasCodeModeHost('codex'), false)
})

test('a complete CODEX_PATH is used unchanged', async (t) => {
  const fs = await sandbox(t)
  const override = await desktopLayout(fs.env().LOCALAPPDATA, 'a')
  await npmLayout(fs.env().APPDATA)
  const warnings = []
  assert.equal(resolveCodexPath({ env: fs.env({ CODEX_PATH: override }), warn: (line) => warnings.push(line) }), override)
  assert.deepEqual(warnings, [])
})

test('a host-less CODEX_PATH falls back to a complete install', async (t) => {
  const fs = await sandbox(t)
  const sandboxed = join(fs.root, 'codex', '.sandbox-bin', 'codex.exe')
  await touch(sandboxed, 200)
  const cli = await npmLayout(fs.env().APPDATA)
  const warnings = []
  assert.equal(resolveCodexPath({ env: fs.env({ CODEX_PATH: sandboxed }), warn: (line) => warnings.push(line) }), cli)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /codex-code-mode-host\.exe/)
  assert.ok(warnings[0].includes(sandboxed))
  assert.ok(warnings[0].includes(cli))
})

test('a host-less CODEX_PATH is kept when nothing complete exists', async (t) => {
  const fs = await sandbox(t)
  const sandboxed = join(fs.root, 'codex', '.sandbox-bin', 'codex.exe')
  await touch(sandboxed, 200)
  const warnings = []
  assert.equal(resolveCodexPath({ env: fs.env({ CODEX_PATH: sandboxed }), warn: (line) => warnings.push(line) }), sandboxed)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /npm install -g @openai\/codex/)
})

test('without CODEX_PATH the npm CLI wins over Codex Desktop', async (t) => {
  const fs = await sandbox(t)
  const desktop = await desktopLayout(fs.env().LOCALAPPDATA, 'a', { seconds: 900 })
  const cli = await npmLayout(fs.env().APPDATA, { seconds: 100 })
  const warnings = []
  assert.equal(resolveCodexPath({ env: fs.env(), warn: (line) => warnings.push(line) }), cli)
  assert.notEqual(cli, desktop)
  assert.deepEqual(warnings, [])
})

test('without CODEX_PATH the newest complete Desktop build wins', async (t) => {
  const fs = await sandbox(t)
  const complete = await desktopLayout(fs.env().LOCALAPPDATA, 'old', { seconds: 100 })
  await desktopLayout(fs.env().LOCALAPPDATA, 'new', { host: false, seconds: 900 })
  assert.equal(resolveCodexPath({ env: fs.env(), warn() {} }), complete)
})

test('a bare command name is trusted as configured', async (t) => {
  const fs = await sandbox(t)
  const warnings = []
  assert.equal(resolveCodexPath({ env: fs.env({ CODEX_PATH: 'codex' }), warn: (line) => warnings.push(line) }), 'codex')
  assert.deepEqual(warnings, [])
})

test('nothing installed leaves the adapter on the bare command', async (t) => {
  const fs = await sandbox(t)
  assert.equal(resolveCodexPath({ env: fs.env(), warn() {} }), 'codex')
})
