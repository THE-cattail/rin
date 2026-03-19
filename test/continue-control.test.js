const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createContinueEventFilter,
  discardTrailingContinueAssistant,
  extractAssistantTextFromMessage,
  isContinueAssistantMessage,
} = require('../dist/continue-control.js')

const TOKEN = '#RIN_CONTINUE'

function assistantMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  }
}

test('extractAssistantTextFromMessage joins text blocks', () => {
  assert.equal(
    extractAssistantTextFromMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', text: 'ignored' },
        { type: 'text', text: 'world' },
      ],
    }),
    'hello\nworld',
  )
})

test('isContinueAssistantMessage matches continue-only assistant replies', () => {
  assert.equal(isContinueAssistantMessage(assistantMessage(TOKEN), TOKEN), true)
  assert.equal(isContinueAssistantMessage(assistantMessage('done'), TOKEN), false)
})

test('createContinueEventFilter suppresses continue-only assistant output during auto-continue', async () => {
  const delivered = []
  const session = { __rinPromptAutoContinueInternal: true }
  const filter = createContinueEventFilter(session, async (event) => {
    delivered.push(event)
  }, TOKEN)

  await filter({ type: 'message_start', message: assistantMessage('') })
  await filter({
    type: 'message_update',
    message: assistantMessage(''),
    assistantMessageEvent: { type: 'text_delta', delta: '#RIN_' },
  })
  await filter({
    type: 'message_update',
    message: assistantMessage(''),
    assistantMessageEvent: { type: 'text_delta', delta: 'CONTINUE' },
  })
  await filter({ type: 'message_end', message: assistantMessage(TOKEN) })
  await filter({ type: 'agent_end', messages: [assistantMessage(TOKEN)] })

  assert.deepEqual(delivered.map((event) => event.type), ['agent_end'])
})

test('createContinueEventFilter replays buffered message_start for normal assistant replies without deltas', async () => {
  const delivered = []
  const session = { __rinPromptAutoContinueInternal: true }
  const filter = createContinueEventFilter(session, async (event) => {
    delivered.push(event)
  }, TOKEN)

  await filter({ type: 'message_start', message: assistantMessage('') })
  await filter({ type: 'message_end', message: assistantMessage('done') })

  assert.deepEqual(delivered.map((event) => event.type), ['message_start', 'message_end'])
})

test('createContinueEventFilter flushes buffered deltas once the assistant is not sending continue', async () => {
  const delivered = []
  const session = { __rinPromptAutoContinueInternal: true }
  const filter = createContinueEventFilter(session, async (event) => {
    delivered.push(event)
  }, TOKEN)

  await filter({ type: 'message_start', message: assistantMessage('') })
  await filter({
    type: 'message_update',
    message: assistantMessage(''),
    assistantMessageEvent: { type: 'text_delta', delta: '#RIN_' },
  })
  await filter({
    type: 'message_update',
    message: assistantMessage(''),
    assistantMessageEvent: { type: 'text_delta', delta: 'SEND hi' },
  })
  await filter({ type: 'message_end', message: assistantMessage('#RIN_SEND hi') })

  assert.deepEqual(delivered.map((event) => event.type), ['message_start', 'message_update', 'message_update', 'message_end'])
})

test('discardTrailingContinueAssistant rewinds the leaf and agent messages', () => {
  const calls = []
  const session = {
    sessionManager: {
      getLeafEntry: () => ({
        type: 'message',
        parentId: 'parent-1',
        message: assistantMessage(TOKEN),
      }),
      branch: (fromId) => calls.push(['branch', fromId]),
      buildSessionContext: () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }] }),
    },
    agent: {
      replaceMessages: (messages) => calls.push(['replaceMessages', messages]),
    },
  }

  assert.equal(discardTrailingContinueAssistant(session, TOKEN), true)
  assert.deepEqual(calls, [
    ['branch', 'parent-1'],
    ['replaceMessages', [{ role: 'user', content: [{ type: 'text', text: 'work' }] }]],
  ])
})
