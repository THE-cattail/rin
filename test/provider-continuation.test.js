const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyProviderOptimizations,
  canUsePreviousResponse,
  extractComparablePayload,
  rewritePayloadWithRemoteCompaction,
  convertAgentMessagesToResponsesInput,
  buildRemoteCompactionReplayItems,
} = require('../dist/provider-continuation.js')

test('continuation leaves provider payload untouched', () => {
  const payload = {
    model: 'gpt-5',
    instructions: 'sys',
    prompt_cache_key: 'sess-1',
    prompt_cache_retention: '24h',
    store: false,
    input: [
      { role: 'developer', content: 'sys' },
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ],
    stream: true,
    tool_choice: 'auto',
  }
  const optimized = applyProviderOptimizations({
    payload,
    model: { api: 'openai-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
    sessionId: 'sess-1',
    state: { lastResponseId: 'resp-1', lastComparable: null },
  })
  assert.deepEqual(optimized.payload, payload)
  assert.equal(optimized.usedPreviousResponse, false)
})

test('rewritePayloadWithRemoteCompaction replaces summary envelope with assistant summary plus compaction item', () => {
  const payload = {
    model: 'gpt-5',
    input: [
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nold summary\n</summary>',
        }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'next turn' }],
      },
    ],
  }
  const rewritten = rewritePayloadWithRemoteCompaction({
    payload,
    summary: 'remote summary',
    encryptedContent: 'ENCRYPTED',
  })
  assert.equal(rewritten.changed, true)
  assert.equal(rewritten.payload.input[0].type, 'message')
  assert.equal(rewritten.payload.input[0].role, 'assistant')
  assert.equal(rewritten.payload.input[0].content[0].text, 'remote summary')
  assert.deepEqual(rewritten.payload.input[1], { type: 'compaction', encrypted_content: 'ENCRYPTED' })
  assert.equal(rewritten.payload.input[2].content[0].text, 'next turn')
})

test('rewritePayloadWithRemoteCompaction prefers remote output items when available', () => {
  const payload = {
    model: 'gpt-5',
    input: [
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nold summary\n</summary>',
        }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'after compact' }],
      },
    ],
  }
  const rewritten = rewritePayloadWithRemoteCompaction({
    payload,
    summary: 'fallback summary',
    encryptedContent: 'ENCRYPTED',
    rawOutput: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'fresh developer instructions' }],
      },
      {
        type: 'compaction_summary',
        encrypted_content: 'ENCRYPTED',
      },
    ],
  })
  assert.equal(rewritten.changed, true)
  assert.equal(rewritten.payload.input[0].role, 'developer')
  assert.equal(rewritten.payload.input[0].content[0].text, 'fresh developer instructions')
  assert.deepEqual(rewritten.payload.input[1], { type: 'compaction', encrypted_content: 'ENCRYPTED' })
  assert.equal(rewritten.payload.input[2].content[0].text, 'after compact')
})

test('rewritePayloadWithRemoteCompaction drops kept historical suffix for non-split compaction', () => {
  const payload = {
    model: 'gpt-5',
    input: [
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nold summary\n</summary>',
        }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'old kept assistant', annotations: [] }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'fresh user turn' }],
      },
    ],
  }
  const rewritten = rewritePayloadWithRemoteCompaction({
    payload,
    encryptedContent: 'ENCRYPTED',
    rawOutput: [{ type: 'compaction_summary', encrypted_content: 'ENCRYPTED' }],
    dropFollowingHistoricalItems: true,
  })
  assert.equal(rewritten.changed, true)
  assert.deepEqual(rewritten.payload.input, [
    { type: 'compaction', encrypted_content: 'ENCRYPTED' },
    { role: 'user', content: [{ type: 'input_text', text: 'fresh user turn' }] },
  ])
})

test('buildRemoteCompactionReplayItems falls back to compaction only when remote output has no summary text', () => {
  const items = buildRemoteCompactionReplayItems({
    rawOutput: [{ type: 'compaction_summary', encrypted_content: 'ENC' }],
    summary: 'unused summary',
    encryptedContent: 'ENC',
    fallbackSummary: 'old summary',
  })
  assert.deepEqual(items, [{ type: 'compaction', encrypted_content: 'ENC' }])
})

test('rewritePayloadWithRemoteCompaction heuristically drops plain assistant suffix when remote output has no assistant message', () => {
  const payload = {
    model: 'gpt-5',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nold summary\n</summary>' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'kept assistant', annotations: [] }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'fresh user turn' }],
      },
    ],
  }
  const rewritten = rewritePayloadWithRemoteCompaction({
    payload,
    encryptedContent: 'ENC',
    rawOutput: [{ type: 'compaction_summary', encrypted_content: 'ENC' }],
  })
  assert.deepEqual(rewritten.payload.input, [
    { type: 'compaction', encrypted_content: 'ENC' },
    { role: 'user', content: [{ type: 'input_text', text: 'fresh user turn' }] },
  ])
})

test('convertAgentMessagesToResponsesInput converts representative message types', () => {
  const items = convertAgentMessagesToResponsesInput([
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: Date.now(),
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'world' }],
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-5',
      timestamp: Date.now(),
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1|fc_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'file contents' }],
      isError: false,
      timestamp: Date.now(),
    },
  ])
  assert.equal(items[0].role, 'user')
  assert.equal(items[1].type, 'message')
  assert.equal(items[1].role, 'assistant')
  assert.equal(items[2].type, 'function_call_output')
  assert.equal(items[2].call_id, 'call-1')
})

test('extractComparablePayload keeps input and envelope split', () => {
  const comparable = extractComparablePayload({
    instructions: 'a',
    input: [{ x: 1 }, { x: 2 }],
    stream: true,
    previous_response_id: 'resp-1',
  })
  assert.deepEqual(comparable.input, [{ x: 1 }, { x: 2 }])
  assert.equal(comparable.envelope.instructions, 'a')
  assert.equal(comparable.envelope.stream, true)
  assert.equal(comparable.envelope.previous_response_id, undefined)
})

test('prefix comparison requires identical envelope and strict prefix growth', () => {
  const previous = extractComparablePayload({
    instructions: 'a',
    input: [{ x: 1 }],
  })
  const same = extractComparablePayload({
    instructions: 'a',
    input: [{ x: 1 }],
  })
  const extended = extractComparablePayload({
    instructions: 'a',
    input: [{ x: 1 }, { x: 2 }],
  })
  assert.equal(canUsePreviousResponse({ previous, current: same }), false)
  assert.equal(canUsePreviousResponse({ previous, current: extended }), true)
})
