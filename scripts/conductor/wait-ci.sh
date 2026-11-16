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
log="$(mktemp -t wait-ci.XXXXXX)"
rc=0
gh pr checks "$pr" --watch --fail-fast=false >"$log" 2>&1 || rc=$?
gh pr checks "$pr" || true
if [ "$rc" -ne 0 ]; then
  fails="$(gh pr checks "$pr" --json name,bucket,link \
    --jq '.[] | select(.bucket=="fail") | [.name,.link] | @tsv' 2>/dev/null || true)"
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
