# Rin Runtime Reference

Authoritative execution-time reference for Rin local architecture. 
Precedence: This file overrides upstream Pi documentation for Rin-specific behavior. Use Pi docs only for SDK or TUI API technical details.

## 1. Canonical Roots

- **Runtime Root:** defaults to `~/.rin`; may be overridden by `RIN_HOME` or the installer.
- **Docs Root:** `<runtime-root>/docs/rin`
- **Data Root:** `<runtime-root>/data`
- **Source Repo:** Distinct from runtime state (e.g., `~/rin-src`).

Operational Rule: Treat the runtime root as one explicit path. Use `~/.rin` only as the default, not as a hardcoded assumption.

## 2. Runtime Surfaces

- `rin`: Local TUI (`InteractiveMode`).
- `rin restart`: Restart the background daemon service.
- `rin update`: Reinstalls from source and refreshes runtime.
- `rin uninstall`: Interactive uninstallation.
- `rin-daemon.service`: Background bridge and scheduler.

Internal behavior (chat delivery, trust, schedules, memory) is exposed via the agent runtime, not CLI subcommands.

## 3. Session Model

Active Pi contexts:
1. **Local TUI:** Started by `rin`. Local-only; not a daemon client.
2. **Daemon Sessions:** Used for bridge, timers, and inspection.

Execution State:
- Async brain capture runs in-process per session.
- `#RIN_CONTINUE` is the exclusive control token persisted across TUI and daemon contexts.

## 4. Auto-Loaded Content

Rin discovers content exclusively within the configured runtime root.
- **Config:** `AGENTS.md`, `auth.json`, `settings.json`, `models.json`
- **Logic:** `skills/**`
- **Reference:** `docs/rin/**`
- **State:** `data/**`

Settings:
- Use global `<runtime-root>/settings.json`.
- Project-local `.pi/settings.json` is ignored.

## 5. Non-Discovered Content

The following are NOT auto-discovered:
- `AGENTS.md` outside the runtime root.
- Project-local `.pi/` resources (skills, prompts, etc.).
- `~/.agents/skills`.
- Legacy resource chains.

Manual Inspection: If a task targets a directory, manually check for `AGENTS.md` or `.rin/` content as an explicit step.

## 6. Path Semantics

Rin has no ambient project working directory. Runtime root is the configured runtime path.
Tools inherit Pi's `cwd` requirement, pinned to `$HOME`.
- **Relative paths:** Resolve from `$HOME`.
- **TUI sessions:** `<runtime-root>/sessions/default`.
- **Daemon sessions:** `<runtime-root>/data/chats/...`.

Operation:
- Use absolute paths.
- Explicitly `cd` within `bash` calls.
- Do not assume a project-local working directory.

## 7. Tool Surface

Core Tools: `read`, `bash`, `edit`, `write`.
Rin Tools: `rin_brain`, `rin_koishi`, `rin_schedule`, `web_search`.
Web search runtime config lives under `<runtime-root>/data/web-search/config.json`.
Default web search uses the built-in vanilla SearxNG sidecar against Google Web. Users can point SearxNG at another base URL/API key or add their own Serper API in that config file.

Constraints:
- Follow tool schemas for parameters.
- Do not use deprecated names: `rin_memory`, `rin_send`, `rin_identity`.

## 8. Constraints

Naming:
- Identity: `rin`.
- Background service: `daemon`.
- Prohibited terms: `guardian`.
- Pi is an SDK/implementation detail, not the product identity.

Architecture:
- Minimal public CLI surface.
- Minimal runtime prompts.
- Move delivery/protocol logic to code, not prompts, unless inference-critical.
- Avoid legacy aliases or compatibility wrappers.

## 9. Documentation Usage

- **Rin Architecture/Behavior:** Reference this file.
- **Upstream Pi/SDK/TUI:** Reference `docs/` and `examples/`.

Mapping:
- SDK: `docs/sdk.md`
- TUI: `docs/tui.md`
- Extensions: `docs/extensions.md`
- Skills: `docs/skills.md`
- Keybindings: `docs/keybindings.md`
- Models/Providers: `docs/models.md`, `docs/providers.md`, `docs/custom-provider.md`

## 10. Execution Guidance

Internal Edits:
- Runtime/private files: `<runtime-root>`.
- Source changes: Repository checkout.
- Inspect state directly; do not rely on assumptions.
- Verify behavior via resulting state changes.

External Targets:
- Directories are explicit targets, not working-directory context.
- Manually inspect target files.
- Ensure Rin runtime state remains under the configured runtime root.
