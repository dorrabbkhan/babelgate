/**
 * record-shapes.ts — shape-recording reverse proxy for client-evidence
 * gates (spec §3.10). Sits in front of babelgate, forwards every
 * request unchanged, and appends one JSON line per request to the
 * output file:
 *
 *   {method, path, queryKeys, headerNames, bodyShape, status,
 *    contentType}
 *
 *   ts-node scripts/gates/record-shapes.ts <listenPort> <forwardBaseUrl> <outJsonl>
 *
 * bodyShape keeps object keys and array lengths but replaces every
 * string with "<string:len>", every number with "<number>", every
 * boolean with "<bool>" and null with "<null>"; a non-JSON body is
 * "<non-json:len>" and an absent one is null. No values, no header
 * values and no query values are ever recorded — `path` is the
 * pathname only and `queryKeys`/`headerNames` are name lists.
 */
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [portArg, forwardBase, outJsonl] = process.argv.slice(2);
const listenPort = Number(portArg);
if (
  !Number.isInteger(listenPort) ||
  listenPort <= 0 ||
  forwardBase === undefined ||
  outJsonl === undefined
) {
  console.error(
    "usage: record-shapes.ts <listenPort> <forwardBaseUrl> <outJsonl>",
  );
  process.exit(2);
}

const forward = new URL(forwardBase);

/** Headers that belong to this hop only — never forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Replace values with shape markers; keep keys and array lengths. */
function shape(value: unknown): unknown {
  if (value === null) return "<null>";
  if (typeof value === "string") return `<string:${value.length}>`;
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<bool>";
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        shape(v),
      ]),
    );
  }
  return `<${typeof value}>`;
}

function bodyShape(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return shape(JSON.parse(body.toString("utf8")));
  } catch {
    return `<non-json:${body.length}>`;
  }
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://recorder.invalid");
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
      ),
    );

    const upstream = http.request(
      {
        protocol: forward.protocol,
        hostname: forward.hostname,
        port: forward.port,
        method: req.method,
        path: `${forward.pathname.replace(/\/$/, "")}${req.url}`,
        headers: { ...headers, "content-length": body.length },
      },
      (upRes) => {
        const line = {
          method: req.method,
          path: url.pathname,
          queryKeys: [...new Set([...url.searchParams.keys()])],
          headerNames: Object.keys(req.headers).map((n) =>
            n.toLowerCase(),
          ),
          bodyShape: bodyShape(body),
          status: upRes.statusCode,
          contentType: upRes.headers["content-type"] ?? null,
        };
        appendFileSync(outJsonl, JSON.stringify(line) + "\n");

        res.writeHead(
          upRes.statusCode ?? 502,
          Object.fromEntries(
            Object.entries(upRes.headers).filter(
              ([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
            ),
          ),
        );
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      appendFileSync(
        outJsonl,
        JSON.stringify({
          method: req.method,
          path: url.pathname,
          queryKeys: [...new Set([...url.searchParams.keys()])],
          headerNames: Object.keys(req.headers).map((n) =>
            n.toLowerCase(),
          ),
          bodyShape: bodyShape(body),
          status: 0,
          contentType: null,
          forwardError: String(
            (err as NodeJS.ErrnoException).code ?? err.message,
          ),
        }) + "\n",
      );
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.end(body);
  });
});

mkdirSync(dirname(outJsonl), { recursive: true });
server.listen(listenPort, "127.0.0.1", () => {
  console.log(`record-shapes listening on :${listenPort} -> ${forwardBase}`);
});
