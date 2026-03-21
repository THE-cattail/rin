const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const {
  createRinBuiltinTools,
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

test('builtin Rin extension tool definitions cover the remaining Pi-facing tools', () => {
  const tools = createRinBuiltinTools(baseArgs())
  const names = tools.map((tool) => tool.name)

  assert.deepEqual(names.sort(), ['rin_history', 'rin_koishi', 'rin_skills', 'rin_subagent'].sort())
})

test('builtin extension factory registers migrated Rin tools and memory hooks', () => {
  const tools = []
  const events = []
  const factory = createRinBuiltinExtensionFactory({
    repoRoot: '/tmp/rin-repo',
    stateRoot: '/tmp/rin-state',
    brainChatKey: 'local:test',
    getAdditionalTools: () => createRinBuiltinTools(baseArgs()),
  })

  factory({
    registerTool(definition) {
      tools.push(definition)
    },
    on(name, handler) {
      events.push({ name, handler })
    },
  })

  const toolNames = tools.map((tool) => tool.name)
  assert.deepEqual(toolNames.sort(), [
    'rin_brain',
    'rin_context',
    'rin_history',
    'rin_koishi',
    'rin_schedule',
    'rin_skills',
    'rin_subagent',
    'rin_web_search',
  ].sort())

  const eventNames = events.map((event) => event.name)
  assert.ok(eventNames.includes('message_start'))
  assert.ok(eventNames.includes('agent_end'))
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
