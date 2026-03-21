#!/usr/bin/env node
// @ts-nocheck
/* eslint-disable no-console */

import {
  ensureDir,
  readJson,
  writeJsonAtomic as sharedWriteJsonAtomic,
  safeString,
  isPidAlive,
  lockRootDir,
  lockFilePathForKey,
  acquireExclusiveFileLock,
  expandHomeAgainst,
  resolveRinLayout,
  resolveRinHomeRoot,
} from './runtime-paths'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const readline = require('node:readline/promises')
const dynamicImport = new Function('specifier', 'return import(specifier)')

function repoRootFromEntry() {
  return path.resolve(__dirname, '..')
}

let cachedLayout = null

function layout() {
  if (!cachedLayout) cachedLayout = resolveRinLayout({ sourceHint: repoRootFromEntry() })
  return cachedLayout
}

function rootDir() {
  return layout().homeRoot
}

function repoDir() {
  return layout().repoRoot
}

function installHomeAssetDir(bundleRoot = '') {
  const root = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  return path.join(root, 'install', 'home')
}

function isPathInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

function writeJsonAtomic(filePath, obj) {
  sharedWriteJsonAtomic(filePath, obj, { chmod0600: true })
}

function copyFileIfMissing(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (fs.existsSync(dst)) return false
  fs.copyFileSync(src, dst)
  return true
}

function copyTreeIfPresent(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
  return true
}

function writeTextIfMissing(filePath, text) {
  ensureDir(path.dirname(filePath))
  if (fs.existsSync(filePath)) return false
  fs.writeFileSync(filePath, text, 'utf8')
  return true
}

function syncFile(src, dst, { overwrite = false } = {}) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (!overwrite && fs.existsSync(dst)) return false
  fs.copyFileSync(src, dst)
  return true
}

function syncTree(src, dst, { overwrite = false } = {}) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  if (overwrite && fs.existsSync(dst)) {
    try { fs.rmSync(dst, { recursive: true, force: true }) } catch {}
  }
  fs.cpSync(src, dst, { recursive: true, force: overwrite, errorOnExist: false })
  return true
}

function collectRelativeFiles(root, prefix = '') {
  const absRoot = safeString(root).trim()
  if (!absRoot || !fs.existsSync(absRoot)) return []
  const out = []
  const names = fs.readdirSync(absRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of names) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name
    const abs = path.join(absRoot, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectRelativeFiles(abs, rel))
      continue
    }
    if (entry.isFile()) out.push(rel)
  }
  return out
}

function pruneEmptyDirs(root, stopAt = root) {
  const absRoot = safeString(root).trim()
  const absStop = safeString(stopAt).trim() || absRoot
  if (!absRoot || !fs.existsSync(absRoot)) return
  const visit = (dir) => {
    let names = []
    try { names = fs.readdirSync(dir) } catch { return false }
    for (const name of names) {
      const child = path.join(dir, name)
      let stat = null
      try { stat = fs.statSync(child) } catch {}
      if (!stat || !stat.isDirectory()) continue
      visit(child)
    }
    if (path.resolve(dir) === path.resolve(absStop)) return false
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
        return true
      }
    } catch {}
    return false
  }
  visit(absRoot)
}

function normalizeManagedTreeManifest(manifest) {
  const base = manifest && typeof manifest === 'object' ? JSON.parse(JSON.stringify(manifest)) : {}
  const next = {
    version: 1,
    trees: base.trees && typeof base.trees === 'object' ? base.trees : {},
  }
  for (const [key, value] of Object.entries(next.trees)) {
    next.trees[key] = Array.isArray(value)
      ? value.map((item) => safeString(item).trim()).filter(Boolean)
      : []
  }
  return next
}

function syncManagedTree(src, dst, {
  overwrite = false,
  manifestPath = '',
  manifestKey = '',
  legacyDeleteRelPaths = [],
} = {}) {
  if (!fs.existsSync(src)) return false
  ensureDir(dst)

  const currentFiles = collectRelativeFiles(src)
  const manifest = manifestPath
    ? normalizeManagedTreeManifest(readJson(manifestPath, { version: 1, trees: {} }))
    : { version: 1, trees: {} }
  const key = safeString(manifestKey).trim()
  const previousFiles = key && Array.isArray(manifest.trees[key]) ? manifest.trees[key] : []
  const currentFileSet = new Set(currentFiles)
  const staleRelPaths = overwrite
    ? Array.from(new Set([
        ...previousFiles,
        ...((Array.isArray(legacyDeleteRelPaths) ? legacyDeleteRelPaths : []).map((item) => safeString(item).trim()).filter(Boolean)),
      ])).filter((rel) => rel && !currentFileSet.has(rel))
    : []

  for (const rel of staleRelPaths) {
    const targetPath = path.join(dst, rel)
    if (!fs.existsSync(targetPath)) continue
    try { fs.rmSync(targetPath, { recursive: true, force: true }) } catch {}
  }

  let changed = staleRelPaths.length > 0
  for (const rel of currentFiles) {
    const srcPath = path.join(src, rel)
    const dstPath = path.join(dst, rel)
    let dstStat = null
    try { dstStat = fs.statSync(dstPath) } catch {}
    if (dstStat && !dstStat.isFile()) {
      try { fs.rmSync(dstPath, { recursive: true, force: true }) } catch {}
    }
    if (syncFile(srcPath, dstPath, { overwrite })) changed = true
  }

  if (key) {
    manifest.trees[key] = currentFiles.slice()
    writeJsonAtomic(manifestPath, manifest)
  }

  if (overwrite) pruneEmptyDirs(dst)
  return changed || currentFiles.length > 0
}

function normalizeGitUrl(value) {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (/^git@github\.com:/.test(raw)) return `https://github.com/${raw.slice('git@github.com:'.length)}`
  return raw
}

function gitOutput(args, cwd = repoRootFromEntry()) {
  try {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.status !== 0) return ''
    return safeString(out.stdout).trim()
  } catch {
    return ''
  }
}

function detectInstallSourceRepoAt(cwd, fallback = DEFAULT_INSTALL_SOURCE_REPO) {
  return normalizeGitUrl(gitOutput(['remote', 'get-url', 'origin'], cwd) || fallback)
}

function detectInstallSourceRepo(fallback = DEFAULT_INSTALL_SOURCE_REPO) {
  return detectInstallSourceRepoAt(repoRootFromEntry(), fallback)
}

function detectInstallSourceRefAt(cwd, fallback = DEFAULT_INSTALL_SOURCE_REF) {
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (branch && branch !== 'HEAD') return branch
  return gitOutput(['rev-parse', 'HEAD'], cwd) || fallback
}

function detectInstallSourceRef(fallback = DEFAULT_INSTALL_SOURCE_REF) {
  return detectInstallSourceRefAt(repoRootFromEntry(), fallback)
}

function npmInstallArgsFor(dir) {
  const useCi = fs.existsSync(path.join(dir, 'package-lock.json'))
  return useCi
    ? ['ci', '--no-fund', '--no-audit']
    : ['install', '--no-fund', '--no-audit']
}

const INTERNAL_SKILL_NAMES = new Set([
  'brain',
  'memory',
  'rin-daemon',
  'rin-koishi',
  'rin-schedule',
  'rin-send',
  'rin-identity',
  'web-search',
])

const DEFAULT_INSTALL_SOURCE_REPO = 'https://github.com/THE-cattail/rin.git'
const DEFAULT_INSTALL_SOURCE_REF = 'main'
const DEFAULT_RUNTIME_AGENTS_MD = [
  '# AGENTS.md',
  '',
  '## Runtime Notes',
  '',
  '- This file defines the local prompt and rule layers for this Rin installation.',
  '- Use it to store private preferences, identity rules, and runtime-only instructions.',
  '- This file resides in the local runtime state and is excluded from the public source tree.',
  '',
].join('\n')

const AUTH_KEY_BY_PROVIDER = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  google: 'google',
  gemini: 'google',
  mistral: 'mistral',
  groq: 'groq',
  cerebras: 'cerebras',
  xai: 'xai',
  openrouter: 'openrouter',
  'vercel-ai-gateway': 'vercel-ai-gateway',
  zai: 'zai',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
  huggingface: 'huggingface',
  'kimi-coding': 'kimi-coding',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
}

function authKeyForProvider(provider = '') {
  const key = safeString(provider).trim().toLowerCase()
  return AUTH_KEY_BY_PROVIDER[key] || key
}

function splitCommaList(value = '') {
  return safeString(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function installBridgeAccountName(platform, value, index) {
  const base = safeString(value).trim().replace(/[^A-Za-z0-9._-]+/g, '-')
  return base || `${platform}-${index}`
}

function installBridgeBotId(platform, config = {}) {
  if (safeString(platform).trim() === 'telegram') {
    const token = safeString(config && config.token).trim()
    const match = token.match(/^(\d+):/)
    return match ? match[1] : ''
  }
  if (safeString(platform).trim() === 'onebot') return safeString(config && config.selfId).trim()
  return ''
}

function openInstallPromptInterface() {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return {
      rl: readline.createInterface({ input: process.stdin, output: process.stderr }),
      close() {},
    }
  }
  try {
    fs.accessSync('/dev/tty', fs.constants.R_OK | fs.constants.W_OK)
    const inputFd = fs.openSync('/dev/tty', 'r')
    const outputFd = fs.openSync('/dev/tty', 'w')
    const input = fs.createReadStream('/dev/tty', { fd: inputFd, autoClose: true })
    const output = fs.createWriteStream('/dev/tty', { fd: outputFd, autoClose: true })
    const rl = readline.createInterface({ input, output })
    return {
      rl,
      close() {
        try { rl.close() } catch {}
        try { input.close() } catch {}
        try { output.close() } catch {}
      },
    }
  } catch {
    return null
  }
}

const INSTALL_PROVIDER_PRESETS = [
  {
    value: 'anthropic',
    label: 'Claude / Anthropic API key',
    authKey: 'anthropic',
    preferredModelIds: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    modelHints: {
      'claude-sonnet-4-6': 'balanced default',
      'claude-opus-4-6': 'stronger, pricier',
    },
    models: [
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced default' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 — stronger, pricier' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'openai-codex',
    label: 'ChatGPT / Codex subscription',
    authKey: 'openai',
    preferredModelIds: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'],
    modelHints: {
      'gpt-5.4': 'recommended',
      'gpt-5.3-codex': 'Codex-focused',
      'gpt-5.2-codex': 'slightly older Codex fallback',
    },
    models: [
      { value: 'gpt-5.4', label: 'GPT-5.4 — recommended' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI API',
    authKey: 'openai',
    preferredModelIds: ['gpt-5.2', 'gpt-5.1', 'gpt-4.1'],
    modelHints: {
      'gpt-5.2': 'newest default',
      'gpt-5.1': 'strong stable option',
      'gpt-4.1': 'older fallback',
    },
    models: [
      { value: 'gpt-5.2', label: 'GPT-5.2 — newest default' },
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'google',
    label: 'Gemini / Google',
    authKey: 'google',
    preferredModelIds: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    modelHints: {
      'gemini-3.1-pro-preview': 'newer Gemini preview',
      'gemini-3-pro-preview': 'Gemini 3 preview',
      'gemini-2.5-pro': 'strong stable option',
      'gemini-2.5-flash': 'faster / cheaper',
    },
    models: [
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview — newer Gemini preview' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — strong stable option' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — faster / cheaper' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    authKey: 'openrouter',
    preferredModelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.1-codex', 'google/gemini-3.1-pro-preview'],
    modelHints: {
      'anthropic/claude-sonnet-4.6': 'balanced default',
      'openai/gpt-5.1-codex': 'coding-focused',
      'google/gemini-3.1-pro-preview': 'Gemini via OpenRouter',
    },
    models: [
      { value: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 via OpenRouter — balanced default' },
      { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex via OpenRouter' },
      { value: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview via OpenRouter' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'groq',
    label: 'Groq',
    authKey: 'groq',
    preferredModelIds: ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile'],
    modelHints: {
      'openai/gpt-oss-120b': 'best general default',
      'qwen/qwen3-32b': 'compact reasoning option',
      'llama-3.3-70b-versatile': 'broad compatibility',
    },
    models: [
      { value: 'openai/gpt-oss-120b', label: 'GPT OSS 120B — best general default' },
      { value: 'qwen/qwen3-32b', label: 'Qwen3 32B' },
      { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { value: 'custom', label: 'Custom model id' },
    ],
  },
  {
    value: 'custom',
    label: 'Other / custom provider',
    authKey: '',
    preferredModelIds: [],
    modelHints: {},
    models: [
      { value: 'custom', label: 'Enter custom model id' },
    ],
  },
]

const INSTALL_THINKING_OPTIONS = [
  { value: '', label: 'Leave unset' },
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

function findInstallProviderPreset(value = '') {
  const key = safeString(value).trim()
  return INSTALL_PROVIDER_PRESETS.find((item) => item.value === key) || INSTALL_PROVIDER_PRESETS[0]
}

let cachedInstallModelsByProvider = null

function formatInstallModelChoice(model, hint = '') {
  const id = safeString(model && model.id).trim()
  const name = safeString(model && model.name).trim() || id
  const base = name && name !== id ? `${name} (${id})` : id
  return hint ? `${base} — ${hint}` : base
}

async function loadInstallModelsByProvider() {
  if (cachedInstallModelsByProvider) return cachedInstallModelsByProvider
  try {
    const pi = await dynamicImport('@mariozechner/pi-coding-agent')
    const tempBase = path.join(os.tmpdir(), `rin-install-model-registry-${process.pid}`)
    const authStorage = pi.AuthStorage.create(`${tempBase}-auth.json`)
    const modelRegistry = new pi.ModelRegistry(authStorage, `${tempBase}-models.json`)
    const grouped = new Map()
    for (const model of modelRegistry.getAll()) {
      const provider = safeString(model && model.provider).trim()
      if (!provider) continue
      if (!grouped.has(provider)) grouped.set(provider, [])
      grouped.get(provider).push(model)
    }
    cachedInstallModelsByProvider = grouped
  } catch {
    cachedInstallModelsByProvider = new Map()
  }
  return cachedInstallModelsByProvider
}

async function getInstallProviderModelChoices(providerValue = '') {
  const providerPreset = findInstallProviderPreset(providerValue)
  const fallbackModels = Array.isArray(providerPreset && providerPreset.models) ? providerPreset.models : []
  if (!providerPreset || safeString(providerPreset.value).trim() === 'custom') return fallbackModels

  const grouped = await loadInstallModelsByProvider()
  const providerModels = Array.isArray(grouped && grouped.get(providerPreset.value)) ? grouped.get(providerPreset.value) : []
  if (!providerModels.length) return fallbackModels

  const choices = []
  const seen = new Set()
  for (const id of Array.isArray(providerPreset.preferredModelIds) ? providerPreset.preferredModelIds : []) {
    const match = providerModels.find((model) => safeString(model && model.id).trim() === safeString(id).trim())
    if (!match) continue
    const normalizedId = safeString(match && match.id).trim()
    if (!normalizedId || seen.has(normalizedId)) continue
    seen.add(normalizedId)
    choices.push({
      value: normalizedId,
      label: formatInstallModelChoice(match, safeString(providerPreset.modelHints && providerPreset.modelHints[normalizedId]).trim()),
    })
  }

  const fillTarget = Math.max(3, choices.length)
  for (const model of providerModels) {
    const id = safeString(model && model.id).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    choices.push({ value: id, label: formatInstallModelChoice(model) })
    if (choices.length >= fillTarget) break
  }

  choices.push({ value: 'custom', label: 'Custom model id' })
  return choices.length > 1 ? choices : fallbackModels
}

function findChoiceIndex(options, value) {
  const index = options.findIndex((item) => item && item.value === value)
  return index >= 0 ? index : 0
}

function installPromptCanUseArrowMenu(rl) {
  const input = rl && rl.input
  const output = rl && rl.output
  return Boolean(input && output && input.isTTY && output.isTTY && typeof input.setRawMode === 'function')
}

async function promptInstallArrowChoice(rl, question, options, fallbackIndex = 0) {
  if (!installPromptCanUseArrowMenu(rl)) return null
  const input = rl.input
  const output = rl.output
  const selectedDefault = Number.isFinite(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < options.length ? fallbackIndex : 0
  readlineCore.emitKeypressEvents(input)
  const hadRawMode = Boolean(input.isRaw)
  let renderedLines = 0
  let selected = selectedDefault

  const render = () => {
    const lines = [`${question}  (↑/↓ to move, Enter to confirm)`]
    options.forEach((opt, index) => {
      const cursor = index === selected ? '›' : ' '
      const marker = index === selectedDefault ? ' (default)' : ''
      lines.push(`  ${cursor} ${opt.label}${marker}`)
    })
    if (renderedLines > 0) output.write(`\u001b[${renderedLines}F\u001b[J`)
    output.write(`${lines.join('\n')}\n`)
    renderedLines = lines.length
  }

  return await new Promise((resolve) => {
    const cleanup = () => {
      input.removeListener('keypress', onKeypress)
      if (!hadRawMode) {
        try { input.setRawMode(false) } catch {}
      }
      if (renderedLines > 0) output.write(`\u001b[${renderedLines}F\u001b[J`)
      output.write(`Selected: ${options[selected].label}\n`)
    }

    const finish = (value) => {
      cleanup()
      resolve(value)
    }

    const onKeypress = (_str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        process.exit(130)
      }
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + options.length) % options.length
        render()
        return
      }
      if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % options.length
        render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(options[selected].value)
        return
      }
      const digit = Number.parseInt(safeString(_str), 10)
      if (Number.isFinite(digit) && digit >= 1 && digit <= options.length) {
        selected = digit - 1
        render()
      }
    }

    try { input.setRawMode(true) } catch { return resolve(null) }
    input.on('keypress', onKeypress)
    render()
  })
}

async function promptInstallChoiceWithDefault(rl, question, options, fallbackValue = '') {
  const fallbackIndex = findChoiceIndex(options, fallbackValue)
  const arrowChoice = await promptInstallArrowChoice(rl, question, options, fallbackIndex)
  if (arrowChoice != null) return arrowChoice
  console.error(question)
  options.forEach((opt, index) => {
    const marker = index === fallbackIndex ? ' (default)' : ''
    console.error(`  ${index + 1}) ${opt.label}${marker}`)
  })
  while (true) {
    const raw = safeString(await rl.question('Select an option: ')).trim()
    if (!raw) return options[fallbackIndex].value
    const idx = Number(raw)
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) return options[idx - 1].value
  }
}

async function collectInstallAuthConfig(rl, provider = '', presetAuthKey = '') {
  const mode = await promptInstallChoiceWithDefault(rl, 'How should Rin store provider credentials', [
    { value: 'skip', label: 'Skip for now' },
    { value: 'literal', label: 'Store a literal API key in auth.json' },
    { value: 'env', label: 'Store an environment variable name in auth.json' },
    { value: 'command', label: 'Store a shell command (!command) in auth.json' },
  ], 'skip')
  if (mode === 'skip') return {}

  const defaultAuthKey = safeString(presetAuthKey || authKeyForProvider(provider)).trim()
  const authKey = safeString(provider).trim() === 'custom'
    ? await promptInstallText(rl, 'auth.json provider key', defaultAuthKey)
    : defaultAuthKey

  let keyValue = ''
  if (mode === 'literal') keyValue = await promptInstallText(rl, 'API key', '')
  if (mode === 'env') keyValue = await promptInstallText(rl, 'Environment variable name', '')
  if (mode === 'command') keyValue = `!${safeString(await promptInstallText(rl, 'Shell command (without leading !)', '')).trim()}`

  if (!safeString(authKey).trim() || !safeString(keyValue).trim()) return {}
  return {
    [safeString(authKey).trim()]: {
      type: 'api_key',
      key: safeString(keyValue).trim(),
    },
  }
}

async function collectInstallProviderConfig(rl, defaults = {}) {
  const fallbackProvider = safeString(defaults.provider || 'anthropic').trim() || 'anthropic'
  const providerChoice = await promptInstallChoiceWithDefault(
    rl,
    'Pick how you want Rin to talk to models',
    [
      ...INSTALL_PROVIDER_PRESETS.map((item) => ({ value: item.value, label: item.label })),
      { value: 'skip', label: 'Skip for now' },
    ],
    fallbackProvider,
  )
  if (providerChoice === 'skip') return null

  const providerPreset = findInstallProviderPreset(providerChoice)
  const provider = providerChoice === 'custom'
    ? await promptInstallText(rl, 'Custom provider id', '')
    : providerChoice
  const modelChoices = await getInstallProviderModelChoices(providerChoice)

  const modelChoice = await promptInstallChoiceWithDefault(
    rl,
    'Choose the default model',
    modelChoices,
    safeString(defaults.model || modelChoices[0]?.value || 'custom').trim(),
  )
  const model = modelChoice === 'custom'
    ? await promptInstallText(rl, 'Custom model id', '')
    : modelChoice

  const thinking = await promptInstallChoiceWithDefault(
    rl,
    'Choose the default thinking level',
    INSTALL_THINKING_OPTIONS,
    safeString(defaults.thinking || 'medium').trim(),
  )

  const authEntries = await collectInstallAuthConfig(rl, provider, providerPreset.authKey)

  return {
    settingsPatch: {
      defaultProvider: safeString(provider).trim(),
      defaultModel: safeString(model).trim(),
      defaultThinkingLevel: safeString(thinking).trim(),
    },
    authEntries,
  }
}

async function collectOneBotAccounts(rl) {
  const accounts = []
  let keepAdding = true
  while (keepAdding) {
    const index = accounts.length + 1
    const endpointMode = await promptInstallChoiceWithDefault(rl, 'OneBot endpoint', [
      { value: 'napcat-local', label: 'NapCat / local default (ws://127.0.0.1:6700)' },
      { value: 'custom', label: 'Custom endpoint' },
    ], 'napcat-local')
    const endpoint = endpointMode === 'custom'
      ? await promptInstallText(rl, 'OneBot WebSocket endpoint', 'ws://127.0.0.1:6700')
      : 'ws://127.0.0.1:6700'
    const selfId = await promptInstallText(rl, 'OneBot self ID', '')
    const saveToken = await promptInstallYesNo(rl, 'Does this OneBot account require a token', false)
    const token = saveToken ? await promptInstallText(rl, 'OneBot token', '') : ''
    const ownerUserIds = splitCommaList(await promptInstallText(rl, 'Owner user IDs for this account (comma-separated, empty to skip)', ''))
    const name = installBridgeAccountName('onebot', '', index)
    accounts.push({
      platform: 'onebot',
      name,
      config: { name, protocol: 'ws', endpoint, selfId, token, owners: ownerUserIds },
    })
    keepAdding = await promptInstallYesNo(rl, 'Add another OneBot account', false)
  }
  return accounts
}

async function collectTelegramAccounts(rl) {
  const accounts = []
  let keepAdding = true
  while (keepAdding) {
    const index = accounts.length + 1
    const token = await promptInstallText(rl, 'Telegram bot token', '')
    const protocol = await promptInstallChoiceWithDefault(rl, 'Telegram delivery mode', [
      { value: 'polling', label: 'Polling (recommended for simple setups)' },
      { value: 'webhook', label: 'Webhook' },
    ], 'polling')
    const ownerUserIds = splitCommaList(await promptInstallText(rl, 'Owner user IDs for this bot (comma-separated, empty to skip)', ''))
    const name = installBridgeAccountName('telegram', '', index)
    accounts.push({
      platform: 'telegram',
      name,
      config: { name, token, protocol: safeString(protocol).trim() || 'polling', slash: true, owners: ownerUserIds },
    })
    keepAdding = await promptInstallYesNo(rl, 'Add another Telegram bot', false)
  }
  return accounts
}

async function collectInstallBridgeAccounts(rl) {
  const bridgeMode = await promptInstallChoiceWithDefault(rl, 'Configure chat bridge accounts', [
    { value: 'skip', label: 'Skip for now' },
    { value: 'onebot', label: 'Configure OneBot / NapCat / QQ only' },
    { value: 'telegram', label: 'Configure Telegram only' },
    { value: 'both', label: 'Configure both OneBot and Telegram' },
  ], 'skip')
  if (bridgeMode === 'skip') return null

  const accounts = []
  if (bridgeMode === 'onebot' || bridgeMode === 'both') accounts.push(...await collectOneBotAccounts(rl))
  if (bridgeMode === 'telegram' || bridgeMode === 'both') accounts.push(...await collectTelegramAccounts(rl))
  if (!accounts.length) return null

  const onebot = accounts.filter((item) => item.platform === 'onebot').map((item) => item.config)
  const telegram = accounts.filter((item) => item.platform === 'telegram').map((item) => item.config)
  const ownerAliases = []
  for (const item of accounts) {
    const botId = installBridgeBotId(item.platform, item.config)
    const owners = Array.isArray(item.config.owners) ? item.config.owners : []
    for (const userId of owners) ownerAliases.push({ platform: item.platform, userId, botId })
  }

  return {
    settingsPatch: {
      koishi: {
        ...(onebot.length ? { onebot } : {}),
        ...(telegram.length ? { telegram } : {}),
      },
    },
    ownerAliases,
  }
}

async function collectInstallStateRoot(rl, homeDir, requestedStateRoot = '') {
  const defaultStateRoot = installStateRootForHome(homeDir)
  const requested = safeString(requestedStateRoot).trim()
  const options = [{ value: 'default', label: `Use the default runtime root (${defaultStateRoot})` }]
  let fallback = 'default'
  if (requested && path.resolve(expandHomeAgainst(homeDir, requested)) !== path.resolve(defaultStateRoot)) {
    options.push({ value: 'requested', label: `Use the preset runtime root (${path.resolve(expandHomeAgainst(homeDir, requested))})` })
    fallback = 'requested'
  }
  options.push({ value: 'custom', label: 'Enter a custom runtime root' })

  const choice = await promptInstallChoiceWithDefault(rl, 'Choose where Rin should keep its runtime home', options, fallback)
  if (choice === 'default') return defaultStateRoot
  if (choice === 'requested') return path.resolve(expandHomeAgainst(homeDir, requested))
  return await promptInstallText(rl, 'Custom runtime root', requested || defaultStateRoot)
}

function mergeInstallConfigSections(...configs) {
  const out = { settingsPatch: {}, authEntries: {}, ownerAliases: [] }
  for (const config of configs) {
    if (!config || typeof config !== 'object') continue
    out.settingsPatch = mergeInstallObject(out.settingsPatch, config.settingsPatch)
    out.authEntries = mergeInstallObject(out.authEntries, config.authEntries)
    out.ownerAliases = [...out.ownerAliases, ...(Array.isArray(config.ownerAliases) ? config.ownerAliases : [])]
  }
  return out
}

function daemonManagerChoicesForPlatform() {
  if (process.platform === 'darwin') {
    return [
      { value: 'auto', label: 'Auto (prefer launchd, fallback to detached)' },
      { value: 'launchd', label: 'launchd agent' },
      { value: 'detached', label: 'Detached background process' },
    ]
  }
  if (process.platform === 'win32') {
    return [
      { value: 'auto', label: 'Auto (detached background process)' },
      { value: 'detached', label: 'Detached background process' },
    ]
  }
  return [
    { value: 'auto', label: 'Auto (prefer systemd, fallback to detached)' },
    { value: 'systemd', label: 'systemd user service' },
    { value: 'detached', label: 'Detached background process' },
  ]
}

async function collectInstallServiceManager(rl, fallbackValue = 'auto') {
  return await promptInstallChoiceWithDefault(rl, 'Choose how Rin should keep its background daemon running', daemonManagerChoicesForPlatform(), fallbackValue)
}

function summarizeInstallPlan({ targetUser, requestedStateRoot, installConfig, serviceManager = 'auto', dryRun = false }: any = {}) {
  const settings = installConfig && installConfig.settingsPatch && typeof installConfig.settingsPatch === 'object'
    ? installConfig.settingsPatch
    : {}
  const koishi = settings && settings.koishi && typeof settings.koishi === 'object' ? settings.koishi : {}
  const onebotCount = Array.isArray(koishi.onebot) ? koishi.onebot.length : koishi.onebot ? 1 : 0
  const telegramCount = Array.isArray(koishi.telegram) ? koishi.telegram.length : koishi.telegram ? 1 : 0
  const authKeys = Object.keys(installConfig && installConfig.authEntries && typeof installConfig.authEntries === 'object' ? installConfig.authEntries : {})
  return [
    dryRun ? 'Install summary (dry run):' : 'Install summary:',
    `  User: ${safeString(targetUser && targetUser.username || '')}`,
    `  Runtime root: ${safeString(requestedStateRoot || '')}`,
    `  Service backend: ${safeString(serviceManager || 'auto')}`,
    `  Default provider: ${safeString(settings.defaultProvider || '(unset)')}`,
    `  Default model: ${safeString(settings.defaultModel || '(unset)')}`,
    `  Thinking: ${safeString(settings.defaultThinkingLevel || '(unset)')}`,
    `  Saved auth entries: ${authKeys.length ? authKeys.join(', ') : '(none)'}`,
    `  Bridge accounts: OneBot ${onebotCount}, Telegram ${telegramCount}`,
    dryRun ? '  Writes: skipped (preview only)' : '  Writes: enabled',
  ].join('\n')
}

function ensureWorkspaceBaseline(home, { overwriteManaged = false, bundleRoot = '' } = {}) {
  const repo = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  const assetRoot = installHomeAssetDir(repo)
  const createdDirs = []
  const copied = []
  const written = []
  const cleaned = []

  const ensureWorkspaceDir = (rel) => {
    const abs = path.join(home, rel)
    const existed = fs.existsSync(abs)
    ensureDir(abs)
    if (!existed) createdDirs.push(rel)
  }

  const removeIfPresent = (rel) => {
    const abs = path.join(home, rel)
    if (!fs.existsSync(abs)) return
    fs.rmSync(abs, { recursive: true, force: true })
    cleaned.push(rel)
  }

  const migrateFirstIfMissing = (sources, dstRel) => {
    const dst = path.join(home, dstRel)
    if (fs.existsSync(dst)) return false
    for (const srcRel of sources) {
      const src = path.join(home, srcRel)
      if (copyFileIfMissing(src, dst)) {
        copied.push(dstRel)
        return true
      }
    }
    return false
  }

  ;[
    'data',
    'docs',
    'docs/rin',
    'skills',
  ].forEach(ensureWorkspaceDir)

  if (writeTextIfMissing(path.join(home, 'AGENTS.md'), DEFAULT_RUNTIME_AGENTS_MD)) written.push('AGENTS.md')

  const managedManifestPath = path.join(home, 'data', '.managed', 'install-home.json')
  if (syncManagedTree(path.join(assetRoot, 'docs', 'rin'), path.join(home, 'docs', 'rin'), {
    overwrite: overwriteManaged,
    manifestPath: managedManifestPath,
    manifestKey: 'docs/rin',
    legacyDeleteRelPaths: [
      'examples',
    ],
  })) {
    copied.push('docs/rin')
  }

  ;[
    'GUARDIAN.md',
    'README.md',
    'docs/pi',
    'handbooks',
    'data/identity.example.json',
    'data/schedules.example.json',
    'data/rin/identity.example.json',
    'data/rin/schedules.example.json',
    'data/koishi.generated.yml',
    'data/.generated',
    'bin/rin',
    'kb/README.md',
    'kb/vault/README.md',
    'memory/README.md',
    'routines/README.md',
    'locale/en-US.default.json',
    'skills/web-search',
  ].forEach(removeIfPresent)

  return {
    workspace: home,
    repoRoot: repo,
    createdDirs,
    copied,
    written,
    cleaned,
  }
}

function findExecutableOnPath(name) {
  const raw = safeString(process.env.PATH)
  const parts = raw ? raw.split(path.delimiter) : []
  for (const dir of parts) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return ''
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2))
}

function expandHome(value) {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function stockPiAgentDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.pi', 'agent')
}

function piAgentDir() {
  return rootDir()
}

function syncPiSettings(agentDir) {
  ensureDir(agentDir)
  const settingsPath = path.join(agentDir, 'settings.json')
  const current = readJson(settingsPath, {})
  const next = current && typeof current === 'object' ? JSON.parse(JSON.stringify(current)) : {}

  if (next.enableSkillCommands == null) next.enableSkillCommands = true

  const repoExtensionDir = path.join(repoDir(), 'pi', 'extensions')
  const currentExtensions = Array.isArray(next.extensions) ? next.extensions.map((v) => safeString(v).trim()).filter(Boolean) : []
  const filteredExtensions = currentExtensions.filter((entry) => path.resolve(entry) !== path.resolve(repoExtensionDir))
  if (filteredExtensions.length > 0) next.extensions = filteredExtensions
  else delete next.extensions

  writeJsonAtomic(settingsPath, next)
  return { ok: true, settingsPath }
}

function seedPiAgentDirFromStock(agentDir, { homeDir = os.homedir() } = {}) {
  const stockDir = stockPiAgentDir(homeDir)
  if (!stockDir || path.resolve(stockDir) === path.resolve(agentDir) || !fs.existsSync(stockDir)) {
    return { ok: false, reason: 'stock_profile_missing' }
  }
  const copied = []
  for (const name of ['auth.json', 'settings.json', 'models.json']) {
    if (copyFileIfMissing(path.join(stockDir, name), path.join(agentDir, name))) copied.push(name)
  }
  return { ok: copied.length > 0, copied }
}

function ensurePiBootstrapAt({ agentDir, stateRoot = rootDir(), homeDir = os.homedir() } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || piAgentDir())
  ensureDir(resolvedAgentDir)
  const seeded = seedPiAgentDirFromStock(resolvedAgentDir, { homeDir })
  const settings = syncPiSettings(resolvedAgentDir)
  return { agentDir: resolvedAgentDir, seeded, settings }
}

function ensurePiBootstrap() {
  return ensurePiBootstrapAt({ agentDir: piAgentDir(), stateRoot: rootDir(), homeDir: os.homedir() })
}

function rinAppDir() {
  const currentRepoDir = repoDir()
  if (fs.existsSync(path.join(currentRepoDir, 'dist', 'index.js'))) return currentRepoDir
  const installedAppDir = path.join(rootDir(), 'app', 'current')
  if (fs.existsSync(path.join(installedAppDir, 'dist', 'index.js'))) return installedAppDir
  return currentRepoDir
}

function rinDistPath(rel = 'index.js') {
  return path.join(rinAppDir(), 'dist', rel)
}

function ensureRinDistFile(rel) {
  const filePath = rinDistPath(rel)
  if (!fs.existsSync(filePath)) throw new Error(`rin_dist_missing:${rel}`)
  return filePath
}

function ensureRinTuiHost() {
  return ensureRinDistFile('tui.js')
}

function ensureRinTuiDebugHost() {
  return ensureRinDistFile('tui-debug.js')
}

function installStateRootForHome(homeDir, stateRoot = '') {
  const explicit = safeString(stateRoot).trim()
  if (explicit) return path.resolve(expandHomeAgainst(homeDir, explicit))
  return resolveRinHomeRoot(homeDir)
}

function lookupUserRecord(username) {
  const name = safeString(username).trim()
  if (!name) return null
  const out = spawnSync('getent', ['passwd', name], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const line = safeString(out.stdout).trim().split('\n').filter(Boolean)[0] || ''
  const parts = line.split(':')
  if (parts.length < 7) return null
  const uid = Number(parts[2])
  const gid = Number(parts[3])
  const homeDir = parts[5] || ''
  return {
    username: parts[0],
    uid: Number.isFinite(uid) ? uid : -1,
    gid: Number.isFinite(gid) ? gid : -1,
    homeDir,
    shell: parts[6] || '',
  }
}

function currentUserRecord() {
  const username = safeString(process.env.USER || process.env.LOGNAME).trim()
  const fromGetent = username ? lookupUserRecord(username) : null
  if (fromGetent) return fromGetent
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const gid = typeof process.getgid === 'function' ? process.getgid() : -1
  return {
    username: username || 'unknown',
    uid,
    gid,
    homeDir: os.homedir(),
    shell: process.env.SHELL || '/bin/bash',
  }
}

function installCanManageExistingUsers(capabilities: any = {}) {
  const platform = safeString(capabilities.platform || process.platform).trim() || process.platform
  const isRoot = typeof capabilities.isRoot === 'boolean'
    ? capabilities.isRoot
    : typeof process.getuid === 'function' && process.getuid() === 0
  const hasGetent = typeof capabilities.hasGetent === 'boolean'
    ? capabilities.hasGetent
    : Boolean(findExecutableOnPath('getent'))
  return platform === 'linux' && isRoot && hasGetent
}

function installCanCreateUsers(capabilities: any = {}) {
  const hasUseradd = typeof capabilities.hasUseradd === 'boolean'
    ? capabilities.hasUseradd
    : Boolean(findExecutableOnPath('useradd'))
  return installCanManageExistingUsers(capabilities) && hasUseradd
}

function installTargetChoices(currentUser = currentUserRecord(), capabilities: any = {}) {
  const platform = safeString(capabilities.platform || process.platform).trim() || process.platform
  const hasGetent = typeof capabilities.hasGetent === 'boolean'
    ? capabilities.hasGetent
    : Boolean(findExecutableOnPath('getent'))
  const dryRun = capabilities.dryRun === true
  const choices = [
    { value: 'current', label: `Install for current user (${currentUser.username})` },
  ]
  if (installCanManageExistingUsers(capabilities) || (dryRun && platform === 'linux' && hasGetent)) {
    choices.push({ value: 'existing', label: dryRun ? 'Preview install for an existing user' : 'Install for an existing user' })
  }
  if (installCanCreateUsers(capabilities) || (dryRun && platform === 'linux')) {
    choices.push({ value: 'create', label: dryRun ? 'Preview install for a new user' : 'Create a new user and install there' })
  }
  return choices
}

function previewUserRecordForInstall(username, currentUser = currentUserRecord()) {
  const name = safeString(username).trim() || 'preview-user'
  const currentHome = safeString(currentUser && currentUser.homeDir).trim() || os.homedir()
  const parentHome = currentHome ? path.dirname(currentHome) : os.homedir()
  const homeDir = path.join(parentHome, name)
  return {
    username: name,
    uid: -1,
    gid: -1,
    homeDir,
    shell: safeString(currentUser && currentUser.shell).trim() || process.env.SHELL || '/bin/bash',
  }
}

function formatCliErrorMessage(error) {
  const message = String(error && error.message ? error.message : error)
  if (message === 'uninstall_requires_confirmation_or_yes') return 'Uninstall needs confirmation. Re-run interactively or pass --yes.'
  if (message === 'install_requires_root_for_other_user') return 'Installing for another user needs root on Linux. Re-run with sudo, or choose the current user.'
  if (message === 'install_requires_root_to_create_user') return 'Creating a new user during install needs root on Linux. Re-run with sudo, or choose the current user.'
  if (message === 'install_existing_user_unsupported') return 'Installing for another user is only available on Linux root installs right now. Please choose the current user instead.'
  if (message === 'install_create_user_unsupported') return 'Creating a new user from the installer is only available on Linux root installs right now. Please create the user first, or install for the current user.'
  if (message === 'local_bundle_root_missing') return 'A local source tree is required. Pass `--path <repo>` or run the command from the Rin source checkout.'
  if (message.startsWith('local_bundle_package_missing:')) return `No Rin package.json found under ${message.slice('local_bundle_package_missing:'.length)}.`
  if (message.startsWith('install_already_exists:')) return `Rin is already installed at ${message.slice('install_already_exists:'.length)}. Use \`rin update\`, uninstall first, or pass the internal upgrade path.`
  return message
}

function chownRecursiveIfPossible(targetPath, uid, gid) {
  if (!fs.existsSync(targetPath)) return
  if (!Number.isFinite(Number(uid)) || !Number.isFinite(Number(gid))) return
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  const entries = [targetPath]
  while (entries.length) {
    const current = entries.pop()
    try { fs.chownSync(current, uid, gid) } catch {}
    let st = null
    try { st = fs.lstatSync(current) } catch {}
    if (!st || !st.isDirectory()) continue
    let names = []
    try { names = fs.readdirSync(current) } catch {}
    for (const name of names) entries.push(path.join(current, name))
  }
}

function isLocalBundlePath(value) {
  const raw = safeString(value).trim()
  if (!raw) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*@/.test(raw)) return false
  const abs = path.resolve(expandHome(raw))
  try { return fs.statSync(abs).isDirectory() } catch { return false }
}

function resolveLocalBundleRoot(value, fallback = '') {
  const raw = safeString(value).trim() || safeString(fallback).trim()
  if (!raw) return ''
  return path.resolve(expandHome(raw))
}

async function prepareLocalInstallBundle(bundleRoot) {
  const resolved = resolveLocalBundleRoot(bundleRoot)
  if (!resolved) throw new Error('local_bundle_root_missing')
  if (!fs.existsSync(path.join(resolved, 'package.json'))) throw new Error(`local_bundle_package_missing:${resolved}`)
  await spawnChecked('npm', npmInstallArgsFor(resolved), { cwd: resolved })
  await spawnChecked('npm', ['run', '-s', 'build'], { cwd: resolved })
  ensureInstallableBundle(resolved)
  return resolved
}

function ensureInstallableBundle(bundleRoot = '') {
  const root = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  for (const rel of ['dist/index.js', 'dist/brain.js', 'dist/daemon.js', 'dist/tui.js', 'dist/tui-debug.js']) {
    const filePath = path.join(root, rel)
    if (!fs.existsSync(filePath)) throw new Error(`rin_dist_missing:${rel.replace(/^dist\//, '')}`)
  }
}

function copyInstallBundleTree(src, dst) {
  if (!fs.existsSync(src)) return false
  ensureDir(path.dirname(dst))
  fs.cpSync(src, dst, { recursive: true, force: true })
  return true
}

function pruneOldRuntimeReleases(stateRoot, keepReleaseIds = []) {
  const releasesRoot = path.join(stateRoot, 'app', 'releases')
  if (!fs.existsSync(releasesRoot)) return []
  const keep = new Set((Array.isArray(keepReleaseIds) ? keepReleaseIds : []).map((v) => safeString(v).trim()).filter(Boolean))
  const names = fs.readdirSync(releasesRoot).filter((name) => {
    const abs = path.join(releasesRoot, name)
    try { return fs.statSync(abs).isDirectory() } catch { return false }
  }).sort()
  const removed = []
  for (const name of names) {
    if (keep.has(name)) continue
    try {
      fs.rmSync(path.join(releasesRoot, name), { recursive: true, force: true })
      removed.push(name)
    } catch {}
  }
  return removed
}

function installRuntimeBundle(stateRoot, { bundleRoot = '', releaseId = '' } = {}) {
  const repo = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  ensureInstallableBundle(repo)
  const nextReleaseId = safeString(releaseId).trim() || new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  const releasesRoot = path.join(stateRoot, 'app', 'releases')
  const releaseRoot = path.join(releasesRoot, nextReleaseId)
  ensureDir(releaseRoot)

  for (const rel of ['package.json', 'package-lock.json']) {
    const src = path.join(repo, rel)
    if (fs.existsSync(src)) syncFile(src, path.join(releaseRoot, rel), { overwrite: true })
  }
  copyInstallBundleTree(path.join(repo, 'dist'), path.join(releaseRoot, 'dist'))
  if (fs.existsSync(path.join(repo, 'node_modules'))) {
    copyInstallBundleTree(path.join(repo, 'node_modules'), path.join(releaseRoot, 'node_modules'))
  }
  copyInstallBundleTree(path.join(repo, 'third_party'), path.join(releaseRoot, 'third_party'))
  copyInstallBundleTree(path.join(repo, 'install'), path.join(releaseRoot, 'install'))
  try { fs.chmodSync(path.join(releaseRoot, 'dist', 'index.js'), 0o755) } catch {}

  const currentLink = path.join(stateRoot, 'app', 'current')
  try { fs.rmSync(currentLink, { force: true, recursive: true }) } catch {}
  try {
    fs.symlinkSync(path.relative(path.dirname(currentLink), releaseRoot), currentLink, 'dir')
  } catch {
    copyInstallBundleTree(releaseRoot, currentLink)
  }

  const prunedReleaseIds = pruneOldRuntimeReleases(stateRoot, [nextReleaseId])
  return { releaseId: nextReleaseId, releaseRoot, currentRoot: currentLink, prunedReleaseIds }
}

function installedLauncherText({ stateRoot }) {
  const resolvedStateRoot = path.resolve(stateRoot)
  const targetPath = path.join(resolvedStateRoot, 'app', 'current', 'dist', 'index.js')
  return [
    '#!/usr/bin/env sh',
    `export RIN_HOME=${JSON.stringify(resolvedStateRoot)}`,
    `RIN_NODE=${JSON.stringify(process.execPath)}`,
    `RIN_TARGET=${JSON.stringify(targetPath)}`,
    '',
    'if [ ! -f "$RIN_TARGET" ]; then',
    '  echo "rin: installed runtime missing at $RIN_TARGET" >&2',
    '  echo "rin: automatic self-repair is disabled. Please run `rin update` from a working source tree, or reinstall after uninstalling the broken runtime." >&2',
    '  exit 1',
    'fi',
    'exec "$RIN_NODE" "$RIN_TARGET" "$@"',
    '',
  ].join('\n')
}

function createInstalledLauncher({ stateRoot, userHome, sourceRepo = '', sourceRef = '' }) {
  const localBinDir = path.join(userHome, '.local', 'bin')
  ensureDir(localBinDir)
  const launcherPath = path.join(localBinDir, 'rin')
  const targetPath = path.join(stateRoot, 'app', 'current', 'dist', 'index.js')
  const launcherText = installedLauncherText({ stateRoot, sourceRepo, sourceRef })
  try { fs.rmSync(launcherPath, { force: true }) } catch {}
  fs.writeFileSync(launcherPath, launcherText, 'utf8')
  try { fs.chmodSync(targetPath, 0o755) } catch {}
  try { fs.chmodSync(launcherPath, 0o755) } catch {}
  return launcherPath
}

function writeInstallMetadata(stateRoot, data) {
  const file = path.join(stateRoot, 'install.json')
  writeJsonAtomic(file, data)
  return file
}

function mergeInstallObject(base, patch) {
  const left = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  const right = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const out = { ...left }
  for (const [key, value] of Object.entries(right)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      out[key] = JSON.parse(JSON.stringify(value))
      continue
    }
    if (value && typeof value === 'object') {
      out[key] = mergeInstallObject(out[key], value)
      continue
    }
    out[key] = value
  }
  return out
}

function normalizeOwnerAlias(platform, userId, botId = '') {
  const nextPlatform = safeString(platform).trim()
  const nextUserId = safeString(userId).trim()
  const nextBotId = safeString(botId).trim()
  if (!nextPlatform || !nextUserId) return null
  return nextBotId
    ? { platform: nextPlatform, userId: nextUserId, botId: nextBotId, personId: 'owner' }
    : { platform: nextPlatform, userId: nextUserId, personId: 'owner' }
}

function applyInstallConfiguration({ stateRoot, settingsPatch = {}, authEntries = {}, ownerAliases = [] } = {}) {
  const settingsPath = path.join(stateRoot, 'settings.json')
  const authPath = path.join(stateRoot, 'auth.json')
  const identityPath = path.join(stateRoot, 'data', 'identity.json')

  const currentSettings = readJson(settingsPath, {})
  const nextSettings = mergeInstallObject(currentSettings, settingsPatch)
  writeJsonAtomic(settingsPath, nextSettings)

  const currentAuth = readJson(authPath, {})
  const nextAuth = mergeInstallObject(currentAuth, authEntries)
  writeJsonAtomic(authPath, nextAuth)

  const identity = readJson(identityPath, { persons: { owner: { trust: 'OWNER' } }, aliases: [], trusted: [] })
  identity.persons ||= {}
  identity.aliases ||= []
  identity.trusted ||= []
  identity.persons.owner = identity.persons.owner && typeof identity.persons.owner === 'object'
    ? { ...identity.persons.owner, trust: 'OWNER' }
    : { trust: 'OWNER' }

  for (const entry of ownerAliases.map((item) => normalizeOwnerAlias(item && item.platform, item && item.userId, item && item.botId)).filter(Boolean)) {
    const existing = identity.aliases.find((alias) => alias
      && alias.platform === entry.platform
      && String(alias.userId) === entry.userId
      && safeString(alias.botId || '') === safeString(entry.botId || ''))
    if (existing) Object.assign(existing, entry)
    else identity.aliases.push(entry)
  }
  writeJsonAtomic(identityPath, identity)

  return { settingsPath, authPath, identityPath }
}

function performInstall({
  targetUser,
  homeDir,
  stateRoot = '',
  serviceManager = 'auto',
  overwriteManaged = true,
  allowExistingInstall = false,
  sourceRepo = '',
  sourceRef = '',
  bundleRoot = '',
  releaseId = '',
  seedHomeDir = '',
  installConfig = null,
  dryRun = false,
} = {}) {
  const userHome = path.resolve(homeDir)
  const resolvedStateRoot = installStateRootForHome(userHome, stateRoot)
  const resolvedBundleRoot = safeString(bundleRoot).trim() ? path.resolve(bundleRoot) : repoDir()
  const launcherPath = path.join(userHome, '.local', 'bin', 'rin')
  const metadataPath = path.join(resolvedStateRoot, 'install.json')
  const currentAppEntry = path.join(resolvedStateRoot, 'app', 'current', 'dist', 'index.js')

  if (!dryRun && !allowExistingInstall && fs.existsSync(currentAppEntry)) {
    throw new Error(`install_already_exists:${resolvedStateRoot}`)
  }

  if (dryRun) {
    const settings = installConfig && installConfig.settingsPatch && typeof installConfig.settingsPatch === 'object'
      ? installConfig.settingsPatch
      : {}
    const koishi = settings && settings.koishi && typeof settings.koishi === 'object' ? settings.koishi : {}
    const onebotCount = Array.isArray(koishi.onebot) ? koishi.onebot.length : koishi.onebot ? 1 : 0
    const telegramCount = Array.isArray(koishi.telegram) ? koishi.telegram.length : koishi.telegram ? 1 : 0
    return {
      ok: true,
      dryRun: true,
      stateRoot: resolvedStateRoot,
      launcherPath,
      launcherText: installedLauncherText({
        stateRoot: resolvedStateRoot,
        sourceRepo: safeString(sourceRepo).trim(),
        sourceRef: safeString(sourceRef).trim(),
      }),
      metadataPath,
      preview: {
        targetUser: targetUser && targetUser.username ? targetUser.username : safeString(process.env.USER || ''),
        runtimeRoot: resolvedStateRoot,
        repoRoot: resolvedBundleRoot,
        installSource: {
          repo: safeString(sourceRepo).trim(),
          ref: safeString(sourceRef).trim(),
        },
        serviceManager: safeString(serviceManager || 'auto').trim() || 'auto',
        defaultProvider: safeString(settings.defaultProvider || ''),
        defaultModel: safeString(settings.defaultModel || ''),
        defaultThinkingLevel: safeString(settings.defaultThinkingLevel || ''),
        bridgeAccounts: { onebot: onebotCount, telegram: telegramCount },
      },
      plannedChanges: [
        `would prepare runtime root: ${resolvedStateRoot}`,
        `would write runtime docs and managed assets under: ${resolvedStateRoot}`,
        `would create launcher: ${launcherPath}`,
        `would write install metadata: ${metadataPath}`,
      ],
    }
  }

  ensureDir(resolvedStateRoot)
  const baseline = ensureWorkspaceBaseline(resolvedStateRoot, { overwriteManaged, bundleRoot: resolvedBundleRoot })
  const bundle = installRuntimeBundle(resolvedStateRoot, { bundleRoot: resolvedBundleRoot, releaseId })
  const bootstrap = ensurePiBootstrapAt({ agentDir: resolvedStateRoot, stateRoot: resolvedStateRoot, homeDir: path.resolve(seedHomeDir || userHome) })
  const appliedConfig = installConfig && typeof installConfig === 'object'
    ? applyInstallConfiguration({ stateRoot: resolvedStateRoot, ...installConfig })
    : null
  const createdLauncherPath = createInstalledLauncher({
    stateRoot: resolvedStateRoot,
    userHome,
    sourceRepo: safeString(sourceRepo).trim(),
    sourceRef: safeString(sourceRef).trim(),
  })
  const writtenMetadataPath = writeInstallMetadata(resolvedStateRoot, {
    installedAt: new Date().toISOString(),
    stateRoot: resolvedStateRoot,
    appRoot: path.join(resolvedStateRoot, 'app', 'current'),
    launcherPath: createdLauncherPath,
    targetUser: targetUser && targetUser.username ? targetUser.username : safeString(process.env.USER || ''),
    installSource: {
      repo: safeString(sourceRepo).trim(),
      ref: safeString(sourceRef).trim(),
    },
    serviceManager: safeString(serviceManager || 'auto').trim() || 'auto',
  })
  if (targetUser) {
    chownRecursiveIfPossible(resolvedStateRoot, targetUser.uid, targetUser.gid)
    chownRecursiveIfPossible(path.join(userHome, '.local'), targetUser.uid, targetUser.gid)
  }
  return {
    ok: true,
    stateRoot: resolvedStateRoot,
    launcherPath: createdLauncherPath,
    baseline,
    bundle,
    bootstrap,
    appliedConfig,
    metadataPath: writtenMetadataPath,
  }
}

function performUninstall({ homeDir = os.homedir(), stateRoot = '', mode = 'keep' } = {}) {
  const userHome = path.resolve(homeDir)
  const resolvedStateRoot = installStateRootForHome(userHome, stateRoot)
  const launcherPath = path.join(userHome, '.local', 'bin', 'rin')

  try { fs.rmSync(launcherPath, { force: true }) } catch {}

  const removed = []
  if (mode === 'purge') {
    if (fs.existsSync(resolvedStateRoot)) {
      try { fs.rmSync(resolvedStateRoot, { recursive: true, force: true }) } catch {}
      removed.push(resolvedStateRoot)
    }
  } else {
    for (const rel of ['app', 'install.json']) {
      const target = path.join(resolvedStateRoot, rel)
      if (!fs.existsSync(target)) continue
      try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
      removed.push(target)
    }
  }

  return {
    ok: true,
    mode,
    stateRoot: resolvedStateRoot,
    launcherPath,
    launcherRemoved: !fs.existsSync(launcherPath),
    removed,
  }
}

function daemonSystemdServiceName() {
  return 'rin-daemon.service'
}

function daemonSystemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', daemonSystemdServiceName())
}

function daemonSystemdUnitText() {
  const stateRoot = rootDir().replace(/\\/g, '/')
  const appRoot = path.dirname(path.dirname(daemonDistPath())).replace(/\\/g, '/')
  const repoRoot = appRoot
  const entry = daemonDistPath().replace(/\\/g, '/')
  return [
    '[Unit]',
    'Description=Rin daemon (Koishi bridge for NapCat + Telegram + Codex)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${appRoot}`,
    `Environment=RIN_HOME=${stateRoot}`,
    `Environment=RIN_REPO_ROOT=${repoRoot}`,
    `ExecStart=${process.execPath} ${entry}`,
    'Restart=always',
    'RestartSec=3',
    'TimeoutStopSec=180',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function ensureDaemonSystemdServiceFile() {
  const unitPath = daemonSystemdUnitPath()
  const text = daemonSystemdUnitText()
  ensureDir(path.dirname(unitPath))
  const current = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf8') : ''
  if (current !== text) fs.writeFileSync(unitPath, text, 'utf8')
  const res = systemctlUser(['daemon-reload'])
  if (res.status !== 0) {
    const msg = safeString(res.stderr || res.stdout).trim() || 'systemd_daemon_reload_failed'
    throw new Error(msg)
  }
  return unitPath
}

function detectDaemonSystemdService() {
  const systemctl = findExecutableOnPath('systemctl')
  if (!systemctl) return ''
  try {
    const out = spawnSync(systemctl, ['--user', 'show', '-p', 'LoadState', daemonSystemdServiceName()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return ''
    const text = `${out.stdout || ''}\n${out.stderr || ''}`
    if (!/\bLoadState=loaded\b/.test(text)) return ''
    return systemctl
  } catch {
    return ''
  }
}

function runDaemonSystemctl(systemctl, args) {
  const res = spawnSync(systemctl, ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    const msg = safeString(res.stderr || res.stdout).trim() || `systemctl_failed:${args.join(' ')}`
    throw new Error(msg)
  }
  return safeString(res.stdout || '').trim()
}

function readDaemonSystemdPid(systemctl) {
  try {
    const out = spawnSync(systemctl, ['--user', 'show', daemonSystemdServiceName(), '-p', 'MainPID', '-p', 'ActiveState'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return { active: false, pid: 0 }
    const text = String(out.stdout || '')
    const active = /\bActiveState=active\b/.test(text)
    const m = text.match(/\bMainPID=(\d+)\b/)
    const pid = m ? Number(m[1]) : 0
    return { active, pid: Number.isFinite(pid) && pid > 1 ? pid : 0 }
  } catch {
    return { active: false, pid: 0 }
  }
}

function listProcessTable() {
  const psBin = findExecutableOnPath('ps')
  if (!psBin) return []
  try {
    const out = spawnSync(psBin, ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.status !== 0) return []
    return String(out.stdout || '')
      .split(/\r?\n/g)
      .map((line) => {
        const m = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
        if (!m) return null
        const pid = Number(m[1])
        const ppid = Number(m[2])
        const args = safeString(m[3])
        if (!Number.isFinite(pid) || pid <= 1 || !args) return null
        return { pid, ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0, args }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function listDaemonProcesses() {
  const pkgDir = daemonPackageDir().replace(/\\/g, '/')
  const markers = [
    path.join(pkgDir, 'dist', 'daemon.js').replace(/\\/g, '/'),
  ]
  return listProcessTable().filter((entry) => markers.some((marker) => entry.args.includes(marker)))
}

async function waitForPidsExit(pids, timeoutMs = 8_000) {
  const pending = Array.from(new Set((pids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 1)))
  if (!pending.length) return true
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const alive = pending.filter((pid) => isPidAlive(pid))
    if (!alive.length) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return pending.every((pid) => !isPidAlive(pid))
}

async function terminatePids(pids, { timeoutMs = 8_000 } = {}) {
  const unique = Array.from(new Set((pids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 1)))
  if (!unique.length) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
  }
  const stopped = await waitForPidsExit(unique, timeoutMs)
  if (stopped) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGKILL') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
  }
  await waitForPidsExit(unique, 2_000)
}

async function cleanupStrayDaemonProcesses({ keepPid = 0 } = {}) {
  const daemons = listDaemonProcesses()
    .filter((entry) => entry.pid !== process.pid)
    .filter((entry) => !(keepPid && entry.pid === keepPid))
  const daemonPids = daemons.map((entry) => entry.pid)
  if (!daemonPids.length) return { daemonPids: [] }
  await terminatePids(daemonPids, { timeoutMs: 10_000 })
  return { daemonPids }
}

async function spawnInherit(cmd, args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: cwd || rootDir(),
      env: env ? { ...process.env, ...env } : process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`child exited with signal: ${signal}`)
        process.exitCode = 1
      } else {
        process.exitCode = Number.isFinite(code) ? code : 1
      }
      resolve()
    })
  })
}

async function spawnChecked(cmd, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: options.cwd || rootDir(),
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`child_signal:${signal}`))
      if (Number(code || 0) !== 0) return reject(new Error(`child_exit:${Number(code || 0)}`))
      resolve(Number(code || 0))
    })
  })
}

function usage(exitCode = 2) {
  console.error([
    'Usage:',
    '  rin',
    '  rin offline',
    '  rin install [--yes] [--dry-run] [--state-root <path>] [--service-manager <auto|systemd|launchd|detached>] [--local [--path <repo>]]',
    '  rin restart',
    '  rin update [--repo <git-url>] [--ref <branch|tag|commit>] [--local [--path <repo>]]',
    '  rin uninstall [--yes] [--keep-state | --purge]',
    '',
    'Notes:',
    '  - `rin` starts the daemon-backed Rin TUI frontend.',
    '  - `rin offline` starts the local offline TUI using the native Pi InteractiveMode host.',
    '  - `rin install --local` installs from a local source tree using the standard installer flow.',
    '  - `rin update --local` rebuilds and deploys from a local source tree instead of cloning.',
    '  - `rin restart` restarts the Rin daemon service.',
    '  - brain / koishi / schedule are internal runtime capabilities, not public subcommands.',
  ].join('\n'))
  process.exit(exitCode)
}

async function promptInstallText(rl, question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : ''
  const out = safeString(await rl.question(`${question}${suffix}: `)).trim()
  return out || fallback
}

async function promptInstallYesNo(rl, question, fallback = true) {
  const marker = fallback ? 'Y/n' : 'y/N'
  const out = safeString(await rl.question(`${question} [${marker}]: `)).trim().toLowerCase()
  if (!out) return fallback
  return out === 'y' || out === 'yes'
}

async function promptInstallChoice(rl, question, options) {
  console.error(question)
  options.forEach((opt, index) => console.error(`  ${index + 1}) ${opt.label}`))
  while (true) {
    const raw = safeString(await rl.question('Select an option: ')).trim()
    const idx = Number(raw)
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) return options[idx - 1].value
  }
}

async function cmdInstall(argv) {
  let yes = false
  let dryRun = false
  let mode = ''
  let targetUserName = ''
  let createUserName = ''
  let requestedStateRoot = safeString(process.env.RIN_HOME).trim()
  let serviceManager = safeString(process.env.RIN_SERVICE_MANAGER).trim() || 'auto'
  let sourceRepo = safeString(process.env.RIN_INSTALL_SOURCE_REPO).trim()
  let sourceRef = safeString(process.env.RIN_INSTALL_SOURCE_REF).trim()
  let bundleRoot = ''
  let localSource = false
  let allowExistingInstall = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') { yes = true; continue }
    if (a === '--dry-run' || a === '-n') { dryRun = true; continue }
    if (a === '--source-repo') { sourceRepo = argv[i + 1] || ''; i++; continue }
    if (a === '--source-ref') { sourceRef = argv[i + 1] || ''; i++; continue }
    if (a === '--bundle-root') { bundleRoot = argv[i + 1] || ''; i++; continue }
    if (a === '--local') { localSource = true; continue }
    if (a === '--path') { bundleRoot = argv[i + 1] || ''; localSource = true; i++; continue }
    if (a === '--service-manager') { serviceManager = argv[i + 1] || ''; i++; continue }
    if (a === '--state-root' || a === '--home' || a === '--dir') { requestedStateRoot = argv[i + 1] || ''; i++; continue }
    if (a === '--upgrade-existing') { allowExistingInstall = true; continue }
    if (a === '--current-user') { mode = 'current'; continue }
    if (a === '--user') { mode = 'existing'; targetUserName = argv[i + 1] || ''; i++; continue }
    if (a === '--create-user') { mode = 'create'; createUserName = argv[i + 1] || ''; i++; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin install [--yes] [--dry-run] [--state-root <path>] [--service-manager <auto|systemd|launchd|detached>] [--local [--path <repo>]] [--current-user | --user <name> | --create-user <name>]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const currentUser = currentUserRecord()
  const promptSession = !yes ? openInstallPromptInterface() : null
  const rl = promptSession ? promptSession.rl : null

  try {
    if (!mode && rl) {
      const targetChoices = installTargetChoices(currentUser, { dryRun })
      if (targetChoices.length === 1) {
        mode = 'current'
        console.error(`Install target: current user (${currentUser.username})`)
      } else {
        mode = await promptInstallChoice(rl, 'Rin install target', targetChoices)
      }
      if (mode === 'existing') targetUserName = await promptInstallText(rl, 'Existing username')
      if (mode === 'create') createUserName = await promptInstallText(rl, 'New username')
    }

    let targetUser = null
    if (!mode || mode === 'current') {
      targetUser = currentUser
    } else if (mode === 'existing') {
      if (!installCanManageExistingUsers()) {
        if (dryRun) {
          targetUser = lookupUserRecord(targetUserName)
          if (!targetUser) throw new Error(`user_not_found:${targetUserName}`)
        } else {
          if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('install_requires_root_for_other_user')
          throw new Error('install_existing_user_unsupported')
        }
      } else {
        targetUser = lookupUserRecord(targetUserName)
        if (!targetUser) throw new Error(`user_not_found:${targetUserName}`)
      }
    } else if (mode === 'create') {
      const nextName = safeString(createUserName).trim()
      if (!nextName) throw new Error('missing_create_user_name')
      if (!installCanCreateUsers()) {
        if (dryRun) {
          targetUser = lookupUserRecord(nextName) || previewUserRecordForInstall(nextName, currentUser)
        } else {
          if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('install_requires_root_to_create_user')
          throw new Error('install_create_user_unsupported')
        }
      } else {
        if (!lookupUserRecord(nextName)) {
          const created = spawnSync('useradd', ['-m', '-s', '/bin/bash', nextName], { stdio: 'inherit' })
          if (created.status !== 0) throw new Error(`useradd_failed:${nextName}`)
        }
        targetUser = lookupUserRecord(nextName)
        if (!targetUser) throw new Error(`user_lookup_failed:${nextName}`)
      }
    }

    let installConfig = null
    if (rl) {
      requestedStateRoot = await collectInstallStateRoot(rl, targetUser.homeDir, requestedStateRoot)
      serviceManager = await collectInstallServiceManager(rl, serviceManager)
      const providerConfig = await collectInstallProviderConfig(rl, {})
      const bridgeConfig = await collectInstallBridgeAccounts(rl)
      installConfig = mergeInstallConfigSections(providerConfig, bridgeConfig)
      console.error(summarizeInstallPlan({ targetUser, requestedStateRoot, installConfig, serviceManager, dryRun }))
      const confirmed = await promptInstallYesNo(rl, 'Proceed with this install', true)
      if (!confirmed) process.exit(1)
    }

    const resolvedBundleRoot = localSource ? resolveLocalBundleRoot(bundleRoot, process.cwd()) : safeString(bundleRoot).trim()
    if (localSource && resolvedBundleRoot && !dryRun) {
      await prepareLocalInstallBundle(resolvedBundleRoot)
    }
    const effectiveSourceRepo = localSource
      ? path.resolve(resolvedBundleRoot || process.cwd())
      : (safeString(sourceRepo).trim() || detectInstallSourceRepo())
    const effectiveSourceRef = localSource
      ? detectInstallSourceRefAt(path.resolve(resolvedBundleRoot || process.cwd()), 'local')
      : (safeString(sourceRef).trim() || detectInstallSourceRef())

    const result = performInstall({
      targetUser,
      homeDir: targetUser.homeDir,
      stateRoot: requestedStateRoot,
      serviceManager,
      overwriteManaged: true,
      allowExistingInstall,
      sourceRepo: effectiveSourceRepo,
      sourceRef: effectiveSourceRef,
      bundleRoot: resolvedBundleRoot,
      installConfig,
      dryRun,
    })
    if (!dryRun && targetUser && targetUser.username === currentUser.username) {
      try { ensureDaemonSystemdServiceFile() } catch {}
    }
    printJson(result)
  } finally {
    try { promptSession && promptSession.close() } catch {}
  }
}

async function cmdUpdate(argv) {
  let repo = ''
  let ref = ''
  let localSource = false
  let bundleRoot = ''

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') { repo = argv[i + 1] || ''; i += 1; continue }
    if (a === '--ref') { ref = argv[i + 1] || ''; i += 1; continue }
    if (a === '--local') { localSource = true; continue }
    if (a === '--path') { bundleRoot = argv[i + 1] || ''; localSource = true; i += 1; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin update [--repo <git-url>] [--ref <branch|tag|commit>] [--local [--path <repo>]]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const stateRoot = rootDir()
  const installMeta = readJson(path.join(stateRoot, 'install.json'), {})
  const installSource = installMeta && typeof installMeta === 'object' && installMeta.installSource && typeof installMeta.installSource === 'object'
    ? installMeta.installSource
    : {}
  const configuredSourceRepo = safeString(repo).trim() || safeString(installSource.repo).trim() || detectInstallSourceRepo()
  const serviceManager = safeString(installMeta && installMeta.serviceManager).trim() || 'auto'

  const localBundleRoot = resolveLocalBundleRoot(bundleRoot, localSource
    ? (configuredSourceRepo && isLocalBundlePath(configuredSourceRepo) ? configuredSourceRepo : process.cwd())
    : '')
  const shouldUseLocalSource = localSource || (configuredSourceRepo && isLocalBundlePath(configuredSourceRepo))

  if (shouldUseLocalSource) {
    const preparedBundleRoot = await prepareLocalInstallBundle(localBundleRoot || configuredSourceRepo)
    const localRepoPath = path.resolve(preparedBundleRoot)
    const localRef = safeString(ref).trim() || safeString(installSource.ref).trim() || detectInstallSourceRefAt(localRepoPath, 'local')
    const installArgs = [
      path.join(localRepoPath, 'dist', 'index.js'),
      '__install',
      '--current-user',
      '--yes',
      '--upgrade-existing',
      '--service-manager', serviceManager,
      '--bundle-root', localRepoPath,
      '--source-repo', localRepoPath,
      '--source-ref', localRef,
    ]
    await spawnChecked(process.execPath, installArgs, {
      cwd: localRepoPath,
    })
    if (detectDaemonSystemdService()) {
      await startDaemonRuntime('restart')
    }
    return
  }

  const repoUrl = normalizeGitUrl(configuredSourceRepo)
  const sourceRef = safeString(ref).trim() || safeString(installSource.ref).trim() || detectInstallSourceRef()
  const git = findExecutableOnPath('git')
  if (!git) throw new Error('git_not_found')

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-update-'))
  const cloneDir = path.join(tmpRoot, 'repo')
  try {
    let cloned = false
    if (sourceRef) {
      try {
        await spawnChecked(git, ['clone', '--depth', '1', '--branch', sourceRef, repoUrl, cloneDir], { cwd: tmpRoot })
        cloned = true
      } catch {}
    }
    if (!cloned) {
      await spawnChecked(git, ['clone', '--depth', '1', repoUrl, cloneDir], { cwd: tmpRoot })
      if (sourceRef) await spawnChecked(git, ['-C', cloneDir, 'checkout', sourceRef], { cwd: tmpRoot })
    }

    await spawnChecked('npm', npmInstallArgsFor(cloneDir), { cwd: cloneDir })
    await spawnChecked('npm', ['run', '-s', 'build'], { cwd: cloneDir })

    const installArgs = [
      path.join(cloneDir, 'dist', 'index.js'),
      '__install',
      '--current-user',
      '--yes',
      '--upgrade-existing',
      '--service-manager', serviceManager,
      '--source-repo', repoUrl,
      '--source-ref', sourceRef,
    ]
    await spawnChecked(process.execPath, installArgs, {
      cwd: cloneDir,
    })

    if (detectDaemonSystemdService()) {
      await startDaemonRuntime('restart')
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

async function cmdRestart(argv) {
  if (argv.some((arg) => arg === '-h' || arg === '--help' || arg === 'help')) {
    console.error('Usage:\n  rin restart')
    process.exit(0)
  }
  if (argv.length > 0) {
    console.error(`Unknown arg: ${argv[0]}`)
    usage(2)
  }
  await startDaemonRuntime('restart')
  console.log('Rin daemon restarted.')
}

async function cmdUninstall(argv) {
  let yes = false
  let mode = ''

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') { yes = true; continue }
    if (a === '--keep-state') { mode = 'keep'; continue }
    if (a === '--purge' || a === '--all') { mode = 'purge'; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      console.error('Usage:\n  rin uninstall [--yes] [--keep-state | --purge]')
      process.exit(0)
    }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }

  const currentStateRoot = rootDir()
  const choices = [
    { value: 'keep', label: `Remove the installed app and launcher, but keep ${currentStateRoot}` },
    { value: 'purge', label: `Remove Rin completely, including ${currentStateRoot}` },
  ]

  if (!mode && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      mode = await promptInstallChoice(rl, 'Rin uninstall mode', choices)
      const confirmed = await promptInstallYesNo(
        rl,
        mode === 'purge'
          ? `This will remove ${currentStateRoot} and the launcher. Continue`
          : `This will remove the installed app and launcher, but keep ${currentStateRoot}. Continue`,
        false,
      )
      if (!confirmed) process.exit(1)
      yes = true
    } finally {
      try { rl.close() } catch {}
    }
  }

  if (!mode) mode = 'keep'
  if (!yes) throw new Error('uninstall_requires_confirmation_or_yes')

  try { await removeDaemonManagedService() } catch {}

  printJson(performUninstall({ homeDir: os.homedir(), stateRoot: currentStateRoot, mode }))
}

function daemonPackageDir() {
  return repoDir()
}

function daemonLockPath() {
  return path.join(rootDir(), 'data', 'rin-daemon.lock')
}

function daemonDistPath() {
  return ensureRinDistFile('daemon.js')
}

function readDaemonPid() {
  try {
    const raw = fs.readFileSync(daemonLockPath(), 'utf8')
    const pid = Number(String(raw || '').trim())
    return Number.isFinite(pid) && pid > 1 ? pid : 0
  } catch {
    return 0
  }
}

async function waitForDaemonExit(timeoutMs = 20_000) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const pid = readDaemonPid()
    if (!pid || !isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function waitForDaemonStart(expectedPid = 0, timeoutMs = 20_000) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const pid = readDaemonPid()
    if (pid && isPidAlive(pid) && (!expectedPid || pid === expectedPid)) return pid
    await new Promise((r) => setTimeout(r, 200))
  }
  return 0
}

function sanitizeFileComponent(input) {
  const raw = safeString(input).trim()
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'default'
}

function inspectRuntimeRoot() {
  return path.join(rootDir(), 'data', 'inspect-runtime')
}

function inspectWorkPath(name) {
  return path.join(inspectRuntimeRoot(), `${sanitizeFileComponent(name)}.work.json`)
}

function inspectWorkLockPath(name) {
  return path.join(lockRootDir(), 'inspect-work', `${sanitizeFileComponent(name)}.lock`)
}

function defaultInspectWorkState() {
  return { version: 1, items: [] }
}

function normalizeInspectWorkItem(item) {
  const now = Date.now()
  const raw = item && typeof item === 'object' ? item : {}
  const createdAtMs = Number(raw.createdAtMs)
  const updatedAtMs = Number(raw.updatedAtMs)
  const availableAtMs = Number(raw.availableAtMs)
  const leaseUntilMs = Number(raw.leaseUntilMs)
  const attempts = Number(raw.attempts)
  const state = safeString(raw.state) || 'ready'
  const normalized = {
    ...raw,
    id: safeString(raw.id) || nodeCrypto.randomUUID(),
    state,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : now,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : (Number.isFinite(createdAtMs) ? createdAtMs : now),
    availableAtMs: Number.isFinite(availableAtMs) ? availableAtMs : (Number.isFinite(createdAtMs) ? createdAtMs : now),
    leaseOwner: safeString(raw.leaseOwner),
    leaseUntilMs: Number.isFinite(leaseUntilMs) ? leaseUntilMs : 0,
    attempts: Number.isFinite(attempts) ? attempts : 0,
    role: safeString(raw.role),
    kind: safeString(raw.kind),
    summary: safeString(raw.summary),
  }
  if (state !== 'leased') {
    normalized.leaseOwner = ''
    normalized.leaseUntilMs = 0
  }
  return normalized
}

function normalizeInspectWorkState(state) {
  const raw = state && typeof state === 'object' ? state : {}
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeInspectWorkItem) : []
  return { version: 1, items }
}

function readInspectWorkState(name) {
  const file = inspectWorkPath(name)
  const data = readJson(file, null)
  return normalizeInspectWorkState(data)
}

function writeInspectWorkState(name, state) {
  const file = inspectWorkPath(name)
  ensureDir(path.dirname(file))
  writeJsonAtomic(file, normalizeInspectWorkState(state))
}

function reviveExpiredInspectWorkLeases(state, now = Date.now()) {
  const base = normalizeInspectWorkState(state)
  let changed = false
  const items = base.items.map((item) => {
    if (safeString(item.state) !== 'leased') return item
    const leaseUntilMs = Number(item.leaseUntilMs) || 0
    if (!leaseUntilMs || leaseUntilMs > now) return item
    changed = true
    return {
      ...item,
      state: 'ready',
      leaseOwner: '',
      leaseUntilMs: 0,
      updatedAtMs: now,
      lastLeaseExpiredAtMs: now,
    }
  })
  return { state: { version: 1, items }, changed }
}

async function withInspectWorkState(name, fn) {
  const lockPath = inspectWorkLockPath(name)
  ensureDir(path.dirname(lockPath))
  const release = await acquireExclusiveFileLock(lockPath, {
    pollMs: 100,
    heartbeatMs: 10_000,
    staleMs: 5 * 60 * 1000,
    meta: { kind: 'inspect-work', name: safeString(name) },
  })
  try {
    const loaded = readInspectWorkState(name)
    const revived = reviveExpiredInspectWorkLeases(loaded)
    const value = await fn(revived.state)
    if (value && typeof value === 'object' && value.state) {
      writeInspectWorkState(name, value.state)
      return value.result
    }
    writeInspectWorkState(name, revived.state)
    return value
  } finally {
    try { release() } catch {}
  }
}

async function cmdTui(argv, { offline = false } = {}) {
  const sessionRoot = os.homedir()
  let noBootstrap = false
  let index = 0

  while (index < argv.length) {
    const a = argv[index]
    if (a === '--') { index += 1; break }
    if (a === '--no-bootstrap') { noBootstrap = true; index += 1; continue }
    if (a === '-h' || a === '--help' || a === 'help') {
      const hostPath = offline ? ensureRinTuiDebugHost() : ensureRinTuiHost()
      await spawnInherit(process.execPath, [hostPath, '--help'], {
        cwd: sessionRoot,
        env: {
          RIN_REPO_ROOT: repoDir(),
          PI_SKIP_VERSION_CHECK: '1',
        },
      })
      return
    }
    break
  }

  const hostArgs = argv.slice(index)
  const hostPath = offline ? ensureRinTuiDebugHost() : ensureRinTuiHost()
  if (!noBootstrap) ensurePiBootstrap()
  if (!offline) await ensureDaemonStarted()
  await spawnInherit(process.execPath, [hostPath, ...hostArgs], {
    cwd: sessionRoot,
    env: {
      RIN_REPO_ROOT: repoDir(),
      PI_SKIP_VERSION_CHECK: '1',
    },
  })
}

async function cmdPi(argv) {
  return await cmdTui(argv, { offline: false })
}

async function cmdOffline(argv) {
  return await cmdTui(argv, { offline: true })
}

function daemonStatusSnapshot() {
  const resolved = resolveDaemonManager()
  if (resolved.actual === 'systemd') {
    const daemonSystemctl = detectDaemonSystemdService()
    if (daemonSystemctl) {
      const { active, pid } = readDaemonSystemdPid(daemonSystemctl)
      return { ok: true, running: active && !!pid, pid: active ? pid : 0, manager: 'systemd', systemctl: daemonSystemctl }
    }
  }
  if (resolved.actual === 'launchd') {
    const launchctl = detectDaemonLaunchdService()
    if (launchctl) {
      const { active, pid } = readDaemonLaunchdPid()
      return { ok: true, running: active && !!pid, pid: active ? pid : 0, manager: 'launchd', launchctl }
    }
  }
  const pid = readDaemonPid()
  return { ok: true, running: Boolean(pid && isPidAlive(pid)), pid: pid && isPidAlive(pid) ? pid : 0, manager: resolved.actual }
}

async function ensureDaemonStarted() {
  const resolved = resolveDaemonManager()
  if (resolved.actual === 'systemd') {
    try { ensureDaemonSystemdServiceFile() } catch {}
    const daemonSystemctl = detectDaemonSystemdService()
    if (!daemonSystemctl) {
      if (resolved.requested === 'auto') return await startDetachedDaemonRuntime()
      return { ok: false, reason: 'systemd_unavailable' }
    }
    const current = readDaemonSystemdPid(daemonSystemctl)
    if (current.active && current.pid) return { ok: true, pid: current.pid, manager: 'systemd' }
    runDaemonSystemctl(daemonSystemctl, ['start', daemonSystemdServiceName()])
    const next = readDaemonSystemdPid(daemonSystemctl)
    if (!next.active || !next.pid) throw new Error('daemon_start_failed_systemd')
    return { ok: true, pid: next.pid, manager: 'systemd' }
  }
  if (resolved.actual === 'launchd') {
    const plistPath = ensureDaemonLaunchdServiceFile()
    const launchctl = findExecutableOnPath('launchctl')
    if (!launchctl) {
      if (resolved.requested === 'auto') return await startDetachedDaemonRuntime()
      return { ok: false, reason: 'launchd_unavailable' }
    }
    const current = readDaemonLaunchdPid()
    if (!current.active) {
      try { launchctlUser(['bootstrap', daemonLaunchdDomainTarget(), plistPath]) } catch {}
    }
    launchctlUser(['kickstart', '-k', daemonLaunchdServiceTarget()])
    const next = readDaemonLaunchdPid()
    if (!next.active) throw new Error('daemon_start_failed_launchd')
    await cleanupStrayDaemonProcesses({ keepPid: next.pid || 0 })
    return { ok: true, pid: next.pid || 0, manager: 'launchd' }
  }
  return await startDetachedDaemonRuntime()
}

async function stopDaemonRuntime() {
  const resolved = resolveDaemonManager()
  if (resolved.actual === 'systemd') {
    const daemonSystemctl = detectDaemonSystemdService()
    if (daemonSystemctl) {
      const { active } = readDaemonSystemdPid(daemonSystemctl)
      const hadManaged = Boolean(active)
      if (hadManaged) runDaemonSystemctl(daemonSystemctl, ['stop', daemonSystemdServiceName()])
      const cleaned = await cleanupStrayDaemonProcesses()
      return { stopped: hadManaged || cleaned.daemonPids.length > 0, manager: 'systemd' }
    }
  }
  if (resolved.actual === 'launchd') {
    const loaded = detectDaemonLaunchdService()
    if (loaded) {
      try { launchctlUser(['bootout', daemonLaunchdDomainTarget(), daemonLaunchdPlistPath()]) } catch {}
    }
    const cleaned = await cleanupStrayDaemonProcesses()
    return { stopped: Boolean(loaded) || cleaned.daemonPids.length > 0, manager: 'launchd' }
  }
  const pid = readDaemonPid()
  let stopped = false
  if (pid && isPidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if (!e || e.code !== 'ESRCH') throw e
    }
    stopped = await waitForDaemonExit(20_000)
    if (!stopped) throw new Error(`daemon_stop_timeout:${pid}`)
  }
  const cleaned = await cleanupStrayDaemonProcesses()
  return { stopped: stopped || cleaned.daemonPids.length > 0, manager: 'detached' }
}

async function startDaemonRuntime(action = 'restart') {
  const resolved = resolveDaemonManager()
  if (resolved.actual === 'systemd') {
    try { ensureDaemonSystemdServiceFile() } catch {}
    const daemonSystemctl = detectDaemonSystemdService()
    if (!daemonSystemctl) {
      if (resolved.requested === 'auto') return await startDetachedDaemonRuntime()
      throw new Error(`daemon_${action}_requires_systemd:${daemonSystemdServiceName()}`)
    }
    runDaemonSystemctl(daemonSystemctl, [action, daemonSystemdServiceName()])
    const { active, pid } = readDaemonSystemdPid(daemonSystemctl)
    if (!active || !pid) throw new Error(`daemon_${action}_failed_systemd`)
    await cleanupStrayDaemonProcesses({ keepPid: pid })
    return { ok: true, pid, manager: 'systemd' }
  }
  if (resolved.actual === 'launchd') {
    const plistPath = ensureDaemonLaunchdServiceFile()
    if (action === 'restart') {
      try { launchctlUser(['bootout', daemonLaunchdDomainTarget(), plistPath]) } catch {}
      const boot = launchctlUser(['bootstrap', daemonLaunchdDomainTarget(), plistPath])
      if (boot.status !== 0) throw new Error(`daemon_${action}_failed_launchd`)
      launchctlUser(['kickstart', '-k', daemonLaunchdServiceTarget()])
    } else if (action === 'start') {
      const current = readDaemonLaunchdPid()
      if (!current.active) {
        const boot = launchctlUser(['bootstrap', daemonLaunchdDomainTarget(), plistPath])
        if (boot.status !== 0) throw new Error(`daemon_${action}_failed_launchd`)
      }
      launchctlUser(['kickstart', '-k', daemonLaunchdServiceTarget()])
    } else {
      throw new Error(`daemon_${action}_unsupported_launchd`)
    }
    const { active, pid } = readDaemonLaunchdPid()
    if (!active) throw new Error(`daemon_${action}_failed_launchd`)
    await cleanupStrayDaemonProcesses({ keepPid: pid || 0 })
    return { ok: true, pid: pid || 0, manager: 'launchd' }
  }
  if (action === 'restart') {
    try { await stopDaemonRuntime() } catch {}
  }
  return await startDetachedDaemonRuntime()
}

async function removeDaemonManagedService() {
  const resolved = resolveDaemonManager()
  if (resolved.actual === 'systemd') {
    const unitPath = daemonSystemdUnitPath()
    const daemonSystemctl = detectDaemonSystemdService()
    if (daemonSystemctl) {
      try { runDaemonSystemctl(daemonSystemctl, ['disable', '--now', daemonSystemdServiceName()]) } catch {}
    } else {
      try { await stopDaemonRuntime() } catch {}
    }
    try { fs.rmSync(unitPath, { force: true }) } catch {}
    const reload = systemctlUser(['daemon-reload'])
    if (reload.status !== 0) {
      const msg = safeString(reload.stderr || reload.stdout).trim()
      if (msg) console.error(msg)
    }
    try { systemctlUser(['reset-failed']) } catch {}
    return unitPath
  }
  if (resolved.actual === 'launchd') {
    const plistPath = daemonLaunchdPlistPath()
    try { launchctlUser(['bootout', daemonLaunchdDomainTarget(), plistPath]) } catch {}
    try { fs.rmSync(plistPath, { force: true }) } catch {}
    return plistPath
  }
  try { await stopDaemonRuntime() } catch {}
  return ''
}

function systemctlUser(args) {
  const env = { ...process.env }
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!env.XDG_RUNTIME_DIR && uid != null) {
      const runtimeDir = `/run/user/${uid}`
      try { fs.accessSync(runtimeDir, fs.constants.R_OK | fs.constants.X_OK); env.XDG_RUNTIME_DIR = runtimeDir } catch {}
    }
    if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
      const bus = path.join(env.XDG_RUNTIME_DIR, 'bus')
      try { fs.accessSync(bus, fs.constants.R_OK | fs.constants.W_OK); env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}` } catch {}
    }
  } catch {}

  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env })
  return { status: r.status == null ? 1 : r.status, stdout: safeString(r.stdout), stderr: safeString(r.stderr) }
}

function daemonLaunchdLabel() {
  return 'moe.kneco.rin.daemon'
}

function daemonLaunchdDomainTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `gui/${uid}`
}

function daemonLaunchdServiceTarget() {
  return `${daemonLaunchdDomainTarget()}/${daemonLaunchdLabel()}`
}

function daemonLaunchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${daemonLaunchdLabel()}.plist`)
}

function daemonLaunchdPlistText() {
  const stateRoot = rootDir().replace(/\\/g, '/')
  const appRoot = path.dirname(path.dirname(daemonDistPath())).replace(/\\/g, '/')
  const repoRoot = appRoot
  const entry = daemonDistPath().replace(/\\/g, '/')
  const stdoutPath = path.join(rootDir(), 'data', 'daemon.stdout.log').replace(/\\/g, '/')
  const stderrPath = path.join(rootDir(), 'data', 'daemon.stderr.log').replace(/\\/g, '/')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${daemonLaunchdLabel()}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${process.execPath}</string>`,
    `    <string>${entry}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${appRoot}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>RIN_HOME</key><string>${stateRoot}</string>`,
    `    <key>RIN_REPO_ROOT</key><string>${repoRoot}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${stdoutPath}</string>`,
    `  <key>StandardErrorPath</key><string>${stderrPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function launchctlUser(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: r.status == null ? 1 : r.status, stdout: safeString(r.stdout), stderr: safeString(r.stderr) }
}

function ensureDaemonLaunchdServiceFile() {
  const plistPath = daemonLaunchdPlistPath()
  const text = daemonLaunchdPlistText()
  ensureDir(path.dirname(plistPath))
  const current = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : ''
  if (current !== text) fs.writeFileSync(plistPath, text, 'utf8')
  return plistPath
}

function detectDaemonLaunchdService() {
  if (process.platform !== 'darwin' || !findExecutableOnPath('launchctl')) return ''
  const out = launchctlUser(['print', daemonLaunchdServiceTarget()])
  if (out.status !== 0) return ''
  return 'launchctl'
}

function readDaemonLaunchdPid() {
  const out = launchctlUser(['print', daemonLaunchdServiceTarget()])
  if (out.status !== 0) return { active: false, pid: 0 }
  const text = `${out.stdout || ''}\n${out.stderr || ''}`
  const m = text.match(/\bpid = (\d+)\b/)
  const pid = m ? Number(m[1]) : 0
  return { active: true, pid: Number.isFinite(pid) && pid > 1 ? pid : 0 }
}

function configuredDaemonManager() {
  const installMeta = readJson(path.join(rootDir(), 'install.json'), {})
  const configured = safeString(installMeta && installMeta.serviceManager).trim()
  return configured || 'auto'
}

function daemonManagerAvailable(manager) {
  const name = safeString(manager).trim()
  if (name === 'systemd') return process.platform === 'linux' && Boolean(findExecutableOnPath('systemctl'))
  if (name === 'launchd') return process.platform === 'darwin' && Boolean(findExecutableOnPath('launchctl'))
  if (name === 'detached') return true
  return false
}

function resolveDaemonManager(preferred = '') {
  const requested = safeString(preferred || configuredDaemonManager()).trim() || 'auto'
  if (requested !== 'auto') return { requested, actual: requested }
  if (daemonManagerAvailable('systemd')) return { requested, actual: 'systemd' }
  if (daemonManagerAvailable('launchd')) return { requested, actual: 'launchd' }
  return { requested, actual: 'detached' }
}

async function waitForDetachedDaemonStart(timeoutMs = 15_000) {
  const deadline = Date.now() + Number(timeoutMs || 0)
  while (Date.now() < deadline) {
    const pid = readDaemonPid()
    if (pid && isPidAlive(pid)) return pid
    await new Promise((r) => setTimeout(r, 200))
  }
  return 0
}

async function startDetachedDaemonRuntime() {
  const daemonEntry = daemonDistPath()
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(path.dirname(daemonEntry)),
    env: {
      ...process.env,
      RIN_HOME: rootDir(),
      RIN_REPO_ROOT: repoDir(),
    },
  })
  child.unref()
  const pid = await waitForDetachedDaemonStart(15_000)
  if (!pid) throw new Error('daemon_start_failed_detached')
  await cleanupStrayDaemonProcesses({ keepPid: pid })
  return { ok: true, pid, manager: 'detached' }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)
  if (!cmd) return await cmdPi([])
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') usage(0)

  if (cmd === 'install') return await cmdInstall(rest)
  if (cmd === 'restart') return await cmdRestart(rest)
  if (cmd === 'update') return await cmdUpdate(rest)
  if (cmd === 'uninstall') return await cmdUninstall(rest)
  if (cmd === 'offline') return await cmdOffline(rest)
  if (cmd === '__install') return await cmdInstall(rest)

  if (safeString(cmd).startsWith('-')) return await cmdPi(argv)

  console.error(`Unknown arg: ${cmd}`)
  usage(2)
}

export {
  performInstall,
  performUninstall,
  installTargetChoices,
  formatCliErrorMessage,
}

if (require.main === module) {
  main().catch((e) => {
    console.error(formatCliErrorMessage(e))
    process.exitCode = 1
  })
}
