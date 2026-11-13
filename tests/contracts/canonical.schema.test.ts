import { describe, it, expect } from 'vitest';
import { adapters, type Provider } from '../../src/transformers';
import {
  canonicalRequestSchema,
  canonicalResponseSchema,
  canonicalStreamEventSchema,
} from '../../src/types/canonical.schema';
import openaiFixtures from '../fixtures/openai.json';
import geminiFixtures from '../fixtures/gemini.json';
import ollamaFixtures from '../fixtures/ollama.json';
import anthropicFixtures from '../fixtures/anthropic.json';
import responsesFixtures from '../fixtures/responses.json';

/**
 * Contract tests: every adapter's toCanonical* output must satisfy
 * the canonical schema. This is the safety net that makes adapter-level
 * testing sufficient — if all adapters produce schema-valid canonical
 * data, any source→target pair composes correctly.
 */

// Representative provider-format inputs (one per adapter)
const PROVIDER_REQUESTS: Record<Provider, unknown> = {
  openai: {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc123' },
          },
        ],
      },
    ],
    temperature: 0.7,
    max_tokens: 150,
    top_p: 0.9,
    stop: ['END'],
  },
  gemini: {
    contents: [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi!' }] },
      {
        role: 'user',
        parts: [
          { text: 'What is this?' },
          { inlineData: { mimeType: 'image/png', data: 'abc123' } },
        ],
      },
    ],
    systemInstruction: { role: 'user', parts: [{ text: 'Be helpful' }] },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 150,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
    },
  },
  ollama: {
    model: 'llama3',
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'What is this?', images: ['aW1hZ2U='] },
    ],
    options: {
      temperature: 0.7,
      num_predict: 150,
      top_p: 0.9,
      top_k: 40,
      stop: ['END'],
      seed: 42,
    },
  },
  anthropic: {
    model: 'claude-3-opus-20240229',
    max_tokens: 150,
    system: 'You are helpful',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc123',
            },
          },
        ],
      },
    ],
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ['END'],
  },
  responses: {
    model: 'gpt-5-codex',
    instructions: 'You are helpful',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        ],
      },
    ],
    temperature: 0.7,
    max_output_tokens: 150,
    top_p: 0.9,
  },
};

const PROVIDER_RESPONSES: Record<Provider, unknown> = {
  openai: {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
  gemini: {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'Hello!' }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  },
  ollama: {
    model: 'llama3',
    created_at: new Date(),
    message: { role: 'assistant', content: 'Hello!' },
    done: true,
    done_reason: 'stop',
    total_duration: 100,
    load_duration: 10,
    prompt_eval_count: 10,
    prompt_eval_duration: 40,
    eval_count: 5,
    eval_duration: 50,
  },
  anthropic: {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus-20240229',
    content: [{ type: 'text', text: 'Hello!' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  responses: {
    id: 'resp_123',
    object: 'response',
    created_at: 1700000000,
    status: 'completed',
    model: 'gpt-5-codex',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hello!', annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  },
};

const providers: Provider[] = [
  'openai',
  'gemini',
  'ollama',
  'anthropic',
  'responses',
];

describe('Canonical schema contracts', () => {
  describe.each(providers)('%s adapter', (provider) => {
    const adapter = adapters[provider];

    it('toCanonicalRequest produces schema-valid canonical output', () => {
      const canonical = adapter.toCanonicalRequest(PROVIDER_REQUESTS[provider]);

      const result = canonicalRequestSchema.safeParse(canonical);
      if (!result.success) {
        console.error(provider, result.error.issues);
      }
      expect(result.success).toBe(true);
    });

    it('toCanonicalResponse produces schema-valid canonical output', () => {
      const canonical = adapter.toCanonicalResponse(
        PROVIDER_RESPONSES[provider],
        'test-model'
      );

      const result = canonicalResponseSchema.safeParse(canonical);
      if (!result.success) {
        console.error(provider, result.error.issues);
      }
      expect(result.success).toBe(true);
    });
  });

  it('every canonical request is accepted by every adapter (cross-compat)', () => {
    // For each source adapter, produce canonical → feed to every target adapter
    for (const source of providers) {
      const canonical = adapters[source].toCanonicalRequest(
        PROVIDER_REQUESTS[source]
      );

      for (const target of providers) {
        const result = canonicalRequestSchema.safeParse(canonical);
        expect(result.success).toBe(true);

        // Should not throw — proves canonical is a sufficient
        // superset for every target adapter
        const providerReq = adapters[target].fromCanonicalRequest(canonical);
        expect(providerReq).toBeDefined();
      }
    }
  });

  it('every canonical response is accepted by every adapter (cross-compat)', () => {
    for (const source of providers) {
      const canonical = adapters[source].toCanonicalResponse(
        PROVIDER_RESPONSES[source],
        'test-model'
      );

      for (const target of providers) {
        const providerRes = adapters[target].fromCanonicalResponse(canonical);
        expect(providerRes).toBeDefined();
      }
    }
  });
});

describe('Canonical stream event schema', () => {
  it('every CanonicalStreamEvent variant parses', () => {
    const events = [
      { type: 'message_start', id: 'msg_1', model: 'gpt-4' },
      { type: 'text_delta', text: 'hi' },
      { type: 'tool_call_start', index: 0, id: 'call_0', name: 'f' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"a":' },
      { type: 'tool_call_end', index: 0 },
      {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      { type: 'message_end', finishReason: 'stop' },
      {
        type: 'error',
        error: { kind: 'upstream', status: 502, message: 'boom' },
      },
    ];

    for (const event of events) {
      const result = canonicalStreamEventSchema.safeParse(event);
      if (!result.success) {
        console.error(event, result.error.issues);
      }
      expect(result.success).toBe(true);
    }
  });

  it('rejects a negative tool_call_delta index', () => {
    expect(
      canonicalStreamEventSchema.safeParse({
        type: 'tool_call_delta',
        index: -1,
        argumentsDelta: '',
      }).success
    ).toBe(false);
  });

  it('toolChoice variants parse on canonical requests', () => {
    const choices = [
      'auto',
      'none',
      'required',
      { type: 'function', function: { name: 'f' } },
    ];
    for (const toolChoice of choices) {
      const result = canonicalRequestSchema.safeParse({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        toolChoice,
      });
      expect(result.success).toBe(true);
    }
  });

  it('image part with cache is valid', () => {
    const result = canonicalRequestSchema.safeParse({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: { data: 'abc', mimeType: 'image/png' },
              cache: { ttl: '1h' },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'f' },
          cache: {},
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('tool message with a cache hint is valid (Task 17a)', () => {
    const result = canonicalRequestSchema.safeParse({
      model: 'm',
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: 'result text',
          cache: { ttl: '5m' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('system parts must be text', () => {
    const image = canonicalRequestSchema.safeParse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: [
        { type: 'image', image: { data: 'abc', mimeType: 'image/png' } },
      ],
    });
    expect(image.success).toBe(false);

    const text = canonicalRequestSchema.safeParse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cache: { ttl: '5m' } },
      ],
    });
    expect(text.success).toBe(true);
  });

  it('cached usage fields parse and stay optional', () => {
    const withCache = canonicalResponseSchema.safeParse({
      id: 'r1',
      model: 'm',
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: 90,
        cacheWriteTokens: 9,
      },
    });
    expect(withCache.success).toBe(true);

    const negative = canonicalResponseSchema.safeParse({
      id: 'r1',
      model: 'm',
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cacheReadTokens: -1,
      },
    });
    expect(negative.success).toBe(false);
  });
});

describe('v1.4 canonical extensions (v1.4 spec §3.2)', () => {
  const request = (over: Record<string, unknown>) => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  });
  const reasoningPart = {
    type: 'reasoning',
    reasoning: {
      text: 'let me think',
      origin: { provider: 'p', model: 'm' },
    },
  };

  it('reasoning part needs origin', () => {
    const noOrigin = canonicalRequestSchema.safeParse(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'reasoning', reasoning: { text: 't' } }],
          },
        ],
      })
    );
    expect(noOrigin.success).toBe(false);

    const noReasoning = canonicalRequestSchema.safeParse(
      request({
        messages: [
          { role: 'assistant', content: [{ type: 'reasoning' }] },
        ],
      })
    );
    expect(noReasoning.success).toBe(false);

    const valid = canonicalRequestSchema.safeParse(
      request({
        messages: [{ role: 'assistant', content: [reasoningPart] }],
      })
    );
    expect(valid.success).toBe(true);
  });

  it('reasoning part only on assistant messages', () => {
    for (const role of ['user', 'system', 'tool']) {
      const result = canonicalRequestSchema.safeParse(
        request({
          messages: [
            {
              role,
              ...(role === 'tool' ? { toolCallId: 'c1' } : {}),
              content: [reasoningPart],
            },
          ],
        })
      );
      expect(result.success, `role ${role}`).toBe(false);
    }

    const assistant = canonicalRequestSchema.safeParse(
      request({
        messages: [{ role: 'assistant', content: [reasoningPart] }],
      })
    );
    expect(assistant.success).toBe(true);
  });

  it('custom tool with grammar is valid', () => {
    const grammar = canonicalRequestSchema.safeParse(
      request({
        tools: [
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Apply a patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: x' },
            cache: { ttl: '5m' },
          },
        ],
      })
    );
    expect(grammar.success).toBe(true);

    const textFormat = canonicalRequestSchema.safeParse(
      request({
        tools: [{ type: 'custom', name: 't', format: { type: 'text' } }],
      })
    );
    expect(textFormat.success).toBe(true);

    const bare = canonicalRequestSchema.safeParse(
      request({ tools: [{ type: 'custom', name: 't' }] })
    );
    expect(bare.success).toBe(true);

    // A custom tool has no `function`; the shape stays discriminated.
    const bad = canonicalRequestSchema.safeParse(
      request({
        tools: [{ type: 'custom', name: 't', format: { type: 'yaml' } }],
      })
    );
    expect(bad.success).toBe(false);
  });

  it('responseFormat json_schema needs name and schema', () => {
    const noName = canonicalRequestSchema.safeParse(
      request({
        responseFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    expect(noName.success).toBe(false);

    const noSchema = canonicalRequestSchema.safeParse(
      request({ responseFormat: { type: 'json_schema', name: 'x' } })
    );
    expect(noSchema.success).toBe(false);

    const valid = canonicalRequestSchema.safeParse(
      request({
        responseFormat: {
          type: 'json_schema',
          name: 'x',
          schema: { type: 'object' },
          strict: true,
          description: 'd',
        },
      })
    );
    expect(valid.success).toBe(true);

    const jsonObject = canonicalRequestSchema.safeParse(
      request({ responseFormat: { type: 'json_object' } })
    );
    expect(jsonObject.success).toBe(true);
  });

  it('parallelToolCalls is optional boolean', () => {
    expect(
      canonicalRequestSchema.safeParse(
        request({ parallelToolCalls: false })
      ).success
    ).toBe(true);
    expect(
      canonicalRequestSchema.safeParse(
        request({ parallelToolCalls: 'no' })
      ).success
    ).toBe(false);
  });

  it("effort xhigh valid, 'max' invalid", () => {
    for (const effort of [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]) {
      const result = canonicalRequestSchema.safeParse(
        request({ config: { reasoning: { effort } } })
      );
      expect(result.success, `effort ${effort}`).toBe(true);
    }
    expect(
      canonicalRequestSchema.safeParse(
        request({ config: { reasoning: { effort: 'max' } } })
      ).success
    ).toBe(false);

    const full = canonicalRequestSchema.safeParse(
      request({
        config: {
          reasoning: { effort: 'high', summary: true, budgetTokens: 4096 },
        },
      })
    );
    expect(full.success).toBe(true);
  });

  it('existing requests still valid', () => {
    const fixtures: Record<Provider, { requests: Record<string, unknown> }> =
      {
        openai: openaiFixtures,
        gemini: geminiFixtures,
        ollama: ollamaFixtures,
        anthropic: anthropicFixtures,
        responses: responsesFixtures,
      };
    for (const provider of providers) {
      for (const [name, req] of Object.entries(fixtures[provider].requests)) {
        const canonical = adapters[provider].toCanonicalRequest(req);
        const result = canonicalRequestSchema.safeParse(canonical);
        expect(result.success, `${provider}/${name}`).toBe(true);
      }
    }
  });

  it('reasoning stream events and flagged tool_call_start parse', () => {
    const signature = {
      origin: { provider: 'p', model: 'm' },
      data: 'sig',
    };
    const events = [
      { type: 'reasoning_delta', index: 0, text: 'think' },
      { type: 'reasoning_signature', index: 0, signature },
      {
        type: 'tool_call_start',
        index: 0,
        id: 'call_0',
        name: 'f',
        custom: true,
        signature,
      },
    ];
    for (const event of events) {
      const result = canonicalStreamEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(event)).toBe(true);
    }
  });

  it('reasoning_start needs origin', () => {
    const noOrigin = canonicalStreamEventSchema.safeParse({
      type: 'reasoning_start',
      index: 0,
    });
    expect(noOrigin.success).toBe(false);

    const valid = canonicalStreamEventSchema.safeParse({
      type: 'reasoning_start',
      index: 0,
      origin: { provider: 'p', model: 'm' },
    });
    expect(valid.success).toBe(true);

    const redacted = canonicalStreamEventSchema.safeParse({
      type: 'reasoning_start',
      index: 0,
      origin: { provider: 'p', model: 'm' },
      redacted: true,
    });
    expect(redacted.success).toBe(true);
  });

  it('usage carries reasoningTokens only when non-negative', () => {
    const usage = {
      inputTokens: 11,
      outputTokens: 34,
      totalTokens: 45,
      reasoningTokens: 33,
    };
    const ok = canonicalResponseSchema.safeParse({
      id: 'r1',
      model: 'm',
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      usage,
    });
    expect(ok.success).toBe(true);

    const negative = canonicalResponseSchema.safeParse({
      id: 'r1',
      model: 'm',
      message: { role: 'assistant', content: 'hi' },
      finishReason: 'stop',
      usage: { ...usage, reasoningTokens: -1 },
    });
    expect(negative.success).toBe(false);
  });
});
