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
  q: string
  limit?: number
  categories?: string[]
  engines?: string[]
  language?: string
  pageno?: number
  time_range?: string
  safesearch?: number
  image_proxy?: boolean
  enabled_plugins?: string[]
  disabled_plugins?: string[]
  enabled_engines?: string[]
  disabled_engines?: string[]
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

function sidecarRuntimeDirForState(stateRoot: string): string {
  return path.join(dataRootForState(stateRoot), 'searxng-runtime')
}

function sidecarSourceDirForState(stateRoot: string): string {
  return path.join(sidecarRuntimeDirForState(stateRoot), 'src')
}

function sidecarVenvDirForState(stateRoot: string): string {
  return path.join(sidecarRuntimeDirForState(stateRoot), 'venv')
}

function sidecarTmpDirForState(stateRoot: string): string {
  return path.join(sidecarRuntimeDirForState(stateRoot), 'tmp')
}

function sidecarBootstrapStateFileForState(stateRoot: string): string {
  return path.join(sidecarRuntimeDirForState(stateRoot), 'bootstrap.json')
}

function sidecarSettingsFileForState(stateRoot: string): string {
  return path.join(sidecarConfigDirForState(stateRoot), 'settings.yml')
}

function sidecarPythonBinForState(stateRoot: string): string {
  const dir = sidecarVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python')
}

function sidecarPipBinForState(stateRoot: string): string {
  const dir = sidecarVenvDirForState(stateRoot)
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'pip.exe') : path.join(dir, 'bin', 'pip')
}

function writeSearxngSettingsForState(stateRoot: string, config: any) {
  const settingsPath = sidecarSettingsFileForState(stateRoot)
  ensurePrivateDir(path.dirname(settingsPath))
  const baseUrl = normalizeBaseUrl(config && config.searxng && config.searxng.baseUrl || managedBaseUrl(config)) || managedBaseUrl(config)
  const secret = crypto.createHash('sha256').update(`${baseUrl}|${stateRoot}|rin-web-search`).digest('hex').slice(0, 32)
  const port = toPositiveInt(config && config.searxng && config.searxng.hostPort, DEFAULT_CONFIG.searxng.hostPort)
  const yaml = [
    'use_default_settings: true',
    '',
    'general:',
    '  enable_metrics: false',
    '',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
    'server:',
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    `  base_url: ${JSON.stringify(`${baseUrl}/`)}`,
    `  secret_key: ${JSON.stringify(secret)}`,
    '  limiter: false',
    '  public_instance: false',
    '',
    'valkey:',
    '  url: false',
    '',
  ].join('\n')
  fs.writeFileSync(settingsPath, yaml, { mode: 0o600 })
  return settingsPath
}

function loadConfigResolved(_stateRoot: string) {
  return normalizeConfigShape({})
}

function loadState(stateRoot: string) {
  return readJson(stateFileForState(stateRoot), {
    providers: {},
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

function normalizeSearxngToolRequest(raw: WebSearchRequest, config: any) {
  const q = nonEmpty(raw && raw.q)
  const limit = Math.max(1, Math.min(10, toPositiveInt(raw && raw.limit, 8)))
  const categories = normalizeStringList(raw && raw.categories, normalizeStringList(config && config.searxng && config.searxng.categories, DEFAULT_CONFIG.searxng.categories))
  const engines = normalizeStringList(raw && raw.engines, normalizeStringList(config && config.searxng && config.searxng.defaultEngines, DEFAULT_CONFIG.searxng.defaultEngines))
  const language = nonEmpty(raw && raw.language) || 'all'
  const pageno = Math.max(1, toPositiveInt(raw && raw.pageno, 1))
  const time_range = ['day', 'week', 'month', 'year'].includes(nonEmpty(raw && raw.time_range).toLowerCase()) ? nonEmpty(raw && raw.time_range).toLowerCase() : ''
  const safesearchRaw = Number(raw && raw.safesearch)
  const safesearch = [0, 1, 2].includes(safesearchRaw) ? safesearchRaw : 1
  const image_proxy = raw && typeof raw.image_proxy === 'boolean' ? raw.image_proxy : undefined
  const enabled_plugins = normalizeStringList(raw && raw.enabled_plugins, [])
  const disabled_plugins = normalizeStringList(raw && raw.disabled_plugins, [])
  const enabled_engines = normalizeStringList(raw && raw.enabled_engines, [])
  const disabled_engines = normalizeStringList(raw && raw.disabled_engines, [])
  return {
    q,
    limit,
    categories,
    engines,
    language,
    pageno,
    time_range,
    safesearch,
    image_proxy,
    enabled_plugins,
    disabled_plugins,
    enabled_engines,
    disabled_engines,
    cacheTtlSeconds: Math.max(60, toPositiveInt(config.cacheTtlSeconds, DEFAULT_CONFIG.cacheTtlSeconds)),
  }
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

function readSidecarBootstrapState(stateRoot: string) {
  return readJson<any>(sidecarBootstrapStateFileForState(stateRoot), null)
}

function writeSidecarBootstrapState(stateRoot: string, value: any) {
  writeJsonAtomic(sidecarBootstrapStateFileForState(stateRoot), value)
}

function runCommandSync(command: string, args: string[], options: any = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status === 0) return result
  const detail = safeText(result.stderr || result.stdout || result.error && result.error.message || `exit_${result.status}`)
  throw new Error(`${path.basename(command)}:${detail}`)
}

function ensureSearxngRuntimeInstalled(stateRoot: string, config: any, logger?: any) {
  const runtimeDir = sidecarRuntimeDirForState(stateRoot)
  const sourceDir = sidecarSourceDirForState(stateRoot)
  const venvDir = sidecarVenvDirForState(stateRoot)
  const tmpDir = sidecarTmpDirForState(stateRoot)
  const pythonBin = sidecarPythonBinForState(stateRoot)
  const pipBin = sidecarPipBinForState(stateRoot)
  const current = readSidecarBootstrapState(stateRoot)
  if (current && current.ready && fs.existsSync(sourceDir) && fs.existsSync(pythonBin) && fs.existsSync(pipBin)) {
    return { ok: true, sourceDir, venvDir, pythonBin, pipBin, reused: true, commit: safeText(current.commit) }
  }

  ensurePrivateDir(runtimeDir)
  ensurePrivateDir(tmpDir)

  const python = findExecutableOnPath('python3') || findExecutableOnPath('python')
  if (!python) throw new Error('python_not_found')

  const git = findExecutableOnPath('git')
  if (!git) throw new Error('git_not_found')

  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    try { fs.rmSync(sourceDir, { recursive: true, force: true }) } catch {}
    try { logger && typeof logger.info === 'function' && logger.info('web-search: cloning searxng source') } catch {}
    runCommandSync(git, ['clone', '--depth', '1', 'https://github.com/searxng/searxng.git', sourceDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  }

  if (!fs.existsSync(pythonBin)) {
    try { logger && typeof logger.info === 'function' && logger.info('web-search: creating searxng virtualenv') } catch {}
    runCommandSync(python, ['-m', 'venv', venvDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  }

  try { logger && typeof logger.info === 'function' && logger.info('web-search: installing searxng runtime dependencies') } catch {}
  runCommandSync(pipBin, ['install', '--upgrade', 'pip', 'wheel', 'setuptools'], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  runCommandSync(pipBin, ['install', '-r', path.join(sourceDir, 'requirements.txt')], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })
  runCommandSync(pipBin, ['install', '--no-build-isolation', '-e', sourceDir], { cwd: runtimeDir, env: { ...process.env, TMPDIR: tmpDir } })

  const commit = fs.existsSync(path.join(sourceDir, '.git'))
    ? safeText(runCommandSync(git, ['-C', sourceDir, 'rev-parse', 'HEAD'], { env: { ...process.env, TMPDIR: tmpDir } }).stdout)
    : ''
  writeSidecarBootstrapState(stateRoot, {
    ready: true,
    sourceDir,
    venvDir,
    pythonBin,
    pipBin,
    commit,
    installedAt: new Date().toISOString(),
  })
  return { ok: true, sourceDir, venvDir, pythonBin, pipBin, reused: false, commit }
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

    const runtime = ensureSearxngRuntimeInstalled(stateRoot, config, logger)
    const current = readSidecarState(stateRoot)
    const settingsPath = writeSearxngSettingsForState(stateRoot, config)
    const port = toPositiveInt(config.searxng.hostPort, DEFAULT_CONFIG.searxng.hostPort)
    const tmpDir = sidecarTmpDirForState(stateRoot)
    ensurePrivateDir(tmpDir)

    if (current && Number(current.pid) > 1 && isPidAlive(current.pid)) {
      try { process.kill(Number(current.pid), 'SIGTERM') } catch {}
    }

    try { logger && typeof logger.info === 'function' && logger.info(`web-search: starting managed searxng baseUrl=${baseUrl}`) } catch {}
    const child = spawn(runtime.pythonBin, ['-m', 'searx.webapp'], {
      cwd: runtime.sourceDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        TMPDIR: tmpDir,
        PYTHONUNBUFFERED: '1',
        SEARXNG_SETTINGS_PATH: settingsPath,
        SEARXNG_PORT: String(port),
        SEARXNG_BIND_ADDRESS: '127.0.0.1',
        SEARXNG_BASE_URL: `${baseUrl}/`,
        SEARXNG_LIMITER: 'false',
      },
    })
    try { child.unref() } catch {}

    writeSidecarState(stateRoot, {
      pid: Number(child.pid || 0),
      port,
      baseUrl,
      pythonBin: runtime.pythonBin,
      sourceDir: runtime.sourceDir,
      settingsPath,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    })

    const startTimeoutMs = Number(options && options.timeoutMs || 0) > 0
      ? Number(options && options.timeoutMs)
      : toPositiveInt(config.searxng.startTimeoutMs, DEFAULT_CONFIG.searxng.startTimeoutMs)
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (await checkSearxngHealth(baseUrl, healthTimeoutMs)) {
        return { ok: true, baseUrl, reused: runtime.reused ? 'started_reused_runtime' : 'started_bootstrapped_runtime', pid: Number(child.pid || 0) }
      }
      if (Number(child.pid || 0) > 1 && !isPidAlive(child.pid)) break
      await sleep(500)
    }

    try { process.kill(Number(child.pid || 0), 'SIGTERM') } catch {}
    try { fs.rmSync(sidecarStateFileForState(stateRoot), { force: true }) } catch {}
    return { ok: false, baseUrl, error: 'searxng_start_timeout' }
  } catch (error: any) {
    return { ok: false, baseUrl, error: safeText(error && (error.message || error) || 'searxng_runtime_error') || 'searxng_runtime_error' }
  } finally {
    try { release() } catch {}
  }
}

async function stopSearxngSidecar(stateRoot: string, options: { logger?: any } = {}) {
  const logger = options && options.logger
  const release = await acquireSidecarLock(sidecarLockPathForState(stateRoot), 20_000)
  try {
    const current = readSidecarState(stateRoot) || {}
    if (Number(current.pid || 0) > 1 && isPidAlive(current.pid)) {
      try { process.kill(Number(current.pid), 'SIGTERM') } catch {}
    }
    try { fs.rmSync(sidecarStateFileForState(stateRoot), { force: true }) } catch {}
    try { logger && typeof logger.info === 'function' && logger.info('web-search: stopped managed searxng runtime') } catch {}
    return { ok: true, pid: Number(current.pid || 0) }
  } finally {
    try { release() } catch {}
  }
}

async function searchViaSearxng(config: any, request: any) {
  const baseUrl = nonEmpty(config && config.searxng && config.searxng.baseUrl)
  if (!baseUrl) return { skipped: true, reason: 'searxng_not_configured' }

  const url = new URL('/search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('q', request.q)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', request.language || 'all')
  url.searchParams.set('safesearch', String(request.safesearch))
  url.searchParams.set('pageno', String(request.pageno || 1))
  if (Array.isArray(request.engines) && request.engines.length) url.searchParams.set('engines', request.engines.join(','))
  if (Array.isArray(request.categories) && request.categories.length) url.searchParams.set('categories', request.categories.join(','))
  if (request.time_range) url.searchParams.set('time_range', request.time_range)
  if (typeof request.image_proxy === 'boolean') url.searchParams.set('image_proxy', request.image_proxy ? '1' : '0')
  if (Array.isArray(request.enabled_plugins) && request.enabled_plugins.length) url.searchParams.set('enabled_plugins', request.enabled_plugins.join(','))
  if (Array.isArray(request.disabled_plugins) && request.disabled_plugins.length) url.searchParams.set('disabled_plugins', request.disabled_plugins.join(','))
  if (Array.isArray(request.enabled_engines) && request.enabled_engines.length) url.searchParams.set('enabled_engines', request.enabled_engines.join(','))
  if (Array.isArray(request.disabled_engines) && request.disabled_engines.length) url.searchParams.set('disabled_engines', request.disabled_engines.join(','))

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

async function searchWeb({ stateRoot, noCache = false, ...rawRequest }: { stateRoot: string } & WebSearchRequest): Promise<WebSearchResponse> {
  const config = loadConfigResolved(stateRoot)
  const request = normalizeSearxngToolRequest(rawRequest as WebSearchRequest, config)
  if (!request.q) throw new Error('web_search_query_required')

  if (shouldManageLocalSearxng(config)) {
    try { await ensureSearxngSidecar(stateRoot) } catch {}
  }

  const state = loadState(stateRoot)
  const provider = 'searxng'
  const cacheKey = cacheKeyFromRequest({
    q: request.q,
    limit: request.limit,
    categories: request.categories,
    engines: request.engines,
    language: request.language,
    pageno: request.pageno,
    time_range: request.time_range,
    safesearch: request.safesearch,
    image_proxy: request.image_proxy,
    enabled_plugins: request.enabled_plugins,
    disabled_plugins: request.disabled_plugins,
    enabled_engines: request.enabled_engines,
    disabled_engines: request.disabled_engines,
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

  const attempts: Array<Record<string, any>> = []
  const cooldownUntilMs = isProviderCoolingDown(state, provider)
  if (cooldownUntilMs > Date.now()) {
    attempts.push({ provider, status: 'skipped_cooldown', cooldownUntilMs })
    return {
      ok: false,
      query: request.q,
      providerUsed: '',
      cached: false,
      cacheKey,
      results: [],
      extras: {},
      attempts,
      error: 'provider_cooling_down',
    }
  }

  try {
    const result = await searchViaSearxng(config, request)
    if (result && result.skipped) {
      attempts.push({ provider, status: 'skipped', reason: result.reason })
      return {
        ok: false,
        query: request.q,
        providerUsed: '',
        cached: false,
        cacheKey,
        results: [],
        extras: {},
        attempts,
        error: safeText(result.reason || 'searxng_skipped') || 'searxng_skipped',
      }
    }

    noteProviderSuccess(state, provider)
    const resultsCount = Array.isArray(result && result.results) ? result.results.length : 0
    const status = resultsCount > 0 ? 'success' : 'empty'
    attempts.push({ provider, status, resultsCount, durationMs: Number(result && result.durationMs || 0) })

    const response = {
      ok: true,
      query: request.q,
      providerUsed: provider,
      cached: false,
      cacheKey,
      request: {
        limit: request.limit,
        categories: request.categories,
        engines: request.engines,
        language: request.language,
        pageno: request.pageno,
        time_range: request.time_range,
        safesearch: request.safesearch,
        image_proxy: request.image_proxy,
        enabled_plugins: request.enabled_plugins,
        disabled_plugins: request.disabled_plugins,
        enabled_engines: request.enabled_engines,
        disabled_engines: request.disabled_engines,
      },
      results: result && result.results || [],
      extras: result && result.extras || {},
      attempts,
    }

    saveState(stateRoot, state)
    if (!noCache) saveCacheEntry(stateRoot, cacheKey, response, request.cacheTtlSeconds)
    return response
  } catch (error: any) {
    const errorText = safeText(error && (error.message || error) || 'provider_error')
    noteProviderFailure(state, provider, errorText)
    attempts.push({ provider, status: 'error', error: errorText })
    saveState(stateRoot, state)
    return {
      ok: false,
      query: request.q,
      providerUsed: '',
      cached: false,
      cacheKey,
      results: [],
      extras: {},
      attempts,
      error: errorText || 'provider_error',
    }
  }
}

export {
  DEFAULT_CONFIG,
  normalizeProviderList,
  normalizeStringList,
  normalizeBaseUrl,
  normalizeConfigShape,
  loadConfigResolved,
  normalizeSearxngToolRequest,
  ensureSearxngSidecar,
  stopSearxngSidecar,
  searchWeb,
}
