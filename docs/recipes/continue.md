# Recipe: Continue on any backend through babelgate

Continue's `config.yaml` takes an `apiBase` per model, so its Chat,
Edit, Apply and Agent modes can run against babelgate's OpenAI surface —
on any provider behind it, free presets included — with streaming and
tool calls translated as usual.

You need: Node ≥ 20 (for `npx`), the Continue extension (VS Code or
JetBrains), and a reachable target.

> **Verified:** written against Continue's docs
> ([docs.continue.dev/customize/model-providers/top-level/openai](https://docs.continue.dev/customize/model-providers/top-level/openai)
> and [docs.continue.dev/reference](https://docs.continue.dev/reference),
> accessed 2026-11-23). The hand check — one chat and one edit/agent
> action through babelgate on a free preset — is run by the conductor on
> this recipe's PR; the client version and run date are filled in from it.

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free --preset openai-apps
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. `babelgate presets`
lists every preset with its tier, key env var and the docs it was
verified against — the free tier entries say "per <provider>'s docs on
<date>", not a promise of limits.

## Point Continue at it

`~/.continue/config.yaml` (`%USERPROFILE%\.continue` on Windows):

```yaml
name: babelgate
version: 0.0.1
schema: v1

models:
  - name: babelgate
    provider: openai
    # A model the target actually serves — it is forwarded unchanged.
    model: nvidia/nemotron-3-ultra-550b-a55b:free   # openrouter-free
    apiBase: http://localhost:3000/v1
    apiKey: babelgate
    capabilities:
      - tool_use        # enables Agent mode
```

- `apiBase` needs the `/v1` — babelgate's OpenAI surface lives under it.
- `apiKey: babelgate` is a placeholder: with `PROXY_API_KEY` unset the
  proxy doesn't authenticate clients; with it set, use that key.
- The default `roles` (`chat`, `edit`, `apply`) already cover Chat,
  Edit and Apply. Add `autocomplete` only if you want FIM-style
  autocomplete routed through a chat model — that path is untested
  through babelgate.
- `capabilities: [tool_use]` tells Continue the model can call tools,
  which is what Agent mode needs; babelgate translates the calls
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).

## What works, what doesn't

- **Chat and Edit** — streamed `POST /v1/chat/completions` on any target
  ([plain](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Agent mode** — tool calls and their results translate through
  canonical; small or non-tool-trained models will still call tools
  unreliably.
- **`embed` role** — babelgate serves `POST /v1/embeddings` and routes it
  like chat, but only where the target has an embeddings model (Ollama,
  Gemini, an OpenAI-compatible embedding endpoint). Point a second
  `models:` entry at one; the free presets above don't include one.
- **Not covered:** the `rerank` role (no rerank endpoint), `embed` on a
  chat-only target, and Continue's hub-side features (its own
  autocomplete models, org assistants) which don't use your `apiBase`.
- Errors arrive in OpenAI's error shape, so a free tier's daily cap
  shows as an ordinary provider error in the chat.

## Gotchas

- **One model name per target.** `model:` goes to the provider verbatim —
  `nvidia/nemotron-3-ultra-550b-a55b:free` on `openrouter-free`,
  `gemini-3.8-flash` on `gemini-free`, `gpt-oss-120b` on `cerebras`.
  Rename with `MODEL_MAP` if you'd rather keep a stable display name.
- **Reasoning models:** Continue's OpenAI provider can send the
  Responses API for some model families (`useResponsesApi`); babelgate
  serves `POST /v1/responses` too, so either path is covered
  ([responses row](../compatibility.md#plain-request-plain)).
