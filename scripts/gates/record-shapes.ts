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
 * forwardBaseUrl may be http: or https: (a remote Responses upstream
 * for the Codex recorder); the forwarded Host header is rewritten to
 * the forward base's host so CDNs upstream of https: bases route it.
 *
 * bodyShape keeps object keys and array lengths but replaces every
 * string with "<string:len>", every number with "<number>", every
 * boolean with "<bool>" and null with "<null>"; a non-JSON body is
 * "<non-json:len>" and an absent one is null. No values, no header
 * values and no query values are ever recorded — `path` is the
 * pathname only and `queryKeys`/`headerNames` are name lists.
 *
 * RECORD_KEEP_ENUMS=1 (off by default — default output is unchanged,
 * byte for byte) keeps the protocol-enum strings a shape alone cannot
 * show, verbatim: every `type`, `model`, `tool_choice` (string form or
 * its `type`/`name`), `include[]` entries, `reasoning.effort`,
 * `reasoning.summary`, `text.verbosity`, a tool entry's `format.syntax`
 * (`format.definition` stays "<string:len>" — it is grammar text) and
 * tool `name`s — at `tools[]`, nested namespace `tools[].tools[]` and
 * on `function_call`/`custom_tool_call` input items. The request's
 * user-agent is recorded as product tokens only (`name/version` pairs;
 * parenthesised OS/details dropped). For `text/event-stream` replies
 * the mode adds `sseEvents` ({name: count}) and `sseOrder` (first-seen
 * order) — event names only, never payloads. Field and event names
 * follow the OpenAI Responses API reference and Codex's wire code,
 * codex-rs/core/src/client.rs and codex-rs/codex-api/src/sse/
 * responses.rs (plan v1.4 wire-format rule). Keys, prompt text, tool
 * arguments, outputs, reasoning text and header values still never
 * appear.
 */
import http from "node:http";
import https from "node:https";
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

// node:http only speaks http: — pick the transport by protocol once,
// here, so an unsupported scheme fails at startup instead of throwing
// inside a request handler.
const forwardRequest =
  forward.protocol === "https:"
    ? https.request
    : forward.protocol === "http:"
      ? http.request
      : null;
if (forwardRequest === null) {
  console.error(
    `record-shapes: unsupported forward protocol "${forward.protocol}" (http: or https: only)`,
  );
  process.exit(2);
}

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

/**
 * RECORD_KEEP_ENUMS=1: opt-in enum allowlist (see the header comment).
 * Anything the env var does not name takes the v1.3 shape path, so a
 * recording made without it is byte-identical to before.
 */
const KEEP_ENUMS = process.env.RECORD_KEEP_ENUMS === "1";

function bodyShape(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return KEEP_ENUMS ? shapeKeep(parsed, {}, null) : shape(parsed);
  } catch {
    return `<non-json:${body.length}>`;
  }
}

/** What the object being shaped is, in Responses terms. */
interface KeepFrame {
  /** Element of a `tools[]` array (top-level or a namespace's own). */
  toolEntry?: boolean;
  /** The `tool_choice` object. */
  toolChoice?: boolean;
  /** The `reasoning` object. */
  reasoning?: boolean;
  /** The `text` object. */
  text?: boolean;
  /** A tool entry's `format` object. */
  toolFormat?: boolean;
}

/**
 * Is this object entry a protocol enum worth keeping verbatim? Decided
 * by the containing object: `frame` describes that object, `parent` is
 * the object itself. Everything not listed stays "<string:len>" — in
 * particular `format.definition` (grammar text), `encrypted_content`,
 * `arguments`, `output`, `description` and all prompt text.
 */
function keepString(
  key: string,
  parent: Record<string, unknown>,
  frame: KeepFrame,
): boolean {
  // Field names per the Responses API reference and Codex's wire code
  // (codex-rs/core/src/client.rs, codex-rs/codex-api/src/sse/
  // responses.rs): `type` is the discriminator everywhere — tools,
  // input items, content parts, format objects.
  if (key === "type" || key === "model" || key === "tool_choice") {
    return true;
  }
  if (key === "name") {
    if (frame.toolEntry || frame.toolChoice) return true;
    const t = parent.type;
    return t === "function_call" || t === "custom_tool_call";
  }
  if (frame.reasoning && (key === "effort" || key === "summary")) {
    return true;
  }
  if (frame.text && key === "verbosity") return true;
  if (frame.toolFormat && key === "syntax") return true;
  return false;
}

/** The frame for a child object reached under `key`. */
function childFrame(key: string, parentFrame: KeepFrame): KeepFrame {
  const frame: KeepFrame = {};
  if (key === "tool_choice") frame.toolChoice = true;
  if (key === "reasoning") frame.reasoning = true;
  if (key === "text") frame.text = true;
  if (key === "format" && parentFrame.toolEntry) frame.toolFormat = true;
  return frame;
}

/**
 * Allowlist-mode counterpart of shape(): same markers, except the
 * strings keepString() names stay verbatim. `frame`/`key` describe
 * `value`'s own position; `include[]` elements (dot-path strings such
 * as "reasoning.encrypted_content") and `tools[]` elements (whose
 * `name`s are tool names) are the only array positions that keep
 * strings.
 */
function shapeKeep(
  value: unknown,
  frame: KeepFrame,
  key: string | null,
): unknown {
  if (value === null) return "<null>";
  if (typeof value === "string") return `<string:${value.length}>`;
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<bool>";
  if (Array.isArray(value)) {
    return value.map((item) =>
      key === "include" && typeof item === "string"
        ? item
        : shapeKeep(item, key === "tools" ? { toolEntry: true } : {}, null),
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k,
        typeof v === "string" && keepString(k, obj, frame)
          ? v
          : shapeKeep(v, childFrame(k, frame), k),
      ]),
    );
  }
  return `<${typeof value}>`;
}

/**
 * Product tokens only: "codex_exec/0.169.0 (Linux 6.0; x86_64) xterm"
 * becomes "codex_exec/0.169.0" — name/version pairs survive,
 * parenthesised OS/details and bare tokens do not.
 */
function uaProducts(ua: string | string[] | undefined): string | null {
  if (typeof ua !== "string") return null;
  const tokens = ua
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((t) => t.includes("/"));
  return tokens.length > 0 ? tokens.join(" ") : null;
}

/**
 * Distinct `event:` names of an SSE stream in first-seen order with
 * per-name counts — the only thing recorded from a response body;
 * `data:` payloads are never read into the record. Event names per
 * codex-rs/codex-api/src/sse/responses.rs and the Responses streaming
 * reference.
 */
function sseSummary(text: string): {
  sseEvents: Record<string, number>;
  sseOrder: string[];
} {
  const sseEvents: Record<string, number> = {};
  const sseOrder: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("event:")) continue;
    const name = line.slice("event:".length).trim();
    if (name === "") continue;
    if (sseEvents[name] === undefined) {
      sseEvents[name] = 0;
      sseOrder.push(name);
    }
    sseEvents[name] += 1;
  }
  return { sseEvents, sseOrder };
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

    const upstream = forwardRequest(
      {
        protocol: forward.protocol,
        hostname: forward.hostname,
        port: forward.port,
        method: req.method,
        path: `${forward.pathname.replace(/\/$/, "")}${req.url}`,
        headers: {
          ...headers,
          host: forward.host,
          "content-length": body.length,
        },
      },
      (upRes) => {
        const line: Record<string, unknown> = {
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
        if (KEEP_ENUMS) {
          line.userAgent = uaProducts(req.headers["user-agent"]);
        }

        // An SSE reply's event names come from the stream itself, so
        // its line lands when the stream ends — or closes early (a
        // client abort still records the events that arrived).
        const contentType = upRes.headers["content-type"];
        if (
          KEEP_ENUMS &&
          typeof contentType === "string" &&
          contentType.startsWith("text/event-stream")
        ) {
          const sseChunks: Buffer[] = [];
          let wrote = false;
          const flush = () => {
            if (wrote) return;
            wrote = true;
            appendFileSync(
              outJsonl,
              JSON.stringify({
                ...line,
                ...sseSummary(Buffer.concat(sseChunks).toString("utf8")),
              }) + "\n",
            );
          };
          upRes.on("data", (chunk: Buffer) => sseChunks.push(chunk));
          upRes.on("end", flush);
          upRes.on("close", flush);
        } else {
          appendFileSync(outJsonl, JSON.stringify(line) + "\n");
        }

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
      const errLine: Record<string, unknown> = {
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
      };
      if (KEEP_ENUMS) {
        errLine.userAgent = uaProducts(req.headers["user-agent"]);
      }
      appendFileSync(outJsonl, JSON.stringify(errLine) + "\n");
      console.error(
        `record-shapes: forward error ${req.method} ${url.pathname}: ${
          (err as NodeJS.ErrnoException).code ?? err.name
        }`,
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("record-shapes: upstream request failed\n");
    });
    upstream.end(body);
  });
});

mkdirSync(dirname(outJsonl), { recursive: true });
server.listen(listenPort, "127.0.0.1", () => {
  console.log(`record-shapes listening on :${listenPort} -> ${forwardBase}`);
});
