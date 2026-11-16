import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/yaml-config';
import { lookupPrice } from '../../src/cost/price-table';
import type { Provider } from '../../src/transformers';
import defaultConfig from '../../vitest.config';
import liveConfig from '../../vitest.live.config';

// The live step of the §3.6 lookup must not touch the network in npm
// test: getRawModelList answers an empty list, so a live_prices
// provider falls through to the bundled table exactly like an
// upstream whose model page carries no pricing.
vi.mock('../../src/services/models.service', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/models.service')>();
  return { ...original, getRawModelList: vi.fn(async () => ({ data: [] })) };
});

/**
 * Guards the suite layout: `npm test` must never pick up the live
 * suite (no network in npm test), and the live config must only
 * pick up tests/live/*.live.test.ts with a timeout generous enough
 * for real upstream calls.
 */
describe('test configuration', () => {
  it('npm test excludes the live suite', () => {
    expect(defaultConfig.test?.exclude).toContain('tests/live/**');
  });

  it('live config only includes live tests', () => {
    expect(liveConfig.test?.include).toEqual(['tests/live/**/*.live.test.ts']);
    expect(liveConfig.test?.testTimeout).toBeGreaterThanOrEqual(120000);
  });
});

/**
 * The Codex recipe's examples must keep loading through the real YAML
 * config loader — gates A, B and C (spec §4.5) run these files.
 * `src/config/examples.test.ts` covers the directory wholesale; this
 * pins each file by name and the provider type its recipe claims.
 */
describe('codex examples', () => {
  const EXAMPLES = join(__dirname, '..', '..', 'examples');
  const ENV: NodeJS.ProcessEnv = {
    OPENROUTER_API_KEY: 'test-key',
    GEMINI_API_KEY: 'test-key',
    ANTHROPIC_API_KEY: 'test-key',
  };
  const CASES: [string, Provider][] = [
    ['codex-gemini.yaml', 'gemini'],
    ['codex-anthropic.yaml', 'anthropic'],
    ['codex-openrouter.yaml', 'responses'],
  ];

  it('codex examples parse', async () => {
    for (const [name, type] of CASES) {
      const config = loadYamlConfig(join(EXAMPLES, name), ENV);
      const entry = config.registry.get(config.routing.defaultProvider);
      expect(entry.type, `${name}: default provider type`).toBe(type);

      const model = config.routing.rules.find((r) => r.match === '*')
        ?.to.model;
      expect(model, `${name}: a * route`).toBeDefined();

      // codex-openrouter.yaml prices qwen/qwen3-coder live off
      // OpenRouter's /models pricing block — with the live step
      // stubbed empty there is no offline price to assert.
      if (name === 'codex-openrouter.yaml') continue;

      const priced = await lookupPrice(entry, model!, config);
      expect(priced, `${name}: routed model priced`).toBeDefined();
      if (name === 'codex-anthropic.yaml') {
        expect(priced?.source, `${name}: price source`).toBe('override');
        expect(priced?.price, `${name}: override price`).toEqual({
          input: 1,
          output: 5,
          cacheRead: 0.1,
          cacheWrite: 1.25,
        });
      } else {
        expect(priced?.source, `${name}: price source`).toBe('bundled');
      }
    }
  });
});
