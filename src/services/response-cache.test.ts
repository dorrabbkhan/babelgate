import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyRequest } from "./proxy.service";
import { resetConfig } from "../config/env-config";
import { runWithTrace } from "../observe/context";
import { registerSink, resetSinks } from "../observe/emit";
import { newTrace } from "../observe/trace";
import {
  createUsageStore,
  resetUsageStore,
} from "../observe/sinks/usage-store";
import {
  cacheKey,
  createResponseCache,
  isCacheableEvents,
  isCacheableResponse,
} from "./response-cache";
import type { RouteTarget } from "../routing/plan-route";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from "../types/canonical.types";

/**
 * The opt-in exact-match response cache (v1.6 spec §3.5): keyed on the
 * canonical request plus the winning target — the stream flag and
 * client metadata are out of the key, so a hit replays in the asking
 * client's own format. Never cached: temperature > 0 (unless
 * `cache.ignore_temperature`), errors, tool calls cut short by the
 * token cap, and pass-through requests. Upstreams are mocked via
 * ./http-client — no network.
 */

vi.mock("./http-client", () => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
  postStream: vi.fn(),
}));

import { postJson, postStream } from "./http-client";

const mockPostJson = vi.mocked(postJson);
const mockPostStream = vi.mocked(postStream);

const OLLAMA_RESPONSE = {
  status: 200,
  body: {
    model: "llama3",
    message: { role: "assistant", content: "Hi" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 5,
    eval_count: 1,
  },
  durationMs: 5,
};

const CHAT_REQ = {
  model: "m",
  messages: [{ role: "user", content: "Hello" }],
};

const chat = (
  body: unknown = CHAT_REQ,
  id = "r1",
): ReturnType<typeof proxyRequest> =>
  proxyRequest("/v1/chat/completions", "POST", body, id, {
    source: "openai",
  });

const STORED_RESPONSE: CanonicalResponse = {
  id: "r",
  model: "m",
  message: { role: "assistant", content: "Hi" },
  finishReason: "stop",
  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
};

const target = (provider = "p", model = "m"): RouteTarget => ({
  provider,
  model,
});

const req = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

const cfg = (over: Partial<Parameters<typeof createResponseCache>[0]> = {}) => ({
  ttlMs: 60_000,
  maxEntries: 10,
  ignoreTemperature: false,
  ...over,
});

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = "http://ollama.test";
  process.env.RESPONSES_API_BASE_URL = "http://responses.test";
  process.env.RESPONSES_API_KEY = "k";
  delete process.env.CACHE;
  resetConfig();
});

afterEach(() => {
  delete process.env.CACHE;
  delete process.env.BABELGATE_CONFIG;
  delete process.env.TARGET_API;
  resetConfig();
  resetSinks();
  resetUsageStore();
  vi.resetAllMocks();
});

describe("response cache keying and store", () => {
  it("ttl expiry misses", () => {
    let now = 1_000;
    const cache = createResponseCache(cfg({ ttlMs: 100 }), () => now);
    const key = cache.key(target(), req())!;
    cache.set(key, { response: STORED_RESPONSE });
    expect(cache.get(key)).toBeDefined();
    now += 101;
    expect(cache.get(key)).toBeUndefined();
  });

  it("lru evicts oldest", () => {
    const cache = createResponseCache(cfg({ maxEntries: 2 }));
    cache.set("a", { response: STORED_RESPONSE });
    cache.set("b", { response: STORED_RESPONSE });
    // Touch "a" — "b" is now the oldest.
    expect(cache.get("a")).toBeDefined();
    cache.set("c", { response: STORED_RESPONSE });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("key ignores stream flag and field order but not tools or formats", () => {
    const base = req({ config: { temperature: 0, maxTokens: 5 } });
    const streamed = req({
      stream: true,
      config: { maxTokens: 5, temperature: 0 },
    });
    expect(cacheKey(target(), base)).toBe(cacheKey(target(), streamed));
    // a different target provider or model is a different key
    expect(cacheKey(target("p2"), base)).not.toBe(cacheKey(target(), base));
    expect(cacheKey(target("p", "m2"), base)).not.toBe(
      cacheKey(target(), base),
    );
  });
});

describe("response cache in the chat services", () => {
  it("identical request hits", async () => {
    process.env.CACHE = "on";
    resetConfig();
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    const first = await chat(CHAT_REQ, "r1");
    const second = await chat(CHAT_REQ, "r2");
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers?.["x-babelgate-cache"]).toBe("hit");
    expect(second?.headers?.["x-babelgate-attempts"]).toBe("0");
  });

  it("cache off by default", async () => {
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    await chat(CHAT_REQ, "r1");
    await chat(CHAT_REQ, "r2");
    expect(mockPostJson).toHaveBeenCalledTimes(2);
  });

  it("temperature>0 not cached unless ignore_temperature", async () => {
    const cache = createResponseCache(cfg());
    const lax = createResponseCache(cfg({ ignoreTemperature: true }));
    const warm = req({ config: { temperature: 0.7 } });
    expect(cache.key(target(), warm)).toBeUndefined();
    expect(lax.key(target(), warm)).toBeTypeOf("string");
    // temperature === 0 is cacheable
    expect(cache.key(target(), req({ config: { temperature: 0 } }))).toBeTypeOf(
      "string",
    );

    process.env.CACHE = "on";
    resetConfig();
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    const body = { ...CHAT_REQ, temperature: 0.7 };
    await chat(body, "r1");
    await chat(body, "r2");
    expect(mockPostJson).toHaveBeenCalledTimes(2);

    // `cache.ignore_temperature: true` via babelgate.yaml opts it in.
    const dir = mkdtempSync(join(tmpdir(), "bg-cache-"));
    writeFileSync(
      join(dir, "babelgate.yaml"),
      [
        "default: ollama",
        "providers:",
        "  ollama:",
        "    type: ollama",
        "    base_url: http://ollama.test",
        "cache:",
        "  enabled: true",
        "  ignore_temperature: true",
        "",
      ].join("\n"),
    );
    process.env.BABELGATE_CONFIG = join(dir, "babelgate.yaml");
    delete process.env.CACHE;
    resetConfig();
    mockPostJson.mockClear();
    await chat(body, "r3");
    const r4 = await chat(body, "r4");
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(r4?.headers?.["x-babelgate-cache"]).toBe("hit");
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors not cached", async () => {
    process.env.CACHE = "on";
    resetConfig();
    mockPostJson
      .mockResolvedValueOnce({
        status: 500,
        body: { error: "boom" },
        durationMs: 5,
      })
      .mockResolvedValueOnce(OLLAMA_RESPONSE);
    await expect(chat(CHAT_REQ, "r1")).rejects.toBeTruthy();
    const second = await chat(CHAT_REQ, "r2");
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    expect(second?.headers?.["x-babelgate-cache"]).toBeUndefined();
    // The successful reply was cached — the next identical request hits.
    const third = await chat(CHAT_REQ, "r3");
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    expect(third?.headers?.["x-babelgate-cache"]).toBe("hit");
  });

  it("passthrough not cached", async () => {
    process.env.TARGET_API = "responses";
    process.env.CACHE = "on";
    resetConfig();
    const responsesReply = {
      status: 200,
      body: { id: "resp_1", model: "m", output: [], status: "completed" },
      durationMs: 5,
    };
    mockPostJson.mockResolvedValue(responsesReply);
    const body = { model: "m", input: "Hello" };
    await proxyRequest("/v1/responses", "POST", body, "r1", {
      source: "responses",
    });
    await proxyRequest("/v1/responses", "POST", body, "r2", {
      source: "responses",
    });
    // Both requests relayed — the cache is never consulted.
    expect(mockPostJson).toHaveBeenCalledTimes(2);
  });

  it("stream hit replays events in order", async () => {
    process.env.CACHE = "on";
    resetConfig();
    const ndjson = readFileSync("tests/fixtures/streams/ollama/text.ndjson");
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
    const collect = async (id: string): Promise<string[]> => {
      const result = await proxyRequest(
        "/v1/chat/completions",
        "POST",
        { ...CHAT_REQ, stream: true },
        id,
        { source: "openai" },
      );
      const out: string[] = [];
      for await (const chunk of result!.stream!.chunks) out.push(chunk);
      return out;
    };
    // The stream encoder stamps `created` from Date.now() once per
    // response; the two collects straddling a second boundary made the
    // chunk payloads differ by that one field (CI flake). Freeze the
    // clock so the comparison stays chunk-for-chunk exact.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const first = await collect("r1");
      const second = await collect("r2");
      expect(mockPostStream).toHaveBeenCalledTimes(1);
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    } finally {
      clock.mockRestore();
    }
  });

  it("cache hit row has cache_hit 1 and cost 0", async () => {
    process.env.CACHE = "on";
    resetConfig();
    const dir = mkdtempSync(join(tmpdir(), "bg-cache-"));
    const store = createUsageStore({
      path: join(dir, "usage.db"),
      logBodies: false,
    });
    registerSink(store);
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    await chat(CHAT_REQ, "seed");
    const trace = newTrace({
      requestId: "hit",
      startedAt: Date.now(),
      client: "test",
      sourceApi: "openai",
    });
    await runWithTrace(trace, () => chat(CHAT_REQ, "hit"));
    // finishTrace emits through an async price step — let it land.
    await new Promise((r) => setImmediate(r));
    store.flush();
    const row = store.getRequest("hit");
    expect(row?.cacheHit).toBe(true);
    expect(row?.costUsd).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requests differing only in tool_choice miss", async () => {
    process.env.CACHE = "on";
    resetConfig();
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    const tools = [
      {
        type: "function",
        function: { name: "f", parameters: { type: "object" } },
      },
    ];
    // Ollama accepts only an absent/"auto" tool_choice, so the pair
    // here is "auto" vs unset — still differing only in tool_choice.
    await chat({ ...CHAT_REQ, tools, tool_choice: "auto" }, "r1");
    await chat({ ...CHAT_REQ, tools }, "r2");
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    // ...but the first request was cached — asking it again hits.
    const again = await chat(
      { ...CHAT_REQ, tools, tool_choice: "auto" },
      "r3",
    );
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    expect(again?.headers?.["x-babelgate-cache"]).toBe("hit");
  });

  it("requests differing only in response_format miss", async () => {
    process.env.CACHE = "on";
    resetConfig();
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    await chat(CHAT_REQ, "r1");
    await chat(
      { ...CHAT_REQ, response_format: { type: "json_object" } },
      "r2",
    );
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    const again = await chat(CHAT_REQ, "r3");
    expect(mockPostJson).toHaveBeenCalledTimes(2);
    expect(again?.headers?.["x-babelgate-cache"]).toBe("hit");
  });

  it("hit replays in a different source format", async () => {
    process.env.CACHE = "on";
    resetConfig();
    mockPostJson.mockResolvedValue(OLLAMA_RESPONSE);
    await proxyRequest(
      "/v1/chat/completions",
      "POST",
      {
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0,
      },
      "r1",
      { source: "openai" },
    );
    const second = await proxyRequest(
      "/api/chat",
      "POST",
      {
        model: "m",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
        options: { temperature: 0 },
      },
      "r2",
      { source: "ollama" },
    );
    // The openai client's request cached a canonical response the
    // ollama client's identical request re-encodes in its own format.
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(second?.headers?.["x-babelgate-cache"]).toBe("hit");
    const body = second?.body as Record<string, unknown>;
    expect(body.done).toBe(true);
    expect((body.message as { content: string }).content).toBe("Hi");
  });
});

describe("stored-entry rules", () => {
  it("tool calls cut short by the token cap are never cached", () => {
    const truncated: CanonicalResponse = {
      ...STORED_RESPONSE,
      finishReason: "length",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      },
    };
    expect(isCacheableResponse(truncated)).toBe(false);
    expect(isCacheableResponse(STORED_RESPONSE)).toBe(true);
    // a plain "length" finish (no tool calls) is still cacheable
    expect(
      isCacheableResponse({ ...STORED_RESPONSE, finishReason: "length" }),
    ).toBe(true);
  });

  it("errored or incomplete streams are never cached", () => {
    const good: CanonicalStreamEvent[] = [
      { type: "message_start", id: "r", model: "m" },
      { type: "text_delta", text: "Hi" },
      { type: "message_end", finishReason: "stop" },
    ];
    expect(isCacheableEvents(good)).toBe(true);
    expect(isCacheableEvents(good.slice(0, -1))).toBe(false);
    expect(
      isCacheableEvents([
        { type: "message_start", id: "r", model: "m" },
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "x" },
        },
      ]),
    ).toBe(false);
    // length + a tool call → cut short → not cached
    expect(
      isCacheableEvents([
        { type: "message_start", id: "r", model: "m" },
        { type: "tool_call_start", index: 0, id: "c1", name: "f" },
        { type: "tool_call_end", index: 0 },
        { type: "message_end", finishReason: "length" },
      ]),
    ).toBe(false);
  });
});
