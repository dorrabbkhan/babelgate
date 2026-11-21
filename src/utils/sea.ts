/**
 * The node:sea boundary (v1.6 spec §3.2): inside a single-executable
 * build the module answers isSea()/getAsset(); anywhere else — plain
 * node, ts-node, vitest — every call is a no-op answer. require() is
 * wrapped because node:sea is absent on older runtimes, never because
 * a SEA check itself could throw.
 */

let sea: typeof import("node:sea") | undefined;
try {
  sea = require("node:sea") as typeof import("node:sea");
} catch {
  sea = undefined;
}

/** True only when running as the injected script of a SEA binary. */
export function isSea(): boolean {
  try {
    return sea?.isSea() ?? false;
  } catch {
    return false;
  }
}

/**
 * One embedded asset as a Buffer — SEA keys look like "ui/index.html"
 * (build-binary maps dist/ui under the ui/ prefix). Undefined outside
 * a SEA and for keys that are not assets.
 */
export function seaAsset(key: string): Buffer | undefined {
  if (sea === undefined || !isSea()) return undefined;
  try {
    return Buffer.from(sea.getAsset(key) as ArrayBuffer);
  } catch {
    return undefined;
  }
}
