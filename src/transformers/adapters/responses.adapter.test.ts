import { describe, it, expect, vi } from "vitest";
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./responses.adapter";
import {
  createStreamDecoder,
} from "./responses.stream.decode";
import { createStreamEncoder } from "./responses.stream.encode";
import { runWithTrace } from "../../observe/context";
import { newTrace, type RequestTrace } from "../../observe/trace";
import { ValidationError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { sequentialIds } from "../../utils/ids";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type {
  ResponsesRequest,
  ResponsesResponse,
} from "../../types/responses.types";
import fixtures from "../../../tests/fixtures/responses.json";

/** Run `fn` inside a trace scope and return the filled trace (§3.5). */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: "r1",
    startedAt: 0,
    client: "other",
    sourceApi: "responses",
  });
  runWithTrace(trace, fn);
  return trace;
}

describe("Responses adapter", () => {
  describe("toCanonicalRequest", () => {
    it("string input is one user message", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: "Hello",
      } as ResponsesRequest);

      expect(canonical.model).toBe("m");
      expect(canonical.messages).toEqual([
        { role: "user", content: "Hello" },
      ]);
    });

    it("instructions and developer messages become the system prompt", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        instructions: "Be terse",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Follow the repo rules" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      } as ResponsesRequest);

      expect(canonical.systemPrompt).toBe(
        "Be terse\n\nFollow the repo rules",
      );
      expect(canonical.messages.map((m) => m.role)).toEqual([
        "system",
        "system",
        "user",
      ]);
    });

    it("function_call and output round-trip (call_id preserved)", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "call_abc",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            type: "function_call_output",
            call_id: "call_abc",
            output: "sunny",
          },
        ],
      } as ResponsesRequest);

      expect(canonical.messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        { role: "tool", toolCallId: "call_abc", content: "sunny" },
      ]);

      const wire = fromCanonicalRequest(canonical) as unknown as {
        input: Array<Record<string, unknown>>;
      };
      expect(wire.input).toEqual([
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: "sunny",
        },
      ]);
    });

    it("tool_choice forms", () => {
      const withChoice = (tool_choice: unknown) =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          tool_choice,
        } as ResponsesRequest).toolChoice;

      expect(withChoice("auto")).toBe("auto");
      expect(withChoice("none")).toBe("none");
      expect(withChoice("required")).toBe("required");
      expect(withChoice({ type: "function", name: "get_weather" })).toEqual({
        type: "function",
        function: { name: "get_weather" },
      });
    });

    it("remote image URLs are a 400, data URLs decode", () => {
      expect(() =>
        toCanonicalRequest({
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "https://example.com/cat.png",
                },
              ],
            },
          ],
        } as ResponsesRequest),
      ).toThrow(ValidationError);

      const canonical = toCanonicalRequest(
        fixtures.requests.multimodal as ResponsesRequest,
      );
      const parts = canonical.messages[0].content;
      expect(Array.isArray(parts) && parts[1]).toEqual({
        type: "image",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      });
    });

    it("dropped fields are noted, never sent", () => {
      const trace = traced(() =>
        toCanonicalRequest(fixtures.requests.codex as ResponsesRequest),
      );

      const paths = trace.notes.map((n) => n.path);
      for (const field of [
        "reasoning",
        "include",
        "prompt_cache_key",
        "client_metadata",
      ]) {
        expect(paths).toContain(field);
      }
      // namespace and web_search are parsed, not honoured — noted drops
      // (lowering belongs to Tasks 5/8).
      expect(paths).toContain("tools[1]");
      expect(paths).toContain("tools[2]");
      expect(
        trace.notes.every((n) => n.code !== "content"),
      ).toBe(true);

      const canonical = toCanonicalRequest(
        fixtures.requests.codex as ResponsesRequest,
      );
      const wire = fromCanonicalRequest(canonical) as Record<string, unknown>;
      for (const field of [
        "reasoning",
        "include",
        "prompt_cache_key",
        "client_metadata",
      ]) {
        expect(wire[field]).toBeUndefined();
      }
      // only the real function tool survives
      expect(wire.tools).toEqual([
        expect.objectContaining({ type: "function", name: "exec_command" }),
      ]);
      // namespace/built-in tools never reach the wire
      expect(JSON.stringify(wire)).not.toContain("namespace");
      expect(JSON.stringify(wire)).not.toContain("web_search");
    });

    it("request encode round-trips the fixture (minus dropped fields)", () => {
      for (const name of ["basic", "developer", "tools", "multimodal"]) {
        const request = JSON.parse(
          JSON.stringify(
            fixtures.requests[name as keyof typeof fixtures.requests],
          ),
        ) as Record<string, unknown>;
        const canonical = toCanonicalRequest(
          request as unknown as ResponsesRequest,
        );
        const wire = fromCanonicalRequest(canonical) as Record<
          string,
          unknown
        >;

        // `strict` on function tools is a noted drop (same convention
        // as the openai adapter); strip it from the expectation.
        const expected = JSON.parse(JSON.stringify(request)) as {
          tools?: Array<Record<string, unknown>>;
        };
        for (const tool of expected.tools ?? []) {
          delete tool.strict;
        }
        const { tools: wireTools, ...wireRest } = wire as {
          tools?: Array<Record<string, unknown>>;
        } & Record<string, unknown>;
        for (const tool of wireTools ?? []) {
          delete tool.strict;
        }
        expect({ ...wireRest, tools: wireTools }).toEqual(expected);
      }
    });
  });

  describe("toCanonicalResponse", () => {
    it("length finish is incomplete max_output_tokens", () => {
      const canonical = toCanonicalResponse(
        fixtures.responses.incomplete as unknown as ResponsesResponse,
        "m",
      );

      expect(canonical.finishReason).toBe("length");
      expect(canonical.message.role).toBe("assistant");
      expect(canonical.message.content).toEqual([
        { type: "text", text: "partial answer" },
      ]);
    });

    it("function_call output becomes toolCalls with call_id as id", () => {
      const canonical = toCanonicalResponse(
        fixtures.responses.function_call as unknown as ResponsesResponse,
        "m",
      );

      expect(canonical.finishReason).toBe("tool_call");
      expect(canonical.message.toolCalls).toEqual([
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
        },
      ]);
    });

    it("usage with cached and reasoning tokens", () => {
      const canonical = toCanonicalResponse(
        {
          id: "resp_u",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "m",
          output: [],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 900 },
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 20 },
            total_tokens: 1050,
          },
        } as unknown as ResponsesResponse,
        "m",
      );

      expect(canonical.usage).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        cacheReadTokens: 900,
        reasoningTokens: 20,
      });
    });
  });

  describe("fromCanonicalResponse", () => {
    const canonicalOf = (
      response: Partial<CanonicalResponse>,
    ): CanonicalResponse => ({
      id: "abc",
      model: "upstream-model",
      message: { role: "assistant", content: "hi" },
      finishReason: "stop",
      ...response,
    });

    it("length finish is incomplete max_output_tokens", () => {
      const wire = fromCanonicalResponse(
        canonicalOf({ finishReason: "length" }),
      ) as unknown as Record<string, unknown>;

      expect(wire.status).toBe("incomplete");
      expect(wire.incomplete_details).toEqual({
        reason: "max_output_tokens",
      });
    });

    it("message + function_call output items with resp_/msg_/fc_ ids", () => {
      const wire = fromCanonicalResponse(
        canonicalOf({
          finishReason: "tool_call",
          message: {
            role: "assistant",
            content: "let me check",
            toolCalls: [
              {
                id: "call_xyz",
                type: "function",
                function: { name: "ls", arguments: "{}" },
              },
            ],
          },
        }),
      ) as unknown as {
        id: string;
        object: string;
        status: string;
        output: Array<Record<string, unknown>>;
      };

      expect(wire.id).toBe("resp_abc");
      expect(wire.object).toBe("response");
      expect(wire.status).toBe("completed");
      expect(wire.output).toEqual([
        {
          type: "message",
          id: "msg_0",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "let me check", annotations: [] },
          ],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_xyz",
          name: "ls",
          arguments: "{}",
          status: "completed",
        },
      ]);
    });

    it("usage renders input/output details", () => {
      const wire = fromCanonicalResponse(
        canonicalOf({
          usage: {
            inputTokens: 1000,
            outputTokens: 50,
            totalTokens: 1050,
            cacheReadTokens: 900,
            reasoningTokens: 20,
          },
        }),
      ) as unknown as { usage: Record<string, unknown> };

      expect(wire.usage).toEqual({
        input_tokens: 1000,
        input_tokens_details: {
          cached_tokens: 900,
          cache_write_tokens: 0,
        },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 1050,
      });
    });
  });

  describe("streaming", () => {
    const ctx = (
      requestedModel = "client-model",
    ): StreamEncoderContext<ResponsesRequest> => ({
      sourceRequest: {
        model: requestedModel,
        input: "hi",
        stream: true,
      } as ResponsesRequest,
      query: {},
      requestedModel,
    });

    const EVENTS: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp_1", model: "client-model" },
      { type: "text_delta", text: "Hello" },
      {
        type: "tool_call_start",
        index: 0,
        id: "call_1",
        name: "get_weather",
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '{"location":"Paris"}',
      },
      { type: "tool_call_end", index: 0 },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      { type: "message_end", finishReason: "tool_call" },
    ];

    function encodeAll(
      events: CanonicalStreamEvent[],
      context = ctx(),
    ): { event?: string; data: any }[] {
      const encoder = createStreamEncoder(context);
      let wire = "";
      for (const event of events) wire += encoder.encode(event);
      wire += encoder.end();
      return wire
        .split("\n\n")
        .map((f) => f.trim())
        .filter((f) => f !== "")
        .map((frame) => {
          let event: string | undefined;
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:"))
              data.push(line.slice(5).replace(/^ /, ""));
          }
          const text = data.join("\n");
          return {
            event,
            data: text === "[DONE]" ? text : JSON.parse(text),
          };
        });
    }

    function decodeAll(wire: string): CanonicalStreamEvent[] {
      const decoder = createStreamDecoder("m", sequentialIds());
      const events = decoder.feed(new TextEncoder().encode(wire));
      events.push(...decoder.end());
      return events;
    }

    it("sequence_number is contiguous and every frame is event-typed", () => {
      const frames = encodeAll(EVENTS);
      const seqs = frames.map((f) => f.data.sequence_number);
      expect(seqs).toEqual(frames.map((_, i) => i));
      for (const f of frames) {
        // plan §4: SSE framing is `event: <type>` matching the
        // payload's own `type` (Responses streaming reference).
        expect(f.event).toBe(f.data.type);
        expect(f.data.type).toMatch(/^response\./);
      }
    });

    it("parallel calls each get their own output_index", () => {
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        {
          type: "tool_call_start",
          index: 0,
          id: "call_1",
          name: "a",
        },
        { type: "tool_call_end", index: 0 },
        {
          type: "tool_call_start",
          index: 1,
          id: "call_2",
          name: "b",
        },
        { type: "tool_call_end", index: 1 },
        { type: "message_end", finishReason: "tool_call" },
      ]);
      const added = frames.filter(
        (f) =>
          f.data.type === "response.output_item.added" &&
          f.data.item?.type === "function_call",
      );
      expect(added.map((f) => f.data.output_index)).toEqual([0, 1]);
      expect(added.map((f) => f.data.item.call_id)).toEqual([
        "call_1",
        "call_2",
      ]);
    });

    it("interleaved canonical deltas are not interleaved on the wire", () => {
      // Canonical rule 5 lets call blocks interleave; the Responses
      // wire serialises items per output_index — every frame of call
      // 0's item precedes call 1's output_item.added.
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        { type: "tool_call_start", index: 0, id: "call_1", name: "a" },
        { type: "tool_call_start", index: 1, id: "call_2", name: "b" },
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"a":' },
        { type: "tool_call_delta", index: 1, argumentsDelta: '{"b":' },
        { type: "tool_call_delta", index: 0, argumentsDelta: "1}" },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_delta", index: 1, argumentsDelta: "2}" },
        { type: "tool_call_end", index: 1 },
        { type: "message_end", finishReason: "tool_call" },
      ]);
      const first = frames.findIndex(
        (f) =>
          f.data.type === "response.output_item.added" &&
          f.data.item?.call_id === "call_1",
      );
      const firstDone = frames.findIndex(
        (f) =>
          f.data.type === "response.output_item.done" &&
          f.data.item?.call_id === "call_1",
      );
      const secondAdded = frames.findIndex(
        (f) =>
          f.data.type === "response.output_item.added" &&
          f.data.item?.call_id === "call_2",
      );
      expect(first).toBeGreaterThan(-1);
      expect(firstDone).toBeGreaterThan(first);
      expect(secondAdded).toBeGreaterThan(firstDone);
      // No frame of the second item appears between the first
      // item's added and done.
      const secondItemId = frames[secondAdded].data.item.id;
      expect(
        frames
          .slice(first, firstDone + 1)
          .every((f) => f.data.item_id !== secondItemId),
      ).toBe(true);
    });

    it("failed stream ends with response.failed and no response.completed", () => {
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        { type: "text_delta", text: "partial" },
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "boom" },
        },
      ]);
      const types = frames.map((f) => f.data.type);
      expect(types.at(-1)).toBe("response.failed");
      expect(types).not.toContain("response.completed");
      const failed = frames.at(-1)!.data;
      expect(failed.response.status).toBe("failed");
      expect(failed.response.error).toEqual(
        expect.objectContaining({ message: "boom" }),
      );
    });

    it("model in response.created and response.completed is the client's", () => {
      const frames = encodeAll(
        [
          { type: "message_start", id: "r", model: "upstream-model" },
          { type: "text_delta", text: "hi" },
          { type: "message_end", finishReason: "stop" },
        ],
        ctx("client-model"),
      );
      for (const type of ["response.created", "response.completed"]) {
        const frame = frames.find((f) => f.data.type === type);
        expect(frame?.data.response.model).toBe("client-model");
      }
    });

    it("decoder accepts SSE with no event: lines (E19, OpenRouter)", () => {
      const wire = [
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_e19","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
        "",
        'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}',
        "",
        'data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}',
        "",
        'data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_e19","object":"response","created_at":1,"status":"completed","model":"m","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hi","annotations":[]}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
        "",
      ].join("\n");

      expect(decodeAll(wire)).toEqual([
        { type: "message_start", id: "resp_e19", model: "m" },
        { type: "text_delta", text: "hi" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        },
        { type: "message_end", finishReason: "stop" },
      ]);
    });

    it("decoder accepts a trailing data: [DONE]", () => {
      const wire =
        'data: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_d","object":"response","created_at":1,"status":"completed","model":"m","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n';
      const events = decodeAll(wire);
      expect(events.at(-1)).toEqual({
        type: "message_end",
        finishReason: "stop",
      });
      expect(events.every((e) => e.type !== "error")).toBe(true);
    });

    it("an in-stream error event decodes to canonical error", () => {
      const wire =
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}\n\n' +
        'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"slow down","param":null}\n\n';
      const events = decodeAll(wire);
      expect(events.at(-1)?.type).toBe("error");
    });

    // Terminal `response.completed` reconcile of `output[]` message
    // items: the item is skipped only when text for its item_id was
    // already emitted — being announced by `output_item.added` alone
    // must not suppress it, and streamed text must not be re-emitted.
    const COMPLETED_WITH_HELLO =
      'data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_r","object":"response","created_at":1,"status":"completed","model":"m","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}';

    function joinedText(events: CanonicalStreamEvent[]): string {
      return events
        .map((e) => (e.type === "text_delta" ? e.text : ""))
        .join("");
    }

    function expectSingleStopEnd(events: CanonicalStreamEvent[]): void {
      expect(events.filter((e) => e.type === "message_end")).toEqual([
        { type: "message_end", finishReason: "stop" },
      ]);
      expect(events.at(-1)).toEqual({
        type: "message_end",
        finishReason: "stop",
      });
    }

    it("reconcile does not re-emit text already streamed by deltas", () => {
      const wire = [
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_r","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
        "",
        'data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello there"}',
        "",
        COMPLETED_WITH_HELLO,
        "",
      ].join("\n");
      const events = decodeAll(wire);
      expect(joinedText(events)).toBe("Hello there");
      expectSingleStopEnd(events);
    });

    it("reconcile emits text for a message item only announced by output_item.added", () => {
      const wire = [
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_r","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
        "",
        'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}',
        "",
        COMPLETED_WITH_HELLO,
        "",
      ].join("\n");
      const events = decodeAll(wire);
      expect(joinedText(events)).toBe("Hello there");
      expectSingleStopEnd(events);
    });

    it("reconcile does not re-emit text emitted by output_text.done", () => {
      const wire = [
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_r","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
        "",
        'data: {"type":"response.output_text.done","sequence_number":1,"item_id":"msg_1","output_index":0,"content_index":0,"text":"Hello there"}',
        "",
        COMPLETED_WITH_HELLO,
        "",
      ].join("\n");
      const events = decodeAll(wire);
      expect(events.filter((e) => e.type === "text_delta")).toEqual([
        { type: "text_delta", text: "Hello there" },
      ]);
      expect(joinedText(events)).toBe("Hello there");
      expectSingleStopEnd(events);
    });

    it("encoder/decode round trip keeps call ids and text", () => {
      const wire = encodeAll(EVENTS)
        .map((f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${JSON.stringify(f.data)}`)
        .join("\n\n");
      expect(decodeAll(`${wire}\n\n`)).toEqual(EVENTS);
    });

    // A `.done` event's `arguments` is the call's full arguments: when
    // it extends the streamed deltas the decoder emits the missing
    // suffix so the concatenated deltas are the arguments exactly as
    // sent (canonical rule 3); a mismatch keeps the streamed deltas
    // and only logs the event type and call index — never the args.
    const ARGS_STREAM = {
      created:
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_a","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
      added:
        'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"f","arguments":"","status":"in_progress"}}',
      completed:
        'data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_a","object":"response","created_at":1,"status":"completed","model":"m","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      delta: (text: string, seq: number) =>
        `data: {"type":"response.function_call_arguments.delta","sequence_number":${seq},"item_id":"fc_1","output_index":0,"delta":${JSON.stringify(text)}}`,
      argsDone: (args: string, seq: number) =>
        `data: {"type":"response.function_call_arguments.done","sequence_number":${seq},"item_id":"fc_1","output_index":0,"arguments":${JSON.stringify(args)}}`,
      itemDone: (args: string, seq: number) =>
        `data: {"type":"response.output_item.done","sequence_number":${seq},"output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"f","arguments":${JSON.stringify(args)},"status":"completed"}}`,
    };

    function joinedArgs(events: CanonicalStreamEvent[], index = 0): string {
      return events
        .map((e) =>
          e.type === "tool_call_delta" && e.index === index
            ? e.argumentsDelta
            : "",
        )
        .join("");
    }

    it("deltas then a longer full arguments at .done emit the suffix", () => {
      const wire = [
        ARGS_STREAM.created,
        "",
        ARGS_STREAM.added,
        "",
        ARGS_STREAM.delta('{"a":', 2),
        "",
        ARGS_STREAM.argsDone('{"a":1}', 3),
        "",
        ARGS_STREAM.completed,
        "",
      ].join("\n");
      expect(joinedArgs(decodeAll(wire))).toBe('{"a":1}');
    });

    it("output_item.done alone emits the suffix over partial deltas", () => {
      const wire = [
        ARGS_STREAM.created,
        "",
        ARGS_STREAM.added,
        "",
        ARGS_STREAM.delta('{"a":', 2),
        "",
        ARGS_STREAM.itemDone('{"a":1}', 3),
        "",
        ARGS_STREAM.completed,
        "",
      ].join("\n");
      expect(joinedArgs(decodeAll(wire))).toBe('{"a":1}');
    });

    it("equal full arguments at .done emit no extra delta", () => {
      const wire = [
        ARGS_STREAM.created,
        "",
        ARGS_STREAM.added,
        "",
        ARGS_STREAM.delta('{"a":1}', 2),
        "",
        ARGS_STREAM.argsDone('{"a":1}', 3),
        "",
        ARGS_STREAM.itemDone('{"a":1}', 4),
        "",
        ARGS_STREAM.completed,
        "",
      ].join("\n");
      const events = decodeAll(wire);
      expect(events.filter((e) => e.type === "tool_call_delta")).toEqual([
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"a":1}' },
      ]);
      expect(joinedArgs(events)).toBe('{"a":1}');
    });

    it("mismatched full arguments keep the streamed deltas", () => {
      const debugSpy = vi
        .spyOn(logger, "debug")
        .mockImplementation(() => logger);
      try {
        const wire = [
          ARGS_STREAM.created,
          "",
          ARGS_STREAM.added,
          "",
          ARGS_STREAM.delta('{"b":', 2),
          "",
          ARGS_STREAM.argsDone('{"a":1}', 3),
          "",
          ARGS_STREAM.itemDone('{"a":1}', 4),
          "",
          ARGS_STREAM.completed,
          "",
        ].join("\n");
        expect(joinedArgs(decodeAll(wire))).toBe('{"b":');
        // The debug line names only the event type and call index —
        // the arguments themselves are content and are never logged.
        expect(debugSpy).toHaveBeenCalledWith(
          { type: "response.function_call_arguments.done", index: 0 },
          expect.any(String),
        );
        const logged = JSON.stringify(debugSpy.mock.calls);
        expect(logged).not.toContain('{"a":1}');
        expect(logged).not.toContain('{"b":');
      } finally {
        debugSpy.mockRestore();
      }
    });

    it("response.failed carries usage: null when no usage arrived", () => {
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        { type: "text_delta", text: "partial" },
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "boom" },
        },
      ]);
      const failed = frames.at(-1)!.data;
      expect(failed.type).toBe("response.failed");
      expect(failed.response).toHaveProperty("usage", null);
    });

    it("response.failed keeps usage when a usage event arrived", () => {
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        {
          type: "usage",
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
        {
          type: "error",
          error: { kind: "upstream", status: 502, message: "boom" },
        },
      ]);
      const failed = frames.at(-1)!.data;
      expect(failed.type).toBe("response.failed");
      expect(failed.response.usage?.input_tokens).toBe(7);
    });

    it("terminal response.completed carries the unary field set", () => {
      const frames = encodeAll(EVENTS);
      const streamed = frames.find(
        (f) => f.data.type === "response.completed",
      )!.data.response as Record<string, unknown>;
      const unary = fromCanonicalResponse({
        id: "resp_1",
        model: "client-model",
        message: {
          role: "assistant",
          content: "Hello",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        finishReason: "tool_call",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }) as unknown as Record<string, unknown>;
      expect(Object.keys(streamed).sort()).toEqual(
        Object.keys(unary).sort(),
      );
    });
  });
});
