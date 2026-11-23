# Recipe: Cursor on any backend through babelgate

Cursor accepts an OpenAI API key with an **OpenAI base URL override**, so
its chat and agent traffic can go through babelgate in OpenAI format and
land on any provider you configured — Ollama, Gemini, an
Anthropic-speaking endpoint, or a free preset — with streaming and tool
calls translated as usual.

You need: Node ≥ 20 (for `npx`), the Cursor desktop app, and a reachable
target.

> **Verified:** written against Cursor's docs
> ([cursor.com/help/models-and-usage/api-keys](https://cursor.com/help/models-and-usage/api-keys),
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
verified against (`gemini-free`, `groq`, `nvidia-nim` and `cerebras` are
the other free-tier entries — free tier per each provider's docs, dated
on that row).

The printed lines are the values to paste into Cursor:

```
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=babelgate
```

`babelgate` is a placeholder — with `PROXY_API_KEY` unset the proxy
doesn't authenticate clients; with it set, paste that key instead.

## Point Cursor at it

In Cursor Settings (`Ctrl+Shift+J` / `Cmd+Shift+J`) → **Models** →
**API Keys**:

1. Paste the key into the **OpenAI API Key** field and enable it.
2. Enable **Override OpenAI Base URL** and set it to
   `http://localhost:3000/v1` — the `/v1` is required; babelgate's
   OpenAI surface lives under it.
3. Add a model under the model list and select it in chat. The name is
   forwarded to the target unchanged, so it must be a model the provider
   serves — e.g. `nvidia/nemotron-3-ultra-550b-a55b:free` on
   `openrouter-free` or `gemini-3.8-flash` on `gemini-free`. Rename with
   `MODEL_MAP` if you want to keep a familiar name in the picker.

Cursor's API-keys section has fields for several providers (OpenAI,
Anthropic, Google, Azure, Bedrock), but only the **OpenAI** one has a
base-URL override — there is no way to redirect Cursor's Anthropic or
Google traffic, so babelgate's Anthropic and Gemini dialects don't apply
here.

## What works, what doesn't

- **Chat and agent turns** — OpenAI `POST /v1/chat/completions`, streaming
  included ([cells](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)).
- **Tool calls** — the agent's function calls translate to the target
  ([`tools`](../compatibility.md#tool-calls-tools),
  [`stream_tools`](../compatibility.md#tool-calls-streaming-stream_tools)).
- **`GET /v1/models`** returns the merged catalog across your providers,
  though Cursor's picker is configured by hand anyway.
- **Not covered:** Tab autocomplete, Apply, inline edit, background/cloud
  agents and Cursor's own models (Composer, its Claude/GPT/Grok picks)
  run on Cursor's backend and ignore the override — per Cursor's docs,
  custom keys cover chat models only. Keep an eye on Cursor's own
  models while the override is on: turning it off restores them.
- Errors arrive in OpenAI's error shape, so Cursor surfaces provider
  failures (like a free tier's daily cap) as ordinary API errors.

## Gotchas

- **One OpenAI endpoint at a time.** The override is global for
  OpenAI-format requests — while it's on, Cursor's built-in OpenAI
  models go through babelgate too. Toggle it off to go back.
- **Model names are per-provider.** `nvidia/nemotron-3-ultra-550b-a55b:free`
  means nothing to a Gemini target; keep one config per provider or use
  `MODEL_MAP` on the babelgate side.
- **`PROXY_API_KEY`** travels in Cursor's OpenAI key field if you enable
  client auth — don't paste an upstream provider key there; upstream
  keys live in babelgate's environment only.
