# Recipe: Antigravity CLI on any backend through babelgate

Antigravity CLI (`agy`) is Google's individual-facing CLI (Gemini CLI for
individuals ended 2026-06-18). In API-key mode it speaks the same Gemini API
format as Gemini CLI (`/v1beta/models/*`), so the recipe is the same
mechanism: point it at babelgate and every chat turn is translated to
whatever provider you configured — a local Ollama, an OpenAI-compatible
backend like OpenRouter, or Gemini itself — with streaming and tool calls
intact.

You need: Node ≥ 22.13, the `agy` CLI, and a reachable target.

## Install the CLI

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The installer puts `agy` in `~/.local/bin` (SHA-512-verified download;
`--dir` overrides the location). Windows: `irm …/install.ps1` or
`winget install Google.AntigravityCLI`. It is closed source and updates
itself in the background.

## Point the CLI at babelgate

API-key mode is the only mode that can be redirected. Pin it in
`~/.gemini/antigravity-cli/settings.json` (note: `agy` reuses Gemini CLI's
`~/.gemini` directory):

```json
{ "modelProvider": "gemini" }
```

Then two environment variables do it:

```bash
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3000
export GEMINI_API_KEY=dummy
agy
```

- **`GOOGLE_GEMINI_BASE_URL`** replaces the API endpoint. It only applies
  in API-key mode (`modelProvider: "gemini"`, added in agy 1.1.13); the
  signed-in/OAuth mode ignores it entirely.
- **`GEMINI_API_KEY`** travels in the `x-goog-api-key` header. With
  babelgate's client auth off (no `PROXY_API_KEY`) any value works —
  `dummy` is fine. `GEMINI_API_KEY` wins over `GOOGLE_API_KEY` when both
  are set. `.env` files are **not** loaded.
- **HTTPS for anything non-localhost.** `http://localhost` is verified
  working; a remote plain-`http` base URL is untested (no scheme check
  observed, but a remote-`http` run hung rather than failing fast). Put a
  remote babelgate behind TLS.

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
provider-model name `agy` sends is routed by the usual rules (explicit
`provider/model`, aliases, `routes`, then the default).

## Non-Gemini model names: `customModelsConfig`

`agy --model` only accepts names from its built-in Gemini catalog — until
you declare a custom model in `settings.json`:

```json
{
  "modelProvider": "gemini",
  "customModelsConfig": {
    "customModels": {
      "local-qwen": {
        "apiProvider": "GOOGLE_GEMINI",
        "modelName": "qwen3-coder:30b"
      }
    }
  }
}
```

Then `agy --model local-qwen` sends `modelName` verbatim on the wire —
verified on **agy 1.5.11**:
`POST /v1beta/models/qwen3-coder:30b:streamGenerateContent` (the colon
included; babelgate's model parsing handles it). `apiProvider` resolves
to a Google transport — `GOOGLE_GEMINI` (the Gemini API, i.e. your
`GOOGLE_GEMINI_BASE_URL`) or Vertex variants — there is no generic
"openai-compatible" endpoint.

## What the CLI calls (tested: agy 1.5.11)

Recorded through a logging stub and end-to-end through babelgate with
**agy 1.5.11** (google-genai-sdk 1.77.0, Go build), 2026-11-18 —
`docs/research/2026-11-18-antigravity-spike.md` has the captured requests:

| Call | What it's for | babelgate |
|---|---|---|
| `POST /v1beta/models/{m}:streamGenerateContent?alt=sse` | every chat turn — one call per `agy -p` turn (~44 KB body) | translated to your provider, SSE back |
| `POST /v1beta/models/{m}:countTokens` | not called by agy | answered locally as a `chars/4` estimate, marked `x-babelgate-token-estimate: true` |
| `GET /v1beta/models` | not called by agy (catalog is static in the binary) | merged model list as usual |

Tool declarations use `parametersJsonSchema` (understood, same as Gemini
CLI), `thinkingConfig.thinkingLevel` and `thinkingBudget` decode to
canonical reasoning (`thinkingBudget: -1` and `0` are handled — the
dynamic/off sentinels that used to 400), and `thoughtSignature` on later
turns rides the surface built in v1.5 Tasks 3–5.

## Limits

- **OAuth/signed-in models cannot be redirected.** The Claude and gpt-oss
  families in signed-in mode run on Google's own backend, not through
  `GOOGLE_GEMINI_BASE_URL` — babelgate cannot sit under them.
- **No custom headers** on the model endpoint (open request:
  google-antigravity/antigravity-cli issue #514). babelgate's
  `PROXY_API_KEY` cannot travel on a header — run babelgate without
  client auth, on localhost or behind TLS.
- **Closed source and auto-updating** — unlike Gemini CLI's Apache-2.0.
  Re-verify after `agy` updates (`agy changelog` prints release notes).
- **Quota commands hidden in API-key mode** (`/usage`, `/quota`,
  `/credits` show nothing — there is no account quota to show). Track
  cost through babelgate's own usage store.

## Terms

Scope: **API-key mode only** — never run babelgate behind signed-in/
consumer OAuth `agy` (the base-URL override is ignored there anyway,
and §6 plus a Google staff statement forbid wrapping it — `agy acp`
headless included — in third-party harnesses). Quotes accessed
2026-11-18; our reading, not legal advice:

| Source | What it says |
|---|---|
| [antigravity.google/terms](https://antigravity.google/terms) §6 | "using third party software, tools, or services to access the Service" "is a breach of this Agreement" ("e.g. using OpenClaw with Antigravity OAuth"), and "using the Service in connection with products not provided by us" → suspension/termination; the preamble sends API-key/Cloud access to the administrator's terms — no clause on custom endpoints or base URLs |
| [antigravity.google/docs/install](https://antigravity.google/docs/install) | "Model requests go directly to the Gemini API, and the CLI never establishes an account session"; `GOOGLE_GEMINI_BASE_URL` → a "different Gemini-compatible endpoint" is documented (`modelProvider: "gemini"` only) |
| [issue #1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) (staff, closed 2026-11-17) | `agy acp` as a third-party harness worker is barred under consumer sign-in — "no carve-out for single-account or personal use"; such traffic "is subject to automated abuse enforcement"; key/Cloud auth is "governed by their respective API and Google Cloud terms" |
| [issue #514](https://github.com/google-antigravity/antigravity-cli/issues/514) (open) | no staff statement on custom base URLs; July-2026 "ignored" reports predate API-key mode — verified working on agy 1.5.11 |

Reading: §6 bans third-party access to Google's OAuth-backed service;
API-key mode opens no account session, is documented and is described
by staff as governed by the API/Cloud terms — the only mode this
recipe covers. Unverified: no Google statement on routing that
endpoint to a non-Google model, and the Gemini API / Google Cloud
terms themselves were not read.
