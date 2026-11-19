# Recipe: the native-endpoint shim (presets and gaps)

More providers now ship an endpoint that already speaks your client's
format — Ollama, LM Studio, DeepSeek, z.ai (GLM) and Moonshot (Kimi) all
serve Anthropic Messages, and most OpenAI-compatible hosts serve Chat
Completions. Translation is unnecessary on those paths, but the
endpoint's gaps still bite: Claude Code calls `count_tokens` constantly,
forces `tool_choice` on some turns, sends `cache_control` hints, URL
images and PDF `document` blocks — and a native endpoint that 404s,
ignores or silently drops any of those breaks the session in ways that
are hard to see.

babelgate's **native-endpoint shim** handles exactly this: when the
routed provider speaks the client's format (`anthropic` or `openai`),
the request is **passed through** — forwarded in the client's own format
without the canonical round trip — after each declared **gap**'s fix is
applied to the body.

## Presets

A provider-level `preset` fills `type`, `base_url`, `api_key_env` and
the `gaps` list, and implies `passthrough: true`. Each preset's gap list
is verified against the provider's own documentation (and, where noted,
a live probe):

| Preset | Endpoint | Key | Declared gaps | Verified |
|---|---|---|---|---|
| `ollama-anthropic` | `http://localhost:11434` | — (keyless) | `count_tokens`, `url_images`, `documents` | [docs](https://docs.ollama.com/api/anthropic-compatibility) + probe, 2026-11-16 |
| `lmstudio-anthropic` | `http://localhost:1234` | — (keyless) | `count_tokens`, `documents`, `tool_choice` | [docs](https://lmstudio.ai/docs/developer/anthropic-compat) + probe, 2026-11-18 |
| `deepseek-anthropic` | `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` | `count_tokens`, `prompt_cache` | [docs](https://api-docs.deepseek.com/guides/anthropic_api), 2026-11-17 |
| `glm-anthropic` | `https://api.z.ai/api/anthropic` | `ZAI_API_KEY` | `count_tokens`, `documents`, `tool_choice`, `url_images` | [docs](https://docs.z.ai/devpack/tool/others) + probe, 2026-11-18 |
| `kimi-anthropic` | `https://api.moonshot.ai/anthropic` | `MOONSHOT_API_KEY` | `count_tokens`, `prompt_cache`, `url_images`, `documents` | [docs](https://platform.kimi.ai/docs/api/messages), 2026-11-17 |

"Accepted is not supported": several endpoints return 200 to a feature
they can't honour (a base64 PDF on a text-only model, a `count_tokens`
that always answers 0). Those stay declared — the fix errs on the side
of refusing or estimating rather than trusting a wrong answer.

## The gap vocabulary

`gaps:` is a fixed per-provider vocabulary — a declaration about the
endpoint, never a per-pair special case. Each gap has exactly one fix,
applied in the source format's JSON before the request is forwarded:

| Gap | Fix |
|---|---|
| `tool_choice` | Removed; `required`/named choice adds a `tool_choice_dropped` trace note |
| `count_tokens` | Answered locally with the chars/4 estimate, flagged `x-babelgate-token-estimate: true` |
| `prompt_cache` | `cache_control` markers stripped with a `cache_control_dropped` note |
| `url_images` | Fetched and inlined as bytes (`media.fetch`/`media.allow_private` guard applies) |
| `documents` | Refused with a 400 in the client's dialect naming the field — never silently dropped |
| `stream_usage` | Usage requested where the format allows; otherwise estimated and flagged |

For an endpoint we haven't preset, declare the same vocabulary yourself
on a `type: anthropic` or `type: openai` provider and opt in with
`passthrough: true` — pass-through is automatic **only** on shim
presets, so existing configs keep the canonical path (and tool-call
repair) unchanged.

## Example

[examples/native-endpoints.yaml](../../examples/native-endpoints.yaml)
puts Claude Code on two Anthropic-speaking endpoints — z.ai's cloud
endpoint with a local Ollama fallback — plus a hand-declared endpoint:

```yaml
default: ollama
providers:
  ollama:
    preset: ollama-anthropic
    # The preset fills: type anthropic, base_url http://localhost:11434,
    # no api_key_env (keyless), gaps count_tokens + url_images +
    # documents, and passthrough.
    context_window: 32768   # an ordinary provider key — overrides add, not replace
    timeout_ms: 600000      # local models are slow; same value the CLI preset uses
  zai:
    preset: glm-anthropic
    # The preset fills type anthropic, base_url
    # https://api.z.ai/api/anthropic, api_key_env ZAI_API_KEY and gaps
    # count_tokens + documents + tool_choice + url_images. The explicit
    # api_key_env below is already the preset's value — it is spelled
    # out so this file names every env var it needs.
    api_key_env: ZAI_API_KEY
  custom:
    # No preset: declare the endpoint and its gaps yourself.
    type: anthropic
    base_url: http://localhost:8080
    api_key_env: SHIM_API_KEY
    passthrough: true        # opt in — automatic only on shim presets
    gaps: [count_tokens, tool_choice]
routes:
  - match: claude-*haiku*   # Claude Code's cheap background calls stay small and local
    to: ollama/qwen2.5-coder:7b
  - match: claude-*
    to: zai/GLM-4.6V-Flash
    fallback:
      - ollama/qwen3-coder:30b
```

```bash
ZAI_API_KEY=<key> \
  npx babelgate --config native-endpoints.yaml --preset claude-code
```

Two different "presets" here: the provider-level `preset:` key picks a
shim endpoint; the CLI `--preset claude-code` only chooses which client
`export` lines get printed (and, without a config file, the env
routing). They are independent.

## What babelgate adds on a pass-through path

The body is relayed unchanged except the model name and the gap fixes —
but the rest of the gateway still works:

- **Routing and fallbacks** — rules, aliases and `fallback:` apply;
  fallback happens before the first byte, a mid-stream death is an
  in-stream error in the client's dialect.
- **The request trace** — hops, usage, cost and tool-call diagnostics
  are recorded as usual; the inspector marks the request
  `pass-through · <preset>` and lists each gap fix's note
  (`tool_choice_dropped`, `cache_control_dropped`,
  `count_tokens_estimated`, `usage_estimated`, `url_image_inlined`).
- **Client auth, model-name rewriting** (`PROXY_API_KEY`, routes and
  aliases) — replies keep the name the client asked for.
- **Reasoning** stays bound to its origin: signed thinking goes back to
  the same provider verbatim; a turn that falls back to a different
  provider drops foreign reasoning with a `reasoning_dropped` note.

## Notes and gotchas

- **`documents` refusal is deliberate.** Several endpoints answer 200
  and drop the PDF. The shim refuses instead, naming the field — a loud
  error you can fix over a silent wrong answer.
- **`count_tokens` stays an estimate** (chars/4), marked by the
  response header — fine for Claude Code's budgeting, not for billing.
- **`url_images` fetching is guarded** the same as canonical media
  inlining: `http:`/`https:` only, private/loopback/link-local targets
  refused unless `media.allow_private: true`, 20 MB / 15 s caps, bytes
  never logged.
- **Responses pass-through is separate and unchanged**: `type:
  responses` providers already relay `POST /v1/responses` byte-for-byte
  — see [docs/recipes/codex.md](codex.md).
- **Gemini and Ollama sources have no shim** in v1.5 — same-format
  pass-through exists for `anthropic` and `openai` sources only.
