const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeAssistantMessageForRin,
} = require('../dist/runtime.js')

function assistantMessage(content) {
  return { role: 'assistant', content }
}

test('normalizeAssistantMessageForRin drops semantically duplicated assistant text blocks', () => {
  const duplicated = 'This is a long enough assistant reply block to be considered for de-duplication.\n\nIt should only appear once.'
  const message = assistantMessage([
    { type: 'thinking', thinking: '', thinkingSignature: 'sig-1' },
    { type: 'text', text: duplicated },
    { type: 'thinking', thinking: '', thinkingSignature: '' },
    { type: 'text', text: `${duplicated}  ` },
  ])

  normalizeAssistantMessageForRin(message)

  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: '', thinkingSignature: 'sig-1' },
    { type: 'text', text: duplicated },
  ])
})

test('normalizeAssistantMessageForRin preserves distinct assistant text blocks', () => {
  const message = assistantMessage([
    { type: 'text', text: 'first block with enough length to avoid accidental dedupe' },
    { type: 'text', text: 'second block with enough length to stay distinct too' },
  ])

  normalizeAssistantMessageForRin(message)

  assert.equal(message.content.length, 2)
  assert.equal(message.content[0].text, 'first block with enough length to avoid accidental dedupe')
  assert.equal(message.content[1].text, 'second block with enough length to stay distinct too')
})
