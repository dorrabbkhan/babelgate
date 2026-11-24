import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The replay-backed mock upstream (v1.6 spec §3.2): each route answers
 * a recorded provider body verbatim from a file under
 * tests/fixtures/streams/ or tests/process/replays/ — the upstream half
 * of the process suite stays as faithful as the in-process msw mocks.
 * Binds 127.0.0.1:0 (IPv4 explicitly, 0192cad); no external network.
 */

export interface MockRoute {
  method: string;
  path: string | RegExp;
  reply: {
    status: number;
    headers: Record<string, string>;
    bodyFile: string;
    /** The 502 error body when bodyFile isn't on disk — e.g. a
     * non-streaming twin the conductor has not recorded yet (the
     * mock never substitutes a different replay for it). */
    missingBodyFile?: string;
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Absolute path of the body file this request was served — lets
   * the verdict read the upstream response bytes (mock mode only;
   * unset when no route matched or the file was missing). */
  responseFile?: string;
  /** Shape-only response summary — set in live mode by the spy's
   * JSONL entry (never the response text). */
  response?: { hasReasoning?: boolean };
}

export interface RunningMockUpstream {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const REPO = join(__dirname, "..", "..");

/**
 * A bodyFile resolves, in order, as an absolute path, repo-relative,
 * tests/-relative, then under the two replay roots the plan names —
 * so "openai/text.sse" finds tests/fixtures/streams/ and
 * "openai/text.json" finds tests/process/replays/ (replays resolve
 * before the streams corpus — its <case>.json files are event
 * metadata, not wire bodies).
 */
function resolveBodyFile(bodyFile: string): string {
  const candidates = isAbsolute(bodyFile)
    ? [bodyFile]
    : [
        join(REPO, bodyFile),
        join(REPO, "tests", bodyFile),
        // replays before streams: a bare "openai/text.json" would
        // otherwise hit the streams corpus's meta files
        // (<case>.json holds expectedEvents, not a wire body)
        join(REPO, "tests", "process", "replays", bodyFile),
        join(REPO, "tests", "fixtures", "streams", bodyFile),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`mock upstream body file not found: ${bodyFile}`);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

export function startMockUpstream(
  routes: MockRoute[],
): Promise<RunningMockUpstream> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      requests.push({
        method: req.method ?? "",
        url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const route = routes.find(
        (r) =>
          r.method === req.method &&
          (typeof r.path === "string"
            ? r.path === url
            : r.path.test(url)),
      );
      if (route === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `no mock route for ${req.method} ${url}`,
          }),
        );
        return;
      }
      let file: string;
      try {
        file = resolveBodyFile(route.reply.bodyFile);
      } catch (err) {
        // A replay the run has not recorded yet is a clear 502 — never
        // a different replay standing in for it (fix round 3: a
        // non-streaming call must never get SSE bytes).
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              route.reply.missingBodyFile ??
              (err instanceof Error ? err.message : String(err)),
          }),
        );
        return;
      }
      requests[requests.length - 1].responseFile = file;
      const headers = { ...route.reply.headers };
      if (
        !hasHeader(headers, "content-length") &&
        !hasHeader(headers, "transfer-encoding")
      ) {
        headers["content-length"] = String(statSync(file).size);
      }
      res.writeHead(route.reply.status, headers);
      createReadStream(file).pipe(res);
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("mock upstream failed to bind"));
        return;
      }
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            // Idle keep-alive sockets would otherwise hold the close.
            server.closeIdleConnections();
            server.close((err) =>
              err ? rejectClose(err) : resolveClose(),
            );
          }),
      });
    });
  });
}
