// @ts-nocheck
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

import { Loader, Logger, h } from 'koishi'
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
  sendTextToOwners,
} from './daemon-support'
import { loadPiSdkModule, manageSchedule, queueBrainFinalizeAsync, runPiSdkTurn } from './runtime'
import { startDaemonTuiRpcServer } from './daemon-tui-rpc'
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

				  function defaultState(chatKey) {
				    return {
				      chatKey,
				      codexThreadId: '',
              piSessionFile: '',
            bridgeProtocolRetryCount: 0,
				      lastProcessedSeq: 0,
              lastThreadIngestedSeq: 0,
			      lastSeq: 0,
			      lastInboundSeq: 0,
			      lastInboundText: '',
            lastAgentInboundSeq: 0,
            lastAgentInboundAt: 0,
            lastAgentInboundText: '',
            lastAgentResult: null,
            lastShadowResult: null,
            lastResetResult: null,
            inboundUnprocessed: 0,
					      processing: false,
	              processingNoInterrupt: false,
                processingRuntime: '',
					      processingPid: 0,
              processingThreadId: '',
            processingTurnId: '',
				      processingRunId: '',
				      processingStartedAt: 0,
              resetPendingTrigger: null,
				      batchEndSeq: 0,
		      lastSystemAckAt: 0,
		      interruptRequested: false,
		      interruptRequestedAt: 0,
	      pendingWake: false,
	      pendingTrigger: null,
	      replyToMessageId: '',
	      forceContinue: false,
	      recentMessageIds: [],
	    }
	  }

  function readCodexThreadId(state: any) {
    if (!state || typeof state !== 'object') return ''
    return safeString((state as any).codexThreadId || (state as any).codexSessionId || '').trim()
  }

  function writeCodexThreadId(state: any, value: any) {
    if (!state || typeof state !== 'object') return ''
    const nextThreadId = safeString(value || '').trim()
    ;(state as any).codexThreadId = nextThreadId
    try { delete (state as any).codexSessionId } catch {}
    return nextThreadId
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

  function piShadowSessionDirForChat(chatDir: string) {
    return path.join(chatDir, 'pi-shadow-session')
  }

  function shadowRunLogPath(chatDir: string) {
    return path.join(chatDir, 'shadow-runs.jsonl')
  }

  function mergePendingTrigger(a, b) {
    if (!a) return b || null
    if (!b) return a || null
    const as = Number(a.seq || 0)
    const bs = Number(b.seq || 0)
    if (Number.isFinite(bs) && Number.isFinite(as) && bs !== as) {
      const picked = bs > as ? b : a
      return { ...picked, isMentioned: Boolean((a as any)?.isMentioned || (b as any)?.isMentioned) }
    }
    const at = Number(a.ts || 0)
    const bt = Number(b.ts || 0)
    if (Number.isFinite(bt) && Number.isFinite(at) && bt !== at) {
      const picked = bt > at ? b : a
      return { ...picked, isMentioned: Boolean((a as any)?.isMentioned || (b as any)?.isMentioned) }
    }
    const picked = b || a || null
    if (!picked) return null
    return { ...picked, isMentioned: Boolean((a as any)?.isMentioned || (b as any)?.isMentioned) }
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

  const BRIDGE_AGENT_SEND_PREFIX = '#RIN_SEND'
  const BRIDGE_AGENT_INTERIM_MARKER = '··· '
  const activeProcessingTurns = new Map<string, any>()
  const shadowTurnQueues = new Map<string, Promise<any>>()
  let codexAppServerSupervisor: any = null
  let codexAppServerSupervisorPromise: Promise<any> | null = null
  let sendToChatRef: any = null
  let isCurrentProcessingRunRef: any = null
  let syncConcurrentStateFromDiskRef: any = null
  let requestInterruptIfProcessingRef: any = null

  function lockRootDir() {
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

  function lockFilePathForKey(key) {
    const h = nodeCrypto.createHash('sha256').update(safeString(key)).digest('hex')
    return path.join(lockRootDir(), 'locks', `${h}.lock`)
  }

  function trimTail(text: any, limit = 128_000) {
    const s = safeString(text)
    if (!limit || s.length <= limit) return s
    return s.slice(-limit)
  }

  function extractBridgeSendText(value: any) {
    const raw = safeString(value || '')
    if (!raw) return ''
    const normalized = raw.replace(/^\uFEFF/, '')
    if (!normalized.startsWith(BRIDGE_AGENT_SEND_PREFIX)) return ''
    let rest = normalized.slice(BRIDGE_AGENT_SEND_PREFIX.length)
    if (rest.startsWith('\r\n')) rest = rest.slice(2)
    else if (rest.startsWith('\n')) rest = rest.slice(1)
    else if (rest.startsWith(' ')) rest = rest.slice(1)
    return rest.replace(/^\s+/, '')
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

  function candidateOutboundTextKeys(value: any, platform = '') {
    const raw = safeString(value || '')
    const out = new Set<string>()
    const key = normalizeBridgePayloadKey(raw)
    if (key) out.add(key)
    return out
  }

  function outboundHasText(records: Array<any>, value: any) {
    const items = Array.isArray(records) ? records : []
    return items.some((item) => {
      const logged = normalizeBridgePayloadKey(item && item.text)
      if (!logged) return false
      const platform = safeString(item && item.platform || '')
      return candidateOutboundTextKeys(value, platform).has(logged)
    })
  }

  function normalizeFinalAgentMessage(value: any) {
    const raw = safeString(value || '')
    const trimmed = raw.trim()
    const normalized = raw.replace(/^\uFEFF/, '')
    const prefixedSend = normalized.startsWith(BRIDGE_AGENT_SEND_PREFIX)
    const sent = extractBridgeSendText(raw)
    if (prefixedSend) {
      return sent
        ? { kind: 'reply', raw: trimmed, text: sent }
        : { kind: 'empty', raw: trimmed, text: '' }
    }
    if (!trimmed) return { kind: 'empty', raw: '', text: '' }
    if (trimmed === 'OK') return { kind: 'ok', raw: trimmed, text: '' }
    return { kind: 'reply', raw: trimmed, text: trimmed }
  }

  function evaluateTurnCompletion(value: any, outbound: Array<any>, {
    allowContinue = true,
    allowLegacyOk = false,
    allowReplyWithoutDelivery = false,
  } = {}) {
    const normalized = normalizeFinalAgentMessage(value)
    const hasOutbound = Array.isArray(outbound) && outbound.length > 0
    const sentFinalReply = normalized.kind === 'reply' ? outboundHasText(outbound, normalized.text) : false
    if (normalized.kind === 'reply') {
      const acceptedReply = sentFinalReply || (!hasOutbound && allowReplyWithoutDelivery)
      return { normalized, hasOutbound, sentFinalReply, kind: acceptedReply ? 'ok' : 'protocol_violation' }
    }
    if (normalized.kind === 'ok') {
      return { normalized, hasOutbound, sentFinalReply, kind: allowLegacyOk && hasOutbound ? 'ok' : 'protocol_violation' }
    }
    return { normalized, hasOutbound, sentFinalReply, kind: 'protocol_violation' }
  }

  function activeProcessingTurnKey(chatKey: any, processingRunId: any) {
    return `${safeString(chatKey || '')}@@${safeString(processingRunId || '')}`
  }

  function registerActiveProcessingTurn({ chatKey, processingRunId, runtime = 'codex', threadId, turnId, abort = null }: any) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key || key === '@@') return
    activeProcessingTurns.set(key, {
      chatKey: safeString(chatKey || ''),
      processingRunId: safeString(processingRunId || ''),
      runtime: normalizeRuntimeKind(runtime),
      threadId: safeString(threadId || ''),
      turnId: safeString(turnId || ''),
      abort: typeof abort === 'function' ? abort : null,
    })
  }

  function clearActiveProcessingTurn({ chatKey, processingRunId }: any) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key || key === '@@') return
    activeProcessingTurns.delete(key)
  }

  function getActiveProcessingTurn({ chatKey, processingRunId }: any) {
    const key = activeProcessingTurnKey(chatKey, processingRunId)
    if (!key || key === '@@') return null
    return activeProcessingTurns.get(key) || null
  }

  function currentCodexAppServerPid() {
    const pid = Number(codexAppServerSupervisor && codexAppServerSupervisor.child && codexAppServerSupervisor.child.pid)
    return Number.isFinite(pid) && pid > 0 ? pid : 0
  }

  function createCodexAppServerSupervisor(repoRoot: string, workspaceRoot: string) {
    const supervisor: any = {
      child: null,
      lineBuf: '',
      pending: new Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>(),
      rpcId: 1,
      initialized: false,
      closed: false,
      stderrTail: '',
      turnsByTurnId: new Map<string, any>(),
      turnsByThreadId: new Map<string, any>(),
    }

    const clearTurnTimeout = (turn: any) => {
      if (turn && turn.timeoutTimer) {
        try { clearTimeout(turn.timeoutTimer) } catch {}
        turn.timeoutTimer = null
      }
    }

    const armTurnTimeout = (turn: any) => {
      if (!turn || turn.completed || turn.killedByTimeout) return
      const timeoutMs = Number(turn.timeoutMs || 0)
      if (!(timeoutMs > 0)) return
      clearTurnTimeout(turn)
      turn.timeoutTimer = setTimeout(() => {
        turn.killedByTimeout = true
        clearTurnTimeout(turn)
        void supervisor.interruptTurn({ threadId: turn.threadId, turnId: turn.turnId })
        turn.forceStopTimer = setTimeout(() => {
          if (turn.completed) return
          turn.stderr = trimTail(`${safeString(turn.stderr || '')}${turn.stderr ? '\n' : ''}turn_timeout`, 32_000)
          supervisor.forceRestart('turn_timeout')
        }, 10_000)
      }, timeoutMs)
    }

    const refreshTurnTimeout = (turn: any) => {
      if (!turn || turn.completed || turn.killedByTimeout) return
      turn.lastActivityAt = Date.now()
      armTurnTimeout(turn)
    }

    const removeTurn = (turn: any) => {
      const threadId = safeString(turn && turn.threadId || '')
      const turnId = safeString(turn && turn.turnId || '')
      if (turnId) supervisor.turnsByTurnId.delete(turnId)
      if (threadId && supervisor.turnsByThreadId.get(threadId) === turn) supervisor.turnsByThreadId.delete(threadId)
      clearTurnTimeout(turn)
      if (turn && turn.forceStopTimer) {
        try { clearTimeout(turn.forceStopTimer) } catch {}
        turn.forceStopTimer = null
      }
      if (turn && turn.runtimeTracking) {
        clearActiveProcessingTurn({
          chatKey: turn.runtimeTracking.chatKey,
          processingRunId: turn.runtimeTracking.processingRunId,
        })
      }
    }

    const finishTurn = (turn: any, code: any) => {
      if (!turn || turn.completed) return
      if (Number(code) === 0) queueBridgeFinalReply(turn)
      turn.completed = true
      removeTurn(turn)
      void Promise.resolve(turn.sendQueue || Promise.resolve())
        .catch(() => {})
        .then(() => {
          try {
            turn.resolve({
              code: code == null ? 1 : code,
              stdout: safeString(turn.stdout || ''),
              stderr: safeString(turn.stderr || ''),
              lastMessage: safeString(turn.lastMessage || ''),
              killedByTimeout: Boolean(turn.killedByTimeout),
              threadId: safeString(turn.threadId || ''),
              turnStarted: Boolean(turn.turnStarted),
              turnStatus: safeString(turn.turnStatus || ''),
            })
          } catch {}
        })
    }

    const failTurn = (turn: any, error: any, code = 1) => {
      if (!turn || turn.completed) return
      const msg = safeString(error && error.message ? error.message : error || '')
      if (msg) turn.stderr = trimTail(`${safeString(turn.stderr || '')}${turn.stderr ? '\n' : ''}${msg}`, 32_000)
      if (!safeString(turn.stderr || '').trim() && supervisor.stderrTail) {
        turn.stderr = trimTail(supervisor.stderrTail, 32_000)
      }
      finishTurn(turn, code)
    }

    const captureLastMessage = (turn: any, value: any, phase = '') => {
      if (!turn) return
      const text = safeString(value)
      if (!text.trim()) return
      const normalizedPhase = safeString(phase).trim().toLowerCase()
      if (normalizedPhase === 'final_answer') {
        turn.lastMessage = text
        return
      }
      if (!safeString(turn.lastMessage || '').trim()) turn.lastMessage = text
    }

    const enqueueBridgeText = (turn: any, payload: any, { itemId = '', dedupeByPayload = false, interim = false, viaOverride = '' }: any = {}) => {
      if (!turn || !turn.bridgeSend) return false
      const rawPayload = safeString(payload || '')
      if (!rawPayload) return false
      const textPayload = interim
        ? formatBridgeInterimText(rawPayload, safeString(turn.bridgeSend.interimMarker || '') || BRIDGE_AGENT_INTERIM_MARKER)
        : rawPayload
      if (!textPayload) return false
      const id = safeString(itemId || '')
      if (id) {
        if (!turn.sentBridgeItemIds) turn.sentBridgeItemIds = new Set()
        if (turn.sentBridgeItemIds.has(id)) return false
        turn.sentBridgeItemIds.add(id)
      }
      const chatKey = safeString(turn.bridgeSend.chatKey || '')
      if (!chatKey) return false
      const parsed = parseChatKey(chatKey)
      if (!parsed) return false
      const replyToMessageId = safeString(turn.bridgeSend.replyToMessageId || '')
      const via = safeString(viaOverride || turn.bridgeSend.via || 'agent-prefix')
      const payloadKey = normalizeBridgePayloadKey(textPayload)
      if (dedupeByPayload && payloadKey) {
        if (!turn.sentBridgePayloadKeys) turn.sentBridgePayloadKeys = new Set()
        if (turn.sentBridgePayloadKeys.has(payloadKey)) return false
      }
      if (payloadKey) {
        if (!turn.sentBridgePayloadKeys) turn.sentBridgePayloadKeys = new Set()
        turn.sentBridgePayloadKeys.add(payloadKey)
      }
      turn.sendQueue = Promise.resolve(turn.sendQueue || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await sendToChatRef({
            chatKey,
            parsed,
            text: textPayload,
            elements: [],
            images: [],
            files: [],
            via,
            replyToMessageId,
          })
        })
        .catch((e: any) => {
          logger.warn(`agent prefix send failed chatKey=${chatKey} err=${safeString(e && e.message ? e.message : e)}`)
        })
      return true
    }

    const queueBridgeSend = (turn: any, value: any, itemId = '') => {
      const payload = extractBridgeSendText(value)
      if (!payload) return
      enqueueBridgeText(turn, payload, { itemId, dedupeByPayload: false, interim: true })
    }

    const queueBridgeFinalReply = (turn: any) => {
      if (!turn || turn.finalBridgeReplyQueued) return
      turn.finalBridgeReplyQueued = true
      const normalized = normalizeFinalAgentMessage(turn.lastMessage)
      if (normalized.kind !== 'reply') return
      enqueueBridgeText(turn, normalized.text, { dedupeByPayload: true })
    }

    const resolvePending = (obj: any) => {
      const pendingEntry = supervisor.pending.get(obj.id)
      if (!pendingEntry) return false
      supervisor.pending.delete(obj.id)
      if (obj.error) {
        const message = safeString(obj.error && obj.error.message || 'rpc_error')
        pendingEntry.reject(new Error(message))
      } else {
        pendingEntry.resolve(obj.result)
      }
      return true
    }

    const findTurnForParams = (params: any) => {
      const turnIds = [
        params && params.turnId,
        params && params.turn && params.turn.id,
        params && params.turn && params.turn.turnId,
        params && params.msg && params.msg.turn_id,
        params && params.id,
      ]
      for (const rawId of turnIds) {
        const id = safeString(rawId || '')
        if (!id) continue
        const turn = supervisor.turnsByTurnId.get(id)
        if (turn) return turn
      }
      const threadIds = [
        params && params.threadId,
        params && params.thread && params.thread.id,
        params && params.thread && params.thread.threadId,
        params && params.msg && params.msg.thread_id,
        params && params.conversationId,
      ]
      for (const rawId of threadIds) {
        const id = safeString(rawId || '')
        if (!id) continue
        const turn = supervisor.turnsByThreadId.get(id)
        if (turn) return turn
      }
      return null
    }

    const handleRpcLine = (line: string) => {
      const raw = safeString(line)
      const t = raw.trim()
      if (!t) return

      let obj: any = null
      try { obj = JSON.parse(t) } catch { return }

      if (obj && typeof obj.id === 'number' && Object.prototype.hasOwnProperty.call(obj, 'method')) {
        try {
          supervisor.child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: obj.id,
            error: {
              code: -32601,
              message: `unsupported_server_request:${safeString(obj.method || '')}`,
            },
          }) + '\n')
        } catch {}
        return
      }

      if (obj && typeof obj.id === 'number' && (Object.prototype.hasOwnProperty.call(obj, 'result') || Object.prototype.hasOwnProperty.call(obj, 'error'))) {
        resolvePending(obj)
        return
      }

      const method = safeString(obj && obj.method || '')
      const params = obj && typeof obj.params === 'object' ? obj.params : {}
      const turn = findTurnForParams(params)
      if (turn) turn.stdout = trimTail(`${safeString(turn.stdout || '')}${raw}\n`, 256_000)
      if (turn) refreshTurnTimeout(turn)

      if (method === 'item/started') {
        const item = params && typeof params.item === 'object' ? params.item : null
        if (turn && item && safeString(item.type).toLowerCase() === 'agentmessage') {
          const itemId = safeString(item.id || '')
          if (itemId) {
            turn.agentMessageTexts.set(itemId, safeString(item.text || ''))
            turn.agentMessagePhases.set(itemId, safeString(item.phase || ''))
          }
        }
        return
      }

      if (method === 'item/agentMessage/delta') {
        if (!turn) return
        const itemId = safeString(params && params.itemId || '')
        if (!itemId) return
        const next = safeString(turn.agentMessageTexts.get(itemId) || '') + safeString(params && params.delta || '')
        turn.agentMessageTexts.set(itemId, next)
        return
      }

      if (method === 'item/completed') {
        const item = params && typeof params.item === 'object' ? params.item : null
        if (turn && item && safeString(item.type).toLowerCase() === 'agentmessage') {
          const itemId = safeString(item.id || '')
          const phase = safeString(item.phase || turn.agentMessagePhases.get(itemId) || '')
          const text = safeString(item.text || turn.agentMessageTexts.get(itemId) || '')
          queueBridgeSend(turn, text, itemId)
          captureLastMessage(turn, text, phase)
        }
        return
      }

      if (method === 'codex/event/agent_message') {
        if (!turn) return
        const msg = params && params.msg && typeof params.msg === 'object' ? params.msg : {}
        captureLastMessage(turn, msg.message, msg.phase)
        return
      }

      if (method === 'codex/event/task_complete') {
        if (!turn) return
        const msg = params && params.msg && typeof params.msg === 'object' ? params.msg : {}
        captureLastMessage(turn, msg.last_agent_message, 'final_answer')
        return
      }

      if (method === 'turn/started') {
        if (!turn) return
        const turnObj = params && typeof params.turn === 'object' ? params.turn : null
        const turnId = safeString(turnObj && (turnObj.id || turnObj.turnId) || '')
        turn.turnStarted = true
        if (turnId) {
          turn.turnId = turnId
          supervisor.turnsByTurnId.set(turnId, turn)
          if (turn.runtimeTracking) {
            registerActiveProcessingTurn({
              chatKey: turn.runtimeTracking.chatKey,
              processingRunId: turn.runtimeTracking.processingRunId,
              runtime: 'codex',
              threadId: turn.threadId,
              turnId,
            })
          }
          if (turn.autoInterruptOnTurnStart && !turn.autoInterruptIssued) {
            turn.autoInterruptIssued = true
            void supervisor.interruptTurn({ threadId: turn.threadId, turnId })
          }
        }
        return
      }

      if (method === 'turn/completed') {
        if (!turn) return
        const turnObj = params && typeof params.turn === 'object' ? params.turn : null
        const turnError = turnObj && turnObj.error
        if (turnError) {
          const msg = safeString(turnError && turnError.message ? turnError.message : JSON.stringify(turnError))
          if (msg) turn.stderr = trimTail(`${safeString(turn.stderr || '')}${turn.stderr ? '\n' : ''}${msg}`, 32_000)
        }
        const status = safeString(turnObj && turnObj.status || '')
        turn.turnStatus = status
        const interruptedAsSuccess = Boolean(turn.allowInterruptedSuccess && turn.autoInterruptIssued && status === 'interrupted' && !turnError)
        const code = turn.killedByTimeout
          ? 124
          : (turnError || (status && status !== 'completed' && !interruptedAsSuccess))
            ? 1
            : 0
        finishTurn(turn, code)
      }
    }

    supervisor.sendRequest = (method: string, params: any) => {
      if (supervisor.closed || !supervisor.child) return Promise.reject(new Error('app_server_unavailable'))
      const id = supervisor.rpcId++
      return awaitableRequest(id, method, params)
    }

    const awaitableRequest = (id: number, method: string, params: any) => {
      return new Promise<any>((resolveReq, rejectReq) => {
        supervisor.pending.set(id, { resolve: resolveReq, reject: rejectReq })
        try {
          supervisor.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        } catch (e) {
          supervisor.pending.delete(id)
          rejectReq(e)
        }
      })
    }

    supervisor.interruptTurn = async ({ threadId, turnId }: any) => {
      const nextThreadId = safeString(threadId || '')
      const nextTurnId = safeString(turnId || '')
      if (!nextThreadId || !nextTurnId) return
      try {
        await supervisor.sendRequest('turn/interrupt', { threadId: nextThreadId, turnId: nextTurnId })
      } catch (e) {
        logger.warn(`turn interrupt failed thread=${nextThreadId} turn=${nextTurnId} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
      }
    }

    supervisor.forceRestart = (reason = '') => {
      if (!supervisor.child) return
      logger.warn(`restarting codex app-server reason=${safeString(reason || 'unknown')}`)
      try { supervisor.child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { supervisor.child.kill('SIGKILL') } catch {} }, 2000)
    }

    supervisor.start = async () => {
      if (supervisor.child && !supervisor.closed) return supervisor
      const child = spawn('codex', ['app-server'], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          RIN_REPO_ROOT: repoRoot,
          PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`,
        },
      })
      supervisor.child = child
      supervisor.closed = false
      supervisor.stderrTail = ''
      supervisor.lineBuf = ''
      supervisor.rpcId = 1
      supervisor.pending = new Map()
      supervisor.turnsByTurnId = new Map()
      supervisor.turnsByThreadId = new Map()

      child.stdout.on('data', (d) => {
        const s = d.toString()
        supervisor.lineBuf += s
        while (true) {
          const idx = supervisor.lineBuf.indexOf('\n')
          if (idx < 0) break
          const line = supervisor.lineBuf.slice(0, idx)
          supervisor.lineBuf = supervisor.lineBuf.slice(idx + 1)
          handleRpcLine(line)
        }
      })
      child.stderr.on('data', (d) => {
        supervisor.stderrTail = trimTail(`${supervisor.stderrTail}${d.toString()}`, 32_000)
      })
      child.on('error', (e) => {
        supervisor.stderrTail = trimTail(`${supervisor.stderrTail}${supervisor.stderrTail ? '\n' : ''}spawn_error:${safeString(e && (e as any).message ? (e as any).message : e)}`, 32_000)
      })
      child.on('close', (code, signal) => {
        if (supervisor.lineBuf) handleRpcLine(supervisor.lineBuf)
        supervisor.lineBuf = ''
        supervisor.closed = true
        const message = signal
          ? `app_server_signal:${signal}`
          : `app_server_closed:${String(code == null ? 1 : code)}`
        for (const [, pendingEntry] of supervisor.pending) {
          try { pendingEntry.reject(new Error(message)) } catch {}
        }
        supervisor.pending.clear()
        const activeTurns = Array.from(supervisor.turnsByTurnId.values()) as any[]
        const provisionalTurns = Array.from(supervisor.turnsByThreadId.values()).filter((turn: any) => !safeString(turn && turn.turnId || '')) as any[]
        const turns = [...activeTurns, ...provisionalTurns] as any[]
        for (const turn of turns) failTurn(turn, message, turn && turn.killedByTimeout ? 124 : 1)
        supervisor.turnsByTurnId.clear()
        supervisor.turnsByThreadId.clear()
        if (codexAppServerSupervisor === supervisor) codexAppServerSupervisor = null
      })

      await supervisor.sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: {
          name: 'rin',
          version: '1.0.0',
        },
      })
      supervisor.initialized = true
      return supervisor
    }

    supervisor.runTurn = async ({
      prompt,
      inputItems = null,
      resumeThreadId,
      timeoutMs = 0,
      images = [],
      bridgeSend = null,
      runtimeTracking = null,
      turnBehavior = null,
      threadConfig = null,
    }: any): Promise<CodexTurnResult> => {
      const rt = runtimeTracking && typeof runtimeTracking === 'object' ? runtimeTracking : null
      const behavior = turnBehavior && typeof turnBehavior === 'object' ? turnBehavior : {}
      const nextThreadConfig = threadConfig && typeof threadConfig === 'object' ? threadConfig : {}
      const primeRuntimeState = () => {
        if (!rt) return
        if (!isCurrentProcessingRunRef || !isCurrentProcessingRunRef(rt.state, rt.processingRunId)) throw new Error('stale_processing_run')
        rt.state.processingPid = supervisor.child && supervisor.child.pid ? supervisor.child.pid : 0
        if (syncConcurrentStateFromDiskRef) {
          syncConcurrentStateFromDiskRef({ chatDir: rt.chatDir, state: rt.state, observedToSeq: rt.observedToSeq })
        }
        rt.saveState()
      }

      primeRuntimeState()

      let threadResult = null as any
      if (resumeThreadId) {
        try {
          threadResult = await supervisor.sendRequest('thread/resume', {
            threadId: resumeThreadId,
            cwd: repoRoot,
            sandbox: 'danger-full-access',
            approvalPolicy: 'never',
            ...nextThreadConfig,
          })
        } catch (e) {
          logger.warn(`thread resume failed thread=${safeString(resumeThreadId)} err=${safeString(e && (e as any).message ? (e as any).message : e)}; starting fresh thread`)
        }
      }
      if (!threadResult) {
        threadResult = await supervisor.sendRequest('thread/start', {
          cwd: repoRoot,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          ...nextThreadConfig,
        })
      }

      const threadId = safeString(
        threadResult
        && threadResult.thread
        && (threadResult.thread.id || threadResult.thread.threadId),
      )

      const turn: any = {
        threadId,
        turnId: '',
        stdout: '',
        stderr: '',
        lastMessage: '',
        killedByTimeout: false,
        turnStarted: false,
        turnStatus: '',
        completed: false,
        resolve: (_value: CodexTurnResult) => {},
        bridgeSend: bridgeSend && typeof bridgeSend === 'object' ? bridgeSend : null,
        runtimeTracking: rt,
        agentMessageTexts: new Map(),
        agentMessagePhases: new Map(),
        sentBridgeItemIds: new Set(),
        sentBridgePayloadKeys: new Set(),
        finalBridgeReplyQueued: false,
        timeoutMs: Number(timeoutMs || 0),
        timeoutTimer: null,
        forceStopTimer: null,
        lastActivityAt: Date.now(),
        sendQueue: Promise.resolve(),
        autoInterruptOnTurnStart: Boolean(behavior.autoInterruptOnTurnStart),
        autoInterruptIssued: false,
        allowInterruptedSuccess: Boolean(behavior.allowInterruptedSuccess),
      }
      if (threadId) supervisor.turnsByThreadId.set(threadId, turn)

      const input = Array.isArray(inputItems) && inputItems.length
        ? inputItems
        : [
            { type: 'text', text: prompt },
            ...((Array.isArray(images) ? images : [])
              .map((filePath) => safeString(filePath).trim())
              .filter(Boolean)
              .map((filePath) => ({ type: 'localImage', path: filePath }))),
          ]

      const resultPromise = new Promise<CodexTurnResult>((resolveTurn) => {
        turn.resolve = resolveTurn
      })

      armTurnTimeout(turn)

      try {
        const turnResult = await supervisor.sendRequest('turn/start', {
          threadId,
          input,
          cwd: repoRoot,
          approvalPolicy: 'never',
        })
        turn.turnId = safeString(
          turnResult
          && turnResult.turn
          && (turnResult.turn.id || turnResult.turn.turnId),
        )
        if (turn.turnId) supervisor.turnsByTurnId.set(turn.turnId, turn)
        if (rt) {
          registerActiveProcessingTurn({
            chatKey: rt.chatKey,
            processingRunId: rt.processingRunId,
            runtime: 'codex',
            threadId,
            turnId: turn.turnId,
          })
          try {
            rt.state.processingThreadId = threadId
            rt.state.processingTurnId = turn.turnId
          } catch {}
          primeRuntimeState()
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
      } catch (e) {
        failTurn(turn, e, 1)
      }

      return await resultPromise
    }

    return supervisor
  }

  async function ensureCodexAppServerSupervisor(repoRoot: string, workspaceRoot: string) {
    if (codexAppServerSupervisor && !codexAppServerSupervisor.closed && codexAppServerSupervisor.child) return codexAppServerSupervisor
    if (codexAppServerSupervisorPromise) return await codexAppServerSupervisorPromise
    const supervisor = createCodexAppServerSupervisor(repoRoot, workspaceRoot)
    codexAppServerSupervisor = supervisor
    codexAppServerSupervisorPromise = supervisor.start()
      .then(() => supervisor)
      .catch((error: any) => {
        if (codexAppServerSupervisor === supervisor) codexAppServerSupervisor = null
        throw error
      })
      .finally(() => {
        codexAppServerSupervisorPromise = null
      })
    return await codexAppServerSupervisorPromise
  }

  async function runCodexAppServerTurn({
    repoRoot,
    workspaceRoot,
    prompt,
    inputItems = null,
    resumeThreadId,
    timeoutMs = 0,
    onSpawn = null,
    images = [],
    lockKey = '',
    threadInitLockKey = 'thread-init',
    envPatch = null,
    configOverrides = [],
    bridgeSend = null,
    runtimeTracking = null,
    turnBehavior = null,
    threadConfig = null,
  }: any): Promise<CodexTurnResult> {
    const threadInitLockPath = (!resumeThreadId && threadInitLockKey)
      ? lockFilePathForKey(`codex:${safeString(threadInitLockKey)}`)
      : ''
    let threadInitLockReleased = false
    const releaseThreadInitLock = threadInitLockPath
      ? await acquireExclusiveFileLock(threadInitLockPath, {
        pollMs: 120,
        heartbeatMs: 10_000,
        staleMs: 10 * 60 * 1000,
        meta: { cmd: 'codex', lockKey: 'thread-init' },
      })
      : null
    const safeReleaseThreadInitLock = () => {
      if (!releaseThreadInitLock || threadInitLockReleased) return
      threadInitLockReleased = true
      try { releaseThreadInitLock() } catch {}
    }
    const lockPath = lockKey ? lockFilePathForKey(`codex:${safeString(lockKey)}`) : ''
    const releaseLock = lockPath
      ? await acquireExclusiveFileLock(lockPath, {
        pollMs: 120,
        heartbeatMs: 10_000,
        staleMs: 10 * 60 * 1000,
        meta: { cmd: 'codex', lockKey: safeString(lockKey) },
      })
      : null

    try {
      if (envPatch && Object.keys(envPatch).length) {
        logger.warn('persistent app-server ignores per-turn envPatch; configure behavior in prompt/runtime instead')
      }
      if (Array.isArray(configOverrides) && configOverrides.some((entry) => safeString(entry).trim())) {
        logger.warn('persistent app-server ignores per-turn configOverrides; configure behavior in prompt/runtime instead')
      }
      const supervisor = await ensureCodexAppServerSupervisor(repoRoot, workspaceRoot)
      if (typeof onSpawn === 'function') {
        try { onSpawn(supervisor.child) } catch {}
      }
      const result = await supervisor.runTurn({
        prompt,
        inputItems,
        resumeThreadId,
        timeoutMs,
        images,
        bridgeSend,
        runtimeTracking,
        turnBehavior,
        threadConfig,
      })
      if (!resumeThreadId && result && safeString(result.threadId || '')) safeReleaseThreadInitLock()
      return result
    } finally {
      safeReleaseThreadInitLock()
      try { if (typeof releaseLock === 'function') releaseLock() } catch {}
    }
  }

  async function runPiTurn({
    rootDir = '',
    repoRoot,
    workspaceRoot,
    piProvider = 'openai-codex',
    piModel = 'gpt-5.3-codex',
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
      const normalized = normalizeFinalAgentMessage(rawText)
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

  function reconcileCodexThreadId(state: any, resultThreadId: any, chatKey = '') {
    const nextThreadId = safeString(resultThreadId || '').trim()
    if (!nextThreadId) return
    const currentThreadId = readCodexThreadId(state)
    if (!currentThreadId) {
      writeCodexThreadId(state, nextThreadId)
      return
    }
    if (currentThreadId !== nextThreadId) {
      logger.warn(`codex thread mismatch chatKey=${safeString(chatKey)} expected=${currentThreadId} got=${nextThreadId}`)
      writeCodexThreadId(state, nextThreadId)
    }
  }

  function reconcilePiSessionFile(state: any, resultSessionFile: any, chatKey = '') {
    const nextSessionFile = safeString(resultSessionFile || '').trim()
    if (!nextSessionFile) return
    const currentSessionFile = readPiSessionFile(state)
    if (!currentSessionFile) {
      writePiSessionFile(state, nextSessionFile)
      return
    }
    if (currentSessionFile !== nextSessionFile) {
      logger.warn(`pi session mismatch chatKey=${safeString(chatKey)} expected=${currentSessionFile} got=${nextSessionFile}`)
      writePiSessionFile(state, nextSessionFile)
    }
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
    const configuredPiProvider = safeString((config as any)?.provider || (config as any)?.piProvider || 'openai-codex').trim()
    const configuredPiModel = safeString((config as any)?.model || (config as any)?.piModel || 'gpt-5.3-codex').trim()
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

    function buildRestartResumeThreadText({ requestId = '', reason = '', startupText = '' }: any = {}) {
      const visibleReply = safeString(startupText || localizedDaemonStatusText('startup') || '').trim() || 'Daemon is back online now.'
      const lines = [
        '[daemon internal restart note]',
        'This is an internal runtime event, not a user message.',
        'Daemon just completed a self-restart for this chat.',
      ]
      const nextRequestId = safeString(requestId || '').trim()
      const nextReason = safeString(reason || '').trim()
      if (nextRequestId) lines.push(`requestId: ${nextRequestId}`)
      if (nextReason) lines.push(`reason: ${nextReason}`)
      lines.push('Do not mention requestId, reason, logs, thread state, or restart internals to the user.')
      lines.push('Please send exactly this brief plain-text message to the current chat:')
      lines.push(visibleReply)
      lines.push('After sending it, continue normally on later turns.')
      return lines.join('\n')
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

      const syntheticText = buildRestartResumeThreadText({
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

        state.lastAgentInboundSeq = Number(record.seq || 0) || 0
        state.lastAgentInboundAt = tsMs
        state.lastAgentInboundText = syntheticText
        state.inboundUnprocessed = Math.max(0, Number(state.inboundUnprocessed || 0) || 0) + 1
        state.pendingWake = true
        state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, {
          seq: Number(record.seq || 0) || 0,
          ts: Number(record.ts || 0) || 0,
          messageId: syntheticMessageId,
          content: syntheticText,
          senderUserId: '',
          senderName: 'Daemon',
          isMentioned: false,
          chatType: effectiveChatType,
          replyToMessageId: '',
          quotedText: '',
          quotedSenderUserId: '',
          quotedSenderName: '',
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

    function buildBatchInputItemsFromRecords(records: Array<any>, {
      maxImages = 6,
    }: any = {}) {
      const textBlocks: Array<string> = []
      const images: Array<any> = []
      const seenImagePaths = new Set<string>()
      const items = Array.isArray(records) ? records : []

      for (const record of items) {
        if (shouldSkipThreadHistoryRecord(record)) continue
        const inputs = buildThreadHistoryInputsFromRecord(record)
        for (const input of inputs) {
          if (!input || typeof input !== 'object') continue
          if (safeString(input.type) === 'text') {
            const text = safeString(input.text).trim()
            if (text) textBlocks.push(text)
            continue
          }
          if (safeString(input.type) === 'localImage') {
            const localPath = safeString(input.path).trim()
            if (!localPath || seenImagePaths.has(localPath) || images.length >= Number(maxImages || 0)) continue
            seenImagePaths.add(localPath)
            images.push({ type: 'localImage', path: localPath })
          }
        }
      }

      const out: Array<any> = []
      const text = textBlocks.join('\n\n').trim()
      if (text) out.push({ type: 'text', text })
      return out.concat(images)
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
				      writeCodexThreadId(state, readCodexThreadId(state))
              writePiSessionFile(state, readPiSessionFile(state))
				      if (!state.chatKey) state.chatKey = chatKey
              state.processingRuntime = state.processing
                ? normalizeRuntimeKind(state.processingRuntime || 'codex')
                : safeString(state.processingRuntime || '').trim()
			      if (!Number.isFinite(Number(state.lastInboundSeq))) state.lastInboundSeq = Number(state.lastSeq || 0)
			      if (typeof state.lastInboundText !== 'string') state.lastInboundText = safeString(state.lastInboundText || '')
            if (!Number.isFinite(Number(state.lastThreadIngestedSeq))) {
              state.lastThreadIngestedSeq = Number(state.lastProcessedSeq || 0) || 0
            }
            if (!Number.isFinite(Number(state.lastAgentInboundSeq))) state.lastAgentInboundSeq = 0
            if (!Number.isFinite(Number(state.lastAgentInboundAt))) state.lastAgentInboundAt = 0
            if (typeof state.lastAgentInboundText !== 'string') state.lastAgentInboundText = safeString(state.lastAgentInboundText || '')
            state.lastAgentResult = normalizeLastAgentResult(state.lastAgentResult)
            state.lastShadowResult = normalizeLastAgentResult(state.lastShadowResult)
            state.lastResetResult = normalizeLastAgentResult(state.lastResetResult)
            if (!Number.isFinite(Number(state.inboundUnprocessed))) state.inboundUnprocessed = 0
			      try {
			        const lastProcessableInbound = Number(state.lastAgentInboundSeq || 0)
			        const lastProcessed = Number(state.lastProcessedSeq || 0)
			        const unprocessedInbound = Math.max(0, lastProcessableInbound - lastProcessed)
              if (Number(state.inboundUnprocessed || 0) > unprocessedInbound) state.inboundUnprocessed = unprocessedInbound
			      } catch {}
	      if (state.processing && !state.processingPid) {
          const active = getActiveProcessingTurn({ chatKey, processingRunId: state.processingRunId })
          const activeRuntime = normalizeRuntimeKind(
            (active && active.runtime)
            || state.processingRuntime
            || primaryRuntimeForChat(chatKey),
          )
          const keepInProcessPi = Boolean(active && activeRuntime === 'pi')
	        const startedAt = Number(state.processingStartedAt || 0)
	        if (!keepInProcessPi && (!startedAt || nowMs() - startedAt > 5 * 60 * 1000)) {
	          state.processing = false
            state.processingRuntime = ''
	          state.processingThreadId = ''
          state.processingTurnId = ''
          state.processingStartedAt = 0
        }
      }
      if (state.processing && state.processingPid) {
        try {
          process.kill(Number(state.processingPid), 0)
	        } catch (e) {
		          if (e && e.code === 'ESRCH') {
		            state.processing = false
                state.processingRuntime = ''
		            state.processingPid = 0
              state.processingThreadId = ''
              state.processingTurnId = ''
	            state.processingStartedAt = 0
	          }
	        }
	      }

	        const saveState = () => {
		        const disk = readJson(statePath, null) || defaultState(chatKey)
		        const merged = { ...disk, ...state }
		        merged.chatKey = state.chatKey || disk.chatKey || chatKey
	        writeCodexThreadId(merged, readCodexThreadId(state))
          writePiSessionFile(merged, readPiSessionFile(state))
		        merged.lastSeq = Math.max(Number(disk.lastSeq || 0), Number(state.lastSeq || 0))
	        merged.lastProcessedSeq = Math.max(Number(disk.lastProcessedSeq || 0), Number(state.lastProcessedSeq || 0))
        merged.lastThreadIngestedSeq = Math.max(Number(disk.lastThreadIngestedSeq || 0), Number(state.lastThreadIngestedSeq || 0))
	        merged.lastInboundSeq = Math.max(Number(disk.lastInboundSeq || 0), Number(state.lastInboundSeq || 0))
        merged.batchEndSeq = Math.max(Number(disk.batchEndSeq || 0), Number(state.batchEndSeq || 0))
        // Reset boundary must be monotonic; also avoid stale writers resurrecting pre-reset state.
        const diskResetAtMs = Number(disk.lastResetAtMs || 0)
        const stateResetAtMs = Number(state.lastResetAtMs || 0)
        merged.lastResetAtMs = Math.max(diskResetAtMs, stateResetAtMs)
        merged.lastResetSeq = Math.max(Number(disk.lastResetSeq || 0), Number(state.lastResetSeq || 0))
        try {
          const diskProcessed = Number(disk.lastProcessedSeq || 0)
          const nextProcessed = Math.max(Number(disk.lastProcessedSeq || 0), Number(state.lastProcessedSeq || 0))
          const diskInbound = Number(disk.inboundUnprocessed || 0)
          const stateInbound = Number(state.inboundUnprocessed || 0)
          merged.inboundUnprocessed = nextProcessed > diskProcessed ? Math.max(0, stateInbound) : Math.max(0, Math.max(diskInbound, stateInbound))
        } catch {}
        merged.pendingWake = Boolean(state.pendingWake)
        merged.pendingTrigger = state.pendingTrigger == null ? null : mergePendingTrigger(disk.pendingTrigger, state.pendingTrigger)
        merged.replyToMessageId = state.replyToMessageId == null ? (disk.replyToMessageId || '') : state.replyToMessageId
        merged.forceContinue = Boolean(state.forceContinue)
        const diskAgentInboundSeq = Math.max(0, Number(disk.lastAgentInboundSeq || 0) || 0)
        const stateAgentInboundSeq = Math.max(0, Number(state.lastAgentInboundSeq || 0) || 0)
        const diskAgentInboundAt = Math.max(0, Number(disk.lastAgentInboundAt || 0) || 0)
        const stateAgentInboundAt = Math.max(0, Number(state.lastAgentInboundAt || 0) || 0)
        if (stateAgentInboundSeq > diskAgentInboundSeq || (stateAgentInboundSeq === diskAgentInboundSeq && stateAgentInboundAt >= diskAgentInboundAt)) {
          merged.lastAgentInboundSeq = stateAgentInboundSeq
          merged.lastAgentInboundAt = stateAgentInboundAt
          merged.lastAgentInboundText = safeString(state.lastAgentInboundText || '')
        } else {
          merged.lastAgentInboundSeq = diskAgentInboundSeq
          merged.lastAgentInboundAt = diskAgentInboundAt
          merged.lastAgentInboundText = safeString(disk.lastAgentInboundText || '')
        }
	        merged.lastAgentResult = pickNewerLastAgentResult(disk.lastAgentResult, state.lastAgentResult)
	        merged.lastShadowResult = pickNewerLastAgentResult(disk.lastShadowResult, state.lastShadowResult)
	        merged.lastResetResult = pickNewerLastAgentResult(disk.lastResetResult, state.lastResetResult)
	        if (diskResetAtMs > stateResetAtMs) {
		          writeCodexThreadId(merged, readCodexThreadId(disk))
              writePiSessionFile(merged, readPiSessionFile(disk))
		          merged.pendingWake = Boolean(disk.pendingWake)
          merged.pendingTrigger = (disk as any).pendingTrigger == null ? null : (disk as any).pendingTrigger
          try { merged.inboundUnprocessed = Math.max(0, Number(disk.inboundUnprocessed || 0)) } catch {}
        }
        const a = Array.isArray(disk.recentMessageIds) ? disk.recentMessageIds : []
        const b = Array.isArray(state.recentMessageIds) ? state.recentMessageIds : []
        merged.recentMessageIds = Array.from(new Set([...a, ...b])).slice(-200)
        // Keep background counters strictly in-memory (restart-safe).
        try { delete (merged as any).recentInboundAtMs } catch {}
        try { delete (merged as any).backgroundPending } catch {}
        try { delete (merged as any).backgroundNonAtUnprocessed } catch {}
        try { delete (merged as any).backgroundLastCodexAt } catch {}
        try { delete (merged as any).lastBackgroundAt } catch {}
        try { delete (merged as any).backgroundArmed } catch {}
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
      if (!/^\/[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)) return ''
      return name
    }

    function isSlashCommandText(text) {
      const name = extractCommandLikeText(text)
      if (!name) return ''
      if (name === '/help' || name === '/reset' || name === '/restart' || name === '/status') return name
      return ''
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
      if (!raw || typeof raw !== 'object') return null
      return {
        runtime: normalizeRuntimeKind(raw.runtime || 'codex'),
        kind: safeString(raw.kind || ''),
        finishedAt: Math.max(0, Number(raw.finishedAt || 0) || 0),
        forInboundSeq: Math.max(0, Number(raw.forInboundSeq || 0) || 0),
        processedToSeq: Math.max(0, Number(raw.processedToSeq || 0) || 0),
        exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
        lastMessage: safeString(raw.lastMessage || ''),
      }
    }

    function pickNewerLastAgentResult(a: any, b: any) {
      const left = normalizeLastAgentResult(a)
      const right = normalizeLastAgentResult(b)
      if (!left) return right
      if (!right) return left
      if (right.finishedAt !== left.finishedAt) return right.finishedAt > left.finishedAt ? right : left
      if (right.forInboundSeq !== left.forInboundSeq) return right.forInboundSeq > left.forInboundSeq ? right : left
      return right
    }

    function summarizeLastAgentResult(result: any) {
      const normalized = normalizeLastAgentResult(result)
      if (!normalized) return 'none'
      const prefix = normalized.runtime ? `${normalized.runtime}: ` : ''
      if (normalized.kind === 'ok') {
        const finalMessage = normalizeFinalAgentMessage(normalized.lastMessage)
        return `${prefix}${finalMessage.kind === 'reply' ? 'reply' : 'completed'}`
      }
      if (normalized.kind === 'interrupted') return `${prefix}INTERRUPTED`
      if (normalized.kind === 'protocol_violation') {
        return normalized.lastMessage ? `${prefix}PROTOCOL_VIOLATION (${normalized.lastMessage})` : `${prefix}PROTOCOL_VIOLATION`
      }
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

    function uiText(pathKey: string, params: Record<string, any> = {}) {
      return daemonText(ctx.i18n, pathKey, params)
    }

    async function handleHelp({ chatKey, session }) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      const cache = new Map<string, Promise<boolean>>()
      const lines = []
      for (const cmd of ctx.$commander._commandList) {
        if (!cmd || cmd.name.includes('.') || cmd.config?.slash === false) continue
        if (!cmd.match(session)) continue
        if (!await ctx.permissions.test(`command:${cmd.name}`, session, cache)) continue
        const name = safeString(cmd.displayName || cmd.name || '').trim()
        if (!name) continue
        const description = safeString(session.text(`commands.${cmd.name}.description`) || '').trim()
        lines.push(description ? `· /${name}：${description}` : `· /${name}`)
      }

      await sendToChat({
        chatKey,
        parsed,
        text: lines.join('\n').trim(),
        images: [],
        files: [],
        via: 'koishi-cmd',
      })
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

      const resetCommandSeq = Number(state.lastResetCommandSeq || 0) || 0
      const resetCommandAt = Number(state.lastResetCommandAtMs || state.lastResetAtMs || 0) || 0
      if (resetCommandSeq > lastInboundSeq) {
        lastInboundSeq = resetCommandSeq
        if (resetCommandAt > 0) lastInboundAt = resetCommandAt
        lastInboundText = '/reset'
      }

      const currentResult = normalizeLastAgentResult(state.lastAgentResult)
      const currentResetResult = normalizeLastAgentResult(state.lastResetResult)
      const resultForLastInbound = currentResult && currentResult.forInboundSeq >= lastInboundSeq ? currentResult : null
      const resultForLastReset = currentResetResult && currentResetResult.forInboundSeq >= resetCommandSeq ? currentResetResult : null
      const resetInProgress = Boolean(state.processing && state.processingNoInterrupt)
      const processingRuntime = state.processing
        ? normalizeRuntimeKind(state.processingRuntime || primaryRuntimeForChat(chatKey))
        : ''
      const statusLine = resetInProgress
        ? `resetting since ${formatStatusTime(state.processingStartedAt)}${processingRuntime ? ` (${processingRuntime})` : ''}`
        : state.processing
          ? `running since ${formatStatusTime(state.processingStartedAt)}${processingRuntime ? ` (${processingRuntime})` : ''}`
          : 'idle'
      const resetLine = !resetCommandSeq
        ? 'none yet'
        : resetInProgress
          ? `running since ${formatStatusTime(state.processingStartedAt)}`
          : resultForLastReset
            ? summarizeLastAgentResult(resultForLastReset)
            : 'none yet'
      const resultLine = state.processing
        ? (resetInProgress ? 'none yet (reset is still running)' : 'none yet (agent is still running)')
        : resultForLastInbound
          ? summarizeLastAgentResult(resultForLastInbound)
          : 'none yet'
      const finishedLine = !state.processing && resultForLastInbound
        ? formatStatusTime(resultForLastInbound.finishedAt)
        : 'n/a'
      const resetFinishedLine = !resetCommandSeq || resetInProgress || !resultForLastReset
        ? 'n/a'
        : formatStatusTime(resultForLastReset.finishedAt)
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
      if (resetCommandSeq || resetCommandAt) {
        parts.push(`Last reset: ${formatStatusTime(resetCommandAt)}${resetCommandSeq ? ` (seq ${resetCommandSeq})` : ''}`)
        parts.push(`Reset result: ${resetLine}`)
        if (!resetInProgress) parts.push(`Reset result time: ${resetFinishedLine}`)
      }
      if (inboundPreview) parts.push(`Inbound preview: ${inboundPreview}`)
      return parts.join('\n')
    }

    async function handleStatus({ chatKey }) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      const text = await buildStatusText(chatKey)
      if (!text) return
      await sendToChat({
        chatKey,
        parsed,
        text,
        images: [],
        files: [],
        via: 'koishi-cmd',
      })
    }

    function queueBrainFinalize({ chatKey, reason = 'manual' }: any = {}) {
      try {
        return queueBrainFinalizeAsync({
          repoRoot,
          stateRoot: workspaceRoot,
          chatKey: safeString(chatKey || '').trim() || 'local:default',
          reason: safeString(reason || 'manual'),
        })
      } catch (e) {
        const message = safeString(e && (e as any).message ? (e as any).message : e)
        logger.warn(`brain finalize queue failed chatKey=${chatKey} err=${message}`)
        return { ok: false, error: message }
      }
    }

    function defaultChatTypeFromParsed(parsed: any) {
      const platform = safeString(parsed && parsed.platform || '')
      const chatId = safeString(parsed && parsed.chatId || '')
      if (platform === 'telegram') return chatId.startsWith('-') ? 'group' : 'private'
      if (platform === 'onebot') return chatId.startsWith('private:') ? 'private' : 'group'
      return 'private'
    }

    function isExplicitSlashControlCommand(session: any, expectedSlash = '') {
      const want = safeString(expectedSlash || '').trim()
      if (!want) return false
      const content = safeString(session && session.content || '')
      if (extractCommandLikeText(content) === want) return true
      const strippedContent = safeString(session && session.stripped && session.stripped.content || '')
      return extractCommandLikeText(strippedContent) === want
    }

    function clearPersistentRunFlags(
      state: any,
      { keepPendingTrigger = false, keepResetPending = false }: { keepPendingTrigger?: boolean, keepResetPending?: boolean } = {},
    ) {
      state.pendingWake = false
      if (!keepPendingTrigger) state.pendingTrigger = null
      if (!keepResetPending) state.resetPendingTrigger = null
      state.replyToMessageId = ''
      state.forceContinue = false
      state.processing = false
      state.processingNoInterrupt = false
      state.processingRuntime = ''
      state.processingPid = 0
      state.processingThreadId = ''
      state.processingTurnId = ''
      state.processingRunId = ''
      state.processingStartedAt = 0
      state.interruptRequested = false
      state.interruptRequestedAt = 0
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
      recentOutboundMinSeqExclusive = 0,
      recentOutboundMinTsMs = 0,
      allowContinue = true,
      allowLegacyOk = false,
      allowReplyWithoutDelivery = false,
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
        const normalized = normalizeFinalAgentMessage(result && result.lastMessage || '')
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
      const outbound = recentOutboundRecords(chatDir, {
        minSeqExclusive: Math.max(0, Number(recentOutboundMinSeqExclusive || 0) || 0),
        minTsMs: Math.max(0, Number(recentOutboundMinTsMs || 0) || 0),
      })
      const completion = evaluateTurnCompletion(result && result.lastMessage || '', outbound, {
        allowContinue,
        allowLegacyOk,
        allowReplyWithoutDelivery,
      })
	      const protocolViolation = Boolean(result && Number(result.code || 0) === 0 && completion.kind === 'protocol_violation')
	      return { result, trimmed, outbound, completion, protocolViolation }
	    }

    function queueShadowBridgeTurn({
      chatKey,
      parsed,
      uptoSeq,
      liveInputItems = [],
      batchInputItems = [],
      primaryRuntime = 'codex',
      primaryResultText = '',
    }: any = {}) {
      const configuredShadow = shadowRuntimeForChat(chatKey)
      if (!configuredShadow) return
      const prev = shadowTurnQueues.get(chatKey) || Promise.resolve()
      const next = prev
        .catch(() => {})
        .then(async () => {
          const shadowRuntime = shadowRuntimeForChat(chatKey)
          if (!shadowRuntime) return
          const shadowParsed = parsed || parseChatKey(chatKey)
          if (!shadowParsed) return
          const pseudo = pseudoSessionFromParsed(shadowParsed)
          const { chatDir, state, saveState } = getChatCtx(pseudo)
          if (Number(state.lastResetSeq || 0) >= (Number(uptoSeq || 0) || 0)) return

          const shadowResumeId = shadowRuntime === 'codex'
            ? (readCodexThreadId(state) || null)
            : (readPiSessionFile(state) || null)
          const shadowInputItems = shadowRuntime === 'pi'
            ? cloneTurnInputItems(batchInputItems)
            : cloneTurnInputItems(shadowResumeId ? liveInputItems : batchInputItems)
          if (!shadowInputItems.length) return

          const result = await runSelectedRuntimeTurn({
            runtimeKind: shadowRuntime,
            rootDir: root,
            repoRoot,
            workspaceRoot,
            piProvider: configuredPiProvider,
            piModel: configuredPiModel,
            piThinking: configuredPiThinking,
            prompt: '',
            inputItems: shadowInputItems,
            resumeThreadId: shadowResumeId,
            timeoutMs: config.agentMaxRuntimeMs || config.codexMaxRuntimeMs || 0,
            images: [],
          })
          const shadowCompletion = evaluateTurnCompletion(result && result.lastMessage || '', [], {
            allowContinue: true,
            allowLegacyOk: false,
            allowReplyWithoutDelivery: true,
          })
          const shadowResultRecord = {
            runtime: shadowRuntime,
            kind: Number(result && result.code || 0) === 0
              ? (shadowCompletion.kind === 'ok' ? 'ok' : 'protocol_violation')
              : 'failed',
            finishedAt: nowMs(),
            forInboundSeq: Number(uptoSeq || 0) || 0,
            processedToSeq: Number(uptoSeq || 0) || 0,
            exitCode: result && result.code == null ? null : Number(result.code),
            lastMessage: safeString(result && result.lastMessage || ''),
          }

          await withChatLock(chatKey, async () => {
            const latest = getChatCtx(pseudo)
            if (shadowRuntime === 'codex') {
              reconcileCodexThreadId(latest.state, result && result.threadId, chatKey)
            } else {
              reconcilePiSessionFile(latest.state, result && ((result as any).sessionFile || result.threadId), chatKey)
            }
            latest.state.lastShadowResult = shadowResultRecord
            latest.saveState()
          }, { op: 'shadow_turn_commit', chatKey, runtime: shadowRuntime })

          const primaryPreview = safeString(primaryResultText || '').replace(/\s+/g, ' ').slice(0, 160)
          const shadowPreview = safeString(result && result.lastMessage || '').replace(/\s+/g, ' ').slice(0, 160)
          try {
            appendJsonl(shadowRunLogPath(chatDir), {
              ts: nowMs(),
              chatKey,
              uptoSeq: Number(uptoSeq || 0) || 0,
              primaryRuntime: safeString(primaryRuntime),
              shadowRuntime,
              exitCode: result && result.code == null ? null : Number(result.code),
              completion: safeString(shadowCompletion.kind || ''),
              primaryPreview,
              shadowPreview,
            })
          } catch {}
          logger.info(`shadow compare chatKey=${chatKey} primary=${safeString(primaryRuntime)} shadow=${shadowRuntime} code=${String(result && result.code == null ? '' : result.code)} primaryPreview=${JSON.stringify(primaryPreview)} shadowPreview=${JSON.stringify(shadowPreview)}`)
        })
        .catch((e: any) => {
          logger.warn(`shadow turn failed chatKey=${chatKey} runtime=${shadowRuntimeForChat(chatKey)} err=${safeString(e && e.message ? e.message : e)}`)
        })
      shadowTurnQueues.set(chatKey, next)
      void next.finally(() => {
        if (shadowTurnQueues.get(chatKey) === next) shadowTurnQueues.delete(chatKey)
      })
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

    async function handleReset({ chatKey, resetMessageId = '' }) {
      const parsed = parseChatKey(chatKey)
      if (!parsed) return
      const pseudo = { platform: parsed.platform, channelId: parsed.chatId, guildId: null }
      const { chatDir, state, saveState } = getChatCtx(pseudo)
      let resetRecord = null as any
      try {
        if (safeString(resetMessageId || '').trim()) {
          resetRecord = findLoggedMessageById(chatDir, resetMessageId)
        }
      } catch {}
      const resetLogCutover = prepareResetLogCutover(chatDir)
      resetEphemeral(chatKey)
      try {
        const active = getActiveProcessingTurn({ chatKey, processingRunId: state.processingRunId })
        if (state.processing || state.processingPid || active) {
          const activeRuntime = normalizeRuntimeKind(
            (active && active.runtime)
            || state.processingRuntime
            || primaryRuntimeForChat(chatKey),
          )
          if (activeRuntime === 'pi' && active && typeof active.abort === 'function') {
            void Promise.resolve(active.abort()).catch(() => {})
          } else if (activeRuntime === 'codex' && active && active.threadId && active.turnId) {
            void ensureCodexAppServerSupervisor(repoRoot, workspaceRoot)
              .then((supervisor) => supervisor.interruptTurn({ threadId: active.threadId, turnId: active.turnId }))
              .catch(() => {})
          } else {
            const pid = Number(state.processingPid || 0)
            const supervisorPid = currentCodexAppServerPid()
            if (pid && (!supervisorPid || pid !== supervisorPid)) {
              try { process.kill(pid, 'SIGTERM') } catch {}
              setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 2000)
            }
          }
        }
      } catch {}

      let resetBoundarySeq = 0
      try {
        const disk = readJson(path.join(chatDir, 'state.json'), null) || {}
        const diskLastSeq = Number(disk.lastSeq || 0)
        const diskLastInbound = Number(disk.lastInboundSeq || 0)
        const memLastSeq = Number(state.lastSeq || 0)
        const memLastInbound = Number(state.lastInboundSeq || 0)
        resetBoundarySeq = Math.max(
          Number.isFinite(diskLastSeq) ? diskLastSeq : 0,
          Number.isFinite(diskLastInbound) ? diskLastInbound : 0,
          Number.isFinite(memLastSeq) ? memLastSeq : 0,
          Number.isFinite(memLastInbound) ? memLastInbound : 0,
        )
      } catch {}

      try {
        const cmdSeq = Number(state.lastResetCommandSeq || 0)
        const cmdMsgId = safeString(state.lastResetCommandMessageId || '')
        const want = safeString(resetMessageId || '')
        if (cmdSeq > 0 && cmdMsgId && want && cmdMsgId === want) resetBoundarySeq = cmdSeq
      } catch {}
      const freshBoundarySeq = Math.max(0, resetBoundarySeq - 1)

	      state.lastResetAtMs = nowMs()
	      state.lastResetSeq = freshBoundarySeq
	      state.lastThreadIngestedSeq = freshBoundarySeq
	      writeCodexThreadId(state, '')
        writePiSessionFile(state, '')
	      try { fs.rmSync(piSessionDirForChat(chatDir), { recursive: true, force: true }) } catch {}
      state.bridgeProtocolRetryCount = 0
      clearPersistentRunFlags(state, { keepPendingTrigger: false })
      state.inboundUnprocessed = 0
      state.lastInboundText = ''
      state.lastAgentInboundSeq = 0
      state.lastAgentInboundAt = 0
      state.lastAgentInboundText = ''
      state.lastAgentResult = null
      state.lastShadowResult = null
      state.lastResetResult = null
      state.lastProcessedSeq = freshBoundarySeq
      state.batchEndSeq = freshBoundarySeq
      state.replyToMessageId = ''
      saveState()

      queueBrainFinalize({ chatKey, reason: 'reset' })

      void finalizeResetLogCutover({
        chatKey,
        chatDir,
        stagingDir: resetLogCutover.stagingDir,
        historyDir: resetLogCutover.historyDir,
      }).catch(() => {})
      if (resetRecord && typeof resetRecord === 'object') {
        try {
          appendJsonl(
            path.join(chatDir, 'logs', `${isoDate((Number(resetRecord.ts || 0) || 0) * 1000 || nowMs())}.jsonl`),
            resetRecord,
          )
        } catch (e) {
          logger.warn(`reset record reappend failed chatKey=${chatKey} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
        }
      }

      const resetReplyText = safeString(uiText('commands.reset.messages.reply') || 'Understood. Starting fresh here.').trim()
      if (!resetReplyText) return

      const resetReplyToMessageId = safeString(resetMessageId || (resetRecord && resetRecord.messageId) || '')
      const markResetResult = (result: any) => {
        state.lastResetResult = normalizeLastAgentResult({
          runtime: state.processingRuntime || primaryRuntimeForChat(chatKey),
          ...result,
        })
        saveState()
      }

      try {
        await sendToChat({
          chatKey,
          parsed,
          text: resetReplyText,
          images: [],
          files: [],
          via: 'koishi-cmd',
          replyToMessageId: resetReplyToMessageId,
        })
        state.lastSystemAckAt = nowMs()
        markResetResult({
          kind: 'ok',
          finishedAt: nowMs(),
          forInboundSeq: Number(resetBoundarySeq || 0) || Number(state.lastResetCommandSeq || 0) || 0,
          processedToSeq: freshBoundarySeq,
          exitCode: 0,
          lastMessage: resetReplyText,
        })
      } catch (e) {
        logger.warn(`reset reply send failed chatKey=${chatKey} err=${safeString(e && (e as any).message ? (e as any).message : e)}`)
        markResetResult({
          kind: 'failed',
          finishedAt: nowMs(),
          forInboundSeq: Number(resetBoundarySeq || 0) || Number(state.lastResetCommandSeq || 0) || 0,
          processedToSeq: freshBoundarySeq,
          exitCode: 1,
          lastMessage: safeString(e && (e as any).message ? (e as any).message : e),
        })
      }
    }



    function canRunRestartCommand(_session, trust) {
      return trust === 'OWNER'
    }

    // Control command permissions.
    function canRunControlCommand(session, trust) {
      if (!(trust === 'OWNER' || trust === 'TRUSTED')) return false
      // Private: OWNER only (avoid social engineering).
      if (!session.guildId) return trust === 'OWNER'
      // Group: OWNER/TRUSTED.
      return true
    }

    ctx.before('command/execute', (argv: any) => {
      const commandName = safeString(argv && argv.command && argv.command.name || '')
      if (!commandName || !['help', 'reset', 'restart', 'status'].includes(commandName)) return
      const session = argv && argv.session
      if (isExplicitSlashControlCommand(session, `/${commandName}`)) return
      return ''
    }, true)

    ctx.command('help', uiText('commands.help.description')).action(async ({ session }) => {
      if (!isExplicitSlashControlCommand(session, '/help')) return ''
      const { platform, chatKey } = getChatCtx(session)
      const identity = getIdentity()
      const trust = identity.trustOf(platform, safeString(session.userId))
      if (!canRunControlCommand(session, trust)) return
      await handleHelp({ chatKey, session })
    })

    ctx.command('status', uiText('commands.status.description')).action(async ({ session }) => {
      if (!isExplicitSlashControlCommand(session, '/status')) return ''
      const { platform, chatKey } = getChatCtx(session)
      const identity = getIdentity()
      const trust = identity.trustOf(platform, safeString(session.userId))
      if (!canRunControlCommand(session, trust)) return
      await handleStatus({ chatKey })
    })

    ctx.command('reset', uiText('commands.reset.description')).action(async ({ session }) => {
      if (!isExplicitSlashControlCommand(session, '/reset')) return ''
      const { platform, chatKey } = getChatCtx(session)
      const identity = getIdentity()
      const trust = identity.trustOf(platform, safeString(session.userId))
      if (!canRunControlCommand(session, trust)) return
      // Ensure the inbound `/reset` message has a seq + is de-duped, regardless of middleware ordering.
      // (This prevents boot catch-up from "resurrecting" a pre-reset message after restart.)
      try { await handleMessageLike(session) } catch {}
      await handleReset({ chatKey, resetMessageId: safeString(session.messageId) })
    })

    ctx.command('restart', uiText('commands.restart.description')).action(async ({ session }) => {
      if (!isExplicitSlashControlCommand(session, '/restart')) return ''
      const { platform, chatKey } = getChatCtx(session)
      const identity = getIdentity()
      const trust = identity.trustOf(platform, safeString(session.userId))
      if (!canRunRestartCommand(session, trust)) return
      try { await handleMessageLike(session) } catch {}
      await handleRestart({ chatKey, restartMessageId: safeString(session.messageId) })
    })

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

    async function hydrateInboundHistoryIntoThread({
      chatKey,
      chatDir,
      state,
      saveState,
      processingRunId,
      uptoSeqExclusive,
    }: any) {
      const targetSeqExclusive = Math.max(0, Number(uptoSeqExclusive || 0) || 0)
      let hydratedThroughSeq = Math.max(0, Number(state.lastThreadIngestedSeq || 0) || 0)
      if (targetSeqExclusive <= hydratedThroughSeq + 1) {
        return { ok: true, hydratedThroughSeq, injectedCount: 0, interrupted: false }
      }

      const records = readChatLogRecordsInSeqRange(chatDir, {
        minSeqInclusive: hydratedThroughSeq + 1,
        maxSeqInclusive: targetSeqExclusive - 1,
        inboundOnly: true,
      }).filter((record) => !shouldSkipThreadHistoryRecord(record))

      let injectedCount = 0
      for (const record of records) {
        if (!isCurrentProcessingRun(state, processingRunId) || state.interruptRequested) {
          return { ok: false, hydratedThroughSeq, injectedCount, interrupted: true }
        }

        const recordSeq = Math.max(0, Number(record && record.seq || 0) || 0)
        const inputs = buildThreadHistoryInputsFromRecord(record)
        if (!inputs.length) {
          hydratedThroughSeq = Math.max(hydratedThroughSeq, recordSeq)
          state.lastThreadIngestedSeq = Math.max(Number(state.lastThreadIngestedSeq || 0), hydratedThroughSeq)
          saveState()
          continue
        }

        const result = await runCodexAppServerTurn({
          repoRoot,
          workspaceRoot,
          prompt: '',
          inputItems: inputs,
          resumeThreadId: readCodexThreadId(state) || null,
          timeoutMs: 30_000,
          runtimeTracking: {
            chatKey,
            chatDir,
            state,
            saveState,
            processingRunId,
            observedToSeq: state.batchEndSeq,
            allowInterrupt: true,
          },
          turnBehavior: {
            autoInterruptOnTurnStart: true,
            allowInterruptedSuccess: true,
          },
        })

        reconcileCodexThreadId(state, result && result.threadId, chatKey)
        if (result && result.turnStarted) {
          hydratedThroughSeq = Math.max(hydratedThroughSeq, recordSeq)
          state.lastThreadIngestedSeq = Math.max(Number(state.lastThreadIngestedSeq || 0), hydratedThroughSeq)
          saveState()
        }

        if (state.interruptRequested) {
          return { ok: false, hydratedThroughSeq, injectedCount, interrupted: true }
        }
        if (result.code !== 0) {
          logger.warn(`thread history inject failed chatKey=${chatKey} seq=${recordSeq} code=${result.code} status=${safeString(result.turnStatus || '')} stderr=${JSON.stringify((result.stderr || '').slice(0, 500))}`)
          return { ok: false, hydratedThroughSeq, injectedCount, interrupted: false }
        }

        injectedCount += 1
      }

      return { ok: true, hydratedThroughSeq, injectedCount, interrupted: false }
    }

	    function requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason }: any) {
	      if (!state || !state.processing) return
	      // Some operations (e.g. /reset thread init) must not be interrupted by new inbound work.
	      if (state.processingNoInterrupt) return

      if (!state.interruptRequested) {
        state.interruptRequested = true
        state.interruptRequestedAt = nowMs()
        // New inbound work should cancel any CONTINUE loop.
        state.forceContinue = false
        saveState()
      }

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
        if (activeRuntime === 'codex' && activeThreadId && activeTurnId) {
          logger.info(`interrupt requested chatKey=${chatKey} runtime=${activeRuntime} thread=${activeThreadId} turn=${activeTurnId} reason=${safeString(reason)}`)
          void ensureCodexAppServerSupervisor(repoRoot, workspaceRoot)
            .then((supervisor) => supervisor.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId }))
            .catch((e: any) => {
              logger.warn(`interrupt dispatch failed chatKey=${chatKey} err=${safeString(e && e.message ? e.message : e)}`)
            })
          return
        }

	      const pid = Number(state.processingPid || 0)
	      if (!Number.isFinite(pid) || pid <= 0) return

        const supervisorPid = currentCodexAppServerPid()
        if (activeRuntime === 'codex' && supervisorPid && pid === supervisorPid) {
          logger.warn(`interrupt requested but no active turn handle chatKey=${chatKey} pid=${pid} reason=${safeString(reason)}`)
          return
        }
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
        if (!disk || typeof disk !== 'object') return

        // If a new inbound message arrives while `activate()` is running, it updates state.json from
        // another call stack. `activate()` must not clobber those flags with a stale in-memory copy.

        const diskInterrupt = Boolean(disk.interruptRequested)
        if (diskInterrupt) {
          state.interruptRequested = true
          state.interruptRequestedAt = Math.max(Number(state.interruptRequestedAt || 0), Number(disk.interruptRequestedAt || 0))
        }

        const diskLastAgentInbound = Number(disk.lastAgentInboundSeq || 0)
        const diskPendingWake = Boolean(disk.pendingWake)
        const diskTrigger = disk.pendingTrigger && typeof disk.pendingTrigger === 'object' ? disk.pendingTrigger : null
        const diskTriggerSeq = diskTrigger ? Number(diskTrigger.seq || 0) : 0

        const shouldKeepTrigger = diskTrigger && (!Number.isFinite(Number(observedToSeq)) || Number(diskTriggerSeq) > Number(observedToSeq))
        if (shouldKeepTrigger) {
          state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, diskTrigger)
          state.pendingWake = true
        }

        // Extra guardrail: even if another writer forgot to set `pendingWake`, a larger
        // agent-visible inbound seq means there is still pending work after `observedToSeq`.
        if (Number.isFinite(Number(observedToSeq)) && Number.isFinite(diskLastAgentInbound)) {
          if (diskLastAgentInbound > Number(observedToSeq)) state.pendingWake = true
        } else if (diskPendingWake) {
          state.pendingWake = true
	        }
	      } catch {}
	    }
    syncConcurrentStateFromDiskRef = syncConcurrentStateFromDisk

	    async function runCodexInChatSession({ chatKey, prompt, kind, name = '' }: any) {
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
          if (state.processing) {
            state.pendingWake = true
            saveState()
            return { ok: false, error: 'chat_busy' }
          }

          state.processing = true
          state.processingNoInterrupt = false
          state.processingRuntime = runtimeKind
          state.processingPid = 0
          state.processingThreadId = ''
          state.processingTurnId = ''
          processingRunId = nodeCrypto.randomBytes(12).toString('hex')
          state.processingRunId = processingRunId
          state.processingStartedAt = nowMs()
          state.replyToMessageId = ''
          // Never allow CONTINUE loops for scheduled jobs.
          state.forceContinue = false
          // Preserve any pending triggers/wake requests; they will be processed after the job.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: null })
          saveState()
          return { ok: true }
        }, { op: 'scheduled_claim', chatKey, kind: safeString(kind), name: safeString(name) })
        if (!claim || claim.ok === false) throw new Error(claim?.error || 'chat_busy')

		        const activeHandle = runtimeKind === 'pi' ? readPiSessionFile(state) : readCodexThreadId(state)
            logger.info(`scheduled run chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} runner=${runtimeKind === 'pi' ? 'pi-sdk' : 'codex-app-server'} thread=${activeHandle || '(new)'}`)

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
		            resumeThreadId: runtimeKind === 'pi'
                  ? (readPiSessionFile(state) || null)
                  : (readCodexThreadId(state) || null),
		            timeoutMs: config.agentMaxRuntimeMs || config.codexMaxRuntimeMs || 0,
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
        const outbound = recentOutboundRecords(chatDir, {
          minTsMs: Number(state.processingStartedAt || 0) || 0,
        })
        const completion = evaluateTurnCompletion(result.lastMessage, outbound, {
          allowContinue: false,
          allowLegacyOk: false,
        })
        const post = await withChatLock(chatKey, async () => {
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: null })
          if (!isCurrentProcessingRun(state, processingRunId)) {
            logger.info(`scheduled run stale release ignored chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} runId=${processingRunId} currentRunId=${safeString(state.processingRunId || '') || '(none)'}`)
            return { shouldWake: false, interrupted: false, stale: true }
          }
          const interrupted = Boolean(state.interruptRequested)
          if (!interrupted && result.code === 0 && completion.kind === 'ok') {
            state.lastSystemAckAt = nowMs()
          } else if (interrupted) {
            logger.info(`scheduled run interrupted chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)}`)
          } else {
            logger.warn(`scheduled run failed chatKey=${chatKey} kind=${safeString(kind)} name=${safeString(name)} code=${result.code} lastMessage=${JSON.stringify(trimmed)} stderr=${JSON.stringify((result.stderr || '').slice(0, 500))}`)
          }

            if (runtimeKind === 'pi') {
              reconcilePiSessionFile(state, result && ((result as any).sessionFile || result.threadId), chatKey)
            } else {
              reconcileCodexThreadId(state, result && result.threadId, chatKey)
            }

          state.processing = false
          state.processingRuntime = ''
          state.processingPid = 0
          state.processingThreadId = ''
          state.processingTurnId = ''
          state.processingRunId = ''
          state.processingStartedAt = 0
          state.replyToMessageId = ''
          state.forceContinue = false
          state.interruptRequested = false
          state.interruptRequestedAt = 0
          const shouldWake = !isShuttingDown() && Boolean(state.pendingWake)
          saveState()
          return { shouldWake, interrupted }
        }, { op: 'scheduled_release', chatKey, kind: safeString(kind), name: safeString(name) })

        if (post && post.shouldWake) {
          scheduleActivation(chatKey, () => {
            activate(pseudo).catch((e) => logger.error(e))
          }, 0, 0)
        }

        if (post && post.interrupted) throw new Error('interrupted')
        if (result.code !== 0) throw new Error(`${runtimeKind}_failed`)
        if (completion.kind !== 'ok') {
          throw new Error(`${runtimeKind}_bad_last_message:${trimmed || '(empty)'}`)
        }
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
	      return await runCodexEphemeralTurn({ inputItems: [{ type: 'text', text: promptText }], prompt: '', kind: 'timer', name, chatKey })
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

	      return await runCodexEphemeralTurn({ inputItems: [{ type: 'text', text: promptText }], prompt: '', kind: 'inspect', name, chatKey: deliveryChatKey })
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

    async function runCodexEphemeralTurn({ prompt, inputItems = null, kind, name = '', chatKey = '' }: any) {
      const runtimeKind = runtimeForEphemeralTurn(safeString(chatKey || '').trim())
      const runnerName = runtimeKind === 'pi' ? 'pi-sdk' : 'codex-app-server'
      logger.info(`scheduled run (ephemeral) kind=${safeString(kind)} name=${safeString(name)} runner=${runnerName} thread=(new)`)
      const runStartedAtMs = nowMs()

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
        timeoutMs: config.agentMaxRuntimeMs || config.codexMaxRuntimeMs || 0,
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
        const normalized = normalizeFinalAgentMessage(result.lastMessage || '')
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
      const outbound = chatDir
        ? recentOutboundRecords(chatDir, { minTsMs: runStartedAtMs })
        : []
      const completion = evaluateTurnCompletion(result.lastMessage, outbound, {
        allowContinue: false,
        allowLegacyOk: false,
        allowReplyWithoutDelivery: !safeString(chatKey || '').trim(),
      })
      if (result.code !== 0) throw new Error(`${runtimeKind}_failed:code=${String(result.code)}`)
      if (completion.kind !== 'ok') {
        throw new Error(`${runtimeKind}_bad_last_message:${trimmed || '(empty)'}`)
      }
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
	          if (state.processing) {
	            state.pendingWake = true
	            saveState()
            return { ok: false }
          }

          const pendingTrigger = state.pendingTrigger && typeof state.pendingTrigger === 'object' ? state.pendingTrigger : null
          const resetPendingTrigger = state.resetPendingTrigger && typeof state.resetPendingTrigger === 'object'
            ? state.resetPendingTrigger
            : null
          const claimedTrigger = resetPendingTrigger || pendingTrigger
          const triggerSeq = Number(claimedTrigger && claimedTrigger.seq || 0) || 0
          fromSeq = (state.lastProcessedSeq || 0) + 1
          toSeq = triggerSeq > 0 ? triggerSeq : (state.lastAgentInboundSeq || 0)
          const allowEmpty = Boolean(state.forceContinue)
          if (toSeq < fromSeq && !allowEmpty) return { ok: false }

          state.processing = true
          state.processingNoInterrupt = Boolean(claimedTrigger && (claimedTrigger as any).processingNoInterrupt)
          state.processingRuntime = primaryRuntime
          state.processingPid = 0
          state.processingThreadId = ''
          state.processingTurnId = ''
	          processingRunId = nodeCrypto.randomBytes(12).toString('hex')
	          state.processingRunId = processingRunId
          runStartedAtMs = nowMs()
	          state.processingStartedAt = runStartedAtMs
	          state.batchEndSeq = toSeq
	          trigger = claimedTrigger
	          state.interruptRequested = false
	          state.interruptRequestedAt = 0
          const pendingTriggerSeq = Number(pendingTrigger && pendingTrigger.seq || 0) || 0
          const keepQueuedPending = Boolean(
            resetPendingTrigger
            && pendingTrigger
            && pendingTriggerSeq > triggerSeq,
          )
	          state.pendingWake = keepQueuedPending
          if (resetPendingTrigger) {
            state.resetPendingTrigger = null
          }
	          state.pendingTrigger = keepQueuedPending ? pendingTrigger : null
          state.replyToMessageId = safeString(trigger?.messageId || '')
          // If a new trigger arrived between the state snapshot above and this state write,
          // preserve it (and any interrupt request) instead of wiping it.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: toSeq })
          saveState()
          return { ok: true }
        }, { op: 'activate_claim', chatKey })
        if (!claim || claim.ok === false) return

	        if (primaryRuntime === 'codex') {
	          const historyHydration = await hydrateInboundHistoryIntoThread({
            chatKey,
            chatDir,
            state,
            saveState,
            processingRunId,
            uptoSeqExclusive: toSeq,
          })
          if (historyHydration && historyHydration.interrupted) {
          logger.info(`activate history hydration interrupted chatKey=${chatKey} hydratedThrough=${Number(historyHydration.hydratedThroughSeq || 0) || 0} targetExclusive=${toSeq}`)
          const post = await withChatLock(chatKey, async () => {
            syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: state.batchEndSeq })
            if (!isCurrentProcessingRun(state, processingRunId)) return { action: 'stale' }
            state.forceContinue = false
            state.processing = false
            state.processingRuntime = ''
            state.processingPid = 0
            state.processingThreadId = ''
            state.processingTurnId = ''
            state.processingRunId = ''
            state.processingStartedAt = 0
            state.replyToMessageId = ''
            state.interruptRequested = false
            state.interruptRequestedAt = 0
            const action = isShuttingDown()
              ? 'shutdown'
              : state.pendingWake
                ? 'wake'
                : 'done'
            saveState()
            return { action }
          }, { op: 'activate_history_abort', chatKey })

          if (!post) return
          if (post.action === 'shutdown' || post.action === 'stale') return
	          if (post.action === 'wake') {
	            scheduleActivation(chatKey, () => {
	              activate(session).catch((e) => logger.error(e))
	            }, 0, 0)
		          }
		          return
		        }
          }
	        const activeThreadId = primaryRuntime === 'codex'
            ? readCodexThreadId(state)
            : readPiSessionFile(state)
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
        const batchedRecords = readChatLogRecordsInSeqRange(chatDir, {
          minSeqInclusive: fromSeq,
          maxSeqInclusive: toSeq,
          inboundOnly: true,
        })
        const batchInputItems = buildBatchInputItemsFromRecords(batchedRecords, {
          maxImages: 6,
        })
	        const runnerName = primaryRuntime === 'pi' ? 'pi-sdk' : 'codex-app-server'
	        logger.info(`activate chatKey=${chatKey} seq=${fromSeq}..${toSeq} runner=${runnerName} thread=${activeThreadId || '(new)'}`)

	        const { result, trimmed, completion, protocolViolation } = await runBridgeReplyTurn({
          runtimeKind: primaryRuntime,
          parsed: { platform, chatId },
          chatKey,
          chatDir,
          state,
          saveState,
          processingRunId,
          observedToSeq: state.batchEndSeq,
          allowInterrupt: true,
          prompt: '',
	          inputItems: primaryRuntime === 'pi' ? batchInputItems : liveInputItems,
	          resumeThreadId: primaryRuntime === 'pi'
              ? (readPiSessionFile(state) || null)
              : (readCodexThreadId(state) || null),
          timeoutMs: config.agentMaxRuntimeMs || config.codexMaxRuntimeMs || 0,
          replyToMessageId: safeString(currentRecord && currentRecord.messageId || trigger?.messageId || ''),
          recentOutboundMinSeqExclusive: toSeq,
          recentOutboundMinTsMs: runStartedAtMs || 0,
          allowContinue: true,
          allowLegacyOk: false,
        })
        const post = await withChatLock(chatKey, async () => {
          // Pick up concurrent interrupt requests / pending triggers that happened during the run.
          syncConcurrentStateFromDisk({ chatDir, state, observedToSeq: state.batchEndSeq })
          if (!isCurrentProcessingRun(state, processingRunId)) {
            logger.info(`activate stale release ignored chatKey=${chatKey} seq=${fromSeq}..${toSeq} runId=${processingRunId} currentRunId=${safeString(state.processingRunId || '') || '(none)'}`)
            return { action: 'stale' }
          }

	          if (primaryRuntime === 'codex') {
	            reconcileCodexThreadId(state, result && result.threadId, chatKey)
	          } else {
              reconcilePiSessionFile(state, result && ((result as any).sessionFile || result.threadId), chatKey)
            }
	          if (primaryRuntime === 'codex' && result && result.turnStarted) {
	            state.lastThreadIngestedSeq = Math.max(
	              Number(state.lastThreadIngestedSeq || 0),
	              Number(state.batchEndSeq || 0) || 0,
            )
          }

          const interrupted = Boolean(state.interruptRequested)
          const finishedAt = nowMs()
          const resultKind = !interrupted && result.code === 0 && completion.kind === 'ok'
            ? 'ok'
            : !interrupted && protocolViolation
              ? 'protocol_violation'
              : interrupted
                ? 'interrupted'
                : 'failed'
          const lastAgentResultRecord = {
            runtime: primaryRuntime,
            kind: resultKind,
            finishedAt,
            forInboundSeq: Number(toSeq || state.batchEndSeq || 0) || 0,
            processedToSeq: Number(state.batchEndSeq || 0) || 0,
            exitCode: result.code == null ? null : Number(result.code),
            lastMessage: trimmed,
          }
          state.lastAgentResult = lastAgentResultRecord
          const resetCommandSeq = Number(state.lastResetCommandSeq || 0) || 0
          const coversResetCommand = resetCommandSeq > 0
            && Number(fromSeq || 0) <= resetCommandSeq
            && Number(toSeq || state.batchEndSeq || 0) >= resetCommandSeq
          if (coversResetCommand) state.lastResetResult = { ...lastAgentResultRecord }
          if (!interrupted && result.code === 0 && completion.kind === 'ok') {
            state.lastProcessedSeq = state.batchEndSeq
            state.forceContinue = false
            state.inboundUnprocessed = 0
            state.bridgeProtocolRetryCount = 0
            logger.info(`${runnerName} reply chatKey=${chatKey} processedTo=${state.lastProcessedSeq}`)
          } else if (!interrupted && protocolViolation && Number(state.bridgeProtocolRetryCount || 0) < 2) {
            state.forceContinue = false
            state.bridgeProtocolRetryCount = Number(state.bridgeProtocolRetryCount || 0) + 1
            state.pendingWake = true
            state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, trigger)
            logger.warn(`${runnerName} protocol violation chatKey=${chatKey} retry=${state.bridgeProtocolRetryCount} lastMessage=${JSON.stringify(trimmed)}`)
          } else if (!interrupted && protocolViolation) {
            state.forceContinue = false
            state.bridgeProtocolRetryCount = 0
            logger.warn(`${runnerName} protocol violation exhausted chatKey=${chatKey} lastMessage=${JSON.stringify(trimmed)}`)
          } else if (interrupted) {
            state.forceContinue = false
            state.bridgeProtocolRetryCount = 0
            logger.info(`${runnerName} interrupted chatKey=${chatKey} processedTo=${state.lastProcessedSeq || 0} batchEnd=${state.batchEndSeq}`)
          } else {
            state.forceContinue = false
            state.bridgeProtocolRetryCount = 0
            logger.warn(`${runnerName} failed chatKey=${chatKey} code=${result.code} lastMessage=${JSON.stringify(trimmed)} stderr=${JSON.stringify((result.stderr || '').slice(0, 500))}`)
          }

          state.processing = false
          state.processingRuntime = ''
          state.processingPid = 0
          state.processingThreadId = ''
          state.processingTurnId = ''
          state.processingRunId = ''
          state.processingStartedAt = 0
          state.replyToMessageId = ''
          state.interruptRequested = false
          state.interruptRequestedAt = 0

          const action = isShuttingDown()
            ? 'shutdown'
            : state.forceContinue
              ? 'continue'
              : state.pendingWake
                ? 'wake'
                : 'done'
          saveState()
          return { action }
        }, { op: 'activate_release', chatKey })

	        if (!post) return
	        if (post.action === 'shutdown') return
	        if (post.action === 'stale') return
          queueShadowBridgeTurn({
            chatKey,
            parsed: { platform, chatId },
            uptoSeq: toSeq,
            liveInputItems,
            batchInputItems,
            primaryRuntime,
            primaryResultText: result && result.lastMessage || '',
          })
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
      const userId = safeString(session.userId)
      const trust = identity.trustOf(platform, userId)
      const inboundText = getInboundText(session)

      const commandLike = extractCommandLikeText(inboundText)
      const slash = isSlashCommandText(inboundText)
      const isPrivilegedCommand = !!slash && canRunControlCommand(session, trust)

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

      if (!isPrivilegedCommand && agentVisible) {
        state.lastAgentInboundSeq = Number(record.seq || 0) || 0
        state.lastAgentInboundAt = Number(ts || 0) || 0
        state.lastAgentInboundText = safeString(record.text || '')
        saveState()
      }

	      // Don't wake Codex for privileged control commands; Koishi command handlers will respond.
	      if (isPrivilegedCommand) {
          // Persist reset boundary info ASAP so `/reset` can be slow without swallowing messages
          // that arrive after the reset command.
          if (slash === '/reset') {
            state.lastResetCommandSeq = record.seq
            state.lastResetCommandMessageId = record.messageId
            state.lastResetCommandAtMs = nowMs()
            saveState()
          }
          return
        }
        state.inboundUnprocessed = Number(state.inboundUnprocessed || 0) + 1
        saveState()
      // (No persistent "last inbound" metadata; keep state minimal.)

      const makeTrigger = (opts: { isMentioned?: boolean, chatType?: string } = {}) => ({
        seq: record.seq,
        ts: record.ts,
        messageId: record.messageId,
        content: record.text,
        senderUserId: userId,
        senderName: record.sender?.name || '',
        isMentioned: Boolean(opts.isMentioned),
        chatType: safeString(opts.chatType || effectiveChatType || record.chatType || ''),
        replyToMessageId: safeString(replyMeta.replyToMessageId || ''),
        quotedText: safeString(replyMeta.quotedText || ''),
        quotedSenderUserId: safeString(replyMeta.quotedSenderUserId || ''),
        quotedSenderName: safeString(replyMeta.quotedSenderName || ''),
      })

	      const markTriggerAndActivate = (trigger, delayMs, maxDelayMs) => {
	        state.pendingWake = true
	        state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, trigger)
	        saveState()
	        if (shuttingDown) return
        if (state.processing) {
          requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason: 'new_trigger' })
          return
        }
        scheduleActivation(chatKey, () => {
          activate(session).catch((e) => logger.error(e))
        }, delayMs, maxDelayMs)
      }

	      // Gate rules
	      if (effectiveChatType === 'private' && agentVisible) {
	        markTriggerAndActivate(makeTrigger({ isMentioned: mentionLike, chatType: effectiveChatType }), config.ownerDebounceMs, config.ownerDebounceMaxMs)
	      } else if (effectiveChatType === 'group' && agentVisible) {
	        // Always record the trigger, but only activate after we have enough group context.
	        state.pendingWake = true
	        state.pendingTrigger = mergePendingTrigger(state.pendingTrigger, makeTrigger({ isMentioned: true, chatType: effectiveChatType }))
	        saveState()
	        if (shuttingDown) return
          if (state.processing) {
            requestInterruptIfProcessing({ chatKey, chatDir, state, saveState, reason: 'new_trigger' })
            return
          }
          // Mentions from OWNER/TRUSTED are explicit; respond immediately (no startup silence / context gate).
          scheduleActivation(chatKey, () => {
            activate(session).catch((e) => logger.error(e))
          }, config.mentionedDebounceMs, config.mentionedDebounceMs)
	      } else {
          if (effectiveChatType === 'group') {
            const pending = state.pendingTrigger && typeof state.pendingTrigger === 'object' ? state.pendingTrigger : null
            if (pending && pending.isMentioned && state.pendingWake && !state.processing) {
              // If a mention trigger is pending, keep trying to activate (debounced).
	              scheduleActivation(chatKey, () => {
                activate(session).catch((e) => logger.error(e))
              }, config.mentionedDebounceMs, config.mentionedDebounceMs)
            }
          }
	      }
	    }

    // Run before Koishi command middleware, so slash-prefixed traffic and Telegram command-shaped
    // messages are still logged + can trigger activation.
    ctx.middleware(async (session, next) => {
      disableBareDirectCommandSuggest(session)
      // Some adapters dispatch `message-created` or `interaction/command`; treat them as inbound
      // message-like events for logging + gate.
      if (session.type === 'message' || session.type === 'message-created' || session.type === 'interaction/command') {
        await handleMessageLike(session)
      }
      return next()
    }, true)

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
                  const lastSeq = Number(st.lastAgentInboundSeq || 0)
                  const lastProcessed = Number(st.lastProcessedSeq || 0)
                  const resetSeq = Number(st.lastResetSeq || 0)
                  const effectiveProcessed = Math.max(
                    Number.isFinite(lastProcessed) ? lastProcessed : 0,
                    Number.isFinite(resetSeq) ? resetSeq : 0,
                  )
                  const hasUnprocessed = Number.isFinite(lastSeq) && Number.isFinite(effectiveProcessed) && lastSeq > effectiveProcessed
                  const keepForceContinue = Boolean(st.forceContinue) || !hasUnprocessed
                  await withChatLock(chatKey, async () => {
                    const parsed = parseChatKey(chatKey)
                    if (!parsed) return
                    const pseudo0 = pseudoSessionFromParsed(parsed, '')
                    const { state, saveState } = getChatCtx(pseudo0)
                    resetEphemeral(chatKey)
                    clearPersistentRunFlags(state, { keepPendingTrigger: true, keepResetPending: true })
                    state.pendingWake = true
                    if (keepForceContinue) state.forceContinue = true
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
	                const lastSeq = Number(st.lastAgentInboundSeq || 0)
	                const lastProcessed = Number(st.lastProcessedSeq || 0)
                  const resetSeq = Number(st.lastResetSeq || 0)
                  const effectiveProcessed = Math.max(
                    Number.isFinite(lastProcessed) ? lastProcessed : 0,
                    Number.isFinite(resetSeq) ? resetSeq : 0,
                  )
	                const hasUnprocessed = Number.isFinite(lastSeq) && Number.isFinite(effectiveProcessed) && lastSeq > effectiveProcessed
                  const pending = st.pendingTrigger && typeof st.pendingTrigger === 'object' ? st.pendingTrigger : null
                  const hasResumeWork = hasUnprocessed || Boolean(st.processing) || Boolean(st.pendingWake) || Boolean(st.forceContinue) || Boolean(pending)
	                if (!hasResumeWork) continue
                  let isGroup = true
                  try {
                    if (platform === 'onebot') isGroup = !String(chatId).startsWith('private:')
                    else if (platform === 'telegram') {
                      const n = Number(chatId)
                      isGroup = Number.isFinite(n) ? n < 0 : true
                    }
                  } catch {}

                  const shouldCatchUp = !isGroup
                    ? true
                    : Boolean(st.processing) ||
                      Boolean(st.pendingWake) ||
                      Boolean(st.forceContinue) ||
                      Boolean(pending && (pending as any).isMentioned)

                  if (!shouldCatchUp) continue
	                const chatKey = safeString(st.chatKey || composeRuntimeChatKey(platform, chatId, botId))
	                const lastText = safeString(st?.pendingTrigger?.content || st?.lastAgentInboundText || '')
	                catchUp.set(chatKey, lastText)
                }
	          } catch {}

	          if (!catchUp.size) return

	          const chatKeys = Array.from(catchUp.keys()).filter(Boolean)
	          logger.info(`boot catch-up chatKeys=${JSON.stringify(chatKeys)}`)
	          for (const chatKey of chatKeys) {
	            const parsed = parseChatKey(chatKey)
	            if (!parsed) continue
	            if (!findBot(parsed.platform, parsed.botId)) continue

	            // On boot, clear stale resume flags so we don't "recover twice".
	            try {
		              await withChatLock(chatKey, async () => {
		                const pseudo0 = pseudoSessionFromParsed(parsed, '')
		                const { chatDir, state, saveState } = getChatCtx(pseudo0)
	                    resetEphemeral(chatKey)
	                    const keepForceContinue = Boolean(state.forceContinue)
	                    writeCodexThreadId(state, '')
                      writePiSessionFile(state, '')
                      try { fs.rmSync(piSessionDirForChat(chatDir), { recursive: true, force: true }) } catch {}
	                    state.lastThreadIngestedSeq = Math.max(0, Number(state.lastResetSeq || 0) || 0)
                    const resetSeq = Number(state.lastResetSeq || 0)
                    if (Number.isFinite(resetSeq) && resetSeq > 0) {
                      const processed = Number(state.lastProcessedSeq || 0)
                      if (!Number.isFinite(processed) || processed < resetSeq) state.lastProcessedSeq = resetSeq
                    }
                    clearPersistentRunFlags(state, { keepPendingTrigger: true, keepResetPending: true })
                    if (keepForceContinue) state.forceContinue = true
	                saveState()
	              }, { op: 'boot_cleanup', chatKey })
	            } catch {}

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
        try {
          if (codexAppServerSupervisor && typeof codexAppServerSupervisor.forceRestart === 'function') {
            codexAppServerSupervisor.forceRestart('daemon_dispose')
          }
        } catch {}
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
        help: { description: 'Show help' },
        status: { description: 'Show current chat status' },
        reset: {
          description: 'Start fresh',
          messages: {
            reply: 'Understood. Starting fresh here.',
            agentPrompt: 'The owner has used /reset. Send a brief, natural message in plain English that marks a fresh start, without mentioning technical details like "reset", "context", or "logs".'
          },
        },
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
    provider: configString(settings.defaultProvider, 'openai-codex'),
    model: configString(settings.defaultModel, 'gpt-5.4'),
    thinking: configString(settings.defaultThinkingLevel, ''),
  })

  return app
}

async function main() {
  if (!process.env.TMPDIR) {
    // Some environments don't set it; Koishi/codex runner uses it for transient files.
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
