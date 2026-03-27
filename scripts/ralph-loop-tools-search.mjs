import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPiSdkTurn } from '../dist/runtime.js'

const BANNED = ['当然', '下面', '首先', '其次', '最后', '希望这对你有帮助']

function scoreText(text, maxChars = 80) {
  const trimmed = String(text || '').trim()
  const hits = BANNED.filter((item) => trimmed.includes(item))
  const lineCount = trimmed ? trimmed.split(/\n+/).length : 0
  const bulletish = /^[-*\d]+[.)\s]/m.test(trimmed)
  return {
    text: trimmed,
    chars: trimmed.length,
    empty: trimmed.length === 0,
    overLimit: trimmed.length > maxChars,
    bannedHits: hits,
    lineCount,
    bulletish,
  }
}

async function runCase({ repoRoot, workspaceRoot, name, prompt, maxChars = 80 }) {
  const sessionFile = path.join(os.homedir(), '.rin', 'sessions', `ralph-tools-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  const events = []
  const run = await runPiSdkTurn({
    repoRoot,
    workspaceRoot,
    sessionDir: path.join(os.homedir(), '.rin', 'sessions'),
    sessionFile,
    inputItems: [{ type: 'text', text: prompt }],
    timeoutMs: 180000,
    provider: 'openai-codex',
    model: 'gpt-5.4',
    thinking: 'minimal',
    systemPromptExtra: '',
    onEvent: (event) => {
      events.push({
        type: event?.type || '',
        role: event?.message?.role || '',
        toolName: event?.toolCall?.name || event?.toolResult?.name || '',
        assistantMessageEventType: event?.assistantMessageEvent?.type || '',
      })
    },
  })
  return {
    name,
    prompt,
    ...scoreText(run.lastMessage, maxChars),
    code: run.code,
    turnStatus: run.turnStatus,
    stderr: run.stderr,
    toolsUsed: [...new Set(events.map((e) => e.toolName).filter(Boolean))],
    eventSummary: events.map((e) => e.type + (e.toolName ? ':' + e.toolName : '') + (e.assistantMessageEventType ? ':' + e.assistantMessageEventType : '')).join(' | '),
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-ralph-tools-'))
  const repoRoot = path.join(root, 'repo')
  const workspaceRoot = path.join(os.homedir(), '.rin')
  fs.mkdirSync(repoRoot, { recursive: true })

  const sandboxDir = path.join(os.homedir(), '.rin', 'tmp', 'ralph-tools-search')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.writeFileSync(path.join(sandboxDir, 'note.txt'), '项目代号是 Blue River。', 'utf8')
  fs.writeFileSync(path.join(sandboxDir, 'status.json'), JSON.stringify({ ok: true, count: 3 }), 'utf8')

  const cases = [
    {
      name: 'read-file-summary',
      prompt: `读一下 ${path.join(os.homedir(), '.rin', 'tmp', 'ralph-tools-search', 'note.txt')}，然后告诉我项目代号是什么。`,
      maxChars: 24,
    },
    {
      name: 'read-json-answer',
      prompt: `看一下 ${path.join(os.homedir(), '.rin', 'tmp', 'ralph-tools-search', 'status.json')}，count 是多少？`,
      maxChars: 16,
    },
    {
      name: 'bash-list-answer',
      prompt: `列一下 ${path.join(os.homedir(), '.rin', 'tmp', 'ralph-tools-search')} 里有哪些文件，只要简短回答。`,
      maxChars: 40,
    },
    {
      name: 'web-search-fact',
      prompt: '帮我查一下今天黄金价格走势，用一句话概括。',
      maxChars: 60,
    },
  ]

  const results = []
  for (const c of cases) results.push(await runCase({ repoRoot, workspaceRoot, ...c }))

  console.log('\n===== RALPH LOOP TOOLS+SEARCH EVAL START =====\n')
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
    console.log(`TOOLS_USED: ${r.toolsUsed.join(', ') || '(none)'}`)
    console.log(`CODE: ${r.code}`)
    console.log(`TURN_STATUS: ${r.turnStatus}`)
    console.log(`STDERR: ${r.stderr || '(none)'}`)
    console.log('')
  }
  console.log('===== RALPH LOOP TOOLS+SEARCH EVAL END =====\n')

  const failed = results.filter((r) => r.code !== 0 || r.empty || r.overLimit || r.bannedHits.length > 0 || r.lineCount > 2 || r.bulletish)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
