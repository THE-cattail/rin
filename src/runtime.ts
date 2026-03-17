// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'

import { Type } from '@sinclair/typebox'

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
}: {
  sourceHint?: string
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
  const homeRoot = path.resolve(path.join(os.homedir(), '.rin'))
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
      await new Promise((r) => setTimeout(r, Math.max(50, Number(pollMs) || 250)))
    }
  }
}

const RinBuiltins = (() => {
// @ts-nocheck
const INTERNALIZED_SKILL_NAMES = new Set([
  'brain',
  'memory',
  'rin-daemon',
  'rin-koishi',
  'rin-schedule',
  'rin-send',
  'rin-identity',
])

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function trimText(value: any, limit = 64_000): string {
  const text = safeString(value)
  if (!limit || text.length <= limit) return text
  return text.slice(-limit)
}

function collectMessageText(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  const blocks = Array.isArray(content) ? content : []
  const parts: string[] = []
  let imageCount = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const type = safeString((block as any).type)
    if (type === 'text') {
      const text = safeString((block as any).text).trim()
      if (text) parts.push(text)
      continue
    }
    if (type === 'image') imageCount += 1
  }
  if (imageCount > 0) parts.push(imageCount === 1 ? '[image]' : `[images:${imageCount}]`)
  return parts.join('\n\n').trim()
}

async function runNodeEntrypoint({
  entryPath,
  repoRoot,
  stateRoot,
  args,
  signal,
}: {
  entryPath: string
  repoRoot: string
  stateRoot: string
  args: string[]
  signal?: AbortSignal
}): Promise<{ code: number, stdout: string, stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: stateRoot,
      env: {
        ...process.env,
        RIN_REPO_ROOT: repoRoot,
        PI_SKIP_VERSION_CHECK: safeString(process.env.PI_SKIP_VERSION_CHECK || '1') || '1',
        MEM0_TELEMETRY: safeString(process.env.MEM0_TELEMETRY || 'false') || 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code: Number(code ?? 1), stdout: trimText(stdout), stderr: trimText(stderr) }))
    if (signal) {
      const abort = () => {
        try { child.kill('SIGTERM') } catch {}
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
  })
}

async function runRinBrainCommand({
  repoRoot,
  stateRoot,
  args,
  signal,
}: {
  repoRoot: string
  stateRoot: string
  args: string[]
  signal?: AbortSignal
}): Promise<{ code: number, stdout: string, stderr: string }> {
  return await runNodeEntrypoint({
    entryPath: path.join(repoRoot, 'dist', 'brain.js'),
    repoRoot,
    stateRoot,
    args,
    signal,
  })
}

function brainQueueRootForState(stateRoot: string) {
  return path.join(stateRoot, 'data', 'brain', 'queue')
}

function brainQueuePendingDirForState(stateRoot: string) {
  return path.join(brainQueueRootForState(stateRoot), 'pending')
}

function brainQueueFailedDirForState(stateRoot: string) {
  return path.join(brainQueueRootForState(stateRoot), 'failed')
}

function brainQueueProcessingDirForState(stateRoot: string) {
  return path.join(brainQueueRootForState(stateRoot), 'processing')
}

function brainJobArgs(job: any) {
  const kind = safeString(job && job.kind).trim()
  const chatKey = safeString(job && job.chatKey).trim() || 'local:default'
  if (kind === 'brain.turn') {
    const role = safeString(job && job.role).trim()
    const text = safeString(job && job.text).trim()
    if (!role || !text) return null
    return ['brain', 'turn', role, text, '--chatKey', chatKey]
  }
  if (kind === 'brain.finalize') {
    const reason = safeString(job && job.reason).trim() || 'manual'
    return ['brain', 'finalize', '--scope', 'chat', '--chatKey', chatKey, '--reason', reason]
  }
  return null
}

function backoffBrainJob(stateRoot: string, job: any, fileName: string, errorText: string) {
  const attempts = Number(job && job.attempts || 0) + 1
  const delayMs = Math.min(15 * 60_000, Math.max(30_000, attempts * 60_000))
  const nextJob = {
    ...(job && typeof job === 'object' ? job : {}),
    attempts,
    nextRunAtMs: Date.now() + delayMs,
    lastError: safeString(errorText).trim(),
    updatedAtMs: Date.now(),
  }
  const processingPath = path.join(brainQueueProcessingDirForState(stateRoot), fileName)
  writeJsonAtomic(processingPath, nextJob)
  const targetPath = attempts >= 5
    ? path.join(brainQueueFailedDirForState(stateRoot), fileName)
    : path.join(brainQueuePendingDirForState(stateRoot), fileName)
  try { fs.renameSync(processingPath, targetPath) } catch {}
}

function hasQueuedBrainJobs(stateRoot: string, chatKey = '') {
  const want = safeString(chatKey).trim()
  for (const dir of [brainQueuePendingDirForState(stateRoot), brainQueueProcessingDirForState(stateRoot)]) {
    let names: string[] = []
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() } catch {}
    for (const name of names) {
      const job = readJson(path.join(dir, name), null)
      if (!job || typeof job !== 'object') continue
      const jobChatKey = safeString(job && (job as any).chatKey).trim()
      if (!want || jobChatKey === want) return true
    }
  }
  return false
}

const brainQueueRuntimes = new Map<string, any>()

function ensureBrainQueueRuntime({
  repoRoot,
  stateRoot,
  pollMs = 5000,
}: {
  repoRoot: string
  stateRoot: string
  pollMs?: number
}) {
  const resolvedRepoRoot = path.resolve(repoRoot)
  const resolvedStateRoot = path.resolve(stateRoot)
  const key = resolvedStateRoot
  const existing = brainQueueRuntimes.get(key)
  if (existing) {
    existing.repoRoot = resolvedRepoRoot
    return existing
  }

  const runtime: any = {
    repoRoot: resolvedRepoRoot,
    stateRoot: resolvedStateRoot,
    active: false,
    disposed: false,
    wakeTimer: null,
    pollTimer: null,
    kick(limit = 4, delayMs = 0) {
      if (runtime.disposed || runtime.wakeTimer) return
      runtime.wakeTimer = setTimeout(() => {
        runtime.wakeTimer = null
        void runtime.processOnce(limit).catch(() => {})
      }, Math.max(0, Number(delayMs) || 0))
      try { runtime.wakeTimer.unref?.() } catch {}
    },
    async processOnce(limit = 4) {
      if (runtime.disposed || runtime.active) return { ok: true, skipped: runtime.disposed ? 'disposed' : 'busy' }
      runtime.active = true
      ensureDir(brainQueuePendingDirForState(resolvedStateRoot))
      ensureDir(brainQueueProcessingDirForState(resolvedStateRoot))
      ensureDir(brainQueueFailedDirForState(resolvedStateRoot))
      try {
        const names = fs.readdirSync(brainQueuePendingDirForState(resolvedStateRoot)).filter((name) => name.endsWith('.json')).sort()
        const maxJobs = Math.max(1, Number(limit) || 1)
        let started = 0
        let processed = 0
        for (const name of names) {
          if (started >= maxJobs) break
          const srcPath = path.join(brainQueuePendingDirForState(resolvedStateRoot), name)
          const processingPath = path.join(brainQueueProcessingDirForState(resolvedStateRoot), name)
          try { fs.renameSync(srcPath, processingPath) } catch { continue }
          const job = readJson(processingPath, null)
          if (!job || typeof job !== 'object') {
            try { fs.rmSync(processingPath, { force: true }) } catch {}
            continue
          }
          const nextRunAtMs = Number(job.nextRunAtMs || 0)
          if (nextRunAtMs > Date.now()) {
            try { fs.renameSync(processingPath, srcPath) } catch {}
            continue
          }
          const args = brainJobArgs(job)
          if (!args) {
            try { fs.renameSync(processingPath, path.join(brainQueueFailedDirForState(resolvedStateRoot), name)) } catch {}
            continue
          }
          started += 1
          try {
            const result = await runRinBrainCommand({
              repoRoot: runtime.repoRoot,
              stateRoot: resolvedStateRoot,
              args,
            })
            if (Number(result.code) === 0) {
              processed += 1
              try { fs.rmSync(processingPath, { force: true }) } catch {}
              continue
            }
            backoffBrainJob(resolvedStateRoot, job, name, safeString(result.stderr || result.stdout || 'brain_job_failed'))
          } catch (e: any) {
            backoffBrainJob(resolvedStateRoot, job, name, safeString(e && e.message ? e.message : e))
          }
        }
        return { ok: true, processed }
      } finally {
        runtime.active = false
      }
    },
    async flush({ chatKey = '', timeoutMs = 10_000, limit = 4 }: { chatKey?: string, timeoutMs?: number, limit?: number } = {}) {
      const deadline = Number(timeoutMs) > 0 ? Date.now() + Number(timeoutMs) : 0
      runtime.kick(limit, 0)
      while (true) {
        await runtime.processOnce(limit).catch(() => {})
        if (!runtime.active && !hasQueuedBrainJobs(resolvedStateRoot, chatKey)) return { ok: true }
        if (deadline && Date.now() >= deadline) return { ok: false, timeout: true }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    },
    dispose() {
      if (runtime.disposed) return
      runtime.disposed = true
      if (runtime.wakeTimer) {
        try { clearTimeout(runtime.wakeTimer) } catch {}
        runtime.wakeTimer = null
      }
      if (runtime.pollTimer) {
        try { clearInterval(runtime.pollTimer) } catch {}
        runtime.pollTimer = null
      }
      brainQueueRuntimes.delete(key)
    },
  }

  runtime.pollTimer = setInterval(() => {
    runtime.kick(4, 0)
  }, Math.max(1000, Number(pollMs) || 5000))
  try { runtime.pollTimer.unref?.() } catch {}

  brainQueueRuntimes.set(key, runtime)
  runtime.kick(4, 0)
  return runtime
}

function queueBrainTurnAsync({
  repoRoot,
  stateRoot,
  role,
  text,
  chatKey = 'local:default',
}: {
  repoRoot: string
  stateRoot: string
  role: string
  text: string
  chatKey?: string
}) {
  const queued = enqueueBrainTurn(stateRoot, { role, text, chatKey })
  try { ensureBrainQueueRuntime({ repoRoot, stateRoot }).kick() } catch {}
  return queued
}

function queueBrainFinalizeAsync({
  repoRoot,
  stateRoot,
  chatKey = 'local:default',
  reason = 'manual',
}: {
  repoRoot: string
  stateRoot: string
  chatKey?: string
  reason?: string
}) {
  const queued = enqueueBrainFinalize(stateRoot, { chatKey, reason })
  try { ensureBrainQueueRuntime({ repoRoot, stateRoot }).kick() } catch {}
  return queued
}

async function flushBrainQueue({
  repoRoot,
  stateRoot,
  chatKey = '',
  timeoutMs = 10_000,
}: {
  repoRoot: string
  stateRoot: string
  chatKey?: string
  timeoutMs?: number
}) {
  return await ensureBrainQueueRuntime({ repoRoot, stateRoot }).flush({ chatKey, timeoutMs })
}

function enqueueBrainJob(stateRoot: string, job: Record<string, any>) {
  const pendingDir = brainQueuePendingDirForState(stateRoot)
  const failedDir = brainQueueFailedDirForState(stateRoot)
  ensureDir(pendingDir)
  ensureDir(failedDir)
  const createdAtMs = Date.now()
  const id = `${createdAtMs}-${process.pid}-${nodeCrypto.randomBytes(6).toString('hex')}`
  const payload = {
    id,
    createdAtMs,
    nextRunAtMs: createdAtMs,
    attempts: 0,
    ...JSON.parse(JSON.stringify(job || {})),
  }
  const filePath = path.join(pendingDir, `${id}.json`)
  writeJsonAtomic(filePath, payload)
  return { ok: true, id, filePath }
}

function enqueueBrainTurn(stateRoot: string, {
  role,
  text,
  chatKey = 'local:default',
}: {
  role: string
  text: string
  chatKey?: string
}) {
  const nextRole = safeString(role).trim()
  const nextText = safeString(text).trim()
  if (!nextRole || !nextText) return { ok: false, skipped: 'missing_role_or_text' }
  return enqueueBrainJob(stateRoot, {
    kind: 'brain.turn',
    role: nextRole,
    text: nextText,
    chatKey: safeString(chatKey).trim() || 'local:default',
  })
}

function enqueueBrainFinalize(stateRoot: string, {
  chatKey = 'local:default',
  reason = 'manual',
}: {
  chatKey?: string
  reason?: string
}) {
  return enqueueBrainJob(stateRoot, {
    kind: 'brain.finalize',
    chatKey: safeString(chatKey).trim() || 'local:default',
    reason: safeString(reason).trim() || 'manual',
  })
}

function ctlSockPathForState(stateRoot: string) {
  return path.join(stateRoot, 'data', 'rin-ctl.sock')
}

async function ctlRequest({
  stateRoot,
  payload,
  timeoutMs = 20_000,
  signal,
}: {
  stateRoot: string
  payload: any
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<any> {
  const sockPath = ctlSockPathForState(stateRoot)
  const body = JSON.stringify(payload) + '\n'
  return await new Promise((resolve, reject) => {
    const socket = new net.Socket()
    socket.setEncoding('utf8')
    let buf = ''
    let done = false

    const finish = (err?: any, resp?: any) => {
      if (done) return
      done = true
      try { socket.end() } catch {}
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort) } catch {}
      }
      if (err) reject(err)
      else resolve(resp)
    }

    const t = setTimeout(() => finish(new Error('rin ctl timeout')), timeoutMs)
    socket.on('error', (e) => {
      clearTimeout(t)
      finish(new Error(e && (e as any).message ? String((e as any).message) : String(e)))
    })
    socket.on('connect', () => {
      socket.write(body)
    })
    socket.on('data', (chunk) => {
      buf += String(chunk)
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(t)
      const line = buf.slice(0, nl).trim()
      let resp: any
      try { resp = JSON.parse(line) } catch { return finish(new Error('invalid response from rin ctl')) }
      finish(null, resp)
    })

    const onAbort = () => {
      clearTimeout(t)
      try { socket.destroy(new Error('aborted')) } catch {}
      finish(new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      socket.connect({ path: sockPath })
    } catch (e) {
      clearTimeout(t)
      finish(new Error(e && (e as any).message ? String((e as any).message) : String(e)))
    }
  })
}

function resolveHomeFilePath(filePath: string) {
  const raw = safeString(filePath).trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  if (path.isAbsolute(raw)) return raw
  return path.resolve(os.homedir(), raw)
}

function ensureReadableFiles(paths: any[], label: string) {
  const out: string[] = []
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const abs = resolveHomeFilePath(safeString(filePath))
    if (!abs) continue
    try { fs.accessSync(abs, fs.constants.R_OK) } catch { throw new Error(`${label} not readable: ${abs}`) }
    out.push(abs)
  }
  return out
}

async function sendBridgeMessage({
  stateRoot,
  chatKey,
  text = '',
  atIds = [],
  images = [],
  files = [],
  signal,
}: {
  stateRoot: string
  chatKey: string
  text?: string
  atIds?: string[]
  images?: string[]
  files?: string[]
  signal?: AbortSignal
}) {
  const resolvedImages = ensureReadableFiles(images, 'image')
  const resolvedFiles = ensureReadableFiles(files, 'file')
  const resp = await ctlRequest({
    stateRoot,
    payload: {
      op: 'send',
      chatKey: safeString(chatKey),
      text: safeString(text),
      elements: (Array.isArray(atIds) ? atIds : []).map((id) => ({ type: 'at', attrs: { id: safeString(id) } })),
      images: resolvedImages.map((filePath) => ({ path: filePath })),
      files: resolvedFiles.map((filePath) => ({ path: filePath, name: path.basename(filePath) })),
    },
    signal,
  })
  if (!resp || resp.ok !== true) throw new Error(resp && resp.error ? String(resp.error) : 'send_failed')
  return { ok: true, images: resolvedImages, files: resolvedFiles, response: resp }
}

async function getChatHistoryMessage({
  stateRoot,
  chatKey,
  messageId,
  signal,
}: {
  stateRoot: string
  chatKey: string
  messageId: string
  signal?: AbortSignal
}) {
  const resp = await ctlRequest({
    stateRoot,
    payload: {
      op: 'history.get',
      chatKey: safeString(chatKey),
      messageId: safeString(messageId),
    },
    signal,
  })
  if (!resp || resp.ok !== true) throw new Error(resp && resp.error ? String(resp.error) : 'history_get_failed')
  return resp
}

function identityPathForState(stateRoot: string) {
  return path.join(stateRoot, 'data', 'identity.json')
}

function trustedPersonId(platform: string, userId: string) {
  const key = `${platform}:${userId}`
  return `trusted_${nodeCrypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`
}

function loadIdentityState(stateRoot: string) {
  const identity = readJson(identityPathForState(stateRoot), { persons: {}, aliases: [], trusted: [] })
  identity.persons ||= {}
  identity.aliases ||= []
  identity.trusted ||= []
  return identity
}

function formatTrustedAliases(identity: any) {
  const aliases = Array.isArray(identity && identity.aliases) ? identity.aliases : []
  const persons = identity && typeof identity.persons === 'object' ? identity.persons : {}
  const out: string[] = []
  for (const entry of aliases) {
    if (!entry || entry.platform == null || entry.userId == null || entry.personId == null) continue
    const person = persons[entry.personId]
    if (!person || person.trust !== 'TRUSTED') continue
    out.push(`${entry.platform}:${entry.userId}${person.name ? ` (${person.name})` : ''}`)
  }
  return out
}

function manageTrustedIdentity({
  stateRoot,
  action,
  platform = '',
  userId = '',
  name = '',
}: {
  stateRoot: string
  action: string
  platform?: string
  userId?: string
  name?: string
}) {
  const identityPath = identityPathForState(stateRoot)
  const identity = loadIdentityState(stateRoot)

  if (action === 'list') {
    const items = formatTrustedAliases(identity)
    return { text: JSON.stringify(items, null, 2), details: { items } }
  }

  if (action === 'check') {
    const nextPlatform = safeString(platform).trim()
    const nextUserId = safeString(userId).trim()
    if (!nextPlatform || !nextUserId) throw new Error('identity_check_requires_platform_and_userId')
    const entry = identity.aliases.find((alias: any) => alias && alias.platform === nextPlatform && String(alias.userId) === nextUserId) || null
    const personId = safeString(entry && entry.personId)
    const person = personId ? identity.persons[personId] : null
    const trust = safeString(person && person.trust || 'OTHER') || 'OTHER'
    const details = {
      matched: Boolean(entry && personId),
      platform: nextPlatform,
      userId: nextUserId,
      personId: personId || undefined,
      trust,
      name: safeString(person && person.name || '') || undefined,
    }
    return { text: JSON.stringify(details, null, 2), details }
  }

  if (action === 'add') {
    const nextPlatform = safeString(platform).trim()
    const nextUserId = safeString(userId).trim()
    if (!nextPlatform || !nextUserId) throw new Error('identity_add_requires_platform_and_userId')
    const nextName = safeString(name).trim()
    const personId = trustedPersonId(nextPlatform, nextUserId)
    identity.persons[personId] = { name: nextName, trust: 'TRUSTED' }
    const existing = identity.aliases.find((entry: any) => entry && entry.platform === nextPlatform && String(entry.userId) === nextUserId)
    if (existing) existing.personId = personId
    else identity.aliases.push({ platform: nextPlatform, userId: nextUserId, personId })
    if (!identity.trusted.includes(personId)) identity.trusted.push(personId)
    writeJsonAtomic(identityPath, identity, { chmod0600: true })
    return { text: 'OK', details: { platform: nextPlatform, userId: nextUserId, name: nextName } }
  }

  if (action === 'del') {
    const nextPlatform = safeString(platform).trim()
    const nextUserId = safeString(userId).trim()
    if (!nextPlatform || !nextUserId) throw new Error('identity_del_requires_platform_and_userId')
    identity.aliases = identity.aliases.filter((entry: any) => !(entry && entry.platform === nextPlatform && String(entry.userId) === nextUserId))
    writeJsonAtomic(identityPath, identity, { chmod0600: true })
    return { text: 'OK', details: { platform: nextPlatform, userId: nextUserId } }
  }

  throw new Error(`invalid_identity_action:${safeString(action)}`)
}

function scheduleConfigPathForState(stateRoot: string) {
  return path.join(stateRoot, 'data', 'schedules.json')
}

function scheduleStatePathForState(stateRoot: string) {
  return path.join(stateRoot, 'data', 'schedules.state.json')
}

function parseDurationMs(value: any) {
  const raw = safeString(value).trim()
  if (!raw) return NaN
  if (/^\d+$/.test(raw)) return Number(raw)
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i)
  if (!match) return NaN
  const n = Number(match[1])
  const unit = match[2].toLowerCase()
  const mul = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
          : unit === 'd' ? 86_400_000
            : 1
  return Math.floor(n * mul)
}

function parseTimeMs(value: any) {
  const raw = safeString(value).trim()
  if (!raw) return NaN
  if (raw === 'now') return Date.now()
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : NaN
}

function isPathInside(parent: string, child: string) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

function deriveInspectTodoPath(inspectPath: string, inspectName: string) {
  const p = safeString(inspectPath).trim()
  if (p.endsWith('.prompt.md')) return p.replace(/\.prompt\.md$/, '.todo')
  if (p.endsWith('.inspect.md')) return p.replace(/\.inspect\.md$/, '.todo')
  if (p.endsWith('.md')) return p.replace(/\.md$/, '.todo')
  const name = safeString(inspectName).trim()
  if (name) return `routines/inspects/${name}.todo`
  return `${p}.todo`
}

function normalizeScheduleConfigItem(kind: 'timer' | 'inspect', item: any) {
  if (!item || typeof item !== 'object') return null
  const base = {
    name: safeString(item.name),
    enabled: item.enabled !== false,
    startAtMs: Number(item.startAtMs),
    intervalMs: Number(item.intervalMs),
    type: kind,
  }
  if (!base.name) return null
  if (!Number.isFinite(base.startAtMs) || !Number.isFinite(base.intervalMs) || base.intervalMs <= 0) return null
  if (kind === 'timer') {
    const chatKey = safeString(item.chatKey)
    const routineFile = safeString(item.routineFile || item.routine_file || item.routine)
    if (!chatKey || !routineFile) return null
    return { ...base, chatKey, routineFile }
  }
  const file = safeString(item.file || item.inspectFile || item.inspect_file || item.path)
  const command = safeString(item.command || item.cmd || item.exec).trim()
  if (!file && !command) return null
  const todoFile = safeString(item.todoFile || item.todolistFile || item.todo_file || item.todo || '').trim() || deriveInspectTodoPath(file, base.name)
  if (file) return { ...base, file, todoFile }
  return { ...base, command, todoFile }
}

function loadSchedulesConfigForState(stateRoot: string) {
  const data = readJson(scheduleConfigPathForState(stateRoot), null)
  if (!data || typeof data !== 'object') return { version: 1, timers: [], inspections: [] }
  const timers: any[] = []
  const inspections: any[] = []
  for (const item of Array.isArray(data.timers) ? data.timers : []) {
    const normalized = normalizeScheduleConfigItem('timer', item)
    if (normalized) timers.push(normalized)
  }
  for (const item of Array.isArray(data.inspections) ? data.inspections : []) {
    const normalized = normalizeScheduleConfigItem('inspect', item)
    if (normalized) inspections.push(normalized)
  }
  return { version: 1, timers, inspections }
}

function saveSchedulesConfigForState(stateRoot: string, value: any) {
  writeJsonAtomic(scheduleConfigPathForState(stateRoot), {
    version: 1,
    timers: Array.isArray(value && value.timers) ? value.timers : [],
    inspections: Array.isArray(value && value.inspections) ? value.inspections : [],
  })
}

function loadSchedulesStateForState(stateRoot: string) {
  const data = readJson(scheduleStatePathForState(stateRoot), null)
  if (!data || typeof data !== 'object') return { version: 1, state: {} }
  return { version: 1, state: data.state && typeof data.state === 'object' ? data.state : {} }
}

function saveSchedulesStateForState(stateRoot: string, value: any) {
  writeJsonAtomic(scheduleStatePathForState(stateRoot), {
    version: 1,
    state: value && value.state && typeof value.state === 'object' ? value.state : {},
  })
}

function findByName(list: any[], name: string) {
  return (Array.isArray(list) ? list : []).find((item) => item && typeof item === 'object' && String(item.name || '') === String(name || '')) || null
}

function scheduleItemBase({
  name,
  chatKey = '',
  startAtMs,
  intervalMs,
}: {
  name: string
  chatKey?: string
  startAtMs: number
  intervalMs: number
}) {
  const out: any = { name, enabled: true, startAtMs, intervalMs }
  const key = safeString(chatKey)
  if (key) out.chatKey = key
  return out
}

function upsert(list: any[], item: any) {
  const out = Array.isArray(list) ? list.slice() : []
  const index = out.findIndex((entry) => entry && typeof entry === 'object' && String(entry.name || '') === String(item.name || ''))
  if (index >= 0) out[index] = { ...out[index], ...item }
  else out.push(item)
  return out
}

async function manageSchedule({
  stateRoot,
  kind,
  action,
  name = '',
  chatKey = '',
  routineFile = '',
  file = '',
  command = '',
  todoFile = '',
  start = '',
  every = '',
  signal,
}: {
  stateRoot: string
  kind: string
  action: string
  name?: string
  chatKey?: string
  routineFile?: string
  file?: string
  command?: string
  todoFile?: string
  start?: string
  every?: string
  signal?: AbortSignal
}) {
  const nextKind = safeString(kind).trim()
  const nextAction = safeString(action).trim()
  const nextName = safeString(name).trim()
  const schedules = loadSchedulesConfigForState(stateRoot)
  const state = loadSchedulesStateForState(stateRoot)
  const runtimeRoot = path.resolve(stateRoot)

  if (nextKind !== 'timer' && nextKind !== 'inspect') throw new Error(`invalid_schedule_kind:${nextKind}`)

  if (nextAction === 'list') {
    const items = (nextKind === 'timer' ? schedules.timers : schedules.inspections).map((item: any) => {
      const key = `${nextKind === 'timer' ? 'timer' : 'inspect'}:${safeString(item.name)}`
      const runtimeState = state.state && typeof state.state === 'object' ? state.state[key] : null
      return { ...item, state: runtimeState && typeof runtimeState === 'object' ? runtimeState : {} }
    })
    return { text: JSON.stringify(items, null, 2), details: { items } }
  }

  if (!nextName) throw new Error('schedule_action_requires_name')

  if (nextAction === 'del') {
    if (nextKind === 'timer') schedules.timers = schedules.timers.filter((item: any) => !(item && typeof item === 'object' && String(item.name || '') === nextName))
    else schedules.inspections = schedules.inspections.filter((item: any) => !(item && typeof item === 'object' && String(item.name || '') === nextName))
    saveSchedulesConfigForState(stateRoot, schedules)
    if (state.state && typeof state.state === 'object') {
      delete state.state[`${nextKind === 'timer' ? 'timer' : 'inspect'}:${nextName}`]
      saveSchedulesStateForState(stateRoot, state)
    }
    return { text: 'OK', details: { kind: nextKind, action: nextAction, name: nextName } }
  }

  if (nextAction === 'enable' || nextAction === 'disable') {
    const target = findByName(nextKind === 'timer' ? schedules.timers : schedules.inspections, nextName)
    if (!target) throw new Error(`not_found:${nextName}`)
    target.enabled = nextAction === 'enable'
    saveSchedulesConfigForState(stateRoot, schedules)
    return { text: 'OK', details: { kind: nextKind, action: nextAction, name: nextName, enabled: target.enabled } }
  }

  if (nextAction === 'run') {
    const resp = await ctlRequest({
      stateRoot,
      payload: { op: 'schedule.run', kind: nextKind, name: nextName },
      timeoutMs: 35 * 60_000,
      signal,
    })
    if (!resp || resp.ok !== true) throw new Error(resp && resp.error ? String(resp.error) : 'schedule_run_failed')
    return { text: 'OK', details: { kind: nextKind, action: nextAction, name: nextName, response: resp } }
  }

  if (nextAction !== 'add') throw new Error(`invalid_schedule_action:${nextAction}`)

  const startAtMs = parseTimeMs(start)
  const intervalMs = parseDurationMs(every)
  if (!Number.isFinite(startAtMs)) throw new Error('invalid_schedule_start')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('invalid_schedule_every')

  if (nextKind === 'timer') {
    const nextChatKey = safeString(chatKey).trim()
    if (!nextChatKey) throw new Error('missing_chatKey')
    let nextRoutineFile = safeString(routineFile).trim()
    if (!nextRoutineFile) throw new Error('missing_routineFile')
    if (nextRoutineFile.startsWith(runtimeRoot + path.sep)) nextRoutineFile = nextRoutineFile.slice(runtimeRoot.length + 1)
    const routineAbs = path.resolve(runtimeRoot, nextRoutineFile)
    if (!isPathInside(runtimeRoot, routineAbs)) throw new Error('routineFile_outside_state_root')
    if (!fs.existsSync(routineAbs)) throw new Error(`missing_routineFile:${routineAbs}`)
    const item = { ...scheduleItemBase({ name: nextName, chatKey: nextChatKey, startAtMs, intervalMs }), type: 'timer', routineFile: nextRoutineFile }
    schedules.timers = upsert(schedules.timers, item)
    saveSchedulesConfigForState(stateRoot, schedules)
    return { text: 'OK', details: { kind: nextKind, action: nextAction, item } }
  }

  if (safeString(chatKey).trim()) throw new Error('inspect_chatKey_not_supported')
  const nextFile = safeString(file).trim()
  const nextCommand = safeString(command).trim()
  if (!!nextFile === !!nextCommand) throw new Error('inspect_requires_exactly_one_of_file_or_command')

  let inspectFile = nextFile
  if (inspectFile && inspectFile.startsWith(runtimeRoot + path.sep)) inspectFile = inspectFile.slice(runtimeRoot.length + 1)
  if (inspectFile) {
    const inspectAbs = path.resolve(runtimeRoot, inspectFile)
    if (!isPathInside(runtimeRoot, inspectAbs)) throw new Error('inspectFile_outside_state_root')
    if (!fs.existsSync(inspectAbs)) throw new Error(`missing_inspectFile:${inspectAbs}`)
  }

  let nextTodoFile = safeString(todoFile).trim() || deriveInspectTodoPath(inspectFile, nextName)
  if (nextTodoFile.startsWith(runtimeRoot + path.sep)) nextTodoFile = nextTodoFile.slice(runtimeRoot.length + 1)
  const todoAbs = path.resolve(runtimeRoot, nextTodoFile)
  if (!isPathInside(runtimeRoot, todoAbs)) throw new Error('todoFile_outside_state_root')
  ensureDir(path.dirname(todoAbs))

  const item = inspectFile
    ? { ...scheduleItemBase({ name: nextName, startAtMs, intervalMs }), type: 'inspect', file: inspectFile, todoFile: nextTodoFile }
    : { ...scheduleItemBase({ name: nextName, startAtMs, intervalMs }), type: 'inspect', command: nextCommand, todoFile: nextTodoFile }
  schedules.inspections = upsert(schedules.inspections, item)
  saveSchedulesConfigForState(stateRoot, schedules)
  return { text: 'OK', details: { kind: nextKind, action: nextAction, item } }
}

function toolResultFromCommand(result: { code: number, stdout: string, stderr: string }, okFallback = 'OK') {
  const text = [safeString(result.stdout).trim(), safeString(result.stderr).trim()].filter(Boolean).join('\n') || okFallback
  return {
    content: [{ type: 'text' as const, text }],
    details: {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    isError: result.code !== 0,
  }
}

function toolResultFromText(text: string, details: any = {}, isError = false) {
  return {
    content: [{ type: 'text' as const, text: safeString(text) }],
    details,
    isError,
  }
}

function createRinBuiltinTools({ repoRoot, stateRoot, currentChatKey = '' }: { repoRoot: string, stateRoot: string, currentChatKey?: string }) {
  const brainTool = {
    name: 'rin_brain',
    label: 'Rin Brain',
    description: 'Search and update memory, history, and knowledge.',
    promptSnippet: 'Search and update memory, history, and knowledge.',
    promptGuidelines: [],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('show'),
        Type.Literal('search'),
        Type.Literal('recall'),
        Type.Literal('history_recent'),
        Type.Literal('history_search'),
        Type.Literal('remember'),
        Type.Literal('finalize'),
        Type.Literal('knowledge_search'),
        Type.Literal('knowledge_index'),
      ]),
      query: Type.Optional(Type.String()),
      hours: Type.Optional(Type.Number({ minimum: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1 })),
      chatKey: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const action = safeString(params && params.action).trim()
      const args: string[] = []
      if (action === 'knowledge_search' || action === 'knowledge_index') args.push('knowledge')
      else args.push('brain')
      if (action === 'show') args.push('show')
      if (action === 'search') args.push('search', safeString(params.query || ''))
      if (action === 'recall') args.push('recall', safeString(params.query || ''))
      if (action === 'history_recent') args.push('history', 'recent')
      if (action === 'history_search') args.push('history', 'search', safeString(params.query || ''))
      if (action === 'remember') args.push('remember', safeString(params.query || ''))
      if (action === 'finalize') args.push('finalize')
      if (action === 'knowledge_search') args.push('search', safeString(params.query || ''))
      if (action === 'knowledge_index') args.push('index')
      if (params && params.limit != null) args.push('--limit', String(params.limit))
      if (params && params.hours != null && action === 'history_recent') args.push('--hours', String(params.hours))
      if (params && params.chatKey) args.push('--chatKey', safeString(params.chatKey))
      if (params && params.scope && action !== 'knowledge_search' && action !== 'knowledge_index' && action !== 'history_recent' && action !== 'history_search') args.push('--scope', safeString(params.scope))
      if (params && params.reason && action === 'finalize') args.push('--reason', safeString(params.reason))
      if (params && params.mode && action === 'knowledge_search') args.push('--mode', safeString(params.mode))
      const result = await runRinBrainCommand({ repoRoot, stateRoot, args, signal })
      return toolResultFromCommand(result)
    },
  }

  const koishiTool = {
    name: 'rin_koishi',
    label: 'Rin Koishi',
    description: 'Send messages, inspect chat history, and manage trusted platform identities.',
    promptSnippet: 'Send messages, inspect chat history, and manage trusted platform identities.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('send'),
        Type.Literal('history_get'),
        Type.Literal('trusted_list'),
        Type.Literal('trusted_add'),
        Type.Literal('trusted_del'),
        Type.Literal('trusted_check'),
      ]),
      chatKey: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      atIds: Type.Optional(Type.Array(Type.String())),
      images: Type.Optional(Type.Array(Type.String())),
      files: Type.Optional(Type.Array(Type.String())),
      messageId: Type.Optional(Type.String()),
      platform: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      try {
        const action = safeString(params && params.action).trim()
        const effectiveChatKey = safeString(params && params.chatKey || currentChatKey)
        if (action === 'send') {
          const result = await sendBridgeMessage({
            stateRoot,
            chatKey: effectiveChatKey,
            text: safeString(params.text || ''),
            atIds: Array.isArray(params.atIds) ? params.atIds.map((id: any) => safeString(id)) : [],
            images: Array.isArray(params.images) ? params.images.map((file: any) => safeString(file)) : [],
            files: Array.isArray(params.files) ? params.files.map((file: any) => safeString(file)) : [],
            signal,
          })
          return toolResultFromText('OK', result)
        }
        if (action === 'history_get') {
          const result = await getChatHistoryMessage({
            stateRoot,
            chatKey: effectiveChatKey,
            messageId: safeString(params.messageId),
            signal,
          })
          return toolResultFromText(JSON.stringify(result.message || {}, null, 2), result)
        }
        const mappedAction = action === 'trusted_list'
          ? 'list'
          : action === 'trusted_add'
            ? 'add'
            : action === 'trusted_del'
              ? 'del'
              : action === 'trusted_check'
                ? 'check'
                : ''
        const result = manageTrustedIdentity({
          stateRoot,
          action: mappedAction,
          platform: safeString(params.platform || ''),
          userId: safeString(params.userId || ''),
          name: safeString(params.name || ''),
        })
        return toolResultFromText(result.text, result.details)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      }
    },
  }

  const scheduleTool = {
    name: 'rin_schedule',
    label: 'Rin Schedule',
    description: 'Manage timers and inspect schedules.',
    promptSnippet: 'Manage timers and inspect schedules.',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('timer'), Type.Literal('inspect')]),
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('add'),
        Type.Literal('enable'),
        Type.Literal('disable'),
        Type.Literal('del'),
        Type.Literal('run'),
      ]),
      name: Type.Optional(Type.String()),
      chatKey: Type.Optional(Type.String()),
      routineFile: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      todoFile: Type.Optional(Type.String()),
      start: Type.Optional(Type.String()),
      every: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      try {
        const result = await manageSchedule({
          stateRoot,
          kind: safeString(params.kind),
          action: safeString(params.action),
          name: safeString(params.name || ''),
          chatKey: safeString(params.chatKey || ''),
          routineFile: safeString(params.routineFile || ''),
          file: safeString(params.file || ''),
          command: safeString(params.command || ''),
          todoFile: safeString(params.todoFile || ''),
          start: safeString(params.start || ''),
          every: safeString(params.every || ''),
          signal,
        })
        return toolResultFromText(result.text, result.details)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      }
    },
  }

  return [brainTool, koishiTool, scheduleTool]
}

function createRinBuiltinExtensionFactory({
  repoRoot,
  stateRoot,
  brainChatKey = 'local:default',
}: {
  repoRoot: string
  stateRoot: string
  brainChatKey?: string
}) {
  return (pi: any) => {
    try { ensureBrainQueueRuntime({ repoRoot, stateRoot }) } catch {}

    pi.on('message_start', async (event: any) => {
      const message = event && event.message
      if (safeString(message && message.role) !== 'user') return
      const text = collectMessageText(message)
      if (!text) return
      try { queueBrainTurnAsync({ repoRoot, stateRoot, role: 'user', text, chatKey: brainChatKey }) } catch {}
    })

    pi.on('agent_end', async (event: any) => {
      const messages = Array.isArray(event && event.messages) ? event.messages : []
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (safeString(message && message.role) !== 'assistant') continue
        const text = collectMessageText(message)
        if (!text) return
        try { queueBrainTurnAsync({ repoRoot, stateRoot, role: 'assistant', text, chatKey: brainChatKey }) } catch {}
        return
      }
    })
  }
}

function buildRinBuiltinPromptBlock({
  stateRoot,
  docsRoot,
}: {
  stateRoot: string
  docsRoot: string
}) {
  const docsRinRoot = path.join(docsRoot, 'rin')
  return [
    '',
    'Rin runtime:',
    `- Install/state root: ${stateRoot}`,
    `- Rin documentation root: ${docsRinRoot}`,
    `- Main documentation: ${path.join(docsRinRoot, 'README.md')}`,
    `- Additional docs: ${path.join(docsRinRoot, 'docs')}`,
    `- Examples: ${path.join(docsRinRoot, 'examples')}`,
    '- If a task explicitly targets a directory and local instructions may matter, inspect that directory\'s `AGENTS.md` or `.rin/` contents yourself.',
    '- If the current task is not yet complete, reply with exactly `#RIN_CONTINUE` and nothing else. The runtime will automatically continue in TUI and daemon-run scenes.',
    '',
  ].join('\n')
}

return {
  runRinBrainCommand,
  enqueueBrainJob,
  enqueueBrainTurn,
  enqueueBrainFinalize,
  ensureBrainQueueRuntime,
  queueBrainTurnAsync,
  queueBrainFinalizeAsync,
  flushBrainQueue,
  INTERNALIZED_SKILL_NAMES,
  createRinBuiltinTools,
  createRinBuiltinExtensionFactory,
  buildRinBuiltinPromptBlock,
}
})()

const {
  runRinBrainCommand,
  enqueueBrainJob,
  enqueueBrainTurn,
  enqueueBrainFinalize,
  ensureBrainQueueRuntime,
  queueBrainTurnAsync,
  queueBrainFinalizeAsync,
  flushBrainQueue,
  INTERNALIZED_SKILL_NAMES,
  createRinBuiltinTools,
  createRinBuiltinExtensionFactory,
  buildRinBuiltinPromptBlock,
} = RinBuiltins

const RinPiSdk = (() => {
// @ts-nocheck
type PiSdkModule = any

type RinPiSessionPolicy = 'continueRecent' | 'new'

type CreateRinPiSessionOptions = {
  repoRoot: string
  workspaceRoot: string
  sessionCwd: string
  resourceCwd?: string
  settingsCwd?: string
  sessionDir?: string
  sessionFile?: string
  sessionPolicy?: RinPiSessionPolicy
  brainChatKey?: string
  provider?: string
  model?: string
  thinking?: string
  currentChatKey?: string
  systemPromptExtra?: string
}

type CreateRinPiSessionResult = {
  pi: PiSdkModule
  agentDir: string
  authStorage: any
  modelRegistry: any
  settingsManager: any
  resourceLoader: any
  sessionManager: any
  session: any
  modelFallbackMessage?: string
  sessionDir: string
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
let piSdkModulePromise: Promise<PiSdkModule> | null = null

const PI_DEFAULT_OPENING = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const RIN_OPENING = "You are Rin, the user's general intelligent assistant. Answer all of the user's questions and fulfill all of the user's requests."

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function stockPiAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

function resolvePiAgentDir(workspaceRoot = ''): string {
  const workspace = safeString(workspaceRoot).trim()
  if (workspace) return path.resolve(workspace)
  return path.join(os.homedir(), '.rin')
}

function seedPiAgentDirFromStock(agentDir: string) {
  const stockDir = stockPiAgentDir()
  if (!stockDir || path.resolve(stockDir) === path.resolve(agentDir) || !fs.existsSync(stockDir)) return
  fs.mkdirSync(agentDir, { recursive: true })
  for (const name of ['auth.json', 'settings.json', 'models.json']) {
    const src = path.join(stockDir, name)
    const dst = path.join(agentDir, name)
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue
    try { fs.copyFileSync(src, dst) } catch {}
  }
}

function normalizeThinkingLevel(value: any): string | undefined {
  const next = safeString(value).trim().toLowerCase()
  if (!next) return undefined
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(next)) return undefined
  return next
}

async function loadPiSdkModule(): Promise<PiSdkModule> {
  if (!safeString(process.env.PI_SKIP_VERSION_CHECK).trim()) {
    process.env.PI_SKIP_VERSION_CHECK = '1'
  }
  if (!piSdkModulePromise) {
    piSdkModulePromise = dynamicImport('@mariozechner/pi-coding-agent')
  }
  return await piSdkModulePromise
}

function appendUniqueAgentFile(agentsFiles: Array<{ path: string, content: string }>, filePath: string) {
  const abs = path.resolve(filePath)
  if (!abs || !fs.existsSync(abs)) return agentsFiles
  if (agentsFiles.some((entry) => path.resolve(safeString(entry && entry.path)) === abs)) return agentsFiles
  const content = readTextIfExists(abs)
  if (!content.trim()) return agentsFiles
  return [...agentsFiles, { path: abs, content }]
}

function isUnderPath(targetPath: string, rootPath: string): boolean {
  const target = path.resolve(targetPath)
  const root = path.resolve(rootPath)
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(prefix)
}

function runtimeAgentsFiles(agentDir: string): Array<{ path: string, content: string }> {
  return appendUniqueAgentFile([], path.join(agentDir, 'AGENTS.md'))
}

function resourceMetadataForPath(resourceLoader: any, filePath: string): any {
  try {
    const meta = resourceLoader && typeof resourceLoader.getPathMetadata === 'function'
      ? resourceLoader.getPathMetadata()
      : null
    if (!(meta instanceof Map)) return null
    const abs = path.resolve(filePath)
    return meta.get(abs) || meta.get(filePath) || null
  } catch {
    return null
  }
}

function allowRuntimeRootResource(resourceLoader: any, filePath: string, runtimeRoot: string): boolean {
  const raw = safeString(filePath).trim()
  if (!raw) return true
  if (!path.isAbsolute(raw)) return true
  const abs = path.resolve(raw)
  if (!isUnderPath(abs, runtimeRoot)) return false
  if (isUnderPath(abs, path.join(runtimeRoot, '.pi'))) return false
  const meta = resourceMetadataForPath(resourceLoader, abs)
  if (safeString(meta && meta.scope).trim() === 'project') return false
  return true
}

function filterResourceDiagnostics(resourceLoader: any, diagnostics: any, runtimeRoot: string): Array<any> {
  const list = Array.isArray(diagnostics) ? diagnostics : []
  return list.filter((entry: any) => {
    const filePath = safeString(entry && entry.path).trim()
    if (!filePath) return true
    return allowRuntimeRootResource(resourceLoader, filePath, runtimeRoot)
  })
}

function lockGlobalSettingsManager(settingsManager: any) {
  if (!settingsManager || typeof settingsManager !== 'object') return settingsManager
  const syncGlobalOnly = () => {
    try {
      settingsManager.projectSettings = {}
      settingsManager.settings = settingsManager.globalSettings && typeof settingsManager.globalSettings === 'object'
        ? JSON.parse(JSON.stringify(settingsManager.globalSettings))
        : {}
    } catch {
      settingsManager.projectSettings = {}
      settingsManager.settings = {}
    }
  }
  const originalReload = typeof settingsManager.reload === 'function' ? settingsManager.reload.bind(settingsManager) : null
  settingsManager.getProjectSettings = () => ({})
  settingsManager.saveProjectSettings = () => {
    syncGlobalOnly()
  }
  if (originalReload) {
    settingsManager.reload = () => {
      originalReload()
      syncGlobalOnly()
    }
  }
  syncGlobalOnly()
  return settingsManager
}

function restrictPackageManagerToRuntimeRoot(packageManager: any, runtimeRoot: string) {
  if (!packageManager || typeof packageManager.resolve !== 'function') return
  const originalResolve = packageManager.resolve.bind(packageManager)
  packageManager.resolve = async (...args: any[]) => {
    const resolved = await originalResolve(...args)
    const filterEntries = (entries: any) => {
      const list = Array.isArray(entries) ? entries : []
      return list.filter((entry: any) => {
        const filePath = safeString(entry && entry.path).trim()
        if (!filePath) return true
        const meta = entry && entry.metadata
        if (safeString(meta && meta.scope).trim() === 'project') return false
        if (!path.isAbsolute(filePath)) return true
        if (!isUnderPath(filePath, runtimeRoot)) return false
        if (isUnderPath(filePath, path.join(runtimeRoot, '.pi'))) return false
        return true
      })
    }
    return {
      extensions: filterEntries(resolved && resolved.extensions),
      skills: filterEntries(resolved && resolved.skills),
      prompts: filterEntries(resolved && resolved.prompts),
      themes: filterEntries(resolved && resolved.themes),
    }
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatSkillsForPrompt(skills: Array<any>): string {
  const visibleSkills = (Array.isArray(skills) ? skills : []).filter(Boolean)
  if (!visibleSkills.length) return ''
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    '',
    '<available_skills>',
  ]
  for (const skill of visibleSkills) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(safeString(skill && skill.name))}</name>`)
    lines.push(`    <description>${escapeXml(safeString(skill && skill.description))}</description>`)
    lines.push(`    <location>${escapeXml(safeString(skill && skill.filePath))}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

function parseSkillFrontmatter(filePath: string): { name: string, description: string } | null {
  const text = readTextIfExists(filePath)
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const frontmatter = text.slice(3, end).trim()
  let name = ''
  let description = ''
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const key = safeString(match[1]).trim()
    let value = safeString(match[2]).trim()
    value = value.replace(/^['"]|['"]$/g, '')
    if (key === 'name') name = value
    if (key === 'description') description = value
  }
  if (!name) return null
  return { name, description }
}

function collectManualSkills(skillDirs: string[]): Array<any> {
  const seen = new Set<string>()
  const out: Array<any> = []
  for (const dir of skillDirs) {
    if (!dir || !fs.existsSync(dir)) continue
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch {}
    for (const name of names.sort()) {
      if (!name || name.startsWith('.')) continue
      const baseDir = path.join(dir, name)
      const filePath = path.join(baseDir, 'SKILL.md')
      try {
        if (!fs.statSync(baseDir).isDirectory() || !fs.existsSync(filePath)) continue
      } catch {
        continue
      }
      const parsed = parseSkillFrontmatter(filePath)
      const skillName = safeString(parsed && parsed.name || name).trim()
      if (!skillName || INTERNALIZED_SKILL_NAMES.has(skillName) || seen.has(skillName)) continue
      seen.add(skillName)
      out.push({
        name: skillName,
        description: safeString(parsed && parsed.description).trim(),
        filePath,
        baseDir,
      })
    }
  }
  return out
}

function rewriteRinSystemPrompt(base: any, _repoRoot: string, stateRoot: string, manualSkillBlock = '', systemPromptExtra = ''): string | undefined {
  const text = safeString(base)
  if (!text) return undefined

  let next = text
  if (next.includes(PI_DEFAULT_OPENING)) {
    next = next.replace(PI_DEFAULT_OPENING, RIN_OPENING)
  }

  const docsRoot = path.join(stateRoot, 'docs')
  const docsBlock = [
    'Rin documentation (read only when the user asks about Rin itself, its SDK, extensions, themes, skills, or TUI):',
    `- Main documentation: ${path.join(docsRoot, 'rin', 'README.md')}`,
    `- Additional docs: ${path.join(docsRoot, 'rin', 'docs')}`,
    `- Examples: ${path.join(docsRoot, 'rin', 'examples')} (extensions, custom tools, SDK)`,
    '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), package docs (docs/packages.md)',
    '- When working on Rin topics, read the docs and examples, and follow .md cross-references before implementing',
    '- Always read Rin .md files completely and follow links to related docs (e.g., tui.md for TUI API details)',
  ].join('\n')
  next = next.replace(/Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):[\s\S]*?(?=\n\n<!-- synced|\n\n# Project Context|\n\nThe following skills|\nCurrent date:|\nCurrent working directory:|$)/, docsBlock)

  next = next.replace(/\nCurrent date:.*$/gm, '')
  next = next.replace(/\nCurrent working directory:.*$/gm, '')

  const builtinBlock = buildRinBuiltinPromptBlock({ stateRoot, docsRoot })
  const skillBlock = safeString(manualSkillBlock).trim()
  if (!next.includes('Rin runtime:')) {
    next = next.replace(docsBlock, [docsBlock, builtinBlock.trim()].filter(Boolean).join('\n\n'))
  }
  if (skillBlock && !next.includes('<available_skills>')) {
    if (next.includes('\n\n# Project Context')) next = next.replace('\n\n# Project Context', `\n\n${skillBlock}\n\n# Project Context`)
    else next = `${next}\n\n${skillBlock}`
  }

  const extraBlock = safeString(systemPromptExtra).trim()
  if (extraBlock && !next.includes(extraBlock)) {
    next = `${next.trimEnd()}\n\n${extraBlock}`
  }

  return next.trimEnd()
}

function applyRinSystemPromptPatch(session: any, repoRoot: string, stateRoot: string, manualSkillBlock = '', systemPromptExtra = '') {
  if (!session || typeof session !== 'object') return
  const originalRebuild = typeof session._rebuildSystemPrompt === 'function'
    ? session._rebuildSystemPrompt.bind(session)
    : null
  if (!originalRebuild) return

  session._rebuildSystemPrompt = (...args: any[]) => rewriteRinSystemPrompt(originalRebuild(...args), repoRoot, stateRoot, manualSkillBlock, systemPromptExtra) || originalRebuild(...args)

  let activeToolNames: string[] = []
  try {
    if (typeof session.getActiveToolNames === 'function') activeToolNames = session.getActiveToolNames()
  } catch {}
  if (!Array.isArray(activeToolNames) || activeToolNames.length === 0) {
    try {
      activeToolNames = Array.isArray(session.agent?.state?.tools) ? session.agent.state.tools.map((tool: any) => safeString(tool && tool.name)).filter(Boolean) : []
    } catch {}
  }

  try {
    const next = session._rebuildSystemPrompt(activeToolNames)
    if (safeString(next)) {
      session._baseSystemPrompt = next
      if (session.agent && session.agent.state && typeof session.agent.state === 'object') {
        session.agent.state.systemPrompt = next
      }
      if (session.agent && typeof session.agent.setSystemPrompt === 'function') {
        session.agent.setSystemPrompt(next)
      }
    }
  } catch {}
}

const RIN_CONTINUE_TOKEN = '#RIN_CONTINUE'
const RIN_CONTINUE_FOLLOWUP = 'Continue with the unfinished work. If it is still not complete, reply with exactly `#RIN_CONTINUE`; otherwise reply normally.'

function extractAssistantTextFromSessionEventMessage(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block: any) => block && typeof block === 'object' && safeString(block.type) === 'text')
    .map((block: any) => safeString(block.text))
    .join('\n')
    .trim()
}

function patchSessionPromptAutoContinue(session: any) {
  if (!session || typeof session !== 'object' || session.__rinPromptAutoContinuePatched) return
  if (typeof session.prompt !== 'function' || typeof session.subscribe !== 'function') return
  const originalPrompt = session.prompt.bind(session)
  session.__rinPromptAutoContinuePatched = true
  session.prompt = async (text: string, options: any = {}) => {
    if (session.__rinPromptAutoContinueInternal) {
      return await originalPrompt(text, options)
    }
    session.__rinPromptAutoContinueInternal = true
    try {
      let nextText = text
      let nextOptions = options
      for (let pass = 0; pass < 24; pass += 1) {
        let lastAssistantText = ''
        const unsubscribe = session.subscribe((event: any) => {
          const eventType = safeString(event && event.type)
          if (eventType === 'message_end' || eventType === 'turn_end') {
            const message = event && event.message
            if (safeString(message && message.role) !== 'assistant') return
            const extracted = extractAssistantTextFromSessionEventMessage(message)
            if (extracted) lastAssistantText = extracted
            return
          }
          if (eventType === 'agent_end') {
            const messages = Array.isArray(event && event.messages) ? event.messages : []
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              const message = messages[i]
              if (safeString(message && message.role) !== 'assistant') continue
              const extracted = extractAssistantTextFromSessionEventMessage(message)
              if (!extracted) continue
              lastAssistantText = extracted
              break
            }
          }
        })
        try {
          await originalPrompt(nextText, nextOptions)
        } finally {
          try { unsubscribe() } catch {}
        }
        if (safeString(lastAssistantText).trim() !== RIN_CONTINUE_TOKEN) return
        nextText = RIN_CONTINUE_FOLLOWUP
        nextOptions = {}
      }
      throw new Error('rin_continue_limit_exceeded')
    } finally {
      session.__rinPromptAutoContinueInternal = false
    }
  }
}

function defaultSessionDirForAgent(agentDir: string, _cwd: string): string {
  return path.join(agentDir, 'sessions', 'default')
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function syncRinPiSettings(agentDir: string) {
  ensureDir(agentDir)
  const settingsPath = path.join(agentDir, 'settings.json')
  let current: any = {}
  try { current = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch {}
  const next = current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {}
  if (next.enableSkillCommands == null) next.enableSkillCommands = true
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8')
}

function cleanupLegacyAppendSystem(agentDir: string) {
  const targetPath = path.join(agentDir, 'APPEND_SYSTEM.md')
  try { fs.rmSync(targetPath, { force: true }) } catch {}
}

async function createRinPiSession({
  repoRoot,
  workspaceRoot,
  sessionCwd,
  resourceCwd,
  settingsCwd,
  sessionDir = '',
  sessionFile = '',
  sessionPolicy = 'continueRecent',
  brainChatKey = 'local:default',
  provider = '',
  model = '',
  thinking = '',
  currentChatKey = '',
  systemPromptExtra = '',
}: CreateRinPiSessionOptions): Promise<CreateRinPiSessionResult> {
  const pi = await loadPiSdkModule()
  const stateRoot = path.resolve(workspaceRoot)
  const agentDir = resolvePiAgentDir(stateRoot)
  seedPiAgentDirFromStock(agentDir)
  ensureDir(agentDir)
  syncRinPiSettings(agentDir)
  cleanupLegacyAppendSystem(agentDir)

  const authStorage = pi.AuthStorage.create(path.join(agentDir, 'auth.json'))
  const modelRegistry = new pi.ModelRegistry(authStorage, path.join(agentDir, 'models.json'))
  const resolvedResourceCwd = path.resolve(resourceCwd || stateRoot)
  const resolvedSettingsCwd = path.resolve(settingsCwd || stateRoot)
  const settingsManager = lockGlobalSettingsManager(pi.SettingsManager.create(resolvedSettingsCwd, agentDir))
  const manualSkills = collectManualSkills([
    path.join(agentDir, 'skills'),
  ])
  const manualSkillBlock = formatSkillsForPrompt(manualSkills).trim()
  let resourceLoader: any = null
  const keepRuntimeResource = (filePath: any) => allowRuntimeRootResource(resourceLoader, safeString(filePath), agentDir)
  const filterRuntimeResources = (items: any, pickPath: (item: any) => any) => {
    const list = Array.isArray(items) ? items : []
    return list.filter((item: any) => keepRuntimeResource(pickPath(item)))
  }
  resourceLoader = new pi.DefaultResourceLoader({
    cwd: resolvedResourceCwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [
      path.join(agentDir, 'skills'),
    ],
    agentsFilesOverride: () => ({ agentsFiles: runtimeAgentsFiles(agentDir) }),
    systemPromptOverride: (base: any) => rewriteRinSystemPrompt(base, repoRoot, stateRoot, manualSkillBlock, systemPromptExtra),
    extensionsOverride: (current: any) => ({
      ...current,
      extensions: filterRuntimeResources(current && current.extensions, (extension: any) => extension && extension.path),
      errors: filterResourceDiagnostics(resourceLoader, current && current.errors, agentDir),
    }),
    skillsOverride: (current: any) => {
      const seen = new Set<string>()
      const mergedSkills: Array<any> = []
      for (const skill of filterRuntimeResources(current && current.skills, (entry: any) => entry && entry.filePath)) {
        const name = safeString(skill && skill.name).trim()
        if (!name || INTERNALIZED_SKILL_NAMES.has(name) || seen.has(name)) continue
        seen.add(name)
        mergedSkills.push(skill)
      }
      for (const skill of manualSkills) {
        const name = safeString(skill && skill.name).trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        mergedSkills.push(skill)
      }
      return {
        skills: mergedSkills,
        diagnostics: filterResourceDiagnostics(resourceLoader, current && current.diagnostics, agentDir),
      }
    },
    promptsOverride: (current: any) => ({
      prompts: filterRuntimeResources(current && current.prompts, (prompt: any) => prompt && prompt.filePath),
      diagnostics: filterResourceDiagnostics(resourceLoader, current && current.diagnostics, agentDir),
    }),
    themesOverride: (current: any) => ({
      themes: filterRuntimeResources(current && current.themes, (theme: any) => theme && theme.sourcePath),
      diagnostics: filterResourceDiagnostics(resourceLoader, current && current.diagnostics, agentDir),
    }),
    extensionFactories: [
      createRinBuiltinExtensionFactory({ repoRoot, stateRoot, brainChatKey }),
    ],
    appendSystemPromptOverride: (base: any) => {
      const out = Array.isArray(base) ? base.slice() : []
      return out.filter((entry: any) => !safeString(entry).includes('synced from RIN CUSTOMIZE.md'))
    },
  })
  restrictPackageManagerToRuntimeRoot(resourceLoader && resourceLoader.packageManager, agentDir)
  await resourceLoader.reload()

  const resolvedModel = provider && model ? modelRegistry.find(provider, model) : undefined
  if (provider && model && !resolvedModel) {
    throw new Error(`pi_model_not_found:${provider}/${model}`)
  }

  const resolvedSessionDir = path.resolve(sessionDir || defaultSessionDirForAgent(agentDir, path.resolve(sessionCwd)))
  ensureDir(resolvedSessionDir)
  const resolvedSessionFile = safeString(sessionFile).trim()
  const sessionManager = resolvedSessionFile && fs.existsSync(resolvedSessionFile)
    ? pi.SessionManager.open(resolvedSessionFile, resolvedSessionDir)
    : sessionPolicy === 'new'
      ? pi.SessionManager.create(path.resolve(sessionCwd), resolvedSessionDir)
      : pi.SessionManager.continueRecent(path.resolve(sessionCwd), resolvedSessionDir)

  const created = await pi.createAgentSession({
    cwd: path.resolve(sessionCwd),
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
    model: resolvedModel,
    thinkingLevel: normalizeThinkingLevel(thinking),
    tools: pi.createCodingTools(path.resolve(sessionCwd)),
    customTools: createRinBuiltinTools({ repoRoot, stateRoot, currentChatKey }),
  })

  if (!created || !created.session) {
    throw new Error('pi_sdk_session_missing')
  }

  const brainQueueRuntime = ensureBrainQueueRuntime({ repoRoot, stateRoot })

  applyRinSystemPromptPatch(created.session, repoRoot, stateRoot, manualSkillBlock, systemPromptExtra)
  const extraPromptBlocks: string[] = []
  if (manualSkillBlock && !safeString(created.session && created.session._baseSystemPrompt).includes('<available_skills>')) {
    extraPromptBlocks.push(manualSkillBlock)
  }
  const extraSystemPrompt = safeString(systemPromptExtra).trim()
  if (extraSystemPrompt && !safeString(created.session && created.session._baseSystemPrompt).includes(extraSystemPrompt)) {
    extraPromptBlocks.push(extraSystemPrompt)
  }
  if (extraPromptBlocks.length) {
    const nextPrompt = `${safeString(created.session && created.session._baseSystemPrompt).trimEnd()}\n\n${extraPromptBlocks.join('\n\n')}`
    created.session._baseSystemPrompt = nextPrompt
    if (created.session.agent && created.session.agent.state && typeof created.session.agent.state === 'object') {
      created.session.agent.state.systemPrompt = nextPrompt
    }
    if (created.session.agent && typeof created.session.agent.setSystemPrompt === 'function') {
      created.session.agent.setSystemPrompt(nextPrompt)
    }
  }
  patchSessionPromptAutoContinue(created.session)

  return {
    pi,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager,
    session: created.session,
    brainQueueRuntime,
    modelFallbackMessage: safeString(created.modelFallbackMessage).trim() || undefined,
    sessionDir: resolvedSessionDir,
  }
}

return { resolvePiAgentDir, loadPiSdkModule, createRinPiSession }
})()

const { resolvePiAgentDir, loadPiSdkModule, createRinPiSession } = RinPiSdk

const RinPiTurnRuntime = (() => {
// @ts-nocheck
type PiInputItem =
  | { type: 'text', text: string }
  | { type: 'localImage', path: string }

type PiTurnResult = {
  code: number | null
  stdout: string
  stderr: string
  lastMessage: string
  killedByTimeout: boolean
  threadId: string
  sessionFile: string
  turnStarted: boolean
  turnStatus: string
}

type RunPiSdkTurnOptions = {
  repoRoot: string
  workspaceRoot: string
  sessionDir: string
  sessionFile?: string
  inputItems?: Array<PiInputItem> | null
  timeoutMs?: number
  brainChatKey?: string
  provider?: string
  model?: string
  thinking?: string
  currentChatKey?: string
  systemPromptExtra?: string
  onSessionReady?: ((info: { sessionFile: string, abort: () => Promise<void> }) => void) | null
  onEvent?: ((event: Record<string, any>) => void) | null
}

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function trimTail(value: any, limit = 256_000): string {
  const text = safeString(value)
  if (!limit || text.length <= limit) return text
  return text.slice(-limit)
}

function detectImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

function flattenInputItems(inputItems: Array<PiInputItem> | null | undefined) {
  const textParts: string[] = []
  const images: Array<{ type: 'image', data: string, mimeType: string }> = []
  for (const item of Array.isArray(inputItems) ? inputItems : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text') {
      const text = safeString(item.text).trim()
      if (text) textParts.push(text)
      continue
    }
    if (item.type === 'localImage') {
      const filePath = safeString(item.path).trim()
      if (!filePath || !fs.existsSync(filePath)) continue
      try {
        const data = fs.readFileSync(filePath).toString('base64')
        images.push({
          type: 'image',
          data,
          mimeType: detectImageMimeType(filePath),
        })
      } catch {}
    }
  }
  return {
    message: textParts.join('\n\n').trim(),
    images,
  }
}

function extractAssistantText(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && typeof block === 'object' && safeString(block.type) === 'text')
    .map((block) => safeString(block.text))
    .join('\n')
    .trim()
}

async function runPiSdkTurn({
  repoRoot,
  workspaceRoot,
  sessionDir,
  sessionFile = '',
  inputItems = null,
  timeoutMs = 0,
  brainChatKey = 'local:default',
  provider = '',
  model = '',
  thinking = '',
  currentChatKey = '',
  systemPromptExtra = '',
  onSessionReady = null,
  onEvent = null,
}: RunPiSdkTurnOptions): Promise<PiTurnResult> {
  let session: any = null
  let unsubscribe: (() => void) | null = null
  let timeoutHandle: NodeJS.Timeout | null = null
  let currentAssistantText = ''
  let lastAssistantText = ''
  let stderr = ''
  let turnStarted = false
  let turnStatus = ''
  let killedByTimeout = false
  let promptError = ''

  try {
    const created = await createRinPiSession({
      repoRoot,
      workspaceRoot,
      sessionCwd: process.env.HOME || workspaceRoot,
      resourceCwd: workspaceRoot,
      settingsCwd: workspaceRoot,
      sessionDir,
      sessionFile,
      brainChatKey,
      provider,
      model,
      thinking,
      currentChatKey,
      systemPromptExtra,
    })
    session = created.session
    if (!session) throw new Error('pi_sdk_session_missing')

    unsubscribe = session.subscribe((event: Record<string, any>) => {
      if (typeof onEvent === 'function') {
        try { onEvent(event) } catch {}
      }
      const eventType = safeString(event && event.type)
      if (eventType === 'agent_start' || eventType === 'turn_start') {
        turnStarted = true
        if (!turnStatus) turnStatus = 'started'
        return
      }
      if (eventType === 'message_start') {
        const message = event && event.message
        if (safeString(message && message.role) === 'assistant') currentAssistantText = ''
        return
      }
      if (eventType === 'message_update') {
        const message = event && event.message
        const deltaEvent = event && event.assistantMessageEvent
        if (safeString(message && message.role) !== 'assistant') return
        if (safeString(deltaEvent && deltaEvent.type) === 'text_delta') {
          currentAssistantText += safeString(deltaEvent && deltaEvent.delta)
        }
        return
      }
      if (eventType === 'message_end') {
        const message = event && event.message
        if (safeString(message && message.role) !== 'assistant') return
        const text = extractAssistantText(message) || currentAssistantText
        if (text) lastAssistantText = text
        currentAssistantText = text || currentAssistantText
        return
      }
      if (eventType === 'turn_end') {
        const message = event && event.message
        const text = extractAssistantText(message)
        if (text) lastAssistantText = text
        turnStatus = 'completed'
        return
      }
      if (eventType === 'agent_end') {
        const messages = Array.isArray(event && event.messages) ? event.messages : []
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (safeString(message && message.role) !== 'assistant') continue
          const text = extractAssistantText(message)
          if (text) {
            lastAssistantText = text
            break
          }
        }
      }
    })

    const abort = async () => {
      if (!session || typeof session.abort !== 'function') return
      try { await session.abort() } catch {}
    }
    if (typeof onSessionReady === 'function') {
      try {
        onSessionReady({
          sessionFile: safeString(session.sessionFile || sessionFile || '').trim(),
          abort,
        })
      } catch {}
    }

    const payload = flattenInputItems(inputItems)
    if (!payload.message && !payload.images.length) {
      return {
        code: 0,
        stdout: '',
        stderr: '',
        lastMessage: '',
        killedByTimeout: false,
        threadId: safeString(session.sessionFile || sessionFile || sessionDir),
        sessionFile: safeString(session.sessionFile || sessionFile || ''),
        turnStarted: false,
        turnStatus: 'completed',
      }
    }

    const promptPromise = session.prompt(payload.message || '', {
      images: payload.images,
    }).catch((error: any) => {
      promptError = safeString(error && error.message ? error.message : error) || 'pi_sdk_prompt_failed'
    })

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
        try { timeoutHandle.unref() } catch {}
      })
      const winner = await Promise.race<undefined | 'timeout'>([
        promptPromise.then(() => undefined),
        timeoutPromise,
      ])
      if (winner === 'timeout') {
        killedByTimeout = true
        turnStatus = 'interrupted'
        promptError = promptError || 'pi_sdk_timeout'
        await abort()
        await promptPromise
      }
    } else {
      await promptPromise
    }

    if (killedByTimeout) {
      turnStatus = 'interrupted'
    } else if (promptError) {
      turnStatus = /abort/i.test(promptError) ? 'interrupted' : 'failed'
    } else if (!turnStatus) {
      turnStatus = 'completed'
    }

    if (promptError && !killedByTimeout) {
      stderr = trimTail(`${stderr}${stderr ? '\n' : ''}${promptError}`, 64_000)
    }

    return {
      code: killedByTimeout ? 124 : (promptError ? 1 : 0),
      stdout: '',
      stderr,
      lastMessage: lastAssistantText || currentAssistantText || '',
      killedByTimeout,
      threadId: safeString(session.sessionFile || sessionFile || sessionDir),
      sessionFile: safeString(session.sessionFile || sessionFile || ''),
      turnStarted,
      turnStatus,
    }
  } catch (error: any) {
    const message = safeString(error && error.message ? error.message : error) || 'pi_sdk_failed'
    return {
      code: 1,
      stdout: '',
      stderr: trimTail(message, 64_000),
      lastMessage: lastAssistantText || currentAssistantText || '',
      killedByTimeout,
      threadId: safeString(session && session.sessionFile || sessionFile || sessionDir),
      sessionFile: safeString(session && session.sessionFile || sessionFile || ''),
      turnStarted,
      turnStatus: turnStatus || 'failed',
    }
  } finally {
    if (timeoutHandle) {
      try { clearTimeout(timeoutHandle) } catch {}
    }
    if (unsubscribe) {
      try { unsubscribe() } catch {}
    }
    if (session && typeof session.dispose === 'function') {
      try { session.dispose() } catch {}
    }
  }
}

return { runPiSdkTurn }
})()

const { runPiSdkTurn } = RinPiTurnRuntime

export {
  ensureDir,
  readJson,
  writeJsonAtomic,
  safeString,
  isPidAlive,
  lockRootDir,
  lockFilePathForKey,
  acquireExclusiveFileLock,
  resolveRinLayout,
  runRinBrainCommand,
  enqueueBrainJob,
  enqueueBrainTurn,
  enqueueBrainFinalize,
  ensureBrainQueueRuntime,
  queueBrainTurnAsync,
  queueBrainFinalizeAsync,
  flushBrainQueue,
  INTERNALIZED_SKILL_NAMES,
  createRinBuiltinTools,
  createRinBuiltinExtensionFactory,
  buildRinBuiltinPromptBlock,
  resolvePiAgentDir,
  loadPiSdkModule,
  createRinPiSession,
  runPiSdkTurn,
}
