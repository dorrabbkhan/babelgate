import { describe, it, expect, vi } from 'vitest';
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
  fromCanonicalModelList,
} from './openai.adapter';
import { toCanonicalRequest as anthropicToCanonicalRequest } from './anthropic.adapter';
import { fromCanonicalRequest as anthropicFromCanonical } from './anthropic.adapter';
import { fromCanonicalRequest as geminiFromCanonical } from './gemini.adapter';
import { fromCanonicalRequest as ollamaFromCanonical } from './ollama.adapter';
import { fromCanonicalRequest as responsesFromCanonical } from './responses.adapter';
import { runWithTrace } from '../../observe/context';
import { newTrace, type RequestTrace } from '../../observe/trace';
import { UpstreamError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { CanonicalRequest, CanonicalResponse } from '../../types/canonical.types';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../types/openai.types';
import type { MessageCreateParams } from '../../types/anthropic.types';

/** Run `fn` inside a trace scope and return the filled trace (§3.5). */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: 'r1',
    startedAt: 0,
    client: 'other',
    sourceApi: 'openai',
  });
  runWithTrace(trace, fn);
  return trace;
}

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

    it('emits hinted system parts as one cache_control part', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        systemPrompt: hinted,
        messages: [
          { role: 'system', content: hinted },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      // §3.2: a hint reaching the encoder (only cache_hints targets
      // let it through) is emitted as cache_control on a one-part
      // content array — the hint marks the end of the system text.
      expect(result.messages[0]).toEqual({
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'A\n\nB',
            cache_control: { type: 'ephemeral' },
          },
        ],
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
        content: [
          {
            type: 'text',
            text: 'A\n\nB',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('unhinted system parts stay a plain string', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'A' },
              { type: 'text', text: 'B' },
            ],
          },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[0]).toEqual({
        role: 'system',
        content: 'A\n\nB',
      });
    });
  });

  describe('cache_control passthrough (spec §3.2)', () => {
    it('emitted on content parts and tools when the canonical carries a hint', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi', cache: {} },
              {
                type: 'image',
                image: { data: 'aGk=', mimeType: 'image/png' },
                cache: { ttl: '1h' },
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather' },
            cache: { ttl: '1h' },
          },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hi',
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGk=' },
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      });
      expect((result.tools?.[0] as { cache_control?: unknown }).cache_control).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      });
    });

    it('unhinted parts and tools carry no cache_control', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              {
                type: 'image',
                image: { data: 'aGk=', mimeType: 'image/png' },
              },
            ],
          },
        ],
        tools: [
          { type: 'function', function: { name: 'get_weather' } },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(JSON.stringify(result.messages[0])).not.toContain(
        'cache_control',
      );
      expect(JSON.stringify(result.tools)).not.toContain('cache_control');
    });

    it('a hinted tool message emits a cache_control text part', () => {
      // Task 17a: a tool-message hint reaching the encoder (only
      // cache_hints targets let it through) becomes a one-part
      // content array — the OpenAI dialect carries breakpoints on
      // content parts, and a tool message's content may be an array
      // of text parts.
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            content: '18C, sunny',
            cache: { ttl: '1h' },
          },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[1]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          {
            type: 'text',
            text: '18C, sunny',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      });
    });

    it('an unhinted tool message stays a plain string', () => {
      const input: CanonicalRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'tool',
            toolCallId: 'call_1',
            content: '18C, sunny',
          },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[0]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '18C, sunny',
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

    it('openai client gets the text when the upstream reasons', () => {
      // Task 8 fix: a parts array may carry reasoning — an OpenAI
      // client receives only the joined text parts.
      const result = fromCanonicalResponse({
        id: 'chatcmpl-r',
        model: 'm',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              reasoning: {
                text: 'hmm',
                origin: { provider: '', model: 'm' },
              },
            },
            { type: 'text', text: 'the answer' },
          ],
        },
        finishReason: 'stop',
      });

      expect(result.choices[0].message.content).toBe('the answer');
      const body = JSON.stringify(result);
      expect(body).not.toContain('hmm');
      expect(body).not.toContain('reasoning_content');
    });

    it('openai client gets the text of a signed text part', () => {
      // Task 7a: a Gemini text part may carry a thoughtSignature —
      // the client gets the text, never the signature.
      const result = fromCanonicalResponse({
        id: 'chatcmpl-s',
        model: 'm',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '1, 2',
              signature: {
                origin: { provider: '', model: 'gemini-3.5-flash-lite' },
                data: 'SIG',
              },
            },
          ],
        },
        finishReason: 'stop',
      });

      expect(result.choices[0].message.content).toBe('1, 2');
      expect(JSON.stringify(result)).not.toContain('SIG');
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

    it('canonical parallelToolCalls encodes as parallel_tool_calls (v1.4 spec §3.6)', () => {
      const result = fromCanonicalRequest({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object' } },
          },
        ],
        parallelToolCalls: false,
      });

      expect(result.parallel_tool_calls).toBe(false);

      const without = fromCanonicalRequest({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(without.parallel_tool_calls).toBeUndefined();
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
      const decodedTool = canonical.tools?.[0];
      expect(decodedTool?.type).toBe('function');
      expect(
        decodedTool?.type === 'function' && decodedTool.function.name,
      ).toBe('get_weather');
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

  // §3.5: every lossy-translation drop site records a TranslationNote
  // on the ambient trace (code + JSON path, never content). One case
  // per site.
  describe('translation notes (spec §3.5)', () => {
    it('parallel_tool_calls records its own code', () => {
      const input = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        parallel_tool_calls: false,
      } as unknown as ChatCompletionRequest;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'parallel_tool_calls_dropped',
        path: 'parallel_tool_calls',
      });
    });

    it('tool strict records tool_strict_dropped with its index', () => {
      const input: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'a', strict: true },
          },
          {
            type: 'function',
            function: { name: 'b', strict: false },
          },
        ],
      };

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'tool_strict_dropped',
        path: 'tools[0].function.strict',
      });
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'tool_strict_dropped',
        path: 'tools[1].function.strict',
      });
    });
  });

  describe('reasoning config encode (v1.4 spec §3.3)', () => {
    const request = (
      reasoning: NonNullable<CanonicalRequest['config']>['reasoning'],
    ): CanonicalRequest => ({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      config: { reasoning },
    });

    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const)(
      'effort %s passes through as reasoning_effort',
      (effort) => {
        const result = fromCanonicalRequest(request({ effort }));

        expect(result.reasoning_effort).toBe(effort);
      },
    );

    it('reasoning without effort sends no reasoning_effort', () => {
      const result = fromCanonicalRequest(request({}));

      expect(result.reasoning_effort).toBeUndefined();
    });

    it('no effort leaves thinking off', () => {
      // The Codex case (summary only) emits no reasoning_effort.
      expect(fromCanonicalRequest(request({ summary: true }))).toEqual({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    it('budgetTokens is dropped with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(request({ budgetTokens: 4096 })),
      );

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'openai',
        code: 'reasoning_budget_dropped',
        path: 'reasoning.budget_tokens',
      });
    });

    it('summary is dropped with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(request({ summary: true })),
      );

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'openai',
        code: 'reasoning_summary_dropped',
        path: 'reasoning.summary',
      });
    });
  });

  describe('reasoning request config (v1.5 spec §3.1)', () => {
    it('chat reasoning_effort maps to config.reasoning, encoded for every target', () => {
      const canonical = toCanonicalRequest({
        model: 'm',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      } as ChatCompletionRequest);

      expect(canonical.config?.reasoning).toEqual({ effort: 'high' });

      expect(fromCanonicalRequest(canonical)).toEqual({
        model: 'm',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(anthropicFromCanonical(canonical)).toEqual({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 25600,
        thinking: { type: 'enabled', budget_tokens: 24576 },
      });
      expect(geminiFromCanonical(canonical)).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 24576 },
        },
      });
      expect(ollamaFromCanonical(canonical)).toEqual({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        think: 'high',
      });
      expect(responsesFromCanonical(canonical)).toEqual({
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        ],
        reasoning: { effort: 'high' },
        include: ['reasoning.encrypted_content'],
        store: false,
      });
    });

    it('each reasoning_effort level decodes verbatim', () => {
      for (const effort of [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ] as const) {
        const canonical = toCanonicalRequest({
          model: 'm',
          reasoning_effort: effort,
          messages: [{ role: 'user', content: 'hi' }],
        } as ChatCompletionRequest);
        expect(canonical.config?.reasoning).toEqual({ effort });
      }
    });

    it('reasoning_effort "max" lowers to xhigh with a note', () => {
      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest({
          model: 'm',
          reasoning_effort: 'max',
          messages: [{ role: 'user', content: 'hi' }],
        } as ChatCompletionRequest);
      });

      expect(canonical?.config?.reasoning).toEqual({ effort: 'xhigh' });
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'reasoning_effort_lowered',
        path: 'reasoning_effort',
      });
    });

    it('an unknown reasoning_effort string is dropped with a note', () => {
      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest({
          model: 'm',
          reasoning_effort: 'ultra',
          messages: [{ role: 'user', content: 'hi' }],
        } as unknown as ChatCompletionRequest);
      });

      expect(canonical?.config?.reasoning).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'field_dropped',
        path: 'reasoning_effort',
      });
    });
  });

  describe('response format (v1.4 spec §3.5)', () => {
    const SCHEMA = {
      type: 'object',
      $defs: { cents: { type: 'number', minimum: 0 } },
      properties: {
        name: { type: 'string' },
        price: { $ref: '#/$defs/cents' },
        opts: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      required: ['name'],
      additionalProperties: false,
    } as const;

    function deepFreeze<T>(value: T): T {
      if (typeof value === 'object' && value !== null) {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
      }
      return value;
    }

    it('json_schema round-trips unchanged', () => {
      const schema = deepFreeze({ ...SCHEMA });
      const wire = {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema,
            strict: true,
            description: 'the answer',
          },
        },
      } as unknown as ChatCompletionRequest;

      const canonical = toCanonicalRequest(wire);
      expect(canonical.responseFormat).toEqual({
        type: 'json_schema',
        name: 'answer',
        schema,
        strict: true,
        description: 'the answer',
      });
      // The schema object is passed through, never cloned-and-edited.
      expect(
        canonical.responseFormat?.type === 'json_schema' &&
          canonical.responseFormat.schema,
      ).toBe(schema);

      const out = fromCanonicalRequest(canonical) as unknown as Record<
        string,
        unknown
      >;
      expect(out.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema,
          strict: true,
          description: 'the answer',
        },
      });
    });

    it('json_object mapping', () => {
      const canonical = toCanonicalRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      } as unknown as ChatCompletionRequest);
      expect(canonical.responseFormat).toEqual({ type: 'json_object' });

      const out = fromCanonicalRequest(canonical) as unknown as Record<
        string,
        unknown
      >;
      expect(out.response_format).toEqual({ type: 'json_object' });
    });

    it('an unknown response_format type is dropped with a note', () => {
      const trace = traced(() =>
        toCanonicalRequest({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'xml_schema' },
        } as unknown as ChatCompletionRequest),
      );

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'openai',
        code: 'field_dropped',
        path: 'response_format',
      });
    });
  });
});

// ===== v1.4 Task 8: reasoning_content decode + passback (spec §3.3) =====

import { runWithAttempt } from '../../observe/context';
import { canonicalForTarget } from '../../services/attempt-targets';
import type { ProviderEntry } from '../../routing/registry';
import type { CanonicalReasoningOrigin } from '../../types/canonical.types';

describe('reasoning_content (v1.4 spec §3.3)', () => {
  const ATTEMPT = { providerName: 'deep', upstreamModel: 'deepseek-v3' };
  const ORIGIN: CanonicalReasoningOrigin = {
    provider: 'deep',
    model: 'deepseek-v3',
  };

  it('reasoning_content decoded', () => {
    // DeepSeek/OpenRouter/vLLM reply field — a reasoning part with no
    // signature, tagged with the attempt's origin.
    const response = {
      id: 'chatcmpl-r',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v3',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'thought it through',
          },
          finish_reason: 'stop',
        },
      ],
    } as unknown as ChatCompletionResponse;

    const canonical = runWithAttempt(ATTEMPT, () =>
      toCanonicalResponse(response, 'deepseek-v3'),
    );
    expect(canonical.message.content).toEqual([
      {
        type: 'reasoning',
        reasoning: { text: 'thought it through', origin: ORIGIN },
      },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('reasoning field decodes too', () => {
    const response = {
      id: 'chatcmpl-r2',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'a', reasoning: 'r' },
          finish_reason: 'stop',
        },
      ],
    } as unknown as ChatCompletionResponse;
    const canonical = runWithAttempt(ATTEMPT, () =>
      toCanonicalResponse(response, 'deepseek-v3'),
    );
    const parts = canonical.message.content as Array<{ type: string }>;
    expect(parts[0].type).toBe('reasoning');
  });

  it('passback only with reasoning_passback', () => {
    // canonicalForTarget strips reasoning parts for openai targets
    // unless the entry opts in — adapters stay config-free.
    const canonical = {
      model: 'deepseek-v3',
      messages: [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'reasoning' as const,
              reasoning: { text: 'why', origin: ORIGIN },
            },
            { type: 'text' as const, text: 'answer' },
          ],
        },
      ],
    };
    const target = { provider: 'openai', model: 'deepseek-v3' };
    const base: ProviderEntry = {
      name: 'deep',
      type: 'openai',
      baseUrl: 'http://x',
    };

    const stripped = canonicalForTarget(canonical, base, target);
    expect(
      (stripped.messages[1].content as Array<{ type: string }>).every(
        (p) => p.type !== 'reasoning',
      ),
    ).toBe(true);

    const kept = canonicalForTarget(
      canonical,
      { ...base, reasoningPassback: true },
      target,
    );
    const wire = runWithAttempt(ATTEMPT, () =>
      fromCanonicalRequest(kept),
    ) as unknown as {
      messages: Array<Record<string, unknown>>;
    };
    const assistant = wire.messages[1];
    expect(assistant.reasoning_content).toBe('why');
  });

  it('foreign reasoning is dropped even with passback', () => {
    const canonical = {
      model: 'deepseek-v3',
      messages: [
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'reasoning' as const,
              reasoning: {
                text: 'other brain',
                origin: { provider: 'other', model: 'other-m' },
              },
            },
            { type: 'text' as const, text: 'answer' },
          ],
        },
      ],
    };
    const trace = traced(() => {
      const wire = runWithAttempt(ATTEMPT, () =>
        fromCanonicalRequest(canonical),
      ) as unknown as { messages: Array<Record<string, unknown>> };
      expect(wire.messages[0].reasoning_content).toBeUndefined();
    });
    expect(trace.notes).toContainEqual({
      stage: 'encode',
      adapter: 'openai',
      code: 'reasoning_dropped',
      path: 'reasoning_content',
    });
  });

  it('a matching part with no text emits no reasoning_content', () => {
    const wire = runWithAttempt(ATTEMPT, () =>
      fromCanonicalRequest({
        model: 'deepseek-v3',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                reasoning: { redacted: true, origin: ORIGIN },
              },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    ) as unknown as { messages: Array<Record<string, unknown>> };
    expect(wire.messages[0]).not.toHaveProperty('reasoning_content');
  });
});
