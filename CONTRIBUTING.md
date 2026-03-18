# Contributing

Thanks for taking an interest in `rin`.

## Project goals

Rin keeps the public repository focused on reusable runtime code.

When contributing, optimize for:

- portability over local convenience
- clear public/private boundaries
- smaller, reusable abstractions instead of one-off features
- reproducible install, build, and update flows
- keeping behavior, docs, and tests in sync

## Before you open a change

- Read [README.md](README.md) first.
- Keep private runtime state, personal IDs, secrets, and generated local artifacts out of git.
- Prefer one focused change over a mixed cleanup bundle.
- If a behavior change is user-visible, update the relevant documentation in the same change.

## Development setup

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
npm run check
```

## Code standards

### Portability

- Do not hard-code paths, users, hostnames, tokens, or machine-local assumptions.
- Keep install/update behavior reproducible from a fresh clone.
- Avoid adding features that only work in one private environment unless they are explicitly modeled as optional local runtime state.

### Scope control

- Prefer trimming or merging existing code over adding parallel paths.
- Do not keep dead compatibility layers unless a real migration path still needs them.
- Keep the public CLI small and user-facing. Internal runtime capabilities should stay internal unless they are intentionally part of the supported surface.

### Documentation

- README content should stay accurate for a fresh public checkout.
- If you change setup, runtime layout, command behavior, or tracked/local boundaries, update docs in the same PR.
- Keep user-facing docs concrete and easy to verify.

### Testing

- Every bug fix or behavior change should add or update an automated check when practical.
- Run `npm run check` before opening a PR.
- New tests should avoid private credentials and should run in a clean CI environment.

## Pull requests

Please include:

- what changed
- why it changed
- any runtime or CLI behavior changes
- any follow-up work that was intentionally left out

If your change touches install/update flows, bridge behavior, scheduling, or memory behavior, call that out explicitly in the PR description.

## Security and privacy

Never commit:

- secrets, API keys, tokens, or private keys
- private chat logs or personal runtime state
- local overlays or machine-specific configuration unless they are deliberate public examples

Runtime state under `~/.rin` should be treated as local unless a file is explicitly designed as a public stock asset.
