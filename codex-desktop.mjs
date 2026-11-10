import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function installedCodex(localAppData) {
  const bin = join(localAppData, 'OpenAI', 'Codex', 'bin')
  let entries
  try {
    entries = readdirSync(bin, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return undefined
    throw error
  }
  let newest
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const executable = join(bin, entry.name, 'codex.exe')
    const info = statSync(executable, { throwIfNoEntry: false })
    if (info?.isFile() && (newest === undefined || info.mtimeMs > newest.modified)) {
      newest = { executable, modified: info.mtimeMs }
    }
  }
  return newest?.executable
}

if (!process.env.CODEX_PATH) {
  const localAppData = process.env.LOCALAPPDATA
  const executable = localAppData ? installedCodex(localAppData) : undefined
  process.env.CODEX_PATH = executable ?? 'codex'
}
