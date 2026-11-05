# v1.3 Task 3: owner decision (2026-11-05)

**Fixture change approved (option A), and this one only.** Spec §3.2 maps OpenAI
`prompt_tokens_details.cached_tokens` to `cacheReadTokens`. Decoding `tests/fixtures/streams/openai/tool_call.sse` that way
(its synthetic usage chunk has `cached_tokens: 20`) adds `"cacheReadTokens": 20` to the decoded usage event.

- Do: implement the §3.2 OpenAI decode (stream and non-stream) as specified, and add `"cacheReadTokens": 20` to that one
  `usage` event in `tests/fixtures/streams/openai/tool_call.json` `expectedEvents`. Do not change anything else in that file.
- Do not touch `tool_call.sse` or any other fixture or snapshot. If any other expected value would have to change, STOP
  as before. This approval covers only the change above.
- Record it in the "v1.3 Task 3" decisions entry: a "Fixture change (owner-approved 2026-11-05, option A)" line naming the
  file and the field, and saying the `.sse` wire bytes are unchanged. Do not write an "Owner sign-off" line.
- `scripts/ci/fixture-guard.sh` will flag this file. The PR title starts with `[OWNER REVIEW]` (Task 3 is an interface change),
  and the PR body names the fixture change.
- Do not add a `cached_tokens <= prompt_tokens` guard or any other data-dependent rule: decode exactly what the wire says.
