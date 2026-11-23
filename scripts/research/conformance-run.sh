#!/usr/bin/env bash
# conformance-run.sh — competitor conformance run (v1.6 spec §3.10).
#
#   scripts/research/conformance-run.sh [--report <file>] [--skip-install]
#
# Installs the pinned competitor gateways under the gitignored tmp/
# (CCR via `npm install --prefix`, free-claude-code via `git clone
# --depth 1 --branch` + `uv sync --frozen`; pins live in
# tests/process/gateways/), then runs
# tests/process/conformance.process.test.ts for
# babelgate,ccr,free-claude-code and writes the draft report and the
# raw results JSON.
#
# Replay-backed scenarios that need conductor-recorded streams
# (npm run record:streams, RECORD_OUT_DIR=tests/process/replays) stay
# red until those files exist; the report records them as pending.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

report="docs/research/$(date +%F)-conformance-run.md"
results="tmp/conformance/results.json"
skip_install=0
gateways="babelgate,ccr,free-claude-code"
while [ $# -gt 0 ]; do
  case "$1" in
    --report) report="$2"; shift 2 ;;
    --results) results="$2"; shift 2 ;;
    --gateways) gateways="$2"; shift 2 ;;
    --skip-install) skip_install=1; shift ;;
    *) echo "usage: $0 [--report <file>] [--results <file>] [--gateways a,b] [--skip-install]" >&2; exit 2 ;;
  esac
done

mkdir -p tmp/conformance "$(dirname "$report")"

if [ "$skip_install" = 0 ]; then
  # The install steps live in the gateway adapters so the pins and the
  # run cannot drift apart.
  if case ",$gateways," in *,ccr,*) true ;; *) false ;; esac; then
    echo "[install] ccr (@musistudio/claude-code-router, pinned in tests/process/gateways/ccr.ts)"
    npx ts-node -e "require('./tests/process/gateways/ccr.ts').installCcr()"
  fi
  if case ",$gateways," in *,free-claude-code,*) true ;; *) false ;; esac; then
    echo "[install] free-claude-code (tag pinned in tests/process/gateways/free-claude-code.ts)"
    npx ts-node -e "require('./tests/process/gateways/free-claude-code.ts').installFcc()"
  fi
fi

set +e
env \
  CONFORMANCE_GATEWAYS="$gateways" \
  CONFORMANCE_RESULTS="$results" \
  CONFORMANCE_REPORT="$report" \
  npx vitest run --config vitest.process.config.ts \
    tests/process/conformance.process.test.ts
vitest_status=$?
set -e

echo "results: $results"
echo "report:  $report"
echo "confirm mock-only competitor failures with:"
echo "  scripts/research/conformance-live.sh <gateway> <scenario>"
exit "$vitest_status"
