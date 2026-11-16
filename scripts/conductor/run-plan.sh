#!/usr/bin/env bash
# Usage: run-plan.sh <version> <from-task> <to-task>
# Runs one fresh headless Claude Code session per plan task (spec §3.0.4):
#
#   claude -p "/conduct <version> <id>" --model <opus|sonnet> \
#     --allowedTools "<specs from headless-tools.txt>"
#
# Task order and ids come from the plan's Task Index table (ids like 0b, 7);
# the model comes from its Conductor column (Opus|Sonnet). The plan file is
# found the same way build-prompt.sh finds it
# (docs/superpowers/plans/*babelgate-<version>-plan.md); PLAN_FILE=<path>
# overrides it (used by the dry-run fixture under fixtures/run-plan/).
#
# After each session the script reads the last non-empty line of the task's
# ~/babelgate-conductor/<version>-task<id>/conductor-log.md — but only if the
# session appended to the log (a stale RESULT from an earlier run does not
# count) — and treats it as a RESULT only if it starts with "RESULT: ":
#   RESULT: READY <PR>              → poll `gh pr view <PR> --json state`
#                                     every RUN_PLAN_POLL_S (default 300)
#                                     seconds until MERGED, then next task
#   RESULT: ESCALATED|GATE|FAILED   → notify.sh and stop
#   missing/unparseable             → notify.sh and stop
# It never merges and never starts a session while a previous task's PR is
# still open.
#
# DRY_RUN=1 prints the `claude -p` command(s) it would run and exits 0
# without starting sessions, polling, or notifying.
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "usage: run-plan.sh <version> <from-task> <to-task>" >&2
  echo "  env: PLAN_FILE=<plan.md> override, DRY_RUN=1 print only," >&2
  echo "       RUN_PLAN_POLL_S=<n> merge-poll interval (default 300)," >&2
  echo "       RUN_PLAN_DIR=<dir> session dir override (default ~/babelgate-conductor)" >&2
  exit 2
fi
VER="$1"; FROM="$2"; TO="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$ROOT"
TOOLS="$HERE/headless-tools.txt"
POLL_S="${RUN_PLAN_POLL_S:-300}"

# --- resolve the plan file (build-prompt.sh's mapping, PLAN_FILE override) ---
if [ -n "${PLAN_FILE:-}" ]; then
  PLAN="$PLAN_FILE"
  [ -f "$PLAN" ] || { echo "run-plan.sh: PLAN_FILE $PLAN does not exist" >&2; exit 2; }
else
  shopt -s nullglob
  PLANS=("$ROOT"/docs/superpowers/plans/*babelgate-"$VER"-plan.md)
  shopt -u nullglob
  if [ "${#PLANS[@]}" -ne 1 ]; then
    echo "run-plan.sh: expected one plan matching *babelgate-$VER-plan.md, found ${#PLANS[@]}." >&2
    exit 2
  fi
  PLAN="${PLANS[0]}"
fi
[ -f "$TOOLS" ] || { echo "run-plan.sh: $TOOLS missing" >&2; exit 2; }

# --- parse the Task Index table: "id<TAB>conductor" per row, in table order ---
# Columns are located by header name ("#" and "Conductor"), so extra columns
# (Gate, Why this model, …) can sit anywhere.
mapfile -t INDEX < <(awk '
  /^##[[:space:]]+Task Index/ { inix=1; next }
  inix && /^[[:space:]]*\|/ {
    n = split($0, f, "|")
    if (!hdr) {
      for (i = 1; i <= n; i++) {
        h = f[i]; gsub(/^[ \t]+|[ \t]+$/, "", h)
        if (h == "#") cid = i
        if (h == "Conductor") cmod = i
      }
      hdr = 1; next
    }
    id = f[cid]; gsub(/^[ \t]+|[ \t]+$/, "", id)
    if (id ~ /^-+$/) next
    mod = cmod ? f[cmod] : ""
    gsub(/^[ \t]+|[ \t]+$/, "", mod)
    printf "%s\t%s\n", id, mod
    next
  }
  inix && hdr { exit }
' "$PLAN")
[ "${#INDEX[@]}" -gt 0 ] || { echo "run-plan.sh: no Task Index table in $PLAN" >&2; exit 2; }

# --- select the contiguous range from..to by table position ---
IDS=(); MODS=()
for row in "${INDEX[@]}"; do
  IDS+=("${row%%$'\t'*}"); MODS+=("${row#*$'\t'}")
done
pos() { local want="$1" i; for i in "${!IDS[@]}"; do [ "${IDS[$i]}" = "$want" ] && { echo "$i"; return 0; }; done; return 1; }
PI="$(pos "$FROM")" || { echo "run-plan.sh: task id '$FROM' not in $PLAN Task Index (${IDS[*]})" >&2; exit 2; }
QI="$(pos "$TO")"   || { echo "run-plan.sh: task id '$TO' not in $PLAN Task Index (${IDS[*]})" >&2; exit 2; }
[ "$QI" -ge "$PI" ] || { echo "run-plan.sh: '$TO' comes before '$FROM' in the Task Index" >&2; exit 2; }

model_for() {
  case "$1" in
    Opus|opus) echo opus ;;
    Sonnet|sonnet) echo sonnet ;;
    *) return 1 ;;
  esac
}

# Comment/blank lines in headless-tools.txt are documentation; join the rest.
ALLOWED="$(grep -vE '^[[:space:]]*(#|$)' "$TOOLS" | paste -sd, -)"
DIR_BASE="${RUN_PLAN_DIR:-$HOME/babelgate-conductor}"

stop_with() {
  "$HERE/notify.sh" "run-plan $VER: $1" || true
  echo "run-plan.sh: $1" >&2
  exit 1
}

for ((i = PI; i <= QI; i++)); do
  ID="${IDS[$i]}"; COND="${MODS[$i]}"
  MODEL="$(model_for "$COND")" \
    || { echo "run-plan.sh: task $ID Conductor column is '$COND', expected Opus or Sonnet" >&2; exit 2; }
  CMD=(claude -p "/conduct $VER $ID" --model "$MODEL" --allowedTools "$ALLOWED")
  TASKDIR="$DIR_BASE/$VER-task$ID"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUT="$TASKDIR/headless-$STAMP.out"

  if [ "${DRY_RUN:-}" = "1" ]; then
    printf 'DRY_RUN: claude -p "/conduct %s %s" --model %s --allowedTools "%s" > %s\n' \
      "$VER" "$ID" "$MODEL" "$ALLOWED" "$OUT"
    continue
  fi

  mkdir -p "$TASKDIR"
  LOG="$TASKDIR/conductor-log.md"
  LINES_BEFORE=0
  { [ -f "$LOG" ] && LINES_BEFORE="$(wc -l <"$LOG")"; } || true
  echo "run-plan.sh: starting task $ID ($MODEL) → $OUT"
  set +e
  ( cd "$ROOT" && "${CMD[@]}" ) >"$OUT" 2>&1
  rc=$?
  set -e
  echo "run-plan.sh: task $ID session exited $rc"

  LINES_AFTER=0
  { [ -f "$LOG" ] && LINES_AFTER="$(wc -l <"$LOG")"; } || true
  [ "$LINES_AFTER" -gt "$LINES_BEFORE" ] \
    || stop_with "task $ID: no new RESULT: line in $LOG (session rc=$rc, output $OUT)"
  RESULT=""
  LAST="$(awk 'NF{l=$0} END{print l}' "$LOG")"
  case "$LAST" in "RESULT: "*) RESULT="$LAST" ;; esac
  case "$RESULT" in
    "RESULT: READY "*)
      PR="${RESULT#RESULT: READY }"; PR="${PR%%[[:space:]]*}"
      [ -n "$PR" ] || stop_with "task $ID: 'RESULT: READY' without a PR"
      echo "run-plan.sh: task $ID ready, waiting for PR $PR to merge (poll ${POLL_S}s)"
      while :; do
        state="$(gh pr view "$PR" --json state --jq .state 2>/dev/null || echo UNKNOWN)"
        case "$state" in
          MERGED) echo "run-plan.sh: PR $PR merged"; break ;;
          CLOSED) stop_with "task $ID: PR $PR closed without merge" ;;
          *) sleep "$POLL_S" ;;
        esac
      done
      ;;
    "RESULT: READY"*)     stop_with "task $ID: 'RESULT: READY' without a PR" ;;
    "RESULT: ESCALATED"*) stop_with "task $ID escalated (see $LOG)" ;;
    "RESULT: GATE"*)      stop_with "task $ID stopped at an owner gate (see $LOG)" ;;
    "RESULT: FAILED"*)    stop_with "task $ID failed (see $LOG)" ;;
    *) stop_with "task $ID: no RESULT: line in $LOG (session rc=$rc, output $OUT)" ;;
  esac
done

[ "${DRY_RUN:-}" = "1" ] || echo "run-plan.sh: tasks $FROM..$TO of $VER done"
exit 0
