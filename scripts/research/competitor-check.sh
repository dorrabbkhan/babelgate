#!/usr/bin/env bash
# competitor-check.sh — monthly scripted competitor check (v1.6 spec §3.9).
#
#   scripts/research/competitor-check.sh [--out <file>] [--since YYYY-MM-DD]
#
# For every `owner/repo` in scripts/research/competitor-repos.txt this
# fetches, via `gh api`: repo metadata (stars, last push, archived), the
# latest release tag/date, and the count + first 5 titles of open issues
# created since --since matching `thinking|tool|stream|reasoning`. The
# JSON lands in a temp dir and scripts/research/competitor-check.ts
# renders the dated Markdown report. --out defaults to
# docs/research/<today>-competitor-check.md, --since to 30 days ago.
# Run by hand monthly and before every version spec — deliberately no
# workflow, so the GitHub App's permissions stay unchanged (§3.9).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

repos_file="scripts/research/competitor-repos.txt"
out=""
since=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --since) since="$2"; shift 2 ;;
    *) echo "usage: $0 [--out <file>] [--since YYYY-MM-DD]" >&2; exit 2 ;;
  esac
done

if [ -z "$since" ]; then
  # GNU date on Linux, BSD date on macOS.
  if since_default="$(date -d '30 days ago' +%F 2>/dev/null)"; then
    since="$since_default"
  else
    since="$(date -v-30d +%F)"
  fi
fi
[ -n "$out" ] || out="docs/research/$(date +%F)-competitor-check.md"

command -v gh >/dev/null 2>&1 || {
  echo "competitor-check: requires the GitHub CLI (gh)" >&2
  exit 1
}

data="$(mktemp -d)"
trap 'rm -rf "$data"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*($|#) ]] && continue
  repo="${line%%[[:space:]]*}"

  slug="${repo//\//_}"
  echo "[check] $repo"

  if ! gh api "repos/$repo" >"$data/$slug.repo.json" 2>"$data/$slug.err"; then
    echo "competitor-check: gh api repos/$repo failed:" >&2
    cat "$data/$slug.err" >&2
    exit 1
  fi

  # No GitHub release (404) is data, not a failure; anything else is.
  if ! gh api "repos/$repo/releases/latest" \
    >"$data/$slug.release.json" 2>"$data/$slug.rel.err"; then
    if grep -qi "not found" "$data/$slug.rel.err"; then
      rm -f "$data/$slug.release.json"
    else
      echo "competitor-check: releases/latest for $repo failed:" >&2
      cat "$data/$slug.rel.err" >&2
      exit 1
    fi
  fi

  if ! gh api search/issues -X GET \
    -f q="repo:$repo is:issue is:open created:>=$since thinking OR tool OR stream OR reasoning" \
    -f per_page=5 -f sort=created -f order=desc \
    >"$data/$slug.issues.json" 2>"$data/$slug.iss.err"; then
    echo "competitor-check: issue search for $repo failed:" >&2
    cat "$data/$slug.iss.err" >&2
    exit 1
  fi
done < "$repos_file"

./node_modules/.bin/ts-node scripts/research/competitor-check.ts \
  --data "$data" --repos "$repos_file" --since "$since" --out "$out"
