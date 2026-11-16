#!/usr/bin/env bash
# Usage: wait-ci.sh <PR> — block until the PR's checks finish (spec §3.0.2).
# The --watch output stays in a temp file (gh reprints the whole table each
# interval in non-TTY mode); we print the final `gh pr checks` table once and,
# for each failing job, the last 40 lines of its failed log.
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "usage: wait-ci.sh <PR>" >&2
  exit 2
fi
pr="$1"
# Right after a push no checks are registered yet and --watch exits at once
# ("no checks reported"). Poll until at least one check exists, for at most
# WAIT_CI_MAX_S (default 300) at WAIT_CI_POLL_S (default 10) intervals.
# `gh pr checks --json` needs gh >= 2.50; the packaged gh 2.46 lacks it, so
# fall back to the statusCheckRollup length (same "checks registered" count).
poll_s="${WAIT_CI_POLL_S:-10}"
max_s="${WAIT_CI_MAX_S:-300}"
waited=0
while :; do
  n="$(gh pr checks "$pr" --json name --jq length 2>/dev/null \
    || gh pr view "$pr" --json statusCheckRollup --jq '.statusCheckRollup | length' 2>/dev/null \
    || echo 0)"
  [ "${n:-0}" -gt 0 ] 2>/dev/null && break
  if [ "$waited" -ge "$max_s" ]; then
    echo "wait-ci: no checks registered after ${max_s}s" >&2
    exit 3
  fi
  sleep "$poll_s"
  waited=$((waited + poll_s))
done
log="$(mktemp -t wait-ci.XXXXXX)"
rc=0
gh pr checks "$pr" --watch --fail-fast=false >"$log" 2>&1 || rc=$?
gh pr checks "$pr" || true
if [ "$rc" -ne 0 ]; then
  # Same gh 2.46 limit as the poll above: `pr checks` has no --json, so the
  # failing rows come from the plain non-TTY table (name, status, elapsed,
  # link — tab-separated).
  fails="$(gh pr checks "$pr" 2>/dev/null | awk -F'\t' '$2=="fail"{print $1"\t"$4}' || true)"
  if [ -n "$fails" ]; then
    echo "--- failing checks:"
    printf '%s\n' "$fails" | cut -f1
    printf '%s\n' "$fails" | cut -f2 | grep -oE 'job/[0-9]+' | sort -u | while read -r j; do
      job="${j#job/}"
      echo "--- job $job: last 40 failed-log lines"
      gh run view --job "$job" --log-failed 2>&1 | tail -40
    done
  fi
fi
rm -f "$log"
exit "$rc"
