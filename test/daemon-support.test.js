const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildDaemonConfigFromSettings,
  findPluginConfig,
  listChatStateFiles,
  materializeDaemonConfig,
  ownerChatKeysFromIdentity,
  parseChatKey,
  preferredOwnerChatKey,
  sendTextToOwners,
} = require('../dist/daemon-support.js')

test('buildDaemonConfigFromSettings materializes enabled adapters with defaults', () => {
  const config = buildDaemonConfigFromSettings({
    koishi: {
      onebot: { endpoint: 'ws://example.test', selfId: '123' },
      telegram: { token: 'abc', slash: false },
    },
  })

  assert.equal(config.name, 'rin')
  assert.deepEqual(config.prefix, ['/'])
  assert.equal(config.plugins['adapter-onebot'].protocol, 'ws')
  assert.equal(config.plugins['adapter-onebot'].endpoint, 'ws://example.test')
  assert.equal(config.plugins['adapter-telegram'].protocol, 'polling')
  assert.equal(config.plugins['adapter-telegram'].slash, false)
})

test('findPluginConfig matches aliased plugin keys', () => {
  const plugin = { token: 'x' }
  assert.equal(findPluginConfig({ '~adapter-telegram:main': plugin }, 'adapter-telegram'), plugin)
  assert.equal(findPluginConfig({ http: {} }, 'adapter-telegram'), null)
})

test('parseChatKey parses platform-prefixed chat keys', () => {
  assert.deepEqual(parseChatKey('telegram:123'), { platform: 'telegram', chatId: '123' })
  assert.equal(parseChatKey('missing-separator'), null)
})

test('ownerChatKeysFromIdentity and preferredOwnerChatKey normalize owner aliases', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-owner-'))
  fs.writeFileSync(path.join(tempDir, 'identity.json'), JSON.stringify({
    aliases: [
      { personId: 'owner', platform: 'telegram', userId: '42' },
      { personId: 'owner', platform: 'onebot', userId: '99' },
      { personId: 'guest', platform: 'telegram', userId: '100' },
    ],
  }, null, 2))

  assert.deepEqual(ownerChatKeysFromIdentity(tempDir).sort(), ['onebot:private:99', 'telegram:42'])
  assert.equal(preferredOwnerChatKey(tempDir), 'onebot:private:99')
})

test('listChatStateFiles discovers persisted chat states', () => {
  const chatsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-chats-'))
  const chatPath = path.join(chatsRoot, 'telegram', '123')
  fs.mkdirSync(chatPath, { recursive: true })
  fs.writeFileSync(path.join(chatPath, 'state.json'), '{}')

  assert.deepEqual(listChatStateFiles(chatsRoot), [
    { platform: 'telegram', chatId: '123', statePath: path.join(chatPath, 'state.json') },
  ])
})

test('materializeDaemonConfig writes koishi config yaml', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-config-'))
  const configPath = path.join(tempDir, 'koishi.yml')
  const result = materializeDaemonConfig(configPath, {
    koishi: {
      telegram: { token: 'secret-token' },
    },
  })

  assert.equal(result.configPath, configPath)
  const text = fs.readFileSync(configPath, 'utf8')
  assert.match(text, /adapter-telegram/)
  assert.match(text, /secret-token/)
})

test('sendTextToOwners fans out to preferred owner aliases', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-send-'))
  fs.writeFileSync(path.join(tempDir, 'identity.json'), JSON.stringify({
    aliases: [
      { personId: 'owner', platform: 'telegram', userId: '42' },
      { personId: 'owner', platform: 'onebot', userId: '99' },
    ],
  }, null, 2))

  const sent = []
  const app = {
    bots: [
      { platform: 'telegram', sendMessage: async (chatId, text) => sent.push(['telegram', chatId, text]) },
      { platform: 'onebot', sendMessage: async (chatId, text) => sent.push(['onebot', chatId, text]) },
    ],
  }

  const result = await sendTextToOwners(app, tempDir, { text: 'hello', timeoutMs: 2000 })
  assert.equal(result.ok, true)
  assert.deepEqual(sent.sort(), [
    ['onebot', 'private:99', 'hello'],
    ['telegram', '42', 'hello'],
  ])
})
