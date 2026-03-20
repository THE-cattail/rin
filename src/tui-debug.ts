// @ts-nocheck
import os from 'node:os'
import path from 'node:path'

import { importPiTuiModule } from './pi-upstream'
import { createRinPiSession, queueBrainFinalizeAsync, flushBrainQueue } from './runtime'
import { resolveRinLayout } from './runtime-paths'

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function expandHome(value: string): string {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (raw === '~') return process.env.HOME || raw
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2))
  return raw
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

async function runRinInteractiveMode({
  repoRoot,
  workspaceRoot,
  sessionFile = '',
  provider = '',
  model = '',
  thinking = '',
}: {
  repoRoot: string
  workspaceRoot: string
  sessionFile?: string
  provider?: string
  model?: string
  thinking?: string
}): Promise<void> {
  await installBuiltinTuiKeybindings()
  const sessionHome = process.env.HOME || os.homedir()
  const brainChatKey = 'local:default'
  const { pi, session, modelFallbackMessage } = await createRinPiSession({
    repoRoot,
    workspaceRoot,
    sessionCwd: sessionHome,
    resourceCwd: workspaceRoot,
    settingsCwd: workspaceRoot,
    sessionFile,
    sessionPolicy: 'new',
    brainChatKey,
    currentChatKey: '',
    provider,
    model,
    thinking,
  })

  const mode = new pi.InteractiveMode(session, {
    modelFallbackMessage,
  })

  let finalizedBrain = false
  const finalizeBrain = async (reason = 'manual') => {
    if (finalizedBrain) return
    finalizedBrain = true
    try { queueBrainFinalizeAsync({ repoRoot, stateRoot: workspaceRoot, chatKey: brainChatKey, reason }) } catch {}
    try { await flushBrainQueue({ repoRoot, stateRoot: workspaceRoot, chatKey: brainChatKey, timeoutMs: 8000 }) } catch {}
  }

  const originalShutdown = typeof mode.shutdown === 'function' ? mode.shutdown.bind(mode) : null
  if (originalShutdown && session?.settingsManager && typeof session.settingsManager.flush === 'function') {
    mode.shutdown = async () => {
      try { await finalizeBrain('manual') } catch {}
      try { await session.settingsManager.flush() } catch {}
      return await originalShutdown()
    }
  }

  try {
    await mode.run()
  } finally {
    try { await finalizeBrain('manual') } catch {}
    if (session?.settingsManager && typeof session.settingsManager.flush === 'function') {
      try { await session.settingsManager.flush() } catch {}
    }
    if (session && typeof session.dispose === 'function') {
      try { session.dispose() } catch {}
    }
  }
}

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  rin pi [--session <path>] [--provider <id>] [--model <id>] [--thinking <level>]',
    '',
    'Runs Rin using Pi\'s native InteractiveMode via the SDK.',
  ].join('\n')
  if (exitCode === 0) console.log(text)
  else console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]) {
  let sessionFile = ''
  let provider = ''
  let model = ''
  let thinking = ''

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help' || a === 'help') usage(0)
    if (a === '--session') { sessionFile = path.resolve(expandHome(argv[i + 1] || '')); i += 1; continue }
    if (a === '--provider') { provider = safeString(argv[i + 1]); i += 1; continue }
    if (a === '--model') { model = safeString(argv[i + 1]); i += 1; continue }
    if (a === '--thinking') { thinking = safeString(argv[i + 1]); i += 1; continue }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  return { sessionFile, provider, model, thinking }
}

async function main() {
  const { sessionFile, provider, model, thinking } = parseArgs(process.argv.slice(2))
  const repoRoot = path.resolve(safeString(process.env.RIN_REPO_ROOT).trim() || path.join(__dirname, '..'))
  const workspaceRoot = resolveRinLayout().homeRoot

  await runRinInteractiveMode({
    repoRoot,
    workspaceRoot,
    sessionFile,
    provider,
    model,
    thinking,
  })
}

main().catch((error: any) => {
  const message = safeString(error && error.message ? error.message : error) || 'rin_tui_debug_failed'
  console.error(message)
  process.exit(1)
})
