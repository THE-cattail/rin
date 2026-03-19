#!/usr/bin/env node
// @ts-nocheck
/* eslint-disable no-console */

import {
  ensureDir,
  readJson,
  writeJsonAtomic as sharedWriteJsonAtomic,
  safeString,
  isPidAlive,
  lockRootDir,
  lockFilePathForKey,
  acquireExclusiveFileLock,
  resolveRinLayout,
} from './runtime-paths'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const readline = require('node:readline/promises')

function repoRootFromEntry() {
  return path.resolve(__dirname, '..')
}

let cachedLayout = null

function layout() {
  if (!cachedLayout) cachedLayout = resolveRinLayout({ sourceHint: repoRootFromEntry() })
  return cachedLayout
}

function rootDir() {
  return layout().homeRoot
}

function repoDir() {
  return layout().repoRoot
}

function installHomeAssetDir(bundleRoot = '') {
  const root = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  return path.join(root, 'install', 'home')
}

function isPathInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

function writeJsonAtomic(filePath, obj) {
  sharedWriteJsonAtomic(filePath, obj, { chmod0600: true })
}

function copyFileIfMissing(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (fs.existsSync(dst)) return false
  fs.copyFileSync(src, dst)
  return true
}

function copyTreeIfPresent(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
  return true
}

function writeTextIfMissing(filePath, text) {
  ensureDir(path.dirname(filePath))
  if (fs.existsSync(filePath)) return false
  fs.writeFileSync(filePath, text, 'utf8')
  return true
}

function syncFile(src, dst, { overwrite = false } = {}) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (!overwrite && fs.existsSync(dst)) return false
  fs.copyFileSync(src, dst)
  return true
}

function syncTree(src, dst, { overwrite = false } = {}) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (overwrite && fs.existsSync(dst)) {
    try { fs.rmSync(dst, { recursive: true, force: true }) } catch {}
  }
  fs.cpSync(src, dst, { recursive: true, force: overwrite, errorOnExist: false })
  return true
}

function normalizeGitUrl(value) {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (/^git@github\.com:/.test(raw)) return `https://github.com/${raw.slice('git@github.com:'.length)}`
  return raw
}

function gitOutput(args, cwd = repoRootFromEntry()) {
  try {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.status !== 0) return ''
    return safeString(out.stdout).trim()
  } catch {
    return ''
  }
}

function detectInstallSourceRepo(fallback = DEFAULT_INSTALL_SOURCE_REPO) {
  return normalizeGitUrl(gitOutput(['remote', 'get-url', 'origin']) || fallback)
}

function detectInstallSourceRef(fallback = DEFAULT_INSTALL_SOURCE_REF) {
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch && branch !== 'HEAD') return branch
  return gitOutput(['rev-parse', 'HEAD']) || fallback
}

function npmInstallArgsFor(dir) {
  const useCi = fs.existsSync(path.join(dir, 'package-lock.json'))
  return useCi
    ? ['ci', '--no-fund', '--no-audit']
    : ['install', '--no-fund', '--no-audit']
}

const INTERNAL_SKILL_NAMES = new Set([
  'brain',
  'memory',
  'rin-daemon',
  'rin-koishi',
  'rin-schedule',
  'rin-send',
  'rin-identity',
  'web-search',
])

const DEFAULT_INSTALL_SOURCE_REPO = 'https://github.com/THE-cattail/rin.git'
const DEFAULT_INSTALL_SOURCE_REF = 'main'
const DEFAULT_RUNTIME_AGENTS_MD = [
  '# AGENTS.md',
  '',
  '## Runtime Notes',
  '',
  '- This file defines the local prompt and rule layers for this Rin installation.',
  '- Use it to store private preferences, identity rules, and runtime-only instructions.',
  '- This file resides in the local runtime state and is excluded from the public source tree.',
  '',
].join('\n')

function ensureWorkspaceBaseline(home, { overwriteManaged = false, bundleRoot = '' } = {}) {
  const repo = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  const assetRoot = installHomeAssetDir(repo)
  const createdDirs = []
  const copied = []
  const written = []
  const cleaned = []

  const ensureWorkspaceDir = (rel) => {
    const abs = path.join(home, rel)
    const existed = fs.existsSync(abs)
    ensureDir(abs)
    if (!existed) createdDirs.push(rel)
  }

  const removeIfPresent = (rel) => {
    const abs = path.join(home, rel)
    if (!fs.existsSync(abs)) return
    fs.rmSync(abs, { recursive: true, force: true })
    cleaned.push(rel)
  }

  const migrateFirstIfMissing = (sources, dstRel) => {
    const dst = path.join(home, dstRel)
    if (fs.existsSync(dst)) return false
    for (const srcRel of sources) {
      const src = path.join(home, srcRel)
      if (copyFileIfMissing(src, dst)) {
        copied.push(dstRel)
        return true
      }
    }
    return false
  }

  ;[
    'data',
    'docs',
    'docs/rin',
    'skills',
  ].forEach(ensureWorkspaceDir)

  if (writeTextIfMissing(path.join(home, 'AGENTS.md'), DEFAULT_RUNTIME_AGENTS_MD)) written.push('AGENTS.md')

  if (syncTree(path.join(assetRoot, 'docs', 'rin'), path.join(home, 'docs', 'rin'), { overwrite: overwriteManaged })) {
    copied.push('docs/rin')
  }

  ;[
    'GUARDIAN.md',
    'README.md',
    'docs/pi',
    'handbooks',
    'data/identity.example.json',
    'data/schedules.example.json',
    'data/rin/identity.example.json',
    'data/rin/schedules.example.json',
    'data/koishi.generated.yml',
    'data/.generated',
    'bin/rin',
    'kb/README.md',
    'kb/vault/README.md',
    'memory/README.md',
    'routines/README.md',
    'locale/en-US.default.json',
    'skills/web-search',
  ].forEach(removeIfPresent)

  return {
    workspace: home,
    repoRoot: repo,
    createdDirs,
    copied,
    written,
    cleaned,
  }
}

function findExecutableOnPath(name) {
  const raw = safeString(process.env.PATH)
  const parts = raw ? raw.split(path.delimiter) : []
  for (const dir of parts) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return ''
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2))
}

function expandHome(value) {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function stockPiAgentDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.pi', 'agent')
}

function piAgentDir() {
  return rootDir()
}

function syncPiSettings(agentDir) {
  ensureDir(agentDir)
  const settingsPath = path.join(agentDir, 'settings.json')
  const current = readJson(settingsPath, {})
  const next = current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {}

  if (next.enableSkillCommands == null) next.enableSkillCommands = true

  const repoExtensionDir = path.join(repoDir(), 'pi', 'extensions')
  const currentExtensions = Array.isArray(next.extensions) ? next.extensions.map((v) => safeString(v).trim()).filter(Boolean) : []
  const filteredExtensions = currentExtensions.filter((entry) => path.resolve(entry) !== path.resolve(repoExtensionDir))
  if (filteredExtensions.length > 0) next.extensions = filteredExtensions
  else delete next.extensions

  writeJsonAtomic(settingsPath, next)
  return { ok: true, settingsPath }
}

function seedPiAgentDirFromStock(agentDir, { homeDir = os.homedir() } = {}) {
  const stockDir = stockPiAgentDir(homeDir)
  if (!stockDir || path.resolve(stockDir) === path.resolve(agentDir) || !fs.existsSync(stockDir)) {
    return { ok: false, reason: 'stock_profile_missing' }
  }
  const copied = []
  for (const name of ['auth.json', 'settings.json', 'models.json']) {
    if (copyFileIfMissing(path.join(stockDir, name), path.join(agentDir, name))) copied.push(name)
  }
  return { ok: copied.length > 0, copied }
}

function ensurePiBootstrapAt({ agentDir, stateRoot = rootDir(), homeDir = os.homedir() } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || piAgentDir())
  ensureDir(resolvedAgentDir)
  const seeded = seedPiAgentDirFromStock(resolvedAgentDir, { homeDir })
  const settings = syncPiSettings(resolvedAgentDir)
  return { agentDir: resolvedAgentDir, seeded, settings }
}

function ensurePiBootstrap() {
  return ensurePiBootstrapAt({ agentDir: piAgentDir(), stateRoot: rootDir(), homeDir: os.homedir() })
}

function rinAppDir() {
  return repoDir()
}

function rinDistPath(rel = 'index.js') {
  return path.join(rinAppDir(), 'dist', rel)
}

function ensureRinDistFile(rel) {
  const filePath = rinDistPath(rel)
  if (!fs.existsSync(filePath)) throw new Error(`rin_dist_missing:${rel}`)
  return filePath
}

function ensureRinTuiHost() {
  return ensureRinDistFile('tui.js')
}

function installStateRootForHome(homeDir) {
  return path.join(path.resolve(homeDir), '.rin')
}

function lookupUserRecord(username) {
  const name = safeString(username).trim()
  if (!name) return null
  const out = spawnSync('getent', ['passwd', name], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const line = safeString(out.stdout).trim().split('\n').filter(Boolean)[0] || ''
  const parts = line.split(':')
  if (parts.length < 7) return null
  const uid = Number(parts[2])
  const gid = Number(parts[3])
  const homeDir = parts[5] || ''
  return {
    username: parts[0],
    uid: Number.isFinite(uid) ? uid : -1,
    gid: Number.isFinite(gid) ? gid : -1,
    homeDir,
    shell: parts[6] || '',
  }
}

function currentUserRecord() {
  const username = safeString(process.env.USER || process.env.LOGNAME).trim()
  const fromGetent = username ? lookupUserRecord(username) : null
  if (fromGetent) return fromGetent
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const gid = typeof process.getgid === 'function' ? process.getgid() : -1
  return {
    username: username || 'unknown',
    uid,
    gid,
    homeDir: os.homedir(),
    shell: process.env.SHELL || '/bin/bash',
  }
}

function chownRecursiveIfPossible(targetPath, uid, gid) {
  if (!fs.existsSync(targetPath)) return
  if (!Number.isFinite(Number(uid)) || !Number.isFinite(Number(gid))) return
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  const entries = [targetPath]
  while (entries.length) {
    const current = entries.pop()
    try { fs.chownSync(current, uid, gid) } catch {}
    let st = null
    try { st = fs.lstatSync(current) } catch {}
    if (!st || !st.isDirectory()) continue
    let names = []
    try { names = fs.readdirSync(current) } catch {}
    for (const name of names) entries.push(path.join(current, name))
  }
}

function ensureInstallableBundle(bundleRoot = '') {
  const root = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  for (const rel of ['dist/index.js', 'dist/brain.js', 'dist/daemon.js', 'dist/tui.js']) {
    const filePath = path.join(root, rel)
    if (!fs.existsSync(filePath)) throw new Error(`rin_dist_missing:${rel.replace(/^dist\//, '')}`)
  }
}

function copyInstallBundleTree(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  fs.cpSync(src, dst, { recursive: true, force: true })
  return true
}

function pruneOldRuntimeReleases(stateRoot, keepReleaseIds = []) {
  const releasesRoot = path.join(stateRoot, 'app', 'releases')
  if (!fs.existsSync(releasesRoot)) return []
  const keep = new Set((Array.isArray(keepReleaseIds) ? keepReleaseIds : []).map((v) => safeString(v).trim()).filter(Boolean))
  const names = fs.readdirSync(releasesRoot).filter((name) => {
    const abs = path.join(releasesRoot, name)
    try { return fs.statSync(abs).isDirectory() } catch { return false }
  }).sort()
  const removed = []
  for (const name of names) {
    if (keep.has(name)) continue
    try {
      fs.rmSync(path.join(releasesRoot, name), { recursive: true, force: true })
      removed.push(name)
    } catch {}
  }
  return removed
}

function installRuntimeBundle(stateRoot, { bundleRoot = '', releaseId = '' } = {}) {
  const repo = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  ensureInstallableBundle(repo)
  const nextReleaseId = safeString(releaseId).trim() || new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  const releasesRoot = path.join(stateRoot, 'app', 'releases')
  const releaseRoot = path.join(releasesRoot, nextReleaseId)
  ensureDir(releaseRoot)

  for (const rel of ['package.json', 'package-lock.json']) {
    const src = path.join(repo, rel)
    if (fs.existsSync(src)) syncFile(src, path.join(releaseRoot, rel), { overwrite: true })
  }
  copyInstallBundleTree(path.join(repo, 'dist'), path.join(releaseRoot, 'dist'))
  if (fs.existsSync(path.join(repo, 'node_modules'))) {
    copyInstallBundleTree(path.join(repo, 'node_modules'), path.join(releaseRoot, 'node_modules'))
  }
  copyInstallBundleTree(path.join(repo, 'install'), path.join(releaseRoot, 'install'))
  try { fs.chmodSync(path.join(releaseRoot, 'dist', 'index.js'), 0o755) } catch {}

  const currentLink = path.join(stateRoot, 'app', 'current')
  try { fs.rmSync(currentLink, { force: true, recursive: true }) } catch {}
  try {
    fs.symlinkSync(path.relative(path.dirname(currentLink), releaseRoot), currentLink, 'dir')
  } catch {
    copyInstallBundleTree(releaseRoot, currentLink)
  }

  const prunedReleaseIds = pruneOldRuntimeReleases(stateRoot, [nextReleaseId])
  return { releaseId: nextReleaseId, releaseRoot, currentRoot: currentLink, prunedReleaseIds }
}

function createInstalledLauncher({ stateRoot, userHome }) {
  const localBinDir = path.join(userHome, '.local', 'bin')
  ensureDir(localBinDir)
  const launcherPath = path.join(localBinDir, 'rin')
  const targetPath = path.join(stateRoot, 'app', 'current', 'dist', 'index.js')
  try { fs.rmSync(launcherPath, { force: true }) } catch {}
  try {
    fs.symlinkSync(targetPath, launcherPath)
  } catch {
    fs.copyFileSync(targetPath, launcherPath)
  }
  try { fs.chmodSync(targetPath, 0o755) } catch {}
  try { fs.chmodSync(launcherPath, 0o755) } catch {}
  return launcherPath
}

function writeInstallMetadata(stateRoot, data) {
  const file = path.join(stateRoot, 'install.json')
  writeJsonAtomic(file, data)
  return file
}

function performInstall({
  targetUser,
  homeDir,
  overwriteManaged = true,
  sourceRepo = '',
  sourceRef = '',
  bundleRoot = '',
  releaseId = '',
  seedHomeDir = '',
} = {}) {
  const userHome = path.resolve(homeDir)
  const stateRoot = installStateRootForHome(userHome)
  const resolvedBundleRoot = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  ensureDir(stateRoot)
  const baseline = ensureWorkspaceBaseline(stateRoot, { overwriteManaged, bundleRoot: resolvedBundleRoot })
  const bundle = installRuntimeBundle(stateRoot, { bundleRoot: resolvedBundleRoot, releaseId })
  const bootstrap = ensurePiBootstrapAt({ agentDir: stateRoot, stateRoot, homeDir: path.resolve(seedHomeDir || userHome) })
  const launcherPath = createInstalledLauncher({ stateRoot, userHome })
  const metadataPath = writeInstallMetadata(stateRoot, {
    installedAt: new Date().toISOString(),
    stateRoot,
    appRoot: bundle.currentRoot,
    launcherPath,
    targetUser: targetUser && targetUser.username ? targetUser.username : safeString(process.env.USER || ''),
    installSource: {
      repo: safeString(sourceRepo).trim(),
      ref: safeString(sourceRef).trim(),
    },
  })
  if (targetUser) {
    chownRecursiveIfPossible(stateRoot, targetUser.uid, targetUser.gid)
    chownRecursiveIfPossible(path.join(userHome, '.local'), targetUser.uid, targetUser.gid)
  }
  return {
    ok: true,
    stateRoot,
    launcherPath,
    baseline,
    bundle,
    bootstrap,
    metadataPath,
  }
}

function performUninstall({ homeDir = os.homedir(), mode = 'keep' } = {}) {
  const userHome = path.resolve(homeDir)
  const stateRoot = installStateRootForHome(userHome)
  const launcherPath = path.join(userHome, '.local', 'bin', 'rin')

  try { fs.rmSync(launcherPath, { force: true }) } catch {}

  const removed = []
  if (mode === 'purge') {
    if (fs.existsSync(stateRoot)) {
      try { fs.rmSync(stateRoot, { recursive: true, force: true }) } catch {}
      removed.push(stateRoot)
    }
  } else {
    for (const rel of ['app', 'install.json']) {
      const target = path.join(stateRoot, rel)
      if (!fs.existsSync(target)) continue
      try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
      removed.push(target)
    }
  }

  return {
    ok: true,
    mode,
    stateRoot,
    launcherPath,
    launcherRemoved: !fs.existsSync(launcherPath),
    removed,
  }
}

function daemonSystemdServiceName() {
  return 'rin-daemon.service'
}

function daemonSystemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', daemonSystemdServiceName())
}

function daemonSystemdUnitText() {
  const stateRoot = rootDir().replace(/\\/g, '/')
  const repoRoot = repoDir().replace(/\\/g, '/')
  const entry = daemonDistPath().replace(/\\/g, '/')
  return [
    '[Unit]',
    'Description=Rin daemon (Koishi bridge for NapCat + Telegram + Codex)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${stateRoot}`,
    `Environment=RIN_REPO_ROOT=${repoRoot}`,
    `ExecStart=${process.execPath} ${entry}`,
    'Restart=always',
    'RestartSec=3',
    'TimeoutStopSec=180',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function ensureDaemonSystemdServiceFile() {
  const unitPath = daemonSystemdUnitPath()
  const text = daemonSystemdUnitText()
  ensureDir(path.dirname(unitPath))
  const current = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf8') : ''
  if (current !== text) fs.writeFileSync(unitPath, text, 'utf8')
  const res = systemctlUser(['daemon-reload'])
  if (res.status !== 0) {
    const msg = safeString(res.stderr || res.stdout).trim() || 'systemd_daemon_reload_failed'
    throw new Error(msg)
  }
  return unitPath
}

function detectDaemonSystemdService() {
  const systemctl = findExecutableOnPath('systemctl')
  if (!systemctl) return ''
  try {
    const out = spawnSync(systemctl, ['--user', 'show', '-p', 'LoadState', daemonSystemdServiceName()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return ''
    const text = `${out.stdout || ''}\n${out.stderr || ''}`
    if (!/\bLoadState=loaded\b/.test(text)) return ''
    return systemctl
  } catch {
    return ''
  }
}

function runDaemonSystemctl(systemctl, args) {
  const res = spawnSync(systemctl, ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    const msg = safeString(res.stderr || res.stdout).trim() || `systemctl_failed:${args.join(' ')}`
    throw new Error(msg)
  }
  return safeString(res.stdout || '').trim()
}

function readDaemonSystemdPid(systemctl) {
  try {
    const out = spawnSync(systemctl, ['--user', 'show', daemonSystemdServiceName(), '-p', 'MainPID', '-p', 'ActiveState'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return { active: false, pid: 0 }
    const text = String(out.stdout || '')
    const active = /\bActiveState=active\b/.test(text)
    const m = text.match(/\bMainPID=(\d+)\b/)
    const pid = m ? Number(m[1]) : 0
    return { active, pid: Number.isFinite(pid) && pid > 1 ? pid : 0 }
  } catch {
    return { active: false, pid: 0 }
  }
}

function listProcessTable() {
  const psBin = findExecutableOnPath('ps')
  if (!psBin) return []
  try {
    const out = spawnSync(psBin, ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return []
    return String(out.stdout || '')
      .split(/\r?\n/g)
      .map((line) => {
        const m = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
        if (!m) return null
        const pid = Number(m[1])
        const ppid = Number(m[2])
        const args = safeString(m[3])
        if (!Number.isFinite(pid) || pid <= 1 || !args) return null
        return { pid, ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0, args }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function listDaemonProcesses() {
  const pkgDir = daemonPackageDir().replace(/\\/g, '/')
  const markers = [
    path.join(pkgDir, 'dist', 'daemon.js').replace(/\\/g, '/'),
  ]
  return listProcessTable().filter((entry) => markers.some((marker) => entry.args.includes(marker)))
}

async function waitForPidsExit(pids, timeoutMs = 8_000) {
  const pending = Array.from(new Set((pids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 1)))
  if (!pending.length) return true
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const alive = pending.filter((pid) => isPidAlive(pid))
    if (!alive.length) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return pending.every((pid) => !isPidAlive(pid))
}

async function terminatePids(pids, { timeoutMs = 8_000 } = {}) {
  const unique = Array.from(new Set((pids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 1)))
  if (!unique.length) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
  }
  const stopped = await waitForPidsExit(unique, timeoutMs)
  if (stopped) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGKILL') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
  }
  await waitForPidsExit(unique, 2_000)
}

async function cleanupStrayDaemonProcesses({ keepPid = 0 } = {}) {
  const daemons = listDaemonProcesses()
    .filter((entry) => entry.pid !== process.pid)
    .filter((entry) => !(keepPid && entry.pid === keepPid))
  const daemonPids = daemons.map((entry) => entry.pid)
  if (!daemonPids.length) return { daemonPids: [] }
  await terminatePids(daemonPids, { timeoutMs: 10_000 })
  return { daemonPids }
}

async function spawnInherit(cmd, args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: cwd || rootDir(),
      env: env ? { ...process.env, ...env } : process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`child exited with signal: ${signal}`)
        process.exitCode = 1
      } else {
        process.exitCode = Number.isFinite(code) ? code : 1
      }
      resolve()
    })
  })
}

async function spawnChecked(cmd, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: options.cwd || rootDir(),
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`child_signal:${signal}`))
      if (Number(code || 0) !== 0) return reject(new Error(`child_exit:${Number(code || 0)}`))
      resolve(Number(code || 0))
    })
  })
}

function usage(exitCode = 2) {
  console.error([
    'Usage:',
    '  rin',
    '  rin restart',
    '  rin update [--repo <git-url>] [--ref <branch|tag|commit>]',
    '  rin uninstall [--yes] [--keep-state | --purge]',
    '',
    'Notes:',
    '  - `rin` starts Pi\'s native interactive mode.',
    '  - `rin restart` restarts the Rin daemon service.',
    '  - install is handled by install.sh, not by a public CLI subcommand.',
    '  - brain / koishi / schedule are internal runtime capabilities, not public subcommands.',
  ].join('\n'))
  process.exit(exitCode)
}

async function promptInstallText(rl, question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : ''
  const out = safeString(await rl.question(`${question}${suffix}: `)).trim()
  return out || fallback
}

async function promptInstallYesNo(rl, question, fallback = true) {
  const marker = fallback ? 'Y/n' : 'y/N'
  const out = safeString(await rl.question(`${question} [${marker}]: `)).trim().toLowerCase()
  if (!out) return fallback
  return out === 'y' || out === 'yes'
}

async function promptInstallChoice(rl, question, options) {
  console.error(question)
  options.forEach((opt, index) => console.error(`  ${index + 1}) ${opt.label}`))
  while (true) {
    const raw = safeString(await rl.question('Select an option: ')).trim()
    const idx = Number(raw)
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) return options[idx - 1].value
  }
}

async function cmdInstall(argv) {
  let yes = false
  let mode = ''
  let targetUserName = ''
  let createUserName = ''
  let sourceRepo = safeString(process.env.RIN_INSTALL_SOURCE_REPO).trim()
  let sourceRef = safeString(process.env.RIN_INSTALL_SOURCE_REF).trim()

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') { yes = true; continue }
    if (a === '--source-repo') { sourceRepo = argv[i + 1] || ''; i++; continue }
    if (a === '--source-ref') { sourceRef = argv[i + 1] || ''; i++; continue }
    if (a === '--current-user') { mode = 'current'; continue }
    if (a === '--user') { mode = 'existing'; targetUserName = argv[i + 1] || ''; i++; continue }
    if (a === '--create-user') { mode = 'create'; createUserName = argv[i + 1] || ''; i++; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin install [--yes] [--current-user | --user <name> | --create-user <name>]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const currentUser = currentUserRecord()
  if (!mode && !yes && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      mode = await promptInstallChoice(rl, 'Rin install target', [
        { value: 'current', label: `Install for current user (${currentUser.username})` },
        { value: 'existing', label: 'Install for an existing user' },
        { value: 'create', label: 'Create a new user and install there' },
      ])
      if (mode === 'existing') targetUserName = await promptInstallText(rl, 'Existing username')
      if (mode === 'create') createUserName = await promptInstallText(rl, 'New username')
      console.error('Warning: Rin operates from the target user\'s installed state and user-home file space.')
      const confirmed = await promptInstallYesNo(rl, 'Proceed with this install', true)
      if (!confirmed) process.exit(1)
    } finally {
      try { rl.close() } catch {}
    }
  }

  let targetUser = null
  if (!mode || mode === 'current') {
    targetUser = currentUser
  } else if (mode === 'existing') {
    targetUser = lookupUserRecord(targetUserName)
    if (!targetUser) throw new Error(`user_not_found:${targetUserName}`)
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && targetUser.username !== currentUser.username) {
      throw new Error('install_requires_root_for_other_user')
    }
  } else if (mode === 'create') {
    const nextName = safeString(createUserName).trim()
    if (!nextName) throw new Error('missing_create_user_name')
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      throw new Error('install_requires_root_to_create_user')
    }
    if (!lookupUserRecord(nextName)) {
      const created = spawnSync('useradd', ['-m', '-s', '/bin/bash', nextName], { stdio: 'inherit' })
      if (created.status !== 0) throw new Error(`useradd_failed:${nextName}`)
    }
    targetUser = lookupUserRecord(nextName)
    if (!targetUser) throw new Error(`user_lookup_failed:${nextName}`)
  }

  const result = performInstall({
    targetUser,
    homeDir: targetUser.homeDir,
    overwriteManaged: true,
    sourceRepo: safeString(sourceRepo).trim() || detectInstallSourceRepo(),
    sourceRef: safeString(sourceRef).trim() || detectInstallSourceRef(),
  })
  if (targetUser && targetUser.username === currentUser.username) {
    try { ensureDaemonSystemdServiceFile() } catch {}
  }
  printJson(result)
}

async function cmdUpdate(argv) {
  let repo = ''
  let ref = ''

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') { repo = argv[i + 1] || ''; i += 1; continue }
    if (a === '--ref') { ref = argv[i + 1] || ''; i += 1; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin update [--repo <git-url>] [--ref <branch|tag|commit>]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const stateRoot = rootDir()
  const installMeta = readJson(path.join(stateRoot, 'install.json'), {})
  const installSource = installMeta && typeof installMeta === 'object' && installMeta.installSource && typeof installMeta.installSource === 'object'
    ? installMeta.installSource
    : {}
  const repoUrl = normalizeGitUrl(safeString(repo).trim() || safeString(installSource.repo).trim() || detectInstallSourceRepo())
  const sourceRef = safeString(ref).trim() || safeString(installSource.ref).trim() || detectInstallSourceRef()
  const git = findExecutableOnPath('git')
  if (!git) throw new Error('git_not_found')

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-update-'))
  const cloneDir = path.join(tmpRoot, 'repo')
  try {
    let cloned = false
    if (sourceRef) {
      try {
        await spawnChecked(git, ['clone', '--depth', '1', '--branch', sourceRef, repoUrl, cloneDir], { cwd: tmpRoot })
        cloned = true
      } catch {}
    }
    if (!cloned) {
      await spawnChecked(git, ['clone', '--depth', '1', repoUrl, cloneDir], { cwd: tmpRoot })
      if (sourceRef) await spawnChecked(git, ['-C', cloneDir, 'checkout', sourceRef], { cwd: tmpRoot })
    }

    await spawnChecked('npm', npmInstallArgsFor(cloneDir), { cwd: cloneDir })
    await spawnChecked('npm', ['run', '-s', 'build'], { cwd: cloneDir })

    const installArgs = [
      path.join(cloneDir, 'dist', 'index.js'),
      '__install',
      '--current-user',
      '--yes',
      '--source-repo', repoUrl,
      '--source-ref', sourceRef,
    ]
    await spawnChecked(process.execPath, installArgs, {
      cwd: cloneDir,
    })

    if (detectDaemonSystemdService()) {
      await startDaemonRuntime('restart')
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

async function cmdRestart(argv) {
  if (argv.some((arg) => arg === '-h' || arg === '--help' || arg === 'help')) {
    console.error('Usage:\n  rin restart')
    process.exit(0)
  }
  if (argv.length > 0) {
    console.error(`Unknown arg: ${argv[0]}`)
    usage(2)
  }
  await startDaemonRuntime('restart')
  console.log('Rin daemon restarted.')
}

async function cmdUninstall(argv) {
  let yes = false
  let mode = ''

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') { yes = true; continue }
    if (a === '--keep-state') { mode = 'keep'; continue }
    if (a === '--purge' || a === '--all') { mode = 'purge'; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin uninstall [--yes] [--keep-state | --purge]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const choices = [
    { value: 'keep', label: 'Remove the installed app and launcher, but keep ~/.rin state' },
    { value: 'purge', label: 'Remove Rin completely, including ~/.rin state' },
  ]

  if (!mode && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      mode = await promptInstallChoice(rl, 'Rin uninstall mode', choices)
      const confirmed = await promptInstallYesNo(
        rl,
        mode === 'purge'
          ? 'This will remove ~/.rin and the launcher. Continue'
          : 'This will remove the installed app and launcher, but keep ~/.rin state. Continue',
        false,
      )
      if (!confirmed) process.exit(1)
      yes = true
    } finally {
      try { rl.close() } catch {}
    }
  }

  if (!mode) mode = 'keep'
  if (!yes) throw new Error('uninstall_requires_confirmation_or_yes')

  try { await removeDaemonSystemdService() } catch {}

  printJson(performUninstall({ homeDir: os.homedir(), mode }))
}

function daemonPackageDir() {
  return repoDir()
}

function daemonLockPath() {
  return path.join(rootDir(), 'data', 'rin-daemon.lock')
}

function daemonDistPath() {
  return ensureRinDistFile('daemon.js')
}

function readDaemonPid() {
  try {
    const raw = fs.readFileSync(daemonLockPath(), 'utf8')
    const pid = Number(String(raw || '').trim())
    return Number.isFinite(pid) && pid > 1 ? pid : 0
  } catch {
    return 0
  }
}

async function waitForDaemonExit(timeoutMs = 20_000) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const pid = readDaemonPid()
    if (!pid || !isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function waitForDaemonStart(expectedPid = 0, timeoutMs = 20_000) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const pid = readDaemonPid()
    if (pid && isPidAlive(pid) && (!expectedPid || pid === expectedPid)) return pid
    await new Promise((r) => setTimeout(r, 200))
  }
  return 0
}

function sanitizeFileComponent(input) {
  const raw = safeString(input).trim()
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'default'
}

function inspectRuntimeRoot() {
  return path.join(rootDir(), 'data', 'inspect-runtime')
}

function inspectWorkPath(name) {
  return path.join(inspectRuntimeRoot(), `${sanitizeFileComponent(name)}.work.json`)
}

function inspectWorkLockPath(name) {
  return path.join(lockRootDir(), 'inspect-work', `${sanitizeFileComponent(name)}.lock`)
}

function defaultInspectWorkState() {
  return { version: 1, items: [] }
}

function normalizeInspectWorkItem(item) {
  const now = Date.now()
  const raw = item && typeof item === 'object' ? item : {}
  const createdAtMs = Number(raw.createdAtMs)
  const updatedAtMs = Number(raw.updatedAtMs)
  const availableAtMs = Number(raw.availableAtMs)
  const leaseUntilMs = Number(raw.leaseUntilMs)
  const attempts = Number(raw.attempts)
  const state = safeString(raw.state) || 'ready'
  const normalized = {
    ...raw,
    id: safeString(raw.id) || nodeCrypto.randomUUID(),
    state,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : now,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : (Number.isFinite(createdAtMs) ? createdAtMs : now),
    availableAtMs: Number.isFinite(availableAtMs) ? availableAtMs : (Number.isFinite(createdAtMs) ? createdAtMs : now),
    leaseOwner: safeString(raw.leaseOwner),
    leaseUntilMs: Number.isFinite(leaseUntilMs) ? leaseUntilMs : 0,
    attempts: Number.isFinite(attempts) ? attempts : 0,
    role: safeString(raw.role),
    kind: safeString(raw.kind),
    summary: safeString(raw.summary),
  }
  if (state !== 'leased') {
    normalized.leaseOwner = ''
    normalized.leaseUntilMs = 0
  }
  return normalized
}

function normalizeInspectWorkState(state) {
  const raw = state && typeof state === 'object' ? state : {}
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeInspectWorkItem) : []
  return { version: 1, items }
}

function readInspectWorkState(name) {
  const file = inspectWorkPath(name)
  const data = readJson(file, null)
  return normalizeInspectWorkState(data)
}

function writeInspectWorkState(name, state) {
  const file = inspectWorkPath(name)
  ensureDir(path.dirname(file))
  writeJsonAtomic(file, normalizeInspectWorkState(state))
}

function reviveExpiredInspectWorkLeases(state, now = Date.now()) {
  const base = normalizeInspectWorkState(state)
  let changed = false
  const items = base.items.map((item) => {
    if (safeString(item.state) !== 'leased') return item
    const leaseUntilMs = Number(item.leaseUntilMs) || 0
    if (!leaseUntilMs || leaseUntilMs > now) return item
    changed = true
    return {
      ...item,
      state: 'ready',
      leaseOwner: '',
      leaseUntilMs: 0,
      updatedAtMs: now,
      lastLeaseExpiredAtMs: now,
    }
  })
  return { state: { version: 1, items }, changed }
}

async function withInspectWorkState(name, fn) {
  const lockPath = inspectWorkLockPath(name)
  ensureDir(path.dirname(lockPath))
  const release = await acquireExclusiveFileLock(lockPath, {
    pollMs: 100,
    heartbeatMs: 10_000,
    staleMs: 5 * 60 * 1000,
    meta: { kind: 'inspect-work', name: safeString(name) },
  })
  try {
    const loaded = readInspectWorkState(name)
    const revived = reviveExpiredInspectWorkLeases(loaded)
    const value = await fn(revived.state)
    if (value && typeof value === 'object' && value.state) {
      writeInspectWorkState(name, value.state)
      return value.result
    }
    writeInspectWorkState(name, revived.state)
    return value
  } finally {
    try { release() } catch {}
  }
}

async function cmdPi(argv) {
  const sessionRoot = os.homedir()
  let noBootstrap = false
  let index = 0

  while (index < argv.length) {
    const a = argv[index]
    if (a === '--') { index += 1; break }
    if (a === '--no-bootstrap') { noBootstrap = true; index += 1; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      const hostPath = ensureRinTuiHost()
      await spawnInherit(process.execPath, [hostPath, '--help'], {
        cwd: sessionRoot,
        env: {
          RIN_REPO_ROOT: repoDir(),
          PI_SKIP_VERSION_CHECK: '1',
        },
      })
      return
    }
    break
  }

  const hostArgs = argv.slice(index)
  const hostPath = ensureRinTuiHost()
  if (!noBootstrap) ensurePiBootstrap()
  await spawnInherit(process.execPath, [hostPath, ...hostArgs], {
    cwd: sessionRoot,
    env: {
      RIN_REPO_ROOT: repoDir(),
      PI_SKIP_VERSION_CHECK: '1',
    },
  })
}

function daemonStatusSnapshot() {
  const daemonSystemctl = detectDaemonSystemdService()
  if (daemonSystemctl) {
    const { active, pid } = readDaemonSystemdPid(daemonSystemctl)
    return { ok: true, running: active && !!pid, pid: active ? pid : 0, manager: 'systemd', systemctl: daemonSystemctl }
  }
  const pid = readDaemonPid()
  return { ok: true, running: Boolean(pid && isPidAlive(pid)), pid: pid && isPidAlive(pid) ? pid : 0, manager: '' }
}

async function stopDaemonRuntime() {
  const daemonSystemctl = detectDaemonSystemdService()
  if (daemonSystemctl) {
    const { active } = readDaemonSystemdPid(daemonSystemctl)
    const hadManaged = Boolean(active)
    if (hadManaged) runDaemonSystemctl(daemonSystemctl, ['stop', daemonSystemdServiceName()])
    const cleaned = await cleanupStrayDaemonProcesses()
    return { stopped: hadManaged || cleaned.daemonPids.length > 0, systemctl: daemonSystemctl }
  }
  const pid = readDaemonPid()
  let stopped = false
  if (pid && isPidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
    stopped = await waitForDaemonExit(20_000)
    if (!stopped) throw new Error(`daemon_stop_timeout:${pid}`)
  }
  const cleaned = await cleanupStrayDaemonProcesses()
  return { stopped: stopped || cleaned.daemonPids.length > 0, systemctl: '' }
}

async function startDaemonRuntime(action = 'restart') {
  try { ensureDaemonSystemdServiceFile() } catch {}
  const daemonSystemctl = detectDaemonSystemdService()
  if (!daemonSystemctl) {
    throw new Error(`daemon_${action}_requires_systemd:${daemonSystemdServiceName()}`)
  }
  runDaemonSystemctl(daemonSystemctl, [action, daemonSystemdServiceName()])
  const { active, pid } = readDaemonSystemdPid(daemonSystemctl)
  if (!active || !pid) throw new Error(`daemon_${action}_failed_systemd`)
  await cleanupStrayDaemonProcesses({ keepPid: pid })
  return { ok: true, pid, manager: 'systemd' }
}

async function removeDaemonSystemdService() {
  const unitPath = daemonSystemdUnitPath()
  const daemonSystemctl = detectDaemonSystemdService()
  if (daemonSystemctl) {
    try { runDaemonSystemctl(daemonSystemctl, ['disable', '--now', daemonSystemdServiceName()]) } catch {}
  } else {
    try { await stopDaemonRuntime() } catch {}
  }
  try { fs.rmSync(unitPath, { force: true }) } catch {}
  const reload = systemctlUser(['daemon-reload'])
  if (reload.status !== 0) {
    const msg = safeString(reload.stderr || reload.stdout).trim()
    if (msg) console.error(msg)
  }
  try { systemctlUser(['reset-failed']) } catch {}
  return unitPath
}

function systemctlUser(args) {
  const env = { ...process.env }
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!env.XDG_RUNTIME_DIR && uid != null) {
      const runtimeDir = `/run/user/${uid}`
      try { fs.accessSync(runtimeDir, fs.constants.R_OK | fs.constants.X_OK); env.XDG_RUNTIME_DIR = runtimeDir } catch {}
    }
    if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
      const bus = path.join(env.XDG_RUNTIME_DIR, 'bus')
      try { fs.accessSync(bus, fs.constants.R_OK | fs.constants.W_OK); env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}` } catch {}
    }
  } catch {}

  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env })
  return { status: r.status == null ? 1 : r.status, stdout: safeString(r.stdout), stderr: safeString(r.stderr) }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)
  if (!cmd) return await cmdPi([])
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') usage(0)

  if (cmd === 'restart') return await cmdRestart(rest)
  if (cmd === 'update') return await cmdUpdate(rest)
  if (cmd === 'uninstall') return await cmdUninstall(rest)

  if (cmd === '__install') return await cmdInstall(rest)

  return await cmdPi(argv)
}

export {
  performInstall,
  performUninstall,
}

if (require.main === module) {
  main().catch((e) => {
    const message = String(e && e.message ? e.message : e)
    if (message === 'uninstall_requires_confirmation_or_yes') console.error('Uninstall needs confirmation. Re-run interactively or pass --yes.')
    else console.error(message)
    process.exitCode = 1
  })
}
