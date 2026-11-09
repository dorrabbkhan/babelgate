# Recipe: Gemini CLI on any backend through babelgate

Gemini CLI speaks the Gemini API format (`/v1beta/models/*`). Point it at
babelgate and every chat turn is translated to whatever provider you
configured — a local Ollama, an OpenAI-compatible backend like OpenRouter,
or Gemini itself — with streaming and tool calls intact.

You need: Node ≥ 22.13, the `gemini` CLI, and a reachable target.

## Point the CLI at babelgate

Two environment variables do it:

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:3000
export GEMINI_API_KEY=dummy
gemini
```

- **`GOOGLE_GEMINI_BASE_URL`** replaces the API endpoint. It only applies
  with **`GEMINI_API_KEY` auth** — the other auth methods (OAuth, Vertex)
  ignore it. Pin the method in `~/.gemini/settings.json` if yours is
  different: `{"security": {"auth": {"selectedType": "gemini-api-key"}}}`.
- **`GEMINI_API_KEY`** travels in the `x-goog-api-key` header. With
  babelgate's client auth off (no `PROXY_API_KEY`) any value works —
  `dummy` is fine. With `PROXY_API_KEY` set, use that key as the value.
- **HTTPS is required unless the host is localhost.** Gemini CLI refuses a
  plain-`http` base URL for anything remote. Running babelgate in Docker
  or on another machine? Put it behind TLS, or keep the setup on
  localhost — the tested path is localhost.
- **Stray `GOOGLE_*` / `GEMINI_*` variables override the endpoint.**
  Unset `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA` and
  `GOOGLE_APPLICATION_CREDENTIALS` in the shell you run `gemini` in, or
  they can redirect or re-authenticate the client past your base URL.

## Start babelgate

Env-only, against a local Ollama:

```bash
OLLAMA_API_BASE_URL=http://localhost:11434 \
  npx babelgate --target ollama --model qwen3-coder:30b
```

or with a config file (the same files the other recipes use):

```bash
OPENROUTER_API_KEY=<key> npx babelgate --config babelgate.yaml
```

babelgate prints the routing table at startup; every `gemini-*` or
provider-model name Gemini CLI sends is routed by the usual rules
(explicit `provider/model`, aliases, `routes`, then the default).

## What the CLI calls (tested: Gemini CLI 0.66.0)

Recorded against babelgate with Gemini CLI **0.66.0**
(google-genai-sdk 1.30.0, `npx @google/gemini-cli`), 2026-11-04. The
recording saw exactly two method paths — the first two rows below; the
remaining rows are babelgate behaviour for clients that do call them,
not anything 0.66.0 does:

| Call | What it's for | babelgate |
|---|---|---|
| `POST /v1beta/models/{m}:streamGenerateContent?alt=sse` | every chat turn | translated to your provider, SSE back |
| `POST /v1beta/models/{m}:generateContent` | non-streaming helper calls (the model router) | same |
| `POST /v1beta/models/{m}:countTokens` | not called by 0.66.0; supported for clients that do | answered locally as a `chars/4` estimate, marked `x-babelgate-token-estimate: true` |
| `embedContent` and other unsupported methods | not called by 0.66.0 | `501` in Gemini's error format |

Tool declarations that use `parametersJsonSchema` are understood, and
outgoing `functionCall` parts carry the documented
`thoughtSignature: "skip_thought_signature_validator"` placeholder so
Gemini-3.x models accept tool-use history (see `docs/decisions.md`,
v1.3 Task 1).

## Notes and gotchas

- **The CLI's User-Agent identifies it.** `GeminiCLI-tui/<ver>/<model>
  (<os>; <arch>; terminal)` shows up as `gemini-cli` in the request
  trace, the usage store and the UI's client filter.
- **`thinkingConfig` is dropped.** `includeThoughts`/`thinkingLevel`
  have no canonical slot yet; requests still work.
- **Model names are the upstream's.** The CLI sends whatever model it's
  configured with (`gemini-3.8-flash`, …); route it like any other name —
  e.g. `match: gemini-*` → `to: ollama/qwen3-coder:30b`.
- **The recording script is the reference.** `scripts/gates/record-gemini-cli.sh`
  re-runs the edit-task gate through a shape recorder; see
  `docs/gates/` and `docs/decisions.md` (v1.3 Task 1) for the captured
  wire details.
