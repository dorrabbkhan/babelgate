import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogSink } from "./log";
import { registerSink, resetSinks } from "../emit";
import { newTrace } from "../trace";
import { runWithTrace } from "../context";
import { proxyRequest } from "../../services/proxy.service";
import { resetConfig } from "../../config/env-config";
import { logger } from "../../utils/logger";

vi.mock("../../services/http-client", () => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
  postStream: vi.fn(),
}));

import { postJson } from "../../services/http-client";

const mockPostJson = vi.mocked(postJson);

const VALID_OPENAI_REQUEST = {
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello" }],
};

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = "http://ollama.test";
  process.env.OPENAI_API_BASE_URL = "http://openai.test";
  process.env.GEMINI_API_BASE_URL = "http://gemini.test";
  process.env.ANTHROPIC_API_BASE_URL = "http://anthropic.test";
  process.env.GEMINI_API_KEY = "k";
  process.env.OPENAI_API_KEY = "k";
  process.env.ANTHROPIC_API_KEY = "k";
  resetConfig();
  resetSinks();
  registerSink(createLogSink());
  mockPostJson.mockResolvedValue({
    status: 200,
    body: {
      model: "llama3",
      message: { role: "assistant", content: "Hi" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 5,
      eval_count: 1,
    },
    durationMs: 10,
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

/**
 * The v1.2 route-log test, moved from proxy.service.test.ts: same
 * assertions, now exercised through the trace the chat service finishes
 * and the log sink emits (spec §3.1).
 */
describe("log sink", () => {
  it("logs token usage metrics on completion", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    await runWithTrace(
      newTrace({
        requestId: "r1",
        startedAt: Date.now(),
        client: "other",
        sourceApi: "openai",
      }),
      () =>
        proxyRequest(
          "/v1/chat/completions",
          "POST",
          VALID_OPENAI_REQUEST,
          "r1",
          { source: "openai" },
        ),
    );

    const completed = infoSpy.mock.calls.find(
      ([_fields, msg]) => msg === "Request completed",
    );
    expect(completed).toBeDefined();
    // spec §3.4 route log record
    expect(completed![0]).toMatchObject({
      requestId: "r1",
      sourceApi: "openai",
      requestedModel: "gpt-4",
      reason: "default",
      winner: "ollama",
      stream: false,
      inputTokens: 5,
      outputTokens: 1,
      finishReason: "stop",
      hops: [
        {
          provider: "ollama",
          model: "gpt-4",
          outcome: "ok",
          ms: expect.any(Number),
        },
      ],
    });
  });

  it("log line carries every RouteLogRecord field plus the trace fields", () => {
    const infoSpy = vi.spyOn(logger, "info");
    const sink = createLogSink();

    sink.accept({
      ...newTrace({
        requestId: "r2",
        startedAt: 1_000,
        client: "claude-code",
        userAgent: "claude-cli/2.1.3",
        sourceApi: "anthropic",
      }),
      requestedModel: "claude-3",
      reason: "explicit",
      hops: [
        { provider: "main", model: "m", outcome: "ok", ms: 7 },
      ],
      winner: "main",
      stream: true,
      inputTokens: 1000,
      outputTokens: 5,
      finishReason: "stop",
      status: "ok",
      httpStatus: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 90,
      costUsd: 0.0042,
      ttfbMs: 120,
      totalMs: 800,
      diagnostics: [
        { toolCallId: "t1", name: "f", code: "invalid_json" },
      ],
      notes: [{ stage: "decode", adapter: "openai", code: "x" }],
      bodies: { target: [{ value: { a: 1 } }] },
    });

    const completed = infoSpy.mock.calls.find(
      ([_fields, msg]) => msg === "Request completed",
    );
    expect(completed).toBeDefined();
    expect(completed![0]).toMatchObject({
      requestId: "r2",
      sourceApi: "anthropic",
      requestedModel: "claude-3",
      reason: "explicit",
      winner: "main",
      stream: true,
      inputTokens: 1000,
      outputTokens: 5,
      finishReason: "stop",
      client: "claude-code",
      status: "ok",
      httpStatus: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 90,
      costUsd: 0.0042,
      ttfbMs: 120,
      totalMs: 800,
      diagnostics: ["invalid_json"],
    });
    // Diagnostics carry codes only; notes, bodies and the raw user
    // agent never reach the log line (spec §3.1, privacy).
    const record = completed![0] as Record<string, unknown>;
    expect(record).not.toHaveProperty("bodies");
    expect(record).not.toHaveProperty("notes");
    expect(record).not.toHaveProperty("userAgent");
    expect(JSON.stringify(record)).not.toContain('"code":"x"');
  });
});
