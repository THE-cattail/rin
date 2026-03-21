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

spinner() {
  pid="$1"
  label="$2"
  frames='|/-\\'
  i=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    frame=$(printf '%s' "$frames" | cut -c $((i % 4 + 1)))
    printf '\r[%s] %s' "$frame" "$label" >&2
    i=$((i + 1))
    sleep 0.1
  done
}

run_quiet() {
  label="$1"
  shift
  log_file="$TMP_ROOT/$(date +%s)-$$.log"
  (
    "$@"
  ) >"$log_file" 2>&1 &
  cmd_pid=$!
  spinner "$cmd_pid" "$label" &
  spinner_pid=$!
  wait_status=0
  if ! wait "$cmd_pid"; then
    wait_status=$?
  fi
  kill "$spinner_pid" >/dev/null 2>&1 || true
  wait "$spinner_pid" 2>/dev/null || true
  if [ "$wait_status" -eq 0 ]; then
    printf '\r[✓] %s\n' "$label" >&2
    rm -f "$log_file"
    return 0
  fi
  printf '\r[✗] %s\n' "$label" >&2
  if [ -f "$log_file" ]; then
    printf '\n---- command output ----\n' >&2
    cat "$log_file" >&2
    printf '------------------------\n' >&2
  fi
  return "$wait_status"
}

if [ "$#" -eq 0 ]; then
  set -- --current-user
fi

TARGET_STATE_ROOT="${RIN_HOME:-$HOME/.rin}"
prev=''
for arg in "$@"; do
  if [ "$prev" = '--state-root' ] || [ "$prev" = '--home' ] || [ "$prev" = '--dir' ]; then
    TARGET_STATE_ROOT="$arg"
    prev=''
    continue
  fi
  prev="$arg"
done

if [ -f "$TARGET_STATE_ROOT/app/current/dist/index.js" ] && [ "${RIN_FORCE_INSTALL_EXISTING:-}" != '1' ]; then
  echo "Rin is already installed at $TARGET_STATE_ROOT." >&2
  echo "Use 'rin update' to upgrade, or uninstall first before running install.sh again." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rin-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

CLONE_DIR="$TMP_ROOT/repo"

printf '[…] Preparing Rin installer\n' >&2
if ! run_quiet "Cloning Rin from $REPO_URL ($REF)" git clone --depth 1 --branch "$REF" "$REPO_URL" "$CLONE_DIR"; then
  rm -rf "$CLONE_DIR"
  run_quiet "Cloning Rin from $REPO_URL (fallback)" git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
  run_quiet "Checking out $REF" sh -c "cd \"$CLONE_DIR\" && git checkout \"$REF\""
fi

cd "$CLONE_DIR"
run_quiet "Installing npm dependencies" sh -c '
  if [ -f package-lock.json ]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
'
run_quiet "Building Rin" npm run -s build
exec node ./dist/index.js __install "$@" --source-repo "$REPO_URL" --source-ref "$REF"
