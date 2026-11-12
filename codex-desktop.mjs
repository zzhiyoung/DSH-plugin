import { resolveCodexPath } from './src/codex-path.js'

// The adapter reads CODEX_PATH and falls back to the bundled dependency, so the
// resolution has to land in the environment before the adapter starts.
process.env.CODEX_PATH = resolveCodexPath()
