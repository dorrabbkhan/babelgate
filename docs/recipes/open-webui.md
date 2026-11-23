# Recipe: Open WebUI on any backend through babelgate

Open WebUI connects to **OpenAI-compatible** and **Ollama** servers —
babelgate serves both dialects on one port, so either connection type
works and lands on whatever provider you configured, free presets
included. Chat streams, tool calls and the model dropdown all carry
over; the OpenAI mode is the better-supported of the two.

You need: Node ≥ 20 (for `npx`), an Open WebUI instance (Docker or
pip), admin access to it, and a reachable target.

> **Verified:** Open WebUI v0.13.4 through `babelgate --provider
> cerebras` (the Ollama-mode tool check ran on `gemini-free`),
> 2026-11-23 — per-mode results below. Written against Open WebUI's
> docs
> ([docs.openwebui.com/getting-started/quick-start/connect-a-provider](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)).

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free --preset openai-apps
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. `babelgate presets`
lists every preset — free-tier rows name the provider docs and their
verification date, not a promised limit.

## Connect in OpenAI mode (recommended)

**Settings → Admin → Connections → Manage OpenAI API Connections →
Add Connection**:

- **URL:** `http://localhost:3000/v1` — or
  `http://host.docker.internal:3000/v1` when Open WebUI runs in Docker
  and babelgate runs on the host. The `/v1` is required.
- **API Key:** `babelgate` — a placeholder while `PROXY_API_KEY` is
  unset (client auth off); the field can't be empty. With
  `PROXY_API_KEY` set, use that key.
- **Model IDs:** leave empty — Open WebUI auto-discovers through
  `GET /v1/models`, and babelgate returns one merged list across all
  your providers.

New chats pick any discovered model — auto-discovery through
`/v1/models` showed `gpt-oss-120b` in the verified run. The model name
is forwarded to the target unchanged, so pick one the provider serves —
the merged list only contains names at least one provider knows.

For tool calls, set the model's **Function Calling** to **Native**: the
Default mode sends no `tools` field, and the connection's verify button
does not test tools. Chat and one tool call were verified this way.

## Connect in Ollama mode

**Manage Ollama API Connections**: URL `http://localhost:3000` (or
`http://host.docker.internal:3000` from Docker), no key needed.

babelgate's Ollama surface is `GET /api/tags` (model list) and
`POST /api/chat` (chat, NDJSON streaming) — nothing else. Model pull,
delete, `/api/show`, `/api/generate` and `/api/version` are not served.
**The connection's verify button fails with "Network Problem"** because
Open WebUI probes `GET /api/version`, which babelgate does not serve —
save the connection anyway and it works. Chat runs over `POST /api/chat`
with the proxy streaming NDJSON (whether the reply visibly streamed on
screen was not recorded). The model-management screens still won't
work — manage models at the provider. And because every request is
translated to your configured target, an "Ollama" connection can
quietly run on Gemini or OpenRouter behind it. For tool calls, use the
OpenAI mode above.

## What works, what doesn't

- **Chat and streaming** — OpenAI mode over
  `POST /v1/chat/completions`, Ollama mode over `POST /api/chat`
  ([plain](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — verified in OpenAI mode with Function Calling set to
  Native ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
  **Ollama-mode tool calls are not verified — and failed in one
  observed case:** a tool result without `tool_name` is rejected on a
  Gemini target with `400 Tool result "" has no matching assistant
  tool call` (`src/transformers/adapters/gemini.adapter.ts:968`;
  `src/transformers/adapters/ollama.adapter.ts:168` sets the id only
  when `tool_name` is non-empty), while the same request with
  `tool_name` returns 200. Those were hand-built requests — Open
  WebUI's own body wasn't logged, so it omitting `tool_name` is the
  likely cause, not confirmed. Use OpenAI mode for tools; a follow-up
  fix is planned (no date).
- **Document Q&A / RAG** — needs an embeddings model; babelgate serves
  `POST /v1/embeddings` in OpenAI mode and routes it like chat, so it
  works where your target has one (Ollama, Gemini, an OpenAI-compatible
  embedding endpoint). The free presets above don't include one.
- **Not covered:** Ollama-mode model management (pull/delete/show),
  `/api/generate`, and Open WebUI's built-in web search and image
  tools, which are their own integrations, not part of the model
  connection.
- Errors arrive in the connection's own dialect, so a free tier's daily
  cap shows as a normal provider error in the chat.

## Gotchas

- **Prefix ID** on a connection namespaces its models (`bg/` →
  `bg/.model`) — handy when several babelgate instances or providers
  feed one instance; the names still resolve the same upstream. (Not
  verified in the 2026-11-23 check.)
- **`localhost` means the container.** From a Docker'd Open WebUI,
  `host.docker.internal` reaches the host on Docker Desktop; on Linux
  add `--add-host=host.docker.internal:host-gateway` or run both on the
  same compose network.
- **Free presets can hit their daily cap.** A cap error (OpenRouter
  free: `free-models-per-day` — `openrouter-free` hit its cap during
  the 2026-11-23 check) comes back through babelgate with the preset
  hint; use another preset, e.g. `cerebras` with `gpt-oss-120b` or
  `gemini-free` with `gemini-3.8-flash`.
