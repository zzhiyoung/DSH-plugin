import { fileURLToPath } from 'node:url'
import { apply as applyHub, Config, inject, name } from './src/index.js'

export { Config, inject, name }

const codexDesktop = new URL('./codex-desktop.mjs', import.meta.url).href
const bundledAdapter = fileURLToPath(new URL('./vendor/codex-acp/dist/index.js', import.meta.url))

/**
 * Point the Codex row at the bundled ACP adapter unless the operator configured
 * its own arguments or `DSH_ACP_CODEX_ENTRY`.
 * @param ctx - Cordis context owning the registration.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const agents = config.agents.map((agent) => {
    if (agent.id !== 'codex' || agent.args.length > 0) return agent
    const entry = process.env.DSH_ACP_CODEX_ENTRY || bundledAdapter
    return { ...agent, args: ['--import', codexDesktop, entry] }
  })
  applyHub(ctx, { ...config, agents })
}
