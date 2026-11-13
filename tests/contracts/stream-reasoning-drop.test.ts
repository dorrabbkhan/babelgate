import { describe, it, expect, vi, afterEach } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";

/**
 * Global Constraints / spec §3.3: non-Responses clients receive no
 * reasoning. Every target encoder drops reasoning_start /
 * reasoning_delta / reasoning_signature — a stream carrying them must
 * encode byte-identically to the same stream without them.
 */

const PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
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

  it.each(PROVIDERS)(
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
});
