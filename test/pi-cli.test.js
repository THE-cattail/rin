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
    env: { ...process.env, ...env },
  })
}

test('top-level help advertises rin pi instead of rin debug', () => {
  const result = runCli(['--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /rin pi/)
  assert.doesNotMatch(output, /rin debug/)
})

test('pi subcommand reaches the native interactive-mode host help', () => {
  const result = runCli(['pi', '--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /Usage:\s*\n\s*rin pi \[--session <path>\]/)
  assert.match(output, /Pi's native InteractiveMode/i)
  assert.doesNotMatch(output, /Unknown arg: pi/)
})

test('pi subcommand help still works through the vendored upstream path', () => {
  const result = runCli(['pi', '--help'])
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  assert.equal(result.status, 0)
  assert.match(output, /Usage:\s*\n\s*rin pi \[--session <path>\]/)
  assert.match(output, /Pi's native InteractiveMode/i)
  assert.doesNotMatch(output, /Unknown arg: pi/)
})
