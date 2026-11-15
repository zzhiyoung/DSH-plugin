import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyHub, Config, inject, name } from './src/index.js'
import { planQoder } from './src/qoder-path.js'

export { Config, inject, name }

const codexDesktop = new URL('./codex-desktop.mjs', import.meta.url).href
const bundledAdapter = fileURLToPath(new URL('./vendor/codex-acp/dist/index.js', import.meta.url))
const WORKBUDDY = 'workbuddy'
const WORKBUDDY_CLI = join('WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
let registryLookup

/** Extract a launcher from one `reg query` field, tolerating quotes and `,0` icons. */
export function iconPath(value) {
  const raw = value.trim()
  const quoted = /^"([^"]+)"/.exec(raw)
  const path = (quoted === null ? raw : quoted[1]).replace(/,\d+$/, '')
  const cli = join(dirname(path), 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
  return existsSync(cli) ? cli : undefined
}

/**
 * Ask the uninstall registry where WorkBuddy lives. The installer records no
 * InstallLocation, so `DisplayIcon` (and `UninstallString` as a fallback) is
 * the only path hint, and it is what makes non-default drives work.
 * @returns the launcher script, or undefined when the registry has no match.
 */
function registryWorkBuddy() {
  if (registryLookup !== undefined) return registryLookup
  for (const key of UNINSTALL_KEYS) {
    let output
    try {
      output = execFileSync('reg.exe', ['query', key, '/s', '/f', 'WorkBuddy', '/d'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      continue
    }
    for (const match of output.matchAll(/(?:DisplayIcon|UninstallString)\s+REG_\w+\s+(.+)\r?$/gm)) {
      const cli = iconPath(match[1])
      if (cli !== undefined) return (registryLookup = cli)
    }
  }
  return registryLookup
}

/**
 * Locate the WorkBuddy desktop CLI launcher. `DSH_ACP_WORKBUDDY` wins; then the
 * two Program Files roots and the per-user Programs root are probed; finally
 * the uninstall registry is consulted, because WorkBuddy often installs on a
 * non-system drive.
 * @returns the launcher script, an executable, or undefined when absent.
 */
function locateWorkBuddy() {
  const override = process.env.DSH_ACP_WORKBUDDY?.trim()
  if (override !== undefined && override !== '') {
    if (!override.includes('\\') && !override.includes('/')) return override
    return existsSync(override) ? override : undefined
  }
  const localAppData = process.env.LOCALAPPDATA
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    localAppData === undefined ? undefined : join(localAppData, 'Programs'),
  ]
  for (const root of roots) {
    if (root === undefined || root === '') continue
    const candidate = join(root, WORKBUDDY_CLI)
    if (existsSync(candidate)) return candidate
  }
  return registryWorkBuddy()
}

/**
 * Turn the WorkBuddy row into an explicit launcher. The desktop package ships
 * only the `codebuddy-lite-wb` bundle, which exposes ACP on stdio only through
 * `--serve --acp --acp-transport stdio`; a standalone CLI keeps plain `--acp`.
 * @param agent - the configured WorkBuddy row.
 * @param cli - resolved launcher, or undefined when WorkBuddy is not installed.
 * @returns the patched row, or undefined when the agent is unavailable.
 */
export function planWorkBuddy(agent, cli = locateWorkBuddy()) {
  if (agent.id !== WORKBUDDY) return agent
  // WorkBuddy authenticate() explicitly logs out first; do not force a login by default.
  agent = { ...agent, authMode: agent.authMode ?? 'existing' }
  if (agent.args.length > 0) return agent
  if (cli === undefined) return undefined
  const hasDirectory = cli.includes('\\') || cli.includes('/')
  const dist = hasDirectory ? join(dirname(cli), '..', 'dist') : undefined
  const hasLiteBundle = dist !== undefined && existsSync(join(dist, 'codebuddy-lite-wb.mjs'))
  const hasHeadlessBundle = dist !== undefined && existsSync(join(dist, 'codebuddy-headless.js'))
  const desktopLayout = hasLiteBundle && !hasHeadlessBundle
  // Both bundles expose stdio ACP through a local HTTP server. The standalone
  // full CLI otherwise binds a fixed port that the running WorkBuddy desktop
  // already owns (EADDRINUSE on 127.0.0.1:13034), so always ask for a free one.
  const serveAcp = desktopLayout || hasHeadlessBundle
  const args = [
    ...(serveAcp ? ['--serve'] : []),
    '--acp',
    '--acp-transport',
    'stdio',
    ...(serveAcp ? ['--port', '0'] : []),
  ]
  const env = [...agent.env]
  if (desktopLayout) {
    // The desktop's encrypted auth store requires its private bootstrap environment.
    // A standalone ACP process keeps its own login in memory instead of watching/writing that store.
    for (const variable of ['CODEBUDDY_FORCE_LITE_WB_BUNDLE', 'CODEBUDDY_CREDENTIALS_IN_MEMORY']) {
      if (!env.some((entry) => entry.split('=')[0] === variable)) env.push(`${variable}=1`)
    }
  }
  const override = process.env.DSH_ACP_WORKBUDDY_AUTH?.trim()
  const auth = agent.auth ?? (override === undefined || override === '' ? 'internal' : override)
  return /\.(?:exe|cmd|bat)$/i.test(cli) || !hasDirectory
    ? { ...agent, command: cli, args, env, auth }
    : { ...agent, args: [cli, ...args], env, auth }
}

/**
 * Patch the built-in agent rows, then hand the configuration to the hub.
 * A WorkBuddy row is dropped when its CLI cannot be found, so the plugin still
 * loads on machines without WorkBuddy.
 * @param ctx - Cordis context owning the registration.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const agents = []
  for (const agent of config.agents) {
    if (agent.id === 'qoder') {
      agents.push(planQoder(agent))
      continue
    }
    if (agent.id === 'codex' && agent.args.length === 0) {
      const entry = process.env.DSH_ACP_CODEX_ENTRY || bundledAdapter
      agents.push({ ...agent, args: ['--import', codexDesktop, entry] })
      continue
    }
    if (agent.id === WORKBUDDY) {
      const planned = planWorkBuddy(agent)
      if (planned === undefined) {
        ctx.logger?.warn?.('ACP Hub skipped WorkBuddy because its CLI was not found. Set DSH_ACP_WORKBUDDY to the codebuddy launcher.')
        continue
      }
      agents.push(planned)
      continue
    }
    agents.push(agent)
  }
  if (agents.length === 0) throw new Error('ACP Hub has no available agents. Configure one of the built-in rows or set DSH_ACP_WORKBUDDY.')
  applyHub(ctx, { ...config, agents })
}
