const DEFAULT_CONFIG = {
  version: 3,
  defaultProviders: ['searxng'],
  cacheTtlSeconds: 6 * 60 * 60,
  http: {
    userAgent: 'Rin web search/2.0',
  },
  searxng: {
    baseUrl: 'http://127.0.0.1:18080',
    apiKey: '',
    timeoutMs: 8_000,
    autoStart: true,
    hostPort: 18080,
    dockerImage: 'ghcr.io/searxng/searxng:latest',
    containerName: 'rin-searxng',
    healthTimeoutMs: 5_000,
    startTimeoutMs: 90_000,
    defaultEngines: ['google'],
    categories: ['general'],
  },
  serper: {
    apiKey: '',
    endpoint: 'https://google.serper.dev/search',
    gl: 'us',
    hl: 'en',
    num: 8,
    timeoutMs: 12_000,
    maxFallbacksPerHour: 60,
  },
}

function safeString(v: unknown): string {
  if (v == null) return ''
  return String(v)
}

function nonEmpty(v: unknown): string {
  const s = safeString(v).trim()
  return s || ''
}

function toPositiveInt(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function normalizeProviderList(value: unknown, fallback: string[] = []): string[] {
  const items = Array.isArray(value)
    ? value
    : safeString(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const out: string[] = []
  for (const item of items) {
    const next = safeString(item).trim().toLowerCase()
    if (!next) continue
    if (!['searxng', 'serper'].includes(next)) continue
    if (!out.includes(next)) out.push(next)
  }
  return out.length ? out : fallback.slice()
}

function normalizeStringList(value: unknown, fallback: string[] = []): string[] {
  const items = Array.isArray(value)
    ? value
    : safeString(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const out: string[] = []
  for (const item of items) {
    const next = safeString(item).trim()
    if (!next) continue
    if (!out.includes(next)) out.push(next)
  }
  return out.length ? out : fallback.slice()
}

function normalizeBaseUrl(value: unknown): string {
  let s = nonEmpty(value)
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    return u.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function mergeConfig(base: any, overlay: any) {
  const next = deepClone(base)
  const src = overlay && typeof overlay === 'object' ? overlay : {}
  for (const [key, value] of Object.entries(src)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
      next[key] = mergeConfig(next[key], value)
    } else {
      next[key] = deepClone(value)
    }
  }
  return next
}

function managedBaseUrl(config: any): string {
  const port = toPositiveInt(config && config.searxng && config.searxng.hostPort, DEFAULT_CONFIG.searxng.hostPort)
  return `http://127.0.0.1:${port}`
}

function normalizeConfigShape(config: any) {
  const raw = config && typeof config === 'object' ? config : {}
  const next = mergeConfig(DEFAULT_CONFIG, raw)
  const rawVersion = toPositiveInt(raw.version, 0)
  const rawDefaultProviders = normalizeProviderList(raw.defaultProviders, [])
  const usingLegacyDefaultProviders = rawDefaultProviders.length === 2 && rawDefaultProviders[0] === 'searxng' && rawDefaultProviders[1] === 'serper'
  next.version = DEFAULT_CONFIG.version
  next.defaultProviders = normalizeProviderList(next.defaultProviders, DEFAULT_CONFIG.defaultProviders)
  if (rawVersion > 0 && rawVersion < DEFAULT_CONFIG.version && usingLegacyDefaultProviders) {
    next.defaultProviders = DEFAULT_CONFIG.defaultProviders.slice()
  }
  next.cacheTtlSeconds = Math.max(60, toPositiveInt(next.cacheTtlSeconds, DEFAULT_CONFIG.cacheTtlSeconds))
  if (rawVersion > 0 && rawVersion < DEFAULT_CONFIG.version && safeString(next.http && next.http.userAgent).trim() === 'Rin web-search skill/1.0') {
    next.http.userAgent = DEFAULT_CONFIG.http.userAgent
  }
  next.searxng.baseUrl = normalizeBaseUrl(next.searxng.baseUrl || managedBaseUrl(next)) || managedBaseUrl(next)
  next.searxng.hostPort = toPositiveInt(next.searxng.hostPort, DEFAULT_CONFIG.searxng.hostPort)
  next.searxng.timeoutMs = toPositiveInt(next.searxng.timeoutMs, DEFAULT_CONFIG.searxng.timeoutMs)
  next.searxng.healthTimeoutMs = toPositiveInt(next.searxng.healthTimeoutMs, DEFAULT_CONFIG.searxng.healthTimeoutMs)
  if (rawVersion > 0 && rawVersion < DEFAULT_CONFIG.version && next.searxng.healthTimeoutMs === 2500) {
    next.searxng.healthTimeoutMs = DEFAULT_CONFIG.searxng.healthTimeoutMs
  }
  next.searxng.startTimeoutMs = toPositiveInt(next.searxng.startTimeoutMs, DEFAULT_CONFIG.searxng.startTimeoutMs)
  next.searxng.defaultEngines = normalizeStringList(next.searxng.defaultEngines, DEFAULT_CONFIG.searxng.defaultEngines)
  next.searxng.categories = normalizeStringList(next.searxng.categories, DEFAULT_CONFIG.searxng.categories)
  next.serper.timeoutMs = toPositiveInt(next.serper.timeoutMs, DEFAULT_CONFIG.serper.timeoutMs)
  next.serper.num = Math.max(1, Math.min(10, toPositiveInt(next.serper.num, DEFAULT_CONFIG.serper.num)))
  const serperMaxFallbacks = Number(next.serper.maxFallbacksPerHour)
  next.serper.maxFallbacksPerHour = Number.isFinite(serperMaxFallbacks) && serperMaxFallbacks >= 0
    ? Math.floor(serperMaxFallbacks)
    : DEFAULT_CONFIG.serper.maxFallbacksPerHour
  return next
}

function shouldManageLocalSearxng(config: any): boolean {
  if (!config || !config.searxng) return false
  if (config.searxng.autoStart === false) return false
  const baseUrl = normalizeBaseUrl(config.searxng.baseUrl)
  return !baseUrl || baseUrl === normalizeBaseUrl(managedBaseUrl(config))
}

export {
  DEFAULT_CONFIG,
  normalizeProviderList,
  normalizeStringList,
  normalizeBaseUrl,
  normalizeConfigShape,
  managedBaseUrl,
  shouldManageLocalSearxng,
}
