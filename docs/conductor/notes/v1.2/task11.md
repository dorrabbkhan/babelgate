# v1.2 Task 11 — conductor notes

## Release gates deferred to release time (owner decision, 2026-11-02, PR #53)

The owner deferred the three v1.2 release gates (spec §4.5; plan Task 10) to release time: no GPU host yet.
PR #53 merged the gate support work (`config` mode in `scripts/gates/claude-code-edit.sh`, runbook
`docs/gates/gpu-ollama.md`) with every result line in its `docs/decisions.md` entry still
`PENDING — owner run`.

The gates still block the `v1.2.0` tag. For this task:

1. Before anything else, check the Task 10 entry in `docs/decisions.md`. If any of the Gate 1, Gate 2 or
   Gate 3 lines still says `PENDING`, say so at the top of the PR body under a heading
   **"Release gates pending — tag blocked"**, listing each pending gate with its command from the runbook.
   Do not remove, reword or fill in those lines, and do not run any gate yourself.
2. Do the rest of Task 11 as planned (CHANGELOG, version, roadmap). Do not describe the release as gated or
   verified in the CHANGELOG or roadmap while any gate is pending; keep the wording factual.
3. The owner records results (or has a fix session record them from pasted outputs) before tagging. If a gate
   fails twice, v1.2.0 is not released; that is the owner's call, not this task's.
