---
description: Work through a range of plan tasks sequentially, one headless session each, pausing at gates.
argument-hint: <version> <from-task> <to-task>   e.g. v1.5 1 5
---
Arguments as typed: $ARGUMENTS
Run `scripts/conductor/run-plan.sh $0 $1 $2`. It starts one fresh headless `/conduct $0 <id>` session per
task in Task Index order, on the model named by the index's Conductor column, with the explicit
`--allowedTools` list in scripts/conductor/headless-tools.txt (D7 — a tool call outside the list fails and
the session escalates instead of improvising). After each session it reads the `RESULT:` line that
/conduct appended to the task's conductor-log.md: `READY <PR>` waits for the owner to merge;
`ESCALATED`, `GATE`, `FAILED` or a missing line stops the run and notifies you. It never merges.
Watch the first runs and adjust headless-tools.txt by PR if a legitimate call fails closed.
