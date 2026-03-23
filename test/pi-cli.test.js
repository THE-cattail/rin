const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'dist', 'index.js')

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, RIN_HOME: '', RIN_REPO_ROOT: '', ...env },
  })
}

test('top-level help advertises rin offline as the local TUI entry', () => {
  const result = runCli(['--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /rin offline/)
  assert.match(output, /`rin` starts the daemon-backed Rin TUI frontend/i)
  assert.match(output, /`rin offline` starts the local offline TUI/i)
  assert.match(output, /rin \[-u <user>] \[--tmux/i)
  assert.match(output, /--tmux-list/)
  assert.match(output, /dedicated tmux socket file/i)
  assert.doesNotMatch(output, /rin pi/)
})

test('tmux session listing does not fall through into the TUI', () => {
  const tempHome = path.join(repoRoot, 'tmp', `pi-cli-tmux-list-${Date.now()}`)
  const runtimeDist = path.join(tempHome, '.rin', 'app', 'current', 'dist')
  const fakeTmuxDir = path.join(tempHome, 'bin')
  const fakeTmuxPath = path.join(fakeTmuxDir, 'tmux')

  require('node:fs').mkdirSync(runtimeDist, { recursive: true })
  require('node:fs').mkdirSync(fakeTmuxDir, { recursive: true })
  require('node:fs').writeFileSync(path.join(runtimeDist, 'index.js'), 'process.exit(0)\n')
  require('node:fs').writeFileSync(fakeTmuxPath, '#!/bin/sh\nprintf "%s\\n" alpha beta\n')
  require('node:fs').chmodSync(fakeTmuxPath, 0o755)

  const result = runCli(['--tmux-list'], {
    HOME: tempHome,
    USER: '',
    LOGNAME: '',
    PATH: `${fakeTmuxDir}:${process.env.PATH || ''}`,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /^alpha\nbeta$/m)
  assert.doesNotMatch(output, /not installed for the current user/i)
})

test('offline subcommand reaches the local interactive host help', () => {
  const result = runCli(['offline', '--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /Usage:\s*\n\s*rin offline \[--session <path>\]/)
  assert.match(output, /Pi's native InteractiveMode host/i)
  assert.match(output, /without the daemon/i)
  assert.doesNotMatch(output, /Unknown arg: offline/)
})

test('legacy rin pi is rejected and no longer advertised', () => {
  const result = runCli(['pi', '--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.notEqual(result.status, 0)
  assert.match(output, /Unknown arg: pi/)
  assert.doesNotMatch(output, /rin pi \[--session <path>\]/)
})

test('install parser rejects conflicting target selectors', () => {
  const result = runCli(['install', '--current-user', '--user', 'alice', '--dry-run'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.notEqual(result.status, 0)
  assert.match(output, /--current-user' cannot be used with option '--user <name>'/)
})

test('uninstall parser rejects conflicting removal modes', () => {
  const result = runCli(['uninstall', '--yes', '--keep-state', '--purge'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.notEqual(result.status, 0)
  assert.match(output, /--keep-state' cannot be used with option '--purge'/)
})

test('default rin use is unavailable when the current user has no local runtime', () => {
  const tempHome = path.join(repoRoot, 'tmp', `pi-cli-no-runtime-${Date.now()}`)
  const result = runCli([], { HOME: tempHome, USER: 'nobody', LOGNAME: 'nobody' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.notEqual(result.status, 0)
  assert.match(output, /not installed for the current user/i)
  assert.match(output, /rin -u <user>/i)
})
