import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { get } from "node:http";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { http as mswHttp, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { app } from "../app";
import { resetConfig } from "../config/env-config";
import { resetModelListCache } from "../services/models.service";
import { registerSink, resetSinks } from "../observe/emit";
import { createLogSink } from "../observe/sinks/log";

/**
 * GET /ui/api/live (spec §3.9): an SSE feed of `started` (id, client,
 * source, requested model) and `finished` (the row) events — never
 * bodies.
 *
 * The upstream is a local msw ollama (TARGET_API=ollama env mode);
 * src tests cannot import tests/mocks (tsconfig rootDir).
 */

const OLLAMA_URL = "http://ollama.mock";

const server = setupServer(
  mswHttp.post(`${OLLAMA_URL}/api/chat`, () =>
    HttpResponse.json({
      model: "llama3",
      created_at: "2024-01-01T00:00:00Z",
      message: { role: "assistant", content: "hi" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 8,
    }),
  ),
);

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event !== undefined && data !== undefined) {
      events.push({ event, data: JSON.parse(data) });
    }
  }
  return events;
}

let httpServer: Server;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "bypass" });
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
});

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = OLLAMA_URL;
  process.env.UPSTREAM_RETRIES = "0";
  process.env.USAGE_STORE = "off";
  resetModelListCache();
  resetConfig();
  resetSinks();
  registerSink(createLogSink());
});

afterEach(() => {
  server.resetHandlers();
  delete process.env.TARGET_API;
  delete process.env.OLLAMA_API_BASE_URL;
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.USAGE_STORE;
  resetConfig();
});

afterAll(() => {
  server.close();
  httpServer.close();
});

describe("GET /ui/api/live", () => {
  it("live streams started and finished, no bodies", async () => {
    const port = (httpServer.address() as AddressInfo).port;
    const sse = await new Promise<{
      status: number;
      text: () => string;
      close: () => void;
    }>((resolve, reject) => {
      const req = get(
        {
          host: "127.0.0.1",
          port,
          path: "/ui/api/live",
          headers: { "x-babelgate-ui": "1" },
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
    expect(sse.status).toBe(200);

    // A prompt canary: it must never appear on the wire feed.
    const canary = "CANARY-ui-live-9f3b";
    const chat = await request(app)
      .post("/v1/chat/completions")
      .set("user-agent", "claude-cli/2.1.3 (external, cli)")
      .send({
        model: "gpt-4",
        messages: [{ role: "user", content: canary }],
      });
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);

    const deadline = Date.now() + 5000;
    while (
      !sse.text().includes("event: finished") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const raw = sse.text();
    sse.close();

    const events = parseSse(raw);
    const started = events.find((e) => e.event === "started");
    const finished = events.find((e) => e.event === "finished");
    expect(started).toBeDefined();
    expect(finished).toBeDefined();

    expect(started!.data).toMatchObject({
      id: expect.any(String),
      client: "claude-code",
      sourceApi: "openai",
      requestedModel: "gpt-4",
      startedAt: expect.any(Number),
    });

    const row = finished!.data as Record<string, unknown>;
    expect(row).toMatchObject({
      id: (started!.data as { id: string }).id,
      sourceApi: "openai",
      requestedModel: "gpt-4",
      provider: "ollama",
      status: "ok",
      httpStatus: 200,
    });
    expect(row.bodies).toBeUndefined();
    // The whole feed — canary text (prompt/completion content) nowhere.
    expect(raw).not.toContain(canary);
    expect(raw).not.toContain("bodies");
  });
});
