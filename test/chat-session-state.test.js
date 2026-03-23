const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyInboundRecord,
  buildBridgeRestartResumeThreadText,
  buildConversationTrigger,
  buildTuiDaemonRestartSystemPromptExtra,
  claimConversationProcessing,
  claimConversationTurn,
  clearConversationResumeWork,
  defaultConversationState,
  mergeConversationState,
  mergePendingTrigger,
  planConversationActivation,
  recoverConversationFromStaleProcessing,
  releaseConversationProcessing,
  releaseConversationTurn,
  requestConversationInterrupt,
  resetConversationContinuation,
  resetConversationStateForBoundary,
  summarizeConversationResumeWork,
} = require('../dist/chat-session-state.js')

const id = (v) => String(v || '')

test('default conversation state stays transport-agnostic and starts idle', () => {
  const state = defaultConversationState('onebot:test')
  assert.equal(state.chatKey, 'onebot:test')
  assert.equal(state.processing, false)
  assert.equal(state.pendingWake, false)
  assert.deepEqual(state.recentMessageIds, [])
  assert.equal(state.piSessionFile, '')
})

test('mergePendingTrigger keeps the newest trigger while preserving mention intent', () => {
  const merged = mergePendingTrigger(
    { seq: 3, ts: 10, isMentioned: true, content: 'old' },
    { seq: 5, ts: 9, isMentioned: false, content: 'new' },
  )
  assert.equal(merged.seq, 5)
  assert.equal(merged.content, 'new')
  assert.equal(merged.isMentioned, true)
})

test('mergeConversationState keeps monotonic seqs and newest inbound/result data', () => {
  const merged = mergeConversationState({
    disk: {
      ...defaultConversationState('onebot:test'),
      lastSeq: 2,
      lastProcessedSeq: 1,
      lastAgentInboundSeq: 1,
      lastAgentInboundAt: 100,
      lastAgentInboundText: 'old',
      recentMessageIds: ['a'],
    },
    state: {
      ...defaultConversationState('onebot:test'),
      lastSeq: 3,
      lastProcessedSeq: 2,
      lastAgentInboundSeq: 2,
      lastAgentInboundAt: 200,
      lastAgentInboundText: 'new',
      recentMessageIds: ['b'],
    },
    chatKey: 'onebot:test',
    mergePendingTrigger,
    pickNewerLastAgentResult: (a, b) => b || a,
    readLegacyThreadHandle: () => '',
    writeLegacyThreadHandle: () => '',
    readPiSessionFile: () => '',
    writePiSessionFile: () => '',
  })
  assert.equal(merged.lastSeq, 3)
  assert.equal(merged.lastProcessedSeq, 2)
  assert.equal(merged.lastAgentInboundText, 'new')
  assert.deepEqual(merged.recentMessageIds.sort(), ['a', 'b'])
})

test('claimConversationTurn captures current trigger and releaseConversationTurn preserves wake decisions', () => {
  const state = defaultConversationState('onebot:test')
  state.lastProcessedSeq = 1
  state.lastAgentInboundSeq = 2
  state.pendingWake = true
  state.pendingTrigger = { seq: 2, ts: 20, messageId: 'm2' }

  const claimed = claimConversationTurn({
    state,
    primaryRuntime: 'pi',
    processingRunId: 'run-1',
    nowMs: 123,
  })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.fromSeq, 2)
  assert.equal(claimed.toSeq, 2)
  assert.equal(state.processing, true)

  state.pendingWake = true
  state.pendingTrigger = { seq: 3, ts: 30, messageId: 'm3', isMentioned: true }
  const released = releaseConversationTurn({
    state,
    resultCode: 0,
    interrupted: false,
    primaryRuntime: 'pi',
    trimmed: 'done',
    toSeq: 2,
    fromSeq: 2,
    finishedAt: 200,
    isShuttingDown: false,
  })
  assert.equal(released.action, 'wake')
  assert.equal(state.processing, false)
  assert.equal(state.pendingWake, true)
  assert.equal(state.pendingTrigger.messageId, 'm3')
})

test('claimConversationProcessing and releaseConversationProcessing keep generic processing flags centralized', () => {
  const state = defaultConversationState('onebot:test')
  state.pendingWake = true
  state.pendingTrigger = { seq: 9, messageId: 'm9' }

  const claimed = claimConversationProcessing({
    state,
    runtime: 'pi',
    processingRunId: 'job-1',
    nowMs: 500,
  })
  assert.equal(claimed.ok, true)
  assert.equal(state.processing, true)
  assert.equal(state.processingRunId, 'job-1')

  const released = releaseConversationProcessing({
    state,
    preservePendingWake: true,
    preservePendingTrigger: true,
    preserveResetPending: true,
  })
  assert.equal(released.shouldWake, true)
  assert.equal(state.processing, false)
  assert.equal(state.pendingWake, true)
  assert.equal(state.pendingTrigger.messageId, 'm9')
})

test('applyInboundRecord and activation planning capture private and mentioned-group wake semantics', () => {
  const privateState = defaultConversationState('onebot:test')
  const record = { seq: 4, ts: 40, messageId: 'm4', text: 'hi', chatType: 'private' }
  const inbound = applyInboundRecord({
    state: privateState,
    record,
    tsMs: 400,
    agentVisible: true,
    isPrivilegedCommand: false,
  })
  assert.equal(inbound.shouldActivate, true)
  const privateTrigger = buildConversationTrigger({ record, userId: 'u1', senderName: 'owner', chatType: 'private', isMentioned: false })
  const privatePlan = planConversationActivation({
    state: privateState,
    effectiveChatType: 'private',
    agentVisible: true,
    trigger: privateTrigger,
  })
  assert.equal(privatePlan.mode, 'activate_private')
  assert.equal(privateState.pendingTrigger.messageId, 'm4')

  const groupState = defaultConversationState('onebot:group')
  const groupTrigger = buildConversationTrigger({ record: { ...record, messageId: 'm5', chatType: 'group' }, userId: 'u1', senderName: 'owner', chatType: 'group', isMentioned: true })
  const groupPlan = planConversationActivation({
    state: groupState,
    effectiveChatType: 'group',
    agentVisible: true,
    trigger: groupTrigger,
  })
  assert.equal(groupPlan.mode, 'activate_group_mention')
  assert.equal(groupState.pendingTrigger.messageId, 'm5')
})

test('restart note builders keep bridge and tui continuity semantics explicit', () => {
  const bridge = buildBridgeRestartResumeThreadText({ requestId: 'abc', reason: 'manual', startupText: '我回来了' })
  const tui = buildTuiDaemonRestartSystemPromptExtra({ reason: 'daemon_tui_rpc_reconnect' })
  assert.match(bridge, /requestId: abc/)
  assert.match(bridge, /Please send exactly this brief plain-text message/)
  assert.match(tui, /daemon hosting this TUI session restarted/i)
  assert.match(tui, /interrupted/i)
})

test('resume helpers summarize work and normalize stale or reset continuation state', () => {
  const state = {
    ...defaultConversationState('onebot:private'),
    lastAgentInboundSeq: 5,
    lastProcessedSeq: 3,
    pendingWake: false,
    pendingTrigger: { seq: 5, content: '继续', isMentioned: false },
    processing: true,
    forceContinue: false,
    lastResetSeq: 4,
    piSessionFile: '/tmp/demo.jsonl',
  }

  const summary = summarizeConversationResumeWork({ state, platform: 'onebot', chatId: 'private:123' })
  assert.equal(summary.hasResumeWork, true)
  assert.equal(summary.shouldCatchUp, true)
  assert.equal(summary.keepForceContinue, false)
  assert.equal(summary.lastText, '继续')

  recoverConversationFromStaleProcessing({ state, keepForceContinue: summary.keepForceContinue })
  assert.equal(state.processing, false)
  assert.equal(state.pendingWake, true)
  assert.equal(state.forceContinue, false)

  requestConversationInterrupt({ state, nowMs: 777, clearForceContinue: true })
  assert.equal(state.interruptRequested, true)
  assert.equal(state.interruptRequestedAt, 777)

  resetConversationStateForBoundary({ state, freshBoundarySeq: 4, keepPendingTrigger: false })
  assert.equal(state.lastProcessedSeq, 4)
  assert.equal(state.batchEndSeq, 4)
  assert.equal(state.lastAgentInboundSeq, 0)
  assert.equal(state.lastAgentResult, null)

  resetConversationContinuation({
    state,
    keepForceContinue: true,
    writePiSessionFile: (target, value) => { target.piSessionFile = value },
  })
  assert.equal(state.piSessionFile, '')
  assert.equal(state.lastThreadIngestedSeq, 4)
  assert.equal(state.lastProcessedSeq, 4)
  assert.equal(state.forceContinue, true)
})

test('clearConversationResumeWork drops interrupted auto-resume state after daemon restart', () => {
  const state = {
    ...defaultConversationState('onebot:private'),
    piSessionFile: '/tmp/demo.jsonl',
    lastInboundSeq: 8,
    lastAgentInboundSeq: 7,
    lastProcessedSeq: 3,
    lastThreadIngestedSeq: 2,
    batchEndSeq: 3,
    inboundUnprocessed: 4,
    pendingWake: true,
    pendingTrigger: { seq: 7, content: '继续' },
    forceContinue: true,
    processing: true,
    replyToMessageId: 'm7',
  }

  clearConversationResumeWork({
    state,
    writePiSessionFile: (target, value) => { target.piSessionFile = value },
  })

  assert.equal(state.piSessionFile, '')
  assert.equal(state.processing, false)
  assert.equal(state.pendingWake, false)
  assert.equal(state.pendingTrigger, null)
  assert.equal(state.forceContinue, false)
  assert.equal(state.inboundUnprocessed, 0)
  assert.equal(state.lastProcessedSeq, 8)
  assert.equal(state.lastThreadIngestedSeq, 8)
  assert.equal(state.replyToMessageId, '')
})
