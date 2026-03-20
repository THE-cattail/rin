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

function pluginBaseName(name: string) {
  return safeString(name).replace(/^~/, '').split(':', 1)[0]
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

function sanitizeAdapterName(value: any, fallback: string) {
  const raw = safeString(value).trim().replace(/[^A-Za-z0-9._-]+/g, '-')
  return raw || fallback
}

function looksLikeSingleAdapterConfig(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (!keys.length) return true
  const singleConfigKeys = new Set([
    'name',
    'enabled',
    'endpoint',
    'selfId',
    'token',
    'protocol',
    'slash',
    'owners',
    'ownerUserIds',
    'botId',
  ])
  return keys.some((key) => singleConfigKeys.has(key))
}

function normalizeAdapterEntries(value: any, defaults: Record<string, any>, fallbackPrefix: string) {
  const rawEntries: Array<{ name: string, config: Record<string, any> }> = []

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
      rawEntries.push({
        name: sanitizeAdapterName((entry as any).name, `${fallbackPrefix}-${index + 1}`),
        config: JSON.parse(JSON.stringify(entry)),
      })
    })
  } else if (looksLikeSingleAdapterConfig(value)) {
    rawEntries.push({
      name: sanitizeAdapterName(value && value.name, fallbackPrefix),
      config: value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {},
    })
  } else if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      rawEntries.push({
        name: sanitizeAdapterName((entry as any).name || name, safeString(name) || fallbackPrefix),
        config: JSON.parse(JSON.stringify(entry)),
      })
    }
  }

  return rawEntries
    .filter((entry) => entry.config.enabled !== false)
    .map((entry) => {
      const config = normalizeKoishiAdapterConfig(entry.config, defaults)
      delete (config as any).name
      delete (config as any).owners
      delete (config as any).ownerUserIds
      delete (config as any).botId
      return { name: entry.name, config }
    })
}

function applyAdapterPlugins(plugins: Record<string, any>, baseName: string, value: any, defaults: Record<string, any>, fallbackPrefix: string) {
  const entries = normalizeAdapterEntries(value, defaults, fallbackPrefix)
  if (!entries.length) return
  entries.forEach((entry, index) => {
    const key = index === 0 ? baseName : `${baseName}:${entry.name || index + 1}`
    plugins[key] = entry.config
  })
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
  applyAdapterPlugins(next.plugins, 'adapter-onebot', koishi && koishi.onebot, {
    protocol: 'ws',
    endpoint: '',
    selfId: '',
    token: '',
  }, 'onebot')
  applyAdapterPlugins(next.plugins, 'adapter-telegram', koishi && koishi.telegram, {
    protocol: 'polling',
    token: '',
    slash: true,
  }, 'telegram')

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
    if (pluginBaseName(String(key)) === name) return value
  }
  return null
}

function findPluginConfigs(plugins: any, name: string) {
  if (!plugins || typeof plugins !== 'object') return []
  return Object.entries(plugins)
    .filter(([key]) => pluginBaseName(String(key)) === name)
    .map(([key, value]) => ({ key: String(key), value }))
}

function composeChatKey(platform: string, chatId: string, botId = '') {
  const nextPlatform = safeString(platform).trim()
  const nextChatId = safeString(chatId).trim()
  const nextBotId = safeString(botId).trim()
  if (!nextPlatform || !nextChatId) return ''
  return nextBotId ? `${nextPlatform}/${nextBotId}:${nextChatId}` : `${nextPlatform}:${nextChatId}`
}

function parseChatKey(chatKey: string) {
  const match = safeString(chatKey).trim().match(/^([^/:]+)(?:\/([^:]+))?:(.+)$/)
  if (!match) return null
  const [, platform, botId = '', chatId] = match
  if (!platform || !chatId) return null
  return { platform, botId, chatId }
}

function listChatStateFiles(chatsRoot: string) {
  const out: Array<{ platform: string, botId?: string, chatId: string, statePath: string }> = []
  try {
    const platforms = fs.readdirSync(chatsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const platform of platforms) {
      const platformDir = path.join(chatsRoot, platform)
      const levelOne = fs.readdirSync(platformDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      for (const first of levelOne) {
        const firstDir = path.join(platformDir, first)
        const directStatePath = path.join(firstDir, 'state.json')
        if (fs.existsSync(directStatePath)) {
          out.push({ platform, chatId: first, statePath: directStatePath })
          continue
        }
        const levelTwo = fs.readdirSync(firstDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        for (const chatId of levelTwo) {
          const statePath = path.join(firstDir, chatId, 'state.json')
          if (fs.existsSync(statePath)) out.push({ platform, botId: first, chatId, statePath })
        }
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
    const botId = safeString(a.botId || a.selfId)
    if (!platform || !userId) continue
    const chatId = platform === 'onebot' ? `private:${userId}` : userId
    out.push(composeChatKey(platform, chatId, botId))
  }
  return Array.from(new Set(out.filter(Boolean)))
}

function preferredOwnerChatKey(dataDir: string) {
  const uniq = ownerChatKeysFromIdentity(dataDir)
  return uniq.find((k) => k.startsWith('onebot/'))
    || uniq.find((k) => k.startsWith('onebot:private:'))
    || uniq.find((k) => k.startsWith('telegram/'))
    || uniq.find((k) => k.startsWith('telegram:'))
    || uniq[0]
    || ''
}

function findBot(app: any, platform: string, botId = '') {
  const bots = (app && app.bots) ? app.bots : []
  const nextPlatform = safeString(platform).trim()
  const nextBotId = safeString(botId).trim()
  if (!nextPlatform) return null
  const matches = bots.filter((bot: any) => bot && bot.platform === nextPlatform)
  if (!matches.length) return null
  if (!nextBotId) return matches[0]
  return matches.find((bot: any) => safeString(bot && bot.selfId).trim() === nextBotId) || null
}

async function sendTextToChatKey(app: any, chatKey: string, text: string) {
  const parsed = parseChatKey(chatKey)
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`)
  const bot = findBot(app, parsed.platform, parsed.botId)
  if (!bot) throw new Error(`no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ''}`)
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
  findPluginConfigs,
  composeChatKey,
  parseChatKey,
  listChatStateFiles,
  ownerChatKeysFromIdentity,
  preferredOwnerChatKey,
  findBot,
  sendTextToOwners,
}
