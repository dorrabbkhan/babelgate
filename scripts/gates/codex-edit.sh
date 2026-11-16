#!/usr/bin/env bash
# Codex CLI edit gate (v1.4 spec §4.5, D4 — release gates A/B/C):
# copies the failing edit-task fixture to a temp dir, starts babelgate
# with the gate's YAML, lets Codex fix the bug through the proxy (the
# Responses wire format via a scratch CODEX_HOME), then runs the
# fixture's npm test itself. Pass = GATE PASS (+ OBSERVE PASS when
# OBSERVE_CHECK is set).
#
#   scripts/gates/codex-edit.sh config <path-to-yaml> [model-label]
#
# Real upstreams only — this script makes network calls. `config`
# mode takes whatever env the YAML file's api_key_env entries name
# (GEMINI_API_KEY for examples/codex-gemini.yaml, OPENROUTER_API_KEY
# for codex-anthropic.yaml / codex-openrouter.yaml). Keys are never
# printed.
#
# The scratch config.toml carries the gate's Codex settings (owner
# decision A, docs/conductor/notes/v1.4/task14.md): an unrecognized
# model slug gets Codex's fallback metadata — no apply_patch tool and
# no reasoning.effort (spec §1.2 E12) — so the gate points
# `model_catalog_json` at a catalog whose entry for `model` carries
# `apply_patch_tool_type: "freeform"` and `use_responses_lite: false`,
# and sets `model_reasoning_effort` so reasoning.effort is sent.
# Env overrides: CODEX_MODEL (default "babelgate" — must match the
# catalog entry's slug), CODEX_MODEL_CATALOG (catalog JSON path,
# default examples/codex-model-catalog.json; empty omits the key),
# CODEX_REASONING_EFFORT (default "medium"; empty omits the key).
# `web_search = "disabled"` is always set — built-in tools are
# dropped on the bridge (spec §2.2).
#
# OBSERVE_CHECK: after the edit task, run scripts/gates/observe-check.ts
# against the still-running instance. `1` enables it with
# `--client codex`; any other value is appended as extra flags (e.g.
# OBSERVE_CHECK="--expect-cost --expect-no-note reasoning_dropped"
# for gates A/B, "--expect-cost --expect-passthrough" for gate C).
# The config-derived flags work as in claude-code-edit.sh:
# live_prices → --expect-cost, ≥2 providers → --expect-providers in
# file order, would_cost_reference → --expect-saved. USAGE_DB always
# points at a temp file so every row the check sees is from this run.
#
# Codex binary: CODEX_BIN, then `codex` on PATH, then
# `npx -y @openai/codex@$CODEX_VERSION` — the recordings and spec
# E12–E19 are for codex-cli 0.169.0 (CODEX_VERSION, default 0.169.0);
# a CODEX_BIN/PATH codex reporting another version gets a GATE WARN
# but still runs. CODEX_TIMEOUT_S is a hard cap on the `codex exec`
# run (default 900 — Codex retries a dead upstream forever).
# CODEX_EDIT_DRY_RUN=1 prints the generated config.toml and exits
# before starting babelgate or Codex.
set -euo pipefail

# Caller's cwd, captured before the cd: `config` resolves a relative
# YAML path (and CODEX_MODEL_CATALOG a relative catalog path) against
# it.
caller_pwd="$PWD"
cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
PROMPT="Make the failing test pass. Run npm test to check your work."

usage() {
  echo "usage: $0 config <path-to-yaml> [model-label]" >&2
}

[ "${1:-}" = "config" ] || { usage; exit 2; }
shift
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

# codex binary: CODEX_BIN, then PATH, then npx pinned to
# CODEX_VERSION — see the header note on the version pin.
CODEX_VERSION="${CODEX_VERSION:-0.169.0}"
if [ -n "${CODEX_BIN:-}" ]; then
  codex_cmd=("$CODEX_BIN")
elif command -v codex >/dev/null 2>&1; then
  codex_cmd=(codex)
else
  codex_cmd=(npx -y "@openai/codex@$CODEX_VERSION")
fi

codex_version_warn=""
if [ "${codex_cmd[0]}" != "npx" ]; then
  reported="$("${codex_cmd[@]}" --version 2>/dev/null | head -1 || true)"
  if [ "$reported" != "codex-cli $CODEX_VERSION" ]; then
    codex_version_warn="GATE WARN: ${reported:-codex-cli version unknown} != pinned $CODEX_VERSION (recordings/evidence are for $CODEX_VERSION)"
    echo "$codex_version_warn" >&2
  fi
fi

# The gate model's catalog entry (owner decision A): must exist and
# parse as JSON, or the model falls back to metadata without
# apply_patch — exactly what the gate is meant to exercise.
catalog="${CODEX_MODEL_CATALOG-$PWD/examples/codex-model-catalog.json}"
if [ -n "$catalog" ]; then
  case "$catalog" in
    /*) ;;
    *) catalog="$caller_pwd/$catalog" ;;
  esac
  if [ ! -f "$catalog" ]; then
    echo "GATE FAIL: model catalog not found: $catalog" >&2
    exit 1
  fi
fi

effort="${CODEX_REASONING_EFFORT-medium}"
codex_model="${CODEX_MODEL:-babelgate}"

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

mkdir -p "$work/edit-task" "$work/codex-home" "$work/home"
cp -R "$FIXTURE"/. "$work/edit-task/"

# A free port: let the OS pick one by asking node.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# Scratch CODEX_HOME (the real ~/.codex stays untouched). The
# provider block mirrors docs/recipes/codex.md; env_key names the env
# var Codex reads the client-facing key from — set to the printed
# export token at codex-run time below. approval_policy/sandbox_mode
# match record-codex.sh's --yolo equivalent: the edit task must write
# files and run npm test without asking.
{
  echo "model = \"$codex_model\""
  echo "model_provider = \"babelgate\""
  [ -n "$effort" ] && echo "model_reasoning_effort = \"$effort\""
  [ -n "$catalog" ] && echo "model_catalog_json = \"$catalog\""
  echo "web_search = \"disabled\""
  echo "approval_policy = \"never\""
  echo "sandbox_mode = \"danger-full-access\""
  echo ""
  echo "[model_providers.babelgate]"
  echo "name = \"babelgate\""
  echo "base_url = \"http://localhost:$port/v1\""
  echo "wire_api = \"responses\""
  echo "env_key = \"BABELGATE_KEY\""
  echo "requires_openai_auth = false"
} > "$work/codex-home/config.toml"

if [ "${CODEX_EDIT_DRY_RUN:-}" = "1" ]; then
  echo "CODEX_EDIT_DRY_RUN: generated config.toml:"
  cat "$work/codex-home/config.toml"
  exit 0
fi

npm run --silent build

# USAGE_DB points the usage store at a temp file (deleted on exit) so
# every row observe-check sees is from this run — the owner's real
# ~/.babelgate/usage.db is untouched and "since start" is exact.
# env -u PROXY_API_KEY on the launch: an exported PROXY_API_KEY would
# make /ui/api require that key (src/ui-api/access.ts rule 4) and
# observe-check would 403 on a healthy run. NODE_ENV=production: the
# routing summary below parses the route log lines as JSON
# (pino-pretty is dev-only), and production also keeps upstream body
# previews out of the log.
NODE_ENV=production \
  USAGE_DB="$work/usage.db" \
  env -u PROXY_API_KEY \
  node dist/cli.js --preset openai-apps --config "$config_path" --port "$port" \
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

# The client export line the CLI printed — the client-facing proxy
# token (not an upstream key); Codex sends it via env_key.
token="$(grep -m1 '^export OPENAI_API_KEY=' "$work/babelgate.log" | cut -d= -f2- || true)"
if [ -z "$token" ]; then
  echo "GATE FAIL: babelgate did not print the client export lines" >&2
  tail -20 "$work/babelgate.log" >&2 || true
  exit 1
fi

# Non-interactive Codex run. --skip-git-repo-check: the temp fixture
# copy is not a git repo and Codex refuses to run outside one.
# npm_config_cache/HOME point at scratch dirs so nothing writes to
# the real ~/.npm or ~/.codex. timeout + </dev/null: Codex retries an
# unreachable upstream forever, so the run gets a hard cap (TERM,
# then KILL after 30s) and no stdin to block on.
(
  cd "$work/edit-task"
  env -u PROXY_API_KEY \
    HOME="$work/home" \
    CODEX_HOME="$work/codex-home" \
    BABELGATE_KEY="$token" \
    npm_config_cache="$npm_cache" \
    timeout -k 30 "${CODEX_TIMEOUT_S:-900}" \
      "${codex_cmd[@]}" exec --skip-git-repo-check "$PROMPT" \
      </dev/null >"$work/codex.log" 2>&1
) || true

pass=""
if (cd "$work/edit-task" && npm test) >"$work/npm-test.log" 2>&1; then
  pass=1
fi

elapsed="$(( $(date +%s) - started ))"
echo "codex version: $(npm_config_cache="$npm_cache" "${codex_cmd[@]}" --version 2>&1 | head -1)"
if [ -n "$codex_version_warn" ]; then
  echo "$codex_version_warn"
fi
echo "model: $model (codex model: $codex_model, effort: ${effort:-none})"
# A "Model metadata ... not found" warning means the catalog entry
# did not resolve — the run had no apply_patch and no default effort.
metadata_warning="$(grep "Model metadata" "$work/codex.log" 2>/dev/null | head -1 || true)"
if [ -n "$metadata_warning" ]; then
  echo "codex warning: $metadata_warning"
fi
echo "duration: ${elapsed}s"
# Routing summary for the decisions record: count the "Request
# completed" route log lines (src/routing/route-log.ts) by winner and
# by reason, plus the multi-hop (fallback) count. The log is JSON
# (NODE_ENV=production above); non-JSON lines — the client exports
# and the routing table — are skipped. Only these aggregate fields
# are printed: no prompt text, model output or keys.
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

# The release gates' observability half (spec §4.5): OBSERVE_CHECK
# enables it — see the header comment for the derived and extra flags.
observe_failed=0
if [ -n "${OBSERVE_CHECK:-}" ] && [ "$OBSERVE_CHECK" != "0" ]; then
  obs_args=(--base "http://localhost:$port" --client codex --since "$started_ms")
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
  echo "--- codex output (tail) ---" >&2
  tail -30 "$work/codex.log" >&2 || true
  echo "--- npm test output (tail) ---" >&2
  tail -15 "$work/npm-test.log" >&2 || true
  exit 1
fi
