import { describe, it, expect } from "vitest";
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./ollama.adapter";
import { sequentialIds } from "../../utils/ids";
import { ValidationError } from "../../utils/errors";
import type {
  CanonicalRequest,
  CanonicalResponse,
} from "../../types/canonical.types";
import type {
  OllamaChatRequest,
  OllamaChatResponse,
} from "../../types/ollama.types";

describe("Ollama Adapter", () => {
  describe("toCanonicalRequest", () => {
    it("should convert basic request", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = toCanonicalRequest(input);

      expect(result.model).toBe("llama2");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toBe("Hello");
    });

    it("should extract system prompt", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
      };

      const result = toCanonicalRequest(input);

      expect(result.systemPrompt).toBe("You are helpful");
    });

    it("should convert options to config", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        options: {
          temperature: 0.7,
          num_predict: 100,
          top_p: 0.9,
          top_k: 40,
          stop: ["END"],
          seed: 42,
        },
      };

      const result = toCanonicalRequest(input);

      expect(result.config?.temperature).toBe(0.7);
      expect(result.config?.maxTokens).toBe(100);
      expect(result.config?.topP).toBe(0.9);
      expect(result.config?.topK).toBe(40);
      expect(result.config?.stopSequences).toEqual(["END"]);
      expect(result.config?.seed).toBe(42);
    });

    it("should handle messages with images", () => {
      const input: OllamaChatRequest = {
        model: "llava",
        messages: [
          {
            role: "user",
            content: "What is this?",
            images: ["abc123"],
          },
        ],
      };

      const result = toCanonicalRequest(input);
      const content = result.messages[0].content;

      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toEqual({ type: "text", text: "What is this?" });
        expect(content[1].type).toBe("image");
        expect(content[1].image?.data).toBe("abc123");
      }
    });

    it("should pass through stream parameter", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      };

      const result = toCanonicalRequest(input);

      expect(result.stream).toBe(true);
    });

    it("streams when stream is omitted (Ollama API default)", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = toCanonicalRequest(input);

      expect(result.stream).toBe(true);
    });

    it("does not stream on explicit stream:false", () => {
      const input: OllamaChatRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      };

      const result = toCanonicalRequest(input);

      expect(result.stream).toBeUndefined();
    });
  });

  describe("fromCanonicalRequest", () => {
    it("should convert basic canonical request", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = fromCanonicalRequest(input);

      expect(result.model).toBe("llama2");
      expect(result.messages).toHaveLength(1);
      expect(result.messages![0].role).toBe("user");
      expect(result.messages![0].content).toBe("Hello");
    });

    it("should convert config to options", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        config: {
          temperature: 0.7,
          maxTokens: 100,
          topP: 0.9,
          topK: 40,
          stopSequences: ["END"],
          seed: 42,
        },
      };

      const result = fromCanonicalRequest(input);

      expect(result.options?.temperature).toBe(0.7);
      expect(result.options?.num_predict).toBe(100);
      expect(result.options?.top_p).toBe(0.9);
      expect(result.options?.top_k).toBe(40);
      expect(result.options?.stop).toEqual(["END"]);
      expect(result.options?.seed).toBe(42);
    });

    it("should handle multipart content with images", () => {
      const input: CanonicalRequest = {
        model: "llava",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image",
                image: { data: "abc123", mimeType: "image/png" },
              },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages![0].content).toBe("What is this?");
      expect(result.messages![0].images).toEqual(["abc123"]);
    });

    it("should pass through stream parameter", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      };

      const result = fromCanonicalRequest(input);

      expect(result.stream).toBe(true);
    });

    it("fromCanonicalRequest sets stream false when canonical omits it", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = fromCanonicalRequest(input);

      expect(result.stream).toBe(false);
    });

    it("keeps explicit stream value", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      };

      const result = fromCanonicalRequest(input);

      expect(result.stream).toBe(true);
    });
  });

  describe("hinted system parts (spec §3.2)", () => {
    it("flattens hinted system parts to one string", () => {
      const hinted = [
        { type: "text" as const, text: "A", cache: {} },
        { type: "text" as const, text: "B" },
      ];
      const input: CanonicalRequest = {
        model: "llama2",
        systemPrompt: hinted,
        messages: [
          { role: "system", content: hinted },
          { role: "user", content: "Hello" },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages![0]).toEqual({
        role: "system",
        content: "A\n\nB",
      });
    });

    it("keeps unhinted system parts joined with \"\\n\"", () => {
      const input: CanonicalRequest = {
        model: "llama2",
        messages: [
          {
            role: "system",
            content: [
              { type: "text" as const, text: "A" },
              { type: "text" as const, text: "B" },
            ],
          },
          { role: "user", content: "Hello" },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages![0]).toEqual({
        role: "system",
        content: "A\nB",
      });
    });
  });

  describe("toCanonicalResponse", () => {
    it("should convert basic response", () => {
      const input = {
        model: "llama2",
        created_at: new Date(),
        message: { role: "assistant", content: "Hello!" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      } as OllamaChatResponse;

      const result = toCanonicalResponse(input, "llama2");

      expect(result.model).toBe("llama2");
      expect(result.message.role).toBe("assistant");
      expect(result.message.content).toBe("Hello!");
      expect(result.finishReason).toBe("stop");
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
    });

    it("should generate valid id", () => {
      const input = {
        model: "llama2",
        created_at: new Date(),
        message: { role: "assistant", content: "Hi" },
        done: true,
      } as OllamaChatResponse;

      const result = toCanonicalResponse(input, "llama2");

      expect(result.id).toMatch(/^ollama-/);
    });

    it("should handle missing usage counts", () => {
      const input = {
        model: "llama2",
        created_at: new Date(),
        message: { role: "assistant", content: "Hi" },
        done: true,
      } as OllamaChatResponse;

      const result = toCanonicalResponse(input, "llama2");

      expect(result.usage?.inputTokens).toBe(0);
      expect(result.usage?.outputTokens).toBe(0);
    });

    it("should set unknown finish reason when not done", () => {
      const input = {
        model: "llama2",
        created_at: new Date(),
        message: { role: "assistant", content: "Hi" },
        done: false,
      } as OllamaChatResponse;

      const result = toCanonicalResponse(input, "llama2");

      expect(result.finishReason).toBe("unknown");
    });
  });

  describe("fromCanonicalResponse", () => {
    it("should convert canonical response to Ollama format", () => {
      const input: CanonicalResponse = {
        id: "test-123",
        model: "llama2",
        message: { role: "assistant", content: "Hello!" },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const result = fromCanonicalResponse(input);

      expect(result.model).toBe("llama2");
      expect(result.message.content).toBe("Hello!");
      expect(result.done).toBe(true);
      expect(result.prompt_eval_count).toBe(10);
      expect(result.eval_count).toBe(5);
    });

    it("should set done based on finish reason", () => {
      const stopResponse: CanonicalResponse = {
        id: "test",
        model: "llama2",
        message: { role: "assistant", content: "" },
        finishReason: "stop",
      };

      const lengthResponse: CanonicalResponse = {
        id: "test",
        model: "llama2",
        message: { role: "assistant", content: "" },
        finishReason: "length",
      };

      expect(fromCanonicalResponse(stopResponse).done).toBe(true);
      expect(fromCanonicalResponse(lengthResponse).done).toBe(false);
    });
  });

  describe("cached usage (spec §3.2)", () => {
    it("no cache fields ever emitted", () => {
      // Ollama reuses its KV cache by itself: prompt_eval_cached_count
      // is not decoded and cache hints are never encoded.
      const decoded = toCanonicalResponse(
        {
          model: "llama2",
          created_at: new Date(),
          message: { role: "assistant", content: "Hi" },
          done: true,
          prompt_eval_count: 36,
          prompt_eval_cached_count: 35,
          eval_count: 10,
        } as unknown as OllamaChatResponse,
        "llama2"
      );

      expect(decoded.usage).toEqual({
        inputTokens: 36,
        outputTokens: 10,
        totalTokens: 46,
      });

      const encoded = fromCanonicalResponse({
        id: "ollama-1",
        model: "llama2",
        message: { role: "assistant", content: "Hi" },
        finishReason: "stop",
        usage: {
          inputTokens: 36,
          outputTokens: 10,
          totalTokens: 46,
          cacheReadTokens: 35,
          cacheWriteTokens: 4,
        },
      });

      expect(encoded.prompt_eval_count).toBe(36);
      expect(encoded.eval_count).toBe(10);
      expect(
        Object.keys(encoded).every((k) => !k.includes("cache"))
      ).toBe(true);
    });
  });

  describe("roundtrip", () => {
    it("should preserve data through request roundtrip", () => {
      const original: OllamaChatRequest = {
        model: "llama2",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hello" },
        ],
        options: {
          temperature: 0.7,
          num_predict: 100,
        },
      };

      const canonical = toCanonicalRequest(original);
      const result = fromCanonicalRequest(canonical);

      expect(result.model).toBe(original.model);
      expect(result.messages!.length).toBe(original.messages!.length);
      expect(result.options?.temperature).toBe(original.options?.temperature);
      expect(result.options?.num_predict).toBe(original.options?.num_predict);
    });
  });

  describe("tools", () => {
    it("ollama tools definitions pass through", () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
          },
        },
      ];
      const input: OllamaChatRequest = {
        model: "qwen2.5:0.5b",
        messages: [{ role: "user", content: "Hi" }],
        tools,
      };

      const canonical = toCanonicalRequest(input);
      expect(canonical.tools).toEqual(tools);

      const restored = fromCanonicalRequest(canonical);
      expect(restored.tools).toEqual(tools);
    });

    it("ollama assistant tool_calls → canonical with generated IDs", () => {
      const input = {
        model: "qwen2.5:0.5b",
        created_at: new Date(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                index: 0,
                name: "get_weather",
                arguments: { location: "Paris" },
              },
            },
            {
              function: {
                index: 1,
                name: "get_weather",
                arguments: { location: "London" },
              },
            },
          ],
        },
        done: true,
      } as unknown as OllamaChatResponse;

      const result = toCanonicalResponse(
        input,
        "qwen2.5:0.5b",
        sequentialIds(),
      );

      expect(result.message.toolCalls).toEqual([
        {
          id: "call_0",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location":"Paris"}',
          },
        },
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location":"London"}',
          },
        },
      ]);
      expect(result.finishReason).toBe("tool_call");
    });

    it("ollama assistant tool_calls keep the wire id", () => {
      const input = {
        model: "qwen2.5:0.5b",
        created_at: new Date(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_ls22t79s",
              function: {
                index: 0,
                name: "get_weather",
                arguments: { location: "Paris" },
              },
            },
          ],
        },
        done: true,
      } as unknown as OllamaChatResponse;

      const result = toCanonicalResponse(
        input,
        "qwen2.5:0.5b",
        sequentialIds(),
      );

      expect(result.message.toolCalls?.[0]?.id).toBe("call_ls22t79s");
      expect(result.finishReason).toBe("tool_call");
    });

    it("ollama tool result carries tool_name from history", () => {
      const input: CanonicalRequest = {
        model: "qwen2.5:0.5b",
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_0",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
          { role: "tool", content: "15 degrees", toolCallId: "call_0" },
        ],
      };

      const result = fromCanonicalRequest(input);

      const assistant = result.messages![1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.tool_calls).toEqual([
        {
          id: "call_0",
          function: {
            index: 0,
            name: "get_weather",
            arguments: { location: "Paris" },
          },
        },
      ]);
      const toolMsg = result.messages![2];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toBe("15 degrees");
      expect(toolMsg.tool_name).toBe("get_weather");
    });

    it("ollama tool message with no matching call is a ValidationError", () => {
      const input: CanonicalRequest = {
        model: "qwen2.5:0.5b",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "15 degrees", toolCallId: "call_9" },
        ],
      };

      expect(() => fromCanonicalRequest(input)).toThrow(ValidationError);
      expect(() => fromCanonicalRequest(input)).toThrow(/call_9/);
    });

    it("ollama rejects toolChoice required", () => {
      const input: CanonicalRequest = {
        model: "qwen2.5:0.5b",
        messages: [{ role: "user", content: "Hi" }],
        toolChoice: "required",
      };

      expect(() => fromCanonicalRequest(input)).toThrow(ValidationError);
      expect(() => fromCanonicalRequest(input)).toThrow(
        'Ollama does not support tool_choice "required"',
      );
    });

    it("ollama rejects a function toolChoice with its JSON form", () => {
      const input: CanonicalRequest = {
        model: "qwen2.5:0.5b",
        messages: [{ role: "user", content: "Hi" }],
        toolChoice: {
          type: "function",
          function: { name: "get_weather" },
        },
      };

      expect(() => fromCanonicalRequest(input)).toThrow(ValidationError);
      expect(() => fromCanonicalRequest(input)).toThrow(
        'Ollama does not support tool_choice "{"type":"function","function":{"name":"get_weather"}}"',
      );
    });

    it("ollama decode pairs two same-name results with their calls in order", () => {
      const input = {
        model: "qwen2.5:0.5b",
        messages: [
          { role: "user", content: "weather in Paris and London?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_paris",
                function: {
                  index: 0,
                  name: "get_weather",
                  arguments: { location: "Paris" },
                },
              },
              {
                id: "call_london",
                function: {
                  index: 1,
                  name: "get_weather",
                  arguments: { location: "London" },
                },
              },
            ],
          },
          { role: "tool", tool_name: "get_weather", content: "15 degrees" },
          { role: "tool", tool_name: "get_weather", content: "10 degrees" },
        ],
      } as OllamaChatRequest;

      const result = toCanonicalRequest(input);

      expect(result.messages[2].role).toBe("tool");
      expect(result.messages[2].toolCallId).toBe("call_paris");
      expect(result.messages[3].role).toBe("tool");
      expect(result.messages[3].toolCallId).toBe("call_london");
    });

    it("ollama unmatched tool_name is kept and fails on Ollama encode", () => {
      const input = {
        model: "qwen2.5:0.5b",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_name: "get_weather", content: "15 degrees" },
        ],
      } as OllamaChatRequest;

      const canonical = toCanonicalRequest(input);
      expect(canonical.messages[1].toolCallId).toBe("get_weather");

      expect(() => fromCanonicalRequest(canonical)).toThrow(ValidationError);
      expect(() => fromCanonicalRequest(canonical)).toThrow(/get_weather/);
    });

    it("ollama string arguments pass through verbatim", () => {
      const input = {
        model: "qwen2.5:0.5b",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  index: 0,
                  name: "get_weather",
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
        ],
      } as unknown as OllamaChatRequest;

      const result = toCanonicalRequest(input);

      expect(result.messages[0].toolCalls?.[0]?.function.arguments).toBe(
        '{"location":"Paris"}',
      );
    });

    it("ollama tool message resolves only against an earlier assistant call", () => {
      const input: CanonicalRequest = {
        model: "qwen2.5:0.5b",
        messages: [
          { role: "tool", content: "15 degrees", toolCallId: "call_late" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_late",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{}",
                },
              },
            ],
          },
        ],
      };

      expect(() => fromCanonicalRequest(input)).toThrow(ValidationError);
      expect(() => fromCanonicalRequest(input)).toThrow(/call_late/);
    });

    it("ollama invalid canonical arguments become the wrapper", () => {
      const input: CanonicalResponse = {
        id: "ollama-test",
        model: "qwen2.5:0.5b",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_0",
              type: "function",
              function: { name: "get_weather", arguments: "not json" },
            },
          ],
        },
        finishReason: "tool_call",
      };

      const result = fromCanonicalResponse(input);

      expect(result.message.tool_calls?.[0]?.function.arguments).toEqual({
        _invalid_arguments: "not json",
      });
    });
  });
});
