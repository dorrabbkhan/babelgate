# v1.2 Task 8 — conductor notes

## Gemini endpoint line (owner decision, 2026-11-02, PR #50)

The CLI endpoints block (Task 7, spec §3.7) prints `Gemini     http://localhost:<port>/v1beta`. Concern: the
`@google/genai` SDK (and `@google/generative-ai`) may take a base URL **without** the API version and append
`/v1beta` itself; a user who pastes the printed URL would then call `/v1beta/v1beta/models/...` → 404.

Owner decision: check this against the SDK documentation in this task; change the line **only if the
check confirms the problem**.

1. Check the official docs/source for how each Gemini client's base URL is composed — at least
   `@google/genai` (JS `httpOptions.baseUrl` + `apiVersion`) and `google-genai` (Python
   `http_options.base_url`). Record in the PR body: doc/source URL, date checked, and the exact URL the SDK
   builds for `generateContent` from a given base URL. Our own mocks and tests are NOT evidence.
2. Whatever the result, the README/recipe Gemini client example must show the base URL that actually works
   with that SDK (and name the SDK option), backed by step 1.
3. Only if step 1 confirms the SDK appends the version itself: change the Gemini line in `endpointLines`
   (`src/cli.ts`) to `Gemini     http://localhost:<port>` and update the exact string in the
   `"endpoint lines"` test in `src/cli.test.ts` (an exact-string update, still exact match — no weaker
   assertion). These two files are outside Task 8's Files block: record them in `docs/decisions.md`
   ("Files outside the Files block"), citing this owner decision and the doc URL, and note the §3.7 wording
   change. Do not edit the spec.
4. If the docs are ambiguous or the SDKs disagree, do not change the line; put the evidence in the PR body
   and keep the README explicit about the exact URL to use with each SDK.
