import { describe, it, expect, vi } from 'vitest';
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
  fromCanonicalModelList,
} from './openai.adapter';
import { toCanonicalRequest as anthropicToCanonicalRequest } from './anthropic.adapter';
import { UpstreamError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { CanonicalRequest, CanonicalResponse } from '../../types/canonical.types';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../types/openai.types';
import type { MessageCreateParams } from '../../types/anthropic.types';

describe('OpenAI Adapter', () => {
  describe('toCanonicalRequest', () => {
    it('should convert basic request', () => {
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = toCanonicalRequest(input);

      expect(result.model).toBe('gpt-4');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
    });

    it('should extract system prompt', () => {
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = toCanonicalRequest(input);

      expect(result.systemPrompt).toBe('You are helpful');
      expect(result.messages).toHaveLength(2);
    });

    it('should convert config parameters', () => {
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 100,
        top_p: 0.9,
        stop: ['END'],
        n: 2,
      };

      const result = toCanonicalRequest(input);

      expect(result.config?.temperature).toBe(0.7);
      expect(result.config?.maxTokens).toBe(100);
      expect(result.config?.topP).toBe(0.9);
      expect(result.config?.stopSequences).toEqual(['END']);
      expect(result.config?.candidateCount).toBe(2);
    });

    it('should handle multipart content', () => {
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
            ],
          },
        ],
      };

      const result = toCanonicalRequest(input);
      const content = result.messages[0].content;

      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(content[1]).toEqual({
          type: 'image',
          image: { data: 'abc123', mimeType: 'image/png' },
        });
      }
    });
  });

  describe('fromCanonicalRequest', () => {
    it('should convert basic canonical request', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = fromCanonicalRequest(input);

      expect(result.model).toBe('gpt-4');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('should convert config to OpenAI parameters', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        config: {
          temperature: 0.7,
          maxTokens: 100,
          topP: 0.9,
          stopSequences: ['END'],
        },
      };

      const result = fromCanonicalRequest(input);

      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(100);
      expect(result.top_p).toBe(0.9);
      expect(result.stop).toEqual(['END']);
    });
  });

  describe('hinted system parts (spec §3.2)', () => {
    const hinted = [
      { type: 'text' as const, text: 'A', cache: {} },
      { type: 'text' as const, text: 'B' },
    ];

    it('flattens hinted system parts to one string', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        systemPrompt: hinted,
        messages: [
          { role: 'system', content: hinted },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[0]).toEqual({
        role: 'system',
        content: 'A\n\nB',
      });
    });

    it('Anthropic decode → OpenAI encode keeps the system text verbatim', () => {
      const anthropicRequest = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: 'A',
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'B' },
        ],
        messages: [{ role: 'user', content: 'Hello' }],
      } as unknown as MessageCreateParams;

      const canonical = anthropicToCanonicalRequest(anthropicRequest);
      const result = fromCanonicalRequest(canonical);

      expect(result.messages[0]).toEqual({
        role: 'system',
        content: 'A\n\nB',
      });
    });
  });

  describe('toCanonicalResponse', () => {
    it('should convert basic response', () => {
      const input: ChatCompletionResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const result = toCanonicalResponse(input, 'gpt-4');

      expect(result.id).toBe('chatcmpl-123');
      expect(result.model).toBe('gpt-4');
      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello!');
      expect(result.finishReason).toBe('stop');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
    });

    it('should map finish reasons correctly', () => {
      const makeResponse = (finish_reason: string): ChatCompletionResponse => ({
        id: 'test',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', refusal: null },
            finish_reason: finish_reason as 'stop',
            logprobs: null,
          },
        ],
      });

      expect(toCanonicalResponse(makeResponse('stop'), 'gpt-4').finishReason).toBe('stop');
      expect(toCanonicalResponse(makeResponse('length'), 'gpt-4').finishReason).toBe('length');
      expect(toCanonicalResponse(makeResponse('tool_calls'), 'gpt-4').finishReason).toBe('tool_call');
      expect(toCanonicalResponse(makeResponse('content_filter'), 'gpt-4').finishReason).toBe('content_filter');
    });
  });

  describe('fromCanonicalResponse', () => {
    it('should convert canonical response to OpenAI format', () => {
      const input: CanonicalResponse = {
        id: 'test-123',
        model: 'gpt-4',
        message: { role: 'assistant', content: 'Hello!' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        created: 1234567890,
      };

      const result = fromCanonicalResponse(input);

      expect(result.id).toBe('test-123');
      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gpt-4');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage?.prompt_tokens).toBe(10);
      expect(result.usage?.completion_tokens).toBe(5);
    });

    it('should generate ID if not provided', () => {
      const input: CanonicalResponse = {
        id: '',
        model: 'gpt-4',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
      };

      const result = fromCanonicalResponse(input);

      expect(result.id).toMatch(/^chatcmpl-/);
    });
  });

  describe('cached usage (spec §3.2)', () => {
    it('cached_tokens decoded', () => {
      const input = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hi', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: {
            cached_tokens: 512,
            cache_write_tokens: 64,
          },
        },
      } as unknown as ChatCompletionResponse;

      const result = toCanonicalResponse(input, 'gpt-4');

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: 512,
        cacheWriteTokens: 64,
      });
    });

    it('deepseek hit tokens decoded', () => {
      // DeepSeek reports prompt_cache_hit_tokens instead of
      // prompt_tokens_details (api-docs.deepseek.com "KV Cache").
      const input = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hi', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 300,
          prompt_cache_miss_tokens: 20,
        },
      } as unknown as ChatCompletionResponse;

      const result = toCanonicalResponse(input, 'deepseek-chat');

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: 300,
      });
    });

    it('cached usage encoded only when non-zero', () => {
      const make = (usage: CanonicalResponse['usage']): CanonicalResponse => ({
        id: 'chatcmpl-1',
        model: 'gpt-4',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
        usage,
      });

      const plain = fromCanonicalResponse(
        make({ inputTokens: 100, outputTokens: 5, totalTokens: 105 }),
      );
      expect(plain.usage).toStrictEqual({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
      });

      const cached = fromCanonicalResponse(
        make({
          inputTokens: 100,
          outputTokens: 5,
          totalTokens: 105,
          cacheReadTokens: 512,
          cacheWriteTokens: 64,
        }),
      );
      expect(cached.usage).toStrictEqual({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: {
          cached_tokens: 512,
          cache_write_tokens: 64,
        },
      });
    });
  });

  describe('roundtrip', () => {
    it('should preserve data through request roundtrip', () => {
      const original: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        max_tokens: 100,
      };

      const canonical = toCanonicalRequest(original);
      const result = fromCanonicalRequest(canonical);

      expect(result.model).toBe(original.model);
      expect(result.messages.length).toBe(original.messages.length);
      expect(result.temperature).toBe(original.temperature);
      expect(result.max_tokens).toBe(original.max_tokens);
    });
  });

  describe('fromCanonicalModelList', () => {
    it('model list owned_by defaults to babelgate', () => {
      const result = fromCanonicalModelList({ models: [{ id: 'm' }] });
      expect(result.data?.[0]?.owned_by).toBe('babelgate');
    });
  });

  describe('tools', () => {
    it('openai toolChoice round trip', () => {
      const choices = [
        'auto',
        'none',
        'required',
        { type: 'function', function: { name: 'get_weather' } },
      ] as const;

      for (const tool_choice of choices) {
        const input = {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }],
          tool_choice,
        } as ChatCompletionRequest;

        const canonical = toCanonicalRequest(input);
        expect(canonical.toolChoice).toEqual(tool_choice);

        const restored = fromCanonicalRequest(canonical);
        expect(restored.tool_choice).toEqual(tool_choice);
      }
    });

    it('openai strict and parallel_tool_calls are dropped with a debug log naming the field', () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const input = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'get_weather',
              strict: true,
              parameters: {
                type: 'object',
                properties: { location: { type: 'string' } },
              },
            },
          },
        ],
      } as ChatCompletionRequest;

      const canonical = toCanonicalRequest(input);

      // The request still decodes — the drop is only made visible.
      expect(canonical.tools?.[0]?.function.name).toBe('get_weather');
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('"strict"'),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('"parallel_tool_calls"'),
      );
      expect(debugSpy).toHaveBeenCalledTimes(2);
      // Field names only — never values or tool names.
      for (const call of debugSpy.mock.calls) {
        expect(call).toHaveLength(1);
        expect(String(call[0])).not.toContain('get_weather');
      }
      debugSpy.mockRestore();
    });

    it('openai custom tool_call in a request → 400 naming the type', () => {
      const input = {
        model: 'gpt-4',
        messages: [
          {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'custom' as const,
                custom: { name: 'code_exec', input: 'print(1)' },
              },
            ],
          },
        ],
      } as ChatCompletionRequest;

      let err: unknown;
      try {
        toCanonicalRequest(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).statusCode).toBe(400);
      expect((err as Error).message).toContain('"custom"');
      expect((err as Error).message).not.toContain('code_exec');
      expect((err as Error).message).not.toContain('print(1)');
    });

    it('openai custom tool_call in a response → error naming the type', () => {
      const input = {
        id: 'chatcmpl-1',
        object: 'chat.completion' as const,
        created: 0,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'custom' as const,
                  custom: { name: 'code_exec', input: 'print(1)' },
                },
              ],
            },
            finish_reason: 'tool_calls' as const,
            logprobs: null,
          },
        ],
      } as ChatCompletionResponse;

      let err: unknown;
      try {
        toCanonicalResponse(input, 'gpt-4');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UpstreamError);
      expect((err as UpstreamError).statusCode).toBe(502);
      expect((err as Error).message).toContain('"custom"');
      expect((err as Error).message).not.toContain('code_exec');
      expect((err as Error).message).not.toContain('print(1)');
    });

    it('openai tools definitions pass through', () => {
      const tools = [
        {
          type: 'function' as const,
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        },
      ];
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        tools,
      };

      const canonical = toCanonicalRequest(input);
      expect(canonical.tools).toEqual(tools);

      const restored = fromCanonicalRequest(canonical);
      expect(restored.tools).toEqual(tools);
    });
  });
});
