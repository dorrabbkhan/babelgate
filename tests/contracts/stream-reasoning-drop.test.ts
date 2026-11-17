import { describe, it, expect, vi, afterEach } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";
import { unpackEnvelope } from "../../src/transformers/reasoning-envelope";

/**
 * Global Constraints / spec §3.3: non-Responses clients receive no
 * reasoning. Every target encoder drops reasoning_start /
 * reasoning_delta / reasoning_signature — a stream carrying them must
 * encode byte-identically to the same stream without them.
 *
 * v1.5 Task 4 (owner note, docs/conductor/notes/v1.5/task4.md):
 * Anthropic and Gemini encoders now emit reasoning — as a thinking
 * block / signature_delta and a `{text, thought: true}` part
 * respectively — so they leave the mid-stream case below for exact
 * byte-asserting twins in this file. The text_signature case is
 * unchanged: a signature with no carrier produces no wire bytes
 * anywhere.
 */

const PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
];

/** Providers whose encoders still emit no reasoning bytes. */
const TEXT_ONLY_PROVIDERS: Provider[] = ["openai", "ollama"];

const SOURCE_REQUESTS: Record<
  Provider,
  { sourceRequest: unknown; query: Record<string, string> }
> = {
  openai: {
    sourceRequest: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    },
    query: {},
  },
  anthropic: {
    sourceRequest: {
      model: "m",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    query: {},
  },
  gemini: {
    sourceRequest: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    query: { alt: "sse" },
  },
  ollama: {
    sourceRequest: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    query: {},
  },
};

function encode(provider: Provider, events: CanonicalStreamEvent[]): string {
  const { sourceRequest, query } = SOURCE_REQUESTS[provider];
  const encoder = adapters[provider].createStreamEncoder({
    sourceRequest,
    query,
    requestedModel: "m",
  });
  let out = "";
  for (const event of events) out += encoder.encode(event);
  return out + encoder.end();
}

describe("stream encoders drop reasoning events", () => {
  // Ollama stamps each chunk with the wall clock; freeze it so the two
  // encodes compare byte-for-byte.
  afterEach(() => vi.useRealTimers());

  it.each(TEXT_ONLY_PROVIDERS)(
    "%s: reasoning block mid-stream leaves the wire bytes unchanged",
    (provider) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
      const signature = {
        origin: { provider: "p", model: "m" },
        data: "OPAQUE",
      };
      const plain: CanonicalStreamEvent[] = [
        { type: "message_start", id: "msg_1", model: "m" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
        { type: "message_end", finishReason: "stop" },
      ];
      const withReasoning: CanonicalStreamEvent[] = [
        { type: "message_start", id: "msg_1", model: "m" },
        { type: "text_delta", text: "Hello " },
        {
          type: "reasoning_start",
          index: 0,
          origin: { provider: "p", model: "m" },
        },
        { type: "reasoning_delta", index: 0, text: "think" },
        { type: "reasoning_signature", index: 0, signature },
        { type: "text_delta", text: "world" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
        { type: "message_end", finishReason: "stop" },
      ];

      expect(encode(provider, withReasoning)).toBe(
        encode(provider, plain),
      );
    },
  );

  it.each(PROVIDERS)(
    "%s: client encoders ignore text_signature",
    (provider) => {
      // Task 7a (#99): a text_signature mid-stream changes nothing on
      // a non-Responses client's wire — byte-identical output.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
      const signature = {
        origin: { provider: "p", model: "m" },
        data: "OPAQUE",
      };
      const plain: CanonicalStreamEvent[] = [
        { type: "message_start", id: "msg_1", model: "m" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
        { type: "message_end", finishReason: "stop" },
      ];
      const withSignature: CanonicalStreamEvent[] = [
        { type: "message_start", id: "msg_1", model: "m" },
        { type: "text_delta", text: "Hello " },
        { type: "text_signature", signature },
        { type: "text_delta", text: "world" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
        { type: "message_end", finishReason: "stop" },
      ];

      expect(encode(provider, withSignature)).toBe(
        encode(provider, plain),
      );
    },
  );

  // ── v1.5 Task 4: Anthropic and Gemini now carry reasoning to the
  // client inside the `bg1.` envelope (owner note: these two cases
  // replace their entry in the mid-stream case above and assert the
  // exact events/bytes, envelope contents included). ──

  it("anthropic: reasoning block streams as thinking deltas with an envelope signature_delta", () => {
    const origin = { provider: "p", model: "m" };
    const signature = {
      origin: { provider: "p", model: "m" },
      data: "OPAQUE",
    };
    const out = encode("anthropic", [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "reasoning_start", index: 0, origin },
      { type: "reasoning_delta", index: 0, text: "think" },
      { type: "reasoning_signature", index: 0, signature },
      { type: "text_delta", text: "Hello " },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "stop" },
    ]);

    // Exact event order: the thinking block opens, streams its delta,
    // carries ONE signature_delta — the bg1. envelope — before its
    // content_block_stop; the text block follows.
    const eventOrder = [...out.matchAll(/event: (\w+)/g)].map(
      (m) => m[1],
    );
    expect(eventOrder).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const frames = [...out.matchAll(/data: (\{.*\})/g)].map((m) =>
      JSON.parse(m[1]),
    );
    expect(frames[1]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(frames[2].delta).toEqual({
      type: "thinking_delta",
      thinking: "think",
    });
    expect(frames[3].delta.type).toBe("signature_delta");
    expect(unpackEnvelope(frames[3].delta.signature)).toEqual({
      v: 1,
      reasoning: [
        {
          type: "reasoning",
          reasoning: { text: "think", origin },
          signature,
        },
      ],
      signatures: [],
    });
    expect(frames[4]).toEqual({
      type: "content_block_stop",
      index: 0,
    });
    expect(frames[5]).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });
  });

  it("gemini: reasoning block streams as a thought part with an envelope thoughtSignature", () => {
    const origin = { provider: "p", model: "m" };
    const signature = {
      origin: { provider: "p", model: "m" },
      data: "OPAQUE",
    };
    const out = encode("gemini", [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "reasoning_start", index: 0, origin },
      { type: "reasoning_delta", index: 0, text: "think" },
      { type: "reasoning_signature", index: 0, signature },
      { type: "text_delta", text: "Hello " },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "stop" },
    ]);

    const frames = [...out.matchAll(/data: (\{.*\})/g)].map((m) =>
      JSON.parse(m[1]),
    );
    // First frame: the thought part with the bg1. envelope on
    // thoughtSignature; second: the reply text; third: the close.
    expect(frames).toHaveLength(3);
    const thoughtPart =
      frames[0].candidates[0].content.parts[0];
    expect(thoughtPart.text).toBe("think");
    expect(thoughtPart.thought).toBe(true);
    expect(
      unpackEnvelope(thoughtPart.thoughtSignature),
    ).toEqual({
      v: 1,
      reasoning: [
        {
          type: "reasoning",
          reasoning: { text: "think", origin },
          signature,
        },
      ],
      signatures: [],
    });
    expect(frames[1].candidates[0].content.parts).toEqual([
      { text: "Hello " },
    ]);
    expect(frames[2].candidates[0].finishReason).toBe("STOP");
  });
});
