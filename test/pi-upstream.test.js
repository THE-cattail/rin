const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  resolvePiCodingAgentRoot,
  resolvePiCodingAgentModule,
  resolvePiTuiRoot,
  resolvePiTuiModule,
} = require('../dist/pi-upstream.js')

test('pi upstream helper resolves the vendored coding-agent package', () => {
  const codingRoot = resolvePiCodingAgentRoot()

  assert.equal(codingRoot, path.resolve(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'coding-agent'))
  assert.match(resolvePiCodingAgentModule(), /third_party\/pi-mono\/packages\/coding-agent\/dist\/index\.js$/)
})

test('pi upstream helper resolves the vendored tui package', () => {
  const tuiRoot = resolvePiTuiRoot()

  assert.equal(tuiRoot, path.resolve(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'tui'))
  assert.match(resolvePiTuiModule(), /third_party\/pi-mono\/packages\/tui\/dist\/index\.js$/)
})
