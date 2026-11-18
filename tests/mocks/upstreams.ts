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

/**
 * The media host the URL-image pair cells fetch (v1.5 spec §3.2.2,
 * Task 11). A public-IP literal skips name resolution entirely —
 * media-fetch's SSRF guard still runs (a public range, allowed) but
 * no resolver is consulted — and msw intercepts the HTTP hop, so
 * `npm test` stays offline.
 */
export const MEDIA_URL = "http://93.184.216.34/pic.png";

/** The 1×1 PNG the media host serves (base64). */
export const MEDIA_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Nothing listens on this port — a guaranteed transport failure. */
export const DEAD_BASE_URL = "http://127.0.0.1:9";

/**
 * The deterministic vector and input-token count every embeddings
 * upstream serves (v1.5 spec §3.6) — tests assert both the reply
 * `data[].embedding` and the recorded usage against them.
 */
export const EMBED_VECTOR = [0.5, -1.25, 3];
export const EMBED_PROMPT_TOKENS = 11;

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
        // SSE events end with a blank line — without it the relay
        // (correctly) treats the last frame as unterminated.
        "",
      ].join("\n");
  }
}

// ===== Reasoning / structured-output replies (opt-in per test, v1.4 §4.2) =====

/**
 * Providers whose upstream serves a signed reasoning reply when the
 * test opts in (`reasoningReply.gemini = true`). The bodies below are
 * hand-written provider wire shapes — the reply a reasoning-capable
 * model returns for a tool-loop turn: one signed reasoning part plus
 * a call to `exec_command` (the tool the recorded Codex turns in
 * tests/fixtures/codex/turns.json drive). Signatures embed the
 * 1-based request ordinal (`sig-gem-2-…`) so a multi-turn test can
 * tell turn N's signature from turn N+1's. Streaming requests get the
 * same reply as provider SSE/NDJSON via reasoningReplyStream
 * (implemented for the dialects whose streams carry signatures —
 * Gemini, Anthropic); providers without a streamed twin still fall
 * through to the recorded corpus.
 */
export const reasoningReply: Partial<Record<Provider, boolean>> = {};

/**
 * Providers whose upstream serves a schema-shaped JSON document when
 * the test opts in (`structuredReply.gemini = true`). The message
 * text is the same JSON in every dialect.
 */
export const structuredReply: Partial<Record<Provider, boolean>> = {};

export function resetReplyOptins(): void {
  for (const key of Object.keys(reasoningReply) as Provider[]) {
    delete reasoningReply[key];
  }
  for (const key of Object.keys(structuredReply) as Provider[]) {
    delete structuredReply[key];
  }
}

const STRUCTURED_DOC = '{"name":"Ada","age":36}';

function reasoningReplyBody(provider: Provider, n: number): unknown {
  switch (provider) {
    // message.reasoning_content + tool_calls per DeepSeek's Chat
    // Completions dialect
    // (https://api-docs.deepseek.com/guides/reasoning_model —
    // reasoning_content arrives before content on the message).
    case "openai":
      return {
        id: `chatcmpl-r${n}`,
        object: "chat.completion",
        created: 1700000000,
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              reasoning_content: `reasoning about turn ${n}`,
              tool_calls: [
                {
                  id: `call_${n}`,
                  type: "function",
                  function: {
                    name: "exec_command",
                    arguments: '{"cmd":"ls"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };
    // thinking block with `signature` + tool_use per
    // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
    case "anthropic":
      return {
        id: `msg_r${n}`,
        type: "message",
        role: "assistant",
        model: "m",
        content: [
          {
            type: "thinking",
            thinking: `reasoning about turn ${n}`,
            signature: `sig-ant-${n}-think`,
          },
          {
            type: "tool_use",
            id: `toolu_${n}`,
            name: "exec_command",
            input: { cmd: "ls" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 8 },
      };
    // `thought: true` part + `thoughtSignature` on the thought and the
    // functionCall per
    // https://ai.google.dev/gemini-api/docs/thought-signatures
    case "gemini":
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: `reasoning about turn ${n}`,
                  thought: true,
                  thoughtSignature: `sig-gem-${n}-think`,
                },
                {
                  functionCall: {
                    name: "exec_command",
                    args: { cmd: "ls" },
                  },
                  thoughtSignature: `sig-gem-${n}-call`,
                },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "m",
      };
    // message.thinking + tool_calls per
    // https://docs.ollama.com/capabilities/thinking
    case "ollama":
      return {
        model: "m",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "",
          thinking: `reasoning about turn ${n}`,
          tool_calls: [
            {
              function: {
                name: "exec_command",
                arguments: { cmd: "ls" },
              },
            },
          ],
        },
        done: true,
        done_reason: "stop",
      };
    // reasoning + function_call output items per
    // https://platform.openai.com/docs/api-reference/responses/object
    // (encrypted_content is an upstream-native blob, not bg1.)
    case "responses":
      return {
        id: `resp_r${n}`,
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "m",
        output: [
          {
            type: "reasoning",
            id: `rs_${n}`,
            summary: [
              { type: "summary_text", text: `reasoning about turn ${n}` },
            ],
            encrypted_content: `enc-${n}`,
          },
          {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: "exec_command",
            arguments: '{"cmd":"ls"}',
            status: "completed",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      };
  }
}

function structuredReplyBody(provider: Provider): unknown {
  switch (provider) {
    // response_format json_schema per
    // https://platform.openai.com/docs/api-reference/chat/create
    case "openai":
      return {
        id: "chatcmpl-so",
        object: "chat.completion",
        created: 1700000000,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: STRUCTURED_DOC },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };
    // output_config.format json_schema per
    // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
    case "anthropic":
      return {
        id: "msg_so",
        type: "message",
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: STRUCTURED_DOC }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 8 },
      };
    // generationConfig.responseJsonSchema per
    // https://ai.google.dev/api/generate-content#GenerationConfig
    case "gemini":
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: STRUCTURED_DOC }],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "m",
      };
    // `format` per https://docs.ollama.com/capabilities/structured-outputs
    case "ollama":
      return {
        model: "m",
        created_at: "2024-01-01T00:00:00Z",
        message: { role: "assistant", content: STRUCTURED_DOC },
        done: true,
        done_reason: "stop",
      };
    // text.format json_schema per
    // https://platform.openai.com/docs/api-reference/responses/create
    case "responses":
      return {
        id: "resp_so",
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "m",
        output: [
          {
            type: "message",
            id: "msg_so",
            status: "completed",
            role: "assistant",
            content: [
              { type: "output_text", text: STRUCTURED_DOC, annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      };
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

/**
 * The streamed twin of reasoningReplyBody, served in 7-byte chunks
 * like the recorded corpus: the same ordinal-marked signatures
 * (`sig-gem-${n}-think`, `sig-gem-${n}-call`, `sig-ant-${n}-think`)
 * and the same `exec_command` call, carried on each dialect's stream
 * events. Providers whose stream can't carry a signature the corpus
 * doesn't already have keep returning undefined — the request falls
 * through to the recorded stream fixtures as before.
 */
function reasoningReplyStream(
  provider: Provider,
  n: number,
): HttpResponse | undefined {
  switch (provider) {
    // `data:` frames of GenerateContentResponse per
    // https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
    // (`:streamGenerateContent?alt=sse`); `thought: true` +
    // `thoughtSignature` on the thought part and the signature on the
    // `functionCall` part per
    // https://ai.google.dev/gemini-api/docs/thought-signatures; the
    // terminal frame carries `finishReason` + cumulative
    // `usageMetadata`.
    case "gemini":
      return textStreamResponse(
        [
          `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"reasoning about turn ${n}","thought":true,"thoughtSignature":"sig-gem-${n}-think"}]},"index":0}],"modelVersion":"m"}`,
          "",
          `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"exec_command","args":{"cmd":"ls"}},"thoughtSignature":"sig-gem-${n}-call"}]},"index":0}],"modelVersion":"m"}`,
          "",
          'data: {"candidates":[{"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":8,"totalTokenCount":18},"modelVersion":"m"}',
          "",
        ].join("\n"),
        STREAM_CONTENT_TYPE.gemini,
      );
    // Event-typed SSE per
    // https://docs.anthropic.com/en/api/messages-streaming and the
    // "Streaming thinking" section of
    // https://platform.claude.com/docs/en/build-with-claude/extended-thinking:
    // a `thinking` block (index 0) streams `thinking_delta` then its
    // `signature_delta`; a `tool_use` block (index 1) streams
    // `input_json_delta.partial_json`; `message_delta` carries the
    // stop reason and output usage; `message_stop` is terminal.
    case "anthropic":
      return textStreamResponse(
        [
          "event: message_start",
          `data: {"type":"message_start","message":{"id":"msg_r${n}","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}`,
          "",
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          "",
          "event: content_block_delta",
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning about turn ${n}"}}`,
          "",
          "event: content_block_delta",
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-ant-${n}-think"}}`,
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "",
          "event: content_block_start",
          `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_${n}","name":"exec_command","input":{}}}`,
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":1}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
        STREAM_CONTENT_TYPE.anthropic,
      );
    default:
      return undefined;
  }
}

/** Opt-in replies win over the corpus but never over responseOverrides. */
function optinReply(
  provider: Provider,
  url: string,
  body: unknown,
): HttpResponse | undefined {
  if (wantsStream(url, body)) {
    if (reasoningReply[provider]) {
      return reasoningReplyStream(
        provider,
        capturedRequests[provider].length,
      );
    }
    return undefined;
  }
  if (reasoningReply[provider]) {
    return HttpResponse.json(
      reasoningReplyBody(provider, capturedRequests[provider].length),
    );
  }
  if (structuredReply[provider]) {
    return HttpResponse.json(structuredReplyBody(provider));
  }
  return undefined;
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
      const optin = optinReply("openai", request.url, body);
      if (optin) return optin;
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
    // v1.5 §3.6: :batchEmbedContents — reply shape per googleapis
    // generative_service.proto BatchEmbedContentsResponse
    // ({embeddings: [{values}]} in batch order; no usage fields).
    if (request.url.includes(":batchEmbedContents")) {
      const requests =
        (body as { requests?: unknown[] } | null)?.requests ?? [];
      return HttpResponse.json({
        embeddings: requests.map(() => ({ values: EMBED_VECTOR })),
      });
    }
    const optin = optinReply("gemini", request.url, body);
    if (optin) return optin;
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
    const optin = optinReply("ollama", request.url, body);
    if (optin) return optin;
    if (cachedUsage.ollama) {
      return cachedUsageResponse("ollama", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("ollama");
    }
    return HttpResponse.json(nonStreamBody("ollama"));
  }),

  // ===== Embeddings endpoints (v1.5 spec §3.6) =====

  // OpenAI embeddings object: {object:"list", data:[{object:
  // "embedding",index,embedding}], model, usage:{prompt_tokens,
  // total_tokens}} — https://platform.openai.com/docs/api-reference/embeddings/object
  http.post(`${MOCK_BASE_URLS.openai}/v1/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      model?: string;
      input?: unknown;
    };
    capturedRequests.openai.push(body);
    capturedHeaders.openai.push(request.headers);
    const override = responseOverrides.openai;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    const n = Array.isArray(body.input) ? body.input.length : 1;
    return HttpResponse.json({
      object: "list",
      data: Array.from({ length: n }, (_, i) => ({
        object: "embedding",
        index: i,
        embedding: EMBED_VECTOR,
      })),
      model: body.model ?? "m",
      usage: {
        prompt_tokens: EMBED_PROMPT_TOKENS,
        total_tokens: EMBED_PROMPT_TOKENS,
      },
    });
  }),

  // POST /api/embed — https://docs.ollama.com/api/embed: {model,
  // embeddings: number[][], prompt_eval_count}.
  http.post(`${MOCK_BASE_URLS.ollama}/api/embed`, async ({ request }) => {
    const body = (await request.json()) as {
      model?: string;
      input?: unknown;
    };
    capturedRequests.ollama.push(body);
    capturedHeaders.ollama.push(request.headers);
    const override = responseOverrides.ollama;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    const n = Array.isArray(body.input) ? body.input.length : 1;
    return HttpResponse.json({
      model: body.model ?? "m",
      embeddings: Array.from({ length: n }, () => EMBED_VECTOR),
      prompt_eval_count: EMBED_PROMPT_TOKENS,
    });
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
    const optin = optinReply("responses", request.url, body);
    if (optin) return optin;
    if (cachedUsage.responses) {
      return cachedUsageResponse("responses", request.url, body);
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("responses");
    }
    return HttpResponse.json(nonStreamBody("responses"));
  }),

  // Anthropic's real token counter (v1.5 §3.3): a pass-through
  // anthropic entry forwards /v1/messages/count_tokens here.
  // https://docs.anthropic.com/en/api/messages-count-tokens
  http.post(
    `${MOCK_BASE_URLS.anthropic}/v1/messages/count_tokens`,
    async ({ request }) => {
      const body = await request.json();
      capturedRequests.anthropic.push(body);
      capturedHeaders.anthropic.push(request.headers);
      const override = responseOverrides.anthropic;
      if (override) {
        return HttpResponse.json(override.body ?? {}, {
          status: override.status ?? 200,
        });
      }
      return HttpResponse.json({ input_tokens: 1234 });
    },
  ),

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
    const optin = optinReply("anthropic", request.url, body);
    if (optin) return optin;
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

  http.post(`${OPENAI2_BASE_URL}/v1/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      model?: string;
      input?: unknown;
    };
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
    const n = Array.isArray(body.input) ? body.input.length : 1;
    return HttpResponse.json({
      object: "list",
      data: Array.from({ length: n }, (_, i) => ({
        object: "embedding",
        index: i,
        embedding: EMBED_VECTOR,
      })),
      model: body.model ?? "m",
      usage: {
        prompt_tokens: EMBED_PROMPT_TOKENS,
        total_tokens: EMBED_PROMPT_TOKENS,
      },
    });
  }),

  // ===== Media host (URL-image inlining, v1.5 spec §3.2.2) =====
  //
  // Serves the 1×1 MEDIA_PNG_B64 to media-fetch's http.request hop;
  // the URL is an IP literal so no DNS lookup ever leaves the box.
  http.get(MEDIA_URL, () => {
    const buf = Buffer.from(MEDIA_PNG_B64, "base64");
    return HttpResponse.arrayBuffer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
      { headers: { "content-type": "image/png" } },
    );
  }),
];
