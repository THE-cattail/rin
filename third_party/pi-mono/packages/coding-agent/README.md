# rin

![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**One little home for your agent.**

**Rin** is a local-first companion for people who want an agent that stays with them. Instead of starting over every time you switch projects, windows, or devices, Rin helps the same agent keep its memory, habits, and ways of talking to you.

A small assistant should not feel disposable.
Rin is built so it can stay, learn your rhythm, and keep things in order.

## Why Rin?

- **It follows you, not just one folder.** Your agent is centered around the person using it.
- **It remembers.** Not as a pile of temporary chat scraps, but as something the assistant can keep carrying forward.
- **It can meet you in more than one place.** Talk in the terminal, or let it speak through your chat apps too.
- **It can tidy itself.** Rin can read its own notes, tools, and little house rules, then keep improving how it works.
- **It can keep watch.** Repeating routines and quiet check-ins are part of the system, not an afterthought.
- **It feels ready out of the box.** The command line stays small, while most of the real behavior lives inside the assistant itself.

## A short manifesto

Many agent tools begin with a surface.
A command. A panel. A project.

Rin begins with continuity.

The assistant should be able to stay.
To remember.
To keep its place.
To grow with the person who uses it.

Not a one-off trick.
A companion you can keep around.

## How Rin fits together

```text
You
 ├─ talk in the terminal ─┐
 └─ talk in chat apps ────┤
                          ├──> Rin
                          │      ├─ remembers things
                          │      ├─ uses tools
                          │      ├─ keeps notes and rules
                          │      ├─ handles repeating jobs
                          │      └─ checks in when needed
                          │
                          └──> keeps going across sessions
```

## Get the feel in 3 steps

**1. Install**

```bash
# Interactive installer (runtime root, provider, and chat bridge choices included)
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# Custom runtime root
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# Dry run the installer without writing anything
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run
```

**2. Open it**

```bash
rin
```

**3. Keep the same assistant with you**

Use Rin in the terminal, connect it to chat if you like, and let the same assistant keep growing with you instead of resetting for every project.

## Quick Start

### Requirements

- Linux, macOS, or Windows (use Git Bash / a POSIX shell on Windows for `install.sh`)
- Background daemon backend auto-selects from `systemd`, `launchd`, or a detached process
- Node.js >= 22
- `npm`, `git`, and `mktemp`

### Quick Install

```bash
# Install latest main with the interactive setup wizard
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# Install into a custom runtime root
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# Preview the install without changing your environment
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run

# Install specific ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### Source Install

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
./install.sh --local
```

### Update from a Local Checkout

```bash
cd /path/to/rin
rin update --local

# or update an installed runtime from another checkout
rin update --local --path /path/to/rin
```

### Launch Rin

```bash
rin
```

## Use Cases

| | |
| :--- | :--- |
| **A personal helper in the terminal**<br>It keeps going across projects instead of acting like a stranger every time. | **A helper that can also speak in chat**<br>Useful when you want the same assistant to receive, handle, and send things for you. |
| **A self-tidying assistant home**<br>It can look through its own notes, habits, and tools, then keep refining itself. | **A quiet background helper**<br>Good for repeating chores, gentle reminders, and long-running workflows. |

## Compared with other agent products

| Question | Rin | Terminal Coding Agents | IDE-Centric Agents |
| :--- | :--- | :--- | :--- |
| **Who does the assistant belong to?** | The person using it | The current shell or repo | The current editor workspace |
| **Where do you meet it?** | Terminal and chat | Command runs | Editor panels and extensions |
| **What happens when you close the surface?** | The assistant keeps its own continuity | The task often ends with the process | The experience stays tied to the editor |
| **What lives inside the assistant?** | Memory, routines, checks, and more | Mostly task execution | Mostly editor help |
| **What is it trying to be?** | A lasting personal assistant home | A tool for direct terminal work | A helper inside the editor |

*Examples of related categories include terminal agents like Codex CLI, Claude Code, or Gemini CLI, and IDE-centric tools like Cursor, Windsurf, or Cline.*

## Public Command Surface

Rin keeps the public command set intentionally small:

- `rin`: Opens the local interactive interface.
- `rin restart`: Restarts the background service.
- `rin update`: Reinstalls or updates Rin from the configured source.
- `rin uninstall --keep-state --yes`: Removes the app but keeps your saved state.
- `rin uninstall --purge --yes`: Removes both the app and its saved state.

## Included Capabilities

- **A local chat-like interface** for talking to your assistant directly.
- **Chat app delivery** so the same assistant can speak outside the terminal.
- **Built-in memory** so it can keep more than the current conversation.
- **Repeating jobs and quiet checks** as part of the system itself.
- **Assistant-led setup** through its own notes, tools, and internal instructions.
- **A small surface, with more of the real work living inside the assistant.**

## Built on Pi

Pi serves as a mature agent runtime, with a robust session model, broad provider and model support, a capable terminal UI, and an SDK / extension surface that is already practical for real agent work.

Rin builds on that foundation in a different direction. Rather than centering a single repo or a one-off coding session, it turns Pi into a local-first persistent runtime for one person and one continuing assistant—carrying memory, chat bridges, schedules, and assistant-owned notes and rules across sessions.

## Documentation

- [Runtime reference](install/home/docs/rin/README.md)
- [Examples (source repo)](examples/pi/README.md)

## Development

To verify local changes:

```bash
npm ci
npm run check
npm run check:container
```

`npm ci` also installs the local Husky hooks in a Git checkout. The `pre-push` hook runs `npm run check:container` automatically before each push, so Docker needs to be available locally.

For contribution details, see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_STYLE.md](CODE_STYLE.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
