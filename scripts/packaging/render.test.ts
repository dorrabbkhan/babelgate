import { describe, expect, it, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { render } from "./render";

/**
 * scripts/packaging/render.ts (v1.6 spec §3.2, Task 6): renders the
 * Homebrew formula and the three winget manifests from a release's
 * SHA256SUMS. No `brew` or `winget validate` runs in CI — the tests
 * pin the rendered fields and value shapes against the winget 1.9
 * manifest layout instead.
 */

const VERSION = "9.9.9-test";
const DOWNLOAD = "https://github.com/dorrabbkhan/babelgate/releases/download";

const TARBALLS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;
const ZIP = "win-x64";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "bg-render-test-"));
  tmpDirs.push(d);
  return d;
}

function hashOf(name: string): string {
  return createHash("sha256").update(`content of ${name}`).digest("hex");
}

// A SHA256SUMS like the release's: every archive plus the SBOM, sorted
// by file name (scripts/packaging/checksums.ts format).
function writeSums(names: string[]): string {
  const path = join(dir(), "SHA256SUMS");
  writeFileSync(
    path,
    names
      .slice()
      .sort()
      .map((n) => `${hashOf(n)}  ${n}`)
      .join("\n") + "\n",
  );
  return path;
}

function allFiles(): string[] {
  return [
    ...TARBALLS.map((t) => `babelgate-${VERSION}-${t}.tar.gz`),
    `babelgate-${VERSION}-${ZIP}.zip`,
    `babelgate-${VERSION}.cdx.json`,
  ];
}

describe("scripts/packaging/render.ts (v1.6 §3.2)", () => {
  it("formula has four platform urls with sums", () => {
    const out = dir();
    render(VERSION, writeSums(allFiles()), out);

    const formula = readFileSync(
      join(out, "homebrew", "Formula", "babelgate.rb"),
      "utf8",
    );
    for (const target of TARBALLS) {
      const name = `babelgate-${VERSION}-${target}.tar.gz`;
      expect(formula).toContain(`${DOWNLOAD}/v${VERSION}/${name}`);
      expect(formula).toContain(`sha256 "${hashOf(name)}"`);
    }
    // The formula's own smoke test runs the binary's --version.
    expect(formula).toContain("--version");
    // And nothing points at a target we never publish (match the full
    // file name — "darwin-x64" ends in the substring "win-x64").
    expect(formula).not.toContain(`babelgate-${VERSION}-win-x64`);
  });

  it("winget manifest validates against schema 1.9 shape", () => {
    const out = dir();
    render(VERSION, writeSums(allFiles()), out);

    const base = join(
      out,
      "winget",
      "manifests",
      "d",
      "dorrabbkhan",
      "babelgate",
      VERSION,
    );
    const installer = parse(
      readFileSync(join(base, "dorrabbkhan.babelgate.installer.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(installer.PackageIdentifier).toBe("dorrabbkhan.babelgate");
    expect(installer.PackageVersion).toBe(VERSION);
    expect(installer.InstallerType).toBe("zip");
    expect(installer.NestedInstallerType).toBe("portable");
    expect(installer.ManifestType).toBe("installer");
    expect(installer.ManifestVersion).toBe("1.9.0");
    const nested = installer.NestedInstallerFiles as Record<
      string,
      unknown
    >[];
    expect(nested).toHaveLength(1);
    expect(nested[0].RelativeFilePath).toBe("babelgate.exe");
    expect(nested[0].PortableCommandAlias).toBe("babelgate");
    const installers = installer.Installers as Record<string, unknown>[];
    expect(installers).toHaveLength(1);
    expect(installers[0].Architecture).toBe("x64");
    expect(installers[0].InstallerUrl).toBe(
      `${DOWNLOAD}/v${VERSION}/babelgate-${VERSION}-${ZIP}.zip`,
    );
    // winget convention: InstallerSha256 in upper-case hex.
    expect(installers[0].InstallerSha256).toMatch(/^[0-9A-F]{64}$/);
    expect(installers[0].InstallerSha256).toBe(
      hashOf(`babelgate-${VERSION}-${ZIP}.zip`).toUpperCase(),
    );

    const version = parse(
      readFileSync(join(base, "dorrabbkhan.babelgate.version.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(version.PackageIdentifier).toBe("dorrabbkhan.babelgate");
    expect(version.PackageVersion).toBe(VERSION);
    expect(version.ManifestType).toBe("version");
    expect(version.ManifestVersion).toBe("1.9.0");

    const locale = parse(
      readFileSync(
        join(base, "dorrabbkhan.babelgate.locale.en-US.yaml"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(locale.PackageIdentifier).toBe("dorrabbkhan.babelgate");
    expect(locale.PackageVersion).toBe(VERSION);
    expect(locale.PackageLocale).toBe("en-US");
    expect(locale.ManifestType).toBe("defaultLocale");
    expect(locale.ManifestVersion).toBe("1.9.0");
    expect(typeof locale.ShortDescription).toBe("string");
    expect(locale.Publisher).toBe("dorrabbkhan");
  });

  it("winget manifests carry the schema header on line 1", () => {
    const out = dir();
    render(VERSION, writeSums(allFiles()), out);

    const base = join(
      out,
      "winget",
      "manifests",
      "d",
      "dorrabbkhan",
      "babelgate",
      VERSION,
    );
    // winget validate warns "Schema header not found" and exits
    // non-zero without this first line (wingetcreate writes it).
    const headers: Record<string, string> = {
      "dorrabbkhan.babelgate.installer.yaml":
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.9.0.schema.json",
      "dorrabbkhan.babelgate.locale.en-US.yaml":
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.9.0.schema.json",
      "dorrabbkhan.babelgate.version.yaml":
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.9.0.schema.json",
    };
    for (const [file, header] of Object.entries(headers)) {
      const firstLine = readFileSync(join(base, file), "utf8").split("\n")[0];
      expect(firstLine).toBe(header);
    }
  });

  it("a missing target exits non-zero naming it", () => {
    const missing = `babelgate-${VERSION}-linux-arm64.tar.gz`;
    const sums = writeSums(allFiles().filter((n) => n !== missing));
    const out = dir();

    expect(() => render(VERSION, sums, out)).toThrow(/linux-arm64/);

    const cli = spawnSync(
      process.execPath,
      [
        resolve("node_modules/ts-node/dist/bin.js"),
        resolve("scripts/packaging/render.ts"),
        "--version",
        VERSION,
        "--sums",
        sums,
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(cli.status).not.toBe(0);
    expect(cli.stderr + cli.stdout).toContain("linux-arm64");
  });
});
