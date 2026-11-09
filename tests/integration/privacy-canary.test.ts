import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { get } from "node:http";
import { stdSerializers } from "pino";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { setupServer } from "msw/node";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { resetModelListCache } from "../../src/services/models.service";
import {
  registerSink,
  resetSinks,
  type TraceSink,
} from "../../src/observe/emit";
import { createLogSink } from "../../src/observe/sinks/log";
import { getBodyRing } from "../../src/observe/sinks/body-ring";
import {
  getUsageStore,
  resetUsageStore,
} from "../../src/observe/sinks/usage-store";
import { resetMetricsSink } from "../../src/observe/sinks/metrics";
import { createOtelSink } from "../../src/observe/sinks/otel";
import type { RequestTrace } from "../../src/observe/trace";
import { logger } from "../../src/utils/logger";
import {
  upstreamHandlers,
  capturedRequests,
  capturedHeaders,
  responseOverrides,
  resetCaptured,
  resetOverrides,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";

/**
 * The privacy canary (spec §4.1, D3): unique strings planted in a
 * prompt, a tool argument and a completion — plus a fake provider key
 * — may only ever reach the in-memory body ring (and the `bodies`
 * table when LOG_BODIES=true). Every other surface — the log,
 * /metrics, OTel spans, /ui/api/live, /ui/api/routing,
 * /ui/api/requests and the `requests` table — carries routing and
 * usage facts, never content.
 *
 * All sinks are on: log, body-ring, usage-store, metrics, an OTel
 * sink with an in-memory exporter, and the live SSE feed.
 */

const server = setupServer(...upstreamHandlers);
let httpServer: Server;

const UI = { "x-babelgate-ui": "1" };

/** Four distinct sentinels so a leak names its origin. */
const CANARY_PROMPT = "CANARY-PROMPT-xK7f2Qz9";
const CANARY_TOOLARG = "CANARY-TOOLARG-mB4v8Lp1";
const CANARY_COMPLETION = "CANARY-COMPLETION-wR6t3Yd5";
const CANARY_KEY = "CANARY-KEY-nZ9s2Hj4";
const CONTENT_CANARIES = [CANARY_PROMPT, CANARY_TOOLARG, CANARY_COMPLETION];
const ALL_CANARIES = [...CONTENT_CANARIES, CANARY_KEY];

const CHAT_BODY = {
  model: "gpt-4",
  messages: [{ role: "user", content: `echo ${CANARY_PROMPT}` }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
};

/** The upstream reply plants canaries in content and tool arguments. */
function canaryCompletion(): object {
  return {
    id: "chatcmpl-canary",
    object: "chat.completion",
    created: 1,
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `done ${CANARY_COMPLETION}`,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: `{"city":"${CANARY_TOOLARG}"}`,
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

/**
 * The in-memory exporter: InMemorySpanExporter's own shutdown() resets
 * its span list, so the sink's shutdown flush would erase the evidence
 * — this one records and never forgets (same pattern as otel.test.ts).
 */
type ExportResult = Parameters<
  Parameters<SpanExporter["export"]>[1]
>[0];
class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(
    batch: ReadableSpan[],
    done: (result: ExportResult) => void,
  ): void {
    this.spans.push(...batch);
    done({ code: 0 }); // ExportResultCode.SUCCESS
  }
  async shutdown(): Promise<void> {}
}

/** Every trace emitTrace fans out — to learn the requestId. */
const traces: RequestTrace[] = [];
const recorder: TraceSink = {
  name: "recorder",
  accept: (t) => traces.push(t),
};

async function waitForTraces(n: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (traces.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The log surface: every logger method's serialized call args. */
const LOG_METHODS = ["fatal", "error", "warn", "info", "debug"] as const;
function spyOnLogger(): void {
  for (const m of LOG_METHODS) vi.spyOn(logger, m);
}
function logText(): string {
  // pino-http's calls carry the raw Express req/res; the emitted line
  // holds only what the serializers produce (id, method, url, redacted
  // headers — never req.body). Serialize the way the wire sees it.
  const calls = LOG_METHODS.flatMap(
    (m) => vi.mocked(logger[m]).mock.calls,
  );
  const emitted = calls.map((args) =>
    args.map((a) => {
      if (a === null || typeof a !== "object") return a;
      const o = { ...(a as Record<string, unknown>) };
      for (const [key, ser] of [
        ["req", stdSerializers.req],
        ["res", stdSerializers.res],
        ["err", stdSerializers.err],
      ] as const) {
        if (o[key] !== undefined) {
          try {
            o[key] = (ser as (v: unknown) => unknown)(o[key]);
          } catch {
            // not that kind of value — leave it as logged
          }
        }
      }
      return o;
    }),
  );
  return JSON.stringify(emitted);
}

interface LiveFeed {
  status: number;
  text: () => string;
  close: () => void;
}

/** Connect to /ui/api/live on the real server (the live.test.ts shape). */
async function connectLive(): Promise<LiveFeed> {
  const port = (httpServer.address() as AddressInfo).port;
  return new Promise<LiveFeed>((resolve, reject) => {
    const req = get(
      {
        host: "127.0.0.1",
        port,
        path: "/ui/api/live",
        headers: UI,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        resolve({
          status: res.statusCode ?? 0,
          text: () => text,
          close: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
  });
}

async function waitForSseFinished(
  sse: LiveFeed,
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (
    !sse.text().includes("event: finished") &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Drive one canary chat request; returns the emitted trace's id. */
async function driveCanaryChat(): Promise<string> {
  const before = traces.length;
  const res = await request(app)
    .post("/v1/chat/completions")
    .send(CHAT_BODY as object);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await waitForTraces(before + 1);
  getUsageStore()!.flush();
  return traces[traces.length - 1].requestId;
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "bypass" });
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
});

beforeEach(() => {
  process.env.TARGET_API = "openai";
  process.env.OPENAI_API_BASE_URL = MOCK_BASE_URLS.openai;
  process.env.OPENAI_API_KEY = CANARY_KEY;
  process.env.UPSTREAM_RETRIES = "0";
  process.env.USAGE_DB = ":memory:";
  process.env.USAGE_STORE = "on";
  responseOverrides.openai = { status: 200, body: canaryCompletion() };
  resetModelListCache();
  resetConfig();
  resetSinks();
  resetMetricsSink();
  registerSink(createLogSink());
  registerSink(recorder);
  // The ring singleton survives resetSinks() unregistered — re-add it.
  const ring = getBodyRing();
  if (ring !== undefined) registerSink(ring);
  resetUsageStore();
  getUsageStore();
  traces.length = 0;
  spyOnLogger();
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  delete process.env.TARGET_API;
  delete process.env.OPENAI_API_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.USAGE_DB;
  delete process.env.USAGE_STORE;
  delete process.env.LOG_BODIES;
  resetUsageStore();
  vi.restoreAllMocks();
  resetConfig();
});

afterAll(() => {
  server.close();
  httpServer.close();
});

describe("privacy canary (spec §4.1)", () => {
  it("canary reaches only the ring", async () => {
    const exporter = new RecordingExporter();
    const otel = await createOtelSink(exporter);
    registerSink(otel);

    const sse = await connectLive();
    expect(sse.status).toBe(200);

    const requestId = await driveCanaryChat();
    await waitForSseFinished(sse);
    const liveText = sse.text();
    sse.close();

    // Sanity: the canaries really were in flight — the prompt body and
    // the key reached the upstream.
    expect(JSON.stringify(capturedRequests.openai)).toContain(
      CANARY_PROMPT,
    );
    expect(
      JSON.stringify(
        capturedHeaders.openai.map((h) => Object.fromEntries(h)),
      ),
    ).toContain(CANARY_KEY);

    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    const routing = await request(app).get("/ui/api/routing").set(UI);
    expect(routing.status).toBe(200);
    const requestsApi = await request(app)
      .get("/ui/api/requests")
      .set(UI);
    expect(requestsApi.status).toBe(200);
    expect(requestsApi.body.rows.length).toBeGreaterThan(0);

    // shutdown() flushes the batch processor to the recording exporter.
    await otel.shutdown();
    expect(exporter.spans.length).toBeGreaterThanOrEqual(2);

    const store = getUsageStore()!;
    const tableRows = store.listRequests({ limit: 500 }).rows;
    const detail = store.getRequest(requestId);
    expect(detail).toBeDefined();

    // An arbitrary third-party sink only ever sees the stripped copy.
    expect(traces[0].bodies).toBeUndefined();

    const haystacks: Record<string, string> = {
      log: logText(),
      metrics: metrics.text,
      otelSpans: JSON.stringify(
        exporter.spans.map((s) => ({
          name: s.name,
          attributes: s.attributes,
          status: s.status,
          events: s.events,
        })),
      ),
      live: liveText,
      routing: JSON.stringify(routing.body),
      requestsApi: JSON.stringify(requestsApi.body),
      requestsTable: JSON.stringify({
        ...detail,
        bodies: undefined,
        rows: tableRows,
      }),
    };
    for (const [surface, text] of Object.entries(haystacks)) {
      for (const canary of ALL_CANARIES) {
        expect(text, `${surface} leaked ${canary}`).not.toContain(canary);
      }
    }

    // The ring is the one place bodies belong (spec §3.5).
    const ring = getBodyRing()!.get(requestId);
    expect(ring).toBeDefined();
    const ringText = JSON.stringify(ring);
    for (const canary of CONTENT_CANARIES) {
      expect(ringText).toContain(canary);
    }
    // Headers are never captured (spec §3.5) — not even in the ring.
    expect(ringText).not.toContain(CANARY_KEY);

    // LOG_BODIES is off: no bodies row on disk.
    expect(detail!.bodies).toBeUndefined();
  });

  it("canary reaches the bodies table only with LOG_BODIES=true", async () => {
    process.env.LOG_BODIES = "true";
    resetConfig();
    // Re-open the store so it reads logBodies from the new config.
    resetUsageStore();
    const store = getUsageStore()!;

    const requestId = await driveCanaryChat();

    const detail = store.getRequest(requestId)!;
    expect(detail.bodies).toBeDefined();
    const bodiesText = JSON.stringify(detail.bodies);
    for (const canary of CONTENT_CANARIES) {
      expect(bodiesText).toContain(canary);
    }
    // Keys still travel in headers only — never in a snapshot.
    expect(bodiesText).not.toContain(CANARY_KEY);

    // The row itself still carries no content.
    const { bodies: _bodies, ...row } = detail;
    const rowText = JSON.stringify(row);
    for (const canary of ALL_CANARIES) {
      expect(rowText).not.toContain(canary);
    }
  });
});
