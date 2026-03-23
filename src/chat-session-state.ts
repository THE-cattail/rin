// @ts-nocheck

function safeString(value: any) {
  if (value == null) return ''
  return String(value)
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function defaultConversationState(chatKey: string) {
  return {
    chatKey,
    piSessionFile: '',
    lastProcessedSeq: 0,
    lastThreadIngestedSeq: 0,
    lastSeq: 0,
    lastInboundSeq: 0,
    lastInboundText: '',
    lastAgentInboundSeq: 0,
    lastAgentInboundAt: 0,
    lastAgentInboundText: '',
    lastAgentResult: null,
    lastShadowResult: null,
    lastResetResult: null,
    inboundUnprocessed: 0,
    processing: false,
    processingNoInterrupt: false,
    processingRuntime: '',
    processingPid: 0,
    processingThreadId: '',
    processingTurnId: '',
    processingRunId: '',
    processingStartedAt: 0,
    resetPendingTrigger: null,
    batchEndSeq: 0,
    lastSystemAckAt: 0,
    interruptRequested: false,
    interruptRequestedAt: 0,
    pendingWake: false,
    pendingTrigger: null,
    replyToMessageId: '',
    forceContinue: false,
    recentMessageIds: [],
  }
}

export function mergePendingTrigger(a: any, b: any) {
  if (!a) return b || null
  if (!b) return a || null
  const as = Number(a.seq || 0)
  const bs = Number(b.seq || 0)
  if (Number.isFinite(bs) && Number.isFinite(as) && bs !== as) {
    const picked = bs > as ? b : a
    return { ...picked, isMentioned: Boolean(a?.isMentioned || b?.isMentioned) }
  }
  const at = Number(a.ts || 0)
  const bt = Number(b.ts || 0)
  if (Number.isFinite(bt) && Number.isFinite(at) && bt !== at) {
    const picked = bt > at ? b : a
    return { ...picked, isMentioned: Boolean(a?.isMentioned || b?.isMentioned) }
  }
  const picked = b || a || null
  if (!picked) return null
  return { ...picked, isMentioned: Boolean(a?.isMentioned || b?.isMentioned) }
}

export function normalizeLastAgentResult(raw: any, normalizeRuntimeKind: (value: any) => string) {
  if (!raw || typeof raw !== 'object') return null
  return {
    runtime: normalizeRuntimeKind(raw.runtime || 'pi'),
    kind: safeString(raw.kind || ''),
    finishedAt: Math.max(0, Number(raw.finishedAt || 0) || 0),
    forInboundSeq: Math.max(0, Number(raw.forInboundSeq || 0) || 0),
    processedToSeq: Math.max(0, Number(raw.processedToSeq || 0) || 0),
    exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
    lastMessage: safeString(raw.lastMessage || ''),
  }
}

export function pickNewerLastAgentResult(a: any, b: any, normalizeRuntimeKind: (value: any) => string) {
  const left = normalizeLastAgentResult(a, normalizeRuntimeKind)
  const right = normalizeLastAgentResult(b, normalizeRuntimeKind)
  if (!left) return right
  if (!right) return left
  if (right.finishedAt !== left.finishedAt) return right.finishedAt > left.finishedAt ? right : left
  if (right.forInboundSeq !== left.forInboundSeq) return right.forInboundSeq > left.forInboundSeq ? right : left
  return right
}

export function normalizeConversationState({
  state,
  chatKey,
  normalizeRuntimeKind,
  normalizeLastAgentResult,
  readLegacyThreadHandle,
  writeLegacyThreadHandle,
  readPiSessionFile,
  writePiSessionFile,
  processingActive = false,
  processingRuntime = '',
  processingTimeoutMs = 5 * 60 * 1000,
  nowMs = Date.now(),
  hasLiveProcessingPid = false,
}: any) {
  const current = state && typeof state === 'object' ? state : defaultConversationState(chatKey)
  writeLegacyThreadHandle(current, readLegacyThreadHandle(current))
  writePiSessionFile(current, readPiSessionFile(current))
  if (!current.chatKey) current.chatKey = chatKey
  current.processingRuntime = current.processing
    ? normalizeRuntimeKind(current.processingRuntime || processingRuntime || 'pi')
    : safeString(current.processingRuntime || '').trim()
  if (!Number.isFinite(Number(current.lastInboundSeq))) current.lastInboundSeq = Number(current.lastSeq || 0)
  if (typeof current.lastInboundText !== 'string') current.lastInboundText = safeString(current.lastInboundText || '')
  if (!Number.isFinite(Number(current.lastThreadIngestedSeq))) current.lastThreadIngestedSeq = Number(current.lastProcessedSeq || 0) || 0
  if (!Number.isFinite(Number(current.lastAgentInboundSeq))) current.lastAgentInboundSeq = 0
  if (!Number.isFinite(Number(current.lastAgentInboundAt))) current.lastAgentInboundAt = 0
  if (typeof current.lastAgentInboundText !== 'string') current.lastAgentInboundText = safeString(current.lastAgentInboundText || '')
  current.lastAgentResult = normalizeLastAgentResult(current.lastAgentResult)
  current.lastShadowResult = normalizeLastAgentResult(current.lastShadowResult)
  current.lastResetResult = normalizeLastAgentResult(current.lastResetResult)
  if (!Number.isFinite(Number(current.inboundUnprocessed))) current.inboundUnprocessed = 0
  const lastProcessableInbound = Number(current.lastAgentInboundSeq || 0)
  const lastProcessed = Number(current.lastProcessedSeq || 0)
  const unprocessedInbound = Math.max(0, lastProcessableInbound - lastProcessed)
  if (Number(current.inboundUnprocessed || 0) > unprocessedInbound) current.inboundUnprocessed = unprocessedInbound

  if (current.processing && !safeNumber(current.processingPid, 0)) {
    const startedAt = Number(current.processingStartedAt || 0)
    const keepInProcess = Boolean(processingActive && normalizeRuntimeKind(processingRuntime || current.processingRuntime || 'pi') === 'pi')
    if (!keepInProcess && (!startedAt || nowMs - startedAt > processingTimeoutMs)) {
      current.processing = false
      current.processingRuntime = ''
      current.processingThreadId = ''
      current.processingTurnId = ''
      current.processingStartedAt = 0
    }
  }

  if (current.processing && safeNumber(current.processingPid, 0) > 0 && !hasLiveProcessingPid) {
    current.processing = false
    current.processingRuntime = ''
    current.processingPid = 0
    current.processingThreadId = ''
    current.processingTurnId = ''
    current.processingStartedAt = 0
  }

  return current
}

export function mergeConversationState({
  disk,
  state,
  chatKey,
  mergePendingTrigger,
  pickNewerLastAgentResult,
  readLegacyThreadHandle,
  writeLegacyThreadHandle,
  readPiSessionFile,
  writePiSessionFile,
}: any) {
  const left = disk && typeof disk === 'object' ? disk : defaultConversationState(chatKey)
  const right = state && typeof state === 'object' ? state : defaultConversationState(chatKey)
  const merged = { ...left, ...right }
  merged.chatKey = right.chatKey || left.chatKey || chatKey
  writeLegacyThreadHandle(merged, readLegacyThreadHandle(right))
  writePiSessionFile(merged, readPiSessionFile(right))
  merged.lastSeq = Math.max(Number(left.lastSeq || 0), Number(right.lastSeq || 0))
  merged.lastProcessedSeq = Math.max(Number(left.lastProcessedSeq || 0), Number(right.lastProcessedSeq || 0))
  merged.lastThreadIngestedSeq = Math.max(Number(left.lastThreadIngestedSeq || 0), Number(right.lastThreadIngestedSeq || 0))
  merged.lastInboundSeq = Math.max(Number(left.lastInboundSeq || 0), Number(right.lastInboundSeq || 0))
  merged.batchEndSeq = Math.max(Number(left.batchEndSeq || 0), Number(right.batchEndSeq || 0))

  const diskResetAtMs = Number(left.lastResetAtMs || 0)
  const stateResetAtMs = Number(right.lastResetAtMs || 0)
  merged.lastResetAtMs = Math.max(diskResetAtMs, stateResetAtMs)
  merged.lastResetSeq = Math.max(Number(left.lastResetSeq || 0), Number(right.lastResetSeq || 0))

  const diskProcessed = Number(left.lastProcessedSeq || 0)
  const nextProcessed = Math.max(Number(left.lastProcessedSeq || 0), Number(right.lastProcessedSeq || 0))
  const diskInbound = Number(left.inboundUnprocessed || 0)
  const stateInbound = Number(right.inboundUnprocessed || 0)
  merged.inboundUnprocessed = nextProcessed > diskProcessed ? Math.max(0, stateInbound) : Math.max(0, Math.max(diskInbound, stateInbound))

  merged.pendingWake = Boolean(right.pendingWake)
  merged.pendingTrigger = right.pendingTrigger == null ? null : mergePendingTrigger(left.pendingTrigger, right.pendingTrigger)
  merged.replyToMessageId = right.replyToMessageId == null ? (left.replyToMessageId || '') : right.replyToMessageId
  merged.forceContinue = Boolean(right.forceContinue)

  const diskAgentInboundSeq = Math.max(0, Number(left.lastAgentInboundSeq || 0) || 0)
  const stateAgentInboundSeq = Math.max(0, Number(right.lastAgentInboundSeq || 0) || 0)
  const diskAgentInboundAt = Math.max(0, Number(left.lastAgentInboundAt || 0) || 0)
  const stateAgentInboundAt = Math.max(0, Number(right.lastAgentInboundAt || 0) || 0)
  if (stateAgentInboundSeq > diskAgentInboundSeq || (stateAgentInboundSeq === diskAgentInboundSeq && stateAgentInboundAt >= diskAgentInboundAt)) {
    merged.lastAgentInboundSeq = stateAgentInboundSeq
    merged.lastAgentInboundAt = stateAgentInboundAt
    merged.lastAgentInboundText = safeString(right.lastAgentInboundText || '')
  } else {
    merged.lastAgentInboundSeq = diskAgentInboundSeq
    merged.lastAgentInboundAt = diskAgentInboundAt
    merged.lastAgentInboundText = safeString(left.lastAgentInboundText || '')
  }

  merged.lastAgentResult = pickNewerLastAgentResult(left.lastAgentResult, right.lastAgentResult)
  merged.lastShadowResult = pickNewerLastAgentResult(left.lastShadowResult, right.lastShadowResult)
  merged.lastResetResult = pickNewerLastAgentResult(left.lastResetResult, right.lastResetResult)

  if (diskResetAtMs > stateResetAtMs) {
    writeLegacyThreadHandle(merged, readLegacyThreadHandle(left))
    writePiSessionFile(merged, readPiSessionFile(left))
    merged.pendingWake = Boolean(left.pendingWake)
    merged.pendingTrigger = left.pendingTrigger == null ? null : left.pendingTrigger
    merged.inboundUnprocessed = Math.max(0, Number(left.inboundUnprocessed || 0))
  }

  const a = Array.isArray(left.recentMessageIds) ? left.recentMessageIds : []
  const b = Array.isArray(right.recentMessageIds) ? right.recentMessageIds : []
  merged.recentMessageIds = Array.from(new Set([...a, ...b])).slice(-200)
  try { delete merged.recentInboundAtMs } catch {}
  try { delete merged.backgroundPending } catch {}
  try { delete merged.backgroundNonAtUnprocessed } catch {}
  try { delete merged.backgroundLastCodexAt } catch {}
  try { delete merged.lastBackgroundAt } catch {}
  try { delete merged.backgroundArmed } catch {}
  return merged
}

export function clearPersistentConversationRunFlags(
  state: any,
  { keepPendingTrigger = false, keepResetPending = false }: { keepPendingTrigger?: boolean, keepResetPending?: boolean } = {},
) {
  state.pendingWake = false
  if (!keepPendingTrigger) state.pendingTrigger = null
  if (!keepResetPending) state.resetPendingTrigger = null
  state.replyToMessageId = ''
  state.forceContinue = false
  state.processing = false
  state.processingNoInterrupt = false
  state.processingRuntime = ''
  state.processingPid = 0
  state.processingThreadId = ''
  state.processingTurnId = ''
  state.processingRunId = ''
  state.processingStartedAt = 0
  state.interruptRequested = false
  state.interruptRequestedAt = 0
}

export function summarizeConversationResumeWork({ state, platform = '', chatId = '' }: any) {
  const current = state && typeof state === 'object' ? state : {}
  const lastSeq = Number(current.lastAgentInboundSeq || 0)
  const lastProcessed = Number(current.lastProcessedSeq || 0)
  const resetSeq = Number(current.lastResetSeq || 0)
  const effectiveProcessed = Math.max(
    Number.isFinite(lastProcessed) ? lastProcessed : 0,
    Number.isFinite(resetSeq) ? resetSeq : 0,
  )
  const hasUnprocessed = Number.isFinite(lastSeq) && Number.isFinite(effectiveProcessed) && lastSeq > effectiveProcessed
  const pending = current.pendingTrigger && typeof current.pendingTrigger === 'object' ? current.pendingTrigger : null
  const hasResumeWork = hasUnprocessed || Boolean(current.processing) || Boolean(current.pendingWake) || Boolean(current.forceContinue) || Boolean(pending)

  let isGroup = true
  try {
    if (platform === 'onebot') isGroup = !String(chatId).startsWith('private:')
    else if (platform === 'telegram') {
      const n = Number(chatId)
      isGroup = Number.isFinite(n) ? n < 0 : true
    }
  } catch {}

  const shouldCatchUp = hasResumeWork && (!isGroup
    ? true
    : Boolean(current.processing)
      || Boolean(current.pendingWake)
      || Boolean(current.forceContinue)
      || Boolean(pending && pending.isMentioned))

  return {
    lastSeq,
    lastProcessed,
    resetSeq,
    effectiveProcessed,
    hasUnprocessed,
    pending,
    hasResumeWork,
    isGroup,
    shouldCatchUp,
    keepForceContinue: Boolean(current.forceContinue) || !hasUnprocessed,
    lastText: safeString((pending && pending.content) || current.lastAgentInboundText || ''),
  }
}

export function recoverConversationFromStaleProcessing({ state, keepForceContinue = false }: any) {
  clearPersistentConversationRunFlags(state, { keepPendingTrigger: true, keepResetPending: true })
  state.pendingWake = true
  if (keepForceContinue) state.forceContinue = true
  return state
}

export function clearConversationResumeWork({
  state,
  writeLegacyThreadHandle,
  writePiSessionFile,
}: any) {
  if (typeof writeLegacyThreadHandle === 'function') writeLegacyThreadHandle(state, '')
  if (typeof writePiSessionFile === 'function') writePiSessionFile(state, '')
  const boundarySeq = Math.max(
    0,
    Number(state && state.lastProcessedSeq || 0) || 0,
    Number(state && state.lastAgentInboundSeq || 0) || 0,
    Number(state && state.lastInboundSeq || 0) || 0,
    Number(state && state.lastResetSeq || 0) || 0,
  )
  state.lastProcessedSeq = boundarySeq
  state.lastThreadIngestedSeq = Math.max(Number(state && state.lastThreadIngestedSeq || 0) || 0, boundarySeq)
  state.batchEndSeq = Math.max(Number(state && state.batchEndSeq || 0) || 0, boundarySeq)
  state.inboundUnprocessed = 0
  state.pendingWake = false
  state.pendingTrigger = null
  state.forceContinue = false
  state.replyToMessageId = ''
  clearPersistentConversationRunFlags(state, { keepPendingTrigger: false, keepResetPending: false })
  return state
}

export function resetConversationContinuation({
  state,
  keepForceContinue = false,
  writeLegacyThreadHandle,
  writePiSessionFile,
}: any) {
  if (typeof writeLegacyThreadHandle === 'function') writeLegacyThreadHandle(state, '')
  if (typeof writePiSessionFile === 'function') writePiSessionFile(state, '')
  state.lastThreadIngestedSeq = Math.max(0, Number(state.lastResetSeq || 0) || 0)
  const resetSeq = Number(state.lastResetSeq || 0)
  if (Number.isFinite(resetSeq) && resetSeq > 0) {
    const processed = Number(state.lastProcessedSeq || 0)
    if (!Number.isFinite(processed) || processed < resetSeq) state.lastProcessedSeq = resetSeq
  }
  clearPersistentConversationRunFlags(state, { keepPendingTrigger: true, keepResetPending: true })
  if (keepForceContinue) state.forceContinue = true
  return state
}

export function resetConversationStateForBoundary({
  state,
  freshBoundarySeq = 0,
  keepPendingTrigger = false,
}: any) {
  clearPersistentConversationRunFlags(state, { keepPendingTrigger, keepResetPending: false })
  state.inboundUnprocessed = 0
  state.lastInboundText = ''
  state.lastAgentInboundSeq = 0
  state.lastAgentInboundAt = 0
  state.lastAgentInboundText = ''
  state.lastAgentResult = null
  state.lastShadowResult = null
  state.lastResetResult = null
  state.lastProcessedSeq = Math.max(0, Number(freshBoundarySeq || 0) || 0)
  state.batchEndSeq = Math.max(0, Number(freshBoundarySeq || 0) || 0)
  state.replyToMessageId = ''
  return state
}

export function requestConversationInterrupt({
  state,
  nowMs = Date.now(),
  clearForceContinue = true,
}: any) {
  if (state.interruptRequested) return { changed: false }
  state.interruptRequested = true
  state.interruptRequestedAt = Number(nowMs || 0) || Date.now()
  if (clearForceContinue) state.forceContinue = false
  return { changed: true }
}

export function syncConversationFromDisk({ state, disk, observedToSeq = null, mergePendingTrigger }: any) {
  if (!disk || typeof disk !== 'object') return state
  const diskInterrupt = Boolean(disk.interruptRequested)
  if (diskInterrupt) {
    state.interruptRequested = true
    state.interruptRequestedAt = Math.max(Number(state.interruptRequestedAt || 0), Number(disk.interruptRequestedAt || 0))
  }

  const diskLastAgentInbound = Number(disk.lastAgentInboundSeq || 0)
  const diskPendingWake = Boolean(disk.pendingWake)
  const diskTrigger = disk.pendingTrigger && typeof disk.pendingTrigger === 'object' ? disk.pendingTrigger : null
  const diskTriggerSeq = diskTrigger ? Number(diskTrigger.seq || 0) : 0
  const shouldKeepTrigger = diskTrigger && (!Number.isFinite(Number(observedToSeq)) || Number(diskTriggerSeq) > Number(observedToSeq))
  if (shouldKeepTrigger) {
    state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, diskTrigger)
    state.pendingWake = true
  }
  if (Number.isFinite(Number(observedToSeq)) && Number.isFinite(diskLastAgentInbound)) {
    if (diskLastAgentInbound > Number(observedToSeq)) state.pendingWake = true
  } else if (diskPendingWake) {
    state.pendingWake = true
  }
  return state
}

export function claimConversationProcessing({
  state,
  runtime = '',
  processingRunId = '',
  nowMs = Date.now(),
  noInterrupt = false,
  pendingOnBusy = true,
  clearReplyTo = true,
  clearForceContinue = true,
}: any) {
  if (state.processing) {
    if (pendingOnBusy) state.pendingWake = true
    return { ok: false }
  }
  state.processing = true
  state.processingNoInterrupt = Boolean(noInterrupt)
  state.processingRuntime = safeString(runtime || '').trim()
  state.processingPid = 0
  state.processingThreadId = ''
  state.processingTurnId = ''
  state.processingRunId = safeString(processingRunId || '').trim()
  state.processingStartedAt = Number(nowMs || 0) || Date.now()
  if (clearReplyTo) state.replyToMessageId = ''
  if (clearForceContinue) state.forceContinue = false
  state.interruptRequested = false
  state.interruptRequestedAt = 0
  return { ok: true }
}

export function releaseConversationProcessing({
  state,
  preservePendingWake = true,
  preservePendingTrigger = true,
  preserveResetPending = true,
  preserveForceContinue = false,
}: any) {
  const pendingWake = preservePendingWake ? Boolean(state.pendingWake) : false
  const pendingTrigger = preservePendingTrigger ? state.pendingTrigger : null
  const resetPendingTrigger = preserveResetPending ? state.resetPendingTrigger : null
  const forceContinue = preserveForceContinue ? Boolean(state.forceContinue) : false
  clearPersistentConversationRunFlags(state, {
    keepPendingTrigger: preservePendingTrigger,
    keepResetPending: preserveResetPending,
  })
  state.pendingWake = pendingWake
  state.pendingTrigger = pendingTrigger
  state.resetPendingTrigger = resetPendingTrigger
  state.forceContinue = forceContinue
  return { shouldWake: pendingWake }
}

export function claimConversationTurn({
  state,
  primaryRuntime,
  processingRunId,
  nowMs,
}: any) {
  if (state.processing) {
    state.pendingWake = true
    return { ok: false }
  }
  const pendingTrigger = state.pendingTrigger && typeof state.pendingTrigger === 'object' ? state.pendingTrigger : null
  const resetPendingTrigger = state.resetPendingTrigger && typeof state.resetPendingTrigger === 'object'
    ? state.resetPendingTrigger
    : null
  const claimedTrigger = resetPendingTrigger || pendingTrigger
  const triggerSeq = Number(claimedTrigger && claimedTrigger.seq || 0) || 0
  const fromSeq = (state.lastProcessedSeq || 0) + 1
  const toSeq = triggerSeq > 0 ? triggerSeq : (state.lastAgentInboundSeq || 0)
  const allowEmpty = Boolean(state.forceContinue)
  if (toSeq < fromSeq && !allowEmpty) return { ok: false }

  state.processing = true
  state.processingNoInterrupt = Boolean(claimedTrigger && claimedTrigger.processingNoInterrupt)
  state.processingRuntime = primaryRuntime
  state.processingPid = 0
  state.processingThreadId = ''
  state.processingTurnId = ''
  state.processingRunId = processingRunId
  state.processingStartedAt = nowMs
  state.batchEndSeq = toSeq
  state.interruptRequested = false
  state.interruptRequestedAt = 0

  const pendingTriggerSeq = Number(pendingTrigger && pendingTrigger.seq || 0) || 0
  const keepQueuedPending = Boolean(resetPendingTrigger && pendingTrigger && pendingTriggerSeq > triggerSeq)
  state.pendingWake = keepQueuedPending
  if (resetPendingTrigger) state.resetPendingTrigger = null
  state.pendingTrigger = keepQueuedPending ? pendingTrigger : null
  state.replyToMessageId = safeString(claimedTrigger?.messageId || '')

  return {
    ok: true,
    fromSeq,
    toSeq,
    trigger: claimedTrigger,
  }
}

export function releaseConversationTurn({
  state,
  resultCode,
  interrupted = false,
  primaryRuntime,
  trimmed = '',
  toSeq = 0,
  fromSeq = 0,
  finishedAt = Date.now(),
  isShuttingDown = false,
}: any) {
  const resultKind = !interrupted && Number(resultCode || 0) === 0
    ? 'ok'
    : interrupted
      ? 'interrupted'
      : 'failed'
  const lastAgentResultRecord = {
    runtime: primaryRuntime,
    kind: resultKind,
    finishedAt,
    forInboundSeq: Number(toSeq || state.batchEndSeq || 0) || 0,
    processedToSeq: Number(state.batchEndSeq || 0) || 0,
    exitCode: resultCode == null ? null : Number(resultCode),
    lastMessage: safeString(trimmed || ''),
  }
  state.lastAgentResult = lastAgentResultRecord
  const resetCommandSeq = Number(state.lastResetCommandSeq || 0) || 0
  const coversResetCommand = resetCommandSeq > 0
    && Number(fromSeq || 0) <= resetCommandSeq
    && Number(toSeq || state.batchEndSeq || 0) >= resetCommandSeq
  if (coversResetCommand) state.lastResetResult = { ...lastAgentResultRecord }

  if (!interrupted && Number(resultCode || 0) === 0) {
    state.lastProcessedSeq = state.batchEndSeq
    state.forceContinue = false
    state.inboundUnprocessed = 0
  } else {
    state.forceContinue = false
  }

  const pendingWake = Boolean(state.pendingWake)
  const pendingTrigger = state.pendingTrigger
  const resetPendingTrigger = state.resetPendingTrigger
  const forceContinue = Boolean(state.forceContinue)

  state.processing = false
  state.processingNoInterrupt = false
  state.processingRuntime = ''
  state.processingPid = 0
  state.processingThreadId = ''
  state.processingTurnId = ''
  state.processingRunId = ''
  state.processingStartedAt = 0
  state.replyToMessageId = ''
  state.interruptRequested = false
  state.interruptRequestedAt = 0
  state.pendingWake = pendingWake
  state.pendingTrigger = pendingTrigger
  state.resetPendingTrigger = resetPendingTrigger
  state.forceContinue = forceContinue

  const action = isShuttingDown
    ? 'shutdown'
    : forceContinue
      ? 'continue'
      : pendingWake
        ? 'wake'
        : 'done'
  return { action, lastAgentResultRecord }
}

export function applyInboundRecord({
  state,
  record,
  tsMs,
  agentVisible = false,
  isPrivilegedCommand = false,
  slash = '',
}: any) {
  if (!isPrivilegedCommand && agentVisible) {
    state.lastAgentInboundSeq = Number(record && record.seq || 0) || 0
    state.lastAgentInboundAt = Number(tsMs || 0) || 0
    state.lastAgentInboundText = safeString(record && record.text || '')
  }
  if (isPrivilegedCommand) {
    return { shouldActivate: false }
  }
  state.inboundUnprocessed = Math.max(0, Number(state.inboundUnprocessed || 0) || 0) + 1
  return { shouldActivate: true }
}

export function buildConversationTrigger({
  record,
  userId = '',
  senderName = '',
  isMentioned = false,
  chatType = '',
  replyMeta = null,
}: any) {
  const reply = replyMeta && typeof replyMeta === 'object' ? replyMeta : {}
  return {
    seq: Number(record && record.seq || 0) || 0,
    ts: Number(record && record.ts || 0) || 0,
    messageId: safeString(record && record.messageId || ''),
    content: safeString(record && record.text || ''),
    senderUserId: safeString(userId || ''),
    senderName: safeString(senderName || ''),
    isMentioned: Boolean(isMentioned),
    chatType: safeString(chatType || (record && record.chatType) || ''),
    replyToMessageId: safeString(reply.replyToMessageId || ''),
    quotedText: safeString(reply.quotedText || ''),
    quotedSenderUserId: safeString(reply.quotedSenderUserId || ''),
    quotedSenderName: safeString(reply.quotedSenderName || ''),
  }
}

export function queueConversationTrigger({ state, trigger, mergePendingTrigger }: any) {
  state.pendingWake = true
  state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, trigger)
  return state.pendingTrigger
}

export function planConversationActivation({
  state,
  effectiveChatType,
  agentVisible,
  trigger,
}: any) {
  if (!agentVisible || !trigger) return { mode: 'ignore' }
  if (effectiveChatType === 'private') {
    queueConversationTrigger({ state, trigger, mergePendingTrigger })
    return { mode: 'activate_private' }
  }
  if (effectiveChatType === 'group') {
    queueConversationTrigger({ state, trigger, mergePendingTrigger })
    if (trigger.isMentioned) return { mode: 'activate_group_mention' }
    if (state.pendingTrigger && state.pendingTrigger.isMentioned && state.pendingWake && !state.processing) {
      return { mode: 'activate_group_pending_mention' }
    }
  }
  return { mode: 'ignore' }
}

export function buildBridgeRestartResumeThreadText({
  requestId = '',
  reason = '',
  startupText = '',
}: any = {}) {
  const visibleReply = safeString(startupText || '').trim() || 'Daemon is back online now.'
  const lines = [
    '[daemon internal restart note]',
    'This is an internal runtime event, not a user message.',
    'Daemon just completed a self-restart for this chat.',
  ]
  const nextRequestId = safeString(requestId || '').trim()
  const nextReason = safeString(reason || '').trim()
  if (nextRequestId) lines.push(`requestId: ${nextRequestId}`)
  if (nextReason) lines.push(`reason: ${nextReason}`)
  lines.push('Do not mention requestId, reason, logs, thread state, or restart internals to the user.')
  lines.push('Please send exactly this brief plain-text message to the current chat:')
  lines.push(visibleReply)
  lines.push('After sending it, continue normally on later turns.')
  return lines.join('\n')
}

export function buildTuiDaemonRestartSystemPromptExtra({ reason = '' }: any = {}) {
  const nextReason = safeString(reason || '').trim()
  const lines = [
    '[daemon restart continuity note]',
    'The daemon hosting this TUI session restarted after the previous saved turn.',
    'Any in-flight generation, queued follow-up, or unsent output from before the restart may have been interrupted and should not be assumed to have completed or been delivered.',
    'Continue from the persisted session state and currently visible transcript only.',
    'If the user asks, state plainly that the daemon restarted and the interrupted turn did not continue automatically.',
  ]
  if (nextReason) lines.push(`Restart reason (internal only): ${nextReason}`)
  return lines.join('\n')
}
