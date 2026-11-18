#!/usr/bin/env bash
# client-replay diagnostics (v1.5 replay-diagnostics follow-up to Task
# 12): called by client-replay.sh after the summary is written. The
# first live.yml dispatches showed only the summary table — each
# sub-run log stayed in a temp dir that died with the runner — so this
# stages the run's artifacts into the directory the workflow uploads
# and prints a bounded tail of every failed sub-run's log to stdout.
#
# Env in (all the status vars default to "not FAIL"):
#   REPLAY_WORK_DIR    scratch dir holding the four sub-run logs and
#                      the recorded JSONLs
#   REPLAY_SUMMARY     path of the run's summary.md
#   ARTIFACT_DIR       staging dir the workflow uploads
#   CLAUDE_GATE / CODEX_GATE / CLAUDE_RECORD / CODEX_RECORD — PASS|FAIL
#   OPENROUTER_API_KEY never printed or staged: a staged file
#                      containing it is dropped, a tail containing it
#                      is withheld.
set -euo pipefail

work="${REPLAY_WORK_DIR:?REPLAY_WORK_DIR is required}"
summary="${REPLAY_SUMMARY:?REPLAY_SUMMARY is required}"
artifact_dir="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"

key_set() { [ -n "${OPENROUTER_API_KEY:-}" ]; }

str_has_key() {
  # $1 = text → true when the key is set and present in $1
  key_set || return 1
  case "$1" in *"$OPENROUTER_API_KEY"*) return 0 ;; esac
  return 1
}

stage() {
  # $1 = source file: copies it under $artifact_dir, then drops the
  # copy when it contains the key. Missing sources are skipped — a
  # record that never ran has no JSONL.
  local src="$1" dest
  [ -f "$src" ] || return 0
  dest="$artifact_dir/$(basename "$src")"
  [ "$src" -ef "$dest" ] || cp -f "$src" "$dest"
  if key_set && grep -qF -- "$OPENROUTER_API_KEY" "$dest"; then
    rm -f "$dest"
    echo "dropped artifact $(basename "$dest"): contains OPENROUTER_API_KEY" >&2
  fi
}

print_tail() {
  # $1 = sub-run name, $2 = status, $3 = log file. A FAIL sub-run gets
  # a bounded tail inside workflow-command group markers (never the
  # whole log); PASS prints nothing; a tail holding the key is
  # withheld.
  [ "${2:-}" = "FAIL" ] || return 0
  echo "::group::$1 log (tail)"
  if [ ! -f "$3" ]; then
    echo "(no log at $3)"
  else
    local tail_out
    tail_out="$(tail -40 "$3")"
    if str_has_key "$tail_out"; then
      echo "(tail withheld: contains OPENROUTER_API_KEY)"
    else
      printf '%s\n' "$tail_out"
    fi
  fi
  echo "::endgroup::"
}

mkdir -p "$artifact_dir"
for f in \
  "$work/claude.jsonl" "$work/codex.jsonl" \
  "$work/claude-gate.log" "$work/codex-gate.log" \
  "$work/claude-record.log" "$work/codex-record.log" \
  "$summary"; do
  stage "$f"
done

print_tail "claude gate" "${CLAUDE_GATE:-}" "$work/claude-gate.log"
print_tail "codex gate" "${CODEX_GATE:-}" "$work/codex-gate.log"
print_tail "claude record" "${CLAUDE_RECORD:-}" "$work/claude-record.log"
print_tail "codex record" "${CODEX_RECORD:-}" "$work/codex-record.log"
