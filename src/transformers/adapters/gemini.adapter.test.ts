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
import { fromCanonicalRequest as anthropicFromCanonical } from './anthropic.adapter';
import { fromCanonicalRequest as openaiFromCanonical } from './openai.adapter';
import { fromCanonicalRequest as ollamaFromCanonical } from './ollama.adapter';
import { fromCanonicalRequest as responsesFromCanonical } from './responses.adapter';
import { runWithTrace, runWithAttempt } from '../../observe/context';
import { newTrace, type RequestTrace } from '../../observe/trace';

/** Run `fn` inside a trace scope and return the filled trace (§3.5). */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: 'r1',
    startedAt: 0,
    client: 'other',
    sourceApi: 'gemini',
  });
  runWithTrace(trace, fn);
  return trace;
}

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

  describe('reasoning config encode (v1.4 spec §3.3)', () => {
    const request = (
      model: string,
      reasoning: NonNullable<CanonicalRequest['config']>['reasoning'],
    ): CanonicalRequest => ({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      config: { reasoning },
    });

    const thinkingConfigOf = (
      result: GenerateContentRequest,
    ): Record<string, unknown> | undefined =>
      (result.generationConfig as Record<string, unknown> | undefined)
        ?.thinkingConfig as Record<string, unknown> | undefined;

    it.each(['minimal', 'low', 'medium', 'high'] as const)(
      'effort %s becomes thinkingLevel on a 3.x model',
      (effort) => {
        const result = fromCanonicalRequest(
          request('gemini-3-flash-preview', { effort }),
        );

        expect(thinkingConfigOf(result)).toEqual({
          thinkingLevel: effort,
        });
      },
    );

    it('xhigh is sent on models that document it', () => {
      const result = fromCanonicalRequest(
        request('gemini-4-hydrogen', { effort: 'xhigh' }),
      );

      expect(thinkingConfigOf(result)).toEqual({
        thinkingLevel: 'xhigh',
      });
    });

    it('xhigh lowers to high where the model lacks it, with a note', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('gemini-3-flash-preview', { effort: 'xhigh' }),
        ),
      );

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_effort_lowered',
        path: 'reasoning.effort',
      });
    });

    it('medium lowers to low on gemini-3-pro-preview (no medium level)', () => {
      const result = fromCanonicalRequest(
        request('gemini-3-pro-preview', { effort: 'medium' }),
      );

      expect(thinkingConfigOf(result)).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('effort none clamps to the model floor with a note on 3.x', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('gemini-3-flash-preview', { effort: 'none' }),
        ),
      );

      const result = fromCanonicalRequest(
        request('gemini-3-flash-preview', { effort: 'none' }),
      );
      expect(thinkingConfigOf(result)).toEqual({
        thinkingLevel: 'minimal',
      });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_effort_clamped',
        path: 'reasoning.effort',
      });
    });

    it('effort none clamps to low on gemini-3-pro-preview (its floor)', () => {
      const result = fromCanonicalRequest(
        request('gemini-3-pro-preview', { effort: 'none' }),
      );

      expect(thinkingConfigOf(result)).toEqual({
        thinkingLevel: 'low',
      });
    });

    it.each([
      ['minimal', 1024],
      ['low', 2048],
      ['medium', 8192],
      ['high', 24576],
      ['xhigh', 32000],
    ] as const)(
      'effort %s becomes thinkingBudget %i on a 2.5 model',
      (effort, budget) => {
        // gemini-2.5-pro's documented range (128–32768) covers every
        // budget, so the raw mapping shows unclamped.
        const result = fromCanonicalRequest(
          request('gemini-2.5-pro', { effort }),
        );

        expect(thinkingConfigOf(result)).toEqual({
          thinkingBudget: budget,
        });
      },
    );

    it('effort none becomes thinkingBudget 0 on a 2.5 model', () => {
      const result = fromCanonicalRequest(
        request('gemini-2.5-flash', { effort: 'none' }),
      );

      expect(thinkingConfigOf(result)).toEqual({ thinkingBudget: 0 });
    });

    it('none on 2.5 pro omits thinkingBudget with a note', () => {
      // 2.5 Pro cannot turn thinking off (its budget table row has
      // no off switch), so the wire gets no budget at all.
      const trace = traced(() =>
        fromCanonicalRequest(request('gemini-2.5-pro', { effort: 'none' })),
      );

      const result = fromCanonicalRequest(
        request('gemini-2.5-pro', { effort: 'none' }),
      );
      expect(thinkingConfigOf(result)).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_effort_raised',
        path: 'reasoning.effort',
      });
    });

    it('budget clamped to the model maximum', () => {
      // xhigh's 32000 exceeds 2.5 Flash's documented 24576 maximum.
      const trace = traced(() =>
        fromCanonicalRequest(request('gemini-2.5-flash', { effort: 'xhigh' })),
      );

      const result = fromCanonicalRequest(
        request('gemini-2.5-flash', { effort: 'xhigh' }),
      );
      expect(thinkingConfigOf(result)).toEqual({ thinkingBudget: 24576 });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_budget_clamped',
        path: 'reasoning.effort',
      });
    });

    it('budget below the model minimum is raised', () => {
      // 2.5 Pro's documented floor is 128.
      const trace = traced(() =>
        fromCanonicalRequest(
          request('gemini-2.5-pro', { budgetTokens: 100 }),
        ),
      );

      const result = fromCanonicalRequest(
        request('gemini-2.5-pro', { budgetTokens: 100 }),
      );
      expect(thinkingConfigOf(result)).toEqual({ thinkingBudget: 128 });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_budget_clamped',
        path: 'reasoning.budget_tokens',
      });
    });

    it('reasoning {} sends no thinkingConfig on a 2.5 model', () => {
      const result = fromCanonicalRequest(
        request('gemini-2.5-flash-lite', {}),
      );

      expect(thinkingConfigOf(result)).toBeUndefined();
    });

    it('no effort leaves thinking off', () => {
      // 2.5 (budget path) — the Codex case (summary only) emits
      // includeThoughts but no thinkingBudget.
      expect(
        fromCanonicalRequest(
          request('gemini-2.5-flash', { summary: true }),
        ),
      ).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          thinkingConfig: { includeThoughts: true },
        },
      });
    });

    it('no effort leaves thinking off', () => {
      // 3.x (level path) — includeThoughts but no thinkingLevel.
      expect(
        fromCanonicalRequest(
          request('gemini-3-flash-preview', { summary: true }),
        ),
      ).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          thinkingConfig: { includeThoughts: true },
        },
      });
    });

    it('explicit budgetTokens becomes thinkingBudget on a 2.5 model', () => {
      const result = fromCanonicalRequest(
        request('gemini-2.5-flash', { budgetTokens: 5000 }),
      );

      expect(thinkingConfigOf(result)).toEqual({
        thinkingBudget: 5000,
      });
    });

    it('explicit budgetTokens is dropped with a note on a 3.x model', () => {
      const trace = traced(() =>
        fromCanonicalRequest(
          request('gemini-3-flash-preview', { budgetTokens: 5000 }),
        ),
      );

      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_budget_dropped',
        path: 'reasoning.budget_tokens',
      });
    });

    it('summary becomes includeThoughts', () => {
      const result = fromCanonicalRequest(
        request('gemini-3-flash-preview', { effort: 'low', summary: true }),
      );

      expect(thinkingConfigOf(result)).toEqual({
        thinkingLevel: 'low',
        includeThoughts: true,
      });
    });
  });

  describe('reasoning fields still dropped (v1.4 spec §3.3)', () => {
    it('gemini thinkingConfig produces no config.reasoning, body unchanged for every target', () => {
      const canonical = toCanonicalRequest({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 1024 },
        },
      } as GenerateContentRequest);

      expect(canonical.config?.reasoning).toBeUndefined();

      expect(fromCanonicalRequest(canonical)).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {},
      });
      expect(anthropicFromCanonical(canonical)).toEqual({
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      });
      expect(openaiFromCanonical(canonical)).toEqual({
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(ollamaFromCanonical(canonical)).toEqual({
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(responsesFromCanonical(canonical)).toEqual({
        model: 'gemini-pro',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        ],
        store: false,
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
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      } as unknown as GenerateContentRequest;

      const canonical = toCanonicalRequest(wire);
      // responseJsonSchema carries no name — the canonical side gets
      // the fixed default name.
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

      const out = fromCanonicalRequest(canonical) as GenerateContentRequest;
      // The v1.2 tool-parameter sanitiser never touches
      // responseJsonSchema: $defs/$ref/anyOf/minimum/
      // additionalProperties all survive.
      const gc = out.generationConfig as
        | Record<string, unknown>
        | undefined;
      expect(gc?.responseJsonSchema).toEqual(schema);
      expect(gc?.responseMimeType).toBe('application/json');
      // The encoder never sends the canonical name.
      expect(out.generationConfig).not.toHaveProperty(
        'responseSchema',
      );
    });

    it('responseSchema decodes to the same canonical schema', () => {
      const schema = { ...SCHEMA };
      const canonical = toCanonicalRequest({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      } as unknown as GenerateContentRequest);

      expect(canonical.responseFormat).toEqual({
        type: 'json_schema',
        name: 'response',
        schema,
      });
      expect(
        canonical.responseFormat?.type === 'json_schema' &&
          canonical.responseFormat.schema,
      ).toBe(schema);
    });

    it('responseMimeType application/json alone is json_object', () => {
      const canonical = toCanonicalRequest({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { responseMimeType: 'application/json' },
      } as GenerateContentRequest);

      expect(canonical.responseFormat).toEqual({ type: 'json_object' });
    });

    it('json_object mapping', () => {
      const out = fromCanonicalRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
      }) as GenerateContentRequest;

      expect(out.generationConfig).toEqual({
        responseMimeType: 'application/json',
      });
    });

    it('an unknown responseMimeType is dropped with a note', () => {
      const trace = traced(() =>
        toCanonicalRequest({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { responseMimeType: 'text/x.enum' },
        } as GenerateContentRequest),
      );

      const canonical = toCanonicalRequest({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { responseMimeType: 'text/x.enum' },
      } as GenerateContentRequest);
      expect(canonical.responseFormat).toBeUndefined();
      expect(trace.notes).toContainEqual({
        stage: 'decode',
        adapter: 'gemini',
        code: 'field_dropped',
        path: 'generationConfig.responseMimeType',
      });
    });
  });

  describe('reasoning parts and signatures (v1.4 spec §3.3, Task 7)', () => {
    const ATTEMPT = {
      providerName: 'gemini-main',
      upstreamModel: 'gemini-2.5-flash',
    };
    const ORIGIN = { provider: 'gemini-main', model: 'gemini-2.5-flash' };

    const encodeRequest = (message: CanonicalRequest['messages'][number]) =>
      runWithAttempt(ATTEMPT, () =>
        fromCanonicalRequest({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'hi' }, message],
        }),
      );

    it('gemini signature returns on its functionCall', () => {
      // ai.google.dev/gemini-api/docs/thought-signatures: the real
      // signature rides the part-level `thoughtSignature` sibling and
      // replaces the v1.3 placeholder on encode.
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'sum', args: { a: 1 } },
                  thoughtSignature: 'sig_fc',
                },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      } as unknown as GenerateContentResponse;

      const canonical = runWithAttempt(ATTEMPT, () =>
        toCanonicalResponse(response, 'gemini-2.5-flash', sequentialIds()),
      );

      expect(canonical.message.toolCalls).toEqual([
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'sum', arguments: '{"a":1}' },
          signature: { origin: ORIGIN, data: 'sig_fc' },
        },
      ]);

      const wire = encodeRequest(canonical.message);
      expect(wire.contents[1].parts).toEqual([
        {
          functionCall: { name: 'sum', args: { a: 1 } },
          thoughtSignature: 'sig_fc',
        },
      ]);
    });

    it('gemini text-part signature returns on its text part', () => {
      // Encode side of "signatures on the part they came on": a signed
      // text part of the current origin carries thoughtSignature back.
      const message = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'signed answer',
            signature: { origin: ORIGIN, data: 'sig_txt' },
          },
        ],
      } as CanonicalRequest['messages'][number];

      const wire = encodeRequest(message);

      expect(wire.contents[1].parts).toEqual([
        { text: 'signed answer', thoughtSignature: 'sig_txt' },
      ]);
    });

    it('placeholder only when no signature', () => {
      // E8: `skip_thought_signature_validator` stays only for calls
      // with no matching-origin signature.
      const unsigned = {
        id: 'call_u',
        type: 'function',
        function: { name: 'f', arguments: '{}' },
      };
      const signed = {
        id: 'call_s',
        type: 'function',
        function: { name: 'g', arguments: '{}' },
        signature: { origin: ORIGIN, data: 'sig_g' },
      };
      const message = {
        role: 'assistant',
        content: '',
        toolCalls: [unsigned, signed],
      } as CanonicalRequest['messages'][number];

      const wire = encodeRequest(message);

      expect(wire.contents[1].parts).toEqual([
        {
          functionCall: { name: 'f', args: {} },
          thoughtSignature: 'skip_thought_signature_validator',
        },
        {
          functionCall: { name: 'g', args: {} },
          thoughtSignature: 'sig_g',
        },
      ]);
    });

    it('thought part decodes to a reasoning part and returns as one', () => {
      // `thought: true` marks a reasoning part on the wire; its
      // thoughtSignature becomes the part's signature.
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'thinking it over',
                  thought: true,
                  thoughtSignature: 'sig_th',
                },
                { text: 'answer' },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      } as unknown as GenerateContentResponse;

      const canonical = runWithAttempt(ATTEMPT, () =>
        toCanonicalResponse(response, 'gemini-2.5-flash', sequentialIds()),
      );

      expect(canonical.message.content).toEqual([
        {
          type: 'reasoning',
          reasoning: { text: 'thinking it over', origin: ORIGIN },
          signature: { origin: ORIGIN, data: 'sig_th' },
        },
        { type: 'text', text: 'answer' },
      ]);

      const wire = encodeRequest(canonical.message);
      expect(wire.contents[1].parts).toEqual([
        {
          text: 'thinking it over',
          thought: true,
          thoughtSignature: 'sig_th',
        },
        { text: 'answer' },
      ]);
    });

    it('foreign origin dropped with a note', () => {
      // Same provider, other model → dropped (spec §3.2).
      const foreign = { provider: 'gemini-main', model: 'gemini-3-pro' };
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
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'f', arguments: '{}' },
            signature: { origin: foreign, data: 'sig_c' },
          },
        ],
      } as CanonicalRequest['messages'][number];

      let wire: ReturnType<typeof fromCanonicalRequest> | undefined;
      const trace = traced(() => {
        wire = encodeRequest(message);
      });

      expect(wire?.contents[1].parts).toEqual([
        { text: 'answer' },
        {
          functionCall: { name: 'f', args: {} },
          thoughtSignature: 'skip_thought_signature_validator',
        },
      ]);
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_dropped',
        path: 'reasoning',
      });
      expect(trace.notes).toContainEqual({
        stage: 'encode',
        adapter: 'gemini',
        code: 'reasoning_dropped',
        path: 'signature',
      });
    });

    it('gemini client never receives thought parts', () => {
      const canonical: CanonicalResponse = {
        id: 'r1',
        model: 'gemini-2.5-flash',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              reasoning: { text: 'hmm', origin: ORIGIN },
              signature: { origin: ORIGIN, data: 'sig_1' },
            },
            { type: 'text', text: 'answer' },
          ],
        },
      };

      const wire = fromCanonicalResponse(canonical);

      expect(wire.candidates?.[0]?.content?.parts).toEqual([
        { text: 'answer' },
      ]);
    });
  });
});
