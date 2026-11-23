import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDir, parseRepoList, renderReport } from "./competitor-check";

/**
 * competitor-check (v1.6 spec §3.9): renders the monthly competitor
 * report from `gh api` JSON. The fixtures under scripts/research/
 * fixtures/ were recorded 2026-11-23 with `gh api repos/<repo>`,
 * `repos/<repo>/releases/latest` and `search/issues?q=repo:<repo>
 * is:issue is:open created:>=2026-10-24 thinking OR tool OR stream OR
 * reasoning` — the same calls competitor-check.sh makes, so the tests
 * exercise the real response shapes offline.
 */

const FIXTURES = join(__dirname, "fixtures");
const entries = parseRepoList(
  readFileSync(join(FIXTURES, "repos.txt"), "utf8"),
);
const rows = loadDir(FIXTURES, entries);

function render(presets: Parameters<typeof renderReport>[0]["presets"] = []) {
  return renderReport({
    date: "2026-11-23",
    since: "2026-10-24",
    rows,
    presets,
  });
}

describe("scripts/research/competitor-check (v1.6 §3.9)", () => {
  it("renders one row per repo", () => {
    const md = render();
    for (const { repo } of entries) {
      expect(md).toContain(`| [${repo}](https://github.com/${repo}) |`);
    }
    // Exactly one table row per listed repo — no more, no fewer.
    const tableRows = md.split("\n").filter((l) => l.startsWith("| ["));
    expect(tableRows).toHaveLength(entries.length);
    // Recorded values land in the row: stars, push date, release.
    const litellm = tableRows.find((l) => l.includes("BerriAI/litellm")) ?? "";
    expect(litellm).toContain("63.8k");
    expect(litellm).toContain("2026-11-23");
    expect(litellm).toContain("v1.110.2 (2026-11-20)");
    // And the issue-search count and first titles make the report.
    expect(md).toContain("**BerriAI/litellm** (199)");
    expect(md).toContain(
      "model_info.default_reasoning_effort is never injected",
    );
    // A repo with zero matching issues gets no title block.
    expect(md).not.toContain("**tensorzero/tensorzero** (0)");
  });

  it("archived repo flagged", () => {
    const line =
      render()
        .split("\n")
        .find((l) => l.startsWith("| [tensorzero/tensorzero")) ?? "";
    expect(line).toContain("**archived**");
    // A live repo's row carries no flag.
    const live =
      render()
        .split("\n")
        .find((l) => l.startsWith("| [BerriAI/litellm")) ?? "";
    expect(live).not.toContain("**archived**");
  });

  it("stale preset docs listed", () => {
    const md = render([
      // 53 days before the report date — stale.
      {
        name: "stale-preset",
        docs: "https://provider.example/old-docs",
        verified: "2026-10-01",
      },
      // Exactly 30 days — the boundary is not stale.
      {
        name: "edge-preset",
        docs: "https://provider.example/edge-docs",
        verified: "2026-10-24",
      },
      // Fresh — not listed.
      {
        name: "fresh-preset",
        docs: "https://provider.example/new-docs",
        verified: "2026-11-20",
      },
    ]);
    expect(md).toContain("`stale-preset`");
    expect(md).toContain("https://provider.example/old-docs");
    expect(md).toContain("2026-10-01");
    expect(md).not.toContain("edge-preset");
    expect(md).not.toContain("fresh-preset");
  });
});
