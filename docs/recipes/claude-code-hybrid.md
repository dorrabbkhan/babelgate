# Recipe: Claude Code on local + cloud models through one config

The `claude-code` preset sends every `claude-*` request to one target.
[examples/claude-code-hybrid.yaml](../../examples/claude-code-hybrid.yaml)
keeps the same idea but splits the work: Claude Code's cheap background
calls stay on a small local model, routine turns run on a bigger local
model, long contexts and local outages go to OpenRouter — decided per
request by babelgate, from one file.

You need: Node ≥ 20 (for `npx`), the `claude` CLI, an Ollama that can
run `qwen3-coder:30b` (see [docs/gates/gpu-ollama.md](../gates/gpu-ollama.md)
if your laptop can't), and an `OPENROUTER_API_KEY` for the cloud routes.

## The config

```yaml
default: ollama
providers:
  ollama:
    type: ollama
    base_url: http://localhost:11434
    context_window: 32768
    timeout_ms: 600000
  openrouter:
    type: openai
    base_url: https://openrouter.ai/api
    api_key_env: OPENROUTER_API_KEY
routes:
  - match: claude-*haiku*
    to: ollama/qwen2.5-coder:7b
  - match: claude-*
    when:
      min_input_tokens: 60000
    to: openrouter/qwen/qwen3-coder
  - match: claude-*
    to: ollama/qwen3-coder:30b
    fallback:
      - openrouter/qwen/qwen3-coder
```

What a request hits, in order (first match wins):

1. `claude-*haiku*` → `ollama/qwen2.5-coder:7b`. Claude Code sends its
   background and subagent work under haiku names; those stay small and
   local.
2. Any other `claude-*` whose *estimated* input is ≥ 60 000 tokens →
   `openrouter/qwen/qwen3-coder`. The estimate is `ceil(chars/4)` — cheap,
   approximate, good enough for "this conversation got long".
3. Every remaining `claude-*` → `ollama/qwen3-coder:30b`, with
   `openrouter/qwen/qwen3-coder` as fallback: a transport failure, a
   header/connect timeout, or an upstream `429`/`500`/`502`/`503`/`504`/`529`
   moves the request to OpenRouter before the first byte. Once bytes
   stream back, the provider is committed — a mid-stream death is an
   in-stream error, never a silent switch.
4. A model name no route matches goes to the `default` provider
   unchanged — so `ollama/mistral` or `openrouter/anthropic/claude-sonnet-4.5`
   still work as explicit picks, and any bare name lands on Ollama.

`context_window: 32768` becomes Ollama's `options.num_ctx` (what the
`claude-code` preset sets via `TARGET_CONTEXT_WINDOW`), and
`timeout_ms: 600000` mirrors the preset's longer timeout for slow local
models. `base_url` is `https://openrouter.ai/api`, not `/api/v1` —
babelgate appends `/v1/chat/completions` itself.

## Run it

The npm package doesn't ship `examples/`, so download the file linked
above first (saving it as `babelgate.yaml` also works —
`./babelgate.yaml` is auto-discovered):

```bash
curl -fsSLo claude-code-hybrid.yaml \
  https://raw.githubusercontent.com/dorrabbkhan/babelgate/main/examples/claude-code-hybrid.yaml
OPENROUTER_API_KEY=<your key> \
  npx babelgate --config claude-code-hybrid.yaml --preset claude-code
```

With `--preset`, babelgate prints Claude Code's two lines (the preset
only selects which `export` lines to print — the file does the routing):

```
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_AUTH_TOKEN=babelgate
```

then the routing table (the endpoints block prints only without
`--preset`). Export the two lines in the shell you'll run `claude` in
(and unset `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` there), then start
Claude Code.

## Seeing the routing work

Every reply carries `x-babelgate-provider`, `x-babelgate-model` and
`x-babelgate-attempts`, so a long session that crossed the threshold —
or a local Ollama that died — is visible per response and in the
`"Request completed"` log line's `hops` list. Watch for
`x-babelgate-attempts: 2`: that's a fallback firing.

## Notes and gotchas

- **Replies keep the requested name.** Claude Code asked for
  `claude-sonnet-…`; the reply says `claude-sonnet-…` even though Ollama
  or OpenRouter did the work.
- **Aliases and the default have no fallbacks.** Only a route's
  `fallback` list does — that's why the catch-all is a `claude-*` route
  rather than relying on `default`.
- **Provider names win over model prefixes.** A request for
  `ollama/anything` is always explicit, never routed.
- **Spend-capped OpenRouter keys:** cap Claude Code's output budget with
  `export CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000` or requests can be rejected
  mid-session.
- **Local-model caveats from the single-target recipe still apply** —
  small models call tools unreliably, `thinking` is dropped,
  `count_tokens` stays a `chars/4` estimate. See
  [claude-code.md](claude-code.md) for the full list.
