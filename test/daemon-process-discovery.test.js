const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('daemon process discovery covers installed release daemons across release swaps', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')

  assert.match(source, /app', 'current', 'dist', 'daemon\.js'/)
  assert.match(source, /app', 'releases'/)
})
