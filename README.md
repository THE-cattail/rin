# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Local-first runtime for chat-connected agent workflows.

## Requirements

- Node.js >= 22
- npm, git, mktemp
- Linux-compatible environment

## Installation

Install via `install.sh`. Note: `rin install` is not a public command.

```bash
# Standard install
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# Install a specific ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

The launcher is installed to `~/.local/bin/rin`.

### Source Install

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## Usage

- **Start**: `rin` (starts interactive mode)
- **Restart**: `rin restart` (restarts the background daemon)
- **Update**: `rin update` 
- **Custom Update**: `rin update --repo https://github.com/THE-cattail/rin.git --ref main` 

## Uninstallation

- **Keep data**: `rin uninstall --keep-state --yes` 
- **Full purge**: `rin uninstall --purge --yes` 

## Data Storage

Runtime data and state are stored in `~/.rin`.