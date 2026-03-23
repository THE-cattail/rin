const test = require('node:test')
const assert = require('node:assert/strict')

const runtime = require('../dist/runtime.js')

test('dist runtime exports createRinTuiSession for TUI entrypoints', () => {
  assert.equal(typeof runtime.createRinTuiSession, 'function')
})
