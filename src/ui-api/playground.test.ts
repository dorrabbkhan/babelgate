import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import request from "supertest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { AddressInfo } from "node:net";
import { app } from "../app";
import { resetConfig } from "../config/env-config";
import { resetModelListCache } from "../services/models.service";
import { registerSink, resetSinks } from "../observe/emit";
import { createLogSink } from "../observe/sinks/log";
import { getBodyRing } from "../observe/sinks/body-ring";
import {
  getUsageStore,
  resetUsageStore,
} from "../observe/sinks/usage-store";
import type { RequestTrace } from "../observe/trace";

/**
 * POST /ui/api/playground (spec §3.9): 2–4 models through
 * planRoute → attempt → one trace each (client "playground"), the
 * replies multiplexed onto one SSE response —
 * `event: delta {model,text}` / `event: done {model,usage,costUsd,ms}`
 * / `event: error {model,message}`.
 *
 * The upstream is a local msw ollama (TARGET_API=ollama env mode);
 * src tests cannot import tests/mocks (tsconfig rootDir).
 */

const OLLAMA_URL = "http://ollama.mock";
const UI = { "x-babelgate-ui": "1" };

const server = setupServer();

/** Ollama NDJSON lines for a streamed reply of `text` in `chunk` pieces. */
function ndjson(model: string, chunks: string[]): HttpResponse<ReadableStream<Uint8Array>> {
  const lines = [
    ...chunks.map(
      (text) =>
        `{"model":"${model}","created_at":"t","message":{"role":"assistant","content":${JSON.stringify(text)}},"done":false}`,
    ),
    `{"model":"${model}","created_at":"t","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":7}`,
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const line of lines) c.enqueue(enc.encode(`${line}\n`));
      c.close();
    },
  });
  return new HttpResponse(body, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

interface SseFrame {
  event: string;
  data: { model?: string; text?: string; message?: string; usage?: unknown; costUsd?: number | null; ms?: number };
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const frame of text.split("\n\n")) {
    if (frame.trim() === "") continue;
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0)
      frames.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return frames;
}

async function postPlayground(body: unknown) {
  return request(app)
    .post("/ui/api/playground")
    .set(UI)
    .send(body as object);
}

async function waitFor(
  check: () => boolean,
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    getUsageStore()?.flush();
    if (check() || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = OLLAMA_URL;
  process.env.UPSTREAM_RETRIES = "0";
  process.env.USAGE_DB = ":memory:";
  resetModelListCache();
  resetConfig();
  resetSinks();
  registerSink(createLogSink());
  const ring = getBodyRing();
  if (ring !== undefined) registerSink(ring);
  resetUsageStore();
});

afterEach(() => {
  server.resetHandlers();
  delete process.env.TARGET_API;
  delete process.env.OLLAMA_API_BASE_URL;
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.USAGE_DB;
  delete process.env.USAGE_STORE;
  resetUsageStore();
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("POST /ui/api/playground", () => {
  it("three models stream in parallel, one fails", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hits: string[] = [];
    server.use(
      http.post(`${OLLAMA_URL}/api/chat`, async ({ request }) => {
        const body = (await request.json()) as { model: string };
        hits.push(body.model);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // Hold every request open briefly — a serial fan-out could
          // never reach three concurrent upstreams.
          await new Promise((r) => setTimeout(r, 60));
          if (body.model === "fail-me") {
            return HttpResponse.json(
              { error: "upstream exploded" },
              { status: 500 },
            );
          }
          return ndjson(body.model, [`hello from ${body.model}`]);
        } finally {
          inFlight -= 1;
        }
      }),
    );

    const res = await postPlayground({
      messages: [{ role: "user", content: "hi" }],
      models: ["m1", "fail-me", "m3"],
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    // Every model attempted its upstream call, three at once.
    expect(new Set(hits)).toEqual(new Set(["m1", "fail-me", "m3"]));
    expect(maxInFlight).toBe(3);

    const frames = parseSse(res.text);
    const deltas = frames.filter((f) => f.event === "delta");
    expect(deltas).toContainEqual({
      event: "delta",
      data: { model: "m1", text: "hello from m1" },
    });
    expect(deltas).toContainEqual({
      event: "delta",
      data: { model: "m3", text: "hello from m3" },
    });
    const dones = frames.filter((f) => f.event === "done");
    expect(dones.map((d) => d.data.model).sort()).toEqual(["m1", "m3"]);
    expect(dones[0]!.data.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(dones[0]!.data.costUsd).toBe(0);
    expect(dones[0]!.data.ms).toEqual(expect.any(Number));
    const errors = frames.filter((f) => f.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data.model).toBe("fail-me");
    expect(errors[0]!.data.message).toEqual(expect.any(String));
  });

  it("each model gets its own row with client playground", async () => {
    getUsageStore();
    server.use(
      http.post(`${OLLAMA_URL}/api/chat`, async ({ request }) => {
        const body = (await request.json()) as { model: string };
        return ndjson(body.model, ["hi"]);
      }),
    );

    const res = await postPlayground({
      messages: [{ role: "user", content: "hi" }],
      models: ["m1", "m2"],
    });
    expect(res.status).toBe(200);

    const store = getUsageStore()!;
    await waitFor(
      () => store.listRequests({ limit: 10 }).rows.length >= 2,
    );
    const rows = store
      .listRequests({ limit: 10 })
      .rows.filter((r) => r.client === "playground");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.map((r) => r.requestedModel).sort()).toEqual([
      "m1",
      "m2",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        client: "playground",
        provider: "ollama",
        stream: true,
        status: "ok",
        httpStatus: 200,
        costUsd: 0,
      });
      expect(row.model).toBe(row.requestedModel);
    }
  });

  it("abort cancels all upstreams", async () => {
    const traces: RequestTrace[] = [];
    registerSink({
      name: "collect",
      accept: (t) => {
        traces.push(t);
      },
    });
    const cancelled: string[] = [];
    server.use(
      http.post(`${OLLAMA_URL}/api/chat`, async ({ request }) => {
        const body = (await request.json()) as { model: string };
        // The upstream sees the abort on its request signal when
        // postStream's fetch is torn down.
        request.signal.addEventListener("abort", () => {
          cancelled.push(body.model);
        });
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  `{"model":"${body.model}","created_at":"t","message":{"role":"assistant","content":"x"},"done":false}\n`,
                ),
              );
              // stays open — the client goes away first
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }),
    );

    const listener = app.listen(0);
    try {
      const port = (listener.address() as AddressInfo).port;
      const ac = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/ui/api/playground`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-babelgate-ui": "1",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
            models: ["m1", "m2"],
          }),
          signal: ac.signal,
        },
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read(); // first frames delivered, then disconnect
      ac.abort();
      await reader.read().catch(() => {});

      await waitFor(
        () =>
          traces.filter((t) => t.client === "playground").length >= 2,
      );
      const mine = traces.filter((t) => t.client === "playground");
      expect(mine).toHaveLength(2);
      for (const t of mine) {
        expect(t.status).toBe("aborted");
      }
      // The abort reached both upstream streams.
      await waitFor(() => cancelled.length >= 2, 2000);
      expect(new Set(cancelled)).toEqual(new Set(["m1", "m2"]));
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
  });

  it("5 models → 400", async () => {
    const res = await postPlayground({
      messages: [{ role: "user", content: "hi" }],
      models: ["a", "b", "c", "d", "e"],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
