# Recipe: LlamaIndex apps on any backend through babelgate

LlamaIndex.TS's `OpenAI` LLM takes a `baseURL`, so RAG pipelines and
agents can run against babelgate's OpenAI surface — on any provider
behind it, free presets included — with streaming and tool calls
translated as usual.

You need: Node ≥ 18 (LlamaIndex's engine floor; ≥ 22 for `npx
babelgate`), a reachable target, and the packages below.

> **Checked in CI, not by hand:** `examples/sdk/sdk.examples.test.ts`
> runs this page's example file (`examples/sdk/llamaindex.ts`) on every
> `npm test` — the SDK makes a real HTTP call to babelgate's listener
> while the upstream answer is a recorded fixture, on the
> OpenAI→Anthropic path. Pinned: `llamaindex` 0.12.1 +
> `@llamaindex/openai` 0.4.22 (the provider package the LLM classes
> live in; `llamaindex` alone ships no provider). Written against
> [LlamaIndex's OpenAI page](https://developers.llamaindex.ai/typescript/framework/modules/models/llms/openai/)
> (accessed 2026-11-23), which documents `baseURL`.

## Install

```bash
npm i llamaindex @llamaindex/openai
```

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free --preset openai-apps
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. `babelgate presets`
lists every preset with its tier, key env var and the docs it was
verified against.

babelgate prints:

```
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=babelgate
```

`OpenAI` **does** read `OPENAI_BASE_URL` from the environment (per the
docs linked above), so exporting the two lines works — but passing
`baseURL` in code is the same thing and keeps the value next to the
model name. `babelgate` is the placeholder key for local dev; with
`PROXY_API_KEY` set, pass that key instead.

## Point LlamaIndex at it

```ts
import { OpenAI } from "@llamaindex/openai";

const llm = new OpenAI({
  model: "nvidia/nemotron-3-ultra-550b-a55b:free",
  apiKey: "babelgate", // or your PROXY_API_KEY
  baseURL: "http://localhost:3000/v1",
});
const reply = await llm.chat({
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});
console.log(reply.message.content);
```

- `baseURL` keeps the `/v1` suffix — babelgate's OpenAI surface lives
  under it.
- `model` is forwarded to the provider unchanged, so send a name it
  serves — or rename with `MODEL_MAP`.
- `maxRetries: 0` while testing: the default is 10 retries, which can
  sit on a provider error for a while.

## The CI-checked example

`examples/sdk/llamaindex.ts` exports `run(baseUrl)` and doubles as a
script:

```bash
npx ts-node examples/sdk/llamaindex.ts http://localhost:3000/v1
```

## What works, what doesn't

- **Chat turns** — `.chat()` non-streaming and its streaming overload
  ([cells](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — `tools` in chat params and agent workers translate
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
- **Errors** arrive in OpenAI's error shape — a free tier's daily cap
  surfaces as an ordinary SDK error with the preset hint.
- **Not covered by the CI check:** the `OpenAIResponses` class speaks
  the Responses API — babelgate serves that dialect too
  (`POST /v1/responses`), but the checked example runs Chat
  Completions only; embeddings (`OpenAIEmbedding` → `POST
  /v1/embeddings`) and RAG stores follow the general matrix, not this
  recipe's check.
