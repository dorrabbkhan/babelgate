#!/usr/bin/env bash
# Usage: usage-report.sh [--since YYYY-MM-DD] [--version vX.Y] [--json]
#   [--projects-dir <dir>]
# Per-session and per-task Claude Code usage from the session logs (spec
# §3.0.5). Aggregates only — never prompt text or tool inputs/outputs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec npx ts-node scripts/conductor/usage-report.ts "$@"
