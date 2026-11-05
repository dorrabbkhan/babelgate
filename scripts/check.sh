#!/usr/bin/env bash
# Local replacement for CI. Run from anywhere in the repo.
#
#   ./scripts/check.sh        full local gate: run once before pushing,
#                             same checks the PR workflow runs
#   ./scripts/check.sh quick  iteration gate: fixture guard + typecheck,
#                             tests only for files changed since BASE
#
# BASE overrides the comparison commit (default: merge-base with
# origin/main); ALLOW_FIXTURE_CHANGE=1 skips the fixture guard (human only).
#
# A fixture-guard failure no longer stops the run: the other checks still
# run, so a PR with an owner-approved fixture change shows whether typecheck,
# tests and build pass. The script still exits non-zero at the end.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:-}"
case "$mode" in
  ""|quick) ;;
  *) echo "usage: $0 [quick]" >&2; exit 2 ;;
esac

[ -d node_modules ] || npm ci

guard_failed=0
run_guard() { scripts/ci/fixture-guard.sh || guard_failed=1; }
finish() {
  if [ "$guard_failed" = 1 ]; then
    printf '\nFIXTURE GUARD FAILED (see above); all other checks passed\n' >&2
    exit 1
  fi
  printf '\n%s\n' "$1"
}

if [ "$mode" = "quick" ]; then
  run_guard
  npm run --silent typecheck
  base="${BASE:-$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)}"
  npx vitest run --changed "$base" --passWithNoTests
  finish 'QUICK CHECKS PASSED (run ./scripts/check.sh before pushing)'
  exit 0
fi

run_guard
npm run --silent typecheck
npm test
npm run --silent build
scripts/ci/smoke-pack.sh

finish 'ALL CHECKS PASSED'
