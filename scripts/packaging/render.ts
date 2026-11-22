/**
 * render.ts — render the Homebrew formula and the winget manifests for
 * a release from its SHA256SUMS (v1.6 spec §3.2, Task 6, D3/D4).
 *
 *   ts-node scripts/packaging/render.ts --version <v> --sums <SHA256SUMS> [--out <dir>]
 *
 * Reads the archive hashes from the given SHA256SUMS by exact archive
 * name (`babelgate-<v>-<target>.tar.gz` / `-win-x64.zip`) — a missing
 * target exits non-zero naming it — and writes:
 *
 *   <out>/homebrew/Formula/babelgate.rb
 *   <out>/winget/manifests/d/dorrabbkhan/babelgate/<v>/dorrabbkhan.babelgate.*.yaml
 *
 * so the owner can copy Formula/ into dorrabbkhan/homebrew-babelgate
 * (D3) and manifests/ into a winget-pkgs fork (D4) unchanged. <out>
 * defaults to dist-packaging/ (gitignored); rendered output is never
 * committed. Requires Node's sha256 of nothing — the hashes come from
 * the signed SHA256SUMS, which is also what install.sh verifies.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TARBALL_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;
const ZIP_TARGET = "win-x64";
const WINGET_MANIFEST_VERSION = "1.9.0";

/** Parse GNU coreutils `<64 hex>  <name>` lines into name → hash. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

function fill(template: string, vars: Record<string, string>): string {
  const out = template.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (_whole, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        throw new Error(`render: template placeholder ${name} has no value`);
      }
      return value;
    },
  );
  if (out.includes("{{")) {
    throw new Error("render: unresolved placeholder left in output");
  }
  return out;
}

/**
 * Render every packaging manifest for <version> into <outDir>.
 * Returns the written paths. Throws naming the missing target when
 * SHA256SUMS lacks an archive this release must carry.
 */
export function render(
  version: string,
  sumsPath: string,
  outDir: string,
): string[] {
  const sums = parseSums(readFileSync(sumsPath, "utf8"));
  const shaFor = (name: string): string => {
    const sha = sums.get(name);
    if (sha === undefined) {
      throw new Error(`SHA256SUMS has no entry for ${name}`);
    }
    return sha;
  };

  const vars: Record<string, string> = { VERSION: version };
  for (const target of TARBALL_TARGETS) {
    const name = `babelgate-${version}-${target}.tar.gz`;
    vars[`SHA256_${target.toUpperCase().replace(/-/g, "_")}`] = shaFor(name);
  }
  // winget convention: InstallerSha256 in upper-case hex.
  vars.SHA256_WIN_X64_UPPER = shaFor(
    `babelgate-${version}-${ZIP_TARGET}.zip`,
  ).toUpperCase();

  const wingetDir = join(
    "winget",
    "manifests",
    "d",
    "dorrabbkhan",
    "babelgate",
    version,
  );
  const outputs: Array<[string, string]> = [
    [
      join("homebrew", "Formula", "babelgate.rb"),
      join(REPO_ROOT, "packaging", "homebrew", "babelgate.rb.tmpl"),
    ],
    ...["installer", "locale.en-US", "version"].map(
      (kind): [string, string] => [
        join(wingetDir, `dorrabbkhan.babelgate.${kind}.yaml`),
        join(
          REPO_ROOT,
          "packaging",
          "winget",
          `dorrabbkhan.babelgate.${kind}.yaml.tmpl`,
        ),
      ],
    ),
  ];

  const written: string[] = [];
  for (const [rel, tmplPath] of outputs) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fill(readFileSync(tmplPath, "utf8"), vars));
    written.push(path);
  }
  return written;
}

function usage(): never {
  console.error(
    "usage: ts-node scripts/packaging/render.ts --version <v> --sums <SHA256SUMS> [--out <dir>]",
  );
  process.exit(2);
}

if (require.main === module) {
  let version = "";
  let sums = "";
  let out = resolve(REPO_ROOT, "dist-packaging");
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--version" || arg === "--sums" || arg === "--out") && next) {
      if (arg === "--version") version = next;
      else if (arg === "--sums") sums = next;
      else out = resolve(next);
      i++;
    } else {
      usage();
    }
  }
  if (!version || !sums) usage();
  try {
    const written = render(version.replace(/^v/, ""), sums, out);
    for (const path of written) console.log(`[render] ${path}`);
    console.log(
      `[render] winget manifest schema ${WINGET_MANIFEST_VERSION}; validate with 'winget validate' before submitting`,
    );
  } catch (err) {
    console.error(`render: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
