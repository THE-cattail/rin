#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function safeString(value) {
  return value == null ? '' : String(value)
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseArgs(argv) {
  const out = {
    days: 7,
    limit: 10,
    json: false,
    root: '',
    writeLatest: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--days') out.days = Math.max(1, safeNumber(argv[++i], 7))
    else if (arg === '--limit') out.limit = Math.max(1, safeNumber(argv[++i], 10))
    else if (arg === '--root') out.root = safeString(argv[++i]).trim()
    else if (arg === '--json') out.json = true
    else if (arg === '--write-latest') out.writeLatest = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function resolveObservabilityRoot(override = '') {
  if (override) return path.resolve(override)
  const envHome = safeString(process.env.RIN_HOME).trim()
  const homeRoot = envHome
    ? path.resolve(envHome.startsWith('~/') ? path.join(os.homedir(), envHome.slice(2)) : envHome)
    : path.join(os.homedir(), '.rin')
  return path.join(homeRoot, 'observability', 'provider-usage')
}

function collectJsonlFiles(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(fullPath)
    }
  }
  walk(dir)
  return out.sort()
}

function loadRows(root, cutoffMs) {
  const rows = []
  for (const filePath of collectJsonlFiles(root)) {
    const text = fs.readFileSync(filePath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        const ts = Date.parse(safeString(row && row.observedAt))
        if (!Number.isFinite(ts) || ts < cutoffMs) continue
        rows.push(row)
      } catch {}
    }
  }
  rows.sort((a, b) => Date.parse(safeString(a.observedAt)) - Date.parse(safeString(b.observedAt)))
  return rows
}

function emptyTotals() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
    inputTextChars: 0,
    assistantMessages: 0,
    toolResultBlocks: 0,
    compactionItems: 0,
    promptApproxBytes: 0,
    heavyPromptRequests: 0,
    inputItems: 0,
    messageItems: 0,
    nonMessageItems: 0,
    reasoningItems: 0,
    functionCallItems: 0,
    functionCallOutputItems: 0,
  }
}

function countEntry(list, key) {
  const items = Array.isArray(list) ? list : []
  const found = items.find((item) => safeString(item && item.key).trim() === key)
  return safeNumber(found && found.value)
}

function addTotals(target, row) {
  const usage = row && row.usage && typeof row.usage === 'object' ? row.usage : {}
  const prompt = row && row.prompt && typeof row.prompt === 'object' ? row.prompt : {}
  const derived = row && row.derived && typeof row.derived === 'object' ? row.derived : {}
  target.requests += 1
  target.input += safeNumber(usage.input)
  target.output += safeNumber(usage.output)
  target.cacheRead += safeNumber(usage.cacheRead)
  target.cacheWrite += safeNumber(usage.cacheWrite)
  target.totalTokens += safeNumber(usage.totalTokens)
  target.costTotal += safeNumber(usage.costTotal)
  target.inputTextChars += safeNumber(prompt.inputTextChars)
  target.assistantMessages += safeNumber(prompt.assistantMessages)
  target.toolResultBlocks += safeNumber(prompt.inputToolResultBlocks)
  target.compactionItems += safeNumber(prompt.compactionItems)
  target.promptApproxBytes += safeNumber(row.payloadApproxBytes)
  target.heavyPromptRequests += derived.hasHeavyPrompt ? 1 : 0
  target.inputItems += safeNumber(prompt.inputItems)
  target.messageItems += safeNumber(prompt.messageItems)
  target.nonMessageItems += safeNumber(prompt.nonMessageItems)
  target.reasoningItems += countEntry(prompt.itemTypes, 'reasoning')
  target.functionCallItems += countEntry(prompt.itemTypes, 'function_call')
  target.functionCallOutputItems += countEntry(prompt.itemTypes, 'function_call_output')
  return target
}

function finalizeTotals(totals) {
  const requests = Math.max(1, safeNumber(totals.requests, 0))
  return {
    ...totals,
    avgInput: totals.input / requests,
    avgOutput: totals.output / requests,
    avgTotalTokens: totals.totalTokens / requests,
    avgCostTotal: totals.costTotal / requests,
    cacheReadShare: totals.input > 0 ? totals.cacheRead / totals.input : 0,
    avgAssistantMessages: totals.assistantMessages / requests,
    avgToolResultBlocks: totals.toolResultBlocks / requests,
    avgPromptApproxBytes: totals.promptApproxBytes / requests,
    avgInputItems: totals.inputItems / requests,
    avgMessageItems: totals.messageItems / requests,
    avgNonMessageItems: totals.nonMessageItems / requests,
    avgReasoningItems: totals.reasoningItems / requests,
    avgFunctionCallItems: totals.functionCallItems / requests,
    avgFunctionCallOutputItems: totals.functionCallOutputItems / requests,
  }
}

function groupTop(rows, keyFn, limit) {
  const map = new Map()
  for (const row of rows) {
    const key = keyFn(row)
    if (!key) continue
    if (!map.has(key)) map.set(key, emptyTotals())
    addTotals(map.get(key), row)
  }
  return Array.from(map.entries())
    .map(([key, totals]) => ({ key, totals: finalizeTotals(totals) }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests)
    .slice(0, limit)
}

function summarizeRows(rows, limit) {
  const totals = finalizeTotals(rows.reduce((acc, row) => addTotals(acc, row), emptyTotals()))
  const topModels = groupTop(rows, (row) => `${safeString(row.provider).trim() || 'unknown'}/${safeString(row.model).trim() || 'unknown'}`, limit)
  const topSessions = groupTop(rows, (row) => safeString(row && row.session && row.session.sessionFileBase).trim() || safeString(row && row.session && row.session.sessionId).trim(), limit)
  const suspicious = rows
    .map((row) => ({
      observedAt: safeString(row.observedAt),
      provider: safeString(row.provider),
      model: safeString(row.model),
      sessionFile: safeString(row && row.session && row.session.sessionFileBase),
      input: safeNumber(row && row.usage && row.usage.input),
      output: safeNumber(row && row.usage && row.usage.output),
      cacheRead: safeNumber(row && row.usage && row.usage.cacheRead),
      costTotal: safeNumber(row && row.usage && row.usage.costTotal),
      assistantMessages: safeNumber(row && row.prompt && row.prompt.assistantMessages),
      toolResultBlocks: safeNumber(row && row.prompt && row.prompt.inputToolResultBlocks),
      compactionItems: safeNumber(row && row.prompt && row.prompt.compactionItems),
      inputItems: safeNumber(row && row.prompt && row.prompt.inputItems),
      messageItems: safeNumber(row && row.prompt && row.prompt.messageItems),
      nonMessageItems: safeNumber(row && row.prompt && row.prompt.nonMessageItems),
      reasoningItems: countEntry(row && row.prompt && row.prompt.itemTypes, 'reasoning'),
      functionCallItems: countEntry(row && row.prompt && row.prompt.itemTypes, 'function_call'),
      functionCallOutputItems: countEntry(row && row.prompt && row.prompt.itemTypes, 'function_call_output'),
      promptApproxBytes: safeNumber(row && row.payloadApproxBytes),
      hasHeavyPrompt: Boolean(row && row.derived && row.derived.hasHeavyPrompt),
    }))
    .sort((a, b) => b.input - a.input || b.promptApproxBytes - a.promptApproxBytes)
    .slice(0, limit)

  const daily = groupTop(rows, (row) => safeString(row.observedAt).slice(0, 10), limit * 3)
  return { totals, topModels, topSessions, suspicious, daily }
}

function formatInt(n) {
  return Math.round(safeNumber(n)).toLocaleString('en-US')
}

function formatMoney(n) {
  return safeNumber(n).toFixed(4)
}

function formatPct(n) {
  return `${(safeNumber(n) * 100).toFixed(1)}%`
}

function renderText(summary, opts) {
  const lines = []
  lines.push(`# Token usage report (${opts.days}d)`)
  lines.push('')
  lines.push(`- requests: ${formatInt(summary.totals.requests)}`)
  lines.push(`- input tokens: ${formatInt(summary.totals.input)}`)
  lines.push(`- output tokens: ${formatInt(summary.totals.output)}`)
  lines.push(`- cache read tokens: ${formatInt(summary.totals.cacheRead)} (${formatPct(summary.totals.cacheReadShare)})`)
  lines.push(`- total tokens: ${formatInt(summary.totals.totalTokens)}`)
  lines.push(`- cost: ${formatMoney(summary.totals.costTotal)}`)
  lines.push(`- avg/request: in ${formatInt(summary.totals.avgInput)}, out ${formatInt(summary.totals.avgOutput)}, total ${formatInt(summary.totals.avgTotalTokens)}`)
  lines.push(`- avg prompt shape: ${formatInt(summary.totals.avgInputItems)} items, ${formatInt(summary.totals.avgMessageItems)} message items, ${formatInt(summary.totals.avgNonMessageItems)} non-message items`)
  lines.push(`- avg tool/reasoning items: calls ${formatInt(summary.totals.avgFunctionCallItems)}, outputs ${formatInt(summary.totals.avgFunctionCallOutputItems)}, reasoning ${formatInt(summary.totals.avgReasoningItems)}`)
  lines.push(`- heavy prompts: ${formatInt(summary.totals.heavyPromptRequests)}`)
  lines.push('')
  lines.push('## Top models')
  for (const item of summary.topModels) {
    lines.push(`- ${item.key}: total ${formatInt(item.totals.totalTokens)}, input ${formatInt(item.totals.input)}, requests ${formatInt(item.totals.requests)}, avg in ${formatInt(item.totals.avgInput)}`)
  }
  lines.push('')
  lines.push('## Top sessions')
  for (const item of summary.topSessions) {
    lines.push(`- ${item.key}: total ${formatInt(item.totals.totalTokens)}, input ${formatInt(item.totals.input)}, requests ${formatInt(item.totals.requests)}, compactions ${formatInt(item.totals.compactionItems)}`)
  }
  lines.push('')
  lines.push('## Daily totals')
  for (const item of summary.daily) {
    lines.push(`- ${item.key}: total ${formatInt(item.totals.totalTokens)}, input ${formatInt(item.totals.input)}, requests ${formatInt(item.totals.requests)}`)
  }
  lines.push('')
  lines.push('## Largest prompts')
  for (const item of summary.suspicious) {
    lines.push(`- ${item.observedAt} ${item.provider}/${item.model} ${item.sessionFile || '-'} | in ${formatInt(item.input)}, out ${formatInt(item.output)}, cache ${formatInt(item.cacheRead)}, items ${formatInt(item.inputItems)} (${formatInt(item.messageItems)} msg/${formatInt(item.nonMessageItems)} non-msg), calls ${formatInt(item.functionCallItems)}/${formatInt(item.functionCallOutputItems)}, reasoning ${formatInt(item.reasoningItems)}, compactions ${formatInt(item.compactionItems)}, bytes ${formatInt(item.promptApproxBytes)}`)
  }
  return `${lines.join('\n')}\n`
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeLatestSummary(root, summary, text) {
  const latestDir = path.join(root, 'reports')
  ensureDir(latestDir)
  fs.writeFileSync(path.join(latestDir, 'latest.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(latestDir, 'latest.md'), text)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log('Usage: node scripts/token-usage-report.mjs [--days N] [--limit N] [--root PATH] [--json] [--write-latest]')
  process.exit(0)
}

const root = resolveObservabilityRoot(opts.root)
const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000
const rows = fs.existsSync(root) ? loadRows(root, cutoffMs) : []
const summary = summarizeRows(rows, opts.limit)
const text = renderText(summary, opts)

if (opts.writeLatest) writeLatestSummary(root, { generatedAt: new Date().toISOString(), root, options: opts, ...summary }, text)
if (opts.json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), root, options: opts, ...summary }, null, 2))
else process.stdout.write(text)
