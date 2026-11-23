# babelgate

**The translator you can check.** A small proxy that sits in front of
LLM APIs and translates between their request/response formats —
streaming, tool calls, reasoning and media included. Point your
OpenAI client at it, and it can talk to Gemini, Ollama, or Anthropic behind
the scenes — and vice versa. Point Claude Code or Codex CLI at it, and it
runs on any tool-capable model you can reach.

Supported providers right now:

- OpenAI (and OpenAI-compatible backends like OpenRouter)
- Google Gemini
- Ollama
- Anthropic (Claude)

…and five client-facing formats, the fifth being the OpenAI **Responses**
API (`POST /v1/responses`) — what Codex CLI speaks. A `type: responses`
provider also gets byte-preserving pass-through to Responses-native
upstreams (OpenRouter's Responses API, vLLM, Ollama's Responses endpoint,
…): [docs/recipes/codex.md](docs/recipes/codex.md).

The "check" is the product:

- **A published compatibility matrix** — every source × target ×
  feature cell, generated from the tests:
  [docs/compatibility.md](docs/compatibility.md).
- **The translation inspector** — source, canonical and target side by
  side, every dropped field named (`/ui`, see below).
- **Small and auditable** — a cosign-signed container image, a
  CycloneDX SBOM attached to each release, few runtime dependencies:
  [SECURITY.md](SECURITY.md).
- **A shim for native endpoints** — where a provider already speaks the
  client's format, babelgate passes through and fixes the gaps that
  endpoint leaves: [docs/recipes/native-endpoints.md](docs/recipes/native-endpoints.md).

![Codex CLI fixing a failing test through babelgate, bridged to Claude on OpenRouter](docs/assets/demo-codex.gif)
*Recorded with [scripts/demo](scripts/demo/); the model's thinking time is cut.*

![Claude Code fixing the same failing test through babelgate on a free OpenRouter model](docs/assets/demo.gif)
*Recorded with [scripts/demo](scripts/demo/); the model's thinking time is cut.*

## How is this different?

Putting Claude Code or Codex on another model is table stakes — several
tools do it. babelgate is the one whose translations you can verify:

| | babelgate | LiteLLM · Bifrost · CCR | OpenRouter · CF AI Gateway |
|---|---|---|---|
| Per-pair conformance matrix, published | ✓ generated from tests | not documented | not documented |
| Inspector: source → canonical → target diff | ✓ | ◐ request logs | ◐ logs / debug echo |
| Native-endpoint shim with declared gaps | ✓ presets + `gaps:` | not documented | not documented |
| Replays each new Claude Code / Codex release | ✓ weekly job | not documented | not documented |

The honest trade-offs — provider count, MCP gateway, semantic cache,
load balancing, team governance, a hosted option — all belong to the
others, and the full dated matrix says "use X if you need that":
[docs/comparison.md](docs/comparison.md).

## Quick start: Claude Code on a local model

```bash
ollama pull qwen3-coder:30b
OLLAMA_API_BASE_URL=http://localhost:11434 \
  npx babelgate --preset claude-code --target ollama --model qwen3-coder:30b
```

babelgate prints the two lines Claude Code needs:

```
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_AUTH_TOKEN=babelgate
```

Export them in your shell, then:

```bash
claude
```

Claude Code talks Anthropic format to babelgate; babelgate streams it to
Ollama — tools included. Two honest caveats on this exact path: the release
gate passed on hosted OpenRouter models, not on local `qwen3-coder:30b`, and
small local models call tools unreliably — see
[Known limitations](#known-limitations).

### Claude Code on OpenRouter (or any OpenAI-compatible backend)

```bash
OPENAI_API_KEY=<your OpenRouter key> \
  npx babelgate --preset claude-code --target openai \
  --model qwen/qwen3-coder --base-url https://openrouter.ai/api
```

The base URL is `https://openrouter.ai/api` — babelgate appends
`/v1/chat/completions` itself. If your OpenRouter key has a spend limit,
cap the output budget at the proxy or requests can be rejected:

```bash
TARGET_MAX_OUTPUT_TOKENS=8000 \
  npx babelgate --preset claude-code --target openai \
  --model qwen/qwen3-coder --base-url https://openrouter.ai/api
```

(In a `babelgate.yaml` it's the provider's `max_output_tokens` key.)

Then the same two `export` lines and `claude`. Full walkthrough:
[docs/recipes/claude-code.md](docs/recipes/claude-code.md).

### Any OpenAI-SDK app on any backend

```bash
OLLAMA_API_BASE_URL=http://localhost:11434 \
  npx babelgate --preset openai-apps --target ollama
```

prints:

```
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=babelgate
```

The app sends whatever model name it likes — it's forwarded to the target
unchanged (send a name the target knows, like `qwen3-coder:30b`, or rename
with `MODEL_MAP`). Recipe: [docs/recipes/openai-sdk.md](docs/recipes/openai-sdk.md).

### Recommended tool-capable models

- **Verified through the release gate** (Claude Code completed a real edit
  task through babelgate): `qwen/qwen3-coder` and `poolside/laguna-s-2.1:free`
  on OpenRouter.
- **Local (Ollama):** `qwen3-coder:30b` is the intended launch model — it
  needs serious RAM or a GPU. Smaller `qwen2.5-coder` sizes run on CPU but
  are slow and call tools less reliably.

## One endpoint, many providers

Everything above is one target behind one port. With a `babelgate.yaml`
the same port serves **every client format at once** — OpenAI, Anthropic,
Gemini, Ollama and Responses clients all work against it — and routes each
request to
one of several providers by model name, with aliases, a long-context
condition, and fallbacks before the first byte:

The npm package doesn't ship `examples/` — fetch the file first (saving
it as `babelgate.yaml` also works, since `./babelgate.yaml` is
auto-discovered):

```bash
curl -fsSLo claude-code-hybrid.yaml \
  https://raw.githubusercontent.com/dorrabbkhan/babelgate/main/examples/claude-code-hybrid.yaml
OPENROUTER_API_KEY=<your key> \
  npx babelgate --config claude-code-hybrid.yaml --preset claude-code
```

[examples/claude-code-hybrid.yaml](examples/claude-code-hybrid.yaml)
keeps Claude Code's cheap background calls on a small local model, runs
routine turns on local `qwen3-coder:30b`, sends ≥ 60 000-token contexts
to OpenRouter, and falls back to OpenRouter when Ollama is down:

```yaml
routes:
  - match: claude-*haiku*
    to: ollama/qwen2.5-coder:7b
  - match: claude-*
    when:
      min_input_tokens: 60000
    to: openrouter/qwen/qwen3-coder
  - match: claude-*
    to: ollama/qwen3-coder:30b
    fallback:
      - openrouter/qwen/qwen3-coder
```

Model resolution, in order: an explicit `<provider>/<model>` in the
request, then aliases, then routes in file order, then the `default`
provider with the model unchanged. Replies always keep the name the
client asked for. Walkthrough:
[docs/recipes/claude-code-hybrid.md](docs/recipes/claude-code-hybrid.md);
a second example with three providers and aliases lives at
[examples/multi-provider.yaml](examples/multi-provider.yaml) — fetch it
the same way.

Started without `--preset`, babelgate prints a client-facing endpoint
per dialect — each is the **base URL the SDK expects**, which differs
from the raw request paths:

```
OpenAI     http://localhost:3000/v1
Anthropic  http://localhost:3000
Gemini     http://localhost:3000
Ollama     http://localhost:3000
UI         http://localhost:3000/ui
```

Responses clients — Codex CLI among them — use the same `/v1` base URL:
`POST /v1/responses` is the fifth source dialect. Recipe:
[docs/recipes/codex.md](docs/recipes/codex.md).

```python
# OpenAI SDK (Python) — base_url includes /v1
OpenAI(base_url="http://localhost:3000/v1", api_key="babelgate")

# google-genai (Python) — http_options.base_url excludes it; the SDK
# appends /v1beta itself (a /v1beta base URL double-appends and 404s)
genai.Client(api_key="babelgate",
             http_options={"base_url": "http://localhost:3000"})
```

```ts
// @google/genai (JS) — same, via httpOptions.baseUrl
new GoogleGenAI({ apiKey: "babelgate",
                  httpOptions: { baseUrl: "http://localhost:3000" } })
```

Raw-HTTP callers use the real paths instead: `/v1/chat/completions`,
`/v1/messages`, `/v1beta/models/<model>:generateContent`, `/api/chat`,
`/v1/responses`.
Every proxied reply carries `x-babelgate-provider`, `x-babelgate-model`
and `x-babelgate-attempts`, and `GET …/models` returns one merged list
across all providers. Any OpenAI-compatible backend (Groq, DeepSeek,
Together, LM Studio, vLLM, llama.cpp…) is a `type: openai` provider —
base URLs and key handling are in
[docs/recipes/openai-compatible-providers.md](docs/recipes/openai-compatible-providers.md).
Antigravity CLI (`agy`) uses the same mechanism in API-key mode —
recipe: [docs/recipes/antigravity-cli.md](docs/recipes/antigravity-cli.md).
Gemini CLI still works with paid API keys and enterprise licences
(`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`) — Google moved individual
users to Antigravity CLI, so the recipe is frozen:
[docs/recipes/gemini-cli.md](docs/recipes/gemini-cli.md).
More clients, one recipe page each:
[Cursor](docs/recipes/cursor.md) (Cursor: setup documented, not
verified end to end),
[Continue](docs/recipes/continue.md),
[Aider](docs/recipes/aider.md) and
[Open WebUI](docs/recipes/open-webui.md).
SDK and app recipes, each with a CI-checked example under
`examples/sdk/`:
[LangChain](docs/recipes/langchain.md),
[LlamaIndex](docs/recipes/llamaindex.md),
[Vercel AI SDK](docs/recipes/vercel-ai-sdk.md) and
[Ollama-only apps on cloud models](docs/recipes/ollama-apps.md).

## The `babelgate` CLI

`npx babelgate` parses flags with `node:util`, sets environment defaults
that **your own env always overrides** (a stderr line,
`babelgate: your environment overrides <keys>`, tells you which preset
values lost), starts the server, and prints the client `export` lines to
paste. Upstream API keys come only from the environment — never from flags.

```
Usage: babelgate [--preset <claude-code|openai-apps>] [--target <provider>]
                 [--model <name>] [--base-url <url>] [--port <n>]
                 [--config <path>] [--help]

Config file discovery: --config, then BABELGATE_CONFIG,
then ./babelgate.yaml. Upstream API keys come only from the environment
(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_API_KEY,
RESPONSES_API_KEY).
```

| Flag          | Effect                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| `--preset`    | `claude-code` or `openai-apps` — picks which `export` lines to print; with no config file it also sets the v1.1 env routing |
| `--target`    | `ollama`, `openai`, `anthropic`, `gemini` or `responses` — sets `TARGET_API` (env-only mode) |
| `--model`     | `claude-code` preset only: `MODEL_MAP=claude-*=<model>`                         |
| `--base-url`  | Sets `{TARGET}_API_BASE_URL` (e.g. `https://openrouter.ai/api` for OpenRouter)  |
| `--config`    | Path to a `babelgate.yaml` — `--target`, `--model` and `--base-url` are then defined by the file |
| `--port`      | Listen port (default `3000`)                                                    |
| `--help`      | Usage                                                                         |

The `claude-code` preset also sets `TARGET_CONTEXT_WINDOW=32768` and, for
`--target ollama`, `UPSTREAM_TIMEOUT_MS=600000` — local models are slow.
Without `--model` it warns `babelgate: no --model given; claude-* model
names are forwarded to the target unchanged` on stderr.

Presets are just env values. Everything below works without them.

## How it works

The naive way to build this is a transformer per provider pair. That gets
painful fast — five formats means twenty conversion functions in each
direction, and every new provider adds another batch.

Instead, every request goes through a **canonical format** in the middle:

```
OpenAI request ──► canonical ──► Gemini request
Gemini response ──► canonical ──► OpenAI response
```

Each provider has an _adapter_ that knows how to convert its own format to and
from canonical. Adding a provider costs you one adapter file — the rest of the
pipeline doesn't care.

The actual request flow:

1. Request hits the Express app.
2. The request path decides the client's format (`/v1/chat/completions`
   is OpenAI, `/v1/messages` Anthropic, `/v1beta/models` Gemini,
   `/api/chat` Ollama, `/v1/responses` Responses); the route table picks it
   up. Unknown paths fall through to a 404.
3. The body is converted to canonical, routed to a provider (config
   file, or the single `TARGET_API` in env-only mode), then encoded in
   the target's format — unless the provider already speaks the client's
   format and pass-through applies (`preset`/`passthrough` and `type:
   responses` below), in which case the body is forwarded with only its
   declared gap fixes.
4. It's forwarded upstream to the provider's `base_url` + the target's
   endpoint, with the right auth headers.
5. The response comes back through the same path in reverse.

Endpoint kinds:

- **Chat** — the request/response translation described above (OpenAI
  `/v1/chat/completions`, Gemini `/v1beta/models/{m}:generateContent`,
  Ollama `/api/chat`, Anthropic `/v1/messages`, Responses
  `/v1/responses`).
- **Streaming chat** — `stream: true` (and Gemini's
  `:streamGenerateContent?alt=sse`) flows chunk-by-chunk in each side's own
  wire protocol: SSE for OpenAI, Anthropic, Gemini and Responses, NDJSON
  for Ollama.
  A client disconnect aborts the upstream request; an upstream that dies
  mid-stream produces an in-stream error in the client's dialect, and a
  stream that stalls longer than `UPSTREAM_STREAM_IDLE_MS` is cut rather
  than left hanging.
- **Tools** — tool definitions, `tool_choice`, parallel calls, streamed
  tool-call deltas and tool results map through canonical. Calls with
  arguments that aren't valid JSON reach the model wrapped as
  `{ "_invalid_arguments": "<raw>" }` instead of crashing the turn.
- **Model list** — GET endpoints (`/v1/models`, `/v1beta/models`,
  `/api/tags`) transform the upstream catalog into the source format,
  so client SDKs and dropdowns work unchanged.
- **`count_tokens`** (Anthropic source only) — answered locally as a
  chars/4 estimate, marked by the `x-babelgate-token-estimate: true`
  response header. Claude Code calls it constantly; the estimate keeps
  it happy without a fake upstream.
- **Media** — URL images, documents (PDF, plain text) and images inside
  tool results translate through canonical. A target that needs bytes
  gets them fetched under a guard (`http:`/`https:` only, private
  addresses refused, 20 MB / 15 s caps — `media:` YAML section or
  `MEDIA_FETCH`/`MEDIA_ALLOW_PRIVATE` env); a target that can't take a
  document or tool image gets a 400 in the client's dialect, never a
  silent drop.
- **Embeddings** — `POST /v1/embeddings` (OpenAI format) routes to
  OpenAI-compatible, Gemini and Ollama targets; aliases and fallbacks
  apply.
- **Pass-through / the shim** — when the routed provider speaks the
  client's format (`type: responses` always; `type: anthropic` /
  `type: openai` with a shim `preset` or `passthrough: true`), the body
  is relayed without the canonical round trip, with each declared
  `gaps` entry's fix applied:
  [docs/recipes/native-endpoints.md](docs/recipes/native-endpoints.md).

Every completed chat request logs token usage (`inputTokens`,
`outputTokens`, `finishReason`, upstream latency) via pino — grep for
`"Request completed"`. Model-list requests log `modelCount` instead
(`"Models list completed"`).

## See what's happening

Every chat request produces a **request trace** — client, routed
provider/model, hops and fallbacks, tokens, cache hits, cost, timings —
fanned out to isolated sinks: the log line, a SQLite usage store
(`USAGE_DB`, default `~/.babelgate/usage.db`), an in-memory body ring,
Prometheus metrics, and optional OpenTelemetry spans. Open
`http://localhost:3000/ui` for the built-in UI: a live Requests feed, a
per-request Inspector that diffs each translation stage, Usage (cost and
tokens per day/model/client, "saved ≈ $X" for local rows), the Routing
table, and a Playground that streams up to four models side by side.

![babelgate Requests screen](docs/assets/ui-requests.png)

Bodies stay private: prompts, completions and tool arguments reach only
the in-memory ring (last `INSPECTOR_BUFFER` requests) — and disk only
with `LOG_BODIES=true`. Metrics carry labels, never content. The whole
privacy model, every `observe:` setting, `/metrics` scrape config, OTel
and Docker notes:
[docs/recipes/observability.md](docs/recipes/observability.md);
architecture: [docs/architecture.md](docs/architecture.md).

## Configuration

Two modes. A **`babelgate.yaml`** (found via `--config`, `BABELGATE_CONFIG`
or `./babelgate.yaml`) defines ≥ 1 providers, aliases and ordered routes —
see the section above and [examples/](examples/). With no file,
**env-only mode** is exactly the v1.1 setup: one provider named after
`TARGET_API`, `MODEL_MAP` entries become its routes.

| Variable                  | What it's for                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `BABELGATE_CONFIG`        | Path to a `babelgate.yaml` (same as `--config`)                                               |
| `SOURCE_API`              | **Deprecated** — ignored in 1.2 (the request path decides the client format); removed in 2.0  |
| `TARGET_API`              | Format to translate to upstream — `openai`, `anthropic`, `gemini`, `ollama` or `responses` (env-only mode; ignored when a YAML file is loaded) |
| `PORT`                    | Listen port (default `3000`)                                                                 |
| `{PROVIDER}_API_BASE_URL` | Upstream base URL for the target provider, e.g. `OLLAMA_API_BASE_URL=http://localhost:11434` (env-only; YAML providers use `base_url`) |
| `{PROVIDER}_API_KEY`      | API key for the target provider (Ollama doesn't need one). With YAML, keys are whichever env vars `api_key_env` names |
| `UPSTREAM_TIMEOUT_MS`     | Per-request upstream timeout (default `30000`)                                               |
| `UPSTREAM_RETRIES`        | Retries for transport failures / 429 / 503 (default `1`)                                     |
| `UPSTREAM_STREAM_IDLE_MS` | Longest gap allowed between chunks mid-stream (default `300000`)                             |
| `MAX_BODY_SIZE`           | JSON body limit (default `10mb` — base64 images need it)                                     |
| `PROXY_API_KEY`           | Optional client auth — when set, callers send the key in their provider's native auth header (see Authentication) |
| `MODEL_MAP`               | Ordered `glob=model` rules, comma-separated — e.g. `claude-*haiku*=qwen2.5-coder:7b,claude-*=qwen3-coder:30b`. First match wins; replies still carry the name the client asked for (env-only; YAML has `routes`) |
| `TARGET_CONTEXT_WINDOW`   | Minimum context window the target should allocate (Ollama `options.num_ctx`; env-only — YAML has per-provider `context_window`) |
| `TARGET_MAX_OUTPUT_TOKENS` | Clamp the model's output budget (env-only — YAML has per-provider `max_output_tokens`) |
| `USAGE_STORE` / `USAGE_DB` / `USAGE_RETENTION_DAYS` | Request-trace store: `on` / `~/.babelgate/usage.db` / `30` days (YAML `observe.*`) |
| `INSPECTOR_BUFFER`      | Traces kept in the in-memory body ring (default `50`; `0` disables body capture) |
| `LOG_BODIES`            | `true` persists body snapshots to the `bodies` table (default `false`) |
| `METRICS`               | `/metrics` Prometheus endpoint (default `on`)                             |
| `UI` / `UI_ALLOW_REMOTE` / `UI_ALLOWED_HOSTS` | `/ui` + `/ui/api`: `on` / remote clients without a key (`false`) / extra `Host`s (empty) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Set to emit GenAI-convention spans (never content); unset = no OTel |
| `MEDIA_FETCH` / `MEDIA_ALLOW_PRIVATE` | URL media fetching: `true` / `false` (YAML `media:` section) — private/loopback/link-local targets always need `allow_private` |

Provider YAML keys `max_output_tokens`, `cache_hints`, `live_prices`,
`repair_tool_calls`, `local` and the `observe:`/`prices:` blocks are in
[docs/recipes/observability.md](docs/recipes/observability.md). The
shim keys — `preset`, `gaps`, `passthrough` — are in
[docs/recipes/native-endpoints.md](docs/recipes/native-endpoints.md);
`reasoning: false` restores v1.4's drop behaviour for that provider
([docs/recipes/claude-code.md](docs/recipes/claude-code.md)).

Routing and upstream endpoints are conventions, not configuration: each
provider's routes (`kind`, `method`, `pathPrefix`, `requestPath`) live in
`PROVIDER_ROUTES` in `src/transformers/adapters/index.ts`.

## Authentication

Set `PROXY_API_KEY` and every proxied endpoint requires it, in whichever
native auth style the client SDK already sends — any one match
authenticates, and every comparison is timing-safe:

- `Authorization: Bearer <key>` — OpenAI and Ollama SDKs, Codex CLI, Anthropic's
  `ANTHROPIC_AUTH_TOKEN` (the `Bearer` scheme is case-insensitive)
- `x-api-key: <key>` — Anthropic SDK
- `x-goog-api-key: <key>` — Gemini SDK
- `?key=<key>` query parameter — Gemini's other auth style

A wrong or missing key gets a `401` in the source provider's error format.
The client key is never forwarded upstream — the upstream sees only the
proxy's own `{TARGET}_API_KEY`. Leave `PROXY_API_KEY` unset to disable
client auth (local dev — the CLI's printed `export …_TOKEN=babelgate`
lines are placeholders in that mode), and note `/health` stays open either
way.

## Errors

Errors on provider routes are rendered in the **source** provider's error
format, so client SDKs raise their native exceptions:

| Source | Error body |
|---|---|
| OpenAI | `{"error":{"message","type","param","code"}}` |
| Anthropic | `{"type":"error","error":{"type","message"}}` |
| Gemini | `{"error":{"code","message","status"}}` |
| Ollama | `{"error":"<message>"}` |
| Responses | `{"error":{"message","type","param","code"}}` (the OpenAI envelope) |

The same holds inside a stream: an upstream that fails mid-stream produces
the source dialect's in-stream error event, never silence or half a JSON
object.

When the upstream provider itself fails, the status the client sees is:

| Upstream | Client | Notes |
|---|---|---|
| 400, 422 | 400 | The upstream message passes through |
| 404 | 404 | Almost always "model not found" — the client can fix it |
| 413 | 413 | Request too large |
| 429 | 429 | `Retry-After` passed through when present |
| 401, 403 | 502 | `Upstream <provider> rejected the proxy's credentials (<status>)` — the *proxy's* upstream key failed, not the client's. Gemini's `400 API_KEY_INVALID` maps here too |
| 503, 529 | 503 | Unavailable |
| Other 5xx | 502 | Upstream failure |
| Timeout | 504 | After `UPSTREAM_TIMEOUT_MS` |
| Transport failure | 502 | Upstream unreachable |
| Non-JSON 2xx body | 502 | `Upstream returned a non-JSON response (content-type: <type>)` |

Error privacy in detail: proxy-generated messages contain no prompt text
or API keys, and client credentials are redacted from request logs. An
upstream 401/403 — including Gemini's `400 API_KEY_INVALID` — reaches
neither the client nor the logs; every other upstream error message is
passed through to the client and logged truncated to 200 characters.
Outside production, an error's `details` may include the first 200
characters of a non-JSON upstream body. Unknown paths and `/health` keep
a small generic error shape rather than any provider's.

## Running from source

```bash
npm ci
cp .env.example .env
```

For a local Ollama target, `.env` needs two lines:

```bash
TARGET_API=ollama
OLLAMA_API_BASE_URL=http://localhost:11434
```

Pull a small model and start the proxy:

```bash
ollama pull qwen2.5:0.5b
npm run dev
```

Then send an OpenAI-style request at the proxy:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen2.5:0.5b", "messages": [{"role": "user", "content": "Hello"}]}'
```

That gets translated to an Ollama `/api/chat` call upstream (the proxy
sends `stream: false` when you don't ask for a stream), and the response
comes back in OpenAI `chat.completion` shape. Add `"stream": true` and the
same call comes back as SSE.

## Project structure

```
src/
├── cli.ts                  npx babelgate — flags, presets, printed export lines
├── app.ts                  Express app wiring (middleware → routes → errors)
├── index.ts                Server startup
├── config/                 Env-only config + babelgate.yaml loader (zod-validated)
├── middleware/             Source detection, client auth, pino logging, error handler
├── routes/proxy.ts         Thin HTTP adapter — writes streams, aborts on close
├── services/
│   ├── http-client.ts      Upstream transport: timeout, retry, logging, postStream
│   ├── stream-pipeline.ts  Provider-agnostic stream plumbing (abort, idle timeout)
│   ├── token-estimate.ts   chars/4 estimate behind count_tokens
│   └── proxy.service.ts    Orchestration: validate → transform → forward
├── routing/                Provider registry, aliases/rules, planRoute, MODEL_MAP
├── observe/                RequestTrace + sinks (log, store, ring, metrics, OTel)
├── cost/                   Bundled price table, overrides, live prices, compute
├── ui-api/                 /ui/api JSON routes + access control
├── transformers/
│   ├── index.ts            transformRequest/transformResponse entry points
│   └── adapters/           One adapter per provider (+ stream codecs, helpers) + PROVIDER_ROUTES
├── types/
│   ├── canonical.types.ts  The canonical format + CanonicalStreamEvent
│   ├── canonical.schema.ts Zod schemas for runtime validation
│   └── *.types.ts          Provider types (mostly SDK re-exports)
└── utils/                  logger (pino), error classes, SSE/NDJSON parsers,
                            ID generators, stream reassembly, MODEL_MAP
ui/                         The /ui single-page app (Preact + Vite, Playwright e2e)
```

## Testing

```bash
npm test
```

All fast, no network. Layers:

- **Adapter unit tests** (`src/transformers/adapters/*.test.ts`) — each
  adapter's to/from canonical functions.
- **Contract tests** (`tests/contracts/`) — the interesting part. Every
  adapter's canonical output is validated against Zod schemas, fixture-driven
  golden tests cover realistic payloads, stream decoders are run against a
  corpus of recorded wire bytes (and re-fed byte-by-byte at every split
  point) and parsed back with the providers' own SDKs, and property tests
  hammer the event-ordering rules.
- **HTTP integration tests** (`tests/integration/`) — real requests against
  the Express app via supertest, with upstream providers mocked by msw. No
  actual network calls happen. `pairs.test.ts` generates end-to-end tests
  per provider pair — chat and model list, so all 25 combinations get
  exercised — `stream-pairs.test.ts` runs the streaming × tools matrix
  over every pair, and `errors.test.ts` runs every pair through the
  upstream-error mapping table.

The contract tests are what make the adapter approach hold up: you don't need
N×N tests if every adapter produces schema-valid canonical data, because then
any pair composes by construction.

## Live tests

`npm test` never touches the network, so it can't catch upstream-format
drift. The opt-in live suite runs the real app against real upstreams:

```bash
npm run test:live
```

- **Ollama always runs**: `OLLAMA_API_BASE_URL` (default
  `http://localhost:11434`) must be reachable or the suite fails loudly —
  it never silently passes. Model from `LIVE_OLLAMA_MODEL` (default
  `qwen2.5:0.5b`).
- **Paid providers are opt-in**: OpenAI, Anthropic and Gemini cases run
  only when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` are
  set, with cheap defaults `gpt-4o-mini`, `claude-haiku-5-5` and
  `gemini-3.8-flash` respectively — `LIVE_<PROVIDER>_MODEL` overrides.
  **OpenRouter** runs as an extra OpenAI-style target when
  `OPENROUTER_API_KEY` is set (model `LIVE_OPENROUTER_MODEL`, default
  `qwen/qwen3-coder`). Skipped targets are listed in the output.
- Cases per available target, driven through every source format: a chat
  round trip, the model list, an unknown model → 404 (400 on OpenRouter —
  it answers bad model IDs differently), and a streamed chat asserted on
  chunks, terminal event and usage — all on response *shape*, never on
  generated text.

A Codex live suite (`tests/live/codex.live.test.ts`) replays recorded
Codex session shapes against real upstreams the same way.

A nightly GitHub Actions job (`.github/workflows/live.yml`) runs the
suite against a fresh Ollama; paid-provider secrets are off until the
owner adds them.

**The release gate** — `scripts/gates/claude-code-edit.sh <ollama|openrouter>
[model]` — is the end-to-end proof: it copies a fixture repo with a failing
test, starts `babelgate --preset claude-code`, lets Claude Code fix the bug
through the proxy (file edits and `npm test` only), then runs the test
itself. Prints `GATE PASS`/`GATE FAIL`, the `claude --version`, model and
duration. It makes real network calls.

## Adding a provider

Adding a provider means one adapter plus registration, env typing and
fixtures/tests — see
[CONTRIBUTING.md](CONTRIBUTING.md#adding-a-provider).

## Known limitations

- **Claude Code ↔ Ollama has not been gate-tested on a capable model.**
  The release gate passed on OpenRouter (`qwen/qwen3-coder`,
  `poolside/laguna-s-2.1:free`), proving Claude Code end to end through
  babelgate; the Ollama adapter is live-tested nightly, but the combined
  path on `qwen3-coder:30b` was never run (accepted launch risk — small
  machines can't fit the model). Local models may call tools unreliably,
  and on CPU-only machines a slow model can stall past
  `UPSTREAM_STREAM_IDLE_MS` (default 300 s) and have its stream cut.
- **Reasoning stays bound to its origin.** All five client formats now
  carry the model's reasoning: request fields (`thinking`,
  `reasoning_effort`, `thinkingConfig`, `think`, `reasoning`) map to the
  target's thinking control, and signed thinking
  (`signature`/`thoughtSignature`, packed in `bg1.` envelopes) returns
  between turns of the same provider/model. Reasoning from provider X
  is never sent to provider Y — it's dropped with a `reasoning_dropped`
  note, and an Anthropic target that can't present a foreign block gets
  thinking disabled for that request. `reasoning: false` on a provider
  restores the v1.4 drop behaviour for it. `cache_control`/`metadata`
  on non-shim paths are still dropped (debug-logged by type name only).
- **Media is refused, never silently dropped.** Documents go only to
  targets that read them — elsewhere the request fails with a 400 in the
  client's dialect naming the field (text documents become text parts
  instead). Images inside tool results are refused on Chat and Ollama
  targets, which can't carry them.
- **`parallel_tool_calls` is honoured only from Responses clients** —
  decoded on `/v1/responses` and mapped to OpenAI, Anthropic and Responses
  targets; the other sources can't express it and providers get their own
  default parallel behaviour.
- **Not every pair is equally verified.** Streaming and tools are
  implemented in all five adapters and the full 5×5 pair matrix runs in CI,
  but the streaming × tools release gates cover only a few launch pairs
  (`anthropic → ollama`, `anthropic → openai` — which is how OpenRouter is
  reached — `openai → ollama`, plus the v1.4 Codex gates).
- **`count_tokens` is an estimate** (chars/4), marked by the
  `x-babelgate-token-estimate: true` header — enough for Claude Code's
  budgeting, not for billing.
- **Non-chat Gemini methods return 501** — `:countTokens`, `:embedContent`
  and friends aren't translated.
- Some provider-specific features (citations, extra usage fields) map to
  canonical best-effort — the format only keeps what's expressible
  across providers.
- **No config hot reload and no overall request deadline** — a
  `babelgate.yaml` change needs a restart, and worst-case latency is the
  sum of per-attempt timeouts across a fallback chain.

## Roadmap

Shipped so far: the 16-pair matrix (v1.1), one endpoint for many
providers (v1.2), observability and the `/ui` (v1.3), the Responses
API / Codex entry point (v1.4), and "correct everywhere" (v1.5 —
reasoning and media for every client format, the native-endpoint shim,
the generated compatibility matrix with client-release replay, signed
releases, minimal embeddings). Release notes are in
[CHANGELOG.md](CHANGELOG.md); the version-by-version plan lives in
[docs/roadmap.md](docs/roadmap.md).

## Docker

```bash
docker build -t babelgate .
docker run -p 3000:3000 --env-file .env babelgate
```

Release tags also publish `ghcr.io/dorrabbkhan/babelgate:<version>` and
`:latest` via `.github/workflows/release.yml` — the image is signed
with keyless cosign in CI, the npm package is published by hand
(without provenance), and a maintainer-generated CycloneDX SBOM is
attached to each GitHub release. Verification steps:
[SECURITY.md](SECURITY.md).

Multi-stage build: provider SDKs are `devDependencies` (type-only imports),
so the runtime image ships `dist/` (server and built UI) plus the
runtime dependencies from `package.json` — `express`, `pino`,
`pino-http`, `zod`, `yaml`, `dotenv`, `prom-client` and the
OpenTelemetry packages. The usage store uses Node's built-in
`node:sqlite` and lives on the `/data` volume (`USAGE_DB=/data/usage.db`).

## Stack

Node ≥ 22.13, Express 5, TypeScript, pino (logging), zod (schema
validation), yaml (config), `node:sqlite` (usage store), prom-client and
OpenTelemetry (metrics, traces), Preact + Vite (the `/ui`), vitest + msw +
supertest + Playwright (tests). Provider types come from the official SDKs
wherever possible.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions
are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and checks,
and first-time contributors sign the [CLA](CLA.md) once via the CLA
Assistant bot on their first PR.
