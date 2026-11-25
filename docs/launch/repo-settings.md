# Repo settings — prepared, not applied

*Visitor-facing repo hygiene for the launch (spec §3.8). Applying any
of this is the owner's act — the conductor's app cannot edit repo
settings. "Current" values were read 2026-11-25 via `gh repo view`.*

## Description

Current:

> LLM API gateway that translates between OpenAI Chat, Responses, Anthropic, Gemini and Ollama formats — streaming, tool calls, reasoning and structured output included. Run Claude Code, Codex CLI or Gemini CLI on any model. Built-in /ui, usage tracking, Prometheus/OTel.

Proposed (leads with the pitch and the free first run; still one
breath):

> The translator you can check — a proxy that converts between OpenAI, Anthropic, Gemini, Ollama and Responses API formats. Run Claude Code or Codex on a free model in one command; every translation verifiable via a generated compatibility matrix and a per-request inspector. Signed binaries, Homebrew/install.sh/npx/Docker.

## Topics

Current (20/20 slots used): `ai-gateway`, `anthropic`,
`api-translation`, `claude`, `claude-code`, `codex`, `codex-cli`,
`gemini`, `gemini-cli`, `llm`, `llm-gateway`, `llm-proxy`,
`observability`, `ollama`, `openai`, `openai-api`, `openrouter`,
`responses-api`, `self-hosted`, `typescript`.

Proposed: no changes needed — the set already covers the discovery
terms the launch targets. If a slot is wanted for `ai` or `proxy`,
`gemini-cli` is the weakest entry (that recipe is frozen since Google
moved individual users to Antigravity CLI).

## Social preview

Upload (owner → repo Settings → Social preview), 1280×640:

- Preferred: `site/og.png` once Task 16's build produces it — it is
  rendered from the landing mockup and carries the launch headline.
- Interim: `docs/assets/ui-requests.png` (the real Requests screen —
  it already exists and shows the inspector honestly).

Alt/og description text:

> babelgate — the translator you can check. Run Claude Code or Codex on
> any model; every translation backed by a published,
> test-generated compatibility matrix.

## Pinned "start here" issue

File a new issue titled **`Start here — new to babelgate`**, pin it
(owner: issue → ⋯ → Pin issue), and label it `pinned`/`documentation`
if such a label exists. Body:

```markdown
New here? Start with the free first run:

    GEMINI_API_KEY=<free key from https://aistudio.google.com/apikey> \
      babelgate --preset claude-code --provider gemini-free

— or `--preset codex` for Codex. `babelgate presets` lists every free
and cheap preset with the provider doc it was verified against.

Then read, in order:

1. [README](https://github.com/dorrabbkhan/babelgate#readme) — install,
   first run, proof.
2. [docs/compatibility.md](https://github.com/dorrabbkhan/babelgate/blob/main/docs/compatibility.md) —
   the source × target × feature matrix, generated from tests.
3. [docs/recipes/](https://github.com/dorrabbkhan/babelgate/tree/main/docs/recipes) —
   one page per client (Claude Code, Codex, Cursor, Continue, Aider,
   Open WebUI, SDKs…).
4. [docs/comparison.md](https://github.com/dorrabbkhan/babelgate/blob/main/docs/comparison.md) —
   honest trade-offs vs LiteLLM, Bifrost, claude-code-router,
   OpenRouter and Cloudflare AI Gateway.

Bugs and questions: open an issue (never include API keys). Security:
the Security tab's private reporting, per
[SECURITY.md](https://github.com/dorrabbkhan/babelgate/blob/main/SECURITY.md).
```

## `good first issue` candidates

As of 2026-11-25 the repo has **no open issues** (`gh issue list`), so
there is nothing existing to label. These are proposed issues for the
owner to file and label `good first issue` — each is small, self-
contained, and checkable offline. Links point at the files each would
touch.

1. **Recipe: OpenCode through babelgate** — OpenCode speaks
   OpenAI-compatible; verify the setup by hand and write
   `docs/recipes/opencode.md` on the existing recipe pattern. Files:
   [`docs/recipes/openai-sdk.md`](https://github.com/dorrabbkhan/babelgate/blob/main/docs/recipes/openai-sdk.md) (closest pattern),
   [`docs/recipes/continue.md`](https://github.com/dorrabbkhan/babelgate/blob/main/docs/recipes/continue.md).
2. **Recipe: Cline (VS Code) through babelgate** — same shape:
   OpenAI-compatible base URL + any key. Write
   `docs/recipes/cline.md`, marked "setup documented, not verified end
   to end" unless it was exercised. Files: same two links plus the
   recipes index line in
   [`README.md`](https://github.com/dorrabbkhan/babelgate/blob/main/README.md).
3. **`babelgate presets --json`** — a machine-readable preset listing
   (name, tier, key env name, suggested models, docs URL, verified
   date). Files:
   [`src/cli-presets.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/cli-presets.ts),
   [`src/cli.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/cli.ts),
   [`src/cli-presets.test.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/cli-presets.test.ts).
4. **`babelgate doctor`** — a subcommand that checks, without starting
   the server: effective preset/target, key env presence (name only,
   never the value), port free, upstream base URL reachable. Files:
   [`src/cli.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/cli.ts),
   [`src/cli-first-run.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/cli-first-run.ts).
5. **A proven suggested model for the `groq` preset** — run the
   edit-task gate (`scripts/gates/claude-code-edit.sh`) live through
   `--provider groq` on a free model and fill
   `suggested["claude-code"]`/`["codex"]` in
   [`src/config/provider-presets.ts`](https://github.com/dorrabbkhan/babelgate/blob/main/src/config/provider-presets.ts)
   with the run date, per the file's evidence comment convention.
6. **Recipe: LibreChat through babelgate** — OpenAI-compatible
   endpoint; document the compose/env wiring on the Open WebUI recipe's
   pattern. Files:
   [`docs/recipes/open-webui.md`](https://github.com/dorrabbkhan/babelgate/blob/main/docs/recipes/open-webui.md).
