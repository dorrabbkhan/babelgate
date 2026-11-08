import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import { app } from "../app";
import { resetConfig } from "../config/env-config";
import { resetSinks } from "../observe/emit";
import {
  getUsageStore,
  resetUsageStore,
} from "../observe/sinks/usage-store";
import { newTrace, type RequestTrace } from "../observe/trace";

/**
 * GET /ui/api/usage (spec §3.9): tokens, cost, would-have-cost,
 * cache-hit ratio, error and fallback counts per group
 * (day | model | provider | client).
 */

const UI = { "x-babelgate-ui": "1" };

let seq = 0;
function seeded(overrides: Partial<RequestTrace>): void {
  const trace: RequestTrace = {
    ...newTrace({
      requestId: `t-${seq++}`,
      startedAt: Date.now(),
      client: "claude-code",
      sourceApi: "openai",
    }),
    requestedModel: "asked",
    reason: "default",
    hops: [
      { provider: "main", model: "m1", outcome: "ok", ms: 5 },
    ],
    winner: "main",
    status: "ok",
    httpStatus: 200,
    totalMs: 10,
    ...overrides,
  };
  getUsageStore()!.accept(trace);
}

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = "http://ollama.mock";
  process.env.USAGE_DB = ":memory:";
  resetConfig();
  resetSinks();
  resetUsageStore();
});

afterEach(() => {
  delete process.env.TARGET_API;
  delete process.env.OLLAMA_API_BASE_URL;
  delete process.env.USAGE_DB;
  delete process.env.USAGE_STORE;
  resetUsageStore();
  resetConfig();
});

describe("GET /ui/api/usage", () => {
  it("groups tokens, cost, errors and fallbacks per model", async () => {
    getUsageStore();
    seeded({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 900,
      costUsd: 0.5,
      wouldCostUsd: 1,
    });
    seeded({
      status: "error",
      httpStatus: 500,
      winner: undefined,
      hops: [
        { provider: "main", model: "m1", outcome: "transport", ms: 3 },
        { provider: "bak", model: "m2", outcome: "http_error", ms: 4 },
      ],
    });
    getUsageStore()!.flush();

    const res = await request(app)
      .get("/ui/api/usage?group=model")
      .set(UI);
    expect(res.status).toBe(200);
    const groups = res.body.groups;
    const m1 = groups.find((g: { key: string }) => g.key === "m1");
    expect(m1).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 900,
      costUsd: 0.5,
      wouldCostUsd: 1,
      errors: 0,
      fallbacks: 0,
    });
    expect(m1.cacheHitRatio).toBeCloseTo(0.9);
    const errored = groups.find(
      (g: { key: string }) => g.key === "none",
    );
    expect(errored).toMatchObject({ requests: 1, errors: 1 });
  });

  it("fallbacks count rows with more than one hop", async () => {
    getUsageStore();
    seeded({
      hops: [
        { provider: "a", model: "m", outcome: "transport", ms: 1 },
        { provider: "b", model: "n", outcome: "ok", ms: 2 },
      ],
      winner: "b",
    });
    getUsageStore()!.flush();

    const res = await request(app)
      .get("/ui/api/usage?group=client")
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.groups[0]).toMatchObject({
      key: "claude-code",
      requests: 1,
      fallbacks: 1,
    });
  });

  it("day grouping and a from/to window", async () => {
    getUsageStore();
    seeded({ startedAt: Date.now() });
    getUsageStore()!.flush();

    const res = await request(app)
      .get("/ui/api/usage?group=day")
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);

    const empty = await request(app)
      .get("/ui/api/usage?group=day&from=0&to=1")
      .set(UI);
    expect(empty.status).toBe(200);
    expect(empty.body.groups).toEqual([]);
  });

  it("400s on a bad group", async () => {
    getUsageStore();
    const res = await request(app)
      .get("/ui/api/usage?group=hour")
      .set(UI);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: expect.any(String) });
  });

  it("store off answers empty groups", async () => {
    process.env.USAGE_STORE = "off";
    resetConfig();
    const res = await request(app)
      .get("/ui/api/usage?group=model")
      .set(UI);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });
});
