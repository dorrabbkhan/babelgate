import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, START_MARKER, END_MARKER } from "./build-site";

/**
 * v1.6 Task 16 (spec §3.8): the landing page's table, "verified by
 * hand" rows and "last checked" line are generated from the pair-test
 * matrix, the recipe headers and the latest client replay — never
 * typed by hand (the spec's honesty rule). These tests drive
 * `scripts/site/build-site.ts` against temp inputs and the committed
 * `site/` source.
 */

const ROOT = join(__dirname, "..", "..");

interface Fixture {
  dir: string;
  site: string;
  out: string;
  matrix: string;
  compat: string;
  recipes: string;
  replay: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "build-site-"));
  const f: Fixture = {
    dir,
    site: join(dir, "index.html"),
    out: join(dir, "dist-site"),
    matrix: join(dir, "matrix.json"),
    compat: join(dir, "compatibility.md"),
    recipes: join(dir, "recipes"),
    replay: join(dir, "client-replay"),
  };
  mkdirSync(f.recipes);
  mkdirSync(f.replay);
  // The real template: empty matrix markers, all chrome present.
  f.site = join(ROOT, "site", "index.html");
  return f;
}

function argv(f: Fixture): string[] {
  return [
    "--site", f.site,
    "--out", f.out,
    "--matrix", f.matrix,
    "--compat", f.compat,
    "--recipes", f.recipes,
    "--replay-dir", f.replay,
  ];
}

/** A matrix where `pairs` maps feature → source → target → status. */
function writeMatrix(f: Fixture, cells: unknown): void {
  writeFileSync(f.matrix, JSON.stringify({ version: 1, cells }));
}

const PASS = { status: "pass" };
const FAIL = { status: "fail", note: "nope" };

function fullRow(status = PASS): Record<string, unknown> {
  return {
    openai: status,
    gemini: status,
    ollama: status,
    anthropic: status,
    responses: status,
  };
}

function writeCompat(f: Fixture, header = ""): void {
  const table =
    "| source \\ target | openai | gemini | ollama | anthropic | responses |\n" +
    "| --- | --- | --- | --- | --- | --- |\n" +
    "| anthropic | ✓ | ✓ | ✓ | ✓ | ✓ |\n";
  const sections = [
    "## Plain request (`plain`)",
    "## Streaming (`stream`)",
    "## Tool calls (`tools`)",
    "## Tool calls (streaming) (`stream_tools`)",
  ]
    .map((t) => `${t}\n\n${table}`)
    .join("\n");
  writeFileSync(
    f.compat,
    `# Compatibility matrix\n\n${header}\n\n${sections}`,
  );
}

function build(f: Fixture): string {
  const rc = run(argv(f), undefined, () => {});
  expect(rc).toBe(0);
  return readFileSync(join(f.out, "index.html"), "utf8");
}

describe("build-site", () => {
  it("table rows come from matrix json", () => {
    const f = makeFixture();
    writeMatrix(f, {
      plain: { anthropic: fullRow(), openai: fullRow() },
      stream: { anthropic: fullRow(), openai: fullRow() },
      tools: { anthropic: fullRow(), openai: fullRow() },
      stream_tools: {
        anthropic: fullRow(),
        openai: { ...fullRow(), gemini: FAIL },
      },
    });
    writeCompat(f);
    const html = build(f);

    // anthropic row: all five targets checked.
    const anthropicRow = html
      .split("\n")
      .find((l) => l.includes("<td>Claude Code"));
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow!.match(/class="ck"/g)).toHaveLength(5);

    // openai row: stream_tools vs gemini failed → one miss, four checks.
    const openaiRow = html
      .split("\n")
      .find((l) => l.includes("<td>OpenAI-format apps"));
    expect(openaiRow).toBeDefined();
    expect(openaiRow!.match(/class="ck"/g)).toHaveLength(4);
    expect(openaiRow!.match(/class="miss"/g)).toHaveLength(1);

    // ollama has no recorded cells → its row is omitted entirely.
    expect(html).not.toContain("<td>Ollama apps");
  });

  it("table rows also render from compatibility.md", () => {
    const f = makeFixture();
    // no matrix.json at all — the compat doc's cells drive the table.
    writeCompat(f);
    const html = build(f);
    const row = html.split("\n").find((l) => l.includes("<td>Claude Code"));
    expect(row).toBeDefined();
    expect(row!.match(/class="ck"/g)).toHaveLength(5);
  });

  it("no hand-typed check marks outside markers", () => {
    const f = makeFixture();
    writeMatrix(f, {
      plain: { anthropic: fullRow() },
      stream: { anthropic: fullRow() },
      tools: { anthropic: fullRow() },
      stream_tools: { anthropic: fullRow() },
    });
    writeCompat(f);
    const html = build(f);

    const start = html.indexOf(START_MARKER);
    const end = html.indexOf(END_MARKER);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const outside =
      html.slice(0, start) + html.slice(end + END_MARKER.length);
    expect(outside).not.toContain("✓");
    expect(outside).not.toContain('class="ck"');
    // And the committed template itself carries no check marks.
    const source = readFileSync(f.site, "utf8");
    expect(source).not.toContain("✓");
  });

  it("recipe-only client marked verified by hand", () => {
    const f = makeFixture();
    writeMatrix(f, {
      plain: { anthropic: fullRow() },
      stream: { anthropic: fullRow() },
      tools: { anthropic: fullRow() },
      stream_tools: { anthropic: fullRow() },
    });
    writeCompat(f);
    writeFileSync(
      join(f.recipes, "open-webui.md"),
      "# Recipe: Open WebUI on any backend through babelgate\n\n" +
        "> **Verified:** Open WebUI v9.9.9 through `babelgate --provider x`,\n" +
        "> 2026-11-24 — chat and one tool call.\n",
    );
    writeFileSync(
      join(f.recipes, "cursor.md"),
      "# Recipe: Cursor on any backend through babelgate\n\n" +
        "> **Not verified end to end:** written against Cursor's docs.\n",
    );
    const html = build(f);
    const row = html
      .split("\n")
      .find((l) => l.includes("<td>Open WebUI"));
    expect(row).toBeDefined();
    expect(row).toContain("verified by hand on v9.9.9");
    // Not-verified recipes are omitted, not marked.
    expect(html).not.toContain("<td>Cursor");
  });

  it("no internal docs linked", () => {
    const f = makeFixture();
    writeMatrix(f, {
      plain: { anthropic: fullRow() },
      stream: { anthropic: fullRow() },
      tools: { anthropic: fullRow() },
      stream_tools: { anthropic: fullRow() },
    });
    writeCompat(f);
    const html = build(f);
    for (const forbidden of [
      "docs/superpowers",
      "roadmap.md",
      "decisions.md",
      "docs/conductor",
      "docs/research",
      "docs/launch",
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("no external script or font requests", () => {
    const f = makeFixture();
    const html = build(f);
    // No script tags with src, no external stylesheets/fonts/imports,
    // no external images/iframes — the page must load fully offline.
    expect(html).not.toMatch(/<script[^>]+src\s*=/i);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*"https?:/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/<(?:img|iframe|video|source)[^>]+src\s*=\s*"https?:/i);
    // Every link goes to the repo or a provider key page — never a CDN,
    // tracker or docs-site host.
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      // Anchors, data: URIs and same-origin relative paths load nothing.
      if (href.startsWith("#") || href.startsWith("data:")) continue;
      if (!href.includes(":")) continue;
      expect(href).toMatch(
        /^https:\/\/(github\.com\/dorrabbkhan\/babelgate|dorrabbkhan\.github\.io\/babelgate|aistudio\.google\.com)/,
      );
    }
  });

  it("reduced-motion rule present", () => {
    const css = readFileSync(join(ROOT, "site", "style.css"), "utf8");
    expect(css).toContain("prefers-reduced-motion");
    const f = makeFixture();
    const html = build(f);
    expect(html).toContain('href="style.css"');
  });
});
