type SessionLike = {
  agent?: { replaceMessages?: (messages: any[]) => void }
  sessionManager?: {
    getLeafEntry?: () => any
    branch?: (fromId: string) => void
    resetLeaf?: () => void
    buildSessionContext?: () => { messages?: any[] }
  }
  __rinPromptAutoContinueInternal?: boolean
}

function safeString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

function extractAssistantTextFromMessage(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block: any) => block && typeof block === 'object' && safeString(block.type) === 'text')
    .map((block: any) => safeString(block.text))
    .join('\n')
    .trim()
}

function isContinueAssistantText(text: unknown, token: string): boolean {
  return safeString(text).trim() === safeString(token).trim()
}

function isContinueAssistantMessage(message: any, token: string): boolean {
  return safeString(message && message.role) === 'assistant'
    && isContinueAssistantText(extractAssistantTextFromMessage(message), token)
}

function canStillBecomeContinue(text: unknown, token: string): boolean {
  const candidate = safeString(text).trim()
  if (!candidate) return true
  const normalizedToken = safeString(token).trim()
  return normalizedToken === candidate || normalizedToken.startsWith(candidate)
}

async function flushBufferedEvents(listener: (event: any) => any, state: { pending: any[] }) {
  const pending = state.pending.slice()
  state.pending = []
  for (const event of pending) {
    await listener(event)
  }
}

function createContinueEventFilter(session: SessionLike, listener: (event: any) => any, token: string) {
  const state: {
    mode: 'idle' | 'buffering' | 'passthrough'
    pending: any[]
    text: string
  } = {
    mode: 'idle',
    pending: [],
    text: '',
  }

  return async (event: any) => {
    if (!session || !session.__rinPromptAutoContinueInternal) {
      state.mode = 'idle'
      state.pending = []
      state.text = ''
      return await listener(event)
    }

    const eventType = safeString(event && event.type)
    const message = event && event.message
    const isAssistant = safeString(message && message.role) === 'assistant'

    if (eventType === 'message_start' && isAssistant) {
      state.mode = 'buffering'
      state.pending = []
      state.text = ''
      return await listener(event)
    }

    if (eventType === 'message_update' && isAssistant && safeString(event && event.assistantMessageEvent && event.assistantMessageEvent.type) === 'text_delta') {
      if (state.mode === 'buffering') {
        state.pending.push(event)
        state.text += safeString(event && event.assistantMessageEvent && event.assistantMessageEvent.delta)
        if (canStillBecomeContinue(state.text, token)) return
        state.mode = 'passthrough'
        await flushBufferedEvents(listener, state)
        return
      }
      return await listener(event)
    }

    if (eventType === 'message_end' && isAssistant) {
      const isContinue = isContinueAssistantMessage(message, token)
      if (state.mode === 'buffering' && isContinue) {
        state.mode = 'idle'
        state.pending = []
        state.text = ''
        return
      }
      if (state.mode === 'buffering') {
        state.mode = 'idle'
        await flushBufferedEvents(listener, state)
        state.text = ''
        return await listener(event)
      }
      state.mode = 'idle'
      state.pending = []
      state.text = ''
      return await listener(event)
    }

    if (state.mode === 'passthrough' && eventType === 'agent_end') {
      state.mode = 'idle'
      state.pending = []
      state.text = ''
    }

    return await listener(event)
  }
}

function discardTrailingContinueAssistant(session: SessionLike, token: string): boolean {
  const manager = session && session.sessionManager
  const agent = session && session.agent
  if (!manager || typeof manager.getLeafEntry !== 'function') return false
  const leaf = manager.getLeafEntry()
  if (!leaf || safeString(leaf && leaf.type) !== 'message') return false
  if (!isContinueAssistantMessage(leaf.message, token)) return false

  const parentId = leaf.parentId == null ? null : safeString(leaf.parentId)
  if (parentId) {
    if (typeof manager.branch !== 'function') return false
    manager.branch(parentId)
  } else {
    if (typeof manager.resetLeaf !== 'function') return false
    manager.resetLeaf()
  }

  if (agent && typeof agent.replaceMessages === 'function' && typeof manager.buildSessionContext === 'function') {
    const context = manager.buildSessionContext()
    agent.replaceMessages(Array.isArray(context && context.messages) ? context.messages : [])
  }
  return true
}

export {
  extractAssistantTextFromMessage,
  isContinueAssistantText,
  isContinueAssistantMessage,
  createContinueEventFilter,
  discardTrailingContinueAssistant,
}
