import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { app } from '../../src/app';
import {
  PROVIDER_PRESETS,
  type PresetName,
  type ProviderPreset,
} from '../../src/config/provider-presets';
import type { BreakerSnapshot } from '../../src/routing/circuit-breaker';
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

/**
 * Forced-429 breaker case (v1.6 Task 17, spec §3.5/§4): a local stub
 * on 127.0.0.1 answers 429 to every request — the rate limit is
 * forced deterministically, never borrowed from a real provider.
 * `circuit_breaker.failures: 1` opens `limited` after its first
 * eligible failure; the next request must skip it (skipped_open) and
 * be served by the ollama fallback.
 */
const FORCED_429_YAML = (stubPort: number) => `default: ollama
providers:
  limited:
    type: openai
    base_url: http://127.0.0.1:${stubPort}
    api_key_env: ${DEAD_KEY_ENV}
    circuit_breaker:
      failures: 1
      cooldown_ms: 60000
  ollama:
    type: ollama
    base_url: ${LIVE_OLLAMA_URL}
routes:
  - match: "*"
    to: limited/x
    fallback:
      - ollama/${LIVE_OLLAMA_MODEL}
`;

describe('live gateway: breaker opens on a forced 429 route', () => {
  let stub: Server | undefined;
  let stubHits = 0;

  beforeAll(async () => {
    stub = createServer((_req, res) => {
      stubHits += 1;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"forced 429 (test stub)"}}');
    });
    await new Promise<void>((resolve, reject) => {
      stub!.once('error', reject);
      stub!.listen(0, '127.0.0.1', () => resolve());
    });
  });
  afterAll(() => stub?.close());

  it('opens the 429 target; the fallback serves the next request', async () => {
    process.env[DEAD_KEY_ENV] = 'babelgate-live-dead-key';
    const stubPort = (stub!.address() as { port: number }).port;
    const restore = useYamlConfig(FORCED_429_YAML(stubPort));
    try {
      const call = chatCall('openai', UNMATCHED_MODEL);
      const first = await request(app).post(call.path).send(call.body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.headers['x-babelgate-provider']).toBe('ollama');
      expect(first.headers['x-babelgate-attempts']).toBe('2');
      const hitsAfterFirst = stubHits;
      expect(hitsAfterFirst).toBeGreaterThan(0);

      // The exact breaker state: `limited` open for the cool-down,
      // `ollama` closed after serving the fallback.
      const routing = await request(app)
        .get('/ui/api/routing')
        .set('x-babelgate-ui', '1')
        // Harmless when PROXY_API_KEY is unset; required when the
        // live environment has one (uiAccess rule 4).
        .set('x-api-key', process.env.PROXY_API_KEY ?? 'unused');
      expect(routing.status, JSON.stringify(routing.body)).toBe(200);
      const breakers = (routing.body.breakers ?? []) as BreakerSnapshot[];
      const limited = breakers.find((b) => b.provider === 'limited');
      expect(limited?.state).toBe('open');
      expect(limited?.consecutiveFailures).toBe(1);
      expect(
        breakers.find((b) => b.provider === 'ollama')?.state,
      ).toBe('closed');

      const second = await request(app).post(call.path).send(call.body);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      // `limited` was skipped_open — one attempt, answered by the
      // fallback provider, and the stub saw no new request.
      expect(second.headers['x-babelgate-provider']).toBe('ollama');
      expect(second.headers['x-babelgate-attempts']).toBe('1');
      expect(stubHits).toBe(hitsAfterFirst);
    } finally {
      restore();
      delete process.env[DEAD_KEY_ENV];
    }
  });
});

/**
 * Free/cheap preset cases (v1.6 Task 17, spec §4 live line): each
 * preset's own `suggested` model — never a hard-coded copy — answers
 * through the client dialect it was proven for on the Task 8 edit
 * task. A preset's describe registers only when its api_key_env is
 * set (the suite's conditional-inclusion convention); presets with
 * no `suggested` (their candidates failed the edit task) get none.
 */
const SUGGESTED_SOURCE = {
  'claude-code': 'anthropic',
  codex: 'responses',
  'openai-apps': 'openai',
} as const;

type SuggestedClient = keyof typeof SUGGESTED_SOURCE;

const PRESET_LIVE_CASES: [PresetName, ProviderPreset][] = (
  Object.entries(PROVIDER_PRESETS) as [PresetName, ProviderPreset][]
).filter(
  ([, preset]) =>
    preset.tier !== 'shim' &&
    preset.api_key_env !== undefined &&
    preset.suggested !== undefined,
);

/** One request in the client dialect a `suggested` entry names. */
function presetCall(
  client: SuggestedClient,
  model: string,
): { path: string; body: object } {
  const source = SUGGESTED_SOURCE[client];
  if (source === 'responses') {
    // Codex's dialect, minimal (recorded shape: tests/fixtures/codex/
    // recording.jsonl carries store:false); max_output_tokens caps
    // the call — an uncapped request reads as 65 536 tokens to a
    // credit-checking upstream.
    return {
      path: '/v1/responses',
      body: {
        model,
        store: false,
        max_output_tokens: 64,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with one word.' }],
          },
        ],
      },
    };
  }
  const call = chatCall(source, model);
  return { path: call.path, body: call.body };
}

/** Shape check in the asking client's dialect. */
function presetFormatCheck(
  client: SuggestedClient,
  body: unknown,
): void {
  const source = SUGGESTED_SOURCE[client];
  if (source === 'responses') {
    expect((body as { object?: string }).object).toBe('response');
    return;
  }
  SOURCE_FORMAT_CHECKS[source](body);
}

for (const [name, preset] of PRESET_LIVE_CASES) {
  const keyEnv = preset.api_key_env!;
  // `preset:` fills type/base_url/api_key_env/gaps and lands the
  // preset name on the entry (the free-tier hint and UI label read
  // it); `default:` routes every model name unchanged.
  const yaml = `default: ${name}
providers:
  ${name}:
    preset: ${name}
`;
  const suggested = Object.entries(preset.suggested ?? {}).filter(
    (e): e is [SuggestedClient, string] => e[0] in SUGGESTED_SOURCE,
  );
  if (process.env[keyEnv]) {
    describe(`live preset: ${name} (tier ${preset.tier})`, () => {
      for (const [client, model] of suggested) {
        it(`${client} suggested model answers`, async () => {
          const restore = useYamlConfig(yaml);
          try {
            const call = presetCall(client, model);
            const res = await request(app)
              .post(call.path)
              .send(call.body);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.headers['x-babelgate-provider']).toBe(name);
            presetFormatCheck(client, res.body);
          } finally {
            restore();
          }
        });
      }
    });
  } else {
    console.log(
      `live suite: skipping the ${name} preset cases — ${keyEnv} not set`,
    );
  }
}
