#!/usr/bin/env bash
# Usage: devin.sh <kind: task|review|fix> <version> <task> [extra prompt file]
# Runs a fresh, non-interactive local Devin session; saves prompt + output; prints output.
# VERIFY the flags below with `devin --help` on your version and adjust DEVIN_CMD once.
# `--sandbox` keeps Devin autonomous only inside the repository: it ignores --permission-mode
# (prints "ignoring --permission-mode …"), and a tool call that needs confirmation (seen with a
# worktree at /tmp/bg-main, v1.3 Task 5) is rejected in -p mode and ends the session
# ("rejected a tool call that requires confirmation"). standing-notes.md tells Devin to keep
# worktrees under .claude/worktrees/. Don't switch to --permission-mode dangerous for this.
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
REPO_DIR="${REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
# Devin checks its task branch out in the shared checkout and leaves it there. Put the checkout
# back on the branch it started on, so the conductor and the next session start from there.
# Only when no tracked file is modified: never discard or carry over a session's work.
ORIG="$(git -C "$REPO_DIR" symbolic-ref --short -q HEAD || git -C "$REPO_DIR" rev-parse HEAD)"
OUT="$DIR/${KIND}-${STAMP}.out.md"
# Restore messages go to stderr AND the end of the saved output, so a caller that discards
# stderr still sees them when it reads the .out.md file.
note() { echo ">>> devin.sh: $*" | tee -a "$OUT" >&2; }
restore_checkout() {
  # Leftover worktrees outside .claude/worktrees/ (stale "prunable" entries skipped): a session
  # that leaves one may have died on a sandbox confirmation, and one holding $ORIG blocks the
  # restore below.
  local wt
  wt="$(git -C "$REPO_DIR" worktree list --porcelain | awk '
    /^worktree /{p=substr($0,10); bad=0} /^prunable/{bad=1}
    /^$/{if(p!="" && !bad) print p; p=""} END{if(p!="" && !bad) print p}' \
    | grep -v -x -F "$REPO_DIR" | grep -v -F '/.claude/worktrees/' || true)"
  [ -z "$wt" ] || note "worktrees outside .claude/worktrees/ after the session: $(echo "$wt" | tr '\n' ' ')"
  local now
  now="$(git -C "$REPO_DIR" symbolic-ref --short -q HEAD || git -C "$REPO_DIR" rev-parse HEAD)"
  [ "$now" = "$ORIG" ] && return 0
  if [ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]; then
    note "left on $now (tracked changes present), not restoring $ORIG"
  elif git -C "$REPO_DIR" checkout -q "$ORIG" 2>/dev/null; then
    note "checkout restored from $now to $ORIG"
  else
    note "could NOT restore $ORIG (left on $now); another worktree probably holds it"
  fi
}
trap restore_checkout EXIT
( cd "$REPO_DIR" && "${DEVIN_CMD[@]}" --prompt-file "$PROMPT" ) 2>&1 | tee "$OUT"
