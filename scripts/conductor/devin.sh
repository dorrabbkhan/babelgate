#!/usr/bin/env bash
# Usage: devin.sh <kind: task|review|fix> <version> <task> [extra prompt file]
# Runs a fresh, non-interactive local Devin session; saves prompt + output; prints output.
# VERIFY the flags below with `devin --help` on your version and adjust DEVIN_CMD once.
# `--sandbox` alone is enough: Devin always runs autonomously under it and ignores
# --permission-mode (prints "ignoring --permission-mode …"); `devin --help` lists no
# "bypass" mode anyway (auto|accept-edits|smart|dangerous).
set -euo pipefail
KIND="$1"; VER="$2"; N="$3"; EXTRA="${4:-}"
DIR="$HOME/babelgate-conductor/${VER}-task${N}"; mkdir -p "$DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEVIN_CMD=(devin --sandbox -p)
# Devin acts as the babelgate-conductor GitHub App, never as the owner.
# shellcheck disable=SC1091
source "$(dirname "$0")/app-env.sh"
PROMPT="$DIR/${KIND}-${STAMP}.prompt.md"
if [ -n "$EXTRA" ]; then cp "$EXTRA" "$PROMPT"; else cat > "$PROMPT"; fi
( cd "${REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && "${DEVIN_CMD[@]}" --prompt-file "$PROMPT" ) 2>&1 | tee "$DIR/${KIND}-${STAMP}.out.md"
