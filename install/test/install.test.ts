import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * install.sh / install.ps1 (v1.6 spec §3.2, Task 6, Review Focus 4).
 *
 * install.sh is exercised end-to-end against a hermetic HTTP server
 * bound to 127.0.0.1 serving a fake tar.gz (a `babelgate` shell stub
 * at the archive root, exactly like release.yml packs it) and a
 * SHA256SUMS computed in this file. BABELGATE_INSTALL_BASE_URL points
 * the script at it. PATH is pinned to /usr/bin:/bin so no cosign is
 * ever found; one test puts a failing cosign stub first on PATH to
 * prove a signature failure aborts. install.ps1 has no PowerShell in
 * CI — the tests assert the essentials of its text instead.
 */

const SCRIPT = resolve(__dirname, "..", "install.sh");
const PS1 = resolve(__dirname, "..", "install.ps1");
const VERSION = "9.9.9-test";

// The target the script computes on this machine (its uname mapping).
const TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${
  process.arch === "arm64" ? "arm64" : "x64"
}`;
const ARCHIVE = `babelgate-${VERSION}-${TARGET}.tar.gz`;

const tmpDirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "bg-install-test-"));
  tmpDirs.push(d);
  return d;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

let server: Server;
let baseUrl = "";
// basename -> content served by the fake release download endpoint.
const files = new Map<string, Buffer>();

beforeAll(async () => {
  // A fake release archive: one executable `babelgate` at the root,
  // like `tar -czf … -C dist-bin babelgate` in release.yml.
  const src = dir();
  writeFileSync(
    join(src, "babelgate"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "babelgate ${VERSION}"\nelse\n  echo "babelgate stub"\nfi\n`,
  );
  chmodSync(join(src, "babelgate"), 0o755);
  const archivePath = join(src, ARCHIVE);
  execFileSync("tar", ["-czf", archivePath, "-C", src, "babelgate"]);
  const archive = readFileSync(archivePath);

  files.set(ARCHIVE, archive);
  setSums(`${sha256(archive)}  ${ARCHIVE}`);
  files.set(`${ARCHIVE}.sigstore.json`, Buffer.from("{}"));
  files.set("SHA256SUMS.sigstore.json", Buffer.from("{}"));

  server = createServer((req, res) => {
    const name = basename((req.url ?? "").split("?")[0]);
    const body = files.get(name);
    if (body === undefined || req.method !== "GET") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", done),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// SHA256SUMS lists every release file — including ones we did not
// download — so the script must pick the one line for the archive.
function setSums(archiveLine: string): void {
  files.set(
    "SHA256SUMS",
    Buffer.from(
      [
        `${"0".repeat(64)}  babelgate-${VERSION}.cdx.json`,
        archiveLine,
        `${"f".repeat(64)}  babelgate-${VERSION}-win-x64.zip`,
        "",
      ].join("\n"),
    ),
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Async spawn: the fake release server lives in this process, and a
// spawnSync would freeze the event loop while install.sh's curl waits
// for a response — a guaranteed deadlock.
function runInstall(args: string[], path: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", [SCRIPT, ...args], {
      env: {
        // /usr/bin has curl, tar, sha256sum/shasum, awk, mktemp — and
        // no cosign (the sandbox keeps it in /usr/local/bin), so the
        // signature path is off unless a test stubs it in.
        PATH: path,
        HOME: dir(),
        BABELGATE_INSTALL_BASE_URL: baseUrl,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ status: code ?? 1, stdout, stderr }),
    );
  });
}

function fakeBin(entries: Record<string, string>): string {
  const d = dir();
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(join(d, name), body);
    chmodSync(join(d, name), 0o755);
  }
  return d;
}

// Bytes, not text: Windows PowerShell 5.1 reads a BOM-less script as
// the ANSI code page, where a UTF-8 em dash becomes the bytes `â€”`
// and the `”` ends a string early (v1.6 Task 6 patch, 2026-11-22).
// Returning line numbers makes a future em dash easy to find.
function nonAsciiLines(path: string): number[] {
  const lines = new Set<number>();
  let line = 1;
  for (const byte of readFileSync(path)) {
    if (byte > 0x7f) lines.add(line);
    if (byte === 0x0a) line += 1;
  }
  return [...lines];
}

describe("install/install.sh (v1.6 §3.2, Task 6)", () => {
  it("installs into --dir and prints version", async () => {
    const installDir = dir();
    const r = await runInstall(
      ["--version", VERSION, "--dir", installDir],
      "/usr/bin:/bin",
    );

    expect(r.status, r.stderr).toBe(0);
    const installed = join(installDir, "babelgate");
    expect(existsSync(installed)).toBe(true);
    expect(r.stdout).toContain(VERSION);
    // Nothing left behind but the binary itself.
    expect(readdirSync(installDir)).toEqual(["babelgate"]);
    // The installed binary actually runs.
    const v = spawnSync(installed, ["--version"], { encoding: "utf8" });
    expect(v.stdout.trim()).toBe(`babelgate ${VERSION}`);
  });

  it("checksum mismatch aborts and leaves no file", async () => {
    // Review Focus 4: a tampered download must abort and leave the
    // install dir exactly as it was — no partial or replaced file.
    const good = files.get(ARCHIVE);
    if (!good) throw new Error("archive missing from test server");
    setSums(`${"1".repeat(64)}  ${ARCHIVE}`);
    try {
      const installDir = dir();
      const before = readdirSync(installDir);
      const r = await runInstall(
        ["--version", VERSION, "--dir", installDir],
        "/usr/bin:/bin",
      );

      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/sha-256|checksum|mismatch/i);
      expect(readdirSync(installDir)).toEqual(before);
    } finally {
      setSums(`${sha256(good)}  ${ARCHIVE}`);
    }
  });

  it("existing binary untouched on failure", async () => {
    const good = files.get(ARCHIVE);
    if (!good) throw new Error("archive missing from test server");
    setSums(`${"1".repeat(64)}  ${ARCHIVE}`);
    try {
      const installDir = dir();
      const oldBytes = Buffer.from("previously installed babelgate");
      writeFileSync(join(installDir, "babelgate"), oldBytes);
      const r = await runInstall(
        ["--version", VERSION, "--dir", installDir],
        "/usr/bin:/bin",
      );

      expect(r.status).not.toBe(0);
      expect(readdirSync(installDir)).toEqual(["babelgate"]);
      expect(readFileSync(join(installDir, "babelgate"))).toEqual(oldBytes);
    } finally {
      setSums(`${sha256(good)}  ${ARCHIVE}`);
    }
  });

  it("unsupported arch exits with a message", async () => {
    const bin = fakeBin({
      uname: '#!/bin/sh\ncase "$1" in\n  -m) echo mips ;;\n  *) echo Linux ;;\nesac\n',
    });
    const installDir = dir();
    const r = await runInstall(
      ["--version", VERSION, "--dir", installDir],
      `${bin}:/usr/bin:/bin`,
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unsupported/i);
    expect(readdirSync(installDir)).toEqual([]);
  });

  it("cosign verification failure aborts and leaves no file", async () => {
    const bin = fakeBin({ cosign: "#!/bin/sh\nexit 1\n" });
    const installDir = dir();
    const r = await runInstall(
      ["--version", VERSION, "--dir", installDir],
      `${bin}:/usr/bin:/bin`,
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/cosign|signature/i);
    expect(readdirSync(installDir)).toEqual([]);
  });

  it("install.sh passes shellcheck", () => {
    const found = spawnSync("sh", ["-c", "command -v shellcheck"], {
      encoding: "utf8",
    });
    if (found.status !== 0) {
      // GitHub's ubuntu runners carry shellcheck; locally it may be
      // absent — warn instead of silently skipping (no it.skipIf: a
      // skipped gate is invisible in the test list).
      if (process.env.CI) {
        throw new Error(
          "shellcheck is not installed and CI is set — install it",
        );
      }
      console.warn(
        "install.test.ts: shellcheck not on PATH — shellcheck run skipped locally",
      );
      return;
    }
    const r = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  it("install.sh is ASCII only", () => {
    // A user pipes this script into a shell; keep it pure ASCII like
    // install.ps1 so no locale or code page can mangle it.
    const bad = nonAsciiLines(SCRIPT);
    expect(bad, `non-ASCII byte(s) on line(s): ${bad.join(", ")}`).toEqual(
      [],
    );
  });
});

describe("install/install.ps1 (v1.6 §3.2, Task 6)", () => {
  // No pwsh in CI or the sandbox — install.ps1 cannot be executed
  // here. Assert the essentials of the mirror; the owner/Windows leg
  // verifies it end to end.
  const text = readFileSync(PS1, "utf8");

  it("mirrors install.sh essentials", () => {
    expect(text).toContain("LOCALAPPDATA");
    expect(text).toContain("Get-FileHash");
    expect(text).toContain("sigstore.json");
    expect(text).toContain("certificate-identity-regexp");
    expect(text).toContain("BABELGATE_INSTALL_BASE_URL");
    expect(text).toContain("Set-StrictMode");
  });

  it("install.ps1 is ASCII only", () => {
    const bad = nonAsciiLines(PS1);
    expect(bad, `non-ASCII byte(s) on line(s): ${bad.join(", ")}`).toEqual(
      [],
    );
  });
});
