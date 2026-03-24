const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const {
  createRinBuiltinExtensionTools,
  createRinBuiltinExtensionFactory,
} = require('../dist/runtime.js')

function baseArgs(stateRoot = '/tmp/rin-state') {
  return {
    repoRoot: '/tmp/rin-repo',
    stateRoot,
    pi: {},
    agentDir: '/tmp/rin-state/.pi',
    authStorage: {},
    modelRegistry: {},
    resourceLoader: {
      getSkills() {
        return { skills: [] }
      },
    },
    sessionManager: {},
    sessionRef: { current: null },
  }
}

async function withCtlServer(handler, run) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ctl-test-'))
  const sockPath = path.join(stateRoot, 'data', 'rin-ctl.sock')
  fs.mkdirSync(path.dirname(sockPath), { recursive: true })
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let payload = {}
      try { payload = JSON.parse(buf.slice(0, nl)) } catch {}
      Promise.resolve(handler(payload)).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`)
      })
    })
  })
  await new Promise((resolve) => server.listen(sockPath, resolve))
  try {
    return await run({ stateRoot, sockPath })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    try { fs.rmSync(stateRoot, { recursive: true, force: true }) } catch {}
  }
}

test('builtin Rin extension tool definitions cover all builtin Rin extension tools', () => {
  const tools = createRinBuiltinExtensionTools(baseArgs())
  const names = tools.map((tool) => tool.name)

  assert.deepEqual(names.sort(), [
    'rin_context',
    'rin_history',
    'rin_koishi',
    'rin_memory',
    'rin_schedule',
    'rin_skills',
    'rin_subagent',
    'rin_web_search',
  ].sort())
})

test('builtin Rin enum-like tool parameters expose descriptions with allowed values', () => {
  const tools = createRinBuiltinExtensionTools(baseArgs())
  const webSearch = tools.find((tool) => tool.name === 'rin_web_search')
  const history = tools.find((tool) => tool.name === 'rin_history')
  const subagent = tools.find((tool) => tool.name === 'rin_subagent')

  assert.match(webSearch.parameters.properties.q.description, /SearXNG search query/)
  assert.match(webSearch.parameters.properties.time_range.description, /day, week, month, year/)
  assert.match(webSearch.parameters.properties.safesearch.description, /0, 1, 2/)
  assert.match(history.parameters.properties.source.description, /auto, session, chat/)
  assert.match(subagent.parameters.properties.action.description, /run, list_models/)
  assert.match(subagent.parameters.properties.contextMode.description, /full, summary, empty/)
  assert.match(subagent.parameters.properties.thinking.description, /off, minimal, low, medium, high, xhigh/)
})

test('rin_context lists Pi-style AGENTS candidates and discovered project skill paths', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-context-tool-'))
  try {
    const repoDir = path.join(tempRoot, 'repo')
    const workDir = path.join(repoDir, 'pkg')
    fs.mkdirSync(workDir, { recursive: true })

    fs.writeFileSync(path.join(tempRoot, 'AGENTS.md'), '# root\n')
    fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), '# repo\n')

    const targetSkillsDir = path.join(workDir, '.agents', 'skills')
    const ancestorSkillsDir = path.join(repoDir, '.agents', 'skills')
    fs.mkdirSync(path.join(targetSkillsDir, 'alpha'), { recursive: true })
    fs.mkdirSync(path.join(ancestorSkillsDir, 'beta'), { recursive: true })
    fs.writeFileSync(path.join(targetSkillsDir, 'root-skill.md'), '# root skill\n')
    fs.writeFileSync(path.join(targetSkillsDir, 'alpha', 'SKILL.md'), '---\ndescription: alpha\n---\n')
    fs.writeFileSync(path.join(ancestorSkillsDir, 'beta', 'SKILL.md'), '---\ndescription: beta\n---\n')

    const tools = createRinBuiltinExtensionTools(baseArgs())
    const contextTool = tools.find((tool) => tool.name === 'rin_context')
    const result = await contextTool.execute('tool-context', { path: path.join(workDir, 'file.ts') })
    assert.equal(result.isError, false)

    const details = result.details
    assert.equal(details.directory, workDir)

    assert.equal(details.agentsFiles.some((entry) => entry.path === path.join(workDir, 'AGENTS.md')), false)
    assert.ok(details.agentsFiles.some((entry) => entry.path === path.join(repoDir, 'AGENTS.md')))
    assert.ok(details.agentsFiles.some((entry) => entry.path === path.join(tempRoot, 'AGENTS.md')))

    assert.ok(details.skillRoots.some((entry) => entry.path === targetSkillsDir && entry.scope === 'target'))
    assert.ok(details.skillRoots.some((entry) => entry.path === ancestorSkillsDir && entry.scope === 'ancestor'))

    assert.ok(details.skills.some((entry) => entry.path === path.join(targetSkillsDir, 'root-skill.md') && entry.kind === 'file'))
    assert.ok(details.skills.some((entry) => entry.path === path.join(targetSkillsDir, 'alpha') && entry.kind === 'directory'))
    assert.ok(details.skills.some((entry) => entry.path === path.join(ancestorSkillsDir, 'beta') && entry.kind === 'directory'))
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
  }
})

test('runtime source compiles markdown memory into the system prompt and auto-captures explicit user memory cues', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime.ts'), 'utf8')
  assert.match(source, /compileMemorySync\(/)
  assert.match(source, /judgeMemoryCandidatesWithLlm\(/)
  assert.match(source, /## Resident Memory/)
  assert.match(source, /registerCommand\('init'/)
})

test('builtin extension factory registers migrated Rin tools with memory hooks but without automatic legacy brain hooks', () => {
  const tools = []
  const events = []
  const commands = []
  const factory = createRinBuiltinExtensionFactory({
    repoRoot: '/tmp/rin-repo',
    stateRoot: '/tmp/rin-state',
    brainChatKey: 'local:test',
    getTools: () => createRinBuiltinExtensionTools(baseArgs()),
  })

  factory({
    registerTool(definition) {
      tools.push(definition)
    },
    registerCommand(name, options) {
      commands.push({ name, options })
    },
    sendUserMessage() {},
    on(name, handler) {
      events.push({ name, handler })
    },
  })

  const toolNames = tools.map((tool) => tool.name)
  assert.deepEqual(toolNames.sort(), [
    'rin_context',
    'rin_history',
    'rin_koishi',
    'rin_memory',
    'rin_schedule',
    'rin_skills',
    'rin_subagent',
    'rin_web_search',
  ].sort())

  const eventNames = events.map((event) => event.name)
  assert.ok(eventNames.includes('message_start'))
  assert.equal(eventNames.includes('agent_end'), false)
  assert.ok(commands.some((entry) => entry.name === 'init'))
})

test('migrated rin_schedule tool can use daemon ctl rpc', async () => {
  await withCtlServer(
    async (payload) => {
      assert.equal(payload.op, 'schedule.manage')
      assert.equal(payload.kind, 'timer')
      assert.equal(payload.action, 'list')
      return { ok: true, text: '[]', details: { items: [] } }
    },
    async ({ stateRoot }) => {
      const tools = []
      const factory = createRinBuiltinExtensionFactory({
        repoRoot: '/tmp/rin-repo',
        stateRoot,
        enableBrainHooks: false,
      })
      factory({ registerTool(definition) { tools.push(definition) }, on() {} })
      const scheduleTool = tools.find((tool) => tool.name === 'rin_schedule')
      const result = await scheduleTool.execute('tool-1', { kind: 'timer', action: 'list' })
      assert.equal(result.isError, false)
      assert.equal(result.content[0].text, '[]')
    },
  )
})

test('migrated rin_schedule tool requires daemon without fallback', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-schedule-no-daemon-'))
  try {
    const tools = []
    const factory = createRinBuiltinExtensionFactory({
      repoRoot: '/tmp/rin-repo',
      stateRoot,
      enableBrainHooks: false,
    })
    factory({ registerTool(definition) { tools.push(definition) }, on() {} })
    const scheduleTool = tools.find((tool) => tool.name === 'rin_schedule')
    const result = await scheduleTool.execute('tool-2', { kind: 'timer', action: 'list' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /rin_daemon_required:schedule/)
  } finally {
    try { fs.rmSync(stateRoot, { recursive: true, force: true }) } catch {}
  }
})
