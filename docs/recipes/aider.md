# Recipe: Aider on any backend through babelgate

Aider reaches any OpenAI-compatible endpoint through two environment
variables (it uses LiteLLM underneath). Point them at babelgate and the
whole session — chat, edits, commits — runs on whatever provider you
configured, free presets included, with streaming intact.

You need: Node ≥ 20 (for `npx`), aider (`pip install aider-install &&
aider-install`), a git repo to work in, and a reachable target.

> **Verified:** written against aider's docs
> ([aider.chat/docs/llms/openai-compat.html](https://aider.chat/docs/llms/openai-compat.html)
> and
> [aider.chat/docs/config/options.html](https://aider.chat/docs/config/options.html),
> accessed 2026-11-23). The hand check — one chat and one edit through
> babelgate on a free preset — is run by the conductor on this recipe's
> PR; the client version and run date are filled in from it.

## Start babelgate on a free preset

```bash
OPENROUTER_API_KEY=<key from https://openrouter.ai/keys> \
  npx babelgate --provider openrouter-free --preset openai-apps
```

`--provider` fills the target type, base URL, key env var and the
provider's output-token cap; your own env still wins. `babelgate presets`
lists every preset — the free-tier rows name the provider docs and the
date they were verified against, not a promised limit.

## Point aider at it

In the shell you run aider from:

```bash
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=babelgate
cd /to/your/project
aider --model openai/nvidia/nemotron-3-ultra-550b-a55b:free   # openrouter-free
```

- `OPENAI_API_BASE` takes the `/v1` base URL — LiteLLM appends
  `/chat/completions` itself, and the full endpoint URL would double
  the path.
- The `openai/` prefix selects the OpenAI-compatible client; everything
  after it is sent as the `model` field verbatim, so it must be a model
  the target serves (`gemini-3.8-flash` on `gemini-free`,
  `gpt-oss-120b` on `cerebras`). Rename with `MODEL_MAP` if you want a
  stable name.
- `OPENAI_API_KEY=babelgate` is a placeholder — with `PROXY_API_KEY`
  unset the proxy doesn't authenticate clients; with it set, export
  that key instead. Upstream keys stay in babelgate's environment.
- Equivalent flag/config forms: `aider --openai-api-base
  http://localhost:3000/v1`, or `openai-api-base:` in `.aider.conf.yml`.

`--weak-model`, `--editor-model` and friends use the same env
variables — give them `openai/<model>` names too, or they fall back to
real OpenAI and fail on the placeholder key.

## What works, what doesn't

- **Chat and edits** — streamed `POST /v1/chat/completions` on any
  target ([plain](../compatibility.md#plain-request-plain),
  [streaming](../compatibility.md#streaming-stream)). aider's edit
  formats are plain-text protocols, so they need no tool support from
  the model — a whole-file or diff edit is just a completion.
- **Tool-capable extras** — features that do use function calling (like
  the `agent` edit format's tool calls) translate where the target
  supports them ([`tools`](../compatibility.md#tool-calls-tools)).
- **Repo map and commit messages** — more chat calls, same path.
- **Not covered:** model metadata aider keeps per litellm name —
  unfamiliar `openai/` names run on generic defaults (whole-file edits,
  no per-model token costs; aider prints a warning and keeps working).
- Errors arrive in OpenAI's error shape, so a free tier's daily cap
  shows as a normal provider error, retried per aider's own rules.

## Gotchas

- **Model warnings are expected.** A name aider doesn't know triggers
  its "model is not in the known list" warning — that's the generic-
  defaults path above, not a failure.
- **Cost tracking:** aider can't price an unknown model; use
  babelgate's usage store and `/ui` instead.
