# Listing texts — prepared, not submitted

*Drafts for the owner to submit (submitting is the owner's act). Each
text is the format the target site already uses — a one-line table
entry for Ollama's integrations list, a docs-page section for Open
WebUI, and an entry for the Claude Code community docs. Every link
points at a page that exists on `main`.*

## Ollama community integrations

For the integrations list in `ollama/ollama` (README "Community
Integrations" table — name + one-line description):

> | [babelgate](https://github.com/dorrabbkhan/babelgate) | Proxy that
> translates between LLM API formats — run Ollama behind OpenAI,
> Anthropic, Gemini or Responses clients (Claude Code, Codex) and
> vice versa; per-pair compatibility matrix generated from tests. |

Notes for the submitter: the Ollama recipe paths are
`docs/recipes/ollama-apps.md` (Ollama-only apps on cloud models) and
`docs/recipes/native-endpoints.md` (Ollama's own Anthropic endpoint
through the shim); the plain Ollama target walkthrough is the README's
free-first-run section plus `docs/recipes/claude-code.md`.

## Open WebUI docs

For Open WebUI's docs (tutorials/integrations — a section they could
publish under "integrations"):

> ### babelgate — one OpenAI endpoint in front of any provider
>
> [babelgate](https://github.com/dorrabbkhan/babelgate) is a
> self-hosted Apache-2.0 proxy that translates between LLM API
> formats. Open WebUI talks to it as a standard OpenAI connection
> (`http://localhost:3000/v1`, any key value while `PROXY_API_KEY` is
> unset); behind it you can mix Ollama, Gemini, Anthropic and any
> OpenAI-compatible backend with routing, fallbacks, a passive circuit
> breaker and a per-request translation inspector at `/ui`.
>
> Setup walkthrough:
> [`docs/recipes/open-webui.md`](https://github.com/dorrabbkhan/babelgate/blob/main/docs/recipes/open-webui.md).

Notes for the submitter: the recipe page is verified by hand (per its
header); the OpenAI-compat endpoint claim is backed by
`tests/integration/` pair tests and `docs/compatibility.md`.

## Claude Code community docs

For community docs lists (e.g. awesome-claude-code style entries — the
format is name, link, one-line description):

> **babelgate** —
> [github.com/dorrabbkhan/babelgate](https://github.com/dorrabbkhan/babelgate)
> — Run Claude Code on any tool-capable model — free presets for
> Gemini, OpenRouter `:free`, Groq, NVIDIA NIM and Cerebras, local
> Ollama models, or Anthropic-speaking endpoints (Ollama, LM Studio,
> DeepSeek, z.ai, Kimi) through a declared-gap shim. Translations are
> checkable: a generated per-pair compatibility matrix, a weekly replay
> of each new Claude Code release, and a `/ui` inspector naming every
> dropped field. `babelgate --preset claude-code --provider
> gemini-free` is the one-command free first run.

Notes for the submitter: "each preset's suggested model passed the
edit-task gate" is the honest version of "works" — see the `suggested`
comments in `src/config/provider-presets.ts` (each names the live-run
date). The Claude Code recipe:
[`docs/recipes/claude-code.md`](https://github.com/dorrabbkhan/babelgate/blob/main/docs/recipes/claude-code.md).
