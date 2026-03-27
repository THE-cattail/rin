// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'

import { createRinPiSession, safeString } from './runtime'

function extractAssistantText(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block: any) => block && typeof block === 'object' && safeString(block.type) === 'text')
    .map((block: any) => safeString(block.text))
    .join('\n')
    .trim()
}

function setSessionSystemPrompt(session: any, systemPrompt: string) {
  const next = safeString(systemPrompt).trim()
  if (!next || !session) return
  try { session._baseSystemPrompt = next } catch {}
  try {
    if (session.agent && session.agent.state && typeof session.agent.state === 'object') {
      session.agent.state.systemPrompt = next
    }
  } catch {}
  try {
    if (session.agent && typeof session.agent.setSystemPrompt === 'function') session.agent.setSystemPrompt(next)
  } catch {}
}

function emit(payload: any) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  } catch {}
}

async function main() {
  const payloadPath = path.resolve(safeString(process.argv[2]).trim())
  if (!payloadPath) throw new Error('missing_subagent_payload')
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  let session: any = null
  let unsubscribe: (() => void) | null = null
  let lastAssistantText = ''
  let lastAssistantUsage: any = null
  let aborted = false

  try {
    const created = await createRinPiSession({
      repoRoot: safeString(payload && payload.repoRoot).trim(),
      workspaceRoot: path.resolve(safeString(payload && payload.workspaceRoot).trim()),
      sessionCwd: path.resolve(safeString(payload && payload.cwd).trim() || process.cwd()),
      resourceCwd: path.resolve(safeString(payload && payload.workspaceRoot).trim() || process.cwd()),
      settingsCwd: path.resolve(safeString(payload && payload.workspaceRoot).trim() || process.cwd()),
      sessionPolicy: 'new',
      inMemorySession: true,
      provider: safeString(payload && payload.provider).trim(),
      model: safeString(payload && payload.model).trim(),
      thinking: safeString(payload && payload.thinking).trim(),
      currentChatKey: safeString(payload && payload.currentChatKey).trim(),
      toolSessionDir: safeString(payload && payload.parentSessionDir).trim(),
      toolSessionFile: safeString(payload && payload.parentSessionFile).trim(),
      enableBrainHooks: false,
    })
    session = created && created.session
    if (!session) throw new Error('subagent_session_missing')

    const toolNames = Array.isArray(payload && payload.toolNames)
      ? payload.toolNames.map((item: any) => safeString(item).trim()).filter(Boolean)
      : []
    if (typeof session.setActiveToolsByName === 'function') {
      session.setActiveToolsByName(toolNames)
    }

    setSessionSystemPrompt(session, safeString(payload && payload.systemPrompt))

    const messages = Array.isArray(payload && payload.messages) ? payload.messages : []
    if (messages.length > 0 && session.agent && typeof session.agent.replaceMessages === 'function') {
      try { session.agent.replaceMessages(messages) } catch {}
    }

    unsubscribe = typeof session.subscribe === 'function'
      ? session.subscribe((event: any) => {
          try { emit({ type: 'session_event', event }) } catch {}
          const eventType = safeString(event && event.type)
          if (eventType === 'message_end') {
            const message = event && event.message
            if (safeString(message && message.role) !== 'assistant') return
            const text = extractAssistantText(message)
            if (text) lastAssistantText = text
            if (message && message.usage) lastAssistantUsage = message.usage
            return
          }
          if (eventType === 'agent_end') {
            const messages = Array.isArray(event && event.messages) ? event.messages : []
            for (let i = messages.length - 1; i >= 0; i--) {
              const message = messages[i]
              if (safeString(message && message.role) !== 'assistant') continue
              const text = extractAssistantText(message)
              if (text) lastAssistantText = text
              if (message && message.usage && !lastAssistantUsage) lastAssistantUsage = message.usage
              if (text || lastAssistantUsage) break
            }
          }
        })
      : null

    if (typeof session.prompt !== 'function') throw new Error('subagent_prompt_unavailable')
    await session.prompt(safeString(payload && payload.prompt))
    emit({ type: 'runner_result', lastAssistantText, lastAssistantUsage, aborted: false })
  } catch (error: any) {
    const message = safeString(error && error.message ? error.message : error) || 'subagent_runner_failed'
    aborted = /abort/i.test(message)
    emit({ type: 'runner_result', lastAssistantText, lastAssistantUsage, aborted, error: message })
    process.exitCode = aborted ? 130 : 1
  } finally {
    if (unsubscribe) {
      try { unsubscribe() } catch {}
    }
    if (session && typeof session.dispose === 'function') {
      try { session.dispose() } catch {}
    }
  }
}

main().catch((error: any) => {
  const message = safeString(error && error.message ? error.message : error) || 'subagent_runner_failed'
  emit({ type: 'runner_result', lastAssistantText: '', aborted: /abort/i.test(message), error: message })
  process.exit(1)
})
