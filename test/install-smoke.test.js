const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  performInstall,
  performUninstall,
  installTargetChoices,
  formatCliErrorMessage,
} = require('../dist/index.js')

function makeBundleFixture(rootDir) {
  fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'install', 'home', 'docs', 'rin'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'tui', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'dist', 'index.js'), '#!/usr/bin/env node\nconsole.log("rin fixture")\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'brain.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'daemon.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'tui.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'tui-debug.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'tui', 'dist', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(rootDir, 'install', 'home', 'docs', 'rin', 'README.md'), '# fixture runtime docs\n')
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'rin-fixture', version: '0.0.0' }, null, 2))
}

test('installTargetChoices hides unsupported user-management options', () => {
  const currentUser = { username: 'demo' }
  assert.deepEqual(
    installTargetChoices(currentUser, { platform: 'darwin', isRoot: false, hasGetent: false, hasUseradd: false }).map((item) => item.value),
    ['current'],
  )
  assert.deepEqual(
    installTargetChoices(currentUser, { platform: 'linux', isRoot: true, hasGetent: true, hasUseradd: false }).map((item) => item.value),
    ['current', 'existing'],
  )
  assert.deepEqual(
    installTargetChoices(currentUser, { platform: 'linux', isRoot: true, hasGetent: true, hasUseradd: true }).map((item) => item.value),
    ['current', 'existing', 'create'],
  )
  assert.deepEqual(
    installTargetChoices(currentUser, { platform: 'linux', isRoot: false, hasGetent: true, hasUseradd: false, dryRun: true }).map((item) => item.value),
    ['current', 'existing', 'create'],
  )
})

test('formatCliErrorMessage turns installer capability errors into guidance', () => {
  assert.match(formatCliErrorMessage(new Error('install_requires_root_to_create_user')), /needs root on Linux/i)
  assert.match(formatCliErrorMessage(new Error('install_existing_user_unsupported')), /only available on Linux root installs/i)
})

test('performInstall creates a portable runtime layout and launcher', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const result = performInstall({
    homeDir,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.equal(result.ok, true)
  assert.equal(result.stateRoot, path.join(homeDir, '.rin'))
  assert.equal(fs.existsSync(path.join(result.stateRoot, 'docs', 'rin', 'README.md')), true)
  assert.equal(fs.existsSync(path.join(result.stateRoot, 'app', 'current', 'dist', 'index.js')), true)
  assert.equal(fs.existsSync(path.join(result.stateRoot, 'app', 'current', 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'index.js')), true)
  assert.equal(fs.existsSync(path.join(result.stateRoot, 'app', 'current', 'third_party', 'pi-mono', 'packages', 'tui', 'dist', 'index.js')), true)
  assert.equal(fs.existsSync(result.launcherPath), true)

  const installMeta = JSON.parse(fs.readFileSync(path.join(result.stateRoot, 'install.json'), 'utf8'))
  assert.equal(installMeta.installSource.repo, 'https://example.com/rin.git')
  assert.equal(installMeta.installSource.ref, 'main')
})

test('performInstall simulates update by replacing the current release and pruning the old one', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-update-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const first = performInstall({
    homeDir,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const second = performInstall({
    homeDir,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'stable',
    releaseId: '2026-03-20T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.equal(second.bundle.releaseId, '2026-03-20T00-00-00-000Z')
  assert.deepEqual(second.bundle.prunedReleaseIds, ['2026-03-19T00-00-00-000Z'])
  assert.equal(fs.existsSync(path.join(first.stateRoot, 'app', 'releases', '2026-03-19T00-00-00-000Z')), false)

  const installMeta = JSON.parse(fs.readFileSync(path.join(second.stateRoot, 'install.json'), 'utf8'))
  assert.equal(installMeta.installSource.ref, 'stable')
})

test('performInstall supports custom runtime roots and launcher export', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-custom-root-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const customStateRoot = path.join(tempRoot, 'runtime-home')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const result = performInstall({
    homeDir,
    stateRoot: customStateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-21T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.equal(result.stateRoot, customStateRoot)
  const launcherText = fs.readFileSync(result.launcherPath, 'utf8')
  assert.match(launcherText, new RegExp(`RIN_HOME=${JSON.stringify(customStateRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('performInstall supports dry-run previews without touching disk', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-dry-run-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(tempRoot, 'state-root')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const result = performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    dryRun: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.stateRoot, stateRoot)
  assert.equal(fs.existsSync(stateRoot), false)
  assert.equal(fs.existsSync(result.launcherPath), false)
  assert.match(result.launcherText, /RIN_HOME=/)
  assert.match(result.plannedChanges.join('\n'), /would create launcher/)
})

test('performUninstall supports keep-state and purge flows', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-uninstall-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const installed = performInstall({
    homeDir,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const keep = performUninstall({ homeDir, mode: 'keep' })

  assert.equal(keep.ok, true)
  assert.equal(fs.existsSync(path.join(installed.stateRoot, 'app')), false)
  assert.equal(fs.existsSync(path.join(installed.stateRoot, 'docs', 'rin', 'README.md')), true)

  performInstall({
    homeDir,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-20T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const purge = performUninstall({ homeDir, mode: 'purge' })
  assert.equal(purge.ok, true)
  assert.equal(fs.existsSync(installed.stateRoot), false)
})
