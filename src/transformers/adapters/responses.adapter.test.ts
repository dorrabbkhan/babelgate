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

    it("function_call_output output array decodes to tool parts", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [
              { type: "input_text", text: "see this" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,YWJj",
              },
            ],
          },
        ],
      } as ResponsesRequest);

      expect(canonical.messages).toEqual([
        {
          role: "tool",
          toolCallId: "call_1",
          content: [
            { type: "text", text: "see this" },
            {
              type: "image",
              image: { data: "YWJj", mimeType: "image/png" },
            },
          ],
        },
      ]);
    });

    it("tool image reaches responses target", () => {
      const wire = fromCanonicalRequest({
        model: "m",
        messages: [
          {
            role: "tool",
            toolCallId: "call_1",
            content: [
              { type: "text", text: "see this" },
              {
                type: "image",
                image: { data: "YWJj", mimeType: "image/png" },
              },
            ],
          },
        ],
      } as Parameters<typeof fromCanonicalRequest>[0]) as unknown as {
        input: Array<Record<string, unknown>>;
      };

      expect(wire.input).toEqual([
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "see this" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,YWJj",
              detail: "auto",
            },
          ],
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

    it("remote image URLs decode to url images, data URLs decode", () => {
      // v1.5 §3.2.2: a remote image_url keeps its URL (was a 400).
      const remote = toCanonicalRequest({
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
      } as ResponsesRequest);
      expect(remote.messages[0].content).toEqual([
        {
          type: "image",
          image: { url: "https://example.com/cat.png" },
        },
      ]);

      const canonical = toCanonicalRequest(
        fixtures.requests.multimodal as ResponsesRequest,
      );
      const parts = canonical.messages[0].content;
      expect(Array.isArray(parts) && parts[1]).toEqual({
        type: "image",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      });
    });

    it("input_file decodes to a document part", () => {
      // v1.5 §3.2.2: file_data / file_url per the Responses reference —
      // https://platform.openai.com/docs/api-reference/responses/create
      const byData = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                file_data: "data:application/pdf;base64,JVBERi0=",
                filename: "spec.pdf",
              },
            ],
          },
        ],
      } as ResponsesRequest);
      expect(byData.messages[0].content).toEqual([
        {
          type: "document",
          document: {
            data: "JVBERi0=",
            mimeType: "application/pdf",
            name: "spec.pdf",
          },
        },
      ]);

      const byUrl = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                file_url: "https://cdn.example.com/spec.pdf",
                filename: "spec.pdf",
              },
            ],
          },
        ],
      } as ResponsesRequest);
      expect(byUrl.messages[0].content).toEqual([
        {
          type: "document",
          document: {
            url: "https://cdn.example.com/spec.pdf",
            mimeType: "application/pdf",
            name: "spec.pdf",
          },
        },
      ]);
    });

    it("url image encodes to input_image, document encodes to input_file", () => {
      const wire = fromCanonicalRequest({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: { url: "https://cdn.example.com/cat.png" },
              },
              {
                type: "document",
                document: {
                  data: "JVBERi0=",
                  mimeType: "application/pdf",
                  name: "spec.pdf",
                },
              },
              {
                type: "document",
                document: {
                  url: "https://cdn.example.com/other.pdf",
                  mimeType: "application/pdf",
                },
              },
            ],
          },
        ],
      });
      expect(wire.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://cdn.example.com/cat.png",
              detail: "auto",
            },
            {
              type: "input_file",
              file_data: "data:application/pdf;base64,JVBERi0=",
              filename: "spec.pdf",
            },
            {
              type: "input_file",
              file_url: "https://cdn.example.com/other.pdf",
            },
          ],
        },
      ]);
    });

    it("dropped fields are noted, never sent", () => {
      const trace = traced(() =>
        toCanonicalRequest(fixtures.requests.codex as ResponsesRequest),
      );

      const paths = trace.notes.map((n) => n.path);
      for (const field of [
        "prompt_cache_key",
        "client_metadata",
      ]) {
        expect(paths).toContain(field);
      }
      // web_search is parsed, not honoured — a noted drop; the
      // namespace tool rides canonical natively (Task 5, spec §3.6).
      expect(paths).toContain("tools[2]");
      expect(
        trace.notes.every((n) => n.code !== "content"),
      ).toBe(true);

      const canonical = toCanonicalRequest(
        fixtures.requests.codex as ResponsesRequest,
      );
      const wire = fromCanonicalRequest(canonical) as Record<string, unknown>;
      for (const field of [
        "prompt_cache_key",
        "client_metadata",
      ]) {
        expect(wire[field]).toBeUndefined();
      }
      // Task 6: reasoning + include decode into config.reasoning and
      // encode back verbatim.
      expect(canonical.config?.reasoning).toEqual({ summary: true });
      expect(wire.reasoning).toEqual({ summary: "auto" });
      expect(wire.include).toEqual(["reasoning.encrypted_content"]);
      // the function tool and the namespace tool survive natively
      expect(wire.tools).toEqual([
        expect.objectContaining({ type: "function", name: "exec_command" }),
        expect.objectContaining({ type: "namespace", name: "multi_agent_v1" }),
      ]);
      // the built-in tool never reaches the wire
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

  describe("reasoning config (v1.4 spec §3.3)", () => {
    it("responses decoder produces config.reasoning", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          reasoning: { effort: "high", summary: "auto" },
          include: ["reasoning.encrypted_content"],
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: { effort: "high", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toEqual({
        effort: "high",
        summary: true,
      });
      expect(
        trace.notes.filter((n) => n.code === "field_dropped"),
      ).toEqual([]);
    });

    it("summary auto alone produces reasoning config", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: { summary: "auto" },
      } as unknown as ResponsesRequest);

      expect(canonical.config?.reasoning).toEqual({ summary: true });
    });

    it("include reasoning.encrypted_content alone produces reasoning config", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        include: ["reasoning.encrypted_content"],
      } as unknown as ResponsesRequest);

      expect(canonical.config?.reasoning).toEqual({});
    });

    it("effort max lowers to xhigh with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          reasoning: { effort: "max" },
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: { effort: "max" },
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toEqual({ effort: "xhigh" });
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "reasoning_effort_lowered",
        path: "reasoning.effort",
      });
    });

    it("deprecated generate_summary also maps to summary", () => {
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: { generate_summary: "detailed" },
      } as unknown as ResponsesRequest);

      expect(canonical.config?.reasoning).toEqual({ summary: true });
    });

    it("unrelated include values are still dropped with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          include: ["message.output_text.logprobs"],
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        include: ["message.output_text.logprobs"],
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "include",
      });
    });

    it("a non-object reasoning is dropped with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          reasoning: "high",
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: "high",
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "reasoning",
      });
    });

    it("a non-string effort is dropped with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          reasoning: { effort: 5 },
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        reasoning: { effort: 5 },
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toEqual({});
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "reasoning.effort",
      });
    });

    it("a non-array include is dropped with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          include: "reasoning.encrypted_content",
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        include: "reasoning.encrypted_content",
      } as unknown as ResponsesRequest);
      expect(canonical.config?.reasoning).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "include",
      });
    });

    it("encoder emits reasoning effort, summary auto and include", () => {
      const result = fromCanonicalRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        config: { reasoning: { effort: "medium", summary: true } },
      }) as unknown as Record<string, unknown>;

      expect(result.reasoning).toEqual({
        effort: "medium",
        summary: "auto",
      });
      expect(result.include).toEqual(["reasoning.encrypted_content"]);
    });

    it("encoder emits bare reasoning and include when config is empty", () => {
      const result = fromCanonicalRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        config: { reasoning: {} },
      }) as unknown as Record<string, unknown>;

      expect(result.reasoning).toEqual({});
      expect(result.include).toEqual(["reasoning.encrypted_content"]);
    });

    it("no reasoning config means no reasoning or include fields", () => {
      const result = fromCanonicalRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        config: {},
      }) as unknown as Record<string, unknown>;

      expect(result.reasoning).toBeUndefined();
      expect(result.include).toBeUndefined();
    });

    it("no effort leaves thinking off", () => {
      // The Codex case (summary only) keeps summary:"auto" with no
      // effort field.
      expect(
        fromCanonicalRequest({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          config: { reasoning: { summary: true } },
        }),
      ).toEqual({
        model: "m",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
        store: false,
        reasoning: { summary: "auto" },
        include: ["reasoning.encrypted_content"],
      });
    });

    it("budgetTokens is dropped with a note", () => {
      const trace = traced(() =>
        fromCanonicalRequest({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          config: { reasoning: { budgetTokens: 4096 } },
        }),
      );

      expect(trace.notes).toContainEqual({
        stage: "encode",
        adapter: "responses",
        code: "reasoning_budget_dropped",
        path: "reasoning.budget_tokens",
      });
    });
  });

  describe("custom and namespace tools (v1.4 spec §3.6)", () => {
    it("web_search dropped with builtin_tool_dropped", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          tools: [{ type: "web_search" }],
        } as unknown as ResponsesRequest),
      );

      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "builtin_tool_dropped",
        path: "tools[0]",
      });
    });

    it("tool_choice naming a dropped tool becomes auto", () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: "m",
          input: "hi",
          tool_choice: { type: "web_search" },
        } as unknown as ResponsesRequest),
      );

      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        tool_choice: { type: "web_search" },
      } as unknown as ResponsesRequest);
      expect(canonical.toolChoice).toBe("auto");
      expect(
        trace.notes.some(
          (n) => n.code === "field_dropped" && n.path === "tool_choice",
        ),
      ).toBe(true);
    });

    it("tool_choice naming a custom tool round-trips as {type:custom}", () => {
      // `{type:"custom", name}` per the Responses create reference and
      // the openai 7.30.1 SDK's ToolChoiceCustom — canonical's named
      // choice is provider-agnostic, so the encode decides from the
      // request's tools.
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        tools: [{ type: "custom", name: "apply_patch" }],
        tool_choice: { type: "custom", name: "apply_patch" },
      } as unknown as ResponsesRequest);
      expect(canonical.toolChoice).toEqual({
        type: "function",
        function: { name: "apply_patch" },
      });

      const wire = fromCanonicalRequest(canonical) as unknown as Record<
        string,
        unknown
      >;
      expect(wire.tool_choice).toEqual({
        type: "custom",
        name: "apply_patch",
      });
    });

    it("tool_choice naming a function tool stays {type:function}", () => {
      const wire = fromCanonicalRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather" },
          },
          { type: "custom", name: "apply_patch" },
        ],
        toolChoice: { type: "function", function: { name: "get_weather" } },
      }) as unknown as Record<string, unknown>;

      expect(wire.tool_choice).toEqual({
        type: "function",
        name: "get_weather",
      });
    });

    it("custom_tool_call round-trips", () => {
      // Item shapes per
      // https://platform.openai.com/docs/api-reference/responses/object
      // (`custom_tool_call` {call_id, name, input};
      // `custom_tool_call_output` {call_id, output}) and the openai
      // 7.30.1 SDK ResponseInputItem typings.
      const canonical = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_9",
            name: "apply_patch",
            input: "*** Begin Patch\n@@\n*** End Patch",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_9",
            output: "patched",
          },
        ],
      } as unknown as ResponsesRequest);

      expect(canonical.messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_9",
              type: "function",
              custom: true,
              function: {
                name: "apply_patch",
                arguments: "*** Begin Patch\n@@\n*** End Patch",
              },
            },
          ],
        },
        { role: "tool", toolCallId: "call_9", content: "patched" },
      ]);

      const wire = fromCanonicalRequest(canonical) as unknown as {
        input: Array<Record<string, unknown>>;
      };
      expect(wire.input).toEqual([
        {
          type: "custom_tool_call",
          call_id: "call_9",
          name: "apply_patch",
          input: "*** Begin Patch\n@@\n*** End Patch",
          status: "completed",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_9",
          output: "patched",
        },
      ]);
    });

    it("custom tool and custom_tool_call output decode and re-encode", () => {
      // tools[].type "custom" + `format` (text|grammar) per
      // https://platform.openai.com/docs/api-reference/responses/create
      // and the openai 7.30.1 SDK `CustomTool` typing.
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            description: "Patch tool",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: "start: patch",
            },
          },
        ],
      } as unknown as ResponsesRequest);

      expect(canonical.tools).toEqual([
        {
          type: "custom",
          name: "apply_patch",
          description: "Patch tool",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: patch",
          },
        },
      ]);

      const wire = fromCanonicalRequest(canonical) as unknown as {
        tools: Array<Record<string, unknown>>;
      };
      expect(wire.tools).toEqual([
        {
          type: "custom",
          name: "apply_patch",
          description: "Patch tool",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: patch",
          },
        },
      ]);
    });

    it("namespace tool rides canonical and re-encodes natively", () => {
      // `{type:"namespace", name, description, tools}` per the
      // openai 7.30.1 SDK `NamespaceTool` typing; Codex's usage is
      // evidenced by codex-rs/core/src/client.rs at Codex 0.169.0 and
      // tests/fixtures/codex/recording.jsonl.
      const nested = [
        {
          type: "function",
          name: "spawn_agent",
          description: "Spawn",
          parameters: { type: "object" },
        },
      ];
      const canonical = toCanonicalRequest({
        model: "m",
        input: "hi",
        tools: [
          {
            type: "namespace",
            name: "multi_agent_v1",
            description: "Sub-agents",
            tools: nested,
          },
        ],
      } as unknown as ResponsesRequest);

      expect(canonical.tools).toEqual([
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "Sub-agents",
          tools: [
            {
              type: "function",
              function: {
                name: "spawn_agent",
                description: "Spawn",
                parameters: { type: "object" },
              },
            },
          ],
        },
      ]);

      const wire = fromCanonicalRequest(canonical) as unknown as {
        tools: Array<Record<string, unknown>>;
      };
      expect(wire.tools).toEqual([
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "Sub-agents",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn",
              parameters: { type: "object" },
              strict: null,
            },
          ],
        },
      ]);
    });

    it("namespaced function_call items decode natively", () => {
      // `function_call` items carry an explicit `namespace` field —
      // codex-rs/core/src/tools/router.rs `build_tool_call` reads only
      // that field (Codex 0.169.0); a flat name never matches. The
      // canonical call keeps `{name: leaf, function.namespace}`;
      // the `ns__leaf` flat name exists only in lowered (upstream)
      // copies.
      const canonical = toCanonicalRequest({
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "spawn_agent",
            namespace: "multi_agent_v1",
            arguments: "{}",
          },
        ],
      } as unknown as ResponsesRequest);

      expect(canonical.messages[0].toolCalls?.[0].function).toEqual({
        name: "spawn_agent",
        namespace: "multi_agent_v1",
        arguments: "{}",
      });

      // …and re-encodes with the explicit namespace field intact.
      const wire = fromCanonicalRequest(canonical) as unknown as {
        input: Array<Record<string, unknown>>;
      };
      expect(wire.input[0]).toMatchObject({
        type: "function_call",
        name: "spawn_agent",
        namespace: "multi_agent_v1",
      });
    });

    it("output custom_tool_call decodes to a custom call", () => {
      // `custom_tool_call` output items per
      // https://platform.openai.com/docs/api-reference/responses/object
      const canonical = toCanonicalResponse(
        {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "m",
          output: [
            {
              type: "custom_tool_call",
              call_id: "call_9",
              name: "apply_patch",
              input: "*** Begin Patch",
            },
          ],
        } as unknown as ResponsesResponse,
        "m",
      );

      expect(canonical.message.toolCalls).toEqual([
        {
          id: "call_9",
          type: "function",
          custom: true,
          function: {
            name: "apply_patch",
            arguments: "*** Begin Patch",
          },
        },
      ]);
      expect(canonical.finishReason).toBe("tool_call");
    });

    it("a custom call encodes as custom_tool_call output", () => {
      const wire = fromCanonicalResponse({
        id: "resp_1",
        model: "m",
        finishReason: "tool_call",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_9",
              type: "function",
              custom: true,
              function: {
                name: "apply_patch",
                arguments: "*** Begin Patch",
              },
            },
          ],
        },
      }) as unknown as { output: Array<Record<string, unknown>> };

      expect(wire.output).toEqual([
        {
          type: "custom_tool_call",
          id: expect.any(String),
          call_id: "call_9",
          name: "apply_patch",
          input: "*** Begin Patch",
          status: "completed",
        },
      ]);
    });
  });

  describe("custom-tool streaming (v1.4 spec §3.6)", () => {
    const ctx = (
      requestedModel = "client-model",
      sourceRequest = {
        model: requestedModel,
        input: "hi",
        stream: true,
      } as ResponsesRequest,
    ): StreamEncoderContext<ResponsesRequest> => ({
      sourceRequest,
      query: {},
      requestedModel,
    });

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

    it("custom input streams as custom_tool_call_input deltas", () => {
      // `response.custom_tool_call_input.delta`/`.done` event names
      // per https://platform.openai.com/docs/api-reference/responses-streaming
      // (ResponseStreamEvent) and openai 7.30.1 SDK typings.
      const frames = encodeAll([
        { type: "message_start", id: "r", model: "m" },
        {
          type: "tool_call_start",
          index: 0,
          id: "call_9",
          name: "apply_patch",
          custom: true,
        },
        {
          type: "tool_call_delta",
          index: 0,
          argumentsDelta: "*** Begin Patch",
        },
        { type: "tool_call_end", index: 0 },
        { type: "message_end", finishReason: "tool_call" },
      ]);

      const types = frames.map((f) => f.data.type);
      expect(types).toContain("response.custom_tool_call_input.delta");
      expect(types).toContain("response.custom_tool_call_input.done");
      const added = frames.find(
        (f) =>
          f.data.type === "response.output_item.added" &&
          f.data.item?.type === "custom_tool_call",
      );
      expect(added?.data.item).toMatchObject({
        call_id: "call_9",
        name: "apply_patch",
      });
      const done = frames.find(
        (f) => f.data.type === "response.custom_tool_call_input.done",
      );
      expect(done?.data.input).toBe("*** Begin Patch");
    });

    it("custom_tool_call_input deltas decode to tool_call events", () => {
      const wire = [
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","created_at":1,"status":"in_progress","model":"m","output":[]}}',
        "",
        'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","call_id":"call_9","name":"apply_patch","input":""}}',
        "",
        'data: {"type":"response.custom_tool_call_input.delta","sequence_number":2,"item_id":"ctc_1","output_index":0,"delta":"*** Begin "}',
        "",
        'data: {"type":"response.custom_tool_call_input.delta","sequence_number":3,"item_id":"ctc_1","output_index":0,"delta":"Patch"}',
        "",
        'data: {"type":"response.custom_tool_call_input.done","sequence_number":4,"item_id":"ctc_1","output_index":0,"input":"*** Begin Patch"}',
        "",
        'data: {"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","call_id":"call_9","name":"apply_patch","input":"*** Begin Patch"}}',
        "",
        'data: {"type":"response.completed","sequence_number":6,"response":{"id":"r","object":"response","created_at":1,"status":"completed","model":"m","output":[{"id":"ctc_1","type":"custom_tool_call","call_id":"call_9","name":"apply_patch","input":"*** Begin Patch"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
        "",
      ].join("\n");

      const events = decodeAll(wire);
      const start = events.find((e) => e.type === "tool_call_start");
      expect(start).toMatchObject({
        id: "call_9",
        name: "apply_patch",
        custom: true,
      });
      const deltas = events
        .filter((e) => e.type === "tool_call_delta")
        .map((e) => e.argumentsDelta)
        .join("");
      expect(deltas).toBe("*** Begin Patch");
      expect(events.at(-1)?.type).toBe("message_end");
    });
  });

  describe("response format (v1.4 spec §3.5)", () => {
    const SCHEMA = {
      type: "object",
      $defs: { cents: { type: "number", minimum: 0 } },
      properties: {
        name: { type: "string" },
        price: { $ref: "#/$defs/cents" },
        opts: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
      required: ["name"],
      additionalProperties: false,
    } as const;

    function deepFreeze<T>(value: T): T {
      if (typeof value === "object" && value !== null) {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
      }
      return value;
    }

    const request = (text: unknown): ResponsesRequest =>
      ({ model: "m", input: "hi", text }) as unknown as ResponsesRequest;

    it("json_schema round-trips unchanged", () => {
      const schema = deepFreeze({ ...SCHEMA });
      const format = {
        type: "json_schema",
        name: "answer",
        schema,
        strict: true,
        description: "the answer",
      };

      const canonical = toCanonicalRequest(request({ format }));
      expect(canonical.responseFormat).toEqual({
        type: "json_schema",
        name: "answer",
        schema,
        strict: true,
        description: "the answer",
      });
      // The schema object is passed through, never cloned-and-edited.
      expect(
        canonical.responseFormat?.type === "json_schema" &&
          canonical.responseFormat.schema,
      ).toBe(schema);

      const wire = fromCanonicalRequest(canonical) as Record<
        string,
        unknown
      >;
      expect(wire.text).toEqual({
        format: {
          type: "json_schema",
          name: "answer",
          schema,
          strict: true,
          description: "the answer",
        },
      });
    });

    it("json_object mapping", () => {
      const canonical = toCanonicalRequest(
        request({ format: { type: "json_object" } }),
      );
      expect(canonical.responseFormat).toEqual({ type: "json_object" });

      const wire = fromCanonicalRequest(canonical) as Record<
        string,
        unknown
      >;
      expect(wire.text).toEqual({ format: { type: "json_object" } });
    });

    it("text verbosity stays dropped alongside a decoded format", () => {
      const trace = traced(() =>
        toCanonicalRequest(
          request({
            verbosity: "low",
            format: { type: "json_object" },
          }),
        ),
      );

      const canonical = toCanonicalRequest(
        request({ verbosity: "low", format: { type: "json_object" } }),
      );
      expect(canonical.responseFormat).toEqual({ type: "json_object" });
      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "text",
      });
    });

    it("text format type text decodes as no constraint", () => {
      const trace = traced(() =>
        toCanonicalRequest(request({ format: { type: "text" } })),
      );

      const canonical = toCanonicalRequest(
        request({ format: { type: "text" } }),
      );
      expect(canonical.responseFormat).toBeUndefined();
      expect(
        trace.notes.filter((n) => n.code === "field_dropped"),
      ).toEqual([]);
    });

    it("an unknown format type is dropped with a note", () => {
      const trace = traced(() =>
        toCanonicalRequest(
          request({ format: { type: "xml_schema", schema: {} } }),
        ),
      );

      expect(trace.notes).toContainEqual({
        stage: "decode",
        adapter: "responses",
        code: "field_dropped",
        path: "text.format",
      });
    });
  });
});

// ===== v1.4 Task 8: reasoning items + bg1 envelope (spec §3.3) =====

import { runWithAttempt } from "../../observe/context";
import { packEnvelope } from "./responses.envelope";
import type { CanonicalReasoningOrigin } from "../../types/canonical.types";

describe("reasoning items (v1.4 spec §3.3)", () => {
  const ATTEMPT = { providerName: "resp", upstreamModel: "gpt-5-codex" };
  const ORIGIN: CanonicalReasoningOrigin = {
    provider: "resp",
    model: "gpt-5-codex",
  };

  it("reasoning item precedes the call it explains", () => {
    const signature = { origin: ORIGIN, data: "sig-call" };
    const out = runWithAttempt(ATTEMPT, () =>
      fromCanonicalRequest({
        model: "gpt-5-codex",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                reasoning: { text: "hmm", origin: ORIGIN },
              },
            ],
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
                signature,
              },
            ],
          },
        ],
      }),
    );
    const input = (out as unknown as { input: Array<Record<string, unknown>> })
      .input;
    const reasoningIdx = input.findIndex((i) => i.type === "reasoning");
    const callIdx = input.findIndex((i) => i.type === "function_call");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(reasoningIdx);
    // The envelope carries the call's signature under its call id.
    const item = input[reasoningIdx] as {
      encrypted_content?: string;
    };
    expect(item.encrypted_content?.startsWith("bg1.")).toBe(true);
  });

  it("reasoning output item comes first in fromCanonicalResponse", () => {
    const res = fromCanonicalResponse({
      id: "resp_1",
      model: "m",
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            reasoning: { text: "why", origin: ORIGIN },
            signature: { origin: ORIGIN, data: "blob" },
          },
          { type: "text", text: "answer" },
        ],
      },
      finishReason: "stop",
    });
    expect((res.output as unknown as Array<{ type: string }>)[0].type).toBe("reasoning");
    const item = (res.output as unknown as Array<Record<string, unknown>>)[0] as {
      summary?: Array<{ type: string; text: string }>;
      encrypted_content?: string;
    };
    expect(item.summary).toEqual([{ type: "summary_text", text: "why" }]);
    expect(item.encrypted_content?.startsWith("bg1.")).toBe(true);
  });

  it("summary text streams as reasoning_summary_text deltas", () => {
    const encoder = createStreamEncoder({
      sourceRequest: { model: "m", input: [] } as ResponsesRequest,
      query: {},
      requestedModel: "m",
    });
    const events: CanonicalStreamEvent[] = [
      { type: "message_start", id: "resp_1", model: "m" },
      { type: "reasoning_start", index: 0, origin: ORIGIN },
      { type: "reasoning_delta", index: 0, text: "think " },
      { type: "reasoning_delta", index: 0, text: "more" },
      {
        type: "reasoning_signature",
        index: 0,
        signature: { origin: ORIGIN, data: "blob" },
      },
      { type: "text_delta", text: "answer" },
      { type: "message_end", finishReason: "stop" },
    ];
    const text = events.map((e) => encoder.encode(e)).join("") + encoder.end();
    const frames = text
      .split("\n\n")
      .filter((f) => f !== "")
      .map((f) =>
        JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(5)),
      );
    const types = frames.map((f: { type: string }) => f.type);
    // Event chain per the streaming reference + the plan's Task 8
    // Interfaces block.
    const added = types.indexOf("response.output_item.added");
    expect(types[added + 1]).toBe("response.reasoning_summary_part.added");
    const deltas = frames.filter(
      (f: { type: string }) => f.type === "response.reasoning_summary_text.delta",
    );
    expect(deltas.map((d: { delta: string }) => d.delta)).toEqual([
      "think ",
      "more",
    ]);
    expect(types).toContain("response.reasoning_summary_text.done");
    expect(types).toContain("response.reasoning_summary_part.done");
    const done = frames.find(
      (f: { type: string; item?: { type?: string } }) =>
        f.type === "response.output_item.done" && f.item?.type === "reasoning",
    ) as { item: { encrypted_content?: string } };
    expect(done.item.encrypted_content?.startsWith("bg1.")).toBe(true);
  });

  it("reasoning input item unpacks to the following assistant turn", () => {
    // A recorded Codex replay: the envelope restores the reasoning part
    // and the call signature verbatim.
    const envelope = packEnvelope({
      v: 1,
      reasoning: [
        {
          type: "reasoning",
          reasoning: { text: "hmm", origin: ORIGIN },
          signature: { origin: ORIGIN, data: "blob" },
        },
      ],
      signatures: [
        {
          toolCallId: "call_1",
          signature: { origin: ORIGIN, data: "sig-call" },
        },
      ],
    })!;
    const canonical = toCanonicalRequest({
      model: "m",
      input: [
        { type: "reasoning", encrypted_content: envelope },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "{}",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
      ],
    } as unknown as ResponsesRequest);

    const assistant = canonical.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      {
        type: "reasoning",
        reasoning: { text: "hmm", origin: ORIGIN },
        signature: { origin: ORIGIN, data: "blob" },
      },
    ]);
    expect(assistant?.toolCalls?.[0].signature).toEqual({
      origin: ORIGIN,
      data: "sig-call",
    });
  });

  it("non-bg1 encrypted_content is dropped with a reasoning note", () => {
    const trace = traced(() =>
      toCanonicalRequest({
        model: "m",
        input: [
          { type: "reasoning", encrypted_content: "real-upstream-blob" },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      } as unknown as ResponsesRequest),
    );
    expect(trace.notes).toContainEqual({
      stage: "decode",
      adapter: "responses",
      code: "reasoning_dropped",
      path: "input[0]",
    });
  });
});
