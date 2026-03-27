const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRinPiSession } = require('../dist/runtime.js')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

test('print final Rin system prompt for a real session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-system-prompt-'))
  const repoRoot = path.join(root, 'repo')
  const workspaceRoot = path.join(root, 'workspace')
  const sessionCwd = workspaceRoot
  const resourceCwd = workspaceRoot
  const settingsCwd = workspaceRoot

  ensureDir(repoRoot)
  ensureDir(workspaceRoot)

  const created = await createRinPiSession({
    repoRoot,
    workspaceRoot,
    sessionCwd,
    resourceCwd,
    settingsCwd,
    inMemorySession: true,
    sessionPolicy: 'new',
    systemPromptExtra: '',
    enableBrainHooks: false,
    enableMemoryHooks: false,
  })

  const prompt = String(
    (created && created.session && created.session.agent && created.session.agent.state && created.session.agent.state.systemPrompt)
      || ''
  )

  console.log('\n===== FINAL SYSTEM PROMPT START =====\n')
  console.log(prompt)
  console.log('\n===== FINAL SYSTEM PROMPT END =====\n')

  assert.match(prompt, /independent identity and the freedom to think for yourself/)
  assert.match(prompt, /Your default personality and tone is concise, direct, and friendly\./)
  assert.doesNotMatch(prompt, /Be natural, like we're just chatting in an app\./)

  try {
    if (created && created.session && typeof created.session.shutdown === 'function') {
      await created.session.shutdown()
    }
  } catch {}

  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
})
