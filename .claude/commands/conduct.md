---
description: Run one plan task end to end (task → review ∥ CI → judge → fixes → status), never merging.
argument-hint: <version> <task-number>   e.g. v1.2 1
---
Arguments as typed: $ARGUMENTS
Run the conductor loop from CLAUDE.md for plan version $0, task $1.
1. Read the plan file for $0 (mapping in .devin/skills/babelgate-task/SKILL.md), its Global Constraints, its
   Review Focus and Task $1; the spec sections it names; docs/conductor/standing-notes.md; and
   docs/conductor/notes/$0/task$1.md if it exists.
2. Check that the dependencies in the Task Index are merged; if not, say so and stop.
3. Build every Devin prompt with scripts/conductor/build-prompt.sh (it names the skill by path, puts the per-task
   owner decisions first, then extra instructions, standing notes and the footer; never start a prompt with a
   "/babelgate-…" line) and pipe it into scripts/conductor/devin.sh:
   - task:   `scripts/conductor/build-prompt.sh task $0 $1 | scripts/conductor/devin.sh task $0 $1`
   - review: `scripts/conductor/build-prompt.sh review $0 $1 <PR> [focus.md] | scripts/conductor/devin.sh review $0 $1`
   - fix:    `scripts/conductor/build-prompt.sh fix $0 $1 <PR> required.md | scripts/conductor/devin.sh fix $0 $1`
     (required.md lists the REQUIRED items precisely, with file:line and the exact test values to assert).
4. Follow the loop and judgment rules exactly. Keep a short running log in
   ~/babelgate-conductor/$0-task$1/conductor-log.md.
5. Finish with scripts/conductor/status-comment.sh and scripts/conductor/notify.sh, then print a summary:
   PR, verdict, CI, fix rounds used, anything the owner must look at (gates, wire-format evidence, diffs).
