const test = require('node:test')
const assert = require('node:assert/strict')

const {
  isStreamingBehaviorRequiredError,
  promptSessionWithRetry,
} = require('../dist/session-prompt.js')

test('detects SDK queueing error messages', () => {
  assert.equal(isStreamingBehaviorRequiredError(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")), true)
  assert.equal(isStreamingBehaviorRequiredError(new Error('different failure')), false)
})

test('promptSessionWithRetry sends the prompt directly when the session is idle', async () => {
  const calls = []
  const session = {
    agent: {
      waitForIdle: async () => {
        throw new Error('waitForIdle should not run for direct prompts')
      },
    },
  }

  const result = await promptSessionWithRetry(session, async (text, options) => {
    calls.push({ text, options })
  }, 'hello', { images: [{ type: 'image' }] })

  assert.equal(result.mode, 'direct')
  assert.deepEqual(calls, [
    {
      text: 'hello',
      options: { images: [{ type: 'image' }] },
    },
  ])
})

test('promptSessionWithRetry falls back to followUp queueing and waits for idle', async () => {
  const calls = []
  let waitForIdleCount = 0
  const session = {
    agent: {
      waitForIdle: async () => {
        waitForIdleCount += 1
      },
    },
  }

  const result = await promptSessionWithRetry(session, async (text, options = {}) => {
    calls.push({ text, options })
    if (!options.streamingBehavior) {
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")
    }
  }, 'continue', { images: [{ type: 'image' }] })

  assert.equal(result.mode, 'followUp')
  assert.equal(waitForIdleCount, 1)
  assert.deepEqual(calls, [
    {
      text: 'continue',
      options: { images: [{ type: 'image' }] },
    },
    {
      text: 'continue',
      options: { images: [{ type: 'image' }], streamingBehavior: 'followUp' },
    },
  ])
})

test('promptSessionWithRetry preserves unrelated failures', async () => {
  const session = {}
  await assert.rejects(
    () => promptSessionWithRetry(session, async () => {
      throw new Error('network_failed')
    }, 'hello'),
    /network_failed/,
  )
})
