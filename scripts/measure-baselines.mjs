#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await import(path.join(repoRoot, 'dist', 'runtime.js'))

function measureCommand(args, repeats = 3) {
  const samples = []
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now()
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'dist', 'index.js'), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const end = performance.now()
    if (result.status !== 0) {
      throw new Error(`measure_failed:${args.join(' ')}:${(result.stderr || result.stdout || '').trim()}`)
    }
    samples.push(Number((end - start).toFixed(2)))
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  }
}

const promptBlock = runtime.buildRinBuiltinPromptBlock({
  stateRoot: '~/.rin',
  docsRoot: '~/.rin/docs',
})

const report = {
  measuredAt: new Date().toISOString(),
  commandHelp: {
    root: measureCommand(['--help']),
    restart: measureCommand(['restart', '--help']),
    update: measureCommand(['update', '--help']),
    uninstall: measureCommand(['uninstall', '--help']),
  },
  promptBudgets: {
    builtinPromptBlockChars: promptBlock.length,
    continueFollowUpChars: runtime.RIN_CONTINUE_FOLLOWUP.length,
  },
}

console.log(JSON.stringify(report, null, 2))
