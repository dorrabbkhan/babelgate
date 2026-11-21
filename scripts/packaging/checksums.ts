/**
 * checksums.ts — write SHA256SUMS for the release archives (v1.6 spec
 * §3.2, Task 5). The release join job runs it on the directory holding
 * every `babelgate-<v>-<target>` archive; install.sh verifies a
 * download with `sha256sum --check` (or `shasum -a 256`).
 *
 *   ts-node scripts/packaging/checksums.ts <dir>
 *
 * Emits GNU coreutils text-mode format — `<64 lowercase hex><two
 * spaces><file name>` — one line per regular file in <dir> except
 * SHA256SUMS itself, sorted by file name so the file is stable
 * regardless of download order.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256sums(dir: string): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
    .map((entry) => entry.name)
    .sort();
  return names.map(
    (name) =>
      `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`,
  );
}

export function writeSha256sums(dir: string): void {
  writeFileSync(join(dir, "SHA256SUMS"), sha256sums(dir).join("\n") + "\n");
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: ts-node scripts/packaging/checksums.ts <dir>");
    process.exit(2);
  }
  writeSha256sums(dir);
  console.log(`[checksums] ${join(dir, "SHA256SUMS")}`);
}
