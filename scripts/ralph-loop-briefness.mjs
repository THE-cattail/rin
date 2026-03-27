import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPiSdkTurn } from '../dist/runtime.js'

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
  {
    name: 'no-preface',
    prompt: '北京是中国首都吗？直接回答，不要铺垫。',
    maxChars: 20,
    banned: ['当然', '是的，', '下面', '首先', '其次', '最后'],
  },
]

function scoreText(text, maxChars, banned) {
  const trimmed = String(text || '').trim()
  const hits = banned.filter((item) => trimmed.includes(item))
  return {
    text: trimmed,
    chars: trimmed.length,
    overLimit: trimmed.length > maxChars,
    bannedHits: hits,
    empty: trimmed.length === 0,
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ralph-loop-script-'))
  const repoRoot = path.join(root, 'repo')
  const workspaceRoot = path.join(os.homedir(), '.rin')
  fs.mkdirSync(repoRoot, { recursive: true })
  const results = []

  for (const c of CASES) {
    const events = []
    const sessionFile = path.join(os.homedir(), '.rin', 'sessions', `ralph-${c.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
    const run = await runPiSdkTurn({
      repoRoot,
      workspaceRoot,
      sessionDir: path.join(os.homedir(), '.rin', 'sessions'),
      sessionFile,
      inputItems: [{ type: 'text', text: c.prompt }],
      timeoutMs: 120000,
      provider: 'openai-codex',
      model: 'gpt-5.4',
      thinking: 'minimal',
      systemPromptExtra: '',
      onEvent: (event) => {
        events.push({
          type: event?.type || '',
          role: event?.message?.role || '',
          assistantMessageEventType: event?.assistantMessageEvent?.type || '',
        })
      },
    })
    results.push({
      name: c.name,
      prompt: c.prompt,
      ...scoreText(run.lastMessage, c.maxChars, c.banned),
      code: run.code,
      turnStatus: run.turnStatus,
      stderr: run.stderr,
      events,
    })
  }

  console.log('\n===== RALPH LOOP BRIEFNESS EVAL START =====\n')
  for (const r of results) {
    console.log(`# ${r.name}`)
    console.log(`PROMPT: ${r.prompt}`)
    console.log(`OUTPUT: ${r.text}`)
    console.log(`CHARS: ${r.chars}`)
    console.log(`EMPTY: ${r.empty}`)
    console.log(`OVER_LIMIT: ${r.overLimit}`)
    console.log(`BANNED_HITS: ${r.bannedHits.join(', ') || '(none)'}`)
    console.log(`CODE: ${r.code}`)
    console.log(`TURN_STATUS: ${r.turnStatus}`)
    console.log(`STDERR: ${r.stderr || '(none)'}`)
    console.log(`EVENTS: ${r.events.map((e) => e.type + (e.assistantMessageEventType ? ':' + e.assistantMessageEventType : '')).join(' | ')}`)
    console.log('')
  }
  console.log('===== RALPH LOOP BRIEFNESS EVAL END =====\n')

  const failed = results.filter((r) => r.code !== 0 || r.empty || r.overLimit || r.bannedHits.length > 0)
  if (failed.length) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
