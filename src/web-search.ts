// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

import {
  DEFAULT_CONFIG,
  managedBaseUrl,
  normalizeBaseUrl,
  normalizeConfigShape,
  normalizeProviderList,
  normalizeStringList,
  shouldManageLocalSearxng,
} from './web-search-config'

type WebSearchRequest = {
  query: string
  limit?: number
  freshness?: string
  safe?: string
  provider?: string
  providers?: string[]
  noCache?: boolean
}

type WebSearchResponse = {
  ok: boolean
  query: string
  providerUsed: string
  cached: boolean
  cacheKey: string
  results: Array<Record<string, any>>
  extras: Record<string, any>
  attempts: Array<Record<string, any>>
  request?: Record<string, any>
  error?: string
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

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function ensurePrivateDir(dir: string) {
  ensureDir(dir)
  try { fs.chmodSync(dir, 0o700) } catch {}
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600) {
  ensurePrivateDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, mode) } catch {}
}

function findExecutableOnPath(name: string): string {
  const raw = safeString(process.env.PATH)
  const parts = raw ? raw.split(path.delimiter) : []
  for (const dir of parts) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return ''
}

function isPidAlive(pid: unknown): boolean {
  const n = Number(pid || 0)
  if (!Number.isFinite(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(safeString(value)).digest('hex')
}

function dataRootForState(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'data', 'web-search')
}

function configFileForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'config.json')
}

function stateFileForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'state.json')
}

function cacheResultsDirForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'cache', 'results')
}

function sidecarLockPathForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'searxng-sidecar.lock')
}

function sidecarStateFileForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'searxng-sidecar.json')
}

function sidecarConfigDirForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'searxng')
}

function sidecarSettingsFileForState(stateRoot: string): string {
  return path.join(sidecarConfigDirForState(stateRoot), 'settings.yml')
}

function writeSearxngSettingsForState(stateRoot: string, config: any) {
  const settingsPath = sidecarSettingsFileForState(stateRoot)
  ensurePrivateDir(path.dirname(settingsPath))
  const baseUrl = normalizeBaseUrl(config && config.searxng && config.searxng.baseUrl || managedBaseUrl(config)) || managedBaseUrl(config)
  const secret = crypto.createHash('sha256').update(`${baseUrl}|${stateRoot}|rin-web-search`).digest('hex').slice(0, 32)
  const yaml = [
    'use_default_settings: true',
    '',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
    'server:',
    `  base_url: ${JSON.stringify(`${baseUrl}/`)}`,
    `  secret_key: ${JSON.stringify(secret)}`,
    '  limiter: false',
    '  bind_address: "0.0.0.0"',
    '',
  ].join('\n')
  fs.writeFileSync(settingsPath, yaml, { mode: 0o600 })
  return settingsPath
}

function applyEnv(config: any) {
  const next = normalizeConfigShape(config)
  const providerOrder = nonEmpty(process.env.RIN_WEB_SEARCH_PROVIDER_ORDER)
  if (providerOrder) next.defaultProviders = normalizeProviderList(providerOrder, next.defaultProviders)

  const ttl = toPositiveInt(process.env.RIN_WEB_SEARCH_CACHE_TTL_SECONDS, 0)
  if (ttl > 0) next.cacheTtlSeconds = ttl

  const searxngUrl = normalizeBaseUrl(process.env.RIN_WEB_SEARCH_SEARXNG_URL)
  if (searxngUrl) next.searxng.baseUrl = searxngUrl
  const searxngApiKey = nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_API_KEY)
  if (searxngApiKey) next.searxng.apiKey = searxngApiKey
  const searxngPort = toPositiveInt(process.env.RIN_WEB_SEARCH_SEARXNG_PORT, 0)
  if (searxngPort > 0) next.searxng.hostPort = searxngPort
  const searxngImage = nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_IMAGE)
  if (searxngImage) next.searxng.dockerImage = searxngImage
  const searxngEngines = nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_ENGINES)
  if (searxngEngines) next.searxng.defaultEngines = normalizeStringList(searxngEngines, next.searxng.defaultEngines)
  const searxngCategories = nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_CATEGORIES)
  if (searxngCategories) next.searxng.categories = normalizeStringList(searxngCategories, next.searxng.categories)
  if (nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_AUTOSTART)) {
    next.searxng.autoStart = !['0', 'false', 'no', 'off'].includes(nonEmpty(process.env.RIN_WEB_SEARCH_SEARXNG_AUTOSTART).toLowerCase())
  }

  const serperApiKey = nonEmpty(process.env.RIN_WEB_SEARCH_SERPER_API_KEY || process.env.SERPER_API_KEY)
  if (serperApiKey) next.serper.apiKey = serperApiKey
  const serperEndpoint = nonEmpty(process.env.RIN_WEB_SEARCH_SERPER_ENDPOINT)
  if (serperEndpoint) next.serper.endpoint = serperEndpoint
  const serperGl = nonEmpty(process.env.RIN_WEB_SEARCH_SERPER_GL)
  if (serperGl) next.serper.gl = serperGl
  const serperHl = nonEmpty(process.env.RIN_WEB_SEARCH_SERPER_HL)
  if (serperHl) next.serper.hl = serperHl
  const serperMaxFallbacks = Number(process.env.RIN_WEB_SEARCH_SERPER_MAX_FALLBACKS_PER_HOUR)
  if (Number.isFinite(serperMaxFallbacks) && serperMaxFallbacks >= 0) next.serper.maxFallbacksPerHour = Math.floor(serperMaxFallbacks)

  return normalizeConfigShape(next)
}

function normalizeStateConfigFile(stateRoot: string) {
  const configPath = configFileForState(stateRoot)
  const current = readJson<any>(configPath, null)
  if (!current || typeof current !== 'object') return { ok: false, updated: false, configPath }
  const normalized = normalizeConfigShape(current)
  const currentJson = JSON.stringify(current)
  const nextJson = JSON.stringify(normalized)
  if (currentJson === nextJson) return { ok: true, updated: false, configPath, config: normalized }
  writeJsonAtomic(configPath, normalized)
  return { ok: true, updated: true, configPath, config: normalized }
}

function loadConfigResolved(stateRoot: string) {
  const fileConfig = readJson<any>(configFileForState(stateRoot), null)
  return applyEnv(fileConfig || {})
}

function loadState(stateRoot: string) {
  return readJson(stateFileForState(stateRoot), {
    providers: {},
    serperFallbackWindow: { hourKey: '', count: 0 },
  })
}

function saveState(stateRoot: string, value: any) {
  writeJsonAtomic(stateFileForState(stateRoot), value)
}

function providerState(state: any, provider: string) {
  const root = state.providers || (state.providers = {})
  if (!root[provider] || typeof root[provider] !== 'object') {
    root[provider] = {
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
      lastError: '',
      lastAttemptAtMs: 0,
      lastSuccessAtMs: 0,
    }
  }
  return root[provider]
}

function noteProviderSuccess(state: any, provider: string) {
  const p = providerState(state, provider)
  p.consecutiveFailures = 0
  p.cooldownUntilMs = 0
  p.lastError = ''
  p.lastAttemptAtMs = Date.now()
  p.lastSuccessAtMs = Date.now()
}

function noteProviderFailure(state: any, provider: string, errorText: string) {
  const p = providerState(state, provider)
  p.consecutiveFailures = Number(p.consecutiveFailures || 0) + 1
  p.lastAttemptAtMs = Date.now()
  p.lastError = safeText(errorText).slice(0, 500)
  if (p.consecutiveFailures >= 3) p.cooldownUntilMs = Date.now() + 5 * 60_000
}

function isProviderCoolingDown(state: any, provider: string) {
  const p = providerState(state, provider)
  const until = Number(p.cooldownUntilMs || 0)
  return until > Date.now() ? until : 0
}

function reserveSerperFallbackSlot(state: any, config: any) {
  const limit = Number(config && config.serper && config.serper.maxFallbacksPerHour || 0)
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true, remaining: Infinity, limit: 0 }
  const hourKey = new Date().toISOString().slice(0, 13)
  if (!state.serperFallbackWindow || state.serperFallbackWindow.hourKey !== hourKey) {
    state.serperFallbackWindow = { hourKey, count: 0 }
  }
  if (state.serperFallbackWindow.count >= limit) return { ok: false, remaining: 0, limit }
  state.serperFallbackWindow.count += 1
  return { ok: true, remaining: Math.max(0, limit - state.serperFallbackWindow.count), limit }
}

function cacheKeyFromRequest(payload: unknown): string {
  return sha256(JSON.stringify(payload))
}

function cacheFileForKey(stateRoot: string, key: string): string {
  return path.join(cacheResultsDirForState(stateRoot), `${key}.json`)
}

function loadCacheEntry(stateRoot: string, key: string, ttlSeconds: number) {
  const file = cacheFileForKey(stateRoot, key)
  const entry = readJson<any>(file, null)
  if (!entry || typeof entry !== 'object') return null
  const expiresAtMs = Number(entry.expiresAtMs || 0)
  const staleByFile = Date.now() - Number(entry.cachedAtMs || 0) > Math.max(1, ttlSeconds) * 1000
  if ((expiresAtMs && expiresAtMs < Date.now()) || staleByFile) return null
  return entry
}

function saveCacheEntry(stateRoot: string, key: string, response: any, ttlSeconds: number) {
  ensurePrivateDir(cacheResultsDirForState(stateRoot))
  const now = Date.now()
  writeJsonAtomic(cacheFileForKey(stateRoot, key), {
    cachedAtMs: now,
    expiresAtMs: now + Math.max(1, ttlSeconds) * 1000,
    response,
  })
}

function safeText(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function mapSearxngSafe(safe: string): string {
  if (safe === 'strict') return '2'
  if (safe === 'moderate') return '1'
  return '0'
}

function mapFreshnessToGoogleTbs(freshness: string): string {
  if (freshness === 'day') return 'qdr:d'
  if (freshness === 'week') return 'qdr:w'
  if (freshness === 'month') return 'qdr:m'
  if (freshness === 'year') return 'qdr:y'
  return ''
}

async function fetchJson(url: string, { method = 'GET', headers = {}, body = undefined, timeoutMs = 10_000 }: any = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout:${timeoutMs}`)), Math.max(1, timeoutMs))
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) {
      const err: any = new Error(`http_${res.status}:${safeText(text || res.statusText)}`)
      err.status = res.status
      err.body = text
      throw err
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function checkSearxngHealth(baseUrl: string, timeoutMs = 2_500) {
  const url = new URL('/', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timeout:${timeoutMs}`)), Math.max(1, timeoutMs))
    try {
      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': DEFAULT_CONFIG.http.userAgent },
        signal: controller.signal,
      })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function readSidecarState(stateRoot: string) {
  return readJson<any>(sidecarStateFileForState(stateRoot), null)
}

function writeSidecarState(stateRoot: string, value: any) {
  writeJsonAtomic(sidecarStateFileForState(stateRoot), value)
}

async function acquireSidecarLock(lockPath: string, timeoutMs = 15_000) {
  ensurePrivateDir(path.dirname(lockPath))
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      try { fs.closeSync(fd) } catch {}
      return () => { try { fs.rmSync(lockPath, { force: true }) } catch {} }
    } catch {
      let stale = false
      try {
        const raw = fs.readFileSync(lockPath, 'utf8')
        const state = JSON.parse(raw)
        if (!isPidAlive(Number(state && state.pid || 0))) stale = true
      } catch {
        stale = true
      }
      if (stale) {
        try { fs.rmSync(lockPath, { force: true }) } catch {}
        continue
      }
      await sleep(100)
    }
  }
  throw new Error(`web_search_lock_timeout:${lockPath}`)
}

async function ensureSearxngSidecar(stateRoot: string, options: { logger?: any, timeoutMs?: number } = {}) {
  const logger = options && options.logger
  const config = loadConfigResolved(stateRoot)
  const baseUrl = normalizeBaseUrl(config.searxng.baseUrl || managedBaseUrl(config)) || managedBaseUrl(config)
  if (!shouldManageLocalSearxng(config)) {
    return { ok: false, skipped: 'external_base_url', baseUrl }
  }

  const healthTimeoutMs = toPositiveInt(config.searxng.healthTimeoutMs, DEFAULT_CONFIG.searxng.healthTimeoutMs)
  if (await checkSearxngHealth(baseUrl, healthTimeoutMs)) {
    return { ok: true, baseUrl, reused: 'healthy' }
  }

  const release = await acquireSidecarLock(sidecarLockPathForState(stateRoot), 20_000)
  try {
    if (await checkSearxngHealth(baseUrl, healthTimeoutMs)) {
      return { ok: true, baseUrl, reused: 'locked_healthy' }
    }

    const docker = findExecutableOnPath('docker')
    if (!docker) {
      return { ok: false, baseUrl, error: 'docker_not_found' }
    }

    const current = readSidecarState(stateRoot)
    const containerName = nonEmpty(config.searxng.containerName) || DEFAULT_CONFIG.searxng.containerName
    const port = toPositiveInt(config.searxng.hostPort, DEFAULT_CONFIG.searxng.hostPort)
    const image = nonEmpty(config.searxng.dockerImage) || DEFAULT_CONFIG.searxng.dockerImage
    const settingsPath = writeSearxngSettingsForState(stateRoot, config)

    if (current && Number(current.pid) > 1 && isPidAlive(current.pid)) {
      try { process.kill(Number(current.pid), 'SIGTERM') } catch {}
    }
    try { spawnSync(docker, ['rm', '-f', containerName], { stdio: 'ignore' }) } catch {}

    const args = [
      'run',
      '--rm',
      '--name', containerName,
      '-p', `127.0.0.1:${port}:8080`,
      '-v', `${settingsPath}:/etc/searxng/settings.yml:ro`,
      '-e', 'SEARXNG_BIND_ADDRESS=0.0.0.0',
      '-e', `SEARXNG_BASE_URL=${baseUrl}/`,
      '-e', 'SEARXNG_LIMITER=false',
      image,
    ]

    try { logger && typeof logger.info === 'function' && logger.info(`web-search: starting searxng sidecar image=${image} baseUrl=${baseUrl}`) } catch {}
    const child = spawn(docker, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    try { child.unref() } catch {}

    writeSidecarState(stateRoot, {
      pid: Number(child.pid || 0),
      containerName,
      port,
      baseUrl,
      image,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    })

    const startTimeoutMs = Number(options && options.timeoutMs || 0) > 0
      ? Number(options && options.timeoutMs)
      : toPositiveInt(config.searxng.startTimeoutMs, DEFAULT_CONFIG.searxng.startTimeoutMs)
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (await checkSearxngHealth(baseUrl, healthTimeoutMs)) {
        return { ok: true, baseUrl, reused: 'started', pid: Number(child.pid || 0) }
      }
      if (Number(child.pid || 0) > 1 && !isPidAlive(child.pid)) break
      await sleep(500)
    }

    try { spawnSync(docker, ['rm', '-f', containerName], { stdio: 'ignore' }) } catch {}
    try { fs.rmSync(sidecarStateFileForState(stateRoot), { force: true }) } catch {}
    return { ok: false, baseUrl, error: 'searxng_start_timeout' }
  } finally {
    try { release() } catch {}
  }
}

async function stopSearxngSidecar(stateRoot: string, options: { logger?: any } = {}) {
  const logger = options && options.logger
  const release = await acquireSidecarLock(sidecarLockPathForState(stateRoot), 20_000)
  try {
    const config = loadConfigResolved(stateRoot)
    const current = readSidecarState(stateRoot) || {}
    const containerName = nonEmpty(current.containerName || config.searxng.containerName) || DEFAULT_CONFIG.searxng.containerName
    const docker = findExecutableOnPath('docker')
    if (Number(current.pid || 0) > 1 && isPidAlive(current.pid)) {
      try { process.kill(Number(current.pid), 'SIGTERM') } catch {}
    }
    if (docker) {
      try { spawnSync(docker, ['rm', '-f', containerName], { stdio: 'ignore' }) } catch {}
    }
    try { fs.rmSync(sidecarStateFileForState(stateRoot), { force: true }) } catch {}
    try { logger && typeof logger.info === 'function' && logger.info(`web-search: stopped searxng sidecar container=${containerName}`) } catch {}
    return { ok: true, containerName }
  } finally {
    try { release() } catch {}
  }
}

async function searchViaSearxng(config: any, request: any) {
  const baseUrl = nonEmpty(config && config.searxng && config.searxng.baseUrl)
  if (!baseUrl) return { skipped: true, reason: 'searxng_not_configured' }

  const url = new URL('/search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('q', request.query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'all')
  url.searchParams.set('safesearch', mapSearxngSafe(request.safe))
  const defaultEngines = normalizeStringList(config && config.searxng && config.searxng.defaultEngines, DEFAULT_CONFIG.searxng.defaultEngines)
  const categories = normalizeStringList(config && config.searxng && config.searxng.categories, DEFAULT_CONFIG.searxng.categories)
  if (defaultEngines.length) url.searchParams.set('engines', defaultEngines.join(','))
  if (categories.length) url.searchParams.set('categories', categories.join(','))
  if (request.freshness) url.searchParams.set('time_range', request.freshness)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': config && config.http && config.http.userAgent || DEFAULT_CONFIG.http.userAgent,
  }
  if (nonEmpty(config && config.searxng && config.searxng.apiKey)) headers.Authorization = `Bearer ${config.searxng.apiKey}`

  const started = Date.now()
  const data = await fetchJson(url.toString(), {
    headers,
    timeoutMs: toPositiveInt(config && config.searxng && config.searxng.timeoutMs, DEFAULT_CONFIG.searxng.timeoutMs),
  })

  const results = Array.isArray(data && data.results) ? data.results : []
  const normalized = results.slice(0, request.limit).map((item: any, index: number) => ({
    type: safeText(item && (item.category || 'organic')) || 'organic',
    position: Number(item && (item.position || index + 1)),
    title: safeText(item && item.title),
    url: safeText(item && item.url),
    snippet: safeText(item && (item.content || item.description)),
    source: safeText(item && item.engine),
    publishedDate: safeText(item && (item.publishedDate || item.published_date)),
    provider: 'searxng',
  })).filter((item: any) => item.url)

  return {
    ok: true,
    provider: 'searxng',
    durationMs: Date.now() - started,
    results: normalized,
    extras: {
      answers: Array.isArray(data && data.answers) ? data.answers : [],
      suggestions: Array.isArray(data && data.suggestions) ? data.suggestions : [],
      infoboxes: Array.isArray(data && data.infoboxes) ? data.infoboxes : [],
      unresponsiveEngines: Array.isArray(data && data.unresponsive_engines) ? data.unresponsive_engines : [],
    },
  }
}

async function searchViaSerper(config: any, request: any) {
  const apiKey = nonEmpty(config && config.serper && config.serper.apiKey)
  if (!apiKey) return { skipped: true, reason: 'serper_not_configured' }

  const payload: Record<string, any> = {
    q: request.query,
    num: Math.max(1, Math.min(10, request.limit || Number(config && config.serper && config.serper.num || 8))),
    gl: nonEmpty(config && config.serper && config.serper.gl || 'us'),
    hl: nonEmpty(config && config.serper && config.serper.hl || 'en'),
    autocorrect: true,
  }
  const tbs = mapFreshnessToGoogleTbs(request.freshness)
  if (tbs) payload.tbs = tbs

  const started = Date.now()
  const data = await fetchJson(nonEmpty(config && config.serper && config.serper.endpoint) || DEFAULT_CONFIG.serper.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
      'User-Agent': config && config.http && config.http.userAgent || DEFAULT_CONFIG.http.userAgent,
    },
    body: JSON.stringify(payload),
    timeoutMs: toPositiveInt(config && config.serper && config.serper.timeoutMs, DEFAULT_CONFIG.serper.timeoutMs),
  })

  const organic = Array.isArray(data && data.organic) ? data.organic : []
  const news = Array.isArray(data && data.news) ? data.news : []
  const combined: Array<Record<string, any>> = []

  for (const item of organic) {
    combined.push({
      type: 'organic',
      position: Number(item && (item.position || combined.length + 1)),
      title: safeText(item && item.title),
      url: safeText(item && item.link),
      snippet: safeText(item && item.snippet),
      source: safeText(item && item.source),
      publishedDate: safeText(item && item.date),
      provider: 'serper',
    })
  }
  for (const item of news) {
    if (combined.length >= request.limit) break
    combined.push({
      type: 'news',
      position: Number(item && (item.position || combined.length + 1)),
      title: safeText(item && item.title),
      url: safeText(item && item.link),
      snippet: safeText(item && item.snippet),
      source: safeText(item && item.source),
      publishedDate: safeText(item && item.date),
      provider: 'serper',
    })
  }

  return {
    ok: true,
    provider: 'serper',
    durationMs: Date.now() - started,
    results: combined.slice(0, request.limit).filter((item) => item.url),
    extras: {
      answerBox: data && data.answerBox || null,
      knowledgeGraph: data && data.knowledgeGraph || null,
      peopleAlsoAsk: Array.isArray(data && data.peopleAlsoAsk) ? data.peopleAlsoAsk : [],
      relatedSearches: Array.isArray(data && data.relatedSearches) ? data.relatedSearches : [],
      credits: data && data.credits || null,
    },
  }
}

async function searchWeb({ stateRoot, query, limit = 8, freshness = '', safe = 'moderate', provider = '', providers = [], noCache = false }: { stateRoot: string } & WebSearchRequest): Promise<WebSearchResponse> {
  const config = loadConfigResolved(stateRoot)
  const nextQuery = nonEmpty(query)
  if (!nextQuery) throw new Error('web_search_query_required')

  const explicitProvider = nonEmpty(provider).toLowerCase()
  const selectedProviders = explicitProvider
    ? normalizeProviderList([explicitProvider], [])
    : normalizeProviderList(providers && providers.length ? providers : config.defaultProviders, config.defaultProviders)
  if (!selectedProviders.length) throw new Error('web_search_no_providers_selected')

  if (selectedProviders.includes('searxng') && shouldManageLocalSearxng(config)) {
    try { await ensureSearxngSidecar(stateRoot) } catch {}
  }

  const request = {
    query: nextQuery,
    limit: Math.max(1, Math.min(10, toPositiveInt(limit, 8))),
    freshness: ['day', 'week', 'month', 'year'].includes(nonEmpty(freshness).toLowerCase()) ? nonEmpty(freshness).toLowerCase() : '',
    safe: ['off', 'moderate', 'strict'].includes(nonEmpty(safe).toLowerCase()) ? nonEmpty(safe).toLowerCase() : 'moderate',
    providers: selectedProviders,
    cacheTtlSeconds: Math.max(60, toPositiveInt(config.cacheTtlSeconds, DEFAULT_CONFIG.cacheTtlSeconds)),
  }

  const state = loadState(stateRoot)
  const cacheKey = cacheKeyFromRequest({
    q: request.query,
    limit: request.limit,
    freshness: request.freshness,
    safe: request.safe,
    providers: selectedProviders,
  })

  if (!noCache) {
    const hit = loadCacheEntry(stateRoot, cacheKey, request.cacheTtlSeconds)
    if (hit && hit.response) {
      return {
        ...hit.response,
        cached: true,
        cacheKey,
      }
    }
  }

  let lastSuccess: any = null
  const attempts: Array<Record<string, any>> = []

  for (let index = 0; index < selectedProviders.length; index += 1) {
    const currentProvider = selectedProviders[index]
    const cooldownUntilMs = isProviderCoolingDown(state, currentProvider)
    if (cooldownUntilMs > Date.now()) {
      attempts.push({ provider: currentProvider, status: 'skipped_cooldown', cooldownUntilMs })
      continue
    }

    const hasMeaningfulPriorProvider = attempts.some((attempt) => attempt.provider !== 'serper' && attempt.status !== 'skipped')
    if (currentProvider === 'serper' && index > 0 && hasMeaningfulPriorProvider) {
      const budget = reserveSerperFallbackSlot(state, config)
      if (!budget.ok) {
        attempts.push({ provider: currentProvider, status: 'skipped_local_budget', limit: budget.limit })
        continue
      }
    }

    let result: any = null
    try {
      if (currentProvider === 'searxng') result = await searchViaSearxng(config, request)
      else if (currentProvider === 'serper') result = await searchViaSerper(config, request)
      else result = { skipped: true, reason: 'unknown_provider' }
    } catch (error: any) {
      const errorText = safeText(error && (error.message || error) || 'provider_error')
      noteProviderFailure(state, currentProvider, errorText)
      attempts.push({ provider: currentProvider, status: 'error', error: errorText })
      continue
    }

    if (result && result.skipped) {
      attempts.push({ provider: currentProvider, status: 'skipped', reason: result.reason })
      continue
    }

    noteProviderSuccess(state, currentProvider)
    const resultsCount = Array.isArray(result && result.results) ? result.results.length : 0
    const status = resultsCount > 0 ? 'success' : 'empty'
    attempts.push({ provider: currentProvider, status, resultsCount, durationMs: Number(result && result.durationMs || 0) })

    lastSuccess = {
      ok: true,
      query: request.query,
      providerUsed: currentProvider,
      cached: false,
      cacheKey,
      request: {
        limit: request.limit,
        freshness: request.freshness,
        safe: request.safe,
        providers: selectedProviders,
      },
      results: result && result.results || [],
      extras: result && result.extras || {},
      attempts,
    }

    if (resultsCount > 0 || index === selectedProviders.length - 1) break
  }

  saveState(stateRoot, state)

  if (!lastSuccess) {
    return {
      ok: false,
      query: request.query,
      providerUsed: '',
      cached: false,
      cacheKey,
      results: [],
      extras: {},
      attempts,
      error: 'all_providers_failed_or_unconfigured',
    }
  }

  if (!noCache) saveCacheEntry(stateRoot, cacheKey, lastSuccess, request.cacheTtlSeconds)
  return lastSuccess
}

export {
  DEFAULT_CONFIG,
  normalizeProviderList,
  normalizeStringList,
  normalizeBaseUrl,
  normalizeConfigShape,
  reserveSerperFallbackSlot,
  loadConfigResolved,
  ensureSearxngSidecar,
  stopSearxngSidecar,
  searchWeb,
}
