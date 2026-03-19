# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Rin** is a local-first runtime designed for chat-connected agent workflows. It provides a stable, daemon-backed environment where agents can manage schedules, automation, and long-running bridge deliveries without being tied to a single terminal session or editor window.

## Why Rin?

Rin occupies a unique position in the agent ecosystem. While many tools focus on immediate code generation or editor integration, Rin focuses on the **runtime root**—the persistent background layer that enables agents to function as continuous assistants.

### Compared with other agent products

| Feature | Rin | Terminal Coding Agents | IDE-Centric Agents |
| :--- | :--- | :--- | :--- |
| **Primary Interface** | Local Runtime & TUI | CLI Commands | Editor / Extension |
| **Execution Model** | Persistent Daemon | Task-specific Process | Editor-bound Plugin |
| **State Management** | Centralized (`~/.rin`) | Session-based | Editor Workspace |
| **Tool Surface** | Internal Runtime API | CLI Subcommands | Editor Commands |
| **Core Focus** | Connected Workflows | Direct File Editing | In-editor Assistance |

*Examples of related categories include terminal agents like Codex CLI, Claude Code, or Gemini CLI, and IDE-centric tools like Cursor, Windsurf, or Cline.*

## Key Characteristics

- **Local-First Root:** All runtime state, memory, and configuration live in `~/.rin`.
- **Daemon-Backed:** A background service handles bridges, schedules, and automation flows, ensuring tasks continue even when the UI is closed.
- **Minimal CLI Surface:** The public CLI is kept intentionally small. Complex agent capabilities (web search, memory, inspection) are exposed through the runtime tool surface rather than expanding the CLI complexity.
- **User-Level Management:** Deeply integrates with `systemd` for managed service lifecycles (restart, update, logs).

## Installation

### Quick Install
Requires a Linux-compatible environment with `systemd`, Node.js >= 22, `npm`, `git`, and `mktemp`.

```bash
# Install latest main
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# Install specific ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### Source Install
```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## Command Surface

Rin maintains a lean CLI to stay out of your way:

- `rin`: Launches the interactive local TUI.
- `rin restart`: Restarts the background Rin daemon service.
- `rin update`: Reinstalls/updates Rin from the configured source repository and ref.
- `rin uninstall --keep-state --yes`: Removes the application and launcher but preserves your data in `~/.rin`.
- `rin uninstall --purge --yes`: Completely removes the application and the `~/.rin` directory.

## Runtime Layout

The runtime state is strictly contained within your home directory:

- `~/.rin/`: Primary state root.
- `~/.rin/data/web-search/config.json`: Web search configuration.
- `~/.rin/bin/`: Launcher and binaries.

## Web Search

Rin features a flexible web search runtime capability. It can manage a local **SearxNG** instance via Docker (optional sidecar), connect to an existing SearxNG instance, or use **Serper** credentials. Configuration is managed at `~/.rin/data/web-search/config.json`.

## Development

### Requirements
- Node.js >= 22
- Linux with user-level `systemd`
- Docker (optional, for managed SearxNG sidecar)

### Verification
To verify your local changes:
```bash
npm run check
```

For more details on contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_STYLE.md](CODE_STYLE.md). Internal documentation can be found in `install/home/docs/rin/README.md`.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
