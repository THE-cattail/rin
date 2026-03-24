const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_CONFIG,
  managedBaseUrl,
  normalizeBaseUrl,
  normalizeConfigShape,
  normalizeProviderList,
  shouldManageLocalSearxng,
} = require('../dist/web-search-config.js')
const { normalizeSearxngToolRequest } = require('../dist/web-search.js')

test('normalizeProviderList keeps only the managed searxng provider', () => {
  assert.deepEqual(
    normalizeProviderList(['SERPER', 'searxng', 'serper', 'unknown'], []),
    ['searxng'],
  )
})

test('normalizeBaseUrl canonicalizes scheme and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:18080/'), 'http://127.0.0.1:18080')
  assert.equal(normalizeBaseUrl('https://example.com////'), 'https://example.com')
})

test('normalizeConfigShape keeps managed defaults and strips retired config fields', () => {
  const config = normalizeConfigShape({
    version: 2,
    defaultProviders: ['searxng', 'serper'],
    http: { userAgent: 'Rin web-search skill/1.0' },
    searxng: {
      hostPort: 19090,
      baseUrl: '',
      healthTimeoutMs: 2500,
    },
    serper: {
      apiKey: 'unused',
    },
  })

  assert.equal(config.version, DEFAULT_CONFIG.version)
  assert.deepEqual(config.defaultProviders, DEFAULT_CONFIG.defaultProviders)
  assert.equal(config.http.userAgent, DEFAULT_CONFIG.http.userAgent)
  assert.equal(config.searxng.baseUrl, 'http://127.0.0.1:19090')
  assert.equal(config.searxng.healthTimeoutMs, DEFAULT_CONFIG.searxng.healthTimeoutMs)
  assert.equal('dockerImage' in config.searxng, false)
  assert.equal('containerName' in config.searxng, false)
  assert.equal('serper' in config, false)
})

test('managedBaseUrl and shouldManageLocalSearxng keep local sidecar behavior explicit', () => {
  const managedConfig = normalizeConfigShape({
    searxng: {
      hostPort: 19191,
      baseUrl: '',
    },
  })
  assert.equal(managedBaseUrl(managedConfig), 'http://127.0.0.1:19191')
  assert.equal(shouldManageLocalSearxng(managedConfig), true)

  const remoteConfig = normalizeConfigShape({
    searxng: {
      hostPort: 19191,
      baseUrl: 'https://search.example.com',
    },
  })
  assert.equal(shouldManageLocalSearxng(remoteConfig), false)
})

test('normalizeSearxngToolRequest exposes searxng-style request fields directly', () => {
  const config = normalizeConfigShape({
    searxng: {
      defaultEngines: ['google'],
      categories: ['general'],
    },
  })

  const request = normalizeSearxngToolRequest({
    q: 'EverMind AI',
    limit: 5,
    engines: ['google', 'brave'],
    categories: ['general', 'news'],
    language: 'ja',
    pageno: 3,
    time_range: 'month',
    safesearch: 2,
    image_proxy: true,
    enabled_plugins: ['Hash_plugin'],
    disabled_plugins: ['Tracker_URL_remover'],
    enabled_engines: ['google'],
    disabled_engines: ['bing'],
  }, config)

  assert.equal(request.q, 'EverMind AI')
  assert.equal(request.limit, 5)
  assert.deepEqual(request.engines, ['google', 'brave'])
  assert.deepEqual(request.categories, ['general', 'news'])
  assert.equal(request.language, 'ja')
  assert.equal(request.pageno, 3)
  assert.equal(request.time_range, 'month')
  assert.equal(request.safesearch, 2)
  assert.equal(request.image_proxy, true)
  assert.deepEqual(request.enabled_plugins, ['Hash_plugin'])
  assert.deepEqual(request.disabled_plugins, ['Tracker_URL_remover'])
  assert.deepEqual(request.enabled_engines, ['google'])
  assert.deepEqual(request.disabled_engines, ['bing'])
})

test('normalizeSearxngToolRequest falls back to managed defaults and sanitizes invalid values', () => {
  const config = normalizeConfigShape({
    searxng: {
      defaultEngines: ['google'],
      categories: ['general'],
    },
  })

  const request = normalizeSearxngToolRequest({
    q: 'test',
    limit: 99,
    pageno: 0,
    time_range: '30d',
    safesearch: 9,
  }, config)

  assert.equal(request.limit, 10)
  assert.equal(request.pageno, 1)
  assert.equal(request.time_range, '')
  assert.equal(request.safesearch, 1)
  assert.deepEqual(request.engines, ['google'])
  assert.deepEqual(request.categories, ['general'])
  assert.equal(request.language, 'all')
})
