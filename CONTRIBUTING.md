# Contributing

Thanks for contributing to `rin`.

## Before you start

- Read [README.md](README.md) for the current public product surface.
- Read [CODE_STYLE.md](CODE_STYLE.md) for the repository engineering rules.
- Keep each pull request focused on one user-visible outcome or one cleanup pass.
- Never commit private runtime state, secrets, or machine-local configuration.

## Development

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run check
```

`npm run check` builds the project, runs unit tests, and runs repository portability/doc checks.

## What good changes look like

### Keep it portable

- Do not hard-code users, hostnames, tokens, or workstation-only paths.
- Keep install, build, and update flows reproducible from a fresh clone.
- Prefer public-facing defaults and documentation that work outside one private setup.

### Keep it small

- Prefer simplifying existing code over adding parallel paths.
- Extract reusable helpers when large files start duplicating logic.
- Remove stale compatibility code instead of extending it by default.
- Keep the public CLI limited to supported user-facing commands.

### Keep docs and tests in sync

- Update README and contributor docs when setup or behavior changes.
- Add or extend automated tests when changing portability-sensitive, prompt/session, or shared runtime logic.
- Leave the tree in a state where `npm run check` passes.

## Pull requests

Include:

- what changed
- why it changed
- any user-visible behavior difference
- any follow-up work intentionally left out

## Security and privacy

Never commit:

- secrets, API keys, tokens, or private keys
- private chat logs or local runtime state
- machine-specific overlays unless they are intentional public examples
