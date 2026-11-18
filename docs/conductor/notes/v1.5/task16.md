# v1.5 Task 16 — owner decision: "How is this different?" is answered in the docs

**Requested by the owner on 2026-11-18.** The launch (Show HN, Reddit) will meet "how is this different from
X?" as the first question. The docs must answer it before it is asked. This adds the following to Task 16's
scope; record the new files in the Task 16 `docs/decisions.md` entry (they are intentional, not drift).

## Added files and edits

- **Create `docs/comparison.md`** — "babelgate vs the alternatives", in this order:
  1. *The short answer* (≤ 6 lines): what babelgate is for, in the plan's positioning order (the translator
     you can check: published matrix, inspector, small and auditable, native-endpoint shim).
  2. *Feature comparison matrix*: rows = features, columns = babelgate, LiteLLM, Bifrost, claude-code-router,
     OpenRouter, Cloudflare AI Gateway (add OmniRoute and Kong only if every cell can be sourced). Cells: ✓ / ✗ / ◐ (partial,
     with a one-line reason) / "not documented". Source rows from `docs/research/2026-11-16-market-analysis.md` §4–§5.
     Lead with the rows where babelgate differs (published per-pair conformance, translation inspector, Ollama
     as an inbound client format, native-endpoint shim with declared gaps, signed releases/SBOM, reasoning
     carried across formats, replay of each new Claude Code/Codex release), then the table-stakes rows.
  3. *Where the others are better* — honest, not buried: providers count, distribution and community, MCP
     gateway, semantic cache, load balancing/health, team governance (SSO, budgets, audit), raw performance,
     hosted option. Say "use X if you need that".
  4. *When to pick which* (one line per tool).
  5. *Method*: date accessed, "corrections welcome — open an issue", link to the generated
     `docs/compatibility.md` for babelgate's own column.
- **`README.md`**: a short "How is this different?" section near the top (≤ 10 lines + a 4-row mini table),
  linking `docs/comparison.md`.
- **`docs/launch/v1.5-correct.md`**: a "Why not LiteLLM / claude-code-router / OpenRouter?" paragraph that
  links the page, so the FAQ is answered in the post itself.

## Rules for the comparison (the conductor will check these)

1. **A ✗ is a claim about someone else's product.** Use ✗ only when the competitor's own current docs or
   repository show the feature absent or documented as unsupported, and cite that URL in a Sources section
   (one row per ✗ and per ◐). If you cannot confirm it from a primary source, write "not documented" or
   "unverified" — never ✗. The market analysis marks many cells `?`: re-verify each against primary docs;
   do not copy its Y/N cells as facts.
2. **babelgate's own ✓ must be backed by a test or file in this repo** (name it in an HTML comment next to the
   cell or in the Sources section). A feature that is not on `main` is "planned vX.Y", not ✓. Cells that
   depend on the generated matrix link `docs/compatibility.md`.
3. **No name-and-shame.** Do not mention security incidents, acquisitions or open-issue numbers of other
   projects as a point against them. "Signed releases, SBOM and few runtime dependencies" is stated about
   babelgate only. Neutral, dated, checkable.
4. **Date every competitor column** ("as of 2026-11-DD") and say the table can go stale.
5. **Don't lead with "Claude Code / Codex on any model"** or provider count: the analysis marks them as
   table stakes. They appear in the matrix, not as differentiators.
6. Network research for competitor docs: if the sandbox cannot fetch a page, write "not verified" for that cell
   and list it under *Follow-ups noticed*; the conductor will verify and hand you the result.
