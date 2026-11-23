# Recipe: Vercel AI SDK apps on any backend through babelgate

The Vercel AI SDK's `createOpenAI` takes a `baseURL`, so `generateText`
/ `streamText` calls — including the SDK's multi-step tool loop — can
run against babelgate's OpenAI surface on any provider behind it, free
presets included.

You need: Node ≥ 22 (the SDK's engine floor and `npx`), a reachable
target, and the packages below.

> **Checked in CI, not by hand:** `examples/sdk/sdk.examples.test.ts`
> runs this page's example file (`examples/sdk/vercel-ai-sdk.ts`) on
> every `npm test` — `generateText` makes real HTTP calls to
> babelgate's listener while the upstream answers are recorded
> fixtures, including a two-turn tool call (`tool_call` reply →
> `role: "tool"` message back through the gateway). Pinned: `ai`
> 7.0.173 + `@ai-sdk/openai` 4.0.118. Written against the
> [AI SDK OpenAI provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
> and the [`generateText` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)
> (both accessed 2026-11-23).

## Install

```bash
npm i ai @ai-sdk/openai
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

`createOpenAI` reads **both** from the environment
(`OPENAI_BASE_URL`, `OPENAI_API_KEY` per the provider source linked
above), so exporting the two lines is enough — or pass them in code.
`babelgate` is the placeholder key for local dev; with `PROXY_API_KEY`
set, pass that key instead.

## Point the AI SDK at it

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "babelgate", // or your PROXY_API_KEY
});
const { text } = await generateText({
  model: openai.chat("nvidia/nemotron-3-ultra-550b-a55b:free"),
  prompt: "Say hello in one short sentence.",
});
```

- `baseURL` keeps the `/v1` suffix.
- **`openai.chat(<model>)` pins Chat Completions.** Calling the provider
  directly — `openai(<model>)` or `openai.responses(<model>)` — sends
  Responses-API requests instead; babelgate serves that dialect too
  (`POST /v1/responses`), so both work, but the checked example pins
  `.chat()`.
- `model` is forwarded to the provider unchanged, so send a name it
  serves — or rename with `MODEL_MAP`.

## The CI-checked example

`examples/sdk/vercel-ai-sdk.ts` exports `run(baseUrl)` — it registers a
`get_weather` tool, lets `generateText` run the tool loop under
`stopWhen: stepCountIs(3)`, and returns the final text. Run it:

```bash
npx ts-node examples/sdk/vercel-ai-sdk.ts http://localhost:3000/v1
```

## What works, what doesn't

- **Text generation** — `generateText` and `streamText`
  ([cells](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — `tools` + `execute` + `stopWhen` drive the multi-step
  loop through the gateway both ways
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
- **Structured output** — `generateObject` maps to `response_format`
  ([`structured`](../compatibility.md#structured-output-structured)).
- **Errors** arrive in OpenAI's error shape — a free tier's daily cap
  surfaces as an `APICallError` with the preset hint.
- **Not covered by the CI check:** `streamObject`, embeddings
  (`openai.embedding`), the Responses-API factory and provider-specific
  options follow the general matrix, not this recipe's check.
