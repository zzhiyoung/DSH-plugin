import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The helper the Codex app server spawns from its own directory. Code mode fails
 * closed without it, so an install that lacks it can answer text but cannot run
 * a single command.
 */
export const CODE_MODE_HOST = 'codex-code-mode-host.exe'

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function modified(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function subdirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
  } catch {
    return []
  }
}

/**
 * @param executable - absolute path to a `codex.exe`.
 * @returns whether the helper binary sits next to it.
 */
export function hasCodeModeHost(executable) {
  return isFile(join(dirname(executable), CODE_MODE_HOST))
}

function isBareCommand(value) {
  return !value.includes('\\') && !value.includes('/')
}

/** Newest `vendor/<target>/bin/codex.exe` below one npm package directory. */
function vendorExecutable(packageDirectory) {
  let newest
  for (const vendor of subdirectories(join(packageDirectory, 'vendor'))) {
    const executable = join(vendor, 'bin', 'codex.exe')
    if (!isFile(executable)) continue
    if (newest === undefined || modified(executable) > modified(newest)) newest = executable
  }
  return newest
}

/**
 * `npm install -g @openai/codex` keeps the native binary in a platform package,
 * either nested under the main package or hoisted beside it.
 * @param appData - `%APPDATA%`.
 * @returns codex executables, newest first.
 */
function npmExecutables(appData) {
  if (appData === undefined || appData === '') return []
  const scope = join(appData, 'npm', 'node_modules', '@openai')
  const main = join(scope, 'codex')
  const packages = [main, ...subdirectories(join(main, 'node_modules', '@openai')), ...subdirectories(scope)]
  return [...new Set(packages.map(vendorExecutable).filter((executable) => executable !== undefined))]
    .sort((left, right) => modified(right) - modified(left))
}

/**
 * Codex Desktop unpacks one directory per version under `OpenAI\Codex\bin`, and
 * only some of those versions ship the code-mode host.
 * @param localAppData - `%LOCALAPPDATA%`.
 * @returns codex executables, newest first.
 */
function desktopExecutables(localAppData) {
  if (localAppData === undefined || localAppData === '') return []
  const bin = join(localAppData, 'OpenAI', 'Codex', 'bin')
  return subdirectories(bin)
    .map((directory) => join(directory, 'codex.exe'))
    .filter(isFile)
    .sort((left, right) => modified(right) - modified(left))
}

function warnToStderr(message) {
  process.stderr.write(`[dsh-acp-agent-hub] ${message}\n`)
}

/**
 * Pick the Codex executable the ACP adapter should run.
 *
 * `CODEX_PATH` stays authoritative, but an explicit path that points at an
 * install without the code-mode host is a trap: the agent still starts and chats,
 * then every command tool fails with "code mode host executable not found".
 * When that happens the resolver prefers a complete install and says so.
 *
 * @param options - `env` overrides the process environment, `warn` collects notices.
 * @returns the executable path, or the bare `codex` command as a last resort.
 */
export function resolveCodexPath({ env = process.env, warn = warnToStderr } = {}) {
  const installed = [...npmExecutables(env.APPDATA), ...desktopExecutables(env.LOCALAPPDATA)]
  const override = env.CODEX_PATH?.trim()
  if (override !== undefined && override !== '' && (isBareCommand(override) || hasCodeModeHost(override))) {
    return override
  }
  const complete = installed.find(hasCodeModeHost)
  if (override !== undefined && override !== '') {
    if (complete !== undefined) {
      warn(`CODEX_PATH points at ${override}, which has no ${CODE_MODE_HOST}; using ${complete} instead so code mode can start.`)
      return complete
    }
    warn(`CODEX_PATH points at ${override}, which has no ${CODE_MODE_HOST}; Codex code mode will fail. Install the official CLI (npm install -g @openai/codex) and point CODEX_PATH at its bin\\codex.exe.`)
    return override
  }
  return complete ?? installed[0] ?? 'codex'
}
