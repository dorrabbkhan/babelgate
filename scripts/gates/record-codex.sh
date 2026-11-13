#!/usr/bin/env bash
# Codex CLI shape recorder (plan v1.4 Task 1, spec §1.2 E1–E3): puts
# record-shapes.ts in front of a Responses-speaking upstream and runs a
# non-interactive `codex exec` edit task in a temp copy of the
# edit-task fixture with a scratch CODEX_HOME whose model provider
# points at the recorder. No babelgate in the loop: this records what
# Codex itself sends to a native Responses endpoint (Codex → recorder →
# upstream). Every request lands as one shape line — method, path,
# query keys, header names and a value-free body shape — in the JSONL
# the script prints.
#
#   scripts/gates/record-codex.sh [--upstream <baseUrl>] [--model <slug>]
#
# --model is the slug written to the scratch config.toml (default
# qwen/qwen3-coder); if Codex prints a "Model metadata ... not found"
# warning for it, that line is echoed into the summary — under fallback
# metadata there is no apply_patch tool and no reasoning.effort, which
# is exactly what the recording is meant to show.
#
# The recorder runs with RECORD_KEEP_ENUMS=1 (record-shapes.ts): type
# values, tool names, include entries, reasoning.effort/summary,
# text.verbosity, format.syntax, tool_choice, model, the user-agent
# product tokens and the SSE event names are kept verbatim; everything
# else stays a "<string:len>" shape.
#
# Real upstream only — this script makes network calls and needs
# OPENROUTER_API_KEY: exported in the environment, or present as an
# OPENROUTER_API_KEY= line in ./.env, read with the same dotenv parse
# babelgate itself uses (only that variable is exported — the file is
# never sourced and the value is never printed; the key never reaches
# the JSONL: header names only). --upstream is the versioned Responses
# base URL the way Codex would use it, default
# https://openrouter.ai/api/v1; even for another upstream the provider
# env_key stays OPENROUTER_API_KEY, so put that upstream's key there.
#
# Env overrides: CODEX_BIN (path to a codex binary, default: `codex`
# on PATH or `npx -y @openai/codex`), RECORD_OUT (JSONL path, default
# tmp/ under the repo), CODEX_TIMEOUT_S (hard cap on the `codex exec`
# run, default 900 — Codex retries a dead upstream forever, so without
# the cap the script hangs).
set -euo pipefail

cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
PROMPT="Make the failing test pass. Run npm test to check your work."
MODEL="qwen/qwen3-coder"

usage() {
  echo "usage: $0 [--upstream <baseUrl>] [--model <slug>]" >&2
}

upstream="https://openrouter.ai/api/v1"
while [ $# -gt 0 ]; do
  case "$1" in
    --upstream)
      upstream="${2:?--upstream needs a value}"
      shift 2
      ;;
    --model)
      MODEL="${2:?--model needs a value}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

# Key from the environment first; if unset, the same ./.env babelgate
# loads — parsed with dotenv itself so quoting rules match, and only
# this variable is exported (the file is never sourced, the value
# never printed).
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f .env ]; then
  OPENROUTER_API_KEY="$(
    node -e 'process.stdout.write(
      require("dotenv").config({ quiet: true }).parsed?.OPENROUTER_API_KEY ?? "",
    )' 2>/dev/null || true
  )"
  export OPENROUTER_API_KEY
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "RECORD FAIL: OPENROUTER_API_KEY is not set (env or .env)" >&2
  exit 1
fi

# codex binary: CODEX_BIN, then PATH, then npx. ~/.npm can be
# read-only, so npx gets a throwaway cache.
if [ -n "${CODEX_BIN:-}" ]; then
  codex_cmd=("$CODEX_BIN")
elif command -v codex >/dev/null 2>&1; then
  codex_cmd=(codex)
else
  codex_cmd=(npx -y @openai/codex)
fi

started="$(date +%s)"
work="$(mktemp -d)"
npm_cache="$(mktemp -d)"
recorder_pid=""
out_jsonl="${RECORD_OUT:-$PWD/tmp/codex-records/$(date +%Y%m%d-%H%M%S).jsonl}"

cleanup() {
  if [ -n "$recorder_pid" ]; then
    kill "$recorder_pid" 2>/dev/null || true
    wait "$recorder_pid" 2>/dev/null || true
  fi
  rm -rf "$work" "$npm_cache"
}
trap cleanup EXIT

mkdir -p "$work/edit-task" "$work/codex-home" "$(dirname "$out_jsonl")"
cp -R "$FIXTURE"/. "$work/edit-task/"

# One free port, OS-assigned, for the recorder.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# record-shapes joins <forwardBase> + the request path, and Codex's
# base_url below is fixed at http://localhost:<port>/v1 so it POSTs
# /v1/responses. Forwarding to <upstream> verbatim would double the
# /v1 (/api/v1/v1/responses), so the forward base is --upstream minus
# its trailing /v1 segment — Codex's /v1 then lands at
# <upstream>/responses (https://openrouter.ai/api/v1/responses for the
# default). An --upstream whose path does not end in /v1 keeps it and
# Codex's /v1 is appended after it.
forward_base="$(
  node -e '
    const u = new URL(process.argv[1]);
    u.pathname = u.pathname.replace(/\/v1\/?$/, "");
    process.stdout.write(u.toString().replace(/\/$/, ""));
  ' "$upstream"
)"

# RECORD_KEEP_ENUMS=1: type values, tool names, reasoning/include/text
# enums and the SSE event names land verbatim in the JSONL — the plan's
# turns.json keeps those; everything else stays a "<string:len>" shape.
npm_config_cache="$npm_cache" \
  RECORD_KEEP_ENUMS=1 \
  npx ts-node scripts/gates/record-shapes.ts \
  "$port" "$forward_base" "$out_jsonl" \
  >"$work/recorder.log" 2>&1 &
recorder_pid=$!

# Readiness: the recorder prints one line when it binds.
ready=""
for _ in $(seq 1 30); do
  if grep -q "record-shapes listening" "$work/recorder.log" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$recorder_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "RECORD FAIL: recorder did not start on :$port" >&2
  tail -20 "$work/recorder.log" >&2 || true
  exit 1
fi

# Scratch CODEX_HOME: keeps the user's real ~/.codex (auth, sessions,
# config) out of the recording. model_provider `rec` is the recorder;
# wire_api "responses" is what this task is measuring. env_key names
# the env var Codex reads the key from — it stays OPENROUTER_API_KEY
# whatever --upstream points at. approval_policy/sandbox_mode match
# record-gemini-cli.sh's --yolo: the edit task must write files and
# run npm test without asking (a sandbox-denied run records nothing).
cat > "$work/codex-home/config.toml" <<EOF
model = "$MODEL"
model_provider = "rec"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.rec]
name = "Recorded upstream"
base_url = "http://localhost:$port/v1"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
requires_openai_auth = false
EOF

# Non-interactive Codex run. --skip-git-repo-check: the temp fixture
# copy is not a git repo and Codex refuses to run outside one.
# npm_config_cache/HOME point at scratch dirs so nothing writes to
# the real ~/.npm or ~/.codex. timeout + </dev/null: Codex retries an
# unreachable upstream forever, so the run gets a hard cap (TERM, then
# KILL after 30s) and no stdin to block on.
(
  cd "$work/edit-task"
  env -u PROXY_API_KEY \
    HOME="$work/home" \
    CODEX_HOME="$work/codex-home" \
    npm_config_cache="$npm_cache" \
    timeout -k 30 "${CODEX_TIMEOUT_S:-900}" \
      "${codex_cmd[@]}" exec --skip-git-repo-check "$PROMPT" \
      </dev/null >"$work/codex.log" 2>&1
) || true

# Give the last requests a beat to flush through the recorder.
sleep 1

# A timed-out or never-connecting run leaves no JSONL — that is a
# recording failure, not an empty result.
if [ ! -s "$out_jsonl" ]; then
  echo "RECORD FAIL: no requests recorded" >&2
  echo "--- recorder log (tail) ---" >&2
  tail -20 "$work/recorder.log" >&2 || true
  echo "--- codex log (tail) ---" >&2
  tail -20 "$work/codex.log" >&2 || true
  exit 1
fi

pass=""
if (cd "$work/edit-task" && npm_config_cache="$npm_cache" npm test) \
  >"$work/npm-test.log" 2>&1; then
  pass=1
fi

elapsed="$(( $(date +%s) - started ))"
echo "codex version: $(npm_config_cache="$npm_cache" "${codex_cmd[@]}" --version 2>&1 | head -1)"
echo "model: $MODEL (upstream: $upstream)"
# Fallback metadata means no apply_patch and no reasoning.effort —
# surface Codex's warning so run 2's gaps are visible in the summary.
metadata_warning="$(grep "Model metadata" "$work/codex.log" 2>/dev/null | head -1 || true)"
if [ -n "$metadata_warning" ]; then
  echo "codex warning: $metadata_warning"
fi
echo "duration: ${elapsed}s"
echo "jsonl: $out_jsonl"
if [ -n "$pass" ]; then
  echo "codex edit task: PASS"
else
  echo "codex edit task: FAIL"
  echo "--- codex output (tail) ---" >&2
  tail -30 "$work/codex.log" >&2 || true
fi
