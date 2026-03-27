import path from 'node:path'
import os from 'node:os'
import { runPiSdkTurn } from '../dist/runtime.js'

const prompt = '阅读一下 ~/rin-src 和 ~/rin-v2-src，理解一下项目现状'

const result = await runPiSdkTurn({
  repoRoot: path.join(os.homedir(), 'rin-src'),
  workspaceRoot: path.join(os.homedir(), '.rin'),
  sessionDir: path.join(os.homedir(), '.rin', 'sessions'),
  sessionFile: path.join(os.homedir(), '.rin', 'sessions', `ralph-repro-${Date.now()}.jsonl`),
  inputItems: [{ type: 'text', text: prompt }],
  timeoutMs: 180000,
  provider: 'openai-codex',
  model: 'gpt-5.4',
  thinking: 'minimal',
  systemPromptExtra: '',
})

console.log('\n===== REPRO TASK =====\n')
console.log('PROMPT:', prompt)
console.log('TURN_STATUS:', result.turnStatus)
console.log('OUTPUT:\n' + (result.lastMessage || ''))
console.log('\n===== END =====\n')
if (!result.lastMessage) process.exitCode = 1
