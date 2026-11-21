import { describe, expect, it, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256sums, writeSha256sums } from "./checksums";

/**
 * checksums.ts (v1.6 spec §3.2, Task 5): the release join job runs it
 * on the directory of platform archives to produce SHA256SUMS in the
 * exact format `sha256sum` emits (`<64 hex>  <name>`), so
 * `sha256sum --check` verifies a download unchanged.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "bg-sums-"));
  tmpDirs.push(d);
  return d;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("scripts/packaging/checksums.ts (v1.6 §3.2)", () => {
  it("checksums match sha256sum format", () => {
    const d = dir();
    writeFileSync(join(d, "babelgate-1.6.0-linux-x64.tar.gz"), "linux");
    writeFileSync(join(d, "babelgate-1.6.0-win-x64.zip"), "windows");

    writeSha256sums(d);
    const lines = readFileSync(join(d, "SHA256SUMS"), "utf8")
      .trimEnd()
      .split("\n");

    // GNU coreutils format: hash, two spaces (text mode), file name.
    expect(lines).toEqual([
      `${sha256("linux")}  babelgate-1.6.0-linux-x64.tar.gz`,
      `${sha256("windows")}  babelgate-1.6.0-win-x64.zip`,
    ]);
  });

  it("sorted by filename", () => {
    const d = dir();
    // Insertion order is not sorted order.
    for (const name of [
      "babelgate-1.6.0-win-x64.zip",
      "babelgate-1.6.0-darwin-arm64.tar.gz",
      "babelgate-1.6.0-linux-arm64.tar.gz",
    ]) {
      writeFileSync(join(d, name), name);
    }

    expect(sha256sums(d).map((line) => line.slice(66))).toEqual([
      "babelgate-1.6.0-darwin-arm64.tar.gz",
      "babelgate-1.6.0-linux-arm64.tar.gz",
      "babelgate-1.6.0-win-x64.zip",
    ]);
  });
});
