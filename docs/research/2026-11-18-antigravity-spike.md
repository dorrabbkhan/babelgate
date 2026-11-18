# Antigravity CLI (`agy`) spike — 2026-11-18

**Task:** v1.5 Task 14 (spec §3.7). Time-boxed, one day, report only — no product code.
**Method:** installed the real binary in a sandbox (`agy` 1.5.11, linux/amd64, ~257 MB Go
binary from `curl -fsSL https://antigravity.google/cli/install.sh | bash`), drove it headless
(`agy -p … --output-format json`) against a logging HTTP stub to capture the wire format, then
end-to-end through a local babelgate (`main` @ this commit) backed by a stub Ollama. Doc
claims are cited with dates; anything checked only inside the shipped binary is marked
*(binary)*; anything I could not verify hands-on is marked **unverified**.

## Headline

**Antigravity CLI works through babelgate today**, in API-key mode, on a non-Google model —
same `GOOGLE_GEMINI_BASE_URL` mechanism as Gemini CLI, officially documented. Verified:

```
GEMINI_API_KEY=dummy GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18200 \
  agy -p "Say hello" --model gemini-3.8-flash-low --output-format json
      → POST http://127.0.0.1:18200/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse
      → babelgate --target ollama → POST http://127.0.0.1:18196/api/chat (tools translated)
      → {"status":"SUCCESS","response":"Hello via babelgate.","usage":{…}}
```

Two caveats, one of them a real babelgate bug this spike surfaced:

1. **agy custom models are broken by babelgate today.** `customModelsConfig` models send
   `generationConfig.thinkingConfig.thinkingBudget: -1` (Gemini API's "dynamic thinking"
   sentinel). babelgate decodes it to `reasoning.budgetTokens`, which the canonical schema
   requires to be `positive()` → every such request 400s with "Malformed request body".
   `thinkingBudget: 0` (thinking off — also a legal Gemini value) 400s the same way.
   Catalog models send `thinkingLevel` instead and are unaffected.
2. The OAuth/enterprise model families (Claude, gpt-oss per marketing) run on Google's own
   backend — they cannot be redirected to a custom endpoint at all.

## Findings

### Install and provenance

- Installer: `curl -fsSL https://antigravity.google/cli/install.sh | bash` → `~/.local/bin/agy`
  (script supports `--dir`; SHA-512-verified download from a `*.run.app` manifest host).
  Not an npm package. Windows via `irm …/install.ps1` or `winget install Google.AntigravityCLI`.
- Version tested: **1.5.11** (2026-11-18). `agy changelog` prints full release notes locally.
- **Closed source** (the repo google-antigravity/antigravity-cli is issues/docs only) — a real
  change from Gemini CLI's Apache-2.0. Auto-updates in the background.
- Config lives at `~/.gemini/antigravity-cli/settings.json` — it reuses Gemini CLI's
  `~/.gemini` directory; plugins can be imported from Gemini CLI extensions and Claude Code
  marketplaces (`agy plugin import`).

### Custom endpoint and env vars

API-key mode (added in **agy 1.1.13**, per its changelog: "Set `modelProvider: "gemini"` in
`settings.json`, export `GEMINI_API_KEY`, and point `GOOGLE_GEMINI_BASE_URL` at a custom
endpoint if you need one"):

```json
// ~/.gemini/antigravity-cli/settings.json
{ "modelProvider": "gemini" }
```

```bash
export GEMINI_API_KEY=dummy                      # any value; travels as x-goog-api-key
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3000
agy
```

- `modelProvider: "gemini"` is the only documented value for direct-API mode; without a key
  or sign-in the CLI parks on a sign-in screen. `GEMINI_API_KEY` wins over `GOOGLE_API_KEY`
  when both are set (verified: `x-goog-api-key: gem-key` reached the stub). `.env` files are
  **not** loaded.
- Other auth knobs seen in the binary/docs: `AGY_ADC_AUTH` (+ `GOOGLE_APPLICATION_CREDENTIALS`)
  for enterprise ADC; `GOOGLE_VERTEX_BASE_URL` exists in the genai SDK *(binary, unverified
  against a live Vertex endpoint)*; managed/enterprise "model gateway" settings exist and —
  per the 1.x changelog — require `https://` for non-localhost hosts.
- `http://localhost` base URL verified working. Whether a remote plain-`http` URL is refused
  like Gemini CLI did: a remote-`http` run hung on connect rather than failing fast — no
  scheme check observed, **unverified** beyond that; assume HTTPS for anything non-localhost.
- No support for arbitrary `Authorization`/custom headers on the model endpoint — community
  feature request open: google-antigravity/antigravity-cli issue #514 (base-URL + headers for
  gateways; as of 2026-11-18 unresolved). babelgate's `PROXY_API_KEY` can't be carried on a
  custom header; `GEMINI_API_KEY` is the only credential slot, which is enough.

### API format it speaks

**Gemini API v1beta only, over the official Go genai SDK.** One captured turn (custom
endpoint, API-key mode, `--model gemini-3.8-flash-low`):

```
POST /v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse
user-agent: google-genai-sdk/1.77.0 gl-go/go1.28-…
x-goog-api-key: dummy
{"contents":[{"parts":[{"text":"<USER_REQUEST>\nhi\n</USER_REQUEST>\n…"}],"role":"user"}],
 "generationConfig":{"maxOutputTokens":65536,
   "thinkingConfig":{"includeThoughts":true,"thinkingLevel":"LOW"}},
 "systemInstruction":{"parts":[{…≈21 KB…}]},
 "tools":[{"functionDeclarations":[14 entries incl. read_file, run_command, …,
   "parametersJsonSchema":{…draft-2020-12…}]}]}
```

- A simple `agy -p` turn = exactly **one** `streamGenerateContent` call (~44 KB body).
  No `countTokens`, no model-list call (the catalog is static in the binary).
- Effort suffixes are client-side: `gemini-3.8-flash-low` → URL model `gemini-3.8-flash` +
  `thinkingLevel:"LOW"` (also MEDIUM/HIGH/XHIGH; `--effort` flag exists).
- Tools use `parametersJsonSchema` — the shape babelgate already understands for Gemini CLI.
- Multi-turn thinking: the changelog notes GEMINI_API_KEY sessions "propagate thought
  signatures on text and thought parts" — i.e. `thoughtSignature` comes back on later turns,
  exactly the surface v1.5 Tasks 3–5 built for.

### Models it allows

- `agy models` (API-key mode) prints a **static Gemini-only catalog**: Gemini 4
  Carbon/Hydrogen/Argon, 3.8/3.7/3.6/3.5 Flash, 3.1 Pro, 2.5 Pro — each × effort suffix.
- `--model` rejects unknown names ("not recognized as a known model or custom model in
  settings"), but `settings.json` `customModelsConfig.customModels.<label>` accepts
  `{apiProvider, modelName}` with an arbitrary `modelName` — verified: `--model local-qwen`
  → `POST /v1beta/models/qwen3-coder:30b:streamGenerateContent` (name sent verbatim, colon
  included; babelgate's last-`:` path parsing handles the name fine).
- `apiProvider` values in the binary: `GOOGLE_GEMINI`, `GOOGLE_VERTEX`, `ANTHROPIC_VERTEX`,
  `OPENAI_VERTEX`, `OPENAI_RESPONSES_VERTEX`, `GOOGLE_EVERGREEN`, `INTERNAL` — **every
  custom-model transport resolves to Google** (Gemini API or Vertex AI). There is no
  generic "openai-compatible" endpoint (a third-party blog claiming `customEndpoints.llmUrl`
  + `provider: "openai-compatible"` does not match the shipped binary — **unverified,
  likely wrong**).
- Signed-in mode adds Anthropic (`claude-sonnet-4-5`, `claude-opus-4-5`) and OpenAI gpt-oss
  models *(binary strings + docs)* — served through Antigravity's own backend ("server-side
  harness"), not through `GOOGLE_GEMINI_BASE_URL`. babelgate cannot sit under those.

### Licence / terms on third-party endpoints

- Free, closed-source binary; governed by the **Google Antigravity Additional Terms**
  (antigravity.google/terms) on top of the universal Google ToS.
- Terms §6 (quoted in issue #1493): "using the Service in connection with products not
  provided by us… third party software… to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach." Google staff there: wrapping `agy`/`agy acp` headless
  inside a third-party agent harness "is not supported under consumer plans."
- **Reading for babelgate:** §6 restricts *OAuth/consumer* access to Google's backend.
  API-key mode pointed at a custom endpoint is a documented feature and the request then
  never touches "the Service" — the user supplies their own (paid) Gemini-compatible
  upstream. magpie (yetone/magpie) already drives `agy` through its own Gemini-speaking
  gateway the same way. That said, Google wrote these terms for gateway-abuse, not for us —
  **treat the terms question as an owner/legal call, not settled**.
- Quota/billing note: in API-key mode agy hides `/usage`, `/quota`, `/credits` (no account
  quota to show) — cost tracking through babelgate's own usage store, not the client's.

### babelgate compatibility — verified matrix

| Request shape | Result on `main` |
|---|---|
| Catalog model (`gemini-3.8-flash-low`) → Ollama stub | ✅ full round trip, tools translated, usage recorded |
| `thinkingConfig.thinkingLevel` | ✅ 200 |
| `thinkingConfig.thinkingBudget: 1024` | ✅ 200 |
| `thinkingConfig.thinkingBudget: -1` (dynamic; sent by every custom model) | ❌ **400** |
| `thinkingConfig.thinkingBudget: 0` (thinking off) | ❌ **400** |
| `countTokens` / model list | not called by agy (stub saw none) |

The `thinkingBudget` reject is `budgetTokens: z.number().int().positive()` in
`canonical.schema.ts` meeting the decode in `gemini.adapter.ts`, which copies any finite
number through. Gemini documents `-1` = dynamic budget and `0` = thinking disabled, so this
hits real clients beyond agy. Candidate fix: decode `≤ 0` to "no budget" (drop or map to
effort) instead of failing schema validation — small, one adapter + tests; **recommend a
v1.5 follow-up task before the recipe ships**.

## Recommendation

**Adopt as an entry point in v1.6** — it is Google's individual-facing CLI now (Gemini CLI
for individuals ended 2026-06-18), the integration path is literally the Gemini CLI recipe
with a different binary name, and our Gemini inbound already covers its wire format. Gate
the launch on the `thinkingBudget ≤ 0` fix.

Estimated size: **small** — one recipe (`docs/recipes/antigravity-cli.md`, ~½ day), the
budgetTokens fix + tests (~1 day), a record/gate script cloned from `record-gemini-cli.sh`
(~1 day), plus a live pass on a real Gemini API key. Optional stretch: document
`customModelsConfig` as the way to name non-Gemini upstream models once the fix lands.

No new provider adapter needed; no canonical change needed.

## Sources

| Claim | Source | Date |
|---|---|---|
| Transition announcement; agy is the individual CLI | developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | 2026-05-19 |
| Individual Gemini CLI cut-off; enterprise/API-key continue | developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals | effective 2026-06-18 |
| Install script, `agy`, config dir | antigravity.google/docs/getting-started/ | accessed 2026-11-18 |
| `modelProvider:"gemini"`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` | antigravity.google/docs/install/ + `agy changelog` (added in 1.1.13) | accessed 2026-11-18 |
| Terms §6, third-party-access ban, consumer-plan wrapping | antigravity.google/terms; google-antigravity/antigravity-cli issue #1493 | accessed 2026-11-18 |
| Custom-endpoint/header feature request (open) | google-antigravity/antigravity-cli issue #514 | accessed 2026-11-18 |
| `customModelsConfig` shape and quirks | issue #1228; yetone/magpie `internal/agent/agy.go` | accessed 2026-11-18 |
| Closed source; subscription/quota complaints | thenewstack.io/google-antigravity-cli/ | 2026-05-26 |
| Everything else | `agy` 1.5.11 binary, captured requests (this session) | 2026-11-18 |
