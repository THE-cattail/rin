# Contributing

Thanks for taking an interest in `rin`.

## Before opening a change

- Read [README.md](README.md) first to understand the public/private split in this repo.
- Keep private runtime state, personal IDs, local overlays, and generated artifacts out of git.
- Prefer small, reviewable changes over large refactors that mix unrelated cleanup.

## Development style

- Keep tracked files neutral and reusable.
- Put installation-specific behavior in local overlays or ignored files instead of hard-coding it into the public baseline.
- When changing operator workflows, update the relevant docs in the same change when practical.

## Pull requests

- Explain what changed and why.
- Call out any behavior changes in CLI commands, schedule handling, memory flows, or tracked/ignored boundaries.
- If your change affects public docs, include the doc update in the same PR.

## Security and privacy

- Never commit secrets, tokens, private keys, personal IDs, or private chat logs.
- Treat `data/rin/memory/`, the legacy local memory store, `memory/vault/`, runtime chat logs, and local overlays as private unless a file is explicitly designed as a public example.
