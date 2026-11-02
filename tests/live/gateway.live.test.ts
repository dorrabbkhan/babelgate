import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import {
  requireOllama,
  chatCall,
  useYamlConfig,
  liveModel,
  SOURCE_FORMAT_CHECKS,
  LIVE_OLLAMA_URL,
  LIVE_OLLAMA_MODEL,
  OPENROUTER_BASE_URL,
} from './live.helpers';

/**
 * Live gateway cases (spec §4.4): multi-provider YAML configs against
 * real upstreams. The dead-provider case needs only local Ollama; the
 * long-context OpenRouter case runs when OPENROUTER_API_KEY is set —
 * the suite's conditional-inclusion convention, no skip APIs.
 */

beforeAll(requireOllama);

/** Env var the throwaway "dead" provider's api_key_env names. */
const DEAD_KEY_ENV = 'BABELGATE_LIVE_DEAD_KEY';

// A model name that is no provider prefix and no alias: the `*` route
// always claims it.
const UNMATCHED_MODEL = 'unmatched-model';

const DEAD_THEN_OLLAMA_YAML = `default: ollama
providers:
  dead:
    type: openai
    base_url: http://127.0.0.1:9
    api_key_env: ${DEAD_KEY_ENV}
  ollama:
    type: ollama
    base_url: ${LIVE_OLLAMA_URL}
routes:
  - match: "*"
    to: dead/x
    fallback:
      - ollama/${LIVE_OLLAMA_MODEL}
`;

// The catch-all rule (not `default:`) answers short prompts, so the
// requested model never has to be a real Ollama model.
const LONG_CONTEXT_YAML = `default: ollama
providers:
  ollama:
    type: ollama
    base_url: ${LIVE_OLLAMA_URL}
  openrouter:
    type: openai
    base_url: ${OPENROUTER_BASE_URL}
    api_key_env: OPENROUTER_API_KEY
routes:
  - match: "*"
    when:
      min_input_tokens: 2000
    to: openrouter/${liveModel('openrouter')}
  - match: "*"
    to: ollama/${LIVE_OLLAMA_MODEL}
`;

describe('live gateway (yaml config)', () => {
  it('dead first provider falls back to ollama', async () => {
    process.env[DEAD_KEY_ENV] = 'babelgate-live-dead-key';
    const restore = useYamlConfig(DEAD_THEN_OLLAMA_YAML);
    try {
      const call = chatCall('openai', UNMATCHED_MODEL);
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.headers['x-babelgate-provider']).toBe('ollama');
      expect(res.headers['x-babelgate-model']).toBe(LIVE_OLLAMA_MODEL);
      expect(res.headers['x-babelgate-attempts']).toBe('2');
      SOURCE_FORMAT_CHECKS.openai(res.body);
    } finally {
      restore();
      delete process.env[DEAD_KEY_ENV];
    }
  });
});

if (process.env.OPENROUTER_API_KEY) {
  describe('live gateway: openrouter route', () => {
    it('long-context route goes to openrouter', async () => {
      const restore = useYamlConfig(LONG_CONTEXT_YAML);
      try {
        // ~9 000 chars → ≈2 250 estimated input tokens (chars/4),
        // over the route's min_input_tokens: 2000; max_tokens: 16
        // keeps the paid call cheap.
        const longCall = chatCall('openai', UNMATCHED_MODEL, {
          messages: [{ role: 'user', content: 'x'.repeat(9000) }],
        });
        const longRes = await request(app)
          .post(longCall.path)
          .send(longCall.body);
        expect(longRes.status, JSON.stringify(longRes.body)).toBe(200);
        expect(longRes.headers['x-babelgate-provider']).toBe('openrouter');

        const shortCall = chatCall('openai', UNMATCHED_MODEL);
        const shortRes = await request(app)
          .post(shortCall.path)
          .send(shortCall.body);
        expect(shortRes.status, JSON.stringify(shortRes.body)).toBe(200);
        expect(shortRes.headers['x-babelgate-provider']).toBe('ollama');
      } finally {
        restore();
      }
    });
  });
} else {
  console.log(
    'live suite: skipping the openrouter route case — OPENROUTER_API_KEY not set',
  );
}
