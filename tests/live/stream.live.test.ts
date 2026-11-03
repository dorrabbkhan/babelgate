import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import type { Provider } from '../../src/transformers';
import {
  requireOllama,
  liveTargets,
  liveModel,
  chatCall,
  tokenBudget,
  useTarget,
  type LiveTarget,
} from './live.helpers';

/**
 * Live streaming and tools suite (spec §4.6): all four sources
 * (openai, anthropic, gemini, ollama) through the always-on local
 * Ollama target and, when OPENROUTER_API_KEY is set, OpenRouter as an
 * OpenAI-shaped target. Shape assertions only — generated text is
 * never compared, and the forced-tool-call case only requires a
 * well-formed call with parseable arguments.
 */

type StreamSource = Provider;
const SOURCES: StreamSource[] = ['openai', 'anthropic', 'gemini', 'ollama'];
const TARGETS: LiveTarget[] = liveTargets().filter(
  (t) => t === 'ollama' || t === 'openrouter',
);

// One weather tool per source dialect; no tool result is sent back, so
// a well-formed reply is either text or a tool call.
const TOOL_EXTRA: Record<StreamSource, Record<string, unknown>> = {
  openai: {
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  },
  anthropic: {
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
  },
  // Gemini tools are `tools: [{functionDeclarations: [...]}]`
  // (ai.google.dev/api/generate-content).
  gemini: {
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
  },
  // Ollama tools are OpenAI-shaped `tools: [{type:"function",...}]`
  // (github.com/ollama/ollama/blob/main/docs/api.md).
  ollama: {
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  },
};

// OpenAI `tool_choice: "required"` (platform.openai.com/docs/api-reference/chat)
// ↔ canonical "required" ↔ Anthropic `tool_choice: {"type":"any"}`
// (docs.claude.com/en/api/messages) ↔ Gemini
// `toolConfig: {functionCallingConfig: {mode: "ANY"}}`
// (ai.google.dev/api/generate-content). Ollama's chat API has no
// tool-choice field (github.com/ollama/ollama/blob/main/docs/api.md):
// a "forced" call can't be expressed on that wire format, so the
// ollama source gets no forced-tool-call case (its tool case only
// asserts the definitions are accepted with a well-formed reply).
const FORCED_TOOL_EXTRA: Partial<
  Record<StreamSource, Record<string, unknown>>
> = {
  openai: { tool_choice: 'required' },
  anthropic: { tool_choice: { type: 'any' } },
  gemini: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
};
const FORCED_SOURCES = SOURCES.filter(
  (s) => FORCED_TOOL_EXTRA[s] !== undefined,
);

interface SseEvent {
  event?: string;
  data: string;
}

/** Parse an SSE body into {event, data} records. */
function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return events;
}

/**
 * Parse the wire stream for a source into data records: openai,
 * anthropic and gemini stream SSE `data:` frames (Gemini carries no
 * `event:` field and no `[DONE]` terminator); the ollama source
 * streams NDJSON — one complete JSON object per line, the last with
 * `done: true` (github.com/ollama/ollama/blob/main/docs/api.md) —
 * wrapped here as data-only events so one assertions path covers all
 * four sources.
 */
function parseWireEvents(source: StreamSource, text: string): SseEvent[] {
  if (source === 'ollama') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ data: line }));
  }
  return parseSse(text);
}

function jsonData(e: SseEvent): Record<string, unknown> | undefined {
  try {
    return JSON.parse(e.data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * supertest only fills `res.text` for text/* content types. Ollama
 * streams `application/x-ndjson`, so its body must be collected as
 * raw text with a custom parser.
 */
function postRaw(path: string, body: unknown): request.Test {
  return request(app)
    .post(path)
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => cb(null, text));
    });
}

/** Replace the request's prompt in the source's own dialect. */
function askForWeather(
  source: StreamSource,
  body: Record<string, unknown>,
): void {
  const prompt = 'What is the weather in Lisbon?';
  if (source === 'gemini') {
    body.contents = [{ role: 'user', parts: [{ text: prompt }] }];
    return;
  }
  (body as { messages: { role: string; content: string }[] }).messages = [
    { role: 'user', content: prompt },
  ];
}

/** Count of stream events that carry a non-empty text delta to the client. */
function textDeltaCount(source: StreamSource, events: SseEvent[]): number {
  return events.filter((e) => {
    const d = jsonData(e);
    if (source === 'openai') {
      const delta = (d?.choices as { delta?: { content?: string } }[] | undefined)?.[0]
        ?.delta;
      return typeof delta?.content === 'string' && delta.content.length > 0;
    }
    if (source === 'anthropic') {
      return (
        e.event === 'content_block_delta' &&
        (d?.delta as { type?: string; text?: string } | undefined)?.type ===
          'text_delta' &&
        ((d?.delta as { text?: string }).text?.length ?? 0) > 0
      );
    }
    if (source === 'gemini') {
      // Each data: frame is a GenerateContentResponse; text arrives in
      // candidates[0].content.parts[].text
      // (ai.google.dev/api/generate-content).
      const parts =
        (
          d?.candidates as
            | { content?: { parts?: { text?: string }[] } }[]
            | undefined
        )?.[0]?.content?.parts ?? [];
      return parts.some(
        (p) => typeof p.text === 'string' && p.text.length > 0,
      );
    }
    // Ollama NDJSON: done:false lines carry message.content.
    const message = d?.message as { content?: string } | undefined;
    return typeof message?.content === 'string' && message.content.length > 0;
  }).length;
}

function expectUsage(source: StreamSource, events: SseEvent[]): void {
  if (source === 'openai') {
    const usageChunk = events.find((e) => {
      const d = jsonData(e);
      return d !== undefined && d.usage !== undefined;
    });
    expect(
      usageChunk,
      'no usage chunk in stream',
    ).toBeDefined();
    const usage = jsonData(usageChunk!)!.usage as {
      total_tokens?: number;
    };
    expect(usage.total_tokens).toBeGreaterThan(0);
    return;
  }
  if (source === 'gemini') {
    // usageMetadata is cumulative on every frame; the last one carries
    // the totals (ai.google.dev/api/generate-content).
    const usageFrame = [...events]
      .map(jsonData)
      .reverse()
      .find((d) => d?.usageMetadata !== undefined);
    expect(usageFrame, 'no usageMetadata frame in stream').toBeDefined();
    const usage = usageFrame!.usageMetadata as {
      totalTokenCount?: number;
    };
    expect(usage.totalTokenCount).toBeGreaterThan(0);
    return;
  }
  if (source === 'ollama') {
    // The done:true line carries the counts
    // (github.com/ollama/ollama/blob/main/docs/api.md).
    const done = events.map(jsonData).find((d) => d?.done === true);
    expect(done, 'no done:true line in stream').toBeDefined();
    const counts = done as {
      prompt_eval_count?: number;
      eval_count?: number;
    };
    expect(counts.prompt_eval_count).toBeGreaterThan(0);
    expect(counts.eval_count).toBeGreaterThan(0);
    return;
  }
  // Anthropic: real output tokens arrive in message_delta; input tokens
  // on message_start are the local estimate (spec §3.5).
  const delta = events.find((e) => e.event === 'message_delta');
  expect(delta, 'no message_delta in stream').toBeDefined();
  const usage = (jsonData(delta!)?.usage ?? {}) as {
    output_tokens?: number;
  };
  expect(usage.output_tokens).toBeGreaterThan(0);
}

function expectWellFormedReply(source: StreamSource, body: unknown): void {
  if (source === 'openai') {
    const message = (body as { choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[] })
      .choices?.[0]?.message;
    expect(message).toBeDefined();
    expect(
      typeof message!.content === 'string' && message!.content.length > 0
        ? true
        : Array.isArray(message!.tool_calls) && message!.tool_calls.length > 0,
    ).toBe(true);
    return;
  }
  if (source === 'gemini') {
    const candidates = (
      body as { candidates?: { content?: { parts?: Record<string, unknown>[] } }[] }
    ).candidates;
    expect(Array.isArray(candidates)).toBe(true);
    const parts = candidates?.[0]?.content?.parts ?? [];
    expect(
      parts.some(
        (p) =>
          (typeof p.text === 'string' && p.text.length > 0) ||
          p.functionCall !== undefined,
      ),
    ).toBe(true);
    return;
  }
  if (source === 'ollama') {
    const message = (
      body as { message?: { content?: string; tool_calls?: unknown[] } }
    ).message;
    expect(message).toBeDefined();
    expect(
      (typeof message!.content === 'string' &&
        message!.content.length > 0) ||
        (Array.isArray(message!.tool_calls) &&
          message!.tool_calls.length > 0),
    ).toBe(true);
    return;
  }
  const content = (body as { content?: { type?: string }[] }).content;
  expect(Array.isArray(content)).toBe(true);
  expect(
    content!.some((b) => b.type === 'text' || b.type === 'tool_use'),
  ).toBe(true);
}

function expectForcedToolCall(source: StreamSource, body: unknown): void {
  if (source === 'openai') {
    const toolCalls = (
      body as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] }
    ).choices?.[0]?.message?.tool_calls;
    expect(Array.isArray(toolCalls) && toolCalls.length > 0).toBe(true);
    for (const call of toolCalls!) {
      expect(() => JSON.parse(call.function!.arguments ?? '')).not.toThrow();
    }
    return;
  }
  if (source === 'gemini') {
    // A forced call arrives as a functionCall part with `name` and an
    // `args` object (ai.google.dev/api/generate-content).
    const parts =
      (
        body as {
          candidates?: {
            content?: {
              parts?: { functionCall?: { name?: string; args?: unknown } }[];
            };
          }[];
        }
      ).candidates?.[0]?.content?.parts ?? [];
    const calls = parts
      .map((p) => p.functionCall)
      .filter((c) => c !== undefined);
    expect(calls.length, 'no functionCall part in reply').toBeGreaterThan(
      0,
    );
    for (const call of calls) {
      expect(typeof call.name === 'string' && call.name.length > 0).toBe(
        true,
      );
      expect(typeof call.args === 'object' && call.args !== null).toBe(
        true,
      );
    }
    return;
  }
  if (source === 'ollama') {
    // Unreachable: FORCED_SOURCES filters ollama out — its wire format
    // has no tool-choice field to force a call with.
    throw new Error(`no forced-tool-call case for source ${source}`);
  }
  const content = (body as { content?: { type?: string; input?: unknown }[] })
    .content;
  const toolUse = content?.find((b) => b.type === 'tool_use');
  expect(toolUse, 'no tool_use block in reply').toBeDefined();
  expect(typeof toolUse!.input === 'object' && toolUse!.input !== null).toBe(
    true,
  );
}

beforeAll(requireOllama);

describe.each(TARGETS.map((target) => ({ target })))(
  'live stream target: $target',
  ({ target }) => {
    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target streams text',
      async ({ source, target }) => {
        useTarget(source, target);

        // Gemini selects streaming by path suffix
        // (`:streamGenerateContent`), not a body flag; `alt=sse` picks
        // the SSE wire form over the streamed JSON array (spec §3.3,
        // ai.google.dev/api/generate-content). Ollama's /api/chat
        // streams NDJSON when `stream` is omitted (api.md: "stream ...
        // if false the response will be returned as a single response
        // object"; default true), so the ollama source sends no flag
        // and exercises the documented default.
        const extra: Record<string, unknown> =
          source === 'gemini' || source === 'ollama' ? {} : { stream: true };
        if (source === 'openai') {
          // The OpenAI encoder only emits a usage chunk when the client
          // asked for it (stream_options.include_usage).
          extra.stream_options = { include_usage: true };
        }
        if (target === 'ollama' || target === 'openrouter') {
          // Same budget as chat.live.test.ts — these targets may need
          // room to finish before the token cap.
          Object.assign(extra, tokenBudget(source, 512));
        }
        const call = chatCall(source, liveModel(target), extra);
        const path =
          source === 'gemini'
            ? `/v1beta/models/${liveModel(target)}:streamGenerateContent?alt=sse`
            : call.path;

        const res =
          source === 'ollama'
            ? await postRaw(path, call.body)
            : await request(app).post(path).send(call.body);
        const wire = source === 'ollama' ? (res.body as string) : res.text;

        expect(res.status, wire).toBe(200);
        const events = parseWireEvents(source, wire);
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(textDeltaCount(source, events)).toBeGreaterThanOrEqual(1);
        if (source === 'openai') {
          expect(events[events.length - 1]!.data).toBe('[DONE]');
        } else if (source === 'anthropic') {
          expect(events[events.length - 1]!.event).toBe('message_stop');
        } else if (source === 'ollama') {
          expect(jsonData(events[events.length - 1]!)?.done).toBe(true);
        } else {
          // Gemini streams have no terminator; the final data: frame
          // carries the finishReason (and usageMetadata).
          const last = jsonData(events[events.length - 1]!);
          const finishReason = (
            last?.candidates as { finishReason?: string }[] | undefined
          )?.[0]?.finishReason;
          expect(
            finishReason,
            'no finishReason on the last SSE frame',
          ).toBeDefined();
        }
        expectUsage(source, events);
      },
    );

    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target accepts tool definitions',
      async ({ source, target }) => {
        useTarget(source, target);

        const extra: Record<string, unknown> = {
          ...TOOL_EXTRA[source],
          // Ollama's /api/chat streams by default (api.md) — the
          // well-formed single-object reply this case parses needs
          // the explicit opt-out.
          ...(source === 'ollama' ? { stream: false } : {}),
          // Room for a full tool-call JSON payload.
          ...tokenBudget(source, target === 'ollama' ? 512 : 256),
        };
        const call = chatCall(source, liveModel(target), extra);
        // Ask for the weather so a tool-capable model may call the tool.
        askForWeather(source, call.body as Record<string, unknown>);

        const res = await request(app).post(call.path).send(call.body);

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expectWellFormedReply(source, res.body);
      },
    );

    if (target === 'openrouter') {
      it.each(FORCED_SOURCES.map((source) => ({ source, target })))(
        '$source → $target forced tool call',
        async ({ source, target }) => {
          useTarget(source, target);

          const extra: Record<string, unknown> = {
            ...TOOL_EXTRA[source],
            ...FORCED_TOOL_EXTRA[source],
            ...tokenBudget(source, 512),
          };
          const call = chatCall(source, liveModel(target), extra);
          const body = call.body as Record<string, unknown>;
          askForWeather(source, body);

          const res = await request(app).post(call.path).send(body);

          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expectForcedToolCall(source, res.body);
        },
      );
    }
  },
);
