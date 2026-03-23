const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('koishi bridge routes slash commands through the shared daemon session command surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.ts'), 'utf8')

  assert.match(source, /import \{ BUILTIN_SLASH_COMMANDS \}/)
  assert.match(source, /async function runBridgeSlashCommand\(/)
  assert.match(source, /async function handleNew\(/)
  assert.match(source, /function pickUserId\(/)
  assert.match(source, /function getActiveProcessingTurn\(/)
  assert.match(source, /function reconcilePiSessionFile\(/)
  assert.match(source, /function normalizeBridgeAssistantText\(/)
  assert.match(source, /sendTextToChatKey/)
  assert.match(source, /await maybeHandleBridgeSlashCommand\(session\)/)
  assert.match(source, /async function runKoishiRegisteredBridgeCommand\(/)
  assert.match(source, /async function syncKoishiBridgeCommands\(/)
  assert.match(source, /ctx\.command\(`\$\{name\} \[args:text\]`, description, \{ slash: true \}\)/)
  assert.match(source, /action\(async \(\{ session \}: any, argsText: any\) => await runKoishiRegisteredBridgeCommand\(session, name, argsText\)\)/)
  assert.match(source, /await ctx\.\$commander\.updateCommands\(bot\)/)
  assert.doesNotMatch(source, /ctx\.command\('help'/)
  assert.doesNotMatch(source, /ctx\.command\('status'/)
  assert.doesNotMatch(source, /ctx\.command\('reset'/)
  assert.doesNotMatch(source, /ctx\.command\('restart'/)
})

test('daemon tui rpc exposes builtin slash commands from the upstream command surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon-tui-rpc.ts'), 'utf8')

  assert.match(source, /import \{ BUILTIN_SLASH_COMMANDS \}/)
  assert.match(source, /for \(const item of Array\.isArray\(BUILTIN_SLASH_COMMANDS\) \? BUILTIN_SLASH_COMMANDS : \[\]\)/)
  assert.match(source, /source: 'builtin'/)
})

test('chat session state no longer treats \/reset as a privileged special case', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-session-state.ts'), 'utf8')

  assert.doesNotMatch(source, /slash === '\/reset'/)
  assert.ok(source.includes("if (isPrivilegedCommand) {\n    return { shouldActivate: false }\n  }"))
})

test('unknown slash text is no longer corrected and bridge permissions default to owner-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.ts'), 'utf8')

  assert.match(source, /const TRUSTED_BRIDGE_COMMANDS = new Set\(\['new'\]\)/)
  assert.match(source, /if \(nextTrust === 'OWNER'\) return true/)
  assert.match(source, /if \(nextTrust === 'TRUSTED'\) return TRUSTED_BRIDGE_COMMANDS\.has\(nextName\)/)
  assert.match(source, /if \(!resolved\.known \|\| !resolved\.invocation\) return false/)
  assert.doesNotMatch(source, /Unknown command: \/\$\{commandName\}/)
})

test('bridge restart recovery auto-enqueues a synthetic resume turn again', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.ts'), 'utf8')

  assert.match(source, /async function enqueueRestartResumeIntent\(/)
  assert.match(source, /system: 'daemon_restart_resume'/)
  assert.match(source, /scheduleActivation\(nextChatKey/)
  assert.match(source, /startup: restart resume enqueued/)
  assert.match(source, /boot catch-up chatKeys=/)
})
