// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'
import net from 'node:net'
import nodeUtil from 'node:util'

import { Type } from '@sinclair/typebox'

const EXPORTED_RIN_CONTINUE_TOKEN = '#RIN_CONTINUE'
const EXPORTED_RIN_CONTINUE_FOLLOWUP = 'Continue unfinished work. If still incomplete, reply exactly `#RIN_CONTINUE`.'

import {
  acquireExclusiveFileLock,
  ensureDir,
  isPidAlive,
  lockFilePathForKey,
  lockRootDir,
  readJson,
  resolveRinLayout,
  safeString,
  writeJsonAtomic,
} from './runtime-paths'
import { runBrainCli } from './brain'
import {
  createContinueEventFilter,
  discardTrailingContinueAssistant,
  extractAssistantTextFromMessage,
} from './continue-control'
import { promptSessionWithRetry } from './session-prompt'
import { searchWeb } from './web-search'

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
  'web-search',
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

let brainCommandSerial: Promise<void> = Promise.resolve()

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
  void repoRoot
  if (signal?.aborted) return { code: 1, stdout: '', stderr: 'aborted' }
  const previous = brainCommandSerial
  let release!: () => void
  brainCommandSerial = new Promise<void>((resolve) => { release = resolve })
  await previous
  let stdout = ''
  let stderr = ''
  const originalLog = console.log
  const originalError = console.error
  const append = (target: 'stdout' | 'stderr', parts: any[]) => {
    const text = nodeUtil.format(...parts)
    if (target === 'stdout') stdout += `${text}\n`
    else stderr += `${text}\n`
  }
  try {
    console.log = (...parts: any[]) => { append('stdout', parts) }
    console.error = (...parts: any[]) => { append('stderr', parts) }
    const originalRepoRoot = process.env.RIN_REPO_ROOT
    const originalSkipVersion = process.env.PI_SKIP_VERSION_CHECK
    const originalMem0Telemetry = process.env.MEM0_TELEMETRY
    try {
      process.env.RIN_REPO_ROOT = repoRoot
      process.env.PI_SKIP_VERSION_CHECK = safeString(process.env.PI_SKIP_VERSION_CHECK || '1') || '1'
      process.env.MEM0_TELEMETRY = safeString(process.env.MEM0_TELEMETRY || 'false') || 'false'
      const code = await runBrainCli(args, stateRoot)
      return { code: Number(code ?? 0), stdout: trimText(stdout), stderr: trimText(stderr) }
    } finally {
      if (originalRepoRoot == null) delete process.env.RIN_REPO_ROOT
      else process.env.RIN_REPO_ROOT = originalRepoRoot
      if (originalSkipVersion == null) delete process.env.PI_SKIP_VERSION_CHECK
      else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersion
      if (originalMem0Telemetry == null) delete process.env.MEM0_TELEMETRY
      else process.env.MEM0_TELEMETRY = originalMem0Telemetry
    }
  } catch (error: any) {
    append('stderr', [safeString(error && error.message ? error.message : error)])
    return { code: 1, stdout: trimText(stdout), stderr: trimText(stderr) }
  } finally {
    console.log = originalLog
    console.error = originalError
    release()
  }
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

type TranscriptEntry = {
  ts: number
  iso: string
  role: string
  text: string
  source: 'session' | 'chat'
  filePath: string
  messageId?: string
}

function extractTranscriptText(message: any): string {
  if (!message) return ''
  const content = Array.isArray(message.content) ? message.content : []
  if (typeof message.content === 'string') return safeString(message.content).trim()
  const out: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') out.push(safeString(block.text))
  }
  return out.join('\n').trim()
}

function readSessionTranscriptFile(filePath: string): TranscriptEntry[] {
  if (!filePath || !fs.existsSync(filePath)) return []
  const text = fs.readFileSync(filePath, 'utf8')
  const rows: TranscriptEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (safeString(parsed && parsed.type) !== 'message') continue
      const message = parsed && parsed.message
      const role = safeString(message && message.role)
      if (!['user', 'assistant', 'toolResult'].includes(role)) continue
      const body = extractTranscriptText(message)
      if (!body) continue
      const iso = safeString(parsed && parsed.timestamp) || new Date(Number(message && message.timestamp || Date.now())).toISOString()
      const ts = Date.parse(iso) || Number(message && message.timestamp || 0) || Date.now()
      rows.push({ ts, iso: new Date(ts).toISOString(), role, text: body, source: 'session', filePath })
    } catch {}
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

function findLatestSessionFile(sessionDir: string): string {
  const dir = safeString(sessionDir).trim()
  if (!dir || !fs.existsSync(dir)) return ''
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
  return files.length ? path.join(dir, files[files.length - 1]) : ''
}

function readChatTranscriptFiles(stateRoot: string, chatKey: string): TranscriptEntry[] {
  const key = safeString(chatKey).trim()
  const match = key.match(/^([^/:]+)(?:\/([^:]+))?:(.+)$/)
  if (!match) return []
  const [, platform, botId = '', chatId] = match
  const logsDir = botId
    ? path.join(stateRoot, 'data', 'chats', platform, botId, chatId, 'logs')
    : path.join(stateRoot, 'data', 'chats', platform, chatId, 'logs')
  if (!fs.existsSync(logsDir)) return []
  const files = fs.readdirSync(logsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
  const rows: TranscriptEntry[] = []
  for (const name of files) {
    const filePath = path.join(logsDir, name)
    const text = fs.readFileSync(filePath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const body = safeString(parsed && parsed.text).trim()
        if (!body) continue
        const senderTrust = safeString(parsed && parsed.sender && parsed.sender.trust)
        const role = senderTrust === 'BOT' ? 'assistant' : 'user'
        const ts = Number(parsed && parsed.ts || 0) * 1000
        const iso = ts > 0 ? new Date(ts).toISOString() : new Date().toISOString()
        rows.push({ ts: ts || Date.now(), iso, role, text: body, source: 'chat', filePath, messageId: safeString(parsed && parsed.messageId) || undefined })
      } catch {}
    }
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

function transcriptSearchScore(query: string, entry: TranscriptEntry): number {
  const needle = safeString(query).trim().toLowerCase()
  if (!needle) return 0
  const hay = `${entry.role} ${entry.text}`.toLowerCase()
  if (hay.includes(needle)) return 10 + (entry.ts / 1e15)
  const parts = needle.split(/\s+/).filter(Boolean)
  if (!parts.length) return 0
  let hits = 0
  for (const part of parts) {
    if (hay.includes(part)) hits += 1
  }
  if (!hits) return 0
  return hits + (entry.ts / 1e15)
}

function formatTranscriptEntries(rows: TranscriptEntry[]): string {
  if (!rows.length) return 'No transcript entries found.'
  return rows.map((row) => `[${row.iso}] ${row.role}: ${row.text}`).join('\n\n')
}

function readConversationTranscript({
  stateRoot,
  currentChatKey = '',
  sessionDir = '',
  sessionFile = '',
  source = 'auto',
}: {
  stateRoot: string
  currentChatKey?: string
  sessionDir?: string
  sessionFile?: string
  source?: string
}): TranscriptEntry[] {
  const mode = safeString(source).trim() || 'auto'
  const rows: TranscriptEntry[] = []
  if (mode === 'auto' || mode === 'session') {
    const effectiveSessionFile = safeString(sessionFile).trim() || findLatestSessionFile(sessionDir)
    if (effectiveSessionFile) rows.push(...readSessionTranscriptFile(effectiveSessionFile))
  }
  if ((mode === 'auto' || mode === 'chat') && safeString(currentChatKey).trim()) {
    rows.push(...readChatTranscriptFiles(stateRoot, currentChatKey))
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
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

  if (nextAction === 'delete') {
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

  if (nextAction !== 'create') throw new Error(`invalid_schedule_action:${nextAction}`)

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

function createRinBuiltinTools({
  repoRoot,
  stateRoot,
  currentChatKey = '',
  sessionDir = '',
  sessionFile = '',
  pi,
  agentDir,
  authStorage,
  modelRegistry,
  resourceLoader,
  sessionManager,
  sessionRef,
}: {
  repoRoot: string
  stateRoot: string
  currentChatKey?: string
  sessionDir?: string
  sessionFile?: string
  pi: any
  agentDir: string
  authStorage: any
  modelRegistry: any
  resourceLoader: any
  sessionManager?: any
  sessionRef?: { current: any }
}) {
  function isHiddenSkillPathLocal(filePath: any): boolean {
    const raw = safeString(filePath).trim()
    if (!raw) return false
    return path.resolve(raw).split(path.sep).filter(Boolean).includes('.hidden')
  }

  function normalizeSkillRecordLocal(skill: any): any {
    if (!skill || typeof skill !== 'object') return null
    const filePath = safeString(skill && skill.filePath).trim()
    const baseDir = safeString(skill && skill.baseDir).trim() || (filePath ? path.dirname(filePath) : '')
    const hidden = Boolean(skill && skill.disableModelInvocation) || isHiddenSkillPathLocal(filePath) || isHiddenSkillPathLocal(baseDir)
    return {
      ...skill,
      name: safeString(skill && skill.name).trim(),
      description: safeString(skill && skill.description).trim(),
      filePath,
      baseDir,
      disableModelInvocation: hidden,
    }
  }

  function stripSkillFrontmatterLocal(text: string): string {
    if (!text.startsWith('---')) return text.trim()
    const end = text.indexOf('\n---', 3)
    if (end < 0) return text.trim()
    return text.slice(end + 4).trim()
  }

  function listRuntimeSkills() {
    const loaded = resourceLoader && typeof resourceLoader.getSkills === 'function'
      ? resourceLoader.getSkills()
      : { skills: [] }
    const skills = Array.isArray(loaded && loaded.skills) ? loaded.skills : []
    return skills
      .map((skill: any) => normalizeSkillRecordLocal(skill))
      .filter((skill: any) => skill && safeString(skill.name).trim() && !INTERNALIZED_SKILL_NAMES.has(safeString(skill.name).trim()))
      .sort((a: any, b: any) => safeString(a && a.name).trim().localeCompare(safeString(b && b.name).trim()))
  }

  function resolveSkillLinkTarget(rawTarget: string): string {
    let target = safeString(rawTarget).trim()
    if (!target) return ''
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
    if (!target || target.startsWith('#')) return ''
    if (/^(?:[a-z]+:)?\/\//i.test(target) || /^(?:mailto|data|javascript):/i.test(target)) return ''
    target = target.replace(/[?#].*$/, '').trim()
    return target
  }

  function collectSkillReferences(skillBody: string, baseDir: string) {
    const matches = new Map<string, any>()
    const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g
    for (const match of skillBody.matchAll(linkPattern)) {
      const rawTarget = safeString(match && match[1]).trim()
      const target = resolveSkillLinkTarget(rawTarget)
      if (!target) continue
      const resolvedPath = path.resolve(baseDir || process.cwd(), target)
      if (matches.has(resolvedPath)) continue
      let exists = false
      let stat: fs.Stats | null = null
      try {
        stat = fs.statSync(resolvedPath)
        exists = true
      } catch {}
      matches.set(resolvedPath, {
        path: resolvedPath,
        relativePath: baseDir ? path.relative(baseDir, resolvedPath) || path.basename(resolvedPath) : target,
        exists,
        kind: exists && stat
          ? stat.isDirectory()
            ? 'directory'
            : path.extname(resolvedPath).slice(1).toLowerCase() || 'file'
          : 'missing',
      })
    }
    return [...matches.values()]
  }

  const brainTool = {
    name: 'rin_brain',
    label: 'Rin Brain',
    description: 'Retrieve or store long-term memory, summarized past events, and indexed knowledge. Do not use this for verbatim transcript reads.',
    promptSnippet: 'Retrieve or store long-term memory, summarized past events, and indexed knowledge.',
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
    description: 'Send bridge messages, fetch one bridged message by chatKey and messageId, or manage trusted platform identities.',
    promptSnippet: 'Send bridge messages, fetch one bridged message, or manage trusted platform identities.',
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

  const historyTool = {
    name: 'rin_history',
    label: 'Rin History',
    description: 'Read recent raw conversation transcript entries from the active local session or active chat logs.',
    promptSnippet: 'Read recent raw conversation transcript entries from the active local session or active chat logs.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('recent'),
        Type.Literal('search'),
      ]),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1 })),
      source: Type.Optional(Type.Union([
        Type.Literal('auto'),
        Type.Literal('session'),
        Type.Literal('chat'),
      ])),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const action = safeString(params && params.action).trim()
      const limit = Math.max(1, Number(params && params.limit || 10) || 10)
      const source = safeString(params && params.source || 'auto').trim() || 'auto'
      const rows = readConversationTranscript({ stateRoot, currentChatKey, sessionDir, sessionFile, source })
      if (action === 'recent') {
        const picked = rows.slice(-limit)
        return toolResultFromText(formatTranscriptEntries(picked), {
          action,
          source,
          count: picked.length,
          entries: picked,
        })
      }
      if (action === 'search') {
        const query = safeString(params && params.query).trim()
        if (!query) return toolResultFromText('missing_query', {}, true)
        const picked = rows
          .map((row) => ({ row, score: transcriptSearchScore(query, row) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => Number(b.score) - Number(a.score) || b.row.ts - a.row.ts)
          .slice(0, limit)
          .map((entry) => entry.row)
          .sort((a, b) => a.ts - b.ts)
        return toolResultFromText(formatTranscriptEntries(picked), {
          action,
          source,
          query,
          count: picked.length,
          entries: picked,
        }, picked.length === 0)
      }
      return toolResultFromText('unsupported_action', {}, true)
    },
  }

  const scheduleTool = {
    name: 'rin_schedule',
    label: 'Rin Schedule',
    description: 'List, create, enable, disable, delete, or run timers and inspect scheduled jobs.',
    promptSnippet: 'List, create, enable, disable, delete, or run timers and inspect scheduled jobs.',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('timer'), Type.Literal('inspect')]),
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('create'),
        Type.Literal('enable'),
        Type.Literal('disable'),
        Type.Literal('delete'),
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

  const webSearchTool = {
    name: 'rin_web_search',
    label: 'Web Search',
    description: 'Search the live public web for current information, official documentation, release notes, pricing, or source-backed verification.',
    promptSnippet: 'Search the live public web for current information, official documentation, release notes, pricing, or source-backed verification.',
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      freshness: Type.Optional(Type.Union([
        Type.Literal('day'),
        Type.Literal('week'),
        Type.Literal('month'),
        Type.Literal('year'),
      ])),
      safe: Type.Optional(Type.Union([
        Type.Literal('off'),
        Type.Literal('moderate'),
        Type.Literal('strict'),
      ])),
      provider: Type.Optional(Type.String()),
      providers: Type.Optional(Type.Array(Type.String())),
      noCache: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId: string, params: any, _signal?: AbortSignal) => {
      try {
        const result = await searchWeb({
          stateRoot,
          query: safeString(params && params.query || ''),
          limit: params && params.limit != null ? Number(params.limit) : undefined,
          freshness: safeString(params && params.freshness || ''),
          safe: safeString(params && params.safe || ''),
          provider: safeString(params && params.provider || ''),
          providers: Array.isArray(params && params.providers) ? params.providers.map((item: any) => safeString(item)) : undefined,
          noCache: Boolean(params && params.noCache),
        })
        return toolResultFromText(JSON.stringify(result, null, 2), result, !result.ok)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      }
    },
  }

  function normalizeToolThinkingLevel(value: any): string | undefined {
    const next = safeString(value).trim().toLowerCase()
    if (!next) return undefined
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(next)) return undefined
    return next
  }

  function readTextIfExistsLocal(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return ''
    }
  }

  function cloneJsonLocal(value: any): any {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }

  function truncateMiddleTextLocal(value: any, limit = 120_000): string {
    const text = safeString(value)
    if (!limit || text.length <= limit) return text
    const head = Math.max(1, Math.floor(limit / 2))
    const tail = Math.max(1, limit - head)
    return `${text.slice(0, head)}\n\n[... truncated ...]\n\n${text.slice(-tail)}`
  }

  function extractAssistantTextLocal(message: any): string {
    if (!message || typeof message !== 'object') return ''
    const content = Array.isArray(message.content) ? message.content : []
    return content
      .filter((block: any) => block && typeof block === 'object' && safeString(block.type) === 'text')
      .map((block: any) => safeString(block.text))
      .join('\n')
      .trim()
  }

  function emptyUsageLocal() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    }
  }

  function mergeUsageLocal(base: any, extra: any) {
    const next = { ...emptyUsageLocal(), ...(base || {}) }
    const add = extra || {}
    next.input += Number(add.input || 0)
    next.output += Number(add.output || 0)
    next.cacheRead += Number(add.cacheRead || 0)
    next.cacheWrite += Number(add.cacheWrite || 0)
    next.cost += Number(add.cost || 0)
    next.contextTokens = Math.max(Number(next.contextTokens || 0), Number(add.contextTokens || 0))
    next.turns += Number(add.turns || 0)
    return next
  }

  function getActiveSessionForSubagent(ctx?: any) {
    return sessionRef && sessionRef.current
      ? sessionRef.current
      : (ctx && ctx.sessionManager && ctx.modelRegistry ? ctx : null)
  }

  function getActiveSessionContextSnapshot(ctx?: any) {
    const active = getActiveSessionForSubagent(ctx)
    const manager = active && active.sessionManager
      ? active.sessionManager
      : (ctx && ctx.sessionManager ? ctx.sessionManager : sessionManager)
    const built = manager && typeof manager.buildSessionContext === 'function'
      ? manager.buildSessionContext()
      : { messages: [] }
    const messages = Array.isArray(built && built.messages) ? cloneJsonLocal(built.messages) : []
    let trimmedToolCallTail = false
    while (messages.length > 0) {
      const last = messages[messages.length - 1]
      const blocks = Array.isArray(last && last.content) ? last.content : []
      const hasToolCall = safeString(last && last.role) === 'assistant'
        && blocks.some((block: any) => safeString(block && block.type) === 'toolCall')
      if (!hasToolCall) break
      messages.pop()
      trimmedToolCallTail = true
    }
    return {
      messages,
      trimmedToolCallTail,
    }
  }

  function serializeMessagesForSubagent(messages: Array<any>) {
    try {
      if (typeof pi.convertToLlm === 'function' && typeof pi.serializeConversation === 'function') {
        return safeString(pi.serializeConversation(pi.convertToLlm(messages))).trim()
      }
    } catch {}
    return messages
      .map((message: any) => {
        const role = safeString(message && message.role).trim() || 'unknown'
        const text = collectMessageText(message)
        return `${role.toUpperCase()}:\n${text || '[no text]'}`
      })
      .join('\n\n')
      .trim()
  }

  function resolveSubagentTargetModel(ctx: any, params: any) {
    const registry = ctx && ctx.modelRegistry ? ctx.modelRegistry : modelRegistry
    const requestedProvider = safeString(params && params.provider).trim()
    const requestedModel = safeString(params && params.model).trim()
    if (!registry) throw new Error('missing_model_registry')
    if (!requestedProvider) throw new Error('missing_provider')
    if (!requestedModel) throw new Error('missing_model')
    const found = typeof registry.find === 'function' ? registry.find(requestedProvider, requestedModel) : undefined
    if (!found) throw new Error(`model_not_found:${requestedProvider}/${requestedModel}`)
    return found
  }

  async function assertSubagentModelAvailable(ctx: any, model: any) {
    const registry = ctx && ctx.modelRegistry ? ctx.modelRegistry : modelRegistry
    if (!registry || typeof registry.getApiKey !== 'function') throw new Error('missing_model_registry')
    const apiKey = await registry.getApiKey(model)
    if (!apiKey) throw new Error(`model_not_available:${safeString(model && model.provider).trim()}/${safeString(model && model.id).trim()}`)
  }

  function createSubagentResourceLoader(systemPrompt: string) {
    const runtime = typeof pi.createExtensionRuntime === 'function' ? pi.createExtensionRuntime() : undefined
    return {
      getExtensions: () => ({ extensions: [], errors: [], runtime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getAppendSystemPrompt: () => [],
      getPathMetadata: () => new Map(),
      extendResources: () => {},
      reload: async () => {},
    }
  }

  function setSessionSystemPromptLocal(session: any, systemPrompt: string) {
    const next = safeString(systemPrompt).trim()
    if (!next || !session) return
    try { session._baseSystemPrompt = next } catch {}
    try {
      if (session.agent && session.agent.state && typeof session.agent.state === 'object') {
        session.agent.state.systemPrompt = next
      }
    } catch {}
    try {
      if (session.agent && typeof session.agent.setSystemPrompt === 'function') session.agent.setSystemPrompt(next)
    } catch {}
  }

  function buildSubagentSystemPromptLocal(baseSystemPrompt: string, contextMode: 'full' | 'summary' | 'empty') {
    const base = safeString(baseSystemPrompt).trim()
    const modeRule = contextMode === 'full'
      ? '- You have the parent thread context injected. Use it when helpful, but stay scoped to the delegated task.'
      : contextMode === 'summary'
        ? '- You only have a compressed parent summary. Do not assume omitted details; inspect files or say what is missing.'
        : '- You do not have parent thread context. Rely only on the delegated task and what you inspect yourself.'
    const contract = [
      'Delegated worker contract:',
      '- You are a temporary subagent running one delegated task inside Rin.',
      '- Treat the latest user message as the task contract and keep scope tight.',
      modeRule,
      '- Prefer direct results over chatty narration.',
      '- If context seems incomplete, say so plainly instead of guessing.',
      '- End with the answer, findings, or completion summary the parent agent can use immediately.',
    ].join('\n')
    return base ? `${base}\n\n${contract}` : contract
  }

  function getSubagentToolSnapshot(ctx?: any) {
    const active = getActiveSessionForSubagent(ctx)
    const tools = Array.isArray(active && active.agent && active.agent.state && active.agent.state.tools)
      ? active.agent.state.tools
      : []
    if (tools.length > 0) return tools
    const cwd = path.resolve((ctx && ctx.cwd) || process.cwd())
    return pi.createCodingTools(cwd)
  }

  async function createEphemeralSubagentSession({
    cwd,
    model,
    thinking,
    tools,
    systemPrompt,
  }: {
    cwd: string
    model: any
    thinking?: string
    tools: Array<any>
    systemPrompt: string
  }) {
    const workerSessionManager = pi.SessionManager.inMemory(cwd)
    const workerResourceLoader = createSubagentResourceLoader(systemPrompt || 'You are a helpful assistant.')
    const created = await pi.createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      resourceLoader: workerResourceLoader,
      sessionManager: workerSessionManager,
      model,
      thinkingLevel: thinking,
      tools,
    })
    if (!created || !created.session) throw new Error('subagent_session_missing')
    setSessionSystemPromptLocal(created.session, systemPrompt)
    return {
      session: created.session,
      sessionManager: workerSessionManager,
    }
  }

  async function runEphemeralSubagentTurn({
    session,
    prompt,
    signal,
    onUpdate,
    updateDetails,
  }: {
    session: any
    prompt: string
    signal?: AbortSignal
    onUpdate?: any
    updateDetails?: any
  }) {
    let currentAssistantText = ''
    let lastAssistantText = ''
    let finalMessages: Array<any> = []
    let aborted = false
    const unsubscribe = typeof session.subscribe === 'function'
      ? session.subscribe((event: any) => {
          const eventType = safeString(event && event.type)
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
              if (typeof onUpdate === 'function') {
                try {
                  onUpdate({
                    content: [{ type: 'text', text: currentAssistantText || '(running...)' }],
                    details: updateDetails || {},
                  })
                } catch {}
              }
            }
            return
          }
          if (eventType === 'message_end') {
            const message = event && event.message
            if (safeString(message && message.role) !== 'assistant') return
            const text = extractAssistantTextLocal(message) || currentAssistantText
            if (text) lastAssistantText = text
            currentAssistantText = text || currentAssistantText
            return
          }
          if (eventType === 'agent_end') {
            finalMessages = Array.isArray(event && event.messages) ? event.messages : []
            for (let i = finalMessages.length - 1; i >= 0; i--) {
              const message = finalMessages[i]
              if (safeString(message && message.role) !== 'assistant') continue
              const text = extractAssistantTextLocal(message)
              if (text) {
                lastAssistantText = text
                break
              }
            }
          }
        })
      : () => {}

    const abortHandler = () => {
      aborted = true
      if (session && typeof session.abort === 'function') {
        Promise.resolve(session.abort()).catch(() => {})
      }
    }
    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }

    try {
      if (typeof session.prompt !== 'function') throw new Error('subagent_prompt_unavailable')
      await session.prompt(prompt)
    } finally {
      try { unsubscribe() } catch {}
      if (signal) {
        try { signal.removeEventListener('abort', abortHandler) } catch {}
      }
    }

    const assistantMessages = finalMessages.filter((message: any) => safeString(message && message.role) === 'assistant')
    let usage = emptyUsageLocal()
    for (const message of assistantMessages) {
      const nextUsage = message && message.usage ? message.usage : null
      usage = mergeUsageLocal(usage, {
        input: Number(nextUsage && nextUsage.input || 0),
        output: Number(nextUsage && nextUsage.output || 0),
        cacheRead: Number(nextUsage && nextUsage.cacheRead || 0),
        cacheWrite: Number(nextUsage && nextUsage.cacheWrite || 0),
        cost: Number(nextUsage && nextUsage.cost && nextUsage.cost.total || 0),
        contextTokens: Number(nextUsage && nextUsage.totalTokens || 0),
        turns: 1,
      })
    }
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
    return {
      text: safeString(lastAssistantText || currentAssistantText).trim(),
      stopReason: safeString(lastAssistant && lastAssistant.stopReason).trim(),
      errorMessage: safeString(lastAssistant && lastAssistant.errorMessage).trim(),
      usage,
      messages: finalMessages,
      aborted,
    }
  }

  async function summarizeContextForSubagent({
    cwd,
    model,
    thinking,
    messages,
    signal,
  }: {
    cwd: string
    model: any
    thinking?: string
    messages: Array<any>
    signal?: AbortSignal
  }) {
    const serialized = truncateMiddleTextLocal(serializeMessagesForSubagent(messages), 120_000)
    const summarySystemPrompt = [
      'You are a context summarizer for delegated subagents.',
      'Compress the parent session into a practical working brief.',
      'Keep user goals, constraints, decisions, relevant files, commands, errors, and open questions.',
      'Do not add advice beyond what is already implied by the conversation.',
      'Return concise markdown only.',
    ].join('\n')
    const summaryTask = [
      'Summarize this parent session so another worker can continue the task with less context.',
      '',
      '<conversation>',
      serialized,
      '</conversation>',
    ].join('\n')
    const created = await createEphemeralSubagentSession({
      cwd,
      model,
      thinking,
      tools: [],
      systemPrompt: summarySystemPrompt,
    })
    try {
      const result = await runEphemeralSubagentTurn({ session: created.session, prompt: summaryTask, signal })
      const summary = safeString(result && result.text).trim()
      if (!summary) throw new Error('subagent_summary_empty')
      return {
        summary,
        usage: result && result.usage ? result.usage : emptyUsageLocal(),
      }
    } finally {
      try { created.session.dispose() } catch {}
    }
  }

  function collectContextFiles(targetPath: string) {
    const raw = safeString(targetPath).trim()
    const resolvedTarget = path.resolve(raw || process.cwd())
    let currentDir = resolvedTarget
    try {
      const stat = fs.statSync(resolvedTarget)
      if (!stat.isDirectory()) currentDir = path.dirname(resolvedTarget)
    } catch {
      currentDir = path.dirname(resolvedTarget)
    }

    const agentsFiles: Array<any> = []
    const seen = new Set<string>()
    let cursor = currentDir
    while (true) {
      const agentsPath = path.join(cursor, 'AGENTS.md')
      if (!seen.has(agentsPath) && fs.existsSync(agentsPath)) {
        seen.add(agentsPath)
        agentsFiles.push({ path: agentsPath, content: readTextIfExistsLocal(agentsPath) })
      }
      const parent = path.dirname(cursor)
      if (!parent || parent === cursor) break
      cursor = parent
    }

    const localRinDir = path.join(currentDir, '.rin')
    let localRinEntries: Array<any> = []
    if (fs.existsSync(localRinDir)) {
      try {
        localRinEntries = fs.readdirSync(localRinDir).sort().map((name) => {
          const entryPath = path.join(localRinDir, name)
          let kind = 'missing'
          try {
            const stat = fs.statSync(entryPath)
            kind = stat.isDirectory() ? 'directory' : path.extname(entryPath).slice(1).toLowerCase() || 'file'
          } catch {}
          return { name, path: entryPath, kind }
        })
      } catch {}
    }

    return {
      targetPath: resolvedTarget,
      directory: currentDir,
      agentsFiles,
      localRinDir: fs.existsSync(localRinDir) ? localRinDir : '',
      localRinEntries,
    }
  }

  const subagentTool = {
    name: 'rin_subagent',
    label: 'Rin Subagent',
    description: 'Delegate a task to a temporary worker session on a specific provider/model with full, summary, or empty context injection.',
    promptSnippet: 'Run a temporary worker session on a specific provider/model, with full, summary, or empty parent-context injection.',
    promptGuidelines: [
      'Use this when the user explicitly wants a different provider/model to handle a subtask without changing the main session model.',
      'Choose contextMode deliberately: `full` for work that depends on the current thread, `summary` for compressed carry-over, and `empty` for clean isolated exploration.',
      'Write the delegated task as a self-contained contract: desired outcome, important constraints, and expected output shape.',
      'Prefer direct delegated work over temporary main-model switching; the result comes back as tool output for the parent session to use.',
    ],
    parameters: Type.Object({
      provider: Type.String({ description: 'Provider ID to use for the worker session.' }),
      model: Type.String({ description: 'Model ID to use for the worker session.' }),
      task: Type.String({ description: 'Task for the delegated worker.' }),
      contextMode: Type.Optional(Type.Union([
        Type.Literal('full'),
        Type.Literal('summary'),
        Type.Literal('empty'),
      ])),
      thinking: Type.Optional(Type.Union([
        Type.Literal('off'),
        Type.Literal('minimal'),
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('xhigh'),
      ])),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => {
      let workerSession: any = null
      try {
        const task = safeString(params && params.task).trim()
        if (!task) throw new Error('missing_task')

        const contextModeRaw = safeString(params && params.contextMode).trim().toLowerCase()
        const contextMode = contextModeRaw === 'summary' || contextModeRaw === 'empty' ? contextModeRaw : 'full'
        const requestedThinking = normalizeToolThinkingLevel(params && params.thinking)
        const targetModel = resolveSubagentTargetModel(ctx, params)
        await assertSubagentModelAvailable(ctx, targetModel)

        const currentSession = getActiveSessionForSubagent(ctx)
        const workerCwd = path.resolve((ctx && ctx.cwd) || process.cwd())
        const inheritedTools = getSubagentToolSnapshot(ctx)
        const inheritedBaseSystemPrompt = safeString(
          (ctx && typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '')
          || (currentSession && currentSession.agent && currentSession.agent.state && currentSession.agent.state.systemPrompt)
          || '',
        ).trim() || 'You are a helpful assistant.'
        const inheritedSystemPrompt = buildSubagentSystemPromptLocal(inheritedBaseSystemPrompt, contextMode)

        const contextSnapshot = contextMode === 'empty' ? { messages: [], trimmedToolCallTail: false } : getActiveSessionContextSnapshot(ctx)
        let summaryText = ''
        let preparationUsage = emptyUsageLocal()

        if (contextMode === 'summary' && contextSnapshot.messages.length > 0) {
          if (typeof onUpdate === 'function') {
            try {
              onUpdate({
                content: [{ type: 'text', text: 'Summarizing parent context...' }],
                details: { phase: 'prepare', contextMode },
              })
            } catch {}
          }
          const summaryResult = await summarizeContextForSubagent({
            cwd: workerCwd,
            model: targetModel,
            thinking: requestedThinking,
            messages: contextSnapshot.messages,
            signal,
          })
          summaryText = safeString(summaryResult && summaryResult.summary).trim()
          preparationUsage = summaryResult && summaryResult.usage ? summaryResult.usage : emptyUsageLocal()
        }

        const created = await createEphemeralSubagentSession({
          cwd: workerCwd,
          model: targetModel,
          thinking: requestedThinking,
          tools: inheritedTools,
          systemPrompt: inheritedSystemPrompt,
        })
        workerSession = created.session

        if (contextMode === 'full' && contextSnapshot.messages.length > 0 && workerSession && workerSession.agent && typeof workerSession.agent.replaceMessages === 'function') {
          workerSession.agent.replaceMessages(cloneJsonLocal(contextSnapshot.messages))
        }

        const workerPrompt = contextMode === 'summary' && summaryText
          ? [
              'Parent session summary:',
              summaryText,
              '',
              'Task:',
              task,
            ].join('\n')
          : task

        const runResult = await runEphemeralSubagentTurn({
          session: workerSession,
          prompt: workerPrompt,
          signal,
          onUpdate,
          updateDetails: {
            phase: 'run',
            contextMode,
            provider: safeString(targetModel && targetModel.provider).trim(),
            model: safeString(targetModel && targetModel.id).trim(),
          },
        })

        const usage = runResult && runResult.usage ? runResult.usage : emptyUsageLocal()
        const totalUsage = mergeUsageLocal(preparationUsage, usage)
        const resultText = safeString(runResult && runResult.text).trim() || '(no output)'
        const details = {
          current: {
            provider: safeString(targetModel && targetModel.provider).trim(),
            model: safeString(targetModel && targetModel.id).trim(),
            thinking: requestedThinking || undefined,
          },
          contextMode,
          context: {
            inheritedMessageCount: contextSnapshot.messages.length,
            trimmedToolCallTail: Boolean(contextSnapshot.trimmedToolCallTail),
            summaryPreview: summaryText ? truncateMiddleTextLocal(summaryText, 4_000) : undefined,
          },
          usage,
          preparationUsage: preparationUsage.turns > 0 || preparationUsage.input > 0 || preparationUsage.output > 0
            ? preparationUsage
            : undefined,
          totalUsage,
        }

        const isError = Boolean(
          runResult && (runResult.aborted || safeString(runResult.errorMessage).trim() || safeString(runResult.stopReason).trim() === 'error'),
        )
        const errorText = safeString(runResult && runResult.errorMessage).trim()
        return toolResultFromText(isError ? errorText || resultText : resultText, details, isError)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      } finally {
        if (workerSession && typeof workerSession.dispose === 'function') {
          try { workerSession.dispose() } catch {}
        }
      }
    },
  }

  const skillTool = {
    name: 'rin_skills',
    label: 'Rin Skills',
    description: 'List available skills or load one skill body, optionally with resolved local markdown references.',
    promptSnippet: 'List available skills or load one skill body when needed.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('get'),
      ]),
      name: Type.Optional(Type.String({ description: 'Skill name for get.' })),
      includeReferences: Type.Optional(Type.Boolean({ description: 'Include resolved local markdown-link references for get. Default: true.' })),
    }),
    execute: async (_toolCallId: string, params: any, _signal?: AbortSignal) => {
      try {
        const action = safeString(params && params.action).trim()
        if (action === 'list') {
          const skills = listRuntimeSkills().map((skill: any) => ({
            name: skill.name,
            description: skill.description,
            hidden: Boolean(skill.disableModelInvocation),
          }))
          return toolResultFromText(JSON.stringify(skills, null, 2), { count: skills.length, skills }, false)
        }
        if (action === 'get') {
          const requestedName = safeString(params && params.name).trim()
          if (!requestedName) throw new Error('missing_skill_name')
          const skill = listRuntimeSkills().find((entry: any) => safeString(entry && entry.name).trim() === requestedName)
          if (!skill) throw new Error(`skill_not_found:${requestedName}`)
          let content = ''
          try { content = fs.readFileSync(skill.filePath, 'utf8') } catch {}
          if (!content.trim()) throw new Error(`skill_read_failed:${requestedName}`)
          const body = stripSkillFrontmatterLocal(content)
          const includeReferences = params && params.includeReferences !== false
          const references = includeReferences ? collectSkillReferences(body, skill.baseDir) : []
          const result = {
            name: skill.name,
            description: skill.description,
            hidden: Boolean(skill.disableModelInvocation),
            content,
            body,
            baseDir: skill.baseDir,
            filePath: skill.filePath,
            references,
          }
          return toolResultFromText(JSON.stringify(result, null, 2), result, false)
        }
        throw new Error(`unsupported_action:${action}`)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      }
    },
  }

  const contextTool = {
    name: 'rin_context',
    label: 'Rin Context',
    description: 'Inspect the AGENTS.md chain and local .rin resources that apply to a target file or directory.',
    promptSnippet: 'Inspect the AGENTS.md chain and local .rin resources for a target path.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Target file or directory. Defaults to the current working directory.' })),
    }),
    execute: async (_toolCallId: string, params: any, _signal?: AbortSignal) => {
      try {
        const result = collectContextFiles(safeString(params && params.path))
        return toolResultFromText(JSON.stringify(result, null, 2), result, false)
      } catch (e: any) {
        return toolResultFromText(safeString(e && e.message ? e.message : e), {}, true)
      }
    },
  }

  return [brainTool, koishiTool, historyTool, scheduleTool, webSearchTool, subagentTool, skillTool, contextTool]
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
  docsRoot: _docsRoot,
}: {
  stateRoot: string
  docsRoot: string
}) {
  return [
    '',
    'Rin runtime:',
    `- Runtime root: ${stateRoot}`,
    '- Runtime-owned config, docs, skills, and state live under this root.',
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
const RIN_OPENING = "You are Rin, the user's general assistant. Carry out the request directly. Do the work yourself unless the task is beyond your capabilities."

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
  return resolveRinLayout().homeRoot
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

const HIDDEN_SKILL_DIR = '.hidden'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function isHiddenSkillPath(filePath: any): boolean {
  const raw = safeString(filePath).trim()
  if (!raw) return false
  return path.resolve(raw).split(path.sep).filter(Boolean).includes(HIDDEN_SKILL_DIR)
}

function normalizeSkillRecord(skill: any): any {
  if (!skill || typeof skill !== 'object') return null
  const filePath = safeString(skill && skill.filePath).trim()
  const baseDir = safeString(skill && skill.baseDir).trim() || (filePath ? path.dirname(filePath) : '')
  const hidden = Boolean(skill && skill.disableModelInvocation) || isHiddenSkillPath(filePath) || isHiddenSkillPath(baseDir)
  return {
    ...skill,
    name: safeString(skill && skill.name).trim(),
    description: safeString(skill && skill.description).trim(),
    filePath,
    baseDir,
    disableModelInvocation: hidden,
  }
}

function formatSkillsForPrompt(skills: Array<any>): string {
  const visibleSkills = (Array.isArray(skills) ? skills : [])
    .map((skill) => normalizeSkillRecord(skill))
    .filter((skill) => skill && !skill.disableModelInvocation)
  if (!visibleSkills.length) return ''
  const lines = [
    'Available skills provide specialized instructions for specific tasks.',
    '',
    '<available_skills>',
  ]
  for (const skill of visibleSkills) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(safeString(skill && skill.name))}</name>`)
    lines.push(`    <description>${escapeXml(safeString(skill && skill.description))}</description>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

function parseSkillFrontmatter(filePath: string): { name: string, description: string, disableModelInvocation: boolean } | null {
  const text = readTextIfExists(filePath)
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const frontmatter = text.slice(3, end).trim()
  let name = ''
  let description = ''
  let disableModelInvocation = false
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const key = safeString(match[1]).trim()
    let value = safeString(match[2]).trim()
    value = value.replace(/^['"]|['"]$/g, '')
    if (key === 'name') name = value
    if (key === 'description') description = value
    if (key === 'disable-model-invocation') disableModelInvocation = value.toLowerCase() === 'true'
  }
  if (!name) return null
  return { name, description, disableModelInvocation }
}

function stripSkillFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text.trim()
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text.trim()
  return text.slice(end + 4).trim()
}

function collectManualSkills(skillDirs: string[]): Array<any> {
  const seen = new Set<string>()
  const out: Array<any> = []

  const pushSkill = (skill: any) => {
    const normalized = normalizeSkillRecord(skill)
    const skillName = safeString(normalized && normalized.name).trim()
    if (!normalized || !skillName || INTERNALIZED_SKILL_NAMES.has(skillName) || seen.has(skillName)) return
    seen.add(skillName)
    out.push(normalized)
  }

  const addSkillFile = (filePath: string, baseDir: string, fallbackName: string) => {
    const parsed = parseSkillFrontmatter(filePath)
    pushSkill({
      name: safeString(parsed && parsed.name || fallbackName).trim(),
      description: safeString(parsed && parsed.description).trim(),
      filePath,
      baseDir,
      source: 'manual',
      disableModelInvocation: Boolean(parsed && parsed.disableModelInvocation),
    })
  }

  const visitDir = (dir: string, rootDir: string) => {
    if (!dir || !fs.existsSync(dir)) return
    const skillFile = path.join(dir, 'SKILL.md')
    try {
      if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
        addSkillFile(skillFile, dir, path.basename(dir))
        return
      }
    } catch {}

    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch {}
    for (const name of names.sort()) {
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') && name !== HIDDEN_SKILL_DIR) continue
      const entryPath = path.join(dir, name)
      let stat: fs.Stats | null = null
      try { stat = fs.statSync(entryPath) } catch {}
      if (!stat) continue
      if (stat.isDirectory()) {
        visitDir(entryPath, rootDir)
        continue
      }
      if (path.resolve(dir) !== path.resolve(rootDir)) continue
      if (!stat.isFile() || path.extname(name).toLowerCase() !== '.md' || name === 'SKILL.md') continue
      addSkillFile(entryPath, dir, path.basename(name, '.md'))
    }
  }

  for (const dir of skillDirs) visitDir(path.resolve(dir), path.resolve(dir))
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
    'Rin docs (read only for Rin, SDK, extensions, themes, skills, prompt templates, package docs, or TUI requests):',
    `- README: ${path.join(docsRoot, 'rin', 'README.md')}`,
    `- Docs dir: ${path.join(docsRoot, 'rin', 'docs')}`,
    `- Examples dir: ${path.join(docsRoot, 'rin', 'examples')}`,
    '- For Rin work, read the relevant .md files fully and follow local markdown links before implementing.',
  ].join('\n')
  next = next.replace(/Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):[\s\S]*?(?=\n\n<!-- synced|\n\n# Project Context|\n\nThe following skills|\nCurrent date:|\nCurrent working directory:|$)/, docsBlock)

  next = next.replace(/\nCurrent date:.*$/gm, '')
  next = next.replace(/\nCurrent working directory:.*$/gm, '')

  const continueGuideline = '- If the current task is not yet complete, reply with exactly `#RIN_CONTINUE` and nothing else.'
  if (!next.includes(continueGuideline)) {
    next = next.replace('Show file paths clearly when working with files', `Show file paths clearly when working with files\n${continueGuideline}`)
  }

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

const RIN_CONTINUE_TOKEN = EXPORTED_RIN_CONTINUE_TOKEN
const RIN_CONTINUE_FOLLOWUP = EXPORTED_RIN_CONTINUE_FOLLOWUP

function patchSessionPromptAutoContinue(session: any) {
  if (!session || typeof session !== 'object' || session.__rinPromptAutoContinuePatched) return
  if (typeof session.prompt !== 'function' || typeof session.subscribe !== 'function') return
  const originalPrompt = session.prompt.bind(session)
  const originalSubscribe = session.subscribe.bind(session)
  session.__rinPromptAutoContinuePatched = true
  session.__rinPromptAutoContinueOriginalSubscribe = originalSubscribe
  session.subscribe = (listener: any) => originalSubscribe(createContinueEventFilter(session, listener, RIN_CONTINUE_TOKEN))
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
        const unsubscribe = originalSubscribe((event: any) => {
          const eventType = safeString(event && event.type)
          if (eventType === 'message_end' || eventType === 'turn_end') {
            const message = event && event.message
            if (safeString(message && message.role) !== 'assistant') return
            const extracted = extractAssistantTextFromMessage(message)
            if (extracted) lastAssistantText = extracted
            return
          }
          if (eventType === 'agent_end') {
            const messages = Array.isArray(event && event.messages) ? event.messages : []
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              const message = messages[i]
              if (safeString(message && message.role) !== 'assistant') continue
              const extracted = extractAssistantTextFromMessage(message)
              if (!extracted) continue
              lastAssistantText = extracted
              break
            }
          }
        })
        try {
          await promptSessionWithRetry(session, originalPrompt, nextText, nextOptions)
        } finally {
          try { unsubscribe() } catch {}
        }
        if (safeString(lastAssistantText).trim() !== RIN_CONTINUE_TOKEN) return
        try { discardTrailingContinueAssistant(session, RIN_CONTINUE_TOKEN) } catch {}
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
  if (!next.memory || typeof next.memory !== 'object') next.memory = {}
  if (next.memory.provider == null) next.memory.provider = 'openai-codex'
  if (next.memory.model == null) next.memory.model = 'gpt-5.4'
  if (next.memory.thinking == null) next.memory.thinking = 'minimal'
  if ('translation' in next) delete next.translation
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8')
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
        const normalized = normalizeSkillRecord(skill)
        const name = safeString(normalized && normalized.name).trim()
        if (!normalized || !name || INTERNALIZED_SKILL_NAMES.has(name) || seen.has(name)) continue
        seen.add(name)
        mergedSkills.push(normalized)
      }
      for (const skill of manualSkills) {
        const normalized = normalizeSkillRecord(skill)
        const name = safeString(normalized && normalized.name).trim()
        if (!normalized || !name || seen.has(name)) continue
        seen.add(name)
        mergedSkills.push(normalized)
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
    appendSystemPromptOverride: (base: any) => Array.isArray(base) ? base.slice() : [],
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

  const sessionRef = { current: null as any }

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
    customTools: createRinBuiltinTools({ repoRoot, stateRoot, currentChatKey, sessionDir: resolvedSessionDir, sessionFile: resolvedSessionFile, pi, agentDir, authStorage, modelRegistry, resourceLoader, sessionManager, sessionRef }),
  })

  if (!created || !created.session) {
    throw new Error('pi_sdk_session_missing')
  }
  sessionRef.current = created.session

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

    const promptPromise = promptSessionWithRetry(session, session.prompt.bind(session), payload.message || '', {
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
  EXPORTED_RIN_CONTINUE_TOKEN as RIN_CONTINUE_TOKEN,
  EXPORTED_RIN_CONTINUE_FOLLOWUP as RIN_CONTINUE_FOLLOWUP,
  resolvePiAgentDir,
  loadPiSdkModule,
  createRinPiSession,
  runPiSdkTurn,
}
