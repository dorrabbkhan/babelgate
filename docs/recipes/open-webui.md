# Recipe: Open WebUI on any backend through babelgate

Open WebUI connects to **OpenAI-compatible** and **Ollama** servers —
babelgate serves both dialects on one port, so either connection type
works and lands on whatever provider you configured, free presets
included. Chat streams, tool calls and the model dropdown all carry
over; the OpenAI mode is the better-supported of the two.

You need: Node ≥ 20 (for `npx`), an Open WebUI instance (Docker or
pip), admin access to it, and a reachable target.

> **Verified:** written against Open WebUI's docs
> ([docs.openwebui.com/getting-started/quick-start/connect-a-provider](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/),
> accessed 2026-11-23). The hand check — one chat and one tool call
> through babelgate on a free preset — is run by the conductor on this
> recipe's PR; the client version and run date are filled in from it.

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

New chats pick any discovered model. The model name is forwarded to the
target unchanged, so pick one the provider serves — the merged list only
contains names at least one provider knows.

## Connect in Ollama mode

**Manage Ollama API Connections**: URL `http://localhost:3000` (or
`http://host.docker.internal:3000` from Docker), no key needed.

babelgate's Ollama surface is `GET /api/tags` (model list) and
`POST /api/chat` (chat, NDJSON streaming) — nothing else. Model pull,
delete, `/api/show`, `/api/generate` and `/api/version` are not served:
if the connection's verify step probes them it may complain, and the
model-management screens won't work — manage models at the provider.
Chat itself works, and because every request is translated to your
configured target, an "Ollama" connection can quietly run on Gemini or
OpenRouter behind it. If the connection check fails, use the OpenAI
mode above.

## What works, what doesn't

- **Chat and streaming** — OpenAI mode over
  `POST /v1/chat/completions`, Ollama mode over `POST /api/chat`
  ([plain](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — where the connection and target support them
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
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
  feed one instance; the names still resolve the same upstream.
- **`localhost` means the container.** From a Docker'd Open WebUI,
  `host.docker.internal` reaches the host on Docker Desktop; on Linux
  add `--add-host=host.docker.internal:host-gateway` or run both on the
  same compose network.
