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

Free, closed-source binary; governed by the **Google Antigravity Additional
Terms** on top of the universal Google ToS. Read first-hand 2026-11-18 (this
section previously cited §6 only second-hand via issue #1493):

- **antigravity.google/terms** (no effective date on the page) §6: "using third
  party software, tools, or services to access the Service" "is a breach of
  this Agreement" ("e.g. using OpenClaw with Antigravity OAuth"), and "using
  the Service in connection with products not provided by us" — violations risk
  suspension/termination of accounts. The preamble sends access "through Gemini
  Enterprise (Google Cloud)" and "with an API Key in Gemini for business" to
  the administrator's terms; the page has no clause on custom endpoints, base
  URLs or a user's own Gemini API key.
- **antigravity.google/docs/install** ("Authenticate"): "Model requests go
  directly to the Gemini API, and the CLI never establishes an account
  session." and "To send model requests to a different Gemini-compatible
  endpoint, set the `GOOGLE_GEMINI_BASE_URL` environment variable".
  `modelProvider: "gemini"` is the only accepted value.
- **google-antigravity/antigravity-cli issue #1493** (staff manirajc
  2026-11-12; closed 2026-11-17): using `agy acp` as a backend worker inside a
  third-party agent harness or orchestrator is not permitted under consumer
  sign-in (oauth-personal) — "there is no carve-out for single-account or
  personal use"; unauthorized harness traffic on consumer OAuth "is subject to
  automated abuse enforcement" (rate limiting or suspension under §6). Staff
  added: "`agy acp` and `agy -p` natively support API-key and Google Cloud
  pay-as-you-go authentication, which are governed by their respective API and
  Google Cloud terms."
- **issue #514** (open): no staff statement on custom base URLs. July-2026
  comments (agy 1.0.12–1.1.0, before API-key mode landed in 1.1.13) say keys
  and base URLs were ignored then; hands-on agy 1.5.11 (this spike) shows they
  work now.

**Reading (ours, not legal advice — decided by the conductor on owner
delegation, 2026-11-18; recorded in docs/decisions.md):** §6 prohibits reaching
Google's OAuth-backed service through third-party tools. API-key mode never
opens an account session, is documented by Google, and is described by Google
staff as governed by the API/Cloud terms, not §6 — so API-key mode plus
`GOOGLE_GEMINI_BASE_URL` pointing at one's own gateway is a documented use,
and it is the only mode the recipe supports. Never put babelgate behind
signed-in/consumer OAuth `agy` (it can't be redirected anyway). **Still
unverified:** Google has made no statement on routing that endpoint to a
non-Google model, and the Gemini API / Google Cloud terms themselves were not
read.

Quota/billing note: in API-key mode agy hides `/usage`, `/quota`, `/credits`
(no account quota to show) — cost tracking through babelgate's own usage
store, not the client's.

### babelgate compatibility — verified matrix

| Request shape | Result on `main` |
|---|---|
| Catalog model (`gemini-3.8-flash-low`) → Ollama stub | ✅ full round trip, tools translated, usage recorded |
| `thinkingConfig.thinkingLevel` | ✅ 200 |
| `thinkingConfig.thinkingBudget: 1024` | ✅ 200 |
| `thinkingConfig.thinkingBudget: -1` (dynamic; sent by every custom model) | ❌ **400** on `main` → ✅ after this PR |
| `thinkingConfig.thinkingBudget: 0` (thinking off) | ❌ **400** on `main` → ✅ after this PR |
| `countTokens` / model list | not called by agy (stub saw none) |

The `thinkingBudget` reject is `budgetTokens: z.number().int().positive()` in
`canonical.schema.ts` meeting the decode in `gemini.adapter.ts`, which copies any finite
number through. Gemini documents `-1` = dynamic budget and `0` = thinking disabled, so this
hits real clients beyond agy. Candidate fix: decode `≤ 0` to "no budget" (drop or map to
effort) instead of failing schema validation — small, one adapter + tests; **recommend a
v1.5 follow-up task before the recipe ships**.

## Live pass (2026-11-18)

The conductor ran `scripts/gates/record-antigravity-cli.sh gemini` against real Gemini
with the owner-installed `agy` 1.5.11 — three findings, all fixed:

1. **`--yolo` does not exist in agy.** It prints its usage and sends no request — the
   first live run recorded only `/health`. agy's flag is
   `--dangerously-skip-permissions` ("Auto-approve all tool permission requests";
   `agy --help`). Fixed in the script (and its offline test's fake `agy`, which now
   exits non-zero on unknown flags like the real one).
2. **The script's default Gemini model is retired.** `gemini-2.5-flash` answers 404
   ("no longer available to new users"); the `gemini` target's default is now
   `gemini-3.8-flash`.
3. **The `bg1.` envelope broke Go genai clients.** With `gemini-3.8-flash` upstream,
   agy got a 200 SSE stream with a `run_command` functionCall, then failed:
   `json: cannot unmarshal string into Go struct field .candidates.0.content.parts.0
   .thoughtSignature of type []uint8: illegal base64 data at input byte 3`. The
   `thoughtSignature` field is bytes on the wire — Go's SDK expects standard padded
   base64 and `bg1.` is not base64 (the `.` is byte 3). Fixed in this PR: the
   envelope crosses the wire as standard base64 (`gemini.signature.ts`), with the
   legacy `bg1.` form still accepted inbound. The live re-run result is reported in
   the PR status comment.
4. **agy sends tool results in a `"model"`-role content.** The Gemini-3 end-to-end
   run first got past turn 1 after the finding-3 fix — agy parsed the stream, ran
   its tool and sent turn 2 — and Google then answered `400 Requests ending with
   a model turn are not supported` for the request babelgate forwarded. The
   captured turn-2 `contents` end with `{role: "model", parts: [{functionResponse:
   …}]}` — the function-calling docs show tool results under `"user"`
   (https://ai.google.dev/gemini-api/docs/function-calling), but the Go
   genai-based client sends `"model"` and Google's API accepts it. babelgate
   dropped the functionResponse and emitted an empty assistant message instead.
   Fixed in this PR: functionResponse parts decode to tool messages regardless of
   the content's role (`gemini.adapter.ts` `toCanonicalRequest`; a model turn of
   only responses emits no assistant message). The live re-run result is posted
   in the PR status comment.

Shape the live run recorded (agy's default model — babelgate's `MODEL_MAP "*=<gate
model>"` routed it):

```
POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse
headers: host, user-agent, content-length, content-type,
         x-goog-api-client, x-goog-api-key, accept-encoding
body keys: contents,
           generationConfig {maxOutputTokens,
             thinkingConfig {includeThoughts, thinkingBudget (a number)}},
           systemInstruction (~16 KB),
           tools (14 function declarations)
```

Note the first request already carries a numeric `thinkingBudget`, so the
`thinkingBudget ≤ 0` fix matters in real use — not only for custom models.

## Recommendation

**Adopt as an entry point in v1.6** — it is Google's individual-facing CLI now (Gemini CLI
for individuals ended 2026-06-18), the integration path is literally the Gemini CLI recipe
with a different binary name, and our Gemini inbound already covers its wire format. The
`thinkingBudget ≤ 0` fix has landed; adoption stays gated on the live re-run passing.

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
| `modelProvider:"gemini"`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`; "the CLI never establishes an account session" | antigravity.google/docs/install/ ("Authenticate") + `agy changelog` (added in 1.1.13) | accessed 2026-11-18 |
| Terms §6 third-party-access ban; preamble sends API-key/Cloud access to admin terms | antigravity.google/terms (read first-hand) | accessed 2026-11-18 |
| Consumer-OAuth ban on `agy acp` harness workers; key/Cloud auth governed by API/Cloud terms | google-antigravity/antigravity-cli issue #1493 (staff manirajc 2026-11-12; closed 2026-11-17) | accessed 2026-11-18 |
| Custom-endpoint/header feature request (open); no staff statement on base URLs | google-antigravity/antigravity-cli issue #514 | accessed 2026-11-18 |
| `customModelsConfig` shape and quirks | issue #1228; yetone/magpie `internal/agent/agy.go` | accessed 2026-11-18 |
| Closed source; subscription/quota complaints | thenewstack.io/google-antigravity-cli/ | 2026-05-26 |
| Everything else | `agy` 1.5.11 binary, captured requests (this session) | 2026-11-18 |

## Follow-up status

Owner extended Task 14 on 2026-11-18 ("follow your recos for all and
add them to same PR"); all three recommendations landed in PR #140:

- **`thinkingBudget` fix**: `gemini.adapter.ts` decodes `-1` to "no
  budget" (provider chooses; `thinkingLevel` still wins), `0` to
  effort `"none"`, and other non-positive/non-integer values to a
  `field_dropped` note — requests stop 400ing (see compatibility
  matrix above).
- **Recipe**: `docs/recipes/antigravity-cli.md`, indexed in the README.
- **Record/gate script**: `scripts/gates/record-antigravity-cli.sh`
  (+ offline test); the live pass is run by the conductor.
- **Terms question**: decided 2026-11-18 — read first-hand and
  resolved by the conductor on owner delegation (see docs/decisions.md,
  Task 14 entry): scope is API-key mode only, with the two unverified
  gaps noted in the Licence/terms section above.
- **Live pass**: ran 2026-11-18 on a real Gemini key (agy 1.5.11,
  `gemini-3.8-flash` target) — four findings (`--yolo` →
  `--dangerously-skip-permissions`, retired default model →
  `gemini-3.8-flash`, the `bg1.` envelope's `thoughtSignature`
  encoding breaking Go genai clients, and agy's `"model"`-role
  functionResponse contents being dropped); the first two fixed in
  the record script, the last two fixed in this PR via
  `src/transformers/adapters/gemini.signature.ts` and
  `src/transformers/adapters/gemini.adapter.ts`. See "Live pass"
  above; the re-run result goes in the PR status comment.
