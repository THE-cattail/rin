// @ts-nocheck
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'

import { importPiCodingAgentModule } from './pi-upstream'
import { buildTuiDaemonRestartSystemPromptExtra } from './chat-session-state'
import { createRinTuiSession } from './runtime'
import { BUILTIN_SLASH_COMMANDS } from '../third_party/pi-mono/packages/coding-agent/dist/core/slash-commands.js'

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

export function tuiRpcSockPathForState(stateRoot: string) {
  return path.join(path.resolve(stateRoot), 'data', 'rin-tui.sock')
}

function createPlainTheme() {
  const wrap = (_name: string, text: string) => safeString(text)
  return {
    fg: wrap,
    bg: wrap,
    bold: (text: string) => safeString(text),
    italic: (text: string) => safeString(text),
    underline: (text: string) => safeString(text),
    inverse: (text: string) => safeString(text),
    strikethrough: (text: string) => safeString(text),
    getThinkingBorderColor: () => (text: string) => safeString(text),
    getBashModeBorderColor: () => (text: string) => safeString(text),
  }
}

async function loadThemeSingleton() {
  try {
    const mod = await importPiCodingAgentModule(path.join('dist', 'modes', 'interactive', 'theme', 'theme.js'))
    const candidate = mod && mod.theme ? mod.theme : null
    if (candidate) {
      try {
        if (typeof candidate.fg === 'function') {
          candidate.fg('muted', '')
          return candidate
        }
      } catch {}
    }
    return createPlainTheme()
  } catch {
    return createPlainTheme()
  }
}

function createExtensionUiBridge({ send, pendingRequests, theme }: any) {
  function createDialogPromise(defaultValue: any, request: Record<string, any>, signal?: AbortSignal, timeoutMs = 0) {
    if (signal?.aborted) return Promise.resolve(defaultValue)
    const id = nodeCrypto.randomUUID()
    return new Promise((resolve) => {
      let timeout: any = null
      const cleanup = () => {
        if (timeout) {
          try { clearTimeout(timeout) } catch {}
          timeout = null
        }
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort) } catch {}
        }
        pendingRequests.delete(id)
      }
      const onAbort = () => {
        cleanup()
        resolve(defaultValue)
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup()
          resolve(defaultValue)
        }, timeoutMs)
      }
      pendingRequests.set(id, {
        resolve: (response: any) => {
          cleanup()
          resolve(response)
        },
      })
      const delivered = send({ type: 'extension_ui_request', id, ...request })
      if (delivered === false) {
        cleanup()
        resolve(defaultValue)
      }
    })
  }

  return {
    select: async (title: string, options: string[], opts?: any) => {
      const response: any = await createDialogPromise(undefined, {
        method: 'select',
        title,
        options,
        timeout: Number(opts?.timeout || 0) || undefined,
      }, opts?.signal, Number(opts?.timeout || 0))
      if (response && response.cancelled) return undefined
      return response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : undefined
    },
    confirm: async (title: string, message: string, opts?: any) => {
      const response: any = await createDialogPromise(false, {
        method: 'confirm',
        title,
        message,
        timeout: Number(opts?.timeout || 0) || undefined,
      }, opts?.signal, Number(opts?.timeout || 0))
      if (response && response.cancelled) return false
      return Boolean(response && response.confirmed)
    },
    input: async (title: string, placeholder: string, opts?: any) => {
      const response: any = await createDialogPromise(undefined, {
        method: 'input',
        title,
        placeholder,
        timeout: Number(opts?.timeout || 0) || undefined,
      }, opts?.signal, Number(opts?.timeout || 0))
      if (response && response.cancelled) return undefined
      return response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : undefined
    },
    notify(message: string, notifyType?: string) {
      send({ type: 'extension_ui_request', id: nodeCrypto.randomUUID(), method: 'notify', message, notifyType })
    },
    onTerminalInput() { return () => {} },
    setStatus(statusKey: string, statusText: string | undefined) {
      send({ type: 'extension_ui_request', id: nodeCrypto.randomUUID(), method: 'setStatus', statusKey, statusText })
    },
    setWorkingMessage() {},
    setWidget(widgetKey: string, content: any, options?: any) {
      if (content === undefined || Array.isArray(content)) {
        send({
          type: 'extension_ui_request',
          id: nodeCrypto.randomUUID(),
          method: 'setWidget',
          widgetKey,
          widgetLines: content,
          widgetPlacement: options && options.placement,
        })
      }
    },
    setFooter() {},
    setHeader() {},
    setTitle(title: string) {
      send({ type: 'extension_ui_request', id: nodeCrypto.randomUUID(), method: 'setTitle', title })
    },
    async custom() { return undefined as never },
    pasteToEditor(text: string) { this.setEditorText(text) },
    setEditorText(text: string) {
      send({ type: 'extension_ui_request', id: nodeCrypto.randomUUID(), method: 'set_editor_text', text })
    },
    getEditorText() { return '' },
    async editor(title: string, prefill?: string) {
      const response: any = await createDialogPromise(undefined, {
        method: 'editor',
        title,
        prefill,
      })
      if (response && response.cancelled) return undefined
      return response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : undefined
    },
    setEditorComponent() {},
    get theme() { return theme },
    getAllThemes() { return [] },
    getTheme() { return undefined },
    setTheme() { return { success: false, error: 'Theme switching not supported in daemon TUI RPC mode' } },
    getToolsExpanded() { return false },
    setToolsExpanded() {},
  }
}

function normalizeResponse(id: any, command: string, data?: any) {
  if (data === undefined) return { id, type: 'response', command, success: true }
  return { id, type: 'response', command, success: true, data }
}

function normalizeError(id: any, command: string, error: any) {
  return { id, type: 'response', command, success: false, error: safeString(error && error.message ? error.message : error) || 'rpc_error' }
}

function formatContextUsageLine(contextUsage: any) {
  const usage = contextUsage && typeof contextUsage === 'object' ? contextUsage : null
  if (!usage) return 'Context: n/a'
  const tokens = Number(usage.tokens)
  const window = Number(usage.contextWindow)
  const percent = Number(usage.percent)
  const tokenText = Number.isFinite(tokens) && tokens >= 0 ? String(tokens) : '?'
  const windowText = Number.isFinite(window) && window > 0 ? String(window) : '?'
  const percentText = Number.isFinite(percent) ? `${percent.toFixed(1)}%` : '?'
  return `Context: ${tokenText}/${windowText} (${percentText})`
}

function formatCurrentSessionStatus(state: any) {
  const current = state && typeof state === 'object' ? state : {}
  const lines: string[] = []
  const sessionName = safeString(current.sessionName || '').trim() || 'default'
  lines.push(`Session: ${sessionName}`)
  const provider = safeString(current.model && current.model.provider || '').trim()
  const modelId = safeString(current.model && current.model.id || '').trim()
  lines.push(`Model: ${provider || '(unknown provider)'}/${modelId || '(unknown model)'}`)
  lines.push(`Thinking: ${safeString(current.thinkingLevel || '').trim() || 'minimal'}`)
  let activity = 'idle'
  if (current.isStreaming) activity = 'running'
  else if (current.isCompacting) activity = 'compacting'
  else if (current.isRetrying) activity = 'retrying'
  else if (current.isBashRunning) activity = 'bash running'
  lines.push(`Agent: ${activity}`)
  lines.push(formatContextUsageLine(current.contextUsage))
  const sessionFile = safeString(current.sessionFile || '').trim()
  if (sessionFile) lines.push(`Session file: ${sessionFile}`)
  const sessionCwd = safeString(current.sessionCwd || '').trim()
  if (sessionCwd) lines.push(`Cwd: ${sessionCwd}`)
  const chatKey = safeString(current.bridgeChatKey || '').trim()
  if (chatKey) lines.push(`Chat: ${chatKey}`)
  const pending = Number(current.pendingMessageCount || 0)
  if (Number.isFinite(pending) && pending > 0) lines.push(`Queued messages: ${pending}`)
  return lines.join('\n')
}

const MAX_RUNTIME_EVENT_BACKLOG = 512

export function startDaemonTuiRpcServer({ repoRoot, stateRoot, logger, bridge }: { repoRoot: string, stateRoot: string, logger?: any, bridge?: any }) {
  const sockPath = tuiRpcSockPathForState(stateRoot)
  const restartResumePath = path.join(path.resolve(stateRoot), 'data', 'tui-restart-resume.json')
  const viewerBindingPath = path.join(path.resolve(stateRoot), 'data', 'tui-viewer-bindings.json')
  try { fs.rmSync(sockPath, { force: true }) } catch {}

  const readRestartResumeMarkers = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(restartResumePath, 'utf8'))
      const markers = Array.isArray(raw && raw.markers) ? raw.markers : []
      return markers
        .map((item: any) => ({
          sessionFile: safeString(item && item.sessionFile).trim(),
          chatKey: safeString(item && item.chatKey).trim(),
          timestampMs: Number(item && item.timestampMs || 0),
          autoResume: Boolean(item && item.autoResume),
          clientInstanceIds: Array.isArray(item && item.clientInstanceIds) ? item.clientInstanceIds.map((value: any) => safeString(value).trim()).filter(Boolean) : [],
        }))
        .filter((item: any) => item.sessionFile)
    } catch {
      return []
    }
  }

  let restartResumeMarkers = readRestartResumeMarkers()
  const persistRestartResumeMarkers = (markers: any[]) => {
    restartResumeMarkers = Array.isArray(markers) ? markers.filter((item: any) => safeString(item && item.sessionFile).trim()) : []
    if (!restartResumeMarkers.length) {
      try { fs.rmSync(restartResumePath, { force: true }) } catch {}
      return
    }
    try { fs.mkdirSync(path.dirname(restartResumePath), { recursive: true }) } catch {}
    const tmp = `${restartResumePath}.tmp.${process.pid}.${Date.now()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ markers: restartResumeMarkers }, null, 2), 'utf8')
      fs.renameSync(tmp, restartResumePath)
    } catch {
      try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  }

  const findRestartResumeMarker = ({ sessionFile = '', chatKey = '', clientInstanceId = '' }: any = {}) => {
    const nextSessionFile = safeString(sessionFile).trim()
    const nextChatKey = safeString(chatKey).trim()
    const nextClientInstanceId = safeString(clientInstanceId).trim()
    if (!nextSessionFile) return null
    const index = restartResumeMarkers.findIndex((item: any) => {
      const itemSessionFile = safeString(item && item.sessionFile).trim()
      const itemChatKey = safeString(item && item.chatKey).trim()
      const itemClientInstanceIds = Array.isArray(item && item.clientInstanceIds) ? item.clientInstanceIds.map((value: any) => safeString(value).trim()).filter(Boolean) : []
      if (!itemSessionFile) return false
      if (itemSessionFile !== nextSessionFile) return false
      if (nextChatKey && itemChatKey && itemChatKey !== nextChatKey) return false
      if (itemClientInstanceIds.length && nextClientInstanceId && !itemClientInstanceIds.includes(nextClientInstanceId)) return false
      return true
    })
    if (index < 0) return null
    return { index, marker: restartResumeMarkers[index] }
  }

  const consumeRestartResumeMarker = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= restartResumeMarkers.length) return null
    const [marker] = restartResumeMarkers.splice(index, 1)
    persistRestartResumeMarkers(restartResumeMarkers)
    return marker || null
  }

  const readViewerBindings = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(viewerBindingPath, 'utf8'))
      const bindings = raw && typeof raw.bindings === 'object' ? raw.bindings : {}
      const rows = new Map<string, any>()
      for (const [clientInstanceId, value] of Object.entries(bindings)) {
        const nextClientInstanceId = safeString(clientInstanceId).trim()
        if (!nextClientInstanceId) continue
        rows.set(nextClientInstanceId, {
          sessionFile: safeString((value as any) && (value as any).sessionFile).trim(),
          chatKey: safeString((value as any) && (value as any).chatKey).trim(),
        })
      }
      return rows
    } catch {
      return new Map<string, any>()
    }
  }

  let viewerBindings = readViewerBindings()
  const persistViewerBindings = () => {
    if (!(viewerBindings instanceof Map) || viewerBindings.size === 0) {
      try { fs.rmSync(viewerBindingPath, { force: true }) } catch {}
      return
    }
    const bindings: Record<string, any> = {}
    for (const [clientInstanceId, value] of viewerBindings.entries()) {
      const nextClientInstanceId = safeString(clientInstanceId).trim()
      if (!nextClientInstanceId) continue
      bindings[nextClientInstanceId] = {
        sessionFile: safeString(value && value.sessionFile).trim(),
        chatKey: safeString(value && value.chatKey).trim(),
      }
    }
    try { fs.mkdirSync(path.dirname(viewerBindingPath), { recursive: true }) } catch {}
    const tmp = `${viewerBindingPath}.tmp.${process.pid}.${Date.now()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ bindings }, null, 2), 'utf8')
      fs.renameSync(tmp, viewerBindingPath)
    } catch {
      try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  }

  const runtimes = new Map<string, any>()
  const runtimeIdBySessionFile = new Map<string, string>()
  const runtimeIdByChatKey = new Map<string, string>()
  const socketToRuntime = new Map<any, any>()

  const normalizeSessionFile = (value: any) => {
    const text = safeString(value).trim()
    return text ? path.resolve(text) : ''
  }

  const runtimeKeyForConfig = (payload: any = {}) => {
    const chatKey = safeString(payload && (payload.chatKey != null ? payload.chatKey : payload.currentChatKey)).trim()
    if (chatKey) return `chat:${chatKey}`
    const sessionFile = normalizeSessionFile(payload && payload.sessionFile)
    if (sessionFile) return `session:${sessionFile}`
    const sessionDir = safeString(payload && payload.sessionDir).trim()
    if (sessionDir) return `dir:${path.resolve(sessionDir)}`
    return ''
  }

  const findRuntimeForConfig = (payload: any = {}) => {
    const chatKey = safeString(payload && (payload.chatKey != null ? payload.chatKey : payload.currentChatKey)).trim()
    if (chatKey) {
      const runtimeId = runtimeIdByChatKey.get(chatKey)
      if (runtimeId && runtimes.has(runtimeId)) return runtimes.get(runtimeId)
    }
    const sessionFile = normalizeSessionFile(payload && payload.sessionFile)
    if (sessionFile) {
      const runtimeId = runtimeIdBySessionFile.get(sessionFile)
      if (runtimeId && runtimes.has(runtimeId)) return runtimes.get(runtimeId)
    }
    const runtimeId = runtimeKeyForConfig(payload)
    return runtimes.get(runtimeId) || null
  }

  const cancelPendingRuntimeExtensionRequests = (runtime: any) => {
    for (const [, pending] of runtime.pendingExtensionRequests) {
      try { pending.resolve({ cancelled: true }) } catch {}
    }
    runtime.pendingExtensionRequests.clear()
  }

  const broadcastToRuntime = (runtime: any, obj: any) => {
    let delivered = false
    for (const socket of runtime.sockets) {
      if (!socket || socket.destroyed) continue
      try {
        socket.write(`${JSON.stringify(obj)}\n`)
        delivered = true
      } catch {}
    }
    return delivered
  }

  const updateRuntimeAliases = (runtime: any) => {
    const nextSessionFile = normalizeSessionFile(runtime.session && runtime.session.sessionFile)
    const nextChatKey = safeString(runtime.activeBridgeChatKey).trim()
    if (runtime.sessionFileAlias && runtimeIdBySessionFile.get(runtime.sessionFileAlias) === runtime.id) {
      runtimeIdBySessionFile.delete(runtime.sessionFileAlias)
    }
    if (runtime.chatKeyAlias && runtimeIdByChatKey.get(runtime.chatKeyAlias) === runtime.id) {
      runtimeIdByChatKey.delete(runtime.chatKeyAlias)
    }
    runtime.sessionFileAlias = nextSessionFile
    runtime.chatKeyAlias = nextChatKey
    if (nextSessionFile) runtimeIdBySessionFile.set(nextSessionFile, runtime.id)
    if (nextChatKey) runtimeIdByChatKey.set(nextChatKey, runtime.id)
  }

  const setViewerBinding = (clientInstanceId: any, runtime: any) => {
    const nextClientInstanceId = safeString(clientInstanceId).trim()
    if (!nextClientInstanceId) return
    const sessionFile = normalizeSessionFile(runtime && runtime.session && runtime.session.sessionFile)
    const chatKey = safeString(runtime && runtime.activeBridgeChatKey).trim()
    viewerBindings.set(nextClientInstanceId, { sessionFile, chatKey })
    persistViewerBindings()
  }

  const clearViewerBinding = (clientInstanceId: any) => {
    const nextClientInstanceId = safeString(clientInstanceId).trim()
    if (!nextClientInstanceId) return
    viewerBindings.delete(nextClientInstanceId)
    persistViewerBindings()
  }

  const makeRuntimeEvent = (runtime: any, obj: any, options: { replayable?: boolean } = {}) => {
    const base = obj && typeof obj === 'object' ? { ...obj } : { type: 'runtime_event', value: obj }
    const event = { ...base, eventSeq: Number(runtime.nextEventSeq || 1) }
    runtime.nextEventSeq = Number(runtime.nextEventSeq || 1) + 1
    if (options.replayable !== false) {
      runtime.eventBacklog.push(event)
      if (runtime.eventBacklog.length > MAX_RUNTIME_EVENT_BACKLOG) {
        runtime.eventBacklog.splice(0, runtime.eventBacklog.length - MAX_RUNTIME_EVENT_BACKLOG)
      }
    }
    return event
  }

  const emitRuntimeEvent = (runtime: any, obj: any, options: { replayable?: boolean } = {}) => {
    const event = makeRuntimeEvent(runtime, obj, options)
    broadcastToRuntime(runtime, event)
    return event
  }

  const replayRuntimeEventsToSocket = (runtime: any, socket: any, lastEventSeq: any) => {
    const cursor = Math.max(0, Number(lastEventSeq) || 0)
    for (const event of runtime.eventBacklog) {
      const eventSeq = Math.max(0, Number(event && event.eventSeq) || 0)
      if (eventSeq <= cursor) continue
      try { socket.write(`${JSON.stringify(event)}\n`) } catch { break }
    }
  }

  const runtimeHasResumeWork = (runtime: any) => {
    const session = runtime && runtime.session ? runtime.session : null
    if (!session) return false
    if (session.isStreaming || session.isCompacting || session.isRetrying || session.isBashRunning) return true
    const pendingMessageCount = Number(session.pendingMessageCount || 0)
    return Number.isFinite(pendingMessageCount) && pendingMessageCount > 0
  }

  const sessionState = (runtime: any) => {
    const session = runtime && runtime.session ? runtime.session : null
    if (!session) return {}
    const steeringMessages = Array.from(session.getSteeringMessages?.() || []).map((item: any) => safeString(item))
    const followUpMessages = Array.from(session.getFollowUpMessages?.() || []).map((item: any) => safeString(item))
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isRetrying: Boolean(session.isRetrying),
      isBashRunning: Boolean(session.isBashRunning),
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionFile: session.sessionFile,
      sessionDir: safeString(runtime.activeSessionDir).trim(),
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      sessionCwd: session.sessionManager && typeof session.sessionManager.getCwd === 'function' ? session.sessionManager.getCwd() : '',
      bridgeChatKey: safeString(runtime.activeBridgeChatKey).trim(),
      autoCompactionEnabled: session.autoCompactionEnabled,
      autoRetryEnabled: Boolean(session.autoRetryEnabled),
      contextUsage: typeof session.getContextUsage === 'function' ? session.getContextUsage() : undefined,
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      pendingMessageCount: Number(session.pendingMessageCount || 0),
      steeringMessages,
      followUpMessages,
      latestEventSeq: Math.max(0, Number(runtime && runtime.nextEventSeq || 1) - 1),
    }
  }

  const disposeRuntime = async (runtime: any) => {
    if (!runtime || runtime.closed) return
    runtime.closed = true
    cancelPendingRuntimeExtensionRequests(runtime)
    if (runtime.unsubscribeSession) {
      try { runtime.unsubscribeSession() } catch {}
      runtime.unsubscribeSession = null
    }
    if (runtime.session && typeof runtime.session.dispose === 'function') {
      try { runtime.session.dispose() } catch {}
    }
    if (runtime.sessionFileAlias && runtimeIdBySessionFile.get(runtime.sessionFileAlias) === runtime.id) {
      runtimeIdBySessionFile.delete(runtime.sessionFileAlias)
    }
    if (runtime.chatKeyAlias && runtimeIdByChatKey.get(runtime.chatKeyAlias) === runtime.id) {
      runtimeIdByChatKey.delete(runtime.chatKeyAlias)
    }
    runtimes.delete(runtime.id)
  }

  const createRuntime = (payload: any = {}) => {
    const explicitRuntimeId = runtimeKeyForConfig(payload)
    const runtimeId = explicitRuntimeId || `runtime:${nodeCrypto.randomUUID()}`
    const existing = explicitRuntimeId ? runtimes.get(explicitRuntimeId) : null
    if (existing) return existing
    const runtime = {
      id: runtimeId,
      sockets: new Set<any>(),
      clientInstanceIds: new Set<string>(),
      pendingExtensionRequests: new Map<string, { resolve: (value: any) => void }>(),
      session: null,
      created: null,
      theme: createPlainTheme(),
      unsubscribeSession: null,
      activeBridgeChatKey: '',
      activeSessionDir: '',
      sessionFileAlias: '',
      chatKeyAlias: '',
      nextEventSeq: 1,
      eventBacklog: [] as any[],
      restartRecoveryHandled: false,
      restartRecoveryTurnTriggered: false,
      initialized: false,
      initInFlight: null,
      closed: false,
    }
    runtimes.set(runtimeId, runtime)
    return runtime
  }

  const ensureRuntimeInitialized = async (runtime: any, payload: any, override: any = {}) => {
    if (runtime.initialized) return
    if (runtime.initInFlight) return await runtime.initInFlight
    runtime.initInFlight = (async () => {
      runtime.theme = await loadThemeSingleton()
      const provider = safeString(override.provider != null ? override.provider : payload && payload.provider).trim()
      const model = safeString(override.model != null ? override.model : payload && payload.model).trim()
      const thinking = safeString(override.thinking != null ? override.thinking : payload && payload.thinking).trim()
      const sessionFile = safeString(override.sessionFile != null ? override.sessionFile : payload && payload.sessionFile).trim()
      const sessionDir = safeString(override.sessionDir != null ? override.sessionDir : '').trim()
      const bridgeChatKey = safeString(override.currentChatKey != null ? override.currentChatKey : payload && payload.chatKey).trim()
      const reconnectGeneration = Math.max(0, Number(override.reconnectGeneration != null ? override.reconnectGeneration : payload && payload.reconnectGeneration) || 0)
      const clientInstanceId = safeString(override.clientInstanceId != null ? override.clientInstanceId : payload && payload.clientInstanceId).trim()
      const persistedResumeMarkerMatch = findRestartResumeMarker({ sessionFile, chatKey: bridgeChatKey, clientInstanceId })
      const persistedResumeMarker = persistedResumeMarkerMatch && persistedResumeMarkerMatch.marker ? persistedResumeMarkerMatch.marker : null
      const restartRecovery = Boolean(sessionFile) && (reconnectGeneration > 0 || Boolean(persistedResumeMarker))
      const requestedAutoResume = Boolean(override.autoResume != null ? override.autoResume : payload && payload.autoResume)
      const shouldAutoResume = Boolean(restartRecovery && ((persistedResumeMarker && persistedResumeMarker.autoResume) || requestedAutoResume))
      runtime.created = await createRinTuiSession({
        repoRoot,
        workspaceRoot: stateRoot,
        sessionHome: process.env.HOME || os.homedir(),
        sessionDir,
        sessionFile,
        sessionPolicy: sessionFile ? 'continueRecent' : 'new',
        brainChatKey: safeString(override.brainChatKey || bridgeChatKey || 'local:default').trim() || 'local:default',
        currentChatKey: bridgeChatKey,
        provider,
        model,
        thinking,
        systemPromptExtra: shouldAutoResume
          ? buildTuiDaemonRestartSystemPromptExtra({ reason: 'daemon_tui_rpc_reconnect' })
          : '',
        enableBrainHooks: false,
      })
      runtime.session = runtime.created.session
      if (!runtime.session) throw new Error('pi_sdk_session_missing')
      runtime.activeBridgeChatKey = bridgeChatKey
      runtime.activeSessionDir = safeString(runtime.created && runtime.created.sessionDir || sessionDir).trim()
      updateRuntimeAliases(runtime)

      const uiContext = createExtensionUiBridge({
        send: (obj: any) => broadcastToRuntime(runtime, obj),
        pendingRequests: runtime.pendingExtensionRequests,
        theme: runtime.theme,
      })
      await runtime.session.bindExtensions({
        uiContext,
        commandContextActions: {
          waitForIdle: () => runtime.session.agent.waitForIdle(),
          newSession: async (options: any) => {
            const cancelled = !(await runtime.session.newSession(options))
            updateRuntimeAliases(runtime)
            return { cancelled }
          },
          fork: async (entryId: string) => {
            const result = await runtime.session.fork(entryId)
            updateRuntimeAliases(runtime)
            return { cancelled: result.cancelled }
          },
          navigateTree: async (targetId: string, options: any) => {
            const result = await runtime.session.navigateTree(targetId, {
              summarize: options && options.summarize,
              customInstructions: options && options.customInstructions,
              replaceInstructions: options && options.replaceInstructions,
              label: options && options.label,
            })
            updateRuntimeAliases(runtime)
            return { cancelled: result.cancelled }
          },
          switchSession: async (sessionPath: string) => {
            const cancelled = !(await runtime.session.switchSession(sessionPath))
            updateRuntimeAliases(runtime)
            return { cancelled }
          },
          reload: async () => { await runtime.session.reload() },
        },
        shutdownHandler: () => {},
        onError: (err: any) => emitRuntimeEvent(runtime, { type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error }),
      })

      runtime.unsubscribeSession = runtime.session.subscribe((event: any) => {
        updateRuntimeAliases(runtime)
        emitRuntimeEvent(runtime, event)
      })
      runtime.initialized = true
    })()
    try {
      await runtime.initInFlight
    } catch (error) {
      await disposeRuntime(runtime)
      throw error
    } finally {
      runtime.initInFlight = null
    }
  }

  const detachSocket = (socket: any) => {
    const runtime = socketToRuntime.get(socket)
    if (!runtime) return
    const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
    socketToRuntime.delete(socket)
    runtime.sockets.delete(socket)
    if (clientInstanceId) runtime.clientInstanceIds.delete(clientInstanceId)
    if (runtime.sockets.size === 0) cancelPendingRuntimeExtensionRequests(runtime)
  }

  const attachSocket = (socket: any, runtime: any, clientInstanceId = '') => {
    const current = socketToRuntime.get(socket)
    if (current && current !== runtime) detachSocket(socket)
    ;(socket as any).__rinClientInstanceId = safeString(clientInstanceId).trim()
    runtime.sockets.add(socket)
    if (safeString(clientInstanceId).trim()) runtime.clientInstanceIds.add(safeString(clientInstanceId).trim())
    socketToRuntime.set(socket, runtime)
  }

  const attachRuntimeForSocket = async (socket: any, payload: any, override: any = {}) => {
    const targetPayload = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      ...(override && typeof override === 'object' ? override : {}),
    }
    const lastEventSeq = Math.max(0, Number(targetPayload && targetPayload.lastEventSeq) || 0)
    const reconnectGeneration = Math.max(0, Number(targetPayload && targetPayload.reconnectGeneration) || 0)
    const clientInstanceId = safeString(targetPayload && targetPayload.clientInstanceId).trim()
    const requestedAutoResume = Boolean(targetPayload && targetPayload.autoResume)
    if (reconnectGeneration > 0 && clientInstanceId) {
      const binding = viewerBindings.get(clientInstanceId)
      if (binding && !safeString(targetPayload && targetPayload.sessionFile).trim() && !safeString(targetPayload && targetPayload.chatKey).trim()) {
        targetPayload.sessionFile = safeString(binding && binding.sessionFile).trim() || undefined
        targetPayload.chatKey = safeString(binding && binding.chatKey).trim() || undefined
      }
    }
    let runtime = findRuntimeForConfig(targetPayload)
    if (!runtime) runtime = createRuntime(targetPayload)
    const previousRuntime = socketToRuntime.get(socket)
    if (previousRuntime && previousRuntime !== runtime) detachSocket(socket)
    try {
      await ensureRuntimeInitialized(runtime, payload, override)
      attachSocket(socket, runtime, clientInstanceId)
      replayRuntimeEventsToSocket(runtime, socket, lastEventSeq)
      if (!runtime.restartRecoveryHandled) {
        const persistedResumeMarkerMatch = findRestartResumeMarker({
          sessionFile: safeString(runtime.session && runtime.session.sessionFile || '').trim(),
          chatKey: safeString(runtime.activeBridgeChatKey).trim(),
          clientInstanceId,
        })
        const persistedResumeMarker = persistedResumeMarkerMatch && persistedResumeMarkerMatch.marker ? persistedResumeMarkerMatch.marker : null
        const restartRecovery = Boolean(runtime.session && runtime.session.sessionFile) && (reconnectGeneration > 0 || Boolean(persistedResumeMarker))
        const shouldAutoResume = Boolean(restartRecovery && ((persistedResumeMarker && persistedResumeMarker.autoResume) || requestedAutoResume))
        if (restartRecovery) {
          runtime.restartRecoveryHandled = true
          if (persistedResumeMarkerMatch) consumeRestartResumeMarker(persistedResumeMarkerMatch.index)
          const recoveryText = shouldAutoResume
            ? 'Daemon restarted. Reopened this TUI session from the last saved state and resumed the interrupted turn automatically.'
            : 'Daemon restarted. Reopened this TUI session from the last saved state.'
          const recoveryEvent = makeRuntimeEvent(runtime, {
            type: 'daemon_restart_recovery',
            reconnectGeneration,
            sessionFile: safeString(runtime.session && runtime.session.sessionFile || '').trim(),
            autoResume: shouldAutoResume,
            text: recoveryText,
          }, { replayable: false })
          try { socket.write(`${JSON.stringify(recoveryEvent)}\n`) } catch {}
          if (shouldAutoResume && !runtime.restartRecoveryTurnTriggered) {
            runtime.restartRecoveryTurnTriggered = true
            void runtime.session.sendCustomMessage({
              customType: 'daemonRestartRecovery',
              content: '',
              display: false,
              details: { reconnectGeneration },
            }, { triggerTurn: true }).catch((error: any) => {
              emitRuntimeEvent(runtime, { type: 'extension_error', extensionPath: 'daemon_tui_rpc', event: 'restart_recovery', error: safeString(error && error.message ? error.message : error) || 'restart_recovery_failed' })
            })
          }
        }
      }
      return runtime
    } catch (error) {
      detachSocket(socket)
      throw error
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let closed = false
    let buf = ''

    const send = (obj: any) => {
      if (closed) return false
      try {
        socket.write(`${JSON.stringify(obj)}\n`)
        return true
      } catch {
        return false
      }
    }

    const cleanup = async () => {
      if (closed) return
      closed = true
      detachSocket(socket)
      try { socket.destroy() } catch {}
    }

    const handleCommand = async (command: any) => {
      const id = command && command.id
      const type = safeString(command && command.type)
      const runtime = () => socketToRuntime.get(socket)

      if (type === 'extension_ui_response') {
        const activeRuntime = runtime()
        if (!activeRuntime) return null
        const pending = activeRuntime.pendingExtensionRequests.get(safeString(command && command.id))
        if (pending) {
          activeRuntime.pendingExtensionRequests.delete(safeString(command && command.id))
          pending.resolve(command)
        }
        return null
      }

      if (type === 'init') {
        const nextRuntime = await attachRuntimeForSocket(socket, command)
        const clientInstanceId = safeString(command && command.clientInstanceId).trim()
        const reconnectGeneration = Math.max(0, Number(command && command.reconnectGeneration) || 0)
        const hasExplicitTarget = Boolean(safeString(command && command.sessionFile).trim() || safeString(command && command.chatKey).trim())
        if (clientInstanceId && (reconnectGeneration > 0 || hasExplicitTarget)) setViewerBinding(clientInstanceId, nextRuntime)
        else if (clientInstanceId) clearViewerBinding(clientInstanceId)
        return normalizeResponse(id, 'init', sessionState(nextRuntime))
      }

      const activeRuntime = runtime()
      if (!activeRuntime || !activeRuntime.initialized || !activeRuntime.session) throw new Error('tui_rpc_requires_init')
      const session = activeRuntime.session

      switch (type) {
        case 'prompt':
          void session.prompt(safeString(command.message), {
            images: Array.isArray(command.images) ? command.images : [],
            streamingBehavior: command.streamingBehavior,
            source: 'rpc',
          }).catch((e: any) => send(normalizeError(id, 'prompt', e)))
          return normalizeResponse(id, 'prompt')
        case 'steer':
          await session.steer(safeString(command.message), Array.isArray(command.images) ? command.images : [])
          return normalizeResponse(id, 'steer')
        case 'follow_up':
          await session.followUp(safeString(command.message), Array.isArray(command.images) ? command.images : [])
          return normalizeResponse(id, 'follow_up')
        case 'clear_queue': {
          const cleared = session.clearQueue()
          return normalizeResponse(id, 'clear_queue', cleared)
        }
        case 'abort':
          await session.abort()
          return normalizeResponse(id, 'abort')
        case 'get_state':
          return normalizeResponse(id, 'get_state', sessionState(activeRuntime))
        case 'get_messages':
          return normalizeResponse(id, 'get_messages', { messages: session.messages })
        case 'set_model': {
          const models = await session.modelRegistry.getAvailable()
          const model = models.find((it: any) => safeString(it.provider) === safeString(command.provider) && safeString(it.id) === safeString(command.modelId))
          if (!model) return normalizeError(id, 'set_model', `Model not found: ${safeString(command.provider)}/${safeString(command.modelId)}`)
          await session.setModel(model)
          return normalizeResponse(id, 'set_model', model)
        }
        case 'cycle_model': {
          const direction = command.direction === 'backward' ? 'backward' : 'forward'
          const result = await session.cycleModel(direction)
          return normalizeResponse(id, 'cycle_model', result || null)
        }
        case 'get_available_models': {
          const models = await session.modelRegistry.getAvailable()
          return normalizeResponse(id, 'get_available_models', { models })
        }
        case 'set_thinking_level':
          session.setThinkingLevel(command.level)
          return normalizeResponse(id, 'set_thinking_level')
        case 'cycle_thinking_level': {
          const level = session.cycleThinkingLevel()
          return normalizeResponse(id, 'cycle_thinking_level', level ? { level } : null)
        }
        case 'set_steering_mode':
          session.setSteeringMode(command.mode === 'all' ? 'all' : 'one-at-a-time')
          return normalizeResponse(id, 'set_steering_mode')
        case 'set_follow_up_mode':
          session.setFollowUpMode(command.mode === 'all' ? 'all' : 'one-at-a-time')
          return normalizeResponse(id, 'set_follow_up_mode')
        case 'abort_compaction':
          session.abortCompaction()
          return normalizeResponse(id, 'abort_compaction')
        case 'abort_branch_summary':
          session.abortBranchSummary()
          return normalizeResponse(id, 'abort_branch_summary')
        case 'compact': {
          const result = await session.compact(safeString(command.customInstructions || ''))
          return normalizeResponse(id, 'compact', result)
        }
        case 'set_auto_compaction':
          session.setAutoCompactionEnabled(Boolean(command.enabled))
          return normalizeResponse(id, 'set_auto_compaction')
        case 'set_auto_retry':
          session.setAutoRetryEnabled(Boolean(command.enabled))
          return normalizeResponse(id, 'set_auto_retry')
        case 'abort_retry':
          session.abortRetry()
          return normalizeResponse(id, 'abort_retry')
        case 'bash': {
          const result = await session.executeBash(safeString(command.command || ''))
          return normalizeResponse(id, 'bash', result)
        }
        case 'abort_bash':
          session.abortBash()
          return normalizeResponse(id, 'abort_bash')
        case 'get_session_stats':
          return normalizeResponse(id, 'get_session_stats', session.getSessionStats())
        case 'export_html': {
          const outPath = await session.exportToHtml(safeString(command.outputPath || '').trim() || undefined)
          return normalizeResponse(id, 'export_html', { path: outPath })
        }
        case 'new_session': {
          const cancelled = !(await session.newSession(command.parentSession ? { parentSession: command.parentSession } : undefined))
          updateRuntimeAliases(activeRuntime)
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, activeRuntime)
          return normalizeResponse(id, 'new_session', { cancelled })
        }
        case 'open_session': {
          const sessionPath = safeString(command.sessionPath || '').trim()
          if (!sessionPath) return normalizeError(id, 'open_session', 'session_path_required')
          const nextRuntime = await attachRuntimeForSocket(socket, command, { sessionFile: sessionPath })
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, nextRuntime)
          return normalizeResponse(id, 'open_session', sessionState(nextRuntime))
        }
        case 'get_bridge_sessions': {
          const sessions = bridge && typeof bridge.listSessions === 'function'
            ? await bridge.listSessions()
            : []
          return normalizeResponse(id, 'get_bridge_sessions', { sessions: Array.isArray(sessions) ? sessions : [] })
        }
        case 'open_bridge_session': {
          const chatKey = safeString(command.chatKey || '').trim()
          if (!chatKey) return normalizeError(id, 'open_bridge_session', 'chat_key_required')
          if (!bridge || typeof bridge.getSessionConfig !== 'function') return normalizeError(id, 'open_bridge_session', 'bridge_sessions_unavailable')
          const next = await bridge.getSessionConfig(chatKey)
          if (!next || typeof next !== 'object') return normalizeError(id, 'open_bridge_session', `bridge_session_not_found:${chatKey}`)
          const nextRuntime = await attachRuntimeForSocket(socket, command, next)
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, nextRuntime)
          return normalizeResponse(id, 'open_bridge_session', sessionState(nextRuntime))
        }
        case 'switch_session': {
          const cancelled = !(await session.switchSession(safeString(command.sessionPath || '')))
          updateRuntimeAliases(activeRuntime)
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, activeRuntime)
          return normalizeResponse(id, 'switch_session', { cancelled })
        }
        case 'navigate_tree': {
          const result = await session.navigateTree(safeString(command.entryId || ''), {
            summarize: Boolean(command.summarize),
            customInstructions: safeString(command.customInstructions || '') || undefined,
            replaceInstructions: Boolean(command.replaceInstructions),
            label: safeString(command.label || '') || undefined,
          })
          updateRuntimeAliases(activeRuntime)
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, activeRuntime)
          return normalizeResponse(id, 'navigate_tree', {
            cancelled: Boolean(result && result.cancelled),
            aborted: Boolean(result && result.aborted),
            editorText: result && result.editorText ? result.editorText : undefined,
          })
        }
        case 'fork': {
          const result = await session.fork(safeString(command.entryId || ''))
          updateRuntimeAliases(activeRuntime)
          const clientInstanceId = safeString((socket as any).__rinClientInstanceId).trim()
          if (clientInstanceId) setViewerBinding(clientInstanceId, activeRuntime)
          return normalizeResponse(id, 'fork', { text: result.selectedText, cancelled: result.cancelled })
        }
        case 'get_fork_messages':
          return normalizeResponse(id, 'get_fork_messages', { messages: session.getUserMessagesForForking() })
        case 'get_last_assistant_text':
          return normalizeResponse(id, 'get_last_assistant_text', { text: session.getLastAssistantText() || null })
        case 'set_session_name': {
          const name = safeString(command.name || '').trim()
          if (!name) return normalizeError(id, 'set_session_name', 'Session name cannot be empty')
          session.setSessionName(name)
          return normalizeResponse(id, 'set_session_name')
        }
        case 'get_commands': {
          const commands: Array<any> = []
          for (const item of Array.isArray(BUILTIN_SLASH_COMMANDS) ? BUILTIN_SLASH_COMMANDS : []) {
            commands.push({
              name: item.name,
              description: item.description,
              source: 'builtin',
            })
          }
          for (const item of session.extensionRunner?.getRegisteredCommandsWithPaths?.() || []) {
            commands.push({
              name: item.command.name,
              description: item.command.description,
              source: 'extension',
              path: item.extensionPath,
            })
          }
          for (const template of session.promptTemplates || []) {
            commands.push({
              name: template.name,
              description: template.description,
              source: 'prompt',
              location: template.source,
              path: template.filePath,
            })
          }
          for (const skill of session.resourceLoader.getSkills().skills || []) {
            commands.push({
              name: `skill:${skill.name}`,
              description: skill.description,
              source: 'skill',
              location: skill.source,
              path: skill.filePath,
            })
          }
          return normalizeResponse(id, 'get_commands', { commands })
        }
        case 'control_command': {
          const name = safeString(command.name || '').trim()
          const chatKey = safeString(command.chatKey || activeRuntime.activeBridgeChatKey).trim()
          if (name === '/status') {
            if (!chatKey) return normalizeResponse(id, 'control_command', { notices: [formatCurrentSessionStatus(sessionState(activeRuntime))] })
          }
          if (name === '/restart') {
            if (!bridge || typeof bridge.runControlCommand !== 'function') return normalizeError(id, 'control_command', 'control_commands_unavailable')
            const result = await bridge.runControlCommand({ name, chatKey })
            return normalizeResponse(id, 'control_command', result || {})
          }
          if (!bridge || typeof bridge.runControlCommand !== 'function') return normalizeError(id, 'control_command', 'control_commands_unavailable')
          const result = await bridge.runControlCommand({ name, chatKey })
          return normalizeResponse(id, 'control_command', result || {})
        }
        case 'ping':
          return normalizeResponse(id, 'ping')
        default:
          return normalizeError(id, type || 'unknown', `Unknown command: ${type}`)
      }
    }

    socket.on('data', (chunk) => {
      if (closed) return
      buf += chunk
      while (true) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        void Promise.resolve()
          .then(() => handleCommand(JSON.parse(line)))
          .then((resp) => { if (resp) send(resp) })
          .catch((e) => {
            let id: any = undefined
            try { id = JSON.parse(line).id } catch {}
            send(normalizeError(id, 'parse', e))
          })
      }
    })

    socket.on('end', () => { void cleanup() })
    socket.on('close', () => { void cleanup() })
    socket.on('error', () => { void cleanup() })
  })

  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600) } catch {}
    try { logger && logger.info ? logger.info(`tui rpc socket ready: ${sockPath}`) : null } catch {}
  })

  return {
    sockPath,
    close() {
      const markers = []
      for (const runtime of runtimes.values()) {
        const sessionFile = normalizeSessionFile(runtime.session && runtime.session.sessionFile)
        if (!sessionFile) continue
        markers.push({
          sessionFile,
          chatKey: safeString(runtime.activeBridgeChatKey).trim(),
          timestampMs: Date.now(),
          autoResume: runtimeHasResumeWork(runtime),
          clientInstanceIds: Array.from(runtime.clientInstanceIds || []).map((value: any) => safeString(value).trim()).filter(Boolean),
        })
      }
      persistRestartResumeMarkers(markers)
      for (const runtime of Array.from(runtimes.values())) {
        void disposeRuntime(runtime)
      }
      try { server.close() } catch {}
      try { fs.rmSync(sockPath, { force: true }) } catch {}
    },
  }
}

export class DaemonTuiRpcClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private requestId = 1
  private pending = new Map<string, { resolve: (value: any) => void, reject: (error: any) => void }>()
  private listeners = new Set<(event: any) => void>()
  private connected = false
  private manuallyStopped = false
  private reconnectPromise: Promise<void> | null = null
  private lastInit: any = {}
  private reconnectGeneration = 0
  private lastEventSeq = 0
  private autoResumeIntent = false
  private readonly clientInstanceId = nodeCrypto.randomUUID()

  constructor(private readonly stateRoot: string) {}

  onEvent(listener: (event: any) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: any) {
    for (const listener of this.listeners) {
      try { listener(event) } catch {}
    }
  }

  private rememberAutoResumeIntent(state: any) {
    const current = state && typeof state === 'object' ? state : null
    const pending = Number(current && current.pendingMessageCount || 0)
    if (Boolean(current && (current.isStreaming || current.isCompacting || current.isRetrying || current.isBashRunning))) {
      this.autoResumeIntent = true
    } else if (Number.isFinite(pending) && pending > 0) {
      this.autoResumeIntent = true
    } else if (current) {
      this.autoResumeIntent = false
    }
    this.lastInit = {
      ...this.lastInit,
      autoResume: this.autoResumeIntent,
      clientInstanceId: this.clientInstanceId,
    }
  }

  private async connectOnce(init: { sessionFile?: string, provider?: string, model?: string, thinking?: string, chatKey?: string, reconnectGeneration?: number, lastEventSeq?: number, autoResume?: boolean, clientInstanceId?: string } = {}) {
    const sockPath = tuiRpcSockPathForState(this.stateRoot)
    const socket = new net.Socket()
    socket.setEncoding('utf8')
    this.socket = socket
    this.buffer = ''
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { socket.destroy(new Error('daemon_tui_rpc_connect_timeout')) } catch {}
        reject(new Error('daemon_tui_rpc_connect_timeout'))
      }, 1500)
      try { timeout.unref() } catch {}
      const cleanup = () => {
        try { clearTimeout(timeout) } catch {}
        socket.removeListener('error', onError)
        socket.removeListener('connect', onConnect)
      }
      const onError = (error: any) => {
        cleanup()
        reject(error)
      }
      const onConnect = () => {
        cleanup()
        resolve()
      }
      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.connect({ path: sockPath })
    })
    this.connected = true
    socket.on('data', (chunk) => {
      this.buffer += chunk
      while (true) {
        const nl = this.buffer.indexOf('\n')
        if (nl < 0) break
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        let obj: any = null
        try { obj = JSON.parse(line) } catch { continue }
        if (obj && obj.type === 'response' && Object.prototype.hasOwnProperty.call(obj, 'id') && this.pending.has(String(obj.id))) {
          const req = this.pending.get(String(obj.id))!
          this.pending.delete(String(obj.id))
          if (obj.success === false) req.reject(new Error(safeString(obj.error || 'rpc_error')))
          else req.resolve(obj.data)
          continue
        }
        const eventSeq = Math.max(0, Number(obj && obj.eventSeq) || 0)
        if (eventSeq > 0) {
          this.lastEventSeq = Math.max(this.lastEventSeq, eventSeq)
          this.lastInit = {
            ...this.lastInit,
            lastEventSeq: this.lastEventSeq,
          }
        }
        const type = safeString(obj && obj.type)
        if (type === 'agent_start' || type === 'auto_compaction_start' || type === 'auto_retry_start') {
          this.autoResumeIntent = true
          this.lastInit = { ...this.lastInit, autoResume: true }
        } else if (type === 'agent_end' || type === 'auto_compaction_end' || type === 'auto_retry_end') {
          this.rememberAutoResumeIntent({ isStreaming: false, isCompacting: false, isRetrying: false, isBashRunning: false, pendingMessageCount: 0 })
        }
        this.emit(obj)
      }
    })
    socket.on('error', (error) => {
      for (const [, req] of this.pending) {
        try { req.reject(error) } catch {}
      }
      this.pending.clear()
      this.emit({ type: 'client_error', error: safeString(error && (error as any).message ? (error as any).message : error) })
    })
    socket.on('close', () => {
      this.connected = false
      this.socket = null
      for (const [, req] of this.pending) {
        try { req.reject(new Error('daemon_tui_rpc_disconnected')) } catch {}
      }
      this.pending.clear()
      this.emit({ type: 'client_close' })
      if (!this.manuallyStopped) {
        this.reconnectGeneration += 1
        this.lastInit = {
          ...this.lastInit,
          reconnectGeneration: this.reconnectGeneration,
        }
        void this.ensureReconnected()
      }
    })
    const initState: any = await this.send('init', init)
    const latestEventSeq = Math.max(0, Number(initState && initState.latestEventSeq) || 0)
    if (latestEventSeq > 0) {
      this.lastEventSeq = Math.max(this.lastEventSeq, latestEventSeq)
      this.lastInit = {
        ...this.lastInit,
        lastEventSeq: this.lastEventSeq,
      }
    }
    this.rememberAutoResumeIntent(initState)
  }

  private async ensureReconnected() {
    if (this.manuallyStopped || this.connected) return
    if (this.reconnectPromise) return await this.reconnectPromise
    this.reconnectPromise = (async () => {
      this.emit({ type: 'client_reconnecting' })
      while (!this.manuallyStopped && !this.connected) {
        try {
          await this.connectOnce(this.lastInit)
          this.emit({ type: 'client_reconnected' })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    })()
    try {
      await this.reconnectPromise
    } finally {
      this.reconnectPromise = null
    }
  }

  setInitState(next: { sessionFile?: string, provider?: string, model?: string, thinking?: string, chatKey?: string, reconnectGeneration?: number, lastEventSeq?: number, autoResume?: boolean, clientInstanceId?: string } = {}) {
    this.lastInit = {
      ...this.lastInit,
      ...next,
    }
  }

  async start(init: { sessionFile?: string, provider?: string, model?: string, thinking?: string, chatKey?: string, reconnectGeneration?: number, lastEventSeq?: number, autoResume?: boolean, clientInstanceId?: string } = {}) {
    this.manuallyStopped = false
    if (!Number.isFinite(Number(init && init.reconnectGeneration))) {
      this.reconnectGeneration = 0
      init = { ...init, reconnectGeneration: this.reconnectGeneration }
    }
    if (!Number.isFinite(Number(init && init.lastEventSeq))) {
      init = { ...init, lastEventSeq: this.lastEventSeq }
    }
    if (typeof (init && init.autoResume) !== 'boolean') {
      init = { ...init, autoResume: this.autoResumeIntent }
    }
    if (!safeString(init && init.clientInstanceId).trim()) {
      init = { ...init, clientInstanceId: this.clientInstanceId }
    }
    this.setInitState(init)
    if (this.connected) return
    if (this.reconnectPromise) return await this.reconnectPromise
    await this.connectOnce(this.lastInit)
  }

  async stop() {
    this.manuallyStopped = true
    this.autoResumeIntent = false
    this.lastInit = {
      ...this.lastInit,
      autoResume: false,
      clientInstanceId: this.clientInstanceId,
    }
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    this.connected = false
    try { socket.end() } catch {}
    try { socket.destroy() } catch {}
  }

  private async send(command: string, data: any = {}) {
    if ((!this.socket || !this.connected) && !this.manuallyStopped) {
      await this.ensureReconnected()
    }
    if (!this.socket || !this.connected) throw new Error('daemon_tui_rpc_not_connected')
    const id = String(this.requestId++)
    const payload = { id, type: command, ...data }
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket!.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  prompt(message: string, images: any[] = [], streamingBehavior?: 'steer' | 'followUp') {
    return this.send('prompt', { message, images, streamingBehavior })
  }
  steer(message: string, images: any[] = []) { return this.send('steer', { message, images }) }
  followUp(message: string, images: any[] = []) { return this.send('follow_up', { message, images }) }
  clearQueue() { return this.send('clear_queue').then((data: any) => ({ steering: data && data.steering ? data.steering : [], followUp: data && data.followUp ? data.followUp : [] })) }
  abort() { return this.send('abort') }
  getState() { return this.send('get_state') }
  getMessages() { return this.send('get_messages').then((data: any) => data && data.messages ? data.messages : []) }
  setModel(provider: string, modelId: string) { return this.send('set_model', { provider, modelId }) }
  cycleModel(direction: 'forward' | 'backward' = 'forward') { return this.send('cycle_model', { direction }) }
  getAvailableModels() { return this.send('get_available_models').then((data: any) => data && data.models ? data.models : []) }
  setThinkingLevel(level: string) { return this.send('set_thinking_level', { level }) }
  cycleThinkingLevel() { return this.send('cycle_thinking_level') }
  setSteeringMode(mode: 'all' | 'one-at-a-time') { return this.send('set_steering_mode', { mode }) }
  setFollowUpMode(mode: 'all' | 'one-at-a-time') { return this.send('set_follow_up_mode', { mode }) }
  setAutoCompaction(enabled: boolean) { return this.send('set_auto_compaction', { enabled }) }
  setAutoRetry(enabled: boolean) { return this.send('set_auto_retry', { enabled }) }
  abortCompaction() { return this.send('abort_compaction') }
  abortBranchSummary() { return this.send('abort_branch_summary') }
  abortRetry() { return this.send('abort_retry') }
  compact(customInstructions = '') { return this.send('compact', { customInstructions }) }
  getCommands() { return this.send('get_commands').then((data: any) => data && data.commands ? data.commands : []) }
  getSessionStats() { return this.send('get_session_stats') }
  getLastAssistantText() { return this.send('get_last_assistant_text').then((data: any) => data ? data.text : null) }
  newSession(parentSession = '') { return this.send('new_session', parentSession ? { parentSession } : {}) }
  openSession(sessionPath: string) { return this.send('open_session', { sessionPath }) }
  getBridgeSessions() { return this.send('get_bridge_sessions').then((data: any) => data && data.sessions ? data.sessions : []) }
  openBridgeSession(chatKey: string) { return this.send('open_bridge_session', { chatKey }) }
  runControlCommand(name: string, chatKey = '') { return this.send('control_command', { name, chatKey }) }
  switchSession(sessionPath: string) { return this.send('switch_session', { sessionPath }) }
  navigateTree(entryId: string, options: { summarize?: boolean, customInstructions?: string, replaceInstructions?: boolean, label?: string } = {}) {
    return this.send('navigate_tree', { entryId, ...options })
  }
  fork(entryId: string) { return this.send('fork', { entryId }) }
  getForkMessages() { return this.send('get_fork_messages').then((data: any) => data && data.messages ? data.messages : []) }
  setSessionName(name: string) { return this.send('set_session_name', { name }) }
  bash(command: string) { return this.send('bash', { command }) }
  abortBash() { return this.send('abort_bash') }
  replyExtensionUi(id: string, payload: any) {
    if (!this.socket || !this.connected) throw new Error('daemon_tui_rpc_not_connected')
    this.socket.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...payload })}\n`)
  }
}
