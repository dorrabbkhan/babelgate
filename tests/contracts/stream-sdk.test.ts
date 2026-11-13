import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { Ollama } from "ollama";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openaiAdapter,
  anthropicAdapter,
  geminiAdapter,
  ollamaAdapter,
} from "../../src/transformers/adapters";
import { mapToAnthropicStopReason } from "../../src/transformers/adapters/anthropic.adapter";
import { mapToGeminiFinishReason } from "../../src/transformers/adapters/gemini.adapter";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import { logger } from "../../src/utils/logger";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";
import type { ChatCompletionRequest } from "../../src/types/openai.types";
import type {
  MessageCreateParams,
  TextBlock,
  ToolUseBlock,
} from "../../src/types/anthropic.types";
import type { GenerateContentRequest } from "../../src/types/gemini.types";
import type { OllamaChatRequest } from "../../src/types/ollama.types";

/**
 * Encoder contract (spec §3.3, §4.2): bytes our encoders write must be
 * parseable by the provider's own SDK — the strongest guarantee the wire
 * format is right, independent of our own decoder.
 *
 * Rows are generated per provider and case; a provider joins when its
 * encoder lands (Tasks 4–7).
 *
 * The bytes are served over a real loopback HTTP server rather than msw:
 * the OpenAI SDK calls reader.cancel() when it sees `[DONE]`, and the
 * cancellation never resolves on msw's synthetic response stream.
 */
const STREAMS_DIR = join(__dirname, "..", "fixtures", "streams");

interface StreamFixture {
  model: string;
  expectedEvents: CanonicalStreamEvent[];
}

function fixtureFor(provider: string, name: string): StreamFixture {
  return JSON.parse(
    readFileSync(join(STREAMS_DIR, provider, `${name}.json`), "utf8"),
  ) as StreamFixture;
}

const openaiCases = readdirSync(join(STREAMS_DIR, "openai"))
  .filter((f) => f.endsWith(".json") && !f.endsWith(".nonstreaming.json"))
  .map((f) => f.slice(0, -".json".length));

// "error" has no message to accumulate — covered by the error-event test.
const anthropicCases = readdirSync(join(STREAMS_DIR, "anthropic"))
  .filter((f) => f.endsWith(".json") && !f.endsWith(".nonstreaming.json"))
  .map((f) => f.slice(0, -".json".length))
  .filter((name) => name !== "error");

// No error fixture exists for gemini (none in Google's published
// captures — docs/decisions.md "v1.1 Task 3"), so no filter here.
const geminiCases = readdirSync(join(STREAMS_DIR, "gemini"))
  .filter((f) => f.endsWith(".json") && !f.endsWith(".nonstreaming.json"))
  .map((f) => f.slice(0, -".json".length));

// "error" makes the SDK throw on the {"error":…} line — covered below.
const ollamaCases = readdirSync(join(STREAMS_DIR, "ollama"))
  .filter((f) => f.endsWith(".json") && !f.endsWith(".nonstreaming.json"))
  .map((f) => f.slice(0, -".json".length))
  .filter((name) => name !== "error");

function encodeOpenai(
  fixture: StreamFixture,
  sourceRequest: ChatCompletionRequest,
): string {
  const encoder = openaiAdapter.createStreamEncoder({
    sourceRequest,
    query: {},
    requestedModel: "m",
  });
  let out = "";
  for (const event of fixture.expectedEvents) out += encoder.encode(event);
  return out + encoder.end();
}

const STREAMING_REQUEST: ChatCompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  stream_options: { include_usage: true },
};

function encodeAnthropic(
  events: CanonicalStreamEvent[],
  sourceRequest: MessageCreateParams,
): string {
  const encoder = anthropicAdapter.createStreamEncoder({
    sourceRequest,
    query: {},
    requestedModel: "m",
  });
  let out = "";
  for (const event of events) out += encoder.encode(event);
  return out + encoder.end();
}

const ANTHROPIC_STREAMING_REQUEST: MessageCreateParams = {
  model: "m",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

const ANTHROPIC_STREAM_PARAMS = {
  model: "m",
  max_tokens: 1024,
  messages: [{ role: "user" as const, content: "hi" }],
};

function encodeOllama(
  events: CanonicalStreamEvent[],
  sourceRequest: OllamaChatRequest,
): string {
  const encoder = ollamaAdapter.createStreamEncoder({
    sourceRequest,
    query: {},
    requestedModel: "m",
  });
  let out = "";
  for (const event of events) out += encoder.encode(event);
  return out + encoder.end();
}

const OLLAMA_STREAMING_REQUEST: OllamaChatRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

function encodeGemini(
  events: CanonicalStreamEvent[],
  sourceRequest: GenerateContentRequest,
  query: Record<string, string> = { alt: "sse" },
): string {
  const encoder = geminiAdapter.createStreamEncoder({
    sourceRequest,
    query,
    requestedModel: "m",
  });
  let out = "";
  for (const event of events) out += encoder.encode(event);
  return out + encoder.end();
}

const GEMINI_STREAMING_REQUEST: GenerateContentRequest = {
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
};

let currentBody = "";
let currentContentType = "text/event-stream";
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": currentContentType });
  res.end(currentBody);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
});
afterAll(() => {
  server.close();
});

function sdkClient(): OpenAI {
  const port = (server.address() as AddressInfo).port;
  return new OpenAI({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${port}/v1`,
    maxRetries: 0,
  });
}

function anthropicClient(): Anthropic {
  const port = (server.address() as AddressInfo).port;
  return new Anthropic({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${port}`,
    maxRetries: 0,
  });
}

function ollamaClient(): Ollama {
  const port = (server.address() as AddressInfo).port;
  return new Ollama({ host: `http://127.0.0.1:${port}` });
}

function geminiModel() {
  const port = (server.address() as AddressInfo).port;
  return new GoogleGenerativeAI("test-key").getGenerativeModel(
    { model: "m" },
    { baseUrl: `http://127.0.0.1:${port}` },
  );
}

describe("stream encoders via the provider SDK", () => {
  beforeEach(() => {
    // Every case declares the content type it serves — SSE by default,
    // the ollama cases override to NDJSON — so no case depends on test
    // order.
    currentContentType = "text/event-stream";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(openaiCases)("openai SDK parses encoded %s", async (name) => {
    const fixture = fixtureFor("openai", name);
    currentBody = encodeOpenai(fixture, STREAMING_REQUEST);

    const runner = sdkClient().chat.completions.stream({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _chunk of runner) {
      // consume the whole stream
    }
    const final = await runner.finalChatCompletion();

    const expected = reassembleStream(fixture.expectedEvents);
    const choice = final.choices[0]!;

    expect(choice.finish_reason).toBe(
      openaiAdapter.fromCanonicalResponse(expected).choices[0].finish_reason,
    );
    expect(choice.message.content ?? "").toBe(expected.message.content);
    expect(
      (choice.message.tool_calls ?? []).map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    ).toEqual(
      (expected.message.toolCalls ?? []).map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    );
    if (expected.usage) {
      expect(final.usage).toMatchObject({
        prompt_tokens: expected.usage.inputTokens,
        completion_tokens: expected.usage.outputTokens,
        total_tokens: expected.usage.totalTokens,
      });
    }
  });

  it("openai encoder omits the usage chunk unless include_usage", () => {
    const fixture = fixtureFor("openai", "max_tokens");
    const without = encodeOpenai(fixture, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(without).not.toContain('"choices":[]');
    expect(without).not.toContain('"usage"');
    expect(without.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const with_ = encodeOpenai(fixture, STREAMING_REQUEST);
    expect(with_).toContain('"choices":[]');
    const usage = fixture.expectedEvents.find((e) => e.type === "usage");
    expect(usage?.type).toBe("usage");
    if (usage?.type === "usage") {
      expect(with_).toContain(`"prompt_tokens":${usage.usage.inputTokens}`);
      expect(with_).toContain(
        `"completion_tokens":${usage.usage.outputTokens}`,
      );
    }
  });

  it.each(anthropicCases)("anthropic SDK parses encoded %s", async (name) => {
    const fixture = fixtureFor("anthropic", name);
    currentBody = encodeAnthropic(
      fixture.expectedEvents,
      ANTHROPIC_STREAMING_REQUEST,
    );

    const runner = anthropicClient().messages.stream(
      ANTHROPIC_STREAM_PARAMS,
    );
    for await (const _event of runner) {
      // consume the whole stream
    }
    const final = await runner.finalMessage();

    const expected = reassembleStream(fixture.expectedEvents);

    expect(final.model).toBe("m");
    const text = final.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe(expected.message.content);

    const toolUses = final.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    expect(toolUses.map((tu) => ({ name: tu.name, input: tu.input }))).toEqual(
      (expected.message.toolCalls ?? []).map((tc) => ({
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
    );

    expect(final.stop_reason).toBe(
      mapToAnthropicStopReason(expected.finishReason),
    );
    if (expected.usage) {
      expect(final.usage).toMatchObject({
        input_tokens: expected.usage.inputTokens,
        output_tokens: expected.usage.outputTokens,
      });
    }
  });

  it("anthropic SDK raises the encoded error event", async () => {
    const fixture = fixtureFor("anthropic", "error");
    currentBody = encodeAnthropic(
      fixture.expectedEvents,
      ANTHROPIC_STREAMING_REQUEST,
    );

    const runner = anthropicClient().messages.stream(
      ANTHROPIC_STREAM_PARAMS,
    );
    const err = await (async () => {
      try {
        for await (const _event of runner) {
          // consume the whole stream
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as Anthropic.APIError).type).toBe("overloaded_error");
  });

  it("interleaved parallel calls", async () => {
    // Canonical index 1's deltas arrive before index 0's end — the encoder
    // buffers by canonical index and emits each tool_use block whole, so
    // both calls land in the SDK's final message with their own inputs.
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "tool_call_start", index: 0, id: "toolu_a", name: "get_weather" },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"city":',
      },
      { type: "tool_call_start", index: 1, id: "toolu_b", name: "get_time" },
      {
        type: "tool_call_delta",
        index: 1,
        argumentsDelta: '{"tz":"UTC"}',
      },
      { type: "tool_call_end", index: 1 },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '"Paris"}',
      },
      { type: "tool_call_end", index: 0 },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      { type: "message_end", finishReason: "tool_call" },
    ];
    currentBody = encodeAnthropic(events, ANTHROPIC_STREAMING_REQUEST);

    const runner = anthropicClient().messages.stream(
      ANTHROPIC_STREAM_PARAMS,
    );
    for await (const _event of runner) {
      // consume the whole stream
    }
    const final = await runner.finalMessage();

    const toolUses = final.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    expect(toolUses).toHaveLength(2);
    // The first call to finish gets the first content-block index.
    expect(toolUses[0]!.id).toBe("toolu_b");
    expect(toolUses[1]!.id).toBe("toolu_a");
    const byId = new Map(toolUses.map((tu) => [tu.id, tu]));
    expect(byId.get("toolu_a")?.name).toBe("get_weather");
    expect(byId.get("toolu_a")?.input).toEqual({ city: "Paris" });
    expect(byId.get("toolu_b")?.name).toBe("get_time");
    expect(byId.get("toolu_b")?.input).toEqual({ tz: "UTC" });
  });

  it("empty arguments become {}", () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "tool_call_start", index: 0, id: "toolu_a", name: "noop" },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeAnthropic(events, ANTHROPIC_STREAMING_REQUEST);

    // content_block_start carries input:{} and the single
    // input_json_delta carries a valid empty object (spec §3.4).
    expect(out).toContain('"input":{}');
    expect(out).toContain('"partial_json":"{}"');
  });

  it("invalid arguments become the _invalid_arguments wrapper", () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "tool_call_start", index: 0, id: "toolu_a", name: "f" },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: "not-json",
      },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeAnthropic(events, ANTHROPIC_STREAMING_REQUEST);

    expect(out).toContain("_invalid_arguments");
    expect(out).toContain("not-json");
  });

  it("text between tool_call_start and tool_call_end closes before the tool block", async () => {
    // A text_delta arriving while a tool call is still buffered opens a
    // text block; Anthropic never overlaps content blocks, so the text
    // block must stop before the tool_use block starts.
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "tool_call_start", index: 0, id: "toolu_a", name: "get_weather" },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"city":"Paris"}',
      },
      { type: "text_delta", text: "hi" },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    currentBody = encodeAnthropic(events, ANTHROPIC_STREAMING_REQUEST);

    // On the wire every content_block_start is preceded by the
    // content_block_stop of any earlier block, and block indices are
    // contiguous from 0.
    const open = new Set<number>();
    const startIndices: number[] = [];
    for (const chunk of currentBody.split("\n\n")) {
      const data = chunk
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6);
      if (data === undefined) continue;
      const event = JSON.parse(data) as { type: string; index?: number };
      if (event.type === "content_block_start") {
        expect(open.size).toBe(0);
        open.add(event.index!);
        startIndices.push(event.index!);
      } else if (event.type === "content_block_stop") {
        expect(open.has(event.index!)).toBe(true);
        open.delete(event.index!);
      }
    }
    expect(startIndices).toEqual([0, 1]);

    const runner = anthropicClient().messages.stream(
      ANTHROPIC_STREAM_PARAMS,
    );
    for await (const _event of runner) {
      // consume the whole stream
    }
    const final = await runner.finalMessage();

    expect(final.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(final.content[0]).toMatchObject({ type: "text", text: "hi" });
    expect(final.content[1]).toMatchObject({
      type: "tool_use",
      id: "toolu_a",
      name: "get_weather",
      input: { city: "Paris" },
    });
  });

  it("anthropic encoder writes nothing after a terminal event", () => {
    const afterEnd = anthropicAdapter.createStreamEncoder({
      sourceRequest: ANTHROPIC_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    afterEnd.encode({ type: "message_start", id: "msg_1", model: "m" });
    afterEnd.encode({ type: "message_end", finishReason: "stop" });
    expect(afterEnd.encode({ type: "text_delta", text: "late" })).toBe("");
    expect(
      afterEnd.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
    expect(afterEnd.end()).toBe("");

    const afterError = anthropicAdapter.createStreamEncoder({
      sourceRequest: ANTHROPIC_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    afterError.encode({
      type: "error",
      error: { kind: "upstream", status: 502, message: "boom" },
    });
    expect(afterError.encode({ type: "text_delta", text: "late" })).toBe("");
    expect(
      afterError.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
  });

  it("anthropic SDK rejects on an error after message_start", async () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "text_delta", text: "hi" },
      {
        type: "error",
        error: { kind: "rate_limit", status: 429, message: "slow down" },
      },
    ];
    currentBody = encodeAnthropic(events, ANTHROPIC_STREAMING_REQUEST);
    const encodedType = (
      JSON.parse(
        currentBody
          .split("event: error\n")[1]!
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ) as { error: { type: string } }
    ).error.type;

    const runner = anthropicClient().messages.stream(
      ANTHROPIC_STREAM_PARAMS,
    );
    const err: unknown = await runner.finalMessage().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as Anthropic.APIError).type).toBe(encodedType);
  });

  it.each(ollamaCases)("ollama SDK parses encoded %s", async (name) => {
    const fixture = fixtureFor("ollama", name);
    currentContentType = "application/x-ndjson";
    currentBody = encodeOllama(
      fixture.expectedEvents,
      OLLAMA_STREAMING_REQUEST,
    );

    const parts = [];
    const stream = await ollamaClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const part of stream) parts.push(part);

    const expected = reassembleStream(fixture.expectedEvents);
    const final = parts.at(-1)!;

    expect(
      parts.map((p) => p.message?.content ?? "").join(""),
    ).toBe(expected.message.content);
    expect(
      parts
        .flatMap((p) => p.message?.tool_calls ?? [])
        .map((tc) => ({
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
    ).toEqual(
      (expected.message.toolCalls ?? []).map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as object,
      })),
    );

    expect(final.done).toBe(true);
    // Ollama reports a tool-call answer's done_reason as "stop" (recorded
    // corpus) — only canonical "length" stays "length".
    expect(final.done_reason).toBe(
      expected.finishReason === "length" ? "length" : "stop",
    );
    if (expected.usage) {
      expect(final.prompt_eval_count).toBe(expected.usage.inputTokens);
      expect(final.eval_count).toBe(expected.usage.outputTokens);
    }
  });

  it("ollama SDK throws on the encoded error line", async () => {
    const fixture = fixtureFor("ollama", "error");
    currentContentType = "application/x-ndjson";
    currentBody = encodeOllama(
      fixture.expectedEvents,
      OLLAMA_STREAMING_REQUEST,
    );

    const stream = await ollamaClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const err: unknown = await (async () => {
      try {
        for await (const _part of stream) {
          // consume the whole stream
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    const errorEvent = fixture.expectedEvents.find(
      (e) => e.type === "error",
    );
    expect(errorEvent?.type).toBe("error");
    if (errorEvent?.type === "error") {
      expect((err as Error).message).toBe(errorEvent.error.message);
    }
  });

  it("ollama encoder handles interleaved canonical tool indices", () => {
    // Index 1's delta arrives before index 0's end (§3.1 rule 5) — each
    // call keeps its own buffer and ID, emitted whole at tool_call_end.
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "call_0", model: "m" },
      { type: "tool_call_start", index: 0, id: "call_a", name: "get_weather" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"city":' },
      { type: "tool_call_start", index: 1, id: "call_b", name: "get_time" },
      { type: "tool_call_delta", index: 1, argumentsDelta: '{"tz":"UTC"}' },
      { type: "tool_call_end", index: 1 },
      { type: "tool_call_delta", index: 0, argumentsDelta: '"Paris"}' },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeOllama(events, OLLAMA_STREAMING_REQUEST);
    const lines = out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const toolLines = lines.filter(
      (l) => (l.message as { tool_calls?: unknown[] }).tool_calls,
    );
    expect(toolLines).toHaveLength(2);
    // The first call to finish emits first — call_b keeps its own id,
    // name, arguments and canonical index.
    expect(toolLines[0]!.message).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_b",
          function: {
            index: 1,
            name: "get_time",
            arguments: { tz: "UTC" },
          },
        },
      ],
    });
    expect(toolLines[1]!.message).toMatchObject({
      tool_calls: [
        {
          id: "call_a",
          function: {
            index: 0,
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        },
      ],
    });
  });

  it("ollama encoder flushes unended tool calls before done", () => {
    // A tool_call_start with no matching tool_call_end leaves the call
    // buffered; at message_end the encoder flushes each in ascending
    // canonical index order (index 0 started second here) as the same
    // message.tool_calls line tool_call_end would have produced.
    const warnSpy = vi.spyOn(logger, "warn");
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "call_0", model: "m" },
      { type: "tool_call_start", index: 1, id: "call_b", name: "get_time" },
      { type: "tool_call_delta", index: 1, argumentsDelta: '{"tz":"UTC"}' },
      {
        type: "tool_call_start",
        index: 0,
        id: "call_a",
        name: "get_weather",
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"city":"Paris"}',
      },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeOllama(events, OLLAMA_STREAMING_REQUEST);
    const lines = out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines).toHaveLength(3);
    expect(lines[0]!.message).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_a",
          function: {
            index: 0,
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        },
      ],
    });
    expect(lines[1]!.message).toMatchObject({
      tool_calls: [
        {
          id: "call_b",
          function: {
            index: 1,
            name: "get_time",
            arguments: { tz: "UTC" },
          },
        },
      ],
    });
    expect(lines[2]).toMatchObject({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 20,
    });

    // One warn per stream naming only the count — no names, ids or
    // arguments.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0]![0]);
    expect(warnMessage).toContain("2");
    expect(warnMessage).not.toContain("call_a");
    expect(warnMessage).not.toContain("call_b");
    expect(warnMessage).not.toContain("get_weather");
    expect(warnMessage).not.toContain("get_time");
    expect(warnMessage).not.toContain("Paris");

    // Before an error event the buffered calls are dropped instead —
    // error is terminal.
    const errOut = encodeOllama(
      [
        ...events.slice(0, -1),
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "boom" },
        },
      ],
      OLLAMA_STREAMING_REQUEST,
    );
    expect(errOut).not.toContain("tool_calls");
    expect(JSON.parse(errOut)).toEqual({ error: "boom" });
  });

  it("ollama encoder warns on tool event for unknown index", () => {
    // A tool_call_delta or tool_call_end for an index that never had
    // tool_call_start is dropped — but not silently.
    const warnSpy = vi.spyOn(logger, "warn");
    const encoder = ollamaAdapter.createStreamEncoder({
      sourceRequest: OLLAMA_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });

    expect(
      encoder.encode({
        type: "tool_call_delta",
        index: 7,
        argumentsDelta: "{}",
      }),
    ).toBe("");
    expect(encoder.encode({ type: "tool_call_end", index: 7 })).toBe("");

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("tool_call_delta");
    expect(String(warnSpy.mock.calls[0]![0])).toContain("7");
    expect(String(warnSpy.mock.calls[1]![0])).toContain("tool_call_end");
    expect(String(warnSpy.mock.calls[1]![0])).toContain("7");

    // Output is unchanged: the rest of the stream encodes as if the
    // stray events never arrived.
    let out = "";
    out += encoder.encode({ type: "message_start", id: "call_0", model: "m" });
    out += encoder.encode({ type: "text_delta", text: "hi" });
    out += encoder.encode({ type: "message_end", finishReason: "stop" });
    out += encoder.end();
    const lines = out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.message).toMatchObject({
      role: "assistant",
      content: "hi",
    });
    expect(lines[1]).toMatchObject({ done: true, done_reason: "stop" });
  });

  it("ollama encoder writes nothing after a terminal event", () => {
    const afterEnd = ollamaAdapter.createStreamEncoder({
      sourceRequest: OLLAMA_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    afterEnd.encode({ type: "message_start", id: "call_0", model: "m" });
    afterEnd.encode({ type: "message_end", finishReason: "stop" });
    expect(afterEnd.encode({ type: "text_delta", text: "late" })).toBe("");
    expect(
      afterEnd.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
    expect(afterEnd.end()).toBe("");

    const afterError = ollamaAdapter.createStreamEncoder({
      sourceRequest: OLLAMA_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    afterError.encode({
      type: "error",
      error: { kind: "upstream", status: 502, message: "boom" },
    });
    expect(afterError.encode({ type: "text_delta", text: "late" })).toBe(
      "",
    );
    expect(
      afterError.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
  });

  it.each(geminiCases)("gemini SDK parses encoded %s", async (name) => {
    const fixture = fixtureFor("gemini", name);
    currentBody = encodeGemini(
      fixture.expectedEvents,
      GEMINI_STREAMING_REQUEST,
    );

    const { stream, response } = await geminiModel().generateContentStream(
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    );
    for await (const _chunk of stream) {
      // consume the whole stream
    }
    const final = await response;

    const expected = reassembleStream(fixture.expectedEvents);

    expect(final.text()).toBe(expected.message.content);
    expect(final.functionCalls() ?? []).toEqual(
      (expected.message.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      })),
    );
    expect(final.candidates?.[0]?.finishReason).toBe(
      mapToGeminiFinishReason(expected.finishReason),
    );
    if (expected.usage) {
      // v1.4 §3.2: canonical outputTokens includes reasoning; Gemini
      // splits it back into candidatesTokenCount + thoughtsTokenCount.
      const reasoning = expected.usage.reasoningTokens ?? 0;
      expect(final.usageMetadata).toMatchObject({
        promptTokenCount: expected.usage.inputTokens,
        candidatesTokenCount: expected.usage.outputTokens - reasoning,
        totalTokenCount: expected.usage.totalTokens,
        ...(reasoning > 0 && { thoughtsTokenCount: reasoning }),
      });
    }
  });

  it("gemini array form without alt=sse", () => {
    // :streamGenerateContent with no alt= query streams a JSON array of
    // GenerateContentResponse elements (spec §3.3) — still valid JSON
    // when it ends.
    const fixture = fixtureFor("gemini", "text");
    const encoder = geminiAdapter.createStreamEncoder({
      sourceRequest: GEMINI_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    expect(encoder.contentType).toBe("application/json");

    let out = "";
    for (const event of fixture.expectedEvents) {
      out += encoder.encode(event);
    }
    out += encoder.end();

    const elements = JSON.parse(out) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
      modelVersion?: string;
      responseId?: string;
    }[];
    expect(elements.length).toBeGreaterThan(0);
    const text = elements
      .flatMap(
        (el) =>
          el.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "") ??
          [],
      )
      .join("");
    const expected = reassembleStream(fixture.expectedEvents);
    expect(text).toBe(expected.message.content);
    const last = elements.at(-1)!;
    expect(last.candidates?.[0]?.finishReason).toBe(
      mapToGeminiFinishReason(expected.finishReason),
    );
    // v1.4 §3.2: canonical outputTokens includes reasoning; Gemini
    // splits it back into candidatesTokenCount + thoughtsTokenCount.
    const reasoning = expected.usage!.reasoningTokens ?? 0;
    expect(last.usageMetadata).toMatchObject({
      promptTokenCount: expected.usage!.inputTokens,
      candidatesTokenCount: expected.usage!.outputTokens - reasoning,
      totalTokenCount: expected.usage!.totalTokens,
      ...(reasoning > 0 && { thoughtsTokenCount: reasoning }),
    });
    expect(last.modelVersion).toBe("m");
  });

  it("gemini array form closes after an error element", () => {
    // An error event mid-array must still leave valid JSON — the "]"
    // closes the array after the {"error":{…}} element (spec §3.3).
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp-1", model: "m" },
      { type: "text_delta", text: "hi" },
      {
        type: "error",
        error: { kind: "upstream", status: 502, message: "boom" },
      },
    ];
    const out = encodeGemini(events, GEMINI_STREAMING_REQUEST, {});

    const elements = JSON.parse(out) as { error?: { code?: number } }[];
    expect(elements.at(-1)).toEqual({
      error: { code: 502, message: "boom", status: "INTERNAL" },
    });
  });

  it("gemini SSE error frame carries the google error shape", () => {
    const out = encodeGemini(
      [
        { type: "message_start", id: "resp-1", model: "m" },
        {
          type: "error",
          error: { kind: "rate_limit", status: 429, message: "slow down" },
        },
      ],
      GEMINI_STREAMING_REQUEST,
    );

    expect(out).toContain("data: {");
    expect(out).toContain(
      '"error":{"code":429,"message":"slow down","status":"RESOURCE_EXHAUSTED"}',
    );
    expect(out.endsWith("\r\n\r\n")).toBe(true);
  });

  it("gemini encoder buffers tool args until tool_call_end", () => {
    // Deltas may interleave across indices (§3.1 rule 5) — each call is
    // keyed by canonical index and emitted whole at tool_call_end.
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp-1", model: "m" },
      { type: "tool_call_start", index: 0, id: "call_a", name: "get_weather" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"city":' },
      { type: "tool_call_start", index: 1, id: "call_b", name: "get_time" },
      { type: "tool_call_delta", index: 1, argumentsDelta: '{"tz":"UTC"}' },
      { type: "tool_call_end", index: 1 },
      { type: "tool_call_delta", index: 0, argumentsDelta: '"Paris"}' },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeGemini(events, GEMINI_STREAMING_REQUEST, {});

    const elements = JSON.parse(out) as {
      candidates?: {
        content?: {
          parts?: { functionCall?: { id?: string; name?: string; args?: unknown } }[];
        };
      }[];
    }[];
    const calls = elements.flatMap(
      (el) =>
        el.candidates?.[0]?.content?.parts
          ?.map((p) => p.functionCall)
          .filter((fc) => fc !== undefined) ?? [],
    );
    expect(calls).toEqual([
      { id: "call_b", name: "get_time", args: { tz: "UTC" } },
      { id: "call_a", name: "get_weather", args: { city: "Paris" } },
    ]);
  });

  it("gemini invalid arguments become the _invalid_arguments wrapper", () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp-1", model: "m" },
      { type: "tool_call_start", index: 0, id: "call_a", name: "f" },
      { type: "tool_call_delta", index: 0, argumentsDelta: "not-json" },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeGemini(events, GEMINI_STREAMING_REQUEST);

    expect(out).toContain("_invalid_arguments");
    expect(out).toContain("not-json");
  });

  it("gemini encoder flushes unended tool calls before the final element", () => {
    // A tool_call_start with no matching tool_call_end leaves the call
    // buffered; at message_end it flushes as the same single-part
    // candidate element tool_call_end would have produced (one
    // logger.warn naming only the count).
    const warnSpy = vi.spyOn(logger, "warn");
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp-1", model: "m" },
      { type: "tool_call_start", index: 0, id: "call_a", name: "get_weather" },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"city":"Paris"}',
      },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeGemini(events, GEMINI_STREAMING_REQUEST, {});

    const elements = JSON.parse(out) as {
      candidates?: {
        content?: {
          parts?: { functionCall?: { name?: string; args?: unknown } }[];
        };
        finishReason?: string;
      }[];
    }[];
    const flushed = elements
      .flatMap((el) => el.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => p.functionCall !== undefined);
    expect(flushed).toEqual([
      {
        functionCall: {
          id: "call_a",
          name: "get_weather",
          args: { city: "Paris" },
        },
      },
    ]);
    expect(elements.at(-1)!.candidates?.[0]?.finishReason).toBe("STOP");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("1");
  });

  it("gemini encoder warns on duplicate tool_call_start and keeps the first call", () => {
    // A second tool_call_start for an index that is already open is
    // ignored — the buffered call is kept and the warn carries only
    // the event type and index (no names, ids or arguments).
    const warnSpy = vi.spyOn(logger, "warn");
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp-1", model: "m" },
      { type: "tool_call_start", index: 0, id: "call_a", name: "get_weather" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"city":' },
      { type: "tool_call_start", index: 0, id: "call_b", name: "get_time" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '"Paris"}' },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ];
    const out = encodeGemini(events, GEMINI_STREAMING_REQUEST, {});

    const elements = JSON.parse(out) as {
      candidates?: {
        content?: {
          parts?: {
            functionCall?: { id?: string; name?: string; args?: unknown };
          }[];
        };
      }[];
    }[];
    const calls = elements.flatMap(
      (el) =>
        el.candidates?.[0]?.content?.parts
          ?.map((p) => p.functionCall)
          .filter((fc) => fc !== undefined) ?? [],
    );
    expect(calls).toEqual([
      { id: "call_a", name: "get_weather", args: { city: "Paris" } },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0]![0]);
    expect(warnMessage).toContain("tool_call_start");
    expect(warnMessage).toContain("0");
    expect(warnMessage).not.toContain("get_weather");
    expect(warnMessage).not.toContain("get_time");
    expect(warnMessage).not.toContain("call_a");
    expect(warnMessage).not.toContain("call_b");
    expect(warnMessage).not.toContain("Paris");
  });

  it("gemini encoder writes nothing after a terminal event", () => {
    const afterEnd = geminiAdapter.createStreamEncoder({
      sourceRequest: GEMINI_STREAMING_REQUEST,
      query: {},
      requestedModel: "m",
    });
    afterEnd.encode({ type: "message_start", id: "resp-1", model: "m" });
    afterEnd.encode({ type: "message_end", finishReason: "stop" });
    expect(afterEnd.encode({ type: "text_delta", text: "late" })).toBe("");
    expect(
      afterEnd.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
    expect(afterEnd.end()).toBe("]");

    const afterError = geminiAdapter.createStreamEncoder({
      sourceRequest: GEMINI_STREAMING_REQUEST,
      query: { alt: "sse" },
      requestedModel: "m",
    });
    afterError.encode({
      type: "error",
      error: { kind: "upstream", status: 502, message: "boom" },
    });
    expect(afterError.encode({ type: "text_delta", text: "late" })).toBe(
      "",
    );
    expect(
      afterError.encode({ type: "message_end", finishReason: "stop" }),
    ).toBe("");
    expect(afterError.end()).toBe("");
  });
});
