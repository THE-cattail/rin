const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_CONFIG,
  normalizeBaseUrl,
  normalizeConfigShape,
  normalizeProviderList,
  reserveSerperFallbackSlot,
} = require('../dist/web-search.js')

test('normalizeProviderList keeps supported providers once and in order', () => {
  assert.deepEqual(
    normalizeProviderList(['SERPER', 'searxng', 'serper', 'unknown'], []),
    ['serper', 'searxng'],
  )
})

test('normalizeBaseUrl canonicalizes scheme and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:18080/'), 'http://127.0.0.1:18080')
  assert.equal(normalizeBaseUrl('https://example.com////'), 'https://example.com')
})

test('normalizeConfigShape upgrades legacy provider order and managed base URL defaults', () => {
  const config = normalizeConfigShape({
    version: 2,
    defaultProviders: ['searxng', 'serper'],
    http: { userAgent: 'Rin web-search skill/1.0' },
    searxng: {
      hostPort: 19090,
      baseUrl: '',
      healthTimeoutMs: 2500,
    },
  })

  assert.equal(config.version, DEFAULT_CONFIG.version)
  assert.deepEqual(config.defaultProviders, DEFAULT_CONFIG.defaultProviders)
  assert.equal(config.http.userAgent, DEFAULT_CONFIG.http.userAgent)
  assert.equal(config.searxng.baseUrl, 'http://127.0.0.1:19090')
  assert.equal(config.searxng.healthTimeoutMs, DEFAULT_CONFIG.searxng.healthTimeoutMs)
})

test('reserveSerperFallbackSlot enforces the hourly fallback budget', () => {
  const state = {}
  const config = {
    serper: {
      maxFallbacksPerHour: 2,
    },
  }

  assert.deepEqual(reserveSerperFallbackSlot(state, config), { ok: true, remaining: 1, limit: 2 })
  assert.deepEqual(reserveSerperFallbackSlot(state, config), { ok: true, remaining: 0, limit: 2 })
  assert.deepEqual(reserveSerperFallbackSlot(state, config), { ok: false, remaining: 0, limit: 2 })
})
