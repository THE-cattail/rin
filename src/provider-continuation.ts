// @ts-nocheck

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`

type ContinuationComparable = {
  input: any[]
  envelope: Record<string, any>
}

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function cloneJson<T = any>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function stableJson(value: any): string {
  const seen = new WeakSet<any>()
  const normalize = (input: any): any => {
    if (input == null || typeof input !== 'object') return input
    if (seen.has(input)) return '[circular]'
    seen.add(input)
    if (Array.isArray(input)) return input.map((item) => normalize(item))
    const out: Record<string, any> = {}
    for (const key of Object.keys(input).sort()) out[key] = normalize(input[key])
    return out
  }
  return JSON.stringify(normalize(value))
}

function deepEqualJson(a: any, b: any): boolean {
  return stableJson(a) === stableJson(b)
}

function isResponsesApi(api: any): boolean {
  const value = safeString(api).trim()
  return value === 'openai-responses'
    || value === 'openai-codex-responses'
    || value === 'azure-openai-responses'
}

function isDirectOpenAiResponsesModel(model: any): boolean {
  if (!model || !isResponsesApi(model.api)) return false
  const baseUrl = safeString(model.baseUrl).trim().toLowerCase()
  return baseUrl.includes('api.openai.com') || baseUrl.includes('chatgpt.com/backend-api')
}

function isContinuationPayload(payload: any): boolean {
  return Boolean(payload && typeof payload === 'object' && Array.isArray(payload.input))
}

function extractComparablePayload(payload: any): ContinuationComparable | null {
  if (!isContinuationPayload(payload)) return null
  const input = Array.isArray(payload.input) ? cloneJson(payload.input) : []
  const envelope = cloneJson(payload)
  try { delete envelope.input } catch {}
  try { delete envelope.previous_response_id } catch {}
  return { input, envelope }
}

function canUsePreviousResponse({ previous, current }: { previous: ContinuationComparable | null, current: ContinuationComparable | null }): boolean {
  if (!previous || !current) return false
  if (!deepEqualJson(previous.envelope, current.envelope)) return false
  if (previous.input.length >= current.input.length) return false
  for (let i = 0; i < previous.input.length; i += 1) {
    if (!deepEqualJson(previous.input[i], current.input[i])) return false
  }
  return true
}

function approxTokenCount(text: any) {
  return Math.ceil(safeString(text).length / 4)
}

function truncateTextCodexStyle(value: any, maxTokens = 10_000) {
  const text = safeString(value)
  if (!text) return text
  const maxChars = Math.max(1, maxTokens) * 4
  if (text.length <= maxChars) return text
  const totalLines = text.split(/\r?\n/).length
  const leftBudget = Math.floor(maxChars / 2)
  const rightBudget = maxChars - leftBudget
  const prefix = text.slice(0, leftBudget)
  const suffix = text.slice(Math.max(leftBudget, text.length - rightBudget))
  const removedBytes = Math.max(0, text.length - maxChars)
  const removedTokens = Math.max(1, Math.ceil(removedBytes / 4))
  return `Total output lines: ${totalLines}\n\n${prefix}…${removedTokens} tokens truncated…${suffix}`
}

function isUserInputMessage(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  return safeString(item.type).trim() === 'message' && safeString(item.role).trim() === 'user'
}

function isAssistantMessage(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  return safeString(item.type).trim() === 'message' && safeString(item.role).trim() === 'assistant'
}

function isReasoningItem(item: any): boolean {
  return Boolean(item && typeof item === 'object' && safeString(item.type).trim() === 'reasoning')
}

function isFunctionCallOutputItem(item: any): boolean {
  const type = safeString(item && item.type).trim()
  return type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'mcp_tool_call_output' || type === 'tool_search_output'
}

function truncateHistoricalOutputItem(item: any, maxTokens = 10_000) {
  const next = cloneJson(item)
  if (!next || typeof next !== 'object') return item
  if (typeof next.output === 'string') {
    next.output = truncateTextCodexStyle(next.output, maxTokens)
    return next
  }
  if (next.output && typeof next.output === 'object') {
    if (typeof next.output.text === 'string') next.output.text = truncateTextCodexStyle(next.output.text, maxTokens)
    if (typeof next.output.output === 'string') next.output.output = truncateTextCodexStyle(next.output.output, maxTokens)
    if (Array.isArray(next.output.content)) {
      next.output.content = next.output.content.map((part: any) => {
        if (!part || typeof part !== 'object') return part
        if (typeof part.text === 'string') return { ...part, text: truncateTextCodexStyle(part.text, maxTokens) }
        return part
      })
    }
  }
  return next
}

function pruneHistoricalReplayItems(payload: any) {
  if (!isContinuationPayload(payload)) return { payload, changed: false }
  const input = Array.isArray(payload.input) ? payload.input : []
  if (input.length < 60) return { payload, changed: false }

  let changed = false
  const nextInput = input.map((item) => {
    if (isReasoningItem(item)) {
      changed = true
      return null
    }
    if (isFunctionCallOutputItem(item)) {
      const next = truncateHistoricalOutputItem(item)
      if (!deepEqualJson(next, item)) changed = true
      return next
    }
    return item
  }).filter(Boolean)

  if (!changed) return { payload, changed: false }
  return { payload: { ...cloneJson(payload), input: nextInput }, changed: true }
}

function applyProviderOptimizations({ payload }: { payload: any, model?: any, sessionId?: string, state?: any }) {
  const pruned = pruneHistoricalReplayItems(payload)
  return { payload: pruned.payload, comparable: extractComparablePayload(pruned.payload), usedPreviousResponse: false }
}

function extractSummaryTextFromCompactionEnvelope(text: any): string {
  const value = safeString(text)
  if (!value.startsWith(COMPACTION_SUMMARY_PREFIX)) return value.trim()
  const suffixIndex = value.lastIndexOf(COMPACTION_SUMMARY_SUFFIX)
  if (suffixIndex < 0) return value.slice(COMPACTION_SUMMARY_PREFIX.length).trim()
  return value.slice(COMPACTION_SUMMARY_PREFIX.length, suffixIndex).trim()
}

function isCompactionSummaryUserItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  if (safeString(item.role).trim() !== 'user') return false
  const content = Array.isArray(item.content) ? item.content : []
  if (!content.length) return false
  const text = content
    .filter((part) => part && part.type === 'input_text')
    .map((part) => safeString(part.text))
    .join('')
  return text.startsWith(COMPACTION_SUMMARY_PREFIX)
}

function createAssistantSummaryItem(summary: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: safeString(summary).trim(), annotations: [] }],
  }
}

function createEncryptedCompactionItem(encryptedContent: string) {
  return {
    type: 'compaction',
    encrypted_content: safeString(encryptedContent).trim(),
  }
}

function sanitizeRemoteMessageContent(role: string, content: any[]): any[] {
  const blocks: any[] = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    if ((role === 'user' || role === 'developer' || role === 'system') && block.type === 'input_text') {
      const text = safeString(block.text)
      if (text) blocks.push({ type: 'input_text', text })
      continue
    }
    if (role === 'assistant' && block.type === 'output_text') {
      const text = safeString(block.text)
      if (text) blocks.push({ type: 'output_text', text, annotations: [] })
      continue
    }
    if (role === 'assistant' && block.type === 'refusal') {
      const refusal = safeString(block.refusal || block.text)
      if (refusal) blocks.push({ type: 'refusal', refusal })
    }
  }
  return blocks
}

function sanitizeRemoteCompactionOutputItem(item: any): any | null {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'compaction' || item.type === 'compaction_summary') {
    const encryptedContent = safeString(item.encrypted_content).trim()
    return encryptedContent ? createEncryptedCompactionItem(encryptedContent) : null
  }
  if (item.type !== 'message') return null
  const role = safeString(item.role).trim()
  if (!['user', 'assistant', 'developer', 'system'].includes(role)) return null
  const content = sanitizeRemoteMessageContent(role, Array.isArray(item.content) ? item.content : [])
  if (!content.length) return null
  const next: any = {
    type: 'message',
    role,
    status: 'completed',
    content,
  }
  if (role === 'assistant' && safeString(item.phase).trim()) next.phase = safeString(item.phase).trim()
  return next
}

function buildRemoteCompactionReplayItems({
  rawOutput,
  summary,
  encryptedContent,
  fallbackSummary,
}: {
  rawOutput?: any[]
  summary?: string
  encryptedContent?: string
  fallbackSummary?: string
}) {
  const replayItems = (Array.isArray(rawOutput) ? rawOutput : [])
    .map((item) => sanitizeRemoteCompactionOutputItem(item))
    .filter(Boolean)
  const normalizedEncrypted = safeString(encryptedContent).trim()
  if (replayItems.length > 0) {
    const hasCompaction = replayItems.some((item) => item && item.type === 'compaction')
    if (normalizedEncrypted && !hasCompaction) replayItems.push(createEncryptedCompactionItem(normalizedEncrypted))
    return replayItems
  }
  const summaryText = safeString(summary).trim() || safeString(fallbackSummary).trim()
  const fallbackItems: any[] = []
  if (summaryText) fallbackItems.push(createAssistantSummaryItem(summaryText))
  if (normalizedEncrypted) fallbackItems.push(createEncryptedCompactionItem(normalizedEncrypted))
  return fallbackItems
}

function isPlainAssistantHistoryItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  if (item.type !== 'message' || safeString(item.role).trim() !== 'assistant') return false
  const content = Array.isArray(item.content) ? item.content : []
  if (!content.length) return false
  return content.every((part: any) => part && (part.type === 'output_text' || part.type === 'refusal'))
}

function isDroppableHistoricalReplayItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  const type = safeString(item.type).trim()
  const role = safeString(item.role).trim()
  if (role === 'user') return false
  if (type === 'message') return ['assistant', 'tool', 'system', 'developer', ''].includes(role)
  return [
    'function_call',
    'function_call_output',
    'reasoning',
    'computer_call',
    'computer_call_output',
    'local_shell_call',
    'local_shell_call_output',
    'compaction',
    'compaction_summary',
  ].includes(type)
}

function remoteOutputHasAssistantMessage(rawOutput: any[] = []): boolean {
  return (Array.isArray(rawOutput) ? rawOutput : []).some((item: any) => item && item.type === 'message' && safeString(item.role).trim() === 'assistant')
}

function rewritePayloadWithRemoteCompaction({
  payload,
  summary,
  encryptedContent,
  rawOutput,
  dropFollowingHistoricalItems = false,
}: {
  payload: any
  summary?: string
  encryptedContent?: string
  rawOutput?: any[]
  dropFollowingHistoricalItems?: boolean
}) {
  if (!isContinuationPayload(payload)) return { payload, changed: false }
  const next = cloneJson(payload)
  const input = Array.isArray(next.input) ? next.input : []
  const compactionIndex = input.findIndex((item) => isCompactionSummaryUserItem(item))
  if (compactionIndex < 0) return { payload, changed: false }
  const compactionItem = input[compactionIndex]
  const fallbackSummary = extractSummaryTextFromCompactionEnvelope(
    Array.isArray(compactionItem && compactionItem.content) ? compactionItem.content.map((part: any) => safeString(part && part.text)).join('') : '',
  )
  const replayItems = buildRemoteCompactionReplayItems({ rawOutput, summary, encryptedContent, fallbackSummary })
  let tail = input.slice(compactionIndex + 1)
  const nextUserOffset = tail.findIndex((item) => item && typeof item === 'object' && safeString(item.role).trim() === 'user')
  const historicalSlice = nextUserOffset >= 0 ? tail.slice(0, nextUserOffset) : tail.slice()
  const shouldDropHeuristic = historicalSlice.length > 0 && (
    historicalSlice.every((item) => isDroppableHistoricalReplayItem(item))
      || (!remoteOutputHasAssistantMessage(rawOutput) && historicalSlice.every((item) => isPlainAssistantHistoryItem(item)))
  )
  if (dropFollowingHistoricalItems || shouldDropHeuristic) {
    tail = nextUserOffset >= 0 ? tail.slice(nextUserOffset) : []
  }
  next.input = [...input.slice(0, compactionIndex), ...replayItems, ...tail]
  return { payload: next, changed: true }
}

function normalizeToolCallId(id: any): string {
  return safeString(id).replace(/[^a-zA-Z0-9_|-]/g, '_').slice(0, 128)
}

function parseThinkingSignature(signature: any): any | null {
  const text = safeString(signature).trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function convertAgentMessagesToResponsesInput(messages: any[]): any[] {
  const items: any[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = safeString(message.role).trim()
    if (role === 'user') {
      if (typeof message.content === 'string') {
        const text = safeString(message.content).trim()
        if (!text) continue
        items.push({ role: 'user', content: [{ type: 'input_text', text }] })
        continue
      }
      const content = Array.isArray(message.content) ? message.content : []
      const converted = content
        .map((block) => {
          if (!block || typeof block !== 'object') return null
          if (block.type === 'text') return { type: 'input_text', text: safeString(block.text) }
          if (block.type === 'image' && safeString(block.data).trim() && safeString(block.mimeType).trim()) {
            return {
              type: 'input_image',
              detail: 'auto',
              image_url: `data:${safeString(block.mimeType)};base64,${safeString(block.data)}`,
            }
          }
          return null
        })
        .filter(Boolean)
      if (converted.length) items.push({ role: 'user', content: converted })
      continue
    }
    if (role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'thinking') {
          const parsed = parseThinkingSignature(block.thinkingSignature)
          if (parsed) items.push(parsed)
          continue
        }
        if (block.type === 'text' && safeString(block.text).trim()) {
          items.push(createAssistantSummaryItem(safeString(block.text).trim()))
          continue
        }
        if (block.type === 'toolCall') {
          const fullId = normalizeToolCallId(block.id)
          const splitIndex = fullId.indexOf('|')
          const callId = splitIndex >= 0 ? fullId.slice(0, splitIndex) : fullId
          const itemId = splitIndex >= 0 ? fullId.slice(splitIndex + 1) : undefined
          items.push({
            type: 'function_call',
            id: itemId,
            call_id: callId,
            name: safeString(block.name),
            arguments: JSON.stringify(block.arguments || {}),
          })
        }
      }
      continue
    }
    if (role === 'toolResult') {
      const fullId = normalizeToolCallId(message.toolCallId)
      const splitIndex = fullId.indexOf('|')
      const callId = splitIndex >= 0 ? fullId.slice(0, splitIndex) : fullId
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block && block.type === 'text')
        .map((block) => safeString(block.text))
        .join('\n')
      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: text || '(no output)',
      })
      continue
    }
    if (role === 'compactionSummary') {
      const summaryText = safeString(message.summary).trim()
      if (summaryText) items.push(createAssistantSummaryItem(summaryText))
    }
  }
  return items
}

function serializeAgentMessagesForCompaction(messages: any[]): string {
  const lines: string[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = safeString(message.role).trim()
    if (role === 'user') {
      lines.push('[User]')
      const content = Array.isArray(message.content) ? message.content : []
      if (typeof message.content === 'string') lines.push(safeString(message.content))
      else {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text') lines.push(safeString(block.text))
          else if (block.type === 'image') lines.push('[Image attached]')
        }
      }
      lines.push('')
      continue
    }
    if (role === 'assistant') {
      lines.push('[Assistant]')
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'thinking' && safeString(block.thinking).trim()) {
          lines.push(`[Thinking] ${safeString(block.thinking).trim()}`)
          continue
        }
        if (block.type === 'text' && safeString(block.text).trim()) {
          lines.push(safeString(block.text).trim())
          continue
        }
        if (block.type === 'toolCall') {
          lines.push(`[ToolCall] ${safeString(block.name)} ${stableJson(block.arguments || {})}`)
        }
      }
      lines.push('')
      continue
    }
    if (role === 'toolResult') {
      lines.push(`[ToolResult:${safeString(message.toolName)}${message.isError ? ':error' : ''}]`)
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && safeString(block.text).trim()) lines.push(safeString(block.text).trim())
        else if (block.type === 'image') lines.push('[Image attached]')
      }
      lines.push('')
    }
  }
  return lines.join('\n').trim()
}

function buildCodexLikeCompactionInstructions({
  customInstructions = '',
  isSplitTurn = false,
}: {
  customInstructions?: string
  isSplitTurn?: boolean
}) {
  const parts = [
    'Compact this coding-agent conversation for future continuation.',
    'Preserve only durable working context needed for the next turns.',
    'Keep implementation facts, open work, concrete constraints, and file/tool state.',
    'Drop repetition, filler, and already-finished detail that no longer matters.',
    'Produce a compact working summary, not a narrative retelling.',
    'When useful, organize the summary with these headings:',
    'Objective',
    'Current state',
    'Decisions and constraints',
    'Files and artifacts',
    'Open work / blockers',
    'Next useful steps',
  ]
  if (isSplitTurn) parts.push('This compaction cuts through a large turn. Preserve exactly what the kept suffix still needs from the earlier prefix.')
  if (safeString(customInstructions).trim()) parts.push(`Additional focus: ${safeString(customInstructions).trim()}`)
  return parts.join('\n')
}

function buildCodexLikeCompactionPrompt({
  conversationText,
  previousSummary = '',
  customInstructions = '',
  isSplitTurn = false,
}: {
  conversationText: string
  previousSummary?: string
  customInstructions?: string
  isSplitTurn?: boolean
}) {
  const instructions = buildCodexLikeCompactionInstructions({ customInstructions, isSplitTurn })
  const body = [instructions]
  if (safeString(previousSummary).trim()) {
    body.push('Previous compaction summary to merge and update:\n' + safeString(previousSummary).trim())
  }
  body.push('<conversation>\n' + safeString(conversationText).trim() + '\n</conversation>')
  return body.join('\n\n')
}

function compactDetailsFromPreparation(preparation: any, extra: Record<string, any> = {}) {
  const readFiles = Array.from(preparation && preparation.fileOps && preparation.fileOps.read instanceof Set ? preparation.fileOps.read : [])
  const modifiedFiles = Array.from(preparation && preparation.fileOps && preparation.fileOps.edited instanceof Set ? preparation.fileOps.edited : [])
  return {
    readFiles,
    modifiedFiles,
    ...extra,
  }
}

export {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  safeString,
  stableJson,
  deepEqualJson,
  isResponsesApi,
  isDirectOpenAiResponsesModel,
  extractComparablePayload,
  canUsePreviousResponse,
  applyProviderOptimizations,
  extractSummaryTextFromCompactionEnvelope,
  buildRemoteCompactionReplayItems,
  sanitizeRemoteCompactionOutputItem,
  rewritePayloadWithRemoteCompaction,
  convertAgentMessagesToResponsesInput,
  serializeAgentMessagesForCompaction,
  buildCodexLikeCompactionInstructions,
  buildCodexLikeCompactionPrompt,
  compactDetailsFromPreparation,
}
