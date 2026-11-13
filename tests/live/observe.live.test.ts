import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import {
  requireOllama,
  useTarget,
  useYamlConfig,
  liveModel,
  OPENROUTER_BASE_URL,
  OPENROUTER_ANTHROPIC_MODEL,
  SOURCE_FORMAT_CHECKS,
} from './live.helpers';

/**
 * Live observe cases (spec §4.5): the endpoints and usage fields the
 * release gates rely on. `:countTokens` is answered locally — the first
 * case needs no upstream at all (a valid config is enough); the
 * OpenRouter cache-read case runs when OPENROUTER_API_KEY is set and
 * the Gemini 3.x parallel-functionCall case when GEMINI_API_KEY is —
 * the suite's conditional-inclusion convention, no skip APIs.
 */

beforeAll(requireOllama);

describe('live observe', () => {
  it('gemini countTokens against babelgate', async () => {
    useTarget('gemini', 'ollama');
    const res = await request(app)
      .post(`/v1beta/models/${liveModel('gemini')}:countTokens`)
      .send({
        contents: [{ role: 'user', parts: [{ text: 'Reply with one word.' }] }],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['x-babelgate-token-estimate']).toBe('true');
    expect(res.body.totalTokens).toBeGreaterThan(0);
  });
});

// The requested model has no provider prefix, so the `*` route claims
// it and the OpenRouter provider serves it as OPENROUTER_ANTHROPIC_MODEL.
// `cache_hints: true` passes the Anthropic-style cache_control through.
const OPENROUTER_CACHE_YAML = `default: openrouter
providers:
  openrouter:
    type: openai
    base_url: ${OPENROUTER_BASE_URL}
    api_key_env: OPENROUTER_API_KEY
    cache_hints: true
routes:
  - match: "*"
    to: openrouter/${OPENROUTER_ANTHROPIC_MODEL}
`;

// ~45 000 chars of varied text, roughly 10 000+ tokens — well over the
// 4 096-token minimum cacheable prompt for Claude Haiku 4.5 (Anthropic
// prompt-caching docs).
const CACHEABLE_SYSTEM = {
  type: 'text',
  text: `You are a careful code reviewer.\n${Array.from(
    { length: 600 },
    (_, i) =>
      `Rule ${i + 1}: review item ${i + 1} — check naming, error handling and tests in module ${i + 1}.`,
  ).join('\n')}`,
  cache_control: { type: 'ephemeral' },
};

// The two calls must be identical for the second to hit the cache.
const CACHE_BODY = {
  model: 'claude-haiku-4.5',
  max_tokens: 512,
  system: [CACHEABLE_SYSTEM],
  messages: [{ role: 'user', content: 'Reply with one word.' }],
};

// Task 17a: a Claude-Code-shaped tool loop — the moving breakpoint
// sits on the newest tool_result block. The shared prefix (hinted
// system + tools + the first tool turn) is identical across the two
// calls; the second call is one turn longer and moves the marker to
// the newest tool_result.
const toolResult = (id: string, text: string, hinted: boolean) => ({
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: id,
      content: text,
      ...(hinted ? { cache_control: { type: 'ephemeral' } } : {}),
    },
  ],
});

const TOOL_LOOP_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from disk.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
  },
];

const TOOL_LOOP_TURN_1 = [
  { role: 'user', content: 'Read package.json and summarise it.' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'package.json' },
      },
    ],
  },
];

const TOOL_LOOP_BODY_1 = {
  model: 'claude-haiku-4.5',
  max_tokens: 512,
  system: [CACHEABLE_SYSTEM],
  tools: TOOL_LOOP_TOOLS,
  messages: [
    ...TOOL_LOOP_TURN_1,
    toolResult('call_1', '{"name":"babelgate","version":"1.3.0"}', true),
  ],
};

const TOOL_LOOP_BODY_2 = {
  ...TOOL_LOOP_BODY_1,
  messages: [
    ...TOOL_LOOP_TURN_1,
    toolResult('call_1', '{"name":"babelgate","version":"1.3.0"}', false),
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'read_file',
          input: { path: 'src/app.ts' },
        },
      ],
    },
    toolResult(
      'call_2',
      'import express from "express";\nexport const app = express();',
      true,
    ),
  ],
};

if (process.env.OPENROUTER_API_KEY) {
  describe('live observe: openrouter', () => {
    it('openrouter anthropic model reports cache reads', async () => {
      const restore = useYamlConfig(OPENROUTER_CACHE_YAML);
      try {
        const first = await request(app)
          .post('/v1/messages')
          .send(CACHE_BODY);
        expect(first.status, JSON.stringify(first.body)).toBe(200);

        const firstUsage = (
          first.body as {
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        ).usage;
        expect(
          (firstUsage?.input_tokens ?? 0) +
            (firstUsage?.cache_creation_input_tokens ?? 0) +
            (firstUsage?.cache_read_input_tokens ?? 0),
          JSON.stringify(firstUsage),
        ).toBeGreaterThanOrEqual(4096);

        const second = await request(app)
          .post('/v1/messages')
          .send(CACHE_BODY);
        expect(second.status, JSON.stringify(second.body)).toBe(200);

        const usage = (
          second.body as {
            usage?: { cache_read_input_tokens?: number };
          }
        ).usage;
        expect(usage?.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });

    it('openrouter anthropic model reports cache reads across a tool loop', async () => {
      const restore = useYamlConfig(OPENROUTER_CACHE_YAML);
      try {
        const first = await request(app)
          .post('/v1/messages')
          .send(TOOL_LOOP_BODY_1);
        expect(first.status, JSON.stringify(first.body)).toBe(200);

        const firstUsage = (
          first.body as {
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        ).usage;
        expect(
          (firstUsage?.input_tokens ?? 0) +
            (firstUsage?.cache_creation_input_tokens ?? 0) +
            (firstUsage?.cache_read_input_tokens ?? 0),
          JSON.stringify(firstUsage),
        ).toBeGreaterThanOrEqual(4096);

        const second = await request(app)
          .post('/v1/messages')
          .send(TOOL_LOOP_BODY_2);
        expect(second.status, JSON.stringify(second.body)).toBe(200);

        const usage = (
          second.body as {
            usage?: { cache_read_input_tokens?: number };
          }
        ).usage;
        expect(usage?.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });
  });
} else {
  console.log(
    'live suite: skipping the openrouter cache-read case — OPENROUTER_API_KEY not set',
  );
}

if (process.env.GEMINI_API_KEY) {
  describe('live observe: gemini', () => {
    // Conductor check from PR #58 (Task 1, decision 1a): the encoder
    // stamps the skip_thought_signature_validator placeholder on EVERY
    // outgoing functionCall part, while Gemini itself signs only the
    // first of a parallel batch. The request ends on the
    // functionResponse turn — Gemini 3 validates thoughtSignature only
    // on the current turn, so ending there keeps both
    // placeholder-signed calls inside the validated turn. A Gemini 3.x
    // upstream must still 200 — if it rejects the extra placeholders
    // this fails and needs an owner decision (first-part only, or real
    // signatures).
    it('parallel tool calls in history are accepted', async () => {
      useTarget('gemini', 'gemini');
      const model = liveModel('gemini');
      const res = await request(app)
        .post(`/v1beta/models/${model}:generateContent`)
        .send({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Compare the weather in Paris and London.' }],
            },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-paris',
                    name: 'get_weather',
                    args: { city: 'Paris' },
                  },
                },
                {
                  functionCall: {
                    id: 'call-london',
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
                    id: 'call-paris',
                    name: 'get_weather',
                    response: { weather: '18C, sunny' },
                  },
                },
                {
                  functionResponse: {
                    id: 'call-london',
                    name: 'get_weather',
                    response: { weather: '12C, rain' },
                  },
                },
              ],
            },
          ],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get the current weather for a city.',
                  parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                  },
                },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 128 },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      SOURCE_FORMAT_CHECKS.gemini(res.body);
    });
  });
} else {
  console.log(
    'live suite: skipping the gemini parallel-tool-call case — GEMINI_API_KEY not set',
  );
}
