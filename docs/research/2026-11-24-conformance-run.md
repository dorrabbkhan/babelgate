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
| thinking-after-tool:anthropic->openai | pass (mock) | fail (mock-only, unconfirmed) | fail (mock-only, unconfirmed) | fail (mock-only, unconfirmed) |
| thinking-after-tool:responses->openai | pass (mock) | fail (mock-only, unconfirmed) | fail (mock-only, unconfirmed) | pass (mock) |
| thinking-after-tool:anthropic->gemini | pass (mock) | pass (mock) | fail (mock-only, unconfirmed) | not supported |
| thinking-after-tool:responses->gemini | pass (mock) | pass (mock) | fail (mock-only, unconfirmed) | not supported |
| streamed-tool-args:anthropic->openai | pass (mock) | pass (mock) | pass (mock) | pass (mock) |
| streamed-tool-args:responses->openai | pass (mock) | pass (mock) | pass (mock) | pass (mock) |
| multi-turn-reasoning:anthropic->openai | pass (mock) | differs (observed) | fail (mock-only, unconfirmed) | fail (mock-only, unconfirmed) |
| multi-turn-reasoning:responses->openai | pass (mock) | differs (observed) | fail (mock-only, unconfirmed) | differs (observed) |
| multi-turn-reasoning:anthropic->gemini | pass (mock) | pass (mock) | fail (mock-only, unconfirmed) | not supported |
| multi-turn-reasoning:responses->gemini | pass (mock) | pass (mock) | fail (mock-only, unconfirmed) | not supported |

## Failing cells

- babelgate-default / thinking-after-tool:anthropic->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=babelgate-default npm run test:process -- conformance.process.test.ts
- babelgate-default / thinking-after-tool:responses->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[0] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=babelgate-default npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:anthropic->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[1] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:responses->openai: turn 2 upstream request carries no reasoning field per the target's wire rules — messages[0] (assistant) carries no reasoning/reasoning_content/reasoning_details field (rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:anthropic->gemini: turn 1 status 502 — turn 1 client response HTTP 502 (rule: https://docs.anthropic.com/en/api/messages-streaming)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:responses->gemini: turn 1 status 502 — turn 1 client response HTTP 502 (rule: https://platform.openai.com/docs/api-reference/responses-streaming)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->openai: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block (rule: https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:responses->openai: turn 1 upstream response carried reasoning but the client stream has no reasoning block — turn 1 client SSE: no output_item.done{type:reasoning, encrypted_content|summary|content} before the first message item (rule: https://platform.openai.com/docs/guides/reasoning)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->gemini: turn 1 status 502 — turn 1 client response HTTP 502 (rule: https://docs.anthropic.com/en/api/messages-streaming)
  - repro: CONFORMANCE_GATEWAYS=ccr npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:responses->gemini: turn 1 status 502 — turn 1 client response HTTP 502 (rule: https://platform.openai.com/docs/api-reference/responses-streaming)
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
- ccr / thinking-after-tool:anthropic->gemini: `scripts/research/conformance-live.sh ccr "thinking-after-tool:anthropic->gemini"`
- ccr / thinking-after-tool:responses->gemini: `scripts/research/conformance-live.sh ccr "thinking-after-tool:responses->gemini"`
- ccr / multi-turn-reasoning:anthropic->openai: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:anthropic->openai"`
- ccr / multi-turn-reasoning:responses->openai: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:responses->openai"`
- ccr / multi-turn-reasoning:anthropic->gemini: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:anthropic->gemini"`
- ccr / multi-turn-reasoning:responses->gemini: `scripts/research/conformance-live.sh ccr "multi-turn-reasoning:responses->gemini"`
- free-claude-code / thinking-after-tool:anthropic->openai: `scripts/research/conformance-live.sh free-claude-code "thinking-after-tool:anthropic->openai"`
- free-claude-code / multi-turn-reasoning:anthropic->openai: `scripts/research/conformance-live.sh free-claude-code "multi-turn-reasoning:anthropic->openai"`

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
