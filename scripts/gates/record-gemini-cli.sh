#!/usr/bin/env bash
# Gemini CLI shape recorder (spec §3.10, plan v1.3 Task 1): starts
# babelgate, puts record-shapes.ts in front of it, and runs a
# non-interactive `gemini -p --yolo` edit task in a temp copy of the
# edit-task fixture with GOOGLE_GEMINI_BASE_URL pointed at the
# recorder. Every request the CLI makes lands as one shape line —
# method, path, query keys, header names and a value-free body shape —
# in the JSONL the script prints.
#
#   scripts/gates/record-gemini-cli.sh <ollama|openrouter|gemini> [model]
#
# Real upstreams only — this script makes network calls. ollama needs a
# reachable OLLAMA_API_BASE_URL (default http://localhost:11434);
# openrouter needs OPENROUTER_API_KEY; gemini needs GEMINI_API_KEY (env
# or .env — babelgate loads it itself). Keys are never printed and
# never reach the JSONL (header names only). The client-facing
# GEMINI_API_KEY=dummy is enough because babelgate only checks
# PROXY_API_KEY, which this script leaves unset.
#
# Env overrides: GEMINI_BIN (path to a gemini CLI binary, default:
# `gemini` on PATH or `npx -y @google/gemini-cli`), RECORD_OUT (JSONL
# path, default tmp/ under the repo).
set -euo pipefail

cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
PROMPT="Make the failing test pass. Run npm test to check your work."

usage() {
  echo "usage: $0 <ollama|openrouter|gemini> [model]" >&2
}

target="${1:-}"
[ $# -gt 0 ] && shift

cli_args=()
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
      echo "RECORD FAIL: OPENROUTER_API_KEY is not set" >&2
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
      echo "RECORD FAIL: GEMINI_API_KEY is not set (env or .env)" >&2
      exit 1
    fi
    # GEMINI_API_BASE_URL is empty in .env, so the base URL comes from
    # the flag (user env would still win over it).
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
work="$(mktemp -d)"
npm_cache="$(mktemp -d)"
proxy_pid=""
recorder_pid=""
out_jsonl="${RECORD_OUT:-$PWD/tmp/gemini-cli-records/$(date +%Y%m%d-%H%M%S).jsonl}"

cleanup() {
  for pid in "$proxy_pid" "$recorder_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$work" "$npm_cache"
}
trap cleanup EXIT

mkdir -p "$work/edit-task" "$(dirname "$out_jsonl")"
cp -R "$FIXTURE"/. "$work/edit-task/"

npm run --silent build

# Two free ports, OS-assigned: one for babelgate, one for the recorder.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
recorder_port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# Whatever model the CLI asks for routes to the gate model; the CLI's
# requests are what is being recorded, not model fidelity.
MODEL_MAP="*=$model" \
UPSTREAM_TIMEOUT_MS="${UPSTREAM_TIMEOUT_MS:-300000}" \
  env -u PROXY_API_KEY \
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
  echo "RECORD FAIL: babelgate did not become healthy on :$port" >&2
  tail -20 "$work/babelgate.log" >&2 || true
  exit 1
fi

npx ts-node scripts/gates/record-shapes.ts \
  "$recorder_port" "http://localhost:$port" "$out_jsonl" \
  >"$work/recorder.log" 2>&1 &
recorder_pid=$!

# Readiness: the recorder forwards /health to babelgate like any
# request, so a 200 proves the whole path.
ready=""
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$recorder_port/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$recorder_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "RECORD FAIL: recorder did not forward on :$recorder_port" >&2
  tail -20 "$work/recorder.log" >&2 || true
  exit 1
fi

# A scratch HOME: keeps the user's real ~/.gemini (settings,
# extensions, trusted folders) out of the recording and works when
# $HOME is read-only. selectedType pins the API-key auth method —
# E9: GOOGLE_GEMINI_BASE_URL applies only with GEMINI_API_KEY auth
# and permits plain HTTP on localhost; the stray GOOGLE_*/GEMINI_*
# endpoint selectors are unset so nothing overrides it. The dummy
# key is fine — babelgate's client auth is off.
mkdir -p "$work/home/.gemini"
cat > "$work/home/.gemini/settings.json" <<'EOF'
{"security": {"auth": {"selectedType": "gemini-api-key"}}}
EOF

# Non-interactive Gemini CLI run. GEMINI_CLI_TRUST_WORKSPACE marks the
# temp fixture dir trusted so --yolo survives (untrusted folders are
# forced back to the default approval mode).
(
  cd "$work/edit-task"
  env -u PROXY_API_KEY \
    -u GOOGLE_API_KEY \
    -u GOOGLE_CLOUD_PROJECT \
    -u GOOGLE_CLOUD_LOCATION \
    -u GOOGLE_GENAI_USE_VERTEXAI \
    -u GOOGLE_GENAI_USE_GCA \
    -u GOOGLE_APPLICATION_CREDENTIALS \
    HOME="$work/home" \
    npm_config_cache="$npm_cache" \
    GEMINI_CLI_TRUST_WORKSPACE=true \
    GEMINI_API_KEY=dummy \
    GOOGLE_GEMINI_BASE_URL="http://localhost:$recorder_port" \
    "${gemini_cmd[@]}" -p "$PROMPT" --yolo \
    >"$work/gemini.log" 2>&1
) || true

# Give the last requests a beat to flush through the recorder.
sleep 1

pass=""
if (cd "$work/edit-task" && npm test) >"$work/npm-test.log" 2>&1; then
  pass=1
fi

elapsed="$(( $(date +%s) - started ))"
echo "gemini version: $(npm_config_cache="$npm_cache" "${gemini_cmd[@]}" --version 2>&1 | head -1)"
echo "model: $model (target: $target)"
echo "duration: ${elapsed}s"
echo "jsonl: $out_jsonl"
if [ -n "$pass" ]; then
  echo "gemini edit task: PASS"
else
  echo "gemini edit task: FAIL"
  echo "--- gemini output (tail) ---" >&2
  tail -30 "$work/gemini.log" >&2 || true
fi
