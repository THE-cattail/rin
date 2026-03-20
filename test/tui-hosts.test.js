const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const tuiPath = path.join(repoRoot, 'dist', 'tui.js')
const nativeTuiPath = path.join(repoRoot, 'dist', 'tui-debug.js')

function runNode(scriptPath, args = [], env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('daemon-backed tui host help works through the vendored upstream path', () => {
  const result = runNode(tuiPath, ['--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /Runs the daemon-backed Rin TUI frontend/i)
  assert.doesNotMatch(output, /Cannot find module|No "exports" main defined|Theme not initialized/i)
})

test('native pi host help works through the vendored upstream path', () => {
  const result = runNode(nativeTuiPath, ['--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /Pi's native InteractiveMode/i)
  assert.doesNotMatch(output, /Cannot find module|No "exports" main defined|Theme not initialized/i)
})
