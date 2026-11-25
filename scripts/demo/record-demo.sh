#!/usr/bin/env bash
# Usage: GEMINI_API_KEY=... scripts/demo/record-demo.sh   → docs/assets/demo.gif
#
# Records demo.tape: Claude Code through the release binary on the
# Gemini free preset (--provider gemini-free, the preset's proven
# suggested model — "free" per the provider's docs, verified
# 2026-11-22; see PROVIDER_PRESETS).
#
# The tape types `babelgate …`, so the binary must be on PATH: this
# script symlinks BABELGATE_BIN (or a freshly built dist-bin/babelgate)
# into /tmp/babelgate-bin and prepends it to PATH for vhs's shell.
set -euo pipefail
: "${GEMINI_API_KEY:?set GEMINI_API_KEY (free key from https://aistudio.google.com/apikey)}"
command -v vhs >/dev/null 2>&1 || {
  echo "record-demo: vhs not found on PATH (https://github.com/charmbracelet/vhs)" >&2
  exit 1
}
command -v claude >/dev/null 2>&1 || {
  echo "record-demo: claude not found on PATH (Claude Code)" >&2
  exit 1
}
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"

# BABELGATE_BIN points at a release binary (e.g. one installed by
# install.sh); otherwise build dist-bin/babelgate from this tree so the
# demo runs the same code the PR ships.
BIN="${BABELGATE_BIN:-$ROOT/dist-bin/babelgate}"
[ -x "$BIN" ] || (cd "$ROOT" && npm run build:binary)
[ -x "$BIN" ] || { echo "record-demo: $BIN is not executable" >&2; exit 1; }
mkdir -p /tmp/babelgate-bin
ln -sf "$BIN" /tmp/babelgate-bin/babelgate
export PATH="/tmp/babelgate-bin:$PATH"

cleanup() {
  # The tape starts babelgate in the background of its own shell; kill
  # it by command line whether the recording succeeds, fails or is cut.
  pkill -f "babelgate --preset" 2>/dev/null || true
}
trap cleanup EXIT

cd ~ && rm -rf /tmp/babelgate-demo
cp -R "$ROOT/scripts/gates/fixtures/edit-task" /tmp/babelgate-demo
vhs "$HERE/demo.tape"
mkdir -p "$ROOT/docs/assets" && mv /tmp/babelgate-demo.gif "$ROOT/docs/assets/demo.gif"
