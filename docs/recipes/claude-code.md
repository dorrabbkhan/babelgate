# Recipe: Claude Code on any backend through babelgate

Claude Code speaks the Anthropic API format. babelgate's `claude-code`
preset serves that format (`SOURCE_API=anthropic`) and translates to
whatever `--target` you pick — a local Ollama, an OpenAI-compatible
backend like OpenRouter, or any other provider — with streaming and
tool calls intact.

You need: Node ≥ 20 (for `npx`), the `claude` CLI, and a reachable target.

## On Ollama

```bash
ollama pull qwen3-coder:30b   # or another tool-capable model
OLLAMA_API_BASE_URL=http://localhost:11434 \
  npx babelgate --preset claude-code --target ollama --model qwen3-coder:30b
```

babelgate prints the client lines:

```
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_AUTH_TOKEN=babelgate
```

Export them in the shell you'll run `claude` in, then start Claude Code.
Every `claude-*` model name it sends is rewritten to your `--model` by the
preset's `MODEL_MAP=claude-*=qwen3-coder:30b`; replies still carry the name
Claude Code asked for, so it stays happy.

**Honest caveat:** this combined path was not exercised by the release
gate (see "What the release gate ran" below). Small local models call
tools unreliably, and on CPU-only machines a slow model can stall longer
than `UPSTREAM_STREAM_IDLE_MS` (300 s by default) and have its stream cut.
The preset already raises the request timeout to `UPSTREAM_TIMEOUT_MS=600000`
for `--target ollama`.

## On OpenRouter (or any OpenAI-compatible backend)

```bash
OPENAI_API_KEY=<your OpenRouter key> \
  npx babelgate --preset claude-code --target openai \
  --model qwen/qwen3-coder --base-url https://openrouter.ai/api
```

- The base URL is `https://openrouter.ai/api`, **not** `/api/v1` —
  babelgate joins `<base-url>` + `/v1/chat/completions` itself.
- The upstream key travels as `OPENAI_API_KEY` in the environment. CLI
  flags never carry keys.
- `qwen/qwen3-coder` is the model the release gate passed on.
  `poolside/laguna-s-2.1:free` passed too, on the free tier.

Then the same two `export` lines and `claude`.

### Keys with a spend limit: `max_output_tokens`

Claude Code requests a large output budget by default, and OpenRouter
rejects requests whose `max_tokens` exceeds the key's remaining credit.
Cap it per provider — in a `babelgate.yaml`:

```yaml
providers:
  openrouter:
    type: openai
    base_url: https://openrouter.ai/api
    api_key_env: OPENROUTER_API_KEY
    max_output_tokens: 8000
    cache_hints: true    # pass Anthropic-style cache hints through
    live_prices: true    # real $ from OpenRouter's /models pricing
```

or in env-only/preset mode with `TARGET_MAX_OUTPUT_TOKENS=8000`. The cap
is recorded on the trace (`maxTokensClamp`), so clamped requests are
visible in the log and the UI.

(The gate's passing runs used 8 000 and 16 000 — then via
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, Claude Code's own variable; capping at
the proxy means one knob covers every client.)

## What the release gate ran

`scripts/gates/claude-code-edit.sh <ollama|openrouter> [model]` is the
repeatable proof: it copies `scripts/gates/fixtures/edit-task` (a tiny repo
whose test fails — `sum(a, b)` returns `a - b`) into a temp dir, builds and
starts `babelgate --preset claude-code`, runs Claude Code non-interactively
against it with only file edits and `npm test` allowed, then runs the test
itself. It prints `claude --version`, the model, the duration, and
`GATE PASS`/`GATE FAIL`. It makes real network calls.

Recorded runs (owner's machine, Claude Code 2.1.311, 2026-10-28):

```bash
scripts/gates/claude-code-edit.sh openrouter poolside/laguna-s-2.1:free
# CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000 → GATE PASS in 36 s

CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000 scripts/gates/claude-code-edit.sh openrouter
# default model qwen/qwen3-coder → GATE PASS in 14 s
```

The `ollama` gate was **not** run before release: local `qwen3-coder:30b`
didn't fit the machine, `qwen2.5-coder:7b` was too slow on CPU, and Ollama
Cloud needs paid credits. Rerun
`scripts/gates/claude-code-edit.sh ollama <model>` when you have the
hardware or credits.

## Notes and gotchas

- **Your env wins.** Preset values only fill env vars you haven't set.
  If you exported `MODEL_MAP` or `SOURCE_API` yourself, the preset defers
  and prints `babelgate: your environment overrides …` on stderr. Unset
  `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` in the client shell so the export
  lines decide routing — the gate does exactly that.
- **`ANTHROPIC_AUTH_TOKEN=babelgate` is a placeholder.** With
  `PROXY_API_KEY` unset, client auth is off and the token is ignored. Set
  `PROXY_API_KEY` and the printed token becomes that key instead.
- **`count_tokens` is estimated** as `ceil(chars/4)` locally and marked
  `x-babelgate-token-estimate: true` — fine for Claude Code's context
  budgeting.
- **Thinking is dropped.** `thinking`/`redacted_thinking` blocks,
  thinking deltas, `cache_control` and `metadata` are discarded
  (debug-logged by type name only); Claude Code keeps working.
- **`TARGET_CONTEXT_WINDOW=32768`** is set by the preset → Ollama
  `options.num_ctx`, so a tool-heavy session doesn't silently truncate
  the window.
