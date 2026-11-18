import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MatrixReport } from "../tests/matrix/matrix-report";
import { renderMatrix, run } from "./matrix";

/**
 * The `npm run matrix` renderer and `--check` staleness gate (v1.5
 * spec §3.4, Task 11): docs/compatibility.md is regenerated from the
 * pair tests' `.out/matrix.json`; CI fails when the committed cells
 * drift.
 */

const REPORT: MatrixReport = {
  version: 1,
  cells: {
    plain: {
      openai: {
        openai: { status: "pass" },
        gemini: { status: "note", note: "inlined" },
        ollama: { status: "fail", note: "no url field" },
      },
      gemini: { openai: { status: "pass" } },
    },
    stream: {
      openai: { openai: { status: "pass" } },
    },
  },
};

const tmpDirs: string[] = [];

function tmpPaths(): { report: string; doc: string } {
  const dir = mkdtempSync(join(tmpdir(), "bg-matrix-"));
  tmpDirs.push(dir);
  const report = join(dir, "matrix.json");
  const doc = join(dir, "compatibility.md");
  writeFileSync(report, JSON.stringify(REPORT));
  return { report, doc };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("npm run matrix (v1.5 spec §3.4)", () => {
  it("renders a pass, a note and a fail cell", () => {
    const md = renderMatrix(REPORT);
    // Header: the replay badge and a link to its latest run.
    expect(md).toContain(
      "![client replay](https://github.com/dorrabbkhan/babelgate/actions/workflows/live.yml/badge.svg?event=schedule)",
    );
    expect(md).toContain("actions/workflows/live.yml");
    // One table per feature; cells render per status.
    expect(md).toContain("## Plain request (`plain`)");
    expect(md).toContain("## Streaming (`stream`)");
    expect(md).toContain(
      "| openai | ✓ | ✓ inlined | ✗ no url field | — | — |",
    );
    expect(md).toContain("| gemini | ✓ | — | — | — | — |");
  });

  it("--check passes on identical cells", () => {
    const paths = tmpPaths();
    writeFileSync(paths.doc, renderMatrix(REPORT));
    expect(run(["--check"], paths, () => {})).toBe(0);
  });

  it("--check fails with a diff on a changed cell", () => {
    const paths = tmpPaths();
    const committed = renderMatrix(REPORT).replace(
      "| openai | ✓ | ✓ inlined | ✗ no url field | — | — |",
      "| openai | ✓ | ✓ | ✗ no url field | — | — |",
    );
    writeFileSync(paths.doc, committed);
    let out = "";
    const code = run(["--check"], paths, (s) => {
      out += s + "\n";
    });
    expect(code).toBe(1);
    // A unified diff pins the changed cell.
    expect(out).toContain("--- ");
    expect(out).toContain("+++ ");
    expect(out).toContain(
      "-| openai | ✓ | ✓ | ✗ no url field | — | — |",
    );
    expect(out).toContain(
      "+| openai | ✓ | ✓ inlined | ✗ no url field | — | — |",
    );
  });

  it("header-only change is not a failure", () => {
    const paths = tmpPaths();
    const committed = renderMatrix(REPORT).replace(
      "# Compatibility matrix",
      "# Compatibility matrix (hand-edited preamble)",
    );
    writeFileSync(paths.doc, committed);
    expect(run(["--check"], paths, () => {})).toBe(0);
  });
});
