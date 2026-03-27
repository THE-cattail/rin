const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FROZEN_SYSTEM_PROMPT_ENTRY_TYPE,
  FROZEN_REQUEST_SURFACE_ENTRY_TYPE,
  FROZEN_REQUEST_SURFACE_KEYS,
  createFrozenSystemPromptExtension,
} = require('../dist/frozen-system-prompt-extension.js')

function createPiHarness() {
  const handlers = new Map()
  const appended = []
  const branchEntries = []
  const sessionManager = {
    getBranch() {
      return branchEntries.slice()
    },
  }
  return {
    appended,
    sessionManager,
    on(event, handler) {
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
    },
    appendEntry(customType, data) {
      appended.push({ customType, data })
      branchEntries.push({
        type: 'custom',
        customType,
        data,
      })
    },
    async emit(event, payload, ctx) {
      const list = handlers.get(event) || []
      let result
      for (const handler of list) {
        const next = await handler(payload, ctx || { sessionManager })
        if (next !== undefined) result = next
      }
      return result
    },
  }
}

test('frozen system prompt extension captures first prompt', async () => {
  const pi = createPiHarness()
  createFrozenSystemPromptExtension()(pi)
  const result = await pi.emit('before_agent_start', {
    type: 'before_agent_start',
    prompt: 'hello',
    systemPrompt: 'frozen once',
  })
  assert.equal(result.systemPrompt, 'frozen once')
  assert.equal(pi.appended.length, 1)
  assert.equal(pi.appended[0].customType, FROZEN_SYSTEM_PROMPT_ENTRY_TYPE)
  assert.equal(pi.appended[0].data.systemPrompt, 'frozen once')
})

test('frozen system prompt extension reuses stored prompt on later turns', async () => {
  const pi = createPiHarness()
  createFrozenSystemPromptExtension()(pi)
  pi.appendEntry(FROZEN_SYSTEM_PROMPT_ENTRY_TYPE, { systemPrompt: 'old frozen prompt' })
  const result = await pi.emit('before_agent_start', {
    type: 'before_agent_start',
    prompt: 'hello again',
    systemPrompt: 'new dynamic prompt',
  })
  assert.equal(result.systemPrompt, 'old frozen prompt')
  assert.equal(pi.appended.length, 1)
})

test('frozen system prompt extension freezes provider request surface after first request', async () => {
  const pi = createPiHarness()
  createFrozenSystemPromptExtension()(pi)

  await pi.emit('before_agent_start', {
    type: 'before_agent_start',
    prompt: 'hello',
    systemPrompt: 'frozen prompt',
  })

  const firstPayload = await pi.emit('before_provider_request', {
    type: 'before_provider_request',
    payload: {
      model: 'gpt-5.4',
      instructions: 'frozen prompt',
      tools: [{ type: 'function', name: 'tool_a', parameters: { type: 'object' } }],
      text: { verbosity: 'medium' },
      tool_choice: 'auto',
      parallel_tool_calls: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    },
  })
  assert.equal(firstPayload.instructions, 'frozen prompt')
  assert.deepEqual(firstPayload.tools, [{ type: 'function', name: 'tool_a', parameters: { type: 'object' } }])
  assert.equal(pi.appended[1].customType, FROZEN_REQUEST_SURFACE_ENTRY_TYPE)
  assert.deepEqual(
    Object.keys(pi.appended[1].data.surface).sort(),
    ['instructions', 'tools'].sort(),
  )

  const secondPayload = await pi.emit('before_provider_request', {
    type: 'before_provider_request',
    payload: {
      model: 'gpt-5.4',
      instructions: 'mutated prompt',
      tools: [{ type: 'function', name: 'tool_b', parameters: { type: 'object', extra: true } }],
      text: { verbosity: 'low' },
      tool_choice: 'required',
      parallel_tool_calls: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'follow up' }] }],
      stream: true,
      prompt_cache_key: 'sess-2',
    },
  })
  assert.equal(secondPayload.instructions, 'frozen prompt')
  assert.deepEqual(secondPayload.tools, [{ type: 'function', name: 'tool_a', parameters: { type: 'object' } }])
  assert.deepEqual(secondPayload.text, { verbosity: 'low' })
  assert.equal(secondPayload.tool_choice, 'required')
  assert.equal(secondPayload.parallel_tool_calls, false)
  assert.deepEqual(secondPayload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'follow up' }] }])
  assert.equal(secondPayload.stream, true)
  assert.equal(secondPayload.prompt_cache_key, 'sess-2')
})
