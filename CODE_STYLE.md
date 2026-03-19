# Code Style

This document defines the repository-level engineering rules for `rin`.

## 1. Build for public clones

- Do not hard-code personal usernames, hostnames, tokens, or workstation-only paths.
- Treat `~/.rin` as runtime state, not as a source-tree dependency.
- Keep install, update, and restart flows reproducible from a fresh clone.
- Prefer HTTPS examples and portable defaults in docs and scripts.

## 2. Keep the public surface small

- The supported public CLI is `rin`, `rin restart`, `rin update`, and `rin uninstall`.
- Runtime capabilities such as bridge delivery, scheduling, memory, and inspection should stay behind the runtime/tool surface unless a new public command is clearly justified.
- Remove compatibility leftovers instead of preserving parallel legacy paths by default.

## 3. Refactor toward lower entropy

- Prefer extracting shared pure helpers over duplicating logic across large files.
- Keep modules focused: runtime helpers, transport logic, prompt/session logic, and docs checks should stay separable.
- Simplify before extending. If a new feature increases branching, first look for code that can be merged or deleted.

## 4. Optimize for user-visible effect

- Reduce startup overhead on common paths.
- Avoid unnecessary prompt text, repeated work, and duplicate event traffic.
- Treat reliability, clarity, and predictable behavior as performance features.

## 5. Tests and docs move with code

- Every user-visible behavior change should update the relevant README or contributor docs in the same change.
- Add or expand automated tests when extracting shared logic, changing prompt/session control flow, or touching portability-sensitive code.
- Do not commit `.only` modifiers in tests; `npm run check` enforces this.
- `npm run check` must stay green from a fresh clone.

## 6. Review checklist

Before merging, verify:

1. the change works outside a private machine setup
2. stale code paths or compatibility residue were removed when possible
3. docs still describe the current public behavior
4. automated checks cover the changed risk area
