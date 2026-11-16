import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/yaml-config';
import type { Provider } from '../../src/transformers';
import defaultConfig from '../../vitest.config';
import liveConfig from '../../vitest.live.config';

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

  it('codex examples parse', () => {
    for (const [name, type] of CASES) {
      const config = loadYamlConfig(join(EXAMPLES, name), ENV);
      const entry = config.registry.get(config.routing.defaultProvider);
      expect(entry.type, `${name}: default provider type`).toBe(type);
    }
  });
});
