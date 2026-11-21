#!/usr/bin/env bash
# Usage: next-task.sh [version]
# Prints "<version> <task>" for the first Task Index row with no merged PR (branch
# <version>/task-<N>-*), in index order. Without a version it uses the newest plan
# (docs/superpowers/plans/ sorts by date). Exits 1 when every task has a merged PR, and 3
# (printing the PR) when that task already has an open PR: never start a duplicate run.
# /conduct calls this for `/conduct next` and `/conduct <version>` with no task (v1.6 Task 4).
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
if [ -n "${1:-}" ]; then
  PLAN="$(ls "$ROOT"/docs/superpowers/plans/*babelgate-"$1"-plan.md)"
  VER="$1"
else
  PLAN="$(ls "$ROOT"/docs/superpowers/plans/*babelgate-*-plan.md | sort | tail -1)"
  VER="$(sed -n 's/.*babelgate-\(.*\)-plan\.md/\1/p' <<<"$PLAN")"
fi
# Task ids from the Task Index table: rows "| <id> | ..." between "## Task Index" and the next heading.
IDS="$(awk '/^## Task Index/{on=1; next} on && /^#/{exit} on && /^\| *[0-9]+[a-z]? *\|/{gsub(/ /,"",$2); print $2}' FS='|' "$PLAN")"
[ -n "$IDS" ] || { echo "next-task.sh: no Task Index rows in ${PLAN##*/}" >&2; exit 2; }
MERGED="$(gh pr list --state merged --limit 200 --search "head:$VER/task-" --json headRefName -q '.[].headRefName')"
for id in $IDS; do
  grep -qE "^$VER/task-$id-" <<<"$MERGED" && continue
  OPEN="$(gh pr list --state open --search "head:$VER/task-$id-" --json number,headRefName \
    -q ".[] | select(.headRefName | startswith(\"$VER/task-$id-\")) | .number")"
  if [ -n "$OPEN" ]; then
    echo "next-task.sh: $VER task $id already has open PR #$OPEN (waiting for merge or owner); not starting it again" >&2
    exit 3
  fi
  echo "$VER $id"; exit 0
done
echo "next-task.sh: every $VER task has a merged PR" >&2
exit 1
