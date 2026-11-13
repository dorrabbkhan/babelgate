import { describe, it, expect } from 'vitest';
import { FinishReason } from '@google/generative-ai';
import {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
} from './gemini.adapter';
import type { CanonicalRequest, CanonicalResponse } from '../../types/canonical.types';
import type { GenerateContentRequest, GenerateContentResponse, Content, FunctionResponsePart } from '../../types/gemini.types';
import { sequentialIds } from '../../utils/ids';
import { ValidationError } from '../../utils/errors';

describe('Gemini Adapter', () => {
  describe('toCanonicalRequest', () => {
    it('should convert basic request', () => {
      const input: GenerateContentRequest = {
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
        ],
      };

      const result = toCanonicalRequest(input);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
    });

    it('should extract system instruction', () => {
      const input: GenerateContentRequest = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        systemInstruction: {
          role: 'user',
          parts: [{ text: 'You are helpful' }],
        },
      };

      const result = toCanonicalRequest(input);

      expect(result.systemPrompt).toBe('You are helpful');
    });

    it('should map model role to assistant', () => {
      const input: GenerateContentRequest = {
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Hi there!' }] },
        ],
      };

      const result = toCanonicalRequest(input);

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('should convert generation config', () => {
      const input: GenerateContentRequest = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
          topP: 0.9,
          topK: 40,
          stopSequences: ['END'],
        },
      };

      const result = toCanonicalRequest(input);

      expect(result.config?.temperature).toBe(0.7);
      expect(result.config?.maxTokens).toBe(100);
      expect(result.config?.topP).toBe(0.9);
      expect(result.config?.topK).toBe(40);
      expect(result.config?.stopSequences).toEqual(['END']);
    });

    it('should handle multipart content with images', () => {
      const input: GenerateContentRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'What is this?' },
              { inlineData: { mimeType: 'image/png', data: 'abc123' } },
            ],
          },
        ],
      };

      const result = toCanonicalRequest(input);
      const content = result.messages[0].content;

      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(content[1].type).toBe('image');
      }
    });
  });

  describe('fromCanonicalRequest', () => {
    it('should convert basic canonical request', () => {
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = fromCanonicalRequest(input);

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[0].parts[0]).toEqual({ text: 'Hello' });
    });

    it('should add system instruction from systemPrompt', () => {
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'You are helpful',
      };

      const result = fromCanonicalRequest(input);

      expect(result.systemInstruction).toBeDefined();
      expect((result.systemInstruction as Content).parts[0]).toEqual({
        text: 'You are helpful',
      });
    });

    it('should filter out system messages from contents', () => {
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('user');
    });

    it('should convert config to generationConfig', () => {
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'Hello' }],
        config: {
          temperature: 0.7,
          maxTokens: 100,
          topP: 0.9,
          stopSequences: ['END'],
        },
      };

      const result = fromCanonicalRequest(input);

      expect(result.generationConfig?.temperature).toBe(0.7);
      expect(result.generationConfig?.maxOutputTokens).toBe(100);
      expect(result.generationConfig?.topP).toBe(0.9);
      expect(result.generationConfig?.stopSequences).toEqual(['END']);
    });

    it('should map assistant role to model', () => {
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.contents[0].role).toBe('user');
      expect(result.contents[1].role).toBe('model');
    });
  });

  describe('hinted system parts (spec §3.2)', () => {
    it('flattens hinted system parts to one instruction', () => {
      const hinted = [
        { type: 'text' as const, text: 'A', cache: {} },
        { type: 'text' as const, text: 'B' },
      ];
      const input: CanonicalRequest = {
        model: 'gemini-pro',
        systemPrompt: hinted,
        messages: [
          { role: 'system', content: hinted },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = fromCanonicalRequest(input);

      expect(result.systemInstruction).toEqual({
        role: 'user',
        parts: [{ text: 'A\n\nB' }],
      });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('user');
    });
  });

  describe('toCanonicalResponse', () => {
    it('should convert basic response', () => {
      const input: GenerateContentResponse = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello!' }] },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const result = toCanonicalResponse(input, 'gemini-pro');

      expect(result.model).toBe('gemini-pro');
      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello!');
      expect(result.finishReason).toBe('stop');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
    });

    it('should generate valid id', () => {
      const input: GenerateContentResponse = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hi' }] },
            index: 0,
          },
        ],
      };

      const result = toCanonicalResponse(input, 'gemini-pro');

      expect(result.id).toMatch(/^gemini-/);
    });

    it('should map finish reasons correctly', () => {
      const makeResponse = (finishReason: FinishReason): GenerateContentResponse => ({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '' }] },
            finishReason,
            index: 0,
          },
        ],
      });

      expect(toCanonicalResponse(makeResponse(FinishReason.STOP), 'gemini-pro').finishReason).toBe('stop');
      expect(toCanonicalResponse(makeResponse(FinishReason.MAX_TOKENS), 'gemini-pro').finishReason).toBe('length');
      expect(toCanonicalResponse(makeResponse(FinishReason.SAFETY), 'gemini-pro').finishReason).toBe('content_filter');
    });

    it('should map safety finish reasons to content_filter', () => {
      const makeResponse = (finishReason: FinishReason): GenerateContentResponse => ({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '' }] },
            finishReason,
            index: 0,
          },
        ],
      });

      // IMAGE_SAFETY is in ai.google.dev/api/generate-content#FinishReason
      // but predates the installed SDK's enum.
      for (const reason of [
        FinishReason.BLOCKLIST,
        FinishReason.PROHIBITED_CONTENT,
        FinishReason.SPII,
        'IMAGE_SAFETY' as FinishReason,
      ]) {
        expect(toCanonicalResponse(makeResponse(reason), 'gemini-pro').finishReason).toBe('content_filter');
      }
    });
  });

  describe('fromCanonicalResponse', () => {
    it('should convert canonical response to Gemini format', () => {
      const input: CanonicalResponse = {
        id: 'test-123',
        model: 'gemini-pro',
        message: { role: 'assistant', content: 'Hello!' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const result = fromCanonicalResponse(input);

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates![0].content.parts[0]).toEqual({ text: 'Hello!' });
      expect(result.candidates![0].finishReason).toBe(FinishReason.STOP);
      expect(result.usageMetadata?.promptTokenCount).toBe(10);
      expect(result.usageMetadata?.candidatesTokenCount).toBe(5);
    });

    it('should map finish reasons back to Gemini format', () => {
      const makeCanonical = (finishReason: CanonicalResponse['finishReason']): CanonicalResponse => ({
        id: 'test',
        model: 'gemini-pro',
        message: { role: 'assistant', content: '' },
        finishReason,
      });

      expect(fromCanonicalResponse(makeCanonical('stop')).candidates![0].finishReason).toBe(FinishReason.STOP);
      expect(fromCanonicalResponse(makeCanonical('length')).candidates![0].finishReason).toBe(FinishReason.MAX_TOKENS);
      expect(fromCanonicalResponse(makeCanonical('content_filter')).candidates![0].finishReason).toBe(FinishReason.SAFETY);
    });

    it('should carry the canonical call id as functionCall.id', () => {
      // FunctionCall.id is a documented optional field; the stream
      // encoder already sends it and a client echoes it back as
      // functionResponse.id.
      const input: CanonicalResponse = {
        id: 'test',
        model: 'gemini-pro',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_42',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        finishReason: 'tool_call',
      };

      const result = fromCanonicalResponse(input);

      expect(result.candidates![0].content.parts).toEqual([
        {
          functionCall: {
            id: 'call_42',
            name: 'get_weather',
            args: { city: 'Paris' },
          },
        },
      ]);
    });
  });

  describe('tools', () => {
    it('gemini toolChoice round trip', () => {
      const base: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather' },
          },
        ],
      };
      const choices: CanonicalRequest['toolChoice'][] = [
        'auto',
        'none',
        'required',
        { type: 'function', function: { name: 'get_weather' } },
      ];

      for (const toolChoice of choices) {
        const gemini = fromCanonicalRequest({ ...base, toolChoice });
        const back = toCanonicalRequest(gemini);
        expect(back.toolChoice).toEqual(toolChoice);
      }
    });

    it('gemini functionCall gets a generated ID', () => {
      const response = {
        candidates: [
          {
            content: {
              role: 'model' as const,
              parts: [
                { functionCall: { name: 'a', args: { x: 1 } } },
                {
                  functionCall: { id: 'wire-id', name: 'b', args: { y: 2 } },
                },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      };

      const result = toCanonicalResponse(
        response as GenerateContentResponse,
        'gemini-pro',
        sequentialIds(),
      );

      expect(result.message.toolCalls).toEqual([
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'a', arguments: '{"x":1}' },
        },
        {
          id: 'wire-id',
          type: 'function',
          function: { name: 'b', arguments: '{"y":2}' },
        },
      ]);
      expect(result.finishReason).toBe('tool_call');
    });

    it('gemini functionResponse finds the name from history', () => {
      const request: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'call_9', content: '{"temp":72}' },
        ],
      };

      const result = fromCanonicalRequest(request);

      expect(result.contents[2]).toEqual({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_weather',
              response: { temp: 72 },
            },
          },
        ],
      });
      expect(result.contents[1].parts[0]).toEqual({
        functionCall: { name: 'get_weather', args: { city: 'Paris' } },
        thoughtSignature: 'skip_thought_signature_validator',
      });
    });

    it('gemini request encoder still omits functionCall.id', () => {
      const request: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_42',
                type: 'function',
                function: { name: 'f', arguments: '{"x":1}' },
              },
            ],
          },
        ],
      };

      const result = fromCanonicalRequest(request);

      expect(result.contents[0].parts[0]).toEqual({
        functionCall: { name: 'f', args: { x: 1 } },
        thoughtSignature: 'skip_thought_signature_validator',
      });
    });

    it('gemini string tool result is wrapped as {content}', () => {
      const request: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'f', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'call_0', content: 'sunny' },
        ],
      };

      const result = fromCanonicalRequest(request);
      const part = result.contents[1].parts[0] as FunctionResponsePart;

      expect(part.functionResponse.response).toEqual({ content: 'sunny' });
    });

    it('gemini tool result with no matching call → ValidationError', () => {
      const request: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'tool', toolCallId: 'call_7', content: 'sunny' },
        ],
      };

      expect(() => fromCanonicalRequest(request)).toThrow(ValidationError);
    });

    it('gemini consecutive tool messages share one user turn', () => {
      const request: CanonicalRequest = {
        model: 'gemini-pro',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'a', arguments: '{}' },
              },
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'b', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'call_0', content: '1' },
          { role: 'tool', toolCallId: 'call_1', content: '2' },
        ],
      };

      const result = fromCanonicalRequest(request);

      expect(result.contents).toHaveLength(2);
      expect(result.contents[1].role).toBe('user');
      expect(result.contents[1].parts).toHaveLength(2);
    });

    it('gemini VALIDATED mode → ValidationError', () => {
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'f' }] }],
        toolConfig: {
          functionCallingConfig: { mode: 'VALIDATED' },
        },
      };

      expect(() =>
        toCanonicalRequest(request as GenerateContentRequest),
      ).toThrow(ValidationError);
    });

    it('gemini ANY with several allowedFunctionNames → 400', () => {
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'f' }, { name: 'g' }] }],
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['f', 'g'],
          },
        },
      };

      expect(() =>
        toCanonicalRequest(request as GenerateContentRequest),
      ).toThrow(ValidationError);
    });

    it('gemini non-function tool entry → 400 naming the tool type', () => {
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        tools: [{ googleSearchRetrieval: {} }],
      };

      expect(() =>
        toCanonicalRequest(request as GenerateContentRequest),
      ).toThrow(ValidationError);
      expect(() =>
        toCanonicalRequest(request as GenerateContentRequest),
      ).toThrow('Gemini tool type "googleSearchRetrieval" is not supported');
    });

    it('gemini parallel calls to the same function keep their own results', () => {
      const request = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: { city: 'Paris' },
                },
              },
              {
                functionCall: {
                  name: 'get_weather',
                  args: { city: 'London' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'get_weather',
                  response: { temp: 72 },
                },
              },
              {
                functionResponse: {
                  name: 'get_weather',
                  response: { temp: 55 },
                },
              },
            ],
          },
        ],
      };

      const result = toCanonicalRequest(request as GenerateContentRequest);
      const calls = result.messages[0].toolCalls!;

      expect(calls).toHaveLength(2);
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].toolCallId).toBe(calls[0].id);
      expect(result.messages[1].content).toBe('{"temp":72}');
      expect(result.messages[2].role).toBe('tool');
      expect(result.messages[2].toolCallId).toBe(calls[1].id);
      expect(result.messages[2].content).toBe('{"temp":55}');
    });

    it('gemini functionResponse id wins over name order', () => {
      const request = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_paris',
                  name: 'get_weather',
                  args: { city: 'Paris' },
                },
              },
              {
                functionCall: {
                  id: 'call_london',
                  name: 'get_weather',
                  args: { city: 'London' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_london',
                  name: 'get_weather',
                  response: { temp: 55 },
                },
              },
              {
                functionResponse: {
                  name: 'get_weather',
                  response: { temp: 72 },
                },
              },
            ],
          },
        ],
      };

      const result = toCanonicalRequest(request as GenerateContentRequest);

      expect(result.messages[1].toolCallId).toBe('call_london');
      expect(result.messages[1].content).toBe('{"temp":55}');
      expect(result.messages[2].toolCallId).toBe('call_paris');
      expect(result.messages[2].content).toBe('{"temp":72}');
    });
  });

  describe('cached usage (spec §3.2)', () => {
    it('cachedContentTokenCount decoded and encoded', () => {
      const decoded = toCanonicalResponse(
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hi' }] },
              finishReason: FinishReason.STOP,
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 5,
            totalTokenCount: 105,
            cachedContentTokenCount: 60,
          },
        },
        'gemini-pro'
      );

      expect(decoded.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: 60,
      });

      const encoded = fromCanonicalResponse({
        id: 'gemini-1',
        model: 'gemini-pro',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 5,
          totalTokens: 105,
          cacheReadTokens: 60,
        },
      });

      expect(encoded.usageMetadata).toStrictEqual({
        promptTokenCount: 100,
        candidatesTokenCount: 5,
        totalTokenCount: 105,
        cachedContentTokenCount: 60,
      });
    });
  });

  describe('reasoning-token usage (v1.4 spec §3.2, E9)', () => {
    it('thoughtsTokenCount added to output', () => {
      const decoded = toCanonicalResponse(
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hi' }] },
              finishReason: FinishReason.STOP,
              index: 0,
            },
          ],
          // ai.google.dev/api/generate-content#UsageMetadata adds
          // thoughtsTokenCount on thinking models; the bundled SDK
          // type predates it and no totalTokenCount arrives here.
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 1,
            thoughtsTokenCount: 33,
          },
        } as unknown as GenerateContentResponse,
        'gemini-2.5-flash'
      );

      expect(decoded.usage).toEqual({
        inputTokens: 11,
        outputTokens: 34,
        reasoningTokens: 33,
        totalTokens: 45,
      });
    });

    it('no thoughts, no reasoningTokens field', () => {
      const decoded = toCanonicalResponse(
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hi' }] },
              finishReason: FinishReason.STOP,
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        },
        'gemini-2.5-flash'
      );

      expect(decoded.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      expect(decoded.usage).not.toHaveProperty('reasoningTokens');
    });

    it('encode splits back', () => {
      const encoded = fromCanonicalResponse({
        id: 'gemini-1',
        model: 'gemini-2.5-flash',
        message: { role: 'assistant', content: 'Hi' },
        finishReason: 'stop',
        usage: {
          inputTokens: 11,
          outputTokens: 34,
          reasoningTokens: 33,
          totalTokens: 45,
        },
      });

      expect(encoded.usageMetadata).toStrictEqual({
        promptTokenCount: 11,
        candidatesTokenCount: 1,
        totalTokenCount: 45,
        thoughtsTokenCount: 33,
      });
    });
  });

  describe('roundtrip', () => {
    it('should preserve data through request roundtrip', () => {
      const original: GenerateContentRequest = {
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Hi!' }] },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
        },
      };

      const canonical = toCanonicalRequest(original);
      const result = fromCanonicalRequest(canonical);

      expect(result.contents.length).toBe(original.contents.length);
      expect(result.generationConfig?.temperature).toBe(original.generationConfig?.temperature);
      expect(result.generationConfig?.maxOutputTokens).toBe(original.generationConfig?.maxOutputTokens);
    });
  });
});

describe('cache hints on tool results (Task 17a)', () => {
  it('a cache hint on a tool message changes nothing on the wire', () => {
    // Gemini has no request-side cache markers (spec §3.2); the hint
    // is ignored, so the encoded request is byte-identical.
    const base: CanonicalRequest = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: '18C, sunny' },
      ],
    };
    const hinted: CanonicalRequest = {
      ...base,
      messages: base.messages.map((m) =>
        m.role === 'tool' ? { ...m, cache: { ttl: '1h' } } : m,
      ),
    };

    expect(fromCanonicalRequest(hinted)).toEqual(fromCanonicalRequest(base));
  });
});
