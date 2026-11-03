import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { PROVIDER_ROUTES, type Provider } from '../../src/transformers';
import {
  requireOllama,
  liveTargets,
  liveModel,
  chatCall,
  tokenBudget,
  useTarget,
  SOURCE_FORMAT_CHECKS,
  MODEL_LIST_CHECKS,
  ASSISTANT_TEXT,
  USAGE_CHECKS,
  MODEL_IDS,
  LIVE_OLLAMA_MODEL,
} from './live.helpers';

/**
 * Live smoke suite: every client-facing source format through every
 * available upstream target. Shape assertions only — generated text is
 * never asserted (LLM output isn't deterministic).
 */

const SOURCES: Provider[] = ['openai', 'anthropic', 'gemini', 'ollama'];

beforeAll(requireOllama);

describe.each(liveTargets().map((target) => ({ target })))(
  'live target: $target',
  ({ target }) => {
    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target chat round trip',
      async ({ source, target }) => {
        useTarget(source, target);

        // The ≤16 cap exists to keep paid calls cheap; a thinking
        // model needs room to finish reasoning before it emits
        // content, so thinking-model targets get a 512 budget in the
        // source's own dialect: the local ollama target (free), and
        // the gemini target — gemini-3.8-flash spends a 16-token
        // budget on thinking and returns no text (owner's Gate 3 run:
        // finishReason MAX_TOKENS, thoughtsTokenCount 11,
        // candidatesTokenCount 1). The ollama source sends
        // stream:false — Ollama's /api/chat streams NDJSON when `stream`
        // is omitted (api.md, default true), and this case parses a
        // single-object reply.
        const call = chatCall(
          source,
          liveModel(target),
          {
            ...(source === 'ollama' ? { stream: false } : {}),
            ...(target === 'ollama' &&
            (source === 'openai' || source === 'anthropic')
              ? { max_tokens: 512 }
              : {}),
            ...(target === 'gemini' ? tokenBudget(source, 512) : {}),
          },
        );
        const res = await request(app).post(call.path).send(call.body);

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        SOURCE_FORMAT_CHECKS[source](res.body);
        expect(ASSISTANT_TEXT[source](res.body)).toBeTruthy();
        USAGE_CHECKS[source](res.body);
      },
    );

    it.each(SOURCES.map((source) => ({ source, target })))(
      '$source → $target model list',
      async ({ source, target }) => {
        useTarget(source, target);

        const modelsRoute = PROVIDER_ROUTES[source].find(
          (r) => r.kind === 'models',
        )!;
        const req = request(app).get(modelsRoute.pathPrefix);
        if (source === 'anthropic') {
          // Anthropic shares `GET /v1/models` with OpenAI: since
          // detect-source.ts (v1.2 Task 2, spec §3.2) only routes it
          // to the anthropic adapter when the request carries
          // `anthropic-version` or `x-api-key`, a bare GET is answered
          // in OpenAI format. Real Anthropic clients always send one
          // of those headers (the SDK sends `anthropic-version`), so
          // this case does too.
          req.set('anthropic-version', '2023-06-01');
        }
        const res = await req;

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        MODEL_LIST_CHECKS[source](res.body);
        if (target === 'ollama') {
          expect(MODEL_IDS[source](res.body)).toContain(LIVE_OLLAMA_MODEL);
        }
      },
    );
  },
);
