const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildDaemonConfigFromSettings,
  composeChatKey,
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
      onebot: [
        { endpoint: 'ws://example.test', selfId: '123' },
        { name: 'backup', endpoint: 'ws://example-2.test', selfId: '456' },
      ],
      telegram: { token: 'abc', slash: false },
    },
  })

  assert.equal(config.name, 'rin')
  assert.deepEqual(config.prefix, ['/'])
  assert.equal(config.plugins['adapter-onebot'].protocol, 'ws')
  assert.equal(config.plugins['adapter-onebot'].endpoint, 'ws://example.test')
  assert.equal(config.plugins['adapter-onebot:backup'].selfId, '456')
  assert.equal(config.plugins['adapter-telegram'].protocol, 'polling')
  assert.equal(config.plugins['adapter-telegram'].slash, false)
})

test('findPluginConfig matches aliased plugin keys', () => {
  const plugin = { token: 'x' }
  assert.equal(findPluginConfig({ '~adapter-telegram:main': plugin }, 'adapter-telegram'), plugin)
  assert.equal(findPluginConfig({ http: {} }, 'adapter-telegram'), null)
})

test('parseChatKey parses platform-prefixed chat keys', () => {
  assert.deepEqual(parseChatKey('telegram:123'), { platform: 'telegram', botId: '', chatId: '123' })
  assert.deepEqual(parseChatKey('telegram/777:123'), { platform: 'telegram', botId: '777', chatId: '123' })
  assert.equal(composeChatKey('telegram', '123', '777'), 'telegram/777:123')
  assert.equal(parseChatKey('missing-separator'), null)
})

test('ownerChatKeysFromIdentity and preferredOwnerChatKey normalize owner aliases', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-owner-'))
  fs.writeFileSync(path.join(tempDir, 'identity.json'), JSON.stringify({
    aliases: [
      { personId: 'owner', platform: 'telegram', userId: '42', botId: '777' },
      { personId: 'owner', platform: 'onebot', userId: '99', botId: '123' },
      { personId: 'guest', platform: 'telegram', userId: '100' },
    ],
  }, null, 2))

  assert.deepEqual(ownerChatKeysFromIdentity(tempDir).sort(), ['onebot/123:private:99', 'telegram/777:42'])
  assert.equal(preferredOwnerChatKey(tempDir), 'onebot/123:private:99')
})

test('listChatStateFiles discovers persisted chat states', () => {
  const chatsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-daemon-chats-'))
  const legacyChatPath = path.join(chatsRoot, 'telegram', '123')
  const botScopedChatPath = path.join(chatsRoot, 'telegram', '777', '456')
  fs.mkdirSync(legacyChatPath, { recursive: true })
  fs.mkdirSync(botScopedChatPath, { recursive: true })
  fs.writeFileSync(path.join(legacyChatPath, 'state.json'), '{}')
  fs.writeFileSync(path.join(botScopedChatPath, 'state.json'), '{}')

  assert.deepEqual(listChatStateFiles(chatsRoot), [
    { platform: 'telegram', chatId: '123', statePath: path.join(legacyChatPath, 'state.json') },
    { platform: 'telegram', botId: '777', chatId: '456', statePath: path.join(botScopedChatPath, 'state.json') },
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
      { personId: 'owner', platform: 'telegram', userId: '42', botId: '777' },
      { personId: 'owner', platform: 'onebot', userId: '99', botId: '123' },
    ],
  }, null, 2))

  const sent = []
  const app = {
    bots: [
      { platform: 'telegram', selfId: '777', sendMessage: async (chatId, text) => sent.push(['telegram', '777', chatId, text]) },
      { platform: 'onebot', selfId: '123', sendMessage: async (chatId, text) => sent.push(['onebot', '123', chatId, text]) },
    ],
  }

  const result = await sendTextToOwners(app, tempDir, { text: 'hello', timeoutMs: 2000 })
  assert.equal(result.ok, true)
  assert.deepEqual(sent.sort(), [
    ['onebot', '123', 'private:99', 'hello'],
    ['telegram', '777', '42', 'hello'],
  ])
})
