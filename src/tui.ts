// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DaemonTuiRpcClient } from './daemon-tui-rpc'
import { importPiCodingAgentModule, importPiTuiModule } from './pi-upstream'
import { resolveRinLayout } from './runtime-paths'

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function expandHome(value: string): string {
  const raw = safeString(value).trim()
  if (!raw) return ''
  if (raw === '~') return process.env.HOME || os.homedir()
  if (raw.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), raw.slice(2))
  return raw
}

let Container: any
let ProcessTerminal: any
let Spacer: any
let Text: any
let TUI: any
let TruncatedText: any
let matchesKey: any
let Loader: any
let DEFAULT_EDITOR_KEYBINDINGS: any

async function loadPiTuiBindings() {
  if (Container && TUI && Loader && DEFAULT_EDITOR_KEYBINDINGS) return
  const piTui = await importPiTuiModule()
  Container = piTui.Container
  ProcessTerminal = piTui.ProcessTerminal
  Spacer = piTui.Spacer
  Text = piTui.Text
  TUI = piTui.TUI
  TruncatedText = piTui.TruncatedText
  matchesKey = piTui.matchesKey
  Loader = piTui.Loader
  DEFAULT_EDITOR_KEYBINDINGS = piTui.DEFAULT_EDITOR_KEYBINDINGS
}

async function installBuiltinTuiKeybindings() {
  try {
    await loadPiTuiBindings()
    const defaults = DEFAULT_EDITOR_KEYBINDINGS
    if (!defaults || typeof defaults !== 'object') return
    const current = Array.isArray(defaults.newLine)
      ? defaults.newLine.map((value: any) => safeString(value).trim()).filter(Boolean)
      : [safeString(defaults.newLine).trim()].filter(Boolean)
    defaults.newLine = Array.from(new Set([...current, 'ctrl+j']))
  } catch {}
}

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  rin-tui [--session <path>] [--provider <id>] [--model <id>] [--thinking <level>]',
    '',
    'Runs the daemon-backed Rin TUI frontend.',
  ].join('\n')
  if (exitCode === 0) console.log(text)
  else console.error(text)
  process.exit(exitCode)
}

function parseArgs(argv: string[]) {
  let sessionFile = ''
  let provider = ''
  let model = ''
  let thinking = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help' || a === 'help') usage(0)
    if (a === '--session') { sessionFile = path.resolve(expandHome(argv[i + 1] || '')); i += 1; continue }
    if (a === '--provider') { provider = safeString(argv[i + 1]); i += 1; continue }
    if (a === '--model') { model = safeString(argv[i + 1]); i += 1; continue }
    if (a === '--thinking') { thinking = safeString(argv[i + 1]); i += 1; continue }
    console.error(`Unknown arg: ${a}`)
    usage(2)
  }
  return { sessionFile, provider, model, thinking }
}

class HeaderBar {
  constructor(private readonly getLine: () => string) {}
  invalidate() {}
  render(_width: number) { return [this.getLine()] }
}

function textBlock(lines: string[]) {
  return new Text((Array.isArray(lines) ? lines : []).join('\n'), 0, 0)
}

function extractMessageText(message: any) {
  const content = message && message.content
  if (typeof content === 'string') return content
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .filter((block: any) => block && block.type === 'text')
    .map((block: any) => safeString(block.text))
    .join('\n\n')
}

async function walkJsonlFiles(dir: string, output: string[] = []) {
  let entries: any[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkJsonlFiles(fullPath, output)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(fullPath)
  }
  return output
}

async function readSessionInfo(filePath: string) {
  const stat = await fs.stat(filePath)
  const raw = await fs.readFile(filePath, 'utf8')
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
  let header: any = null
  let name = ''
  let messageCount = 0
  let firstMessage = ''
  const allMessages: string[] = []
  for (const line of lines) {
    let entry: any = null
    try { entry = JSON.parse(line) } catch { continue }
    if (entry && entry.type === 'session') header = entry
    if (entry && entry.type === 'session_info' && entry.name) name = safeString(entry.name)
    if (entry && entry.type === 'message' && entry.message) {
      messageCount += 1
      const text = extractMessageText(entry.message).trim()
      if (text) {
        if (!firstMessage) firstMessage = text
        allMessages.push(text)
      }
    }
  }
  return {
    path: filePath,
    id: safeString(header && header.id) || path.basename(filePath, '.jsonl'),
    cwd: safeString(header && header.cwd),
    name: name || undefined,
    parentSessionPath: safeString(header && header.parentSession) || undefined,
    created: stat.birthtime || stat.mtime,
    modified: stat.mtime,
    messageCount,
    firstMessage,
    allMessagesText: allMessages.join('\n\n'),
  }
}

async function loadRinSessions(stateRoot: string, cwd?: string) {
  const sessionRoot = path.join(stateRoot, 'sessions')
  const files = await walkJsonlFiles(sessionRoot)
  const items = (await Promise.all(files.map(async (filePath) => {
    try { return await readSessionInfo(filePath) } catch { return null }
  }))).filter(Boolean)
  items.sort((a: any, b: any) => Number(b.modified) - Number(a.modified))
  if (!cwd) return items
  const target = path.resolve(cwd)
  const filtered = items.filter((item: any) => safeString(item.cwd) && path.resolve(item.cwd) === target)
  return filtered.length ? filtered : items
}

async function main() {
  await installBuiltinTuiKeybindings()
  const args = parseArgs(process.argv.slice(2))
  const stateRoot = resolveRinLayout().homeRoot

  const pi = await importPiCodingAgentModule()
  const { KeybindingsManager } = await importPiCodingAgentModule(path.join('dist', 'core', 'keybindings.js'))
  const { FooterDataProvider } = await importPiCodingAgentModule(path.join('dist', 'core', 'footer-data-provider.js'))
  const agentSessionMod = await importPiCodingAgentModule(path.join('dist', 'core', 'agent-session.js'))
  const themeMod = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'theme', 'theme.js'))

  const {
    AuthStorage,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    UserMessageComponent,
    AssistantMessageComponent,
    ToolExecutionComponent,
    BashExecutionComponent,
    FooterComponent,
    CustomMessageComponent,
    CompactionSummaryMessageComponent,
    BranchSummaryMessageComponent,
    SkillInvocationMessageComponent,
    appKey,
    UserMessageSelectorComponent,
    SessionSelectorComponent,
    SettingsSelectorComponent,
    ModelSelectorComponent,
    TreeSelectorComponent,
    CustomEditor,
  } = pi
  const { parseSkillBlock } = agentSessionMod
  const {
    getEditorTheme,
    getMarkdownTheme,
    getAvailableThemes,
    getThemeByName,
    setTheme,
    setThemeInstance,
    Theme,
    initTheme,
    theme,
  } = themeMod

  const authStorage = AuthStorage.create(path.join(stateRoot, 'auth.json'))
  const settingsManager = SettingsManager.create(stateRoot, stateRoot)
  const modelRegistry = new ModelRegistry(authStorage, path.join(stateRoot, 'models.json'))
  const keybindings = KeybindingsManager.create(stateRoot)

  try { initTheme(settingsManager.getTheme(), true) } catch {}
  const markdownTheme = getMarkdownTheme()
  const editorTheme = getEditorTheme()

  const tui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor())
  tui.setClearOnShrink(settingsManager.getClearOnShrink())

  const client = new DaemonTuiRpcClient(stateRoot)
  const root = new Container()
  const headerContainer = new Container()
  const chatContainer = new Container()
  const pendingMessagesContainer = new Container()
  const statusContainer = new Container()
  const widgetAbove = new Container()
  const widgetBelow = new Container()
  const editorContainer = new Container()

  const footerDataProvider = new FooterDataProvider()
  const extensionStatuses = new Map<string, string>()
  const extensionWidgetsAbove = new Map<string, any>()
  const extensionWidgetsBelow = new Map<string, any>()
  const toolMap = new Map<string, any>()
  let currentState: any = null
  let currentBottom: any = null
  let currentBottomFocus: any = null
  let activeAssistantStream: any = null
  let activeAssistantStreamMessageId = ''
  let hideThinkingBlock = settingsManager.getHideThinkingBlock()
  let showImages = settingsManager.getShowImages()
  let lastStatus = ''
  let currentMessages: any[] = []
  let currentSessionManager: any = null
  let lastEscapeTime = 0
  let lastSigintTime = 0
  let branchSummaryInFlight = false
  let statusLoader: any = null
  const pendingMessages: Array<{ mode: 'steer' | 'followUp', text: string }> = []

  const header = new HeaderBar(() => {
    const sessionName = safeString(currentState && currentState.sessionName).trim() || 'default'
    const model = currentState && currentState.model
      ? `${safeString(currentState.model.provider)}/${safeString(currentState.model.id)}`
      : 'no-model'
    const thinking = safeString(currentState && currentState.thinkingLevel).trim() || 'minimal'
    const pending = Number(currentState && currentState.pendingMessageCount || 0)
    const pendingText = pending > 0 ? `  pending:${pending}` : ''
    const subtitle = safeString(lastStatus || '').trim() || (currentState && currentState.isStreaming ? '处理中…' : '')
    return `Rin  [${sessionName}]  ${model}  thinking:${thinking}${pendingText}  ${subtitle}`
  })

  const footerSessionAdapter = {
    get state() {
      return {
        model: currentState && currentState.model || undefined,
        thinkingLevel: safeString(currentState && currentState.thinkingLevel).trim() || 'minimal',
      }
    },
    sessionManager: {
      getEntries: () => currentSessionManager && typeof currentSessionManager.getEntries === 'function' ? currentSessionManager.getEntries() : [],
      getSessionName: () => currentSessionManager && typeof currentSessionManager.getSessionName === 'function' ? currentSessionManager.getSessionName() : safeString(currentState && currentState.sessionName || '') || undefined,
    },
    modelRegistry,
    getContextUsage: () => undefined,
  }
  const footer = new FooterComponent(footerSessionAdapter as any, footerDataProvider)
  footer.setAutoCompactEnabled(Boolean(currentState && currentState.autoCompactionEnabled))

  function renderWidgets() {
    widgetAbove.clear()
    widgetBelow.clear()
    if (extensionWidgetsAbove.size > 0) widgetAbove.addChild(new Spacer(1))
    for (const component of extensionWidgetsAbove.values()) widgetAbove.addChild(component)
    if (extensionWidgetsBelow.size > 0) widgetBelow.addChild(new Spacer(1))
    for (const component of extensionWidgetsBelow.values()) widgetBelow.addChild(component)
  }

  function renderPendingMessages() {
    pendingMessagesContainer.clear()
    if (!pendingMessages.length) return
    pendingMessagesContainer.addChild(new Spacer(1))
    for (const message of pendingMessages) {
      const prefix = message.mode === 'followUp' ? 'Follow-up: ' : 'Steering: '
      pendingMessagesContainer.addChild(new TruncatedText(prefix + message.text, 1, 0))
    }
    pendingMessagesContainer.addChild(new TruncatedText('↳ 已排队，等待当前轮次结束', 1, 0))
  }

  function renderStatusContainer() {
    statusContainer.clear()
    if (statusLoader) {
      statusContainer.addChild(new Spacer(1))
      statusContainer.addChild(statusLoader)
      return
    }
    const text = safeString(lastStatus).trim()
    if (!text) return
    statusContainer.addChild(new Spacer(1))
    statusContainer.addChild(new TruncatedText(text, 1, 0))
  }

  function clearStatusLoader() {
    if (!statusLoader) return
    try { statusLoader.stop?.() } catch {}
    statusLoader = null
  }

  function setStatusLoader(message: string) {
    clearStatusLoader()
    statusLoader = new Loader(
      tui,
      (s: string) => theme.fg('accent', s),
      (s: string) => theme.fg('muted', s),
      message,
    )
    try { statusLoader.start?.() } catch {}
    requestRender()
  }

  function rebuildHeader() {
    headerContainer.clear()
    if (!settingsManager.getQuietStartup()) {
      const instructions = [
        `${appKey(keybindings, 'interrupt')} to interrupt`,
        `${appKey(keybindings, 'clear')} to clear`,
        `${appKey(keybindings, 'clear')} twice to exit`,
        `${appKey(keybindings, 'exit')} to exit (empty)`,
        `${appKey(keybindings, 'cycleThinkingLevel')} to cycle thinking level`,
        `${appKey(keybindings, 'selectModel')} to select model`,
        `/ for commands`,
        `! to run bash`,
        `!! to run bash (no context)`,
        `${appKey(keybindings, 'followUp')} to queue follow-up`,
        `${appKey(keybindings, 'dequeue')} to edit all queued messages`,
        `Ctrl+P to toggle session path in resume`,
      ].join('\n')
      headerContainer.addChild(new Spacer(1))
      headerContainer.addChild(textBlock(['Rin', instructions]))
      headerContainer.addChild(new Spacer(1))
      headerContainer.addChild(header as any)
    } else {
      headerContainer.addChild(header as any)
    }
  }

  function requestRender() {
    header.invalidate()
    rebuildHeader()
    renderPendingMessages()
    renderStatusContainer()
    footer.setAutoCompactEnabled(Boolean(currentState && currentState.autoCompactionEnabled))
    tui.requestRender()
  }

  function setBottom(component: any, focus?: any) {
    editorContainer.clear()
    editorContainer.addChild(component)
    currentBottom = component
    currentBottomFocus = focus || component
    tui.setFocus(currentBottomFocus)
    requestRender()
  }

  function setStatus(text = '') {
    clearStatusLoader()
    lastStatus = safeString(text)
    requestRender()
  }

  function appendSystemNotice(text: string) {
    chatContainer.addChild(textBlock([safeString(text)]))
    requestRender()
  }

  function clearChatState() {
    chatContainer.clear()
    toolMap.clear()
    activeAssistantStream = null
    activeAssistantStreamMessageId = ''
  }

  function getUserText(message: any) {
    const content = message && message.content
    if (typeof content === 'string') return content
    const blocks = Array.isArray(content) ? content : []
    return blocks.filter((block: any) => block && block.type === 'text').map((block: any) => safeString(block.text)).join('\n\n')
  }

  function buildAssistantToolComponents(message: any) {
    const blocks = Array.isArray(message && message.content) ? message.content : []
    const components: any[] = []
    for (const block of blocks) {
      if (!block || block.type !== 'toolCall') continue
      const tool = new ToolExecutionComponent(
        safeString(block.name || ''),
        block.arguments || {},
        { showImages },
        undefined,
        tui,
        process.env.HOME || os.homedir(),
      )
      try { tool.setArgsComplete?.() } catch {}
      const toolCallId = safeString(block.id || '')
      if (toolCallId) toolMap.set(toolCallId, tool)
      components.push(tool)
    }
    return components
  }

  function renderMessageHistory(messages: any[]) {
    clearChatState()
    currentMessages = Array.isArray(messages) ? messages.slice() : []
    for (const message of currentMessages) {
      const role = safeString(message && message.role)
      if (role === 'user') {
        const text = getUserText(message)
        const skillBlock = text ? parseSkillBlock(text) : null
        if (skillBlock) {
          chatContainer.addChild(new Spacer(1))
          const skillComponent = new SkillInvocationMessageComponent(skillBlock, markdownTheme)
          chatContainer.addChild(skillComponent)
          if (skillBlock.userMessage) chatContainer.addChild(new UserMessageComponent(skillBlock.userMessage, markdownTheme))
        } else {
          chatContainer.addChild(new UserMessageComponent(text, markdownTheme))
        }
        chatContainer.addChild(new Spacer(1))
        continue
      }
      if (role === 'assistant') {
        const component = new AssistantMessageComponent(message, hideThinkingBlock, markdownTheme)
        chatContainer.addChild(component)
        for (const tool of buildAssistantToolComponents(message)) chatContainer.addChild(tool)
        chatContainer.addChild(new Spacer(1))
        continue
      }
      if (role === 'custom') {
        if (message && message.display) {
          chatContainer.addChild(new CustomMessageComponent(message, undefined, markdownTheme))
          chatContainer.addChild(new Spacer(1))
        }
        continue
      }
      if (role === 'compactionSummary') {
        chatContainer.addChild(new Spacer(1))
        chatContainer.addChild(new CompactionSummaryMessageComponent(message, markdownTheme))
        chatContainer.addChild(new Spacer(1))
        continue
      }
      if (role === 'branchSummary') {
        chatContainer.addChild(new Spacer(1))
        chatContainer.addChild(new BranchSummaryMessageComponent(message, markdownTheme))
        chatContainer.addChild(new Spacer(1))
        continue
      }
      if (role === 'toolResult') {
        const toolCallId = safeString(message && message.toolCallId)
        const tool = toolMap.get(toolCallId)
        if (tool) {
          tool.updateResult({ content: Array.isArray(message.content) ? message.content : [], isError: Boolean(message.isError), details: message.details || {} }, false)
        }
        continue
      }
      if (role === 'bashExecution') {
        const component = new BashExecutionComponent(safeString(message && message.command || ''), tui, Boolean(message && message.excludeFromContext))
        if (safeString(message && message.output || '')) component.appendOutput(safeString(message.output))
        component.setComplete(message && message.exitCode, Boolean(message && message.cancelled), message && message.truncated ? { truncated: true } : undefined, safeString(message && message.fullOutputPath || '') || undefined)
        chatContainer.addChild(component)
        chatContainer.addChild(new Spacer(1))
        continue
      }
    }
    requestRender()
  }

  async function reloadMessages() {
    const messages = await client.getMessages()
    renderMessageHistory(messages)
  }

  async function refreshState() {
    currentState = await client.getState()
    const pendingCount = Number(currentState && currentState.pendingMessageCount || 0)
    if (pendingCount <= 0) pendingMessages.splice(0, pendingMessages.length)
    else if (pendingMessages.length > pendingCount) pendingMessages.splice(0, pendingMessages.length - pendingCount)
    const sessionFile = safeString(currentState && currentState.sessionFile).trim()
    currentSessionManager = sessionFile ? SessionManager.open(sessionFile) : null
    const availableModels = await client.getAvailableModels().catch(() => [])
    footerDataProvider.setAvailableProviderCount(new Set((availableModels || []).map((item: any) => safeString(item && item.provider))).size)
    requestRender()
  }

  function closeBottomAndRestoreEditor() {
    setBottom(editor, editor)
  }

  async function openSettingsSelector() {
    const selector = new SettingsSelectorComponent({
      autoCompact: Boolean(currentState && currentState.autoCompactionEnabled),
      showImages: settingsManager.getShowImages(),
      autoResizeImages: settingsManager.getImageAutoResize(),
      blockImages: settingsManager.getBlockImages(),
      enableSkillCommands: settingsManager.getEnableSkillCommands(),
      steeringMode: currentState && currentState.steeringMode || settingsManager.getSteeringMode(),
      followUpMode: currentState && currentState.followUpMode || settingsManager.getFollowUpMode(),
      transport: settingsManager.getTransport(),
      thinkingLevel: currentState && currentState.thinkingLevel || settingsManager.getDefaultThinkingLevel() || 'minimal',
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      currentTheme: settingsManager.getTheme() || 'dark',
      availableThemes: getAvailableThemes(),
      hideThinkingBlock,
      collapseChangelog: settingsManager.getCollapseChangelog(),
      doubleEscapeAction: settingsManager.getDoubleEscapeAction(),
      treeFilterMode: settingsManager.getTreeFilterMode(),
      showHardwareCursor: settingsManager.getShowHardwareCursor(),
      editorPaddingX: settingsManager.getEditorPaddingX(),
      autocompleteMaxVisible: settingsManager.getAutocompleteMaxVisible(),
      quietStartup: settingsManager.getQuietStartup(),
      clearOnShrink: settingsManager.getClearOnShrink(),
    }, {
      onAutoCompactChange: async (enabled: boolean) => {
        settingsManager.setCompactionEnabled(enabled)
        await client.setAutoCompaction(enabled)
        await refreshState()
      },
      onShowImagesChange: (enabled: boolean) => {
        showImages = enabled
        settingsManager.setShowImages(enabled)
        for (const tool of toolMap.values()) {
          try { tool.setShowImages(enabled) } catch {}
        }
        requestRender()
      },
      onAutoResizeImagesChange: (enabled: boolean) => settingsManager.setImageAutoResize(enabled),
      onBlockImagesChange: (blocked: boolean) => settingsManager.setBlockImages(blocked),
      onEnableSkillCommandsChange: (enabled: boolean) => settingsManager.setEnableSkillCommands(enabled),
      onSteeringModeChange: async (mode: 'all' | 'one-at-a-time') => {
        settingsManager.setSteeringMode(mode)
        await client.setSteeringMode(mode)
        await refreshState()
      },
      onFollowUpModeChange: async (mode: 'all' | 'one-at-a-time') => {
        settingsManager.setFollowUpMode(mode)
        await client.setFollowUpMode(mode)
        await refreshState()
      },
      onTransportChange: (transport: any) => settingsManager.setTransport(transport),
      onThinkingLevelChange: async (level: string) => {
        settingsManager.setDefaultThinkingLevel(level as any)
        await client.setThinkingLevel(level)
        await refreshState()
      },
      onThemeChange: (themeName: string) => {
        const result = setTheme(themeName, true)
        settingsManager.setTheme(themeName)
        if (!result.success) appendSystemNotice(`theme load failed: ${safeString(result.error || '')}`)
        tui.invalidate()
        requestRender()
      },
      onThemePreview: (themeName: string) => {
        const result = setTheme(themeName, true)
        if (result.success) {
          tui.invalidate()
          requestRender()
        }
      },
      onHideThinkingBlockChange: (hidden: boolean) => {
        hideThinkingBlock = hidden
        settingsManager.setHideThinkingBlock(hidden)
        renderMessageHistory(currentMessages)
      },
      onCollapseChangelogChange: (collapsed: boolean) => settingsManager.setCollapseChangelog(collapsed),
      onDoubleEscapeActionChange: (action: any) => settingsManager.setDoubleEscapeAction(action),
      onTreeFilterModeChange: (mode: any) => settingsManager.setTreeFilterMode(mode),
      onShowHardwareCursorChange: (enabled: boolean) => {
        settingsManager.setShowHardwareCursor(enabled)
        tui.setShowHardwareCursor(enabled)
      },
      onEditorPaddingXChange: (padding: number) => {
        settingsManager.setEditorPaddingX(padding)
        try { editor.setPaddingX?.(padding) } catch {}
      },
      onAutocompleteMaxVisibleChange: (maxVisible: number) => {
        settingsManager.setAutocompleteMaxVisible(maxVisible)
        try { editor.setAutocompleteMaxVisible?.(maxVisible) } catch {}
      },
      onQuietStartupChange: (enabled: boolean) => settingsManager.setQuietStartup(enabled),
      onClearOnShrinkChange: (enabled: boolean) => {
        settingsManager.setClearOnShrink(enabled)
        tui.setClearOnShrink(enabled)
      },
      onCancel: () => closeBottomAndRestoreEditor(),
    })
    setBottom(selector, selector.getSettingsList())
  }

  async function openSessionSelector() {
    const currentSessionCwd = safeString(currentState && currentState.sessionCwd).trim()
    const selector = new SessionSelectorComponent(
      () => loadRinSessions(stateRoot, currentSessionCwd || process.cwd()),
      () => loadRinSessions(stateRoot),
      async (sessionPath: string) => {
        closeBottomAndRestoreEditor()
        await client.switchSession(sessionPath)
        await refreshState()
        await reloadMessages()
        setStatus('已切换会话')
      },
      () => closeBottomAndRestoreEditor(),
      () => void exit(),
      () => requestRender(),
      {
        keybindings,
        renameSession: async (sessionPath: string, nextName: string) => {
          const name = safeString(nextName).trim()
          if (!name) return
          if (safeString(currentState && currentState.sessionFile) === sessionPath) {
            await client.setSessionName(name)
            await refreshState()
            return
          }
          const manager = SessionManager.open(sessionPath)
          manager.appendSessionInfo(name)
        },
        showRenameHint: true,
      },
      safeString(currentState && currentState.sessionFile || ''),
    )
    setBottom(selector, selector.getSessionList())
  }

  async function openTreeSelector(initialSelectedId = '') {
    const sessionFile = safeString(currentState && currentState.sessionFile).trim()
    if (!sessionFile) {
      setStatus('当前没有可浏览的会话树')
      return
    }
    const manager = SessionManager.open(sessionFile)
    const tree = manager.getTree()
    const leafId = manager.getLeafId()
    if (!tree.length) {
      setStatus('当前会话还没有可浏览的节点')
      return
    }
    const selector = new TreeSelectorComponent(
      tree,
      leafId,
      tui.terminal.rows,
      async (entryId: string) => {
        if (entryId === leafId) {
          closeBottomAndRestoreEditor()
          setStatus('已经在这个节点')
          return
        }
        closeBottomAndRestoreEditor()
        let summarize = false
        let customInstructions = ''
        if (!settingsManager.getBranchSummarySkipPrompt()) {
          const choice = await showChoiceDialog('Summarize branch?', ['No summary', 'Summarize', 'Summarize with custom prompt'])
          if (choice == null) {
            void openTreeSelector(entryId)
            return
          }
          summarize = choice !== 'No summary'
          if (choice === 'Summarize with custom prompt') {
            const edited = await showEditorDialog('Custom summarization instructions')
            if (edited == null) {
              void openTreeSelector(entryId)
              return
            }
            customInstructions = edited
          }
        }
        try {
          if (summarize) {
            branchSummaryInFlight = true
            lastStatus = ''
            setStatusLoader('Summarizing branch…')
          }
          const result = await client.navigateTree(entryId, { summarize, customInstructions })
          if (result && result.cancelled) {
            setStatus('导航已取消')
            return
          }
          if (result && result.aborted) {
            setStatus('导航被中断')
            return
          }
          await refreshState()
          await reloadMessages()
          if (result && result.editorText && !safeString(editor.getText?.() || '').trim()) editor.setText(result.editorText)
          setStatus('已跳转到所选节点')
        } catch (e: any) {
          appendSystemNotice(safeString(e && e.message ? e.message : e))
        } finally {
          branchSummaryInFlight = false
          clearStatusLoader()
        }
      },
      () => closeBottomAndRestoreEditor(),
      (entryId: string, label: string | undefined) => {
        try {
          const labelManager = SessionManager.open(sessionFile)
          const nextLabel = safeString(label).trim() || undefined
          labelManager.appendLabelChange(entryId, nextLabel)
        } catch (e: any) {
          appendSystemNotice(safeString(e && e.message ? e.message : e))
        }
      },
      initialSelectedId || undefined,
      settingsManager.getTreeFilterMode(),
    )
    setBottom(selector, selector.getTreeList())
  }

  async function openForkSelector() {
    const items = await client.getForkMessages()
    if (!items.length) {
      setStatus('没有可分叉的消息')
      return
    }
    const selector = new UserMessageSelectorComponent(items.map((item: any) => ({ id: item.entryId, text: item.text })), async (entryId: string) => {
      const result = await client.fork(entryId)
      closeBottomAndRestoreEditor()
      if (result && result.text) editor.setText(result.text)
      await refreshState()
      await reloadMessages()
      setStatus('已创建分叉会话')
    }, () => closeBottomAndRestoreEditor())
    setBottom(selector, selector.getMessageList())
  }

  async function openModelSelector(initialSearch = '') {
    const selector = new ModelSelectorComponent(
      tui,
      currentState && currentState.model || undefined,
      settingsManager,
      modelRegistry,
      [],
      async (model: any) => {
        await client.setModel(safeString(model.provider), safeString(model.id))
        closeBottomAndRestoreEditor()
        await refreshState()
        setStatus(`Model: ${safeString(model.id)}`)
      },
      () => closeBottomAndRestoreEditor(),
      initialSearch,
    )
    setBottom(selector, selector)
  }

  function showChoiceDialog(title: string, options: string[]) {
    return new Promise<string | undefined>((resolve) => {
      const selector = new pi.ExtensionSelectorComponent(
        title,
        options,
        (value: string) => {
          closeBottomAndRestoreEditor()
          resolve(value)
        },
        () => {
          closeBottomAndRestoreEditor()
          resolve(undefined)
        },
        { tui },
      )
      setBottom(selector, selector)
    })
  }

  function showEditorDialog(title: string, prefill = '') {
    return new Promise<string | undefined>((resolve) => {
      const component = new pi.ExtensionEditorComponent(
        tui,
        keybindings,
        title,
        prefill,
        (value: string) => {
          closeBottomAndRestoreEditor()
          resolve(value)
        },
        () => {
          closeBottomAndRestoreEditor()
          resolve(undefined)
        },
      )
      setBottom(component, component)
    })
  }

  const editor = new CustomEditor(tui, editorTheme, keybindings)
  editor.onEscape = () => {
    if (branchSummaryInFlight) {
      setStatus('正在取消分支整理…')
      void client.abortBranchSummary().catch(() => {})
      return
    }
    if (currentState && currentState.isCompacting) {
      setStatus('正在取消整理…')
      void client.abortCompaction().catch(() => {})
      return
    }
    if (currentState && currentState.isRetrying) {
      setStatus('正在取消重试…')
      void client.abortRetry().catch(() => {})
      return
    }
    if (currentState && currentState.isBashRunning) {
      setStatus('正在中断 Bash…')
      void client.abortBash().catch(() => {})
      return
    }
    if (currentState && currentState.isStreaming) {
      setStatus('请求中断…')
      void client.abort().catch(() => {})
      return
    }
    if (safeString(editor.getText?.() || '').trim()) return
    const action = settingsManager.getDoubleEscapeAction()
    if (action === 'none') return
    const now = Date.now()
    if (now - lastEscapeTime < 500) {
      lastEscapeTime = 0
      if (action === 'tree') void openTreeSelector()
      else void openForkSelector()
      return
    }
    lastEscapeTime = now
    setStatus(action === 'tree' ? '再按一次 Esc 打开会话树' : '再按一次 Esc 打开分叉选择')
  }
  editor.onCtrlD = () => { void exit() }
  editor.onAction('selectModel', () => { void openModelSelector() })
  editor.onAction('tree', () => { void openTreeSelector() })
  editor.onAction('cycleThinkingLevel', async () => {
    const result = await client.cycleThinkingLevel()
    if (result && result.level) settingsManager.setDefaultThinkingLevel(result.level)
    await refreshState()
  })
  editor.onAction('cycleModelForward', async () => {
    await client.cycleModel('forward')
    await refreshState()
  })
  editor.onAction('cycleModelBackward', async () => {
    await client.cycleModel('backward')
    await refreshState()
  })
  editor.onAction('newSession', async () => {
    await client.newSession()
    await refreshState()
    await reloadMessages()
    setStatus('新会话已创建')
  })
  editor.onAction('resume', () => { void openSessionSelector() })
  editor.onAction('fork', () => { void openForkSelector() })
  editor.onAction('followUp', () => {
    const text = safeString(editor.getText?.() || '').trim()
    if (!text) return
    void submitUserText(text, 'followUp')
  })
  editor.onAction('dequeue', async () => {
    const cleared = await client.clearQueue().catch(() => ({ steering: [], followUp: [] }))
    pendingMessages.splice(0, pendingMessages.length)
    const combined = [...(cleared.steering || []), ...(cleared.followUp || [])].filter(Boolean).join('\n\n')
    if (combined) {
      const current = safeString(editor.getText?.() || '').trim()
      editor.setText([combined, current].filter(Boolean).join('\n\n'))
      setStatus('已将排队消息放回编辑器')
    } else {
      setStatus('当前没有排队消息')
    }
    await refreshState()
  })
  editor.onAction('clear', () => {
    const now = Date.now()
    if (safeString(editor.getText?.() || '')) editor.setText('')
    if (now - lastSigintTime < 500) {
      void exit()
      return
    }
    lastSigintTime = now
    setStatus('已清空输入，再按一次 Ctrl+C 退出')
  })

  async function submitUserText(rawText: string, queuedMode?: 'steer' | 'followUp') {
    const value = safeString(rawText).trim()
    if (!value) return
    editor.setText('')
    if (localCommands[value]) {
      try { await localCommands[value]() } catch (e: any) { appendSystemNotice(safeString(e && e.message ? e.message : e)) }
      return
    }
    if (value.startsWith('!')) {
      const excluded = value.startsWith('!!')
      const command = (excluded ? value.slice(2) : value.slice(1)).trim()
      if (!command) return
      if (currentState && currentState.isBashRunning) {
        appendSystemNotice('已有 Bash 在运行，先等它结束，或按 Esc 中断。')
        editor.setText(value)
        return
      }
      setStatus(excluded ? '执行 Bash（不进入上下文）…' : '执行 Bash…')
      try {
        await client.bash(command)
        await refreshState()
        await reloadMessages()
      } catch (e: any) {
        appendSystemNotice(safeString(e && e.message ? e.message : e))
      }
      return
    }
    const isStreaming = Boolean(currentState && currentState.isStreaming)
    const mode = queuedMode || 'steer'
    if (!isStreaming) {
      chatContainer.addChild(new UserMessageComponent(value, markdownTheme))
      chatContainer.addChild(new Spacer(1))
      requestRender()
    } else {
      pendingMessages.push({ mode, text: value })
      setStatus(mode === 'followUp' ? '已加入 follow-up 队列' : '已加入当前轮次')
      requestRender()
    }
    try {
      if (isStreaming) {
        if (mode === 'followUp') await client.followUp(value)
        else await client.prompt(value, [], 'steer')
      } else {
        await client.prompt(value)
      }
      await refreshState()
    } catch (e: any) {
      appendSystemNotice(safeString(e && e.message ? e.message : e))
    }
  }

  const localCommands: Record<string, () => Promise<void>> = {
    '/help': async () => {
      appendSystemNotice('本地命令：/help /settings /resume /tree /fork /model /new /clear /commands')
      appendSystemNotice('Esc 双击可按设置打开会话树或分叉；Ctrl+C 清空输入，再按一次退出。')
      appendSystemNotice('还有原生风格的 follow-up 与 dequeue 快捷键，可排队或取回消息。')
      appendSystemNotice('会话选择器支持 Tab 切范围、Ctrl+R 重命名、Ctrl+D 删除。')
      appendSystemNotice('其余 /xxx 会原样交给后端。需要兜底时可用 `rin pi`。')
    },
    '/settings': openSettingsSelector,
    '/resume': openSessionSelector,
    '/tree': () => openTreeSelector(),
    '/fork': openForkSelector,
    '/model': () => openModelSelector(),
    '/new': async () => {
      await client.newSession()
      await refreshState()
      await reloadMessages()
      setStatus('新会话已创建')
    },
    '/clear': async () => {
      clearChatState()
      requestRender()
    },
    '/commands': async () => {
      const commands = await client.getCommands()
      appendSystemNotice(`可用命令 ${commands.length} 个：`)
      for (const item of commands) appendSystemNotice(`/${safeString(item.name)} ${safeString(item.description || '')}`)
    },
  }

  editor.onSubmit = async (text: string) => {
    await submitUserText(text)
  }

  function handleExtensionUi(req: any) {
    const id = safeString(req && req.id)
    const method = safeString(req && req.method)
    if (!id || !method) return
    if (method === 'notify') {
      appendSystemNotice(safeString(req.message || ''))
      return
    }
    if (method === 'setStatus') {
      const key = safeString(req.statusKey || '')
      const text = safeString(req.statusText || '')
      if (text) extensionStatuses.set(key, text)
      else extensionStatuses.delete(key)
      footerDataProvider.setExtensionStatus(key, text || undefined)
      requestRender()
      return
    }
    if (method === 'setWidget') {
      const key = safeString(req.widgetKey || '')
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines.map((line: any) => safeString(line)) : []
      const placement = safeString(req.widgetPlacement || 'aboveEditor')
      const target = placement === 'belowEditor' ? extensionWidgetsBelow : extensionWidgetsAbove
      if (!lines.length) target.delete(key)
      else target.set(key, textBlock(lines))
      renderWidgets()
      requestRender()
      return
    }
    if (method === 'setTitle') {
      try { tui.terminal.setTitle(safeString(req.title || 'Rin')) } catch {}
      return
    }
    if (method === 'set_editor_text') {
      editor.setText(safeString(req.text || ''))
      requestRender()
      return
    }
    if (method === 'select') {
      const selector = new pi.ExtensionSelectorComponent(
        safeString(req.title || 'Select'),
        Array.isArray(req.options) ? req.options.map((value: any) => safeString(value)) : [],
        (value: string) => {
          client.replyExtensionUi(id, { value })
          closeBottomAndRestoreEditor()
        },
        () => {
          client.replyExtensionUi(id, { cancelled: true })
          closeBottomAndRestoreEditor()
        },
        { tui, timeout: Number(req.timeout || 0) || undefined },
      )
      setBottom(selector, selector)
      return
    }
    if (method === 'confirm') {
      const selector = new pi.ExtensionSelectorComponent(
        `${safeString(req.title || 'Confirm')}\n${safeString(req.message || '')}`.trim(),
        ['Yes', 'No'],
        (value: string) => {
          client.replyExtensionUi(id, { confirmed: value === 'Yes' })
          closeBottomAndRestoreEditor()
        },
        () => {
          client.replyExtensionUi(id, { cancelled: true })
          closeBottomAndRestoreEditor()
        },
        { tui, timeout: Number(req.timeout || 0) || undefined },
      )
      setBottom(selector, selector)
      return
    }
    if (method === 'input') {
      const input = new pi.ExtensionInputComponent(
        safeString(req.title || 'Input'),
        safeString(req.placeholder || ''),
        (value: string) => {
          client.replyExtensionUi(id, { value })
          closeBottomAndRestoreEditor()
        },
        () => {
          client.replyExtensionUi(id, { cancelled: true })
          closeBottomAndRestoreEditor()
        },
        { tui, timeout: Number(req.timeout || 0) || undefined },
      )
      setBottom(input, input)
      return
    }
    if (method === 'editor') {
      const component = new pi.ExtensionEditorComponent(
        tui,
        keybindings,
        safeString(req.title || 'Editor'),
        safeString(req.prefill || ''),
        (value: string) => {
          client.replyExtensionUi(id, { value })
          closeBottomAndRestoreEditor()
        },
        () => {
          client.replyExtensionUi(id, { cancelled: true })
          closeBottomAndRestoreEditor()
        },
      )
      setBottom(component, component)
    }
  }

  client.onEvent((event: any) => {
    const type = safeString(event && event.type)
    if (type === 'extension_ui_request') return handleExtensionUi(event)
    if (type === 'client_error') return appendSystemNotice(`client error: ${safeString(event.error || '')}`)
    if (type === 'client_close') return appendSystemNotice('daemon 连接已关闭')
    if (type === 'agent_start') {
      void refreshState().catch(() => {})
      lastStatus = ''
      setStatusLoader('Working…')
      return
    }
    if (type === 'agent_end') {
      activeAssistantStream = null
      activeAssistantStreamMessageId = ''
      clearStatusLoader()
      return Promise.allSettled([refreshState(), reloadMessages()]).then(() => requestRender()).catch(() => {})
    }
    if (type === 'message_update') {
      const partialMessage = event && event.message
      if (safeString(partialMessage && partialMessage.role) !== 'assistant') return
      const messageId = safeString(partialMessage && (partialMessage.id || partialMessage.timestamp || 'stream'))
      if (!activeAssistantStream || activeAssistantStreamMessageId !== messageId) {
        activeAssistantStream = new AssistantMessageComponent(partialMessage, hideThinkingBlock, markdownTheme)
        activeAssistantStreamMessageId = messageId
        chatContainer.addChild(activeAssistantStream)
        chatContainer.addChild(new Spacer(1))
      }
      activeAssistantStream.updateContent(partialMessage)
      requestRender()
      return
    }
    if (type === 'message_end') {
      const message = event && event.message
      if (safeString(message && message.role) === 'assistant') {
        activeAssistantStream = null
        activeAssistantStreamMessageId = ''
      }
      return
    }
    if (type === 'tool_execution_start') {
      const tool = new ToolExecutionComponent(
        safeString(event.toolName || ''),
        event.args || {},
        { showImages },
        undefined,
        tui,
        process.env.HOME || os.homedir(),
      )
      try { tool.setArgsComplete?.() } catch {}
      const key = safeString(event.toolCallId || nodeId())
      toolMap.set(key, tool)
      chatContainer.addChild(tool)
      chatContainer.addChild(new Spacer(1))
      requestRender()
      return
    }
    if (type === 'tool_execution_update') {
      const key = safeString(event.toolCallId || '')
      const tool = toolMap.get(key)
      if (tool) {
        tool.updateResult(event.partialResult || { content: [] }, true)
        requestRender()
      }
      return
    }
    if (type === 'tool_execution_end') {
      const key = safeString(event.toolCallId || '')
      const tool = toolMap.get(key)
      if (tool) {
        tool.updateResult(event.result || { content: [] }, false)
        requestRender()
      }
      return
    }
    if (type === 'auto_compaction_start') {
      void refreshState().catch(() => {})
      lastStatus = ''
      setStatusLoader('Compacting context…')
      return
    }
    if (type === 'auto_compaction_end') {
      clearStatusLoader()
      void refreshState().catch(() => {})
      return setStatus(event && event.aborted ? '整理已取消' : '整理完成')
    }
    if (type === 'auto_retry_start') {
      void refreshState().catch(() => {})
      lastStatus = ''
      setStatusLoader(`Retrying (${safeString(event.attempt || '')}/${safeString(event.maxAttempts || '')})…`)
      return
    }
    if (type === 'auto_retry_end') {
      clearStatusLoader()
      void refreshState().catch(() => {})
      return setStatus(event && event.success ? '重试成功' : '重试结束')
    }
    if (type === 'extension_error') return appendSystemNotice(`extension error: ${safeString(event.error || '')}`)
  })

  function nodeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  let exiting = false
  let stdinListener: ((chunk: any) => void) | null = null
  const handleGlobalCtrlC = () => {
    const now = Date.now()
    if (currentBottom !== editor) {
      closeBottomAndRestoreEditor()
      lastSigintTime = now
      setStatus('已回到输入框，再按一次 Ctrl+C 退出')
      return
    }
    if (safeString(editor.getText?.() || '')) editor.setText('')
    if (now - lastSigintTime < 500) {
      void exit()
      return
    }
    lastSigintTime = now
    setStatus('已清空输入，再按一次 Ctrl+C 退出')
  }
  const exit = async () => {
    if (exiting) return
    exiting = true
    if (stdinListener) {
      try { process.stdin.removeListener('data', stdinListener) } catch {}
      stdinListener = null
    }
    try { clearStatusLoader() } catch {}
    try { footerDataProvider.dispose?.() } catch {}
    try { await client.stop() } catch {}
    try { tui.stop() } catch {}
    process.exit(0)
  }

  root.addChild(headerContainer)
  root.addChild(chatContainer)
  root.addChild(pendingMessagesContainer)
  root.addChild(statusContainer)
  root.addChild(widgetAbove)
  root.addChild(editorContainer)
  root.addChild(widgetBelow)
  root.addChild(footer as any)
  rebuildHeader()
  renderWidgets()
  setBottom(editor, editor)
  tui.addChild(root)

  tui.addInputListener((data: string) => {
    if (data === '\u0004' || matchesKey(data, 'ctrl+d')) {
      void exit()
      return { consume: true }
    }
    if (data === '\u0003' || matchesKey(data, 'ctrl+c')) {
      handleGlobalCtrlC()
      return { consume: true }
    }
    if (currentBottom !== editor && matchesKey(data, 'escape')) {
      closeBottomAndRestoreEditor()
      return { consume: true }
    }
    return undefined
  })

  stdinListener = (chunk: any) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : safeString(chunk)
    if (text.includes('\u0004')) {
      void exit()
      return
    }
    if (text.includes('\u0003')) {
      handleGlobalCtrlC()
    }
  }
  try { process.stdin.on('data', stdinListener) } catch {}

  process.on('SIGINT', () => { void exit() })
  process.on('SIGTERM', () => { void exit() })

  await client.start(args)
  await refreshState()
  await reloadMessages()
  requestRender()
  tui.start()
}

main().catch((error: any) => {
  const message = safeString(error && error.message ? error.message : error) || 'rin_tui_failed'
  console.error(message)
  process.exit(1)
})
