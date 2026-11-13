# v1.4 Task 2 — owner decisions

**Fixture change pre-approved (spec D7, 2026-11-13), exactly this scope:** in
`tests/fixtures/streams/gemini/text.json` and `tests/fixtures/streams/gemini/parallel_tool_calls.json`, the
expected usage only: `outputTokens` 1 → 34 and 54 → 131, plus the new `reasoningTokens` 33 and 77. Don't
STOP on this. Don't touch the `.sse` files or any other expected value. Any other fixture or snapshot change
is still a STOP.

CI will be red with "FIXTURE GUARD FAILED … all other checks passed". That is the expected state; the owner
sets `ALLOW_FIXTURE_CHANGE`. Say so in the PR description, and show
`git diff --stat origin/main -- tests/fixtures tests/contracts/__snapshots__` listing only those two files.

The PR title starts with `[OWNER REVIEW]` (canonical interface change).
