import { describe, it, expect } from "vitest";
import { reassembleStream } from "./stream-reassemble";
import { ProxyError } from "./errors";
import type { CanonicalStreamEvent } from "../types/canonical.types";

describe("reassembleStream", () => {
  it("reassembles text, interleaved tool calls, usage and finish reason", () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "gpt-4" },
      { type: "text_delta", text: "Hello " },
      { type: "tool_call_start", index: 0, id: "call_0", name: "f0" },
      { type: "tool_call_start", index: 1, id: "call_1", name: "f1" },
      { type: "tool_call_delta", index: 1, argumentsDelta: '{"b":' },
      { type: "text_delta", text: "world" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"a":1}' },
      { type: "tool_call_delta", index: 1, argumentsDelta: "2}" },
      { type: "tool_call_end", index: 1 },
      { type: "tool_call_end", index: 0 },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      { type: "message_end", finishReason: "tool_call" },
    ];

    expect(reassembleStream(events)).toEqual({
      id: "msg_1",
      model: "gpt-4",
      message: {
        role: "assistant",
        content: "Hello world",
        toolCalls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "f0", arguments: '{"a":1}' },
          },
          {
            id: "call_1",
            type: "function",
            function: { name: "f1", arguments: '{"b":2}' },
          },
        ],
      },
      finishReason: "tool_call",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  });

  it("reasoning block takes origin from reasoning_start", () => {
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "deepseek-reasoner" },
      {
        type: "reasoning_start",
        index: 0,
        origin: { provider: "deepseek", model: "deepseek-reasoner" },
      },
      { type: "reasoning_delta", index: 0, text: "think " },
      { type: "reasoning_delta", index: 0, text: "more" },
      { type: "text_delta", text: "hi" },
      { type: "message_end", finishReason: "stop" },
    ];

    expect(reassembleStream(events).message.content).toEqual([
      {
        type: "reasoning",
        reasoning: {
          text: "think more",
          origin: { provider: "deepseek", model: "deepseek-reasoner" },
        },
      },
      { type: "text", text: "hi" },
    ]);
  });

  it("redacted reasoning block round-trips the flag", () => {
    const signature = {
      origin: { provider: "a", model: "claude-x" },
      data: "OPAQUE",
    };
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "claude-x" },
      {
        type: "reasoning_start",
        index: 0,
        origin: { provider: "a", model: "claude-x" },
        redacted: true,
      },
      { type: "reasoning_signature", index: 0, signature },
      { type: "text_delta", text: "ok" },
      { type: "message_end", finishReason: "stop" },
    ];

    expect(reassembleStream(events).message.content).toEqual([
      {
        type: "reasoning",
        reasoning: {
          redacted: true,
          origin: { provider: "a", model: "claude-x" },
        },
        signature,
      },
      { type: "text", text: "ok" },
    ]);
  });

  it("text_signature reassembles onto its text part", () => {
    // v1.4 spec §3.3 (Task 7a, #99): the signature attaches to the text
    // part currently being streamed; a non-empty text_delta after a
    // signed part opens a new part, so a signature never moves to
    // other text. Any signed text part makes content a parts array.
    const signature = {
      origin: { provider: "", model: "gemini-3.5-flash-lite" },
      data: "sig_text",
    };
    const events: CanonicalStreamEvent[] = [
      {
        type: "message_start",
        id: "msg_1",
        model: "gemini-3.5-flash-lite",
      },
      { type: "text_delta", text: "1," },
      { type: "text_delta", text: " 2" },
      { type: "text_signature", signature },
      { type: "text_delta", text: " tail" },
      { type: "message_end", finishReason: "stop" },
    ];

    expect(reassembleStream(events).message.content).toEqual([
      { type: "text", text: "1, 2", signature },
      { type: "text", text: " tail" },
    ]);
  });

  it("text_signature with no text opens an empty signed part", () => {
    // Gemini can send the signature on an empty final text part
    // (max_tokens.sse): with no open text part the event opens one.
    const signature = {
      origin: { provider: "", model: "gemini-3.5-flash-lite" },
      data: "sig_empty",
    };
    const events: CanonicalStreamEvent[] = [
      {
        type: "message_start",
        id: "msg_1",
        model: "gemini-3.5-flash-lite",
      },
      { type: "text_signature", signature },
      { type: "message_end", finishReason: "stop" },
    ];

    expect(reassembleStream(events).message.content).toEqual([
      { type: "text", text: "", signature },
    ]);
  });

  it("reasoning_delta without reasoning_start fails", () => {
    expect(() =>
      reassembleStream([
        { type: "message_start", id: "m", model: "m" },
        { type: "reasoning_delta", index: 0, text: "think" },
        { type: "message_end", finishReason: "stop" },
      ]),
    ).toThrow();
  });

  it("duplicate reasoning_start fails", () => {
    const start = {
      type: "reasoning_start" as const,
      index: 0,
      origin: { provider: "p", model: "m" },
    };
    expect(() =>
      reassembleStream([
        { type: "message_start", id: "m", model: "m" },
        start,
        start,
        { type: "message_end", finishReason: "stop" },
      ]),
    ).toThrow();
  });

  it("rejects a delta before its start", () => {
    expect(() =>
      reassembleStream([
        { type: "message_start", id: "m", model: "m" },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "message_end", finishReason: "stop" },
      ]),
    ).toThrow();
  });

  it("an error event throws", () => {
    expect(() =>
      reassembleStream([
        { type: "message_start", id: "m", model: "m" },
        { type: "text_delta", text: "partial" },
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "boom" },
        },
      ]),
    ).toThrow(ProxyError);
  });
});
