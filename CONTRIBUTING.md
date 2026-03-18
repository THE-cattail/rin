# Contributing

Thanks for contributing to `rin`.

## Before you start

- Read [README.md](README.md).
- Keep each change focused.
- Update docs in the same PR when user-facing behavior changes.
- Do not commit private runtime state, secrets, or machine-local configuration.

## Development

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
npm run check
```

## Project rules

### Keep it portable

- Do not hard-code users, hostnames, tokens, or local-only paths.
- Keep install, build, and update flows reproducible from a fresh clone.
- Avoid features that only work in one private environment unless they are clearly local runtime state.

### Keep it small

- Prefer simplifying existing code over adding parallel paths.
- Remove dead compatibility code instead of extending it.
- Keep the public CLI limited to supported user-facing commands.

### Keep docs and tests in sync

- Update README and related docs when setup or behavior changes.
- Add or update automated tests when practical.
- Run `npm run check` before opening a PR.

## Pull requests

Include:

- what changed
- why it changed
- any user-visible command or runtime behavior change
- any follow-up work intentionally left out

## Security and privacy

Never commit:

- secrets, API keys, tokens, or private keys
- private chat logs or local runtime state
- machine-specific local overlays unless they are intentional public examples
