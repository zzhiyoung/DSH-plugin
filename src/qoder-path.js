import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Resolve npm's JS entry directly: Windows cannot spawn npm .cmd shims as executables. */
export function planQoder(agent, { env = process.env, exists = existsSync, read = readFileSync } = {}) {
  if (agent.id !== 'qoder') return agent
  const node = env.DSH_ACP_NODE || 'node.exe'
  const args = agent.args.length ? agent.args : ['--acp']
  const npmEntry = (prefix) => {
    const root = join(prefix, 'node_modules', '@qoder-ai', 'qodercli')
    try {
      const pkg = JSON.parse(read(join(root, 'package.json'), 'utf8'))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.qodercli
      if (typeof bin !== 'string' || isAbsolute(bin)) return undefined
      const entry = resolve(root, bin), rel = relative(root, entry)
      if (rel.startsWith('..') || isAbsolute(rel) || !exists(entry)) return undefined
      return entry
    } catch { return undefined }
  }
  const launch = (command) => {
    if (/\.(?:m?js|cjs)$/i.test(command)) return { ...agent, command: node, args: [command, ...args] }
    if (/qodercli\.cmd$/i.test(command)) {
      const entry = npmEntry(dirname(command))
      if (entry) return { ...agent, command: node, args: [entry, ...args] }
    }
    return { ...agent, command, args }
  }
  const override = env.DSH_ACP_QODER?.trim()
  if (override) return launch(override)
  const command = agent.command
  const automatic = /^(?:qodercli(?:\.exe|\.cmd)?)$/i.test(command) || /[\\/]\.qoder[\\/]bin[\\/]qodercli[\\/]qodercli\.exe$/i.test(command)
  if (!automatic || exists(command)) return launch(command)
  const legacy = env.USERPROFILE && join(env.USERPROFILE, '.qoder', 'bin', 'qodercli', 'qodercli.exe')
  if (legacy && exists(legacy)) return launch(legacy)
  const prefixes = new Set([
    env.npm_config_prefix, env.NPM_CONFIG_PREFIX,
    env.APPDATA && join(env.APPDATA, 'npm'),
    ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean),
  ].filter(Boolean))
  for (const prefix of prefixes) {
    const entry = npmEntry(prefix)
    if (entry) return launch(entry)
    const native = join(prefix, 'qodercli.exe')
    if (exists(native)) return launch(native)
  }
  return { ...agent, command: 'qodercli', args }
}
