// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let DaemonTuiRpcClientImpl;
let importPiCodingAgentModuleImpl;
let resolveRinLayoutImpl;
function requireRuntimeValue(runtime, name) {
    const value = runtime && runtime[name];
    if (!value)
        throw new Error(`rin daemon tui missing runtime dependency: ${name}`);
    return value;
}
function safeString(value) {
    if (value == null)
        return '';
    return String(value);
}
function expandHome(value) {
    const raw = safeString(value).trim();
    if (!raw)
        return '';
    if (raw === '~')
        return process.env.HOME || os.homedir();
    if (raw.startsWith('~/'))
        return path.join(process.env.HOME || os.homedir(), raw.slice(2));
    return raw;
}
function usage(exitCode = 0) {
    const text = [
        'Usage:',
        '  rin-tui [--session <path>] [--provider <id>] [--model <id>] [--thinking <level>]',
        '',
        'Runs the daemon-backed Rin TUI frontend.',
    ].join('\n');
    if (exitCode === 0)
        console.log(text);
    else
        console.error(text);
    process.exit(exitCode);
}
function parseArgs(argv) {
    let sessionFile = '';
    let provider = '';
    let model = '';
    let thinking = '';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help' || a === 'help')
            usage(0);
        if (a === '--session') {
            sessionFile = path.resolve(expandHome(argv[i + 1] || ''));
            i += 1;
            continue;
        }
        if (a === '--provider') {
            provider = safeString(argv[i + 1]);
            i += 1;
            continue;
        }
        if (a === '--model') {
            model = safeString(argv[i + 1]);
            i += 1;
            continue;
        }
        if (a === '--thinking') {
            thinking = safeString(argv[i + 1]);
            i += 1;
            continue;
        }
        console.error(`Unknown arg: ${a}`);
        usage(2);
    }
    return { sessionFile, provider, model, thinking };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatContextUsageLine(contextUsage) {
    const usage = contextUsage && typeof contextUsage === 'object' ? contextUsage : null;
    if (!usage)
        return 'Context: n/a';
    const tokens = Number(usage.tokens);
    const window = Number(usage.contextWindow);
    const percent = Number(usage.percent);
    const tokenText = Number.isFinite(tokens) && tokens >= 0 ? String(tokens) : '?';
    const windowText = Number.isFinite(window) && window > 0 ? String(window) : '?';
    const percentText = Number.isFinite(percent) ? `${percent.toFixed(1)}%` : '?';
    return `Context: ${tokenText}/${windowText} (${percentText})`;
}
function formatCurrentSessionStatus(state) {
    const current = state && typeof state === 'object' ? state : {};
    const lines = [];
    const sessionName = safeString(current.sessionName || '').trim() || 'default';
    lines.push(`Session: ${sessionName}`);
    const provider = safeString(current.model && current.model.provider || '').trim();
    const modelId = safeString(current.model && current.model.id || '').trim();
    lines.push(`Model: ${provider || '(unknown provider)'}/${modelId || '(unknown model)'}`);
    lines.push(`Thinking: ${safeString(current.thinkingLevel || '').trim() || 'minimal'}`);
    let activity = 'idle';
    if (current.isStreaming)
        activity = 'running';
    else if (current.isCompacting)
        activity = 'compacting';
    else if (current.isRetrying)
        activity = 'retrying';
    else if (current.isBashRunning)
        activity = 'bash running';
    lines.push(`Agent: ${activity}`);
    lines.push(formatContextUsageLine(current.contextUsage));
    const sessionFile = safeString(current.sessionFile || '').trim();
    if (sessionFile)
        lines.push(`Session file: ${sessionFile}`);
    const sessionCwd = safeString(current.sessionCwd || '').trim();
    if (sessionCwd)
        lines.push(`Cwd: ${sessionCwd}`);
    const chatKey = safeString(current.bridgeChatKey || '').trim();
    if (chatKey)
        lines.push(`Chat: ${chatKey}`);
    const pending = Number(current.pendingMessageCount || 0);
    if (Number.isFinite(pending) && pending > 0)
        lines.push(`Queued messages: ${pending}`);
    return lines.join('\n');
}
function normalizeSlashCommandName(value) {
    const text = safeString(value).trim().replace(/^\/+/, '');
    return text;
}
function currentModelKey(model) {
    const provider = safeString(model && model.provider).trim();
    const id = safeString(model && model.id).trim();
    return provider && id ? `${provider}/${id}` : '';
}
class RemoteExtensionRunner {
    commands = [];
    setCommands(commands) {
        this.commands = Array.isArray(commands) ? commands.slice() : [];
    }
    normalizeCommand(item) {
        const name = normalizeSlashCommandName(item && item.name);
        if (!name)
            return null;
        return {
            name,
            description: safeString(item && item.description || ''),
        };
    }
    getRegisteredCommands(reserved) {
        const result = [];
        for (const item of this.commands) {
            const normalized = this.normalizeCommand(item);
            if (!normalized)
                continue;
            if (reserved && reserved.has(normalized.name))
                continue;
            result.push(normalized);
        }
        return result;
    }
    getCommand(name) {
        const target = normalizeSlashCommandName(name);
        for (const item of this.commands) {
            const normalized = this.normalizeCommand(item);
            if (!normalized)
                continue;
            if (normalized.name === target)
                return normalized;
        }
        return undefined;
    }
    getExtensionPaths() { return []; }
    getAllRegisteredTools() { return []; }
    getShortcuts() { return new Map(); }
    getShortcutDiagnostics() { return []; }
    getCommandDiagnostics() { return []; }
    getMessageRenderer() { return undefined; }
    hasHandlers() { return false; }
    async emit() { return undefined; }
    async emitUserBash() { return undefined; }
}
class RinDaemonSessionAdapter {
    client;
    pi;
    stateRoot;
    initOptions;
    authStorage;
    modelRegistry;
    settingsManager;
    resourceLoader;
    extensionRunner;
    sessionManager;
    agent;
    promptTemplates = [];
    scopedModels = [];
    listeners = new Set();
    uiContext = null;
    extensionErrorListener = null;
    currentState = {};
    messages = [];
    initialized = false;
    disposed = false;
    clientEventsBound = false;
    constructor({ client, pi, stateRoot, initOptions }) {
        this.client = client;
        this.pi = pi;
        this.stateRoot = stateRoot;
        this.initOptions = initOptions || {};
        this.extensionRunner = new RemoteExtensionRunner();
    }
    async init() {
        if (this.initialized)
            return;
        this.authStorage = this.pi.AuthStorage.create(path.join(this.stateRoot, 'auth.json'));
        this.modelRegistry = new this.pi.ModelRegistry(this.authStorage, path.join(this.stateRoot, 'models.json'));
        this.settingsManager = this.pi.SettingsManager.create(this.stateRoot, this.stateRoot);
        this.resourceLoader = new this.pi.DefaultResourceLoader({
            cwd: process.cwd(),
            agentDir: this.stateRoot,
            settingsManager: this.settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
        });
        await this.resourceLoader.reload().catch(() => { });
        this.promptTemplates = Array.isArray(this.resourceLoader.getPrompts?.().prompts) ? this.resourceLoader.getPrompts().prompts : [];
        if (!this.clientEventsBound) {
            this.clientEventsBound = true;
            this.client.onEvent((event) => { void this.handleClientEvent(event); });
        }
        await this.client.start(this.initOptions);
        await this.refreshRemote({ reloadMessages: true, refreshCommands: true });
        this.agent = {
            waitForIdle: async () => {
                for (;;) {
                    if (!this.isStreaming && !this.isCompacting && !this.isRetrying && !this.isBashRunning)
                        return;
                    await sleep(80);
                }
            },
            abort: () => { void this.abort().catch(() => { }); },
            setTransport: (transport) => {
                try {
                    this.settingsManager.setTransport?.(transport);
                }
                catch { }
            },
        };
        this.initialized = true;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        try {
            this.client.stop?.();
        }
        catch { }
        this.listeners.clear();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch { }
        }
    }
    clearTransientRuntimeState() {
        const interrupted = {
            wasStreaming: Boolean(this.currentState && this.currentState.isStreaming),
            wasCompacting: Boolean(this.currentState && this.currentState.isCompacting),
            wasRetrying: Boolean(this.currentState && this.currentState.isRetrying),
        };
        this.currentState = {
            ...this.currentState,
            isStreaming: false,
            isCompacting: false,
            isRetrying: false,
            isBashRunning: false,
        };
        return interrupted;
    }
    emitInterruptedRuntimeEndEvents(interrupted = {}) {
        if (interrupted.wasStreaming) {
            this.emit({ type: 'agent_end', interrupted: true, daemonRestartRecovery: true });
        }
        if (interrupted.wasCompacting) {
            this.emit({ type: 'auto_compaction_end', aborted: true, daemonRestartRecovery: true, willRetry: false });
        }
        if (interrupted.wasRetrying) {
            this.emit({ type: 'auto_retry_end', success: true, attempt: 0, daemonRestartRecovery: true });
        }
    }
    async refreshRemote({ reloadMessages = false, refreshCommands = false } = {}) {
        const nextState = await this.client.getState().catch(() => null);
        if (nextState && typeof nextState === 'object') {
            this.currentState = nextState;
            this.client.setInitState?.({
                sessionFile: safeString(nextState && nextState.sessionFile).trim() || undefined,
                chatKey: safeString(nextState && nextState.bridgeChatKey).trim() || undefined,
                provider: safeString(nextState && nextState.model && nextState.model.provider).trim() || undefined,
                model: safeString(nextState && nextState.model && nextState.model.id).trim() || undefined,
                thinking: safeString(nextState && nextState.thinkingLevel).trim() || undefined,
                lastEventSeq: Math.max(0, Number(nextState && nextState.latestEventSeq) || 0) || undefined,
                autoResume: Boolean(nextState && (nextState.isStreaming || nextState.isCompacting || nextState.isRetrying || nextState.isBashRunning || Number(nextState.pendingMessageCount || 0) > 0)),
            });
        }
        if (refreshCommands) {
            const commands = await this.client.getCommands().catch(() => []);
            this.extensionRunner.setCommands(Array.isArray(commands) ? commands : []);
        }
        if (reloadMessages || !Array.isArray(this.messages) || this.messages.length === 0) {
            this.messages = await this.client.getMessages().catch(() => this.messages);
        }
        await this.refreshSessionManager();
    }
    async refreshSessionManager() {
        const sessionFile = safeString(this.currentState && this.currentState.sessionFile).trim();
        if (sessionFile && fs.existsSync(sessionFile)) {
            this.sessionManager = this.pi.SessionManager.open(sessionFile);
            return;
        }
        if (!this.sessionManager) {
            const sessionCwd = safeString(this.currentState && this.currentState.sessionCwd).trim() || process.cwd();
            const fallbackDir = path.join(this.stateRoot, 'sessions');
            try {
                this.sessionManager = this.pi.SessionManager.create(sessionCwd, fallbackDir);
            }
            catch {
                this.sessionManager = this.pi.SessionManager.create(process.cwd(), fallbackDir);
            }
        }
    }
    async handleClientEvent(event) {
        const type = safeString(event && event.type);
        if (!type)
            return;
        if (type === 'extension_ui_request') {
            await this.handleExtensionUiRequest(event);
            return;
        }
        if (type === 'extension_error') {
            if (typeof this.extensionErrorListener === 'function') {
                try {
                    this.extensionErrorListener({
                        extensionPath: safeString(event && event.extensionPath || 'remote'),
                        event: safeString(event && event.event || ''),
                        error: safeString(event && event.error || 'extension_error'),
                    });
                }
                catch { }
            }
            return;
        }
        if (type === 'client_reconnecting') {
            const interrupted = this.clearTransientRuntimeState();
            this.emitInterruptedRuntimeEndEvents(interrupted);
            this.emit({ type: 'status', text: 'Waiting for daemon…' });
            return;
        }
        if (type === 'client_reconnected') {
            this.clearTransientRuntimeState();
            await this.refreshRemote({ reloadMessages: true, refreshCommands: true });
            return;
        }
        if (type === 'daemon_restart_recovery') {
            this.clearTransientRuntimeState();
            await this.refreshRemote({ reloadMessages: true, refreshCommands: true });
            return;
        }
        if (type === 'client_close' || type === 'client_error') {
            return;
        }
        if (type === 'agent_start')
            this.currentState = { ...this.currentState, isStreaming: true };
        if (type === 'agent_end') {
            this.currentState = { ...this.currentState, isStreaming: false };
            await this.refreshRemote({ reloadMessages: true });
        }
        if (type === 'auto_compaction_start')
            this.currentState = { ...this.currentState, isCompacting: true };
        if (type === 'auto_compaction_end') {
            this.currentState = { ...this.currentState, isCompacting: false };
            await this.refreshRemote();
        }
        if (type === 'auto_retry_start')
            this.currentState = { ...this.currentState, isRetrying: true };
        if (type === 'auto_retry_end') {
            this.currentState = { ...this.currentState, isRetrying: false };
            await this.refreshRemote();
        }
        if (type === 'message_end') {
            const message = event && event.message;
            if (message) {
                const id = safeString(message && (message.id || message.timestamp || ''));
                const next = Array.isArray(this.messages) ? this.messages.slice() : [];
                const index = id ? next.findIndex((item) => safeString(item && (item.id || item.timestamp || '')) === id) : -1;
                if (index >= 0)
                    next[index] = message;
                else
                    next.push(message);
                this.messages = next;
            }
        }
        this.emit(event);
    }
    async handleExtensionUiRequest(req) {
        const ui = this.uiContext;
        const method = safeString(req && req.method);
        const id = safeString(req && req.id);
        if (!ui || !method)
            return;
        try {
            if (method === 'notify') {
                ui.notify?.(safeString(req && req.message || ''), safeString(req && req.notifyType || ''));
                return;
            }
            if (method === 'setStatus') {
                ui.setStatus?.(safeString(req && req.statusKey || ''), safeString(req && req.statusText || '') || undefined);
                return;
            }
            if (method === 'setWidget') {
                ui.setWidget?.(safeString(req && req.widgetKey || ''), Array.isArray(req && req.widgetLines) ? req.widgetLines.map((line) => safeString(line)) : undefined, { placement: safeString(req && req.widgetPlacement || '') || undefined });
                return;
            }
            if (method === 'setTitle') {
                ui.setTitle?.(safeString(req && req.title || 'Rin'));
                return;
            }
            if (method === 'set_editor_text') {
                ui.setEditorText?.(safeString(req && req.text || ''));
                return;
            }
            if (!id)
                return;
            if (method === 'select') {
                const value = await ui.select?.(safeString(req && req.title || ''), Array.isArray(req && req.options) ? req.options.map((item) => safeString(item)) : []);
                this.client.replyExtensionUi(id, value == null ? { cancelled: true } : { value });
                return;
            }
            if (method === 'confirm') {
                const confirmed = await ui.confirm?.(safeString(req && req.title || ''), safeString(req && req.message || ''));
                this.client.replyExtensionUi(id, { confirmed: Boolean(confirmed) });
                return;
            }
            if (method === 'input') {
                const value = await ui.input?.(safeString(req && req.title || ''), safeString(req && req.placeholder || ''));
                this.client.replyExtensionUi(id, value == null ? { cancelled: true } : { value });
                return;
            }
            if (method === 'editor') {
                const value = await ui.editor?.(safeString(req && req.title || ''), safeString(req && req.prefill || ''));
                this.client.replyExtensionUi(id, value == null ? { cancelled: true } : { value });
            }
        }
        catch (error) {
            try {
                if (id)
                    this.client.replyExtensionUi(id, { cancelled: true, error: safeString(error && error.message ? error.message : error) });
            }
            catch { }
        }
    }
    bindExtensions(bindings = {}) {
        this.uiContext = bindings && bindings.uiContext ? bindings.uiContext : null;
        this.extensionErrorListener = bindings && bindings.onError ? bindings.onError : null;
    }
    get state() {
        return {
            messages: Array.isArray(this.messages) ? this.messages : [],
            systemPrompt: this.systemPrompt,
            model: this.model,
            thinkingLevel: this.thinkingLevel,
            isStreaming: this.isStreaming,
            isCompacting: this.isCompacting,
            isRetrying: this.isRetrying,
            isBashRunning: this.isBashRunning,
            steeringMode: this.steeringMode,
            followUpMode: this.followUpMode,
            pendingMessageCount: this.pendingMessageCount,
            autoCompactionEnabled: this.autoCompactionEnabled,
            autoRetryEnabled: this.autoRetryEnabled,
        };
    }
    get model() { return this.currentState && this.currentState.model ? this.currentState.model : undefined; }
    get thinkingLevel() { return safeString(this.currentState && this.currentState.thinkingLevel).trim() || 'minimal'; }
    get isStreaming() { return Boolean(this.currentState && this.currentState.isStreaming); }
    get isCompacting() { return Boolean(this.currentState && this.currentState.isCompacting); }
    get isRetrying() { return Boolean(this.currentState && this.currentState.isRetrying); }
    get isBashRunning() { return Boolean(this.currentState && this.currentState.isBashRunning); }
    get systemPrompt() { return safeString(this.resourceLoader && this.resourceLoader.getSystemPrompt ? this.resourceLoader.getSystemPrompt() : ''); }
    get retryAttempt() { return 0; }
    get steeringMode() { return safeString(this.currentState && this.currentState.steeringMode).trim() === 'all' ? 'all' : 'one-at-a-time'; }
    get followUpMode() { return safeString(this.currentState && this.currentState.followUpMode).trim() === 'all' ? 'all' : 'one-at-a-time'; }
    get sessionFile() { return safeString(this.currentState && this.currentState.sessionFile).trim() || undefined; }
    get sessionId() { return safeString(this.currentState && this.currentState.sessionId).trim() || 'remote'; }
    get sessionName() { return safeString(this.currentState && this.currentState.sessionName).trim() || ''; }
    get pendingMessageCount() { return Number(this.currentState && this.currentState.pendingMessageCount || 0); }
    get autoCompactionEnabled() { return Boolean(this.currentState && this.currentState.autoCompactionEnabled); }
    get autoRetryEnabled() { return Boolean(this.currentState && this.currentState.autoRetryEnabled); }
    async prompt(message, options = {}) {
        const text = safeString(message);
        const streamingBehavior = safeString(options && options.streamingBehavior).trim();
        await this.client.prompt(text, Array.isArray(options && options.images) ? options.images : [], streamingBehavior || undefined);
        await this.refreshRemote();
    }
    async steer(message, images = []) {
        await this.client.steer(safeString(message), Array.isArray(images) ? images : []);
        await this.refreshRemote();
    }
    async followUp(message, images = []) {
        await this.client.followUp(safeString(message), Array.isArray(images) ? images : []);
        await this.refreshRemote();
    }
    clearQueue() {
        const steering = Array.isArray(this.currentState && this.currentState.steeringMessages) ? this.currentState.steeringMessages.slice() : [];
        const followUp = Array.isArray(this.currentState && this.currentState.followUpMessages) ? this.currentState.followUpMessages.slice() : [];
        this.currentState = {
            ...this.currentState,
            pendingMessageCount: 0,
            steeringMessages: [],
            followUpMessages: [],
        };
        void this.client.clearQueue().then(() => this.refreshRemote()).catch(() => { });
        return { steering, followUp };
    }
    getSteeringMessages() { return Array.isArray(this.currentState && this.currentState.steeringMessages) ? this.currentState.steeringMessages.slice() : []; }
    getFollowUpMessages() { return Array.isArray(this.currentState && this.currentState.followUpMessages) ? this.currentState.followUpMessages.slice() : []; }
    async abort() { await this.client.abort(); }
    async setModel(model) {
        await this.client.setModel(safeString(model && model.provider), safeString(model && model.id));
        await this.refreshRemote();
    }
    async cycleModel(direction = 'forward') {
        if (Array.isArray(this.scopedModels) && this.scopedModels.length > 0) {
            const models = this.scopedModels.slice();
            const currentKey = currentModelKey(this.model);
            let index = models.findIndex((item) => currentModelKey(item && item.model) === currentKey);
            if (index < 0)
                index = 0;
            const delta = direction === 'backward' ? -1 : 1;
            const next = models[(index + delta + models.length) % models.length];
            if (!next || !next.model)
                return null;
            await this.client.setModel(safeString(next.model.provider), safeString(next.model.id));
            if (next.thinkingLevel)
                await this.client.setThinkingLevel(safeString(next.thinkingLevel));
            await this.refreshRemote();
            return { model: next.model, thinkingLevel: safeString(next.thinkingLevel || this.thinkingLevel) || this.thinkingLevel, isScoped: true };
        }
        const result = await this.client.cycleModel(direction);
        await this.refreshRemote();
        return result;
    }
    setScopedModels(models) {
        this.scopedModels = Array.isArray(models) ? models.slice() : [];
    }
    getAvailableThinkingLevels() {
        return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    }
    setThinkingLevel(level) {
        return this.client.setThinkingLevel(level).then(async () => {
            await this.refreshRemote();
        });
    }
    cycleThinkingLevel() {
        return this.client.cycleThinkingLevel().then(async (result) => {
            await this.refreshRemote();
            return result && result.level ? result.level : this.thinkingLevel;
        });
    }
    setSteeringMode(mode) {
        return this.client.setSteeringMode(mode).then(async () => {
            await this.refreshRemote();
        });
    }
    setFollowUpMode(mode) {
        return this.client.setFollowUpMode(mode).then(async () => {
            await this.refreshRemote();
        });
    }
    abortCompaction() { this.client.abortCompaction(); }
    abortBranchSummary() { this.client.abortBranchSummary(); }
    compact(customInstructions = '') { return this.client.compact(customInstructions); }
    setAutoCompactionEnabled(enabled) {
        return this.client.setAutoCompaction(enabled).then(async () => {
            await this.refreshRemote();
        });
    }
    setAutoRetryEnabled(enabled) {
        return this.client.setAutoRetry(enabled).then(async () => {
            await this.refreshRemote();
        });
    }
    abortRetry() { return this.client.abortRetry(); }
    executeBash(command) { return this.client.bash(command); }
    abortBash() { return this.client.abortBash(); }
    recordBashResult() { }
    async getSessionStats() {
        return await this.client.getSessionStats();
    }
    async exportToHtml(outputPath) {
        const sessionFile = safeString(this.sessionFile).trim();
        if (!sessionFile)
            throw new Error('Nothing to export yet - start a conversation first');
        const exportHtml = await importPiCodingAgentModuleImpl(path.join('dist', 'core', 'export-html', 'index.js'));
        return await exportHtml.exportFromFile(sessionFile, outputPath);
    }
    exportToJsonl(outputPath) {
        const sessionFile = safeString(this.sessionFile).trim();
        if (!sessionFile)
            throw new Error('Nothing to export yet - start a conversation first');
        if (!fs.existsSync(sessionFile))
            throw new Error('Nothing to export yet - start a conversation first');
        const target = path.resolve(outputPath || path.basename(sessionFile));
        if (path.resolve(target) !== path.resolve(sessionFile)) {
            fs.copyFileSync(sessionFile, target);
        }
        return target;
    }
    async importFromJsonl(inputPath) {
        const resolved = path.resolve(inputPath);
        if (!fs.existsSync(resolved))
            throw new Error(`File not found: ${resolved}`);
        const sessionDir = this.sessionManager && typeof this.sessionManager.getSessionDir === 'function'
            ? this.sessionManager.getSessionDir()
            : path.join(this.stateRoot, 'sessions');
        try {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        catch { }
        const destPath = path.join(sessionDir, path.basename(resolved));
        if (path.resolve(destPath) !== resolved)
            fs.copyFileSync(resolved, destPath);
        await this.client.openSession(destPath);
        await this.refreshRemote({ reloadMessages: true });
        return true;
    }
    getLastAssistantText() {
        return this.client.getLastAssistantText();
    }
    async reload() {
        await this.resourceLoader.reload().catch(() => { });
        try {
            this.modelRegistry.refresh?.();
        }
        catch { }
        await this.refreshRemote({ reloadMessages: true, refreshCommands: true });
    }
    async newSession(options) {
        const result = await this.client.newSession(safeString(options && options.parentSession).trim() || '');
        await this.refreshRemote({ reloadMessages: true });
        return !(result && result.cancelled);
    }
    async switchSession(sessionPath) {
        await this.client.switchSession(sessionPath);
        await this.refreshRemote({ reloadMessages: true });
        return true;
    }
    async navigateTree(targetId, options = {}) {
        const result = await this.client.navigateTree(targetId, {
            summarize: Boolean(options && options.summarize),
            customInstructions: safeString(options && options.customInstructions || '') || undefined,
            replaceInstructions: Boolean(options && options.replaceInstructions),
            label: safeString(options && options.label || '') || undefined,
        });
        await this.refreshRemote({ reloadMessages: true });
        return result;
    }
    async fork(entryId) {
        const result = await this.client.fork(entryId);
        await this.refreshRemote({ reloadMessages: true });
        return result || { cancelled: true };
    }
    getUserMessagesForForking() {
        return this.client.getForkMessages();
    }
    getContextUsage() {
        return this.currentState && this.currentState.contextUsage ? this.currentState.contextUsage : undefined;
    }
    setSessionName(name) {
        return this.client.setSessionName(name).then(async () => {
            await this.refreshRemote();
        });
    }
}
async function createSessionCatalogProvider({ client, session, stateRoot, bridgeMod, SessionManager }) {
    const { readRinSessionInfo, loadRinSessions, } = bridgeMod;
    const normalizeSessionPath = (value) => {
        const text = safeString(value).trim();
        return text ? path.resolve(text) : '';
    };
    const loadBridgeBindings = async () => {
        const items = await client.getBridgeSessions().catch(() => []);
        const bindings = (await Promise.all((Array.isArray(items) ? items : []).map(async (item) => {
            const chatKey = safeString(item && item.chatKey).trim();
            const sessionFile = normalizeSessionPath(item && item.sessionFile);
            if (!chatKey || !sessionFile)
                return null;
            try {
                const info = await readRinSessionInfo(sessionFile);
                return {
                    ...info,
                    path: sessionFile,
                    sessionFile,
                    chatKey,
                    modified: new Date(Math.max(Number(item && item.modifiedAt || 0), Number(info.modified) || 0)),
                };
            }
            catch {
                return null;
            }
        }))).filter(Boolean);
        bindings.sort((a, b) => Number(b.modified) - Number(a.modified));
        return bindings;
    };
    const mergeSessions = (localSessions, bridgeSessions) => {
        const rows = new Map();
        const upsert = (item, source) => {
            const sessionPath = normalizeSessionPath(item && item.path || item && item.sessionFile);
            if (!sessionPath)
                return;
            const current = rows.get(sessionPath);
            const modifiedMs = Math.max(Number(item && item.modified || 0), Number(current && current.modified || 0));
            const boundChatKeys = Array.isArray(current && current.boundChatKeys) ? current.boundChatKeys.slice() : [];
            const nextChatKey = safeString(item && item.chatKey).trim();
            if (source === 'bridge' && nextChatKey && !boundChatKeys.includes(nextChatKey))
                boundChatKeys.push(nextChatKey);
            const searchBridgeText = boundChatKeys.length ? `\n\n${boundChatKeys.map((chatKey) => `[bound chat] ${chatKey}`).join('\n')}` : '';
            rows.set(sessionPath, {
                ...(current && typeof current === 'object' ? current : {}),
                ...(item && typeof item === 'object' ? item : {}),
                path: sessionPath,
                modified: new Date(modifiedMs || Date.now()),
                boundChatKeys,
                allMessagesText: `${safeString(item && item.allMessagesText || current && current.allMessagesText)}`.trim() + searchBridgeText,
            });
        };
        for (const item of Array.isArray(localSessions) ? localSessions : [])
            upsert(item, 'local');
        for (const item of Array.isArray(bridgeSessions) ? bridgeSessions : [])
            upsert(item, 'bridge');
        return Array.from(rows.values()).sort((a, b) => Number(b.modified) - Number(a.modified));
    };
    return {
        listCurrent: async (onProgress) => {
            const cwd = safeString(session.currentState && session.currentState.sessionCwd).trim() || process.cwd();
            try {
                onProgress({ loaded: 0, total: 0 });
            }
            catch { }
            const [localSessions, bridgeSessions] = await Promise.all([
                loadRinSessions(stateRoot, cwd),
                loadBridgeBindings(),
            ]);
            return mergeSessions(localSessions, bridgeSessions);
        },
        listAll: async () => {
            const [localSessions, bridgeSessions] = await Promise.all([
                loadRinSessions(stateRoot),
                loadBridgeBindings(),
            ]);
            return mergeSessions(localSessions, bridgeSessions);
        },
        openSession: async (sessionPath) => {
            await client.openSession(sessionPath);
            await session.refreshRemote({ reloadMessages: true, refreshCommands: true });
        },
        renameSession: async (sessionPath, nextName) => {
            const name = safeString(nextName).trim();
            const normalizedSessionPath = normalizeSessionPath(sessionPath);
            if (!name || !normalizedSessionPath)
                return;
            if (normalizeSessionPath(session.currentState && session.currentState.sessionFile) === normalizedSessionPath) {
                await client.setSessionName(name);
                await session.refreshRemote();
                return;
            }
            const manager = SessionManager.open(normalizedSessionPath);
            manager.appendSessionInfo(name);
        },
        getActiveSessionPath: () => {
            return normalizeSessionPath(session.currentState && session.currentState.sessionFile) || undefined;
        },
    };
}
export async function runRinDaemonTui(runtime = {}) {
    DaemonTuiRpcClientImpl = requireRuntimeValue(runtime, 'DaemonTuiRpcClient');
    importPiCodingAgentModuleImpl = requireRuntimeValue(runtime, 'importPiCodingAgentModule');
    resolveRinLayoutImpl = requireRuntimeValue(runtime, 'resolveRinLayout');
    const args = parseArgs(Array.isArray(runtime.argv) ? runtime.argv : process.argv.slice(2));
    const stateRoot = resolveRinLayoutImpl().homeRoot;
    const pi = await importPiCodingAgentModuleImpl();
    const { InteractiveMode } = await importPiCodingAgentModuleImpl(path.join('dist', 'modes', 'interactive', 'interactive-mode.js'));
    const bridgeMod = await importPiCodingAgentModuleImpl(path.join('dist', 'modes', 'interactive', 'rin-daemon-bridge.js'));
    const client = new DaemonTuiRpcClientImpl(stateRoot);
    const session = new RinDaemonSessionAdapter({
        client,
        pi,
        stateRoot,
        initOptions: {
            sessionFile: args.sessionFile,
            provider: args.provider,
            model: args.model,
            thinking: args.thinking,
        },
    });
    await session.init();
    const sessionCatalogProvider = await createSessionCatalogProvider({
        client,
        session,
        stateRoot,
        bridgeMod,
        SessionManager: pi.SessionManager,
    });
    const customSlashCommands = [
        {
            name: 'status',
            description: 'Show status for the current session',
            run: async ({ appendText }) => {
                const chatKey = safeString(session.currentState && session.currentState.bridgeChatKey).trim();
                if (!chatKey) {
                    appendText(formatCurrentSessionStatus(session.currentState));
                    return;
                }
                const result = await client.runControlCommand('/status', chatKey);
                const notices = Array.isArray(result && result.notices) ? result.notices : [];
                for (const notice of notices.map((item) => safeString(item)).filter(Boolean))
                    appendText(notice);
            },
        },
        {
            name: 'restart',
            description: 'Restart the Rin daemon',
            run: async ({ showStatus }) => {
                await client.runControlCommand('/restart', safeString(session.currentState && session.currentState.bridgeChatKey).trim());
                showStatus('Daemon restart requested');
            },
        },
    ];
    const mode = new InteractiveMode(session, {
        sessionCatalogProvider,
        customSlashCommands,
    });
    try {
        bridgeMod.ensureCtrlJNewLine?.(mode.keybindings);
    }
    catch { }
    try {
        await mode.run();
    }
    finally {
        try {
            session.dispose();
        }
        catch { }
    }
}
export default runRinDaemonTui;
//# sourceMappingURL=rin-daemon-mode.js.map