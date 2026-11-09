#!/usr/bin/env bash
# Gemini CLI edit gate (spec §4.5, D10 — release gate B): copies the
# failing edit-task fixture to a temp dir, starts babelgate, lets the
# Gemini CLI fix the bug through the proxy (Gemini wire format via
# GOOGLE_GEMINI_BASE_URL), then runs the fixture's npm test itself and
# scripts/gates/observe-check.ts --client gemini-cli against the still
# running instance. Pass = GATE PASS + OBSERVE PASS.
#
#   scripts/gates/gemini-cli-edit.sh <ollama|openrouter|gemini> [model]
#
# Real upstreams only — this script makes network calls. ollama needs a
# reachable OLLAMA_API_BASE_URL (default http://localhost:11434);
# openrouter needs OPENROUTER_API_KEY; gemini needs GEMINI_API_KEY (env
# or .env — babelgate loads it itself). Keys are never printed.
#
# Env overrides: GEMINI_BIN (path to a gemini CLI binary, default:
# `gemini` on PATH or `npx -y @google/gemini-cli`).
set -euo pipefail

cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
PROMPT="Make the failing test pass. Run npm test to check your work."

usage() {
  echo "usage: $0 <ollama|openrouter|gemini> [model]" >&2
}

target="${1:-}"
[ $# -gt 0 ] && shift

# Argument-count validation (usage, exit 2) runs inside each branch
# before any key check, so a bad invocation never exits 1.
case "$target" in
  ollama)
    model="${1:-qwen3-coder:30b}"
    [ $# -gt 0 ] && shift || true
    if [ $# -gt 0 ]; then
      usage
      exit 2
    fi
    cli_args=(--target ollama)
    ;;
  openrouter)
    model="${1:-qwen/qwen3-coder}"
    [ $# -gt 0 ] && shift || true
    if [ $# -gt 0 ]; then
      usage
      exit 2
    fi
    if [ -z "${OPENROUTER_API_KEY:-}" ]; then
      echo "GATE FAIL: OPENROUTER_API_KEY is not set" >&2
      exit 1
    fi
    # Base URL is /api, not /api/v1 — see claude-code-edit.sh.
    cli_args=(--target openai --base-url https://openrouter.ai/api)
    ;;
  gemini)
    model="${1:-gemini-2.5-flash}"
    [ $# -gt 0 ] && shift || true
    if [ $# -gt 0 ]; then
      usage
      exit 2
    fi
    if [ -z "${GEMINI_API_KEY:-}" ] \
      && ! grep -q '^GEMINI_API_KEY=.' .env 2>/dev/null; then
      echo "GATE FAIL: GEMINI_API_KEY is not set (env or .env)" >&2
      exit 1
    fi
    cli_args=(--target gemini --base-url https://generativelanguage.googleapis.com)
    ;;
  *)
    usage
    exit 2
    ;;
esac

# gemini CLI binary: GEMINI_BIN, then PATH, then npx. ~/.npm can be
# read-only, so npx gets a throwaway cache.
if [ -n "${GEMINI_BIN:-}" ]; then
  gemini_cmd=("$GEMINI_BIN")
elif command -v gemini >/dev/null 2>&1; then
  gemini_cmd=(gemini)
else
  gemini_cmd=(npx -y @google/gemini-cli)
fi

started="$(date +%s)"
started_ms="$(( started * 1000 ))"
work="$(mktemp -d)"
npm_cache="$(mktemp -d)"
proxy_pid=""

cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -rf "$work" "$npm_cache"
}
trap cleanup EXIT

mkdir -p "$work/edit-task"
cp -R "$FIXTURE"/. "$work/edit-task/"

npm run --silent build

# A free port: let the OS pick one by asking node.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# Whatever model the CLI asks for routes to the gate model; the CLI's
# traffic is what is being gated, not model fidelity. USAGE_DB keeps
# the gate's rows in the temp dir (deleted on exit) so every row
# observe-check sees is from this run. NODE_ENV=production keeps
# upstream body previews out of the log tail.
bg_env=(
  "USAGE_DB=$work/usage.db"
  "MODEL_MAP=*=$model"
  "UPSTREAM_TIMEOUT_MS=${UPSTREAM_TIMEOUT_MS:-300000}"
)
if [ "$target" = "openrouter" ]; then
  bg_env+=(OPENAI_API_KEY="$OPENROUTER_API_KEY")
elif [ "$target" = "ollama" ]; then
  bg_env+=(OLLAMA_API_BASE_URL="${OLLAMA_API_BASE_URL:-http://localhost:11434}")
fi
NODE_ENV=production \
  env -u PROXY_API_KEY "${bg_env[@]}" \
  node dist/cli.js "${cli_args[@]}" --port "$port" \
  >"$work/babelgate.log" 2>&1 &
proxy_pid=$!

ready=""
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "GATE FAIL: babelgate did not become healthy on :$port" >&2
  tail -20 "$work/babelgate.log" >&2 || true
  exit 1
fi

# A scratch HOME: keeps the user's real ~/.gemini (settings,
# extensions, trusted folders) out of the gate and works when $HOME is
# read-only. selectedType pins the API-key auth method — E9:
# GOOGLE_GEMINI_BASE_URL applies only with GEMINI_API_KEY auth and
# permits plain HTTP on localhost; the stray GOOGLE_*/GEMINI_* endpoint
# selectors are unset so nothing overrides it. The dummy key is fine —
# babelgate's client auth is off.
mkdir -p "$work/home/.gemini"
cat > "$work/home/.gemini/settings.json" <<'EOF'
{"security": {"auth": {"selectedType": "gemini-api-key"}}}
EOF

# Non-interactive Gemini CLI run. GEMINI_CLI_TRUST_WORKSPACE marks the
# temp fixture dir trusted so --yolo survives (untrusted folders are
# forced back to the default approval mode).
(
  cd "$work/edit-task"
  env -u GOOGLE_API_KEY \
    -u GOOGLE_CLOUD_PROJECT \
    -u GOOGLE_CLOUD_LOCATION \
    -u GOOGLE_GENAI_USE_VERTEXAI \
    -u GOOGLE_GENAI_USE_GCA \
    -u GOOGLE_APPLICATION_CREDENTIALS \
    HOME="$work/home" \
    npm_config_cache="$npm_cache" \
    GEMINI_CLI_TRUST_WORKSPACE=true \
    GEMINI_API_KEY=dummy \
    GOOGLE_GEMINI_BASE_URL="http://localhost:$port" \
    "${gemini_cmd[@]}" -p "$PROMPT" --yolo \
    >"$work/gemini.log" 2>&1
) || true

pass=""
if (cd "$work/edit-task" && npm test) >"$work/npm-test.log" 2>&1; then
  pass=1
fi

observe_failed=0
./node_modules/.bin/ts-node scripts/gates/observe-check.ts \
  --base "http://localhost:$port" --client gemini-cli \
  --since "$started_ms" || observe_failed=1

elapsed="$(( $(date +%s) - started ))"
echo "gemini version: $(npm_config_cache="$npm_cache" "${gemini_cmd[@]}" --version 2>&1 | head -1)"
echo "model: $model (target: $target)"
echo "duration: ${elapsed}s"
if [ -n "$pass" ] && [ "$observe_failed" = "0" ]; then
  echo "GATE PASS"
else
  echo "GATE FAIL"
  echo "--- gemini output (tail) ---" >&2
  tail -30 "$work/gemini.log" >&2 || true
  echo "--- npm test output (tail) ---" >&2
  tail -15 "$work/npm-test.log" >&2 || true
  exit 1
fi
