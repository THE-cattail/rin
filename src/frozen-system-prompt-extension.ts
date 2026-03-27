// @ts-nocheck

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

const FROZEN_SYSTEM_PROMPT_ENTRY_TYPE = 'rin_frozen_system_prompt'
const FROZEN_REQUEST_SURFACE_ENTRY_TYPE = 'rin_frozen_request_surface'
const FROZEN_REQUEST_SURFACE_KEYS = new Set([
  'instructions',
  'tools',
])

function cloneJson(value: any) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function frozenSurfaceModelId(payload: any): string {
  return safeString(payload && payload.model).trim()
}

function isWhitelistedFrozenRequestSurfaceKey(key: string): boolean {
  const normalized = safeString(key).trim()
  if (!normalized) return false
  return FROZEN_REQUEST_SURFACE_KEYS.has(normalized)
}

function latestFrozenPromptEntry(sessionManager: any): any {
  const entries = sessionManager && typeof sessionManager.getBranch === 'function'
    ? sessionManager.getBranch()
    : sessionManager && typeof sessionManager.getEntries === 'function'
      ? sessionManager.getEntries()
      : []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry || entry.type !== 'custom' || safeString(entry.customType).trim() !== FROZEN_SYSTEM_PROMPT_ENTRY_TYPE) continue
    const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : null
    const prompt = safeString(data && data.systemPrompt)
    if (!prompt.trim()) continue
    return {
      systemPrompt: prompt,
      source: safeString(data && data.source).trim(),
      savedAt: safeString(data && data.savedAt).trim(),
    }
  }
  return null
}

function latestFrozenRequestSurfaceEntry(sessionManager: any, modelId = ''): any {
  const entries = sessionManager && typeof sessionManager.getBranch === 'function'
    ? sessionManager.getBranch()
    : sessionManager && typeof sessionManager.getEntries === 'function'
      ? sessionManager.getEntries()
      : []
  const targetModel = safeString(modelId).trim()
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!entry || entry.type !== 'custom' || safeString(entry.customType).trim() !== FROZEN_REQUEST_SURFACE_ENTRY_TYPE) continue
    const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : null
    if (!data || !data.surface || typeof data.surface !== 'object') continue
    const entryModel = safeString(data.model).trim()
    if (targetModel && entryModel && entryModel !== targetModel) continue
    return {
      model: entryModel,
      surface: cloneJson(data.surface),
      savedAt: safeString(data.savedAt).trim(),
    }
  }
  return null
}

function extractFrozenRequestSurface(payload: any, forcedInstructions = '') {
  if (!payload || typeof payload !== 'object') return null
  const surface: Record<string, any> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!isWhitelistedFrozenRequestSurfaceKey(key)) continue
    surface[key] = cloneJson(value)
  }
  const normalizedInstructions = safeString(forcedInstructions)
  if (normalizedInstructions.trim()) surface.instructions = normalizedInstructions
  return surface
}

function applyFrozenRequestSurface(payload: any, surface: any) {
  if (!payload || typeof payload !== 'object' || !surface || typeof surface !== 'object') return payload
  const next = cloneJson(payload)
  for (const key of Object.keys(next)) {
    if (!isWhitelistedFrozenRequestSurfaceKey(key)) continue
    if (!Object.prototype.hasOwnProperty.call(surface, key)) delete next[key]
  }
  for (const [key, value] of Object.entries(surface)) {
    if (!isWhitelistedFrozenRequestSurfaceKey(key)) continue
    next[key] = cloneJson(value)
  }
  return next
}

function createFrozenSystemPromptExtension() {
  return function frozenSystemPromptExtension(pi: any) {
    let activeFrozenPrompt = ''
    let activeFrozenRequestSurface: any = null

    pi.on('before_agent_start', async (event: any, ctx: any) => {
      const currentPrompt = safeString(event && event.systemPrompt)
      if (!currentPrompt.trim()) return
      const existing = latestFrozenPromptEntry(ctx && ctx.sessionManager)
      if (existing && safeString(existing.systemPrompt).trim()) {
        activeFrozenPrompt = existing.systemPrompt
        activeFrozenRequestSurface = latestFrozenRequestSurfaceEntry(ctx && ctx.sessionManager)
        return {
          systemPrompt: existing.systemPrompt,
        }
      }
      activeFrozenPrompt = currentPrompt
      activeFrozenRequestSurface = null
      pi.appendEntry(FROZEN_SYSTEM_PROMPT_ENTRY_TYPE, {
        systemPrompt: currentPrompt,
        source: 'before_agent_start',
        savedAt: new Date().toISOString(),
      })
      return {
        systemPrompt: currentPrompt,
      }
    })

    pi.on('before_provider_request', async (event: any, ctx: any) => {
      if (!activeFrozenPrompt) return
      const payload = event && event.payload
      if (!payload || typeof payload !== 'object') return
      const modelId = frozenSurfaceModelId(payload)
      const persisted = latestFrozenRequestSurfaceEntry(ctx && ctx.sessionManager, modelId)
      const currentFrozen = activeFrozenRequestSurface && (
        !safeString(activeFrozenRequestSurface.model).trim()
          || !modelId
          || safeString(activeFrozenRequestSurface.model).trim() === modelId
      )
        ? activeFrozenRequestSurface
        : persisted
      if (currentFrozen && currentFrozen.surface && typeof currentFrozen.surface === 'object') {
        activeFrozenRequestSurface = currentFrozen
        return applyFrozenRequestSurface(payload, currentFrozen.surface)
      }
      const surface = extractFrozenRequestSurface(payload, activeFrozenPrompt)
      if (!surface) return
      const frozen = {
        model: modelId,
        surface,
        savedAt: new Date().toISOString(),
      }
      activeFrozenRequestSurface = frozen
      pi.appendEntry(FROZEN_REQUEST_SURFACE_ENTRY_TYPE, frozen)
      return applyFrozenRequestSurface(payload, surface)
    })

    pi.on('agent_end', async () => {
      activeFrozenPrompt = ''
      activeFrozenRequestSurface = null
    })
  }
}

export {
  FROZEN_SYSTEM_PROMPT_ENTRY_TYPE,
  FROZEN_REQUEST_SURFACE_ENTRY_TYPE,
  FROZEN_REQUEST_SURFACE_KEYS,
  createFrozenSystemPromptExtension,
}
