import { describe, it, expect } from 'vitest';
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from './anthropic.adapter';
import { createStreamDecoder } from './anthropic.stream';
import { runWithTrace } from '../../observe/context';
import { newTrace, type RequestTrace } from '../../observe/trace';
import { ValidationError } from '../../utils/errors';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolChoice,
} from '../../types/canonical.types';
import type {
  MessageCreateParams,
  Message,
  Tool,
  ToolChoice,
} from '../../types/anthropic.types';

// Helper to create test Message objects
function createTestMessage(
  overrides: Partial<Message> & { content: Message['content'] }
): Message {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    ...overrides,
  } as Message;
}

/** Run `fn` inside a trace scope and return the filled trace (§3.5). */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: 'r1',
    startedAt: 0,
    client: 'other',
    sourceApi: 'anthropic',
  });
  runWithTrace(trace, fn);
  return trace;
}

describe('Anthropic Adapter', () => {
  describe('toCanonicalRequest', () => {
    it('should convert basic request', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);

      expect(result.model).toBe('claude-3-opus-20240229');
      expect(result.stream).toBeUndefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
    });

    it('should extract system prompt', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        system: 'You are helpful',
      };

      const result = toCanonicalRequest(input);

      expect(result.systemPrompt).toBe('You are helpful');
      // System should also be added as first message
      expect(result.messages[0].role).toBe('system');
    });

    it('should convert config parameters', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END'],
      };

      const result = toCanonicalRequest(input);

      expect(result.config?.maxTokens).toBe(100);
      expect(result.config?.temperature).toBe(0.7);
      expect(result.config?.topP).toBe(0.9);
      expect(result.config?.topK).toBe(40);
      expect(result.config?.stopSequences).toEqual(['END']);
    });

    it('should handle multipart content', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
              },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);
      const content = result.messages[0].content;

      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(content[1].type).toBe('image');
        expect(content[1].image?.data).toBe('abc123');
      }
    });

    it('should surface stream:true into canonical', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        stream: true,
      };

      expect(toCanonicalRequest(input).stream).toBe(true);
    });
  });

  describe('fromCanonicalRequest', () => {
    it('should convert basic canonical request', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = fromCanonicalRequest(input);

      expect(result.model).toBe('claude-3-opus-20240229');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.max_tokens).toBe(4096); // Default
    });

    it('should add system from systemPrompt', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'You are helpful',
      };

      const result = fromCanonicalRequest(input);

      expect(result.system).toBe('You are helpful');
    });

    it('should filter out system messages', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('should convert config to Anthropic parameters', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        config: {
          maxTokens: 100,
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          stopSequences: ['END'],
        },
      };

      const result = fromCanonicalRequest(input);

      expect(result.max_tokens).toBe(100);
      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBe(0.9);
      expect(result.top_k).toBe(40);
      expect(result.stop_sequences).toEqual(['END']);
    });

    it('should handle multipart content with images', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', image: { data: 'abc123', mimeType: 'image/png' } },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(input);
      const content = result.messages[0].content;

      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(content[1]).toEqual({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        });
      }
    });
  });

  describe('toCanonicalResponse', () => {
    it('should convert basic response', () => {
      const input = createTestMessage({
        content: [{ type: 'text', text: 'Hello!' }] as Message['content'],
        usage: { input_tokens: 10, output_tokens: 5 } as Message['usage'],
      });

      const result = toCanonicalResponse(input, 'claude-3-opus');

      expect(result.model).toBe('claude-3-opus');
      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello!');
      expect(result.finishReason).toBe('stop');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
    });

    it('should map stop reasons correctly', () => {
      const endTurn = createTestMessage({
        content: [{ type: 'text', text: '' }] as Message['content'],
        stop_reason: 'end_turn',
      });
      const maxTokens = createTestMessage({
        content: [{ type: 'text', text: '' }] as Message['content'],
        stop_reason: 'max_tokens',
      });
      const toolUse = createTestMessage({
        content: [{ type: 'text', text: '' }] as Message['content'],
        stop_reason: 'tool_use',
      });

      expect(toCanonicalResponse(endTurn, 'claude').finishReason).toBe('stop');
      expect(toCanonicalResponse(maxTokens, 'claude').finishReason).toBe('length');
      expect(toCanonicalResponse(toolUse, 'claude').finishReason).toBe('tool_call');
    });

    it('should concatenate multiple text blocks', () => {
      const input = createTestMessage({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'World!' },
        ] as Message['content'],
      });

      const result = toCanonicalResponse(input, 'claude');

      expect(result.message.content).toBe('Hello World!');
    });
  });

  describe('fromCanonicalResponse', () => {
    it('should convert canonical response to Anthropic format', () => {
      const input: CanonicalResponse = {
        id: 'test-123',
        model: 'claude-3-opus',
        message: { role: 'assistant', content: 'Hello!' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const result = fromCanonicalResponse(input);

      expect(result.id).toBe('test-123');
      expect(result.model).toBe('claude-3-opus');
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).toBe('Hello!');
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    it('should map finish reasons back to Anthropic format', () => {
      const makeCanonical = (finishReason: CanonicalResponse['finishReason']): CanonicalResponse => ({
        id: 'test',
        model: 'claude',
        message: { role: 'assistant', content: '' },
        finishReason,
      });

      expect(fromCanonicalResponse(makeCanonical('stop')).stop_reason).toBe('end_turn');
      expect(fromCanonicalResponse(makeCanonical('length')).stop_reason).toBe('max_tokens');
      expect(fromCanonicalResponse(makeCanonical('tool_call')).stop_reason).toBe('tool_use');
    });
  });

  describe('tool calling', () => {
    const weatherTool: Tool = {
      name: 'get_weather',
      description: 'Get current weather',
      input_schema: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    };

    it('anthropic tool_choice round trip', () => {
      const cases: Array<[ToolChoice, CanonicalToolChoice]> = [
        [{ type: 'auto' }, 'auto'],
        [{ type: 'any' }, 'required'],
        [{ type: 'none' }, 'none'],
        [
          { type: 'tool', name: 'get_weather' },
          { type: 'function', function: { name: 'get_weather' } },
        ],
      ];

      for (const [anthropicChoice, canonicalChoice] of cases) {
        const input: MessageCreateParams = {
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Weather?' }],
          max_tokens: 1024,
          tools: [weatherTool],
          tool_choice: anthropicChoice,
        };

        const canonical = toCanonicalRequest(input);
        expect(canonical.toolChoice).toEqual(canonicalChoice);
        expect(canonical.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get current weather',
              parameters: weatherTool.input_schema,
            },
          },
        ]);

        const back = fromCanonicalRequest(canonical);
        expect(back.tool_choice).toEqual(anthropicChoice);
        expect(back.tools).toEqual([weatherTool]);
      }
    });

    it('user message with 3 tool_results splits into 3 tool messages then text', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Paris' },
              { type: 'tool_result', tool_use_id: 'toolu_2', content: 'London' },
              { type: 'tool_result', tool_use_id: 'toolu_3', content: 'Berlin' },
              { type: 'text', text: 'Which is warmest?' },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);

      expect(result.messages).toHaveLength(4);
      expect(result.messages[0]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_1',
        content: 'Paris',
      });
      expect(result.messages[1]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_2',
        content: 'London',
      });
      expect(result.messages[2]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_3',
        content: 'Berlin',
      });
      expect(result.messages[3].role).toBe('user');
      expect(result.messages[3].content).toEqual([
        { type: 'text', text: 'Which is warmest?' },
      ]);
    });

    it('user message of only tool_results produces no extra user message', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Paris' },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('tool');
    });

    it('consecutive tool messages merge into one user message', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'assistant', content: '', toolCalls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Paris"}' },
          }] },
          { role: 'tool', toolCallId: 'toolu_1', content: 'Paris' },
          { role: 'tool', toolCallId: 'toolu_2', content: 'London' },
          { role: 'user', content: 'Thanks' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages).toHaveLength(3);
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[1].content).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Paris' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'London' },
      ]);
      expect(result.messages[2]).toEqual({ role: 'user', content: 'Thanks' });
    });

    it('is_error maps to isError and back', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'boom',
                is_error: true,
              },
              { type: 'tool_result', tool_use_id: 'toolu_2', content: 'fine' },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const canonical = toCanonicalRequest(input);
      expect(canonical.messages[0]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_1',
        content: 'boom',
        isError: true,
      });
      expect(canonical.messages[1]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_2',
        content: 'fine',
      });

      const back = fromCanonicalRequest(canonical);
      const blocks = back.messages[0].content;
      expect(Array.isArray(blocks)).toBe(true);
      if (Array.isArray(blocks)) {
        expect(blocks[0]).toEqual({
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'boom',
          is_error: true,
        });
        // is_error is omitted when not true
        expect(blocks[1]).toEqual({
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'fine',
        });
      }
    });

    it('tool_result with text blocks becomes string content', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' },
                ],
              },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);
      expect(result.messages[0].content).toBe('line one\nline two');
    });

    it('image block in tool_result throws ValidationError naming the type', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'see this' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'abc',
                    },
                  },
                ],
              },
            ],
          },
        ],
        max_tokens: 1024,
      };

      expect(() => toCanonicalRequest(input)).toThrow(ValidationError);
      expect(() => toCanonicalRequest(input)).toThrow(/"image"/);
    });

    it('assistant tool_use blocks decode to toolCalls', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { location: 'Paris' },
              },
            ],
          },
        ],
        max_tokens: 1024,
      };

      const result = toCanonicalRequest(input);

      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[0].content).toEqual([
        { type: 'text', text: 'Checking.' },
      ]);
      expect(result.messages[0].toolCalls).toEqual([
        {
          id: 'toolu_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"location":"Paris"}',
          },
        },
      ]);
    });

    it('assistant text then tool_use order on encode', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: 'Let me check.',
            toolCalls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[0].content).toEqual([
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_weather',
          input: { location: 'Paris' },
        },
      ]);
    });

    it('empty tool input encodes as {}', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: { name: 'ping', arguments: '' },
              },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(input);
      const blocks = result.messages[0].content;
      expect(blocks).toEqual([
        { type: 'tool_use', id: 'toolu_1', name: 'ping', input: {} },
      ]);
    });

    it('invalid tool arguments encode with the _invalid_arguments wrapper', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: { name: 'ping', arguments: 'not json' },
              },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(input);
      const blocks = result.messages[0].content;
      expect(blocks).toEqual([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'ping',
          input: { _invalid_arguments: 'not json' },
        },
      ]);
    });

    it('response tool_use blocks decode to message.toolCalls', () => {
      const input = createTestMessage({
        content: [
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_use',
            id: 'toolu_xyz',
            name: 'get_weather',
            input: { location: 'Paris' },
          },
        ] as Message['content'],
        stop_reason: 'tool_use',
      });

      const result = toCanonicalResponse(input, 'claude');

      expect(result.message.content).toBe('Checking.');
      expect(result.message.toolCalls).toEqual([
        {
          id: 'toolu_xyz',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"location":"Paris"}',
          },
        },
      ]);
      expect(result.finishReason).toBe('tool_call');
    });

    it('response toolCalls encode after text as tool_use blocks', () => {
      const input: CanonicalResponse = {
        id: 'msg_1',
        model: 'claude-3-opus',
        message: {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [
            {
              id: 'toolu_xyz',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        finishReason: 'tool_call',
      };

      const result = fromCanonicalResponse(input);

      expect(result.content).toEqual([
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'toolu_xyz',
          name: 'get_weather',
          input: { location: 'Paris' },
        },
      ]);
      expect(result.stop_reason).toBe('tool_use');
    });
  });

  describe('Claude Code handling (spec §3.5)', () => {
    it('system array joins with blank line', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        system: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      };

      const result = toCanonicalRequest(input);

      expect(result.systemPrompt).toBe('part one\n\npart two');
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('part one\n\npart two');
    });

    it('thinking blocks are dropped; cache_control decodes onto parts and system', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hi',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'let me think', signature: 'sig' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 2000 },
        metadata: { user_id: 'u1' },
        system: [
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral' },
          },
        ],
      } as unknown as MessageCreateParams;

      const result = toCanonicalRequest(input);

      expect(result.messages).toHaveLength(3);
      // thinking/redacted_thinking blocks dropped; only the text remains
      const assistant = result.messages[2];
      expect(assistant.content).toEqual([{ type: 'text', text: 'answer' }]);
      expect(assistant.toolCalls).toBeUndefined();
      // §3.2: cache_control turns systemPrompt into hinted parts
      expect(result.systemPrompt).toEqual([
        { type: 'text', text: 'sys', cache: {} },
      ]);
      expect(result.messages[1].content).toEqual([
        { type: 'text', text: 'hi', cache: {} },
      ]);
    });

    it('unknown block type → 400 naming it', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'abc',
                },
              },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      let err: unknown;
      try {
        toCanonicalRequest(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).statusCode).toBe(400);
      expect((err as ValidationError).message).toContain('"document"');
    });
  });

  describe('cache hints and cached usage (spec §3.2)', () => {
    it('cache_control decoded onto parts, tools and system', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        system: [
          { type: 'text', text: 'first' },
          {
            type: 'text',
            text: 'second',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hi',
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'abc123',
                },
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            input_schema: { type: 'object' },
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      } as unknown as MessageCreateParams;

      const result = toCanonicalRequest(input);

      // absent ttl decodes to {} — Anthropic defaults it to 5m
      expect(result.systemPrompt).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second', cache: { ttl: '1h' } },
      ]);
      expect(result.messages[0]).toEqual({
        role: 'system',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second', cache: { ttl: '1h' } },
        ],
      });
      expect(result.messages[1].content).toEqual([
        { type: 'text', text: 'hi', cache: {} },
        {
          type: 'image',
          image: { data: 'abc123', mimeType: 'image/png' },
          cache: { ttl: '1h' },
        },
      ]);
      expect(result.tools?.[0].cache).toEqual({ ttl: '1h' });
    });

    it('usage sums cached input', () => {
      const input = createTestMessage({
        content: [{ type: 'text', text: 'Hi' }] as Message['content'],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 90,
          output_tokens: 5,
        } as Message['usage'],
      });

      const result = toCanonicalResponse(input, 'claude-3-opus-20240229');

      expect(result.usage).toEqual({
        inputTokens: 1000,
        cacheReadTokens: 900,
        cacheWriteTokens: 90,
        outputTokens: 5,
        totalTokens: 1005,
      });
    });

    it('usage encode splits back', () => {
      const input: CanonicalResponse = {
        id: 'msg_123',
        model: 'claude-3-opus-20240229',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
        usage: {
          inputTokens: 1000,
          cacheReadTokens: 900,
          cacheWriteTokens: 90,
          outputTokens: 5,
          totalTokens: 1005,
        },
      };

      const result = fromCanonicalResponse(input);

      expect(result.usage).toEqual({
        input_tokens: 10,
        cache_creation_input_tokens: 90,
        cache_read_input_tokens: 900,
        output_tokens: 5,
      });
    });

    it('split never negative', () => {
      const input: CanonicalResponse = {
        id: 'msg_123',
        model: 'claude-3-opus-20240229',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
        usage: {
          inputTokens: 5,
          cacheReadTokens: 9,
          outputTokens: 1,
          totalTokens: 6,
        },
      };

      const result = fromCanonicalResponse(input);

      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.cache_read_input_tokens).toBe(9);
    });

    it('cache_control encoded on blocks, tools and system', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        systemPrompt: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second', cache: { ttl: '1h' } },
        ],
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second', cache: { ttl: '1h' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi', cache: {} },
              {
                type: 'image',
                image: { data: 'abc123', mimeType: 'image/png' },
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
        config: { maxTokens: 1024 },
      };

      const result = fromCanonicalRequest(input);

      expect(result.system).toEqual([
        { type: 'text', text: 'first' },
        {
          type: 'text',
          text: 'second',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(result.messages[0].content).toEqual([
        {
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc123',
          },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(result.tools?.[0].cache_control).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      });
    });

    it('more than 4 breakpoints keeps the last 4', () => {
      // 6 hinted positions in the order Anthropic walks them —
      // tools → system → messages — so the earliest two (the tool
      // hint and the first system part) must lose theirs (§3.2).
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        systemPrompt: [
          { type: 'text', text: 'first', cache: {} },
          { type: 'text', text: 'second', cache: { ttl: '1h' } },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'm1', cache: {} },
              { type: 'text', text: 'm2', cache: {} },
              { type: 'text', text: 'm3', cache: {} },
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
        config: { maxTokens: 1024 },
      };

      const result = fromCanonicalRequest(input);

      const breakpoints = [
        result.tools?.[0],
        ...(Array.isArray(result.system) ? result.system : []),
        ...result.messages.flatMap((m) =>
          Array.isArray(m.content) ? m.content : [],
        ),
      ];
      expect(
        breakpoints.filter((b) => b && 'cache_control' in b).length,
      ).toBe(4);
      // tools[0] and system[0] are the earliest breakpoints — dropped.
      expect(result.tools?.[0]).not.toHaveProperty('cache_control');
      expect((result.system as { cache_control?: unknown }[])[0]).not.toHaveProperty(
        'cache_control',
      );
      expect(
        (result.system as { cache_control?: unknown }[])[1]
      ).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '1h' } });
      const parts = result.messages[0]!.content as {
        cache_control?: unknown;
      }[];
      for (const part of parts) {
        expect(part.cache_control).toEqual({ type: 'ephemeral' });
      }
    });

    it('no hints → request bytes identical to today', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        systemPrompt: 'Be helpful',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hello' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
        config: { maxTokens: 1024 },
      };

      const result = fromCanonicalRequest(input);

      expect(result).toStrictEqual({
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        system: 'Be helpful',
        tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      });
    });
  });

  describe('roundtrip', () => {
    it('should preserve data through request roundtrip', () => {
      const original: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
        ],
        max_tokens: 100,
        temperature: 0.7,
        system: 'Be helpful',
      };

      const canonical = toCanonicalRequest(original);
      const result = fromCanonicalRequest(canonical);

      expect(result.model).toBe(original.model);
      expect(result.max_tokens).toBe(original.max_tokens);
      expect(result.temperature).toBe(original.temperature);
      expect(result.system).toBe(original.system);
    });
  });

  // §3.5: every lossy-translation drop site records a TranslationNote
  // on the ambient trace (code + JSON path, never content). One case
  // per site.
  describe('translation notes (spec §3.5)', () => {
    it('thinking request field records thinking_dropped', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 2000 },
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'thinking_dropped',
        path: 'thinking',
      });
    });

    it('metadata request field records metadata_dropped', () => {
      const input: MessageCreateParams = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        metadata: { user_id: 'u1' },
      };

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'metadata_dropped',
        path: 'metadata',
      });
    });

    it('uncarried cache_control records cache_control_dropped', () => {
      // cache_control on a block kind canonical can't carry (tool_use)
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'n',
                input: {},
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'cache_control_dropped',
        path: 'cache_control',
      });
    });

    it('thinking content block records thinking_dropped with its path', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: 'sig' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'thinking_dropped',
        path: 'messages[0].content[0]',
      });
    });

    it('disable_parallel_tool_use records its own code', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'disable_parallel_tool_use_dropped',
        path: 'tool_choice.disable_parallel_tool_use',
      });
    });

    it('more than 4 breakpoints records cache_limit on encode', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        systemPrompt: [
          { type: 'text', text: 'first', cache: {} },
          { type: 'text', text: 'second', cache: { ttl: '1h' } },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'm1', cache: {} },
              { type: 'text', text: 'm2', cache: {} },
              { type: 'text', text: 'm3', cache: {} },
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
        config: { maxTokens: 1024 },
      };

      const trace = traced(() => fromCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'cache_limit',
        path: 'cache_control',
      });
    });

    it('stream block drop records stream_block_dropped', () => {
      const decoder = createStreamDecoder('claude-3-opus-20240229');
      const chunk = new TextEncoder().encode(
        'event: content_block_start\n' +
          'data: {"type":"content_block_start","index":0,' +
          '"content_block":{"type":"thinking","thinking":"hmm"}}\n\n',
      );

      const trace = traced(() => decoder.feed(chunk));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'stream_block_dropped',
        path: 'thinking',
      });
    });
  });
});
