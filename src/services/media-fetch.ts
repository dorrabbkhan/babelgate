// Called as namespace properties (http.request, not a destructured
// binding) so msw's patched module functions intercept them in tests
// — a named import captures the pre-patch original at module load.
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, isIPv4 } from "node:net";
import { createGunzip } from "node:zlib";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

/**
 * Media fetch guard (v1.5 spec §3.2.2, Review Focus 1 and 4).
 *
 * Fetches one media URL for inlining into a byte-only target:
 *  - `http:`/`https:` only.
 *  - The host's DNS answer — and every redirect hop's — is checked
 *    BEFORE the connection: every resolved address must be public
 *    unless `allowPrivate` (private/loopback/link-local/CG-NAT/ULA/
 *    metadata ranges refused). An answer that mixes public and
 *    private addresses is the rebinding signature and is refused.
 *  - The connection pins the checked address via `lookup`, so no
 *    second DNS resolution happens between the check and connect.
 *  - Redirects (301/302/303/307/308) are followed at most 3 hops,
 *    each re-checked end to end.
 *  - 20 MB and 15 s defaults; the body streams and the request is
 *    aborted the byte after the cap — never buffered unbounded.
 *  - Bytes are only ever returned to the caller; nothing here logs.
 */

export type MediaFetchReason =
  | "scheme"
  | "private"
  | "size"
  | "timeout"
  | "status"
  | "type";

export class MediaFetchError extends Error {
  constructor(
    public readonly reason: MediaFetchReason,
    public readonly host: string,
    detail?: string,
  ) {
    super(
      `media fetch failed (${reason}) for host "${host}"` +
        (detail !== undefined ? `: ${detail}` : ""),
    );
    this.name = "MediaFetchError";
  }
}

export interface FetchMediaOptions {
  allowPrivate: boolean;
  /** Default 20 MB (v1.5 spec §3.2.2). */
  maxBytes?: number;
  /** Total deadline across all hops; default 15 s. */
  timeoutMs?: number;
  /** DNS resolver — injected by tests; defaults to system DNS. */
  resolve?: (host: string) => Promise<string[]>;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ============ Private-range checks ============

function octets(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? nums
    : undefined;
}

function isPrivateV4(ip: string): boolean {
  const b = octets(ip);
  if (b === undefined) return false;
  const [a, x] = b;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 RFC 1918
    a === 127 || // loopback
    (a === 100 && x >= 64 && x <= 127) || // CG-NAT 100.64.0.0/10
    (a === 169 && x === 254) || // link-local + metadata 169.254/16
    (a === 172 && x >= 16 && x <= 31) || // 172.16.0.0/12
    (a === 192 && x === 0) || // 192.0.0.0/24 protocol assignments
    (a === 192 && x === 168) || // 192.168.0.0/16
    (a === 198 && (x === 18 || x === 19)) || // 198.18.0.0/15 benchmark
    (a === 192 && x === 0 && b[2] === 2) || // 192.0.2.0/24 doc
    (a === 198 && x === 51 && b[2] === 100) || // 198.51.100.0/24 doc
    (a === 203 && x === 0 && b[2] === 113) || // 203.0.113.0/24 doc
    a >= 240 // 240.0.0.0/4 reserved + 255.255.255.255
  );
}

/** Parse an IPv6 literal (with optional %zone) into 16 bytes. */
function v6Bytes(ip: string): number[] | undefined {
  const bare = ip.split("%")[0].toLowerCase();
  if (!bare.includes(":")) return undefined;
  // Expand the embedded-IPv4 tail ("::ffff:1.2.3.4") into two hextets.
  const lastColon = bare.lastIndexOf(":");
  const tail = bare.slice(lastColon + 1);
  const v4 = tail.includes(".") ? octets(tail) : undefined;
  const hexBody = v4 !== undefined ? bare.slice(0, lastColon) : bare;
  const halves = hexBody.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tailHextets =
    halves.length === 2
      ? halves[1] === ""
        ? []
        : halves[1].split(":")
      : [];
  const hextets = [...head, ...tailHextets];
  if (halves.length === 1 && hextets.length !== 8) return undefined;
  if (hextets.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return undefined;
  const values = hextets.map((h) => parseInt(h, 16));
  if (v4 !== undefined) values.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
  const missing = 8 - values.length;
  if (missing < 0) return undefined;
  const padded =
    halves.length === 2
      ? [
          ...values.slice(0, head.length),
          ...Array<number>(missing).fill(0),
          ...values.slice(head.length),
        ]
      : values;
  if (padded.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const h of padded) bytes.push(h >> 8, h & 0xff);
  return bytes;
}

/**
 * Private/loopback/link-local/CG-NAT/ULA/metadata/reserved per spec
 * §3.2.2. IPv6 embedded-IPv4 forms (::ffff:, ::, 64:ff9b::) fall back
 * to the IPv4 ranges.
 */
function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateV4(ip);
  const b = v6Bytes(ip);
  if (b === undefined) return false;
  const firstTenZero = b.slice(0, 10).every((n) => n === 0);
  const firstTwelveZero = b.slice(0, 12).every((n) => n === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (v4-compatible; ::1 lands
  // here as 0.0.0.1 — private under the 0/8 rule anyway).
  if (firstTwelveZero || (firstTenZero && b[10] === 0xff && b[11] === 0xff))
    return isPrivateV4(b.slice(12).join("."));
  // 64:ff9b::/96 NAT64 well-known prefix — the last 4 bytes are a v4.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((n) => n === 0)
  )
    return isPrivateV4(b.slice(12).join("."));
  return (
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || // fe80::/10 link-local
    (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) || // fec0::/10 site-local
    (b[0] & 0xfe) === 0xfc || // fc00::/7 ULA (covers fd00:ec2::/16 metadata)
    b[0] === 0xff || // multicast
    (b[0] === 0x20 && b[1] === 0x02) || // 2002::/16 6to4 (RFC 3056)
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) || // 2001:0000::/32 Teredo (RFC 4380)
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) // 2001:db8::/32 doc
  );
}

// ============ Fetch ============

interface HopResult {
  kind: "ok" | "redirect";
  body?: { data: Buffer; mimeType: string };
  location?: string;
}

async function resolveChecked(
  hostname: string,
  opts: FetchMediaOptions,
): Promise<string> {
  const resolve =
    opts.resolve ??
    (async (host: string) => {
      const records = await dnsLookup(host, { all: true });
      return records.map((r) => r.address);
    });
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new MediaFetchError("status", hostname, "name resolution failed");
  }
  if (addresses.length === 0) {
    throw new MediaFetchError("status", hostname, "name resolution failed");
  }
  if (!opts.allowPrivate) {
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new MediaFetchError(
          "private",
          hostname,
          "address resolves to a private or reserved range",
        );
      }
    }
  }
  return addresses[0];
}

function fetchHop(
  url: string,
  address: string,
  opts: Required<Pick<FetchMediaOptions, "maxBytes">>,
  deadlineMs: number,
): Promise<HopResult> {
  return new Promise<HopResult>((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const fail = (err: unknown) => {
      clearTimeout(timer);
      rejectPromise(
        err instanceof MediaFetchError
          ? err
          : new MediaFetchError("status", host, "request failed"),
      );
    };
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      rejectPromise(new MediaFetchError("timeout", host));
      return;
    }
    const request = (u.protocol === "https:" ? https.request : http.request)({
      hostname: host,
      port: u.port === "" ? undefined : Number(u.port),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: { Accept: "*/*", "Accept-Encoding": "identity" },
      // Pin the checked address — the guard's DNS answer is the one
      // connected to, so no second lookup can rebind (§3.2.2).
      // Node ≥ 20 defaults net.autoSelectFamily to true, so this is
      // called with {all:true} and must answer with an array of
      // {address, family}; the single-address callback shape then
      // throws ERR_INVALID_IP_ADDRESS, surfacing as "request failed"
      // (https://nodejs.org/api/net.html#socketconnectoptions-connectlistener,
      // https://nodejs.org/api/dns.html#dnslookuphostname-options-callback).
      lookup: (_h, options, cb) =>
        options.all
          ? cb(null, [{ address, family: isIPv4(address) ? 4 : 6 }])
          : cb(null, address, isIPv4(address) ? 4 : 6),
    });
    // Once headers arrived the response stream carries the abort:
    // destroying it tears down the connection without leaving the
    // request's parser to trip on late bytes. Pre-response there is
    // nothing to destroy but the request itself.
    let response: IncomingMessage | undefined;
    const abort = (err: MediaFetchError): void => {
      if (response === undefined) request.destroy(err);
      else {
        response.destroy();
        fail(err);
      }
    };
    const timer = setTimeout(
      () => abort(new MediaFetchError("timeout", host)),
      remaining,
    );
    request.on("error", fail);
    request.on("response", (res: IncomingMessage) => {
      response = res;
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = res.headers.location;
        res.resume();
        if (typeof location !== "string" || location === "") {
          fail(new MediaFetchError("status", host, `${status} without a Location`));
          return;
        }
        clearTimeout(timer);
        resolvePromise({ kind: "redirect", location });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        fail(new MediaFetchError("status", host, `HTTP ${status}`));
        return;
      }
      const length = Number(res.headers["content-length"]);
      if (Number.isInteger(length) && length > opts.maxBytes) {
        abort(
          new MediaFetchError(
            "size",
            host,
            `content-length ${length} exceeds the ${opts.maxBytes} byte cap`,
          ),
        );
        return;
      }
      const mimeType = (res.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (mimeType === "") {
        res.resume();
        fail(new MediaFetchError("type", host, "no content-type"));
        return;
      }
      const body: Readable =
        res.headers["content-encoding"] === "gzip"
          ? res.pipe(createGunzip())
          : res;
      const chunks: Buffer[] = [];
      let total = 0;
      body.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > opts.maxBytes) {
          abort(
            new MediaFetchError(
              "size",
              host,
              `download exceeds the ${opts.maxBytes} byte cap`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      body.on("error", fail);
      body.on("end", () => {
        clearTimeout(timer);
        resolvePromise({
          kind: "ok",
          body: { data: Buffer.concat(chunks), mimeType },
        });
      });
    });
    request.end();
  });
}

export async function fetchMedia(
  url: string,
  opts: FetchMediaOptions,
): Promise<{ data: string; mimeType: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new MediaFetchError("scheme", "url", "unparseable URL");
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      // host may be empty for data:/file: URLs — name the scheme,
      // never the URL body (a data: URL carries media bytes).
      throw new MediaFetchError(
        "scheme",
        host || u.protocol.replace(/:$/, "") || "url",
      );
    }
    const address = await resolveChecked(host, opts);
    const hop_result = await fetchHop(
      current,
      address,
      { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES },
      deadline,
    );
    if (hop_result.kind === "ok") {
      return {
        data: hop_result.body!.data.toString("base64"),
        mimeType: hop_result.body!.mimeType,
      };
    }
    if (hop === MAX_REDIRECTS) {
      throw new MediaFetchError("status", host, "too many redirects");
    }
    current = new URL(hop_result.location!, u).toString();
  }
  throw new MediaFetchError("status", url, "unreachable");
}
