import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const stubs = new Map([
  ['@deepseek-ai/dsh-llm', new URL('./stubs/dsh-llm.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-session', new URL('./stubs/dsh-session.mjs', import.meta.url).href],
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
  ['@agentclientprotocol/sdk', new URL('./stubs/acp-sdk.mjs', import.meta.url).href],
  ['@modelcontextprotocol/sdk/server/index.js', new URL('./stubs/mcp-server.mjs', import.meta.url).href],
  ['@modelcontextprotocol/sdk/server/streamableHttp.js', new URL('./stubs/mcp-http.mjs', import.meta.url).href],
  ['@modelcontextprotocol/sdk/types.js', new URL('./stubs/mcp-types.mjs', import.meta.url).href],
])

/**
 * Resolve the DSH and protocol packages this plugin imports to local stubs so
 * the plugin can be loaded and exercised outside a Harness installation.
 * @param specifier - bare or relative module specifier.
 * @param context - resolver context.
 * @param next - the default resolver.
 */
export async function resolve(specifier, context, next) {
  const realRoot = specifier.startsWith('@modelcontextprotocol/') ? process.env.DSH_TEST_PROTOCOL_ROOT : specifier === '@agentclientprotocol/sdk' ? process.env.DSH_TEST_ACP_ROOT : specifier === '@deepseek-ai/schemastery' ? process.env.DSH_TEST_SCHEMA_ROOT : undefined
  if (realRoot) {
    const resolve = createRequire(join(realRoot, 'package.json')).resolve
    return { url: pathToFileURL(resolve(specifier)).href, shortCircuit: true }
  }
  const stub = stubs.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return next(specifier, context)
}
