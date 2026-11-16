import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import {
  useTarget,
  useOpenRouterAnthropic,
  useOpenRouterResponses,
  liveModel,
  outputText,
  OPENROUTER_ANTHROPIC_MODEL,
  USAGE_CHECKS,
} from './live.helpers';

/**
 * Codex-flavoured live cases (v1.4 spec §4.4): the Responses source
 * against the three gate targets — the Gemini bridge, the Anthropic
 * bridge (direct key, or OpenRouter's Anthropic endpoint per E18) and
 * OpenRouter's native Responses API (pass-through). Requests are
 * shaped the way codex-cli 0.169.0 sends them (spec E12–E19):
 * `store: false`, `parallel_tool_calls`, `tool_choice`, and
 * `include: ["reasoning.encrypted_content"]`. Each describe registers
 * only when its key is set — the suite's conditional-inclusion
 * convention, no skip APIs.
 */

interface OutputItem {
  type?: string;
  call_id?: string;
  [key: string]: unknown;
}

const userMsg = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

const WEATHER_TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  strict: true,
};

const TOOL_OUTPUT = '{"temp_c": 18, "condition": "sunny"}';

/**
 * One Codex-shaped POST /v1/responses body — the fields real Codex
 * sends on every request (tests/fixtures/codex/recording.jsonl).
 */
function codexBody(
  model: string,
  input: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model,
    input,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    ...extra,
  };
}

/**
 * A tool output for every `function_call` in `items`, like a Codex
 * client answering the model's calls.
 */
function toolOutputs(items: OutputItem[]): OutputItem[] {
  return items
    .filter((i) => i.type === 'function_call')
    .map((c) => ({
      type: 'function_call_output',
      call_id: c.call_id,
      output: TOOL_OUTPUT,
    }));
}

/**
 * The spec §4.4 case set, run inside each target's describe:
 * `configure` points the app at the target and returns the upstream
 * model name; it runs before each case because the in-process config
 * is per-request state.
 */
function codexCases(configure: () => string) {
  it('plain', async () => {
    const model = configure();
    const res = await request(app)
      .post('/v1/responses')
      .send(codexBody(model, [userMsg('Reply with one word.')]));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.object).toBe('response');
    expect(outputText(res.body)).toBeTruthy();
    USAGE_CHECKS.responses(res.body);
  });

  it('stream', async () => {
    const model = configure();
    const res = await request(app)
      .post('/v1/responses')
      .send(codexBody(model, [userMsg('Reply with one word.')], {
        stream: true,
      }));

    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // OpenRouter's Responses SSE carries no `event:` lines (E19) and
    // pass-through relays them verbatim, so the event type is read
    // from each `data:` JSON — valid on all three targets.
    const types = res.text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((data) => data !== '[DONE]')
      .map((data) => (JSON.parse(data) as { type?: string }).type);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types[types.length - 1]).toBe('response.completed');
  });

  it('tools', async () => {
    const model = configure();
    const first = await request(app)
      .post('/v1/responses')
      .send(
        codexBody(model, [userMsg('What is the weather in Paris?')], {
          tools: [WEATHER_TOOL],
          tool_choice: 'required',
        }),
      );

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const items = (first.body.output ?? []) as OutputItem[];
    const calls = items.filter((i) => i.type === 'function_call');
    expect(calls.length, 'no function_call in output').toBeGreaterThan(0);
    expect(calls[0]!.name).toBe('get_weather');

    const second = await request(app)
      .post('/v1/responses')
      .send(
        codexBody(
          model,
          [userMsg('What is the weather in Paris?'), ...items, ...toolOutputs(items)],
          {
            tools: [WEATHER_TOOL],
            tool_choice: 'auto',
          },
        ),
      );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(outputText(second.body)).toBeTruthy();
  });

  it('three-turn tool loop with reasoning', async () => {
    const model = configure();
    // `tool_choice: "required"` keeps every turn ending in a call so
    // three Codex-style turns always happen; reasoning.effort + the
    // encrypted-content include engage the §3.3 reasoning path, and
    // each turn echoes the previous turn's output items — reasoning
    // envelopes included — the way a stateless Codex resends them.
    let input: unknown[] = [userMsg('What is the weather in Paris?')];
    for (let turn = 1; turn <= 3; turn += 1) {
      const res = await request(app)
        .post('/v1/responses')
        .send(
          codexBody(model, input, {
            tools: [WEATHER_TOOL],
            tool_choice: 'required',
            reasoning: { effort: 'medium', summary: 'auto' },
          }),
        );
      expect(res.status, `turn ${turn}: ${JSON.stringify(res.body)}`).toBe(
        200,
      );
      const items = (res.body.output ?? []) as OutputItem[];
      expect(
        items.filter((i) => i.type === 'function_call').length,
        `turn ${turn}: no function_call in output`,
      ).toBeGreaterThan(0);
      input = [...input, ...items, ...toolOutputs(items)];
    }
  });

  it('structured output parses and matches', async () => {
    const model = configure();
    const res = await request(app)
      .post('/v1/responses')
      .send(
        codexBody(
          model,
          [
            userMsg(
              'Reply with a JSON object: city must be "Paris", temp_c must be 18.',
            ),
          ],
          {
            // `text.format` per the Responses create reference.
            text: {
              format: {
                type: 'json_schema',
                name: 'weather',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    city: { type: 'string' },
                    temp_c: { type: 'number' },
                  },
                  required: ['city', 'temp_c'],
                  additionalProperties: false,
                },
              },
            },
          },
        ),
      );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = JSON.parse(outputText(res.body)) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ city: 'Paris', temp_c: 18 });
  });
}

// All three target describes are key-gated, so the file must register
// at least one test even with no keys (a file or suite with no tests
// is a vitest collect error). This first case needs no upstream: it
// pins the recorded Codex request shape every keyed case builds on.
describe('live codex', () => {
  it('request bodies keep the recorded Codex shape', () => {
    const body = codexBody('babelgate', [userMsg('hi')]);
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
  });

  if (process.env.GEMINI_API_KEY) {
    describe('gemini bridge', () => {
      codexCases(() => {
        useTarget('responses', 'gemini');
        return liveModel('gemini');
      });
    });
  } else {
    console.log(
      'live suite: skipping the codex → gemini bridge cases — GEMINI_API_KEY not set',
    );
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY) {
    describe('anthropic bridge', () => {
      codexCases(() => {
        // Direct Anthropic key when present; OpenRouter's Anthropic
        // endpoint otherwise (E18 proved it returns signed thinking
        // blocks for anthropic/claude-haiku-4.5).
        if (process.env.ANTHROPIC_API_KEY) {
          useTarget('responses', 'anthropic');
          return liveModel('anthropic');
        }
        useOpenRouterAnthropic();
        return OPENROUTER_ANTHROPIC_MODEL;
      });
    });
  } else {
    console.log(
      'live suite: skipping the codex → anthropic bridge cases — neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY set',
    );
  }

  if (process.env.OPENROUTER_API_KEY) {
    describe('openrouter pass-through', () => {
      codexCases(() => {
        useOpenRouterResponses();
        return liveModel('openrouter');
      });
    });
  } else {
    console.log(
      'live suite: skipping the codex → openrouter pass-through cases — OPENROUTER_API_KEY not set',
    );
  }
});
