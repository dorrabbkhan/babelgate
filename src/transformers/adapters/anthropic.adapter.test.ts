import { describe, it, expect } from 'vitest';
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from './anthropic.adapter';
import {
  createStreamDecoder,
  createStreamEncoder,
} from './anthropic.stream';
import {
  packEnvelope,
  unpackEnvelope,
} from '../reasoning-envelope';
import { fromCanonicalRequest as openaiFromCanonical } from './openai.adapter';
import { fromCanonicalRequest as geminiFromCanonical } from './gemini.adapter';
import { fromCanonicalRequest as ollamaFromCanonical } from './ollama.adapter';
import { fromCanonicalRequest as responsesFromCanonical } from './responses.adapter';
import { runWithTrace, runWithAttempt } from '../../observe/context';
import { newTrace, type RequestTrace } from '../../observe/trace';
import { ValidationError } from '../../utils/errors';
import type {
  CanonicalContentPart,
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

/** All `event: <type>` frames' JSON payloads, in wire order. */
function sseEvents(
  body: string,
  event: string,
): Record<string, any>[] {
  const re = new RegExp(`event: ${event}\\ndata: (\\{.*\\})`, 'g');
  return [...body.matchAll(re)].map((m) => JSON.parse(m[1]));
}

function sseEvent(
  body: string,
  event: string,
  index = 0,
): Record<string, any> {
  return sseEvents(body, event)[index];
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

    // v1.4 spec §3.6: `parallelToolCalls: false` →
    // `tool_choice.disable_parallel_tool_use: true`. Anthropic carries
    // the flag inside tool_choice on the forms that use tools — `auto`
    // (the default when no tool_choice is sent → at most one call,
    // text answers still allowed), `any` and `tool` (exactly one
    // call). `none` has no such field; the flag is dropped.
    // https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
    describe('parallelToolCalls → disable_parallel_tool_use', () => {
      const withTools = (
        extra: Partial<CanonicalRequest>,
      ): MessageCreateParams =>
        fromCanonicalRequest({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Weather?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                parameters: { type: 'object' },
              },
            },
          ],
          ...extra,
        });

      it('no tool_choice → {type:"auto", disable_parallel_tool_use:true}', () => {
        const result = withTools({ parallelToolCalls: false });
        expect(result.tool_choice).toEqual({
          type: 'auto',
          disable_parallel_tool_use: true,
        });
      });

      it('tool_choice auto', () => {
        const result = withTools({
          toolChoice: 'auto',
          parallelToolCalls: false,
        });
        expect(result.tool_choice).toEqual({
          type: 'auto',
          disable_parallel_tool_use: true,
        });
      });

      it('tool_choice none sends no flag', () => {
        const result = withTools({
          toolChoice: 'none',
          parallelToolCalls: false,
        });
        expect(result.tool_choice).toEqual({ type: 'none' });
      });

      it('tool_choice required → any with the flag', () => {
        const result = withTools({
          toolChoice: 'required',
          parallelToolCalls: false,
        });
        expect(result.tool_choice).toEqual({
          type: 'any',
          disable_parallel_tool_use: true,
        });
      });

      it('named tool choice keeps the flag', () => {
        const result = withTools({
          toolChoice: {
            type: 'function',
            function: { name: 'get_weather' },
          },
          parallelToolCalls: false,
        });
        expect(result.tool_choice).toEqual({
          type: 'tool',
          name: 'get_weather',
          disable_parallel_tool_use: true,
        });
      });

      it('parallelToolCalls unset or true adds nothing', () => {
        expect(withTools({}).tool_choice).toBeUndefined();
        const result = withTools({
          parallelToolCalls: true,
          toolChoice: 'auto',
        });
        expect(result.tool_choice).toEqual({ type: 'auto' });
      });
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

    it('image block in tool_result decodes to a tool image part', () => {
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

      const canonical = toCanonicalRequest(input);
      expect(canonical.messages[0]).toEqual({
        role: 'tool',
        toolCallId: 'toolu_1',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', image: { data: 'abc', mimeType: 'image/png' } },
        ],
      });
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
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [],
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
      expect((err as ValidationError).message).toContain(
        '"web_search_tool_result"',
      );
    });

    describe('media (v1.5 spec §3.2.2)', () => {
      it('url image block decodes to url image', () => {
        const input = {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://cdn.example.com/cat.png',
                  },
                },
              ],
            },
          ],
          max_tokens: 1024,
        } as unknown as MessageCreateParams;

        const result = toCanonicalRequest(input);
        expect(result.messages[0].content).toEqual([
          {
            type: 'image',
            image: { url: 'https://cdn.example.com/cat.png' },
          },
        ]);
      });

      it('document block decodes to document part', () => {
        const input = {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  title: 'spec.pdf',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: 'JVBERi0=',
                  },
                },
              ],
            },
          ],
          max_tokens: 1024,
        } as unknown as MessageCreateParams;

        const result = toCanonicalRequest(input);
        expect(result.messages[0].content).toEqual([
          {
            type: 'document',
            document: {
              data: 'JVBERi0=',
              mimeType: 'application/pdf',
              name: 'spec.pdf',
            },
          },
        ]);
      });

      it('url image encodes to a url source block', () => {
        const result = fromCanonicalRequest({
          model: 'claude-3-opus-20240229',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  image: { url: 'https://cdn.example.com/cat.png' },
                },
              ],
            },
          ],
        } as unknown as Parameters<typeof fromCanonicalRequest>[0]);
        expect(result.messages[0].content).toEqual([
          {
            type: 'image',
            source: { type: 'url', url: 'https://cdn.example.com/cat.png' },
          },
        ]);
      });

      it('document part encodes to a document block', () => {
        const result = fromCanonicalRequest({
          model: 'claude-3-opus-20240229',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  document: {
                    data: 'JVBERi0=',
                    mimeType: 'application/pdf',
                    name: 'spec.pdf',
                  },
                },
              ],
            },
          ],
        } as unknown as Parameters<typeof fromCanonicalRequest>[0]);
        expect(result.messages[0].content).toEqual([
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0=',
            },
            title: 'spec.pdf',
          },
        ]);
      });

      it('tool image reaches anthropic target', () => {
        const result = fromCanonicalRequest({
          model: 'claude-3-opus-20240229',
          max_tokens: 1024,
          messages: [
            {
              role: 'tool',
              toolCallId: 'toolu_1',
              content: [
                { type: 'text', text: 'see this' },
                {
                  type: 'image',
                  image: { data: 'YWJj', mimeType: 'image/png' },
                },
              ],
            },
          ],
        } as unknown as Parameters<typeof fromCanonicalRequest>[0]);

        // Consecutive tool results merge into one user message of
        // tool_result blocks; the image rides as an image block.
        const user = result.messages.find(
          (m) => m.role === 'user' && Array.isArray(m.content),
        );
        expect(user?.content).toEqual([
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
                  data: 'YWJj',
                },
              },
            ],
          },
        ]);
      });
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

    it('cache_control on a tool_result decodes onto the tool message', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: '18C, sunny',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      } as unknown as MessageCreateParams;

      const result = toCanonicalRequest(input);

      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toEqual({
        role: 'tool',
        toolCallId: 'call_1',
        content: '18C, sunny',
        cache: {},
      });
    });

    it('cache_control on nested tool_result text blocks decodes the last hinted one', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [
                  {
                    type: 'text',
                    text: 'part one',
                    cache_control: { type: 'ephemeral', ttl: '1h' },
                  },
                  {
                    type: 'text',
                    text: 'part two',
                    cache_control: { type: 'ephemeral' },
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as MessageCreateParams;

      const result = toCanonicalRequest(input);

      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.cache).toEqual({});
      expect(toolMsg?.content).toBe('part one\npart two');
    });

    it('a block-level tool_result cache_control wins over a nested one', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [
                  {
                    type: 'text',
                    text: 'part one',
                    cache_control: { type: 'ephemeral', ttl: '1h' },
                  },
                ],
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      } as unknown as MessageCreateParams;

      const result = toCanonicalRequest(input);

      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.cache).toEqual({});
    });

    it('a cache hint on a tool message encodes onto the tool_result block', () => {
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
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
        config: { maxTokens: 1024 },
      };

      const result = fromCanonicalRequest(input);

      expect(result.messages[1]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '18C, sunny',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      });
    });

    it('the 4-breakpoint cap counts tool_result hints', () => {
      // 5 hinted positions in the order Anthropic walks them —
      // tools → system → messages — so the tool definition (the
      // earliest) loses its breakpoint while the tool_result's,
      // one of the last 4, survives (§3.2).
      const input: CanonicalRequest = {
        model: 'claude-3-opus-20240229',
        systemPrompt: [{ type: 'text', text: 'sys', cache: {} }],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'm1', cache: {} }],
          },
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
          { role: 'tool', toolCallId: 'call_1', content: 'result', cache: {} },
          {
            role: 'user',
            content: [{ type: 'text', text: 'm2', cache: {} }],
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

      expect(result.tools?.[0]).not.toHaveProperty('cache_control');
      const system = result.system as { cache_control?: unknown }[];
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
      const m1 = result.messages[0]!.content as { cache_control?: unknown }[];
      expect(m1[0]!.cache_control).toEqual({ type: 'ephemeral' });
      const toolResult = (
        result.messages[2]!.content as { cache_control?: unknown }[]
      )[0]!;
      expect(toolResult.cache_control).toEqual({ type: 'ephemeral' });
      const m2 = result.messages[3]!.content as { cache_control?: unknown }[];
      expect(m2[0]!.cache_control).toEqual({ type: 'ephemeral' });
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
    it('thinking request field maps to config.reasoning', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 8192 },
      } as unknown as MessageCreateParams;

      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest(input);
      });

      // v1.5 spec §3.1: the budget decodes to the ladder level whose
      // starting budget fits, and the budget itself is kept.
      expect(canonical?.config?.reasoning).toEqual({
        effort: 'medium',
        budgetTokens: 8192,
      });
      expect(trace.notes).toEqual([]);
    });

    it('adaptive thinking with output_config effort maps to config.reasoning', () => {
      const input = {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      } as unknown as MessageCreateParams;

      const canonical = toCanonicalRequest(input);

      expect(canonical.config?.reasoning).toEqual({ effort: 'high' });
    });

    it('disabled thinking maps to effort none', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'disabled' },
      } as unknown as MessageCreateParams;

      const canonical = toCanonicalRequest(input);

      expect(canonical.config?.reasoning).toEqual({ effort: 'none' });
    });

    it('unmapped thinking shapes still record thinking_dropped', () => {
      // `adaptive` without `output_config.effort` carries no level —
      // §3.1 maps it to nothing, so the v1.4 drop note stays.
      const input = {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'thinking_dropped',
        path: 'thinking',
      });
    });

    it('thinking: null records thinking_dropped', () => {
      const input = {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: null,
      } as unknown as MessageCreateParams;

      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest(input);
      });

      expect(canonical?.config?.reasoning).toBeUndefined();
      expect(trace.notes).toEqual([
        {
          stage: 'decode',
          adapter: 'anthropic',
          code: 'thinking_dropped',
          path: 'thinking',
        },
      ]);
    });

    it('adaptive thinking with output_config effort max lowers to xhigh with a note', () => {
      const input = {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
      } as unknown as MessageCreateParams;

      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest(input);
      });

      expect(canonical?.config?.reasoning).toEqual({ effort: 'xhigh' });
      expect(trace.notes).toEqual([
        {
          stage: 'decode',
          adapter: 'anthropic',
          code: 'reasoning_effort_lowered',
          path: 'output_config.effort',
        },
      ]);
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

    it('carried tool_result cache_control records no note', () => {
      // tool_result hints decode onto the canonical tool message —
      // they stopped being "uncarried" in Task 17a.
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  { type: 'text', text: 'a' },
                  {
                    type: 'text',
                    text: 'b',
                    cache_control: { type: 'ephemeral' },
                  },
                ],
              },
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: 'done',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      const trace = traced(() => toCanonicalRequest(input));

      expect(
        trace.notes.filter((n) => n.code === 'cache_control_dropped'),
      ).toHaveLength(0);
    });

    it('a second hint inside one tool_result records cache_control_dropped', () => {
      // Two breakpoints on a single tool_result — canonical carries
      // exactly one per tool message (Task 17a), so the extra is
      // still an uncarried drop.
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  {
                    type: 'text',
                    text: 'a',
                    cache_control: { type: 'ephemeral' },
                  },
                  {
                    type: 'text',
                    text: 'b',
                    cache_control: { type: 'ephemeral' },
                  },
                ],
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

    it('thinking content block with envelope decodes to reasoning', () => {
      // v1.5 §3.1 (Task 4): a `bg1.` envelope in a thinking block's
      // signature unpacks to its canonical reasoning part and
      // signatures in place.
      const origin = { provider: 'gem', model: 'g1' };
      const reasoningPart: CanonicalContentPart = {
        type: 'reasoning',
        reasoning: { text: 'hmm', origin },
        signature: { origin, data: 'sig_r' },
      };
      const callSig = { origin, data: 'sig_c' };
      const textSig = { origin, data: 'sig_t' };
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'hmm',
                signature: packEnvelope({
                  v: 1,
                  reasoning: [reasoningPart],
                  signatures: [
                    { textIndex: 0, signature: textSig },
                    { toolCallId: 'toolu_1', signature: callSig },
                  ],
                }),
              },
              { type: 'text', text: 'answer' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: {},
              },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      const request = toCanonicalRequest(input);

      expect(request.messages[0].content).toEqual([
        reasoningPart,
        { type: 'text', text: 'answer', signature: textSig },
      ]);
      expect(request.messages[0].toolCalls).toEqual([
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{}' },
          signature: callSig,
        },
      ]);
    });

    it('raw anthropic signature from client dropped with note', () => {
      // Conductor's call (c): a raw non-`bg1.` signature carries no
      // origin and is dropped with `reasoning_dropped` — as Responses
      // does for foreign `encrypted_content`.
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

      let request: CanonicalRequest | undefined;
      const trace = traced(() => {
        request = toCanonicalRequest(input);
      });

      expect(request?.messages[0].content).toEqual([
        { type: 'text', text: 'answer' },
      ]);
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'reasoning_dropped',
        path: 'messages[0].content[0]',
      });
    });

    it('thinking text without an envelope drops with a note', () => {
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      let request: CanonicalRequest | undefined;
      const trace = traced(() => {
        request = toCanonicalRequest(input);
      });

      expect(request?.messages[0].content).toEqual([
        { type: 'text', text: 'answer' },
      ]);
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'reasoning_dropped',
        path: 'messages[0].content[0]',
      });
    });

    it('redacted_thinking with envelope decodes to a redacted reasoning part', () => {
      const origin = { provider: 'gem', model: 'g1' };
      const reasoningPart: CanonicalContentPart = {
        type: 'reasoning',
        reasoning: { redacted: true, origin },
        signature: { origin, data: 'sig_x' },
      };
      const input = {
        model: 'claude-3-opus-20240229',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'redacted_thinking',
                data: packEnvelope({
                  v: 1,
                  reasoning: [reasoningPart],
                  signatures: [],
                }),
              },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
        max_tokens: 1024,
      } as unknown as MessageCreateParams;

      const request = toCanonicalRequest(input);

      expect(request.messages[0].content).toEqual([
        reasoningPart,
        { type: 'text', text: 'answer' },
      ]);
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
      // Task 7 decodes thinking/redacted_thinking into reasoning
      // blocks — server_tool_use remains a genuinely dropped type.
      const decoder = createStreamDecoder('claude-3-opus-20240229');
      const chunk = new TextEncoder().encode(
        'event: content_block_start\n' +
          'data: {"type":"content_block_start","index":0,' +
          '"content_block":{"type":"server_tool_use","id":"srv_1",' +
          '"name":"web_search","input":{}}}\n\n',
      );

      const trace = traced(() => decoder.feed(chunk));

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'stream_block_dropped',
        path: 'server_tool_use',
      });
    });
  });

  describe('reasoning parts and signatures (v1.4 spec §3.3, Task 7)', () => {
    const ATTEMPT = {
      providerName: 'claude',
      upstreamModel: 'claude-opus-5-5',
    };
    const ORIGIN = { provider: 'claude', model: 'claude-opus-5-5' };

    const encodeRequest = (message: CanonicalRequest['messages'][number]) =>
      runWithAttempt(ATTEMPT, () =>
        fromCanonicalRequest({
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: 'hi' }, message],
          config: { maxTokens: 1024 },
        }),
      );

    it('thinking block round-trips with its signature', () => {
      // docs.claude.com "Extended thinking": a thinking block carries
      // {thinking, signature}; both decode to canonical and encode
      // back when the origin matches the attempt.
      const message = createTestMessage({
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
          { type: 'text', text: 'answer' },
        ] as Message['content'],
      });

      const canonical = runWithAttempt(ATTEMPT, () =>
        toCanonicalResponse(message, 'claude-opus-5-5'),
      );

      expect(canonical.message.content).toEqual([
        {
          type: 'reasoning',
          reasoning: { text: 'hmm', origin: ORIGIN },
          signature: { origin: ORIGIN, data: 'sig_1' },
        },
        { type: 'text', text: 'answer' },
      ]);

      const wire = encodeRequest(canonical.message);
      expect(wire.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig_1' },
          { type: 'text', text: 'answer' },
        ],
      });
    });

    it('redacted_thinking round-trips', () => {
      // A redacted block has no readable text — its `data` is the
      // signature's data (spec §3.3).
      const message = createTestMessage({
        content: [
          { type: 'redacted_thinking', data: 'opaque-xyz' },
          { type: 'text', text: 'ok' },
        ] as Message['content'],
      });

      const canonical = runWithAttempt(ATTEMPT, () =>
        toCanonicalResponse(message, 'claude-opus-5-5'),
      );

      expect(canonical.message.content).toEqual([
        {
          type: 'reasoning',
          reasoning: { redacted: true, origin: ORIGIN },
          signature: { origin: ORIGIN, data: 'opaque-xyz' },
        },
        { type: 'text', text: 'ok' },
      ]);

      const wire = encodeRequest(canonical.message);
      expect(wire.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-xyz' },
          { type: 'text', text: 'ok' },
        ],
      });
    });

    it('thinking before tool_use keeps its position', () => {
      const message = createTestMessage({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig_t' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
        ] as Message['content'],
      });

      const canonical = runWithAttempt(ATTEMPT, () =>
        toCanonicalResponse(message, 'claude-opus-5-5'),
      );

      expect(canonical.message.content).toEqual([
        {
          type: 'reasoning',
          reasoning: { text: 'plan', origin: ORIGIN },
          signature: { origin: ORIGIN, data: 'sig_t' },
        },
      ]);

      const wire = encodeRequest(canonical.message);
      expect(wire.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig_t' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      });
    });

    it('foreign origin dropped with a note', () => {
      // Same provider, other model → the signature is model-bound and
      // never crosses (spec §3.2).
      const foreign = { provider: 'claude', model: 'claude-sonnet-4-6' };
      const message = {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            reasoning: { text: 'hmm', origin: foreign },
            signature: { origin: foreign, data: 'sig_x' },
          },
          { type: 'text', text: 'answer' },
        ],
      } as CanonicalRequest['messages'][number];

      let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
      const trace = traced(() => {
        wire = encodeRequest(message);
      });

      expect(wire?.messages[1]).toEqual({
        role: 'assistant',
        content: 'answer',
      });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_dropped',
        path: 'reasoning',
      });
    });

    it('anthropic client receives thinking with envelope signature', () => {
      // v1.5 §3.1 + conductor's call (a): reasoning reaches the
      // Anthropic client inside the `bg1.` envelope — even when its
      // origin is this same provider (a raw signature carries no
      // origin and could not be routed back).
      const reasoningPart: CanonicalContentPart = {
        type: 'reasoning',
        reasoning: { text: 'hmm', origin: ORIGIN },
        signature: { origin: ORIGIN, data: 'sig_1' },
      };
      const canonical: CanonicalResponse = {
        id: 'msg_r1',
        model: 'claude-opus-5-5',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: [reasoningPart, { type: 'text', text: 'answer' }],
        },
      };

      const wire = fromCanonicalResponse(canonical);

      expect(wire.content).toHaveLength(2);
      const [thinking, text] = wire.content as [
        { type: 'thinking'; thinking: string; signature: string },
        { type: 'text'; text: string },
      ];
      expect(thinking.type).toBe('thinking');
      expect(thinking.thinking).toBe('hmm');
      expect(unpackEnvelope(thinking.signature)).toEqual({
        v: 1,
        reasoning: [reasoningPart],
        signatures: [],
      });
      expect(text).toEqual({ type: 'text', text: 'answer' });
    });

    it('envelope round-trips to identical canonical parts', () => {
      // Reply → client's next request → decode equals the original
      // parts, signatures and tool-call signatures (Task 4).
      const origin = { provider: 'gem', model: 'g1' };
      const reasoningPart: CanonicalContentPart = {
        type: 'reasoning',
        reasoning: { text: 'plan', origin },
        signature: { origin, data: 'sig_r' },
      };
      const textPart: CanonicalContentPart = {
        type: 'text',
        text: 'answer',
        signature: { origin, data: 'sig_t' },
      };
      const call = {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'exec', arguments: '{"cmd":"ls"}' },
        signature: { origin, data: 'sig_c' },
      };
      const canonical: CanonicalResponse = {
        id: 'msg_r1',
        model: 'claude-opus-5-5',
        finishReason: 'tool_call',
        message: {
          role: 'assistant',
          content: [reasoningPart, textPart],
          toolCalls: [call],
        },
      };

      const wire = fromCanonicalResponse(canonical);
      const decoded = toCanonicalRequest({
        model: 'claude-opus-5-5',
        messages: [{ role: 'assistant', content: wire.content }],
        max_tokens: 1024,
      } as unknown as MessageCreateParams);

      expect(decoded.messages[0].content).toEqual(
        canonical.message.content,
      );
      expect(decoded.messages[0].toolCalls).toEqual(
        canonical.message.toolCalls,
      );
    });

    it('turn with signatures but no reasoning gets a leading empty thinking block', () => {
      const origin = { provider: 'gem', model: 'g1' };
      const callSig = { origin, data: 'sig_c' };
      const canonical: CanonicalResponse = {
        id: 'msg_r1',
        model: 'claude-opus-5-5',
        finishReason: 'tool_call',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec', arguments: '{}' },
              signature: callSig,
            },
          ],
        },
      };

      const wire = fromCanonicalResponse(canonical);
      const [thinking, text, toolUse] = wire.content as [
        { type: 'thinking'; thinking: string; signature: string },
        { type: 'text' },
        { type: 'tool_use' },
      ];
      expect(thinking.type).toBe('thinking');
      expect(thinking.thinking).toBe('');
      expect(unpackEnvelope(thinking.signature)).toEqual({
        v: 1,
        reasoning: [],
        signatures: [{ toolCallId: 'call_1', signature: callSig }],
      });
      expect(text).toEqual({ type: 'text', text: 'answer' });
      expect(toolUse.type).toBe('tool_use');
    });

    it('thinking_delta and signature_delta encoded in order', () => {
      // v1.5 §3.1 (Task 4): a reasoning block streams as
      // content_block_start{thinking}, thinking_delta(s), exactly one
      // signature_delta carrying the `bg1.` envelope, then
      // content_block_stop.
      const origin = { provider: 'p', model: 'm' };
      const encoder = createStreamEncoder({
        sourceRequest: {
          model: 'm',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
        query: {},
        requestedModel: 'm',
      });
      const events = [
        { type: 'message_start', id: 'msg_1', model: 'm' },
        { type: 'reasoning_start', index: 0, origin },
        { type: 'reasoning_delta', index: 0, text: 'why' },
        {
          type: 'reasoning_signature',
          index: 0,
          signature: { origin, data: 'sig_r' },
        },
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_end', finishReason: 'stop' },
      ] as const;
      let out = '';
      for (const e of events) {
        out += encoder.encode(
          e as unknown as Parameters<typeof encoder.encode>[0],
        );
      }

      const start = sseEvent(out, 'content_block_start', 0);
      expect(start.content_block).toEqual({
        type: 'thinking',
        thinking: '',
      });
      const deltas = sseEvents(out, 'content_block_delta');
      expect(deltas[0].delta).toEqual({
        type: 'thinking_delta',
        thinking: 'why',
      });
      expect(deltas[1].delta.type).toBe('signature_delta');
      expect(
        unpackEnvelope(
          (deltas[1].delta as { signature: string }).signature,
        ),
      ).toEqual({
        v: 1,
        reasoning: [
          {
            type: 'reasoning',
            reasoning: { text: 'why', origin },
            signature: { origin, data: 'sig_r' },
          },
        ],
        signatures: [],
      });
      // signature_delta precedes the block's stop; a text block then
      // carries the reply.
      const order = out.match(/event: \w+/g) ?? [];
      expect(order).toEqual([
        'event: message_start',
        'event: content_block_start',
        'event: content_block_delta',
        'event: content_block_delta',
        'event: content_block_stop',
        'event: content_block_start',
        'event: content_block_delta',
        'event: content_block_stop',
        'event: message_delta',
        'event: message_stop',
      ]);
    });

    /**
     * Reassemble the wire stream into the assistant content blocks a
     * client sends back on the next turn (docs.claude.com
     * "Preserving thinking blocks": blocks echoed unchanged).
     */
    function streamToContentBlocks(body: string): Record<string, any>[] {
      const blocks: Record<string, any>[] = [];
      for (const m of body.matchAll(
        /event: \w+\ndata: (\{.*\})/g,
      )) {
        const data = JSON.parse(m[1]);
        if (data.type === 'content_block_start') {
          blocks.push({ ...data.content_block });
        } else if (data.type === 'content_block_delta') {
          const block = blocks[data.index];
          const delta = data.delta;
          if (delta.type === 'text_delta') {
            block.text = (block.text ?? '') + delta.text;
          } else if (delta.type === 'thinking_delta') {
            block.thinking = (block.thinking ?? '') + delta.thinking;
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature;
          } else if (delta.type === 'input_json_delta') {
            block.input = JSON.parse(delta.partial_json);
          }
        }
      }
      return blocks;
    }

    function encodeStream(
      events: Parameters<
        ReturnType<typeof createStreamEncoder>['encode']
      >[0][],
    ): string {
      const encoder = createStreamEncoder({
        sourceRequest: {
          model: 'm',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
        query: {},
        requestedModel: 'm',
      });
      let out = '';
      for (const e of events) out += encoder.encode(e);
      return out + encoder.end();
    }

    /** Decode the client echo of a streamed reply. */
    function echoDecode(blocks: Record<string, any>[]) {
      return toCanonicalRequest({
        model: 'claude-opus-5-5',
        messages: [{ role: 'assistant', content: blocks }],
        max_tokens: 1024,
      } as unknown as MessageCreateParams);
    }

    it('streamed signatures after the last reasoning block ride a trailing thinking block', () => {
      // Stream ≠ non-stream parity (fix round): text and tool-call
      // signatures that arrive after the last reasoning block has
      // closed still reach the client — one trailing `thinking` block
      // (`thinking: ""`, one `signature_delta` carrying a `bg1.`
      // envelope with `reasoning: []`) before `message_delta`, mirroring
      // the leading-block rule of fromCanonicalResponse.
      const origin = { provider: 'p', model: 'm' };
      const sigR = { origin, data: 'sig_r' };
      const sigT = { origin, data: 'sig_t' };
      const sigC = { origin, data: 'sig_c' };
      const events = [
        { type: 'message_start', id: 'msg_1', model: 'm' },
        { type: 'reasoning_start', index: 0, origin },
        { type: 'reasoning_delta', index: 0, text: 'think' },
        {
          type: 'reasoning_signature',
          index: 0,
          signature: sigR,
        },
        { type: 'text_delta', text: 'a' },
        { type: 'text_signature', signature: sigT },
        {
          type: 'tool_call_start',
          index: 0,
          id: 'call_1',
          name: 'exec',
          signature: sigC,
        },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"cmd":"ls"}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'message_end', finishReason: 'tool_call' },
      ];

      let out = '';
      const trace = traced(() => {
        out = encodeStream(
          events as unknown as Parameters<typeof encodeStream>[0],
        );
      });

      // Exact block order: thinking, text, tool_use, trailing thinking "".
      const blocks = streamToContentBlocks(out);
      expect(blocks.map((b) => b.type)).toEqual([
        'thinking',
        'text',
        'tool_use',
        'thinking',
      ]);
      expect(blocks[0].thinking).toBe('think');
      expect(unpackEnvelope(blocks[0].signature)).toEqual({
        v: 1,
        reasoning: [
          {
            type: 'reasoning',
            reasoning: { text: 'think', origin },
            signature: sigR,
          },
        ],
        signatures: [],
      });
      expect(blocks[1]).toEqual({ type: 'text', text: 'a' });
      expect(blocks[3].thinking).toBe('');
      expect(unpackEnvelope(blocks[3].signature)).toEqual({
        v: 1,
        reasoning: [],
        signatures: [
          { textIndex: 0, signature: sigT },
          { toolCallId: 'call_1', signature: sigC },
        ],
      });
      expect(
        trace.notes.some((n) => n.code === 'reasoning_dropped'),
      ).toBe(false);

      // The client echoes the turn back; decode restores every part
      // and signature.
      const decoded = echoDecode(blocks);
      expect(decoded.messages[0].content).toEqual([
        {
          type: 'reasoning',
          reasoning: { text: 'think', origin },
          signature: sigR,
        },
        { type: 'text', text: 'a', signature: sigT },
      ]);
      expect(decoded.messages[0].toolCalls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'exec', arguments: '{"cmd":"ls"}' },
          signature: sigC,
        },
      ]);
    });

    it('streamed signed text parts emit one wire text block each', () => {
      // Envelope `textIndex` counts the text parts the client echoes:
      // a signed text block closes on its `text_signature`, so the
      // next canonical text part is a new wire block — matching
      // non-stream's one block per part.
      const origin = { provider: 'p', model: 'm' };
      const sig1 = { origin, data: 'sig_1' };
      const sig2 = { origin, data: 'sig_2' };
      const sigR = { origin, data: 'sig_r' };
      const events = [
        { type: 'message_start', id: 'msg_1', model: 'm' },
        { type: 'text_delta', text: 'a' },
        { type: 'text_signature', signature: sig1 },
        { type: 'text_delta', text: 'b' },
        { type: 'text_signature', signature: sig2 },
        { type: 'reasoning_start', index: 0, origin },
        { type: 'reasoning_delta', index: 0, text: 'think' },
        {
          type: 'reasoning_signature',
          index: 0,
          signature: sigR,
        },
        { type: 'message_end', finishReason: 'stop' },
      ];
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'm',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a', signature: sig1 },
            { type: 'text', text: 'b', signature: sig2 },
            {
              type: 'reasoning',
              reasoning: { text: 'think', origin },
              signature: sigR,
            },
          ],
        },
      };

      const out = encodeStream(
        events as unknown as Parameters<typeof encodeStream>[0],
      );

      const blocks = streamToContentBlocks(out);
      expect(blocks.map((b) => b.type)).toEqual([
        'text',
        'text',
        'thinking',
      ]);
      expect(blocks[0].text).toBe('a');
      expect(blocks[1].text).toBe('b');

      const decoded = echoDecode(blocks);
      expect(decoded.messages[0].content).toEqual(
        canonical.message.content,
      );

      // The streamed round trip equals the non-stream twin's.
      const twin = fromCanonicalResponse(canonical);
      const twinDecoded = echoDecode(
        twin.content as Record<string, any>[],
      );
      expect(decoded.messages[0]).toEqual(twinDecoded.messages[0]);
    });

    it('streamed text_signature with no open text part emits an empty text block', () => {
      // A signature on a fresh empty text part — Gemini's
      // max_tokens.sse signs an empty final part — still gets a wire
      // part so the index exists on the client's echo.
      const origin = { provider: 'p', model: 'm' };
      const sigR = { origin, data: 'sig_r' };
      const sig1 = { origin, data: 'sig_1' };
      const events = [
        { type: 'message_start', id: 'msg_1', model: 'm' },
        { type: 'reasoning_start', index: 0, origin },
        { type: 'reasoning_delta', index: 0, text: 'think' },
        {
          type: 'reasoning_signature',
          index: 0,
          signature: sigR,
        },
        { type: 'text_signature', signature: sig1 },
        { type: 'message_end', finishReason: 'stop' },
      ];
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'm',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              reasoning: { text: 'think', origin },
              signature: sigR,
            },
            { type: 'text', text: '', signature: sig1 },
          ],
        },
      };

      const out = encodeStream(
        events as unknown as Parameters<typeof encodeStream>[0],
      );

      const blocks = streamToContentBlocks(out);
      expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
      expect(blocks[1]).toEqual({ type: 'text', text: '' });

      const decoded = echoDecode(blocks);
      expect(decoded.messages[0].content).toEqual(
        canonical.message.content,
      );

      const twin = fromCanonicalResponse(canonical);
      const twinDecoded = echoDecode(
        twin.content as Record<string, any>[],
      );
      expect(decoded.messages[0]).toEqual(twinDecoded.messages[0]);
    });

    it('fallback mid-session drops foreign envelope', () => {
      // Review Focus 2: Claude Code returns a turn signed by provider
      // X (Gemini) after routing moved to provider Y (Anthropic) —
      // the envelope still decodes, but the foreign reasoning and its
      // signature are dropped on the way upstream, and the continuity
      // guard turns Anthropic thinking off.
      const foreign = { provider: 'gem', model: 'g1' };
      const reasoningPart: CanonicalContentPart = {
        type: 'reasoning',
        reasoning: { text: 'plan', origin: foreign },
        signature: { origin: foreign, data: 'sig_r' },
      };
      const input = {
        model: 'claude-opus-4-5',
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'plan',
                signature: packEnvelope({
                  v: 1,
                  reasoning: [reasoningPart],
                  signatures: [
                    {
                      toolCallId: 'toolu_1',
                      signature: { origin: foreign, data: 'sig_c' },
                    },
                  ],
                }),
              },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'exec',
                input: { cmd: 'ls' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'ok',
              },
            ],
          },
          { role: 'user', content: 'next' },
        ],
        max_tokens: 4096,
      } as unknown as MessageCreateParams;

      const canonical = toCanonicalRequest(input);

      let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
      const trace = traced(() => {
        wire = runWithAttempt(
          { providerName: 'claude', upstreamModel: 'claude-opus-4-5' },
          () => fromCanonicalRequest(canonical),
        );
      });

      // The foreign reasoning part is not in Y's body — no thinking
      // block carries X's bytes, and thinking itself is disabled.
      const assistant = wire?.messages[1];
      expect(assistant?.role).toBe('assistant');
      const blocks = Array.isArray(assistant?.content)
        ? assistant!.content
        : [];
      expect(
        blocks.some(
          (b: { type: string }) =>
            b.type === 'thinking' || b.type === 'redacted_thinking',
        ),
      ).toBe(false);
      expect(wire?.thinking).toBeUndefined();
      expect(
        trace.notes.some(
          (n) =>
            n.code === 'reasoning_dropped' &&
            n.path === 'thinking_disabled_no_prior_block',
        ),
      ).toBe(true);
    });
  });

  describe('reasoning config encode (v1.4 spec §3.3)', () => {
    const request = (
      model: string,
      reasoning: NonNullable<CanonicalRequest['config']>['reasoning'],
      maxTokens = 4096,
    ): CanonicalRequest => ({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      config: { maxTokens, reasoning },
    });

    it('adaptive models get thinking adaptive + output_config.effort', () => {
      const result = fromCanonicalRequest(
        request('claude-opus-5-5', { effort: 'high' }),
      );

      expect(result.thinking).toEqual({ type: 'adaptive' });
      expect(result.output_config).toEqual({ effort: 'high' });
    });

    it.each(['low', 'medium', 'high', 'xhigh'] as const)(
      'effort %s passes through on adaptive models',
      (effort) => {
        const result = fromCanonicalRequest(
          request('claude-haiku-5-5', { effort }),
        );

        expect(result.output_config).toEqual({ effort });
      },
    );

    it('xhigh lowers to high on the 4.6 family with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-sonnet-4-6', { effort: 'xhigh' }),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-sonnet-4-6', { effort: 'xhigh' }),
      );
      expect(result.output_config).toEqual({ effort: 'high' });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_effort_lowered',
        path: 'reasoning.effort',
      });
    });

    it.each([
      ['minimal', 1024],
      ['low', 2048],
      ['medium', 8192],
      ['high', 24576],
      ['xhigh', 32000],
    ] as const)(
      'extended models map effort %s to budget_tokens %i',
      (effort, budget) => {
        const result = fromCanonicalRequest(
          request('claude-sonnet-4-5', { effort }),
        );

        expect(result.thinking).toEqual({
          type: 'enabled',
          budget_tokens: budget,
        });
        expect(result.output_config).toBeUndefined();
      },
    );

    it('explicit budgetTokens beats the effort table', () => {
      const result = fromCanonicalRequest(
        request('claude-sonnet-4-5', { effort: 'low', budgetTokens: 5000 }),
      );

      expect(result.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 5000,
      });
    });

    it('budgetTokens on an adaptive model is dropped with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-opus-5-5', { budgetTokens: 4096 }),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-opus-5-5', { budgetTokens: 4096 }),
      );
      expect(result.thinking).toEqual({ type: 'adaptive' });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_budget_dropped',
        path: 'reasoning.budget_tokens',
      });
    });

    it('max_tokens raised above the budget with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-sonnet-4-5', { effort: 'high' }, 4096),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-sonnet-4-5', { effort: 'high' }, 4096),
      );
      expect(result.max_tokens).toBe(24576 + 1024);
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'max_tokens_raised',
        path: 'max_tokens',
      });
    });

    it('effort none sends no thinking field', () => {
      for (const model of ['claude-opus-5-5', 'claude-sonnet-4-5']) {
        const result = fromCanonicalRequest(
          request(model, { effort: 'none' }),
        );

        expect(result.thinking).toBeUndefined();
        expect(result.output_config).toBeUndefined();
      }
    });

    it('opus 4.5 takes the budget path', () => {
      // Opus 4.5 is extended-thinking-only — `adaptive` is rejected
      // with a 400 per the thinking-troubleshooting per-model table —
      // and the one such model that pairs `output_config.effort` with
      // `budget_tokens` per the effort doc.
      for (const model of ['claude-opus-4-5', 'claude-opus-4-5-20251101']) {
        const result = fromCanonicalRequest(
          request(model, { effort: 'high' }, 40000),
        );

        expect(result).toEqual({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 40000,
          thinking: { type: 'enabled', budget_tokens: 24576 },
          output_config: { effort: 'high' },
        });
      }
    });

    it('xhigh lowers to high on opus 4.5 with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-opus-4-5', { effort: 'xhigh' }, 40000),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-opus-4-5', { effort: 'xhigh' }, 40000),
      );
      expect(result.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 32000,
      });
      expect(result.output_config).toEqual({ effort: 'high' });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_effort_lowered',
        path: 'reasoning.effort',
      });
    });

    it('effort none with a budget records reasoning_budget_dropped on legacy models', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-sonnet-4-5', {
            effort: 'none',
            budgetTokens: 4096,
          }),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-sonnet-4-5', { effort: 'none', budgetTokens: 4096 }),
      );
      expect(result.thinking).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_budget_dropped',
        path: 'reasoning.budget_tokens',
      });
    });

    it('minimal lowers to none on adaptive models (no low-min level)', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-opus-5-5', { effort: 'minimal' }),
        ),
      );

      const result = fromCanonicalRequest(
        request('claude-opus-5-5', { effort: 'minimal' }),
      );
      expect(result.thinking).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_effort_lowered',
        path: 'reasoning.effort',
      });
    });

    it('reasoning {} sends no thinking field', () => {
      for (const model of ['claude-opus-5-5', 'claude-sonnet-4-5']) {
        const result = fromCanonicalRequest(request(model, {}));

        expect(result.thinking).toBeUndefined();
        expect(result.output_config).toBeUndefined();
      }
    });

    it('no effort leaves thinking off', () => {
      // Adaptive model — the Codex case (summary only) emits no
      // thinking and no output_config.
      expect(
        fromCanonicalRequest(request('claude-opus-5-5', { summary: true })),
      ).toEqual({
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      });
    });

    it('no effort leaves thinking off', () => {
      // Legacy extended-thinking model — no thinking and
      // max_tokens unchanged.
      expect(
        fromCanonicalRequest(request('claude-sonnet-4-5', { summary: true })),
      ).toEqual({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      });
    });

    it('summary on anthropic is dropped with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('claude-opus-5-5', { summary: true }),
        ),
      );

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'anthropic',
        code: 'reasoning_summary_dropped',
        path: 'reasoning.summary',
      });
    });
  });

  describe('reasoning request config (v1.5 spec §3.1)', () => {
    it('anthropic thinking maps to config.reasoning, encoded for every target', () => {
      const canonical = toCanonicalRequest({
        model: 'm',
        max_tokens: 100,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{ role: 'user', content: 'hi' }],
      } as MessageCreateParams);

      expect(canonical.config?.reasoning).toEqual({
        effort: 'low',
        budgetTokens: 2048,
      });

      expect(fromCanonicalRequest(canonical)).toEqual({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 3072,
        thinking: { type: 'enabled', budget_tokens: 2048 },
      });
      expect(openaiFromCanonical(canonical)).toEqual({
        model: 'm',
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      });
      expect(geminiFromCanonical(canonical)).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          maxOutputTokens: 100,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      });
      expect(ollamaFromCanonical(canonical)).toEqual({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        options: { num_predict: 100 },
        stream: false,
        think: 'low',
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
        reasoning: { effort: 'low' },
        include: ['reasoning.encrypted_content'],
        store: false,
        max_output_tokens: 100,
      });
    });
  });

  // `thinking: {type:"between_tools"}` — Claude Sonnet 5.5's lowest
  // thinking setting ("respond without thinking first"), accepted at
  // effort high or below:
  // https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5
  describe('between_tools thinking (v1.6 spec §3.6)', () => {
    function betweenTools(outputConfig?: { effort?: string }) {
      return {
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1024,
        thinking: { type: 'between_tools' },
        ...(outputConfig !== undefined && { output_config: outputConfig }),
      } as unknown as MessageCreateParams;
    }

    it('between_tools maps to output_config effort', () => {
      const canonical = toCanonicalRequest(betweenTools({ effort: 'high' }));

      expect(canonical.config?.reasoning).toEqual({ effort: 'high' });
    });

    it('between_tools without effort maps to low', () => {
      const canonical = toCanonicalRequest(betweenTools());

      expect(canonical.config?.reasoning).toEqual({ effort: 'low' });
    });

    it('between_tools max lowers to xhigh', () => {
      let canonical: ReturnType<typeof toCanonicalRequest> | undefined;
      const trace = traced(() => {
        canonical = toCanonicalRequest(betweenTools({ effort: 'max' }));
      });

      expect(canonical?.config?.reasoning).toEqual({ effort: 'xhigh' });
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'reasoning_effort_lowered',
        path: 'output_config.effort',
      });
    });

    it('between_tools records thinking_mode_mapped', () => {
      const trace = traced(() =>
        toCanonicalRequest(betweenTools({ effort: 'medium' })),
      );

      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'anthropic',
        code: 'thinking_mode_mapped',
        path: 'thinking.type',
      });
      // A mapped mode is not a drop — no thinking_dropped.
      expect(trace.notes.map((n) => n.code)).not.toContain(
        'thinking_dropped',
      );
    });

    it('between_tools to gemini target sets thinking level from effort', () => {
      const canonical = toCanonicalRequest(betweenTools({ effort: 'high' }));

      // A level-capable Gemini model gets the decoded effort as its
      // thinkingLevel (no adapter-pair special case — canonical
      // reasoning carries it).
      expect(
        geminiFromCanonical({ ...canonical, model: 'gemini-3-flash-preview' }),
      ).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingLevel: 'high' },
        },
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
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: {
          format: { type: 'json_schema', schema },
        },
      } as unknown as MessageCreateParams;

      const canonical = toCanonicalRequest(wire);
      // `output_config.format` carries no name — the canonical side
      // gets the fixed default name.
      expect(canonical.responseFormat).toEqual({
        type: 'json_schema',
        name: 'response',
        schema,
      });
      // The schema object is passed through, never cloned-and-edited.
      expect(
        canonical.responseFormat?.type === 'json_schema' &&
          canonical.responseFormat.schema,
      ).toBe(schema);

      const out = fromCanonicalRequest(canonical) as MessageCreateParams;
      // The encoder never sends the canonical name.
      expect((out as { output_config?: unknown }).output_config).toEqual(
        { format: { type: 'json_schema', schema } },
      );
    });

    it('format merges with output_config.effort', () => {
      // `output_config` is shared with reasoning effort (Task 6):
      // encoding format must merge, never overwrite.
      const canonical: CanonicalRequest = {
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: {
          type: 'json_schema',
          name: 'answer',
          schema: { ...SCHEMA },
        },
        config: { maxTokens: 4096, reasoning: { effort: 'high' } },
      };

      const out = fromCanonicalRequest(canonical) as MessageCreateParams;
      expect((out as { output_config?: unknown }).output_config).toEqual(
        {
          effort: 'high',
          format: { type: 'json_schema', schema: SCHEMA },
        },
      );
      expect(out.thinking).toEqual({ type: 'adaptive' });
    });

    it('json_object is a 400 unsupported_response_format', () => {
      const canonical: CanonicalRequest = {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
      };

      let thrown: unknown;
      try {
        fromCanonicalRequest(canonical);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect(
        (thrown as ValidationError).toCanonical(),
      ).toMatchObject({
        kind: 'invalid_request',
        status: 400,
        code: 'unsupported_response_format',
      });
    });
  });
});

// ===== v1.4 Task 8: continuity guard (spec §3.2) =====

describe('continuity guard (v1.4 spec §3.2)', () => {
  const ATTEMPT = {
    providerName: 'claude',
    upstreamModel: 'claude-opus-4-5',
  };

  const foreignMsg = {
    role: 'assistant' as const,
    content: [
      {
        type: 'reasoning' as const,
        reasoning: {
          text: 'gemini thought',
          origin: { provider: 'gem', model: 'gem-1' },
        },
        signature: {
          origin: { provider: 'gem', model: 'gem-1' },
          data: 'sig-foreign',
        },
      },
    ],
    toolCalls: [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{}' },
        signature: {
          origin: { provider: 'gem', model: 'gem-1' },
          data: 'sig-foreign',
        },
      },
    ],
  };

  it('continuity guard disables thinking after a foreign turn', () => {
    // Task 8: a thinking-enabled tool loop whose last tool-calling
    // assistant turn carries no reasoning block of THIS origin must
    // not enable Anthropic thinking — the upstream 400s the pair.
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        foreignMsg,
        { role: 'tool' as const, content: 'sunny', toolCallId: 'call_1' },
        { role: 'user' as const, content: 'next' },
      ],
      config: {
        maxTokens: 4096,
        reasoning: { effort: 'medium' as const },
      },
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toBeUndefined();
    expect(
      trace.notes.some(
        (n) =>
          n.code === 'reasoning_dropped' &&
          n.path === 'thinking_disabled_no_prior_block',
      ),
    ).toBe(true);
  });

  it('guard passes with a same-origin reasoning block on the last tool-call turn', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'reasoning' as const,
              reasoning: {
                text: 'own thought',
                origin: { provider: 'claude', model: 'claude-opus-4-5' },
              },
              signature: {
                origin: { provider: 'claude', model: 'claude-opus-4-5' },
                data: 'sig-own',
              },
            },
          ],
          toolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
        { role: 'tool' as const, content: 'sunny', toolCallId: 'call_1' },
        { role: 'user' as const, content: 'next' },
      ],
      config: {
        maxTokens: 8192,
        reasoning: { effort: 'medium' as const },
      },
    };

    const wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    expect(wire.thinking).toEqual({ type: 'enabled', budget_tokens: expect.any(Number) });
  });

  it('no tool-call turn → guard does not apply', () => {
    const wire = runWithAttempt(ATTEMPT, () =>
      fromCanonicalRequest({
        model: 'claude-opus-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        config: {
          maxTokens: 8192,
          reasoning: { effort: 'medium' as const },
        },
      }),
    );
    expect(wire.thinking).toBeDefined();
  });

  // Owner decision 2026-11-16 (PR #108 gate B): Anthropic counts a
  // tool-use loop as ONE assistant turn, and manual mode requires a
  // thinking block at the START of the final assistant turn — so the
  // guard checks the loop's first assistant message, not the last
  // tool-calling one.
  const ownReasoningMsg = (toolCalls: { id: string; name: string }[]) => ({
    role: 'assistant' as const,
    content: [
      {
        type: 'reasoning' as const,
        reasoning: {
          text: 'own thought',
          origin: { provider: 'claude', model: 'claude-opus-4-5' },
        },
        signature: {
          origin: { provider: 'claude', model: 'claude-opus-4-5' },
          data: 'sig-own',
        },
      },
    ],
    toolCalls: toolCalls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: '{}' },
    })),
  });

  const toolCallsOnlyMsg = (id: string) => ({
    role: 'assistant' as const,
    content: '',
    toolCalls: [
      {
        id,
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{}' },
      },
    ],
  });

  const toolResult = (id: string) => ({
    role: 'tool' as const,
    content: 'sunny',
    toolCallId: id,
  });

  const baseConfig = {
    maxTokens: 8192,
    reasoning: { effort: 'medium' as const },
  };

  const guardNote = (trace: RequestTrace) =>
    trace.notes.some(
      (n) =>
        n.code === 'reasoning_dropped' &&
        n.path === 'thinking_disabled_no_prior_block',
    );

  it('guard keeps thinking when the loop starts with an own block and a later step has none', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        ownReasoningMsg([{ id: 'call_1', name: 'get_weather' }]),
        toolResult('call_1'),
        {
          role: 'assistant' as const,
          content: 'checking',
          toolCalls: [
            {
              id: 'call_2',
              type: 'function' as const,
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
        toolResult('call_2'),
      ],
      config: baseConfig,
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toEqual({
      type: 'enabled',
      budget_tokens: expect.any(Number),
    });
    expect(guardNote(trace)).toBe(false);
  });

  it('guard keeps thinking across an assistant text message inside the loop', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        ownReasoningMsg([{ id: 'call_1', name: 'get_weather' }]),
        toolResult('call_1'),
        { role: 'assistant' as const, content: 'ok' },
        toolCallsOnlyMsg('call_2'),
        toolResult('call_2'),
      ],
      config: baseConfig,
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toEqual({
      type: 'enabled',
      budget_tokens: expect.any(Number),
    });
    expect(guardNote(trace)).toBe(false);
  });

  it('guard fires when the loop start has no own block even if the last step does', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        toolCallsOnlyMsg('call_1'),
        toolResult('call_1'),
        ownReasoningMsg([{ id: 'call_2', name: 'get_weather' }]),
        toolResult('call_2'),
      ],
      config: baseConfig,
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toBeUndefined();
    expect(guardNote(trace)).toBe(true);
  });

  it('guard fires for a new loop after a user message', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        ownReasoningMsg([{ id: 'call_1', name: 'get_weather' }]),
        toolResult('call_1'),
        { role: 'user' as const, content: 'next' },
        toolCallsOnlyMsg('call_2'),
        toolResult('call_2'),
      ],
      config: baseConfig,
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toBeUndefined();
    expect(guardNote(trace)).toBe(true);
  });

  it('guard fires when the loop starts with a foreign block', () => {
    const request = {
      model: 'claude-opus-4-5',
      messages: [
        { role: 'user' as const, content: 'hi' },
        foreignMsg,
        toolResult('call_1'),
        ownReasoningMsg([{ id: 'call_2', name: 'get_weather' }]),
        toolResult('call_2'),
      ],
      config: baseConfig,
    };

    let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
    const trace = traced(() => {
      wire = runWithAttempt(ATTEMPT, () => fromCanonicalRequest(request));
    });

    expect(wire?.thinking).toBeUndefined();
    expect(guardNote(trace)).toBe(true);
  });
});
