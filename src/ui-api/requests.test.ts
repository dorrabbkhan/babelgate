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
import { app } from "../app";
import { resetConfig } from "../config/env-config";
import { resetModelListCache } from "../services/models.service";
import {
  registerSink,
  resetSinks,
} from "../observe/emit";
import { createLogSink } from "../observe/sinks/log";
import { getBodyRing } from "../observe/sinks/body-ring";
import {
  getUsageStore,
  resetUsageStore,
} from "../observe/sinks/usage-store";
import { newTrace, type RequestTrace } from "../observe/trace";

/**
 * GET /ui/api/requests and /requests/:id (spec §3.9): rows from the
 * usage store, newest first, cursor-paged; the detail carries the row
 * plus bodies — ring first, then the `bodies` table (LOG_BODIES) — or
 * `bodies: null, reason: "not_retained"`. A disabled store answers
 * empty, never an error: the Requests screen still loads.
 *
 * The upstream is a local msw ollama (TARGET_API=ollama env mode);
 * src tests cannot import tests/mocks (tsconfig rootDir).
 */

const OLLAMA_URL = "http://ollama.mock";

/** A minimal recorded ollama chat reply. */
const OLLAMA_REPLY = {
  model: "llama3",
  created_at: "2024-01-01T00:00:00Z",
  message: { role: "assistant", content: "hi" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 10,
  eval_count: 8,
};

const server = setupServer(
  http.post(`${OLLAMA_URL}/api/chat`, () =>
    HttpResponse.json(OLLAMA_REPLY),
  ),
);

const UI = { "x-babelgate-ui": "1" };

const CHAT_BODY = {
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello" }],
};

async function driveChat(body: unknown = CHAT_BODY) {
  const res = await request(app)
    .post("/v1/chat/completions")
    .send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

async function waitForRows(n: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    getUsageStore()?.flush();
    const count =
      getUsageStore()?.listRequests({ limit: 500 }).rows.length ?? 0;
    if (count >= n || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function listIds(): Promise<string[]> {
  const res = await request(app).get("/ui/api/requests").set(UI);
  expect(res.status).toBe(200);
  return res.body.rows.map((r: { id: string }) => r.id);
}

/** A filler trace that only exists to evict real ids from the ring. */
function fillTrace(id: string): RequestTrace {
  return {
    ...newTrace({
      requestId: id,
      startedAt: Date.now(),
      client: "test",
      sourceApi: "openai",
    }),
    bodies: { target: [] },
  };
}

function evictRing(): void {
  const ring = getBodyRing();
  expect(ring).toBeDefined();
  // The ring holds the last INSPECTOR_BUFFER (50) traces' snapshots.
  for (let i = 0; i < 60; i++) ring!.accept(fillTrace(`fill-${i}`));
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
  // The ring singleton survives resetSinks() unregistered — re-add it
  // (no-op while it is already registered).
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
  delete process.env.LOG_BODIES;
  resetUsageStore();
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("GET /ui/api/requests", () => {
  it("lists rows newest first", async () => {
    getUsageStore();
    await driveChat();
    await driveChat({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: "later" }],
    });
    await waitForRows(2);

    const res = await request(app).get("/ui/api/requests").set(UI);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].startedAt).toBeGreaterThanOrEqual(
      res.body.rows[1].startedAt,
    );
    for (const row of res.body.rows) {
      expect(row).toMatchObject({
        client: expect.any(String),
        sourceApi: "openai",
        provider: "ollama",
        status: "ok",
        httpStatus: 200,
      });
      expect(row.bodies).toBeUndefined();
    }
  });

  it("cursor-pages", async () => {
    getUsageStore();
    for (let i = 0; i < 3; i++) await driveChat();
    await waitForRows(3);

    const page1 = await request(app)
      .get("/ui/api/requests?limit=2")
      .set(UI);
    expect(page1.status).toBe(200);
    expect(page1.body.rows).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app)
      .get(
        `/ui/api/requests?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      )
      .set(UI);
    expect(page2.status).toBe(200);
    expect(page2.body.rows).toHaveLength(1);
    const ids = [...page1.body.rows, ...page2.body.rows].map(
      (r: { id: string }) => r.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("filters by client, model, provider and status", async () => {
    getUsageStore();
    await driveChat();
    await waitForRows(1);

    const byProvider = await request(app)
      .get("/ui/api/requests?provider=ollama")
      .set(UI);
    expect(byProvider.body.rows).toHaveLength(1);
    const none = await request(app)
      .get("/ui/api/requests?provider=gemini")
      .set(UI);
    expect(none.body.rows).toHaveLength(0);
    const byModel = await request(app)
      .get("/ui/api/requests?model=gpt-4")
      .set(UI);
    expect(byModel.body.rows).toHaveLength(1);
    const byStatus = await request(app)
      .get("/ui/api/requests?status=ok")
      .set(UI);
    expect(byStatus.body.rows).toHaveLength(1);
    const errored = await request(app)
      .get("/ui/api/requests?status=error")
      .set(UI);
    expect(errored.body.rows).toHaveLength(0);
  });

  it("400s on a bad limit and a bad cursor", async () => {
    getUsageStore();
    const badLimit = await request(app)
      .get("/ui/api/requests?limit=abc")
      .set(UI);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error).toMatchObject({
      code: expect.any(String),
    });
    const badCursor = await request(app)
      .get("/ui/api/requests?cursor=%%%")
      .set(UI);
    expect(badCursor.status).toBe(400);
  });

  it("limit above 500 is refused", async () => {
    getUsageStore();
    const res = await request(app)
      .get("/ui/api/requests?limit=501")
      .set(UI);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("limit 500 is accepted", async () => {
    getUsageStore();
    const res = await request(app)
      .get("/ui/api/requests?limit=500")
      .set(UI);
    expect(res.status).toBe(200);
  });

  it("store off answers empty rows", async () => {
    process.env.USAGE_STORE = "off";
    resetConfig();
    const res = await request(app).get("/ui/api/requests").set(UI);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });
});

describe("GET /ui/api/requests/:id", () => {
  it("returns the row and ring bodies", async () => {
    getUsageStore();
    await driveChat();
    await waitForRows(1);
    const [id] = await listIds();

    const res = await request(app)
      .get(`/ui/api/requests/${id}`)
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.row.id).toBe(id);
    expect(res.body.row.bodies).toBeUndefined();
    expect(res.body.bodies).toMatchObject({
      source: expect.anything(),
      canonical: expect.anything(),
      target: expect.any(Array),
    });
    expect(res.body.reason).toBeUndefined();
  });

  it("not_retained when ring evicted and no LOG_BODIES", async () => {
    getUsageStore();
    await driveChat();
    await waitForRows(1);
    const [id] = await listIds();
    evictRing();

    const res = await request(app)
      .get(`/ui/api/requests/${id}`)
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.bodies).toBeNull();
    expect(res.body.reason).toBe("not_retained");
  });

  it("bodies fall back to the bodies table with LOG_BODIES", async () => {
    process.env.LOG_BODIES = "true";
    resetConfig();
    getUsageStore();
    await driveChat();
    await waitForRows(1);
    const [id] = await listIds();
    evictRing();

    const res = await request(app)
      .get(`/ui/api/requests/${id}`)
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.bodies).toMatchObject({ source: expect.anything() });
    expect(res.body.reason).toBeUndefined();
  });

  it("unknown id 404s", async () => {
    getUsageStore();
    const res = await request(app)
      .get("/ui/api/requests/nope")
      .set(UI);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: expect.any(String) });
  });
});
