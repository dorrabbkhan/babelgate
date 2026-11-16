# Contributing to babelgate

Thanks for your interest in contributing. This document covers setup, the
checks every change must pass, and the project's ground rules. The binding
rules for contributors (and agents) live in `AGENTS.md` — read it before
writing code.

## Setup

```bash
npm ci
cp .env.example .env   # then fill in the upstream keys you need
npm run dev            # local development server
```

You only need API keys for the providers you route to (`TARGET_API` in
env-only mode, or the providers in your `babelgate.yaml`); Ollama works
key-free against a local install.

## Checks

- `./scripts/check.sh quick` — the iteration gate: fixture guard, typecheck,
  and tests touched by your changes. Run this while you work.
- `./scripts/check.sh` — the full local gate: fixture guard, typecheck, the
  whole test suite, and the production build. Run it once before every push.
- `npm test` runs the mocked suite — **no network**. Real upstream calls
  belong only in the opt-in live suite (`npm run test:live`, needs a running
  Ollama).
- The same checks run in CI (`.github/workflows/ci.yml`) and must be green
  before a PR can be reviewed.

## Fixtures are the oracle

`tests/fixtures/` and `tests/contracts/__snapshots__/` are the source of
truth for provider wire formats (AGENTS.md rule 1). Never hand-edit them,
never run `vitest -u`, and never set `ALLOW_FIXTURE_CHANGE`. If a contract or
fixture test fails, the adapter is wrong — re-check the provider's documented
wire format rather than "fixing" the expected value.

## Adding a provider

1. Create `src/transformers/adapters/newprovider.adapter.ts` implementing the
   `ProviderAdapter` interface (`toCanonicalRequest`, `fromCanonicalRequest`,
   `toCanonicalResponse`, `fromCanonicalResponse`, `toCanonicalModelList`,
   `fromCanonicalModelList`, `toCanonicalError`, `fromCanonicalError`).
2. Register it in `adapters` and add its routes (`kind`, `method`,
   `pathPrefix`, `requestPath`) to `PROVIDER_ROUTES` in
   `src/transformers/adapters/index.ts`.
3. Add it to `VALID_PROVIDERS` in `src/config/env-config.ts` and extend
   `environment.d.ts` with its `*_API_KEY` / `*_API_BASE_URL` vars.
4. Add fixtures in `tests/fixtures/` — the contract and pair tests pick them
   up automatically and will tell you if the canonical output is wrong.

An adapter only converts between its own provider and the canonical format:
it never imports another adapter, and nothing may special-case a provider
*pair*. If a pair needs special handling, the canonical format is missing
something — say so instead of working around it.

## Contributor License Agreement

First-time contributors are asked to sign the CLA (`CLA.md`) by commenting
**"I have read the CLA Document and I hereby sign the
CLA"** on their pull request. CLA Assistant Lite records signatures on the
`cla-signatures` branch — no external service. A CLA check on your PR tells
you where you stand.

## Branch and PR conventions

- One task per branch: `v<version>/task-<N>-<short-name>` (or
  `fix/<short-name>` / `feat/<short-name>` for unplanned work).
- Tests ship in the same PR as the code they test; adapter and service
  changes are test-first.
- Keep PRs inside their task's scope — note follow-ups in the PR description
  instead of doing them.
- Commit messages follow the project's existing conventional style
  (`feat:`, `fix:`, `test:`, `chore:`, `ci:`, `docs:`).
- Fill in the PR template, including "Files outside the plan's Files block".

## Conduct and security

Be respectful and constructive. To report a vulnerability, see
`SECURITY.md` — please do not open a public issue.
