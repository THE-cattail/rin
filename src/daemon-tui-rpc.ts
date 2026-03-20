// @ts-nocheck
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'

import { createRinPiSession } from './runtime'

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
    const mod = await import('@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js')
    return mod && mod.theme ? mod.theme : createPlainTheme()
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
      send({ type: 'extension_ui_request', id, ...request })
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

export function startDaemonTuiRpcServer({ repoRoot, stateRoot, logger }: { repoRoot: string, stateRoot: string, logger?: any }) {
  const sockPath = tuiRpcSockPathForState(stateRoot)
  try { fs.rmSync(sockPath, { force: true }) } catch {}

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let closed = false
    let buf = ''
    let initialized = false
    let initInFlight: Promise<void> | null = null
    let session: any = null
    let created: any = null
    let theme: any = createPlainTheme()
    const pendingExtensionRequests = new Map<string, { resolve: (value: any) => void }>()

    const send = (obj: any) => {
      if (closed) return
      try { socket.write(`${JSON.stringify(obj)}\n`) } catch {}
    }

    const cleanup = async () => {
      if (closed) return
      closed = true
      for (const [, pending] of pendingExtensionRequests) {
        try { pending.resolve({ cancelled: true }) } catch {}
      }
      pendingExtensionRequests.clear()
      if (session && typeof session.dispose === 'function') {
        try { session.dispose() } catch {}
      }
      try { socket.destroy() } catch {}
    }

    const ensureSession = async (payload: any) => {
      if (initialized) return
      if (initInFlight) return await initInFlight
      initInFlight = (async () => {
        theme = await loadThemeSingleton()
        created = await createRinPiSession({
          repoRoot,
          workspaceRoot: stateRoot,
          sessionCwd: process.env.HOME || os.homedir(),
          resourceCwd: stateRoot,
          settingsCwd: stateRoot,
          sessionFile: safeString(payload && payload.sessionFile).trim(),
          sessionPolicy: safeString(payload && payload.sessionFile).trim() ? 'continueRecent' : 'continueRecent',
          brainChatKey: 'local:default',
          currentChatKey: '',
          provider: safeString(payload && payload.provider).trim(),
          model: safeString(payload && payload.model).trim(),
          thinking: safeString(payload && payload.thinking).trim(),
        })
        session = created.session
        if (!session) throw new Error('pi_sdk_session_missing')

        const uiContext = createExtensionUiBridge({ send, pendingRequests: pendingExtensionRequests, theme })
        await session.bindExtensions({
          uiContext,
          commandContextActions: {
            waitForIdle: () => session.agent.waitForIdle(),
            newSession: async (options: any) => ({ cancelled: !(await session.newSession(options)) }),
            fork: async (entryId: string) => {
              const result = await session.fork(entryId)
              return { cancelled: result.cancelled }
            },
            navigateTree: async (targetId: string, options: any) => {
              const result = await session.navigateTree(targetId, {
                summarize: options && options.summarize,
                customInstructions: options && options.customInstructions,
                replaceInstructions: options && options.replaceInstructions,
                label: options && options.label,
              })
              return { cancelled: result.cancelled }
            },
            switchSession: async (sessionPath: string) => ({ cancelled: !(await session.switchSession(sessionPath)) }),
            reload: async () => { await session.reload() },
          },
          shutdownHandler: () => {},
          onError: (err: any) => send({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error }),
        })

        session.subscribe((event: any) => send(event))
        initialized = true
      })()
      try {
        await initInFlight
      } finally {
        initInFlight = null
      }
    }

    const handleCommand = async (command: any) => {
      const id = command && command.id
      const type = safeString(command && command.type)

      if (type === 'extension_ui_response') {
        const pending = pendingExtensionRequests.get(safeString(command && command.id))
        if (pending) {
          pendingExtensionRequests.delete(safeString(command && command.id))
          pending.resolve(command)
        }
        return null
      }

      if (type === 'init') {
        await ensureSession(command)
        const state = {
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          isRetrying: Boolean(session.isRetrying),
          isBashRunning: Boolean(session.isBashRunning),
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          sessionCwd: session.sessionManager && typeof session.sessionManager.getCwd === 'function' ? session.sessionManager.getCwd() : '',
          autoCompactionEnabled: session.autoCompactionEnabled,
          autoRetryEnabled: Boolean(session.autoRetryEnabled),
          messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
          pendingMessageCount: Number(session.pendingMessageCount || 0),
        }
        return normalizeResponse(id, 'init', state)
      }

      if (!initialized) throw new Error('tui_rpc_requires_init')

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
          return normalizeResponse(id, 'get_state', {
            model: session.model,
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            isRetrying: Boolean(session.isRetrying),
            isBashRunning: Boolean(session.isBashRunning),
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            sessionCwd: session.sessionManager && typeof session.sessionManager.getCwd === 'function' ? session.sessionManager.getCwd() : '',
            autoCompactionEnabled: session.autoCompactionEnabled,
            autoRetryEnabled: Boolean(session.autoRetryEnabled),
            messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
            pendingMessageCount: Number(session.pendingMessageCount || 0),
          })
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
          return normalizeResponse(id, 'new_session', { cancelled })
        }
        case 'switch_session': {
          const cancelled = !(await session.switchSession(safeString(command.sessionPath || '')))
          return normalizeResponse(id, 'switch_session', { cancelled })
        }
        case 'navigate_tree': {
          const result = await session.navigateTree(safeString(command.entryId || ''), {
            summarize: Boolean(command.summarize),
            customInstructions: safeString(command.customInstructions || '') || undefined,
            replaceInstructions: Boolean(command.replaceInstructions),
            label: safeString(command.label || '') || undefined,
          })
          return normalizeResponse(id, 'navigate_tree', {
            cancelled: Boolean(result && result.cancelled),
            aborted: Boolean(result && result.aborted),
            editorText: result && result.editorText ? result.editorText : undefined,
          })
        }
        case 'fork': {
          const result = await session.fork(safeString(command.entryId || ''))
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

  async start(init: { sessionFile?: string, provider?: string, model?: string, thinking?: string } = {}) {
    if (this.connected) return
    const sockPath = tuiRpcSockPathForState(this.stateRoot)
    const socket = new net.Socket()
    socket.setEncoding('utf8')
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const onError = (error: any) => {
        socket.removeListener('connect', onConnect)
        reject(error)
      }
      const onConnect = () => {
        socket.removeListener('error', onError)
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
      this.emit({ type: 'client_close' })
    })
    await this.send('init', init)
  }

  async stop() {
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    this.connected = false
    try { socket.end() } catch {}
    try { socket.destroy() } catch {}
  }

  private async send(command: string, data: any = {}) {
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
  compact(customInstructions = '') { return this.send('compact', { customInstructions }) }
  getCommands() { return this.send('get_commands').then((data: any) => data && data.commands ? data.commands : []) }
  getLastAssistantText() { return this.send('get_last_assistant_text').then((data: any) => data ? data.text : null) }
  newSession(parentSession = '') { return this.send('new_session', parentSession ? { parentSession } : {}) }
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
