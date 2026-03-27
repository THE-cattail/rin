import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPiSdkTurn } from '../dist/runtime.js'

const CASES = [
  {
    name: 'neutral-fact',
    prompt: '北京是中国首都吗？',
    maxChars: 12,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助', '是的，北京'],
  },
  {
    name: 'neutral-cause',
    prompt: '为什么雨天路会滑？',
    maxChars: 32,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
  {
    name: 'neutral-choice',
    prompt: '苹果和香蕉哪个好带出门？',
    maxChars: 28,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
  {
    name: 'neutral-fix',
    prompt: '命令找不到 usually 是什么问题？',
    maxChars: 42,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
  {
    name: 'neutral-translate',
    prompt: '把 hello 翻成中文。',
    maxChars: 8,
    banned: ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助'],
  },
]

function scoreText(text, maxChars, banned) {
  const trimmed = String(text || '').trim()
  const hits = banned.filter((item) => trimmed.includes(item))
  const lineCount = trimmed ? trimmed.split(/\n+/).length : 0
  const bulletish = /^[-*\d]+[.)\s]/m.test(trimmed)
  return {
    text: trimmed,
    chars: trimmed.length,
    overLimit: trimmed.length > maxChars,
    bannedHits: hits,
    empty: trimmed.length === 0,
    lineCount,
    bulletish,
  }
}

async function runCase(repoRoot, workspaceRoot, c) {
  const events = []
  const sessionFile = path.join(os.homedir(), '.rin', 'sessions', `ralph-default-${c.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
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
  return {
    name: c.name,
    prompt: c.prompt,
    ...scoreText(run.lastMessage, c.maxChars, c.banned),
    code: run.code,
    turnStatus: run.turnStatus,
    stderr: run.stderr,
    events,
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ralph-default-'))
  const repoRoot = path.join(root, 'repo')
  const workspaceRoot = path.join(os.homedir(), '.rin')
  fs.mkdirSync(repoRoot, { recursive: true })
  const results = []

  for (const c of CASES) results.push(await runCase(repoRoot, workspaceRoot, c))

  console.log('\n===== RALPH LOOP DEFAULT BRIEFNESS EVAL START =====\n')
  for (const r of results) {
    console.log(`# ${r.name}`)
    console.log(`PROMPT: ${r.prompt}`)
    console.log(`OUTPUT: ${r.text}`)
    console.log(`CHARS: ${r.chars}`)
    console.log(`EMPTY: ${r.empty}`)
    console.log(`OVER_LIMIT: ${r.overLimit}`)
    console.log(`BANNED_HITS: ${r.bannedHits.join(', ') || '(none)'}`)
    console.log(`LINES: ${r.lineCount}`)
    console.log(`BULLETISH: ${r.bulletish}`)
    console.log(`CODE: ${r.code}`)
    console.log(`TURN_STATUS: ${r.turnStatus}`)
    console.log(`STDERR: ${r.stderr || '(none)'}`)
    console.log('')
  }
  console.log('===== RALPH LOOP DEFAULT BRIEFNESS EVAL END =====\n')

  const failed = results.filter((r) => r.code !== 0 || r.empty || r.overLimit || r.bannedHits.length > 0 || r.lineCount > 2 || r.bulletish)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
