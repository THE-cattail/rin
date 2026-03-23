const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('daemon bridge keeps botId when routing koishi chat sends', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.ts'), 'utf8')

  assert.match(source, /runBridgeReplyTurn\(\{[\s\S]*?parsed: \{ platform, botId, chatId \}/)
})
