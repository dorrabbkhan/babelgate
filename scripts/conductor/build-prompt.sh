#!/usr/bin/env bash
# Usage: build-prompt.sh <task|review|fix> <version> <task> [PR] [extra instructions file]
# Prints a Devin prompt to stdout; pipe it into devin.sh:
#   scripts/conductor/build-prompt.sh task v1.3 3 | scripts/conductor/devin.sh task v1.3 3
#   scripts/conductor/build-prompt.sh fix v1.3 3 63 required.md | scripts/conductor/devin.sh fix v1.3 3
#
# Order matters. The skill is named by its file path, never as a leading "/babelgate-…" line:
# with a slash command first, Devin expanded the skill and ignored the owner decision appended
# after it (v1.3 Task 3 stopped twice on a fixture question the owner had already answered).
# So: what to do (skill by path) → owner decisions (per-task notes) → extra instructions →
# standing notes → output contract.
set -euo pipefail
KIND="$1"; VER="$2"; N="$3"; PR="${4:-}"; EXTRA="${5:-}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
NOTES="$ROOT/docs/conductor/notes/$VER/task$N.md"
[ "$PR" = "-" ] && PR=""
need_pr() { [ -n "$PR" ] || { echo "build-prompt.sh: $KIND needs a PR number" >&2; exit 2; }; }

case "$KIND" in
  task)
    echo "Implement plan \`$VER\`, Task $N by following \`.devin/skills/babelgate-task/SKILL.md\` exactly (arguments: \`$VER $N\`)."
    ;;
  review)
    need_pr
    echo "Review PR #$PR (plan \`$VER\`, Task $N) by following \`.devin/skills/babelgate-review/SKILL.md\` exactly (arguments: \`$VER $PR\`)."
    echo "This is a review session: do not modify files or push. Check the PR out in a separate \`git worktree\`, not in the main checkout."
    ;;
  fix)
    need_pr
    echo "Fix round for PR #$PR (plan \`$VER\`, Task $N). Check out the PR's branch, work only on it and push to it (no new PR, no force-push)."
    echo "Do not re-implement the task; change only what the REQUIRED items below need. Show \`git diff --stat HEAD~1\` matching your claims."
    ;;
  *) echo "usage: $0 <task|review|fix> <version> <task> [PR] [extra file]" >&2; exit 2 ;;
esac

if [ -f "$NOTES" ]; then
  echo
  echo "## Owner decisions for this task — authoritative; read before anything else"
  echo
  echo "From \`docs/conductor/notes/$VER/task$N.md\`. Where they approve something a rule or skill would otherwise stop on,"
  echo "they are the \"task says so\" exception, exactly as scoped there and no wider. Do not stop on a question they already answer."
  echo
  cat "$NOTES"
fi

if [ -n "$EXTRA" ]; then
  echo
  echo "## Instructions"
  echo
  cat "$EXTRA"
fi

echo
echo "## Standing notes"
echo
cat "$ROOT/docs/conductor/standing-notes.md"
echo

if [ "$KIND" = "review" ]; then
  echo "End with a line \`VERDICT: <APPROVE|CHANGES REQUIRED>\` listing REQUIRED items explicitly."
else
  echo "## Output contract"
  echo
  cat "$ROOT/scripts/conductor/footer.md"
fi
