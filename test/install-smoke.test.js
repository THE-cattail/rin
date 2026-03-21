const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
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
  fs.writeFileSync(path.join(rootDir, 'dist', 'index.js'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    '',
    'function copyTree(src, dst) {',
    '  if (!fs.existsSync(src)) return',
    '  fs.mkdirSync(path.dirname(dst), { recursive: true })',
    '  fs.cpSync(src, dst, { recursive: true, force: true })',
    '}',
    '',
    'const argv = process.argv.slice(2)',
    'if (argv[0] === "__install") {',
    '  let stateRoot = ""',
    '  let sourceRepo = ""',
    '  let sourceRef = ""',
    '  for (let i = 1; i < argv.length; i++) {',
    '    const arg = argv[i]',
    '    if (arg === "--state-root") { stateRoot = argv[i + 1] || ""; i += 1; continue }',
    '    if (arg === "--source-repo") { sourceRepo = argv[i + 1] || ""; i += 1; continue }',
    '    if (arg === "--source-ref") { sourceRef = argv[i + 1] || ""; i += 1; continue }',
    '  }',
    '  if (!stateRoot) throw new Error("missing_state_root")',
    '  const repoRoot = path.resolve(__dirname, "..")',
    '  const currentRoot = path.join(stateRoot, "app", "current")',
    '  copyTree(path.join(repoRoot, "dist"), path.join(currentRoot, "dist"))',
    '  copyTree(path.join(repoRoot, "install"), path.join(currentRoot, "install"))',
    '  copyTree(path.join(repoRoot, "third_party"), path.join(currentRoot, "third_party"))',
    '  fs.mkdirSync(stateRoot, { recursive: true })',
    '  fs.writeFileSync(path.join(stateRoot, "install.json"), JSON.stringify({ installSource: { repo: sourceRepo, ref: sourceRef } }, null, 2))',
    '  process.exit(0)',
    '}',
    '',
    'console.log("rin fixture")',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(rootDir, 'dist', 'brain.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'daemon.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'tui.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'dist', 'tui-debug.js'), 'module.exports = {}\n')
  fs.writeFileSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(rootDir, 'third_party', 'pi-mono', 'packages', 'tui', 'dist', 'index.js'), 'export {}\n')
  fs.writeFileSync(path.join(rootDir, 'install', 'home', 'docs', 'rin', 'README.md'), '# fixture runtime docs\n')
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
    name: 'rin-fixture',
    version: '0.0.0',
    scripts: {
      build: 'node -e ""',
    },
  }, null, 2))
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
  assert.match(formatCliErrorMessage(new Error('local_bundle_root_missing')), /local source tree is required/i)
  assert.match(formatCliErrorMessage(new Error('local_bundle_package_missing:/tmp/demo')), /No Rin package\.json found/i)
  assert.match(formatCliErrorMessage(new Error('install_already_exists:/tmp/rin-home')), /already installed/i)
})

test('install.sh supports local source installation via --local --path', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-sh-local-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const installScript = path.join(__dirname, '..', 'install.sh')
  const result = spawnSync('sh', [installScript, '--local', '--path', bundleRoot, '--current-user', '--state-root', stateRoot], {
    encoding: 'utf8',
    cwd: tempRoot,
    env: { ...process.env, HOME: homeDir },
  })

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`)
  assert.equal(fs.existsSync(path.join(stateRoot, 'app', 'current', 'install', 'home', 'docs', 'rin', 'README.md')), true)
  const installMeta = JSON.parse(fs.readFileSync(path.join(stateRoot, 'install.json'), 'utf8'))
  assert.equal(path.resolve(installMeta.installSource.repo), path.resolve(bundleRoot))
})

test('install.sh refuses to act as update transport', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-sh-refuse-update-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const installScript = path.join(__dirname, '..', 'install.sh')
  const result = spawnSync('sh', [installScript, '--local', '--path', bundleRoot, '--upgrade-existing'], {
    encoding: 'utf8',
    cwd: tempRoot,
    env: { ...process.env, HOME: homeDir },
  })

  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`)
  assert.match(result.stderr, /install\.sh only handles installation/i)
  assert.match(result.stderr, /rin update --local/i)
})

test('performInstall creates a portable runtime layout and launcher', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const result = performInstall({
    homeDir,
    stateRoot,
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

test('installed launcher refuses to self-repair a missing bundle', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-launcher-missing-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const result = performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: bundleRoot,
    sourceRef: 'main',
    releaseId: '2026-03-22T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  fs.rmSync(path.join(result.stateRoot, 'app'), { recursive: true, force: true })

  const launched = spawnSync(result.launcherPath, ['docs'], {
    encoding: 'utf8',
    env: process.env,
  })

  assert.equal(launched.status, 1, `stdout=${launched.stdout}\nstderr=${launched.stderr}`)
  assert.match(launched.stderr, /installed runtime missing/i)
  assert.match(launched.stderr, /automatic self-repair is disabled/i)
  assert.equal(fs.existsSync(path.join(result.stateRoot, 'app', 'current', 'dist', 'index.js')), false)
})

test('performInstall simulates update by replacing the current release and pruning the old one', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-update-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const first = performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const second = performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    allowExistingInstall: true,
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
  assert.match(launcherText, /automatic self-repair is disabled/)
  assert.doesNotMatch(launcherText, /__install --current-user/)
})

test('performInstall refuses to overwrite an active install without the upgrade path', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-guard-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.throws(
    () => performInstall({
      homeDir,
      stateRoot,
      bundleRoot,
      sourceRepo: 'https://example.com/rin.git',
      sourceRef: 'main',
      releaseId: '2026-03-20T00-00-00-000Z',
      seedHomeDir: homeDir,
    }),
    /install_already_exists:/,
  )
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

test('performInstall prunes retired managed docs while preserving user-owned runtime files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-install-managed-prune-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)
  fs.mkdirSync(path.join(bundleRoot, 'install', 'home', 'docs', 'rin', 'examples'), { recursive: true })
  fs.writeFileSync(path.join(bundleRoot, 'install', 'home', 'docs', 'rin', 'examples', 'README.md'), '# old examples\n')

  performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.equal(fs.existsSync(path.join(stateRoot, 'docs', 'rin', 'examples', 'README.md')), true)

  fs.writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ ownerSetting: true }, null, 2))
  fs.writeFileSync(path.join(stateRoot, 'docs', 'rin', 'custom-note.md'), 'keep me\n')
  fs.writeFileSync(path.join(stateRoot, 'data', 'custom.json'), JSON.stringify({ keep: true }, null, 2))

  fs.rmSync(path.join(bundleRoot, 'install', 'home', 'docs', 'rin', 'examples'), { recursive: true, force: true })

  performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    allowExistingInstall: true,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'stable',
    releaseId: '2026-03-20T00-00-00-000Z',
    seedHomeDir: homeDir,
  })

  assert.equal(fs.existsSync(path.join(stateRoot, 'docs', 'rin', 'examples')), false)
  assert.equal(fs.existsSync(path.join(stateRoot, 'docs', 'rin', 'custom-note.md')), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, 'settings.json'), 'utf8')).ownerSetting, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateRoot, 'data', 'custom.json'), 'utf8')), { keep: true })
})

test('performUninstall supports keep-state and purge flows', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-uninstall-smoke-'))
  const bundleRoot = path.join(tempRoot, 'bundle')
  const homeDir = path.join(tempRoot, 'home')
  const stateRoot = path.join(homeDir, '.rin')
  fs.mkdirSync(homeDir, { recursive: true })
  makeBundleFixture(bundleRoot)

  const installed = performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-19T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const keep = performUninstall({ homeDir, stateRoot, mode: 'keep' })

  assert.equal(keep.ok, true)
  assert.equal(fs.existsSync(path.join(installed.stateRoot, 'app')), false)
  assert.equal(fs.existsSync(path.join(installed.stateRoot, 'docs', 'rin', 'README.md')), true)

  performInstall({
    homeDir,
    stateRoot,
    bundleRoot,
    sourceRepo: 'https://example.com/rin.git',
    sourceRef: 'main',
    releaseId: '2026-03-20T00-00-00-000Z',
    seedHomeDir: homeDir,
  })
  const purge = performUninstall({ homeDir, stateRoot, mode: 'purge' })
  assert.equal(purge.ok, true)
  assert.equal(fs.existsSync(installed.stateRoot), false)
})
