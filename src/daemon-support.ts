// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'

const yaml = require('js-yaml') as {
  dump(value: any, options?: any): string
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function safeString(value: unknown): string {
  if (value == null) return ''
  return String(value)
}

function normalizeKoishiAdapterConfig(value: any, defaults: Record<string, any> = {}) {
  const current = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {}
  return { ...defaults, ...current }
}

function loadDaemonHomeSettings(settingsPath: string) {
  const current = readJson(settingsPath, {}) || {}
  const next = current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {}
  if (next.enableSkillCommands == null) next.enableSkillCommands = true
  return next
}

function buildDaemonConfigFromSettings(settings: any) {
  const next = {
    name: 'rin',
    prefix: ['/'],
    prefixMode: 'strict',
    plugins: {
      'proxy-agent': {},
      http: {},
    },
  }

  const koishi = settings && typeof settings.koishi === 'object' ? settings.koishi : {}
  const onebot = koishi && typeof koishi.onebot === 'object' ? koishi.onebot : null
  const telegram = koishi && typeof koishi.telegram === 'object' ? koishi.telegram : null

  if (onebot && onebot.enabled !== false) {
    next.plugins['adapter-onebot'] = normalizeKoishiAdapterConfig(onebot, {
      protocol: 'ws',
      endpoint: '',
      selfId: '',
      token: '',
    })
  }
  if (telegram && telegram.enabled !== false) {
    next.plugins['adapter-telegram'] = normalizeKoishiAdapterConfig(telegram, {
      protocol: 'polling',
      token: '',
      slash: true,
    })
  }

  return next
}

function materializeDaemonConfig(configPath: string, settings: any) {
  ensureDir(path.dirname(configPath))
  const config = buildDaemonConfigFromSettings(settings)
  fs.writeFileSync(configPath, yaml.dump(config, { noRefs: true, lineWidth: 120 }), 'utf8')
  return { configPath, config }
}

function findPluginConfig(plugins: any, name: string) {
  if (!plugins || typeof plugins !== 'object') return null
  for (const [key, value] of Object.entries(plugins)) {
    const base = String(key).replace(/^~/, '').split(':', 1)[0]
    if (base === name) return value
  }
  return null
}

function parseChatKey(chatKey: string) {
  const sep = safeString(chatKey).indexOf(':')
  if (sep <= 0) return null
  return { platform: safeString(chatKey).slice(0, sep), chatId: safeString(chatKey).slice(sep + 1) }
}

function listChatStateFiles(chatsRoot: string) {
  const out: Array<{ platform: string, chatId: string, statePath: string }> = []
  try {
    const platforms = fs.readdirSync(chatsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const platform of platforms) {
      const pdir = path.join(chatsRoot, platform)
      const chats = fs.readdirSync(pdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      for (const chatId of chats) {
        const statePath = path.join(pdir, chatId, 'state.json')
        if (fs.existsSync(statePath)) out.push({ platform, chatId, statePath })
      }
    }
  } catch {}
  return out
}

function ownerChatKeysFromIdentity(dataDir: string) {
  const identityPath = path.join(dataDir, 'identity.json')
  const identity = readJson<any>(identityPath, { aliases: [] })
  const aliases = Array.isArray(identity.aliases) ? identity.aliases : []
  const out: string[] = []
  for (const a of aliases) {
    if (!a || a.personId !== 'owner') continue
    const platform = safeString(a.platform)
    const userId = safeString(a.userId)
    if (!platform || !userId) continue
    const chatId = platform === 'onebot' ? `private:${userId}` : userId
    out.push(`${platform}:${chatId}`)
  }
  return Array.from(new Set(out))
}

function preferredOwnerChatKey(dataDir: string) {
  const uniq = ownerChatKeysFromIdentity(dataDir)
  return uniq.find((k) => k.startsWith('onebot:private:'))
    || uniq.find((k) => k.startsWith('telegram:'))
    || uniq[0]
    || ''
}

function findBot(app: any, platform: string) {
  const bots = (app && app.bots) ? app.bots : []
  for (const bot of bots) {
    if (bot && bot.platform === platform) return bot
  }
  return null
}

async function sendTextToChatKey(app: any, chatKey: string, text: string) {
  const parsed = parseChatKey(chatKey)
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`)
  const bot = findBot(app, parsed.platform)
  if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}`)
  await bot.sendMessage(parsed.chatId, safeString(text))
}

async function sendTextToOwners(app: any, dataDir: string, { text, timeoutMs }: { text: string, timeoutMs?: number }) {
  const ownerChatKeys = ownerChatKeysFromIdentity(dataDir)
  if (!ownerChatKeys.length) return { ok: true, skipped: true }
  if (!app) return { ok: false, error: 'koishi_app_not_ready' }

  const perChatTimeoutMs = Math.max(1000, Math.floor(Number(timeoutMs || 12_000) / ownerChatKeys.length))
  const errors: Array<{ chatKey: string, error: string }> = []

  for (const chatKey of ownerChatKeys) {
    try {
      await Promise.race([
        sendTextToChatKey(app, chatKey, text),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('send_timeout')), perChatTimeoutMs)),
      ])
    } catch (error: any) {
      errors.push({ chatKey, error: safeString(error && error.message ? error.message : error) })
    }
  }

  return { ok: errors.length === 0, errors }
}

export {
  normalizeKoishiAdapterConfig,
  loadDaemonHomeSettings,
  buildDaemonConfigFromSettings,
  materializeDaemonConfig,
  findPluginConfig,
  parseChatKey,
  listChatStateFiles,
  ownerChatKeysFromIdentity,
  preferredOwnerChatKey,
  findBot,
  sendTextToOwners,
}
