# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-2ea44f)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Local-first runtime for chat-connected agent workflows.

## What it is

`rin` keeps the public CLI small and puts the real center of gravity in a local runtime root.

- `rin` starts the local interactive TUI
- a background daemon handles bridge, schedule, and automation flows
- runtime state lives under `~/.rin`
- internal capabilities such as bridge delivery, memory, inspection, schedules, and web search stay behind the runtime/tool surface instead of becoming a long list of public subcommands

## Why it feels different

Rin is not trying to be just another terminal wrapper around a model, and it is not trying to be an IDE shell either.

- **Local-first by default** — state, docs, skills, and runtime data stay under `~/.rin`
- **Daemon-backed workflows** — automation and chat-connected flows are built into the runtime model
- **Small public surface** — the supported CLI stays intentionally narrow: start, restart, update, uninstall
- **Runtime-first design** — agent-facing power is exposed through the runtime itself, not by growing the public CLI every time a new capability appears

## Compared with other agent products

Rin is best understood as a different center of gravity rather than a feature checklist fight.

| Product shape | Typical center | Rin's position |
| --- | --- | --- |
| Terminal coding agents such as Codex CLI, Claude Code, or Gemini CLI | the active terminal session in the current repo | Rin centers a persistent local runtime root plus daemon-backed chat-connected workflows |
| IDE-centric agents such as Cursor, Windsurf, or Cline | the editor window and its extension lifecycle | Rin keeps the workflow in a local runtime with a deliberately small public CLI |

If you want an agent runtime that stays organized around persistent local state and background workflows, Rin is built for that shape.

## Requirements

- Linux-compatible environment
- user-level `systemd` for managed daemon restart/update flows
- Node.js >= 22
- `npm`, `git`, `mktemp`
- Docker optional for the managed local SearxNG sidecar used by web search

## Installation

Install with `install.sh`. `rin install` is intentionally not a public command.

```bash
# Install the main branch
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# Install a specific ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

The launcher is installed to `~/.local/bin/rin`.

### Install from source

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## Quick start

1. Run `rin` to open the local interactive mode.
2. Keep runtime files under `~/.rin`.
3. Use `rin restart` after changing daemon-managed runtime or bridge settings.
4. Use `rin update` to reinstall from the configured source and refresh the runtime.

## Public command surface

| Command | Purpose |
| --- | --- |
| `rin` | Start the local interactive TUI |
| `rin restart` | Restart the user-level Rin daemon service |
| `rin update` | Reinstall from the configured source repository/ref |
| `rin uninstall --keep-state --yes` | Remove the app and launcher but keep `~/.rin` |
| `rin uninstall --purge --yes` | Remove both the app and `~/.rin` |

## Runtime layout

- `~/.rin` — runtime root
- `~/.rin/data` — runtime data and daemon state
- `~/.rin/docs/rin` — local runtime reference copied into the installation

## Web search

Web search reads its runtime config from `~/.rin/data/web-search/config.json`.

By default, Rin can manage a local SearxNG sidecar. You can also point that config at your own SearxNG instance or provide Serper credentials.

## Development

```bash
npm ci
npm run check
```

`npm run check` builds the project, runs unit tests, runs smoke tests for install/update/uninstall flows, and checks repository portability/doc consistency.

See also:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_STYLE.md](CODE_STYLE.md)
- [Runtime reference](install/home/docs/rin/README.md)

## Uninstall

```bash
rin uninstall --keep-state --yes
rin uninstall --purge --yes
```

## License

MIT
