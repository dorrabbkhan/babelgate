# Recipe: Codex CLI on any backend through babelgate

Codex CLI speaks the OpenAI **Responses** API (`POST /v1/responses`).
Point it at babelgate and every turn either passes through byte-for-byte to a
Responses-native upstream, or is translated through the canonical format to
whatever provider you configured — Gemini, Claude, or any OpenAI-compatible
backend — with streaming, tool calls and reasoning intact.

You need: Node ≥ 20 (for `npx`), the `codex` CLI (tested: codex-cli
0.171.0), and a reachable target.

## Point Codex at babelgate

`~/.codex/config.toml`:

```toml
model = "babelgate"              # any non-OpenAI name — see gotchas below
model_provider = "babelgate"
model_reasoning_effort = "medium"  # optional; maps to the target's thinking level
model_reasoning_summary = "auto"   # optional; ask the provider for thought summaries
web_search = "disabled"            # built-in tools are dropped on the bridge (§ below)

[model_providers.babelgate]
name = "babelgate"
base_url = "http://localhost:3000/v1"
wire_api = "responses"
env_key = "BABELGATE_KEY"          # Codex sends this env var as the Bearer key
requires_openai_auth = false       # a custom provider, not ChatGPT login
```

```bash
export BABELGATE_KEY=babelgate     # any value — unless PROXY_API_KEY is set
```

`env_key` names the environment variable Codex reads and forwards as
`Authorization: Bearer …`. With babelgate's client auth off (no
`PROXY_API_KEY`) any value works; with it set, `BABELGATE_KEY` must hold that
key.

## Start babelgate

Three ready-made configs (each file's header has the download line — the npm
package doesn't ship `examples/`):

| File | Target | Path |
|---|---|---|
| [examples/codex-gemini.yaml](../../examples/codex-gemini.yaml) | `gemini-3.8-flash` | bridged — reasoning carried |
| [examples/codex-anthropic.yaml](../../examples/codex-anthropic.yaml) | `anthropic/claude-haiku-4.5` via OpenRouter's `/v1/messages` | bridged — thinking carried |
| [examples/codex-openrouter.yaml](../../examples/codex-openrouter.yaml) | `qwen/qwen3-coder` on OpenRouter's native Responses API | pass-through |

```bash
GEMINI_API_KEY=<key>     npx babelgate --config codex-gemini.yaml       # gate A
OPENROUTER_API_KEY=<key> npx babelgate --config codex-anthropic.yaml    # gate B
OPENROUTER_API_KEY=<key> npx babelgate --config codex-openrouter.yaml   # gate C
```

Each example routes `*` to its model, so the `model` name in `config.toml`
doesn't have to match anything. The routed model name is what Codex sent;
`x-babelgate-provider`/`x-babelgate-model` say who actually served the turn.

Cost comes from the §3.6 price table: codex-anthropic.yaml carries a
`prices:` override because OpenRouter's Anthropic-format `/models` endpoint
returns no pricing; the other two get cost from the bundled table (Gemini)
and `live_prices` (OpenRouter Responses).

## Native vs bridged backends

| Upstream | Provider `type` | Path |
|---|---|---|
| Ollama (stateless), LM Studio, vLLM, OpenRouter (beta), Groq (beta), Together, DeepSeek | `responses` | **pass-through** |
| Gemini, Anthropic (direct or OpenRouter's `/v1/messages`), any other OpenAI-compatible backend, `type: ollama` | `gemini`, `anthropic`, `openai`, `ollama` | **bridged** through canonical |

On a pass-through path the request body is relayed byte-for-byte — only
`model` is rewritten to the routed upstream model (and `max_output_tokens`
clamped by the provider's cap) — and the response or SSE stream comes back
untouched. babelgate still adds everything it adds on other paths: routing by
model name, aliases and ordered routes, fallbacks before the first byte, the
request trace, usage and cost rows, and the inspector (marked pass-through —
the source and target stages diff against each other, no canonical stage).

On a bridged path the request is translated to the target's format. Codex's
custom (freeform) tools such as `apply_patch` reach non-Responses targets as
ordinary function tools whose string input is wrapped in `{input: …}` and
unwrapped on the way back; built-in OpenAI tools are dropped (below).

## Reasoning, carried

`model_reasoning_effort` maps per target: Gemini `thinkingConfig`
(`thinkingLevel`/`thinkingBudget` + `includeThoughts` when you ask for a
summary), Anthropic `thinking` (adaptive effort where the model supports it,
else `budget_tokens`), OpenAI `reasoning_effort`, Ollama `think`. A level the
target doesn't offer is lowered to the nearest supported one, with a
`reasoning_effort_lowered` note on the trace.

The provider's thinking then survives between turns: Anthropic `thinking`
blocks and signatures, Gemini thought parts and `thoughtSignature`s, and
`reasoning_content` are packed into a `bg1.` envelope inside the Responses
`reasoning` items Codex already resends (`include:
["reasoning.encrypted_content"]`). On the next turn the same provider/model
gets its own reasoning back; reasoning from another provider is never sent
across (a `reasoning_dropped` note says so). On Anthropic, if a fallback moved
a turn to another provider, thinking is disabled for the request that can't
present a prior thinking block — Anthropic would reject it — rather than
failing the turn.

### DeepSeek and other `reasoning_content` upstreams

DeepSeek's thinking-mode tool loops need the `reasoning_content` field resent
on the assistant messages it produced. Off by default (some OpenAI-compatible
servers reject the field); enable it per provider:

```yaml
providers:
  deepseek:
    type: openai
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    reasoning_passback: true   # resend reasoning_content on later turns
```

## What Codex calls (recorded: codex-cli 0.171.0)

Recorded against a native Responses endpoint with the shape recorder
(`scripts/gates/record-codex.sh`, evidence E12–E19): every request was
`POST /v1/responses` — no `GET /v1/models`, no other path, no
`previous_response_id`. `store: false`, `stream: true`, `tool_choice: "auto"`,
`parallel_tool_calls`, `include: ["reasoning.encrypted_content"]`, and a
`prompt_cache_key` on every turn; the full input — reasoning items included —
is resent each turn. babelgate's stateless Responses surface covers exactly
this.

## Limitations

- **Stateful Responses is rejected.** `previous_response_id`, `store: true`
  and `conversation` get a 400 naming the field, before routing;
  `GET`/`DELETE /v1/responses/{id}` and `POST /v1/responses/compact` are 404
  in the Responses error envelope. Codex doesn't send any of these over HTTP.
- **Built-in OpenAI tools are dropped on the bridge** — `web_search`,
  `file_search`, `code_interpreter`, `computer_use`, `image_generation`,
  `tool_search`, MCP server tools and `local_shell` (a `builtin_tool_dropped`
  note on the trace), because non-OpenAI upstreams reject them. On
  pass-through they're forwarded unchanged. Keep `web_search = "disabled"`.
- **Reasoning is carried for Responses clients only.** Claude Code, Gemini
  CLI and other clients keep v1.3 behaviour — their reasoning fields are
  still dropped with the existing notes.
- **Catalog-slug model names switch Codex's request shape.** A `model` that
  matches an OpenAI catalog slug makes Codex send the responses-lite shape
  (`additional_tools` input items, the
  `x-openai-internal-codex-responses-lite` header) — pass-through only in
  v1.4. Use an arbitrary name like `babelgate`, as above.

## Notes and gotchas

- **Under Codex's fallback metadata** (an unrecognized model slug) Codex
  does not send the `apply_patch` tool and sends no default reasoning effort —
  edits happen through the shell function tools, and `model_reasoning_effort`
  is the way to turn thinking on explicitly.
- **Codex identifies itself.** Its User-Agent shows as `codex` in the request
  trace, the usage store and the UI's client filter.
- **The recording script is the reference.** `scripts/gates/record-codex.sh`
  re-runs the edit-task gate through a shape recorder; see `docs/decisions.md`
  (v1.4 Task 1) and spec §1.2 E12–E19 for the captured wire details.
- **The release gates are the proof.** `scripts/gates/codex-edit.sh config
  <one of the examples>` runs the same edit-task gate as Claude Code's —
  results are recorded in `docs/decisions.md` when the owner runs them.
