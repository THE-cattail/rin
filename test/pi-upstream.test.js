const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  resolvePiCodingAgentRoot,
  resolvePiCodingAgentModule,
  resolvePiTuiRoot,
  resolvePiTuiModule,
  importPiCodingAgentModule,
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

test('vendored coding-agent exports interactive-mode helper seams', async () => {
  const interactiveMode = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'interactive-mode.js'))

  assert.equal(typeof interactiveMode.buildInteractiveModeStartupInstructions, 'function')
  assert.equal(typeof interactiveMode.buildInteractiveModeAutocompleteCommands, 'function')
  assert.equal(typeof interactiveMode.renderInteractiveMessageHistory, 'function')
})

test('interactive mode source keeps the session-catalog seam for daemon-backed resume flow', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'modes', 'interactive', 'interactive-mode.js'), 'utf8')

  assert.match(source, /sessionCatalogProvider/)
  assert.match(source, /listCurrent/)
  assert.match(source, /openSession/)
})

test('vendored coding-agent exports the rin daemon bridge helper module', async () => {
  const bridge = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'rin-daemon-bridge.js'))

  assert.equal(typeof bridge.ensureCtrlJNewLine, 'function')
  assert.equal(typeof bridge.readRinSessionInfo, 'function')
  assert.equal(typeof bridge.loadRinSessions, 'function')
  assert.equal(typeof bridge.bridgeSessionPath, 'function')
  assert.equal(typeof bridge.parseBridgeSessionPath, 'function')
  assert.equal(bridge.parseBridgeSessionPath(bridge.bridgeSessionPath('koishi:test')), 'koishi:test')
})

test('vendored coding-agent exports the rin daemon mode entry', async () => {
  const daemonMode = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'rin-daemon-mode.js'))

  assert.equal(typeof daemonMode.runRinDaemonTui, 'function')
})

test('rin daemon mode keeps the patch surface minimal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'modes', 'interactive', 'rin-daemon-mode.js'), 'utf8')

  assert.doesNotMatch(source, /new TUI\(/)
  assert.doesNotMatch(source, /new Container\(/)
  assert.doesNotMatch(source, /new CustomEditor\(/)
  assert.doesNotMatch(source, /重试成功/)
  assert.doesNotMatch(source, /'\/help'/)
  assert.doesNotMatch(source, /'\/commands'/)
  assert.match(source, /InteractiveMode/)
  assert.match(source, /'status'/)
  assert.match(source, /'restart'/)
  assert.match(source, /model:\s*this\.model/)
})
