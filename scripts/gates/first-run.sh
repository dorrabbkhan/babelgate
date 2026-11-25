#!/usr/bin/env bash
# First-run gate (v1.6 spec §4, gate F; Task 17): install babelgate
# with the given one-liner, start it on a client+provider preset,
# apply the exports/config.toml it prints exactly as a stranger
# would, then run the same edit task claude-code-edit.sh /
# codex-edit.sh prove (same fixture, same client invocation, same
# npm-test verdict — those scripts cannot be reused directly because
# each owns its own proxy lifecycle). Prints one final FIRST_RUN
# line with the wall-clock setup time.
#
#   scripts/gates/first-run.sh [--dry-run] [--docker] <install-cmd> <preset> <client>
#
# <install-cmd> is ONE argument — the install one-liner a stranger
# runs: "npm install -g babelgate", "npm install -g ." (repo tarball
# path), "npx -y babelgate", "sh install/install.sh", "brew install
# dorrabbkhan/babelgate/babelgate". BABELGATE overrides how the
# installed product is invoked afterwards (default "babelgate"; e.g.
# BABELGATE="npx -y babelgate" for the npx path). $HOME/.local/bin is
# added to PATH so install.sh's default target is found.
#
# <preset> is a provider preset name (see `babelgate presets`),
# <client> is claude-code or codex. The preset's key env var must be
# set in the environment; its value is never printed, and neither
# are prompt bodies or completions.
#
# The whole run uses a fresh `mktemp -d` as HOME: ~/.babelgate,
# ~/.codex, ~/.claude and the npm cache all land in scratch, so the
# run measures a real first run and touches nothing of the caller's
# home. Host mode requires the client binary (claude / codex) on
# PATH — the gate measures babelgate's setup, not the client's
# install, like a stranger who already has the client.
#
# --docker re-runs the script inside `docker run --rm node:24` with
# the repo mounted (the Linux leg of gate F). The client CLI is
# npm-installed inside the container first — untimed prep, same as a
# stranger who has it. Every *_API_KEY env var is forwarded by name.
#
# FIRST_RUN setup_seconds is measured on a monotonic clock
# (performance.now()): from the install command's start to the
# printed exports/config applied and babelgate healthy. The edit
# task runs untimed — gate F's minute is setup time.
#
# --dry-run / FIRST_RUN_DRY_RUN=1 prints the commands it would run
# and exits 0 — offline-safe; scripts/gates/first-run.test.ts
# exercises this mode.
set -euo pipefail
cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
PROMPT="Make the failing test pass. Run npm test to check your work."

usage() {
  echo "usage: $0 [--dry-run] [--docker] <install-cmd> <preset> <claude-code|codex>" >&2
}

dry_run="${FIRST_RUN_DRY_RUN:-0}"
docker_mode="${FIRST_RUN_DOCKER:-0}"
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --docker) docker_mode=1 ;;
    -*) usage; exit 2 ;;
    *) positional+=("$1") ;;
  esac
  shift
done
set -- ${positional[@]+"${positional[@]}"}
install_cmd="${1:-}"
preset="${2:-}"
client="${3:-}"
if [ -z "$install_cmd" ] || [ -z "$preset" ] || [ -z "$client" ] || [ $# -gt 3 ]; then
  usage
  exit 2
fi
case "$client" in
  claude-code) client_bin=claude; client_pkg="@anthropic-ai/claude-code" ;;
  codex) client_bin=codex; client_pkg="@openai/codex" ;;
  *) usage; exit 2 ;;
esac

# A monotonic millisecond clock (performance.now() — immune to
# wall-clock adjustments, unlike `date +%s`).
now_ms() {
  node -e 'process.stdout.write(String(Math.round(performance.now())))'
}

# The one FIRST_RUN line every path ends on. setup_seconds is frozen
# when the exports/config are applied (setup complete); an earlier
# failure reports the elapsed time instead.
setup_seconds=""
start_ms=""
result_line() {
  local s="$setup_seconds"
  if [ -z "$s" ]; then
    if [ -n "$start_ms" ]; then
      s=$(( ($(now_ms) - start_ms + 500) / 1000 ))
    else
      s=0
    fi
  fi
  echo "FIRST_RUN setup_seconds=${s} client=${client} preset=${preset} result=$1"
}

fail() {
  echo "FIRST_RUN FAIL: $*" >&2
  result_line FAIL
  exit 1
}

# --docker: re-execute inside a clean node:24 with the repo mounted.
# Provider keys are forwarded by NAME only (docker -e NAME reads the
# host's value); FIRST_RUN_INSIDE_DOCKER guards recursion.
if [ "$docker_mode" = "1" ] && [ "${FIRST_RUN_INSIDE_DOCKER:-0}" != "1" ]; then
  docker_env=(FIRST_RUN_INSIDE_DOCKER=1)
  while IFS= read -r name; do
    docker_env+=("$name")
  done < <(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*API_KEY\)=.*/\1/p')
  for name in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    [ -n "${!name:-}" ] && docker_env+=("$name")
  done
  docker_args=()
  for name in "${docker_env[@]}"; do
    docker_args+=(-e "$name")
  done
  [ -n "${BABELGATE:-}" ] && docker_args+=(-e "BABELGATE=${BABELGATE}")
  quoted="$(printf '%q ' "$install_cmd" "$preset" "$client")"
  # The client install is untimed prep; `;` not `&&` so a failed
  # install still reaches the script's own not-on-PATH FAIL line.
  inner="npm install -g ${client_pkg} >/dev/null; bash scripts/gates/first-run.sh ${quoted}"
  if [ "$dry_run" = "1" ]; then
    echo "FIRST_RUN_DRY_RUN: would run:"
    echo "  docker run --rm -v $PWD:/babelgate -w /babelgate ${docker_args[*]} node:24 bash -c '$inner'"
    exit 0
  fi
  command -v docker >/dev/null 2>&1 ||
    fail "docker not found on PATH (the --docker leg of gate F needs it)"
  exec docker run --rm -v "$PWD:/babelgate" -w /babelgate "${docker_args[@]}" \
    node:24 bash -c "$inner"
fi

if [ "$dry_run" = "1" ]; then
  bg="${BABELGATE:-babelgate}"
  echo "FIRST_RUN_DRY_RUN: would run (HOME = fresh mktemp -d, \$HOME/.local/bin on PATH):"
  echo "  <install>    $install_cmd"
  echo "  <key check>  $bg presets   (reads the preset's 'key env' name; the value is never printed)"
  echo "  <babelgate>  $bg --preset $client --provider $preset --port <free port>"
  echo "  <readiness>  curl http://localhost:<port>/health (up to 30 s)"
  case "$client" in
    claude-code)
      echo "  <apply>      export ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN [/ CLAUDE_CODE_MAX_OUTPUT_TOKENS] from babelgate's stdout"
      echo "  <client>     (cd <scratch>/edit-task && env -u ANTHROPIC_API_KEY -u ANTHROPIC_MODEL ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=... claude -p --permission-prompts none --allowedTools \"Edit\" \"Write\" \"Bash(npm test)\" --strict-mcp-config --setting-sources local \"<prompt>\")"
      ;;
    codex)
      echo "  <apply>      write babelgate's printed config.toml block to \$HOME/.codex/config.toml (plus the gate's non-interactive approval keys) and export BABELGATE_KEY"
      echo "  <client>     (cd <scratch>/edit-task && CODEX_HOME=\$HOME/.codex BABELGATE_KEY=... codex exec --skip-git-repo-check \"<prompt>\")"
      ;;
  esac
  echo "  <verify>     (cd <scratch>/edit-task && npm test)"
  echo "  <report>     FIRST_RUN setup_seconds=<n> client=$client preset=$preset result=<PASS|FAIL>"
  exit 0
fi

for dep in node curl "$client_bin"; do
  command -v "$dep" >/dev/null 2>&1 ||
    fail "$dep not found on PATH (gate F needs node + curl, and the client installed — it measures babelgate's setup)"
done

work="$(mktemp -d)"
export HOME="$work/home"
export PATH="$HOME/.local/bin:$PATH"
npm_cache="$work/npm-cache"
export npm_config_cache="$npm_cache"
proxy_pid=""

# shellcheck disable=SC2317,SC2329 # invoked indirectly via `trap cleanup EXIT`
cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$HOME" "$work/edit-task"
cp -R "$FIXTURE"/. "$work/edit-task/"

start_ms="$(now_ms)"

# 1. The install one-liner, exactly as a stranger runs it.
bash -c "$install_cmd" || fail "install command failed: $install_cmd"

# 2. How the product is invoked from here on (BABELGATE override).
read -r -a bg_cmd <<< "${BABELGATE:-babelgate}"
command -v "${bg_cmd[0]}" >/dev/null 2>&1 ||
  fail "${bg_cmd[0]} not found on PATH after install (set BABELGATE to the invocation)"

# 3. The preset's key env var name, from the installed product's own
#    `presets` output ("key env NAME" / "keyless") — never the value.
key_env="$("${bg_cmd[@]}" presets 2>/dev/null \
  | sed -n "s/^${preset} (tier [a-z]*, key env \([A-Za-z_][A-Za-z0-9_]*\)).*/\1/p" \
  || true)"
if [ -n "$key_env" ] && [ -z "${!key_env:-}" ]; then
  fail "$key_env is not set (preset $preset reads its key from it)"
fi

# 4. Start babelgate on a free port (the OS picks one), as the
#    first-run flags document. USAGE_DB in scratch; PROXY_API_KEY
#    unset so /ui access rules match a stranger's machine.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
USAGE_DB="$work/usage.db" \
  env -u PROXY_API_KEY \
  "${bg_cmd[@]}" --preset "$client" --provider "$preset" --port "$port" \
  >"$work/babelgate.log" 2>&1 &
proxy_pid=$!

ready=""
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$proxy_pid" 2>/dev/null || break
  sleep 1
done
if [ -z "$ready" ]; then
  tail -20 "$work/babelgate.log" >&2 || true
  fail "babelgate did not become healthy on :$port (missing key prints its guidance above)"
fi

# 5. Apply the printed exports/config the way a user would.
client_env=()
case "$client" in
  claude-code)
    base_url="$(grep -m1 '^export ANTHROPIC_BASE_URL=' "$work/babelgate.log" | cut -d= -f2- || true)"
    token="$(grep -m1 '^export ANTHROPIC_AUTH_TOKEN=' "$work/babelgate.log" | cut -d= -f2- || true)"
    max_out="$(grep -m1 '^export CLAUDE_CODE_MAX_OUTPUT_TOKENS=' "$work/babelgate.log" | cut -d= -f2- || true)"
    if [ -z "$base_url" ] || [ -z "$token" ]; then
      fail "babelgate did not print the claude-code export lines"
    fi
    client_env=(ANTHROPIC_BASE_URL="$base_url" ANTHROPIC_AUTH_TOKEN="$token")
    [ -n "$max_out" ] && client_env+=("CLAUDE_CODE_MAX_OUTPUT_TOKENS=$max_out")
    ;;
  codex)
    token="$(grep -m1 '^export BABELGATE_KEY=' "$work/babelgate.log" | cut -d= -f2- || true)"
    [ -n "$token" ] ||
      fail "babelgate did not print the codex export line"
    # The printed block between the paste markers — verbatim, plus
    # the approval keys the proven gate uses (codex-edit.sh): a real
    # user approves interactively; `codex exec` cannot ask. They are
    # top-level keys, so they are inserted before the first
    # [model_providers] table.
    sed -n '/^Paste into ~\/.codex\/config.toml:$/,/^--- end of config.toml block ---$/p' \
      "$work/babelgate.log" | sed '1d;$d' > "$work/config-block.toml"
    [ -s "$work/config-block.toml" ] ||
      fail "babelgate did not print the config.toml block"
    mkdir -p "$HOME/.codex"
    awk '
      /^\[/ && !done { print "approval_policy = \"never\""; print "sandbox_mode = \"danger-full-access\""; print ""; done=1 }
      { print }
    ' "$work/config-block.toml" > "$HOME/.codex/config.toml"
    client_env=(BABELGATE_KEY="$token")
    ;;
esac

# Setup ends here: installed, running, client pointed at it.
setup_seconds=$(( ($(now_ms) - start_ms + 500) / 1000 ))

# 6. The edit task — same fixture copy, same non-interactive client
#    invocation and same npm-test verdict as claude-code-edit.sh /
#    codex-edit.sh.
case "$client" in
  claude-code)
    (
      cd "$work/edit-task"
      env -u ANTHROPIC_API_KEY -u ANTHROPIC_MODEL \
        "${client_env[@]}" \
        "$client_bin" -p \
          --permission-prompts none \
          --allowedTools "Edit" "Write" "Bash(npm test)" \
          --strict-mcp-config \
          --setting-sources local \
          "$PROMPT" \
          </dev/null >"$work/client.log" 2>&1
    ) || true
    ;;
  codex)
    (
      cd "$work/edit-task"
      env -u PROXY_API_KEY \
        HOME="$HOME" \
        CODEX_HOME="$HOME/.codex" \
        "${client_env[@]}" \
        npm_config_cache="$npm_cache" \
        timeout -k 30 "${CODEX_TIMEOUT_S:-900}" \
          "$client_bin" exec --skip-git-repo-check "$PROMPT" \
          </dev/null >"$work/client.log" 2>&1
    ) || true
    ;;
esac

pass=""
if (cd "$work/edit-task" && npm test) >"$work/npm-test.log" 2>&1; then
  pass=1
fi

if [ -n "$pass" ]; then
  result_line PASS
  exit 0
fi
echo "--- client output (tail) ---" >&2
tail -30 "$work/client.log" >&2 || true
echo "--- npm test output (tail) ---" >&2
tail -15 "$work/npm-test.log" >&2 || true
result_line FAIL
exit 1
