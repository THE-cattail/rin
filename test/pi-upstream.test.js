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
  assert.doesNotMatch(source, /clearQueue\(\)\s*\{\s*return this\.client\.clearQueue\(\)\.then/)
  assert.doesNotMatch(source, /this\.steeringMessages/)
  assert.doesNotMatch(source, /this\.followUpMessages/)
  assert.doesNotMatch(source, /bridgeSessionPath\(/)
  assert.doesNotMatch(source, /parseBridgeSessionPath\(/)
  assert.doesNotMatch(source, /koishi:/)
  assert.match(source, /InteractiveMode/)
  assert.match(source, /'status'/)
  assert.match(source, /'restart'/)
  assert.match(source, /model:\s*this\.model/)
  assert.match(source, /clearQueue\(\)\s*\{\s*const steering = Array\.isArray\(this\.currentState && this\.currentState\.steeringMessages\)/)
})

test('interactive mode still relies on a synchronous clearQueue contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'modes', 'interactive', 'interactive-mode.js'), 'utf8')

  assert.match(source, /const \{ steering, followUp \} = this\.session\.clearQueue\(\);/)
  assert.doesNotMatch(source, /Array\.isArray\(cleared\?\.steering\)/)
})

test('offline tui host keeps native interactive mode while enabling Rin local hooks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tui-debug.ts'), 'utf8')

  assert.match(source, /import \{ importPiCodingAgentModule, importPiTuiModule \} from '\.\/pi-upstream'/)
  assert.match(source, /import \{ createRinTuiSession \} from '\.\/runtime'/)
  assert.match(source, /new pi\.InteractiveMode\(session/)
  assert.match(source, /enableBrainHooks: false/)
  assert.doesNotMatch(source, /DaemonTuiRpcClient/)
  assert.doesNotMatch(source, /session\.bindExtensions\(/)
})

test('daemon tui rpc and offline share the same Rin TUI session assembly helper', () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime.ts'), 'utf8')
  const rpcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon-tui-rpc.ts'), 'utf8')
  const offlineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'tui-debug.ts'), 'utf8')

  assert.match(runtimeSource, /async function createRinTuiSession\(/)
  assert.match(rpcSource, /import \{ createRinTuiSession \} from '\.\/runtime'/)
  assert.match(offlineSource, /import \{ createRinTuiSession \} from '\.\/runtime'/)
  assert.doesNotMatch(rpcSource, /import \{ createRinPiSession \} from '\.\/runtime'/)
  assert.doesNotMatch(offlineSource, /import \{ createRinPiSession \} from '\.\/runtime'/)
})

test('daemon tui session catalog flattens bridge-bound sessions into normal session entries', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'third_party', 'pi-mono', 'packages', 'coding-agent', 'dist', 'modes', 'interactive', 'rin-daemon-mode.js'), 'utf8')

  assert.match(source, /const mergeSessions = \(localSessions, bridgeSessions\)/)
  assert.match(source, /boundChatKeys/)
  assert.match(source, /await client\.openSession\(sessionPath\)/)
  assert.match(source, /normalizeSessionPath\(session\.currentState && session\.currentState\.sessionFile\)/)
  assert.doesNotMatch(source, /bridgeSessionPath\(/)
  assert.doesNotMatch(source, /parseBridgeSessionPath\(/)
})
