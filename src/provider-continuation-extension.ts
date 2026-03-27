// @ts-nocheck
import {
  applyProviderOptimizations,
  buildCodexLikeCompactionInstructions,
  compactDetailsFromPreparation,
  convertAgentMessagesToResponsesInput,
  isDirectOpenAiResponsesModel,
  isResponsesApi,
  rewritePayloadWithRemoteCompaction,
  safeString,
} from './provider-continuation'

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const CONTINUATION_ENTRY_TYPE = 'rin_provider_continuation'

function latestCompactionEntry(sessionManager: any): any {
  const entries = sessionManager && typeof sessionManager.getBranch === 'function'
    ? sessionManager.getBranch()
    : sessionManager && typeof sessionManager.getEntries === 'function'
      ? sessionManager.getEntries()
      : []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry && entry.type === 'compaction') return entry
  }
  return null
}

function latestContinuationEntry(sessionManager: any): any {
  const entries = sessionManager && typeof sessionManager.getBranch === 'function'
    ? sessionManager.getBranch()
    : sessionManager && typeof sessionManager.getEntries === 'function'
      ? sessionManager.getEntries()
      : []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry || entry.type !== 'custom' || safeString(entry.customType).trim() !== CONTINUATION_ENTRY_TYPE) continue
    const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : null
    if (!data) continue
    if (!safeString(data.responseId).trim()) continue
    if (!(Number(data.inputCount) > 0) || !Array.isArray(data.inputHashes)) continue
    return {
      responseId: safeString(data.responseId).trim(),
      model: safeString(data.model).trim(),
      inputCount: Number(data.inputCount) || 0,
      inputHashes: data.inputHashes.map((item: any) => safeString(item)),
    }
  }
  return null
}

function compactionReplayStateFromSession(sessionManager: any) {
  const entry = latestCompactionEntry(sessionManager)
  const details = entry && entry.details && typeof entry.details === 'object' ? entry.details : null
  const encryptedContent = safeString(details && details.encryptedContent).trim()
  const rawOutput = Array.isArray(details && details.remoteOutput) ? details.remoteOutput : []
  if (!entry || (!encryptedContent && rawOutput.length === 0)) return null
  return {
    summary: safeString(entry.summary).trim(),
    encryptedContent,
    rawOutput,
    strategy: safeString(details && details.strategy).trim(),
    isSplitTurn: Boolean(details && details.isSplitTurn),
  }
}

function decodeJwtPayload(token: string): any {
  const parts = safeString(token).trim().split('.')
  if (parts.length !== 3) throw new Error('invalid_jwt')
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
  return JSON.parse(payload)
}

function extractCodexAccountId(token: string): string {
  const payload = decodeJwtPayload(token)
  return safeString(payload && payload[JWT_CLAIM_PATH] && payload[JWT_CLAIM_PATH].chatgpt_account_id).trim()
}

function codexResponsesBase(model: any): string {
  const baseUrl = safeString(model && model.baseUrl).trim().replace(/\/+$/, '')
  if (!baseUrl) return ''
  if (baseUrl.endsWith('/codex/responses')) return baseUrl.slice(0, -('/responses'.length))
  if (baseUrl.endsWith('/codex')) return baseUrl
  return `${baseUrl}/codex`
}

function remoteCompactionEndpoint(model: any): string {
  const base = codexResponsesBase(model)
  return base ? `${base}/responses/compact` : ''
}

function buildCodexCompactHeaders(model: any, apiKey: string): Record<string, string> {
  const accountId = extractCodexAccountId(apiKey)
  if (!accountId) throw new Error('missing_codex_account_id')
  return {
    authorization: `Bearer ${apiKey}`,
    'chatgpt-account-id': accountId,
    originator: 'pi',
    'user-agent': 'pi (node)',
    accept: 'application/json',
    'content-type': 'application/json',
    ...(model && model.headers && typeof model.headers === 'object' ? model.headers : {}),
  }
}

function collectCompactionSummary(output: any[]): string {
  let summary = ''
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type !== 'message' || safeString(item.role).trim() !== 'assistant') continue
    const content = Array.isArray(item.content) ? item.content : []
    const itemText = content
      .filter((part: any) => part && (part.type === 'output_text' || part.type === 'refusal'))
      .map((part: any) => safeString(part.text || part.refusal))
      .join('\n')
      .trim()
    if (itemText) summary = [summary, itemText].filter(Boolean).join('\n').trim()
  }
  return summary
}

function collectEncryptedCompaction(output: any[]): string {
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type !== 'compaction' && item.type !== 'compaction_summary') continue
    const encryptedContent = safeString(item.encrypted_content).trim()
    if (encryptedContent) return encryptedContent
  }
  return ''
}

async function tryRemoteCompaction({
  model,
  apiKey,
  conversationMessages,
  previousSummary,
  customInstructions,
  isSplitTurn,
  inputOverride,
}: {
  model: any
  apiKey: string
  conversationMessages: any[]
  previousSummary?: string
  customInstructions?: string
  isSplitTurn?: boolean
  inputOverride?: any[]
}) {
  if (!isDirectOpenAiResponsesModel(model)) return null
  const endpoint = remoteCompactionEndpoint(model)
  if (!endpoint) return null

  const input = Array.isArray(inputOverride) ? inputOverride.slice() : []
  if (!input.length) {
    if (safeString(previousSummary).trim()) {
      input.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: safeString(previousSummary).trim(), annotations: [] }],
      })
    }
    input.push(...convertAgentMessagesToResponsesInput(conversationMessages))
  }
  if (!input.length) return null

  const body: Record<string, any> = {
    model: safeString(model.id).trim(),
    input,
    instructions: buildCodexLikeCompactionInstructions({
      customInstructions: safeString(customInstructions).trim(),
      isSplitTurn: Boolean(isSplitTurn),
    }),
    tools: [],
    parallel_tool_calls: true,
    text: {
      format: { type: 'text' },
      verbosity: 'low',
    },
  }
  if (model && model.reasoning) {
    body.reasoning = { effort: 'medium', summary: 'auto' }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildCodexCompactHeaders(model, apiKey),
    body: JSON.stringify(body),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(text || `remote_compaction_failed:${response.status}`)
  }
  const json = text ? JSON.parse(text) : null
  const output = Array.isArray(json && json.output) ? json.output : []
  const encryptedContent = collectEncryptedCompaction(output)
  if (!encryptedContent) return null
  return {
    summary: collectCompactionSummary(output),
    encryptedContent,
    rawOutput: output,
  }
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function codexAutoCompactLimitForModel(model: any): number {
  const contextWindow = safeNumber(model && model.contextWindow)
  const configLimit = safeNumber(model && model.autoCompactTokenLimit)
  if (contextWindow > 0) {
    const contextLimit = Math.floor(contextWindow * 0.8)
    return configLimit > 0 ? Math.min(configLimit, contextLimit) : contextLimit
  }
  return configLimit > 0 ? configLimit : 0
}

function applyCodexLikeCompactionThreshold(settingsManager: any, model: any) {
  if (!settingsManager || typeof settingsManager.applyOverrides !== 'function') return
  const contextWindow = safeNumber(model && model.contextWindow)
  const autoCompactLimit = codexAutoCompactLimitForModel(model)
  if (!(contextWindow > 0) || !(autoCompactLimit > 0)) return
  const reserveTokens = Math.max(0, contextWindow - autoCompactLimit)
  settingsManager.applyOverrides({
    compaction: {
      enabled: true,
      reserveTokens,
    },
  })
}

function estimatePayloadTokens(payload: any): number {
  return Math.ceil(safeString(JSON.stringify(payload || null)).length / 4)
}

function isCodexGeneratedPayloadItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  const type = safeString(item.type).trim()
  const role = safeString(item.role).trim()
  if (type === 'message') return role === 'assistant' || role === 'tool' || role === 'system' || role === 'developer'
  return [
    'reasoning',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
    'mcp_tool_call',
    'mcp_tool_call_output',
    'tool_search_call',
    'tool_search_output',
    'local_shell_call',
    'local_shell_call_output',
    'computer_call',
    'computer_call_output',
    'web_search_call',
    'image_generation_call',
  ].includes(type)
}

function trimPayloadTailForRemoteCompaction(payload: any, model: any) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.input)) return { payload, changed: false, deletedItems: 0 }
  const contextWindow = safeNumber(model && model.contextWindow)
  if (!(contextWindow > 0)) return { payload, changed: false, deletedItems: 0 }
  const next = cloneJsonLocal(payload)
  const input = Array.isArray(next.input) ? next.input : []
  let deletedItems = 0
  while (input.length > 0 && estimatePayloadTokens({ ...next, input }) > contextWindow) {
    const last = input[input.length - 1]
    if (!isCodexGeneratedPayloadItem(last)) break
    input.pop()
    deletedItems += 1
  }
  next.input = input
  return { payload: deletedItems > 0 ? next : payload, changed: deletedItems > 0, deletedItems }
}

function cloneJsonLocal(value: any) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createProviderContinuationExtension({ settingsManager = null }: { settingsManager?: any } = {}) {
  return function providerContinuationExtension(pi: any) {
    let pendingContinuationState: any = null

    const syncThreshold = (model: any) => {
      applyCodexLikeCompactionThreshold(settingsManager, model)
    }

    pi.on('session_start', async (_event: any, ctx: any) => {
      syncThreshold(ctx && ctx.model)
    })

    pi.on('model_select', async (event: any) => {
      syncThreshold(event && event.model)
    })

    pi.on('before_provider_request', async (event: any, ctx: any) => {
      syncThreshold(ctx && ctx.model)
      const model = ctx && ctx.model
      const originalPayload = event && event.payload
      pendingContinuationState = null
      if (!model || !isResponsesApi(model.api) || !isDirectOpenAiResponsesModel(model)) return

      let nextPayload = originalPayload

      const replay = compactionReplayStateFromSession(ctx && ctx.sessionManager)
      if (replay && (replay.encryptedContent || Array.isArray(replay.rawOutput))) {
        const rewritten = rewritePayloadWithRemoteCompaction({
          payload: nextPayload,
          summary: replay.summary,
          encryptedContent: replay.encryptedContent,
          rawOutput: replay.rawOutput,
          dropFollowingHistoricalItems: true,
        })
        if (rewritten.changed) nextPayload = rewritten.payload
      }

      const optimized = applyProviderOptimizations({
        payload: nextPayload,
        model,
        sessionId: ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === 'function' ? ctx.sessionManager.getSessionId() : '',
        state: {
          previousResponseState: latestContinuationEntry(ctx && ctx.sessionManager),
        },
      })
      nextPayload = optimized && optimized.payload ? optimized.payload : nextPayload
      pendingContinuationState = optimized && optimized.continuationState
        ? {
            ...optimized.continuationState,
            provider: safeString(model && model.provider).trim(),
            api: safeString(model && model.api).trim(),
            usedPreviousResponse: Boolean(optimized && optimized.usedPreviousResponse),
          }
        : null

      if (nextPayload !== originalPayload) return nextPayload
      return
    })

    pi.on('message_end', async (event: any) => {
      const message = event && event.message
      if (!message || safeString(message.role).trim() !== 'assistant') {
        pendingContinuationState = null
        return
      }
      const responseId = safeString(message && message.responseId).trim()
      if (!responseId || !pendingContinuationState || !(Number(pendingContinuationState.inputCount) > 0)) {
        pendingContinuationState = null
        return
      }
      pi.appendEntry(CONTINUATION_ENTRY_TYPE, {
        responseId,
        model: safeString(pendingContinuationState.model).trim(),
        inputCount: Number(pendingContinuationState.inputCount) || 0,
        inputHashes: Array.isArray(pendingContinuationState.inputHashes) ? pendingContinuationState.inputHashes.map((item: any) => safeString(item)) : [],
        provider: safeString(pendingContinuationState.provider).trim(),
        api: safeString(pendingContinuationState.api).trim(),
        usedPreviousResponse: Boolean(pendingContinuationState.usedPreviousResponse),
        savedAt: new Date().toISOString(),
      })
      pendingContinuationState = null
    })

    pi.on('session_before_compact', async (event: any, ctx: any) => {
      const model = ctx && ctx.model
      if (!model || !isDirectOpenAiResponsesModel(model)) return
      const apiKey = await ctx.modelRegistry.getApiKey(model).catch(() => '')
      if (!apiKey) return
      const preparation = event && event.preparation ? event.preparation : {}
      const conversationMessages = [
        ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
        ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
      ]
      const previousSummary = safeString(preparation.previousSummary).trim()
      if (!conversationMessages.length && !previousSummary) return
      let remoteResult: any = null
      try {
        const remotePayloadInput = convertAgentMessagesToResponsesInput(conversationMessages)
        const compactPayload = {
          model: safeString(model.id).trim(),
          input: [
            ...(
              safeString(previousSummary).trim()
                ? [{
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: safeString(previousSummary).trim(), annotations: [] }],
                  }]
                : []
            ),
            ...remotePayloadInput,
          ],
          instructions: buildCodexLikeCompactionInstructions({
            customInstructions: safeString(event && event.customInstructions).trim(),
            isSplitTurn: Boolean(preparation && preparation.isSplitTurn),
          }),
          tools: [],
          parallel_tool_calls: true,
          text: { format: { type: 'text' }, verbosity: 'low' },
          ...(model && model.reasoning ? { reasoning: { effort: 'medium', summary: 'auto' } } : {}),
        }
        const trimmed = trimPayloadTailForRemoteCompaction(compactPayload, model)
        remoteResult = await tryRemoteCompaction({
          model,
          apiKey,
          conversationMessages,
          previousSummary,
          customInstructions: safeString(event && event.customInstructions).trim(),
          isSplitTurn: Boolean(preparation && preparation.isSplitTurn),
          inputOverride: Array.isArray(trimmed && trimmed.payload && trimmed.payload.input) ? trimmed.payload.input : undefined,
        })
      } catch {
        return
      }
      const summary = safeString(remoteResult && remoteResult.summary).trim() || previousSummary || 'Compacted conversation history.'
      const encryptedContent = safeString(remoteResult && remoteResult.encryptedContent).trim()
      const remoteOutput = Array.isArray(remoteResult && remoteResult.rawOutput) ? remoteResult.rawOutput : []
      if (!encryptedContent) return
      return {
        compaction: {
          summary,
          firstKeptEntryId: safeString(preparation.firstKeptEntryId).trim(),
          tokensBefore: Number(preparation.tokensBefore || 0) || 0,
          details: compactDetailsFromPreparation(preparation, {
            strategy: 'rin_codex_remote_compact',
            encryptedContent,
            remoteOutput,
            isSplitTurn: Boolean(preparation && preparation.isSplitTurn),
            model: `${safeString(model.provider)}/${safeString(model.id)}`,
          }),
          fromHook: true,
        },
      }
    })
  }
}

export {
  createProviderContinuationExtension,
}
