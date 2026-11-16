#!/usr/bin/env bash
# Usage: wait-ci.sh <PR> — block until the PR's checks finish (spec §3.0.2).
# Prints the final `gh pr checks` table and, for each failing check, the job
# name plus the last 40 lines of its failed log (gh run view --log-failed).
set -euo pipefail
pr="$1"
log="$(mktemp -t wait-ci.XXXXXX)"
rc=0
gh pr checks "$pr" --watch --fail-fast=false >"$log" 2>&1 || rc=$?
cat "$log"
if [ "$rc" -ne 0 ]; then
  fails="$(gh pr checks "$pr" --json name,bucket,link \
    --jq '.[] | select(.bucket=="fail") | [.name,.link] | @tsv' 2>/dev/null || true)"
  if [ -n "$fails" ]; then
    echo "--- failing checks:"
    printf '%s\n' "$fails" | cut -f1
    printf '%s\n' "$fails" | cut -f2 | grep -oE 'runs/[0-9]+' | sort -u | while read -r r; do
      run="${r#runs/}"
      echo "--- run $run: last 40 failed-log lines"
      gh run view "$run" --log-failed 2>&1 | tail -40
    done
  fi
fi
rm -f "$log"
exit "$rc"
