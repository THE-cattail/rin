const test = require('node:test')
const assert = require('node:assert/strict')

const { createRinBuiltinExtensionTools } = require('../dist/runtime.js')

function createTools(modelRegistry, overrides = {}) {
  return createRinBuiltinExtensionTools({
    repoRoot: '/tmp/rin-repo',
    stateRoot: '/tmp/rin-state',
    pi: {},
    agentDir: '/tmp/rin-state/.pi',
    authStorage: {},
    modelRegistry,
    resourceLoader: {
      getSkills() {
        return { skills: [] }
      },
    },
    sessionManager: {},
    sessionRef: { current: null },
    ...overrides,
  })
}

test('rin_subagent can list available models by default', async () => {
  const available = [
    {
      provider: 'google',
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      api: 'google',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 65536,
    },
  ]
  const all = [
    ...available,
    {
      provider: 'openrouter',
      id: 'google/gemini-3.1-pro-preview',
      name: 'Google: Gemini 3.1 Pro Preview',
      api: 'openrouter',
      reasoning: true,
      input: ['text'],
      contextWindow: 1048576,
      maxTokens: 65536,
    },
  ]
  const registry = {
    getAvailable() { return available },
    getAll() { return all },
  }
  const tools = createTools(registry)
  const tool = tools.find((entry) => entry.name === 'rin_subagent')

  assert.ok(tool, 'expected rin_subagent tool to be present')

  const result = await tool.execute('tool-1', { action: 'list_models' }, undefined, undefined, { modelRegistry: registry })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(result.isError, false)
  assert.equal(payload.scope, 'available')
  assert.equal(payload.totalCount, 1)
  assert.equal(payload.count, 1)
  assert.equal(payload.models[0].provider, 'google')
  assert.equal(payload.models[0].id, 'gemini-3.1-pro-preview')
  assert.equal(payload.models[0].hasAuth, true)
})

test('rin_subagent can inspect all models with filters and truncation', async () => {
  const available = [
    {
      provider: 'google',
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      api: 'google',
      reasoning: true,
      input: ['text'],
      contextWindow: 1048576,
      maxTokens: 65536,
    },
  ]
  const all = [
    ...available,
    {
      provider: 'google',
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      api: 'google',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 65536,
    },
    {
      provider: 'openrouter',
      id: 'google/gemini-3.1-pro-preview',
      name: 'Google: Gemini 3.1 Pro Preview',
      api: 'openrouter',
      reasoning: true,
      input: ['text'],
      contextWindow: 1048576,
      maxTokens: 65536,
    },
  ]
  const registry = {
    getAvailable() { return available },
    getAll() { return all },
  }
  const tools = createTools(registry)
  const tool = tools.find((entry) => entry.name === 'rin_subagent')
  const result = await tool.execute('tool-2', {
    action: 'list_models',
    scope: 'all',
    provider: 'google',
    search: 'gemini',
    limit: 1,
  }, undefined, undefined, { modelRegistry: registry })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(result.isError, false)
  assert.equal(payload.scope, 'all')
  assert.equal(payload.provider, 'google')
  assert.equal(payload.totalCount, 2)
  assert.equal(payload.count, 1)
  assert.equal(payload.truncated, true)
  assert.deepEqual(payload.providers, { google: 2 })
  assert.equal(payload.models[0].provider, 'google')
  assert.equal(typeof payload.models[0].hasAuth, 'boolean')
})

test('rin_subagent supports chain orchestration with {previous} handoff', async () => {
  const registry = {
    find(provider, model) {
      return {
        provider,
        id: model,
        name: `${provider}/${model}`,
        api: provider,
        reasoning: true,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 8192,
      }
    },
    async getApiKey() {
      return 'ok'
    },
    getAvailable() { return [] },
    getAll() { return [] },
  }

  const seenPrompts = []
  const pi = {
    async __rinRunSubagentProcess({ prompt, model }) {
      seenPrompts.push({ prompt, model: model.id })
      return {
        text: prompt.includes('step two') ? `final from ${model.id}` : `context from ${model.id}`,
        stopReason: 'stop',
        errorMessage: '',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 15,
          turns: 1,
        },
        messages: [],
        aborted: false,
        exitCode: 0,
        stderr: '',
      }
    },
  }

  const tools = createTools(registry, { pi })
  const tool = tools.find((entry) => entry.name === 'rin_subagent')
  const result = await tool.execute('tool-chain', {
    chain: [
      { provider: 'alpha', model: 'one', task: 'step one' },
      { provider: 'beta', model: 'two', task: 'step two using {previous}' },
    ],
  }, undefined, undefined, {
    cwd: '/tmp',
    sessionManager: {},
    modelRegistry: registry,
    agent: { state: { tools: [{}], systemPrompt: '' } },
  })

  assert.equal(result.isError, false)
  assert.equal(result.details.mode, 'chain')
  assert.equal(result.details.results.length, 2)
  assert.match(result.content[0].text, /final from two/)
  assert.equal(seenPrompts[0].prompt, 'step one')
  assert.equal(seenPrompts[1].prompt, 'step two using context from one')
})

test('rin_subagent supports parallel orchestration without role overlays', async () => {
  const registry = {
    find(provider, model) {
      return {
        provider,
        id: model,
        name: `${provider}/${model}`,
        api: provider,
        reasoning: true,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 8192,
      }
    },
    async getApiKey() {
      return 'ok'
    },
    getAvailable() { return [] },
    getAll() { return [] },
  }

  const seenSystemPrompts = []
  const pi = {
    async __rinRunSubagentProcess({ prompt, systemPrompt, model }) {
      seenSystemPrompts.push(systemPrompt)
      return {
        text: `${model.id}:${prompt}`,
        stopReason: 'stop',
        errorMessage: '',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 15,
          turns: 1,
        },
        messages: [],
        aborted: false,
        exitCode: 0,
        stderr: '',
      }
    },
  }

  const tools = createTools(registry, { pi })
  const tool = tools.find((entry) => entry.name === 'rin_subagent')
  const result = await tool.execute('tool-parallel', {
    tasks: [
      { provider: 'alpha', model: 'one', task: 'find api' },
      { provider: 'beta', model: 'two', task: 'check tests' },
    ],
  }, undefined, undefined, {
    cwd: '/tmp',
    sessionManager: {},
    modelRegistry: registry,
    agent: { state: { tools: [{}], systemPrompt: 'Base prompt' } },
    getSystemPrompt() { return 'Base prompt' },
  })

  assert.equal(result.isError, false)
  assert.equal(result.details.mode, 'parallel')
  assert.equal(result.details.results.length, 2)
  assert.match(result.content[0].text, /one:find api/)
  assert.match(result.content[0].text, /two:check tests/)
  assert.ok(seenSystemPrompts.every((text) => !/Role overlay:/i.test(text)))
})

test('rin_subagent surfaces quota failures clearly', async () => {
  const quotaMessage = 'Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h57m2s.'
  const registry = {
    find(provider, model) {
      if (provider === 'google-gemini-cli' && model === 'gemini-3.1-pro-preview') {
        return {
          provider,
          id: model,
          name: 'Gemini 3.1 Pro Preview (Cloud Code Assist)',
          api: 'google-gemini-cli',
          reasoning: true,
          input: ['text'],
          contextWindow: 1048576,
          maxTokens: 65536,
        }
      }
      return undefined
    },
    async getApiKey() {
      return 'oauth-ok'
    },
    getAvailable() {
      return []
    },
    getAll() {
      return []
    },
  }

  const pi = {
    async __rinRunSubagentProcess() {
      return {
        text: '',
        stopReason: 'error',
        errorMessage: quotaMessage,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: quotaMessage,
            content: [],
            usage: {},
          },
        ],
        aborted: false,
        exitCode: 1,
        stderr: '',
      }
    },
  }

  const tools = createTools(registry, { pi })
  const tool = tools.find((entry) => entry.name === 'rin_subagent')
  const result = await tool.execute('tool-3', {
    provider: 'google-gemini-cli',
    model: 'gemini-3.1-pro-preview',
    task: 'polish text',
  }, undefined, undefined, {
    cwd: '/tmp',
    sessionManager: {},
    modelRegistry: registry,
    agent: { state: { tools: [{}], systemPrompt: '' } },
  })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /quota or rate limit/i)
  assert.match(result.content[0].text, /google-gemini-cli\/gemini-3\.1-pro-preview/)
  assert.equal(result.details.result.errorKind, 'quota_or_rate_limit')
  assert.equal(result.details.result.rawError, quotaMessage)
})
