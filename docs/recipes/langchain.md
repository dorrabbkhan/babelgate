# Recipe: LangChain apps on any backend through babelgate

LangChain's `ChatOpenAI` takes a custom `baseURL` in its `configuration`
block, so JS/TS chains and agents can run against babelgate's OpenAI
surface — on any provider behind it, free presets included — with
streaming and tool calls translated as usual.

You need: Node ≥ 22 (for `npx` and the SDK's own engine floor), a
reachable target, and the packages below.

> **Checked in CI, not by hand:** `examples/sdk/sdk.examples.test.ts`
> runs this page's example file (`examples/sdk/langchain.ts`) on every
> `npm test` — `ChatOpenAI` makes a real HTTP call to babelgate's
> listener while the upstream answer is a recorded fixture, on the
> OpenAI→Gemini path. Pinned: `@langchain/openai` 1.8.4 +
> `@langchain/core` 1.5.0. Written against
> [LangChain's ChatOpenAI page](https://docs.langchain.com/oss/javascript/integrations/chat/openai)
> (accessed 2026-11-23), which documents the `configuration.baseURL`
> override used below.

## Install

```bash
npm i @langchain/openai @langchain/core
```

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free --preset openai-apps
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. `babelgate presets`
lists every preset with its tier, key env var and the docs it was
verified against (`gemini-free`, `groq`, `nvidia-nim` and `cerebras` are
the other free-tier entries — free tier per each provider's docs, dated
on that row).

babelgate prints:

```
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=babelgate
```

`ChatOpenAI` reads `OPENAI_API_KEY` from the environment but **not**
`OPENAI_BASE_URL` — pass `baseURL` in code as below. The key line is the
value to use: `babelgate` is a placeholder for local dev (no
`PROXY_API_KEY` → no client auth); with `PROXY_API_KEY` set, pass that
key instead.

## Point LangChain at it

```ts
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "nvidia/nemotron-3-ultra-550b-a55b:free",
  apiKey: "babelgate", // or your PROXY_API_KEY
  configuration: { baseURL: "http://localhost:3000/v1" },
});
const reply = await model.invoke("Say hello in one short sentence.");
console.log(reply.content);
```

- `baseURL` keeps the `/v1` suffix — babelgate's OpenAI surface lives
  under it.
- `model` is forwarded to the provider unchanged, so send a name it
  serves (a `:free` slug on `openrouter-free`, `gemini-3.8-flash` on
  `gemini-free`) — or rename with `MODEL_MAP`.
- `maxRetries: 0` is worth setting while testing: LangChain otherwise
  retries failures on its own, which hides the provider's real answer
  behind extra upstream calls.

## The CI-checked example

`examples/sdk/langchain.ts` exports `run(baseUrl)` and doubles as a
script:

```bash
npx ts-node examples/sdk/langchain.ts http://localhost:3000/v1
```

## What works, what doesn't

- **Chat turns** — `.invoke()` non-streaming and `.stream()` SSE chunks
  ([cells](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — `.bindTools()` schemas and the agent tool loop
  translate to the target
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
- **Structured output** — `withStructuredOutput` maps to
  `response_format` ([`structured`](../compatibility.md#structured-output-structured));
  a target without schema output either reports the gap or gets the
  provider's own error, never a silent drop.
- **Errors** arrive in OpenAI's error shape — a free tier's daily cap
  surfaces as an ordinary LangChain model error with the preset hint.
- **Not covered by the CI check:** `useResponsesApi: true` sends
  Responses-API requests instead of Chat Completions — babelgate serves
  that dialect too (`POST /v1/responses`), but the checked example runs
  Chat Completions only; multimodal blocks and embeddings likewise
  follow the general matrix, not this recipe's check.
