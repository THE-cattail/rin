const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildRinBuiltinPromptBlock,
  RIN_CONTINUE_FOLLOWUP,
} = require('../dist/runtime.js')

test('builtin runtime prompt block stays compact', () => {
  const block = buildRinBuiltinPromptBlock({
    stateRoot: '/tmp/.rin',
    docsRoot: '/tmp/.rin/docs',
  })

  assert.equal(typeof block, 'string')
  assert.ok(block.length <= 140, `expected compact runtime prompt block, got ${block.length} chars`)
  assert.ok(!block.includes('README:'), 'runtime prompt block should avoid duplicated docs paths')
  assert.ok(!block.includes('Examples:'), 'runtime prompt block should avoid duplicated docs paths')
})

test('continue follow-up prompt stays short', () => {
  assert.ok(RIN_CONTINUE_FOLLOWUP.length <= 90, `expected short continue follow-up prompt, got ${RIN_CONTINUE_FOLLOWUP.length} chars`)
})
