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

function latestCompactionEntry(sessionManager: any): any {
  const entries = sessionManager && typeof sessionManager.getEntries === 'function' ? sessionManager.getEntries() : []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry && entry.type === 'compaction') return entry
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
}: {
  model: any
  apiKey: string
  conversationMessages: any[]
  previousSummary?: string
  customInstructions?: string
  isSplitTurn?: boolean
}) {
  if (!isDirectOpenAiResponsesModel(model)) return null
  const endpoint = remoteCompactionEndpoint(model)
  if (!endpoint) return null

  const input = []
  if (safeString(previousSummary).trim()) {
    input.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: safeString(previousSummary).trim(), annotations: [] }],
    })
  }
  input.push(...convertAgentMessagesToResponsesInput(conversationMessages))
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

function createProviderContinuationExtension() {
  return function providerContinuationExtension(pi: any) {
    pi.on('before_provider_request', async (event: any, ctx: any) => {
      const model = ctx && ctx.model
      const originalPayload = event && event.payload
      if (!model || !isResponsesApi(model.api) || !isDirectOpenAiResponsesModel(model)) return

      let nextPayload = originalPayload
      const optimized = applyProviderOptimizations({
        payload: nextPayload,
        model,
        sessionId: ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === 'function' ? ctx.sessionManager.getSessionId() : '',
      })
      nextPayload = optimized && optimized.payload ? optimized.payload : nextPayload

      const replay = compactionReplayStateFromSession(ctx && ctx.sessionManager)
      if (!replay || (!replay.encryptedContent && !Array.isArray(replay.rawOutput))) {
        if (nextPayload !== originalPayload) return nextPayload
        return
      }
      const rewritten = rewritePayloadWithRemoteCompaction({
        payload: nextPayload,
        summary: replay.summary,
        encryptedContent: replay.encryptedContent,
        rawOutput: replay.rawOutput,
        dropFollowingHistoricalItems: !replay.isSplitTurn,
      })
      if (rewritten.changed) return rewritten.payload
      if (nextPayload !== originalPayload) return nextPayload
      return
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
        remoteResult = await tryRemoteCompaction({
          model,
          apiKey,
          conversationMessages,
          previousSummary,
          customInstructions: safeString(event && event.customInstructions).trim(),
          isSplitTurn: Boolean(preparation && preparation.isSplitTurn),
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
