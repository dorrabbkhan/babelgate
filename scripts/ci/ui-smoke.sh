#!/usr/bin/env bash
# §4.4 UI smoke: build is already done (check.sh runs this after the
# build); stand up the mock upstream + dist/index.js, then the one
# Playwright spec — chat request → /ui row → inspector four stages.
#
# Chromium needs the browser binary only (`npx playwright install
# chromium`, no --with-deps); on a host missing its system libraries
# the script fails with the loader's error — the PR then names the
# exact ci.yml apt step for the owner.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MOCK_PORT="${MOCK_PORT:-9711}"
APP_PORT="${APP_PORT:-3199}"
MOCK_LOG="$(mktemp)"; APP_LOG="$(mktemp)"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  echo "--- mock upstream log ---"; cat "$MOCK_LOG" || true
  echo "--- app log ---"; cat "$APP_LOG" || true
}
trap cleanup EXIT

[ -f dist/index.js ] || { echo "dist/index.js missing — run npm run build first" >&2; exit 1; }
[ -f dist/ui/index.html ] || { echo "dist/ui/index.html missing — run npm run build first" >&2; exit 1; }

# Skips the download when the browser is already installed.
npx playwright install chromium

# Mock upstream (the same fixture bodies as tests/mocks/upstreams.ts).
# --project pins the root tsconfig (commonjs): ui/tsconfig.json is
# ESNext and would make ts-node reparse the file as ESM.
MOCK_PORT="$MOCK_PORT" \
  npx ts-node --transpile-only --project tsconfig.json ui/e2e/mock-server.ts \
  >"$MOCK_LOG" 2>&1 &
pids+=($!)

# any HTTP answer means the listener is up (unknown routes are 404)
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$MOCK_PORT/" && break || sleep 0.1
done

# The app, pointed at the mock; :memory: usage store; UI on.
TARGET_API=openai \
OPENAI_API_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
OPENAI_API_KEY=smoke-key \
PORT="$APP_PORT" \
USAGE_DB=":memory:" \
node dist/index.js >"$APP_LOG" 2>&1 &
pids+=($!)

ready=0
for _ in $(seq 1 100); do
  if curl -sf -o /dev/null "http://127.0.0.1:$APP_PORT/health"; then ready=1; break; fi
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "app did not come up" >&2; exit 1; }

SMOKE_BASE_URL="http://127.0.0.1:$APP_PORT" \
  npx playwright test --config ui/playwright.config.ts
