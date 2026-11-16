#!/usr/bin/env bash
# Usage: OPENROUTER_API_KEY=... scripts/demo/record-codex-demo.sh   → docs/assets/demo-codex.gif
set -euo pipefail
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY (the demo routes to the OpenRouter Anthropic endpoint)}"
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

cleanup() {
  # The tape starts babelgate in the background of its own shell; kill it
  # by command line whether the recording succeeds, fails or is cut short.
  pkill -f "codex-anthropic.yaml" 2>/dev/null || true
}
trap cleanup EXIT

cd ~ && rm -rf "$DEMO"
cp -R "$ROOT/scripts/gates/fixtures/edit-task" "$DEMO"
cp "$ROOT/examples/codex-anthropic.yaml" "$DEMO/codex-anthropic.yaml"
cp "$ROOT/examples/codex-model-catalog.json" "$DEMO/codex-model-catalog.json"

# Scratch CODEX_HOME inside the demo dir — the real ~/.codex is never
# touched. Same provider block as docs/recipes/codex.md plus the release
# gate's settings (scripts/gates/codex-edit.sh): the catalog entry gives
# the "babelgate" model the apply_patch tool, approval/sandbox let the
# exec run write files and run npm test without asking.
mkdir -p "$DEMO/codex-home"
cat > "$DEMO/codex-home/config.toml" <<EOF
model = "babelgate"
model_provider = "babelgate"
model_reasoning_effort = "medium"
model_catalog_json = "$DEMO/codex-model-catalog.json"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.babelgate]
name = "babelgate"
base_url = "http://localhost:3000/v1"
wire_api = "responses"
env_key = "BABELGATE_KEY"
requires_openai_auth = false
EOF

vhs "$HERE/codex.tape"
mkdir -p "$ROOT/docs/assets" && mv /tmp/babelgate-codex-demo.gif "$ROOT/docs/assets/demo-codex.gif"
