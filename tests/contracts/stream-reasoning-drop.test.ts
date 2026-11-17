import { describe, it, expect, vi, afterEach } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";
import { unpackEnvelope } from "../../src/transformers/reasoning-envelope";

/**
 * Global Constraints / spec §3.3: reasoning events never produce
 * signature bytes on a client that has no signature field.
 *
 * v1.5 Task 4 (owner note, docs/conductor/notes/v1.5/task4.md):
 * Anthropic and Gemini encoders now emit reasoning — as a thinking
 * block / signature_delta and a `{text, thought: true}` part
 * respectively — so they left the mid-stream byte-identical case for
 * exact byte-asserting twins in this file.
 *
 * v1.5 Task 5 (spec §3.1): Chat and Ollama encoders now emit
 * reasoning text too — `delta.reasoning_content` chunks and
 * `message.thinking` fragments — so they also left the mid-stream
 * byte-identical case (now gone entirely) for exact byte-asserting
 * twins below. Signatures still have no Chat or Ollama field: a
 * signature with no carrier produces no wire bytes on every client.
 */

/**
 * Providers where a `text_signature` produces no wire bytes. Fix round
 * (v1.5 Task 4): the Anthropic encoder now closes the signed text
 * block and carries the signature in a trailing envelope — exact
 * bytes asserted in its own case below. Gemini's signature still
 * rides a later part's envelope (none here → dropped, no bytes).
 */
const SIG_NO_WIRE_PROVIDERS: Provider[] = [
  "openai",
  "gemini",
  "ollama",
];

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

  it.each(SIG_NO_WIRE_PROVIDERS)(
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

  // ── v1.5 Task 5 (spec §3.1): Chat and Ollama now carry reasoning
  // text to the client — exact emitted bytes asserted like the Task 4
  // twins above; the signature still has no field on either format. ──

  it("openai: reasoning block streams as reasoning_content deltas, signature never emitted", () => {
    const origin = { provider: "p", model: "m" };
    const signature = {
      origin: { provider: "p", model: "m" },
      data: "OPAQUE",
    };
    const out = encode("openai", [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "text_delta", text: "Hello " },
      { type: "reasoning_start", index: 0, origin },
      { type: "reasoning_delta", index: 0, text: "think" },
      { type: "reasoning_signature", index: 0, signature },
      { type: "text_delta", text: "world" },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "stop" },
    ]);

    // Exact deltas in order: role chunk, content, the reasoning text
    // as `delta.reasoning_content`, content, the include_usage
    // `choices: []` frame, then the finish chunk — no signature bytes.
    const frames = [...out.matchAll(/data: (\{.*\})/g)].map((m) =>
      JSON.parse(m[1]),
    );
    expect(frames).toHaveLength(6);
    expect(
      frames.map((f) => f.choices[0]?.delta),
    ).toEqual([
      { role: "assistant", content: "" },
      { content: "Hello " },
      { reasoning_content: "think" },
      { content: "world" },
      undefined,
      {},
    ]);
    expect(frames[4].choices).toEqual([]);
    expect(frames[4].usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
    expect(frames[5].choices[0].finish_reason).toBe("stop");
    expect(out).toContain("data: [DONE]");
    expect(out).not.toContain("OPAQUE");
  });

  it("ollama: reasoning block streams as message.thinking fragments, signature never emitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    const origin = { provider: "p", model: "m" };
    const signature = {
      origin: { provider: "p", model: "m" },
      data: "OPAQUE",
    };
    const out = encode("ollama", [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "text_delta", text: "Hello " },
      { type: "reasoning_start", index: 0, origin },
      { type: "reasoning_delta", index: 0, text: "think" },
      { type: "reasoning_signature", index: 0, signature },
      { type: "text_delta", text: "world" },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "stop" },
    ]);

    // Exact NDJSON messages in order: content, the reasoning text as
    // `message.thinking`, content, then the done line — no signature
    // bytes.
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(
      lines.map((l) => l.message),
    ).toEqual([
      { role: "assistant", content: "Hello " },
      { role: "assistant", content: "", thinking: "think" },
      { role: "assistant", content: "world" },
      { role: "assistant", content: "" },
    ]);
    expect(lines[3]).toEqual({
      model: "m",
      created_at: "2026-11-13T00:00:00.000Z",
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: 3,
      prompt_eval_duration: 0,
      eval_count: 4,
      eval_duration: 0,
    });
    expect(out).not.toContain("OPAQUE");
  });

  it("anthropic: text_signature closes the text block and rides a trailing envelope", () => {
    // Fix round: envelope textIndex counts the text parts the client
    // echoes — the signed block closes on its text_signature so the
    // next text part is a new wire block, and a signature with no
    // following reasoning block rides a trailing `thinking` block
    // (thinking: "", one signature_delta with a `bg1.` envelope whose
    // reasoning is []).
    const signature = {
      origin: { provider: "p", model: "m" },
      data: "OPAQUE",
    };
    const out = encode("anthropic", [
      { type: "message_start", id: "msg_1", model: "m" },
      { type: "text_delta", text: "Hello " },
      { type: "text_signature", signature },
      { type: "text_delta", text: "world" },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "stop" },
    ]);

    const eventOrder = [...out.matchAll(/event: (\w+)/g)].map(
      (m) => m[1],
    );
    expect(eventOrder).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
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
      content_block: { type: "text", text: "" },
    });
    expect(frames[2].delta).toEqual({
      type: "text_delta",
      text: "Hello ",
    });
    // Second canonical text part → a second wire text block.
    expect(frames[4]).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });
    expect(frames[5].delta).toEqual({
      type: "text_delta",
      text: "world",
    });
    // Trailing thinking block carries the signature's envelope.
    expect(frames[7]).toEqual({
      type: "content_block_start",
      index: 2,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(frames[8].delta.type).toBe("signature_delta");
    expect(unpackEnvelope(frames[8].delta.signature)).toEqual({
      v: 1,
      reasoning: [],
      signatures: [{ textIndex: 0, signature }],
    });
  });
});
