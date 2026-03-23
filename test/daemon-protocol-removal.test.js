const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('daemon bridge no longer keeps protocol violation retries or state field', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.ts'), 'utf8')

  assert.doesNotMatch(source, /bridgeProtocolRetryCount/)
  assert.doesNotMatch(source, /protocol violation chatKey=/)
  assert.doesNotMatch(source, /kind:\s*'protocol_violation'/)
})
