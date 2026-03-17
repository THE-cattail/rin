# rin

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

`rin` is a local-first runtime for chat-connected agent workflows.

Public source keeps only:

- the TypeScript application source
- the GitHub/bootstrap installer
- install-time stock assets under `install/home`

Runtime state lives only under `~/.rin`. Runtime-created directories such as `kb/` and `routines/` appear only when features actually use them.

## Install from GitHub

Current user install:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

Install a specific ref:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  RIN_REF=main sh
```

Advanced installs can still pass target-user flags:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  sh -s -- --user existing-user --yes
```

The bootstrap clones the repo to a temporary directory, builds the root TypeScript package, and installs Rin into the target user's `~/.rin`.

## Update an existing install

```bash
rin update
```

Override the source when needed:

```bash
rin update --repo https://github.com/THE-cattail/rin.git --ref main
```

## Source checkout workflow

If you are developing Rin from source:

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm install
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## Runtime location

Rin does not treat the source checkout as a runtime workspace.

Runtime state lives only under `~/.rin`, including:

- `~/.rin/AGENTS.md`
- `~/.rin/settings.json`
- `~/.rin/data/`
- `~/.rin/docs/`
- `~/.rin/locale/` (optional user locale overrides)
- `~/.rin/skills/`

The installed runtime reads `AGENTS.md` from `~/.rin`, not from the shell's current directory.

## Single entrypoint

The only user-facing entrypoint in PATH is `rin`.

Installed `rin` exposes only the user-facing runtime commands:

- `rin` (default interactive mode)
- `rin restart`
- `rin update`
- `rin uninstall`

Daily `rin` usage uses Pi's native terminal UI.

Install is handled by `install.sh`.

Operational features such as brain, koishi, daemon control, and schedule are internal runtime capabilities, not public shell subcommands.

## Repository layout

```text
src/
  ...              TypeScript source
install/
  home/            stock files seeded into ~/.rin on install
```

## Installed app layout

```text
~/.rin/app/current/
  dist/
  node_modules/
  install/
  package.json
  package-lock.json
```

`~/.local/bin/rin` points to `~/.rin/app/current/dist/index.js`.

## Installed state layout

```text
~/.rin/
  AGENTS.md
  app/current/
  data/
  docs/
  locale/          optional user locale overrides
  settings.json
  skills/
  ...              generated on demand (for example kb/, routines/)
```

## What is tracked vs local-only

Tracked in git:

- source code under `src/`
- install-time stock assets under `install/home/`
- the GitHub bootstrap installer (`install.sh`)

Kept local under `~/.rin`:

- user-editable prompt docs such as `AGENTS.md`
- bridge/timer/inspect runtime state
- trust mappings and private config
- KB notes, memory stores, and event logs
- local routines, skills, and their helper scripts
- installed docs and runtime bundle
 docs and runtime bundle
