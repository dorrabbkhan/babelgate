# Conformance run — 2026-11-24 — DRAFT

Draft per spec §3.10/D9: private to the PR; publishing decisions
are the owner's. A "fail" is only ever a check a cited provider
doc requires; a check no doc requires is reported as an
observation (`differs`), never a failure. Failures are mock-only,
unconfirmed until scripts/research/conformance-live.sh confirms
them against the live provider.

## Versions

- babelgate: local build (node dist/cli.js)
- babelgate-default: local build (node dist/cli.js)
- ccr: @musistudio/claude-code-router 3.1.6 (npm, --ignore-scripts)
- free-claude-code: Alishahryar1/free-claude-code v6.15.0 (e8806fb608ac, uv sync --frozen)

## Configuration

Every non-default setting the run used, per gateway, with the
doc that documents it.

- babelgate: `reasoning_passback: true` on the mock `openai` and `ollama` provider entries — the spec §3.3 opt-in for Chat `reasoning_content` passback (docs/recipes/codex.md). Everything else is the stock default config.
- babelgate-default: unchanged default config — `reasoning_passback` unset on every provider entry (its spec §3.3 default is off).
- ccr: no reasoning or transformer option is set — v3.1.6 documents none for `openai_chat_completions` or `gemini_generate_content` providers: checked the package `README.md` and the docs source `docs/src/content/docs/en/configuration/providers.md` at tag `v3.1.6` (https://github.com/musistudio/claude-code-router/tree/v3.1.6 — published as https://ccrdesk.top/en/configuration/providers/). The provider entries carry `name`, `type`, `apikey`, `baseurl` and `models` only.
- free-claude-code: `reasoning_history_format: "reasoning_content"` on the custom provider (its default is `"disabled"` — `src/free_claude_code/config/custom_providers.py` at v6.15.0, https://github.com/Alishahryar1/free-claude-code) — the DeepSeek wire field for replaying reasoning (https://api-docs.deepseek.com/guides/reasoning_model).

## Rules

Per scenario, what is checked and the doc that requires it. A
rule with no citing doc is an observation: it can produce
`differs`, never `fail`.

- thinking-after-tool:anthropic->openai
  - every turn returns HTTP 200 with the client dialect's event stream (https://docs.anthropic.com/en/api/messages-streaming)
  - turn 2 upstream request carries reasoning back on the tool-call turn (messages[].reasoning / reasoning_content / reasoning_details) (https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - turn 2 client stream has a signed thinking block before the first text or tool_use block — or immediately after the tool_use whose signature it carries — when the turn's upstream response carried reasoning (https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- thinking-after-tool:responses->openai
  - every turn returns HTTP 200 with the client dialect's event stream (https://platform.openai.com/docs/api-reference/responses-streaming)
  - turn 2 upstream request carries reasoning back on the tool-call turn (messages[].reasoning / reasoning_content / reasoning_details) (https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - turn 2 client stream has a reasoning item before the message or function call when the turn's upstream response carried reasoning (https://platform.openai.com/docs/guides/reasoning)
- thinking-after-tool:anthropic->gemini
  - every turn returns HTTP 200 with the client dialect's event stream (https://docs.anthropic.com/en/api/messages-streaming)
  - turn 2 upstream request carries the thought signature on the tool-call turn (contents[].parts[] functionCall.thoughtSignature / thought:true) (https://ai.google.dev/gemini-api/docs/thought-signatures)
  - turn 2 client stream has a signed thinking block before the first text or tool_use block — or immediately after the tool_use whose signature it carries — when the turn's upstream response carried reasoning (https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- thinking-after-tool:responses->gemini
  - every turn returns HTTP 200 with the client dialect's event stream (https://platform.openai.com/docs/api-reference/responses-streaming)
  - turn 2 upstream request carries the thought signature on the tool-call turn (contents[].parts[] functionCall.thoughtSignature / thought:true) (https://ai.google.dev/gemini-api/docs/thought-signatures)
  - turn 2 client stream has a reasoning item before the message or function call when the turn's upstream response carried reasoning (https://platform.openai.com/docs/guides/reasoning)
- streamed-tool-args:anthropic->openai
  - the client request returns HTTP 200 with the dialect's event stream (https://docs.anthropic.com/en/api/messages-streaming)
  - the client stream carries exactly one tool call whose concatenated arguments parse as the recorded JSON (upstream streams them as >=5 deltas) (https://docs.anthropic.com/en/api/messages-streaming)
- streamed-tool-args:responses->openai
  - the client request returns HTTP 200 with the dialect's event stream (https://platform.openai.com/docs/api-reference/responses-streaming)
  - the client stream carries exactly one tool call whose concatenated arguments parse as the recorded JSON (upstream streams them as >=5 deltas) (https://platform.openai.com/docs/api-reference/responses-streaming)
- multi-turn-reasoning:anthropic->openai
  - every turn returns HTTP 200 with the client dialect's event stream (https://docs.anthropic.com/en/api/messages-streaming)
  - every turn whose upstream response carried reasoning has a signed thinking block before the first text or tool_use block — or immediately after the tool_use whose signature it carries — on the client stream (https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - every upstream request from turn 2 on carries reasoning back (messages[].reasoning / reasoning_content / reasoning_details) — observation only — no provider doc requires reasoning passback on a plain multi-turn chat with no tool call: DeepSeek's reasoning guide excludes earlier reasoning_content from the next turn's context (https://api-docs.deepseek.com/guides/reasoning_model); OpenRouter frames preservation around tool calling (https://openrouter.ai/docs/use-cases/reasoning-tokens)
- multi-turn-reasoning:responses->openai
  - every turn returns HTTP 200 with the client dialect's event stream (https://platform.openai.com/docs/api-reference/responses-streaming)
  - every turn whose upstream response carried reasoning has a reasoning item before the message or function call on the client stream (https://platform.openai.com/docs/guides/reasoning)
  - every upstream request from turn 2 on carries reasoning back (messages[].reasoning / reasoning_content / reasoning_details) — observation only — no provider doc requires reasoning passback on a plain multi-turn chat with no tool call: DeepSeek's reasoning guide excludes earlier reasoning_content from the next turn's context (https://api-docs.deepseek.com/guides/reasoning_model); OpenRouter frames preservation around tool calling (https://openrouter.ai/docs/use-cases/reasoning-tokens)
- multi-turn-reasoning:anthropic->gemini
  - every turn returns HTTP 200 with the client dialect's event stream (https://docs.anthropic.com/en/api/messages-streaming)
  - every turn whose upstream response carried reasoning has a signed thinking block before the first text or tool_use block — or immediately after the tool_use whose signature it carries — on the client stream (https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - every upstream request from turn 2 on carries the thought signature (contents[].parts[] thoughtSignature / thought:true) — observation only — Gemini documents thoughtSignature only on functionCall parts (https://ai.google.dev/gemini-api/docs/thought-signatures); no doc requires resending signatures on a plain multi-turn chat with no tool call
- multi-turn-reasoning:responses->gemini
  - every turn returns HTTP 200 with the client dialect's event stream (https://platform.openai.com/docs/api-reference/responses-streaming)
  - every turn whose upstream response carried reasoning has a reasoning item before the message or function call on the client stream (https://platform.openai.com/docs/guides/reasoning)
  - every upstream request from turn 2 on carries the thought signature (contents[].parts[] thoughtSignature / thought:true) — observation only — Gemini documents thoughtSignature only on functionCall parts (https://ai.google.dev/gemini-api/docs/thought-signatures); no doc requires resending signatures on a plain multi-turn chat with no tool call

## Scenario × gateway

| scenario | babelgate | babelgate-default | ccr | free-claude-code |
| --- | --- | --- | --- | --- |
| thinking-after-tool:anthropic->openai | pass (live-confirmed 2026-11-24) | fail (live-confirmed 2026-11-24) | fail (live-confirmed 2026-11-24) | pass (live-confirmed 2026-11-24) |
| thinking-after-tool:responses->openai | pass (live-confirmed 2026-11-24) | fail (live-confirmed 2026-11-24) | fail (live-confirmed 2026-11-24) | pass (live-confirmed 2026-11-24) |
| thinking-after-tool:anthropic->gemini | pass (mock) | pass (mock) | pass (mock) | not supported |
| thinking-after-tool:responses->gemini | pass (mock) | pass (mock) | pass (mock) | not supported |
| streamed-tool-args:anthropic->openai | pass (mock) | pass (mock) | pass (mock) | pass (mock) |
| streamed-tool-args:responses->openai | pass (live-confirmed 2026-11-24) | pass (live-confirmed 2026-11-24) | pass (live-confirmed 2026-11-24) | pass (live-confirmed 2026-11-24) |
| multi-turn-reasoning:anthropic->openai | pass (live-confirmed 2026-11-24) | differs (observed, live 2026-11-24) | fail (live-confirmed 2026-11-24) | fail (live-confirmed 2026-11-24) |
| multi-turn-reasoning:responses->openai | pass (live-confirmed 2026-11-24) | differs (observed, live 2026-11-24) | fail (live-confirmed 2026-11-24) | differs (observed, live 2026-11-24) |
| multi-turn-reasoning:anthropic->gemini | pass (mock) | pass (mock) | fail (mock-only, unconfirmed) | not supported |
| multi-turn-reasoning:responses->gemini | pass (mock) | pass (mock) | pass (mock) | not supported |

## Failing cells

- babelgate-default / thinking-after-tool:anthropic->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=babelgate-default npm run test:process -- conformance.process.test.ts
- babelgate-default / thinking-after-tool:responses->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[0] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=babelgate-default npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:anthropic->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:responses->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[0] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->openai: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block (rule: https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:responses->openai: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no output_item.done{type:reasoning, encrypted_content|summary|content} before the first message item (rule: https://platform.openai.com/docs/guides/reasoning)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->gemini: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block (rule: https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- free-claude-code / thinking-after-tool:anthropic->openai: turn 2 upstream response carried reasoning but the client stream has no reasoning block before text or tool call — client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block (rule: https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code npm run test:process -- conformance.process.test.ts
- free-claude-code / multi-turn-reasoning:anthropic->openai: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block (rule: https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code npm run test:process -- conformance.process.test.ts

## Observed differences

Not failures — no cited doc requires the behaviour (Rules).

- babelgate-default / multi-turn-reasoning:anthropic->openai: differs — turn 2 upstream request dropped the reasoning block (turn 2 messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field)
- babelgate-default / multi-turn-reasoning:responses->openai: differs — turn 2 upstream request dropped the reasoning block (turn 2 messages[0] (assistant) carries no reasoning/reasoning_content/reasoning_details field)
- free-claude-code / multi-turn-reasoning:responses->openai: differs — turn 2 upstream request dropped the reasoning block (turn 2 messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field)

## Live confirmation

- babelgate-default / thinking-after-tool:anthropic->openai: `scripts/research/conformance-live.sh babelgate-default "thinking-after-tool:anthropic->openai"`
- babelgate-default / thinking-after-tool:responses->openai: `scripts/research/conformance-live.sh babelgate-default "thinking-after-tool:responses->openai"`
- ccr / thinking-after-tool:anthropic->openai: `scripts/research/conformance-live.sh ccr "thinking-after-tool:anthropic->openai"`
- ccr / thinking-after-tool:responses->openai: `scripts/research/conformance-live.sh ccr "thinking-after-tool:responses->openai"`
- ccr / multi-turn-reasoning:anthropic->openai: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:anthropic->openai"`
- ccr / multi-turn-reasoning:responses->openai: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:responses->openai"`
- ccr / multi-turn-reasoning:anthropic->gemini: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:anthropic->gemini"`
- free-claude-code / thinking-after-tool:anthropic->openai: `scripts/research/conformance-live.sh free-claude-code "thinking-after-tool:anthropic->openai"`
- free-claude-code / multi-turn-reasoning:anthropic->openai: `scripts/research/conformance-live.sh free-claude-code "multi-turn-reasoning:anthropic->openai"`

## Live confirmation (2026-11-24)

Each failing mock cell was rerun against the live provider through
the logging spy (`scripts/research/conformance-live.sh`). A cell is
live-confirmed only when every upstream exchange returned 2xx, every
client turn returned 2xx, and the scenario's verdict failed a rule
that cites a provider doc; every other outcome is inconclusive.

**fail (live-confirmed 2026-11-24):**

- babelgate-default / thinking-after-tool:anthropic->openai: the
  turn-2 upstream request's assistant message carries only
  `content, role, tool_calls` — no reasoning field per
  https://openrouter.ai/docs/use-cases/reasoning-tokens. Upstream
  200.
- babelgate-default / thinking-after-tool:responses->openai: same —
  the turn-2 assistant message carries only `content, role,
  tool_calls`. Upstream 200.
- ccr / thinking-after-tool:anthropic->openai: same — the turn-2
  assistant message carries only `content, role, tool_calls`.
  Upstream 200.
- ccr / thinking-after-tool:responses->openai: same — the turn-2
  assistant message carries only `content, role, tool_calls`.
  Upstream 200.
- ccr / multi-turn-reasoning:responses->openai: turn 1 upstream
  response carried reasoning but the client stream has no reasoning
  block per https://platform.openai.com/docs/guides/reasoning.
  Upstream 200.

**Control (live):** babelgate (the `reasoning_passback` opt-in)
passed `thinking-after-tool:{anthropic,responses}->openai` live —
the turn-2 assistant message carries `reasoning_content` and
OpenRouter answered 200 on every exchange. Limit: OpenRouter's doc
names `reasoning_details`; a 200 shows the field was accepted, not
that it was used.

**INCONCLUSIVE — not confirmations, not failures:**

- ccr / multi-turn-reasoning:anthropic->openai: the vitest run timed
  out (60s) before a verdict.
- ccr / multi-turn-reasoning:anthropic->gemini, and the babelgate
  Gemini controls: Gemini returned 429/503 or timed out on three
  attempts on 2026-11-24 — no clean upstream exchange to judge.
- free-claude-code / thinking-after-tool:anthropic->openai and
  multi-turn-reasoning:anthropic->openai: not confirmed — the
  gateway returned 503 on turn 1 and made no upstream call in live
  mode, while the same cells reach the mock. The cause is not
  diagnosed and may be our live-mode adapter config.

Everything else that fails on the mock stays "fail (mock-only,
unconfirmed)".

## Amendment — Task 13d (2026-11-24)

Two defects found in this run's own method, fixed in this PR:

- **Responses scenarios sent no user question after turn 1.** The
  Responses turns carried user text as bare strings inside the
  `input` array; the Responses API's array items are objects, so
  babelgate's decoder dropped each with a `field_dropped` note and
  the upstream request had no user message from turn 2 on (the
  `messages` shapes in the shapes appendix show it: no leading
  user-length-29 item). Every Responses user turn now sends
  `{role: "user", content: "<text>"}`. The decoder behaviour is
  unchanged; the bug was the scenario's.
- **The live model hid whether sent-back reasoning is used.** The
  OpenRouter default was `deepseek/deepseek-r1-0528`; a same-body
  token probe (`usage.prompt_tokens` non-streaming, max_tokens 16)
  counted 135 with no reasoning field, 135 with `reasoning_content`
  and 135 with `reasoning` — R1's chat template drops earlier-turn
  reasoning, so a reasoning cell could pass live while the model
  never saw it. `deepseek/deepseek-v4.1-flash` counted 361/411/411
  (and kimi-k3 268/318/318, glm-5.3 192/241/241), so it is the new
  `conformance-live.sh` OpenRouter default;
  `CONFORMANCE_LIVE_MODEL_OPENAI` still overrides.

**Mock re-run (2026-11-24, with the scenario fix):** every cell's
mock result is the same as in the 13b draft — the fix changed
request shapes only, not any verdict. The re-captured
`*:responses->*` request shapes are in the shapes appendix.

**Live re-run (2026-11-24):** OpenRouter
`deepseek/deepseek-v4.1-flash` (the earlier live run used
`deepseek/deepseek-r1-0528`); Gemini `gemini-3.5-flash`. Live
result per cell, taken from each verdict file's `result` field —
`fail (live-confirmed)` is a `fail` on a doc-cited rule over
all-2xx exchanges; any non-2xx or timeout is inconclusive:

| gateway | cell | live result |
| --- | --- | --- |
| babelgate | multi-turn-reasoning:anthropic->gemini | inconclusive (upstream 503) |
| babelgate | multi-turn-reasoning:anthropic->openai | pass |
| babelgate | multi-turn-reasoning:responses->gemini | inconclusive (upstream 503) |
| babelgate | multi-turn-reasoning:responses->openai | pass |
| babelgate | streamed-tool-args:responses->openai | pass |
| babelgate | thinking-after-tool:anthropic->gemini | inconclusive (upstream 503) |
| babelgate | thinking-after-tool:anthropic->openai | pass |
| babelgate | thinking-after-tool:responses->gemini | inconclusive (upstream 503) |
| babelgate | thinking-after-tool:responses->openai | pass |
| babelgate-default | multi-turn-reasoning:anthropic->gemini | inconclusive (gateway 504 on turn 1) |
| babelgate-default | multi-turn-reasoning:anthropic->openai | differs (observed) |
| babelgate-default | multi-turn-reasoning:responses->gemini | inconclusive (gateway 504 on turn 3) |
| babelgate-default | multi-turn-reasoning:responses->openai | differs (observed) |
| babelgate-default | streamed-tool-args:responses->openai | pass |
| babelgate-default | thinking-after-tool:anthropic->gemini | inconclusive (upstream 429) |
| babelgate-default | thinking-after-tool:anthropic->openai | fail (live-confirmed) |
| babelgate-default | thinking-after-tool:responses->gemini | inconclusive (upstream 429) |
| babelgate-default | thinking-after-tool:responses->openai | fail (live-confirmed) |
| babelgate-preset | multi-turn-reasoning:anthropic->gemini | inconclusive (test timed out) |
| babelgate-preset | multi-turn-reasoning:anthropic->openai | pass |
| babelgate-preset | multi-turn-reasoning:responses->gemini | inconclusive (upstream 429) |
| babelgate-preset | multi-turn-reasoning:responses->openai | pass |
| babelgate-preset | streamed-tool-args:responses->openai | pass |
| babelgate-preset | thinking-after-tool:anthropic->gemini | inconclusive (gateway 504 on turn 1, no upstream call) |
| babelgate-preset | thinking-after-tool:anthropic->openai | pass |
| babelgate-preset | thinking-after-tool:responses->gemini | inconclusive (upstream 429) |
| babelgate-preset | thinking-after-tool:responses->openai | pass |
| ccr | multi-turn-reasoning:anthropic->gemini | inconclusive (upstream 429) |
| ccr | multi-turn-reasoning:anthropic->openai | fail (live-confirmed) |
| ccr | multi-turn-reasoning:responses->gemini | inconclusive (upstream 429) |
| ccr | multi-turn-reasoning:responses->openai | fail (live-confirmed) |
| ccr | streamed-tool-args:responses->openai | pass |
| ccr | thinking-after-tool:anthropic->gemini | inconclusive (upstream 429) |
| ccr | thinking-after-tool:anthropic->openai | fail (live-confirmed) |
| ccr | thinking-after-tool:responses->gemini | inconclusive (upstream 429) |
| ccr | thinking-after-tool:responses->openai | fail (live-confirmed) |
| free-claude-code | multi-turn-reasoning:anthropic->gemini | not supported |
| free-claude-code | multi-turn-reasoning:anthropic->openai | fail (live-confirmed, 13f re-check) |
| free-claude-code | multi-turn-reasoning:responses->gemini | not supported |
| free-claude-code | multi-turn-reasoning:responses->openai | differs (observed, 13f re-check) |
| free-claude-code | streamed-tool-args:responses->openai | pass (live, 13f re-check) |
| free-claude-code | thinking-after-tool:anthropic->gemini | not supported |
| free-claude-code | thinking-after-tool:anthropic->openai | pass (live, 13f re-check) |
| free-claude-code | thinking-after-tool:responses->gemini | not supported |
| free-claude-code | thinking-after-tool:responses->openai | pass (live, 13f re-check) |

Changes from the 13b draft:

- `ccr / multi-turn-reasoning:anthropic->openai`: was `fail
  (mock-only, unconfirmed)`, now `fail (live-confirmed
  2026-11-24)` — turn 1 upstream response carried reasoning, but
  the client stream had no thinking block.
- `ccr / streamed-tool-args:responses->openai`: pass, now confirmed
  live.
- Every `babelgate`/`babelgate-preset` (opt-in) OpenRouter cell
  passes live on the new model — including the Responses cells,
  which now send a user question every turn.
- Still live-confirmed on the new model: `babelgate-default` and
  `ccr` `thinking-after-tool:{anthropic,responses}->openai`, and
  `ccr multi-turn-reasoning:responses->openai`.
- `free-claude-code / multi-turn-reasoning:anthropic->openai`: was
  `fail (mock-only, unconfirmed)`; on the Task 13f re-check the
  turn-1 upstream response carried reasoning and the client stream
  had no thinking block — recorded `fail (live-confirmed)`.
- `free-claude-code / multi-turn-reasoning:responses->openai`:
  still `differs (observed)`, now observed live — the turn-2
  upstream request dropped the reasoning block.
- `free-claude-code / thinking-after-tool:anthropic->openai`: was
  `fail (mock-only, unconfirmed)`; the re-check recorded `pass
  (live)` — the mock finding did not reproduce on this run.
- `free-claude-code / thinking-after-tool:responses->openai` and
  `streamed-tool-args:responses->openai`: pass, now confirmed
  live.

`conformance-live.sh` printed **PASS** for `babelgate-default`
`multi-turn-reasoning:{anthropic,responses}->openai`, but the
verdict files say `differs`; the cells are recorded as `differs
(observed)` — the mislabel is a known tooling limit (below).

Not confirmable in this run: every `*->gemini` cell, for every
gateway — Gemini returned 429/503 and the gateway returned 504
(quota/overload); a retry 20 minutes later still got 429. Every
`free-claude-code` cell answered HTTP 400 on turn 1 in live mode
and made no upstream call (in the 13b run it answered 503,
likewise with no upstream call) — the Task 13f re-check below
traced the 400 to our adapter's client model ref, and after the
fix those cells produced the live values now in the table.

Passback evidence: `passback-tokens.ts` on the `babelgate-preset`
`thinking-after-tool:anthropic->openai` spy log, two runs, provider
Wafer — `prompt_tokens` none 349 / `reasoning_content` 359 /
`reasoning` 359. The new live model uses the sent-back reasoning.

Known tooling limits (recorded here; all three fixed in v1.6 Task
13f — kept for the record):

- **Spy-log timing race.** `scripts/research/conformance-spy.ts`
  writes an exchange's log line when the upstream response ends
  (`up.on("end")`); `tests/process/conformance.process.test.ts`
  re-reads the log when the client stream completes. If the gateway
  finishes the client stream first, that turn gets no upstream
  requests — the comment at `conformance.process.test.ts` (~line
  363, "the spy writes before forwarding") does not match the code.
  Observed once: `babelgate-preset
  multi-turn-reasoning:responses->openai` reported "turn 2 upstream
  request dropped the reasoning block" while the spy log's turn-2
  body carried non-empty `reasoning_content`; two reruns passed.
  Every live-confirmed failure listed above was checked against its
  spy log — the turn-2 assistant message has no reasoning field
  there, so those confirmations stand. *Fixed in 13f:* the spy
  counts in-flight exchanges and answers `GET /__inflight`; live
  turns drain it (50 ms polls, 10 s cap) before re-reading the log,
  and a drain timeout records the turn INCONCLUSIVE, never a
  failure.
- **Verdict mislabel.** `conformance-verdict.ts` prints
  `PASS (live)` for a verdict file whose result is `differs`.
  *Fixed in 13f:* the verdict file is read before the vitest exit
  code — `differs` prints `DIFFERS (observed) — <reason>`, `not
  supported` prints `NOT SUPPORTED`, an `inconclusive` verdict
  prints INCONCLUSIVE with its recorded cause.
- **free-claude-code made no upstream call.** Every FCC live cell
  answered 400 (13d; 503 in 13b) on turn 1 with an empty spy log,
  and the adapter kept no gateway output to diagnose it. *Fixed in
  13f:* the cause was the adapter's client model ref — FCC routes
  `provider/model` on the request's own model field, and a bare
  `deepseek/deepseek-v4.1-flash` matched its built-in `deepseek`
  provider (api.deepseek.com, no key), never the configured custom
  provider. The client ref now carries the `custom_<id>` prefix,
  `model_ids` keeps the bare upstream id, and FCC stdout/stderr tee
  to `tmp/conformance/live/<gateway>-<scenario>.gateway.log` in live
  mode (spy-style key redaction, never bodies).

### Task 13f re-check (2026-11-24)

Step 5 of Task 13f, run live on this PR's branch on 2026-11-24 —
one run per cell on OpenRouter `deepseek/deepseek-v4.1-flash`, the
verdict taken from each cell's verdict file. Step 5's cell list:
the `babelgate-default` and `ccr` cells the 13d table records as
`fail (live-confirmed)` or `differs`, and every `free-claude-code`
OpenRouter cell. The FCC gateway logs were read — HTTP 200 on
every request, no keys, no bodies; the spy shows 2xx upstream
exchanges with reasoning in the response for every FCC cell, and
every client status is 200.

- `babelgate-default` — identical to the 13d table:
  `thinking-after-tool:{anthropic,responses}->openai` stay `fail
  (live-confirmed)` (the turn-2 upstream request carries no
  reasoning field per
  https://openrouter.ai/docs/use-cases/reasoning-tokens) and
  `multi-turn-reasoning:{anthropic,responses}->openai` stay
  `differs (observed)` (the turn-2 upstream request dropped the
  reasoning block). Only the label is new: the fixed verdict tool
  prints `DIFFERS (observed)` for these cells.
- `ccr` — identical to the 13d table:
  `multi-turn-reasoning:{anthropic,responses}->openai` stay `fail
  (live-confirmed)` (the turn-1 upstream response carried
  reasoning, the client stream has no reasoning block per
  https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  and https://platform.openai.com/docs/guides/reasoning) and
  `thinking-after-tool:{anthropic,responses}->openai` stay `fail
  (live-confirmed)` (the turn-2 upstream request carries no
  reasoning field).
- `free-claude-code` — all five OpenRouter cells resolved from
  `inconclusive (gateway 400 on turn 1, no upstream call)`; the
  table above carries the new values:
  - `multi-turn-reasoning:anthropic->openai` — `fail
    (live-confirmed)`: the turn-1 upstream response carried
    reasoning and the client stream has no reasoning block (rule:
    https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
  - `multi-turn-reasoning:responses->openai` — `differs
    (observed)`: the turn-2 upstream request dropped the reasoning
    block.
  - `streamed-tool-args:responses->openai`,
    `thinking-after-tool:{anthropic,responses}->openai` — `pass
    (live)`.
  FCC now reaches the upstream because of this PR's adapter fix —
  the client model ref carries `FCC_PROVIDER_ID`, so a bare
  `deepseek/<model>` no longer routes to FCC's built-in `deepseek`
  provider. The earlier 400/503 were our adapter config, not a
  free-claude-code bug.

These `free-claude-code` results are new versus the 13b draft and
the 13d table and are subject to the owner's D9 decision before
anything public is said about free-claude-code; they are reported
as observed on this run, and no gateway-vs-gateway conclusion is
drawn from them.

Not re-run (outside the task's Step 5 cell list): the three
re-checked gateways' `*->gemini` rows and free-claude-code's
`not supported` rows — they keep their 13d values.

### Task 13g repeats and diagnosis (2026-11-24)

Step 1 (live repeats, run by the conductor on this branch): each
non-passing free-claude-code cell ran three times and each passing
cell once more — same pin (v6.15.0, e8806fb608ac), same live model
(`deepseek/deepseek-v4.1-flash` via OpenRouter). Every upstream
exchange and client turn returned HTTP 200; per-run spy logs,
verdicts, vitest logs and redacted gateway logs sit under
`tmp/conformance/live/repeats/` (`run<N>-<scenario>.<ext>`,
gitignored, not committed). Per-run results — all runs agreed, so
each cell is reported as its result:

| cell | run 1 | run 2 | run 3 | final label |
| --- | --- | --- | --- | --- |
| multi-turn-reasoning:anthropic->openai | fail (live-confirmed) | fail (live-confirmed) | fail (live-confirmed) | fail (live-confirmed 2026-11-24), 3 of 3 |
| multi-turn-reasoning:responses->openai | differs (observed) | differs (observed) | differs (observed) | differs (observed, live 2026-11-24), 3 of 3 |
| streamed-tool-args:responses->openai | pass (13f re-check) | pass (live) | — | pass (live-confirmed 2026-11-24), 2 of 2 |
| thinking-after-tool:anthropic->openai | pass (13f re-check) | pass (live) | — | pass (live-confirmed 2026-11-24), 2 of 2 |
| thinking-after-tool:responses->openai | pass (13f re-check) | pass (live) | — | pass (live-confirmed 2026-11-24), 2 of 2 |

`streamed-tool-args:anthropic->openai` keeps `pass (mock)` — it was
never run live.

Diagnosis, from the spy logs plus FCC source at the pinned commit —
the cause for both non-passing cells is in free-claude-code itself,
not in our adapter config: no `FCC_CUSTOM_PROVIDERS` field covers
either behaviour (the complete field set is
`src/free_claude_code/config/custom_providers.py:33-47`, a pydantic
`extra="forbid"` model), so the adapter is unchanged and no cell
needs a rerun.

- `multi-turn-reasoning:anthropic->openai` — `fail (live-confirmed)`:
  FCC does emit reasoning to an Anthropic client without any setting
  — reasoning output is on whenever the request isn't reasoning-off
  (`output_enabled`,
  `src/free_claude_code/core/reasoning.py:107-111`; suppression only
  under a prefer-off classifier policy,
  `src/free_claude_code/api/stream_delivery.py:66` +
  `src/free_claude_code/api/handlers/messages.py:164`) and the chat
  transport opens a `thinking` block for upstream
  `reasoning_content` deltas
  (`src/free_claude_code/providers/openai_chat/transport.py:318-328`,
  `src/free_claude_code/providers/openai_chat/stream_output.py:429-439`)
  — but the block is always unsigned on a custom provider:
  `signature_delta` is emitted only from upstream-supplied signed or
  encrypted `reasoning_details` (`_reasoning_detail_opaque`,
  `src/free_claude_code/providers/openai_chat/reasoning_details.py:252-263`;
  `_attach_reasoning_replay`,
  `src/free_claude_code/providers/openai_chat/stream_output.py:448-453`)
  through `StructuredReasoningStream`, which exists only when the
  profile's `structured_reasoning_details` is set
  (`src/free_claude_code/providers/openai_chat/transport.py:213-219`)
  — a flag the custom-provider profile leaves `False`
  (`src/free_claude_code/providers/custom.py:159-167`,
  `src/free_claude_code/providers/openai_chat/profiles.py:131`) and
  no config can set. DeepSeek's `reasoning_content` carries no
  signature — the turn-2 spy request shows the echoed reasoning
  coming back as appended assistant `content` text, proving the
  client did receive a (unsigned) thinking block — so the signed
  thinking block the cited Anthropic doc requires can never appear
  on this provider.
- `multi-turn-reasoning:responses->openai` — `differs (observed)`:
  `reasoning_history_format: "reasoning_content"` is honoured — the
  echoed Responses reasoning item does become `reasoning_content`
  on the chat assistant message (`_apply_pending_reasoning` /
  `_apply_reasoning_text`,
  `src/free_claude_code/core/openai_responses/chat_request.py:301-339`
  and `:572-580`) — but `prepare_history` runs at the profile's
  `HistoryScope.TOOL_CONTINUATION`
  (`src/free_claude_code/providers/openai_chat/profiles.py:132`,
  `src/free_claude_code/providers/openai_chat/behavior.py:68-69`;
  unchanged for custom providers,
  `src/free_claude_code/providers/custom.py:160-167`), which keeps
  `reasoning_content` only on an assistant message that follows the
  last non-tool-result user message and is itself followed by tool
  results (`src/free_claude_code/core/history_replay.py:466-496`);
  on a plain multi-turn chat it pops the field and appends the text
  to `content` (`src/free_claude_code/core/history_replay.py:619-623`,
  `_append_context` `:551-562`) — exactly what all three repeats'
  spy logs show. The scope is not a `FCC_CUSTOM_PROVIDERS` field
  (`custom_providers.py:33-47`); even FCC's built-in DeepSeek
  provider uses `HistoryScope.UNKNOWN`, not `ALL`, for tool-less
  bodies (`src/free_claude_code/providers/deepseek/client.py:57-58`).
  `differs` stays an observation: no cited doc requires passback on
  a plain multi-turn chat.
- The three passing cells stay `pass (live-confirmed)` — the
  thinking-after-tool runs show the same scope from the other side:
  on the tool-call turn `reasoning_content` did ride upstream (the
  spy's turn-2 assistant message carries it), and the client-stream
  check was n/a because that turn's live upstream response carried
  no reasoning.

Whether the unsigned-thinking behaviour is a reportable upstream
bug is the owner's decision under spec §3.10 / D9; no issue has been
filed.

**What we may say:** these results are observed on this run only —
three agreeing runs for the two non-passing cells, two for the
passing ones; no verdict language about free-claude-code the
project; nothing in README, recipes, launch or site copy until the
owner decides under D9.

## Not supported

- free-claude-code / thinking-after-tool:anthropic->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / thinking-after-tool:responses->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / multi-turn-reasoning:anthropic->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / multi-turn-reasoning:responses->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)

## Reproduce

```sh
CONFORMANCE_GATEWAYS=babelgate,babelgate-default,ccr,free-claude-code npm run test:process -- conformance.process.test.ts
scripts/research/conformance-run.sh   # installs pinned competitors, runs, rewrites this report
```
