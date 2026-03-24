// @ts-nocheck
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import { Loader, Logger, h } from 'koishi'
import { BUILTIN_SLASH_COMMANDS } from '../third_party/pi-mono/packages/coding-agent/dist/core/slash-commands.js'
import {
  buildDaemonConfigFromSettings,
  composeChatKey,
  findPluginConfig,
  findPluginConfigs,
  listChatStateFiles,
  loadDaemonHomeSettings,
  materializeDaemonConfig,
  normalizeKoishiAdapterConfig,
  ownerChatKeysFromIdentity,
  parseChatKey,
  preferredOwnerChatKey,
  sendTextToChatKey,
  sendTextToOwners,
} from './daemon-support'
import { createRinPiSession, loadPiSdkModule, manageSchedule, runPiSdkTurn } from './runtime'
import { startDaemonTuiRpcServer } from './daemon-tui-rpc'
import {
  applyInboundRecord,
  buildBridgeRestartResumeThreadText,
  buildConversationTrigger,
  claimConversationProcessing,
  claimConversationTurn,
  clearPersistentConversationRunFlags,
  defaultConversationState,
  mergeConversationState,
  mergePendingTrigger,
  normalizeConversationState,
  normalizeLastAgentResult as normalizeConversationLastAgentResult,
  pickNewerLastAgentResult as pickNewerConversationLastAgentResult,
  planConversationActivation,
  queueConversationTrigger,
  recoverConversationFromStaleProcessing,
  releaseConversationProcessing,
  releaseConversationTurn,
  requestConversationInterrupt,
  resetConversationContinuation,
  resetConversationStateForBoundary,
  summarizeConversationResumeWork,
  syncConversationFromDisk,
} from './chat-session-state'
import { ensureSearxngSidecar, stopSearxngSidecar } from './web-search'
import { resolveRinLayout } from './runtime-paths'

type RinDaemonConfig = {
  name?: string
  prefix?: string[]
  prefixMode?: 'auto' | 'strict'
  plugins?: Record<string, any>
}

type RinHomeSettings = {
  enableSkillCommands?: boolean
  quietStartup?: boolean
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  koishi?: {
    onebot?: Record<string, any>
    telegram?: Record<string, any>
  }
}

// Bridge/orchestrator plugin (inlined to keep a single source file).
const rinBridge = (() => {
  const fs = require('node:fs')
  const path = require('node:path')
  const nodeCrypto = require('node:crypto')
  const net = require('node:net')
  const os = require('node:os')
  const { fileURLToPath } = require('node:url')
  const { spawn } = require('node:child_process')

  const { Logger, Universal, h } = require('koishi')

  const logger = new Logger('rin-bridge')
  const chatContextCache = new Map()
  let sendToChatRef: any = null
  let isCurrentProcessingRunRef: any = null
  let requestInterruptIfProcessingRef: any = null
  let syncConcurrentStateFromDiskRef: any = null

  const INLINE_CODE_SENTINEL = '\u0002'
  const FENCE_CODE_SENTINEL = '\u0003'

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true })
  }

  function readJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return fallback
    }
  }

  function writeJsonAtomic(filePath, obj) {
    ensureDir(path.dirname(filePath))
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, filePath)
  }

  function readText(filePath, fallback = '') {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return fallback
    }
  }

  function appendJsonl(filePath, obj) {
    ensureDir(path.dirname(filePath))
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n')
  }

  function nowMs() {
    return Date.now()
  }

  function isoDate(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10)
  }

  function isPidAlive(pid) {
    const p = Number(pid || 0)
    if (!Number.isFinite(p) || p <= 1) return false
    try {
      process.kill(p, 0)
      return true
    } catch {
      return false
    }
  }

  async function acquireExclusiveFileLock(lockPath, { pollMs = 250, heartbeatMs = 30_000, staleMs = 6 * 60 * 60 * 1000, meta = null }: any = {}) {
    ensureDir(path.dirname(lockPath))
    const startedAt = nowMs()
    let loggedWait = false

    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600)
        try {
          const payload = {
            pid: process.pid,
            startedAtMs: startedAt,
            acquiredAtMs: nowMs(),
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
      } catch {
        let shouldBreak = false
        try {
          const st = fs.statSync(lockPath)
          const ageMs = Math.max(0, nowMs() - Number(st.mtimeMs || 0))
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
            logger.warn(`lock stale; removing: ${lockPath}`)
            fs.rmSync(lockPath, { force: true })
          } catch {}
          continue
        }

        if (!loggedWait) {
          loggedWait = true
          logger.info(`lock busy; waiting: ${lockPath}`)
        }
        await new Promise((r) => setTimeout(r, Math.max(50, Number(pollMs) || 250)))
      }
    }
  }

  function guessMimeFromPath(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase()
    if (ext === '.png') return 'image/png'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.gif') return 'image/gif'
    if (ext === '.webp') return 'image/webp'
    if (ext === '.bmp') return 'image/bmp'
    if (ext === '.svg') return 'image/svg+xml'
    return 'application/octet-stream'
  }

  function extFromMime(mime) {
    const m = safeString(mime).toLowerCase()
    if (m === 'image/png') return '.png'
    if (m === 'image/jpeg') return '.jpg'
    if (m === 'image/gif') return '.gif'
    if (m === 'image/webp') return '.webp'
    if (m === 'image/bmp') return '.bmp'
    if (m === 'image/svg+xml') return '.svg'
    if (m === 'text/plain') return '.txt'
    if (m === 'text/markdown') return '.md'
    if (m === 'application/json') return '.json'
    if (m === 'application/pdf') return '.pdf'
    if (m === 'application/zip') return '.zip'
    if (m === 'audio/mpeg') return '.mp3'
    if (m === 'audio/ogg') return '.ogg'
    if (m === 'audio/wav' || m === 'audio/x-wav') return '.wav'
    if (m === 'audio/webm') return '.webm'
    if (m === 'video/mp4') return '.mp4'
    if (m === 'video/webm') return '.webm'
    if (m === 'video/quicktime') return '.mov'
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx'
    if (m === 'application/msword') return '.doc'
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx'
    if (m === 'application/vnd.ms-excel') return '.xls'
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx'
    if (m === 'application/vnd.ms-powerpoint') return '.ppt'
    return '.bin'
  }

  function safeExtFromName(name) {
    const base = safeString(name).trim()
    if (!base) return ''
    const ext = path.extname(base).toLowerCase()
    if (!ext || ext === '.' || ext.length > 12) return ''
    if (!/^\.[a-z0-9]+$/.test(ext)) return ''
    return ext
  }

  function safeBasename(name) {
    const s = safeString(name).trim()
    if (!s) return ''
    // avoid control chars & path separators in display name
    return path.basename(s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180)
  }

  function parseDataUrl(dataUrl) {
    const s = safeString(dataUrl)
    if (!s.startsWith('data:')) return null
    const comma = s.indexOf(',')
    if (comma < 0) return null
    const meta = s.slice(5, comma)
    const body = s.slice(comma + 1)
    const isBase64 = meta.endsWith(';base64')
    const mime = (isBase64 ? meta.slice(0, -';base64'.length) : meta) || 'application/octet-stream'
    try {
      const buf = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
      return { mime, buf }
    } catch {
      return null
    }
  }

  function parseBase64Url(b64Url) {
    const s = safeString(b64Url)
    if (!s.startsWith('base64://')) return null
    try {
      return { mime: 'application/octet-stream', buf: Buffer.from(s.slice('base64://'.length), 'base64') }
    } catch {
      return null
    }
  }

  function tryMimeFromDataUrl(dataUrl) {
    const s = safeString(dataUrl)
    if (!s.startsWith('data:')) return ''
    const comma = s.indexOf(',')
    if (comma < 0) return ''
    const meta = s.slice(5, comma)
    const semi = meta.indexOf(';')
    const mime = (semi >= 0 ? meta.slice(0, semi) : meta).trim()
    return mime || ''
  }

  function listLogFiles(chatDir, fromDateIso, toDateIso) {
    const logsDir = path.join(chatDir, 'logs')
    if (!fs.existsSync(logsDir)) return []
    const all = fs.readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()
    return all
      .filter((n) => n >= `${fromDateIso}.jsonl` && n <= `${toDateIso}.jsonl`)
      .map((n) => path.join(logsDir, n))
  }

  function listAllCurrentLogFiles(chatDir) {
    const logsDir = path.join(chatDir, 'logs')
    if (!fs.existsSync(logsDir)) return []
    return fs.readdirSync(logsDir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => path.join(logsDir, n))
  }

  function prepareResetLogCutover(chatDir) {
    const logsDir = path.join(chatDir, 'logs')
    if (!fs.existsSync(logsDir)) return { stagingDir: '', historyDir: '', stagedLogFiles: [] }

    let files = []
    try {
      files = fs.readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()
    } catch {}
    if (!files.length) return { stagingDir: '', historyDir: '', stagedLogFiles: [] }

    const stamp = String(Date.now())
    const stagingDir = path.join(chatDir, `.logs.reset.${stamp}.${process.pid}`)
    const historyDir = path.join(chatDir, 'logs.history', stamp)

    try {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
      fs.renameSync(logsDir, stagingDir)
      ensureDir(logsDir)
      return {
        stagingDir,
        historyDir,
        stagedLogFiles: files.map((name) => path.join(stagingDir, name)),
      }
    } catch (e) {
      try {
        if (!fs.existsSync(logsDir)) ensureDir(logsDir)
      } catch {}
      logger.warn(`reset log cutover failed chatDir=${safeString(chatDir)} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
      return { stagingDir: '', historyDir: '', stagedLogFiles: [] }
    }
  }

  async function finalizeResetLogCutover({ chatKey = '', chatDir = '', stagingDir = '', historyDir = '' }: any = {}) {
    const src = safeString(stagingDir || '')
    if (!src || !fs.existsSync(src)) return { ok: false, skipped: true }

    let dst = safeString(historyDir || '')
    if (!dst) dst = path.join(safeString(chatDir || ''), 'logs.history', String(Date.now()))

    try {
      await fs.promises.mkdir(path.dirname(dst), { recursive: true })
      if (fs.existsSync(dst)) dst = `${dst}.${process.pid}.${Date.now()}`
      await fs.promises.rename(src, dst)
      return { ok: true, skipped: false, dir: dst }
    } catch (e) {
      logger.warn(`reset log archive finalize failed chatKey=${safeString(chatKey || '')} src=${src} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
      return { ok: false, skipped: false, dir: src }
    }
  }

  function safeString(v) {
    if (v == null) return ''
    return String(v)
  }

  function decodeEscapedControlsIfLikely(text) {
    let s = safeString(text)
    if (!s) return ''
    if (!s.includes('\\') && !s.toLowerCase().includes('<br')) return s

    // Decode only outside code spans/fences so the user can still show literals via backticks.
    const store = []
    s = protectSegments(s, 'fence', /```[\s\S]*?```/g, store)
    s = protectSegments(s, 'inline', /`[^`\n]+`/g, store)

    // Common line-break placeholders from copied HTML or double-escaped tool output.
    s = s.replace(/<br\s*\/?>/gi, '\n')

    // Decode minimal escapes when they look like separators (followed by whitespace, another escape,
    // or common list markers). Avoid breaking Windows paths like `C:\new\name`.
    s = s
      .replace(/(?<!\\)\\r\\n(?=\\\\|\r|\n|\s|$|[-*•·])/g, '\n')
      .replace(/(?<!\\)\\n(?=\\\\|\r|\n|\s|$|[-*•·])/g, '\n')
      .replace(/(?<!\\)\\t(?=\\\\|\r|\n|\s|$|[-*•·])/g, '\t')

    return restoreSegments(s, store)
  }

  function protectSegments(input, kind, regex, store) {
    let s = safeString(input)
    return s.replace(regex, (m) => {
      const idx = store.length
      store.push(m)
      if (kind === 'inline') return `${INLINE_CODE_SENTINEL}${idx}${INLINE_CODE_SENTINEL}`
      return `${FENCE_CODE_SENTINEL}${idx}${FENCE_CODE_SENTINEL}`
    })
  }

  function restoreSegments(input, store) {
    let s = safeString(input)
    s = s.replace(new RegExp(`${INLINE_CODE_SENTINEL}(\\d+)${INLINE_CODE_SENTINEL}`, 'g'), (_, n) => store[Number(n)] || '')
    s = s.replace(new RegExp(`${FENCE_CODE_SENTINEL}(\\d+)${FENCE_CODE_SENTINEL}`, 'g'), (_, n) => store[Number(n)] || '')
    return s
  }

  function compactElements(elements) {
    const out = []
    if (!Array.isArray(elements)) return out
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue
      const type = safeString(el.type)
      const attrs = el.attrs && typeof el.attrs === 'object' ? el.attrs : {}
      if (type === 'at') {
        out.push({ type: 'at', attrs: { id: safeString(attrs.id) } })
        continue
      }
      if (type === 'img') {
        out.push({ type: 'img', attrs: { src: safeString(attrs.src) } })
        continue
      }
      if (type === 'emoji') {
        out.push({ type: 'emoji', attrs: { id: safeString(attrs.id) } })
        continue
      }
      if (type === 'file') {
        out.push({ type: 'file', attrs: { src: safeString(attrs.src), name: safeString(attrs.name) } })
        continue
      }
      if (type === 'video' || type === 'audio') {
        out.push({ type, attrs: { src: safeString(attrs.src) } })
      }
    }
    return out
  }

  function elementsToMessageFragments(platform, elements) {
    if (platform !== 'onebot') return []
    const out = []
    for (const el of compactElements(elements)) {
      if (!el || typeof el !== 'object') continue
      const type = safeString((el as any).type)
      const attrs = (el as any).attrs && typeof (el as any).attrs === 'object' ? (el as any).attrs : {}
      if (type === 'at') {
        const id = safeString((attrs as any).id)
        if (!id) continue
        if (typeof (h as any).at === 'function') out.push((h as any).at(id))
        else out.push((h as any)('at', { id }))
        continue
      }
      if (type === 'emoji') {
        const id = safeString((attrs as any).id)
        if (!id) continue
        if (typeof (h as any).emoji === 'function') out.push((h as any).emoji(id))
        else out.push((h as any)('emoji', { id }))
      }
    }
    return out
  }

  function pickTelegramMessageLike(session) {
    const candidates = [
      session?.telegram,
      session?.event?.telegram,
      session?.event?.payload?.telegram,
      session?.event?.payload,
      session?.event,
    ].filter(Boolean)
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        if (c.message || c.edited_message || c.channel_post || c.edited_channel_post) {
          return c.message || c.edited_message || c.channel_post || c.edited_channel_post
        }
        return c
      }
    }
    return null
  }

  function getInboundText(session) {
    if (safeString(session?.platform) === 'telegram') {
      const msg = pickTelegramMessageLike(session)
      const rawText = safeString(msg?.text || msg?.caption || '')
      if (rawText) return rawText
    }
    return safeString(session?.content || '')
  }

  function parseIdentity(identityPath) {
    const identity = readJson(identityPath, { persons: {}, aliases: [], trusted: [] })
    const aliasMap = new Map()
    for (const a of identity.aliases || []) {
      aliasMap.set(`${a.platform}:${a.userId}`, a.personId)
    }
    const persons = identity.persons || {}
    function trustOf(platform, userId) {
      const personId = aliasMap.get(`${platform}:${userId}`)
      if (!personId) return 'OTHER'
      return persons[personId]?.trust || 'OTHER'
    }
    return { trustOf }
  }

  function normalizeSelfMentions(session) {
    const elements = Array.isArray(session?.elements) ? session.elements : []
    if (!elements.length) return
    const selfId = safeString(
      session?.bot?.selfId ||
      session?.selfId ||
      '',
    )
    const names = new Set<string>()
    const addName = (value) => {
      const name = safeString(value).replace(/^@/, '').trim().toLowerCase()
      if (name) names.add(name)
    }
    addName(session?.bot?.user?.username)
    addName(session?.bot?.user?.name)
    addName(session?.bot?.user?.nick)
    if (!selfId && names.size === 0) return

    let changed = false
    for (const el of elements) {
      if (!el || el.type !== 'at') continue
      const attrs = el.attrs && typeof el.attrs === 'object' ? el.attrs : (el.attrs = {})
      const id = safeString(attrs.id)
      if (id) continue
      const name = safeString(attrs.name).replace(/^@/, '').trim().toLowerCase()
      if (!name || !names.has(name)) continue
      attrs.id = selfId || name
      changed = true
    }

    if (changed && session && typeof session === 'object' && '_stripped' in session) {
      try { delete session._stripped } catch {}
      try { session._stripped = undefined } catch {}
    }
  }

  function isMentioned(session) {
    normalizeSelfMentions(session)
    const selfId =
      session?.bot?.selfId ||
      session?.selfId ||
      ''
    if (session?.stripped?.atSelf) return true
    const elements = Array.isArray(session?.elements) ? session.elements : []
    return elements.some((el) => {
      if (!el || el.type !== 'at') return false
      return !!selfId && safeString(el.attrs?.id) === String(selfId)
    })
  }

  function extractReplyMeta(session) {
    const meta = {
      replyToMessageId: '',
      quotedText: '',
      quotedSenderUserId: '',
      quotedSenderName: '',
    }

    const applyQuote = (quote) => {
      if (!quote || typeof quote !== 'object') return
      if (!meta.replyToMessageId) {
        meta.replyToMessageId = safeString(
          quote.messageId ||
          quote.id ||
          quote.message_id ||
          quote.msgId ||
          quote.message_id_str ||
          '',
        )
      }
      if (!meta.quotedText) {
        meta.quotedText = safeString(
          quote.content ||
          quote.text ||
          quote.message ||
          quote.raw_message ||
          '',
        )
      }
      if (!meta.quotedSenderUserId) {
        meta.quotedSenderUserId = safeString(
          quote.userId ||
          quote.user_id ||
          quote.sender?.userId ||
          quote.sender?.user_id ||
          quote.sender?.id ||
          quote.author?.id ||
          quote.from?.id ||
          '',
        )
      }
      if (!meta.quotedSenderName) {
        meta.quotedSenderName = safeString(
          quote.username ||
          quote.userName ||
          quote.sender?.name ||
          quote.sender?.nickname ||
          quote.author?.name ||
          quote.author?.nickname ||
          quote.from?.first_name ||
          '',
        )
      }
    }

    applyQuote(session?.quote)

    const elements = Array.isArray(session?.elements) ? session.elements : []
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue
      if (el.type !== 'quote' && el.type !== 'reply') continue
      applyQuote({
        messageId: el.attrs?.id || el.attrs?.messageId || el.attrs?.message_id || '',
        content: el.attrs?.content || el.attrs?.text || '',
        userId: el.attrs?.userId || el.attrs?.user_id || '',
        username: el.attrs?.name || el.attrs?.nickname || '',
      })
    }

    if (session?.platform === 'onebot' && session.onebot) {
      const msg = Array.isArray(session.onebot.message) ? session.onebot.message : []
      for (const seg of msg) {
        if (!seg || typeof seg !== 'object') continue
        if (seg.type !== 'reply') continue
        if (!meta.replyToMessageId) {
          meta.replyToMessageId = safeString(seg.data?.id || seg.data?.message_id || '')
        }
      }
      if (!meta.replyToMessageId) {
        const raw = safeString(session.onebot.raw_message)
        const m = raw.match(/\[CQ:reply,[^\]]*\bid=([^,\]]+)/)
        if (m) meta.replyToMessageId = safeString(m[1] || '')
      }
    }

    if (session?.platform === 'telegram') {
      const telegram = pickTelegramMessageLike(session)
      const reply = telegram?.reply_to_message
      if (reply && typeof reply === 'object') {
        applyQuote({
          messageId: reply.message_id,
          content: reply.text || reply.caption || '',
          userId: reply.from?.id,
          username: reply.from?.username || reply.from?.first_name || '',
        })
      }
    }

    return meta
  }

  function normalizeMessageIds(input) {
    const out = []
    const push = (value) => {
      const s = safeString(value).trim()
      if (!s) return
      if (!out.includes(s)) out.push(s)
    }
    if (Array.isArray(input)) {
      for (const item of input) push(item)
    } else {
      push(input)
    }
    return out
  }

  function listArchivedLogFiles(chatDir) {
    const historyRoot = path.join(chatDir, 'logs.history')
    if (!fs.existsSync(historyRoot)) return []
    const out: string[] = []
    try {
      const batches = fs.readdirSync(historyRoot, { withFileTypes: true })
        .filter((entry) => entry && entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
      for (const batch of batches) {
        const batchDir = path.join(historyRoot, batch)
        const files = fs.readdirSync(batchDir)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .reverse()
          .map((name) => path.join(batchDir, name))
        out.push(...files)
      }
    } catch {}
    return out
  }

  function findLoggedMessageById(chatDir, messageId) {
    const target = safeString(messageId).trim()
    if (!target) return null
    try {
      const files = [
        ...listAllCurrentLogFiles(chatDir).slice().reverse(),
        ...listArchivedLogFiles(chatDir),
      ]
      for (const p of files) {
        let raw = ''
        try { raw = fs.readFileSync(p, 'utf8') } catch { raw = '' }
        if (!raw) continue
        const lines = raw.split('\n').filter(Boolean).reverse()
        for (const line of lines) {
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          const ids = normalizeMessageIds([
            obj && obj.messageId,
            ...((obj && obj.raw && Array.isArray(obj.raw.messageIds)) ? obj.raw.messageIds : []),
          ])
          if (ids.includes(target)) return obj
        }
      }
    } catch {}
    return null
  }

  function buildHistoryLookupMessage(chatKey, record) {
    if (!record || typeof record !== 'object') return null
    const sender = record.sender && typeof record.sender === 'object' ? record.sender : {}
    const raw = record.raw && typeof record.raw === 'object' ? record.raw : {}
    const elements = Array.isArray(record.elements) ? record.elements : []
    const attachments = elements
      .filter((el) => el && typeof el === 'object')
      .map((el) => ({
        type: safeString(el.type || ''),
        name: safeString(el.attrs && el.attrs.name || '') || undefined,
        mime: safeString(el.attrs && el.attrs.mime || '') || undefined,
        localPath: safeString(el.attrs && el.attrs.localPath || '') || undefined,
      }))
    const identity = safeString(sender.trust || 'OTHER') || 'OTHER'
    return {
      chatKey: safeString(chatKey || ''),
      platform: safeString(record.platform || ''),
      chatId: safeString(record.chatId || ''),
      chatType: safeString(record.chatType || ''),
      seq: Number(record.seq || 0) || 0,
      ts: Number(record.ts || 0) || 0,
      messageId: safeString(record.messageId || ''),
      replyToMessageId: safeString(raw.replyTo || raw.replyToMessageId || '') || undefined,
      sender: {
        userId: safeString(sender.userId || '') || undefined,
        name: safeString(sender.name || '') || undefined,
        identity,
      },
      text: safeString(record.text || ''),
      attachments,
    }
  }

  function effectiveBridgeChatType(session, { privateLike = false } = {}) {
    if (!session?.guildId) return 'private'
    return privateLike ? 'private' : 'group'
  }

  function isReplyToBotMessage({ session, replyMeta, chatDir }) {
    const selfId = safeString(session?.bot?.selfId || session?.selfId || '').trim()
    const quotedSenderUserId = safeString(replyMeta?.quotedSenderUserId || '').trim()
    if (selfId && quotedSenderUserId && quotedSenderUserId === selfId) return true

    const replyToMessageId = safeString(replyMeta?.replyToMessageId || '').trim()
    if (!replyToMessageId) return false
    const record = findLoggedMessageById(chatDir, replyToMessageId)
    const sender = record && typeof record.sender === 'object' ? record.sender : {}
    if (safeString(sender.trust || '').trim() === 'BOT') return true
    if (selfId && safeString(sender.userId || '').trim() === selfId) return true
    return false
  }

  async function isOwnerBotOnlyGroupSession(session, trust) {
    if (!session?.guildId || trust !== 'OWNER') return false
    const platform = safeString(session?.platform || '').trim()
    const chatId = safeString(pickChatId(session) || '').trim()
    if (!platform || !chatId) return false

    const cacheKey = `${platform}:${chatId}`
    const now = nowMs()
    const cached = chatContextCache.get(cacheKey)
    if (cached && Number(cached.expiresAt || 0) > now) return Boolean(cached.privateLike)

    let memberCount = NaN
    const bot = session?.bot

    try {
      if (platform === 'telegram' && bot?.internal && typeof bot.internal.getChatMemberCount === 'function') {
        memberCount = Number(await bot.internal.getChatMemberCount({ chat_id: chatId }))
      } else if (platform === 'onebot') {
        if (bot?.internal && typeof bot.internal.getGroupInfo === 'function') {
          const info = await bot.internal.getGroupInfo(chatId, true)
          const count = Number(
            info?.member_count ??
            info?.memberCount ??
            info?.member_count_all ??
            0,
          )
          if (Number.isFinite(count) && count > 0) memberCount = count
        }
        if ((!Number.isFinite(memberCount) || memberCount <= 0) && typeof bot?.getGuildMemberList === 'function') {
          const list = await bot.getGuildMemberList(chatId)
          const count = Array.isArray(list?.data) ? list.data.length : NaN
          if (Number.isFinite(count) && count > 0) memberCount = count
        }
      } else if (typeof bot?.getGuildMemberList === 'function') {
        const list = await bot.getGuildMemberList(chatId)
        const count = Array.isArray(list?.data) ? list.data.length : NaN
        if (Number.isFinite(count) && count > 0) memberCount = count
      }
    } catch {}

    const privateLike = Number.isFinite(memberCount) && memberCount > 0 && memberCount <= 2
    chatContextCache.set(cacheKey, {
      memberCount: Number.isFinite(memberCount) ? memberCount : null,
      privateLike,
      expiresAt: now + (privateLike ? 5 * 60 * 1000 : 60 * 1000),
    })
    return privateLike
  }

  async function enrichReplyMeta({ session, platform, chatId, chatDir }) {
    const meta = extractReplyMeta(session)
    const replyToMessageId = safeString(meta.replyToMessageId).trim()
    if (!replyToMessageId) return meta

    const applyRecord = (record) => {
      if (!record || typeof record !== 'object') return
      if (!meta.quotedText) meta.quotedText = safeString(record.text || record.content || '')
      const sender = record.sender && typeof record.sender === 'object' ? record.sender : {}
      if (!meta.quotedSenderUserId) meta.quotedSenderUserId = safeString(sender.userId || record.userId || '')
      if (!meta.quotedSenderName) meta.quotedSenderName = safeString(sender.name || record.username || '')
    }

    applyRecord(findLoggedMessageById(chatDir, replyToMessageId))

    if (platform === 'onebot' && (!meta.quotedText || !meta.quotedSenderUserId || !meta.quotedSenderName)) {
      try {
        const bot = session?.bot
        if (bot && typeof bot.getMessage === 'function') {
          const msg = await bot.getMessage(String(chatId), replyToMessageId)
          applyRecord(msg)
          const user = msg && typeof msg === 'object' && msg.user && typeof msg.user === 'object' ? msg.user : {}
          const author = msg && typeof msg === 'object' && msg.author && typeof msg.author === 'object' ? msg.author : {}
          if (!meta.quotedSenderUserId) {
            meta.quotedSenderUserId = safeString(
              msg?.userId ||
              user.id ||
              author.user?.id ||
              author.id ||
              '',
            )
          }
          if (!meta.quotedSenderName) {
            meta.quotedSenderName = safeString(
              msg?.username ||
              user.name ||
              author.name ||
              author.nick ||
              '',
            )
          }
        }
      } catch {}
    }

    return meta
  }

  function pickChatId(session) {
    // For groups, prefer guildId; for direct, use channelId.
    return session.guildId || session.channelId
  }

  function pickUserId(session) {
    const directChatId = safeString(pickChatId(session)).trim()
    return safeString(
      session?.userId
      || session?.author?.user?.id
      || session?.author?.id
      || session?.event?.user?.id
      || (!session?.guildId ? directChatId : '')
      || '',
    ).trim()
  }

				  function defaultState(chatKey) {
				    return defaultConversationState(chatKey)
	  }

  function readLegacyThreadHandle(_state: any) {
    return ''
  }

  function writeLegacyThreadHandle(_state: any, _value: any) {
    return ''
  }

  function readPiSessionFile(state: any) {
    if (!state || typeof state !== 'object') return ''
    return safeString((state as any).piSessionFile || '').trim()
  }

  function writePiSessionFile(state: any, value: any) {
    if (!state || typeof state !== 'object') return ''
    const nextSessionFile = safeString(value || '').trim()
    ;(state as any).piSessionFile = nextSessionFile
    return nextSessionFile
  }

  function reconcilePiSessionFile(state: any, value: any, _chatKey = '') {
    if (!state || typeof state !== 'object') return ''
    const nextSessionFile = safeString(value || '').trim()
    if (nextSessionFile) return writePiSessionFile(state, nextSessionFile)
    const currentSessionFile = readPiSessionFile(state)
    if (currentSessionFile && !fs.existsSync(currentSessionFile)) {
      return writePiSessionFile(state, '')
    }
    return currentSessionFile
  }

  async function readPiSessionContextSummary(sessionFile: any) {
    const filePath = safeString(sessionFile || '').trim()
    if (!filePath || !fs.existsSync(filePath)) return null
    try {
      const pi = await loadPiSdkModule()
      const sessionManager = pi && pi.SessionManager && typeof pi.SessionManager.open === 'function'
        ? pi.SessionManager.open(filePath)
        : null
      if (!sessionManager || typeof sessionManager.buildSessionContext !== 'function') return null
      const context = sessionManager.buildSessionContext()
      const model = context && context.model && typeof context.model === 'object' ? context.model : null
      const thinkingLevel = safeString(context && context.thinkingLevel || '').trim()
      const provider = safeString(model && model.provider || '').trim()
      const modelId = safeString(model && model.modelId || '').trim()
      if (!provider && !modelId && !thinkingLevel) return null
      return {
        provider,
        modelId,
        thinkingLevel,
      }
    } catch (e) {
      logger.warn(`status read pi session context failed file=${filePath} err=${safeString(e && e.message ? e.message : e)}`)
      return null
    }
  }

  function normalizeRuntimeKind(_value: any) {
    return 'pi'
  }

  function primaryRuntimeForChat(_chatKey = '') {
    return 'pi'
  }

  function shadowRuntimeForChat(_chatKey = '') {
    return ''
  }

  function runtimeForEphemeralTurn(_chatKey = '') {
    return 'pi'
  }

  function piSessionDirForChat(chatDir: string) {
    return path.join(chatDir, 'pi-session')
  }

  function cloneTurnInputItems(items: Array<any>) {
    return (Array.isArray(items) ? items : [])
      .filter(Boolean)
      .map((item: any) => item && typeof item === 'object' ? { ...item } : item)
  }

  type CodexTurnResult = {
    code: number | null
    stdout: string
    stderr: string
    lastMessage: string
    killedByTimeout: boolean
    threadId: string
    sessionFile?: string
    turnStarted: boolean
    turnStatus: string
  }

  const BRIDGE_AGENT_INTERIM_MARKER = '··· '
  const activeProcessingTurns = new Map<string, any>()

  function activeProcessingTurnKey(chatKey: any, processingRunId: any) {
    const keyChat = safeString(chatKey || '').trim()
    const keyRun = safeString(processingRunId || '').trim()
    if (!keyChat || !keyRun) return ''
    return `${keyChat}::${keyRun}`
  }

  function registerActiveProcessingTurn({ chatKey, processingRunId, ...rest }: any = {}) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key) return
    activeProcessingTurns.set(key, {
      chatKey: safeString(chatKey || '').trim(),
      processingRunId: safeString(processingRunId || '').trim(),
      ...rest,
    })
  }

  function clearActiveProcessingTurn({ chatKey, processingRunId }: any = {}) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key) return
    activeProcessingTurns.delete(key)
  }

  function getActiveProcessingTurn({ chatKey, processingRunId }: any = {}) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key) return null
    return activeProcessingTurns.get(key) || null
  }

  function normalizeBridgePayloadKey(value: any) {
    return safeString(value || '').replace(/\r\n/g, '\n').trim()
  }

  function formatBridgeInterimText(value: any, marker = BRIDGE_AGENT_INTERIM_MARKER) {
    const text = safeString(value || '').trimStart()
    if (!text) return ''
    const prefix = safeString(marker || '')
    return prefix ? `${prefix}${text}` : text
  }

  function normalizeBridgeAssistantText(value: any) {
    const text = safeString(value || '').trim()
    if (!text) return { kind: 'empty', text: '' }
    return { kind: 'reply', text }
  }

  async function runPiTurn({
    rootDir = '',
    repoRoot,
    workspaceRoot,
    piProvider = 'openai',
    piModel = 'gpt-5.4',
    piThinking = '',
    systemPromptExtra = '',
    prompt,
    inputItems = null,
    resumeThreadId = null,
    timeoutMs = 0,
    onSpawn = null,
    bridgeSend = null,
    runtimeTracking = null,
  }: any = {}): Promise<CodexTurnResult> {
    const rt = runtimeTracking && typeof runtimeTracking === 'object' ? runtimeTracking : null
    const fallbackRoot = safeString(rootDir || '').trim() || os.tmpdir()
    const fallbackDir = path.join(fallbackRoot, 'pi-ephemeral', nodeCrypto.randomBytes(8).toString('hex'))
    const sessionDir = path.resolve(
      rt && safeString(rt.piSessionDir || '').trim()
        ? safeString(rt.piSessionDir || '').trim()
        : rt && safeString(rt.chatDir || '').trim()
          ? piSessionDirForChat(safeString(rt.chatDir || '').trim())
        : fallbackDir,
    )
    const normalizedInput = Array.isArray(inputItems) && inputItems.length
      ? inputItems
      : (safeString(prompt || '').trim() ? [{ type: 'text', text: safeString(prompt || '') }] : [])
    const sessionFile = safeString(
      resumeThreadId
      || (rt ? readPiSessionFile(rt.state) : '')
      || '',
    ).trim()
    const piTurn = {
      bridgeSend: bridgeSend && typeof bridgeSend === 'object' ? bridgeSend : null,
      sentBridgeItemIds: new Set<string>(),
      sentBridgePayloadKeys: new Set<string>(),
      sendQueue: Promise.resolve(),
      pendingInterimText: '',
      pendingInterimItemId: '',
    }
    const extractPiAssistantText = (message: any) => {
      if (!message || typeof message !== 'object') return ''
      const blocks = Array.isArray(message.content) ? message.content : []
      return blocks
        .filter((block: any) => block && typeof block === 'object' && safeString(block.type) === 'text')
        .map((block: any) => safeString(block.text))
        .join('\n')
        .trim()
    }
    const flushPendingPiInterim = () => {
      const rawText = safeString(piTurn.pendingInterimText || '')
      const itemId = safeString(piTurn.pendingInterimItemId || '')
      piTurn.pendingInterimText = ''
      piTurn.pendingInterimItemId = ''
      if (!rawText || !piTurn.bridgeSend || typeof sendToChatRef !== 'function') return
      const normalized = normalizeBridgeAssistantText(rawText)
      if (normalized.kind !== 'reply' || !normalized.text) return
      const chatKey = safeString(piTurn.bridgeSend.chatKey || '')
      if (!chatKey) return
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      if (itemId) {
        if (piTurn.sentBridgeItemIds.has(itemId)) return
        piTurn.sentBridgeItemIds.add(itemId)
      }
      const textPayload = formatBridgeInterimText(normalized.text, safeString(piTurn.bridgeSend.interimMarker || '') || BRIDGE_AGENT_INTERIM_MARKER)
      const payloadKey = normalizeBridgePayloadKey(textPayload)
      if (payloadKey) {
        if (piTurn.sentBridgePayloadKeys.has(payloadKey)) return
        piTurn.sentBridgePayloadKeys.add(payloadKey)
      }
      piTurn.sendQueue = Promise.resolve(piTurn.sendQueue || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await sendToChatRef({
            chatKey,
            parsed,
            text: textPayload,
            elements: [],
            images: [],
            files: [],
            via: safeString(piTurn.bridgeSend.via || 'agent-prefix'),
            replyToMessageId: safeString(piTurn.bridgeSend.replyToMessageId || ''),
          })
        })
        .catch((e: any) => {
          logger.warn(`pi interim send failed chatKey=${chatKey} err=${safeString(e && e.message ? e.message : e)}`)
        })
    }

    let registeredPiActiveTurn = false
    try {
      return await runPiSdkTurn({
        repoRoot,
        workspaceRoot,
        sessionDir,
        sessionFile,
        inputItems: normalizedInput,
        timeoutMs,
        brainChatKey: rt && safeString(rt.chatKey || '').trim() ? safeString(rt.chatKey || '').trim() : 'local:default',
        provider: piProvider,
        model: piModel,
        thinking: piThinking,
        currentChatKey: rt && safeString(rt.chatKey || '').trim() ? safeString(rt.chatKey || '').trim() : '',
        systemPromptExtra,
        onSessionReady: ({ sessionFile: nextSessionFile, abort }) => {
          const activeSessionFile = safeString(nextSessionFile || sessionFile || '').trim()
          if (rt) {
            if (!isCurrentProcessingRunRef || !isCurrentProcessingRunRef(rt.state, rt.processingRunId)) {
              void Promise.resolve(typeof abort === 'function' ? abort() : undefined).catch(() => {})
              return
            }
            registerActiveProcessingTurn({
              chatKey: rt.chatKey,
              processingRunId: rt.processingRunId,
              runtime: 'pi',
              threadId: activeSessionFile,
              turnId: '',
              abort,
            })
            registeredPiActiveTurn = true
            rt.state.processingPid = 0
            rt.state.processingThreadId = activeSessionFile
            rt.state.processingTurnId = ''
            if (syncConcurrentStateFromDiskRef) {
              syncConcurrentStateFromDiskRef({ chatDir: rt.chatDir, state: rt.state, observedToSeq: rt.observedToSeq })
            }
            rt.saveState()
            if ((rt.allowInterrupt ?? true) && rt.state.interruptRequested && requestInterruptIfProcessingRef) {
              void requestInterruptIfProcessingRef({
                chatKey: rt.chatKey,
                chatDir: rt.chatDir,
                state: rt.state,
                saveState: rt.saveState,
                reason: 'interrupt_pending_on_turn_start',
              })
            }
          }
          if (typeof onSpawn === 'function') {
            try { onSpawn({ pid: 0 }) } catch {}
          }
        },
        onEvent: (event) => {
          const eventType = safeString(event && event.type)
          if (eventType === 'tool_execution_start') {
            flushPendingPiInterim()
            return
          }
          if (eventType === 'message_start') {
            const message = event && event.message
            if (safeString(message && message.role) === 'assistant') flushPendingPiInterim()
            return
          }
          if (eventType !== 'message_end') return
          const message = event && event.message
          if (safeString(message && message.role) !== 'assistant') return
          const text = extractPiAssistantText(message)
          if (!text) return
          piTurn.pendingInterimText = text
          piTurn.pendingInterimItemId = safeString(message && message.id || '')
        },
      })
    } finally {
      if (rt && registeredPiActiveTurn) {
        clearActiveProcessingTurn({
          chatKey: rt.chatKey,
          processingRunId: rt.processingRunId,
        })
      }
    }
  }

  async function runSelectedRuntimeTurn({
    runtimeKind = 'pi',
    ...options
  }: any = {}): Promise<CodexTurnResult> {
    void runtimeKind
    return await runPiTurn(options)
  }

  function yamlStringifyValue(v) {
    if (v == null) return 'null'
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(String(v))
  }

  function dumpYaml(obj, indent = 0) {
    const pad = ' '.repeat(indent)
    if (obj == null) return [`${pad}null`]
    if (Array.isArray(obj)) {
      if (!obj.length) return [`${pad}[]`]
      const out = []
      for (const item of obj) {
        if (item && typeof item === 'object') {
          out.push(`${pad}-`)
          out.push(...dumpYaml(item, indent + 2))
        } else {
          out.push(`${pad}- ${yamlStringifyValue(item)}`)
        }
      }
      return out
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj)
      if (!keys.length) return [`${pad}{}`]
      const out = []
      for (const k of keys) {
        const v = obj[k]
        if (v && typeof v === 'object') {
          out.push(`${pad}${k}:`)
          out.push(...dumpYaml(v, indent + 2))
        } else {
          out.push(`${pad}${k}: ${yamlStringifyValue(v)}`)
        }
      }
      return out
    }
    return [`${pad}${yamlStringifyValue(obj)}`]
  }

  function readPromptFileText(absPath: string, label = 'promptFile') {
    const target = safeString(absPath).trim()
    if (!target) throw new Error(`missing_${label}`)
    if (!fs.existsSync(target)) throw new Error(`${label}_missing:${target}`)
    const text = safeString(fs.readFileSync(target, 'utf8')).trim()
    if (!text) throw new Error(`${label}_empty:${target}`)
    return text
  }

  const apply = (ctx, config) => {
    const root = dataDir
    const chatsRoot = path.join(root, 'chats')
    const identityPath = path.join(root, 'identity.json')
    const restartMarkerPath = path.join(root, 'restart.json')
    const schedulesPath = path.join(root, 'schedules.json')
    const schedulesStatePath = path.join(root, 'schedules.state.json')
    ensureDir(chatsRoot)
    const workspaceRoot = homeRoot
    // When compiled, this plugin lives in `dist/`; keep repoRoot anchored to the code checkout.
    const here = __dirname
    const nested = ['dist', 'src'].includes(path.basename(here))
    const repoRoot = path.resolve(process.env.RIN_REPO_ROOT || path.resolve(here, nested ? '..' : '.', '..', '..'))
    const isShuttingDown = () => Boolean(globalThis.__RIN_KOISHI_SHUTTING_DOWN)
    const processStartedAtMs = nowMs()
    const scheduleRunQueue: { p: Promise<any> } = { p: Promise.resolve() }
    const scheduleCommandQueue: { active: number, limit: number, pending: Array<any> } = {
      active: 0,
      limit: Math.max(1, Number((config as any)?.scheduleCommandConcurrency || 0) || 4),
      pending: [],
    }
    const configuredPiProvider = safeString((config as any)?.provider || (config as any)?.piProvider || 'openai').trim()
    const configuredPiModel = safeString((config as any)?.model || (config as any)?.piModel || 'gpt-5.4').trim()
    const configuredPiThinking = safeString((config as any)?.thinking || (config as any)?.piThinking || '').trim()
    const scheduleInFlight = new Set()
    let schedulesCache = null
    let schedulesCacheMtime = 0
    let schedulesStateCache = null
    let schedulesStateCacheMtime = 0

    function shouldDisableBareDirectCommandSuggest(session: any) {
      const stripped = session?.stripped && typeof session.stripped === 'object' ? session.stripped : null
      if (!stripped) return false
      const chatId = safeString(pickChatId(session) || '').trim()
      const directLike = Boolean(session?.isDirect) || !safeString(session?.guildId || '').trim() || chatId.startsWith('private:')
      if (!directLike) return false
      if (stripped.appel) return false
      const content = safeString(session?.content || '')
      const strippedContent = safeString(stripped.content || '')
      if (extractCommandLikeText(content)) return false
      if (extractCommandLikeText(strippedContent)) return false
      return true
    }

    function disableBareDirectCommandSuggest(session: any) {
      const stripped = session?.stripped && typeof session.stripped === 'object' ? session.stripped : null
      if (!stripped) return
      if (!shouldDisableBareDirectCommandSuggest(session)) return
      stripped.prefix = null as any
      if ((session as any).__rinBareDirectSuggestDisabled) return
      ;(session as any).__rinBareDirectSuggestDisabled = true
      if (typeof session.suggest !== 'function') return
      Object.defineProperty(session, 'suggest', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: async () => undefined as any,
      })
    }

    ctx.before('attach', (session) => {
      disableBareDirectCommandSuggest(session)
    }, true)

    function chatLockPath(chatKey) {
      const h = nodeCrypto.createHash('sha256').update(safeString(chatKey)).digest('hex')
      return path.join(root, 'locks', 'chats', `${h}.lock`)
    }

    async function withChatLock(chatKey, fn, meta) {
      const lockPath = chatLockPath(chatKey)
      const release = await acquireExclusiveFileLock(lockPath, {
        pollMs: 120,
        heartbeatMs: 10_000,
        staleMs: 2 * 60 * 1000,
        meta: meta && typeof meta === 'object' ? meta : { chatKey: safeString(chatKey) },
      })
      try {
        return await fn()
      } finally {
        try { release() } catch {}
      }
    }

    function defaultSchedules() {
      return { version: 1, timers: [], inspections: [] }
    }

    function normalizeSchedules(obj) {
      const x = obj && typeof obj === 'object' ? obj : {}
      const timers = (Array.isArray(x.timers) ? x.timers : []).map((it: any) => {
        if (!it || typeof it !== 'object') return it
        return { ...it, chatKey: safeString(it.chatKey) }
      })
      const inspections = (Array.isArray(x.inspections) ? x.inspections : []).map((it: any) => {
        if (!it || typeof it !== 'object') return it
        const out = { ...it }
        delete (out as any).chatKey
        return out
      })
      return {
        version: 1,
        timers,
        inspections,
      }
    }

    function normalizeSchedulesState(obj) {
      const x = obj && typeof obj === 'object' ? obj : {}
      const state = x.state && typeof x.state === 'object' ? x.state : {}
      return { version: 1, state }
    }

    function getSchedules() {
      try {
        const st = fs.statSync(schedulesPath)
        if (!schedulesCache || st.mtimeMs !== schedulesCacheMtime) {
          schedulesCache = normalizeSchedules(readJson(schedulesPath, defaultSchedules()))
          schedulesCacheMtime = st.mtimeMs
        }
      } catch {
        schedulesCache = normalizeSchedules(readJson(schedulesPath, defaultSchedules()))
        schedulesCacheMtime = 0
      }
      return schedulesCache
    }

    function getSchedulesState() {
      try {
        const st = fs.statSync(schedulesStatePath)
        if (!schedulesStateCache || st.mtimeMs !== schedulesStateCacheMtime) {
          schedulesStateCache = normalizeSchedulesState(readJson(schedulesStatePath, { version: 1, state: {} }))
          schedulesStateCacheMtime = st.mtimeMs
        }
      } catch {
        schedulesStateCache = normalizeSchedulesState(readJson(schedulesStatePath, { version: 1, state: {} }))
        schedulesStateCacheMtime = 0
      }
      return schedulesStateCache
    }

    function saveSchedulesConfig(next) {
      const normalized = normalizeSchedules(next)
      writeJsonAtomic(schedulesPath, normalized)
      try {
        const st = fs.statSync(schedulesPath)
        schedulesCache = normalized
        schedulesCacheMtime = st.mtimeMs
      } catch {}
    }

    function saveSchedulesState(next) {
      const normalized = normalizeSchedulesState(next)
      writeJsonAtomic(schedulesStatePath, normalized)
      try {
        const st = fs.statSync(schedulesStatePath)
        schedulesStateCache = normalized
        schedulesStateCacheMtime = st.mtimeMs
      } catch {}
    }

    function stateKey(kind, name) {
      return `${safeString(kind)}:${safeString(name)}`
    }

    function getScheduleRuntime(kind, name) {
      const st = getSchedulesState()
      const k = stateKey(kind, name)
      const v = st && st.state && typeof st.state === 'object' ? st.state[k] : null
      return v && typeof v === 'object' ? v : { lastDueAtMs: 0, lastRunAtMs: 0, lastOkAtMs: 0, lastError: '' }
    }

    function patchScheduleRuntime(kind, name, patch) {
      const st = getSchedulesState()
      const k = stateKey(kind, name)
      const stateObj = st && st.state && typeof st.state === 'object' ? st.state : {}
      const prev = stateObj[k] && typeof stateObj[k] === 'object' ? stateObj[k] : {}
      const next = { ...prev, ...patch }
      const out = { version: 1, state: { ...stateObj, [k]: next } }
      saveSchedulesState(out)
    }

    function alignedScheduleSlotAt(item, ts) {
      const startAt = Number(item && item.startAtMs)
      const interval = Number(item && item.intervalMs)
      if (!Number.isFinite(startAt) || !Number.isFinite(interval) || interval <= 0) return 0
      if (!(Number(ts) >= startAt)) return 0
      return startAt + Math.floor((Number(ts) - startAt) / interval) * interval
    }

    function maybeSnapScheduleAnchorAfterRun(kind, item, startedAt, finishedAt) {
      if (safeString(kind) !== 'inspect') return
      const name = safeString(item && item.name)
      if (!name) return
      const interval = Number(item && item.intervalMs)
      if (!Number.isFinite(interval) || interval <= 0) return
      const startMs = Number(startedAt) || 0
      const finishMs = Number(finishedAt) || 0
      if (!(startMs > 0) || !(finishMs >= startMs)) return
      const elapsedMs = finishMs - startMs
      const snapThresholdMs = 60 * 60 * 1000
      if (interval - elapsedMs <= snapThresholdMs) return
      const alignedSlotAt = alignedScheduleSlotAt(item, startMs)
      if (!(alignedSlotAt > 0)) return
      const runtime = getScheduleRuntime(kind, name)
      const prevLastDueAt = Number(runtime && runtime.lastDueAtMs) || 0
      if (alignedSlotAt > prevLastDueAt) patchScheduleRuntime(kind, name, { lastDueAtMs: alignedSlotAt })
    }

    // Schedules advance by anchored due slots and keep at least one interval between starts.
    function nextDueForSchedule(item, runtime, now) {
      const startAt = Number(item && item.startAtMs)
      const interval = Number(item && item.intervalMs)
      if (!Number.isFinite(startAt) || !Number.isFinite(interval) || interval <= 0) return { due: false, dueAt: 0, nextAt: 0, slotAt: 0 }
      if (now < startAt) return { due: false, dueAt: startAt, nextAt: startAt, slotAt: startAt }
      const lastDueAt = Number(runtime && runtime.lastDueAtMs) || 0
      const lastStartedAt = Number(runtime && runtime.lastRunAtMs) || 0
      const enabled = item && typeof item === 'object' ? Boolean(item.enabled) : false
      const slotAt = lastDueAt >= startAt ? lastDueAt + interval : startAt
      const minStartGapDueAt = lastStartedAt > 0 ? lastStartedAt + interval : 0
      const driftCorrectionWindowMs = 60 * 60 * 1000
      const dueAt = lastStartedAt > 0 && slotAt - lastStartedAt < driftCorrectionWindowMs
        ? minStartGapDueAt
        : slotAt
      const due = enabled && now >= dueAt
      return { due, dueAt, nextAt: due ? dueAt + interval : dueAt, slotAt }
    }

    // Seed identity.json with a neutral owner record; chat aliases live in identity.json.
    if (!fs.existsSync(identityPath)) {
      const seed = { persons: { owner: { trust: 'OWNER' } }, aliases: [], trusted: [] }
      writeJsonAtomic(identityPath, seed)
    }

    const perChat = new Map()
    const debounceTimers = new Map()
    let identityCache = null
    let identityCacheMtime = 0
    const outboundAt = new Map()
    const mediaCache = new Map()
    function resetEphemeral(_chatKey) {}

    function isSelfMessage(session) {
      const selfId = session?.bot?.selfId
      const userId = session?.userId
      if (!selfId || !userId) return false
      return String(selfId) === String(userId)
    }

	    function pseudoSessionFromParsed(parsed, content = '') {
	      const isGroup = parsed.platform === 'onebot' && !String(parsed.chatId).startsWith('private:')
	      return {
	        platform: parsed.platform,
	        channelId: parsed.chatId,
	        guildId: isGroup ? String(parsed.chatId) : undefined,
	        type: 'message',
	        content: safeString(content || ''),
	        elements: [],
	        bot: { selfId: safeString(parsed && parsed.botId || '') },
	      }
	    }

    async function enqueueRestartResumeIntent({
      chatKey,
      requestId = '',
      reason = '',
      requestedAt = 0,
      markerTs = 0,
    }: any = {}) {
      const nextChatKey = safeString(chatKey || '').trim()
      const parsed = parseChatKey(nextChatKey)
      if (!parsed) return { ok: false, error: 'invalid_chatKey' }

      const syntheticText = buildBridgeRestartResumeThreadText({
        requestId,
        reason,
        startupText: localizedDaemonStatusText('startup'),
      })
      const messageSuffix = safeString(requestId || '').trim() || String(Math.max(0, Number(markerTs || requestedAt || nowMs()) || nowMs()))
      const syntheticMessageId = `daemon-restart:${messageSuffix}`
      const pseudo = pseudoSessionFromParsed(parsed, syntheticText)
      let appended = false

      await withChatLock(nextChatKey, async () => {
        if (isShuttingDown()) throw new Error('daemon_shutting_down')
        const { platform, chatId, chatDir, state, saveState } = getChatCtx(pseudo)
        const recent = Array.isArray(state.recentMessageIds) ? state.recentMessageIds : []
        if (recent.includes(syntheticMessageId)) return

        recent.push(syntheticMessageId)
        while (recent.length > 200) recent.shift()
        state.recentMessageIds = recent

        const tsMs = nowMs()
        state.lastSeq = (state.lastSeq || 0) + 1
        state.lastInboundSeq = state.lastSeq
        state.lastInboundText = syntheticText

        const effectiveChatType = pseudo.guildId ? 'group' : 'private'
        const record = {
          seq: state.lastSeq,
          ts: Math.floor(tsMs / 1000),
          platform,
          chatId: String(chatId),
          chatType: effectiveChatType,
          messageId: syntheticMessageId,
          sender: { userId: '', name: 'Daemon', trust: 'SYSTEM' },
          text: syntheticText,
          elements: [],
          raw: {
            agentVisible: true,
            system: 'daemon_restart_resume',
            requestId: safeString(requestId || '').trim(),
            reason: safeString(reason || '').trim(),
            requestedAt: Number(requestedAt || 0) || 0,
            markerTs: Number(markerTs || 0) || 0,
          },
        }
        appendJsonl(path.join(chatDir, 'logs', `${isoDate(tsMs)}.jsonl`), record)

        applyInboundRecord({
          state,
          record,
          tsMs,
          agentVisible: true,
        })
        queueConversationTrigger({
          state,
          trigger: buildConversationTrigger({
            record,
            userId: '',
            senderName: 'Daemon',
            isMentioned: false,
            chatType: effectiveChatType,
          }),
          mergePendingTrigger,
        })
        saveState()
        appended = true
      }, { op: 'startup_restart_resume', chatKey: nextChatKey })

      if (!appended) return { ok: true, duplicate: true, chatKey: nextChatKey, messageId: syntheticMessageId }

      if (!isShuttingDown()) {
        scheduleActivation(nextChatKey, () => {
          activate(pseudo).catch((e) => logger.error(e))
        }, 0, 0)
      }

      return { ok: true, chatKey: nextChatKey, messageId: syntheticMessageId }
    }

    function logOutbound({ parsed, chatKey, text, elements = [], images, files, via = 'rin-send', replyToMessageId = '', messageIds = [] }) {
      try {
        const pseudo = pseudoSessionFromParsed(parsed)
        const { platform, chatId, chatDir, state, saveState } = getChatCtx(pseudo)
        const statePath = path.join(chatDir, 'state.json')
        const disk = readJson(statePath, null) || defaultState(chatKey)
        const prevLastSeq = Math.max(Number(disk.lastSeq || 0), Number(state.lastSeq || 0))
        const prevProcessed = Math.max(Number(disk.lastProcessedSeq || 0), Number(state.lastProcessedSeq || 0))
        const nextSeq = prevLastSeq + 1
        state.lastSeq = nextSeq
        if (prevProcessed >= prevLastSeq) state.lastProcessedSeq = nextSeq
        saveState()

        const ts = nowMs()
        const imgEls = (Array.isArray(images) ? images : [])
          .map((img) => (img && typeof img === 'object' ? safeString(img.path) : ''))
          .filter(Boolean)
          .map((p) => ({ type: 'img', attrs: { src: '', localPath: p } }))

        const fileEls = (Array.isArray(files) ? files : [])
          .map((f) => (f && typeof f === 'object' ? { path: safeString(f.path), name: safeBasename(f.name) } : { path: '', name: '' }))
          .filter((x) => x.path)
          .map((x) => ({ type: 'file', attrs: { src: '', localPath: x.path, name: x.name } }))

        const normalizedMessageIds = normalizeMessageIds(messageIds)

        const record = {
          seq: nextSeq,
          ts: Math.floor(ts / 1000),
          platform,
          chatId: String(chatId),
          chatType: pseudo.guildId ? 'group' : 'private',
          messageId: normalizedMessageIds[0] || '',
          sender: { userId: '', name: 'Rin', trust: 'BOT' },
          text: safeString(text || ''),
          elements: [...compactElements(elements), ...imgEls, ...fileEls],
          raw: { direction: 'out', via, replyTo: safeString(replyToMessageId || ''), messageIds: normalizedMessageIds },
        }
        appendJsonl(path.join(chatDir, 'logs', `${isoDate(ts)}.jsonl`), record)
      } catch {}
    }

    function recentOutboundRecords(chatDir, { minSeqExclusive = 0, minTsMs = 0 } = {}) {
      const out: Array<any> = []
      try {
        const toDate = isoDate(nowMs())
        const fromDate = isoDate(nowMs() - 2 * 24 * 3600 * 1000)
        const logFiles = listLogFiles(chatDir, fromDate, toDate)
        for (const p of logFiles) {
          let content = ''
          try { content = fs.readFileSync(p, 'utf8') } catch { content = '' }
          if (!content) continue
          for (const line of content.split('\n')) {
            const t = line.trim()
            if (!t) continue
            let obj
            try { obj = JSON.parse(t) } catch { continue }
            const seq = Number(obj && obj.seq)
            const tsMs = Math.floor(Number(obj && obj.ts) * 1000)
            const isOutbound = safeString(obj && obj.raw && obj.raw.direction) === 'out'
            if (!isOutbound) continue
            if (Number.isFinite(seq) && seq <= Number(minSeqExclusive || 0)) continue
            if (Number.isFinite(tsMs) && Number(minTsMs || 0) > 0 && tsMs < Number(minTsMs || 0)) continue
            out.push(obj)
          }
        }
      } catch {}
      return out
    }

    function readChatLogRecordsInSeqRange(chatDir, {
      minSeqInclusive = 0,
      maxSeqInclusive = Number.MAX_SAFE_INTEGER,
      inboundOnly = false,
    }: any = {}) {
      const out: Array<any> = []
      try {
        const files = listAllCurrentLogFiles(chatDir)
        for (const p of files) {
          let content = ''
          try { content = fs.readFileSync(p, 'utf8') } catch { content = '' }
          if (!content) continue
          for (const line of content.split('\n')) {
            const t = line.trim()
            if (!t) continue
            let obj
            try { obj = JSON.parse(t) } catch { continue }
            const seq = Number(obj && obj.seq)
            if (!Number.isFinite(seq)) continue
            if (seq < Number(minSeqInclusive || 0) || seq > Number(maxSeqInclusive || 0)) continue
            const isOutbound = safeString(obj && obj.raw && obj.raw.direction) === 'out'
            if (inboundOnly && isOutbound) continue
            out.push(obj)
          }
        }
      } catch {}
      out.sort((a, b) => Number(a && a.seq || 0) - Number(b && b.seq || 0))
      return out
    }

    function shouldSkipThreadHistoryRecord(record: any) {
      if (!record || typeof record !== 'object') return true
      const isOutbound = safeString(record && record.raw && record.raw.direction) === 'out'
      if (isOutbound) return true
      return !isAgentVisibleRecord(record)
    }

    function isAgentVisibleRecord(record: any) {
      if (!record || typeof record !== 'object') return false
      const raw = record && typeof record.raw === 'object' ? record.raw : {}
      if (Object.prototype.hasOwnProperty.call(raw, 'agentVisible')) return Boolean(raw.agentVisible)
      const chatType = safeString(record && record.chatType || '')
      const trust = safeString(record && record.sender && record.sender.trust || '')
      const commandLike = safeString(raw.commandLike || extractCommandLikeText(record && record.text || ''))
      const mentionLike = Boolean(raw.isMentioned || raw.replyToBot)
      return shouldSurfaceInboundToAgent({ chatType, trust, mentionLike, commandLike })
    }

    function buildThreadHistoryInputsFromRecord(record: any) {
      const inputs: Array<any> = []
      if (!record || typeof record !== 'object') return inputs

      const sender = record && typeof record.sender === 'object' ? record.sender : {}
      const senderName = safeString(sender.name || '')
      const senderUserId = safeString(sender.userId || '')
      const senderTrust = safeString(sender.trust || 'OTHER') || 'OTHER'
      const raw = record && typeof record.raw === 'object' ? record.raw : {}
      const replyToMessageId = safeString(raw.replyTo || raw.replyToMessageId || '')
      const body = safeString(record.text || '')
      const elements = Array.isArray(record.elements) ? record.elements : []

      const fileNames = elements
        .filter((el) => {
          if (!el || typeof el !== 'object') return false
          if (safeString(el.type || '') === 'img') return false
          return Boolean(safeString(el.attrs && el.attrs.localPath || ''))
        })
        .map((el) => safeBasename(el && el.attrs && el.attrs.name))
        .filter(Boolean)

      const lines: string[] = ['[Sender]']
      if (senderName || senderUserId) lines.push(`name: ${senderName || senderUserId}`)
      lines.push(`identity: ${senderTrust}`)

      if (replyToMessageId) {
        lines.push('', '[Reply]', `replyToMessageId: ${replyToMessageId}`)
      }

      if (body) {
        lines.push('', '[Message]', body)
      }

      if (fileNames.length) {
        lines.push('', '[Attachments]', `files: ${fileNames.join(', ')}`)
      }

      const text = lines.join('\n').trim()
      if (text) inputs.push({ type: 'text', text })

      const seenImagePaths = new Set<string>()
      for (const el of elements) {
        if (!el || typeof el !== 'object') continue
        if (safeString(el.type || '') !== 'img') continue
        const localPath = safeString(el.attrs && el.attrs.localPath || '')
        if (!localPath || seenImagePaths.has(localPath) || !fs.existsSync(localPath)) continue
        seenImagePaths.add(localPath)
        inputs.push({ type: 'localImage', path: localPath })
      }

      return inputs
    }

    function collectRecordAttachmentContext(record: any, {
      maxImages = 6,
      maxAttachments = 12,
    }: any = {}) {
      const attachImages: Array<string> = []
      const attachments: Array<any> = []
      const seenLocalPaths = new Set<string>()
      if (!record || typeof record !== 'object') return { attachImages, attachments }

      const seq = Number(record && record.seq || 0)
      const messageId = safeString(record && record.messageId || '')
      const elements = Array.isArray(record.elements) ? record.elements : []
      for (const el of elements) {
        if (attachImages.length >= Number(maxImages || 0) && attachments.length >= Number(maxAttachments || 0)) break
        if (!el || typeof el !== 'object') continue
        const localPath = safeString(el.attrs && el.attrs.localPath || '')
        if (!localPath || !fs.existsSync(localPath) || seenLocalPaths.has(localPath)) continue
        seenLocalPaths.add(localPath)
        if (attachments.length < Number(maxAttachments || 0)) {
          attachments.push({
            seq,
            messageId,
            type: safeString(el && el.type),
            name: safeBasename(el && el.attrs && el.attrs.name),
            mime: safeString(el && el.attrs && el.attrs.mime),
            localPath,
          })
        }
        if (attachImages.length < Number(maxImages || 0) && safeString(el && el.type) === 'img') {
          attachImages.push(localPath)
        }
      }

      return { attachImages, attachments }
    }

    async function materializeRecordMedia({ chatDir, tsMs, elements }) {
      if (!Array.isArray(elements) || elements.length === 0) return elements
      const day = isoDate(tsMs || nowMs())
      const mediaDir = path.join(chatDir, 'media', day)
      ensureDir(mediaDir)

      const out = elements.map((e) => ({ type: e.type, attrs: { ...(e.attrs || {}) } }))
      let downloaded = 0
      const MAX_ITEMS = 10
      const MAX_BYTES = 16 * 1024 * 1024
      const MAX_LOCAL_COPY_BYTES = 64 * 1024 * 1024
      const dataRoot = path.resolve(chatDir, '..', '..', '..')
      const tmpRoot = os.tmpdir()

      const isAllowedLocalPath = (p) => {
        const abs = path.resolve(String(p || ''))
        if (!abs) return false
        if (abs === dataRoot || abs.startsWith(dataRoot + path.sep)) return true
        if (tmpRoot && (abs === tmpRoot || abs.startsWith(tmpRoot + path.sep))) return true
        return false
      }

      const downloadHttp = async (url) => {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 12_000)
        try {
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) return null
          const ct = res.headers.get('content-type') || 'application/octet-stream'
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length > MAX_BYTES) return null
          return { ct, buf }
        } catch {
          return null
        } finally {
          clearTimeout(t)
        }
      }

      for (const el of out) {
        if (!el || (el.type !== 'img' && el.type !== 'file' && el.type !== 'audio' && el.type !== 'video')) continue
        const src = safeString(el.attrs && el.attrs.src)
        if (!src) continue
        if (downloaded >= MAX_ITEMS) break

        const cached = mediaCache.get(src)
        if (cached && fs.existsSync(cached)) {
          el.attrs.localPath = cached
          continue
        }

        const data = parseDataUrl(src) || parseBase64Url(src)
        if (data) {
          if (data.buf.length > MAX_BYTES) continue
          const nameHint = safeBasename(el.attrs && el.attrs.name)
          const ext = safeExtFromName(nameHint) || extFromMime(data.mime)
          const name = `${Date.now()}-${nodeCrypto.randomBytes(6).toString('hex')}${ext}`
          const p = path.join(mediaDir, name)
          try {
            fs.writeFileSync(p, data.buf)
            el.attrs.localPath = p
            el.attrs.mime = data.mime
            mediaCache.set(src, p)
            downloaded++
          } catch {}
          continue
        }

        if (src.startsWith('file://')) {
          try {
            const fp = fileURLToPath(src)
            if (!isAllowedLocalPath(fp)) continue
            const st = fs.statSync(fp)
            if (!st.isFile()) continue
            if (st.size > MAX_LOCAL_COPY_BYTES) continue
            const nameHint = safeBasename(el.attrs && el.attrs.name) || path.basename(fp)
            const ext = safeExtFromName(nameHint) || safeExtFromName(fp) || extFromMime(guessMimeFromPath(fp))
            const name = `${Date.now()}-${nodeCrypto.randomBytes(6).toString('hex')}${ext}`
            const p = path.join(mediaDir, name)
            fs.copyFileSync(fp, p)
            el.attrs.localPath = p
            if (nameHint) el.attrs.name = nameHint
            mediaCache.set(src, p)
            downloaded++
          } catch {}
          continue
        }

        // Some adapters may provide a plain absolute file path.
        if (path.isAbsolute(src)) {
          try {
            if (!isAllowedLocalPath(src)) continue
            const st = fs.statSync(src)
            if (!st.isFile()) continue
            if (st.size > MAX_LOCAL_COPY_BYTES) continue
            const nameHint = safeBasename(el.attrs && el.attrs.name) || path.basename(src)
            const ext = safeExtFromName(nameHint) || safeExtFromName(src) || extFromMime(guessMimeFromPath(src))
            const name = `${Date.now()}-${nodeCrypto.randomBytes(6).toString('hex')}${ext}`
            const p = path.join(mediaDir, name)
            fs.copyFileSync(src, p)
            el.attrs.localPath = p
            if (nameHint) el.attrs.name = nameHint
            mediaCache.set(src, p)
            downloaded++
          } catch {}
          continue
        }

        if (src.startsWith('http://') || src.startsWith('https://')) {
          const got = await downloadHttp(src)
          if (!got) continue
          const nameHint = safeBasename(el.attrs && el.attrs.name)
          const ext = safeExtFromName(nameHint) || extFromMime(got.ct)
          const name = `${Date.now()}-${nodeCrypto.randomBytes(6).toString('hex')}${ext}`
          const p = path.join(mediaDir, name)
          try {
            fs.writeFileSync(p, got.buf)
            el.attrs.localPath = p
            el.attrs.mime = got.ct
            mediaCache.set(src, p)
            downloaded++
          } catch {}
        }
      }

      return out
    }

    async function fixupTelegramMediaElements(session, baseElements) {
      if (session?.platform !== 'telegram') return baseElements
      const elements = Array.isArray(baseElements) ? baseElements.map((e) => ({ type: e.type, attrs: { ...(e.attrs || {}) } })) : []
      const hasEmptyImg = elements.some((e) => e && e.type === 'img' && !safeString(e.attrs && e.attrs.src))
      const maybeHasImg = safeString(session?.content).includes('<img')
      if (!hasEmptyImg && !maybeHasImg) return elements

      const bot = findBot('telegram', safeString(session?.bot?.selfId || ''))
      if (!bot) return elements

      const msg = pickTelegramMessageLike(session)
      if (!msg || typeof msg !== 'object') return elements

      const fileIds = []
      try {
        if (Array.isArray(msg.photo) && msg.photo.length) {
          const photo = msg.photo.slice().sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0]
          if (photo?.file_id) fileIds.push(String(photo.file_id))
        }
        if (msg.sticker?.file_id) fileIds.push(String(msg.sticker.file_id))
        if (msg.animation?.file_id) fileIds.push(String(msg.animation.file_id))
        if (msg.document?.file_id) fileIds.push(String(msg.document.file_id))
        if (msg.video?.file_id) fileIds.push(String(msg.video.file_id))
      } catch {}

      const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)))
      if (!uniqueIds.length) return elements

      const items = []
      for (const id of uniqueIds) {
        if (items.length >= 6) break
        try {
          let src = ''
          if (typeof bot.$getFileFromId === 'function') {
            const attrs = await bot.$getFileFromId(id)
            src = safeString(attrs && attrs.src)
          }
          // Fallback: fetch file via Telegram Bot API directly (avoids adapter/http hooks).
          if (!src && bot.internal && typeof bot.internal.getFile === 'function') {
            const file = await bot.internal.getFile({ file_id: id })
            const filePath = safeString(file && file.file_path)
            const token = safeString(bot.config && bot.config.token)
            if (filePath && token) {
              const url = `https://api.telegram.org/file/bot${token}/${filePath}`
              const controller = new AbortController()
              const t = setTimeout(() => controller.abort(), 12_000)
              try {
                const res = await fetch(url, { signal: controller.signal })
                if (res.ok) {
                  const buf = Buffer.from(await res.arrayBuffer())
                  const mime = res.headers.get('content-type') || guessMimeFromPath(filePath)
                  src = `data:${mime};base64,${buf.toString('base64')}`
                }
              } finally {
                clearTimeout(t)
              }
            }
          }
          if (src) items.push({ src, mime: src.startsWith('data:') ? tryMimeFromDataUrl(src) : '' })
        } catch {}
      }
      if (!items.length) return elements

      const pending = items.slice()
      const take = (pred) => {
        const idx = pending.findIndex(pred)
        if (idx < 0) return null
        return pending.splice(idx, 1)[0]
      }

      for (const el of elements) {
        if (!el || !el.type) continue
        const hasSrc = safeString(el.attrs && el.attrs.src)
        if (hasSrc) continue

        if (el.type === 'img') {
          const item = take((x) => safeString(x.mime).startsWith('image/')) || take(() => true)
          if (!item) continue
          el.attrs ||= {}
          el.attrs.src = item.src
          continue
        }
        if (el.type === 'file' || el.type === 'video' || el.type === 'audio') {
          const item = take((x) => !safeString(x.mime).startsWith('image/')) || take(() => true)
          if (!item) continue
          el.attrs ||= {}
          el.attrs.src = item.src
        }
      }

      while (pending.length && elements.length < 12) {
        const item = pending.shift()
        if (!item) break
        const mime = safeString(item.mime)
        const type = mime.startsWith('image/') ? 'img' : 'file'
        elements.push({ type, attrs: { src: item.src } })
      }
      return elements
    }

    function parseChatKey(chatKey) {
      const match = safeString(chatKey || '').trim().match(/^([^/:]+)(?:\/([^:]+))?:(.+)$/)
      if (!match) return null
      const [, platform, botId = '', chatId] = match
      if (!platform || !chatId) return null
      return { platform, botId, chatId }
    }

    function composeRuntimeChatKey(platform, chatId, botId = '') {
      const nextPlatform = safeString(platform || '').trim()
      const nextChatId = safeString(chatId || '').trim()
      const nextBotId = safeString(botId || '').trim()
      if (!nextPlatform || !nextChatId) return ''
      return nextBotId ? `${nextPlatform}/${nextBotId}:${nextChatId}` : `${nextPlatform}:${nextChatId}`
    }

    function chatDirForParsed(parsed) {
      if (!parsed || !parsed.platform || !parsed.chatId) return ''
      return parsed.botId
        ? path.join(chatsRoot, parsed.platform, String(parsed.botId), String(parsed.chatId))
        : path.join(chatsRoot, parsed.platform, String(parsed.chatId))
    }

    function findBot(platform, botId = '') {
      const bots = ctx.bots || []
      const nextPlatform = safeString(platform || '').trim()
      const nextBotId = safeString(botId || '').trim()
      const matches = bots.filter((b) => b && b.platform === nextPlatform)
      if (!matches.length) return null
      if (!nextBotId) return matches[0]
      return matches.find((b) => safeString(b && b.selfId || '').trim() === nextBotId) || null
    }

    async function sendToChat({ chatKey, parsed, text, elements = [], images, files, via = 'rin-send', replyToMessageId = '' }) {
      // IMPORTANT (owner agreement):
      // When a Codex run is triggered by an inbound message, all outbound messages during that run
      // must reply/quote the triggering message (if the platform supports it).
      const msgTextPlain = safeString(text)
      const msgElements = elementsToMessageFragments(parsed.platform, elements)
      const imgList = Array.isArray(images) ? images : []
      const fileList = Array.isArray(files) ? files : []
      const quoteId = safeString(replyToMessageId)
      const outboundMessageIds = []

      const bot = findBot(parsed.platform, parsed.botId)
      if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ''}`)

      // Telegram note: bot.internal uses JSON POST and does not support uploading raw binary buffers.
      // Use it only for text messages; send images through the normal Satori sendMessage path.
      if (parsed.platform === 'telegram' && bot.internal && imgList.length === 0 && fileList.length === 0) {
        const internal = bot.internal
        const replyTo = quoteId && Number.isFinite(Number(quoteId)) ? Number(quoteId) : undefined
        const sent = await internal.sendMessage({
          chat_id: parsed.chatId,
          text: msgTextPlain,
          reply_to_message_id: replyTo,
        })
        outboundMessageIds.push(...normalizeMessageIds([
          sent && typeof sent === 'object' ? sent.message_id : '',
          sent && typeof sent === 'object' ? sent.messageId : '',
        ]))
        outboundAt.set(chatKey, nowMs())
        logOutbound({ parsed, chatKey, text: msgTextPlain, elements: [], images: imgList, files: fileList, via, replyToMessageId: quoteId, messageIds: outboundMessageIds })
        return
      }

      if (imgList.length || fileList.length) {
        let firstCaption = msgTextPlain
        const prefix = []
        if (quoteId) prefix.push(h.quote(quoteId))
        if (msgElements.length) prefix.push(...msgElements)
        for (const img of imgList) {
          const p = img && typeof img === 'object' ? img.path : null
          if (!p) continue
          const buf2 = fs.readFileSync(String(p))
          const mime = (img && typeof img === 'object' && img.mime) ? safeString(img.mime) : guessMimeFromPath(p)
          const content = firstCaption ? [...prefix, h.image(buf2, mime), '\n', firstCaption] : [...prefix, h.image(buf2, mime)]
          firstCaption = ''
          const sent = await bot.sendMessage(parsed.chatId, content)
          outboundMessageIds.push(...normalizeMessageIds(sent))
        }
        for (const f of fileList) {
          const p = f && typeof f === 'object' ? f.path : null
          if (!p) continue
          const buf2 = fs.readFileSync(String(p))
          const mime = (f && typeof f === 'object' && f.mime) ? safeString(f.mime) : guessMimeFromPath(p)
          const name = safeBasename((f && typeof f === 'object' ? f.name : '') || path.basename(p))
          const content = firstCaption
            ? [...prefix, h.file(buf2, mime, { name }), '\n', firstCaption]
            : [...prefix, h.file(buf2, mime, { name })]
          firstCaption = ''
          const sent = await bot.sendMessage(parsed.chatId, content)
          outboundMessageIds.push(...normalizeMessageIds(sent))
        }
      } else {
        if (!quoteId && msgElements.length === 0) {
          const sent = await bot.sendMessage(parsed.chatId, msgTextPlain)
          outboundMessageIds.push(...normalizeMessageIds(sent))
        } else {
          const content = []
          if (quoteId) content.push(h.quote(quoteId))
          if (msgElements.length) content.push(...msgElements)
          if (msgTextPlain) {
            const needsSpace = msgElements.length && !/^[\s\n]/.test(msgTextPlain)
            if (needsSpace) content.push(' ')
            content.push(msgTextPlain)
          }
          const sent = await bot.sendMessage(parsed.chatId, content)
          outboundMessageIds.push(...normalizeMessageIds(sent))
        }
      }

      outboundAt.set(chatKey, nowMs())
      logOutbound({ parsed, chatKey, text: msgTextPlain, elements: compactElements(elements), images: imgList, files: fileList, via, replyToMessageId: quoteId, messageIds: outboundMessageIds })
    }
    sendToChatRef = sendToChat

    function getIdentity() {
      try {
        const st = fs.statSync(identityPath)
        if (!identityCache || st.mtimeMs !== identityCacheMtime) {
          identityCache = parseIdentity(identityPath)
          identityCacheMtime = st.mtimeMs
        }
      } catch {
        identityCache = parseIdentity(identityPath)
        identityCacheMtime = 0
      }
      return identityCache
    }

    function getChatCtx(session) {
		      const platform = session.platform
		      const chatId = pickChatId(session)
        const botId = safeString(session && session.bot && session.bot.selfId || '').trim()
		      const chatKey = composeRuntimeChatKey(platform, chatId, botId)
		      const chatDir = chatDirForParsed({ platform, botId, chatId })
	      const statePath = path.join(chatDir, 'state.json')
      ensureDir(path.join(chatDir, 'logs'))
      ensureDir(path.join(chatDir, 'batches'))

		      let state = readJson(statePath, null)
			      if (!state) state = defaultState(chatKey)
      const active = getActiveProcessingTurn({ chatKey, processingRunId: state && state.processingRunId })
      const activeRuntime = normalizeRuntimeKind(
        (active && active.runtime)
        || (state && state.processingRuntime)
        || primaryRuntimeForChat(chatKey),
      )
      let hasLiveProcessingPid = false
      if (state && state.processing && state.processingPid) {
        try {
          process.kill(Number(state.processingPid), 0)
          hasLiveProcessingPid = true
        } catch (e) {
          if (!e || e.code !== 'ESRCH') throw e
        }
      }
      state = normalizeConversationState({
        state,
        chatKey,
        normalizeRuntimeKind,
        normalizeLastAgentResult,
        readLegacyThreadHandle,
        writeLegacyThreadHandle,
        readPiSessionFile,
        writePiSessionFile,
        processingActive: Boolean(active),
        processingRuntime: activeRuntime,
        nowMs: nowMs(),
        hasLiveProcessingPid,
      })

	        const saveState = () => {
		        const disk = readJson(statePath, null) || defaultState(chatKey)
        const merged = mergeConversationState({
          disk,
          state,
          chatKey,
          mergePendingTrigger,
          pickNewerLastAgentResult,
          readLegacyThreadHandle,
          writeLegacyThreadHandle,
          readPiSessionFile,
          writePiSessionFile,
        })
	        Object.assign(state, merged)
	        writeJsonAtomic(statePath, state)
	      }
	      return { platform, botId, chatId, chatKey, chatDir, state, saveState }
	    }

    function extractCommandLikeText(text) {
      const s = safeString(text).trim()
      if (!s.startsWith('/')) return ''
      const first = s.split(/\s+/, 1)[0] || ''
      const name = first.split('@')[0]
      if (!/^\/[A-Za-z0-9_][A-Za-z0-9_:-]*$/.test(name)) return ''
      return name
    }

    function parseSlashInvocation(text) {
      const trimmed = safeString(text).trim()
      if (!trimmed.startsWith('/')) return null
      const first = trimmed.split(/\s+/, 1)[0] || ''
      const name = first.split('@')[0]
      if (!/^\/[A-Za-z0-9_][A-Za-z0-9_:-]*$/.test(name)) return null
      const argsText = trimmed.slice(first.length).trim()
      return {
        raw: trimmed,
        name,
        bareName: name.replace(/^\//, ''),
        argsText,
      }
    }

    function parseCommandArgs(argsText: any) {
      const text = safeString(argsText)
      const args: string[] = []
      let current = ''
      let quote: string | null = null
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (quote) {
          if (ch === quote) {
            quote = null
          } else {
            current += ch
          }
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          continue
        }
        if (ch === ' ' || ch === '\t') {
          if (current) {
            args.push(current)
            current = ''
          }
          continue
        }
        current += ch
      }
      if (current) args.push(current)
      return args
    }

    // Group input is agent-visible only for OWNER/TRUSTED mentions or replies. Commands are excluded.
    function shouldSurfaceInboundToAgent({ chatType, trust, mentionLike = false, commandLike = '' }: any = {}) {
      if (safeString(commandLike || '').trim()) return false
      const nextChatType = safeString(chatType).trim()
      const nextTrust = safeString(trust).trim()
      if (nextChatType === 'private') return nextTrust === 'OWNER'
      if (nextChatType === 'group') return Boolean(mentionLike) && (nextTrust === 'OWNER' || nextTrust === 'TRUSTED')
      return false
    }

    function formatStatusTime(tsMs) {
      const ts = Number(tsMs || 0)
      if (!Number.isFinite(ts) || ts <= 0) return 'unknown'
      const d = new Date(ts)
      const pad = (n) => String(Math.trunc(Number(n) || 0)).padStart(2, '0')
      const year = d.getFullYear()
      const month = pad(d.getMonth() + 1)
      const day = pad(d.getDate())
      const hour = pad(d.getHours())
      const minute = pad(d.getMinutes())
      const second = pad(d.getSeconds())
      const offsetMinutes = -d.getTimezoneOffset()
      const sign = offsetMinutes >= 0 ? '+' : '-'
      const abs = Math.abs(offsetMinutes)
      const offsetHour = pad(Math.floor(abs / 60))
      const offsetMinute = pad(abs % 60)
      return `${year}-${month}-${day} ${hour}:${minute}:${second} ${sign}${offsetHour}:${offsetMinute}`
    }

    function normalizeLastAgentResult(raw: any) {
      return normalizeConversationLastAgentResult(raw, normalizeRuntimeKind)
    }

    function pickNewerLastAgentResult(a: any, b: any) {
      return pickNewerConversationLastAgentResult(a, b, normalizeRuntimeKind)
    }

    function summarizeLastAgentResult(result: any) {
      const normalized = normalizeLastAgentResult(result)
      if (!normalized) return 'none'
      const prefix = normalized.runtime ? `${normalized.runtime}: ` : ''
      if (normalized.kind === 'ok') {
        const finalMessage = normalizeBridgeAssistantText(normalized.lastMessage)
        return `${prefix}${finalMessage.kind === 'reply' ? 'reply' : 'completed'}`
      }
      if (normalized.kind === 'interrupted') return `${prefix}INTERRUPTED`
      if (normalized.kind === 'failed') {
        const code = normalized.exitCode == null || Number.isNaN(normalized.exitCode) ? 'unknown' : String(normalized.exitCode)
        return normalized.lastMessage ? `${prefix}FAILED (${code}, ${normalized.lastMessage})` : `${prefix}FAILED (${code})`
      }
      return `${prefix}${normalized.lastMessage || normalized.kind || 'unknown'}`
    }

    function stripHtmlish(s) {
      return safeString(s).replace(/<[^>]*>/g, '').trim()
    }

    function atUserIds(session) {
      const selfId = session?.bot?.selfId || session?.selfId || ''
      const ids = []
      const els = Array.isArray(session?.elements) ? session.elements : []
      for (const el of els) {
        if (!el || el.type !== 'at') continue
        const id = el.attrs?.id
        if (!id) continue
        const sid = String(id)
        if (selfId && sid === String(selfId)) continue
        ids.push(sid)
      }
      return ids
    }

    async function sendBridgeCommandText({ chatKey, parsed, text, replyToMessageId = '' }: any = {}) {
      const nextText = safeString(text).trim()
      if (!nextText) return
      await sendToChat({
        chatKey,
        parsed,
        text: nextText,
        images: [],
        files: [],
        via: 'koishi-cmd',
        replyToMessageId: safeString(replyToMessageId || ''),
      })
    }

    function createHeadlessCommandUi(notices: string[]) {
      const pushNotice = (value: any) => {
        const text = safeString(value).trim()
        if (text) notices.push(text)
      }
      return {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify: (message: string) => pushNotice(message),
        onTerminalInput: () => (() => {}),
        setStatus: (_statusKey: string, statusText?: string) => pushNotice(statusText),
        setWorkingMessage: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        custom: async () => undefined,
        pasteToEditor: (text: string) => pushNotice(text),
        setEditorText: (text: string) => pushNotice(text),
      }
    }

    function builtinBridgeCommands() {
      const rows = Array.isArray(BUILTIN_SLASH_COMMANDS)
        ? BUILTIN_SLASH_COMMANDS.map((command: any) => ({
            name: safeString(command && command.name).trim(),
            description: safeString(command && command.description).trim(),
            source: 'builtin',
          }))
        : []
      rows.push({ name: 'status', description: 'Show status for the current session', source: 'daemon' })
      rows.push({ name: 'restart', description: 'Restart the Rin daemon', source: 'daemon' })
      return rows.filter((item) => item && item.name)
    }

    const TRUSTED_BRIDGE_COMMANDS = new Set(['new'])
    const koishiBridgeCommands = new Map<string, { command: any, description: string }>()

    function normalizeBridgeSlashInvocationFromSession(session: any) {
      const fromText = parseSlashInvocation(safeString(session && session.content || ''))
      if (fromText) return fromText
      const bareName = safeString(session && session.argv && session.argv.command && session.argv.command.name || session && session.command && session.command.name || '').trim().replace(/^\//, '')
      if (!/^[A-Za-z0-9_][A-Za-z0-9_:-]*$/.test(bareName)) return null
      const argvArgs = Array.isArray(session && session.argv && session.argv.args) ? session.argv.args : []
      const argsText = argvArgs.map((value: any) => safeString(value).trim()).filter(Boolean).join(' ').trim()
      return {
        raw: `/${bareName}${argsText ? ` ${argsText}` : ''}`,
        name: `/${bareName}`,
        bareName,
        argsText,
      }
    }

    function canRegisterKoishiBridgeCommand(name: string) {
      return /^[a-z][a-z0-9_]{0,31}$/.test(safeString(name).trim())
    }

    function dedupeBridgeCommands(commands: any[]) {
      const seen = new Set<string>()
      const out: Array<any> = []
      for (const item of Array.isArray(commands) ? commands : []) {
        const name = safeString(item && item.name).trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push({
          ...item,
          name,
          description: safeString(item && item.description).trim(),
        })
      }
      return out
    }

    function canRunBridgeCommand(commandName: string, trust: string) {
      const nextName = safeString(commandName).trim()
      const nextTrust = safeString(trust).trim()
      if (!nextName) return false
      if (nextTrust === 'OWNER') return true
      if (nextTrust === 'TRUSTED') return TRUSTED_BRIDGE_COMMANDS.has(nextName)
      return false
    }

    async function listBridgeSlashCommands(chatKey: string) {
      const controller = await openBridgeCommandSession(chatKey)
      if (!controller) return []
      try {
        return collectBridgeSlashCommandsFromController(controller)
      } finally {
        await controller.dispose()
      }
    }

    async function discoverBridgeSlashCommandsForRegistration() {
      const rows = [...builtinBridgeCommands()]
      const ownerChatKey = preferredOwnerChatKey(root)
      if (ownerChatKey) {
        try {
          rows.push(...(await listBridgeSlashCommands(ownerChatKey)))
        } catch (e) {
          const message = safeString(e && (e as any).message ? (e as any).message : e)
          logger.warn(`bridge command discovery failed chatKey=${ownerChatKey} err=${message}`)
        }
      }
      return dedupeBridgeCommands(rows).filter((item) => canRegisterKoishiBridgeCommand(item && item.name))
    }

    async function runKoishiRegisteredBridgeCommand(session: any, commandName: string, argsText: any) {
      if (!session) return ''
      const nextCommandName = safeString(commandName).trim().replace(/^\//, '')
      if (!nextCommandName) return ''
      const { platform, chatKey } = getChatCtx(session)
      const trust = safeString(getIdentity().trustOf(platform, pickUserId(session))).trim()
      if (!canRunBridgeCommand(nextCommandName, trust)) return ''
      const normalizedArgs = safeString(argsText).trim()
      await runBridgeSlashCommand({
        chatKey,
        text: `/${nextCommandName}${normalizedArgs ? ` ${normalizedArgs}` : ''}`,
        replyToMessageId: safeString(session && session.messageId || ''),
      })
      return ''
    }

    async function syncKoishiBridgeCommands() {
      const discovered = await discoverBridgeSlashCommandsForRegistration()
      const desired = new Map(discovered.map((item) => [safeString(item && item.name).trim(), item]))
      for (const [name, entry] of Array.from(koishiBridgeCommands.entries())) {
        const next = desired.get(name)
        if (next && safeString(entry && entry.description).trim() === safeString(next && next.description).trim()) continue
        try { entry && entry.command && entry.command.dispose?.() } catch {}
        koishiBridgeCommands.delete(name)
      }
      for (const item of discovered) {
        const name = safeString(item && item.name).trim()
        if (!name || koishiBridgeCommands.has(name)) continue
        const description = safeString(item && item.description).trim()
        const command = ctx.command(`${name} [args:text]`, description, { slash: true })
          .action(async ({ session }: any, argsText: any) => await runKoishiRegisteredBridgeCommand(session, name, argsText))
        koishiBridgeCommands.set(name, { command, description })
      }
      for (const bot of Array.isArray(ctx.bots) ? ctx.bots : []) {
        try { await ctx.$commander.updateCommands(bot) } catch {}
      }
    }

    async function resolveBridgeSlashSessionCommand(session: any) {
      const cached = session && session.__rinBridgeSlashResolution
      if (cached) return cached
      const invocation = normalizeBridgeSlashInvocationFromSession(session)
      if (!invocation) {
        const empty = { invocation: null, commandName: '', known: false, authorized: false, trust: '' }
        try { session.__rinBridgeSlashResolution = empty } catch {}
        return empty
      }
      const { platform, chatKey } = getChatCtx(session)
      const identity = getIdentity()
      const trust = safeString(identity.trustOf(platform, pickUserId(session))).trim()
      const commandName = safeString(invocation.bareName).trim()
      let known = new Set(builtinBridgeCommands().map((item) => safeString(item && item.name).trim()).filter(Boolean)).has(commandName)
      if (!known && chatKey) {
        try {
          const commands = await listBridgeSlashCommands(chatKey)
          known = commands.some((item) => safeString(item && item.name).trim() === commandName)
        } catch {}
      }
      const resolved = {
        invocation,
        commandName,
        known,
        authorized: known && canRunBridgeCommand(commandName, trust),
        trust,
      }
      try { session.__rinBridgeSlashResolution = resolved } catch {}
      return resolved
    }

    async function openBridgeCommandSession(chatKey: string) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return null
      const pseudo = pseudoSessionFromParsed(parsed, '')
      const { chatDir, state, saveState } = getChatCtx(pseudo)
      const notices: string[] = []
      const created = await createRinPiSession({
        repoRoot,
        workspaceRoot: homeRoot,
        resourceCwd: repoRoot,
        settingsCwd: homeRoot,
        sessionCwd: repoRoot,
        sessionDir: piSessionDirForChat(chatDir),
        sessionFile: readPiSessionFile(state),
        sessionPolicy: readPiSessionFile(state) ? 'continueRecent' : 'new',
        brainChatKey: chatKey,
        currentChatKey: chatKey,
        enableBrainHooks: false,
      })
      const session = created && created.session
      if (!session) throw new Error('bridge_command_session_missing')
      try {
        await session.bindExtensions({
          uiContext: createHeadlessCommandUi(notices),
          onError: (event: any) => {
            const errorText = safeString(event && event.error || event && event.message || '').trim()
            const extensionPath = safeString(event && event.extensionPath || '').trim()
            if (errorText) notices.push(extensionPath ? `${extensionPath}: ${errorText}` : errorText)
          },
        })
      } catch {}
      return {
        parsed,
        pseudo,
        chatDir,
        state,
        saveState,
        notices,
        created,
        session,
        async dispose() {
          if (session && typeof session.dispose === 'function') {
            try { session.dispose() } catch {}
          }
        },
      }
    }

    function collectBridgeSlashCommandsFromController(controller: any) {
      const reserved = new Set(builtinBridgeCommands().map((item) => safeString(item && item.name).trim()).filter(Boolean))
      const commands: Array<any> = []
      commands.push(...builtinBridgeCommands())
      for (const item of controller.session.extensionRunner?.getRegisteredCommandsWithPaths?.() || []) {
        const name = safeString(item && item.command && item.command.name).trim()
        if (!name || reserved.has(name)) continue
        commands.push({
          name,
          description: safeString(item && item.command && item.command.description).trim(),
          source: 'extension',
          path: safeString(item && item.extensionPath).trim(),
        })
      }
      for (const template of controller.session.promptTemplates || []) {
        const name = safeString(template && template.name).trim()
        if (!name || reserved.has(name)) continue
        commands.push({
          name,
          description: safeString(template && template.description).trim(),
          source: 'prompt',
          path: safeString(template && template.filePath).trim(),
        })
      }
      if (controller.created && controller.created.settingsManager && controller.created.settingsManager.getEnableSkillCommands?.()) {
        for (const skill of controller.created.resourceLoader.getSkills().skills || []) {
          const name = `skill:${safeString(skill && skill.name).trim()}`
          if (!safeString(skill && skill.name).trim() || reserved.has(name)) continue
          commands.push({
            name,
            description: safeString(skill && skill.description).trim(),
            source: 'skill',
            path: safeString(skill && skill.filePath).trim(),
          })
        }
      }
      return commands
    }

    function formatBridgeCommandList(commands: any[]) {
      return (Array.isArray(commands) ? commands : [])
        .map((item) => {
          const name = safeString(item && item.name).trim()
          const description = safeString(item && item.description).trim()
          if (!name) return ''
          return description ? `/${name} — ${description}` : `/${name}`
        })
        .filter(Boolean)
        .join('\n')
    }

    async function handleRestart({ chatKey, restartMessageId = '' }: any = {}) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      try {
        const resp = await requestDaemonSelfRestart({
          chatKey,
          reason: 'slash:/restart',
        })
        if (!(resp && (resp as any).ok)) {
          throw new Error(safeString(resp && (resp as any).error || 'daemon_restart_failed'))
        }
      } catch (e) {
        const message = safeString(e && (e as any).message ? (e as any).message : e) || 'daemon_restart_failed'
        await sendToChat({
          chatKey,
          parsed,
          text: `重启失败：${message}`,
          images: [],
          files: [],
          via: 'koishi-cmd',
          replyToMessageId: safeString(restartMessageId || ''),
        })
      }
    }

    async function buildStatusText(chatKey) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return ''
      const pseudo = pseudoSessionFromParsed(parsed)
      const { chatDir, state } = getChatCtx(pseudo)

      let lastInboundAt = Number(state.lastAgentInboundAt || 0) || 0
      let lastInboundSeq = Number(state.lastAgentInboundSeq || 0) || 0
      let lastInboundText = safeString(state.lastAgentInboundText || '')

      if ((!lastInboundAt || !lastInboundSeq) && fs.existsSync(chatDir)) {
        try {
          const toDate = isoDate(nowMs())
          const fromDate = isoDate(nowMs() - 7 * 24 * 3600 * 1000)
          const files = listLogFiles(chatDir, fromDate, toDate).slice().reverse()
          outer: for (const file of files) {
            const lines = readText(file, '').split('\n').reverse()
            for (const line of lines) {
              const t = line.trim()
              if (!t) continue
              let obj
              try { obj = JSON.parse(t) } catch { continue }
              if (safeString(obj?.sender?.trust) === 'BOT') continue
              if (!isAgentVisibleRecord(obj)) continue
              const text = safeString(obj?.text || '')
              lastInboundSeq = Number(obj?.seq || 0) || lastInboundSeq
              lastInboundAt = (Number(obj?.ts || 0) || 0) * 1000 || lastInboundAt
              lastInboundText = text
              break outer
            }
          }
        } catch {}
      }

      const currentResult = normalizeLastAgentResult(state.lastAgentResult)
      const resultForLastInbound = currentResult && currentResult.forInboundSeq >= lastInboundSeq ? currentResult : null
      const processingRuntime = state.processing
        ? normalizeRuntimeKind(state.processingRuntime || primaryRuntimeForChat(chatKey))
        : ''
      const statusLine = state.processing
        ? `running since ${formatStatusTime(state.processingStartedAt)}${processingRuntime ? ` (${processingRuntime})` : ''}`
        : 'idle'
      const resultLine = state.processing
        ? 'none yet (agent is still running)'
        : resultForLastInbound
          ? summarizeLastAgentResult(resultForLastInbound)
          : 'none yet'
      const finishedLine = !state.processing && resultForLastInbound
        ? formatStatusTime(resultForLastInbound.finishedAt)
        : 'n/a'
      const inboundPreview = lastInboundText
        ? decodeEscapedControlsIfLikely(lastInboundText).replace(/\s+/g, ' ').slice(0, 120)
        : ''
      const piSession = readPiSessionFile(state)
      const piSessionContext = await readPiSessionContextSummary(piSession)
      const currentModelLine = piSessionContext && (piSessionContext.provider || piSessionContext.modelId)
        ? `${piSessionContext.provider || '(unknown provider)'}/${piSessionContext.modelId || '(unknown model)'}`
        : 'n/a'
      const currentThinkingLine = piSessionContext && piSessionContext.thinkingLevel
        ? piSessionContext.thinkingLevel
        : 'n/a'

      const parts = [
        `Last inbound: ${formatStatusTime(lastInboundAt)}${lastInboundSeq ? ` (seq ${lastInboundSeq})` : ''}`,
        `Agent: ${statusLine}`,
        'Runtime: pi',
        `Current model: ${currentModelLine}`,
        `Current thinking: ${currentThinkingLine}`,
        `Last result after that inbound: ${resultLine}`,
      ]
      if (piSession) parts.push(`Pi session: ${piSession}`)
      if (!state.processing) parts.push(`Result time: ${finishedLine}`)
      if (inboundPreview) parts.push(`Inbound preview: ${inboundPreview}`)
      return parts.join('\n')
    }

    async function exportBridgeSessionFile(sessionFile: string, outputPath = '') {
      const sourceFile = safeString(sessionFile).trim()
      if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('session_file_missing')
      const requested = safeString(outputPath).trim()
      const targetPath = requested
        ? path.resolve(requested)
        : path.resolve(repoRoot, `${path.basename(sourceFile, path.extname(sourceFile))}.html`)
      if (targetPath.endsWith('.html')) {
        const exportHtml = await import('../third_party/pi-mono/packages/coding-agent/dist/core/export-html/index.js')
        return await exportHtml.exportFromFile(sourceFile, targetPath)
      }
      if (path.resolve(targetPath) !== path.resolve(sourceFile)) {
        fs.copyFileSync(sourceFile, targetPath)
      }
      return targetPath
    }

    async function runBridgeSlashCommand({ chatKey, text, replyToMessageId = '' }: any = {}) {
      const invocation = parseSlashInvocation(text)
      if (!invocation) return { handled: false }
      const commandName = safeString(invocation.bareName).trim()
      const commandArgs = parseCommandArgs(invocation.argsText)
      const parsed = parseChatKey(chatKey)
      if (!parsed) return { handled: false }

      if (commandName === 'status') {
        await sendBridgeCommandText({
          chatKey,
          parsed,
          text: await buildStatusText(chatKey),
          replyToMessageId,
        })
        return { handled: true }
      }

      if (commandName === 'restart') {
        await handleRestart({ chatKey, restartMessageId: replyToMessageId })
        return { handled: true }
      }

      if (commandName === 'new') {
        await handleNew({ chatKey, newMessageId: replyToMessageId })
        return { handled: true }
      }

      const controller = await openBridgeCommandSession(chatKey)
      if (!controller) return { handled: false }
      const syncSessionBinding = () => {
        reconcilePiSessionFile(controller.state, controller.session && controller.session.sessionFile, chatKey)
        controller.saveState()
      }
      try {
        const availableCommands = collectBridgeSlashCommandsFromController(controller)
        const known = new Set(availableCommands.map((item) => safeString(item && item.name).trim()).filter(Boolean))
        const readOnlyCommands = new Set(['session', 'copy'])
        if (controller.state && controller.state.processing && known.has(commandName) && !readOnlyCommands.has(commandName)) {
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: 'This chat is still processing a turn. Please try that command again after it finishes, or use /new to start a fresh session.',
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'session') {
          const stats = controller.session.getSessionStats()
          const model = controller.session.model
          const thinking = safeString(controller.session.thinkingLevel).trim() || 'n/a'
          const lines = [
            `Session file: ${safeString(stats && stats.sessionFile).trim() || 'n/a'}`,
            `Session id: ${safeString(stats && stats.sessionId).trim() || 'n/a'}`,
            `Messages: ${Number(stats && stats.totalMessages || 0) || 0}`,
            `User messages: ${Number(stats && stats.userMessages || 0) || 0}`,
            `Assistant messages: ${Number(stats && stats.assistantMessages || 0) || 0}`,
            `Tool calls: ${Number(stats && stats.toolCalls || 0) || 0}`,
            `Tool results: ${Number(stats && stats.toolResults || 0) || 0}`,
            `Model: ${safeString(model && model.provider).trim() || 'n/a'}/${safeString(model && model.id).trim() || 'n/a'}`,
            `Thinking: ${thinking}`,
          ]
          await sendBridgeCommandText({ chatKey, parsed, text: lines.join('\n'), replyToMessageId })
          return { handled: true }
        }

        if (commandName === 'copy') {
          const lastText = safeString(controller.session.getLastAssistantText() || '').trim()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: lastText || 'No assistant message yet.',
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'name') {
          const nextName = safeString(invocation.argsText).trim()
          if (!nextName) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Usage: /name <session name>', replyToMessageId })
            return { handled: true }
          }
          controller.session.setSessionName(nextName)
          syncSessionBinding()
          await sendBridgeCommandText({ chatKey, parsed, text: `Session name set to: ${nextName}`, replyToMessageId })
          return { handled: true }
        }

        if (commandName === 'model') {
          const currentModel = controller.session.model
          if (!commandArgs.length) {
            const currentThinking = safeString(controller.session.thinkingLevel).trim() || 'n/a'
            await sendBridgeCommandText({
              chatKey,
              parsed,
              text: [
                `Current model: ${safeString(currentModel && currentModel.provider).trim() || 'n/a'}/${safeString(currentModel && currentModel.id).trim() || 'n/a'}`,
                `Current thinking: ${currentThinking}`,
                'Usage: /model <provider/model> [thinking-level]',
              ].join('\n'),
              replyToMessageId,
            })
            return { handled: true }
          }
          const targetRef = safeString(commandArgs[0]).trim()
          const targetThinking = safeString(commandArgs[1]).trim()
          const slashIndex = targetRef.indexOf('/')
          if (slashIndex <= 0) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Please use the exact form /model <provider/model> [thinking-level].', replyToMessageId })
            return { handled: true }
          }
          const provider = targetRef.slice(0, slashIndex).trim()
          const modelId = targetRef.slice(slashIndex + 1).trim()
          const model = (controller.created && controller.created.modelRegistry && controller.created.modelRegistry.getAvailable
            ? controller.created.modelRegistry.getAvailable()
            : []).find((item: any) => safeString(item && item.provider).trim() === provider && safeString(item && item.id).trim() === modelId)
          if (!model) {
            await sendBridgeCommandText({ chatKey, parsed, text: `Model not found: ${targetRef}`, replyToMessageId })
            return { handled: true }
          }
          await controller.session.setModel(model)
          if (targetThinking) controller.session.setThinkingLevel(targetThinking)
          syncSessionBinding()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: `Model set to ${provider}/${modelId}${targetThinking ? ` with thinking ${targetThinking}` : ''}.`,
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'compact') {
          const result = await controller.session.compact(safeString(invocation.argsText).trim())
          syncSessionBinding()
          const summary = safeString(result && result.summary || '').trim()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: summary ? `Compacted current session.\n\n${summary}` : 'Compacted current session.',
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'reload') {
          await controller.created.resourceLoader.reload().catch(() => {})
          try { controller.created.modelRegistry.refresh?.() } catch {}
          syncSessionBinding()
          await syncKoishiBridgeCommands().catch(() => {})
          await sendBridgeCommandText({ chatKey, parsed, text: 'Reloaded extensions, prompts, skills, and themes.', replyToMessageId })
          return { handled: true }
        }

        if (commandName === 'fork') {
          const entryId = safeString(commandArgs[0]).trim()
          if (!entryId) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Usage: /fork <entry-id>', replyToMessageId })
            return { handled: true }
          }
          const result = await controller.session.fork(entryId)
          syncSessionBinding()
          if (result && result.cancelled) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Fork cancelled.', replyToMessageId })
            return { handled: true }
          }
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: `Forked to a new session.${safeString(controller.session && controller.session.sessionFile).trim() ? `\nSession file: ${safeString(controller.session.sessionFile).trim()}` : ''}`,
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'tree') {
          const entryId = safeString(commandArgs[0]).trim()
          if (!entryId) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Usage: /tree <entry-id>', replyToMessageId })
            return { handled: true }
          }
          const result = await controller.session.navigateTree(entryId, {})
          syncSessionBinding()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: result && result.cancelled ? 'Tree navigation cancelled.' : 'Switched to the requested point in the current session tree.',
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'resume') {
          const sessionPath = safeString(commandArgs[0]).trim()
          if (!sessionPath) {
            await sendBridgeCommandText({
              chatKey,
              parsed,
              text: `Usage: /resume <session-path>${safeString(controller.session && controller.session.sessionFile).trim() ? `\nCurrent session: ${safeString(controller.session.sessionFile).trim()}` : ''}`,
              replyToMessageId,
            })
            return { handled: true }
          }
          const cancelled = !(await controller.session.switchSession(sessionPath))
          syncSessionBinding()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: cancelled ? 'Resume cancelled.' : `Switched to session: ${safeString(controller.session && controller.session.sessionFile || sessionPath).trim()}`,
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'import') {
          const inputPath = safeString(commandArgs[0]).trim()
          if (!inputPath) {
            await sendBridgeCommandText({ chatKey, parsed, text: 'Usage: /import <jsonl-path>', replyToMessageId })
            return { handled: true }
          }
          await controller.session.importFromJsonl(inputPath)
          syncSessionBinding()
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: `Imported session: ${safeString(controller.session && controller.session.sessionFile).trim() || inputPath}`,
            replyToMessageId,
          })
          return { handled: true }
        }

        if (commandName === 'export') {
          const outPath = await exportBridgeSessionFile(safeString(controller.session && controller.session.sessionFile).trim(), safeString(commandArgs[0]).trim())
          await sendBridgeCommandText({ chatKey, parsed, text: `Exported session to: ${outPath}`, replyToMessageId })
          return { handled: true }
        }

        if (['settings', 'scoped-models', 'share', 'login', 'logout', 'changelog', 'hotkeys', 'quit'].includes(commandName)) {
          await sendBridgeCommandText({
            chatKey,
            parsed,
            text: `/${commandName} is currently available only in the TUI.`,
            replyToMessageId,
          })
          return { handled: true }
        }

        if (known.has(commandName)) {
          const beforeAssistant = safeString(controller.session.getLastAssistantText() || '').trim()
          await controller.session.prompt(invocation.raw, { source: 'interactive' })
          syncSessionBinding()
          const afterAssistant = safeString(controller.session.getLastAssistantText() || '').trim()
          const notices = controller.notices.filter(Boolean)
          const replyText = afterAssistant && afterAssistant !== beforeAssistant
            ? afterAssistant
            : notices.join('\n').trim() || 'Done.'
          await sendBridgeCommandText({ chatKey, parsed, text: replyText, replyToMessageId })
          return { handled: true }
        }

        return { handled: false }
      } finally {
        await controller.dispose()
      }
    }

    function defaultChatTypeFromParsed(parsed: any) {
      const platform = safeString(parsed && parsed.platform || '')
      const chatId = safeString(parsed && parsed.chatId || '')
      if (platform === 'telegram') return chatId.startsWith('-') ? 'group' : 'private'
      if (platform === 'onebot') return chatId.startsWith('private:') ? 'private' : 'group'
      return 'private'
    }

    function clearPersistentRunFlags(
      state: any,
      { keepPendingTrigger = false, keepResetPending = false }: { keepPendingTrigger?: boolean, keepResetPending?: boolean } = {},
    ) {
      clearPersistentConversationRunFlags(state, { keepPendingTrigger, keepResetPending })
    }

    function isCurrentProcessingRun(state: any, runId: any) {
      const want = safeString(runId || '')
      if (!want) return false
      return safeString(state && state.processingRunId || '') === want
    }
    isCurrentProcessingRunRef = isCurrentProcessingRun

    async function withTelegramTyping(parsed: any, fn: any) {
      let typingTimer = null
      try {
        if (parsed && safeString(parsed.platform) === 'telegram') {
          const chatId = safeString(parsed.chatId || '')
          const bot = findBot('telegram', safeString(parsed.botId || ''))
          const sendTyping = async () => {
            if (!chatId || !bot || !bot.internal || typeof bot.internal.sendChatAction !== 'function') return
            try { await bot.internal.sendChatAction({ chat_id: chatId, action: 'typing' }) } catch {}
          }
          await sendTyping()
          typingTimer = setInterval(() => { void sendTyping() }, 4000)
        }
        return await fn()
      } finally {
        if (typingTimer) clearInterval(typingTimer)
      }
    }

	    async function runBridgeReplyTurn({
	      runtimeKind = 'pi',
      parsed = null,
      chatKey,
      chatDir,
      state,
      saveState,
      processingRunId,
      observedToSeq = null,
      allowInterrupt = true,
      prompt = '',
      inputItems = null,
      resumeThreadId = null,
      timeoutMs = 0,
      replyToMessageId = '',
      onSpawn = null,
      threadInitLockKey = 'thread-init',
      turnBehavior = null,
      systemPromptExtra = '',
      threadConfig = null,
    }: any = {}) {
      const result = await withTelegramTyping(parsed, async () => {
        return await runSelectedRuntimeTurn({
          runtimeKind,
          rootDir: root,
          repoRoot,
          workspaceRoot,
          piProvider: configuredPiProvider,
          piModel: configuredPiModel,
          piThinking: configuredPiThinking,
          systemPromptExtra,
          prompt,
          inputItems,
          resumeThreadId,
          timeoutMs,
          images: [],
          threadInitLockKey,
          onSpawn,
          bridgeSend: {
            chatKey,
            replyToMessageId: safeString(replyToMessageId || ''),
            via: 'agent-prefix',
            interimMarker: BRIDGE_AGENT_INTERIM_MARKER,
          },
          runtimeTracking: {
            chatKey,
            chatDir,
            state,
            saveState,
            processingRunId,
            observedToSeq,
            allowInterrupt,
          },
          turnBehavior,
          threadConfig,
        })
      })

      if (normalizeRuntimeKind(runtimeKind) === 'pi' && Number(result && result.code || 0) === 0) {
        const normalized = normalizeBridgeAssistantText(result && result.lastMessage || '')
        if (normalized.kind === 'reply') {
          const target = parsed || parseChatKey(chatKey)
          if (target) {
            try {
              await sendToChat({
                chatKey,
                parsed: target,
                text: normalized.text,
                images: [],
                files: [],
                via: 'agent-prefix',
                replyToMessageId: safeString(replyToMessageId || ''),
              })
            } catch (e) {
              logger.warn(`pi final reply send failed chatKey=${chatKey} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
            }
          }
        }
      }

      const trimmed = safeString(result && result.lastMessage || '').trim()
	      return { result, trimmed }
	    }

    function queueShadowBridgeTurn(_options: any = {}) {
      return
    }

		    function makeProcessingOnSpawn({
		      chatKey,
	      chatDir,
      state,
      saveState,
      processingRunId,
      observedToSeq = null,
      allowInterrupt = true,
	    }: any) {
	      return (child) => {
	        if (!isCurrentProcessingRun(state, processingRunId)) return
	        state.processingPid = child.pid || 0
	        syncConcurrentStateFromDisk({ chatDir, state, observedToSeq })
	        saveState()
	        if (allowInterrupt && state.interruptRequested) {
          requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason: 'interrupt_pending_on_spawn' })
        }
      }
    }

    function abortActiveChatProcessing({ chatKey, state }: any = {}) {
      try {
        const active = getActiveProcessingTurn({ chatKey, processingRunId: state && state.processingRunId })
        if (!(state && (state.processing || state.processingPid || active))) return
        const activeRuntime = normalizeRuntimeKind(
          (active && active.runtime)
          || state.processingRuntime
          || primaryRuntimeForChat(chatKey),
        )
        if (activeRuntime === 'pi' && active && typeof active.abort === 'function') {
          void Promise.resolve(active.abort()).catch(() => {})
          return
        }
        const pid = Number(state.processingPid || 0)
        if (pid) {
          try { process.kill(pid, 'SIGTERM') } catch {}
          setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 2000)
        }
      } catch {}
    }

    async function handleNew({ chatKey, newMessageId = '' }: any = {}) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      const pseudo = { platform: parsed.platform, channelId: parsed.chatId, guildId: null }
      const { chatDir, state, saveState } = getChatCtx(pseudo)
      resetEphemeral(chatKey)
      abortActiveChatProcessing({ chatKey, state })

      const controller = await openBridgeCommandSession(chatKey)
      if (!controller) return
      let nextSessionFile = ''
      try {
        await controller.session.newSession()
        nextSessionFile = safeString(controller.session && controller.session.sessionFile || '').trim()
      } finally {
        await controller.dispose()
      }

      const freshBoundarySeq = Math.max(0, Number(state.lastSeq || state.lastInboundSeq || 0) || 0)
      state.lastThreadIngestedSeq = freshBoundarySeq
      resetConversationStateForBoundary({
        state,
        freshBoundarySeq,
        keepPendingTrigger: false,
      })
      reconcilePiSessionFile(state, nextSessionFile, chatKey)
      saveState()

      await sendBridgeCommandText({
        chatKey,
        parsed,
        text: 'Started a new session here.',
        replyToMessageId: safeString(newMessageId || ''),
      })
    }



    async function maybeHandleBridgeSlashCommand(session: any) {
      const resolved = await resolveBridgeSlashSessionCommand(session)
      if (!resolved.known || !resolved.invocation) return false
      if (!resolved.authorized) return true
      const { chatKey } = getChatCtx(session)
      await runBridgeSlashCommand({
        chatKey,
        text: resolved.invocation.raw,
        replyToMessageId: safeString(session && session.messageId || ''),
      })
      return true
    }

    function scheduleActivation(chatKey, fn, delayMs, maxDelayMs) {
      if (isShuttingDown()) return
      const now = nowMs()
      const key = chatKey
      const existing = debounceTimers.get(key)
      if (!existing) {
        const firstAt = now
        const timer = setTimeout(() => {
          debounceTimers.delete(key)
          fn()
        }, delayMs)
        debounceTimers.set(key, { timer, firstAt })
        return
      }

      clearTimeout(existing.timer)
      const elapsed = now - existing.firstAt
      const nextDelay = maxDelayMs && elapsed + delayMs > maxDelayMs ? Math.max(0, maxDelayMs - elapsed) : delayMs
      const timer = setTimeout(() => {
        debounceTimers.delete(key)
        fn()
      }, nextDelay)
      debounceTimers.set(key, { timer, firstAt: existing.firstAt })
    }

	    function requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason }: any) {
	      if (!state || !state.processing) return
	      // Some operations (e.g. session replacement during /new) must not be interrupted by new inbound work.
	      if (state.processingNoInterrupt) return

      const interrupt = requestConversationInterrupt({
        state,
        nowMs: nowMs(),
        clearForceContinue: true,
      })
      if (interrupt.changed) saveState()

	      const runId = safeString(state.processingRunId || '')
        const active = getActiveProcessingTurn({ chatKey, processingRunId: runId })
        const activeRuntime = normalizeRuntimeKind(
          (active && active.runtime)
          || state.processingRuntime
          || primaryRuntimeForChat(chatKey),
        )
        const activeThreadId = safeString(
          (active && active.threadId)
          || state.processingThreadId
          || '',
        )
        const activeTurnId = safeString(
          (active && active.turnId)
          || state.processingTurnId
          || '',
        )
        if (activeRuntime === 'pi' && active && typeof active.abort === 'function') {
          logger.info(`interrupt requested chatKey=${chatKey} runtime=${activeRuntime} thread=${activeThreadId || '(session)'} reason=${safeString(reason)}`)
          void Promise.resolve(active.abort())
            .catch((e: any) => {
              logger.warn(`interrupt dispatch failed chatKey=${chatKey} err=${safeString(e && e.message ? e.message : e)}`)
            })
          return
        }

	      const pid = Number(state.processingPid || 0)
	      if (!Number.isFinite(pid) || pid <= 0) return
	      const statePath = path.join(chatDir, 'state.json')

      const signalIfStillCurrent = (signal) => {
        try {
          const st = readJson(statePath, null)
          if (!st || !st.processing) return
          if (Number(st.processingPid || 0) !== pid) return
          if (runId && safeString(st.processingRunId || '') !== runId) return
          try { process.kill(pid, signal) } catch {}
        } catch {}
      }

	      logger.info(`interrupt requested chatKey=${chatKey} runtime=${activeRuntime} pid=${pid} reason=${safeString(reason)}`)
	      signalIfStillCurrent('SIGINT')
	      setTimeout(() => signalIfStillCurrent('SIGTERM'), 2000)
	      setTimeout(() => signalIfStillCurrent('SIGKILL'), 8000)
	    }
    requestInterruptIfProcessingRef = requestInterruptIfProcessing

	    function syncConcurrentStateFromDisk({ chatDir, state, observedToSeq = null }: any) {
      try {
        const statePath = path.join(chatDir, 'state.json')
        const disk = readJson(statePath, null)
        syncConversationFromDisk({ state, disk, observedToSeq, mergePendingTrigger })
      } catch {}
	    }
    syncConcurrentStateFromDiskRef = syncConcurrentStateFromDisk

	    async function runChatSessionTurn({ chatKey, prompt, kind, name = '' }: any) {
	      const parsed = parseChatKey(chatKey)
	      if (!parsed) throw new Error('invalid_chatKey')
	      const pseudo = pseudoSessionFromParsed(parsed)
        const runtimeKind = primaryRuntimeForChat(chatKey)

      const prev = perChat.get(chatKey) || Promise.resolve()
      const next = prev.catch(() => {}).then(async () => {
        let chatDir, state, saveState
        let processingRunId = ''
        const claim = await withChatLock(chatKey, async () => {
          const ctx = getChatCtx(pseudo)
          chatDir = ctx.chatDir
          state = ctx.state
          saveState = ctx.saveState
          if (isShuttingDown()) return { ok: false, error: 'shutting_down' }
          processingRunId = nodeCrypto.randomBytes(12).toString('hex')
          const claimed = claimConversationProcessing({
            state,
            runtime: runtimeKind,
            processingRunId,
            nowMs: nowMs(),
            noInterrupt: false,
            pendingOnBusy: true,
            clearReplyTo: true,
            clearForceContinue: true,
          })
          if (!claimed.ok) {
            saveState()
            return { ok: false, error: 'chat_busy' }
          }
          // Preserve any pending triggers/wake requests; they will be processed after the job.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: null })
          saveState()
          return { ok: true }
        }, { op: 'scheduled_claim', chatKey, kind: safeString(kind), name: safeString(name) })
        if (!claim || claim.ok === false) throw new Error(claim?.error || 'chat_busy')

		        const activeHandle = readPiSessionFile(state)
            logger.info(`scheduled run chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} runner=pi-sdk thread=${activeHandle || '(new)'}`)

		        const doRun = async () => {
		          const result = await runSelectedRuntimeTurn({
                runtimeKind,
                rootDir: root,
		            repoRoot,
		            workspaceRoot,
                piProvider: configuredPiProvider,
                piModel: configuredPiModel,
                piThinking: configuredPiThinking,
		            prompt,
		            resumeThreadId: readPiSessionFile(state) || null,
		            timeoutMs: config.agentMaxRuntimeMs || 0,
		            images: [],
              bridgeSend: {
                chatKey,
                replyToMessageId: '',
                via: 'agent-prefix',
              },
              runtimeTracking: {
                chatKey,
                chatDir,
                state,
                saveState,
                processingRunId,
                observedToSeq: null,
                allowInterrupt: true,
              },
	          })
	          return result
	        }

        const result = await doRun()

        const trimmed = (result.lastMessage || '').trim()
        const post = await withChatLock(chatKey, async () => {
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: null })
          if (!isCurrentProcessingRun(state, processingRunId)) {
            logger.info(`scheduled run stale release ignored chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} runId=${processingRunId} currentRunId=${safeString(state.processingRunId || '') || '(none)'}`)
            return { shouldWake: false, interrupted: false, stale: true }
          }
          const interrupted = Boolean(state.interruptRequested)
          if (!interrupted && result.code === 0) {
            state.lastSystemAckAt = nowMs()
          } else if (interrupted) {
            logger.info(`scheduled run interrupted chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)}`)
          } else {
            logger.warn(`scheduled run failed chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} code=${result.code} lastMessage=${JSON.stringify(trimmed)} stderr=${JSON.stringify((result.stderr || '').slice(0, 500))}`)
          }

            reconcilePiSessionFile(state, result && ((result as any).sessionFile || result.threadId), chatKey)

          const released = releaseConversationProcessing({
            state,
            preservePendingWake: !isShuttingDown(),
            preservePendingTrigger: true,
            preserveResetPending: true,
            preserveForceContinue: false,
          })
          saveState()
          return { shouldWake: released.shouldWake, interrupted }
        }, { op: 'scheduled_release', chatKey, kind: safeString(kind), name: safeString(name) })

        if (post && post.shouldWake) {
          scheduleActivation(chatKey, () => {
            activate(pseudo).catch((e) => logger.error(e))
          }, 0, 0)
        }

        if (post && post.interrupted) throw new Error('interrupted')
        if (result.code !== 0) throw new Error(`${runtimeKind}_failed`)
        return { ok: true }
      })

      perChat.set(chatKey, next)
      return await next
    }

	    async function runTimerNow({ chatKey, routineFile, name = '' }: any) {
	      const routinePath = safeString(routineFile)
	      if (!routinePath) throw new Error('missing_routineFile')
	      const abs = path.resolve(workspaceRoot, routinePath)
	      if (!abs.startsWith(workspaceRoot + path.sep) && abs !== workspaceRoot) throw new Error('routineFile_outside_workspace')
	      const promptText = readPromptFileText(abs, 'routineFile')
	      return await runEphemeralTurn({ inputItems: [{ type: 'text', text: promptText }], prompt: '', kind: 'timer', name, chatKey })
	    }

      function deriveInspectTodoPath(promptPath: string, inspectName = '') {
        const p = safeString(promptPath).trim()
        if (p.endsWith('.prompt.md')) return p.replace(/\.prompt\.md$/, '.todo')
        if (p.endsWith('.inspect.md')) return p.replace(/\.inspect\.md$/, '.todo')
        if (p.endsWith('.md')) return p.replace(/\.md$/, '.todo')
        const n = safeString(inspectName).trim()
        if (n) return `routines/inspects/${n}.todo`
        return `${p}.todo`
      }

      function resolveInspectTodoPath(todoFile: string, allowOutsideWorkspace = false) {
        const todoRel = safeString(todoFile).trim()
        const todoAbs = path.resolve(workspaceRoot, todoRel)
        if (!allowOutsideWorkspace && !todoAbs.startsWith(workspaceRoot + path.sep) && todoAbs !== workspaceRoot) throw new Error('todoFile_outside_workspace')
        return { todoRel, todoAbs }
      }

	    async function runInspectNow({ sessionChatKey, inspectFile, todoFile, name = '' }: any) {
      const deliveryChatKey = safeString(sessionChatKey)
	      const p = safeString(inspectFile)
	      if (!p) throw new Error('missing_inspectFile')
	      const abs = path.resolve(workspaceRoot, p)
	      if (!abs.startsWith(workspaceRoot + path.sep) && abs !== workspaceRoot) throw new Error('inspectFile_outside_workspace')
      const promptText = readPromptFileText(abs, 'inspectFile')
      const { todoRel, todoAbs } = resolveInspectTodoPath(safeString(todoFile).trim() || deriveInspectTodoPath(p, name), true)
	      if (!fs.existsSync(todoAbs)) return { ok: true, skipped: 'missing_todo' }

	      return await runEphemeralTurn({ inputItems: [{ type: 'text', text: promptText }], prompt: '', kind: 'inspect', name, chatKey: deliveryChatKey })
	    }

      async function runInspectCommandNow({ sessionChatKey, command, todoFile, name = '' }: any) {
        const deliveryChatKey = safeString(sessionChatKey)
        const cmd = safeString(command).trim()
        if (!cmd) throw new Error('missing_inspectCommand')
        const { todoRel, todoAbs } = resolveInspectTodoPath(safeString(todoFile).trim() || deriveInspectTodoPath('', name), true)
        if (!fs.existsSync(todoAbs)) return { ok: true, skipped: 'missing_todo' }
        logger.info(`scheduled inspect command kind=inspect name=${safeString(name)} command=${JSON.stringify(cmd)}`)

        return await new Promise((resolve, reject) => {
          const shell = safeString(process.env.SHELL || '').trim() || '/bin/sh'
          const child = spawn(shell, ['-lc', cmd], {
            cwd: repoRoot,
	            env: {
	              ...process.env,
	              RIN_REPO_ROOT: repoRoot,
	              RIN_SCHEDULE_KIND: 'inspect',
	              RIN_SCHEDULE_NAME: safeString(name),
	              RIN_SCHEDULE_CHAT_KEY: safeString(deliveryChatKey),
	              RIN_INSPECT_TODO_FILE: todoRel,
	            },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (buf) => {
            stdout += buf.toString()
            if (stdout.length > 8000) stdout = stdout.slice(-8000)
          })
          child.stderr.on('data', (buf) => {
            stderr += buf.toString()
            if (stderr.length > 8000) stderr = stderr.slice(-8000)
          })
          child.on('error', (e) => reject(e))
          child.on('close', (code, signal) => {
            if (signal) return reject(new Error(`inspect_command_signal:${signal}`))
            if (Number(code) !== 0) {
              const tail = safeString(stderr || stdout).trim().replace(/\s+/g, ' ').slice(0, 500)
              return reject(new Error(`inspect_command_failed:${String(code)}${tail ? `:${tail}` : ''}`))
            }
            resolve({ ok: true, stdout, stderr })
          })
        })
      }

    async function runEphemeralTurn({ prompt, inputItems = null, kind, name = '', chatKey = '' }: any) {
      const runtimeKind = runtimeForEphemeralTurn(safeString(chatKey || '').trim())
      logger.info(`scheduled run (ephemeral) kind=${safeString(kind)} name=${safeString(name)} runner=pi-sdk thread=(new)`)

      const result = await runSelectedRuntimeTurn({
        runtimeKind,
        rootDir: root,
        repoRoot,
        workspaceRoot,
        piProvider: configuredPiProvider,
        piModel: configuredPiModel,
        piThinking: configuredPiThinking,
        prompt,
        inputItems,
        resumeThreadId: null,
        timeoutMs: config.agentMaxRuntimeMs || 0,
        images: [],
        bridgeSend: safeString(chatKey || '')
          ? {
              chatKey: safeString(chatKey || ''),
              replyToMessageId: '',
              via: 'agent-prefix',
            }
          : null,
      })

      const trimmed = (result.lastMessage || '').trim()
      const parsed = safeString(chatKey || '') ? parseChatKey(safeString(chatKey || '')) : null
      const chatDir = parsed ? chatDirForParsed(parsed) : ''
      if (runtimeKind === 'pi' && parsed && Number(result.code || 0) === 0) {
        const normalized = normalizeBridgeAssistantText(result.lastMessage || '')
        if (normalized.kind === 'reply') {
          await sendToChat({
            chatKey: safeString(chatKey || ''),
            parsed,
            text: normalized.text,
            images: [],
            files: [],
            via: 'agent-prefix',
            replyToMessageId: '',
          })
        }
      }
      if (result.code !== 0) throw new Error(`${runtimeKind}_failed:code=${String(result.code)}`)
      return { ok: true, continue: false }
    }

    function scheduleEnqueue(fn) {
      const prev = scheduleRunQueue.p
      const next = prev.catch(() => {}).then(fn)
      scheduleRunQueue.p = next.then(() => {}, () => {})
      return next
    }

    function drainCommandScheduleQueue() {
      while (scheduleCommandQueue.active < scheduleCommandQueue.limit && scheduleCommandQueue.pending.length) {
        const entry = scheduleCommandQueue.pending.shift()
        if (!entry) break
        scheduleCommandQueue.active += 1
        Promise.resolve()
          .then(entry.fn)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            scheduleCommandQueue.active = Math.max(0, scheduleCommandQueue.active - 1)
            drainCommandScheduleQueue()
          })
      }
    }

    function scheduleEnqueueCommand(fn) {
      return new Promise((resolve, reject) => {
        scheduleCommandQueue.pending.push({ fn, resolve, reject })
        drainCommandScheduleQueue()
      })
    }

    async function tickSchedulesOnce() {
      if (isShuttingDown()) return
      const now = nowMs()
      const s = getSchedules()
      const due = []

      for (const t of s.timers || []) {
        if (!t || typeof t !== 'object') continue
        const key = `timer:${safeString(t.name)}`
        if (scheduleInFlight.has(key)) continue
        const runtime = getScheduleRuntime('timer', safeString(t.name))
        const { due: isDue, dueAt, slotAt } = nextDueForSchedule(t, runtime, now)
        if (!isDue) continue
        due.push({ kind: 'timer', name: safeString(t.name), chatKey: safeString(t.chatKey), routineFile: safeString(t.routineFile), dueAt, slotAt })
      }
      for (const it of s.inspections || []) {
        if (!it || typeof it !== 'object') continue
        const key = `inspect:${safeString(it.name)}`
        if (scheduleInFlight.has(key)) continue
        const runtime = getScheduleRuntime('inspect', safeString(it.name))
        const { due: isDue, dueAt, slotAt } = nextDueForSchedule(it, runtime, now)
        if (!isDue) continue
        due.push({
          kind: 'inspect',
          name: safeString(it.name),
          chatKey: safeString(it.chatKey),
          inspectFile: safeString((it as any).file || (it as any).inspectFile || (it as any).path),
          inspectCommand: safeString((it as any).command || (it as any).cmd || (it as any).exec),
          todoFile: safeString((it as any).todoFile || (it as any).todolistFile || (it as any).todo_file),
          dueAt,
          slotAt,
        })
      }

      if (!due.length) return
      due.sort((a, b) => (Number(a.dueAt) || 0) - (Number(b.dueAt) || 0))

      for (const item of due) {
        const k = `${item.kind}:${item.name}`
        scheduleInFlight.add(k)
        // Advance the anchored slot early so idle polls do not drift with daemon timing.
        patchScheduleRuntime(item.kind, item.name, {
          lastDueAtMs: Math.max(0, Number((item as any).slotAt || item.dueAt || 0) || 0),
          lastError: '',
        })

        const runScheduledItem = async () => {
          let actualStartAt = 0
          try {
            if (item.kind === 'timer') {
              actualStartAt = nowMs()
              patchScheduleRuntime(item.kind, item.name, { lastRunAtMs: actualStartAt, lastError: '' })
              await runTimerNow({ chatKey: item.chatKey, routineFile: item.routineFile, name: item.name })
            } else {
              const inspectFile = safeString((item as any).inspectFile || '')
              const todoRaw = safeString((item as any).todoFile || '').trim() || deriveInspectTodoPath(inspectFile, item.name)
              const { todoAbs } = resolveInspectTodoPath(todoRaw, true)
              if (!fs.existsSync(todoAbs)) {
                patchScheduleRuntime(item.kind, item.name, { lastOkAtMs: nowMs(), lastError: '' })
                return
              }
              actualStartAt = nowMs()
              patchScheduleRuntime(item.kind, item.name, { lastRunAtMs: actualStartAt, lastError: '' })
              if (safeString((item as any).inspectCommand).trim()) {
                await runInspectCommandNow({ sessionChatKey: safeString(item.chatKey), command: (item as any).inspectCommand, todoFile: (item as any).todoFile, name: item.name })
              } else {
                await runInspectNow({ sessionChatKey: safeString(item.chatKey), inspectFile: item.inspectFile, todoFile: (item as any).todoFile, name: item.name })
              }
            }
            if (actualStartAt > 0) maybeSnapScheduleAnchorAfterRun(item.kind, item, actualStartAt, nowMs())
            patchScheduleRuntime(item.kind, item.name, { lastOkAtMs: nowMs(), lastError: '' })
          } catch (e) {
            if (actualStartAt > 0) maybeSnapScheduleAnchorAfterRun(item.kind, item, actualStartAt, nowMs())
            patchScheduleRuntime(item.kind, item.name, { lastError: safeString(e && e.message ? e.message : e) })
            logger.warn(`schedule failed kind=${item.kind} name=${item.name} err=${safeString(e && e.message ? e.message : e)}`)
          } finally {
            scheduleInFlight.delete(k)
          }
        }

        const enqueue = (item.kind === 'inspect' && safeString((item as any).inspectCommand).trim())
          ? scheduleEnqueueCommand
          : scheduleEnqueue
        enqueue(runScheduledItem).catch(() => {})
      }
    }

	    async function activate(session) {
	      const platform = session.platform
	      const chatId = pickChatId(session)
        const botId = safeString(session && session.bot && session.bot.selfId || '').trim()
	      const chatKey = composeRuntimeChatKey(platform, chatId, botId)
        const primaryRuntime = primaryRuntimeForChat(chatKey)

	      const prev = perChat.get(chatKey) || Promise.resolve()
	      const next = prev.catch(() => {}).then(async () => {
	        let chatDir, state, saveState
	        let fromSeq = 0
	        let toSeq = 0
	        let trigger = null
          let runStartedAtMs = 0
          let processingRunId = ''
	        const claim = await withChatLock(chatKey, async () => {
	          const ctx = getChatCtx(session)
	          chatDir = ctx.chatDir
	          state = ctx.state
	          saveState = ctx.saveState

	          if (isShuttingDown()) {
	            return { ok: false }
	          }
	          processingRunId = nodeCrypto.randomBytes(12).toString('hex')
          runStartedAtMs = nowMs()
          const claimed = claimConversationTurn({
            state,
            primaryRuntime,
            processingRunId,
            nowMs: runStartedAtMs,
          })
          if (!claimed || claimed.ok === false) {
            saveState()
            return { ok: false }
          }
          fromSeq = Number(claimed.fromSeq || 0) || 0
          toSeq = Number(claimed.toSeq || 0) || 0
          trigger = claimed.trigger || null
          // If a new trigger arrived between the state snapshot above and this state write,
          // preserve it (and any interrupt request) instead of wiping it.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: toSeq })
          saveState()
          return { ok: true }
        }, { op: 'activate_claim', chatKey })
        if (!claim || claim.ok === false) return

	        const activeThreadId = readPiSessionFile(state)
        const currentRecord = readChatLogRecordsInSeqRange(chatDir, {
          minSeqInclusive: toSeq,
          maxSeqInclusive: toSeq,
          inboundOnly: true,
        }).slice(-1)[0] || null
        const currentRecordEligible = currentRecord ? !shouldSkipThreadHistoryRecord(currentRecord) : false
        const triggerChatType = safeString(currentRecord && currentRecord.chatType || trigger?.chatType || '').trim() || (session.guildId ? 'group' : 'private')
        const { attachImages } = collectRecordAttachmentContext(currentRecordEligible ? currentRecord : null, {
          maxImages: 6,
          maxAttachments: 12,
        })
        const liveInputItems = currentRecordEligible ? buildThreadHistoryInputsFromRecord(currentRecord) : []
        if (!liveInputItems.length) {
          const fallbackText = safeString(currentRecordEligible && currentRecord ? currentRecord.text : (trigger?.content || session.content || ''))
          if (fallbackText) liveInputItems.push({ type: 'text', text: fallbackText })
          for (const localPath of attachImages) {
            liveInputItems.push({ type: 'localImage', path: localPath })
          }
        }
	        const runnerName = 'pi-sdk'
	        logger.info(`activate chatKey=${chatKey} seq=${fromSeq}..${toSeq} runner=${runnerName} thread=${activeThreadId || '(new)'}`)

	        const { result, trimmed } = await runBridgeReplyTurn({
          runtimeKind: primaryRuntime,
          parsed: { platform, botId, chatId },
          chatKey,
          chatDir,
          state,
          saveState,
          processingRunId,
          observedToSeq: state.batchEndSeq,
          allowInterrupt: true,
          prompt: '',
	          inputItems: liveInputItems,
	          resumeThreadId: readPiSessionFile(state) || null,
          timeoutMs: config.agentMaxRuntimeMs || 0,
          replyToMessageId: safeString(currentRecord && currentRecord.messageId || trigger?.messageId || ''),
        })
        const post = await withChatLock(chatKey, async () => {
          // Pick up concurrent interrupt requests / pending triggers that happened during the run.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: state.batchEndSeq })
          if (!isCurrentProcessingRun(state, processingRunId)) {
            logger.info(`activate stale release ignored chatKey=${chatKey} seq=${fromSeq}..${toSeq} runId=${processingRunId} currentRunId=${safeString(state.processingRunId || '') || '(none)'}`)
            return { action: 'stale' }
          }

	          reconcilePiSessionFile(state, result && ((result as any).sessionFile || result.threadId), chatKey)

          const interrupted = Boolean(state.interruptRequested)
          const finishedAt = nowMs()
          const released = releaseConversationTurn({
            state,
            resultCode: result.code,
            interrupted,
            primaryRuntime,
            trimmed,
            toSeq,
            fromSeq,
            finishedAt,
            isShuttingDown: isShuttingDown(),
          })
          if (!interrupted && result.code === 0) {
            logger.info(`${runnerName} reply chatKey=${chatKey} processedTo=${state.lastProcessedSeq}`)
          } else if (interrupted) {
            logger.info(`${runnerName} interrupted chatKey=${chatKey} processedTo=${state.lastProcessedSeq || 0} batchEnd=${state.batchEndSeq}`)
          } else {
            logger.warn(`${runnerName} failed chatKey=${chatKey} code=${result.code} lastMessage=${JSON.stringify(trimmed)} stderr=${JSON.stringify((result.stderr || '').slice(0, 500))}`)
          }

          saveState()
          return { action: released && released.action ? released.action : 'done' }
        }, { op: 'activate_release', chatKey })

	        if (!post) return
	        if (post.action === 'shutdown') return
	        if (post.action === 'stale') return
	        // CONTINUE: re-activate soon even if no new messages.
        if (post.action === 'continue') {
          scheduleActivation(chatKey, () => {
            activate(session).catch((e) => logger.error(e))
          }, 5000, 5000)
          return
        }
        if (post.action === 'wake') {
          scheduleActivation(chatKey, () => {
            activate(session).catch((e) => logger.error(e))
          }, 0, 0)
          return
        }
      })
      perChat.set(chatKey, next)
      await next
    }

	    async function handleMessageLike(session) {
      if (session.type !== 'message' && session.type !== 'message-created' && session.type !== 'interaction/command') return
      if (isSelfMessage(session)) return
      const { platform, chatId, chatKey, chatDir, state, saveState } = getChatCtx(session)
      const shuttingDown = isShuttingDown()
      const identity = getIdentity()
      const userId = pickUserId(session)
      const trust = identity.trustOf(platform, userId)
      const inboundText = getInboundText(session)

      const slashResolution = await resolveBridgeSlashSessionCommand(session)
      const commandLike = slashResolution && slashResolution.known
        ? safeString(slashResolution.invocation && slashResolution.invocation.name).trim()
        : ''
      const slash = commandLike
      const isPrivilegedCommand = Boolean(slashResolution && slashResolution.known)

      // De-dupe: adapters may re-deliver after restarts; avoid double-log + double-activation.
      const messageId = safeString(session.messageId)
      if (messageId) {
        const recent = Array.isArray(state.recentMessageIds) ? state.recentMessageIds : []
        if (recent.includes(messageId)) return
        recent.push(messageId)
        while (recent.length > 200) recent.shift()
        state.recentMessageIds = recent
        saveState()
      }

	      // seq assignment
	      state.lastSeq = (state.lastSeq || 0) + 1
	      state.lastInboundSeq = state.lastSeq
	      state.lastInboundText = inboundText
	      const ts = session.timestamp || nowMs()
      saveState()
      let baseElements = compactElements(session.elements || [])
      baseElements = await fixupTelegramMediaElements(session, baseElements)
      const elements = await materializeRecordMedia({ chatDir, tsMs: ts, elements: baseElements })
      const replyMeta = await enrichReplyMeta({ session, platform, chatId, chatDir })
      try { session.__rinReplyMeta = replyMeta } catch {}
      const ownerBotOnlyGroup = await isOwnerBotOnlyGroupSession(session, trust)
      const effectiveChatType = effectiveBridgeChatType(session, { privateLike: ownerBotOnlyGroup })
      const replyToBot = isReplyToBotMessage({ session, replyMeta, chatDir })
      const mentioned = isMentioned(session)
      const mentionLike = mentioned || replyToBot
      const agentVisible = shouldSurfaceInboundToAgent({
        chatType: effectiveChatType,
        trust,
        mentionLike,
        commandLike,
      })
	      const record = {
        seq: state.lastSeq,
        ts: Math.floor(ts / 1000),
        platform,
        chatId: String(chatId),
        chatType: effectiveChatType,
        messageId,
        sender: { userId, name: safeString(session.username || session.author?.name || ''), trust },
        text: inboundText,
        elements,
        raw: {
          replyTo: safeString(replyMeta.replyToMessageId || ''),
          quotedText: safeString(replyMeta.quotedText || ''),
          quotedSenderUserId: safeString(replyMeta.quotedSenderUserId || ''),
          quotedSenderName: safeString(replyMeta.quotedSenderName || ''),
          replyToBot,
          isMentioned: mentioned,
          commandLike,
          agentVisible,
        },
      }
	      appendJsonl(path.join(chatDir, 'logs', `${isoDate(ts)}.jsonl`), record)

      const inboundEffect = applyInboundRecord({
        state,
        record,
        tsMs: ts,
        agentVisible,
        isPrivilegedCommand,
        slash,
      })
      saveState()

      // Don't wake Codex for privileged control commands; Koishi command handlers will respond.
      if (inboundEffect && inboundEffect.shouldActivate === false) return
      // (No persistent "last inbound" metadata; keep state minimal.)

      const trigger = buildConversationTrigger({
        record,
        userId,
        senderName: record.sender?.name || '',
        isMentioned: mentionLike,
        chatType: effectiveChatType,
        replyMeta,
      })
      const activationPlan = planConversationActivation({
        state,
        effectiveChatType,
        agentVisible,
        trigger,
      })
      saveState()
      if (shuttingDown) return

      if (activationPlan.mode === 'activate_private') {
        if (state.processing) {
          requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason: 'new_trigger' })
          return
        }
        scheduleActivation(chatKey, () => {
          activate(session).catch((e) => logger.error(e))
        }, config.ownerDebounceMs, config.ownerDebounceMaxMs)
        return
      }

      if (activationPlan.mode === 'activate_group_mention' || activationPlan.mode === 'activate_group_pending_mention') {
        if (state.processing) {
          requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason: 'new_trigger' })
          return
        }
        scheduleActivation(chatKey, () => {
          activate(session).catch((e) => logger.error(e))
        }, config.mentionedDebounceMs, config.mentionedDebounceMs)
      }
	    }

    // Run before normal Koishi command handling so slash-prefixed traffic is logged consistently,
    // then dispatch bridge commands through the shared daemon/session command surface.
    ctx.middleware(async (session, next) => {
      disableBareDirectCommandSuggest(session)
      // Some adapters dispatch `message-created` or `interaction/command`; treat them as inbound
      // message-like events for logging + gate.
      if (session.type === 'message' || session.type === 'message-created' || session.type === 'interaction/command') {
        await handleMessageLike(session)
        if (await maybeHandleBridgeSlashCommand(session)) return ''
      }
      return next()
    }, true)

    ctx.on('ready', () => {
      syncKoishiBridgeCommands().catch((e) => {
        const message = safeString(e && (e as any).message ? (e as any).message : e)
        logger.warn(`bridge command sync failed err=${message}`)
      })
    })

    // Local control socket: aggregate daemon capabilities (timers/schedules) without spawning extra daemons.
    const ctlSockPath = path.join(root, 'rin-ctl.sock')
    // Cleanup legacy socket file (no longer used).
    try { fs.rmSync(path.join(root, 'rin-send.sock'), { force: true }) } catch {}
    try { fs.rmSync(ctlSockPath, { force: true }) } catch {}
    const ctlServer = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buf = ''
      let done = false

      const reply = (obj) => {
        if (done) return
        done = true
        try { socket.write(`${JSON.stringify(obj)}\n`) } catch {}
        try { socket.end() } catch {}
      }

      const handleLine = async (line) => {
        let payload
        try { payload = JSON.parse(line) } catch { return reply({ ok: false, error: 'invalid_json' }) }
        const op = safeString(payload?.op)
        try {
          if (op === 'send') {
            const chatKey = safeString(payload?.chatKey)
            const text = payload?.text
            const elements = Array.isArray(payload?.elements) ? payload.elements : []
            const images = Array.isArray(payload?.images) ? payload.images : []
            const files = Array.isArray(payload?.files) ? payload.files : []
            const noReply = Boolean(payload?.noReply)
            if (!chatKey) return reply({ ok: false, error: 'missing_chatKey' })
            if (text == null && elements.length === 0 && images.length === 0 && files.length === 0) return reply({ ok: false, error: 'missing_text_or_attachments' })

            const parsed = parseChatKey(chatKey)
            if (!parsed) return reply({ ok: false, error: 'invalid_chatKey' })

            let replyToMessageId = ''
            if (!noReply) {
              try {
                const st = readJson(path.join(chatsRoot, parsed.platform, String(parsed.chatId), 'state.json'), null)
                if (st && st.processing && st.replyToMessageId) replyToMessageId = safeString(st.replyToMessageId)
              } catch {}
            }

            await sendToChat({ chatKey, parsed, text, elements, images, files, replyToMessageId })
            return reply({ ok: true })
          }
          if (op === 'timer.run') {
            const chatKey = safeString(payload?.chatKey)
            const routineFile = safeString(payload?.routineFile)
            const name = safeString(payload?.name)
            if (!chatKey) return reply({ ok: false, error: 'missing_chatKey' })
            if (!routineFile) return reply({ ok: false, error: 'missing_routineFile' })
            const startedAt = nowMs()
            if (name) patchScheduleRuntime('timer', name, { lastRunAtMs: startedAt, lastError: '' })
            await runTimerNow({ chatKey, routineFile, name })
            if (name) {
              const s = getSchedules()
              const it = (s.timers || []).find((x) => x && safeString(x.name) === name)
              if (it) maybeSnapScheduleAnchorAfterRun('timer', it, startedAt, nowMs())
              patchScheduleRuntime('timer', name, { lastOkAtMs: nowMs(), lastError: '' })
            }
            return reply({ ok: true })
          }
          if (op === 'schedule.run') {
            const kind = safeString(payload?.kind)
            const name = safeString(payload?.name)
            if (!name) return reply({ ok: false, error: 'missing_name' })
            const s = getSchedules()
            if (kind === 'timer') {
              const k = `timer:${name}`
              if (scheduleInFlight.has(k)) return reply({ ok: true, skipped: 'in_flight' })
              scheduleInFlight.add(k)
              const it = (s.timers || []).find((x) => x && safeString(x.name) === name)
              try {
                if (!it) return reply({ ok: false, error: 'not_found' })
                const startedAt = nowMs()
                patchScheduleRuntime(kind, name, { lastRunAtMs: startedAt, lastError: '' })
                await runTimerNow({ chatKey: safeString(it.chatKey), routineFile: safeString(it.routineFile), name })
                maybeSnapScheduleAnchorAfterRun(kind, it, startedAt, nowMs())
                patchScheduleRuntime(kind, name, { lastOkAtMs: nowMs(), lastError: '' })
                return reply({ ok: true })
              } finally {
                scheduleInFlight.delete(k)
              }
            }
            if (kind === 'inspect') {
              const k = `inspect:${name}`
              if (scheduleInFlight.has(k)) return reply({ ok: true, skipped: 'in_flight' })
              scheduleInFlight.add(k)
              const it = (s.inspections || []).find((x) => x && safeString(x.name) === name)
              try {
                if (!it) return reply({ ok: false, error: 'not_found' })
                const inspectFile = safeString((it as any).file || (it as any).inspectFile || (it as any).path)
                const todoRaw = safeString((it as any).todoFile || (it as any).todolistFile || '').trim() || deriveInspectTodoPath(inspectFile, name)
                const { todoAbs } = resolveInspectTodoPath(todoRaw, true)
                const startedAt = fs.existsSync(todoAbs) ? nowMs() : 0
                if (startedAt > 0) patchScheduleRuntime(kind, name, { lastRunAtMs: startedAt, lastError: '' })
                if (safeString((it as any).command || (it as any).cmd || (it as any).exec).trim()) {
                  await runInspectCommandNow({
                    sessionChatKey: safeString(it.chatKey),
                    command: safeString((it as any).command || (it as any).cmd || (it as any).exec),
                    todoFile: safeString((it as any).todoFile || (it as any).todolistFile || ''),
                    name,
                  })
                } else {
                  await runInspectNow({
                    sessionChatKey: safeString(it.chatKey),
                    inspectFile: safeString((it as any).file),
                    todoFile: safeString((it as any).todoFile || (it as any).todolistFile || ''),
                    name,
                  })
                }
                if (startedAt > 0) maybeSnapScheduleAnchorAfterRun(kind, it, startedAt, nowMs())
                patchScheduleRuntime(kind, name, { lastOkAtMs: nowMs(), lastError: '' })
                return reply({ ok: true })
              } finally {
                scheduleInFlight.delete(k)
              }
            }
            return reply({ ok: false, error: 'invalid_kind' })
          }
          if (op === 'history.get') {
            const chatKey = safeString(payload?.chatKey)
            const messageId = safeString(payload?.messageId)
            if (!chatKey) return reply({ ok: false, error: 'missing_chatKey' })
            if (!messageId) return reply({ ok: false, error: 'missing_messageId' })
            const parsed = parseChatKey(chatKey)
            if (!parsed) return reply({ ok: false, error: 'invalid_chatKey' })
            const chatDir = chatDirForParsed(parsed)
            const record = findLoggedMessageById(chatDir, messageId)
            if (!record) return reply({ ok: false, error: 'message_not_found' })
            return reply({ ok: true, message: buildHistoryLookupMessage(chatKey, record) })
          }
          if (op === 'daemon.restart') {
            const chatKey = safeString(payload?.chatKey)
            const reason = safeString(payload?.reason)
            const resp = await requestDaemonSelfRestart({ chatKey, reason })
            return reply(resp)
          }
          if (op === 'schedule.manage') {
            const result = await manageSchedule({
              stateRoot: homeRoot,
              kind: safeString(payload?.kind),
              action: safeString(payload?.action),
              name: safeString(payload?.name || ''),
              chatKey: safeString(payload?.chatKey || ''),
              routineFile: safeString(payload?.routineFile || ''),
              file: safeString(payload?.file || ''),
              command: safeString(payload?.command || ''),
              todoFile: safeString(payload?.todoFile || ''),
              start: safeString(payload?.start || ''),
              every: safeString(payload?.every || ''),
            })
            return reply({ ok: true, text: result.text, details: result.details })
          }
          if (op === 'ping') return reply({ ok: true })
          return reply({ ok: false, error: 'unknown_op' })
        } catch (e) {
          if (op === 'timer.run') {
            const name = safeString(payload?.name)
            if (name) patchScheduleRuntime('timer', name, { lastError: safeString(e && e.message ? e.message : e) })
          }
          if (op === 'schedule.run') {
            const kind = safeString(payload?.kind)
            const name = safeString(payload?.name)
            if (kind && name) patchScheduleRuntime(kind, name, { lastError: safeString(e && e.message ? e.message : e) })
          }
          return reply({ ok: false, error: safeString(e && e.message ? e.message : e) })
        }
      }

      socket.on('data', (chunk) => {
        if (done) return
        buf += chunk
        if (buf.length > 256 * 1024) return reply({ ok: false, error: 'payload_too_large' })
        const nl = buf.indexOf('\n')
        if (nl >= 0) void handleLine(buf.slice(0, nl).trim())
      })
      socket.on('end', () => {
        if (done) return
        const line = buf.trim()
        if (!line) return reply({ ok: false, error: 'empty_payload' })
        void handleLine(line)
      })
      socket.on('error', () => {})
    })
	    ctlServer.listen(ctlSockPath, () => {
	      try { fs.chmodSync(ctlSockPath, 0o600) } catch {}
	      logger.info(`ctl socket ready: ${ctlSockPath}`)
	    })

      const tuiRpcServer = startDaemonTuiRpcServer({
        repoRoot,
        stateRoot: homeRoot,
        logger,
        bridge: {
          listSessions: async () => {
            const rows: Array<any> = []
            for (const entry of listChatStateFiles(chatsRoot)) {
              const platform = safeString(entry && entry.platform || '')
              const chatId = safeString(entry && entry.chatId || '')
              const botId = safeString(entry && entry.botId || '')
              const st = readJson(entry.statePath, null)
              if (!st || typeof st !== 'object') continue
              const chatKey = safeString(st.chatKey || composeRuntimeChatKey(platform, chatId, botId)).trim()
              const sessionFile = readPiSessionFile(st)
              if (!chatKey || !sessionFile || !fs.existsSync(sessionFile)) continue
              let modifiedAt = 0
              try { modifiedAt = Math.max(Number(fs.statSync(sessionFile).mtimeMs || 0), Number(fs.statSync(entry.statePath).mtimeMs || 0)) } catch {}
              rows.push({ chatKey, sessionFile, modifiedAt })
            }
            rows.sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0))
            return rows
          },
          getSessionConfig: async (chatKey) => {
            const parsed = parseChatKey(chatKey)
            if (!parsed) return null
            const pseudo = pseudoSessionFromParsed(parsed, '')
            const { chatDir, state } = getChatCtx(pseudo)
            return {
              sessionDir: piSessionDirForChat(chatDir),
              sessionFile: readPiSessionFile(state),
              brainChatKey: chatKey,
              currentChatKey: chatKey,
            }
          },
          runControlCommand: async ({ name, chatKey }) => {
            const commandName = safeString(name || '').trim()
            const effectiveChatKey = safeString(chatKey || '').trim()
            if (commandName === '/status') {
              if (!effectiveChatKey) throw new Error('bridge_chat_required')
              return { notices: [await buildStatusText(effectiveChatKey)] }
            }
            if (commandName === '/restart') {
              const resp = await requestDaemonSelfRestart({
                chatKey: effectiveChatKey,
                reason: 'tui:/restart',
              })
              if (!(resp && (resp as any).ok)) {
                throw new Error(safeString(resp && (resp as any).error || 'daemon_restart_failed'))
              }
              return { restarting: true }
            }
            throw new Error(`unsupported_control_command:${commandName}`)
          },
        },
      })

	    // Schedule runner (inspection + timer): runs inside this single daemon.
	    const scheduleTickMs = Math.max(Number(config.scheduleTickMs || 0), 5000)
    const scheduleTimer = setInterval(() => { void tickSchedulesOnce().catch(() => {}) }, scheduleTickMs)
    setTimeout(() => { void tickSchedulesOnce().catch(() => {}) }, 3500)

    // After restarts, queued messages may exist on disk but no new event will arrive to trigger activation.
    // Catch up selected chats if there are unprocessed seq ranges (best-effort).
	    setTimeout(() => {
	      void (async () => {
	        try {
	          if (isShuttingDown()) return

            const clearedStaleProcessing: string[] = []
            try {
              const chatStates = listChatStateFiles(chatsRoot)
              for (const entry of chatStates) {
                const platform = safeString(entry && entry.platform || '')
                const chatId = safeString(entry && entry.chatId || '')
                const botId = safeString(entry && entry.botId || '')
                const st = readJson(entry.statePath, null)
                if (!st || typeof st !== 'object' || !Boolean(st.processing)) continue
                const chatKey = safeString(st.chatKey || composeRuntimeChatKey(platform, chatId, botId))
                if (!chatKey) continue

                let stale = false
                const pid = Number(st.processingPid || 0)
                const startedAt = Number(st.processingStartedAt || 0)
                if (Number.isFinite(pid) && pid > 0) {
                  try {
                    process.kill(pid, 0)
                  } catch (e) {
                    if (!e || (e as any).code === 'ESRCH') stale = true
                  }
                } else if (!startedAt || nowMs() - startedAt > 5 * 60 * 1000) {
                  stale = true
                }
                if (!stale) continue

                try {
                  const summary = summarizeConversationResumeWork({ state: st, platform, chatId })
                  await withChatLock(chatKey, async () => {
                    const parsed = parseChatKey(chatKey)
                    if (!parsed) return
                    const pseudo0 = pseudoSessionFromParsed(parsed, '')
                    const { state, saveState } = getChatCtx(pseudo0)
                    resetEphemeral(chatKey)
                    recoverConversationFromStaleProcessing({ state, keepForceContinue: summary.keepForceContinue })
                    saveState()
                  }, { op: 'boot_clear_stale_processing', chatKey })
                  clearedStaleProcessing.push(chatKey)
                } catch {}
              }
            } catch {}
            if (clearedStaleProcessing.length) {
              logger.info(`boot cleared stale processing chatKeys=${JSON.stringify(clearedStaleProcessing)}`)
            }

	          const catchUp = new Map<string, string>()
	          try {
              const chatStates = listChatStateFiles(chatsRoot)
              for (const entry of chatStates) {
                const platform = safeString(entry && entry.platform || '')
                const chatId = safeString(entry && entry.chatId || '')
                const botId = safeString(entry && entry.botId || '')
	                const st = readJson(entry.statePath, null)
	                if (!st || typeof st !== 'object') continue
                const summary = summarizeConversationResumeWork({ state: st, platform, chatId })
	                if (!summary.hasResumeWork || !summary.shouldCatchUp) continue
	                const chatKey = safeString(st.chatKey || composeRuntimeChatKey(platform, chatId, botId))
	                catchUp.set(chatKey, summary.lastText)
                }
	          } catch {}

	          if (!catchUp.size) return

	          const chatKeys = Array.from(catchUp.keys()).filter(Boolean)
	          logger.info(`boot catch-up chatKeys=${JSON.stringify(chatKeys)}`)
	          for (const chatKey of chatKeys) {
	            const parsed = parseChatKey(chatKey)
	            if (!parsed) continue
	            if (!findBot(parsed.platform, parsed.botId)) continue
	            let content = safeString(catchUp.get(chatKey) || '')
	            if (!content) {
	              try {
	                const chatDir = chatDirForParsed(parsed)
	                const logsDir = path.join(chatDir, 'logs')
	                const files = fs.existsSync(logsDir)
	                  ? fs.readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()
	                  : []
	                const tail = files.slice(-3).reverse()
	                for (const f of tail) {
	                  const p = path.join(logsDir, f)
	                  const raw = fs.readFileSync(p, 'utf8')
	                  const lines = raw.split('\n').filter(Boolean).slice(-250).reverse()
	                  for (const line of lines) {
	                    let obj
	                    try { obj = JSON.parse(line) } catch { continue }
	                    const isOutbound = safeString(obj?.raw?.direction) === 'out' || safeString(obj?.sender?.trust) === 'BOT'
	                    if (isOutbound) continue
	                    const t = safeString(obj?.text || '')
	                    if (t) { content = t; break }
	                  }
	                  if (content) break
	                }
	              } catch {}
	            }
	            const pseudo = pseudoSessionFromParsed(parsed, content)
	            activate(pseudo).catch((e) => logger.error(e))
	          }
	        } catch (e) {
	          logger.warn(`boot catch-up failed: ${(e && e.message) ? e.message : String(e)}`)
	        }
	      })()
	    }, 1500)

    setTimeout(() => {
      void (async () => {
        try {
          if (isShuttingDown()) return
          const marker = readJson(restartMarkerPath, null as any)
          if (!marker || typeof marker !== 'object') return
          const restartIntent = marker && typeof marker.intent === 'object' ? marker.intent : null
          const restartChatKey = safeString(restartIntent && restartIntent.chatKey || '').trim()
          if (!restartChatKey || !parseChatKey(restartChatKey)) return

          const resp = await enqueueRestartResumeIntent({
            chatKey: restartChatKey,
            requestId: safeString(restartIntent && restartIntent.requestId || '').trim(),
            reason: safeString(restartIntent && restartIntent.reason || '').trim(),
            requestedAt: Number(restartIntent && restartIntent.requestedAt || 0) || 0,
            markerTs: Number(marker && marker.ts || 0) || 0,
          })

          if (!(resp && (resp as any).ok)) {
            logger.warn(`startup: restart resume enqueue failed chatKey=${restartChatKey} err=${safeString(resp && (resp as any).error || 'unknown_error')}`)
            return
          }

          logger.info(`startup: restart resume enqueued chatKey=${restartChatKey} requestId=${safeString(restartIntent && restartIntent.requestId || '')}`)
          try { fs.rmSync(restartMarkerPath, { force: true }) } catch {}
        } catch (e) {
          logger.warn(`startup: restart resume failed: ${(e && (e as any).message) ? (e as any).message : String(e)}`)
        }
      })()
    }, 2500)

	    ctx.on('dispose', () => {
	      try { clearInterval(scheduleTimer) } catch {}
	      try { ctlServer.close() } catch {}
	      try { fs.rmSync(ctlSockPath, { force: true }) } catch {}
        try { tuiRpcServer && typeof tuiRpcServer.close === 'function' && tuiRpcServer.close() } catch {}
	    })
  }

  return { name: 'rin-bridge', apply }
})()

const logger = new Logger('rin-daemon')

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function safeJson(obj: any) {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return '{}'
  }
}

function writeTextAtomic(filePath: string, content: string) {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch {}
}

function writeJsonAtomic(filePath: string, obj: any) {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, safeJson(obj), 'utf8')
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch {}
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function daemonSettingsPath() {
  return path.join(homeRoot, 'settings.json')
}

function daemonLegacyConfigPath() {
  return path.join(homeRoot, 'config.yml')
}

function daemonKoishiConfigPath(dataDir: string) {
  return path.join(dataDir, 'koishi.yml')
}

function daemonRuntimeLocaleDir() {
  return path.join(homeRoot, 'locale')
}


// When compiled, this file runs from `dist/daemon.js`.
const daemonDir = path.resolve(__dirname, '..')
const daemonLayout = resolveRinLayout({ sourceHint: daemonDir })
const homeRoot = daemonLayout.homeRoot
const dataDir = path.join(homeRoot, 'data')
ensureDir(dataDir)
const restartMarkerPath = path.join(dataDir, 'restart.json')
const chatsRoot = path.join(dataDir, 'chats')

// Prevent accidental double-run (would cause duplicate sends).
const lockPath = path.join(dataDir, 'rin-daemon.lock')
try { fs.rmSync(path.join(dataDir, 'rin-koishi.lock'), { force: true }) } catch {}

function acquireLock() {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    return
  } catch {}

  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim())
    if (pid && Number.isFinite(pid)) {
      try {
        process.kill(pid, 0)
        throw new Error(`rin-daemon already running (pid=${pid})`)
      } catch (e: any) {
        // If the process doesn't exist, we can take over the lock.
        if (e && e.code !== 'ESRCH') throw e
      }
    }
  } catch {}

  try { fs.rmSync(lockPath, { force: true }) } catch {}
  fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
}

acquireLock()
process.on('exit', () => { try { fs.rmSync(lockPath, { force: true }) } catch {} })

let app: any = null
let shuttingDown = false
let shutdownStartedAt = 0
let shutdownPromise: Promise<void> | null = null
let pendingRestartIntent: Record<string, any> | null = null

function localizedDaemonStatusText(kind: 'shutdown' | 'startup') {
  const pathKey = kind === 'shutdown' ? 'rinDaemon.status.shutdown' : 'rinDaemon.status.startup'
  const text = daemonText(app && app.i18n, pathKey)
  if (text) return text
  return kind === 'shutdown' ? 'Daemon is going offline for now.' : 'Daemon is back online now.'
}

function currentRestartIntent() {
  if (!pendingRestartIntent || typeof pendingRestartIntent !== 'object') return null
  return { ...pendingRestartIntent }
}

async function requestDaemonSelfRestart({
  chatKey = '',
  reason = '',
}: {
  chatKey?: string
  reason?: string
} = {}) {
  if (shutdownPromise || shuttingDown) throw new Error('daemon_shutting_down')
  const nextChatKey = topSafeString(chatKey).trim()
  if (nextChatKey && !parseChatKey(nextChatKey)) throw new Error(`invalid_chatKey:${nextChatKey}`)
  const requestId = require('node:crypto').randomBytes(8).toString('hex')
  pendingRestartIntent = {
    kind: 'self_restart',
    requestId,
    requestedAt: Date.now(),
    chatKey: nextChatKey,
    reason: topSafeString(reason || '').trim(),
  }
  setTimeout(() => {
    void gracefulShutdown('SELF_RESTART')
  }, 25)
  return { ok: true, restarting: true, requestId }
}

function interruptCodexRunsAndCollectPids() {
  const pids = new Set<number>()
  for (const { statePath } of listChatStateFiles(chatsRoot)) {
    const st = readJson<any>(statePath, null as any)
    if (!st || typeof st !== 'object') continue
    const pid = Number(st.processingPid || 0)
    if (st.processing && Number.isFinite(pid) && pid > 0) pids.add(pid)
  }

  const allPids = Array.from(pids)
  if (allPids.length) {
    logger.info(`shutdown: interrupting agent pids=${JSON.stringify(allPids)}`)
    for (const pid of allPids) {
      try { process.kill(pid, 'SIGINT') } catch {}
    }
    setTimeout(() => {
      for (const pid of allPids) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
    }, 2000)
    setTimeout(() => {
      for (const pid of allPids) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }, 8000)
  }

  return { pids: allPids }
}

async function waitForPidsExit(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  const remaining = new Set<number>(pids || [])
  while (remaining.size && Date.now() < deadline) {
    for (const pid of Array.from(remaining)) {
      try {
        process.kill(pid, 0)
      } catch (e: any) {
        if (e && e.code === 'ESRCH') remaining.delete(pid)
      }
    }
    if (!remaining.size) break
    await sleep(100)
  }
  return Array.from(remaining)
}

async function gracefulShutdown(signal: string) {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    if (shuttingDown) return
    shuttingDown = true
    shutdownStartedAt = Date.now()
    ;(globalThis as any).__RIN_KOISHI_SHUTTING_DOWN = true

    const { pids } = interruptCodexRunsAndCollectPids()
    const restartIntent = currentRestartIntent()
    writeJsonAtomic(restartMarkerPath, {
      ts: Date.now(),
      pid: process.pid,
      signal: String(signal || ''),
      intent: restartIntent,
    })

    const remaining = await waitForPidsExit(pids, 15_000)
    if (remaining.length) logger.warn(`shutdown: agent still alive after wait pids=${JSON.stringify(remaining)}`)

    try {
      await stopSearxngSidecar(homeRoot, { logger })
    } catch (e: any) {
      logger.warn(`shutdown: searxng stop failed: ${(e && e.message) ? e.message : String(e)}`)
    }

    let shutdownAnnounced = false
    const restartChatKey = topSafeString(restartIntent && restartIntent.chatKey || '').trim()
    if (restartChatKey) {
      try {
        const text = localizedDaemonStatusText('shutdown')
        logger.info(`shutdown: sending targeted away message chatKey=${restartChatKey}`)
        await Promise.race([
          sendTextToChatKey(app, restartChatKey, text),
          new Promise((_r, reject) => setTimeout(() => reject(new Error('send_timeout')), 12_000)),
        ])
        shutdownAnnounced = true
      } catch (e: any) {
        logger.warn(`shutdown: targeted send failed chatKey=${restartChatKey}: ${(e && e.message) ? e.message : String(e)}`)
      }
    }

    if (!shutdownAnnounced) {
	      try {
	        logger.info('shutdown: sending away message to owners')
	        const resp = await sendTextToOwners(app, dataDir, { text: localizedDaemonStatusText('shutdown'), timeoutMs: 12_000 })
	        logger.info(`shutdown: send done ok=${resp && (resp as any).ok ? 'true' : 'false'}`)
	      } catch (e: any) {
	        logger.warn(`shutdown: send failed: ${(e && e.message) ? e.message : String(e)}`)
	      }
    }

    const elapsed = Date.now() - shutdownStartedAt
    logger.info(`shutdown: exit elapsedMs=${elapsed}`)
    process.exit(0)
  })()
  return shutdownPromise
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGHUP', () => { void gracefulShutdown('SIGHUP') })

function readLocaleStore(filePath: string) {
  const store = readJson<any>(filePath, null as any)
  if (!store || typeof store !== 'object' || Array.isArray(store)) return null
  return store
}

function deepMergeLocaleStore(base: any, overlay: any): any {
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay
  if (!base || typeof base !== 'object') return overlay
  if (!overlay || typeof overlay !== 'object') return overlay
  const out: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const prev = out[key]
    if (
      prev &&
      value &&
      typeof prev === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(prev) &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeLocaleStore(prev, value)
      continue
    }
    out[key] = value
  }
  return out
}

function listLocaleDefinitions(dirPath: string) {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const locale = name.endsWith('.default.json')
        ? name.slice(0, -'.default.json'.length)
        : path.basename(name, '.json')
      const store = readLocaleStore(path.join(dirPath, name))
      return store ? { locale, store, isDefault: name.endsWith('.default.json') } : null
    })
    .filter(Boolean) as Array<{ locale: string, store: Record<string, any>, isDefault: boolean }>
}

function mergeLocaleDefinitions(...groups: Array<Array<{ locale: string, store: Record<string, any> }>>) {
  const out = new Map<string, { locale: string, store: Record<string, any> }>()
  for (const group of groups) {
    for (const entry of group) {
      const prev = out.get(entry.locale)
      out.set(
        entry.locale,
        prev
          ? { locale: entry.locale, store: deepMergeLocaleStore(prev.store, entry.store) }
          : { locale: entry.locale, store: entry.store },
      )
    }
  }
  return Array.from(out.values())
}

const builtinDaemonLocaleDefinitions = [
  {
    locale: 'en-US',
    store: {
      commands: {
        new: { description: 'Start a new session' },
        status: { description: 'Show current chat status' },
        restart: { description: 'Restart' },
      },
      rinDaemon: {
        status: {
          shutdown: 'Rin is going offline for now.',
          startup: 'Rin is back online now.',
        },
      },
    },
  },
]
const runtimeLocaleDefinitions = listLocaleDefinitions(daemonRuntimeLocaleDir())
const localLocaleDefinitions = mergeLocaleDefinitions(
  runtimeLocaleDefinitions.filter((entry) => !entry.isDefault),
)
const daemonLocaleDefinitions = mergeLocaleDefinitions(builtinDaemonLocaleDefinitions, localLocaleDefinitions)
const daemonUiLocale = localLocaleDefinitions.some((entry) => entry.locale === 'zh-CN')
  ? 'zh-CN'
  : (localLocaleDefinitions[0]?.locale || 'en-US')
const daemonUiLocales = daemonUiLocale === 'en-US' ? ['en-US'] : [daemonUiLocale, 'en-US']

function registerDaemonLocales(app: any) {
  if (!app || !app.i18n) return
  for (const { locale, store } of daemonLocaleDefinitions) {
    app.i18n.define(locale, store)
  }
}

function daemonText(i18n: any, pathKey: string, params: Record<string, any> = {}) {
  if (!i18n || typeof i18n.text !== 'function') return ''
  return String(i18n.text(daemonUiLocales, [pathKey], params) || '')
}

function topSafeString(v: any) {
  if (v == null) return ''
  return String(v)
}

function topSafeBasename(name: any) {
  const s = topSafeString(name).trim()
  if (!s) return ''
  return path.basename(s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180)
}

function patchTelegramAdapterAvatarFetchOnce() {
  const g: any = globalThis as any
  if (g.__RIN_TELEGRAM_AVATAR_PATCHED) return
  g.__RIN_TELEGRAM_AVATAR_PATCHED = true
  try {
    // adapter-telegram fetches bot profile photos on login; flaky networks can throw and crash the daemon.
    // Swallow avatar fetch errors so OneBot + schedules keep running.
    const mod: any = require('@satorijs/adapter-telegram')
    const TelegramBot = mod && mod.TelegramBot
    if (!TelegramBot || !TelegramBot.prototype) return
    const orig = TelegramBot.prototype.setAvatarUrl
    if (typeof orig !== 'function') return
    TelegramBot.prototype.setAvatarUrl = async function (user: any) {
      try {
        return await orig.call(this, user)
      } catch (e) {
        try {
          const l = (this as any)?.logger
          if (l && typeof l.warn === 'function') {
            l.warn(`setAvatarUrl failed (ignored): ${(e && (e as any).message) ? (e as any).message : String(e)}`)
          }
        } catch {}
      }
    }
  } catch {}
}

function installTelegramPollingSelfHeal(app: any, dataDir: string) {
  if (!app) return
  const bots = Array.isArray(app?.bots) ? app.bots : []
  const restartChatKey = preferredOwnerChatKey(dataDir)
  for (const bot of bots) {
    if (!bot || bot.platform !== 'telegram') continue
    const anyBot: any = bot
    if (anyBot.__RIN_TELEGRAM_POLL_SELF_HEAL_INSTALLED) continue
    anyBot.__RIN_TELEGRAM_POLL_SELF_HEAL_INSTALLED = true

    const state = {
      firstFailureAt: 0,
      failureCount: 0,
      lastFailureAt: 0,
      lastRestartAt: 0,
      restartPending: false,
    }

    const resetState = () => {
      state.firstFailureAt = 0
      state.failureCount = 0
      state.lastFailureAt = 0
      state.restartPending = false
    }

    const origOnline = typeof anyBot.online === 'function' ? anyBot.online : null
    if (origOnline) {
      anyBot.online = function (...args: any[]) {
        resetState()
        return origOnline.apply(this, args)
      }
    }

    const botLogger = anyBot.logger
    const origWarn = botLogger && typeof botLogger.warn === 'function' ? botLogger.warn : null
    if (!origWarn) continue

    const scrubTelegramLogPart = (value: any) => {
      if (typeof value !== 'string') return value
      return value.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    }

    botLogger.warn = function (...args: any[]) {
      const safeArgs = args.map((part) => scrubTelegramLogPart(part))
      try {
        const template = topSafeString(safeArgs[0]).toLowerCase()
        if (template.includes('failed to get updates')) {
          const rendered = safeArgs.map((part) => topSafeString(part)).join(' ').toLowerCase()
          const reason = rendered.includes('409') || rendered.includes('conflict')
            ? 'telegram_getupdates_conflict'
            : 'telegram_getupdates_failed'

          if (reason === 'telegram_getupdates_conflict') {
            const now = Date.now()
            const windowMs = 90_000
            const threshold = 2
            const cooldownMs = 10 * 60 * 1000

            if (!state.firstFailureAt || now - state.firstFailureAt > windowMs) {
              state.firstFailureAt = now
              state.failureCount = 0
            }
            state.failureCount += 1
            state.lastFailureAt = now

            if (
              !state.restartPending
              && state.failureCount >= threshold
              && (!state.lastRestartAt || now - state.lastRestartAt > cooldownMs)
            ) {
              state.restartPending = true
              state.lastRestartAt = now
              logger.warn(
                `telegram self-heal: requesting daemon restart after ${state.failureCount} polling failures within ${Math.max(1, Math.round((now - state.firstFailureAt) / 1000))}s reason=${reason}`,
              )
              void requestDaemonSelfRestart({ chatKey: restartChatKey, reason })
                .then((resp: any) => {
                  logger.info(`telegram self-heal: restart requested ok=${resp && resp.ok ? 'true' : 'false'} chatKey=${restartChatKey || '(owners)'}`)
                })
                .catch((e: any) => {
                  state.restartPending = false
                  logger.warn(`telegram self-heal: restart request failed: ${(e && e.message) ? e.message : String(e)}`)
                })
            }
          }
        }
      } catch {}
      return origWarn.apply(this, safeArgs)
    }
  }
}

function isOneBotFileNotice(data: any) {
  if (!data || typeof data !== 'object') return false
  if (topSafeString(data.post_type) !== 'notice') return false
  const noticeType = topSafeString(data.notice_type)
  return noticeType === 'offline_file' || noticeType === 'group_upload'
}

async function buildOneBotFileElement(bot: any, data: any) {
  const raw = data && typeof data === 'object' ? (data.file && typeof data.file === 'object' ? { ...data.file } : {}) : {}
  const noticeType = topSafeString(data && data.notice_type)
  const name = topSafeBasename(raw.name || raw.file_name || raw.filename || raw.file || '')
  const fileId = topSafeString(raw.file_id || raw.id || '')
  const fileHash = topSafeString(raw.file_hash || raw.sha || '')
  const busid = raw.busid == null ? '' : topSafeString(raw.busid)
  let src = topSafeString(raw.url || raw.src || raw.file || '')

  try {
    if (!src && noticeType === 'group_upload' && bot?.internal && typeof bot.internal.getGroupFileUrl === 'function') {
      const url = await bot.internal.getGroupFileUrl(
        Number(data.group_id || 0) || String(data.group_id || ''),
        fileId,
        busid === '' ? undefined : (Number(busid) || busid),
      )
      src = topSafeString(url)
    }
  } catch {}

  try {
    if (!src && noticeType === 'offline_file' && bot?.internal && typeof bot.internal.getPrivateFileUrl === 'function') {
      const url = await bot.internal.getPrivateFileUrl(
        Number(data.user_id || 0) || String(data.user_id || ''),
        fileId,
        fileHash,
      )
      src = topSafeString(url)
    }
  } catch {}

  const attrs: any = { ...raw }
  if (src) attrs.src = src
  if (name) attrs.name = name
  return h('file', attrs)
}

async function dispatchOneBotFileNotice(bot: any, data: any) {
  if (!bot || !data || typeof data !== 'object' || !isOneBotFileNotice(data)) return false

  const session = bot.session()
  session.selfId = data.self_tiny_id ? topSafeString(data.self_tiny_id) : topSafeString(data.self_id)
  session.type = 'message'
  session.subtype = topSafeString(data.notice_type) === 'offline_file' ? 'private' : 'group'
  session.subsubtype = topSafeString(data.notice_type) === 'offline_file' ? 'offline-file-added' : 'guild-file-added'
  session.isDirect = topSafeString(data.notice_type) === 'offline_file'
  session.userId = topSafeString(data.user_id)
  if (data.group_id != null) session.guildId = session.channelId = topSafeString(data.group_id)
  if (!session.channelId) session.channelId = session.userId ? `private:${session.userId}` : ''
  if (data.time != null) session.timestamp = Number(data.time) * 1000

  const name = topSafeBasename(data?.file?.name || data?.file?.file_name || data?.file?.filename || '')
  const fileId = topSafeString(data?.file?.file_id || data?.file?.id || '')
  const seed = `${topSafeString(data.notice_type)}:${topSafeString(data.group_id || data.user_id)}:${fileId || name}:${topSafeString(data.time)}`
  session.messageId = `onebot-file:${seed}`
  session.content = name ? `[file] ${name}` : '[file]'
  session.elements = [await buildOneBotFileElement(bot, data)]
  try { session.setInternal('onebot', data) } catch {}
  bot.dispatch(session)
  return true
}

function patchOneBotAdapterFileNoticesOnce() {
  const g: any = globalThis as any
  if (g.__RIN_ONEBOT_FILE_NOTICE_PATCHED) return
  g.__RIN_ONEBOT_FILE_NOTICE_PATCHED = true
  try {
    const mod: any = require('koishi-plugin-adapter-onebot')
    const WsClient = mod?.WsClient
    const origAccept = WsClient?.prototype?.accept
    if (typeof origAccept === 'function' && WsClient?.prototype) {
      WsClient.prototype.accept = function (socket: any) {
        const bot = this.bot
        socket.addEventListener('message', ({ data }: any) => {
          let parsed: any
          data = data.toString()
          try {
            parsed = JSON.parse(data)
          } catch {
            return
          }
          if (!isOneBotFileNotice(parsed)) return
          void dispatchOneBotFileNotice(bot, parsed).catch((e) => {
            bot.logger.warn(`dispatch onebot file notice failed: ${(e && e.message) ? e.message : String(e)}`)
          })
        })
        return origAccept.call(this, socket)
      }
    }
  } catch {}
}

function validateDaemonConfig(configPath: string, config: RinDaemonConfig) {
  const onebots = findPluginConfigs(config?.plugins, 'adapter-onebot').map((entry) => entry.value as Record<string, any>)
  const telegrams = findPluginConfigs(config?.plugins, 'adapter-telegram').map((entry) => entry.value as Record<string, any>)
  if (!onebots.length && !telegrams.length) {
    // Local-only TUI installs may not configure any chat adapters yet.
    return
  }
  for (const onebot of onebots) {
    if (!topSafeString(onebot && onebot.endpoint)) {
      throw new Error(`daemon_config_missing_field:adapter-onebot.endpoint`)
    }
    if (!topSafeString(onebot && onebot.selfId)) {
      throw new Error(`daemon_config_missing_field:adapter-onebot.selfId`)
    }
  }
  for (const telegram of telegrams) {
    if (!topSafeString(telegram && telegram.token)) {
      throw new Error(`daemon_config_missing_field:adapter-telegram.token`)
    }
  }
}

function configInt(value: any, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function configString(value: any, fallback: string) {
  const s = topSafeString(value)
  return s || fallback
}

function configStringList(value: any, fallback: string[] = []) {
  if (Array.isArray(value)) {
    return value.map((item) => topSafeString(item).trim()).filter(Boolean)
  }
  const raw = topSafeString(value).trim()
  if (!raw) return fallback
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

async function createKoishiApp(dataDir: string) {
  const settings = loadDaemonHomeSettings(daemonSettingsPath())
  const { configPath, config } = materializeDaemonConfig(daemonKoishiConfigPath(dataDir), settings)

  const loader = new Loader()
  await loader.init(configPath)
  loader.envFiles = []
  await loader.readConfig(true)

  validateDaemonConfig(configPath, config)

  if (findPluginConfig(config?.plugins, 'adapter-onebot')) patchOneBotAdapterFileNoticesOnce()
  if (findPluginConfig(config?.plugins, 'adapter-telegram')) patchTelegramAdapterAvatarFetchOnce()

  const app = await loader.createApp()
  registerDaemonLocales(app)

  app.plugin(rinBridge as any, {
    dataDir,
    groupMentionMinInboundMsgs: 0,
    groupStartupSilenceMs: 0,
    scheduleTickMs: 5000,
    scheduleCommandConcurrency: 4,
    ownerDebounceMs: 0,
    ownerDebounceMaxMs: 0,
    mentionedDebounceMs: 0,
    agentMaxRuntimeMs: 3600000,
    provider: configString(settings.defaultProvider, 'openai'),
    model: configString(settings.defaultModel, 'gpt-5.4'),
    thinking: configString(settings.defaultThinkingLevel, ''),
  })

  return app
}

async function main() {
  if (!process.env.TMPDIR) {
    // Some environments don't set it; the daemon uses it for transient files.
    process.env.TMPDIR = os.tmpdir()
  }

  app = await createKoishiApp(dataDir)
  installTelegramPollingSelfHeal(app, dataDir)

  await app.start()
  installTelegramPollingSelfHeal(app, dataDir)

  try {
    const resp = await ensureSearxngSidecar(homeRoot, { logger })
    if (resp && resp.ok) logger.info(`web-search: searxng ready baseUrl=${topSafeString(resp.baseUrl || '')}`)
    else if (resp && resp.skipped) logger.info(`web-search: searxng skipped reason=${topSafeString(resp.skipped || '')}`)
    else if (resp && resp.error) logger.warn(`web-search: searxng unavailable error=${topSafeString(resp.error || '')}`)
  } catch (e: any) {
    logger.warn(`web-search: searxng startup failed: ${(e && e.message) ? e.message : String(e)}`)
  }

  const bots = app.bots.map((b: any) => ({ platform: b.platform, selfId: b.selfId, status: b.status }))
  logger.info(`started bots=${JSON.stringify(bots)}`)

  // Startup fallback: markers with a valid chatKey are resumed inside rinBridge so the
  // restart context enters the normal bridge log/thread path. Only markers without a
  // valid chatKey still fall back to an owner-facing direct notice here.
  try {
    const marker = readJson(restartMarkerPath, null as any)
    if (marker && typeof marker === 'object') {
      const restartIntent = marker && typeof marker.intent === 'object' ? marker.intent : null
      const restartChatKey = topSafeString(restartIntent && restartIntent.chatKey || '').trim()
      if (restartChatKey && parseChatKey(restartChatKey)) {
        logger.info(`startup: restart marker reserved for bridge resume chatKey=${restartChatKey} requestId=${topSafeString(restartIntent && restartIntent.requestId || '')}`)
      } else {
        await sleep(1500)
        logger.info('startup: sending back message to owners')
        const resp = await sendTextToOwners(app, dataDir, { text: localizedDaemonStatusText('startup'), timeoutMs: 12_000 })
        logger.info(`startup: send done ok=${resp && (resp as any).ok ? 'true' : 'false'}`)
        try { fs.rmSync(restartMarkerPath, { force: true }) } catch {}
      }
    }
  } catch (e: any) {
    logger.warn(`startup: send failed: ${(e && e.message) ? e.message : String(e)}`)
  }
}

main().catch((err) => {
  logger.error(err)
  process.exitCode = 1
})
