type SessionLike = {
  agent?: { waitForIdle?: () => Promise<void> }
  isStreaming?: boolean
}

type SessionPrompt = (text: string, options?: any) => Promise<void>

function safeString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isStreamingBehaviorRequiredError(error: unknown): boolean {
  const message = safeString(error && typeof error === 'object' && 'message' in (error as any)
    ? (error as any).message
    : error).toLowerCase()
  if (!message) return false
  return message.includes('agent is already processing')
    || (message.includes('streamingbehavior') && message.includes('followup'))
}

async function waitForSessionIdle(session: SessionLike, { pollMs = 25, timeoutMs = 30_000 } = {}) {
  if (session && session.agent && typeof session.agent.waitForIdle === 'function') {
    await session.agent.waitForIdle()
    return
  }

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (session && session.isStreaming && Date.now() < deadline) {
    await sleep(Math.max(10, Number(pollMs) || 25))
  }
}

async function promptSessionWithRetry(session: SessionLike, prompt: SessionPrompt, text: string, options: any = {}) {
  const nextOptions = options && typeof options === 'object' ? { ...options } : {}
  try {
    await prompt(text, nextOptions)
    await waitForSessionIdle(session)
    return { mode: 'direct' as const }
  } catch (error) {
    if (!isStreamingBehaviorRequiredError(error)) throw error
    await prompt(text, { ...nextOptions, streamingBehavior: 'followUp' })
    await waitForSessionIdle(session)
    return { mode: 'followUp' as const }
  }
}

export {
  isStreamingBehaviorRequiredError,
  waitForSessionIdle,
  promptSessionWithRetry,
}
