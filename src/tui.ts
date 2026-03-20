// @ts-nocheck
import path from 'node:path'

import { DaemonTuiRpcClient } from './daemon-tui-rpc'
import { importPiCodingAgentModule } from './pi-upstream'
import { resolveRinLayout } from './runtime-paths'

async function main() {
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
