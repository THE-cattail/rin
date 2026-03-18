#!/usr/bin/env sh
set -eu

REPO_URL="${RIN_REPO_URL:-https://github.com/THE-cattail/rin.git}"
REF="${RIN_REF:-main}"

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  echo "Missing required command: $1" >&2
  exit 1
}

need_cmd git
need_cmd node
need_cmd npm
need_cmd mktemp

run_npm_install() {
  if [ -f package-lock.json ]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
}

if [ "$#" -eq 0 ]; then
  set -- --current-user --yes
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rin-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

CLONE_DIR="$TMP_ROOT/repo"

echo "==> Cloning Rin from $REPO_URL ($REF)"
if ! git clone --depth 1 --branch "$REF" "$REPO_URL" "$CLONE_DIR"; then
  rm -rf "$CLONE_DIR"
  git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
  (cd "$CLONE_DIR" && git checkout "$REF")
fi

cd "$CLONE_DIR"
run_npm_install
npm run -s build
node ./dist/index.js __install "$@" --source-repo "$REPO_URL" --source-ref "$REF"
