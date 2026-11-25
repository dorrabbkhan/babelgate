#!/usr/bin/env bash
# Usage: GEMINI_API_KEY=... scripts/demo/record-codex-demo.sh   → docs/assets/demo-codex.gif
#
# Records codex.tape: Codex through the release binary on the Gemini
# free preset (--preset codex --provider gemini-free prints the key
# line, writes the model catalog under ~/.babelgate and prints the
# config.toml block — the demo writes that same block, plus exec-mode
# settings, into a scratch CODEX_HOME).
#
# The tape types `babelgate …`, so the binary must be on PATH: this
# script symlinks BABELGATE_BIN (or a freshly built dist-bin/babelgate)
# into /tmp/babelgate-bin and prepends it to PATH for vhs's shell.
set -euo pipefail
: "${GEMINI_API_KEY:?set GEMINI_API_KEY (free key from https://aistudio.google.com/apikey)}"
command -v vhs >/dev/null 2>&1 || {
  echo "record-codex-demo: vhs not found on PATH (https://github.com/charmbracelet/vhs)" >&2
  exit 1
}
command -v codex >/dev/null 2>&1 || {
  echo "record-codex-demo: codex not found on PATH (npm install -g @openai/codex)" >&2
  exit 1
}
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
DEMO=/tmp/babelgate-codex-demo

# BABELGATE_BIN points at a release binary (e.g. one installed by
# install.sh); otherwise build dist-bin/babelgate from this tree so the
# demo runs the same code the PR ships.
BIN="${BABELGATE_BIN:-$ROOT/dist-bin/babelgate}"
[ -x "$BIN" ] || (cd "$ROOT" && npm run build:binary)
[ -x "$BIN" ] || { echo "record-codex-demo: $BIN is not executable" >&2; exit 1; }
mkdir -p /tmp/babelgate-bin
ln -sf "$BIN" /tmp/babelgate-bin/babelgate
export PATH="/tmp/babelgate-bin:$PATH"

cleanup() {
  # The tape starts babelgate in the background of its own shell; kill it
  # by command line whether the recording succeeds, fails or is cut short.
  pkill -f "babelgate --preset" 2>/dev/null || true
}
trap cleanup EXIT

cd ~ && rm -rf "$DEMO"
cp -R "$ROOT/scripts/gates/fixtures/edit-task" "$DEMO"

# Scratch CODEX_HOME inside the demo dir — the real ~/.codex is never
# touched. This is the block `--preset codex` prints for the preset's
# suggested codex model (gemini-3.8-flash under gemini-free), with the
# release gate's exec settings added (scripts/gates/codex-edit.sh):
# approval/sandbox let the exec run write files and run npm test without
# asking, and model_catalog_json points at the catalog the binary writes
# under the real ~/.babelgate so the model keeps full metadata
# (apply_patch, reasoning levels).
mkdir -p "$DEMO/codex-home"
cat > "$DEMO/codex-home/config.toml" <<EOF
model = "gemini-3.8-flash"
model_provider = "babelgate"
model_reasoning_effort = "medium"
model_reasoning_summary = "auto"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "danger-full-access"
model_catalog_json = "$HOME/.babelgate/codex-model-catalog.json"

[model_providers.babelgate]
name = "babelgate"
base_url = "http://localhost:3000/v1"
wire_api = "responses"
env_key = "BABELGATE_KEY"
requires_openai_auth = false
EOF

vhs "$HERE/codex.tape"
mkdir -p "$ROOT/docs/assets" && mv /tmp/babelgate-codex-demo.gif "$ROOT/docs/assets/demo-codex.gif"
