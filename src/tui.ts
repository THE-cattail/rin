// @ts-nocheck
import path from 'node:path'

import { DaemonTuiRpcClient } from './daemon-tui-rpc'
import { importPiCodingAgentModule, importPiTuiModule } from './pi-upstream'
import { resolveRinLayout } from './runtime-paths'

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

async function installBuiltinTuiKeybindings() {
  try {
    const piTui = await importPiTuiModule()
    const defaults = piTui && piTui.DEFAULT_EDITOR_KEYBINDINGS
    if (!defaults || typeof defaults !== 'object') return
    const current = Array.isArray(defaults.newLine)
      ? defaults.newLine.map((value: any) => safeString(value).trim()).filter(Boolean)
      : [safeString(defaults.newLine).trim()].filter(Boolean)
    defaults.newLine = Array.from(new Set([...current, 'ctrl+j']))
  } catch {}
}

async function main() {
  await installBuiltinTuiKeybindings()
  const { runRinDaemonTui } = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'rin-daemon-mode.js'))
  await runRinDaemonTui({
    argv: process.argv.slice(2),
    DaemonTuiRpcClient,
    importPiCodingAgentModule,
    resolveRinLayout,
  })
}

main().catch((error: any) => {
  const message = String(error && error.message ? error.message : error || 'rin_tui_failed')
  console.error(message)
  process.exit(1)
})
