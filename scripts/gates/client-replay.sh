#!/usr/bin/env bash
# Weekly client-release replay (v1.5 Task 12, spec §3.4; E8 — the
# workflow change is a patch the owner applies): installs the LATEST
# Claude Code and Codex releases into a temp npm prefix and runs each
# through babelgate on a cheap OpenRouter model — bridge for both —
# then replays each client's request shapes against the committed
# recording fixtures. A new client release can change what it sends
# without breaking the edit task; the shape diff is what notices.
#
#   scripts/gates/client-replay.sh
#
# Real upstreams only — this script makes network calls and needs
# OPENROUTER_API_KEY: exported in the environment, or present as an
# OPENROUTER_API_KEY= line in ./.env, read with the same dotenv parse
# the record scripts use (only that variable is exported — the file is
# never sourced and the value is never printed).
#
# Per client:
#   gate   — the edit-task gate verbatim (claude-code-edit.sh config
#            examples/claude-code-openrouter.yaml / codex-edit.sh config
#            examples/codex-openrouter.yaml) with the fresh release on
#            PATH. Exit code is the gate verdict.
#   record — record-claude-code.sh / record-codex.sh (the record-shapes
#            drivers) pointed at a babelgate this script starts, so the
#            recording is client → record-shapes → babelgate →
#            OpenRouter — the same bridge path as the gate. The
#            fixture's own provenance is reused: codex records with
#            qwen/qwen3-coder and no --catalog/--effort (fallback
#            metadata), matching tests/fixtures/codex/recording.jsonl's
#            run; claude records in `thinking` mode, matching
#            tests/fixtures/recordings/claude-code-thinking.jsonl.
#   diff   — shape-diff.ts against that fixture: added request keys,
#            tool types, input item types or SSE event types fail.
#
# Two runs per client on purpose: the gate scripts have no recorder
# hook and this task's Files block adds none — a weekly second run is
# cheaper than an interface change to a tested gate.
#
# Output: a markdown summary (client versions, gate results, shape
# diff) always written to $REPLAY_OUT_DIR/summary.md, plus
# versions.txt for the workflow's issue title; the summary is also
# appended to $GITHUB_STEP_SUMMARY when set. After the summary,
# client-replay-artifacts.sh stages the JSONLs, the four sub-run logs
# and summary.md into tmp/client-replay/ (the workflow's upload path —
# a staged file containing the key is dropped) and tails each failed
# sub-run's log into the job log inside group markers. Exit 1 on any
# gate or record failure or when shape-diff reports added shapes;
# exit 2 on usage errors.
#
# Env overrides: REPLAY_OUT_DIR (default tmp/client-replay under the
# repo), CLAUDE_TIMEOUT_S / CODEX_TIMEOUT_S (the record scripts' hard
# caps; codex-edit.sh honours CODEX_TIMEOUT_S too — the claude gate
# run relies on the workflow job's timeout), npm_config_cache
# (honoured by the npm install).
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  echo "usage: $0" >&2
}

[ $# -gt 0 ] && { usage; exit 2; }

# Key from the environment first; if unset, the same ./.env parse the
# record scripts use (dotenv itself, only this variable exported, the
# file never sourced, the value never printed).
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f .env ]; then
  OPENROUTER_API_KEY="$(
    node -e 'process.stdout.write(
      require("dotenv").config({ quiet: true }).parsed?.OPENROUTER_API_KEY ?? "",
    )' 2>/dev/null || true
  )"
  export OPENROUTER_API_KEY
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "REPLAY FAIL: OPENROUTER_API_KEY is not set (env or .env)" >&2
  exit 1
fi

work="$(mktemp -d)"
npm_cache="$(mktemp -d)"
prefix="$(mktemp -d)"
out_dir="${REPLAY_OUT_DIR:-$PWD/tmp/client-replay}"
bg_pids=()

cleanup() {
  for pid in ${bg_pids[@]+"${bg_pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$work" "$npm_cache" "$prefix"
}
trap cleanup EXIT

mkdir -p "$out_dir" "$work"

# The latest releases, isolated in a temp prefix — the repo's own
# dependencies and any installed client versions are untouched.
echo "installing latest client releases into a temp prefix..."
npm_config_cache="$npm_cache" npm install --prefix "$prefix" \
  --no-audit --no-fund \
  @anthropic-ai/claude-code@latest @openai/codex@latest \
  >"$work/npm-install.log" 2>&1 || {
    echo "REPLAY FAIL: npm install of latest clients failed" >&2
    tail -20 "$work/npm-install.log" >&2 || true
    exit 1
  }
bindir="$prefix/node_modules/.bin"
claude_version="$("$bindir/claude" --version 2>&1 | head -1 || true)"
codex_version="$("$bindir/codex" --version 2>&1 | head -1 || true)"
claude_version="${claude_version:-unknown}"
codex_version="${codex_version:-unknown}"

npm run --silent build

# Babelgate for the recorded runs: starts it on an OS-assigned port,
# leaves the port in $bg_port and tracks the pid for cleanup. Called
# directly (not via $()) so the pid tracking survives. $1 = config
# yaml, $2 = cli preset.
bg_port=""
start_babelgate() {
  local yaml="$1" preset="$2" pid
  bg_port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
  # USAGE_DB at a temp file, env -u PROXY_API_KEY: same reasons as the
  # edit scripts (no client-facing auth, scratch usage rows).
  NODE_ENV=production \
    USAGE_DB="$work/usage-$preset.db" \
    env -u PROXY_API_KEY \
    node dist/cli.js --preset "$preset" --config "$yaml" --port "$bg_port" \
    >"$work/babelgate-$preset.log" 2>&1 &
  pid=$!
  bg_pids+=("$pid")
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$bg_port/health" >/dev/null 2>&1 && return 0
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  echo "REPLAY FAIL: babelgate did not become healthy ($preset)" >&2
  tail -20 "$work/babelgate-$preset.log" >&2 || true
  return 1
}

claude_gate=FAIL
if PATH="$bindir:$PATH" \
  scripts/gates/claude-code-edit.sh config examples/claude-code-openrouter.yaml \
  >"$work/claude-gate.log" 2>&1; then
  claude_gate=PASS
fi

codex_gate=FAIL
if PATH="$bindir:$PATH" \
  scripts/gates/codex-edit.sh config examples/codex-openrouter.yaml \
  >"$work/codex-gate.log" 2>&1; then
  codex_gate=PASS
fi

start_babelgate examples/claude-code-openrouter.yaml claude-code
claude_jsonl="$work/claude.jsonl"
claude_record=FAIL
if CLAUDE_BIN="$bindir/claude" RECORD_OUT="$claude_jsonl" \
  scripts/gates/record-claude-code.sh thinking \
  --upstream "http://localhost:$bg_port" \
  >"$work/claude-record.log" 2>&1; then
  claude_record=PASS
fi
if claude_diff="$(./node_modules/.bin/ts-node scripts/gates/shape-diff.ts \
  "$claude_jsonl" tests/fixtures/recordings/claude-code-thinking.jsonl 2>&1)"; then
  claude_diff_rc=0
else
  claude_diff_rc=$?
fi

start_babelgate examples/codex-openrouter.yaml openai-apps
codex_jsonl="$work/codex.jsonl"
codex_record=FAIL
if CODEX_BIN="$bindir/codex" RECORD_OUT="$codex_jsonl" \
  scripts/gates/record-codex.sh \
  --upstream "http://localhost:$bg_port/v1" --model qwen/qwen3-coder \
  >"$work/codex-record.log" 2>&1; then
  codex_record=PASS
fi
if codex_diff="$(./node_modules/.bin/ts-node scripts/gates/shape-diff.ts \
  "$codex_jsonl" tests/fixtures/codex/recording.jsonl 2>&1)"; then
  codex_diff_rc=0
else
  codex_diff_rc=$?
fi

diff_cell() {
  # $1 = diff output, $2 = rc → "N added, M removed" (+" (FAIL)" when
  # additions made shape-diff exit 1), "diff error" otherwise.
  local totals
  totals="$(printf '%s\n' "$1" | grep -o '[0-9]* added, [0-9]* removed' | head -1 || true)"
  case "$2" in
    0) echo "${totals:-clean}" ;;
    1) echo "${totals:-added shapes} (FAIL)" ;;
    *) echo "diff error" ;;
  esac
}
claude_cell="$(diff_cell "$claude_diff" "$claude_diff_rc")"
codex_cell="$(diff_cell "$codex_diff" "$codex_diff_rc")"

{
  echo "## Weekly client-release replay"
  echo
  echo "- claude-code: \`$claude_version\` (@latest)"
  echo "- codex: \`$codex_version\` (@latest)"
  echo
  echo "| client | edit-task gate | recorded run | shape diff |"
  echo "|---|---|---|---|"
  echo "| claude-code | $claude_gate | $claude_record | $claude_cell |"
  echo "| codex | $codex_gate | $codex_record | $codex_cell |"
  echo
  echo "### claude-code shape diff"
  echo '```'
  printf '%s\n' "$claude_diff"
  echo '```'
  echo "### codex shape diff"
  echo '```'
  printf '%s\n' "$codex_diff"
  echo '```'
} > "$out_dir/summary.md"
printf '%s / %s\n' "$claude_version" "$codex_version" > "$out_dir/versions.txt"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$out_dir/summary.md" >> "$GITHUB_STEP_SUMMARY"
fi
cat "$out_dir/summary.md"

# Diagnostics: stage the artifacts where the workflow's upload step
# reads them and tail each failed sub-run's log into the job log.
REPLAY_WORK_DIR="$work" \
REPLAY_SUMMARY="$out_dir/summary.md" \
ARTIFACT_DIR="$PWD/tmp/client-replay" \
CLAUDE_GATE="$claude_gate" CODEX_GATE="$codex_gate" \
CLAUDE_RECORD="$claude_record" CODEX_RECORD="$codex_record" \
  scripts/gates/client-replay-artifacts.sh

failures=0
for v in "$claude_gate" "$codex_gate" "$claude_record" "$codex_record"; do
  [ "$v" = PASS ] || failures=$((failures + 1))
done
failures=$((failures + claude_diff_rc + codex_diff_rc))
if [ "$failures" -gt 0 ]; then
  echo "REPLAY FAIL: $failures failing check(s)" >&2
  exit 1
fi
echo "REPLAY PASS"
