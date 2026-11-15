# v1.4 Task 7a — owner decisions

**Approved by the owner on 2026-11-15 (issue #99, after PR #98), exactly this scope; don't STOP on these:**

1. **Canonical change (OWNER REVIEW):** one new stream event `{type: "text_signature"; signature: CanonicalReasoningSignature}`
   in `canonical.types.ts` and `canonical.schema.ts` together, logged in `docs/decisions.md` naming #99. No other
   canonical change; any other one is still a STOP. Title the PR `[OWNER REVIEW]`.
2. **D8 fixture change:** in `tests/fixtures/streams/gemini/max_tokens.json`, `expectedEvents` gains one
   `text_signature` event after the second `text_delta`, with `origin {provider: "", model: "gemini-3.5-flash-lite"}`
   and `data` = the `.sse` recording's `thoughtSignature`, verbatim. Nothing else in that file changes (its
   `nonStreaming` body stays as is), no `.sse` or `.nonstreaming.json` changes, and any other fixture or snapshot
   change is still a STOP.
3. **Twin contracts:** `tests/contracts/stream-fixtures.test.ts` and `tests/contracts/stream-properties.test.ts`
   may replace `signature.data` on **text parts** with a constant before the twin `toEqual`, and nothing else. The
   two sides are separate recordings with different signatures. The exact `data` must stay asserted per recording
   (stream: `expectedEvents`; non-stream: the new test `"max_tokens nonStreaming text signature decoded verbatim"`).
   No other assertion may be loosened.

CI will be red with "FIXTURE GUARD FAILED … all other checks passed". That is the expected state; the owner sets
`ALLOW_FIXTURE_CHANGE`. Say so in the PR description, and show `git diff --stat origin/main -- tests/fixtures`
listing only `max_tokens.json`, plus the twin-test diff.
