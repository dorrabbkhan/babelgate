#!/usr/bin/env bash
# Usage: judge.sh <PR> <version> <task> — run the mechanical judgment rules
# (spec §3.0.1) against the PR's diff. Extra args pass through to judge.ts
# (e.g. --claimed, --report-dir).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec npx ts-node scripts/conductor/judge.ts --pr "$1" --version "$2" --task "$3" "${@:4}"
