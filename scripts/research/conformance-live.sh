#!/usr/bin/env bash
# conformance-live.sh — rerun ONE conformance scenario through a
# gateway against the live provider (v1.6 spec §3.10, plan Task 13b).
#
#   scripts/research/conformance-live.sh <gateway> <scenario> [--dry-run]
#
#   <gateway>:  babelgate | babelgate-default | ccr | free-claude-code
#   <scenario>: a scenario name from conformance.process.test.ts, e.g.
#               streamed-tool-args:anthropic->openai
#
# How it works: the conformance suite's "live mode" points the
# gateway's provider config at a localhost logging forward-proxy
# (scripts/research/conformance-spy.ts, "the spy") instead of the
# replay mock. The spy injects the real provider key, forwards to the
# live provider (keeping the target's base path), and records every
# upstream request plus a shape-only summary of the response as JSONL
# — sensitive headers and key=/api_key=/access_token= query values
# redacted, response text never logged — so the same scenario turns
# and pass rules apply: the turn-2 upstream request can be inspected
# for the reasoning field, and each turn's client-side check applies
# only when the upstream response carried reasoning.
#
# The verdict comes from scripts/research/conformance-verdict.ts:
# CONFIRMED FAILURE only when every spy-log upstream exchange is 2xx,
# every client turn is 2xx, and the scenario's recorded verdict
# (CONFORMANCE_LIVE_VERDICT, written by the test) failed a rule that
# cites a provider doc. A timeout, a gateway non-2xx, an upstream
# non-2xx or no upstream call is INCONCLUSIVE — never a failure.
#
# Keys come from env, never from flags:
#   openai upstream — OPENROUTER_API_KEY (target openrouter.ai/api,
#                     model default deepseek/deepseek-r1-0528) or
#                     OPENAI_API_KEY (api.openai.com, gpt-4o-mini)
#   gemini upstream — GEMINI_API_KEY (generativelanguage.googleapis.com,
#                     gemini-3.5-flash)
# Model overrides: CONFORMANCE_LIVE_MODEL_{OPENAI,GEMINI} or
# CONFORMANCE_LIVE_MODEL.
#
# Offline-verifiable: argument parsing, the missing-key error and
# --dry-run make no network calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage() {
  echo "usage: $0 <gateway> <scenario> [--dry-run]" >&2
  echo "  gateway:  babelgate | babelgate-default | ccr | free-claude-code" >&2
  echo "  scenario: <name>:<client>-><upstream>, e.g. streamed-tool-args:anthropic->openai" >&2
  exit 2
}

gateway=""
scenario=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) if [ -z "$gateway" ]; then gateway="$1"; elif [ -z "$scenario" ]; then scenario="$1"; else usage; fi; shift ;;
  esac
done
[ -n "$gateway" ] && [ -n "$scenario" ] || usage

case "$gateway" in
  babelgate|babelgate-default|ccr|free-claude-code) ;;
  *) echo "conformance-live: unknown gateway '$gateway' (babelgate | babelgate-default | ccr | free-claude-code)" >&2; exit 2 ;;
esac

case "$scenario" in
  *"->"*) ;;
  *) echo "conformance-live: scenario '$scenario' is not '<name>:<client>-><upstream>'" >&2; exit 2 ;;
esac
upstream="${scenario##*->}"
case "$upstream" in
  openai|gemini) ;;
  *) echo "conformance-live: upstream '$upstream' is not openai or gemini" >&2; exit 2 ;;
esac

key_env=""
target=""
key_header=""
model_default=""
case "$upstream" in
  openai)
    key_header="authorization"
    # dry-run picks the preferred env name even when unset so the
    # missing-key line can name it
    if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
      key_env="OPENROUTER_API_KEY"
      target="https://openrouter.ai/api"
      model_default="deepseek/deepseek-r1-0528"
    else
      key_env="OPENAI_API_KEY"
      target="https://api.openai.com"
      model_default="gpt-4o-mini"
    fi
    ;;
  gemini)
    key_header="x-goog-api-key"
    key_env="GEMINI_API_KEY"
    target="https://generativelanguage.googleapis.com"
    model_default="gemini-3.5-flash"
    ;;
esac
if [ -z "${!key_env:-}" ] && [ "$dry_run" = 0 ]; then
  echo "conformance-live: $upstream upstream needs \$$key_env" >&2
  exit 2
fi

model_var="CONFORMANCE_LIVE_MODEL_${upstream^^}"
model="${!model_var:-${CONFORMANCE_LIVE_MODEL:-$model_default}}"
spy_dir="tmp/conformance/live"
spy_log="$spy_dir/$gateway-${scenario//[^A-Za-z0-9_.-]/_}.jsonl"
verdict_file="$spy_dir/$gateway-${scenario//[^A-Za-z0-9_.-]/_}.verdict.json"
vitest_out="$spy_dir/$gateway-${scenario//[^A-Za-z0-9_.-]/_}.vitest.log"
spy_port="${CONFORMANCE_SPY_PORT:-4599}"
spy_ts="scripts/research/conformance-spy.ts"

if [ "$dry_run" = 1 ]; then
  key_state="set"; [ -n "${!key_env:-}" ] || key_state="NOT SET"
  cat <<EOF
conformance-live dry run
  gateway:   $gateway
  scenario:  $scenario
  upstream:  $upstream -> $target (key from \$$key_env [$key_state], header $key_header)
  model:     $model (override: $model_var / CONFORMANCE_LIVE_MODEL)
  spy:       http://127.0.0.1:$spy_port -> $target, log $spy_log
  command:
    CONFORMANCE_GATEWAYS=$gateway \\
      CONFORMANCE_LIVE_UPSTREAM=http://127.0.0.1:$spy_port \\
      CONFORMANCE_LIVE_SPY_LOG=$spy_log \\
      CONFORMANCE_LIVE_VERDICT=$verdict_file \\
      $model_var=$model \\
      npx vitest run --config vitest.process.config.ts \\
        tests/process/conformance.process.test.ts -t "$scenario"
  vitest output: $vitest_out
  verdict:       conformance-verdict.ts (CONFIRMED only on a doc-cited rule failure over all-2xx exchanges)
EOF
  exit 0
fi

mkdir -p "$spy_dir"
: > "$spy_log"
rm -f "$verdict_file"
spy_pid=""
cleanup() {
  [ -n "$spy_pid" ] && kill "$spy_pid" 2>/dev/null || true
}
trap cleanup EXIT

key_value="${!key_env}"
SPY_TARGET="$target" SPY_KEY="$key_value" SPY_KEY_HEADER="$key_header" \
  SPY_LOG="$spy_log" SPY_PORT="$spy_port" \
  node -r ts-node/register/transpile-only "$spy_ts" &
spy_pid=$!
for i in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$spy_port/__health" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$spy_pid" 2>/dev/null; then
    echo "conformance-live: spy failed to start" >&2
    exit 1
  fi
  sleep 0.1
done

set +e
env \
  CONFORMANCE_GATEWAYS="$gateway" \
  CONFORMANCE_LIVE_UPSTREAM="http://127.0.0.1:$spy_port" \
  CONFORMANCE_LIVE_SPY_LOG="$spy_log" \
  CONFORMANCE_LIVE_VERDICT="$verdict_file" \
  "$model_var"="$model" \
  npx vitest run --config vitest.process.config.ts \
    tests/process/conformance.process.test.ts -t "$scenario" \
    2>&1 | tee "$vitest_out"
vitest_status=${PIPESTATUS[0]}
set -e

# The verdict: CONFIRMED only for a doc-cited rule failure over
# all-2xx exchanges; every other outcome INCONCLUSIVE with its cause
# (scripts/research/conformance-verdict.ts).
node -r ts-node/register/transpile-only \
  scripts/research/conformance-verdict.ts \
  --gateway "$gateway" --scenario "$scenario" \
  --vitest-status "$vitest_status" --vitest-output "$vitest_out" \
  --spy-log "$spy_log" --verdict "$verdict_file"
