import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { adapters, type Provider } from "../../src/transformers";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";

import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";
import responsesFixtures from "../fixtures/responses.json";

/** Mock hostnames used as *_API_BASE_URL in tests */
export const MOCK_BASE_URLS: Record<Provider, string> = {
  openai: "http://openai.mock",
  gemini: "http://gemini.mock",
  ollama: "http://ollama.mock",
  anthropic: "http://anthropic.mock",
  responses: "http://responses.mock",
};

/** A second OpenAI-type host for multi-provider (fallback) tests. */
export const OPENAI2_BASE_URL = "http://openai2.mock";

/** Nothing listens on this port — a guaranteed transport failure. */
export const DEAD_BASE_URL = "http://127.0.0.1:9";

/** Captured request bodies per provider (reset between tests) */
export const capturedRequests: Record<Provider, unknown[]> = {
  openai: [],
  gemini: [],
  ollama: [],
  anthropic: [],
  responses: [],
};

/** Captured auth headers per provider */
export const capturedHeaders: Record<Provider, Headers[]> = {
  openai: [],
  gemini: [],
  ollama: [],
  anthropic: [],
  responses: [],
};

/** Captured requests/headers on the second OpenAI-type host */
export const capturedRequests2: unknown[] = [];
export const capturedHeaders2: Headers[] = [];

export function resetCaptured(): void {
  for (const p of Object.keys(capturedRequests) as Provider[]) {
    capturedRequests[p].length = 0;
    capturedHeaders[p].length = 0;
  }
  capturedRequests2.length = 0;
  capturedHeaders2.length = 0;
}

/** Responses to return per provider — overridable per test */
export const responseOverrides: Partial<
  Record<Provider, { status?: number; body?: unknown }>
> = {};

export function resetOverrides(): void {
  for (const key of Object.keys(responseOverrides) as Provider[]) {
    delete responseOverrides[key];
  }
  delete responseOverrides2.status;
  delete responseOverrides2.body;
}

/** Overrides for the second OpenAI-type host (cleared by resetOverrides) */
export const responseOverrides2: { status?: number; body?: unknown } = {};

/**
 * Which fixture case each provider's upstream serves (default "text").
 * Streaming requests get the case's recorded wire bytes; non-streaming
 * requests get nonStreamBody(provider).
 */
export const streamCase: Partial<Record<Provider, string>> = {};

export function resetStreamCase(): void {
  for (const key of Object.keys(streamCase) as Provider[]) {
    delete streamCase[key];
  }
}

const FIXTURE_RESPONSES: Record<Provider, Record<string, unknown>> = {
  openai: openaiFixtures.responses,
  gemini: geminiFixtures.responses,
  ollama: ollamaFixtures.responses,
  anthropic: anthropicFixtures.responses,
  responses: responsesFixtures.responses,
};

// Named responses in tests/fixtures/<p>.json for cases that have one.
const CASE_RESPONSE: Record<Provider, Record<string, string>> = {
  openai: { tool_call: "tool_call" },
  anthropic: { tool_call: "tool_use" },
  ollama: {},
  gemini: {},
  responses: {},
};

/**
 * What a non-streaming request gets for the provider's selected
 * streamCase: either `{body}` — a recorded reply ("text" →
 * `responses.basic`, a named fixture response, or the recorded
 * non-streaming twin `<case>.nonstreaming.json` / the `nonStreaming`
 * field) — or `{expectedEvents}` when no recording exists, which
 * nonStreamBody reassembles and re-encodes in the provider's dialect.
 * Tests use this to pick expectations from the same oracle the mock
 * serves, so the derive path is never asserted by re-parsing the
 * adapter-derived body.
 */
export function nonStreamSource(
  provider: Provider,
): { body: unknown } | { expectedEvents: CanonicalStreamEvent[] } {
  const name = streamCase[provider] ?? "text";
  if (name === "text") return { body: FIXTURE_RESPONSES[provider].basic };
  const key = CASE_RESPONSE[provider][name];
  if (key !== undefined) {
    return { body: FIXTURE_RESPONSES[provider][key] };
  }
  const dir = join(__dirname, "..", "fixtures", "streams", provider);
  const twin = join(dir, `${name}.nonstreaming.json`);
  if (existsSync(twin)) {
    return { body: JSON.parse(readFileSync(twin, "utf8")) as unknown };
  }
  const meta = JSON.parse(
    readFileSync(join(dir, `${name}.json`), "utf8"),
  ) as { nonStreaming?: unknown; expectedEvents: CanonicalStreamEvent[] };
  if (meta.nonStreaming != null) return { body: meta.nonStreaming };
  return { expectedEvents: meta.expectedEvents };
}

/**
 * The non-stream reply for a provider's selected streamCase —
 * nonStreamSource's recorded body, or the case's documented stream
 * events reassembled and re-encoded in the provider's dialect.
 */
export function nonStreamBody(provider: Provider): unknown {
  const source = nonStreamSource(provider);
  if ("expectedEvents" in source) {
    return adapters[provider].fromCanonicalResponse(
      reassembleStream(source.expectedEvents),
    );
  }
  return source.body;
}

const WIRE_EXT: Record<Provider, string> = {
  openai: "sse",
  anthropic: "sse",
  gemini: "sse",
  ollama: "ndjson",
  responses: "sse",
};

const STREAM_CONTENT_TYPE: Record<Provider, string> = {
  openai: "text/event-stream",
  anthropic: "text/event-stream",
  gemini: "text/event-stream",
  ollama: "application/x-ndjson",
  responses: "text/event-stream",
};

/**
 * Serve the recorded stream corpus as the upstream reply, in 7-byte
 * chunks so split-point handling is exercised on every proxied stream.
 */
function streamFixtureResponse(provider: Provider): HttpResponse {
  const name = streamCase[provider] ?? "text";
  const file = join(
    __dirname,
    "..",
    "fixtures",
    "streams",
    provider,
    `${name}.${WIRE_EXT[provider]}`,
  );
  const bytes = readFileSync(file);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.subarray(i, i + 7));
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "content-type": STREAM_CONTENT_TYPE[provider] },
  });
}

/** A request body asks for a stream via `stream:true` (or the Gemini path). */
function wantsStream(url: string, body: unknown): boolean {
  if (url.includes(":streamGenerateContent")) return true;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { stream?: unknown }).stream === true
  );
}

// ===== Cached-usage replies (opt-in per test, spec §3.2) =====

/**
 * Providers whose upstream serves cached-usage replies when the test
 * opts in (`cachedUsage.anthropic = true`). The bodies below are
 * hand-written provider wire shapes, not adapter output. Ollama's
 * dialect has no cache fields — its reply carries only the totals.
 */
export const cachedUsage: Partial<Record<Provider, boolean>> = {};

export function resetCachedUsage(): void {
  for (const key of Object.keys(cachedUsage) as Provider[]) {
    delete cachedUsage[key];
  }
}

/** The canonical counts every dialect reply encodes. */
export const CACHED_USAGE = {
  inputTokens: 1000,
  outputTokens: 5,
  readTokens: 900,
  writeTokens: 90,
} as const;

function cachedUsageBody(provider: Provider): unknown {
  const c = CACHED_USAGE;
  switch (provider) {
    case "openai":
      return {
        id: "chatcmpl-cached",
        object: "chat.completion",
        created: 1700000000,
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "hi",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: c.inputTokens,
          completion_tokens: c.outputTokens,
          total_tokens: c.inputTokens + c.outputTokens,
          prompt_tokens_details: {
            cached_tokens: c.readTokens,
            cache_write_tokens: c.writeTokens,
          },
        },
      };
    case "anthropic":
      return {
        id: "msg_cached",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        model: "m",
        stop_reason: "end_turn",
        stop_sequence: null,
        // Wire input_tokens excludes cached tokens (spec §3.2).
        usage: {
          input_tokens: c.inputTokens - c.readTokens - c.writeTokens,
          cache_read_input_tokens: c.readTokens,
          cache_creation_input_tokens: c.writeTokens,
          output_tokens: c.outputTokens,
        },
      };
    case "gemini":
      return {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hi" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "m",
        usageMetadata: {
          promptTokenCount: c.inputTokens,
          candidatesTokenCount: c.outputTokens,
          totalTokenCount: c.inputTokens + c.outputTokens,
          cachedContentTokenCount: c.readTokens,
        },
      };
    case "ollama":
      return {
        model: "m",
        created_at: "2024-01-01T00:00:00Z",
        message: { role: "assistant", content: "hi" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: c.inputTokens,
        eval_count: c.outputTokens,
      };
    // Responses object shape: https://platform.openai.com/docs/api-reference/responses/object
    // (`cache_write_tokens` is evidenced only by the openai 7.30.1 SDK
    // typings — the API reference omits it).
    case "responses":
      return {
        id: "resp_cached",
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "m",
        output: [
          {
            type: "message",
            id: "msg_1",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "hi", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: c.inputTokens,
          input_tokens_details: {
            cached_tokens: c.readTokens,
            cache_write_tokens: c.writeTokens,
          },
          output_tokens: c.outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: c.inputTokens + c.outputTokens,
        },
      };
  }
}

/** Minimal provider-dialect stream whose usage carries the cache counts. */
function cachedUsageStreamText(provider: Provider): string {
  const c = CACHED_USAGE;
  switch (provider) {
    case "openai":
      return [
        'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
        "",
        'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":${c.inputTokens},"completion_tokens":${c.outputTokens},"total_tokens":${c.inputTokens + c.outputTokens},"prompt_tokens_details":{"cached_tokens":${c.readTokens},"cache_write_tokens":${c.writeTokens}}}}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n");
    case "anthropic":
      return [
        "event: message_start",
        `data: {"type":"message_start","message":{"id":"msg_c","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":${c.inputTokens - c.readTokens - c.writeTokens},"cache_read_input_tokens":${c.readTokens},"cache_creation_input_tokens":${c.writeTokens},"output_tokens":1}}}`,
        "",
        "event: content_block_start",
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        "",
        "event: content_block_stop",
        'data: {"type":"content_block_stop","index":0}',
        "",
        "event: message_delta",
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${c.outputTokens}}}`,
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
      ].join("\n");
    case "gemini":
      return [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"index":0}],"modelVersion":"m"}',
        "",
        `data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":${c.inputTokens},"candidatesTokenCount":${c.outputTokens},"totalTokenCount":${c.inputTokens + c.outputTokens},"cachedContentTokenCount":${c.readTokens}},"modelVersion":"m"}`,
        "",
      ].join("\n");
    case "ollama":
      return [
        '{"model":"m","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"hi"},"done":false}',
        `{"model":"m","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":${c.inputTokens},"eval_count":${c.outputTokens}}`,
        "",
      ].join("\n");
    // Responses SSE event names (`response.output_text.delta`,
    // `response.completed`): https://platform.openai.com/docs/api-reference/responses-streaming
    // and openai 7.30.1 `resources/responses/responses.d.ts`
    // (`ResponseStreamEvent`); the inner Response object per
    // /docs/api-reference/responses/object.
    case "responses":
      return [
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}',
        "",
        `data: {"type":"response.completed","response":{"id":"resp_c","object":"response","created_at":1,"status":"completed","model":"m","output":[{"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hi","annotations":[]}]}],"usage":{"input_tokens":${c.inputTokens},"input_tokens_details":{"cached_tokens":${c.readTokens},"cache_write_tokens":${c.writeTokens}},"output_tokens":${c.outputTokens},"output_tokens_details":{"reasoning_tokens":0},"total_tokens":${c.inputTokens + c.outputTokens}}}}`,
        "",
      ].join("\n");
  }
}

/** Same small-chunk serving as streamFixtureResponse, for generated bytes. */
function textStreamResponse(text: string, contentType: string): HttpResponse {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.subarray(i, i + 7));
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "content-type": contentType },
  });
}

function cachedUsageResponse(
  provider: Provider,
  url: string,
  body: unknown,
): HttpResponse {
  if (wantsStream(url, body)) {
    return textStreamResponse(
      cachedUsageStreamText(provider),
      STREAM_CONTENT_TYPE[provider],
    );
  }
  return HttpResponse.json(cachedUsageBody(provider));
}

export const upstreamHandlers = [
  http.post(
    `${MOCK_BASE_URLS.openai}/v1/chat/completions`,
    async ({ request }) => {
      const body = await request.json();
      capturedRequests.openai.push(body);
      capturedHeaders.openai.push(request.headers);
      const override = responseOverrides.openai;
      if (override) {
        return HttpResponse.json(override.body ?? {}, {
          status: override.status ?? 200,
        });
      }
      if (cachedUsage.openai) {
        return cachedUsageResponse("openai", request.url, body);
      }
      if (wantsStream(request.url, body)) {
        return streamFixtureResponse("openai");
      }
      return HttpResponse.json(nonStreamBody("openai"));
    },
  ),

  http.post(`${MOCK_BASE_URLS.gemini}/v1beta/models/*`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.gemini.push(body);
    capturedHeaders.gemini.push(request.headers);
    const override = responseOverrides.gemini;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (cachedUsage.gemini) {
      return cachedUsageResponse("gemini", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("gemini");
    }
    return HttpResponse.json(nonStreamBody("gemini"));
  }),

  http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.ollama.push(body);
    capturedHeaders.ollama.push(request.headers);
    const override = responseOverrides.ollama;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (cachedUsage.ollama) {
      return cachedUsageResponse("ollama", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("ollama");
    }
    return HttpResponse.json(nonStreamBody("ollama"));
  }),

  // POST /v1/responses — request shape per
  // https://platform.openai.com/docs/api-reference/responses/create and
  // the recorded Codex fallback shape (Codex 0.169.0,
  // tests/fixtures/codex/recording.jsonl); replies per /responses/object.
  http.post(`${MOCK_BASE_URLS.responses}/v1/responses`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.responses.push(body);
    capturedHeaders.responses.push(request.headers);
    const override = responseOverrides.responses;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (cachedUsage.responses) {
      return cachedUsageResponse("responses", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("responses");
    }
    return HttpResponse.json(nonStreamBody("responses"));
  }),

  http.post(`${MOCK_BASE_URLS.anthropic}/v1/messages`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.anthropic.push(body);
    capturedHeaders.anthropic.push(request.headers);
    const override = responseOverrides.anthropic;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (cachedUsage.anthropic) {
      return cachedUsageResponse("anthropic", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("anthropic");
    }
    return HttpResponse.json(nonStreamBody("anthropic"));
  }),

  // ===== Model list endpoints =====

  http.get(`${MOCK_BASE_URLS.openai}/v1/models`, ({ request }) => {
    capturedHeaders.openai.push(request.headers);
    const override = responseOverrides.openai;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(openaiFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.gemini}/v1beta/models`, ({ request }) => {
    capturedHeaders.gemini.push(request.headers);
    const override = responseOverrides.gemini;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(geminiFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.ollama}/api/tags`, ({ request }) => {
    capturedHeaders.ollama.push(request.headers);
    const override = responseOverrides.ollama;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(ollamaFixtures.models);
  }),

  // GET /v1/models — OpenAI model-list shape per
  // https://platform.openai.com/docs/api-reference/models/list.
  http.get(`${MOCK_BASE_URLS.responses}/v1/models`, ({ request }) => {
    capturedHeaders.responses.push(request.headers);
    const override = responseOverrides.responses;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(responsesFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.anthropic}/v1/models`, ({ request }) => {
    capturedHeaders.anthropic.push(request.headers);
    const override = responseOverrides.anthropic;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(anthropicFixtures.models);
  }),

  // ===== Second OpenAI-type host (fallback tests) =====

  http.post(`${OPENAI2_BASE_URL}/v1/chat/completions`, async ({ request }) => {
    const body = await request.json();
    capturedRequests2.push(body);
    capturedHeaders2.push(request.headers);
    if (
      responseOverrides2.status !== undefined ||
      responseOverrides2.body !== undefined
    ) {
      return HttpResponse.json(responseOverrides2.body ?? {}, {
        status: responseOverrides2.status ?? 200,
      });
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("openai");
    }
    return HttpResponse.json(openaiFixtures.responses.basic);
  }),

  http.get(`${OPENAI2_BASE_URL}/v1/models`, ({ request }) => {
    capturedHeaders2.push(request.headers);
    if (
      responseOverrides2.status !== undefined ||
      responseOverrides2.body !== undefined
    ) {
      return HttpResponse.json(responseOverrides2.body ?? {}, {
        status: responseOverrides2.status ?? 200,
      });
    }
    return HttpResponse.json(openaiFixtures.models);
  }),
];
