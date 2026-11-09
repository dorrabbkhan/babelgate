#!/usr/bin/env bash
# Claude Code edit gate (spec §4.7, D3; the `config` mode was added for
# the v1.2 gates, spec §4.5, D4): copies the failing edit-task fixture
# to a temp dir, starts babelgate with the claude-code preset, lets
# Claude Code fix the bug through the proxy, then runs npm test
# itself. Pass = the fixture's test passes afterwards.
#
#   scripts/gates/claude-code-edit.sh <ollama|openrouter> [model]
#   scripts/gates/claude-code-edit.sh config <path-to-yaml> [model-label]
#
# Real upstreams only — this script makes network calls. ollama needs a
# reachable OLLAMA_API_BASE_URL (default http://localhost:11434);
# openrouter needs OPENROUTER_API_KEY; config mode takes whatever env the
# YAML file's api_key_env entries name (e.g. OPENROUTER_API_KEY for
# examples/claude-code-hybrid.yaml). The API key is never printed.
#
# OBSERVE_CHECK: after the edit task, run scripts/gates/observe-check.ts
# against the still-running instance (spec §4.5 release gates). `1`
# enables it with `--client claude-code`; any other value is appended
# as extra flags (e.g. OBSERVE_CHECK="--expect-cache-read"). In config
# mode the script also derives flags from the YAML: live_prices →
# --expect-cost, ≥2 providers → --expect-providers in file order,
# would_cost_reference → --expect-saved. USAGE_DB always points at a
# temp file so every row the check sees is from this run.
set -euo pipefail

# Caller's cwd, captured before the cd: `config` resolves a relative
# YAML path against it.
caller_pwd="$PWD"
cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"

usage() {
  echo "usage: $0 <ollama|openrouter> [model]" >&2
  echo "       $0 config <path-to-yaml> [model-label]" >&2
}

target="${1:-}"
[ $# -gt 0 ] && shift

# Argument-count validation (usage, exit 2) runs inside each branch
# before any key or file check, so a bad invocation never exits 1.
case "$target" in
  ollama)
    model="${1:-qwen3-coder:30b}"
    [ $# -gt 0 ] && shift || true
    if [ $# -gt 0 ]; then
      usage
      exit 2
    fi
    cli_args=(--preset claude-code --target ollama --model "$model")
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
    # Base URL is /api, not /api/v1: babelgate joins
    # "${OPENAI_API_BASE_URL}${requestPath}" and the OpenAI request path
    # already carries /v1 → https://openrouter.ai/api/v1/chat/completions
    # (https://openrouter.ai/docs/api-reference/overview).
    cli_args=(
      --preset claude-code --target openai --model "$model"
      --base-url https://openrouter.ai/api
    )
    ;;
  config)
    config_path="${1:-}"
    [ $# -gt 0 ] && shift || true
    model="${1:-per-config}"
    [ $# -gt 0 ] && shift || true
    if [ -z "$config_path" ] || [ $# -gt 0 ]; then
      usage
      exit 2
    fi
    # The script cd'd to the repo root above; anchor a relative path to
    # the caller's working directory (portable — no realpath).
    case "$config_path" in
      /*) ;;
      *) config_path="$caller_pwd/$config_path" ;;
    esac
    if [ ! -f "$config_path" ]; then
      echo "GATE FAIL: config file not found: $config_path" >&2
      exit 1
    fi
    # The CLI rejects --target/--model/--base-url with a config file; the
    # preset only selects which client export lines to print.
    cli_args=(--preset claude-code --config "$config_path")
    ;;
  *)
    usage
    exit 2
    ;;
esac

if ! command -v claude >/dev/null 2>&1; then
  echo "GATE FAIL: claude CLI not found on PATH" >&2
  exit 1
fi

started="$(date +%s)"
started_ms="$(( started * 1000 ))"
work="$(mktemp -d)"
proxy_pid=""

cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/edit-task"
cp -R "$FIXTURE"/. "$work/edit-task/"

npm run --silent build

# A free port: let the OS pick one by asking node.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# USAGE_DB points the usage store at a temp file (deleted on exit) so
# every row observe-check sees is from this run — the owner's real
# ~/.babelgate/usage.db is untouched and "since start" is exact.
if [ "$target" = "openrouter" ]; then
  OPENAI_API_KEY="$OPENROUTER_API_KEY" \
    USAGE_DB="$work/usage.db" \
    node dist/cli.js "${cli_args[@]}" --port "$port" \
    >"$work/babelgate.log" 2>&1 &
elif [ "$target" = "config" ]; then
  # Config file defines every provider; the YAML's api_key_env names are
  # read from this process's environment (spec §3.5 — *_API_BASE_URL env
  # vars are ignored in config mode). NODE_ENV=production: the routing
  # summary below parses the route log lines as JSON (pino-pretty is
  # dev-only), and production also keeps upstream body previews out of
  # the log.
  NODE_ENV=production \
    USAGE_DB="$work/usage.db" \
    node dist/cli.js "${cli_args[@]}" --port "$port" \
    >"$work/babelgate.log" 2>&1 &
else
  OLLAMA_API_BASE_URL="${OLLAMA_API_BASE_URL:-http://localhost:11434}" \
    USAGE_DB="$work/usage.db" \
    node dist/cli.js "${cli_args[@]}" --port "$port" \
    >"$work/babelgate.log" 2>&1 &
fi
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

# The client export lines the CLI printed — AUTH_TOKEN is whatever it
# chose (the client-facing proxy token, not an upstream key).
base_url="$(grep -m1 '^export ANTHROPIC_BASE_URL=' "$work/babelgate.log" | cut -d= -f2- || true)"
token="$(grep -m1 '^export ANTHROPIC_AUTH_TOKEN=' "$work/babelgate.log" | cut -d= -f2- || true)"
if [ -z "$base_url" ] || [ -z "$token" ]; then
  echo "GATE FAIL: babelgate did not print the client export lines" >&2
  tail -20 "$work/babelgate.log" >&2 || true
  exit 1
fi

# Non-interactive Claude Code run. Flag semantics from `claude --help`
# (Claude Code 2.1.311): -p prints and exits; --allowedTools auto-approves
# only the listed tools; --permission-prompts none denies anything else
# that would prompt; --strict-mcp-config and --setting-sources local keep
# the owner's ~/.claude and project config from widening the tool set
# (the temp dir has no .claude dir, so "local" loads nothing).
(
  cd "$work/edit-task"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_MODEL \
    ANTHROPIC_BASE_URL="$base_url" \
    ANTHROPIC_AUTH_TOKEN="$token" \
    claude -p \
      --permission-prompts none \
      --allowedTools "Edit" "Write" "Bash(npm test)" \
      --strict-mcp-config \
      --setting-sources local \
      "Make the failing test pass. Run npm test to check your work." \
      > "$work/claude.log" 2>&1
) || true

pass=""
if (cd "$work/edit-task" && npm test) >"$work/npm-test.log" 2>&1; then
  pass=1
fi

elapsed="$(( $(date +%s) - started ))"
echo "claude version: $(claude --version 2>&1 | head -1)"
echo "model: $model (target: $target)"
echo "duration: ${elapsed}s"
if [ "$target" = "config" ]; then
  # Routing summary for the decisions record: count the "Request
  # completed" route log lines (src/routing/route-log.ts) by winner and
  # by reason, plus the multi-hop (fallback) count. The log is JSON in
  # config mode (NODE_ENV=production above); non-JSON lines — the client
  # exports and the routing table — are skipped. Only these aggregate
  # fields are printed: no prompt text, model output or keys.
  node -e '
    const fs = require("fs");
    const byWinner = {};
    const byReason = {};
    let total = 0;
    let fallbacks = 0;
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.msg !== "Request completed") continue;
      total += 1;
      const winner = rec.winner === undefined ? "none" : String(rec.winner);
      byWinner[winner] = (byWinner[winner] || 0) + 1;
      const reason = rec.reason === undefined ? "unknown" : String(rec.reason);
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (Array.isArray(rec.hops) && rec.hops.length > 1) fallbacks += 1;
    }
    const fmt = (o) =>
      Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join(" ") || "-";
    console.log(`routing summary: ${total} requests, ${fallbacks} fallbacks (>1 hop)`);
    console.log(`  by winner: ${fmt(byWinner)}`);
    console.log(`  by reason: ${fmt(byReason)}`);
  ' "$work/babelgate.log"
fi

# The release gates' observability half (spec §4.5): OBSERVE_CHECK
# enables it — see the header comment for the derived and extra flags.
observe_failed=0
if [ -n "${OBSERVE_CHECK:-}" ] && [ "$OBSERVE_CHECK" != "0" ]; then
  obs_args=(--base "http://localhost:$port" --client claude-code --since "$started_ms")
  if [ "$target" = "config" ]; then
    # Anchored patterns so a commented-out key can't match.
    if grep -Eq '^[[:space:]]*live_prices:[[:space:]]*true' "$config_path"; then
      obs_args+=(--expect-cost)
    fi
    if grep -Eq '^[[:space:]]*would_cost_reference:' "$config_path"; then
      obs_args+=(--expect-saved)
    fi
    # Provider names in file order, from the top-level `providers:` map.
    obs_providers="$(awk '
      /^providers:[[:space:]]*$/ { in_p = 1; next }
      /^[^[:space:]]/ { in_p = 0 }
      in_p && /^[[:space:]]+[a-z0-9_-]+:[[:space:]]*$/ {
        line = $0; sub(/:.*/, "", line); gsub(/[[:space:]]/, "", line); print line
      }
    ' "$config_path")"
    if [ "$(printf '%s\n' "$obs_providers" | grep -c .)" -ge 2 ]; then
      obs_args+=(--expect-providers "$(printf '%s\n' "$obs_providers" | paste -sd, -)")
    fi
  fi
  if [ "$OBSERVE_CHECK" != "1" ]; then
    read -r -a obs_extra <<< "$OBSERVE_CHECK"
    obs_args+=(${obs_extra[@]+"${obs_extra[@]}"})
  fi
  ./node_modules/.bin/ts-node scripts/gates/observe-check.ts "${obs_args[@]}" || observe_failed=1
fi

if [ -n "$pass" ] && [ "$observe_failed" = "0" ]; then
  echo "GATE PASS"
else
  echo "GATE FAIL"
  echo "--- claude output (tail) ---" >&2
  tail -30 "$work/claude.log" >&2 || true
  echo "--- npm test output (tail) ---" >&2
  tail -15 "$work/npm-test.log" >&2 || true
  exit 1
fi
