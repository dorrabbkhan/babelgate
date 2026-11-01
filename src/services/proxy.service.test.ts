import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { proxyRequest } from "./proxy.service";
import { resetConfig } from "../config/env-config";
import {
  NotSupportedError,
  UpstreamError,
  ValidationError,
} from "../utils/errors";
import { logger } from "../utils/logger";

vi.mock("./http-client", () => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
  postStream: vi.fn(),
}));

import { postJson, getJson, postStream } from "./http-client";

const mockPostJson = vi.mocked(postJson);
const mockGetJson = vi.mocked(getJson);
const mockPostStream = vi.mocked(postStream);

const VALID_OPENAI_REQUEST = {
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello" }],
};

const OPENAI_RESPONSE_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
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

describe("proxyRequest", () => {
  it("returns null for non-provider paths", async () => {
    expect(
      await proxyRequest("/random/path", "POST", {}, "r1", {
        source: "openai",
      }),
    ).toBeNull();
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("returns null when path belongs to a different provider", async () => {
    // /api/chat is ollama's prefix but source is openai
    expect(
      await proxyRequest(
        "/api/chat",
        "POST",
        VALID_OPENAI_REQUEST,
        "r1",
        { source: "openai" },
      ),
    ).toBeNull();
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("throws ValidationError for malformed body", async () => {
    const err = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      { model: "gpt-4" }, // missing messages
      "r1",
      { source: "openai" },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
  });

  it("propagates UpstreamError from http-client", async () => {
    mockPostJson.mockRejectedValue(new UpstreamError("upstream down", 500, {}));

    const err = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
  });

  it("converts non-2xx upstream status to UpstreamError", async () => {
    mockPostJson.mockResolvedValue({
      status: 401,
      body: { error: "bad key" },
      durationMs: 5,
    });

    const err = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.statusCode).toBe(502);
  });

  it("builds gemini URL with model in path", async () => {
    process.env.TARGET_API = "gemini";
    resetConfig();
    mockPostJson.mockResolvedValue({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hi" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 1,
          totalTokenCount: 6,
        },
      },
      durationMs: 10,
    });

    await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
    );

    expect(mockPostJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://gemini.test/v1beta/models/gpt-4:generateContent",
      }),
    );
  });

  it("stream:true streams — gemini target uses :streamGenerateContent?alt=sse", async () => {
    // All adapters stream since v1.1 Task 7 — the upstream URL is the
    // Gemini streaming endpoint (streamRequestPath, spec §3.2).
    process.env.TARGET_API = "gemini";
    resetConfig();
    const sse = readFileSync(
      "tests/fixtures/streams/gemini/text.sse",
    ) as Uint8Array;
    mockPostStream.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse);
          c.close();
        },
      }),
    });

    const result = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      { ...VALID_OPENAI_REQUEST, stream: true },
      "r1",
      { source: "openai" },
    );

    expect(mockPostStream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://gemini.test/v1beta/models/gpt-4:streamGenerateContent?alt=sse",
      }),
    );
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.stream).toBeDefined();

    let out = "";
    for await (const chunk of result!.stream!.chunks) out += chunk;
    expect(out).toContain("data: {");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("gemini :streamGenerateContent streams (no alt → JSON array)", async () => {
    resetConfig();
    const ndjson = readFileSync(
      "tests/fixtures/streams/ollama/text.ndjson",
    ) as Uint8Array;
    mockPostStream.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(ndjson);
          c.close();
        },
      }),
    });

    const result = await proxyRequest(
      "/v1beta/models/llama3:streamGenerateContent",
      "POST",
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      "r1",
      { source: "gemini" },
    );

    expect(mockPostStream).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://ollama.test/api/chat" }),
    );
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.stream).toBeDefined();
    expect(result!.stream!.contentType).toBe("application/json");

    let out = "";
    for await (const chunk of result!.stream!.chunks) out += chunk;
    const elements = JSON.parse(out) as {
      candidates?: { finishReason?: string }[];
    }[];
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.at(-1)!.candidates?.[0]?.finishReason).toBe("STOP");
  });

  it("gemini :countTokens → NotSupportedError 'countTokens is not supported'", async () => {
    resetConfig();

    const err = await proxyRequest(
      "/v1beta/models/llama3:countTokens",
      "POST",
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      "r1",
      { source: "gemini" },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(NotSupportedError);
    expect(err.statusCode).toBe(501);
    expect(err.message).toBe("countTokens is not supported");
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("gemini source takes the model from the request path", async () => {
    resetConfig();

    await proxyRequest(
      "/v1beta/models/llama3:generateContent",
      "POST",
      {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
      "r1",
      { source: "gemini" },
    );

    expect(mockPostJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://ollama.test/api/chat",
        body: expect.objectContaining({ model: "llama3" }),
      }),
    );
  });

  it("returns transformed response in source format", async () => {
    const result = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
    );

    expect(result).not.toBeNull();
    const body = result!.body as {
      object?: string;
      choices?: { message?: { content?: string } }[];
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices![0]!.message!.content).toBe("Hi");
  });

  it("logs token usage metrics on completion", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
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
      hops: [{ provider: "ollama", model: "gpt-4", outcome: "ok" }],
    });
  });

  it("stream branch returns stream, not body", async () => {
    process.env.TARGET_API = "openai";
    resetConfig();
    const sse = readFileSync(
      "tests/fixtures/streams/openai/text.sse",
    ) as Uint8Array;
    mockPostStream.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse);
          c.close();
        },
      }),
    });

    const result = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      { ...VALID_OPENAI_REQUEST, stream: true },
      "r1",
      { source: "openai" },
    );

    expect(result).not.toBeNull();
    expect(result!.stream).toBeDefined();
    expect(result!.body).toBeUndefined();
    expect(result!.stream!.contentType).toBe("text/event-stream");

    let out = "";
    for await (const chunk of result!.stream!.chunks) out += chunk;
    expect(out).toContain("data: {");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("every pair streams — no streaming 501 remains", async () => {
    // The last stubbed adapter (gemini) streams since v1.1 Task 7, so a
    // stream:true request reaches postStream for every pair.
    process.env.TARGET_API = "gemini";
    resetConfig();
    const sse = readFileSync(
      "tests/fixtures/streams/gemini/text.sse",
    ) as Uint8Array;
    mockPostStream.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse);
          c.close();
        },
      }),
    });

    const result = await proxyRequest(
      "/v1/chat/completions",
      "POST",
      { ...VALID_OPENAI_REQUEST, stream: true },
      "r1",
      { source: "openai" },
    );

    expect(mockPostStream).toHaveBeenCalledTimes(1);
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.stream).toBeDefined();
    expect(result!.stream!.contentType).toBe("text/event-stream");

    let out = "";
    for await (const chunk of result!.stream!.chunks) out += chunk;
    expect(out).toContain("data: {");
  });

  it("returns null for chat path with wrong method (GET)", async () => {
    expect(
      await proxyRequest("/api/chat", "GET", undefined, "r1", {
        source: "ollama",
      }),
    ).toBeNull();
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("proxies models list through canonical (openai source → ollama target)", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        models: [
          {
            name: "llama3:latest",
            model: "llama3:latest",
            modified_at: "2025-01-01T00:00:00Z",
            size: 4661224676,
          },
        ],
      },
      durationMs: 8,
    });

    const result = await proxyRequest("/v1/models", "GET", undefined, "r1", {
      source: "openai",
    });

    expect(mockGetJson).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://ollama.test/api/tags" }),
    );
    expect(result).not.toBeNull();
    const body = result!.body as {
      object?: string;
      data?: { id: string; object: string }[];
    };
    // Response must be in source (openai) shape
    expect(body.object).toBe("list");
    expect(body.data![0]!.id).toBe("llama3:latest");
    expect(body.data![0]!.object).toBe("model");
  });

  it("returns null for models path with wrong method (POST)", async () => {
    expect(
      await proxyRequest(
        "/v1/models",
        "POST",
        VALID_OPENAI_REQUEST,
        "r1",
        { source: "openai" },
      ),
    ).toBeNull();
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("sends correct auth headers per provider", async () => {
    process.env.TARGET_API = "anthropic";
    resetConfig();
    mockPostJson.mockResolvedValue({
      status: 200,
      body: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-3",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
      durationMs: 10,
    });

    await proxyRequest(
      "/v1/chat/completions",
      "POST",
      VALID_OPENAI_REQUEST,
      "r1",
      { source: "openai" },
    );

    expect(mockPostJson).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "k",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });
});
