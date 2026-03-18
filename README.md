# rin

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

`rin` is a local-first runtime for chat-connected agent workflows.

Languages: [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

## What Rin is

Rin keeps the public repository focused on reusable runtime code and install assets, while keeping user data and private runtime state in `~/.rin`.

It is designed for people who want:

- a single local runtime entrypoint (`rin`)
- chat-connected automation and background workflows
- a clear public/private boundary
- source checkouts that stay separate from live runtime state

## Current public scope

This repository intentionally tracks only the reusable pieces:

- TypeScript application source under `src/`
- the GitHub/bootstrap installer (`install.sh`)
- install-time stock documentation under `install/home/`
- contributor guidance and verification files

Runtime-created state stays local under `~/.rin`.

## Requirements

- Node.js 22+
- npm
- git
- Linux or another environment that can run the current Node.js runtime and installer flow

## Install

Install for the current user:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

Install a specific ref:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  RIN_REF=main sh
```

Install for another existing user:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  sh -s -- --user existing-user --yes
```

The installer clones the requested ref to a temporary directory, installs dependencies, builds the runtime, and installs it into the target user's `~/.rin`.

## Update

```bash
rin update
```

Override the source when needed:

```bash
rin update --repo https://github.com/THE-cattail/rin.git --ref main
```

## Uninstall

Keep local state but remove the installed app bundle:

```bash
rin uninstall --keep-state --yes
```

Remove Rin completely:

```bash
rin uninstall --purge --yes
```

## Develop from source

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

Verification:

```bash
npm run check
```

## Runtime layout

Rin does not use the source checkout as the live workspace.

Installed runtime state lives under `~/.rin`, including:

- `~/.rin/AGENTS.md`
- `~/.rin/settings.json`
- `~/.rin/auth.json`
- `~/.rin/data/`
- `~/.rin/docs/`
- `~/.rin/skills/`
- `~/.rin/locale/` for optional local overrides
- on-demand directories such as `kb/` and `routines/`

The installed launcher is:

```text
~/.local/bin/rin
```

and points to:

```text
~/.rin/app/current/dist/index.js
```

## User-facing command surface

Rin intentionally keeps a small public CLI surface:

- `rin` — interactive mode
- `rin restart` — restart the daemon service
- `rin update` — reinstall from source
- `rin uninstall` — remove the installed runtime

Operational internals such as memory, bridge delivery, and scheduling are runtime capabilities, not public shell subcommands.

## Repository layout

```text
src/                 TypeScript runtime source
install.sh           Bootstrap installer
install/home/        Stock files seeded into ~/.rin on install
.github/workflows/   CI verification
```

## Runtime privacy boundary

Tracked in git:

- source code
- install-time stock docs and assets
- contributor and CI files

Kept local under `~/.rin`:

- user prompt/context files
- auth and model credentials
- private bridge and schedule state
- memory stores, event logs, and local knowledge bases
- local routines, local skills, and local overrides

## Engineering expectations

This repository aims to stay portable and reviewable:

- avoid machine-specific assumptions
- prefer reproducible install/update paths
- keep code and docs aligned in the same change
- add or update automated checks when behavior changes
- favor smaller, reusable surfaces over local-only convenience features

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules.

## License

[MIT](LICENSE)
