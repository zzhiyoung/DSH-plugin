#!/usr/bin/env node
/**
 * Live ACP handshake probe.
 *
 * Starts an ACP agent CLI, sends `initialize`, then `session/new`, and prints
 * every NDJSON frame it receives. Use it to check an agent before adding it to
 * the plugin configuration: the probe fails loudly when the executable is
 * missing, the ACP version does not match, or the agent is not signed in.
 *
 * Usage:
 *   node scripts/probe-acp.mjs -- <command> [args...]
 *   node scripts/probe-acp.mjs --env KEY=VALUE -- <command> [args...]
 *   node scripts/probe-acp.mjs --timeout 30000 --cwd D:\repo -- <command> [args...]
 *
 * Example (WorkBuddy desktop CLI on Windows):
 *   node scripts/probe-acp.mjs --env CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 -- \
 *     node "D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy" --acp
 */

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = 1
const DEFAULTS = { timeoutMs: 0, cwd: process.cwd() }

function parse(argv) {
  const options = { ...DEFAULTS, env: {}, command: [], timeout: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      options.command = argv.slice(index + 1)
      break
    }
    if (token === '--env') {
      const pair = argv[++index] ?? ''
      const at = pair.indexOf('=')
      if (at <= 0) throw new Error(`--env expects KEY=VALUE, got ${JSON.stringify(pair)}`)
      options.env[pair.slice(0, at)] = pair.slice(at + 1)
      continue
    }
    if (token === '--timeout') {
      options.timeout = Number(argv[++index])
      if (!Number.isFinite(options.timeout) || options.timeout < 0) throw new Error('--timeout expects milliseconds (0 disables the deadline)')
      continue
    }
    if (token === '--auth') {
      options.auth = argv[++index]
      if (!options.auth) throw new Error('--auth expects a method id')
      continue
    }
    if (token === '--cwd') {
      options.cwd = argv[++index]
      if (typeof options.cwd !== 'string' || options.cwd === '') throw new Error('--cwd expects a directory')
      continue
    }
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    throw new Error(`Unknown option ${JSON.stringify(token)}. Put agent arguments after "--".`)
  }
  return options
}

const USAGE = `Usage: node scripts/probe-acp.mjs [--env K=V] [--auth method] [--timeout ms] [--cwd dir] -- <command> [args...]

Starts an ACP agent, performs initialize and session/new, and prints every NDJSON
frame plus a summary (protocol version, models, MCP capability, auth methods).

Example:
  node scripts/probe-acp.mjs --env CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 -- \\
    node "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy" --serve --acp --acp-transport stdio --port 0
`

const options = parse(process.argv.slice(2))

if (options.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

if (options.command.length === 0) {
  process.stderr.write(USAGE)
  process.exit(64)
}

const [command, ...args] = options.command
const started = Date.now()
const child = spawn(command, args, {
  cwd: options.cwd,
  env: { ...process.env, ...options.env },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const pending = new Map()
let buffer = ''
let nextId = 1
let settled = false

function send(method, params) {
  const id = nextId++
  const frame = { jsonrpc: '2.0', id, method, params }
  process.stdout.write(`--> ${JSON.stringify(frame)}\n`)
  child.stdin.write(`${JSON.stringify(frame)}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method })
  })
}

function receive(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stdout.write(`[non-json stdout omitted]\n`)
    return
  }
  process.stdout.write(`<-- ${line}\n`)
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${entry.method} failed: ${message.error.code} ${message.error.message}`))
    else entry.resolve(message.result)
    return
  }
  // Agent-to-client request: answer the ones a bare client can answer.
  if (message.method === 'session/request_permission') {
    const allow = message.params?.options?.find((option) => option.kind === 'reject_once')
    const frame = allow === undefined
      ? { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }
      : { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } }
    process.stdout.write(`--> ${JSON.stringify(frame)}\n`)
    child.stdin.write(`${JSON.stringify(frame)}\n`)
    return
  }
  if (message.id !== undefined) {
    const frame = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported client method ${message.method}` } }
    process.stdout.write(`--> ${JSON.stringify(frame)}\n`)
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).replace(/\r$/, '')
    buffer = buffer.slice(at + 1)
    if (line.trim() !== '') receive(line)
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[agent stderr] ${chunk}`))

const timeoutMs = options.timeout ?? DEFAULTS.timeoutMs
const deadline = timeoutMs > 0 ? setTimeout(() => {
  fail(new Error(`ACP handshake did not finish within ${options.timeout ?? DEFAULTS.timeoutMs} ms`))
}, timeoutMs) : undefined
deadline?.unref?.()

function fail(error) {
  if (settled) return
  settled = true
  clearTimeout(deadline)
  process.stderr.write(`\nprobe failed after ${Date.now() - started} ms: ${error.message}\n`)
  child.kill()
  process.exitCode = 1
  setTimeout(() => process.exit(1), 100).unref()
}

child.on('error', (error) => fail(new Error(`could not start ${command}: ${error.message}`)))
child.on('exit', (code, signal) => {
  if (!settled) fail(new Error(`agent exited early (code ${code}, signal ${signal})`))
})

try {
  const init = await send('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'dsh-agent-hub-probe', title: 'DSH ACP Probe', version: '0.0.0' },
  })
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`agent negotiated ACP protocolVersion ${init.protocolVersion}, plugin requires ${PROTOCOL_VERSION}`)
  }
  if (options.auth) await send('authenticate', { methodId: options.auth })
  const session = await send('session/new', { cwd: options.cwd, mcpServers: [] })
  if (typeof session.sessionId !== 'string' || session.sessionId === '') {
    throw new Error('agent returned an empty session id')
  }
  const config = session.configOptions?.find((option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'))
  const models = config?.options?.flatMap((option) => ('options' in option ? option.options : [option])) ?? []
  settled = true
  clearTimeout(deadline)
  process.stdout.write(`\nprobe ok after ${Date.now() - started} ms\n`)
  process.stdout.write(`session: ${session.sessionId}\n`)
  process.stdout.write(`model selector: ${config === undefined ? 'absent (plugin will show the Default model row)' : `${config.id} (current ${config.currentValue})`}\n`)
  process.stdout.write(`models: ${models.length === 0 ? 'none advertised' : models.map((model) => model.value).join(', ')}\n`)
  process.stdout.write(`image prompt: ${init.agentCapabilities?.promptCapabilities?.image === true ? 'yes' : 'no'}\n`)
  process.stdout.write(`mcp http: ${init.agentCapabilities?.mcpCapabilities?.http === true ? 'yes' : 'no'}\n`)
  const auth = init.authMethods?.map((method) => method.id) ?? []
  process.stdout.write(`auth methods: ${auth.length === 0 ? 'none advertised' : auth.join(', ')}\n`)
  child.stdin.end()
  setTimeout(() => {
    child.kill()
    process.exit(0)
  }, 300).unref()
  await new Promise(() => {})
} catch (error) {
  fail(error)
}
