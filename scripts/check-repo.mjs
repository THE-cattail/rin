#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(message) {
  failures.push(message)
}

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function requireText(relPath) {
  const abs = path.join(repoRoot, relPath)
  if (!fs.existsSync(abs)) {
    fail(`missing file: ${relPath}`)
    return ''
  }
  return readText(relPath)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

const packageJson = JSON.parse(requireText('package.json') || '{}')
assert(Boolean(packageJson.name), 'package.json: name is required')
assert(Boolean(packageJson.description), 'package.json: description is required')
assert(Boolean(packageJson.license), 'package.json: license is required')
assert(Boolean(packageJson.homepage), 'package.json: homepage is required')
assert(Boolean(packageJson.repository && packageJson.repository.url), 'package.json: repository.url is required')
assert(Boolean(packageJson.bugs && packageJson.bugs.url), 'package.json: bugs.url is required')
assert(Boolean(packageJson.engines && packageJson.engines.node), 'package.json: engines.node is required')
assert(packageJson.private !== true, 'package.json: private must not be true for the public repo')
assert(Boolean(packageJson.scripts && packageJson.scripts.build), 'package.json: scripts.build is required')
assert(Boolean(packageJson.scripts && packageJson.scripts.test), 'package.json: scripts.test is required')
assert(Boolean(packageJson.scripts && packageJson.scripts.check), 'package.json: scripts.check is required')
assert(Boolean(packageJson.scripts && packageJson.scripts['test:repo']), 'package.json: scripts.test:repo is required')

const readmes = [
  'README.md',
  'README.zh-CN.md',
  'README.ja.md',
]
const readmeTexts = Object.fromEntries(readmes.map((file) => [file, requireText(file)]))
for (const [file, text] of Object.entries(readmeTexts)) {
  assert(/\[English\]\(README\.md\) \| \[简体中文\]\(README\.zh-CN\.md\) \| \[日本語\]\(README\.ja\.md\)/.test(text), `${file}: missing language navigation header`)
  assert(text.includes('`rin`'), `${file}: missing public command \`rin\``)
  assert(text.includes('`rin restart`'), `${file}: missing public command \`rin restart\``)
  assert(text.includes('`rin update`'), `${file}: missing public command \`rin update\``)
  assert(text.includes('`rin uninstall'), `${file}: missing public command family \`rin uninstall ...\``)
}
assert(readmeTexts['README.md'].includes('Compared with other agent products'), 'README.md: missing positioning/comparison section')

const contributing = requireText('CONTRIBUTING.md')
assert(contributing.includes('CODE_STYLE.md'), 'CONTRIBUTING.md: should link to CODE_STYLE.md')
assert(contributing.includes('npm run check'), 'CONTRIBUTING.md: should mention npm run check')

const trackedFiles = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split(/\r?\n/g)
  .filter(Boolean)

const textFilePattern = /\.(md|ts|js|mjs|json|sh|ya?ml|txt)$/i
const forbiddenPatterns = [
  { label: 'hard-coded /home path', pattern: /(^|[\s"'`(])\/home\/[A-Za-z0-9_.-]+\//gm },
  { label: 'hard-coded /Users path', pattern: /(^|[\s"'`(])\/Users\/[A-Za-z0-9_.-]+\//gm },
  { label: 'hard-coded Windows user profile path', pattern: /(^|[\s"'`(])[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/gm },
  { label: 'accidental test.only', pattern: /\b(test|describe|it)\.only\s*\(/gm },
]

for (const relPath of trackedFiles) {
  if (!textFilePattern.test(relPath)) continue
  const absPath = path.join(repoRoot, relPath)
  let text = ''
  try {
    text = fs.readFileSync(absPath, 'utf8')
  } catch {
    continue
  }
  for (const entry of forbiddenPatterns) {
    const matches = text.match(entry.pattern)
    if (matches && matches.length > 0) {
      fail(`${relPath}: found ${entry.label}`)
    }
  }
}

try {
  execFileSync('npm', ['pack', '--dry-run'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : ''
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : ''
  fail(`npm pack --dry-run failed: ${(stderr || stdout).trim() || 'unknown error'}`)
}

if (failures.length > 0) {
  console.error('Repository checks failed:')
  for (const message of failures) console.error(`- ${message}`)
  process.exit(1)
}

console.log('Repository checks passed.')
