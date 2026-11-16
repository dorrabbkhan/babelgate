#!/usr/bin/env bash
# Usage: judge.sh <PR> <version> <task> — run the mechanical judgment rules
# (spec §3.0.1) against the PR's diff. Extra args pass through to judge.ts
# (e.g. --claimed, --report-dir).
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: judge.sh <PR> <version> <task> [--claimed <out.md>] [--report-dir <dir>] …" >&2
  exit 2
fi
cd "$(git rev-parse --show-toplevel)"
exec npx ts-node scripts/conductor/judge.ts --pr "$1" --version "$2" --task "$3" "${@:4}"
