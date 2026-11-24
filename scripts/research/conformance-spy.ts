/**
 * conformance-spy.ts — the forward proxy scripts/research/
 * conformance-live.sh puts between a gateway and the live provider
 * (v1.6 spec §3.10, plan Task 13b). It injects the real provider key,
 * forwards to the provider (keeping the target's base path — e.g.
 * OpenRouter's `/api`), and records each upstream request plus a
 * shape-only summary of the response as JSONL: headers redacted, every
 * `key=`/`api_key=`/`access_token=` query value replaced by
 * `<redacted>`, response text never logged.
 *
 * Run: SPY_TARGET SPY_KEY SPY_KEY_HEADER SPY_LOG SPY_PORT \
 *   node -r ts-node/register/transpile-only \
 *   scripts/research/conformance-spy.ts
 *
 * SPY_PORT=0 binds a free port; the bound port is printed as
 * `listening <port>` (the offline test reads it).
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { upstreamResponseHasReasoning } from "../../tests/process/scenarios/client";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
]);

/**
 * Every credential-carrying query parameter name the gateways use on
 * the wire (Gemini `key`, generic `api_key`, OAuth `access_token`).
 * The value is replaced wholesale — the logged URL must be safe no
 * matter which of them the request carried.
 */
export function redactQuerySecrets(url: string): string {
  return url.replace(
    /([?&])(key|api_key|access_token)=[^&]*/gi,
    "$1$2=<redacted>",
  );
}

export interface SpyOptions {
  /** e.g. https://openrouter.ai/api — the base path is kept. */
  target: string;
  key: string;
  /** "x-goog-api-key" (Gemini) or "authorization" (Chat). */
  keyHeader: string;
  logPath: string;
}

export function createSpyServer(opts: SpyOptions): http.Server {
  const targetUrl = new URL(opts.target);
  const basePath = targetUrl.pathname.replace(/\/+$/, "");
  const transport = targetUrl.protocol === "https:" ? https : http;
  const port = Number(targetUrl.port) ||
    (targetUrl.protocol === "https:" ? 443 : 80);
  const dialect = opts.keyHeader === "x-goog-api-key" ? "gemini" : "openai";

  return http.createServer((req, res) => {
    const clientUrl = req.url ?? "/";
    if (clientUrl === "/__health") {
      res.writeHead(200).end("ok");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers["content-length"];
      delete headers["connection"];
      // The spy reads the upstream body to summarize it — ask the
      // upstream for identity rather than decompressing.
      delete headers["accept-encoding"];
      headers.host = targetUrl.host;
      // The path the upstream actually receives: the target's base
      // path plus the request's path+query (fix round 3 — the
      // generated spy dropped the base path and OpenRouter 404'd).
      let upstreamPath = basePath + clientUrl;
      // Inject the real key (header, or the key= query value when the
      // gateway travels with one, as CCR does for Gemini). The
      // forwarded request carries it; the log never does.
      if (opts.keyHeader === "x-goog-api-key") {
        headers["x-goog-api-key"] = opts.key;
        if (/([?&])key=/.test(upstreamPath)) {
          upstreamPath = upstreamPath.replace(
            /([?&])key=[^&]*/,
            `$1key=${opts.key}`,
          );
        }
      } else {
        headers.authorization = `Bearer ${opts.key}`;
      }
      const safeHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          SENSITIVE_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v,
        ]),
      );
      const record = (fields: Record<string, unknown>): void => {
        fs.appendFileSync(
          opts.logPath,
          JSON.stringify({
            method: req.method,
            url: redactQuerySecrets(clientUrl),
            upstreamPath: redactQuerySecrets(upstreamPath),
            headers: safeHeaders,
            body: body.toString("utf8"),
            ...fields,
          }) + "\n",
        );
      };
      // A client that went away mid-stream must not crash the spy;
      // the record is still written when the upstream ends.
      res.on("error", () => {});
      const fwd = transport.request(
        {
          method: req.method,
          hostname: targetUrl.hostname,
          port,
          path: upstreamPath,
          headers,
        },
        (up) => {
          const upChunks: Buffer[] = [];
          let recorded = false;
          const recordOnce = (fields: Record<string, unknown>): void => {
            if (recorded) return;
            recorded = true;
            record(fields);
          };
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.on("data", (c: Buffer) => {
            upChunks.push(c);
            res.write(c);
          });
          // The entry is written when the upstream response ends —
          // still before the gateway finishes relaying the stream to
          // the client — and carries the shape-only summary the
          // client-side rule needs: whether reasoning was present.
          // The response text itself is never logged.
          up.on("end", () => {
            recordOnce({
              upstreamStatus: up.statusCode,
              response: {
                hasReasoning: upstreamResponseHasReasoning(
                  Buffer.concat(upChunks).toString("utf8"),
                  dialect,
                ),
              },
            });
            res.end();
          });
          up.on("error", (err) => {
            recordOnce({
              upstreamStatus: up.statusCode ?? 0,
              error: `upstream response error: ${String(err)}`,
            });
            res.end();
          });
          // A mid-body abort emits 'aborted' without 'end' — still
          // record the exchange.
          up.on("aborted", () => {
            recordOnce({
              upstreamStatus: up.statusCode ?? 0,
              error: "upstream response aborted mid-body",
            });
            res.end();
          });
        },
      );
      fwd.on("error", (err) => {
        record({ upstreamStatus: 0, error: String(err) });
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
        }
        res.end("spy upstream error");
      });
      fwd.write(body);
      fwd.end();
    });
  });
}

if (require.main === module) {
  const server = createSpyServer({
    target: process.env.SPY_TARGET ?? "",
    key: process.env.SPY_KEY ?? "",
    keyHeader: process.env.SPY_KEY_HEADER ?? "authorization",
    logPath: process.env.SPY_LOG ?? "",
  });
  server.listen(Number(process.env.SPY_PORT ?? 0), "127.0.0.1", () => {
    const addr = server.address() as AddressInfo;
    console.log(`listening ${addr.port}`);
  });
}
