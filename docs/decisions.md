# Decisions & deviations log

One entry per decision or per task that deviated from the plan or spec. Newest at the bottom.

> Renamed llm-proxy → babelgate in v1.1; older entries keep the old name.

## 2026-10-26: roadmap brainstorm

- Audience order: individuals and self-hosting developers (Phases 1–2), then teams (Phase 3), then an
  optional hosted control plane (Phase 4). adnymics is not a pilot or target.
- Flawless experiences: Claude Code on anything; any OpenAI-format app on any backend; one endpoint for
  many providers.
- Roadmap shape: hook first (v1.1 streaming + tools + launch), then gateway (v1.2), then visibility
  (v1.3). Gateway-first and translation-first were rejected (spec §5).
- Licence: Apache-2.0 core with a CLA; team governance in a separate private commercial package on a
  public plugin API; paid tier gated on 3 committed teams.
- Repo visibility: the core stays public (already is); the team package and any hosted control plane are
  private. Announcement waits for v1.1.
- Capacity: part-time, agent-driven; S/M/L sizes as in NeoPhylo.
- Found during exploration, to fix in v1.0.1: the Ollama adapter omits `stream` when the client does, so
  Ollama streams NDJSON while `http-client` expects JSON. Not yet confirmed against a live Ollama.

## 2026-10-26: agent and conductor setup

- Mirrors NeoPhylo: AGENTS.md (agent rules), CLAUDE.md (conductor), CONDUCTOR-SETUP.md,
  `.devin/skills/llm-proxy-{task,review}`, `.claude/commands/{conduct,run-plan,inbox}`,
  `.claude/settings.json`, `scripts/conductor/`, `scripts/llm-proxy-loop.sh`, `docs/conductor/`.
- Adapted to this repo: the oracle is `tests/fixtures/` + `tests/contracts/__snapshots__/`, guarded by
  `scripts/ci/fixture-guard.sh`; added rules on adapter independence, canonical/schema lockstep, no
  network in `npm test`, and never logging prompts or keys. Branches are `v<version>/task-<N>-<name>`.
- `scripts/check.sh` added (quick: fixture guard + typecheck + `vitest --changed`; full: guard,
  typecheck, all tests, build). `npm run typecheck` added to package.json.
- Plan mapping in the skills is by filename pattern (`llm-proxy-<version>-plan`), so new plans need no
  skill edits.
- The conductor's permissions additionally deny `npm publish`, `docker push` and `npm run test:live`
  (spends paid API credit).
- No CI exists until v1.0.1; until then the conductor's "wait for green" falls back to the local
  `./scripts/check.sh`.

## v1.0.1 Task 1: live smoke suite — E1 and E10 confirmed live

- `npm run test:live` run 2026-10-27 against a real Ollama (`ollama version is 0.40.11`,
  `qwen3:0.6b` pulled). The run reached Ollama at `localhost:11434` through the host HTTP proxy
  (`NODE_USE_ENV_PROXY=1`, `no_proxy` cleared) because the agent sandbox cannot bind to host
  localhost directly — no code or config changes for that, it's an artefact of the dev environment.
- Result: 8 tests, **4 failed (chat round trips), 4 passed (model lists)** — the expected pre-fix
  state.
- **E1 confirmed:** `openai`/`anthropic`/`ollama` source → `ollama` chat each failed
  `500 TRANSFORM_ERROR` "Cannot read properties of null (reading 'message')": the adapter omits
  `stream`, Ollama replies with NDJSON, `res.json()` yields `null`, `toCanonicalResponse` crashes.
- **E10 confirmed:** `gemini` source → `ollama` chat failed `502` with upstream
  `404 model 'gemini-pro' not found`: the path's model is ignored and the adapter hard-codes
  `gemini-pro`.
- Model lists pass in every source dialect and `LIVE_OLLAMA_MODEL` (`qwen3:0.6b`) is among the ids.
- Resolved ambiguities (not in the plan): cheap default live models for opt-in paid targets
  (`gpt-4o-mini`, `gemini-2.0-flash`, `claude-3-5-haiku-latest`); OpenAI live requests use
  `max_tokens: 16` (still accepted by gpt-4o-mini and by more OpenAI-compatible gateways than
  `max_completion_tokens`); `useTarget` keeps a pre-set `<TARGET>_API_BASE_URL` so a gateway
  endpoint can be injected via env.

## v1.0.1 Task 2: Ollama `stream: false`, strict 2xx JSON, Gemini model from path

- Live run (`npm run test:live`, 2026-10-27, Ollama 0.40.11, `qwen3:0.6b`, via the host HTTP proxy with
  `NODE_USE_ENV_PROXY=1` and `no_proxy` cleared — same sandbox constraint as Task 1, no code changes for
  it): **8/8 pass** — all four source-format chat round trips and all four model lists against `ollama`.
- **Files outside the Files block:**
  - `src/transformers/adapters/index.test.ts` (new): the task's Files block named no home for the
    `PROVIDER_ROUTES`/`modelFromPath` tests or the per-adapter "request without stream sends no streaming
    flag" tests (openai/anthropic/gemini), so they live beside the code they cover.
  - `tests/live/chat.live.test.ts`: live-run finding the suite exists to catch — `qwen3:0.6b` is a
    thinking model; its `thinking` output consumed the whole 16-token budget (`num_predict`), leaving
    `message.content` empty for the openai/anthropic sources (verified directly: `num_predict` 16/64/128
    → `content: ""`, `done_reason: length`; 256 → `"Yes"`). The suite now passes `max_tokens: 512` via
    `chatCall`'s `extra` **only for `target === 'ollama'`** (free, local). The spec §3.5 `max_tokens ≤ 16`
    cap is scoped to paid-provider calls and is unchanged for paid targets.
- Deviations and notes:
  - `ollama.toCanonicalRequest` now maps `stream: false` → absent (only `stream === true` survives).
    Required for the contract round-trip idempotency check once `fromCanonicalRequest` emits
    `stream: false` by default; canonical treats absent and `false` identically (§3.2 checks `=== true`).
  - `http-client.requestJson` rethrows its own `UpstreamError`s inside the attempt loop so the new
    non-JSON-2xx error (and the retries-exhausted 429/503 error) propagates instead of being rewrapped as
    `Upstream unreachable`; this preserves the message and `upstreamStatus`.
  - `UpstreamResponse` gained `contentType` per Interfaces → Produces.
  - Wire-format evidence: Ollama `/api/chat` defaults `stream` to `true`
    (ollama.com api docs, confirmed live in Task 1's NDJSON failures); Gemini selects streaming by
    endpoint (`:streamGenerateContent`), not a body field.
  - `bodyPreview` on the non-JSON-2xx `UpstreamError` is attached only outside production because
    error-handler logs `err.context` in all environments; whether a non-production preview should
    exist at all is left to the owner (spec §3.1 vs Global Constraints privacy).

## v1.0.1 Task 3: CanonicalError and adapter error functions, with fixtures

- Doc sources for the provider error shapes (spec §3.3 table verified against each), read 2026-10-27:
  - OpenAI: https://developers.openai.com/api/docs/guides/error-codes and
    https://developers.openai.com/api/docs/guides/rate-limits (type/code values), plus
    https://github.com/openai/openai-openapi/blob/master/openapi.yaml (ErrorResponse schema and the
    verbatim `InferenceRateLimited`/`InferenceServiceUnavailable`/404 examples used in the parse fixtures).
  - Anthropic: https://platform.claude.com/docs/en/api/errors (shape, type table, verbatim not_found
    example) and https://platform.claude.com/docs/en/api/rate-limits (verbatim rate_limit example); the
    `model: <id>` not_found message is documented in
    https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/error-codes.md.
  - Gemini: https://ai.google.dev/gemini-api/docs/generate-content/api-errors (gRPC error format,
    status table, verbatim 400 INVALID_ARGUMENT body); the real 429 RESOURCE_EXHAUSTED and 404
    NOT_FOUND bodies are corroborated in Google's own SDK repo googleapis/python-genai issues #1427
    and #2087.
  - Ollama: https://docs.ollama.com/api/errors (shape `{"error": string}` + status semantics,
    verbatim 500 bodies) and https://github.com/ollama/ollama/blob/main/docs/openapi.yaml
    (ErrorResponse schema, verbatim 413 example); the 404 `model '<name>' not found` message format is
    verified in Ollama's own source (server/routes.go).
- Kind → provider type choices where spec §3.3's table names the provider's type vocabulary but not
  the kind (recorded per the standing rule; named mappings unchanged):
  - OpenAI: request_too_large → `invalid_request_error` (OpenAI has no 413-specific documented type);
    unsupported → `invalid_request_error` (client-side capability problem, like real
    `unsupported_parameter` errors); upstream → `api_error`; unavailable → `service_unavailable_error`
    (documented for 503/`server_is_overloaded`); timeout → `api_error`; internal → `api_error`.
  - Gemini: upstream → `INTERNAL` (UNAVAILABLE is reserved for the `unavailable` kind; 502 is a
    server-error class, matching gRPC `INTERNAL` for unexpected server failures).
- Parse-fixture provenance notes: OpenAI docs publish the error schema and per-status type/code/
  message fields rather than complete JSON bodies for most errors; the verbatim spec examples
  (slow_down, server_is_overloaded, project_not_found) plus the community-documented real
  `model_not_found` body were used. For Ollama, docs give the verbatim 500/413 bodies and document
  404/429 semantics; the 429 message in the fixture follows the documented description.
- `toCanonicalError` returns `status` = the canonical status for the derived kind (e.g. upstream 529
  → kind `unavailable`, status 503), matching §3.3's status mapping; Task 4's `toClientError` applies
  the remaining upstream→client policy on top. Messages pass through from the provider body shape and
  the fallback is `Upstream <provider> returned <status>`; `toCanonicalError` never throws.
- `canonical.types.ts` and `canonical.schema.ts` changed together in this commit (CanonicalErrorKind,
  CanonicalError, ProviderAdapter.to/fromCanonicalError, canonicalErrorSchema) as required.
- Note: `openai.adapter.ts` already exceeded the ~400-line file guideline on main (440 lines) before
  this task; the error functions were added to it per the task's Files block rather than split out —
  a split is a good candidate for a follow-up cleanup.
- Owner-approved fixes from the PR #3 review (owner decision 2026-10-27):
  - Anthropic `timeout` kind renders as `timeout_error` (Anthropic's documented 504 type), departing
    from the spec §3.3 table which grouped it under `api_error`; §3.3's provider table was updated in
    the same commit.
  - Gemini `API_KEY_INVALID` in `error.details[]` (`google.rpc.ErrorInfo`) maps to kind
    `authentication` (status 401). Reason: Gemini rejects a bad key with 400, so without this Task 4's
    mapping would tell the client its own key is invalid (D1). Task 4's `toClientError` must map from
    the target adapter's canonical kind, not only the raw status.
  - `docs/superpowers/specs/2026-10-26-llm-proxy-v1.0.1-design.md` (§3.3 provider table) is outside
    the task's Files block; edited here to record the owner decision.

## v1.0.1 Task 4: Error wiring — source middleware, dialect rendering, upstream mapping

- Resolves the open `bodyPreview` question from Task 2 (owner decision 2026-10-27, PR #2):
  `bodyPreview` stays in `err.context` outside production and is carried into the non-production
  response `details` on provider paths (`{ ...dialectBody, details: { bodyPreview } }`), and is
  never written to any log line — the error handler no longer logs `err.context` for
  `UpstreamError` at all. `upstreamBody` is likewise kept as a field (for the §3.3 warn-line
  summary) but removed from `context`, so it can no longer reach `details` or a log line.
- `toClientError` decides the credentials case from the target adapter's canonical kind
  (`authentication`/`permission` → 502 credentials message), not the raw upstream status — per the
  owner decision on PR #3 (option 3b), so a Gemini 400 + `API_KEY_INVALID` reply becomes
  `Upstream gemini rejected the proxy's credentials (400)` with no Gemini-specific branch.
- Upstream 5xx other than 503/529 → client 502 `upstream`, per the spec §3.3 table — this
  intentionally overrides `kindFromStatus(500) → internal` for the upstream path: a 500 from the
  provider is an upstream condition, not a proxy bug.
- Log suppression for auth failures covers statuses other than 401/403: the warn line carries no
  upstream message whenever the client error is `upstream` kind on a sub-500 status, which only
  arises from the credentials rule (e.g. Gemini's 400 `API_KEY_INVALID`). This satisfies the
  owner requirement that the API_KEY_INVALID upstream message reach neither client body nor logs.
- `Retry-After` is passed through whenever the upstream sent it (the table only names 429, but
  the passthrough is applied for any status — it is equally meaningful on 503).
- `proxy.service` only applies `toClientError` to `UpstreamError`s carrying an `upstreamStatus`
  ≥ 400. The non-JSON-2xx error carries upstreamStatus 200 and keeps its own message; timeouts and
  transport failures carry no upstreamStatus and keep their unchanged 504/502 rendering.
- `/v1beta/models/:generateContent` (empty model from `modelFromPath`) now returns a clean
  `invalid_request` 400 before any upstream call — the optional item from the PR #2 review.
  `modelFromPath` returning `undefined` (no `:` in the path, e.g. bare `POST /v1beta/models`) keeps
  the existing fallback to `parsed.data.model`.
- `resolveSource` reads `req.path` (set from the URL, before the body parser) and never throws —
  a broken config leaves `sourceApi` unset and errors keep the generic shape.
- The "Unhandled error" log line no longer serializes `err` wholesale: body-parser errors carry
  the raw request body on `err.body` and echo a fragment of it in `err.message` (prompt text).
  Non-ProxyError errors now log whitelisted fields only (`errType`, message, stack), and
  `entity.*` errors log only `body-parser error: <type>` — pinned by the "malformed request body
  is not echoed into the log" test.
- Test notes: `tests/integration/errors.test.ts` sets `UPSTREAM_RETRIES=0` so 429/503 take the
  last-attempt path immediately without backoff sleeps (retry behaviour itself is covered in
  http-client.test.ts). Log capture spies on the real pino logger methods and serializes the call
  arguments with a circular-safe stringify — pino's own serialization decides nothing here beyond
  the argument object, and the pretty transport runs in a worker thread whose fd writes cannot be
  intercepted in-process.
- Files outside the Files block: `src/middleware/request-logger.ts` (+ test) — pre-existing leak
  since v1.0: pino-http's default serializers logged client credential headers and `?key=` URLs;
  fixed here per owner decision 2026-10-27 (PR #4, option a).

## v1.0.1 follow-up: live default model `qwen2.5:0.5b`

- Owner decision 2026-10-27 (PR #5 comment, "option 2"): the live suite's default Ollama model
  changes from `qwen3:0.6b` (D5) to `qwen2.5:0.5b`, a small non-thinking model. `qwen3:0.6b` stays
  available opt-in via `LIVE_OLLAMA_MODEL`.
- Reason: `qwen3:0.6b` is a thinking model; it sometimes spends the whole token budget on
  `thinking`, leaving `content` empty and making the `'openai' → 'ollama' chat round trip` live
  test intermittently red — confirmed in the PR #5 review (1 failure in 3 runs). Task 2's
  `max_tokens: 512` for Ollama targets only reduced, not eliminated, the flake.
- Change surface: `tests/live/live.helpers.ts` default; the same default named in the v1.0.1 spec
  (§1.3, §3.5, §3.7, D5 row) and plan (header, Task 1 interfaces, Tasks 7 and 9) so later tasks
  pull the new model.
- Follow-up for v1.1: the proxy currently drops the `thinking` field from Ollama responses;
  surfacing it (e.g. as reasoning content) is a v1.1 item, not fixed here.

## v1.0.1 Task 5: Streaming refusal and unsupported Gemini methods

- `isSupportedPath` returns `true` for a path that doesn't parse to `<m>:<method>` (no `:` in the
  tail, e.g. bare `POST /v1beta/models`). The spec's refusal rule is scoped to the `<m>:<method>`
  form, and `modelFromPath` already falls back to the body model for such paths — refusing them
  would be a behaviour change the spec doesn't name.
- Ollama-source requests without `stream` stay non-streaming (Task 2's absent → `stream: false`
  mapping is untouched). `stream: false` is accepted from every source; only an explicit `true`
  or the Gemini `:streamGenerateContent` endpoint triggers the 501.
- Files outside the Files block:
  - `src/transformers/adapters/anthropic.adapter.ts` (+ `anthropic.adapter.test.ts`) — required:
    the Anthropic adapter dropped the incoming `stream` field, so `canonical.stream` could never
    be `true` for an Anthropic client and the task's
    `"anthropic stream:true → 501"` test could not pass. Added the same `stream === true`
    passthrough the Ollama adapter uses (absent/false identical in canonical).
  - `src/utils/errors.test.ts` — unit test for the new `NotSupportedError` (501, kind
    `unsupported`).
  - `src/transformers/adapters/index.test.ts` — unit tests for the new `isStreamPath` /
    `isSupportedPath` route functions.

## v1.0.1 Task 7: CI workflows — Ollama model cache outside the workspace

- Deviations from the plan's literal Step 2 (`.github/workflows/live.yml`):
  - The model cache lives at `/home/runner/.ollama-models` (the ubuntu-latest runner's home)
    bind-mounted into the `ollama/ollama` service as `/root/.ollama` — not `~/.ollama` and not
    inside `github.workspace`. Inside the workspace, `actions/checkout` could clean or replace
    the directory the running service is bound to. The `actions/cache` `path:` is the same
    literal path. Docker creates the host dir as root when the service starts, so a
    `sudo mkdir -p` + `sudo chown -R "$USER"` step runs before the cache step (the restore runs
    as `runner`), and an `if: always()` step at the end re-chowns so the post-job cache save
    can read the root-owned files the pull wrote. Restoring after service start is safe:
    Ollama reads model files at request time from the same bind-mounted directory.
  - Added a "Wait for Ollama" readiness step (60 s timeout, `curl /api/tags` every 2 s) before
    `docker exec ... ollama pull`; the service needs a moment to start listening.
  - `gh workflow run live.yml --ref <branch>` returned 404 before merge: GitHub only dispatches
    workflows that exist on the default branch, so the owner triggers the first live run after
    this PR merges.

## v1.0.1 Task 8: Licence, CLA and contributor docs

- `contributor-assistant/github-action` pinned to `v2.6.1`, the latest release.
  The upstream repository was archived on 2026-03-23 (read-only; releases remain
  functional) — noted for the owner alongside decision D2.
- `cla-signatures` branch must pre-exist: the action stores signatures through
  `repos.createOrUpdateFileContents`, and an empirical probe against the API
  confirmed that endpoint returns 404 `Branch <name> not found` when the branch
  is missing (it cannot create branches). Creating the branch is listed as an
  owner action in the PR — per the action's README, the branch must exist but
  must NOT contain `signatures/cla.json` (the action creates the file itself).
- The `pull_request_target` workflow has no `actions/checkout` step and sets
  explicit minimal permissions; only `secrets.GITHUB_TOKEN` is used.
- Inside the moved "Adding a provider" section in CONTRIBUTING.md, the
  `ProviderAdapter` method list was extended with `toCanonicalError` /
  `fromCanonicalError` (added in Task 3) so the moved text matches the current
  interface. The section is otherwise verbatim from README.md.
- Files outside the Files block:
  - `README.md` — replaced the "Adding a provider" section with a link to
    `CONTRIBUTING.md#adding-a-provider`, as the task requires the section to
    move. No other README changes (Task 9 owns the rest).
- Owner decisions on PR #9 (2026-10-27):
  - The CLA legal text is approved by the owner; the `# DRAFT — requires owner
    review` marker was removed, so `CLA.md` is final.
  - The owner email (`dorrabbk@gmail.com`) stays in `CLA.md` as the Project
    Owner contact.
  - `contributor-assistant/github-action` is pinned by commit SHA
    (`ca4a40a7d1004f18d9960b404b97e5f30a505a08`, tag `v2.6.1`) because the
    upstream repository was archived on 2026-03-23.
  - The `cla-signatures` branch was created from main `fc0be60` on the owner's
    request (the action requires the branch to pre-exist).

## v1.0.1 Task 9: README, CHANGELOG, version 1.0.1, roadmap status

- Files outside the Files block: `package-lock.json` was **regenerated**
  (`npm install --package-lock-only --ignore-scripts`), going beyond the
  Files block's "version field only" — the lockfile on main was stale
  against `package.json` (root still `ISC`, provider SDKs under
  `dependencies`, lingering `@types/uuid`/`yaml` entries, no `engines`).
  The regeneration only moved `dev` flags, removed those stale entries
  and synced root license/engines/version — **no resolved version
  of any package changed** (verified in the diff). `npm ci` afterwards
  installs cleanly (295 packages).
- README quick-start verified verbatim 2026-10-27 against a real Ollama
  (`qwen2.5:0.5b` already pulled): OpenAI-format curl without `stream` →
  200 `chat.completion`. Run through the host HTTP proxy
  (`NODE_USE_ENV_PROXY=1`, `no_proxy` cleared) because the agent sandbox
  cannot reach host localhost directly — same constraint as Tasks 1–2,
  no code or doc changes for it; request/response pasted in the PR.
- README claims checked against the code, not copied from the plan: the
  error mapping table comes from `src/services/upstream-errors.ts`, the
  four auth styles from `src/middleware/require-api-key.ts`, the live
  env vars from `tests/live/live.helpers.ts`, and the test count is now
  "~700" (709 on main) — the roadmap status line's "315 tests" was
  updated inside that line as part of the v1.0.1 status change.
- CHANGELOG `[1.0.1]` links to the releases/tag URL
  (`.../releases/tag/v1.0.1`) — no prior tag exists to compare from; the
  owner creates the tag after merge and adjusts the `2026-10-27` header
  date if the merge is later.
- Owner decision (2026-10-27, PR #5) applied to docs: an Ollama-format
  request that omits `stream` is answered non-streaming — stated in
  README's Known limitations and CHANGELOG's Changed, with "send
  `"stream": false` explicitly" and the 501-until-v1.1 note.
- Fix round 1 (PR #10 review): `CONTRIBUTING.md` edited to remove the
  stale "still in owner review" CLA wording — outside this task's Files
  block, recorded here.

## v1.0.1 summary — deviations recorded across the version

One line each; details in the task entries above. Task PRs: 1→#1, 2→#2,
3→#3, 4→#4, 5→#5, 6→#6, follow-up→#7, 7→#8, 8→#9, 9→this PR.

- Task 1 (PR #1): chose cheap default live models for opt-in paid targets
  (`gpt-4o-mini`, `gemini-2.0-flash`, `claude-3-5-haiku-latest`), OpenAI
  live `max_tokens: 16`, `useTarget` keeps a pre-set `<TARGET>_API_BASE_URL`.
- Task 2 (PR #2): files outside the Files block (`adapters/index.test.ts`,
  `chat.live.test.ts` Ollama `max_tokens: 512`); Ollama adapter maps
  `stream: false` → absent for contract idempotency; `http-client`
  rethrows its own `UpstreamError`s; `bodyPreview` kept non-production
  only (left for the owner, resolved in Task 4).
- Task 3 (PR #3): kind→provider-type picks where §3.3 didn't name the kind
  (OpenAI `invalid_request_error`/`api_error`/`service_unavailable_error`,
  Gemini `INTERNAL`); owner-approved changes: Anthropic `timeout_error`,
  Gemini `API_KEY_INVALID` → `authentication`, spec §3.3 table edited in
  the same commit; `openai.adapter.ts` already over ~400 lines.
- Task 4 (PR #4): `upstreamBody` removed from `err.context`;
  `bodyPreview` deliberately stays in `err.context` outside production
  and is surfaced in non-production `details`, but is never logged
  (owner decision, PR #2); `toClientError` keys on the parsed kind, not raw status; all
  upstream 5xx except 503/529 → 502; `Retry-After` passes through on any
  status; `resolveSource` never throws; unhandled-error log whitelists
  fields; `request-logger` credential redaction (outside the Files block).
- Task 5 (PR #5): `isSupportedPath` returns true for unparseable paths;
  Anthropic adapter gained `stream === true` passthrough. Files outside
  the Files block: `src/transformers/adapters/anthropic.adapter.ts` plus
  three modified test files (`anthropic.adapter.test.ts`,
  `src/utils/errors.test.ts`, `src/transformers/adapters/index.test.ts`).
- Task 6 (PR #6): no deviations recorded.
- Follow-up (PR #7): live default Ollama model `qwen3:0.6b` →
  `qwen2.5:0.5b` per owner decision (thinking flake); spec and plan
  updated to match; Ollama `thinking` drop noted as a v1.1 follow-up.
- Task 7 (PR #8): live.yml model cache moved to `/home/runner/.ollama-models`
  bind-mounted into the service (workspace caching was unsafe); added a
  wait-for-Ollama step; first live run is owner-triggered after merge
  because `workflow_dispatch` only exists on the default branch.
- Task 8 (PR #9): CLA action pinned by SHA `v2.6.1` (upstream repo
  archived); `cla-signatures` branch must pre-exist (owner created it);
  CONTRIBUTING's adapter method list extended with the Task 3 error
  functions; README's "Adding a provider" replaced by a link (outside
  the Files block); CLA text owner-approved and finalized.
- Task 9 (this PR): `package-lock.json` regenerated beyond "version field
  only" (see this task's entry); roadmap status line's stale "315 tests"
  corrected to ~700 inside the line; CHANGELOG links to the tag URL
  (no prior tag to compare from).

## v1.1 Task 1: rename to babelgate

- `fromCanonicalModelList`'s `owned_by` fallback is now `"babelgate"` (was
  `"llm-proxy"`) — a client-visible wire change on the OpenAI model list.
- Agent tooling deliberately keeps the llm-proxy name for v1.1 (plan Task 1
  exclusion list): `.devin/skills/**`, `.claude/**`, `scripts/llm-proxy-loop.sh`,
  `scripts/conductor/**`, `CLAUDE.md`, `AGENTS.md`, `CONDUCTOR-SETUP.md`, and
  past specs/plans/decisions.
- Files outside the Files block: `CHANGELOG.md` (release/compare URLs moved to
  the new repo name — required by the task's `git grep llm-proxy` check);
  `src/transformers/adapters/openai.adapter.test.ts` (the new `owned_by` test,
  per Step 1).
- `docs/roadmap.md`'s link to the roadmap design spec was reworded to a
  date-based pointer: the spec file keeps its `llm-proxy` name (past spec files
  are excluded from the rename), so the literal filename could not stay without
  failing the task's grep check.

## v1.1 Task 2: canonical stream events and stream utilities

- Canonical changes (spec §3.1), all mirrored in `canonical.schema.ts`:
  `CanonicalStreamEvent` replaces `CanonicalStreamChunk`/`CanonicalDelta`
  (both had no users; `canonicalStreamChunkSchema` removed with them);
  `CanonicalRequest.toolChoice`, `CanonicalConfig.contextWindow`,
  `CanonicalMessage.isError`; `StreamDecoder`, `StreamEncoder`,
  `StreamEncoderContext`, `IdGenerator`; `ProviderAdapter` gains
  `createStreamDecoder`/`createStreamEncoder` and `toCanonicalResponse`
  gains an optional `ids?: IdGenerator` (existing two-arg implementations
  still satisfy the interface).
- `createStreamDecoder` takes `ids?: IdGenerator` per the plan's Interfaces
  block; spec §3.1's sketch omits it — the plan is authoritative.
- All four adapters stub `createStreamDecoder`/`createStreamEncoder` with
  `NotSupportedError` and the existing 501 message, so `proxy.service`'s
  stream branch (Task 4) keeps returning 501 until Tasks 4–7 land.
- `createSseParser` drops an event with no `data:` field (bare `event:` /
  comment-only blocks) and dispatches a still-buffered event at `end()`;
  `createLineSplitter`/`takeLines` key on "\n" and strip a trailing "\r",
  which also covers `\r\n` split across chunks.
- `parseToolArguments` treats a whitespace-only string like `""` (→ `{}`,
  valid); valid JSON that isn't an object (arrays, scalars) gets the
  `_invalid_arguments` wrapper.
- `reassembleStream` enforces the spec §3.1 rules strictly (sequential
  `tool_call_start` indexes from 0, deltas/ends only on open calls, usage at
  most once, nothing after `message_end`/`error`); violations raise
  `TransformError`, an `error` event raises a `ProxyError` carrying the
  event's status and kind as its code.
- `createIdGenerator` uses a random base64url suffix (`call_<12 chars>`);
  `sequentialIds` stays `call_0`, `call_1`, … for deterministic tests.
- `createUtf8Decoder` flushes on an empty `Uint8Array` (a truncated trailing
  character becomes U+FFFD); decoders call it from `end()`.

## v1.1 Task 3: stream fixture corpus

- `tests/fixtures/streams/` holds raw provider stream bytes plus a `<case>.json`
  (`source`, `date`, `model`, `expectedEvents`, `nonStreaming`) per case.
  `tests/contracts/stream-fixtures.test.ts` validates them; decoding the bytes is
  exercised by the decoder tasks (4–7).
- Sources: Ollama cases recorded live (`npm run record:streams`,
  ollama 0.40.11, `qwen2.5:0.5b`); Anthropic cases verbatim from
  docs.claude.com streaming examples; OpenAI `text` verbatim from the
  API-reference streaming example and `tool_call` from the recorded
  gpt-4o stream in `openai/openai-go`'s `streamaccumulator_test.go`;
  Gemini cases from recorded `streamGenerateContent?alt=sse` exchanges in
  `google/adk-go` httprr traces and a `googleapis/js-genai` test recording
  (Google-published captures — real provider bytes, per spec §4.1's
  "documented examples verbatim, or owner-recorded" fallback).
- Omissions (no documented/recorded provider bytes found; wire-format claims
  without evidence are not allowed):
  - `openai`: `parallel_tool_calls`, `after_tool_result`, `max_tokens`,
    `error` — current docs only show Responses-API streaming for tool calls;
    needs owner-recorded fixtures.
  - `anthropic`: `parallel_tool_calls`, `after_tool_result`, `max_tokens` —
    the streaming docs publish text, tool_use and error examples only.
  - `gemini`: `max_tokens`, `error` — no recorded MAX_TOKENS or in-stream
    `{"error":…}` exchange found in Google's published captures.
  - `ollama`: `error` — per https://docs.ollama.com/api/errors a mid-stream
    error is an NDJSON `{"error":"…"}` line after normal chunks, with the
    HTTP status left at 200; a decoder never sees a 404. The first
    recording was a pre-stream 404 `application/json` body — the
    non-streaming JSON-error path (plan Review Focus #4), not decoder
    input — so the case was removed. Needs an owner recording of a real
    mid-stream error.
- Edits to captured bytes, disclosed: the OpenAI `tool_call` capture drops the
  second synthetic `choices:[]` usage chunk the SDK authors added for a
  token-details accumulator test (real streams emit exactly one). The OpenAI
  `text` doc example's literal `: Intermediate chat completion chunks
  omitted.` comment line is kept verbatim (it also exercises comment
  handling); no chunks were invented. The Gemini `tool_call` `.sse` is
  re-serialized `data:` framing around the recording's verbatim JSON payload.
- Conventions the decoder tasks must follow (resolved ambiguities, spec §3.1
  rules leave these open):
  - Generated IDs come from `sequentialIds()` in emission order: when the wire
    has no message ID (Ollama), `message_start.id` draws `call_0` first; tool
    call IDs use the wire `id` when present (OpenAI `call_…`, Anthropic
    `toolu_…`, Ollama `call_…`) and draw `call_0`, `call_1`, … when absent
    (Gemini; the wire `responseId` is used for `message_start.id` there).
  - Empty `content`/argument strings produce no `text_delta`/`tool_call_delta`
    event (e.g. OpenAI's opening `{"role":"assistant","content":""}` chunk).
  - Gemini and Ollama send tool arguments as objects on the wire:
    `argumentsDelta` is `JSON.stringify` of the wire `args`/`arguments`
    object (key order preserved), and `stream-fixtures.test.ts` checks the
    concatenated deltas against the wire bytes.
  - `anthropic/error`'s event list is error-only (no `message_start`):
    the documented example (docs.claude.com 'Error events') shows only the
    error event itself, so decoders emit it as-is.
  - `usage` is emitted once, before `message_end`: Anthropic merges
    `message_start.usage.input_tokens` with `message_delta`'s cumulative
    `output_tokens`; Gemini takes the last chunk's cumulative `usageMetadata`;
    OpenAI takes the single `choices:[]` usage chunk; Ollama the `done:true`
    line's `prompt_eval_count`/`eval_count`.
  - `message_end.finishReason` is canonical: Anthropic `tool_use`, OpenAI
    `tool_calls`, and a Gemini/Ollama stream ending in tool calls all become
    `tool_call`; Ollama `done_reason:"length"` becomes `length`.
- `nonStreaming` twins are embedded only where the current adapters produce an
  equal canonical response on `message`/`finishReason`/`usage`
  (ollama `text` and `after_tool_result` — recorded with `temperature:0`, and
  gemini `text` where the single chunk is itself a complete
  `GenerateContentResponse`). They are `null` for tool cases (tool mapping
  lands in Tasks 8–10) and for ollama `max_tokens` (the non-stream adapter maps
  `done` to `"stop"` and ignores `done_reason:"length"` — follow-up).
- Files outside the Files block: none (the `<case>.nonstreaming.json` twins
  are inside the created `tests/fixtures/streams/` tree, which the Files block
  covers as `<case>.{sse|ndjson}` plus `<case>.json`; the extra twin files are
  recorded provenance for the embedded `nonStreaming` bodies).

## v1.1 Task 3b: recorded stream fixtures

- Owner-requested follow-up to Task 3: record the missing cases live instead of
  relying on published captures. `scripts/record-streams.ts` now supports all
  four providers (gated on `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`;
  base URLs from `<PROVIDER>_API_BASE_URL`, public defaults otherwise; model
  overrides `RECORD_OPENAI_MODEL`/`RECORD_ANTHROPIC_MODEL`/`RECORD_GEMINI_MODEL`/
  `RECORD_OLLAMA_MODEL`). `RECORD_PROVIDERS` and `RECORD_CASES` filter the run;
  existing files are never overwritten unless `RECORD_OVERWRITE=1`.
- `expectedEvents` are generated programmatically from the recorded bytes by
  `scripts/stream-fixture-decode.ts` (verified: it reproduces every existing
  fixture's expectedEvents exactly). Anything the Task 3 conventions don't
  cover throws and prints `STOP:` instead of guessing.
- Recorded this run (2026-10-27):
  - `ollama/error` — qwen2.5:0.5b, ollama 0.40.11. A real mid-stream error:
    HTTP 200, normal NDJSON chunks, then `{"error":"an error was encountered
    while running the model: unexpected EOF"}` (docs.ollama.com/api/errors
    shape). Trigger: the llama runner was stopped mid-generation
    (`OLLAMA_MIDSTREAM_KILL`, default `docker exec ollama pkill -f
    llama-server`). The wire carries no status/code; the canonical error is
    `internal`/`500` — the same failure returned pre-stream would be an HTTP
    500, so `kindFromStatus(500)` applies.
  - `gemini/max_tokens` — gemini-3.5-flash-lite (`RECORD_GEMINI_MODEL`;
    the script default `gemini-2.5-flash` now returns 404 "no longer
    available to new users" on this API key). `finishReason: MAX_TOKENS`
    mid-stream → canonical `length`. The `nonStreaming` twin matched on
    message/finishReason/usage and is embedded.
- Still omitted (recorded evidence impossible this run):
  - `openai`: `parallel_tool_calls`, `after_tool_result`, `max_tokens`,
    `error` — the key is set but the account has no credit: every case got a
    pre-stream HTTP 429 (`credit_balance_exhausted`), which is the normal
    JSON-error path, not a stream fixture.
  - `anthropic`: `parallel_tool_calls`, `after_tool_result`, `max_tokens` —
    same: pre-stream HTTP 400 (credit balance too low).
  - `gemini/error`, `openai/error` — no deterministic way to make either
    provider send an in-stream `{"error":…}` on a 2xx stream is known; every
    error trigger probed (invalid tool configs, unsupported modalities,
    exhausted quota) returned a pre-stream non-2xx. The script defines no
    `error` case for them; fabricating or splicing bytes is not allowed.
- Provenance note: `message_start`/`tool_call_start` keep the provider's
  response-object IDs verbatim (`chatcmpl-…`, `msg_…`, `responseId`), as the
  existing fixtures do. Only response bodies are recorded — no request
  headers, API keys, org IDs or `request_id`/`x-request-id` values enter the
  files.
- Files outside the Files block: `scripts/record-streams.ts` extended for
  openai/anthropic/gemini (owner-requested follow-up); split for the ~400-line
  rule into `scripts/record-streams-cases.ts` (per-provider endpoints and case
  definitions) and `scripts/stream-fixture-decode.ts` +
  `scripts/stream-fixture-events.ts` (wire bytes → `expectedEvents` /
  `nonStreaming` matching).

## v1.1 Task 3b fix: OLLAMA_MIDSTREAM_KILL is opt-in

- `OLLAMA_MIDSTREAM_KILL` no longer defaults to `docker exec ollama pkill -f
  llama-server`. `npm run record:streams` never kills a process unless the
  variable is explicitly set; without it the ollama `error` case is skipped
  with a log line naming the variable.
- When set, the command is run once, mid-stream (after the first stream lines
  arrive), to induce a real in-stream error. `pkill -f llama-server` stops
  EVERY model runner in the container — set it only against an Ollama
  instance dedicated to recording.
- Ollama fixture `source` now names the server version, matching the other
  recorded fixtures: `recorded: ollama <version>, <model> (via npm run
  record:streams<; note>)`. The script queries `GET /api/version` for it and
  skips ollama entirely when the base URL doesn't answer.

## v1.1 Task 3b fix: openai and anthropic recorded cheaply

- The owner added $5 credit to both accounts and asked to spend as little as
  possible. `record-streams.ts` gained `RECORD_TWINS` (restrict non-streaming
  twin calls to the named cases; `RECORD_TWINS=max_tokens` here — tool-case
  twins can't be embedded until Tasks 8–10) and now logs upstream request
  counts per provider at the end of a run.
- Model choice (one probe each, per the owner's budget): `gpt-4.1-nano` and
  `claude-3-5-haiku-latest` each got exactly one request and returned HTTP 404
  on these keys; fell back to `gpt-4o-mini` and `claude-haiku-4-5` (the other
  owner-named candidates) — accepted.
- Token caps: `max_tokens` case stays ≤16 (openai 5, anthropic 8); all other
  recorded cases ≤200 — openai `parallel_tool_calls` gained `max_tokens:128`,
  anthropic `parallel_tool_calls` dropped 512→192; `after_tool_result` was
  already 64/128.
- Recorded 2026-10-27 (raw bytes verbatim, `expectedEvents` generated by
  `scripts/stream-fixture-decode.ts`; `source` now reads `recorded: <provider>
  API, <model> (via npm run record:streams)`, the owner-requested format —
  applied to openai/anthropic/gemini prefixes for uniformity with ollama):
  - `openai/parallel_tool_calls` — gpt-4o-mini, two `get_weather` calls
    (Paris, London), finish `tool_calls` → `tool_call`.
  - `openai/after_tool_result` — gpt-4o-mini, text reply after the tool
    result, finish `stop`.
  - `openai/max_tokens` — gpt-4o-mini, `finish_reason:"length"` → `length`;
    twin matched on message/finishReason/usage and is embedded.
  - `anthropic/parallel_tool_calls` — claude-haiku-4-5, two `tool_use`
    blocks (Paris, London), `stop_reason:"tool_use"` → `tool_call`.
  - `anthropic/after_tool_result` — claude-haiku-4-5, text reply, `end_turn`
    → `stop`.
  - `anthropic/max_tokens` — claude-haiku-4-5, `stop_reason:"max_tokens"` →
    `length`; twin matched and is embedded.
- Upstream requests made (hard cap was 15 per provider): openai=5,
  anthropic=5 (each: 1 failed model probe + 3 streamed calls + 1 twin).
  Every case produced the expected shape on the first attempt — no prompt
  retries were needed.
- Still omitted: `openai/error` (no real in-stream trigger known — per the
  owner, not attempted) and `gemini/error` (same; no Gemini case defined).
- Files outside the Files block: none new — `scripts/record-streams.ts` and
  `scripts/record-streams-cases.ts` were already declared in the Task 3b
  entry; the `date` parameter they no longer use was removed from the three
  provider setups and `providerSetups`.

## v1.1 Task 4: postStream, streaming pipeline, route, OpenAI decoder/encoder

- Spec sections implemented: §3.2 (pipeline, postStream, idle timeout,
  client-disconnect abort, in-stream errors, completion log), §3.3 OpenAI row
  (decoder/encoder, usage chunk gated on `stream_options.include_usage`,
  `data: {"error":…}` + `data: [DONE]`).
- Files outside the Files block: `.env.example` (documents the new
  `UPSTREAM_STREAM_IDLE_MS` env var) and `tests/integration/errors.test.ts`
  (Step 1 names the replacement — the openai→openai `stream:true` 501 case is
  now covered by `stream.test.ts`; kept listed here because the Files block's
  Modify list omits it).
- Fix round 1 added `src/services/stream-pipeline.test.ts` (new — the
  prescribed unit test pinning "nothing is encoded after a terminal event";
  the Files block has no pipeline test file) and modified
  `src/services/http-client.test.ts` (postStream unit tests: the msw layer
  can't observe an undici body abort, so the headers-only timeout is pinned
  by stubbing `fetch` and asserting the signal stays un-aborted once headers
  resolve). Both are test files for code inside the block.
- The OpenAI decoder parses `data:` lines individually rather than via strict
  SSE block dispatch: the recorded `tool_call.sse` fixture (openai-go stream
  capture) carries bare `data:` lines with no blank-line separators, and every
  OpenAI `data:` line is a complete JSON payload anyway. Comment/`event:`/
  blank lines are ignored. A stream that ends without `[DONE]` (or with a
  chunk that fails JSON.parse) ends in an `error` event, per §3.2.
- `stream-sdk.test.ts` serves the encoded bytes over a real loopback
  `http.createServer` instead of msw: the OpenAI SDK cancels the response
  reader when it sees `[DONE]`, and that cancellation never resolves on msw's
  synthetic response stream (iteration hangs). Loopback only — no external
  network in `npm test`.
- `stream-decoders.test.ts` runs "every split point" verbatim for fixtures ≤
  4 KB (the plan's bound) and a deterministic ~150-point sample for larger
  recordings — `openai/tool_call.sse` is 74 KB, so an exhaustive split loop
  would be quadratic in decode time.
- Pre-headers non-2xx in `postStream` throws an `UpstreamError` carrying the
  upstream status and parsed body, so proxy.service's `toClientFacing` renders
  exactly the same client error as the JSON path.

## v1.1 Task 5: Anthropic stream decoder/encoder

- Spec sections implemented: §3.3 Anthropic row (event-typed SSE
  decoder/encoder, thinking/signature deltas and ping dropped,
  `input_json_delta.partial_json` → `tool_call_delta`, error events via
  `toCanonicalError`), §3.4 (buffered tool arguments → one
  `input_json_delta`, `_invalid_arguments` wrapper on parse failure).
- Wire-format source checked 2026-10-27:
  https://docs.claude.com/en/api/messages-streaming ("Streaming
  Messages" — event flow `message_start` → `content_block_*` →
  `message_delta` → `message_stop`, `ping` anywhere, `event: error`
  mid-stream; `usage.output_tokens` cumulative in `message_delta`;
  `input_json_delta.partial_json`) and
  https://docs.claude.com/en/api/errors (error `type` ↔ HTTP status
  table used for the decoder's in-stream error mapping:
  `overloaded_error` → 529 → kind `unavailable`, matching the error
  fixture; `billing_error`/`conflict_error` also mapped, unknown types
  fall back to 500).
- `message_end` is emitted on `message_stop`, not `message_delta`:
  `message_delta` only holds the stop reason and cumulative usage.
  Otherwise a stream cut between `message_delta` and `message_stop`
  would emit `message_end` and could not end in an `error` event —
  Review Focus #2 names `message_stop` as the terminal marker.
- Wire `content_block` indices are assigned at emission time, so they
  stay contiguous even when canonical tool events interleave
  (canonical `index` keys the buffer, per §3.1 rule 5); the first call
  to reach `tool_call_end` gets the next content-block index.
- `message_start`'s `message.usage` is `{input_tokens: 0,
  output_tokens: 0}` — the real input count only arrives with the
  canonical `usage` event and lands in `message_delta.usage`
  (`input_tokens` included there too, matching the recorded
  `parallel_tool_calls` fixture and giving SDK `finalMessage()` the
  correct totals).
- `mapFinishReason`/`mapToAnthropicStopReason` are reused as-is from
  the adapter, so unlisted stop reasons (`stop_sequence`, `pause_turn`,
  `refusal`, `model_context_window_exceeded`, `container` deltas)
  follow the non-streaming mapping (default `stop` / `end_turn`).
- Errors before the first byte and retry/timeout behaviour are
  unchanged — they flow through Task 4's `postStream` + `toClientError`
  path, verified by `stream.test.ts` and the remaining 501 rows.
- `errors.test.ts` now filters the `stream:true → 501` rows on a
  STREAMING_ADAPTERS set (openai + anthropic) — replaced rows:
  anthropic→anthropic, anthropic→openai, openai→anthropic, each now
  covered by a named case in `tests/integration/stream.test.ts`.
- Fix round: the encoder's `tool_call_end` now calls `closeText()`
  before emitting `content_block_start{tool_use}` — a text_delta that
  arrived while a call was buffered used to leave its block open across
  the tool block (Anthropic never overlaps content blocks); and
  `message_end`/`error` are terminal — `encode()` writes nothing after
  them.

## v1.1 Task 6: Ollama stream decoder/encoder

- Spec sections implemented: §3.3 Ollama row (NDJSON decoder/encoder —
  `message.content` → `text_delta`, `message.tool_calls` whole →
  start + one `JSON.stringify(arguments)` delta + end, `done:true` →
  `usage` + `message_end`, `{"error":"…"}` → `error` via
  `toCanonicalError`), §3.4 (arguments buffered per canonical `index`
  until `tool_call_end`, `parseToolArguments` → `{}` for empty,
  `_invalid_arguments` wrapper for invalid).
- Wire-format source checked 2026-10-27:
  https://docs.ollama.com/api/chat (NDJSON stream shape — `model`,
  `created_at`, `message{role:"assistant",content}`, `done:false`
  chunks; `message.tool_calls[].function.{name,arguments}`;
  `message.thinking` for think models; final line `done:true`,
  `done_reason`, `prompt_eval_count`, `eval_count`) and
  https://github.com/ollama/ollama/blob/main/docs/api.md ("Chat
  request (Streaming with tools)" example). The recorded 0.40.11
  corpus additionally carries `id` and `function.index` on tool calls
  the docs don't show — the decoder uses the wire `id` when present
  and the encoder emits both fields (fixtures are the oracle).
- `message_start.id` draws from the injected `ids` — Ollama has no
  message id (Task 3 convention: `call_0` under `sequentialIds()`).
- `done_reason` → canonical finishReason: a stream that ended in tool
  calls reports `tool_call` (Ollama itself leaves `done_reason:"stop"`
  there); `"length"` → `length`, `"stop"` → `stop`, anything else →
  `unknown`. The encoder maps back: only canonical `length` stays
  `"length"`, everything else → `"stop"` (the two values Ollama
  documents).
- Mid-stream `{"error":"…"}` → `toCanonicalError(500, …)` = canonical
  `internal`/500 — the wire carries no status, so the same failure
  returned pre-stream (HTTP 500) applies, matching the recorded
  `error` fixture.
- The encoder emits nothing for `message_start` (Ollama opens with the
  first content line) and nothing after `message_end`/`error` —
  terminal guard pinned by a named test.
- `errors.test.ts` STREAMING_ADAPTERS gained `ollama` — replaced
  `stream:true → 501` rows: openai→ollama, anthropic→ollama,
  ollama→ollama, ollama→openai, ollama→anthropic; each streaming pair
  is covered by `stream.test.ts` or the generated contract rows.
- Files outside the Files block: `src/services/proxy.service.test.ts`
  — the two `stream:true → 501` unit cases pinned the openai→ollama
  pair, which now streams by design (spec §1.2 F1); they were
  re-pointed at the openai→gemini pair (gemini is the remaining stub
  until Task 7) so the refusal path stays covered.
- Fix round 1 (owner-requested):
  - `tests/contracts/stream-sdk.test.ts`: module-level
    `currentContentType` is reset to `"text/event-stream"` in a
    `beforeEach`; ollama cases still override to
    `application/x-ndjson` — no case depends on test order.
  - Decoder shape guards: a line that parses as JSON but isn't a
    plain object (number, string, array, `null`) and a
    `message.tool_calls` that isn't an array both emit the same
    canonical `upstream` error as an undecodable line and finish the
    stream — previously the first produced a spurious `message_start`
    (`null` threw) and the second threw from `feed()`.
  - Decoder: a string `function.arguments` passes through verbatim as
    `argumentsDelta` (it is already the JSON encoding); objects keep
    `JSON.stringify`, missing stays `"{}"`.
  - Encoder: calls open at `message_end` flush in ascending canonical
    index as `message.tool_calls` lines just before the `done:true`
    line (one `logger.warn` naming only the count); before an `error`
    event they are dropped (one warn naming the count). A
    `tool_call_delta`/`tool_call_end` for an index that never had
    `tool_call_start` now `logger.warn`s (event type and index only)
    instead of dropping silently; output unchanged.

## v1.1 Task 7: Gemini stream decoder/encoder

- Spec sections implemented: §3.3 Gemini row (SSE `data:` frames of
  `GenerateContentResponse`; text parts → `text_delta`, `functionCall`
  parts → start + one `JSON.stringify(args)` delta + end, last
  `usageMetadata` → `usage` at finish, `finishReason` → `message_end`,
  `{"error":{code,message,status}}` frame → `error`), §3.4 (arguments
  buffered per canonical `index` until `tool_call_end`, `args` via
  `parseToolArguments`).
- Wire-format source checked 2026-10-27:
  https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
  and the same page's `GenerateContentResponse`, `Candidate`,
  `FunctionCall`, `UsageMetadata` and `FinishReason` references —
  `candidates[].content.parts[].{text,functionCall{name,args,id}}`,
  `finishReason` values, `usageMetadata.{promptTokenCount,
  candidatesTokenCount,totalTokenCount}`, `responseId`, `modelVersion`
  all verified against the docs, not only the fixtures.
- `message_start.id` = the wire `responseId`, `model` =
  `modelVersion` (fixture convention). Tool-call ID = `functionCall.id`
  when present, else the injected `ids` (`call_0`, …). A stream ending
  in function calls reports `tool_call` even though the wire
  `finishReason` is `STOP` (as the recorded corpus shows);
  `MAX_TOKENS` → `length`, `SAFETY`/`RECITATION` → `content_filter`.
- Decoder shape guards (matching the ollama/anthropic convention): a
  payload that isn't a plain object, a `candidates`/`content.parts`
  that isn't an array, or a `functionCall` that isn't an object → one
  `upstream` error event, never a throw. A stream ending without
  `finishReason` ends in an `error` event. No `error` fixture exists
  in Google's published captures (recorded in "v1.1 Task 3"), so the
  error-frame case is built inline in stream-decoders.test.ts.
- Encoder: `ctx.query.alt === "sse"` → `data: <response>\r\n\r\n`
  frames (`text/event-stream` — the CRLF framing the real API uses and
  the SDK's `^data: (.*)(\n\n|\r\r|\r\n\r\n)` regex accepts); otherwise
  a streamed JSON array (`[`, `,\r\n` separators, `]`) with content
  type `application/json` — the `]` still closes after an `error`
  element so the body stays valid JSON. Elements carry `responseId`
  (echoed from `message_start`) and `modelVersion` =
  `ctx.requestedModel`. One candidate element per `text_delta` and per
  completed `functionCall` — a single `functionCall` part per element,
  which is what the installed `@google/generative-ai` 0.24.1 SDK's
  `aggregateResponses` composes correctly (its per-candidate `newPart`
  accumulator merges multi-part candidates). `functionCall.id` is
  written back (documented optional field) so `decode(encode(events))`
  keeps the call IDs.
- `streamRequestPath` on the Gemini chat route →
  `/v1beta/models/<m>:streamGenerateContent?alt=sse` — the only
  provider whose upstream stream endpoint differs from its chat path
  (spec §3.1; the route field itself landed in Task 4).
- The v1.0.1 streaming-refusal path is gone: all four adapters stream.
  The `stream:true`/`:streamGenerateContent` → 501 rows in
  errors.test.ts and the three refusal cases in
  proxy.service.test.ts were replaced by streaming assertions (the
  old → new mapping is listed in the PR). `proxy.service` sets
  `canonical.stream = true` when the stream branch is entered via
  `isStreamPath` — a Gemini `:streamGenerateContent` request carries
  no body flag, and targets that signal streaming in the body
  (openai `stream_options`, anthropic/ollama `stream:true`) need it.
  Without this, `gemini source → openai/anthropic target` silently
  proxied non-streaming upstream bodies through the stream pipeline.
- Files outside the Files block: `src/services/proxy.service.test.ts`
  — the two `stream:true → 501` cases PR #18 re-pointed at a gemini
  target plus the `:streamGenerateContent` refusal case pinned the
  refusal path this task removes; each was rewritten as a streaming
  assertion (named in the task instruction as required).
- Fix round 1 (owner-requested):
  - `mapFinishReason` maps `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`
    and `IMAGE_SAFETY` to `content_filter` alongside
    `SAFETY`/`RECITATION` — all four verified 2026-10-27 against the
    FinishReason enum at
    https://ai.google.dev/api/generate-content#FinishReason.
    `IMAGE_SAFETY` is in the doc but absent from the installed
    `@google/generative-ai` 0.24.1 enum, so the adapter test casts
    it. No other mapping changed (STOP, MAX_TOKENS, the default and
    the encode direction are untouched).
  - Encoder: a `tool_call_start` for an index that is already open
    `logger.warn`s (event type and index only — no names, ids or
    arguments, matching the unknown-index warn) and keeps the first
    call's buffer; the duplicate start is ignored.
  - Decoder: `end()` sets `finished` when it emits the "Upstream
    stream ended without completing" error — a second `end()` or any
    later `feed()` emits nothing.
  - Decoder: a non-object member inside `candidates` or inside
    `content.parts` emits the same `upstream` "Upstream sent an
    undecodable stream chunk" error as the array-shape guards instead
    of being skipped.

## v1.1 Task 8: tool calling for OpenAI and Ollama (non-streaming)

Spec §3.4 rows implemented: OpenAI `tools[].function` ↔ canonical `tools`,
`tool_choice` ↔ `toolChoice` (all four forms), `tool_calls`/`tool_call_id`
already existed for messages and responses. Ollama `tools` pass through,
`message.tool_calls` ↔ canonical `toolCalls` (arguments object ↔ JSON
string), `role:"tool"` results ↔ `tool_name`, and the `toolChoice` gate.

Ambiguities resolved (Ollama):
- Call ids: wire `id` kept when present, `ids()` drawn when absent —
  same rule as the stream decoder and "v1.1 Task 3" conventions. On
  encode the adapter writes `id` and `function.index`, mirroring the
  recorded Ollama 0.40.11 wire shape (the SDK type omits both fields).
- `toCanonicalRequest` has no injected generator, so request-decode
  generated ids come from a local `sequentialIds()` (`call_0`, `call_1`,…
  in emission order) — deterministic and unique within the request.
- `tool_name` pairing on decode: Ollama results carry only the tool's
  name; each `role:"tool"` message is paired with the earliest
  unconsumed earlier assistant call of that name (FIFO). An unmatched
  tool message keeps `tool_name` as its `toolCallId` so the
  information survives and a later Ollama encode fails with the
  spec-required ValidationError naming it. On encode the lookup is by
  canonical `toolCallId`; no match → ValidationError naming the id only.
- `toolChoice`: `auto` (or absent) passes through; anything else throws
  `ValidationError` → 400. The `<value>` in the message is the string
  itself (`"required"`, `"none"`) or `JSON.stringify` of an object form,
  e.g. `Ollama does not support tool_choice "{"type":"function",...}"`.
- `finishReason`: `message.tool_calls` present → `tool_call` (the stream
  decoder's `sawToolCalls` rule); `fromCanonicalResponse` encodes
  canonical `tool_call` as `done:true, done_reason:"stop"` — what
  recorded Ollama tool-call answers carry.
- A string `arguments` on the wire passes through verbatim; objects are
  `JSON.stringify`d; encode uses `parseToolArguments` (`{}` for empty,
  `{ "_invalid_arguments": "<raw>" }` + a warn line without arguments).

Ambiguities resolved (OpenAI): non-function entries in `tools`
(e.g. `type:"custom"`) and `tool_choice` forms with no canonical
equivalent (`allowed_tools`, `custom`) throw `ValidationError` naming
the type rather than being silently dropped. `strict` on a function
tool and other fields canonical cannot express are dropped — follow-up.

Owner decision (2026-10-27, option a): mapping tools necessarily changed
the recorded tool-dropping snapshot; the approval allowed updating
exactly `Adapter golden fixtures > openai > request fixtures > tools →
canonical matches snapshot 1` (gained `tools` only — the fixture carries
no `tool_choice`). Updated via `npx vitest run
tests/contracts/fixtures.test.ts -u -t '<exact test name>'` in its own
commit `test: update tool snapshots (owner-approved, option a)`; no
other snapshot entry and no fixture file changed.

Files outside the Files block:
`tests/contracts/__snapshots__/fixtures.test.ts.snap` (the one entry
above, owner-approved) and `docs/decisions.md` (this entry).

Fix round 1:
- `src/transformers/adapters/ollama.tools.ts` (new, 180 lines) —
  file outside the Files block: the Ollama tool-call conversion and
  name-resolution helpers moved out of `ollama.adapter.ts`
  (477 → 388 lines) for AGENTS.md rule 7 (single-purpose, ~400
  lines), same pattern as `gemini.tools.ts` /
  `anthropic.messages.ts`. Imported only by `ollama.adapter.ts`;
  `ollama.stream.ts` is untouched (it takes
  `toCanonicalError`/`fromCanonicalError` from the adapter). No
  behaviour change.
- OpenAI `function.strict` and `parallel_tool_calls` have no
  canonical equivalent (`parallel_tool_calls` is a spec non-goal):
  still dropped, now with a `logger.debug` naming only the field —
  `Dropping tool field "strict" (no canonical equivalent)` and
  `Dropping request field "parallel_tool_calls" (no canonical
  equivalent)`, the same pattern Task 9 uses for Anthropic's
  `disable_parallel_tool_use`. The request is not rejected.
- OpenAI `type:"custom"` entries in `message.tool_calls` were
  silently filtered on both decode paths, leaving `toolCalls: []`
  under a `tool_call` finish. Request decode now throws
  `ValidationError` → 400 `invalid_request` in the OpenAI dialect;
  response decode throws `UpstreamError` → status 502, canonical
  kind `upstream` — the unrepresentable shape came from the
  upstream, not the client (so not 400) and it is not a proxy bug
  (so not 500 `internal`): the same kind the stream decoders emit
  for undecodable upstream chunks. Both messages name only the
  type, never call names or arguments.
- Ollama encode builds the call-id → name lookup while walking the
  messages, so a tool message resolves only against an assistant
  call that precedes it in the request; a result whose call appears
  only later hits the existing ValidationError naming the id.
- Tests added: `openai strict and parallel_tool_calls are dropped
  with a debug log naming the field`, `openai custom tool_call in a
  request → 400 naming the type`, `openai custom tool_call in a
  response → error naming the type`, `ollama tool message resolves
  only against an earlier assistant call`, `ollama decode pairs two
  same-name results with their calls in order`, `ollama unmatched
  tool_name is kept and fails on Ollama encode`, `ollama string
  arguments pass through verbatim`.

## v1.1 Task 9: tools for Anthropic (non-streaming)

Spec §3.4 (Anthropic messages). Non-streaming `tools` / `tool_choice` /
`tool_use` / `tool_result` mapping in `anthropic.adapter.ts`;
`anthropic.stream.ts` untouched (Task 5 already streams tool_use).

- `tools[]` ↔ canonical tools: `{name, description, input_schema}` ↔
  `{type:"function", function:{name, description, parameters}}`.
  `input_schema` passes through unchanged (spec §3.4: only Gemini
  rewrites schemas). On encode `input_schema` defaults to
  `{"type":"object"}` when canonical `parameters` is absent (the
  Messages API requires an object schema).
- `tool_choice` ↔ `toolChoice`: `auto`→`auto`, `any`→`required`,
  `none`→`none`, `{type:"tool",name}`→`{type:"function",
  function:{name}}`, and back.
- `disable_parallel_tool_use` has no canonical field: **dropped with a
  debug log naming only the field** (`tool_choice`
  `disable_parallel_tool_use` has no canonical equivalent). Not a 400 —
  the choice itself still maps; only the parallel-use hint is lost.
- `tool_use.input` on encode is `parseToolArguments(arguments).args`:
  `{}` for empty, the `{ "_invalid_arguments": "<raw>" }` wrapper plus
  a warn log (without the arguments) for unparseable input. On decode
  `arguments` is `JSON.stringify(input)`.
- `tool_result` decode: a user message with N `tool_result` blocks → N
  canonical `role:"tool"` messages in order, then one user message for
  any remaining text/image blocks (spec §3.4). `tool_result.content`:
  a string passes through; an array's **text blocks join with `"\n"`**.
  Any non-text block in `tool_result.content` (image, document, …) →
  `ValidationError` naming the block type → 400 in the Anthropic
  dialect (`invalid_request_error`). Canonical tool results carry no
  images, so this is never a silent drop.
- `is_error` ↔ `isError`: decode maps only `is_error === true` to
  `isError: true`; encode **omits `is_error` unless `isError ===
  true`** (Anthropic's documented default is false).
- Encode merges each run of consecutive canonical tool messages into
  ONE user message of `tool_result` blocks; an assistant message's text
  precedes its `tool_use` blocks.
- `tools[]` entries that are server-side toolsets (no `name` — e.g.
  `browser_toolset_*`) → `ValidationError` naming the tool type; named
  built-in tools map by `name`/`description` (no `input_schema` → no
  `parameters`).
- Canonical tool messages with array content keep their parts on
  encode (`tool_result.content` accepts text/image blocks); other
  adapters only produce string tool content, so this path is
  theoretical.
- Wire-format source checked 2026-10-27: Anthropic Messages API and
  Tool use docs (docs.claude.com / docs.anthropic.com —
  `tools[].{name,description,input_schema}`, `tool_choice` types
  `auto`/`any`/`tool`/`none`, `tool_use{id,name,input}`,
  `tool_result{tool_use_id,content,is_error}`, `stop_reason:"tool_use"`).
- **Owner decision (2026-10-27, option a):** exactly two existing
  contract snapshot entries updated, purely additive —
  `anthropic > request fixtures > tools → canonical matches snapshot 1`
  gained `tools` (the fixture has no `tool_choice`, so no `toolChoice`),
  and `anthropic > response fixtures > tool_use → canonical matches
  snapshot 1` gained `message.toolCalls`. Updated via targeted
  `vitest -t` runs only; committed separately as `test: update tool
  snapshots (owner-approved, option a)`.
- File split (AGENTS.md rule 7): the message/content/tool conversion
  layer moved to `src/transformers/adapters/anthropic.messages.ts`
  (~317 lines; the adapter would otherwise be ~660). The adapter
  imports it one-way; it depends only on `src/types` and `src/utils`,
  same as `anthropic.stream.ts`.
- Files outside the Files block: `docs/decisions.md` (this entry —
  required by the task to record the mapping choices and the owner
  approval),
  `src/transformers/adapters/anthropic.messages.ts` (the split above),
  and `tests/contracts/__snapshots__/fixtures.test.ts.snap` (the two
  entries above, per the owner decision).
## v1.1 Task 10: Gemini tools (non-streaming) + toGeminiSchema

- Spec sections implemented: §3.4 Gemini row —
  `tools[].functionDeclarations` ↔ canonical `tools` (parameters
  through `toGeminiSchema` on encode); `toolConfig.functionCallingConfig`
  ↔ `toolChoice` (`AUTO`/`MODE_UNSPECIFIED`→`auto`, `NONE`→`none`,
  `ANY`→`required`, `ANY`+`allowedFunctionNames:[n]`→function choice;
  `ANY` with >1 allowed names has no canonical equivalent →
  ValidationError); `functionCall` parts ↔ `toolCalls`
  (`functionCall.id` when present, else injected `ids()`; `id` dropped
  on encode); canonical tool messages → `functionResponse` parts
  (`name` resolved from the matching assistant call in the same
  request; content sent as a JSON object when it parses as one,
  otherwise `{ "content": "<string>" }`; consecutive tool messages
  share one `user` turn; no matching call → ValidationError).
- `toGeminiSchema` allow-list (read 2026-10-27 from
  https://ai.google.dev/api/generate-content#Schema — the Schema
  object moved there from caching#Schema): `type`, `format`, `title`,
  `description`, `nullable`, `enum`, `maxItems`, `minItems`,
  `properties`, `required`, `minProperties`, `maxProperties`,
  `minLength`, `maxLength`, `pattern`, `example`, `anyOf`,
  `propertyOrdering`, `items`, `minimum`, `maximum` — the documented
  fields minus `default`. The doc lists `default` as accepted and
  ignored ("included here and ignored so that developers who send
  schemas with a `default` field don't get unknown-field errors");
  Owner decision (2026-10-27, option a): drop it anyway, keep the
  plan's test verbatim. Recursion into `properties.*`, `items` and
  `anyOf` at every depth; the input is never mutated.
- `Type` case: `type` is passed through verbatim (lowercase
  JSON-Schema values such as `"object"`/`"string"`). The enum table
  lists uppercase names (`STRING`, `OBJECT`, …, plus `NULL`), but
  Google's own `FunctionDeclaration.parameters` /
  `parametersJsonSchema` examples on the same page use lowercase
  (`"type": "object"`, `"type": "string"`, `"type": "integer"`), as
  does the function-calling guide example — lowercase is what those
  documented examples send for this field, so no case mapping.
- `functionCallingConfig.mode: "VALIDATED"` (Mode enum on
  https://ai.google.dev/api/caching#Mode, read 2026-10-27) has no
  canonical equivalent: decode throws ValidationError naming the mode
  (400 in the Gemini dialect); encode never emits it.
- Owner decision (2026-10-27, option a) — contract snapshots:
  approved updating exactly one entry,
  `Adapter golden fixtures > gemini > request fixtures > tools →
  canonical matches snapshot 1` (gains `tools`; the fixture has no
  `toolConfig`, so no `toolChoice`), in its own commit
  `test: update tool snapshots (owner-approved, option a)`.
- Files outside the Files block: none —
  `tests/contracts/__snapshots__/fixtures.test.ts.snap` is the
  owner-approved snapshot update above.
- Fix round 1:
  - Decode: `callIds` was `Map<name, id>`, so a second call to the same
    function overwrote the first and parallel same-name calls got each
    other's results. Now a FIFO queue of pending call ids per name
    (`PendingCallIds`); `functionResponse.id` still wins when present
    (consuming its queue entry); a response with no pending call → the
    existing "no matching function call" ValidationError.
  - Decode: `tools[]` entries with keys other than
    `functionDeclarations` (`codeExecution`, `googleSearch`,
    `googleSearchRetrieval`, …) were silently dropped →
    ValidationError `Gemini tool type "<key>" is not supported` (400),
    consistent with the VALIDATED / multi-name ANY handling.
  - File outside the Files block: `src/transformers/adapters/gemini.tools.ts`
    (new, 339 lines) — the whole tool request/response mapping moved
    out of `gemini.adapter.ts` (734 → 551 lines) for AGENTS.md rule 7
    (single-purpose, ~400 lines); imported only by `gemini.adapter.ts`,
    same pattern as `gemini.schema.ts` / `gemini.stream.ts`. No
    behaviour change beyond the two fixes above.
  - Tests added: `gemini parallel calls to the same function keep
    their own results`, `gemini functionResponse id wins over name
    order`, `gemini non-function tool entry → 400 naming the tool
    type`, `gemini ANY with several allowedFunctionNames → 400` (the
    last covers already-implemented behaviour).

## Conductor: act as the babelgate-conductor GitHub App (owner request, 2026-10-28)

- **What:** the conductor and every Devin session act on GitHub as the GitHub App
  `babelgate-conductor[bot]` (app 5508146, installed on this repository only), not as the
  owner. `scripts/conductor/app-token.sh` mints 1-hour installation tokens from a private key
  kept outside the repo (`~/.config/babelgate-conductor/`); `scripts/conductor/bin/gh` and
  `bin/git-credential-babelgate` fetch a fresh token per call; `app-env.sh` (sourced by
  `devin.sh`, `status-comment.sh`, `as-app.sh`, `start.sh`) sets them up and authors commits as
  the bot. The owner's own shell is unaffected. Same setup as NeoPhylo's conductor, with a
  separate app so a session in one repository holds no key for the other.
- **Permissions:** Contents, Pull requests, Issues read/write; Actions, Checks, Commit
  statuses, Metadata read. No Administration, Workflows, Secrets or Environments. **Actions is
  read-only** because `live.yml` runs with provider API keys and a dispatch executes the
  dispatched branch's code; CI reruns and dispatches are therefore the owner's, and suspected
  flakes are rerun locally (CLAUDE.md "GitHub identity").
- **Why:** under the owner's account the owner could not approve agent PRs (GitHub forbids
  self-approval), received no notifications for escalations, and `/inbox` could not tell owner
  commands from agent comments by author.
- **Owner-only settings** (`docs/conductor/rulesets/apply.sh`, run by the owner): `main` keeps
  its required `check` and `CLAAssistant` checks and gains one Code Owner approval not by the
  last pusher; `v*` tags only by the owner.
- **`.github/CODEOWNERS`:** new, `* @dorrabbkhan`, so every PR needs the owner.
- **`/inbox`:** a command counts only from `dorrabbkhan` with association OWNER; comments by
  the bot are never commands. `status-comment.sh` edits only the bot's own sticky comment.
- **CLA:** the CLA workflow's allowlist (`dorrabbkhan,*[bot]`) already exempts the app; its
  commits are the owner's agents acting on the owner's behalf.

## Conductor: SessionStart hook sets the app identity (owner request, 2026-10-28)

- **What:** `.claude/settings.json` gains a SessionStart hook running
  `scripts/conductor/session-env.sh`, which writes absolute `export` lines (git identity and
  credential helper, the `gh` wrapper first on PATH, `CONDUCTOR_ACTOR`) to `$CLAUDE_ENV_FILE`. Every
  Claude Code session opened in this repo therefore acts as `babelgate-conductor[bot]`, however it
  was started; `start.sh` stays but is optional. On a machine without the app's config the
  hook writes nothing. CLAUDE.md and CONDUCTOR-SETUP.md describe it, with the fallback check
  (`printenv CONDUCTOR_ACTOR` empty → use `as-app.sh`).
- **Why:** in a plain `claude` session, the conductor's own `gh` calls (escalations, /inbox
  acknowledgements) went out as the owner, who gets no notification for their own comments.
- **Shell:** export lines rather than sourcing `app-env.sh`, which is bash-only; the owner's
  shell is zsh. Verified with a fresh headless session: commits authored by the bot.

## v1.1 Task 11: Claude Code essentials

- **`token-estimate.ts` lives in `src/utils/`, not `src/services/`** (Files-block
  deviation): the Anthropic stream encoder needs `estimateInputTokens` for
  `message_start.usage.input_tokens`, and adapter files may only import
  `src/types/`, `src/utils/` and own-provider helpers. A `src/services/` home
  would be unimportable there; services may import utils, so
  `src/utils/token-estimate.ts` (+ `src/utils/token-estimate.test.ts`) serves
  both `count_tokens` (proxy.service) and the encoder.
- **The `message_start` estimate is derived inside the encoder** as
  `estimateInputTokens(toCanonicalRequest(ctx.sourceRequest))` — the same body
  the service decoded, re-run through the pure converter. Passing a precomputed
  number would need a new field on `StreamEncoderContext`, which the task notes
  reserve as an owner-level interface change; `sourceRequest` is the existing
  context field that already carries the client's request (the same channel
  `openai.stream.ts` uses for `stream_options`). `canonical.types.ts` is
  unchanged and `message_delta` still carries the real upstream counts.
- **Files outside the Files block:** `src/transformers/adapters/anthropic.messages.ts`
  (block-level drop/ValidationError logic — the message-decode layer the
  adapter delegates to) and `src/transformers/adapters/anthropic.stream.ts`
  (the `message_start` estimate and the thinking-delta drop logs). Both are
  own-provider helper files under the same import rules as `anthropic.adapter.ts`.
- **`src/routes/proxy.ts` was listed as "modify" but needed no change:**
  `result.headers` was already applied before both the JSON and stream paths,
  so the `x-babelgate-token-estimate` header flows through unchanged.
- **`estimateInputTokens` counts system text once.** Every adapter keeps the
  system text in both `systemPrompt` and a `system`-role message; a literal
  "system prompt + all message text" formula double-counts it (live check: a
  26-char request estimated 11 tokens instead of 7). When `systemPrompt` is
  set, `system`-role messages are skipped; when it is absent their text counts
  as message text.
- **`count_tokens` route ordering:** the route precedes the `/v1/messages`
  chat route in `PROVIDER_ROUTES.anthropic` — routes match by `startsWith` in
  order, and the two share the prefix.
- **Ambiguities resolved:** an invalid `MODEL_MAP` entry is an empty pattern,
  an empty model or no `=` (per trimmed entry; `MODEL_MAP` unset/blank → no
  rules); glob `*` matches an empty run but the literals around it stay
  (`x-*-z` does not match `x-z`); `TARGET_CONTEXT_WINDOW` must be a positive
  integer (`ConfigurationError` otherwise); forwarding and completion log
  lines carry both `model` (mapped, upstream-bound) and `requestedModel`
  (client's name) per §3.5 "logs show both".

## v1.1 Task 12: property tests + launch-pair matrix

- **`decode(encode(events))` is asserted event by event** against `wireNormalForm(provider, events)` —
  the exact sequence each wire can carry — with the reassembled `{message, finishReason, usage}` kept
  as an additional end-to-end check. The normal form rewrites only what the wire genuinely cannot
  carry, each rule documented with the encoder/decoder line it comes from: Anthropic/Gemini/Ollama
  collapse each call to `[tool_call_start, one tool_call_delta =
  JSON.stringify(parseToolArguments(args).args), tool_call_end]` at the position of its `tool_call_end`
  (the plan's named exception; non-tool events between start and end keep their order); OpenAI moves
  `tool_call_end`s to just before the trailing usage/`message_end` in start order (its decoder closes
  calls at the finish chunk), moves `usage` to just before `message_end` (emitted at `[DONE]`), and
  drops empty `tool_call_delta`s (the decoder only emits non-empty `function.arguments`); Ollama
  replaces `message_start.id` with the decoder-generated `"call_0"` and always reports usage.
  Everything else — message ids, text-delta boundaries, interleaved deltas, ids, names and raw
  argument strings — round-trips verbatim. The reassembled check still compares tool arguments in wire
  form (raw JSON string for OpenAI, `parseToolArguments`-normalized object for the others, covering
  the `_invalid_arguments` wrapper). `ARGS_POOL` includes `""` so the empty-arguments edge
  (Review Focus 5: Anthropic/Gemini/Ollama clients get `{}`) is exercised. This also feeds fully
  interleaved deltas to every encoder — the §3.1-rule-5 buffering the other tests only exercise for
  Anthropic.
- **Generated sequences stay inside what every wire can carry:** tool-call ends in index order
  (out-of-order ends would renumber decoded calls — a wire limitation, not a canonical one);
  `finishReason` is `tool_call` exactly when calls exist else `stop`/`length`; `usage.totalTokens` is
  always input+output (Anthropic and Ollama recompute it); and usage is always generated for
  Anthropic/Ollama, whose wire streams always carry counts (their decoders emit a usage event even when
  the encoder saw none).
- **`tests/mocks/upstreams.ts`**: `streamCase` now also drives non-stream replies via exported
  `nonStreamBody(provider)`, built on the exported `nonStreamSource(provider)` selector so the
  matrix's expectations come from the same oracle the mock serves. Resolution order: `"text"` → the
  recorded `responses.basic`; a named fixture response (`openai.tool_call`, `anthropic.tool_use`); the
  recorded non-streaming twin (`<case>.nonstreaming.json`, then the `<case>.json` `nonStreaming`
  field); last, the case's documented `expectedEvents` reassembled and re-encoded in the provider's
  dialect. The derive path exists because no recorded parallel-tool-calls non-stream body exists for
  OpenAI/Anthropic/Gemini (fixtures are owner-only changes); it uses only oracle `expectedEvents` plus
  the provider's own encoder.
- **Non-stream matrix expectations are oracle-only:** when the mock serves a recorded body the
  expectation parses that recording; on the derive path it is `reassembleStream(expectedEvents)`
  directly — never re-parsed from the adapter-derived body — and each cell asserts the exact call
  count, names and distinct ids (`tool_call` → 1, `parallel_tool_calls` → 2, text cases → 0 calls and
  non-empty text) so a misconfigured or zero-call mock cannot pass vacuously.
- **Ollama tool-case twins stay out of the twin property** because `<case>.nonstreaming.json` is a
  separate live recording whose call ids differ from the stream's — Ollama keeps the wire tool-call
  ids (`ollama.tools.ts`; only the message id is a generated UUID), so the differing ids are real and
  the fixtures mark `nonStreaming: null`.
- **Files outside the Files block:** `docs/decisions.md` (this entry; the task's Files block lists only
  the two new test files and `tests/mocks/upstreams.ts`).
- **`tests/integration/stream-pairs.test.ts` is ~640 lines and `tests/contracts/stream-properties.test.ts`
  ~645 — above the ~400 guideline.** The generated-matrix test files in this suite already run past that
  (`stream-sdk.test.ts` 1170, `stream.test.ts` 701, `stream-decoders.test.ts` 471); each file is still
  single-purpose, so splitting wasn't done. Task 17 can lift the source/target dialect helpers out when
  it widens the matrix to 16 pairs.

## v1.1 Task 13: CLI + presets

- **`package.json`:** added only `bin` (`babelgate` → `dist/cli.js`) and `files`
  (`dist`, `README.md`, `LICENSE`, `NOTICE`). `name`, `version`, `publishConfig`
  and scripts untouched; `dist/cli.js` gets its `#!/usr/bin/env node` shebang
  from `src/cli.ts` (tsc preserves it).
- **`src/index.ts`:** the server bootstrap moved into an exported
  `startServer(): Promise<Server>` guarded by `require.main === module`, so
  importing it (as `src/cli.ts` does) opens no socket. `npm start`,
  `npm run dev` and the Docker `CMD ["node", "dist/index.js"]` still run the
  module directly and behave exactly as before, including the
  "Invalid configuration" fatal on bad env and the graceful-shutdown handlers
  (now registered inside `startServer`, so CLI-started servers get them too).
- **Ambiguities resolved:**
  - "User env wins" counts a key as set only when its value is non-empty —
    `loadConfig` already treats `""` as unset for every var it reads, and a
    `.env` copied from `.env.example` (`SOURCE_API=` blank) must not disable a
    preset.
  - `MODEL_MAP` is emitted only when `--model` is passed; a model-less
    `claude-*=` rule would be invalid. `--model` has no effect under the
    `openai-apps` preset (spec names no mapping there).
  - `--base-url` targets `<TARGET>_API_BASE_URL`, falling back to a valid
    `TARGET_API` in the env when `--target` isn't passed; it throws naming
    `--base-url` when neither exists.
  - `--port` flows through `PORT`, so the port `clientInstructions` prints is
    always the resolved `config.port` the server actually bound.
  - `main` catches parse/startup failures, prints the message to stderr and
    sets `exitCode = 1`; upstream keys are never accepted as flags or printed
    (only the client-facing `PROXY_API_KEY` appears in the export lines, per
    spec §3.6).
- **Review fixes:**
  - `startServer` now calls `app.listen(port)` with no callback and resolves
    on `server.once("listening")` / rejects on `server.once("error")`.
    Express 5 registers a passed callback on both `listening` and `error`,
    so on EADDRINUSE the callback ran and `resolve(server)` won — the
    process printed the export lines (or nothing, for `node dist/index.js`)
    and exited 0 with nothing listening. The same silent-exit behaviour
    existed on `main` for `npm start` / the Docker CMD since the
    `startServer` refactor; it is now fixed for both entry points. The
    SIGTERM/SIGINT handlers are registered only after `listening`, not on a
    failed bind.
  - The claude-code `UPSTREAM_TIMEOUT_MS=600000` preset value keys off the
    effective target — `--target`, else a valid `TARGET_API` in the env —
    via a shared `effectiveTarget` helper, exactly as `--base-url` already
    resolved it. Previously only `args.target === "ollama"` counted, so
    `TARGET_API=ollama` in the env got no timeout.
  - Two stderr warnings were added before the server starts (via
    `console.error`, never the logger, names only — never env values): one
    naming the env keys that overrode preset/flag values
    (`overriddenKeys(args, env)`), and one for `--preset claude-code`
    without `--model` and no `MODEL_MAP` in the env (claude-* model names
    are forwarded unchanged).
  - The printed export lines follow the resolved `config.sourceApi`, not
    `args.preset`: if the user's env overrides `SOURCE_API` (e.g.
    `SOURCE_API=openai` with `--preset claude-code`) the lines for the
    source that actually runs are printed, via a small source→preset
    mapping that reuses `clientInstructions` unchanged.
- **Files outside the Files block:** `docs/decisions.md` (this entry; the
  task's Files block lists `src/cli.ts`, `src/cli.test.ts`, `package.json` and
  `src/index.ts`).

## v1.1 Task 15: live streaming/tools suite + Claude Code edit gate

- **OpenRouter base URL is `https://openrouter.ai/api`, not the plan's
  `https://openrouter.ai/api/v1` (plan defect).** Upstream URLs are built by
  plain concatenation — `${targetBaseUrl}${requestPath}` in
  `proxy.service.ts` — and the OpenAI request path already carries `/v1`
  (`/v1/chat/completions`). With `/api/v1` the upstream URL would be
  `/api/v1/v1/chat/completions`. OpenRouter's documented endpoint is
  `https://openrouter.ai/api/v1/chat/completions`
  (https://openrouter.ai/docs/api-reference/overview), so the base must be
  `https://openrouter.ai/api`. Applied in `liveTargets()`/`useTarget`
  (`tests/live/live.helpers.ts`) and in
  `scripts/gates/claude-code-edit.sh` (`--base-url https://openrouter.ai/api`).
- **`.github/workflows/live.yml` is not in this commit.** The conductor app
  has no Workflows permission, so the one-line env addition
  (`OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` on the
  "Run the live suite" step) is attached to the PR description as a patch
  for the owner to apply.
- **`"openrouter"` is a `LiveTarget`, not a `Provider`** — the union type
  lives in `tests/live/live.helpers.ts`; no `src/` type changed. It borrows
  the OpenAI provider: `useTarget` sets `TARGET_API=openai` with the
  OpenRouter base URL and `OPENROUTER_API_KEY`, and restores the real
  `OPENAI_API_KEY`/`OPENAI_API_BASE_URL` for other targets so the borrowed
  credentials can't leak into real `openai` cases in the same process.
- **Forced tool call covers both sources** on the openrouter target:
  OpenAI `tool_choice: "required"` and Anthropic `tool_choice: {"type":"any"}`
  — both map to canonical `"required"`, which the OpenAI adapter sends
  upstream as `"required"` (OpenRouter forwards `tool_choice` per
  https://openrouter.ai/docs/api-reference/overview; Anthropic documents
  `type:"any"` as "must use a tool" at
  https://docs.anthropic.com/en/api/messages).
- **Gate flags from `claude --help` 2.1.311:** `-p`,
  `--permission-prompts none` (denies anything that would prompt),
  `--allowedTools "Edit" "Write" "Bash(npm test)"` (file edits and
  `npm test` only), `--strict-mcp-config` and `--setting-sources local`
  (the temp dir has no `.claude`, so user/project/MCP config can't widen
  the tool set). `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` are unset for the
  run so the printed `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` decide
  routing; the auth token is the client-facing proxy token the CLI prints.
- **`OLLAMA_API_BASE_URL` default in the gate:** env-config requires
  `<TARGET>_API_BASE_URL` for the selected target, so the ollama run
  supplies `http://localhost:11434` when the env doesn't set it.
- **Files outside the Files block:** `vitest.config.ts` (added
  `scripts/gates/fixtures/**` to the vitest exclude — the edit-task
  fixture's failing `sum.test.js` is picked up by vitest's default include
  and would break `npm test`), `docs/decisions.md` (this entry),
  `.github/workflows/live.yml` (patch only, see above — not committed).

### Fix round 1 (review of PR #31)

- **Stale live stream case replaced (owner-approved expected-value
  change).** `tests/live/errors.live.test.ts`:
  `"$source → $target stream:true → 501 in source dialect"` →
  `"$source → $target stream:true → 200 stream in source dialect"` —
  asserts status 200, the source's streaming content type (SSE for
  openai/anthropic/gemini, NDJSON for ollama) and a terminal event in the
  source dialect (`data: [DONE]`, `data: {"type":"message_stop"}`,
  last-frame `candidates[0].finishReason === "STOP"`, `done: true`
  NDJSON line), mirroring `tests/integration/stream.test.ts`. Gemini
  still signals streaming in the path — the case uses
  `:streamGenerateContent?alt=sse`. `UNSUPPORTED_CHECKS` removed
  (nothing else used it). The file is outside the task's Files block.
  Owner sign-off: Dorrabb Khan, 2026-10-28 — 501→200 live stream case approved.
- **OpenRouter `streams text` token budget:** the case relied on
  `chatCall`'s 16-token `max_tokens` default, which can truncate before
  a text delta or usage; the `openrouter` target now gets the same 512
  budget as `ollama`. The other openrouter cases (`accepts tool
  definitions`, `forced tool call`) already set explicit budgets.
- **Files outside the Files block (fix round 1):**
  `tests/live/errors.live.test.ts` (expected-value change above),
  `.gitignore` (`!/scripts/gates/fixtures/**` negation after the `*.js`
  rule — the PR's own follow-up note; the gate fixture's `.js` files no
  longer need force-add), `docs/decisions.md` (this entry).

### Edit gate run (owner decision on D3, 2026-10-28)

- **D3 deviation: the PR #31 gate ran on OpenRouter
  `poolside/laguna-s-2.1:free`, not on `qwen3-coder:30b` or
  `qwen/qwen3-coder`.** `scripts/gates/claude-code-edit.sh openrouter
  poolside/laguna-s-2.1:free` → `GATE PASS` in 36 s (Claude Code 2.1.311,
  run on the owner's machine with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000`).
  This shows Claude Code completing the edit task through babelgate on a
  real remote model; it does not cover the Qwen models D3 names. What
  was tried:
  - **Local `qwen3-coder:30b`:** doesn't fit the owner's laptop (30 GB
    RAM, no usable GPU, CPU-only Ollama in Docker). Loading it hit a
    global OOM: llama-server reached 17 GB RSS — Ollama's fit check
    projected 7.5 GB host memory and left out the 13.4 GB `CPU_REPACK`
    buffer — and systemd-oomd killed GNOME Shell. The owner has no
    machine large enough, so a local 30B run is not planned.
  - **Local `qwen2.5-coder:7b` (tried as a lighter stand-in):** `GATE
    FAIL` after 500 s. Memory was fine (≥ 13 GB free throughout), but
    CPU prompt processing ran at ~34 tokens/s, so a ~10.5k-token Claude
    Code request takes ~5 min before the first byte; the first call
    hit the 300 s stream idle timeout (D5, unchanged) and the one reply
    that completed emitted its tool call as text in a ```json block,
    not a native tool call (the "local models call tools unreliably"
    risk in the spec). No babelgate defect found.
  - **OpenRouter `qwen/qwen3-coder` (paid):** the owner's key has only
    a small remaining budget. OpenRouter rejected the request before
    the model ran (Claude Code's default 65 536 `max_tokens` exceeded
    the 40 000 tokens the key could afford); `qwen/qwen3-coder:free`
    returns 404 "This model is unavailable for free". babelgate
    forwarded `max_tokens` unchanged, as it should. 16-token live
    requests to the paid model succeed, so a capped rerun
    (`CLAUDE_CODE_MAX_OUTPUT_TOKENS` below the key's budget) may pass.
- **OpenRouter `qwen/qwen3-coder` (the D3 model) also passed:**
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000 scripts/gates/claude-code-edit.sh
  openrouter` → `GATE PASS` in 14 s (Claude Code 2.1.311, owner's
  machine, 2026-10-28).
- **`CLAUDE_CODE_MAX_OUTPUT_TOKENS`** caps Claude Code's requested
  output budget; the gate script passes the caller's environment
  through, so no script change was made. Keys with a spend limit need it.
- **Ollama path: Claude Code gate not run; accepted risk (owner
  decision).** Every route to a capable model on Ollama was blocked:
  local `qwen3-coder:30b` doesn't fit and local `qwen2.5-coder:7b` is
  too slow on CPU (above), and Ollama Cloud needs paid credits
  (`qwen3-coder:480b-cloud` → 400 "retired on July 15, 2026";
  `glm-5.3-flash:cloud` → 400 "Add usage credits"). The cloud runs did
  confirm the error path: upstream 400s reached Claude Code through
  babelgate intact. What the gate checks is covered in two halves:
  Claude Code end to end through babelgate by the OpenRouter pass
  above, and the Ollama adapter against a real Ollama server by the
  live suite (`qwen2.5:0.5b`, nightly in CI). Not covered: Claude Code
  ↔ Ollama on a capable model; rerun `scripts/gates/claude-code-edit.sh
  ollama <model>` when credits or a GPU are available.
- **Local live-suite run, owner's machine, 2026-10-28:** 66 passed,
  24 failed (90). Every `ollama`-target case passed, including all 10
  streaming and tool cases in `stream.live.test.ts`. The 24 failures
  are test-suite defects, not babelgate defects, and go to fix round 2:
  - 8 `anthropic`-target and 8 `gemini`-target cases: the default live
    models are retired upstream (`claude-3-5-haiku-latest` → 404;
    `gemini-2.0-flash` → 404 "no longer available").
  - 4 `openrouter` cases from the `gemini`/`ollama` sources:
    `chatCall` sets no output limit for those dialects
    (`tests/live/live.helpers.ts`), so OpenRouter assumes 65 536 tokens
    and rejects on credit; the `openai`/`anthropic` sources send
    `max_tokens: 16` and pass.
  - 4 `openrouter` "unknown model → 404" cases: OpenRouter answers an
    unknown model with 400 "is not a valid model ID", not 404; the
    expected status is wrong for this target (an expected-value change,
    needs owner approval).
- **Before Task 16 / the release:** the nightly live suite's OpenRouter
  cases need credit on `OPENROUTER_API_KEY`.
- **Gemini target merged without a clean live rerun:** the `gemini`
  chat and stream cases failed only on the free-tier quota (429) and a
  503 "high demand"; `gemini-3.8-flash` itself resolves (the model-list
  cases pass). Run the gemini target live once on a fresh quota or a
  paid tier before the release.
- Owner sign-off: Dorrabb Khan, 2026-10-28 — D3 deviation accepted
  (OpenRouter gate passed on qwen/qwen3-coder; Ollama Claude Code gate
  not run, accepted risk); merging without the Gemini live rerun.

### Fix round 2 (owner live run)

The owner's `npm run test:live` on 2026-10-28 (66 passed, 24 failed) —
every failure a live-suite defect, not a babelgate defect — fixed as:

- **Retired default live models** (`DEFAULT_LIVE_MODELS` in
  `tests/live/live.helpers.ts`; `LIVE_<TARGET>_MODEL` overrides
  unchanged): `anthropic`: `claude-3-5-haiku-latest` → `claude-haiku-5-5`
  (upstream 404 `not_found_error`); `gemini`: `gemini-2.0-flash` →
  `gemini-3.8-flash` (upstream 404 "no longer available"). The README
  live-suite bullet naming the same defaults was updated to match.
- **`chatCall` output limit for the gemini and ollama sources:**
  `generationConfig.maxOutputTokens: 16` and `options.num_predict: 16`
  respectively — with no limit OpenRouter assumes 65 536 tokens and
  rejects on credit (400 "more credits, or fewer max_tokens"). Caller
  `generationConfig`/`options` in `extra` merge over the defaults, so
  explicit budgets still win. Request bodies only; no assertions
  changed.
- **OpenRouter unknown model → 400 (owner-approved expected-value
  change).** `tests/live/errors.live.test.ts` "unknown model" case:
  `404` + `NOT_FOUND_CHECKS` for every target → `400` +
  `INVALID_REQUEST_CHECKS` for the `openrouter` target only (OpenRouter
  answers an unknown model with 400 "is not a valid model ID";
  https://openrouter.ai/docs/api-reference/errors); every other target
  keeps 404 + `NOT_FOUND_CHECKS` unchanged. Not a provider-pair special
  case — a test expectation for a target whose upstream status differs;
  no `src/` change. Owner sign-off: Dorrabb Khan, 2026-10-28 —
  OpenRouter unknown model → 400 approved.
- **Files outside the Files block (fix round 2):** `README.md`
  (live-suite default model names), `docs/decisions.md` (this entry).

## v1.1 Task 16: README, recipes, CHANGELOG, `1.1.0` · OWNER GATE

- **Demo GIF is a marked slot, not a file.** `docs/assets/demo.gif` does
  not exist; the README carries an HTML-comment slot
  (`<!-- OWNER: add docs/assets/demo.gif ... -->`) the owner fills from
  the OpenRouter gate run before merge. No binary and no rendering
  broken image link was committed.
- **CHANGELOG release date confirmed.** `## [1.1.0] - 2026-10-28` is the
  final release date (owner-confirmed in fix round 1). Tag `v1.1.0` and
  `npm publish` with 2FA remain owner steps.
- **OpenRouter base URL documented as `https://openrouter.ai/api`** in
  README and recipes, matching the Task 15 correction — babelgate
  appends `/v1/chat/completions` itself.
- **Known limitations state the D3 deviation plainly:** the Claude Code
  edit gate passed on OpenRouter (`qwen/qwen3-coder`,
  `poolside/laguna-s-2.1:free`), and the Claude Code ↔ Ollama path on a
  capable model (`qwen3-coder:30b`) was never run. README and the
  claude-code recipe say exactly that — they do not claim a local gate
  pass — and they warn that local models may call tools unreliably and
  CPU-only machines can hit `UPSTREAM_STREAM_IDLE_MS`.
- **No live-verification claims for Gemini.** The Gemini target had no
  clean live run (free-tier 429/503), and Gemini/Ollama sources are not
  live-verified — stated in README, CHANGELOG and decisions.
- **`CLAUDE_CODE_MAX_OUTPUT_TOKENS` documented** in the Claude Code
  recipe and README (spend-limited OpenRouter keys reject Claude Code's
  default output budget; the gate passed with 8 000/16 000).
- **Every documented flag, env var and printed line was checked against
  the code** (`src/cli.ts`, `src/config/env-config.ts`,
  `scripts/gates/claude-code-edit.sh`, `tests/live/live.helpers.ts`) and
  the CLI was run locally to confirm the `--help` text and the exact
  `export …` lines it prints.
- **Files outside the Files block:** none.
- **Fix round 1:** CHANGELOG footer gains `[1.1.0]` → compare
  `v1.0.1...v1.1.0` and `[Unreleased]` now compares `v1.1.0...HEAD`; the
  `2026-10-28` release date is final (owner-confirmed, placeholder
  wording removed); README "Running from source" uses `npm ci`.

## v1.1 hotfix 1.1.1 (out of plan): `npx babelgate` crashes on start

- **Bug (owner-reproduced on published 1.1.0):** `cd ~ && npx -y
  babelgate@1.1.0 --help` crashes with `Error: unable to determine
  transport target for "pino-pretty"` thrown from
  `dist/utils/logger.js`. Separately, dotenv 17's
  `◇ injected env (0) from .env // tip: …` banner prints on every start
  and pollutes the CLI's `export` lines.
- **Cause:** `src/utils/logger.ts` configured the `pino-pretty`
  transport whenever `NODE_ENV !== "production"`, but `pino-pretty` is a
  devDependency — absent in an npm/npx install. The Docker image was
  unaffected (`NODE_ENV=production`).
- **Why CI missed it:** every check ran with devDependencies installed,
  so `pino-pretty` always resolved and the packed tarball was never
  exercised the way `npx` runs it (no devDeps, `NODE_ENV` unset).
- **Fix (owner-approved scope, no dependency change):**
  `loggerOptions(env, canResolve)` exported from `src/utils/logger.ts`;
  the pretty transport is used only when not production AND
  `require.resolve("pino-pretty")` succeeds (try/catch), otherwise plain
  JSON to stdout. Level logic unchanged. `dotenv.config({ quiet: true })`
  in `src/config/env-config.ts` (dotenv 17 `quiet`, verified in
  node_modules).
- **Smoke test:** `scripts/ci/smoke-pack.sh` builds, `npm pack`s,
  installs the tarball with `--omit=dev` into a clean dir outside the
  repo, and runs the bin the way npx does: `--help` must exit 0 with the
  usage line and no `injected env`; a real start must answer `/health`
  and print the `export ANTHROPIC_BASE_URL=…` line, also banner-free.
  Wired into `scripts/check.sh` full mode after `npm run build`, so CI
  (which runs `./scripts/check.sh`) covers it.
- **Publish guard (publishing-config change, owner approval flagged in
  the PR):** `prepublishOnly: ./scripts/check.sh` in package.json.
- **Renumbering:** the plan's Task 18 release becomes `1.1.2` (the plan
  file itself is not edited).
- **Files changed (all outside any plan Files block):**
  `src/utils/logger.ts`, `src/utils/logger.test.ts`,
  `src/config/env-config.ts`, `scripts/ci/smoke-pack.sh` (new),
  `scripts/check.sh`, `package.json`, `package-lock.json`,
  `CHANGELOG.md`, `docs/decisions.md`.
- **Owner release steps after merge:** tag `v1.1.1`, `npm publish
  --access public` (prepublishOnly runs the full check + smoke),
  `npm deprecate babelgate@1.1.0`, verify `npx -y babelgate@1.1.1
  --help`. Suggested (not committed — the conductor app has no
  Workflows permission): add a `./scripts/ci/smoke-pack.sh` step before
  the docker job's build in `.github/workflows/release.yml`.

## v1.1 Task 17: full 16-pair streaming × tools matrix

- **Change:** `tests/integration/stream-pairs.test.ts` replaces
  `LAUNCH_PAIRS` with `ALL_PAIRS` (all 16 ordered provider pairs) ×
  {text, tool_call, parallel_tool_calls, after_tool_result} ×
  {stream, non-stream} — 128 cells, all green.
- **Adapter fixes needed: none.** Every cell passed against the
  adapters as shipped on main; the only changes were to the test
  harness itself, which previously supported just the openai and
  anthropic source dialects.
- **Harness additions (same file, inside the Files block):**
  - Source dialects for `ollama` and `gemini`: request builders
    (`toolResultRequest`, `clientRequest`), and `clientJsonReply` /
    `clientStreamReply` parsers (Ollama NDJSON; Gemini SSE parts).
  - Ollama has no `requests.tools` fixture; its `tools[]` is
    OpenAI-shaped (spec §3.4), so the test reuses the recorded OpenAI
    array wrapped in an Ollama-dialect request.
  - Gemini clients request `:streamGenerateContent?alt=sse` — without
    `alt=sse` the wire form is a streamed JSON array (spec §3.3), and
    the matrix asserts the SSE form.
  - `assertToolsForwarded` reads Gemini `tools[].functionDeclarations`;
    `assertToolResultForwarded` reads Gemini `contents[].parts`
    (`functionCall` / `functionResponse`, string results wrapped as
    `{ "content": "<string>" }` per spec §3.4) and Anthropic `tool_use`
    content blocks, and now also pins `tool_result.tool_use_id` to the
    client's call id for the anthropic target.
- **Assertion semantics resolved by the oracle and spec §3.4:**
  - Call ids are not compared for cells touching Gemini: the recorded
    Gemini upstream sends none, so canonical ids are generated and can
    differ from the oracle's; and the Gemini client side treats
    `functionCall.id` as optional on the wire (the Gemini API
    documents `FunctionCall.id` as optional). For cells touching
    Gemini, names/args/count still compare exactly; client-id
    distinctness still asserted wherever the source dialect carries
    ids.
  - `parallel_tool_calls` count is pinned per oracle:
    `PARALLEL_CALL_COUNTS` — openai/anthropic/ollama recorded 2 calls,
    gemini recorded 3 (`sum` × 3). The fixture is authoritative.
- **Follow-up:** the Gemini non-stream encoder (`functionCallPart` in
  `src/transformers/adapters/gemini.tools.ts`) omits `functionCall.id`
  while the stream encoder (`gemini.stream.ts`) sends it; the Gemini
  API documents the field as optional. Aligning the two encoders is a
  follow-up, out of scope for this task.

## v1.1 Task 18: Gemini and Ollama sources live; release 1.1.2

- **Renumbering:** the plan names this release `1.1.1`, but `1.1.1` was
  already shipped as an out-of-plan hotfix (see "v1.1 hotfix 1.1.1"),
  so the Task 18 release is `1.1.2` — `package.json`,
  `package-lock.json` (root entries only) and `CHANGELOG.md`
  (`## [1.1.2]`, compare link added).
- **Live suite:** `tests/live/stream.live.test.ts` sources extended to
  `gemini` and `ollama` for the stream-text and tool-definitions cases,
  against the same targets (local Ollama always; OpenRouter when
  `OPENROUTER_API_KEY` is set). Gemini streams SSE
  (`:streamGenerateContent?alt=sse`); the Ollama source streams NDJSON,
  so the suite gained an NDJSON parse path (`parseWireEvents` wraps each
  line as a data-only event; `postRaw` collects the
  `application/x-ndjson` body, which supertest leaves out of `res.text`).
- **Ollama forced tool call: not expressible.** Ollama's chat API has
  no tool-choice field (`docs/api.md`), so the forced-tool-call case is
  filtered out for the ollama source rather than faked — its tool case
  only asserts definitions are accepted with a well-formed reply, which
  is what the plan asks. Gemini's forced case uses
  `toolConfig.functionCallingConfig.mode: "ANY"` and asserts a
  `functionCall` part with a `name` and an `args` object.
- **Assertion shape:** per-source helpers (`tokenBudget`, `askForWeather`)
  emit each dialect's own field names (`generationConfig.maxOutputTokens`,
  `options.num_predict`, `contents[].parts`); the openai/anthropic cases
  keep their existing assertions unchanged.
- **Files outside the Files block:** `docs/decisions.md` (this entry —
  the task requires recording the deviation here).
- **Owner release steps after merge:** tag `v1.1.2`, `npm publish
  --access public`, verify `npx -y babelgate@1.1.2 --help`.

### Fix round 1 — Ollama-source `stream` default (owner decision 2026-10-29, ships in 1.1.2)

- **Owner decision:** fix the Ollama-source `stream` default in this
  PR. Ollama's `POST /api/chat` streams NDJSON when `stream` is omitted
  (api.md: "stream: if false the response will be returned as a single
  response object"; default true); babelgate's Ollama source only
  streamed on an explicit `stream: true`.
- **Change:** in `toCanonicalRequest`
  (`src/transformers/adapters/ollama.adapter.ts`),
  `request.stream !== false` now maps to canonical `stream: true` —
  omitted or `true` streams, explicit `false` is the only opt-out.
  Nothing else moved: `proxy.service.ts` already streams on canonical
  `stream === true`; `fromCanonicalRequest` still sends an explicit
  `stream` value upstream; no route changes and no provider-pair
  branch.
- **New tests:** `ollama.adapter.test.ts` — omitted `stream` →
  canonical `stream === true`, explicit `stream: false` → no canonical
  stream (the `stream: true` case was already covered).
  `tests/integration/stream.test.ts` — `POST /api/chat` with no
  `stream` field → 200 `application/x-ndjson` ending in `done: true`;
  with `stream: false` → a single `application/json` object.
- **Test expectations updated for the new default** — each adds an
  explicit `stream: false` to keep the single-object path it asserts;
  no assertion was weakened:
  - `tests/integration/pairs.test.ts` — the pair matrix sends
    `{...requests.basic, stream: false}` for the ollama source (was
    `requests.basic` with no flag → previously a JSON object, now a
    stream).
  - `tests/integration/proxy.test.ts` — "Ollama → OpenAI transforms
    ollama request and returns ollama response" sends
    `{...requests.basic, stream: false}` (was `requests.basic`).
  - `tests/integration/stream-pairs.test.ts` — `clientRequest` sends
    `stream: false` for ollama-source non-streaming cells (was: flag
    omitted for all non-streaming cells).
  - `tests/integration/errors.test.ts` — `SOURCE_CALL.ollama` carries
    `stream: false` (was `requests.basic`), keeping the error matrix
    on the non-streaming upstream path it asserts.
  - `tests/live/chat.live.test.ts` — the ollama-source chat round
    trip sends `stream: false` (was: no flag).
  - `tests/live/stream.live.test.ts` — "accepts tool definitions"
    sends `stream: false` for the ollama source (was: no flag);
    "streams text" now *omits* `stream` for the ollama source so the
    live run exercises the documented default, and its stale comment
    was replaced with the api.md cite.
  - `tests/live/errors.live.test.ts` — deliberately unchanged: the
    unknown-model case asserts a 404 in the source dialect, which the
    stream and non-stream paths render identically.
- **Contract snapshot pending owner action:** the four ollama
  request-fixture snapshots in
  `tests/contracts/__snapshots__/fixtures.test.ts.snap` (`basic`,
  `system`, `params`, `multimodal` → canonical) each gain
  `"stream": true`. Only the owner may touch fixtures/snapshots or run
  `vitest -u`; reported via the fix-round STOP for the owner to
  regenerate.
- **Files outside the Files block (fix round):**
  `src/transformers/adapters/ollama.adapter.ts`,
  `src/transformers/adapters/ollama.adapter.test.ts`,
  `tests/integration/stream.test.ts`,
  `tests/integration/pairs.test.ts`,
  `tests/integration/proxy.test.ts`,
  `tests/integration/stream-pairs.test.ts`,
  `tests/integration/errors.test.ts`,
  `tests/live/chat.live.test.ts`,
  `README.md` and `docs/recipes/openai-sdk.md` (stale description of
  the old Ollama-source default),
  `docs/decisions.md` (this entry).
  (`tests/live/stream.live.test.ts` and `CHANGELOG.md` are inside the
  task's Files block.)

## v1.1 follow-ups

### Live anthropic-source chat budget 16 → 512 (2026-10-29)

- `chatCall` in `tests/live/live.helpers.ts` now sends
  `max_tokens: 512` for the `anthropic` source (was 16). The live
  `anthropic → anthropic` chat case intermittently returned empty
  text: claude-haiku-5-5 can spend a 16-token budget on reasoning
  before it emits a text block. This mirrors the existing 512-token
  carve-out `chat.live.test.ts` already applies when the ollama
  target runs a thinking model, and `stream.live.test.ts` applies
  for ollama/openrouter targets.
- Anthropic source only: openai/gemini/ollama defaults stay at 16,
  no assertions changed, and caller-provided `extra` still merges
  over the default. Owner-approved 2026-10-29.

### Gemini non-stream response encoder sends `functionCall.id`
(owner-approved fix for the Task 17 follow-up, 2026-10-29)

- **Resolved:** the Task 17 follow-up above is done. The non-stream
  response encoder (`fromCanonicalResponse` in
  `src/transformers/adapters/gemini.adapter.ts`) now emits
  `functionCall{id, name, args}` — the same shape the stream encoder
  sends — so a Gemini client that echoes `functionResponse.id` back
  gets ids from both streaming and non-streaming replies.
  `FunctionCall.id` is a documented optional field
  (ai.google.dev/api/generate-content#FunctionCall: "If populated,
  the client to execute the functionCall and return the response
  with the matching id").
- **How:** `functionCallPart` in `gemini.tools.ts` gained an
  `{ includeId }` option (default off). `fromCanonicalResponse`
  passes `includeId: true`; `fromCanonicalRequest` keeps the
  default, so the canonical → Gemini *request* wire shape is
  byte-identical — request snapshots unchanged.
- **New tests:** `gemini.adapter.test.ts` — the non-stream response
  encoder carries `functionCall.id`, and the request encoder still
  omits it.
- **Files outside the Files block:**
  `tests/integration/stream-pairs.test.ts` (comment updates only —
  the header, the Gemini `clientJsonReply` comment and the ids-on-
  wire note described the old one-sided encoder; no assertion
  changed), `docs/decisions.md` (this entry).

### README demo GIF (2026-10-29)

- `docs/assets/demo.gif` (32 s, ~229 KB) is now embedded at the top of
  README.md. It shows `claude -p` (Claude Code print mode, like the
  release gate) fixing the gate fixture's failing `sum` test — file
  edit plus `npm test` — through `npx babelgate --preset claude-code`
  running on OpenRouter's free `poolside/laguna-s-2.1:free` model.
- The model's thinking time is cut from the recording (the tape waits
  off-camera for the answer), which the README caption states.
- Re-record with `OPENROUTER_API_KEY=... scripts/demo/record-demo.sh`
  (VHS tape: `scripts/demo/demo.tape`); the script resolves the repo
  root via `git rev-parse --show-toplevel`, so it works from any clone.

## Agent tooling and planning docs renamed llm-proxy → babelgate (2026-10-29)

- **Renamed paths (git mv):** `.devin/skills/llm-proxy-task/` → `.devin/skills/babelgate-task/`,
  `.devin/skills/llm-proxy-review/` → `.devin/skills/babelgate-review/`,
  `scripts/llm-proxy-loop.sh` → `scripts/babelgate-loop.sh`,
  `docs/superpowers/plans/2026-10-2{6,7,9}-llm-proxy-v{1.0.1,1.1,1.2}-plan.md` → the same names with
  `babelgate`, `docs/superpowers/specs/2026-10-26-llm-proxy-roadmap-design.md` →
  `2026-10-26-babelgate-roadmap-design.md`, `docs/superpowers/specs/2026-10-26-llm-proxy-v1.0.1-design.md`
  → `2026-10-26-babelgate-v1.0.1-design.md`. The skills' plan mapping is now
  `babelgate-<version>-plan`; invocations are `/babelgate-task` and `/babelgate-review`; the
  `.claude/settings.json` allow rule is `Bash(scripts/babelgate-loop.sh:*)`.
- **`llm-proxy` → `babelgate` in text repo-wide** — including forward-looking names (`@babelgate/team`,
  `babelgate-team`, `babelgate.yaml` in the roadmap spec) and spec/plan titles.
- **Exceptions kept** (changing them would make the statement false or rewrite history):
  `docs/decisions.md` entries before this one and `CHANGELOG.md`; lines that describe the rename itself
  or the npm-name collision (v1.1 spec "renamed from `llm-proxy`", F8 "The npm name `llm-proxy` belongs
  to another project", the v1.1 plan's Task 1 rename-scope lines and header note, the roadmap spec's open
  question about "llm-proxy" being a crowded name); the v1.0.1 plan's historical task text (NOTICE name,
  `github.com/dorrabbkhan/llm-proxy`, the `does-not-exist-llm-proxy` model name in its live-test step).
- **Local paths:** the conductor's prompt/output directory is now `~/babelgate-conductor` and the local
  clone path `~/babelgate` (CLAUDE.md, CONDUCTOR-SETUP.md, `.claude/commands/`, `devin.sh`).
- **`tests/live/errors.live.test.ts`:** `UNKNOWN_MODEL` input `'does-not-exist-llm-proxy'` →
  `'does-not-exist-babelgate'` — an input model name, not an expected value; nothing else in the file changed.
- **Conductor/Devin setup fixes (v1.2 session problems):**
  - `scripts/conductor/devin.sh`: output dir `~/babelgate-conductor`; the default repo root is resolved
    from the script's own location (`git -C "$(dirname "$0")" rev-parse --show-toplevel`), not a
    hard-coded home path.
  - `scripts/conductor/notify.sh`: notification title "babelgate conductor".
  - `scripts/babelgate-loop.sh`: state dir `babelgate-loop`; falls back to `${TMPDIR:-/tmp}` when
    `${XDG_RUNTIME_DIR}` is unset or not writable (Devin's read-only XDG_RUNTIME_DIR killed every v1.2 watch).
  - `.claude/commands/{conduct,run-plan,inbox}.md`: this Claude Code version numbers command arguments
    from `$0`; each file gained an `Arguments as typed: $ARGUMENTS` line and updated argument hints.
  - `.devin/skills/babelgate-review/SKILL.md`: step 6 notes the review session runs as the
    babelgate-conductor GitHub App (not the owner's account); step 4 allows `package-lock.json` only when
    the task's Files block lists `package.json`/`package-lock.json`, else a lockfile change FAILs.
  - `docs/conductor/standing-notes.md` gained a Devin-sandbox paragraph (npm cache EROFS, XDG_RUNTIME_DIR).
  - Added `docs/conductor/notes/v1.2/task{2,4,5}.md` per-task conductor notes.

## v1.2 Task 1: behaviour-neutral refactor — registry, explicit inputs, split proxy.service

- **Moved code** (spec §3.1, G7): `buildAuthHeaders` → `authHeaders(entry)` in
  `src/routing/registry.ts`; the glob matcher (`globToRegExp` → `globMatch`) →
  `src/routing/rules.ts` (re-exported from `utils/model-map.ts` so existing
  imports keep working); the non-streaming chat body → `src/services/chat.service.ts`;
  the streaming body → `src/services/chat-stream.service.ts`; the model-list body →
  `src/services/models.service.ts`. `proxy.service.ts` keeps the provider-path
  pre-check, route match on `config.sourceApi`, the Gemini unsupported-method check,
  decode + schema validation, the empty-path-model check, `count_tokens`, `planRoute`
  and dispatch.
- **`toClientFacing` moved to `src/services/attempt-targets.ts`**, not kept in
  `proxy.service.ts`: all three services need it and keeping it in the entry file
  would have created a `proxy.service` ↔ services import cycle. `attempt-targets.ts`
  also gained `canonicalForTarget` — the canonical copy carrying the routed model
  and the target entry's `contextWindow` (spec §3.1: unset → field unset; the
  decoded request is never mutated).
- **`Config` → `GatewayConfig` / `EnvConfig`** (spec §3.1): `getConfig()` returns
  `GatewayConfig`; `loadConfig()` returns `EnvConfig`, which keeps the v1.1 fields
  (`targetApi`, `targetApiKey`, `targetBaseUrl`, `modelMap`, `targetContextWindow`)
  so `env-config.test.ts` is untouched. **`sourceApi` stays on `GatewayConfig` as a
  temporary field** — Task 2 removes it for request-path detection.
- **Env-only mode** builds one `ProviderEntry` named after `TARGET_API` (also
  `routing.defaultProvider`); `MODEL_MAP` entries become ordered `RouteRule`s to
  it — identical resolution order to v1.1's `applyModelMap`.
- **Scope limits kept:** `planRoute` implements spec §3.3 steps 3–4 only (rule
  match, then default — explicit/alias/`when`/`fallback` are Task 3);
  `attemptTargets` tries `plan.targets[0]` only and rethrows (Task 5 adds
  fallback); the model list serves only the default provider (Task 6 merges).
- `index.ts` startup log is `{port, defaultProvider, providers: names()}` — the
  API key is never logged.
- **Files outside the Files block:** none.

## v1.2 Task 2: detectSource — all formats on one port, SOURCE_API retired

- **Step 0 evidence (spec §3.2):** `anthropic-version` is unconditional, not
  tied to auth or endpoint — `@anthropic-ai/sdk@0.132.1`
  `node_modules/@anthropic-ai/sdk/client.js:842` puts
  `'anthropic-version': '2023-06-01'` in the default header object every
  request builds. Claude Code's gateway docs likewise list
  `anthropic-version` among the headers Claude Code includes on API
  requests (https://code.claude.com/docs/en/llm-gateway-protocol, read
  2026-10-30). The spec's `x-api-key`/`Authorization` tie-break is
  therefore not needed; `GET /v1/models` resolves to anthropic iff the
  header is present.
- **`detectSource(method, path, headers)`** in `src/routing/detect-source.ts`
  is pure — it scans `PROVIDER_ROUTES` for every provider matching
  method + pathPrefix; `anthropic-version` selects anthropic only among
  matches, otherwise the first match wins. `detectSourceMiddleware()`
  replaced `resolveSource()` at the same mount point (before the body
  parser and auth) so their errors render in the detected dialect.
  `ProxyRequestOptions.source?: Provider` carries it to `proxyRequest`;
  undefined → null → 404. `GatewayConfig.sourceApi` removed.
- **`SOURCE_API` retired:** `loadConfig()` requires only `TARGET_API`
  (message now `"TARGET_API environment variable is required"`); a set
  `SOURCE_API` is never validated — `INVALID_API` included — and lands
  in `EnvConfig.deprecatedEnv`; `getConfig()` logs the spec's one
  `warn` line. `cli.ts` presets no longer emit `SOURCE_API`; export
  lines come straight from `args.preset` (`presetForSource` deleted).
- **Named expected-value changes (owner approval), old → new:**
  - `claude-code.test.ts` `"count_tokens on a non-anthropic source is 404"`
    → `"count_tokens is answered whatever the configured target"`: 404 →
    200 + `x-babelgate-token-estimate: true`, still no upstream call.
  - `env-config.test.ts` required-vars message:
    `"SOURCE_API and TARGET_API environment variables are required"` →
    `"TARGET_API environment variable is required"`.
  - `env-config.test.ts` `"should throw error when SOURCE_API is not a
    valid provider"` → `"SOURCE_API is ignored and reported as
    deprecated"`: throw → success, `deprecatedEnv` `["SOURCE_API"]`.
  - `env-config.test.ts`: five `expect(config.sourceApi)` lines removed.
  - `cli.test.ts`: `SOURCE_API` dropped from the two `presetEnv` expected
    objects; override list `["SOURCE_API","TARGET_API","MODEL_MAP",
    "UPSTREAM_TIMEOUT_MS"]` → `["TARGET_API","MODEL_MAP",
    "UPSTREAM_TIMEOUT_MS"]`.
  - `resolve-source.test.ts` deleted; its four path cases carried into
    `detect-source.test.ts`; `"never throws when the config is broken"`
    dropped (detectSource reads no config).
- **Approved by the owner, conductor escalation option A:**
  - `pairs.test.ts` GET /models: `source === "anthropic"` now sends
    `anthropic-version: 2023-06-01` (assertions unchanged).
  - `pairs.test.ts` `"returns 404 when path does not match source
    provider"` deleted (spec §3.8: other formats' paths now answer; 404
    coverage stays in `"returns 404 for GET chat paths"` and
    `proxy.test.ts` `"returns 404 for unmapped paths"`).
  - `proxy.service.test.ts`: each `proxyRequest()` call passes
    `{ source: "<provider>" }` matching its path; assertions unchanged;
    dead `process.env.SOURCE_API` lines removed.
- **Approved by the owner, conductor escalation option A
  (2026-10-30):** `detectSource` reads no config, so errors on
  `/v1/chat/completions` now render in the openai dialect (spec §3.2).
  - `src/app.test.ts` `"returns 413 for bodies over MAX_BODY_SIZE"`:
    `error.code` `"PAYLOAD_TOO_LARGE"` → `"request_too_large"`.
  - `src/app.test.ts` `"rejects proxy requests with 401 when key is set
    and missing/wrong"`: `error.code` `"UNAUTHORIZED"` →
    `"authentication"`. No other assertion in that file changes.
- **Deviation from spec §3.2 tie-break (owner-requested 2026-10-30):**
  `GET /v1/models` resolves to anthropic when `anthropic-version` OR
  `x-api-key` is present (header names case-insensitive, any value);
  the spec's fallback "`x-api-key` present AND `Authorization` absent
  → anthropic" becomes "`x-api-key` present → anthropic", because
  Claude Code ≥ 2.1.248 sends both credential headers on discovery.
  Evidence: the Claude Code gateway docs ("Model discovery → Request
  and response",
  https://code.claude.com/docs/en/llm-gateway-protocol, read
  2026-10-30) list only `Authorization`, `x-api-key` and
  `ANTHROPIC_CUSTOM_HEADERS` on `GET /v1/models?limit=1000` — no
  `anthropic-version` — while OpenAI SDKs authenticate with
  `Authorization: Bearer` only.
- **Files outside the Files block:** `tests/integration/pairs.test.ts`,
  `src/services/proxy.service.test.ts` and `src/app.test.ts` (the
  owner-approved adaptations above); `.env.example` and
  `src/transformers/adapters/index.ts` (comment-only) — both
  owner-requested 2026-10-30.

## v1.2 Task 3: rules and the full `planRoute`

- **Spec §3.3 complete:** `planRoute` now resolves explicit
  `provider/model` → alias → rules (`match` + `when`) → default.
  `parseTarget` (in `rules.ts` per the file map) splits on the first
  `/` only, and only when the prefix is a registered provider name —
  case-sensitive — and the rest is non-empty, so model names may carry
  `/` and `:`. `targets` is the matched target plus its `fallback`
  list in file order; explicit, alias and default plans carry one
  target. `proxy.service` computes `estimateInputTokens` once, shares
  it between `count_tokens` and routing, and passes
  `new Set(registry.names())` as the provider-name set.
- **`applyModelMap` kept** (the plan's Files block says remove it):
  removing it would delete three existing assertions in
  `model-map.test.ts`, which Step 5 says stay unchanged; owner
  decision, conductor escalation option 2A (2026-10-31): keep it for
  now; remove it in a later cleanup task, where the owner approves
  deleting the three `model-map.test.ts` cases. Nothing routes
  through it —
  `MODEL_MAP` becomes `RouteRule`s in `env-config` (Task 1) and
  `planRoute` matches on them directly. `git diff main --
  src/utils/model-map.test.ts` is empty.
- **Review Focus 4 pinned on the plan's exact path:** the named test
  uses `POST /v1beta/models/ollama%2Fqwen3:generateContent`
  (non-streaming), asserting the Ollama upstream receives `qwen3` and
  the reply's `modelVersion` is `ollama/qwen3`. A streamed twin
  (`:streamGenerateContent`, JSON-array elements) is kept as an extra
  case.
- **Files outside the Files block:** `src/transformers/adapters/
  gemini.adapter.ts` — `fromCanonicalResponse` now emits
  `modelVersion: response.model`. The named Review Focus 4 test can
  only observe the reply model through `modelVersion`, the field the
  real API returns on every `GenerateContentResponse` and our stream
  encoder already sends on every element; the non-streaming encoder
  simply lacked it. Round-trip and fixture contracts are unaffected
  (`toCanonicalResponse` ignores the field). Approved by the owner,
  conductor escalation option 1A (2026-10-31): a named exception to
  the Global Constraint 'adapters do not change' — the Review Focus 4
  test needs the reply model, and `modelVersion` is the documented
  output field (Google `GenerateContentResponse`; recorded fixture
  `tests/fixtures/streams/gemini/max_tokens.nonstreaming.json`).

## v1.2 Task 4: YAML config, schema, discovery, routing table

- **`yaml@2.9.1`** added via `npm install yaml@^2` (latest 2.x, zero
  dependencies — D6, owner gate). `package-lock.json` also records the
  root `"bin": {"babelgate": "dist/cli.js"}` entry — npm's own
  normalization of the existing package.json field, not a hand edit.
- **`setConfigPath` lives in `env-config.ts`**, not `yaml-config.ts`:
  the Produces block does not pin a file, it feeds `getConfig()`'s
  discovery, and `resetConfig()` clears it alongside `_config` so tests
  start clean. `resolveConfigPath`, `loadYamlConfig` and
  `ignoredEnvKeys` are in `yaml-config.ts` per the file map.
- **`getConfig()` warns only when `ignoredEnvKeys` is non-empty**
  (spec: "one startup warn naming those that are set" — nothing set,
  nothing to name), same pattern as the `deprecatedEnv` warn.
- **Duplicate keys surface through `parseDocument({uniqueKeys: true})`**
  `doc.errors`; the message embeds the offending line, so
  `duplicate-map-key.yaml` and `duplicate-alias.yaml` both name their
  key (`default`, `fast`). The spec's "duplicate alias" is therefore a
  YAML-level error, not a separate registry check.
- **Extra fixtures beyond the plan's pinned list** (new files only,
  nothing existing touched): `missing-key-field.yaml` covers the spec
  §3.5 schema rule "`api_key_env` required unless type is ollama" — the
  plan's eight invalid files map the six named startup errors but not
  this schema violation; `discovery/babelgate.yaml` gives the
  `./babelgate.yaml` discovery step a `cwd` to find.
- **Files outside the Files block:** none.

## v1.2 Task 5: Fallbacks, `x-babelgate-*` headers, route log line

- **`Hop` moved to `routing/route-log.ts`** and re-exported from
  `services/attempt-targets.ts`: the spec §3.4 `hops` shape belongs to
  the log record, and keeping it in routing avoids a
  routing → services import (`route-log.ts` would otherwise import a
  service for one type). `AttemptResult.hops` and the existing tests
  are unaffected.
- **`ctx.hops` out-param on `attemptTargets`**: the plan pins hops in
  the route log record but `AttemptResult` exists only on success —
  the loop fills a caller-provided array (the same array it returns),
  so services can emit the §3.4 record on failure too ("one info line
  per chat request": the failing record has `hops` and no `winner`,
  which is why `winner?` is optional).
- **Failed-hop `status`** is `err.upstreamStatus` on `http_error`
  hops only — timeouts and transport failures carry no status, per the
  record's `status?` field.
- **A pre-upstream failure is not a hop**: `hopOutcome` returns
  `undefined` for non-`UpstreamError`s (validation/transform/encode),
  so the attempt is not recorded in `hops` — the request never left.
  It still fails immediately with `x-babelgate-attempts` per the
  plan's "else, and on the last target" rule.
- **`responseHeaders` is attached only to `ProxyError`s**: a non-proxy
  error thrown out of the loop keeps no headers (the client-abort path
  rethrows before that point anyway, per the plan's signal-first
  ordering).
- **Gateway tests write a temp YAML** at
  `tests/integration/.tmp-gateway.yaml` (deleted in `afterEach`):
  `tests/fixtures/config/` is the fixture oracle and the Files block
  names no new fixtures; `BABELGATE_CONFIG` + `resetConfig()` load it.
- **`401 → no fallback` expects client status 502**, not 401: the §3.3
  credentials rule renders "upstream rejected the proxy's key" as
  `upstream`/502 in every client dialect — a 401 would wrongly blame
  the client's own key. The pinned assertions (one attempt, header) are
  unchanged.
- **Files outside the Files block:** `src/services/proxy.service.test.ts`
  — the "logs token usage metrics on completion" case asserted the
  pre-§3.4 "Request completed" fields (`targetApi`, `model`,
  `upstreamDurationMs`), which the spec-pinned `RouteLogRecord`
  replaces; the assertion now checks the same metrics in the new
  shape. No expected value loosened — `inputTokens`/`outputTokens`/
  `finishReason` assertions are identical.

## v1.2 Task 6: Merged model list and cache

- **Merge order follows spec §3.6 verbatim:** aliases as bare names,
  then the default provider's models bare, then every other
  provider's models as `<provider>/<model>` — ids prefixed on the
  canonical list before the single source-adapter encode, so Gemini
  clients see `models/<provider>/<model>`. First occurrence wins on a
  duplicate id (checked on the final emitted id). Glob routes are
  never listed.
- **`createModelListCache(ttlMs = 60_000, now = Date.now)`** returns a
  `{get, set, clear}` cache keyed on provider name + base URL;
  `proxyModelList` uses a module-level instance, `resetModelListCache()`
  clears it for tests. Fresh strictly inside the TTL: an entry fetched
  at t is served at t + 59 999 and refetched at t + 60 000. Successful
  fetches only — a rejected fetch leaves no entry, so the next call
  refetches. No `NODE_ENV` special-casing and no test bypass.
- **All-providers-fail returns the default provider's error through
  the same `toClientFacing` path as v1.1** — same status and dialect,
  no `x-babelgate-partial` header. With one provider and no aliases
  the merged list is byte-identical to the v1.1 list (verified by the
  unchanged existing model-list tests).
- **Failed-provider warn line** carries `{requestId, provider,
  outcome, status?}` — `outcome` via `hopOutcome` ("http_error" /
  "timeout" / "transport", "error" for a non-upstream failure) and
  `status` only for HTTP errors. No keys, no body text.
- **`tests/mocks/upstreams.ts` needed no changes**: Task 5 already
  added `GET ${OPENAI2_BASE_URL}/v1/models`, which the merged-list
  tests reuse as the second OpenAI-type provider.
- **Existing test file change**: `tests/integration/gateway.test.ts`
  (inside this task's Files block) gained a `resetModelListCache()`
  call in its file-level `beforeEach` — the module-level cache would
  otherwise let a list cached by one case mask a later case's dead
  provider. No existing assertion or expected value changed.
- **`src/services/proxy.service.ts`, listed under Modify in the Files
  block, needed no change**: `proxyModelList`'s signature and the
  dispatch were already what §3.6 requires.
- **Files outside the Files block:** none.

## v1.2 Task 7: CLI --config flag and endpoints block

- **"With a config file loaded" (§3.7) means any resolved file, not only
  `--config`**: `main` runs `resolveConfigPath(args.config, process.env,
  process.cwd())` before `startServer`, so `--target`, `--model` and
  `--base-url` also fail ("defined by the config file", exit 1) when the
  file comes from `BABELGATE_CONFIG` or `./babelgate.yaml`. `parseCliArgs`
  covers the explicit `--config` combination only, since it is pure.
- **Config mode is a parameter, not a global**: `presetEnv` and
  `overriddenKeys` take a third optional `configMode` argument (default
  `false`, so every existing call keeps its signature and behaviour).
  With `configMode` the only flag that maps to env is `--port` → `PORT`
  (§3.5 applies `PORT` with YAML); presets set no routing env and the
  "no --model given" hint is suppressed.
- **With a config file, `--preset` only selects the export lines**
  (§3.7): `clientInstructions` is unchanged; in config mode the preset
  contributes no env values, and `main` still prints its `export` lines
  after start. Without a preset, `main` prints `endpointLines(port)` then
  `formatRoutingTable(getConfig())` on stdout — `index.ts` also logs the
  table via pino, so it appears twice; intentional per §3.5/§3.7.
- **Files outside the Files block:** `docs/conductor/notes/v1.2/task8.md`
  (conductor note, added at the owner's request on PR #50): the Gemini
  endpoint line `…/v1beta` is checked against the Gemini SDK docs in
  Task 8 and changed only if the SDKs append the API version themselves.

## v1.2 Task 8: Examples, recipes, README, GPU runbook

- **Gemini endpoint line changed to `http://localhost:<port>`** (owner
  decision, 2026-11-02, PR #50 / `docs/conductor/notes/v1.2/task8.md`):
  the check confirmed every current Gemini SDK appends the API version
  to its base URL itself, so the §3.7 `…/v1beta` line would produce
  `…/v1beta/v1beta/…` → 404 when pasted into an SDK. Evidence (checked
  2026-11-02):
  - `@google/genai` JS (SDK_VERSION 2.32.0):
    `src/_api_client.ts` `getRequestUrlInternal` builds
    `[baseUrl, apiVersion].join('/')` and `constructUrl` appends the
    path — `apiVersion` defaults to `v1beta` for the Gemini API
    (`GOOGLE_AI_API_DEFAULT_VERSION`), so `httpOptions.baseUrl` must be
    the bare host. `models.generateContent` then calls
    `POST <baseUrl>/v1beta/models/<model>:generateContent`.
    <https://github.com/googleapis/js-genai/blob/main/src/_api_client.ts>
  - `@google/generative-ai` 0.24.x (the older SDK, in
    `node_modules`): `url = ${baseUrl}/${apiVersion}/${model}:${task}`,
    same composition.
  - `google-genai` Python: `_api_client.py::_build_request` joins
    `base_url` with `f'{api_version}/{path}'` (`api_version='v1beta'`
    for the Gemini API) whenever `api_key` is set. Caveat: a custom
    `base_url` *without* `api_key` is used verbatim (no path appended —
    the documented gateway-proxy mode; `force_append_path` in
    python-genai PR #1701). babelgate docs always show a key, so the
    versioned path is appended.
    <https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py>
- **`src/cli.ts` and `src/cli.test.ts` are outside Task 8's Files
  block**, changed per that owner decision: `endpointLines` Gemini line
  `…/v1beta` → bare port, and the `"endpoint lines"` test's expected
  string updated (still an exact `toEqual` match). This departs from
  spec §3.7's literal `Gemini …/v1beta` wording; the spec itself is
  unchanged per the owner's instruction.
- **`examples/multi-provider.yaml` is the spec §3.9 "Ollama + OpenRouter
  + Anthropic + aliases" shape** — two aliases (`fast`, `smart`) and
  three routes so each provider is reachable by glob as well as
  explicitly. `openrouter` `base_url` is `https://openrouter.ai/api`
  (not `/api/v1`): babelgate joins `base_url` + `/v1/…`, matching the
  gate script's comment and `docs/recipes/claude-code.md`.
- **Provider table rows labelled "live-tested"** are OpenRouter (the
  v1.1/v1.2 release gate ran `qwen/qwen3-coder` through it) and Ollama
  (launch target, nightly live suite); all others are "from provider
  docs" with the doc URL and the 2026-11-02 check date, per the plan.
- **README edits beyond the new section** are the lines the v1.2
  behaviour made false: `SOURCE_API` marked deprecated, env-only rows
  tagged "env-only", the "one pair per instance" bullet replaced by the
  §2.2 limitations (no hot reload, no overall deadline), the
  source-detection step rewritten, and the CLI usage block synced to
  `--help`.
- **Files outside the Files block:** `src/cli.ts`, `src/cli.test.ts`
  (owner decision above). Everything else is inside it.

## v1.2 Task 9: Live-suite gateway cases

- **`useYamlConfig(yaml)` in `tests/live/live.helpers.ts`** writes the
  YAML to a `mkdtemp` dir, sets `BABELGATE_CONFIG` and calls
  `resetConfig()`; the returned cleanup restores the previous
  `BABELGATE_CONFIG`, resets the config cache again and removes the
  temp dir. `BABELGATE_CONFIG` (not `--config`/`setConfigPath`) drives
  discovery so the in-process `app` picks the file up on the next
  request — a live YAML overrides every `useTarget()` env.
- **The OpenRouter case is wrapped in
  `if (process.env.OPENROUTER_API_KEY)`**, matching the live suite's
  conditional-inclusion convention (`liveTargets()`) — no `.skip`,
  `skipIf` or `runIf` anywhere, and a console line reports the skip.
- **Catch-all rule `*` → `ollama/<LIVE_OLLAMA_MODEL>`** (not the bare
  `default:`) answers the short-prompt half of the long-context case,
  so the requested model name never has to exist on the Ollama host.
- **The dead provider is `type: openai` on `http://127.0.0.1:9`** with
  a dummy `api_key_env` (`BABELGATE_LIVE_DEAD_KEY`) — connection
  refused is a transport failure, fallback-eligible; `x-babelgate-*`
  headers assert provider `ollama` and `attempts: 2`.
- **Not run locally**: no Ollama on this machine; per the plan the
  owner runs `npm run test:live` and pastes the summary in the PR.
- **Files outside the Files block:** none.

## v1.2 Task 10: Release gates · OWNER REVIEW

- **`scripts/gates/claude-code-edit.sh` is outside the Files block**,
  changed per the plan's Gate 2 instruction ("if the gate script cannot
  pass `--config` through, extend it in this task"): it could not — the
  CLI rejects `--target`/`--model`/`--base-url` with a config file — so
  a `config <path-to-yaml> [model-label]` mode now runs
  `node dist/cli.js --config <path> --preset claude-code --port <port>`.
  The `ollama` and `openrouter` modes are unchanged; health wait,
  export-line parsing, `claude` invocation, output lines and
  `GATE PASS`/`GATE FAIL` are identical. Verified offline:
  `--config examples/claude-code-hybrid.yaml --preset claude-code`
  serves `/health` and prints the `export ANTHROPIC_BASE_URL=` /
  `export ANTHROPIC_AUTH_TOKEN=` lines the script greps (dummy
  `OPENROUTER_API_KEY`, 2026-11-02); `bash -n` clean, `shellcheck` not
  installed in this environment. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is not
  unset anywhere in the script and reaches `claude`.
- **`docs/gates/gpu-ollama.md` corrections (static read):** the host
  prep now pulls `qwen2.5-coder:7b` as well — Gate 2's
  `claude-*haiku*` route targets it with **no fallback** — and disk
  headroom is ~30 GB; a VRAM note covers both models staying resident.
  New sections give the exact commands for Gate 2 (config mode; needs
  Ollama at the YAML's hard-coded `http://localhost:11434` with both
  models, plus `OPENROUTER_API_KEY`; provider per request visible via
  `x-babelgate-provider` / the route log line) and Gate 3
  (`GEMINI_API_KEY` + reachable Ollama).
- **No gate has been run.** Gate runs are owner-only (Global
  Constraints) and this environment has no GPU, no Ollama and no
  OpenRouter/Gemini key — results below are placeholders for the owner
  to fill in on this branch.
- **Files outside the Files block:** `scripts/gates/claude-code-edit.sh`
  (reason above) and `docs/conductor/notes/v1.2/task11.md` — the
  conductor note telling Task 11 to flag the pending gates in its PR
  body (owner decision above). `docs/decisions.md` and
  `docs/gates/gpu-ollama.md` are inside it.
- **Fix round 1:** `config` mode now prints a routing summary after the
  Claude Code run — request counts by `winner` and `reason`, plus the
  multi-hop (fallback) count, parsed from the JSON route log lines
  (`NODE_ENV=production` on the spawned babelgate; `ollama`/`openrouter`
  modes unchanged). It replaces the runbook's tail-the-log recipe: the
  temp dir is deleted on exit. Arg validation order was also restored
  (usage/exit 2 before key and file checks) and `config` resolves a
  relative YAML path against the caller's cwd. `NODE_ENV=production` in
  config mode also turns off the dev-only canonical schema validation
  (src/services/chat.service.ts:115, models.service.ts:212) and enables
  production error-detail hiding (error-handler.ts:107), so config-mode
  gate runs use production behaviour while the `ollama`/`openrouter`
  modes keep the default — accepted because the route log must be JSON
  to summarise.

### Gate results — Gate 3 PASS; Gates 1–2 deferred to v1.3

The owner deferred the gate runs to release time (2026-11-02, PR #53,
no GPU host yet): the gates block the `v1.2.0` tag, not this PR, and
the results below are recorded before tagging.

- **Gate 1 (Claude Code ↔ Ollama GPU):** `DEFERRED to v1.3` (owner
  decision, 2026-11-03 — no GPU host; not run for v1.2.0) —
  `scripts/gates/claude-code-edit.sh ollama qwen3-coder:30b`;
  Claude Code version `<version>`, model `<model>`, GPU `<gpu>`,
  duration `<duration>`, cost `<cost>`, date `<date>`.
- **Gate 2 (Claude Code ↔ hybrid config):** `DEFERRED to v1.3` (owner
  decision, 2026-11-03 — no GPU host; not run for v1.2.0) —
  `scripts/gates/claude-code-edit.sh config examples/claude-code-hybrid.yaml`;
  Claude Code version `<version>`, providers used `<winner counts from
  the script's routing summary>`,
  duration `<duration>`, cost `<cost>`, date `<date>`.
- **Gate 3 (Gemini live):** `PASS` (owner run, 2026-11-03) —
  `GEMINI_API_KEY=<key> OLLAMA_API_BASE_URL=<url> npm run test:live`,
  on `main` at `519f8e0`, Gemini paid tier, model `gemini-3.8-flash`,
  local CPU Ollama (Docker) `qwen2.5:0.5b`. `gemini`-target cases
  passed: 16 / 16, 0 failed — chat round trip ×4, `stream:true` → 200
  stream ×4, model list ×4, unknown model → 404 ×4 (sources openai,
  anthropic, gemini, ollama). Whole suite: 90 passed / 11 failed; all
  11 failures are on the `openrouter` target (not part of this gate):
  openrouter.ai returned HTTP 504 "The operation was aborted" and 429
  "Provider returned error" for `qwen/qwen3-coder` (the owner's
  OpenRouter account has no paid credits); babelgate rendered them
  correctly in each source dialect.
  Confirmed upstream: after the owner added OpenRouter credit (account was `is_free_tier: true`), an
  OpenRouter-only re-run on `main` (`npx vitest run --config vitest.live.config.ts -t "openrouter"`,
  2026-11-03) passed 44 / 44 openrouter cases (57 others skipped by the filter).
  Earlier attempts not counted as
  gate runs: free-tier key rate-limited (5 RPM, 504s); run 1 on the
  paid key 91 / 10 — two stale live tests (anthropic-source model list
  without `anthropic-version`; 16-token budget spent on thinking by
  `gemini-3.8-flash`, confirmed directly against Google: `MAX_TOKENS`,
  `thoughtsTokenCount 11`), fixed in PR #55.

## v1.2 Task 11: CHANGELOG, roadmap, 1.2.0 · OWNER GATE

- **Release gates still `PENDING — owner run`.** The Task 10 entry above
  records all three gates (Claude Code ↔ Ollama GPU, Claude Code ↔
  hybrid config, Gemini live) as `PENDING` — deferred to release time by
  the owner (2026-11-02, PR #53, no GPU host yet). They block the
  `v1.2.0` tag, not this PR: the PR body lists each pending gate with
  its runbook command under "Release gates pending — tag blocked", and
  the PENDING lines, CHANGELOG and roadmap are left factual — no gate
  results claimed, nothing removed or reworded.
- **Version `1.2.0`** set in `package.json` and the two root
  `"version"` entries of `package-lock.json` only (per the Files block);
  dependency versions untouched.
- **CHANGELOG `## [1.2.0] - 2026-11-03`** with the plan's sections —
  Added (one port for all formats, routing, aliases, `min_input_tokens`,
  fallbacks, merged model list, `babelgate.yaml`, `--config`,
  `x-babelgate-*` headers), Changed (other formats' paths answer instead
  of 404; `count_tokens` answered whatever the target), Deprecated
  (`SOURCE_API`, removed in 2.0), Known limitations (spec §2.2: no hot
  reload, no overall deadline, no `/api/show`/`/api/version`/
  `/api/generate`). The date is the PR date; the tag lands after the
  owner records the gate results.
- **Roadmap status line** per the plan: "v1.2 released … Next: v1.3",
  Last revised 2026-11-03.
- **Files outside the Files block:** none.
- **Release gates at tag time (owner decision, 2026-11-03).** Gate 3
  PASS (recorded in the Task 10 entry). Gates 1 and 2 (Claude Code ↔
  GPU Ollama `qwen3-coder:30b`; Claude Code ↔
  `examples/claude-code-hybrid.yaml`) were not run: the owner deferred
  them to v1.3 (no GPU host) and releases `1.2.0` without them. The
  tag is no longer blocked by gates. Runbook for the next release:
  `docs/gates/gpu-ollama.md` (rented GPU host, ≥ 24 GB VRAM — ≥ 32 GB
  recommended for Gate 2 — over an SSH tunnel).
- **Extra end-to-end evidence (not a release gate).** Owner run,
  2026-11-03, on this branch: `scripts/gates/claude-code-edit.sh
  openrouter` → `GATE PASS` — Claude Code 2.1.317, `qwen/qwen3-coder`
  on OpenRouter, duration 19 s. Claude Code fixed the edit-task
  fixture through babelgate 1.2.0 and the fixture's `npm test` passed.
  This is the v1.1 OpenRouter edit gate, not Gate 1 or 2 (both remain
  deferred to v1.3).

## v1.2 follow-ups

### Live suite: gate 3 fixes (2026-11-03)

Owner-approved 2026-11-03 (conductor conversation). Fixes found by
Release Gate 3 (v1.2 plan Tasks 10/11): the owner's paid-Gemini live
run scored 91 pass / 10 fail. Two causes, both fixed under
`tests/live/` only — no `src/` changes, no fixture or snapshot
changes, no assertion removed or weakened.

- **A — the anthropic-source model list must identify itself as
  Anthropic.** All five `'anthropic' → <target> model list` cases
  failed with `expected undefined to be 'model'` at
  `tests/live/live.helpers.ts:315` (`body.data[0].type`). Since v1.2
  Task 2, `src/routing/detect-source.ts` treats `GET /v1/models` as
  anthropic only when the request carries `anthropic-version` or
  `x-api-key` (spec §3.2); the live case sent a bare GET, which is
  answered in OpenAI format (in v1.1 `SOURCE_API` decided the format,
  so the case passed then). Real Anthropic clients always send one of
  those headers (Anthropic SDK: `anthropic-version`; Claude Code:
  `x-api-key`), so the `chat.live.test.ts` model-list case now sets
  `anthropic-version: 2023-06-01` when `source === 'anthropic'`.
  Other sources are unchanged.
- **B — 512-token budget for the `gemini` target (thinking model).**
  Five gemini-target cases failed: `openai`/`gemini`/`ollama → gemini`
  chat round trip (`expected '' to be truthy`,
  `chat.live.test.ts:59`) and `gemini`/`ollama → gemini`
  `stream:true → 200 stream in source dialect`
  (`expected 'MAX_TOKENS' to be 'STOP'`, `errors.live.test.ts:119`;
  `expected 1 to be greater than 1`, `errors.live.test.ts:124`). The
  owner confirmed the upstream behaviour directly against Google:
  `POST …/v1beta/models/gemini-3.8-flash:generateContent` with
  `maxOutputTokens: 16` → `finishReason: MAX_TOKENS`,
  `thoughtsTokenCount: 11`, `candidatesTokenCount: 1` — the model
  spends the 16-token budget on thinking. Same failure mode and fix
  as commit 87c45df (anthropic source 16 → 512, owner-approved
  2026-10-29) and the existing 512 carve-outs for thinking-model
  targets. The `chat round trip` case in `chat.live.test.ts` and the
  `stream:true` case in `errors.live.test.ts` now send a 512-token
  budget in each source's own dialect
  (`max_tokens` / `generationConfig.maxOutputTokens` /
  `options.num_predict`) when `target === 'gemini'`; every other
  target keeps 16, and the STOP/MAX_TOKENS expectations are
  unchanged.
- **`tokenBudget` moved** from `stream.live.test.ts` to
  `tests/live/live.helpers.ts` and exported so all three live files
  share one implementation (the gemini-source stream case builds its
  body from `chatCall('gemini', …)` directly, so the budget is passed
  there too).
- **Not run locally:** `npm run test:live` needs the owner's keys;
  the live files typecheck and the full `./scripts/check.sh` gate
  passes.
- **Files outside the Files block:** none — `tests/live/*` and
  `docs/decisions.md` only.

## v1.3 Task 1 — Gemini CLI shape recording (2026-11-04)

`scripts/gates/record-gemini-cli.sh` ran Gemini CLI **0.66.0**
(google-genai-sdk 1.30.0, `npx @google/gemini-cli`) against
`record-shapes.ts` in front of babelgate, in a temp copy of the
edit-task fixture with `GEMINI_API_KEY=dummy`,
`GOOGLE_GEMINI_BASE_URL=http://localhost:<recorderPort>`, a scratch
`HOME` (selectedType `gemini-api-key`) and
`GEMINI_CLI_TRUST_WORKSPACE=true`. Recorded JSONL:
`tmp/gemini-cli-records/20261104-161147.jsonl` (+ `-162127`,
`-160551` runs and a plain-prompt session against a stub).

**Target deviation:** the plan names `ollama`/`openrouter` targets;
neither was available on the conductor machine (no ollama, no
`OPENROUTER_API_KEY`). A real Gemini upstream was — `GEMINI_API_KEY`
in `.env` works, so the script gained a third mode
`gemini [model]` (`--target gemini --base-url
https://generativelanguage.googleapis.com`, `MODEL_MAP="*=<model>"`).
Node fetch honours env proxies only with `NODE_USE_ENV_PROXY=1`
behind this sandbox's egress proxy; the script makes no network
assumptions itself.

**Recorded endpoints (every distinct method path):**

- `POST /v1beta/models/gemini-3.5-flash-lite:generateContent` —
  non-streaming helper calls (model router), no query params.
- `POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent`
  and `…/gemini-3.8-flash:streamGenerateContent` — every chat turn,
  always `?alt=sse` (server-sent events), `Accept` streaming.
- **No `:countTokens` and no `embedContent`** in v0.66.0 — neither the
  edit task (which died early, see below) nor a completed
  plain-prompt session called them. `:countTokens` is still
  implemented per the plan's pre-approval.

**Chat body shape:** top-level `contents`, `systemInstruction`
(`{parts:[{text}], role:"user"}`), `tools[].functionDeclarations[]`,
`generationConfig`. generationConfig carries `temperature`, `topP`,
`topK`, `thinkingConfig {includeThoughts, thinkingLevel}`; the router
call adds `responseMimeType` + `responseJsonSchema`.
`thinkingConfig` has no canonical slot — silently dropped today
(lossy but non-fatal; noted as a limitation, not fixed here).

**User-Agent:** `GeminiCLI-tui/0.66.0/<model> (<os>; <arch>;
terminal)` — spec §3.4's `GeminiCLI` substring matches it as
`gemini-cli`. Companion header `x-goog-api-client:
google-genai-sdk/<v> gl-node/<v>`; key travels in `x-goog-api-key`
(E9 confirmed).

**Proven gaps:**

1. **`parametersJsonSchema` (in scope per Step 3 — alias decode).**
   Every `functionDeclarations[]` entry uses `parametersJsonSchema`,
   never `parameters`. The decoder read only `parameters` → all
   tool schemas were dropped upstream-side; the model then emitted
   an `update_topic` call missing the required `strategic_intent`
   argument ("Error executing tool update_topic"). Decode alias only,
   no canonical type touched — the plan's own Step-3 example.
2. **`thoughtSignature` (out of scope — owner decision).** History
   `functionCall` parts carry `id` and a sibling `thoughtSignature`
   (first call of a parallel batch only, matching Google's docs);
   `functionResponse` parts carry `id`. The adapter drops
   `thoughtSignature`; Gemini-3.x upstreams then 400 the first
   tool-history turn: "Function call is missing a thought_signature
   in functionCall parts" (seen on `gemini-3.8-flash` and
   `gemini-3.5-flash-lite`; `gemini-2.5-flash(-lite)` are retired on
   this API key). `CanonicalToolCall` has no slot for it — a
   canonical change, reserved for Task 3. Options for the owner:
   (a) emit Google's documented `skip_thought_signature_validator`
   placeholder on unsigned `functionCall` parts in the gemini
   request encoder — encoder-only, no canonical change, unblocks
   the CLI now at documented quality cost ("last resort" per
   ai.google.dev/gemini-api/docs/thought-signatures); (b) carry real
   signatures in a separate task (canonical change, e.g. inside the
   Task-3 window); (c) document as a limitation. Recommended: (a)
   now + (b) as a follow-up — Gemini→Gemini tool use is broken on
   every 3.x model until one of them lands.
3. **`thinkingConfig` / `responseJsonSchema` passthrough** — dropped
   like every unknown `generationConfig` key; lossy, not fatal.
   Needs canonical fields to fix → same owner-decision bucket, but
   lower stakes (requests still 200).

**Run did not complete:** the edit task died on the thoughtSignature
400 at its second turn — `gemini edit task: FAIL` is the expected
state until the owner decides on gap 2. Steps 4–7 (countTokens,
`parametersJsonSchema`, `engines`, tests) pause at the Step-3 scope
check pending that decision.

**Continuation (2026-11-04, owner decisions on PR #58):** the owner
chose (a) for both escalations — the gemini request encoder emits
`thoughtSignature: "skip_thought_signature_validator"` on every
outgoing `functionCall` part (documented placeholder, part-level
sibling of `functionCall`,
https://ai.google.dev/gemini-api/docs/thought-signatures — field name
and exact value confirmed against the recorded wire shape), and
`:countTokens` is implemented per the plan's Interfaces with an
expected-value change approved for
`tests/integration/errors.test.ts:728-766` only (decision 2a).

**Blocked on further expected-value approvals** (STOP reported, not
implemented): the thoughtSignature placeholder changes the gemini
request encoder's output shape, so `gemini.adapter.test.ts`
"gemini functionResponse finds the name from history" (the
`contents[1].parts[0]` `toEqual`) and "gemini request encoder still
omits functionCall.id" (the `contents[0].parts[0]` `toEqual`) need
`thoughtSignature` added to their expected parts; and `:countTokens`
makes `proxy.service.test.ts` "gemini :countTokens → NotSupportedError
'countTokens is not supported'" obsolete (the call now returns 200
`{totalTokens}` locally). Both are outside the approved
errors.test.ts scope, so they wait for the owner. The approved
errors.test.ts edits (countTokens dropped from the `it.each`,
tunedModels case → `embedContent`) land with the implementation.

**Landed this round:** the `parametersJsonSchema` alias in
`toCanonicalTools` (decoder only — `parameters` wins when both are
present, matching what the encoder writes), `engines.node` `>=22.13`
(owner-gated `package.json` change, flagged in the PR),
`tests/integration/gemini-cli.test.ts` (embedContent → 501 case and
the recorded-shape `parametersJsonSchema` case; the countTokens and
placeholder cases were written, shown failing for the expected
reasons — 501 UNIMPLEMENTED and no field — and removed pending the
approvals above), and the `detect-source` countTokens guard.

**Continuation 2 (2026-11-04, approvals on PR #58):** the expected-
value changes blocked above were approved by the owner on PR #58 and
landed with the implementation:

- `tests/integration/errors.test.ts` — `countTokens` dropped from the
  `:method → 501` `it.each` (`embedContent` stays); the tunedModels
  case now uses `:embedContent` (still 501).
- `src/services/proxy.service.test.ts` — rewritten as "gemini
  :countTokens is answered locally with {totalTokens}": 200
  `{totalTokens: n}` (n > 0), the estimate header, no upstream call.
- `src/transformers/adapters/gemini.adapter.test.ts` — the two
  encoded `functionCall` parts gain
  `thoughtSignature: "skip_thought_signature_validator"`;
  `functionCall.id` stays omitted.

No other existing expectation, fixture or contract snapshot changed.
`record-gemini-cli.sh gemini gemini-3.8-flash` re-ran the edit task
end-to-end: **PASS** (spec E13), where the earlier run died on the
thought_signature 400.

**Implementation notes:** `ProviderRoute` gained `matchesPath` (a
claim test beyond the prefix — the gemini `count_tokens` route
shares the chat route's `/v1beta/models` prefix, precedes it, and
claims only `<model>:countTokens`) and `countTokensBody` (the
dialect reply: `{totalTokens}` for gemini, `{input_tokens}` for
anthropic). `functionCallPart` gained a `thoughtSignature` option;
only `fromCanonicalRequest` passes the placeholder — the response
and stream encoders are unchanged. `GeminiFunctionCallPart` was
added to `gemini.types.ts` next to the other REST shapes the SDK
lacks. Live check: `POST /v1beta/models/gemini-3.8-flash:countTokens`
→ `200 {"totalTokens":63}` with `x-babelgate-token-estimate: true`;
`:embedContent` still 501.

- **Files outside the Files block:** `src/transformers/adapters/
  gemini.tools.ts` — the Step-3-approved `parametersJsonSchema` alias
  lives in the tool-declaration decoder, and `functionCallPart`'s
  `thoughtSignature` option sits beside it; the Files block names no
  adapter tool file. `src/transformers/adapters/gemini.adapter.ts`
  (the request-encoder call site that passes the placeholder) and
  `src/types/gemini.types.ts` (the `GeminiFunctionCallPart` wire
  type) carry the rest of decision 1a.
  `tests/integration/errors.test.ts`,
  `src/services/proxy.service.test.ts` and
  `src/transformers/adapters/gemini.adapter.test.ts` hold the
  expected-value changes approved by the owner on PR #58.
- **Follow-ups:** Carry real `thoughtSignature` through canonical
  (owner decision 1b, follow-up task in the Task 3 window).
  `thinkingConfig`/`responseJsonSchema` passthrough (needs canonical
  fields — owner-decision bucket, lower stakes).

**v1.3 Task 1 follow-ups (after PR #58)** — the owner's three
non-blocking review notes, landed on `v1.3/task-1-followups`
(2026-11-04):

- **Lockfile engines sync** — `package-lock.json`'s root
  `packages[""].engines.node` now reads `>=22.13` to match
  `package.json`. The line is the owner's own commit `09c56dd`
  ("Update package-lock.json"), cherry-picked onto this branch so
  the owner stays its author; `git diff origin/main --
  package-lock.json` is that one line.
- **`:countTokens` accepts the `generateContentRequest` form** —
  `models.countTokens` bodies take either `contents[]` or a full
  `GenerateContentRequest` under `generateContentRequest`, with
  `contents` ignored when it is set (googleapis proto
  `google/ai/generativelanguage/v1beta/generative_service.proto`,
  `CountTokensRequest`; REST doc https://ai.google.dev/api/tokens).
  The gemini `count_tokens` route gained `countTokensRequest`,
  which unwraps `generateContentRequest` before decode so the
  estimate counts the same input the same body sent to
  `:generateContent` would — route-level, no provider-pair branch
  in `proxy.service.ts`, no canonical change.
- **`countTokensBody` is now a type-level requirement** —
  `ProviderRoute` is a discriminated union on `kind`; only the
  `count_tokens` variant carries `countTokensBody` (required) and
  `countTokensRequest` (optional). The non-null assertion in
  `proxy.service.ts` is gone; a `count_tokens` route without
  `countTokensBody` no longer typechecks.

## v1.3 Task 2 — Per-provider output-token cap (2026-11-05)

- **`ProviderEntry.maxOutputTokens` is set by conditional spread** in
  both loaders (`yaml-config.ts`, `env-config.ts`), not
  `maxOutputTokens: value | undefined`: `yaml-config.test.ts`'s
  existing "valid full file" case asserts entries with
  `toStrictEqual`, which fails on a key that is present-but-undefined.
  Same reason `context_window` handling was left as is.
- **`TARGET_MAX_OUTPUT_TOKENS` joined `ignoredEnvKeys`** between
  `TARGET_CONTEXT_WINDOW` and `SOURCE_API`: it is env-only per spec
  §3.3, so a loaded YAML should warn that it is ignored, exactly like
  `TARGET_CONTEXT_WINDOW`.
- **The cap is applied in `canonicalForTarget` via
  `maxTokensClampOf`**, the plan's Produces name kept verbatim for
  Task 5 (`trace.maxTokensClamp`): `{from, to}` when a requested
  `maxTokens` was reduced, `{to}` when the cap filled an unset one,
  `undefined` when there is no cap or the request was already under
  it. `config` is copied before `maxTokens` is written — the decoded
  canonical is never mutated.
- **Invalid-cap YAML cases run from `mkdtemp` files**, not new
  `tests/fixtures/config/*.yaml` fixtures: keeps the diff inside the
  task's Files block and the fixture tree untouched (the guard allows
  new files, but the plan names only the three test files).
- **Files outside the Files block:** none.

## v1.3 Task 3 — Canonical cache hints, system parts, cached usage (2026-11-05)

Spec §3.2 (interface change), E2, E3, D9. `canonical.types.ts` and
`canonical.schema.ts` changed together.

**Type diff:**
- `CanonicalCacheHint { ttl?: "5m" | "1h" }` added; `cache?` on
  `CanonicalContentPart` and `CanonicalTool`.
- `CanonicalRequest.systemPrompt?: string | CanonicalContentPart[]`
  (was `string`); parts are text-only, enforced by
  `canonicalRequestSchema` via an array refine (`"system prompt parts
  must be text"`).
- `CanonicalUsage` gains optional `cacheReadTokens` / `cacheWriteTokens`
  (int, nonnegative); `inputTokens` is ALL input, cached included.
- `src/transformers/system-text.ts` (new): `systemText(system)` flattens
  `string | CanonicalContentPart[] | undefined` → `string | undefined`.

**Wire fields (checked against provider docs, 2026-11-05):**
- Anthropic `cache_control: {type:"ephemeral", ttl?:"5m"|"1h"}` on
  content blocks, tools and system blocks, and usage fields
  `cache_creation_input_tokens` / `cache_read_input_tokens` —
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching and
  https://docs.claude.com/en/api/messages (also confirmed in
  @anthropic-ai/sdk@0.132.1 types: `CacheControlEphemeral`,
  `Usage.cache_*_input_tokens: number | null`).
- OpenAI `usage.prompt_tokens_details.cached_tokens` /
  `cache_write_tokens` — https://platform.openai.com/docs/guides/prompt-caching
  and https://openrouter.ai/docs/guides/best-practices/prompt-caching
  (confirmed in openai@7.30.1 `CompletionUsage.PromptTokensDetails`).
- DeepSeek `usage.prompt_cache_hit_tokens` → `cacheReadTokens` when
  `prompt_tokens_details` is absent —
  https://api-docs.deepseek.com/guides/kv_cache (not in the OpenAI SDK
  type; added as `OpenAICompatibleUsage` in `src/types/openai.types.ts`).
- Gemini `usageMetadata.cachedContentTokenCount` → `cacheReadTokens` —
  https://ai.google.dev/api/generate-content#UsageMetadata. Confirmed by
  the field's presence in @google/generative-ai@0.24.1 `UsageMetadata`
  and in recorded stream fixtures (a doc check; no live Gemini key
  available for a live-response check).
- Ollama: no cache mapping (`prompt_eval_cached_count` deliberately not
  decoded — spec §3.2, Ollama reuses its KV cache itself).

**Semantics implemented:**
- Decode: `cache_control` on text/image parts, custom tools and system
  blocks → `cache` (absent ttl → `{}`, the wire default 5m). Any system
  block with `cache_control` turns `systemPrompt` into parts (the system
  message gets the same parts value); without hints the joined string is
  produced exactly as before. `cache_control` on spots canonical still
  can't carry (tool_use/tool_result blocks and their nested content,
  server-side tools, non-text system blocks) keeps the 'Dropping
  "cache_control" fields' debug line — the generic `hasCacheControl`
  scan was narrowed to `hasUncarriedCacheControl` so carried spots no
  longer log.
- Encode: `cache` → `cache_control: {type:"ephemeral", ttl?}` on
  Anthropic text/image blocks, tools and system blocks; a parts
  `systemPrompt` emits a `TextBlockParam[]`, a string stays a string.
  The single-text-block collapse to a string is skipped when the block
  carries a hint. The 4-breakpoint cap is Task 4's scope, not this one.
- Usage: Anthropic decodes `inputTokens = input_tokens + read + write`
  and encodes `input_tokens = max(0, inputTokens − read − write)` plus
  both cache fields; OpenAI/Gemini `prompt_tokens`/`promptTokenCount`
  already include cached tokens so `inputTokens` passes through.
  Cache fields are emitted only when present and non-zero — no-hint
  traffic produces byte-identical usage objects.
- Streams: Anthropic `message_start`/`message_delta` cache fields are
  carried into the canonical `usage` event; the OpenAI `choices:[]`
  usage chunk and Gemini `usageMetadata` gain/keep the same fields; the
  Anthropic stream encoder splits them back in `message_delta`.

**Resolved ambiguity:** the plan writes `systemText` joins parts with
`"\n"` but parenthetically says it is "the same separator the Anthropic
decoder uses for system arrays today; confirm and keep" — and spec §3.2
says "no other system-prompt behaviour changes". Today's decoder joins
with `"\n\n"` (`anthropic.adapter.ts`, 'system array joins with blank
line'), so `systemText` keeps `"\n\n"`.

**Fixture change (owner-approved 2026-11-05, option A):**
`tests/fixtures/streams/openai/tool_call.json` `expectedEvents` gained
`"cacheReadTokens": 20` on its one `usage` event — the `.sse` wire bytes
are unchanged (the recorded usage chunk's synthetic
`prompt_tokens_details.cached_tokens: 20` now decodes per spec §3.2).
Nothing else in the file changed; no other fixture or snapshot was
touched. `scripts/ci/fixture-guard.sh` flags this file by design; the PR
is titled `[OWNER REVIEW]`.

**Files outside the Files block:**
- `src/transformers/adapters/anthropic.cache.ts` (new) — AGENTS.md
  rule 7: the §3.2 helpers (`toCacheHint`, `toCacheControl`,
  `AnthropicWireUsage`, `anthropicUsageToCanonical`,
  `canonicalUsageToAnthropic`, `toCanonicalSystem`, `toAnthropicSystem`,
  `hasUncarriedCacheControl`) live here so `anthropic.adapter.ts` (385)
  and `anthropic.messages.ts` (372) stay under ~400 lines.
- `src/utils/token-estimate.ts` — `req.systemPrompt?.length` no longer
  compiles against the `string | CanonicalContentPart[]` union; it now
  reads `systemText(req.systemPrompt)?.length` (no behaviour change).
- `tests/fixtures/streams/openai/tool_call.json` — the owner-approved
  fixture change above.

**Files block entries that needed no change:**
`ollama.stream.ts` (no cache fields are ever decoded or emitted for
Ollama — asserted by the new "no cache fields ever emitted" tests),
`src/utils/stream-reassemble.ts` (usage passes through by reference, so
the new fields ride along), `src/types/gemini.types.ts` (the SDK
`UsageMetadata` already declares `cachedContentTokenCount`).

**Fix round 1 (review):** the encoders also read system text from the
system-role *message*, not only `systemPrompt` — OpenAI emitted
`content: ""` for hinted parts (system text dropped), Ollama joined
them with `"\n"`, and Gemini's message fallback ignored array content.
All three now flatten the system message's content through
`systemText` too; hints still drop on non-Anthropic targets (Task 4).

**Fix round 2 (review):** Ollama's `systemText` path now applies only
when a system message's parts carry a `cache` hint; unhinted system
parts keep main's `"\n"` join, so no unhinted system-prompt behaviour
changes (§3.2). OpenAI side effect, disclosed: its encoder's system
message still flattens array content via `systemText`, so an
OpenAI-format client's *unhinted* array system content — which main
encoded as `content: ""` (text dropped) — now arrives as its text
joined with `"\n\n"`; a pre-existing drop fixed as a side effect, code
unchanged.

## v1.3 Task 4 — Cache-hint encoding flags, encoder stability, cached-usage pair matrix (2026-11-05)

- **`ProviderEntry.cacheHints` (YAML `cache_hints`) is set by
  conditional spread** in `yaml-config.ts`, same reason as Task 2's
  `maxOutputTokens`: `yaml-config.test.ts`'s "valid full file" case
  asserts entries with `toStrictEqual`, which fails on a
  present-but-undefined key. The plan names no env-only-mode key, so
  none was added — env mode keeps hints stripped.
- **Hint stripping happens in `canonicalForTarget`** (adapters stay
  config-free per spec §3.2): every `cache` is removed unless
  `entry.type === "anthropic"` or `entry.cacheHints === true`. When a
  system prompt's or system message's parts lose their hints they
  collapse to `systemText`'s `"\n\n"` join — the same string the
  decoder produced and the encoders emit — so the strip changes no
  prompt text. Hinted arrays elsewhere (user/assistant/tool messages,
  tools) keep their shape minus `cache`. Ollama strips silently;
  OpenAI/Gemini targets log one `logger.debug` line per request
  (Task 6 turns it into a `cache_control_dropped` note).
- **The Anthropic 4-breakpoint cap is a post-pass** over the encoded
  request (`limitCacheBreakpoints` in `anthropic.cache.ts`): it
  collects `cache_control` holders in Anthropic's walk order —
  `tools` → `system` → `messages` (including `tool_result` content
  blocks one level down) — keeps the last 4 and deletes the rest;
  one `logger.debug` line reports the count (Task 6 turns it into a
  `cache_limit` note).
- **The OpenAI encoder emits `cache_control: {type:"ephemeral", ttl?}`**
  on every part carrying a canonical hint, on `tools[]` at top level,
  and on the system message as a **one-part content array** (the
  plan's wording). A single part can mark only one breakpoint, so the
  **last** hinted part's cache value wins — it covers the most prompt;
  interior hints collapse into it. Recorded because multi-part
  systems with differently placed hints lose precision here either
  way.
- **Two existing OpenAI adapter expectations changed** (flagged, not
  loosened): the §3.2 hinted-system cases previously asserted the
  hinted system message encoded to a plain string. Task 4's spec
  mandates emitting `cache_control` when canonical carries a hint, so
  both now assert the one-part content array. All other expected
  values — fixtures, snapshots, existing tests — are unchanged.
- **Stability findings:** the 4 request encoders were already
  deterministic and prefix-stable on main (400 seeded cases pass
  unmodified — no non-determinism fix was needed). The generator caps
  hints at 4 per request and appends only user/assistant turns: a
  bare tool message legitimately merges into Anthropic's previous
  tool-result user block and a hinted appended turn could push an
  earlier breakpoint past the cap — wire rules, not instability.
- **Mock design:** `tests/mocks/upstreams.ts` `cachedUsage` replies
  are hand-written provider wire shapes (not adapter output) so the
  matrix reads the documented wire fields — Anthropic
  `cache_read_input_tokens`/`cache_creation_input_tokens`, OpenAI
  `prompt_tokens_details.cached_tokens`/`cache_write_tokens`, Gemini
  `cachedContentTokenCount`, Ollama totals only.

**Files outside the Files block:**
- `src/transformers/adapters/anthropic.cache.ts` — `limitCacheBreakpoints`
  belongs with the §3.2 cache-conversion helpers Task 3 created here;
  `anthropic.adapter.ts` stays under ~400 lines.
- `src/config/yaml-config.test.ts` — a new case pinning `cache_hints`
  parsing; the task's Test list doesn't name it, but Task 2 set the
  precedent for config-key cases living here.

## v1.3 Task 5 — RequestTrace, client id, middleware, emitTrace, log sink (2026-11-05)

- **Scope opens only for chat routes.** `observeMiddleware` runs after
  `requireApiKey` and calls `findSourceRoute(source, method, path)`;
  when the matched route's `kind !== "chat"` there is no scope at all
  (model lists, count_tokens, unmatched provider paths). This makes
  spec §3.1's "only chat requests produce traces" structural rather
  than incidental, and keeps `currentTrace()` undefined inside
  non-chat handlers for Task 6's `recordNote`/`snapshot`. Chat-route
  requests rejected before `planRoute` (unsupported Gemini method,
  validation, empty path model) create a trace that is simply never
  finished — no emit, matching "pre-route rejections are not traced".
- **`finishTrace` outside a scope is a no-op.** The update carries no
  `requestId`/`sourceApi`, so there is no fallback "Request completed"
  line for direct service calls — the v1.2 tests that asserted it now
  run inside `runWithTrace`. A second `finishTrace` for the same trace
  is a no-op (WeakSet in emit.ts), so an error path plus the stream's
  `finally` can never double-emit (Review Focus 1).
- **Moved route-log tests.** v1.2 had no `route-log.test.ts`; the two
  tests asserting the "Request completed" line moved instead:
  `proxy.service.test.ts`'s "logs token usage metrics on completion" →
  `src/observe/sinks/log.test.ts` (same assertions, wrapped in
  `runWithTrace`), and `gateway.test.ts`'s "route log line has no
  prompt text" → `tests/integration/observe.test.ts` as "log line has
  no prompt text" (same assertions, same GATEWAY_YAML routing).
- **status/httpStatus/errorType conventions.** A stream that ends on a
  canonical `error` event is `status: "error"` with `httpStatus` 200
  (headers were already flushed) and `errorType` = the event's
  canonical kind; a client abort mid-stream is `status: "aborted"`,
  `httpStatus` 200, no `errorType`; a client abort before any response
  is `status: "aborted"`, `httpStatus` 499 (nginx's client-closed
  convention) via `errorTraceFields` in `attempt-targets.ts`, which
  also maps errors to the *client-facing* canonical status/kind
  (`err.toCanonical()`), not `ProxyError.statusCode` — an upstream 400
  is recorded as 400/`invalid_request`, matching what the error
  handler renders.
- **`maxTokensClamp` records the winning hop's clamp** only
  (`maxTokensClampOf(canonical, result.entry)`); all-fail requests
  carry none. `ttfbMs` is set when the first stream chunk is yielded
  (JSON replies: when the encoded body is ready, computed against
  `trace.startedAt`).
- **The log line is built field-by-field**, never by spreading the
  trace — so `userAgent` (a header), `bodies`, `notes` and `repairs`
  cannot leak into it; `diagnostics` goes in as codes only. All
  v1.2 `RouteLogRecord` fields keep their names and values; the new
  fields are exactly the plan's list: `client`, `status`,
  `httpStatus`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`,
  `ttfbMs`, `totalMs`, `diagnostics`.
- **Sink registry.** The log sink is the module-level default in
  `emit.ts`, so a fresh module graph (tests' `vi.resetModules`)
  re-registers exactly once; `resetSinks()` clears sinks and the warn
  throttle for tests. `emitTrace(trace, now)` takes an injectable
  clock for the one-warn-per-60 s-per-sink test. `bodies` is stripped
  via one shared destructure per emit for every sink except
  `body-ring`/`usage-store` (spec §3.1.1).
- **Trace.ts carries Task 6/9's types now** (`TranslationNote`,
  `ToolCallDiagnostic`, `ToolCallRepair`, `BodySnapshot`,
  `BodySnapshots`) — `RequestTrace` needs them for its spec §3.1
  fields; Task 6/9 will import rather than redeclare them (their
  entries in later Files blocks shrink accordingly).
- **Gemini CLI UA** uses the recorded pattern verbatim:
  `GeminiCLI-tui/0.66.0/<model> (<os>; <arch>; terminal)` → the
  `GeminiCLI` substring → `gemini-cli` (Task 1 record). Playground
  requests reach `playground` through the `x-babelgate-client` header
  override — no special case.

**Files outside the Files block:**
- `src/services/attempt-targets.ts` — `errorTraceFields`, the shared
  status/httpStatus/errorType helper both chat services' error paths
  need (kept beside `toClientFacing`, the file's error-mapping home).
- `src/services/proxy.service.test.ts` and
  `tests/integration/gateway.test.ts` — the two route-log tests were
  *removed* here as part of the sanctioned move (assertions unchanged
  in their new homes).
- `src/observe/sinks/log.test.ts` — the moved test's new home plus the
  sink's own field-shape case; `src/observe/trace.test.ts` covers
  `newTrace` defaults (both fall under the Test list's
  `src/observe/*.test.ts`).

**Fix round 2 (owner-requested, 2026-11-05)** — two paths that reached
`planRoute` but emitted no trace:

- **Encoder creation moved inside the traced try.**
  `adapters[source].createStreamEncoder(...)` in
  `chat-stream.service.ts` ran before the `try` around
  `attemptTargets`, so a throw there skipped `finishTrace` entirely.
  It is now the first statement inside the same try — still created
  once, before the first hop — so the existing catch emits the trace
  (`hops` is still `[]`) and rethrows. Client-visible behaviour is
  unchanged (same 500 TRANSFORM_ERROR rendering).
- **Never-iterated stream: `result.stream.finish(clientStatus)`.** A
  throw in the route between `proxyRequest` and the `for await`
  (setHeader/flushHeaders) left the `chunks` generator suspended at
  start, and a suspended-start async generator's `return()` does NOT
  run its `finally` (verified on Node 24: resolves `{done:true}`
  without entering the body) — so the suggested
  `chunks.return(undefined)` alone could not finish the trace. The
  smallest correct mechanism: the generator's `finally` body moved
  into `finish(clientStatus?)`, which the generator's `finally` still
  calls and which `ProxyResult.stream` also exposes; the route's catch
  calls it on every error path (`finish()` when the client aborted →
  "aborted"; `finish(res.statusCode)` when headers already went out;
  `finish(mapped.toCanonical().status)` on the `next(err)` path —
  Express 5 dispatches the error handler asynchronously, so the
  rendered status is computed the same way the handler computes it).
  Exactly-once is unchanged:
  `finishTrace`'s WeakSet dedupes a second call on an
  already-finished stream. `httpStatus` when never iterated: 499 on
  client abort (the owner decision — a client abort before any
  response stays 499), else the status the client received; once
  iterated it is the 200 that was flushed, as before. Side benefit:
  `finish()` also aborts the won upstream request that a
  never-iterated stream would otherwise leave open.

**Files outside the Files block (fix round 2):**
- `src/routes/proxy.ts` — the never-iterated gap only exists in the
  route's catch; the `finish()` calls live there (plus hoisting
  `result` out of the try).
- `src/services/proxy.service.ts` — `ProxyResult.stream` gained the
  `finish(clientStatus?)` member; `chunks` stays
  `AsyncIterable<string>`.

## v1.3 Task 6 — Translation notes, body snapshots, body ring (2026-11-06)

- **Note codes and paths (spec §3.5).** The 8 adapter drop sites (E6),
  the Task 4 breakpoint-limit line, and the Task 4 `stripCacheHints`
  line (its own decisions entry already promised the note) map to:

  | site | code | stage | path |
  |---|---|---|---|
  | anthropic `thinking` field | `thinking_dropped` | decode | `thinking` |
  | anthropic `metadata` field | `metadata_dropped` | decode | `metadata` |
  | anthropic uncarried `cache_control` | `cache_control_dropped` | decode | `cache_control` |
  | anthropic thinking/redacted_thinking blocks | `thinking_dropped` | decode | `messages[i].content[j]` |
  | anthropic `disable_parallel_tool_use` | `disable_parallel_tool_use_dropped` | decode | `tool_choice.disable_parallel_tool_use` |
  | anthropic stream thinking/signature blocks+δ | `stream_block_dropped` | decode | the wire block/delta type |
  | anthropic >4 breakpoints (encode) | `cache_limit` | encode | `cache_control` |
  | openai `parallel_tool_calls` | `parallel_tool_calls_dropped` | decode | `parallel_tool_calls` |
  | openai tool `strict` | `tool_strict_dropped` | decode | `tools[i].function.strict` |
  | `canonicalForTarget` hint strip | `cache_control_dropped` | encode | — (adapter = target provider type) |

  For a content array filtered before conversion (tool_result/tool_use
  split out first), `content[j]` is the index in the converted block
  list — usually the wire index. `stream_block_dropped` `path` is the
  dropped wire type (`thinking`, `redacted_thinking`, `thinking_delta`,
  `signature_delta`) since a stream event has no JSON path.
- **`recordNote(note, message)` also writes the debug line** — every
  converted site passes its original `logger.debug("Dropping …")`
  sentence verbatim (the breakpoint-limit line keeps the dropped
  count); the derived `Dropping "<path-or-code>" (<adapter> <stage>:
  <code>)` line is only the fallback for a site with no message. No
  existing expected value or assertion changed.
- **`snapshot()`'s "ring enabled" gate is per-request.** `proxyRequest`
  sets `trace.bodies = { target: [] }` only when a trace scope exists
  (chat routes only) and `getBodyRing()` is non-undefined
  (`observe.inspectorBuffer` > 0); `snapshot()` writes only into an
  existing `bodies`. This keeps `context.ts` config-free — adapters may
  import `recordNote`/`snapshot` without transitively importing config
  (Global Constraint: adapters stay config-free).
- **`getBodyRing()` reads `observe.inspectorBuffer` per call** so
  `INSPECTOR_BUFFER=0` disables capture even once the singleton exists;
  a non-zero size never recreates it (size changes need a restart).
  `emitTrace` strips `bodies` for every sink not named `body-ring` /
  `usage-store` — the inspector never sees headers.
- **`GatewayConfig.observe` is required** (`ObserveConfig` with
  `inspectorBuffer` for now; Task 7 extends it). `INSPECTOR_BUFFER` is
  parsed by `parseInspectorBuffer` in env-config and applied in both
  env and YAML mode (env wins, §3.11); the `observe:` YAML section
  itself arrives in Task 7.
- **Snapshots are taken where the stages already exist:**
  `source` = the parsed client body before decode; `canonical` = the
  validated canonical request; `target[]` = each encoded upstream body
  (inside the attempt callback, so a fallback records each hop);
  `response.wire` = the upstream JSON body (snapshotted before decode
  so a throwing decode still leaves it) or, for streams, the tapped
  upstream text; `response.canonical` = the decoded response (JSON) or
  `reassembleStream(observed)` with `model` set to the requested name —
  a stream that ended mid-flight or on an `error` event doesn't
  reassemble and simply has no canonical snapshot.
- **The stream wire tap** is decided once at pipeline start
  (`tapWire = currentTrace()?.bodies !== undefined`): with the ring off
  (`INSPECTOR_BUFFER=0`) there is no decoder, no accumulation and no
  snapshot — the tap does zero work, and `finish` likewise skips
  `reassembleStream`, which only feeds the `response.canonical`
  snapshot. When on, it accumulates decoded upstream text only until
  it passes `STREAM_WIRE_CAP_BYTES`, flushes the incremental UTF-8
  decoder at end, and snapshots in the pipeline's `finally` — partial
  captures on abort/error are kept; the client stream is untouched
  (asserted: tail chunks and `[DONE]` still arrive). The 1 MB /
  256 KB caps are byte caps (1 048 576 / 262 144); over-cap values are
  replaced by the first cap bytes as a string + `truncated: true`,
  with the cut backed off to a UTF-8 character boundary so a snapshot
  never exceeds the cap and never ends in U+FFFD.
- **No existing assertion changed:** the openai adapter test's
  `'"strict"'` expectation and every other expected value on main are
  byte-identical; no fixture, snapshot or wire expected value changed.

**Files outside the Files block:**
- `src/config/yaml-config.ts` — `GatewayConfig.observe` is required and
  `INSPECTOR_BUFFER` applies in YAML mode too (env scalars win, §3.11).
- `src/config/env-config.test.ts` — pins the `INSPECTOR_BUFFER`
  default (50), the 0-disable and the non-negative-integer error.
- `src/services/models.service.test.ts` — its `gatewayConfig` helper
  builds a `GatewayConfig` literal and needed the required `observe`.
- `src/services/attempt-targets.ts` — the Task 4 `stripCacheHints`
  debug line becomes the `cache_control_dropped` note, as Task 4's own
  decisions entry recorded.
- `src/services/attempt-targets.test.ts` — the strip-site's note case
  ("one adapter test per site" — this site lives in services).
- `src/transformers/adapters/anthropic.adapter.test.ts` and
  `openai.adapter.test.ts` — the per-site note cases Step 1 names
  (`"each drop site records its code"`); the Test list's named files
  cover context, ring and integration only.

## v1.3 Task 7 — Usage store, migrations, retention, `observe:` config, Docker volume (2026-11-06)

- **`DatabaseSync` on the newest Node checked: no warning.** On Node
  24.22.0 (the newest available locally) `new DatabaseSync(":memory:")`
  prints nothing — `node:sqlite` is stable on the 24 line, so the name
  is not deprecated and no ExperimentalWarning is emitted. On 22.x the
  warning still fires: the Docker image's Node 22.23.4 prints the
  one-time `ExperimentalWarning` for `node:sqlite` when it is not
  filtered (the Step 4 run showed 0 such lines with the filter
  installed). The filter therefore stays unconditional — it is the
  only thing standing between a 22.x user and a stderr line — while
  being a no-op on 24.
- **The warning filter wraps `process.emit`, not `process.on`.** A
  `process.on("warning")` listener cannot suppress the default print:
  Node's own warning printer is a `warning` listener registered at
  bootstrap, so it runs before any user listener and writes to stderr
  regardless. Intercepting `process.emit` drops the matching `warning`
  event before any listener — including the printer — sees it, so
  nothing reaches stderr. The predicate swallows ONLY an
  `ExperimentalWarning` whose message mentions SQLite; every other
  event and warning passes through untouched. It is installed once by
  `installSqliteWarningFilter()` in `src/observe/sqlite.ts`, called
  from `cli.ts` and `index.ts` before the store can load, and again
  inside `openDatabase` for direct callers.
- **Schema and queries.** The `requests`/`bodies`/`schema_version`
  DDL is spec §3.4 verbatim at `schema_version` 1; migrations are
  forward-only and each runs in a transaction. `provider`/`model`
  columns store the *winning* hop (last hop with `outcome === "ok"`;
  NULL when nothing won) so `usage(group: "model")` and
  `usage(group: "provider")` price and count the winner, never a
  failed first hop. `unpriced` counts rows with `cost_usd IS NULL` —
  unknown price is never conflated with $0 (D8). The cursor is
  `[startedAt, id]` base64url-encoded, paged by
  `(started_at, id) DESC` keyset; a bad cursor raises
  `ValidationError`.
- **Resilience (Review Focus 2).** Open/migrate failures disable the
  sink with one warning naming the path and the fix
  (`getUsageStore()` → undefined, never retried until restart).
  A locked DB surfaces as `SQLITE_BUSY` after the 200 ms
  `DatabaseSync` `timeout`, rolls the batch back, drops it with a
  warn-throttled (60 s) log, and the store keeps serving on the next
  flush. `bodies` cascade-delete works because `node:sqlite`
  enables `PRAGMA foreign_keys` by default — asserted by
  `"retention deletes old rows and their bodies"`.
- **`UsageStore.pruneBefore`** is one method beyond the plan's
  `TraceSink & UsageQueries & { flush; close }` — it is the seam
  `startRetention` calls (typed minimally there as
  `{ pruneBefore(cutoffMs) }`).
- **`~` in `usage_db` expands to the user's home** (`expandHome` in
  env-config.ts): SQLite does not understand `~`, and the §3.11
  default is `~/.babelgate/usage.db`.
- **`observe:` env-wins semantics.** `parseObserve(env, yaml)` is
  shared by `loadConfig` and `loadYamlConfig`; every observe key with
  an env counterpart lets env win, matching v1.2's rule. The env-only
  keys (`metrics`, `ui`, `uiAllowRemote`, `uiAllowedHosts`) are parsed
  now because `ObserveConfig` names them all; they are consumed by
  Tasks 10–12. `wouldCostReference` is YAML-only per §3.11.

**Files outside the Files block:**
- `src/observe/sinks/usage-queries.ts` — split out of
  `usage-store.ts` (478 → ~260 + ~210 lines) for AGENTS.md rule 7
  (single-purpose, ~400 lines): the read path (`RequestRow`,
  `UsageGroup`, `UsageQueries`, `createUsageQueries`) is a separate
  module; `usage-store.ts` re-exports the types so the plan's import
  surface is unchanged.
- `src/services/models.service.test.ts` — its `gatewayConfig` helper
  builds a `GatewayConfig` literal and needed the new required
  `observe` fields.
- `tests/integration/observe.test.ts` — the `"unusable db never
  breaks serving"` test's "app answers chat 200" half (Review Focus 2)
  is an end-to-end assertion and lives in the integration suite; the
  sink-level halves are in `usage-store.test.ts`.

## v1.3 Task 8 — Prices, cost, live prices, would-have-cost (2026-11-07)

- **Bundled table:** `src/cost/prices.json` generated from LiteLLM
  `model_prices_and_context_window.json` at commit
  `77b4644523c20e8338f1986d88d24a5c6ed22b3a` (main @ 2026-11-06),
  3 322 chat-mode models, via the task's own `buildPriceTable`
  transform. Doc reference: LiteLLM repo
  (https://github.com/BerriAI/litellm, MIT — notice added to NOTICE);
  OpenRouter `pricing` field names (`prompt`, `completion`,
  `input_cache_read`, `input_cache_write`, string USD/token) per
  https://openrouter.ai/docs/api-reference/list-available-models.
- **LiteLLM has no `openrouter/` keys** in this snapshot — an
  OpenRouter provider is priced by `live_prices: true` (its own
  `/models` `pricing` block) or a `prices:` override, never by the
  bundled table. The bundled "provider-prefixed key" retry exists for
  `gemini/` only, exactly as the plan's Interfaces spell it.
- **Pricing happens inside `finishTrace`** (`priceTrace` in emit.ts):
  it resolves the winner's `ProviderEntry` from `getConfig().registry`
  and the winning model from the last hop with `outcome === "ok"`, so
  aliases, explicit names and `:`-bearing model ids can never leak
  into the lookup (Review Focus 4). The whole step is wrapped in
  try/catch — a missing config or any lookup failure leaves the trace
  unpriced; it can never break the response.
- **Semantics where the spec is silent:** a request with no winning
  hop (every target failed) or no usage at all stays `costUsd: null`
  — unknown is never conflated with $0 (D8), and a failed upstream
  may still have consumed tokens we cannot see. Partial usage that
  arrived before an abort/error IS priced ("totals computed"). A
  successful JSON reply without usage is not estimated — §3.6 names
  the estimate for streams only; every provider returns usage on JSON
  replies, so a missing one stays `null` rather than a silent
  estimate.
- **Stream estimate:** `estimated` only when `status === "ok"` AND no
  `usage` event arrived — `estimateInputTokens(canonical)` for input,
  new `estimateOutputTokens(observed)` (chars/4 over text + tool-call
  argument deltas, mirroring how the input estimate counts tool
  arguments) for output; `costEstimated: true` rides the same
  TraceFinish flag the formula sets for missing cache prices.
- **`would_cost_reference` is resolved at price time, not load time:**
  parseTarget against the registry; an unresolvable value simply
  skips `wouldCostUsd`. Validating it at load would break the Task 7
  test that loads an `observe:` section naming a provider that is not
  configured.
- **`config.prices` is optional on `GatewayConfig`** so env-only mode
  and existing test literals need no change; lookup order is record
  order (YAML map order), matching "first hit wins" like routes.
- **The model-list cache now stores the raw body** (`getRawModelList`,
  same 60 s TTL, successful fetches only) and `proxyModelList`
  decodes per provider on read — `pricing` survives to live-price
  lookups while the client-facing merge is byte-identical. `source`
  (the request's API dialect) is passed through to the upstream-fetch
  log line; live-price fetches fall back to the ambient trace's
  `sourceApi`.
- **One existing assertion updated:** `"one trace per chat request"`
  expected `costUsd: null` for an ollama winner — now `costUsd: 0`
  with `priceSource: "local"`. That is the task's own feature landing
  (§3.6 step 2: ollama → local $0), not a weakened assertion; the
  rest of that case is untouched.
- **update:prices script:** `npm run update:prices -- <commit>`
  fetches via global `fetch`; the pure `buildPriceTable` is exported
  for the fixture test. In this sandbox the script's fetch had no
  egress, so the table was produced by downloading the file once with
  curl and running the same `buildPriceTable` + write path — the
  script itself is unchanged and the output is what it would have
  written.

**Files outside the Files block:**
- `src/config/env-config.ts` — `GatewayConfig.prices` (optional) and
  the `PriceOverride` interface; `lookupPrice`'s `config` parameter
  is typed `GatewayConfig`, so the field has to live there.
- `src/services/chat-stream.service.ts` — computes the §3.6 stream
  estimate and passes it + `costEstimated` into `finishTrace`
  (emit.ts cannot see the canonical request or the stream's text).
- `src/utils/token-estimate.ts` — `estimateOutputTokens`, the output
  side of the chars/4 estimate the spec's token-estimate owns.
- `src/observe/emit.test.ts` — one case covering pricing inside
  `finishTrace` at unit level.
- `src/config/yaml-config.test.ts` — parse coverage for the new
  `live_prices`/`local`/`prices:` keys (project rule: tests ship with
  the code they test).
- `tests/fixtures/prices/litellm-sample.json` — the 5-model LiteLLM
  sample Step 1 names (new file, no existing fixture touched).
- `scripts/update-prices.test.ts` — Step 1's `update-prices.test.ts`;
  placed beside the script it tests.
- **Fix round 1 (PR #71):** `finishTrace` no longer awaits pricing —
  `priceTrace` runs in the background and the trace is emitted when
  it settles, still priced before emit (a rejected lookup emits it
  unpriced). A cold `live_prices` model-list fetch can take the full
  upstream timeout, and Global Constraints forbid sink I/O on the
  request path; the function is now synchronous (`void`), so
  remaining `await finishTrace(...)` call sites are harmless no-ops.
  Tests that read traces right after a response now wait for the emit
  (`waitForTraces` / `vi.waitFor`) with assertions unchanged. Also:
  negative live prices (OpenRouter's `"-1"` for dynamically priced
  models) are treated as absent — a negative `prompt`/`completion`
  drops the live row so the lookup falls back to bundled (§3.6
  3→4); a negative cache price falls back to `input` at compute time.

## v1.3 Task 9 — Tool-call diagnostics and opt-in repair (2026-11-07)

- **Diagnostics and repairs reach the trace through the ambient
  scope** (`currentTrace()` push), the same pattern `recordNote`
  established for `notes` in Task 6 — `TraceFinish`/`emit.ts` is
  untouched, which also removes any overwrite hazard: the stream
  transform pushes repairs and held-call diagnostics mid-stream,
  before `finishTrace` runs. "diagnostics/repairs into finishTrace"
  is satisfied because they sit on the trace it emits.
- **`diagnoseArguments` treats `""` as `{}`** — the providers' "no
  arguments" convention `parseToolArguments` already encodes — so an
  empty argument string is never `invalid_json` (though a declared
  `required` list still makes it `missing_required`).
- **`fenced_json` requires JSON inside the fences**: a fence around
  non-JSON is `invalid_json` — the spec's condition is "JSON inside
  markdown fences".
- **`unknown_tool` fires whenever the call's name is absent from the
  request's `tools`** — including a request that declared no tools at
  all (the name is then trivially "not in the request's tools").
- **`repairArguments` never runs on parseable input** — the first
  check is `JSON.parse`, so for any valid JSON (including
  non-objects) it returns undefined; a repaired result must still
  parse to an object or nothing is applied (partial repairs are
  never shipped).
- **The stream transform sits AFTER the recording decoder**, so
  `observed` — and the reassembled response finish() diagnoses —
  keeps the original arguments, as §3.7 requires ("Diagnostics are
  computed on the original arguments").
- **Stream reassembly now runs unconditionally in `finish()`** (was
  gated on the ring): §3.7 needs the reassembled response for
  diagnostics either way. `snapshot()` still no-ops when the ring is
  off, so ring-off streams do no capture work beyond the reassemble
  itself.
- **Held-at-end calls are released unrepaired** — a truncated stream
  gets no repair pass — with an argument-shape diagnostic when one
  applies (a held call whose text happens to parse to an object needs
  none). Released per index in index order before `message_end`/`error`.
- **`repairArguments` lives in `tool-diagnostics.ts`** — the plan's
  Interfaces list the two produced files without assigning each
  function; diagnose and repair are §3.7's two halves and the
  non-stream path uses both, while `tool-repair-stream.ts` holds the
  canonical-event transform.
- **`repair_tool_calls` is YAML-only** (no env var): the task's Files
  block does not name `env-config.ts`, and the flag is per-provider
  in the registry, so env-only mode simply never enables repair.
- **`src/observe/trace.ts` needed no type changes** — Task 5 already
  declared `ToolCallDiagnostic`/`ToolCallRepair` exactly as the
  Interfaces spell them; the edit only drops the "(Task 9)" comments.
- **The inspector's `response.canonical` shows the ORIGINAL arguments
  on both paths** — non-stream snapshots a deep copy taken before the
  repair loop rewrites the decoded response (the stream path already
  reassembles the pre-transform `observed` events); the repair itself
  is recorded on `trace.repairs`.

## v1.3 Task 10 — `/metrics` Prometheus endpoint (2026-11-07)

- **New runtime dependency `prom-client@15.1.3`** (plan Tech Stack; latest
  stable, published 2024-06-27). `registry.metrics()` is async in v15 —
  the route awaits it.
- **`prom-client` is deprecated on npm** ("prom-client has been replaced
  by @prometheus-io/client"; registry change 2026-08-25;
  `@prometheus-io/client` was at 0.16.1, pre-1.0). Owner decision
  (2026-11-07, PR #73): keep `prom-client@15.1.3` for v1.3; follow-up
  after 1.3.0: evaluate moving to `@prometheus-io/client` once it is
  stable. Metric names and the text exposition don't depend on the
  library, so a later swap doesn't change `/metrics` for scrapers.
- **The metrics sink is created lazily** by `getMetricsSink()` — the
  `/metrics` route, the `incAux` call sites and `reportSinkError` all go
  through it, so `METRICS=off` means no prom-client objects exist at
  all. `registerSink` is now idempotent so the singleton re-registers
  after `resetSinks()` instead of silently detaching (sinks registered
  during an `emitTrace` iteration are a no-op duplication risk, not a
  bug).
- **`reportSinkError` lives in `emit.ts`** (owner decision): it calls
  `getMetricsSink()?.incSinkError` inside a try/catch — `METRICS=off` or
  an unconfigured environment makes it a no-op, and it can never throw
  inside `emitTrace`'s own catch. The store/retention modules import
  only `emit.ts`, never `metrics.ts` or `prom-client`.
- **`provider`/`model` labels come from the routed hop** — the winning
  hop when one exists, else the last attempted (spec: "the routed
  model, never the raw requested string"). A trace with zero hops
  (failure before the attempt loop) emits empty provider/model labels.
- **`babelgate_fallbacks_total` counts fallback edges**: each hop
  attempted after a failure increments `{from_provider: <previous
  hop>, outcome: <this hop's outcome>}` — the spec names the labels but
  not the counting rule; pairwise edges keep "did falling back from X
  work" answerable.
- **`babelgate_tool_call_repairs_total`'s `code` is the repair step**
  (`strip_fence`/`extract_object`/`trailing_comma`), parallel to the
  failures counter's diagnostic codes.
- **Tokens/cost count the winning hop only; `babelgate_unpriced_requests_total`
  increments only when a winner exists and `costUsd` is null** — an
  unrouted request has no routed model to label, and a failed request
  is counted by status, not as unpriced.
- **`capLabel` keeps a process-wide 100-value budget per label name**;
  `resetMetricsSink()` clears it for test isolation (same pattern as
  `resetUsageStore`).
- **Files outside the Files block:** `src/observe/sinks/usage-store.ts`
  and `src/observe/retention.ts` — the owner decision for Review Focus
  2 requires `reportSinkError("usage-store")` at the batch-dropped
  catch, the retention catch and the `getUsageStore()` disable path
  (failures that never reach `emitTrace`); `emit.test.ts` was not
  touched — existing tests still pass unchanged.

## v1.3 Task 11 — OpenTelemetry traces (2026-11-07) · OWNER GATE

- **New runtime dependencies** (plan Tech Stack; consistent
  2026-10-06 release family, every version ≥ 7 days old):
  `@opentelemetry/api@1.9.1` (api 1.10.0 is out but
  `sdk-trace-base@2.12.0` peers `>=1.3.0 <1.10.0`),
  `@opentelemetry/sdk-trace-base@2.12.0`,
  `@opentelemetry/resources@2.12.0`,
  `@opentelemetry/exporter-trace-otlp-http@0.223.0`. The
  0.300.0/3.x generation was skipped: it was published 2026-11-05
  (under 7 days) and `sdk-trace-base` has no 3.x stable — it was
  split into `sdk-trace` (3.x) plus a shim (2.12.x), so the named
  package pins the 2.x family. Follow-up: revisit when
  sdk-trace-base ships a 3.x stable or the plan switches to
  `@opentelemetry/sdk-trace`.
- **Semconv pin (Step 0):** verified every spec §3.8 attribute name
  against `open-telemetry/semantic-conventions-genai`
  `docs/gen-ai/` at `e6658f14c9d9ea0760825f029cb82e7673f48fab`
  (2026-11-06, newest commit touching docs/gen-ai on 2026-11-07).
  No renames; all four provider names (`openai`, `anthropic`,
  `gcp.gemini`, `ollama`) are well-known `gen_ai.provider.name`
  values there.
- **The sink is registered in `index.ts`** when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set — `createOtelSink` is the only
  place the @opentelemetry packages are imported (dynamic import;
  the module's other OTel references are type-only, so `import
  otel.ts` alone loads nothing). A sink that cannot initialize warns
  and disables itself. `BasicTracerProvider` + `envDetector` honour
  the standard `OTEL_*` variables (sampling, `OTEL_SERVICE_NAME`,
  `OTEL_RESOURCE_ATTRIBUTES`); the exporter reads
  `OTEL_EXPORTER_OTLP_*` itself. The provider is NOT registered as
  the global tracer provider — babelgate does not hijack a host
  app's tracing.
- **Span timing is reconstructed, not measured** (spec: spans are
  built after the fact). Server span = `[startedAt,
  startedAt + totalMs]`; each hop span = `[cursor, cursor + hop.ms]`
  chained from `startedAt`, because `Hop` records only `ms` — the
  decode/plan time before the first attempt folds into the first
  hop's span. Exception: when `trace.stream` is true the winning
  hop's `ms` is only time-to-headers (`postStream` resolves at the
  upstream headers), so its span ends at `startedAt + totalMs` —
  the request end, same as the server span — per the GenAI
  client-span convention that the span covers the call until the
  response is fully received. All other hops, and every hop of a
  non-stream trace, still chain by `ms`; an aborted stream ends the
  winner's span at request end too, with no ERROR status. Note:
  `span.end(ms)`/`startTime: ms` treat numbers below
  `performance.timeOrigin/2` as relative clock readings, so tests
  must use realistic epoch timestamps.
- **Attribute placement** (spec lists the names, not the split):
  `gen_ai.*` on the CLIENT hop spans (`gen_ai.request.model` = the
  hop's routed model; `gen_ai.response.model` = the hop model, the
  only responder we know); the SERVER span repeats request-level
  facts (`gen_ai.request.model` = the requested string, usage,
  finish reasons, winner's provider name). `babelgate.provider` =
  the configured provider NAME on each hop span and the winner on
  the server span (the type already goes in `gen_ai.provider.name`);
  `babelgate.fallback_hops` = `hops.length - 1` (0 for direct or
  unrouted requests); `babelgate.cost_usd` only when `costUsd` is
  non-null (a local $0 row emits `0`, a distinct value from
  absent).
- **Trace usage/finish facts belong to the winning hop only**: the
  last hop with outcome `ok` gets `gen_ai.usage.*`,
  `gen_ai.response.finish_reasons`, `gen_ai.response.model` and
  `gen_ai.request.max_tokens`; failed hops get `error.type`
  (upstream HTTP status for `http_error`, else the outcome name
  `timeout`/`transport`) and ERROR status. `gen_ai.request.max_tokens`
  is `maxTokensClamp.to` — the trace only carries the request's
  max_tokens when a clamp applied, so the attribute is absent
  otherwise.
- **`traceparent` becomes the remote parent** by storing the raw
  header on `trace.parentTraceparent` in observeMiddleware (spec
  name for the field), then `parseTraceparent` → `setSpanContext` —
  no global propagator needed. W3C validity rules applied
  (lowercase hex, version ≠ `ff`, non-zero ids; only the sampled
  flag is propagated). Nothing is injected upstream.
- **Aborted requests are not span errors**: `error.type` / ERROR
  status only for `status: "error"` — a client disconnect is a
  cancellation, not a server fault.
- **Content is never exported**: the sink reads only the §3.8 field
  list; `bodies` is already stripped by emitTrace, and
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is deliberately
  ignored (sentinel test).
- **Tests use a `RecordingExporter`, not `InMemorySpanExporter`** —
  the latter's `shutdown()` clears its span list, which would erase
  the flushed batch before assertions.
- **The JS OTLP/HTTP exporter posts `application/json`** (not
  protobuf) to `/v1/traces` — verified end-to-end against a local
  receiver with a real request (incoming traceparent → child server
  span → hop span, all attributes exported). The plan's Jaeger
  screenshot step stays with the conductor — Docker cannot run in
  this sandbox.
- Owner decision (2026-11-08, PR #74): the four @opentelemetry
  dependencies are accepted as pinned (api 1.9.1, sdk-trace-base
  2.12.0, resources 2.12.0, exporter-trace-otlp-http 0.223.0);
  revisit the 3.x generation after 1.3.0.
- `server.port` is not emitted: semconv marks it conditionally
  required with `server.address`, but spec §3.8 does not list it;
  the spec wins. Candidate for a later spec revision.
- An incoming `traceparent` with the sampled flag off yields
  non-recording spans (parent-based sampling, OTel default), so
  nothing is exported for that request.
- **Files outside the Files block:** none.

## v1.3 Task 12 — `/ui/api` + access control (2026-11-08)

- **`src/config/env-config.ts` needed no change** though the Files block
  names it: `UI`, `UI_ALLOW_REMOTE` and `UI_ALLOWED_HOSTS` were
  already parsed by `parseObserve` in Task 7 (env-only keys, no YAML
  `observe:` counterparts — spec §3.11 names env vars for these
  four).
- **`traceStarted(requestedModel)`** is the emit.ts `started` hook:
  `onTraceStarted(listener)` subscribes, `traceStarted` reads the
  ambient trace and fires `{id, client, sourceApi, requestedModel,
  startedAt}`. It is invoked at the one point the model is known —
  `proxyRequest` right after `modelFromPath ?? canonical.model`,
  before `planRoute`, so `/live` shows the request in flight before
  the first upstream call. Listeners are try/catch'd: a hook never
  affects a response; `resetSinks()` clears them.
- **`finished` reuses the sink fan-out** rather than a second hook:
  live.ts registers a `"live"` `TraceSink` — not in `BODY_SINKS`, so
  emitTrace hands it the bodies-stripped copy — and maps trace →
  `RequestRow` (same field mapping as usage-queries; `provider` =
  `trace.winner`, `model` = last `ok` hop's model). A disabled usage
  store does not affect the feed.
- **Files outside the Files block:** `src/services/proxy.service.ts`
  — one line calling `traceStarted(requestedModel)`. Required
  because the started event carries `requestedModel`, which only
  exists after the body is decoded; the observe middleware (the
  other candidate call site) only knows the placeholder. No other
  pipeline file was touched.
- **Error payloads** are `{error: {code, message}}` from the
  routes themselves (codes: `VALIDATION_ERROR` 400, `FORBIDDEN` 403,
  `NOT_FOUND` 404); UI=off answers the global 404's exact body
  (`{error: {message, code, status}}`) so a probe cannot tell the UI
  exists. Key failures are 403 (the plan's only non-400/404 status);
  the SPA treats 401/403 alike (Task 13's contract).
- **The accepted key styles are a subset of the proxy's**: Bearer
  and `x-api-key` only — `?key=` and `x-goog-api-key` are not
  accepted on `/ui/api`, per spec §3.9's wording and to keep keys
  out of URLs/logs.
- **The Host check compares the port-stripped hostname**
  (case-insensitive) against `localhost`, `127.0.0.1`, `[::1]` or
  `UI_ALLOWED_HOSTS` (an entry with a port matches the full Host
  header too). A missing Host is refused. Only these three literal
  loopback names — not `*.localhost` or other `127/8` addresses —
  match the spec list.
- **Envelopes the spec table left open:** list →
  `{rows, nextCursor?}` (the `UsageQueries` return verbatim);
  detail → `{row, bodies, reason?}` per the plan's interface;
  usage → `{groups}` with each `UsageGroup` plus `cacheHitRatio`
  (`cacheRead/input`, null at 0 input — `inputTokens` include
  cached tokens per §3.6's formula); plan → the `RoutePlan` itself.
  `limit` defaults to 50 with no cap; `from`/`to` default to all
  time; `group` defaults to `day`.
- **A disabled usage store answers empty** (`{rows: []}`,
  `{groups: []}`, 404 on detail): the Requests and Usage screens
  load with USAGE_STORE=off.
- **Dry-run plans pass `estimatedInputTokens: 0`**: without a body
  there is no estimate, so a `when.min_input_tokens` rule never
  matches — documented on the route.
- **Tests are colocated (`src/ui-api/*.test.ts`) and self-contained**:
  `tsconfig.json` `rootDir: ./src` bars imports of `tests/mocks` and
  `tests/fixtures`, so each file carries a minimal local msw ollama /
  catch-all counter instead of the shared upstream mocks.
- **Verified live**: `ts-node src/index.ts` against a stub ollama —
  chat → `/requests` row → detail bodies (all four stages) →
  `/usage`, `/routing`, `/routing/plan`, `/live` (started+finished
  SSE), and the three refusals (missing header 403, foreign Host
  403, OPTIONS with no access-control-allow-* headers). Transcript
  in the PR.
