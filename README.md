# rin

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

`rin` is a local-first runtime for chat-connected agent workflows.

Languages: [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

## What you get

- `rin` for interactive use
- `rin restart` to restart the daemon
- `rin update` to reinstall from a repository ref
- `rin uninstall` to remove the installed runtime
- runtime state stored under `~/.rin`

Rin runs from the installed runtime in `~/.rin`, not from the source checkout.

## Requirements

- Node.js 22+
- npm
- git
- a Linux-like environment supported by the current installer flow

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

## Daily commands

Start interactive mode:

```bash
rin
```

Restart the daemon:

```bash
rin restart
```

Update the installed runtime:

```bash
rin update
```

Update from a specific repository or ref:

```bash
rin update --repo https://github.com/THE-cattail/rin.git --ref main
```

Remove the installed app but keep `~/.rin`:

```bash
rin uninstall --keep-state --yes
```

Remove everything:

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

Run the verification suite:

```bash
npm run check
```

## Repository layout

```text
src/                 runtime source
install.sh           bootstrap installer
install/home/        stock files copied into ~/.rin on install
test/                automated tests
```

## Runtime layout

```text
~/.rin/
  AGENTS.md
  app/current/
  auth.json
  data/
  docs/
  locale/
  settings.json
  skills/
```

Installed launcher:

```text
~/.local/bin/rin
```

## License

[MIT](LICENSE)
