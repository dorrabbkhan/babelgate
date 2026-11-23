# Recipe: Ollama-only apps on cloud models through babelgate

Apps hard-wired to Ollama's API — anything calling `POST /api/chat`,
including the `ollama` JS library's `new Ollama({ host })` — can run on
**cloud models they could never speak to directly**: point the app's
Ollama host at babelgate and its requests come out the other side in
whatever provider's dialect you configured. This is the matrix's unique
cell: an Ollama client on a non-Ollama backend.

You need: Node ≥ 22 (for `npx`), an Ollama-speaking app, and a reachable
target — no local Ollama install required.

> **Checked in CI, not by hand:** `examples/sdk/sdk.examples.test.ts`
> runs this page's example file (`examples/sdk/ollama-app.ts`) on every
> `npm test` — the `ollama` JS library makes a real HTTP call to
> babelgate's listener while the upstream answer is a recorded fixture,
> on the Ollama→Gemini path. Pinned: `ollama` 0.6.4. Written against the
> [ollama-js README](https://github.com/ollama/ollama-js) (custom
> client `host`) and [Ollama's API docs](https://docs.ollama.com/api)
> (accessed 2026-11-23).

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. Without a
`--preset`, babelgate prints one endpoint per client dialect — the
Ollama line is the app's new host:

```
OpenAI     http://localhost:3000/v1
Anthropic  http://localhost:3000
Gemini     http://localhost:3000
Ollama     http://localhost:3000
UI         http://localhost:3000/ui
```

## Point the app at it

With the `ollama` JS library:

```ts
import { Ollama } from "ollama";

const client = new Ollama({ host: "http://localhost:3000" });
const reply = await client.chat({
  model: "nvidia/nemotron-3-ultra-550b-a55b:free",
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
  stream: false,
});
console.log(reply.message.content);
```

- `host` is the bare origin — **no `/api` suffix**: the library appends
  `/api/chat` itself, and babelgate's Ollama surface lives there.
- `stream: false` asks for the single JSON reply; omit it (or pass
  `stream: true`) and you get NDJSON chunks like Ollama's own API.
- `model` is forwarded to the provider unchanged — send a name it
  serves (a `:free` slug on `openrouter-free`, `gemini-3.8-flash` on
  `gemini-free`), or rename with `MODEL_MAP`. An app that insists on an
  Ollama-style name (`qwen3-coder:30b`) works too: `MODEL_MAP` maps it
  to the cloud model on the babelgate side.
- `PROXY_API_KEY` set? Pass it via the library's `headers` option:
  `new Ollama({ host, headers: { Authorization: "Bearer <key>" } })`.
- `GET /api/tags` is served — apps that list models see the merged
  catalog across your providers.

## The CI-checked example

`examples/sdk/ollama-app.ts` exports `run(baseUrl)` and doubles as a
script:

```bash
npx ts-node examples/sdk/ollama-app.ts http://localhost:3000
```

## What works, what doesn't

- **Chat** — `POST /api/chat`, non-streaming and NDJSON streaming
  ([cells](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — Ollama `tools` and `tool_calls` results translate
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools));
  keep `tool_name` on tool-result messages — a result without one can
  fail to pair on strict targets.
- **`GET /api/tags`** — the merged model catalog.
- **Embeddings — not served:** `POST /api/embed` returns 404 —
  inbound embeddings are OpenAI-dialect only (`POST /v1/embeddings`),
  and `/api/embed` exists only as an outbound path when Ollama is the
  target. An Ollama app that needs embeddings should point that one
  call at `/v1/embeddings` through an OpenAI-style client, or at
  Ollama directly.
- **Not served:** `pull`, `show`, `create`, `generate`,
  `api/version` — model management stays at the provider; apps that
  probe `/api/version` in a verify step (Open WebUI's Ollama-mode
  verify button does) report "network problem" even though chat works —
  save the connection anyway or use OpenAI mode (see
  [the Open WebUI recipe](open-webui.md)).
- **Errors** arrive in Ollama's error shape.
