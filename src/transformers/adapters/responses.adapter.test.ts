import { describe, it, expect } from "vitest";
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./responses.adapter";
import { runWithTrace } from "../../observe/context";
import { newTrace, type RequestTrace } from "../../observe/trace";
import { ValidationError } from "../../utils/errors";
import type {
  CanonicalRequest,
  CanonicalResponse,
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
});
