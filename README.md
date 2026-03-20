# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**One runtime for your agent. Across terminal, chat, memory, and time.**

**Rin** is a local-first runtime for chat-connected agents. It is designed around the user rather than the current working directory, so the agent can keep context, memory, tools, schedules, and delivery surfaces together and keep working across sessions.

Rin treats the agent as something you live with, not something you re-create for each repo, shell, or editor tab.

## Why Rin?

- **User-scoped, not cwd-scoped.** Rin follows the person, not whichever repository happens to be open.
- **Layered memory.** Memory is built into the runtime instead of being reduced to a single transient chat log.
- **TUI + Koishi.** Work locally in the terminal and connect the same runtime to chat platforms.
- **Self-bootstrapping.** Rin can inspect, use, and refine the runtime that it already lives in.
- **Timers and inspections.** Background routines and inspection jobs are first-class capabilities.
- **All in agent.** The public CLI stays small while richer behavior is exposed through the agent runtime itself, so the system is usable out of the box and configurable by the agent.

## A short manifesto

Most agent tools begin from the surface: a shell command, an editor pane, a working directory.

Rin begins from continuity.

The agent should keep its own memory, its own routines, its own interfaces, and its own room to grow.

Not a throwaway helper for one task.
A runtime you can keep.

## Architecture at a glance

```text
User
 ├─ terminal ──> Local TUI ────┐
 └─ chat ──────> Koishi bridge │
                               ├──> Rin agent runtime
                               │      ├─ memory
                               │      ├─ skills
                               │      ├─ models
                               │      ├─ schedules
                               │      └─ inspections
                               │
                               └──> persistent runtime state (~/.rin)
```

## Get the feel in 3 steps

**1. Install**

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

**2. Launch**

```bash
rin
```

**3. Let the runtime grow with you**

Use Rin locally in the TUI, connect it to chat, and keep the same agent runtime instead of resetting per repository.

## Quick Start

### Requirements

- Linux-compatible environment with user-level `systemd`
- Node.js >= 22
- `npm`, `git`, and `mktemp`

### Quick Install

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

### Launch Rin

```bash
rin
```

## Typical use cases

| | |
| :--- | :--- |
| **Personal terminal agent**<br>Keeps working across repositories instead of starting from zero in each one. | **Chat-connected assistant**<br>Receives, processes, and delivers work through bridged messaging platforms. |
| **Self-maintaining runtime**<br>Inspects its own docs, skills, memory, and routines, then keeps iterating on them. | **Background automation companion**<br>Handles recurring routines, periodic checks, and long-lived agent workflows. |

## Compared with other agent products

| Question | Rin | Terminal Coding Agents | IDE-Centric Agents |
| :--- | :--- | :--- | :--- |
| **What does the agent belong to?** | The user | The current shell or repo | The current editor workspace |
| **Where do you meet it?** | TUI and chat bridges | CLI command runs | Editor panels and extensions |
| **What happens when you close the surface?** | The runtime keeps its own continuity | The task usually ends with the process | The experience stays tied to the editor |
| **How much of the system lives inside the agent?** | Memory, routines, inspections, configuration | Mostly task execution | Mostly editor assistance |
| **What is the center of gravity?** | A continuous personal agent runtime | Direct terminal work | In-editor help |

*Examples of related categories include terminal agents like Codex CLI, Claude Code, or Gemini CLI, and IDE-centric tools like Cursor, Windsurf, or Cline.*

## Public Command Surface

Rin keeps the public CLI intentionally small:

- `rin`: Launches the interactive local TUI.
- `rin restart`: Restarts the background Rin daemon service.
- `rin update`: Reinstalls or updates Rin from the configured source repository and ref.
- `rin uninstall --keep-state --yes`: Removes the installed app and launcher but keeps data in `~/.rin`.
- `rin uninstall --purge --yes`: Removes the app and the full `~/.rin` runtime.

## Included Capabilities

- **Local TUI** for direct interactive agent sessions.
- **Koishi-backed chat connectivity** for bridged delivery.
- **Memory built into the runtime** instead of a single disposable session log.
- **Scheduled routines and inspections** as native capabilities.
- **Agent-driven configuration** through runtime docs, skills, and internal tools.
- **Out-of-the-box runtime** with a minimal public command surface.

## Documentation

- [Runtime reference](install/home/docs/rin/README.md)
- [TUI guide](install/home/docs/rin/docs/tui.md)
- [Models and providers](install/home/docs/rin/docs/models.md)
- [Skills](install/home/docs/rin/docs/skills.md)
- [Extensions](install/home/docs/rin/docs/extensions.md)
- [SDK](install/home/docs/rin/docs/sdk.md)
- [Examples](install/home/docs/rin/examples/README.md)
- [Development notes](install/home/docs/rin/docs/development.md)

## Development

To verify local changes:

```bash
npm run check
```

For contribution details, see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_STYLE.md](CODE_STYLE.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
