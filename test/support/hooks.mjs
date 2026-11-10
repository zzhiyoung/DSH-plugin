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
  const stub = stubs.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return next(specifier, context)
}
