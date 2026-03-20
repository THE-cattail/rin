const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  acquireExclusiveFileLock,
  lockFilePathForKey,
  lockRootDir,
  readJson,
  resolveRinHomeRoot,
  resolveRinLayout,
  writeJsonAtomic,
} = require('../dist/runtime-paths.js')

function withEnv(overrides, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('lockRootDir respects override precedence', () => {
  const expected = path.resolve('/tmp/rin-locks')
  const result = withEnv({
    RIN_LOCK_DIR: '/tmp/rin-locks',
    XDG_RUNTIME_DIR: '/tmp/runtime',
    XDG_CACHE_HOME: '/tmp/cache',
  }, () => lockRootDir())

  assert.equal(result, expected)
})

test('lockRootDir falls back through XDG directories', () => {
  const runtimeResult = withEnv({
    RIN_LOCK_DIR: null,
    XDG_RUNTIME_DIR: '/tmp/runtime-a',
    XDG_CACHE_HOME: '/tmp/cache-a',
  }, () => lockRootDir())
  assert.equal(runtimeResult, path.join('/tmp/runtime-a', 'rin'))

  const cacheResult = withEnv({
    RIN_LOCK_DIR: null,
    XDG_RUNTIME_DIR: '',
    XDG_CACHE_HOME: '/tmp/cache-b',
  }, () => lockRootDir())
  assert.equal(cacheResult, path.join('/tmp/cache-b', 'rin'))
})

test('lockFilePathForKey hashes the key under the lock root', () => {
  const result = withEnv({ RIN_LOCK_DIR: '/tmp/rin-lock-root' }, () => lockFilePathForKey('chat:key'))
  const expectedHash = crypto.createHash('sha256').update('chat:key').digest('hex')
  assert.equal(result, path.join(path.resolve('/tmp/rin-lock-root'), 'locks', `${expectedHash}.lock`))
})

test('resolveRinLayout prefers sourceHint over repo override', () => {
  const layout = withEnv({ RIN_REPO_ROOT: '/tmp/from-env', RIN_HOME: null, RIN_STATE_ROOT: null }, () => resolveRinLayout({ sourceHint: '/tmp/from-arg' }))
  assert.equal(layout.repoRoot, path.resolve('/tmp/from-arg'))
  assert.equal(layout.homeRoot, path.join(os.homedir(), '.rin'))
  assert.equal(layout.dataDir, path.join(layout.homeRoot, 'data'))
  assert.equal(layout.localeDir, path.join(layout.homeRoot, 'locale'))
  assert.equal(layout.routinesDir, path.join(layout.homeRoot, 'routines'))
  assert.equal(layout.kbDir, path.join(layout.homeRoot, 'kb'))
})

test('resolveRinLayout respects RIN_HOME override', () => {
  const layout = withEnv({ RIN_HOME: '~/custom-rin-home', RIN_STATE_ROOT: null }, () => resolveRinLayout())
  assert.equal(layout.homeRoot, path.join(os.homedir(), 'custom-rin-home'))
  assert.equal(layout.dataDir, path.join(layout.homeRoot, 'data'))
})

test('resolveRinHomeRoot expands against the provided home directory', () => {
  const root = withEnv({ RIN_HOME: '~/custom-rin-home' }, () => resolveRinHomeRoot('/tmp/rin-user-home'))
  assert.equal(root, path.resolve('/tmp/rin-user-home/custom-rin-home'))
})

test('readJson returns fallback for invalid files and writeJsonAtomic writes valid json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-runtime-paths-'))
  const jsonPath = path.join(tempDir, 'state', 'config.json')
  const invalidPath = path.join(tempDir, 'state', 'broken.json')
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true })
  fs.writeFileSync(invalidPath, '{broken', 'utf8')

  writeJsonAtomic(jsonPath, { ok: true }, { chmod0600: true })

  assert.deepEqual(readJson(jsonPath, {}), { ok: true })
  assert.deepEqual(readJson(invalidPath, { ok: false }), { ok: false })
  assert.equal(fs.statSync(jsonPath).mode & 0o777, 0o600)
})

test('acquireExclusiveFileLock enforces exclusivity and cleans up on release', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-lock-test-'))
  const lockPath = path.join(tempDir, 'exclusive.lock')
  const release = await acquireExclusiveFileLock(lockPath, { quiet: true })

  await assert.rejects(
    () => acquireExclusiveFileLock(lockPath, { quiet: true, noWait: true }),
    (error) => error && error.code === 'LOCK_BUSY',
  )

  assert.equal(fs.existsSync(lockPath), true)
  release()
  assert.equal(fs.existsSync(lockPath), false)
})
