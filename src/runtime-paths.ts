// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath: string, obj: unknown, options: { chmod0600?: boolean } = {}): void {
  const chmod0600 = Boolean(options && options.chmod0600)
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, filePath)
  if (chmod0600) {
    try { fs.chmodSync(filePath, 0o600) } catch {}
  }
}

function safeString(v: unknown): string {
  if (v == null) return ''
  return String(v)
}

function isPidAlive(pid: unknown): boolean {
  const p = Number(pid || 0)
  if (!Number.isFinite(p) || p <= 1) return false
  try {
    process.kill(p, 0)
    return true
  } catch {
    return false
  }
}

function expandHomeAgainst(homeDir: string, value: string): string {
  const raw = safeString(value).trim()
  const base = path.resolve(homeDir || os.homedir())
  if (!raw) return ''
  if (raw === '~') return base
  if (raw.startsWith('~/')) return path.join(base, raw.slice(2))
  return raw
}

function resolveRinHomeRoot(homeDir = os.homedir()): string {
  const override = safeString(process.env.RIN_HOME).trim()
  if (override) return path.resolve(expandHomeAgainst(homeDir, override))
  return path.resolve(path.join(homeDir, '.rin'))
}

function lockRootDir(): string {
  const override = safeString(process.env.RIN_LOCK_DIR).trim()
  if (override) return path.resolve(override)
  const runtime = safeString(process.env.XDG_RUNTIME_DIR).trim()
  if (runtime) return path.join(runtime, 'rin')
  const cacheHome = safeString(process.env.XDG_CACHE_HOME).trim()
  if (cacheHome) return path.join(cacheHome, 'rin')
  try {
    const home = os.homedir && os.homedir()
    if (home) return path.join(home, '.cache', 'rin')
  } catch {}
  return path.join(os.tmpdir(), 'rin')
}

function lockFilePathForKey(key: string): string {
  const h = nodeCrypto.createHash('sha256').update(safeString(key)).digest('hex')
  return path.join(lockRootDir(), 'locks', `${h}.lock`)
}

function resolveRinLayout({
  sourceHint = '',
  homeDir = os.homedir(),
}: {
  sourceHint?: string
  homeDir?: string
} = {}): {
  repoRoot: string
  homeRoot: string
  dataDir: string
  localeDir: string
  routinesDir: string
  kbDir: string
} {
  const repoOverride = safeString(process.env.RIN_REPO_ROOT).trim()
  const repoRoot = path.resolve(safeString(sourceHint).trim() || repoOverride || path.join(__dirname, '..'))
  const homeRoot = resolveRinHomeRoot(homeDir)
  return {
    repoRoot,
    homeRoot,
    dataDir: path.join(homeRoot, 'data'),
    localeDir: path.join(homeRoot, 'locale'),
    routinesDir: path.join(homeRoot, 'routines'),
    kbDir: path.join(homeRoot, 'kb'),
  }
}

async function acquireExclusiveFileLock(
  lockPath: string,
  {
    pollMs = 250,
    heartbeatMs = 30_000,
    staleMs = 6 * 60 * 60 * 1000,
    timeoutMs = 0,
    meta = null,
    quiet = false,
    noWait = false,
  }: {
    pollMs?: number
    heartbeatMs?: number
    staleMs?: number
    timeoutMs?: number
    meta?: unknown
    quiet?: boolean
    noWait?: boolean
  } = {},
): Promise<() => void> {
  ensureDir(path.dirname(lockPath))
  const startedAt = Date.now()
  const deadlineMs = Number(timeoutMs) > 0 ? (startedAt + Number(timeoutMs)) : 0
  let loggedWait = false

  while (true) {
    if (deadlineMs && Date.now() > deadlineMs) {
      const err = new Error(`lock_timeout:${lockPath}`) as Error & { code?: string }
      err.code = 'LOCK_TIMEOUT'
      throw err
    }

    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        const payload = {
          pid: process.pid,
          startedAtMs: startedAt,
          acquiredAtMs: Date.now(),
          host: safeString(os.hostname && os.hostname()),
          meta: meta && typeof meta === 'object' ? meta : null,
        }
        fs.writeFileSync(fd, JSON.stringify(payload))
      } catch {}
      try { fs.closeSync(fd) } catch {}

      let released = false
      const tick = () => {
        try { fs.utimesSync(lockPath, new Date(), new Date()) } catch {}
      }
      tick()
      const heartbeat = setInterval(tick, Math.max(5_000, Number(heartbeatMs) || 30_000))
      try { heartbeat.unref() } catch {}

      return () => {
        if (released) return
        released = true
        try { clearInterval(heartbeat) } catch {}
        try { fs.rmSync(lockPath, { force: true }) } catch {}
      }
    } catch (e) {
      const code = e && typeof e === 'object' ? (e as { code?: string }).code : ''
      if (code && code !== 'EEXIST') throw e
      if (noWait) {
        const err = new Error(`lock_busy:${lockPath}`) as Error & { code?: string }
        err.code = 'LOCK_BUSY'
        throw err
      }

      let shouldBreak = false
      try {
        const st = fs.statSync(lockPath)
        const ageMs = Math.max(0, Date.now() - Number(st.mtimeMs || 0))
        if (Number.isFinite(ageMs) && ageMs > Number(staleMs || 0)) shouldBreak = true
      } catch {}

      if (!shouldBreak) {
        try {
          const txt = fs.readFileSync(lockPath, 'utf8')
          const obj = JSON.parse(txt)
          const pid = Number(obj && obj.pid)
          if (pid && !isPidAlive(pid)) shouldBreak = true
        } catch {}
      }

      if (shouldBreak) {
        try {
          if (!quiet) console.error(`rin lock: stale; removing: ${lockPath}`)
          fs.rmSync(lockPath, { force: true })
        } catch {}
        continue
      }

      if (!loggedWait) {
        loggedWait = true
        if (!quiet) console.error(`rin lock: busy; waiting: ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs) || 250)))
    }
  }
}

export {
  ensureDir,
  readJson,
  writeJsonAtomic,
  safeString,
  isPidAlive,
  expandHomeAgainst,
  resolveRinHomeRoot,
  lockRootDir,
  lockFilePathForKey,
  resolveRinLayout,
  acquireExclusiveFileLock,
}
