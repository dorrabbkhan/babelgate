# v1.4 Task 3 — owner decisions

**Codex request shape (owner decision A, PR #87, 2026-11-13):** v1.4 targets Codex's *fallback-metadata*
shape: what Codex sends for any model name not in its bundled catalog, i.e. every Gemini/Claude/Chat-only
name. See spec §1.2 E12–E19, `tests/fixtures/codex/recording.jsonl` and `turns.json`. In it:
- top-level `tools` with `function` tools, one `type: "namespace"` tool (`multi_agent_v1`, nested function
  tools in its own `tools[]`) and `web_search`;
- `reasoning: {summary}` without `effort`; `include: ["reasoning.encrypted_content"]`; `store: false`;
  `prompt_cache_key`; `client_metadata`; no `text`, no `previous_response_id`;
- input items `message`, `function_call`, `function_call_output`.
The Responses types and request decoding in this task must accept all of these (including `namespace` tools
and `client_metadata`) without a 400. How a namespace is lowered is Task 5's job; this task only parses it.

The **responses-lite** shape (header `x-openai-internal-codex-responses-lite`, an `additional_tools` input
item instead of top-level `tools`, message `phase`, `reasoning.context`, `custom_tool_call` with `namespace`)
is **pass-through only** in v1.4. On the bridge, reject it with a 400 in the Responses envelope naming the
unsupported item (e.g. `additional_tools`), and record that as a limitation in docs/decisions.md. Don't
STOP on it.
