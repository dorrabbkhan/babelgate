# Conformance run — 2026-11-23 — DRAFT

Draft per spec §3.10/D9: private to the PR; publishing decisions
are the owner's. Competitor failures are mock-only, unconfirmed
until scripts/research/conformance-live.sh confirms them against
the live provider.

## Versions

- babelgate: local build (node dist/cli.js)
- ccr: @musistudio/claude-code-router 3.1.6 (npm, --ignore-scripts)
- free-claude-code: Alishahryar1/free-claude-code v6.15.0 (e8806fb608ac, uv sync --frozen)

## Scenario × gateway

| scenario | babelgate | ccr | free-claude-code |
| --- | --- | --- |
| thinking-after-tool:anthropic->openai | replay pending | replay pending | replay pending |
| thinking-after-tool:responses->openai | replay pending | replay pending | replay pending |
| thinking-after-tool:anthropic->gemini | replay pending | replay pending | not supported |
| thinking-after-tool:responses->gemini | replay pending | replay pending | not supported |
| streamed-tool-args:anthropic->openai | pass (mock) | pass (mock) | pass (mock) |
| streamed-tool-args:responses->openai | pass (mock) | pass (mock) | pass (mock) |
| multi-turn-reasoning:anthropic->openai | replay pending | replay pending | replay pending |
| multi-turn-reasoning:responses->openai | replay pending | replay pending | replay pending |
| multi-turn-reasoning:anthropic->gemini | replay pending | replay pending | not supported |
| multi-turn-reasoning:responses->gemini | replay pending | replay pending | not supported |

## Failing cells (shapes only)

- babelgate / thinking-after-tool:anthropic->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / thinking-after-tool:responses->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / thinking-after-tool:anthropic->gemini: replay gemini/thinking_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / thinking-after-tool:responses->gemini: replay gemini/thinking_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / multi-turn-reasoning:anthropic->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / multi-turn-reasoning:responses->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / multi-turn-reasoning:anthropic->gemini: replay gemini/thinking.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- babelgate / multi-turn-reasoning:responses->gemini: replay gemini/thinking.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=babelgate CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:anthropic->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:responses->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:anthropic->gemini: replay gemini/thinking_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / thinking-after-tool:responses->gemini: replay gemini/thinking_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:responses->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:anthropic->gemini: replay gemini/thinking.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- ccr / multi-turn-reasoning:responses->gemini: replay gemini/thinking.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=ccr CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- free-claude-code / thinking-after-tool:anthropic->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- free-claude-code / thinking-after-tool:responses->openai: replay openai/reasoning_tool_call.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- free-claude-code / multi-turn-reasoning:anthropic->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts
- free-claude-code / multi-turn-reasoning:responses->openai: replay openai/reasoning.sse not recorded (conductor recording step)
  - repro: CONFORMANCE_GATEWAYS=free-claude-code CONFORMANCE_REPLAY=1 npm run test:process -- conformance.process.test.ts

## Not supported

- free-claude-code / thinking-after-tool:anthropic->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / thinking-after-tool:responses->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / multi-turn-reasoning:anthropic->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)
- free-claude-code / multi-turn-reasoning:responses->gemini: not supported (per https://github.com/Alishahryar1/free-claude-code — gemini upstream is a fixed Google OpenAI-compatible endpoint)

## Reproduce

```sh
CONFORMANCE_GATEWAYS=babelgate,ccr,free-claude-code npm run test:process -- conformance.process.test.ts
scripts/research/conformance-run.sh   # installs pinned competitors, runs, rewrites this report
```
