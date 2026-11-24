# v1.6 Task 13b — owner decisions

**2026-11-24, owner (in the conductor session), after the escalation on PR #181:** option **A**.

1. **One more fix round (round 3) is approved** for the four conformance-tooling defects the conductor found
   in the live confirmation:
   - the spy logs the provider key when it travels as a `?key=` query parameter;
   - the spy drops the target's base path;
   - the Gemini mock replays SSE to non-streaming `generateContent` calls;
   - the client-side reasoning rule demands a thinking block on every turn, which Gemini does not guarantee.

   The scope is these four items and what they directly need. It is not a re-implementation.
2. **D9 for this task:** nothing about competitors becomes public until the cell is live-confirmed. Each
   live-confirmed bug is filed upstream with its repro before launch. Results are then stated factually
   (versions, date, repro link) with no adjectives. The draft report stays private to the PR.
3. The `reasoning_passback` default question is **not** part of this task. The conductor advises the owner
   separately. Do not change product defaults here.
