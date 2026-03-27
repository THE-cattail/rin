// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'

import { safeString } from './provider-continuation'
import { ensureDir, readJson, resolveRinLayout } from './runtime-paths'

const USAGE_OBSERVATION_TYPE = 'rin_usage_observation'
const OBSERVABILITY_DIRNAME = 'observability/provider-usage'

function safeNumber(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function emptyContentStats() {
  return {
    textChars: 0,
    textBlocks: 0,
    thinkingChars: 0,
    thinkingBlocks: 0,
    imageBlocks: 0,
    toolCallBlocks: 0,
    toolCallArgChars: 0,
    toolResultBlocks: 0,
    toolResultChars: 0,
    otherBlocks: 0,
  }
}

function approxJsonChars(value: any) {
  try {
    return safeString(JSON.stringify(value == null ? null : value)).length
  } catch {
    return safeString(value).length
  }
}

function countMessageBlockText(stats: any, text: any) {
  const value = safeString(text)
  stats.textChars += value.length
  if (value.trim()) stats.textBlocks += 1
}

function countThinkingText(stats: any, text: any) {
  const value = safeString(text)
  stats.thinkingChars += value.length
  if (value.trim()) stats.thinkingBlocks += 1
}

function mergeContentStats(target: any, extra: any) {
  target.textChars += safeNumber(extra && extra.textChars)
  target.textBlocks += safeNumber(extra && extra.textBlocks)
  target.thinkingChars += safeNumber(extra && extra.thinkingChars)
  target.thinkingBlocks += safeNumber(extra && extra.thinkingBlocks)
  target.imageBlocks += safeNumber(extra && extra.imageBlocks)
  target.toolCallBlocks += safeNumber(extra && extra.toolCallBlocks)
  target.toolCallArgChars += safeNumber(extra && extra.toolCallArgChars)
  target.toolResultBlocks += safeNumber(extra && extra.toolResultBlocks)
  target.toolResultChars += safeNumber(extra && extra.toolResultChars)
  target.otherBlocks += safeNumber(extra && extra.otherBlocks)
  return target
}

function pushCount(map: Record<string, number>, key: any, delta = 1) {
  const nextKey = safeString(key).trim() || 'unknown'
  map[nextKey] = safeNumber(map[nextKey]) + safeNumber(delta, 1)
  return map
}

function sortedCountEntries(map: Record<string, number>, limit = 20) {
  return Object.entries(map || {})
    .sort((a, b) => safeNumber(b[1]) - safeNumber(a[1]) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, value]) => ({ key, value: safeNumber(value) }))
}

function collectContentStats(content: any) {
  if (typeof content === 'string') {
    return {
      ...emptyContentStats(),
      textChars: content.length,
      textBlocks: content.trim() ? 1 : 0,
    }
  }
  const blocks = Array.isArray(content) ? content : []
  const stats = emptyContentStats()
  const blockTypes: Record<string, number> = {}
  const toolNames: Record<string, number> = {}
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const type = safeString(block.type).trim() || 'unknown'
    pushCount(blockTypes, type)
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      countMessageBlockText(stats, (block as any).text)
      continue
    }
    if (type === 'refusal') {
      countMessageBlockText(stats, (block as any).refusal || (block as any).text)
      continue
    }
    if (type === 'thinking') {
      countThinkingText(stats, (block as any).thinking)
      continue
    }
    if (type === 'reasoning') {
      countThinkingText(stats, (block as any).summary || (block as any).text || (block as any).encrypted_content)
      continue
    }
    if (type === 'image' || type === 'input_image' || type === 'output_image') {
      stats.imageBlocks += 1
      continue
    }
    if (type === 'toolCall' || type === 'function_call' || type === 'custom_tool_call' || type === 'mcp_tool_call') {
      stats.toolCallBlocks += 1
      stats.toolCallArgChars += approxJsonChars((block as any).arguments || (block as any).input || {})
      pushCount(toolNames, (block as any).name)
      continue
    }
    if (type === 'toolResult' || type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'mcp_tool_call_output' || type === 'tool_search_output') {
      stats.toolResultBlocks += 1
      stats.toolResultChars += approxJsonChars((block as any).output ?? (block as any).content ?? (block as any).text ?? block)
      continue
    }
    stats.otherBlocks += 1
  }
  return {
    ...stats,
    blockTypeCounts: blockTypes,
    toolNameCounts: toolNames,
  }
}

function emptyRoleStats() {
  return {
    messages: 0,
    ...emptyContentStats(),
  }
}

function summarizeSessionBranch(sessionManager: any) {
  const branch = sessionManager && typeof sessionManager.getBranch === 'function'
    ? (Array.isArray(sessionManager.getBranch()) ? sessionManager.getBranch() : [])
    : []
  const context = sessionManager && typeof sessionManager.buildSessionContext === 'function'
    ? (sessionManager.buildSessionContext() || { messages: [] })
    : { messages: [] }
  const entriesByType: Record<string, number> = {}
  const messageRoles: Record<string, number> = {}
  const assistantToolNames: Record<string, number> = {}
  const toolResultNames: Record<string, number> = {}
  const assistantStats = emptyRoleStats()
  const toolResultStats = emptyRoleStats()
  const userStats = emptyRoleStats()
  let latestCompactionTokensBefore = 0
  let compactionCount = 0

  for (const entry of branch) {
    if (!entry || typeof entry !== 'object') continue
    const entryType = safeString(entry.type).trim() || 'unknown'
    pushCount(entriesByType, entryType)
    if (entryType === 'compaction') {
      compactionCount += 1
      latestCompactionTokensBefore = Math.max(latestCompactionTokensBefore, safeNumber(entry.tokensBefore))
    }
    if (entryType !== 'message') continue
    const message = entry.message
    const role = safeString(message && message.role).trim() || 'unknown'
    pushCount(messageRoles, role)
    const contentStats = collectContentStats(message && message.content)
    if (role === 'assistant') {
      assistantStats.messages += 1
      mergeContentStats(assistantStats, contentStats)
      for (const [toolName, count] of Object.entries(contentStats.toolNameCounts || {})) pushCount(assistantToolNames, toolName, count)
      continue
    }
    if (role === 'toolResult') {
      toolResultStats.messages += 1
      mergeContentStats(toolResultStats, contentStats)
      pushCount(toolResultNames, message && message.toolName)
      continue
    }
    if (role === 'user') {
      userStats.messages += 1
      mergeContentStats(userStats, contentStats)
    }
  }

  return {
    branchEntryCount: branch.length,
    contextMessageCount: Array.isArray(context && context.messages) ? context.messages.length : 0,
    compactionCount,
    latestCompactionTokensBefore,
    entriesByType: sortedCountEntries(entriesByType),
    messageRoles: sortedCountEntries(messageRoles),
    assistant: {
      ...assistantStats,
      topTools: sortedCountEntries(assistantToolNames),
    },
    toolResults: {
      ...toolResultStats,
      topTools: sortedCountEntries(toolResultNames),
    },
    user: userStats,
  }
}

function derivePayloadStats(payload: any) {
  const input = Array.isArray(payload && payload.input) ? payload.input : []
  const byRole: Record<string, any> = {
    system: emptyRoleStats(),
    user: emptyRoleStats(),
    assistant: emptyRoleStats(),
    tool: emptyRoleStats(),
    developer: emptyRoleStats(),
    unknown: emptyRoleStats(),
  }
  const itemTypes: Record<string, number> = {}
  const nonMessageItemTypes: Record<string, number> = {}
  const toolNames: Record<string, number> = {}
  let compactionItems = 0
  let messageItems = 0
  let nonMessageItems = 0
  let inputApproxChars = 0
  let reasoningChars = 0
  let functionCallArgChars = 0
  let functionCallOutputChars = 0

  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const itemType = safeString(item.type).trim() || 'unknown'
    pushCount(itemTypes, itemType)
    inputApproxChars += approxJsonChars(item)
    if (itemType === 'compaction') {
      compactionItems += 1
      continue
    }
    if (itemType === 'reasoning') {
      nonMessageItems += 1
      pushCount(nonMessageItemTypes, itemType)
      reasoningChars += approxJsonChars(item.summary || item.text || item.encrypted_content || item)
      continue
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'mcp_tool_call') {
      nonMessageItems += 1
      pushCount(nonMessageItemTypes, itemType)
      functionCallArgChars += approxJsonChars(item.arguments || item.input || item)
      pushCount(toolNames, item.name)
      continue
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output' || itemType === 'mcp_tool_call_output' || itemType === 'tool_search_output') {
      nonMessageItems += 1
      pushCount(nonMessageItemTypes, itemType)
      functionCallOutputChars += approxJsonChars(item.output ?? item.content ?? item.text ?? item)
      continue
    }
    if (itemType !== 'message') {
      nonMessageItems += 1
      pushCount(nonMessageItemTypes, itemType)
      continue
    }
    messageItems += 1
    const role = safeString(item.role).trim() || 'unknown'
    const target = byRole[role] || byRole.unknown
    target.messages += 1
    const contentStats = collectContentStats(item.content)
    mergeContentStats(target, contentStats)
    for (const [toolName, count] of Object.entries(contentStats.toolNameCounts || {})) pushCount(toolNames, toolName, count)
  }

  const instructionsChars = approxJsonChars(payload && payload.instructions)
  const toolsChars = approxJsonChars(payload && payload.tools)
  return {
    inputItems: input.length,
    messageItems,
    nonMessageItems,
    compactionItems,
    assistantMessages: byRole.assistant.messages,
    userMessages: byRole.user.messages,
    systemMessages: byRole.system.messages,
    developerMessages: byRole.developer.messages,
    toolMessages: byRole.tool.messages,
    inputApproxChars,
    instructionsChars,
    toolsChars,
    itemTypes: sortedCountEntries(itemTypes),
    nonMessageItemTypes: sortedCountEntries(nonMessageItemTypes),
    toolNames: sortedCountEntries(toolNames),
    byRole,
    totals: {
      textChars: safeNumber(byRole.system.textChars) + safeNumber(byRole.user.textChars) + safeNumber(byRole.assistant.textChars) + safeNumber(byRole.tool.textChars) + safeNumber(byRole.developer.textChars) + safeNumber(byRole.unknown.textChars),
      thinkingChars: safeNumber(byRole.assistant.thinkingChars) + safeNumber(byRole.unknown.thinkingChars),
      toolCallArgChars: safeNumber(byRole.assistant.toolCallArgChars) + functionCallArgChars,
      toolResultChars: safeNumber(byRole.tool.toolResultChars) + safeNumber(byRole.unknown.toolResultChars) + functionCallOutputChars,
      reasoningChars,
      functionCallArgChars,
      functionCallOutputChars,
      instructionsChars,
      toolsChars,
    },
  }
}

function resolveSessionPaths(sessionManager: any) {
  const sessionId = safeString(sessionManager && typeof sessionManager.getSessionId === 'function' ? sessionManager.getSessionId() : '').trim()
  const sessionFile = safeString(sessionManager && typeof sessionManager.getSessionFile === 'function' ? sessionManager.getSessionFile() : '').trim()
  const sessionDir = safeString(sessionManager && typeof sessionManager.getSessionDir === 'function' ? sessionManager.getSessionDir() : '').trim()
  return {
    sessionId,
    sessionFile,
    sessionDir,
    sessionFileBase: sessionFile ? path.basename(sessionFile) : '',
  }
}

function readCompactionConfig() {
  const layout = resolveRinLayout()
  const settings = readJson(path.join(layout.homeRoot, 'settings.json'), {}) as any
  const compaction = settings && typeof settings.compaction === 'object' ? settings.compaction : {}
  return {
    enabled: compaction.enabled !== false,
    reserveTokens: safeNumber(compaction.reserveTokens, 16384),
    keepRecentTokens: safeNumber(compaction.keepRecentTokens, 20000),
  }
}

function collectPayloadObservation(payload: any, model: any, sessionManager: any, requestSeq: number) {
  const payloadStats = derivePayloadStats(payload)
  const sessionPaths = resolveSessionPaths(sessionManager)
  const sessionBranch = summarizeSessionBranch(sessionManager)
  const promptCacheKey = safeString(payload && payload.prompt_cache_key).trim()
  const payloadJson = JSON.stringify(payload || null)
  const compaction = readCompactionConfig()
  const contextWindow = safeNumber(model && model.contextWindow)
  return {
    requestSeq,
    provider: safeString(model && model.provider).trim(),
    model: safeString(model && model.id).trim(),
    api: safeString(model && model.api).trim(),
    promptCacheKey,
    hasPromptCacheKey: Boolean(promptCacheKey),
    hasCompaction: payloadStats.compactionItems > 0,
    observedAt: new Date().toISOString(),
    payloadApproxBytes: Buffer.byteLength(payloadJson || '', 'utf8'),
    modelContext: {
      contextWindow,
      maxTokens: safeNumber(model && model.maxTokens),
    },
    compaction,
    session: sessionPaths,
    prompt: payloadStats,
    sessionBranch,
  }
}

function computeDerivedUsage(observation: any) {
  const usage = observation && observation.usage && typeof observation.usage === 'object' ? observation.usage : {}
  const prompt = observation && observation.prompt && typeof observation.prompt === 'object' ? observation.prompt : {}
  const sessionBranch = observation && observation.sessionBranch && typeof observation.sessionBranch === 'object' ? observation.sessionBranch : {}
  const modelContext = observation && observation.modelContext && typeof observation.modelContext === 'object' ? observation.modelContext : {}
  const compaction = observation && observation.compaction && typeof observation.compaction === 'object' ? observation.compaction : {}
  const input = safeNumber(usage.input)
  const output = safeNumber(usage.output)
  const cacheRead = safeNumber(usage.cacheRead)
  const cacheWrite = safeNumber(usage.cacheWrite)
  const total = safeNumber(usage.totalTokens)
  const assistantMessages = safeNumber(prompt.assistantMessages)
  const toolResultChars = safeNumber(prompt && prompt.totals && prompt.totals.toolResultChars)
  const toolCallArgChars = safeNumber(prompt && prompt.totals && prompt.totals.toolCallArgChars)
  const thinkingChars = safeNumber(prompt && prompt.totals && prompt.totals.thinkingChars)
  const instructionsChars = safeNumber(prompt && prompt.totals && prompt.totals.instructionsChars)
  const toolsChars = safeNumber(prompt && prompt.totals && prompt.totals.toolsChars)
  const reasoningChars = safeNumber(prompt && prompt.totals && prompt.totals.reasoningChars)
  const reserveTokens = safeNumber(compaction.reserveTokens, 16384)
  const contextWindow = safeNumber(modelContext.contextWindow)
  const compactionThreshold = contextWindow > 0 ? Math.max(0, contextWindow - reserveTokens) : 0
  return {
    uncachedInput: Math.max(0, input - cacheRead),
    cacheReadShareOfInput: input > 0 ? cacheRead / input : 0,
    cacheReadShareOfTotal: total > 0 ? cacheRead / total : 0,
    outputInputRatio: input > 0 ? output / input : 0,
    totalPerMessage: safeNumber(prompt.messageItems) > 0 ? total / safeNumber(prompt.messageItems) : 0,
    inputPerAssistantMessage: assistantMessages > 0 ? input / assistantMessages : 0,
    inputPerToolResultChar: toolResultChars > 0 ? input / toolResultChars : 0,
    inputPerToolCallArgChar: toolCallArgChars > 0 ? input / toolCallArgChars : 0,
    inputPerThinkingChar: thinkingChars > 0 ? input / thinkingChars : 0,
    inputPerInstructionChar: instructionsChars > 0 ? input / instructionsChars : 0,
    inputPerToolSchemaChar: toolsChars > 0 ? input / toolsChars : 0,
    inputPerReasoningChar: reasoningChars > 0 ? input / reasoningChars : 0,
    cacheWriteShare: input > 0 ? cacheWrite / input : 0,
    contextTokens: total,
    compactionThreshold,
    compactionHeadroom: compactionThreshold > 0 ? compactionThreshold - total : 0,
    compactionEligibleByThreshold: compactionThreshold > 0 ? total > compactionThreshold : false,
    hasHeavyPrompt: total >= 100_000 || assistantMessages >= 12 || safeNumber(prompt.nonMessageItems) >= 300 || toolCallArgChars >= 20_000 || safeNumber(sessionBranch.compactionCount) === 0 && total >= 80_000,
  }
}

function observationLogRoot() {
  const layout = resolveRinLayout()
  return path.join(layout.homeRoot, OBSERVABILITY_DIRNAME)
}

function observationLogPath(observedAt: string) {
  const date = new Date(observedAt || Date.now())
  const yyyy = String(date.getUTCFullYear())
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return path.join(observationLogRoot(), yyyy, mm, `${dd}.jsonl`)
}

function appendObservationLog(observation: any) {
  const filePath = observationLogPath(safeString(observation && observation.observedAt))
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(observation)}\n`)
}

function createProviderUsageExtension() {
  return function providerUsageExtension(pi: any) {
    let requestSeq = 0
    let lastRequestObservation: any = null

    pi.on('before_provider_request', async (event: any, ctx: any) => {
      const model = ctx && ctx.model
      if (!model) return
      lastRequestObservation = collectPayloadObservation(event && event.payload, model, ctx && ctx.sessionManager, ++requestSeq)
    })

    pi.on('message_end', async (event: any) => {
      const message = event && event.message
      if (!message || safeString(message.role).trim() !== 'assistant') return
      const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : null
      if (!usage) return
      const observation = {
        ...(lastRequestObservation && typeof lastRequestObservation === 'object' ? lastRequestObservation : {}),
        stopReason: safeString(message && message.stopReason).trim(),
        responseId: safeString(message && message.responseId).trim(),
        usage: {
          input: safeNumber(usage.input),
          output: safeNumber(usage.output),
          cacheRead: safeNumber(usage.cacheRead),
          cacheWrite: safeNumber(usage.cacheWrite),
          totalTokens: safeNumber(usage.totalTokens),
          costTotal: safeNumber(usage.cost && usage.cost.total),
        },
      }
      observation.derived = computeDerivedUsage(observation)
      pi.appendEntry(USAGE_OBSERVATION_TYPE, observation)
      try {
        appendObservationLog(observation)
      } catch {}
    })
  }
}

export {
  USAGE_OBSERVATION_TYPE,
  createProviderUsageExtension,
}
