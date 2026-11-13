# v1.4 Task 7 — owner decisions

**Fixture change pre-approved (spec D7, 2026-11-13), exactly this scope:** in
`tests/fixtures/streams/gemini/parallel_tool_calls.json`, the first function call's expected canonical
output gains its real `thoughtSignature` as `signature: {origin: {provider: "", model: "gemini-2.5-flash"},
data: <the recording's thoughtSignature, verbatim>}` (the origin the fixture harness produces outside an
attempt). Don't STOP on this. Nothing else in that file changes, the `.sse` files never change, and any
other fixture or snapshot change is still a STOP.

CI will be red with "FIXTURE GUARD FAILED … all other checks passed". That is the expected state; the owner
sets `ALLOW_FIXTURE_CHANGE`. Say so in the PR description, and show the `git diff --stat` for
`tests/fixtures` listing only that file.
