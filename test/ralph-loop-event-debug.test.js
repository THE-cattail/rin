const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runPiSdkTurn } = require('../dist/runtime.js')

test('debug event flow for a tiny prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-event-debug-'))
  const events = []
  const result = await runPiSdkTurn({
    repoRoot: path.join(root, 'repo'),
    workspaceRoot: path.join(os.homedir(), '.rin'),
    sessionDir: path.join(os.homedir(), '.rin', 'sessions'),
    inputItems: [{ type: 'text', text: '2+2 等于 4 吗？只回答是或不是。' }],
    timeoutMs: 120000,
    provider: 'openai-codex',
    model: 'gpt-5.4',
    thinking: 'minimal',
    onEvent: (event) => {
      events.push({
        type: event && event.type,
        role: event && event.message && event.message.role,
        assistantMessageEventType: event && event.assistantMessageEvent && event.assistantMessageEvent.type,
      })
    },
  })

  console.log('\n===== EVENT DEBUG START =====\n')
  console.log(JSON.stringify({ result, events }, null, 2))
  console.log('\n===== EVENT DEBUG END =====\n')
})
