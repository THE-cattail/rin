# InteractiveMode migration plan

This note maps Rin's current daemon-backed TUI shell onto upstream `InteractiveMode` so the next refactor can delete local behavior instead of layering more patches.

Reference source:
- `third_party/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`

## Current situation

Rin already reuses many upstream components, themes, selectors, and message renderers.

What is still custom is the outer mode shell in `src/tui.ts`:
- startup sequence
- event/state transitions
- pending/status/chat movement rules
- extension-ui orchestration
- daemon RPC integration

That is the part still drifting from upstream.

## Upstream areas to mirror next

### 1. Startup and initialization

Upstream anchors:
- `init()`
- `run()`
- `checkForNewVersion()`
- `checkForPackageUpdates()`
- `checkTmuxKeyboardSetup()`
- `getChangelogForDisplay()`
- `showLoadedResources()`
- `initExtensions()`

Current Rin equivalents:
- `main()`
- `refreshState()`
- `rebuildHeader()`
- ad-hoc notices via `appendSystemNotice()`

Gap:
- Rin still treats startup as a thin local bootstrap instead of an upstream-style initialization pipeline.
- changelog / startup notices / migrated-provider warnings / model-fallback messaging are still not structured the same way.

Recommended next step:
- split `main()` into explicit startup phases that mirror upstream `init()` and `run()`.
- move startup notices into a single ordered pipeline so later upstream syncing is mechanical.

### 2. Event handling and state transitions

Upstream anchors:
- `subscribeToAgent()`
- `handleEvent()`
- `showStatus()`
- `addMessageToChat()`
- `rebuildChatFromMessages()`
- `updatePendingMessagesDisplay()`

Current Rin equivalents:
- `client.onEvent(...)` flow inside `main()`
- `renderMessageHistory()`
- `renderPendingMessages()`
- `renderStatusContainer()`
- `setStatus()` / `setStatusLoader()`

Gap:
- Rin still keeps a parallel event router and parallel rendering policy.
- pending queue, status line, streaming message handling, and tool/bash transitions can still diverge from upstream timing.

Recommended next step:
- introduce one Rin-local event adapter layer that converts daemon RPC events into upstream-shaped session events.
- after that, move rendering decisions into upstream-style handlers instead of custom per-event branches.

### 3. Input, editor, and queue semantics

Upstream anchors:
- `setupKeyHandlers()`
- `setupEditorSubmitHandler()`
- `handleFollowUp()`
- `handleDequeue()`
- `cycleThinkingLevel()`
- `cycleModel()`
- `handleCtrlC()` / `handleCtrlD()` / `shutdown()`

Current Rin equivalents:
- local key handlers registered in `main()`
- `submitUserText()`
- `openModelSelector()`
- local escape / ctrl-c / ctrl-d handling

Gap:
- core shortcuts are much closer now, but the editor lifecycle is still controlled by Rin's shell rather than an upstream-shaped mode object.

Recommended next step:
- carve out an `interactive-controller` layer in Rin whose public methods deliberately match upstream method boundaries.
- keep daemon-specific transport inside that controller, not spread across the host file.

### 4. Selector and dialog surfaces

Upstream anchors:
- `showSettingsSelector()`
- `showSessionSelector()`
- `showTreeSelector()`
- `showModelSelector()`
- `showModelsSelector()`
- `showOAuthSelector()`
- `showLoginDialog()`
- extension selector/input/editor helpers

Current Rin equivalents:
- `openSettingsSelector()`
- `openSessionSelector()`
- `openTreeSelector()`
- `openForkSelector()`
- `openModelSelector()`
- `showChoiceDialog()`
- `showEditorDialog()`
- `handleExtensionUi()`

Gap:
- session/tree/model selectors are partly aligned.
- oauth/login/config-scoped selectors are still missing or flatter than upstream.

Recommended next step:
- port oauth/login/config selector flows first, because they are self-contained and reduce one more custom dialog path.

### 5. Widget / footer / status composition

Upstream anchors:
- `setExtensionStatus()`
- `setExtensionWidget()`
- `renderWidgets()`
- `setExtensionFooter()`
- `setExtensionHeader()`
- footer/status helpers and bordered loaders

Current Rin equivalents:
- `renderWidgets()`
- local footer data provider glue
- `renderStatusContainer()`
- `setStatusLoader()`

Gap:
- Rin still approximates some layout/loader behavior instead of following upstream composition rules exactly.

Recommended next step:
- compare Rin status/pending/widget layout against upstream `BorderedLoader`, `DynamicBorder`, and header/footer composition.
- remove local approximations where upstream pieces can be reused directly.

## Refactor order

1. Keep vendored loading as-is.
2. Split `src/tui.ts` into:
   - transport/bootstrap
   - upstream-shaped controller
   - pure render helpers
3. Add a daemon-event adapter that targets upstream handler boundaries.
4. Port startup pipeline to upstream order.
5. Port oauth/login/config selector flows.
6. Revisit whether the remaining shell can become a thin wrapper around a forked upstream `InteractiveMode` class.

## Success criteria

The migration is on track when:
- `src/tui.ts` stops being the main behavior dump.
- more behavior is expressed in method boundaries that match upstream names.
- vendored upstream updates become mostly merge-and-retest work instead of re-implementing interaction details.
