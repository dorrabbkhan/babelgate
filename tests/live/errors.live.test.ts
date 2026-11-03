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
} from './live.helpers';

/**
 * Live error-path suite (spec §3.3, §3.2): an unknown model against a
 * real upstream must come back rendered in the *source* provider's
 * dialect — 404 for every target except OpenRouter, which answers an
 * unknown model with HTTP 400 — and a streaming request as a 200 stream
 * in that dialect. Shape assertions only — upstream error text isn't
 * asserted.
 */

const SOURCES: Provider[] = ['openai', 'anthropic', 'gemini', 'ollama'];
const UNKNOWN_MODEL = 'does-not-exist-babelgate';

// Shape assertions for a not_found error in each source dialect.
const NOT_FOUND_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const err = (b as { error?: { type?: string; code?: string } }).error;
    expect(err?.type).toBe('not_found_error');
    expect(err?.code).toBe('not_found');
  },
  anthropic: (b) => {
    const body = b as { type?: string; error?: { type?: string } };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('not_found_error');
  },
  gemini: (b) => {
    const err = (b as { error?: { code?: number; status?: string } }).error;
    expect(err?.code).toBe(404);
    expect(err?.status).toBe('NOT_FOUND');
  },
  ollama: (b) => {
    expect(typeof (b as { error?: unknown }).error).toBe('string');
  },
};

// Shape assertions for an invalid_request error in each source dialect.
// Only the openrouter target uses these: OpenRouter answers an unknown
// model with HTTP 400 "not a valid model ID", not 404
// (https://openrouter.ai/docs/api-reference/errors).
const INVALID_REQUEST_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const err = (b as { error?: { type?: string; code?: string } }).error;
    expect(err?.type).toBe('invalid_request_error');
    expect(err?.code).toBe('invalid_request');
  },
  anthropic: (b) => {
    const body = b as { type?: string; error?: { type?: string } };
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('invalid_request_error');
  },
  gemini: (b) => {
    const err = (b as { error?: { code?: number; status?: string } }).error;
    expect(err?.code).toBe(400);
    expect(err?.status).toBe('INVALID_ARGUMENT');
  },
  ollama: (b) => {
    expect(typeof (b as { error?: unknown }).error).toBe('string');
  },
};

/** supertest parses SSE/NDJSON as an opaque body — collect it as text. */
function postStream(path: string, body: object): request.Test {
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

/** Streaming wire format per source — SSE except Ollama's NDJSON. */
const STREAM_CONTENT_TYPE: Record<Provider, string> = {
  openai: 'text/event-stream',
  anthropic: 'text/event-stream',
  gemini: 'text/event-stream',
  ollama: 'application/x-ndjson',
};

// Terminal-event assertions per source dialect — the same checks as
// tests/integration/stream.test.ts.
const STREAM_CHECKS: Record<Provider, (body: string) => void> = {
  openai: (body) => {
    expect(body).toContain('data: {');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  },
  anthropic: (body) => {
    expect(body).toContain('event: message_start');
    expect(body.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(
      true,
    );
  },
  gemini: (body) => {
    const frames = body
      .split('\r\n\r\n')
      .filter((f) => f.trim() !== '')
      .map(
        (f) =>
          JSON.parse(f.replace(/^data: /, '')) as {
            candidates?: { finishReason?: string }[];
            error?: unknown;
          },
      );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.candidates?.[0]?.finishReason).toBe('STOP');
    expect(frames.at(-1)!.error).toBeUndefined();
  },
  ollama: (body) => {
    const lines = body.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) JSON.parse(line);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ done: true });
  },
};

beforeAll(requireOllama);

describe.each(liveTargets().map((target) => ({ target })))(
  'live target: $target',
  ({ target }) => {
    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target unknown model → 404 (openrouter: 400) in source dialect',
      async ({ source, target }) => {
        useTarget(source, target);

        const call = chatCall(source, UNKNOWN_MODEL);
        const res = await request(app).post(call.path).send(call.body);

        // OpenRouter answers an unknown model with HTTP 400, not 404
        // (https://openrouter.ai/docs/api-reference/errors).
        const expectedStatus = target === 'openrouter' ? 400 : 404;
        const checks =
          target === 'openrouter' ? INVALID_REQUEST_CHECKS : NOT_FOUND_CHECKS;
        expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
        checks[source](res.body);
      },
    );

    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target stream:true → 200 stream in source dialect',
      async ({ source, target }) => {
        useTarget(source, target);

        // Gemini signals streaming in the path, not the body. The
        // gemini target runs a thinking model: the default 16-token
        // budget is spent on reasoning, so the stream ends at
        // MAX_TOKENS with no text — give it 512 tokens in the source's
        // own dialect (owner's Gate 3 run; same carve-out as the
        // chat round trip in chat.live.test.ts).
        const extra: Record<string, unknown> =
          target === 'gemini' ? tokenBudget(source, 512) : {};
        const call =
          source === 'gemini'
            ? {
                method: 'POST' as const,
                path: `/v1beta/models/${liveModel(target)}:streamGenerateContent?alt=sse`,
                body: chatCall('gemini', liveModel(target), extra).body,
              }
            : chatCall(source, liveModel(target), {
                stream: true,
                ...extra,
              });
        const res = await postStream(call.path, call.body);
        const body = res.body as string;

        expect(res.status, body.slice(0, 400)).toBe(200);
        expect(res.headers['content-type']).toContain(
          STREAM_CONTENT_TYPE[source],
        );
        STREAM_CHECKS[source](body);
      },
    );
  },
);
