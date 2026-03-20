# Vendored Pi upstream workflow

Rin now carries a vendored upstream checkout at `third_party/pi-mono`.

Purpose:
- track upstream `pi` TUI/InteractiveMode more directly
- keep Rin-specific changes as a thin adaptation layer instead of re-implementing the whole TUI
- make future upstream updates a rebase/sync task instead of another manual UI rewrite

Current loading rule:
- Rin now resolves Pi code from the vendored tree at `third_party/pi-mono/packages/coding-agent` and `third_party/pi-mono/packages/tui`
- the shared loader is used by the daemon-backed TUI, runtime session bootstrap, daemon-side TUI RPC helpers, and `rin pi`
- install bundles now carry `third_party/` as part of the runtime so the vendored path remains intact after local install

Typical workflow:
1. sync vendored upstream
2. install/build `third_party/pi-mono`
3. make the minimal Rin-facing patches there
4. keep Rin runtime-side changes in `src/`

Current state:
- the daemon-backed TUI frontend, runtime session bootstrap, daemon-side theme helpers, and `rin pi` all resolve through the vendored Pi tree
- the remaining architecture step is not loader coverage but replacing more of Rin's hand-written frontend shell with upstream `InteractiveMode` structure, ideally from the vendored `pi-mono` tree itself

Next alignment targets from `third_party/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`:
- lift more startup behavior directly from upstream: changelog display, quiet-startup gating, migrated-provider warnings, and model-fallback messaging
- reduce local TUI state drift by reusing the upstream status/pending/chat transition rules instead of maintaining a parallel Rin state machine
- migrate more selector/editor/login flows from upstream components, especially the oauth/login/config selectors that are still absent from Rin's daemon-backed shell
- compare loader/border behavior with upstream `BorderedLoader`, `DynamicBorder`, and keybinding-hint helpers, then delete Rin-local approximations where upstream pieces can be used directly
- once the frontend shell is thinner, evaluate whether the remaining daemon bridge can sit behind an upstream-shaped session adapter instead of a parallel mode implementation

Suggested upstream sync loop:
```bash
cd third_party/pi-mono
git fetch origin
git checkout <target-ref>
npm install
npm run build
```

After rebuilding upstream locally, rebuild Rin and run the normal `rin` / `rin pi` entrypoints to exercise the vendored build end-to-end.
