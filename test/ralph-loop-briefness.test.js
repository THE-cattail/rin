const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runPiSdkTurn } = require('../dist/runtime.js')

const CASES = [
  {
    name: 'simple-yes-no',
    prompt: '2+2 等于 4 吗？只回答是或不是。',
    maxChars: 12,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
  {
    name: 'one-word-choice',
    prompt: '苹果和香蕉，选一个。只输出你选的那个词。',
    maxChars: 12,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
  {
    name: 'short-direct-answer',
    prompt: '用一句话回答：为什么下雨天路会滑？',
    maxChars: 40,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
]

function scoreText(text, maxChars, banned) {
  const trimmed = String(text || '').trim()
  const hit = banned.filter((item) => trimmed.includes(item))
  return {
    text: trimmed,
    chars: trimmed.length,
    overLimit: trimmed.length > maxChars,
    bannedHits: hit,
  }
}

test('ralph loop briefness eval prints outputs and fails on verbose drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ralph-loop-'))
  const repoRoot = path.join(root, 'repo')
  const workspaceRoot = path.join(os.homedir(), '.rin')
  fs.mkdirSync(repoRoot, { recursive: true })

  const results = []
  for (const c of CASES) {
    const run = await runPiSdkTurn({
      repoRoot,
      workspaceRoot,
      sessionDir: path.join(os.homedir(), '.rin', 'sessions'),
      sessionFile: path.join(os.homedir(), '.rin', 'sessions', `ralph-loop-${c.name}-${Date.now()}.jsonl`),
      inputItems: [{ type: 'text', text: c.prompt }],
      timeoutMs: 120000,
      provider: 'openai-codex',
      model: 'gpt-5.4',
      thinking: 'minimal',
      systemPromptExtra: '',
    })
    const scored = scoreText(run.lastMessage, c.maxChars, c.banned)
    results.push({
      name: c.name,
      prompt: c.prompt,
      ...scored,
      code: run.code,
      turnStatus: run.turnStatus,
      stderr: run.stderr,
    })
  }

  console.log('\n===== RALPH LOOP BRIEFNESS EVAL START =====\n')
  for (const r of results) {
    console.log(`# ${r.name}`)
    console.log(`PROMPT: ${r.prompt}`)
    console.log(`OUTPUT: ${r.text}`)
    console.log(`CHARS: ${r.chars}`)
    console.log(`OVER_LIMIT: ${r.overLimit}`)
    console.log(`BANNED_HITS: ${r.bannedHits.join(', ') || '(none)'}`)
    console.log(`CODE: ${r.code}`)
    console.log(`TURN_STATUS: ${r.turnStatus}`)
    console.log(`STDERR: ${r.stderr || '(none)'}`)
    console.log('')
  }
  console.log('===== RALPH LOOP BRIEFNESS EVAL END =====\n')

  for (const r of results) {
    assert.equal(r.code, 0, `model call failed for ${r.name}: ${r.stderr}`)
    assert.equal(r.text.length > 0, true, `${r.name} returned empty output; turnStatus=${r.turnStatus}; stderr=${r.stderr}`)
    assert.equal(r.overLimit, false, `${r.name} too long: ${r.text}`)
    assert.deepEqual(r.bannedHits, [], `${r.name} contains banned phrases: ${r.text}`)
  }

  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
})
