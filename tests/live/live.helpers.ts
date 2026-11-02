import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { resetConfig } from '../../src/config/env-config';
import type { Provider } from '../../src/transformers';

/**
 * Shared helpers for the opt-in live suite (npm run test:live).
 * These tests run the real app in-process against real upstreams —
 * never in `npm test`.
 */

/** Base URL of the real Ollama instance under test. */
export const LIVE_OLLAMA_URL =
  process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434';

/** Model exercised against live Ollama (D5: small, CPU-friendly). */
export const LIVE_OLLAMA_MODEL = process.env.LIVE_OLLAMA_MODEL || 'qwen2.5:0.5b';

/**
 * A live upstream the suite can target. `"openrouter"` isn't a Provider:
 * it's reached through the OpenAI adapter with a different base URL and
 * key, so the type stays local to tests/live/.
 */
export type LiveTarget = Provider | 'openrouter';

/**
 * OpenRouter base URL — `https://openrouter.ai/api`, NOT `.../api/v1`:
 * upstream URLs are built by plain concatenation
 * `${targetBaseUrl}${requestPath}` and the OpenAI request path already
 * carries `/v1` (docs: https://openrouter.ai/docs/api-reference/overview).
 */
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api';

/** Default OpenRouter model; override with LIVE_OPENROUTER_MODEL. */
const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3-coder';

const ALL_PROVIDERS: Provider[] = [
  'openai',
  'gemini',
  'ollama',
  'anthropic',
];

const API_KEY_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Public base URL per live target; Ollama comes from the env. */
const LIVE_BASE_URLS: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: LIVE_OLLAMA_URL,
  anthropic: 'https://api.anthropic.com',
};

/** Cheap default model per live target; override with LIVE_<TARGET>_MODEL. */
const DEFAULT_LIVE_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-3.8-flash',
  ollama: LIVE_OLLAMA_MODEL,
  anthropic: 'claude-haiku-5-5',
};

/**
 * Fail loudly when the always-on target is missing — the suite never
 * silently passes without a real upstream.
 */
export async function requireOllama(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${LIVE_OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error(
      `Ollama not reachable at ${LIVE_OLLAMA_URL}: start it or set OLLAMA_API_BASE_URL`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Ollama not reachable at ${LIVE_OLLAMA_URL}: start it or set OLLAMA_API_BASE_URL`,
    );
  }
}

let loggedSkipped = false;

/**
 * Targets with credentials to hit: "ollama" always; the paid providers
 * only when their *_API_KEY is set; "openrouter" when OPENROUTER_API_KEY
 * is set. Skipped targets are logged once.
 */
export function liveTargets(): LiveTarget[] {
  const providers = ALL_PROVIDERS.filter(
    (p) => p === 'ollama' || Boolean(process.env[API_KEY_ENV[p]]),
  );
  const targets: LiveTarget[] = process.env.OPENROUTER_API_KEY
    ? [...providers, 'openrouter']
    : providers;
  const skipped: LiveTarget[] = ALL_PROVIDERS.filter(
    (p) => !providers.includes(p),
  );
  if (!process.env.OPENROUTER_API_KEY) skipped.push('openrouter');
  if (skipped.length > 0 && !loggedSkipped) {
    loggedSkipped = true;
    console.log(
      `live suite: skipping targets without ${skipped
        .map((p) => (p === 'openrouter' ? 'OPENROUTER_API_KEY' : API_KEY_ENV[p]))
        .join('/')} set: ${skipped.join(', ')}`,
    );
  }
  return targets;
}

/** Model to request for a live target (LIVE_<TARGET>_MODEL override). */
export function liveModel(target: LiveTarget): string {
  if (target === 'openrouter') {
    return process.env.LIVE_OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  }
  return (
    process.env[`LIVE_${target.toUpperCase()}_MODEL`] ||
    DEFAULT_LIVE_MODELS[target]
  );
}

/**
 * A minimal one-message chat request in the source's wire format.
 * Gemini carries the model in the path. Dialects cap output at
 * 16 tokens (`max_tokens`, `generationConfig.maxOutputTokens`,
 * `options.num_predict`) so paid calls stay cheap — OpenRouter treats
 * an uncapped request as 65 536 tokens and rejects it on credit.
 * The Anthropic source defaults to 512 instead: claude-haiku can
 * spend a 16-token budget on reasoning before it emits a text block,
 * which left the live anthropic → anthropic chat case with empty
 * text. Caller-provided fields in `extra` merge over the defaults,
 * so explicit budgets still win.
 */
export function chatCall(
  source: Provider,
  model: string,
  extra: Record<string, unknown> = {},
): { method: 'POST'; path: string; body: object } {
  const prompt = 'Reply with one word.';
  switch (source) {
    case 'openai':
      return {
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: prompt }],
          ...extra,
        },
      };
    case 'anthropic':
      return {
        method: 'POST',
        path: '/v1/messages',
        body: {
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
          ...extra,
        },
      };
    case 'gemini': {
      const { generationConfig, ...rest } = extra;
      return {
        method: 'POST',
        path: `/v1beta/models/${model}:generateContent`,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 16,
            ...(generationConfig as Record<string, unknown> | undefined),
          },
          ...rest,
        },
      };
    }
    case 'ollama': {
      const { options, ...rest } = extra;
      return {
        method: 'POST',
        path: '/api/chat',
        body: {
          model,
          messages: [{ role: 'user', content: prompt }],
          options: {
            num_predict: 16,
            ...(options as Record<string, unknown> | undefined),
          },
          ...rest,
        },
      };
    }
  }
}

// Captured before any openrouter case runs so the OpenRouter key/URL
// borrowed through the OpenAI env can't leak into a later real
// "openai" target in the same process.
const REAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REAL_OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL;

function restoreOpenAIEnv(): void {
  if (REAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = REAL_OPENAI_API_KEY;
  if (REAL_OPENAI_API_BASE_URL === undefined)
    delete process.env.OPENAI_API_BASE_URL;
  else process.env.OPENAI_API_BASE_URL = REAL_OPENAI_API_BASE_URL;
}

/**
 * Point the in-process app at a real source → target pair and clear the
 * config cache so the next request picks it up. A pre-set
 * <TARGET>_API_BASE_URL (e.g. a gateway endpoint) is kept. The
 * "openrouter" target borrows the OpenAI provider: TARGET_API=openai,
 * OpenRouter's base URL and OPENROUTER_API_KEY.
 */
export function useTarget(source: Provider, target: LiveTarget): void {
  process.env.SOURCE_API = source;
  if (target === 'openrouter') {
    process.env.TARGET_API = 'openai';
    process.env.OPENAI_API_BASE_URL = OPENROUTER_BASE_URL;
    process.env.OPENAI_API_KEY = process.env.OPENROUTER_API_KEY!;
  } else {
    process.env.TARGET_API = target;
    restoreOpenAIEnv();
    const baseUrlVar = `${target.toUpperCase()}_API_BASE_URL`;
    process.env[baseUrlVar] = process.env[baseUrlVar] || LIVE_BASE_URLS[target];
  }
  resetConfig();
}

/**
 * Write `yaml` to a temp file and point the in-process app at it:
 * BABELGATE_CONFIG wins config discovery (spec §3.5), so the next
 * request after resetConfig() loads the file. Returns a cleanup that
 * restores the env, resets the config cache again and removes the temp
 * dir — always call it, or every later test in the worker inherits the
 * YAML config and useTarget() env is ignored.
 */
export function useYamlConfig(yaml: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'babelgate-live-'));
  writeFileSync(join(dir, 'babelgate.yaml'), yaml);
  const previous = process.env.BABELGATE_CONFIG;
  process.env.BABELGATE_CONFIG = join(dir, 'babelgate.yaml');
  resetConfig();
  return () => {
    if (previous === undefined) delete process.env.BABELGATE_CONFIG;
    else process.env.BABELGATE_CONFIG = previous;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  };
}

// Shape assertions that prove the response came back in SOURCE format.
// Same table as tests/integration/pairs.test.ts — keep in sync.
export const SOURCE_FORMAT_CHECKS: Record<
  Provider,
  (body: unknown) => void
> = {
  openai: (b) => {
    const body = b as { object?: string; choices?: unknown[] };
    expect(body.object).toBe('chat.completion');
    expect(Array.isArray(body.choices)).toBe(true);
  },
  gemini: (b) => {
    const body = b as { candidates?: unknown[] };
    expect(Array.isArray(body.candidates)).toBe(true);
  },
  ollama: (b) => {
    const body = b as { message?: unknown; done?: boolean };
    expect(body.message).toBeDefined();
    expect(typeof body.done).toBe('boolean');
  },
  anthropic: (b) => {
    const body = b as { type?: string; content?: unknown[]; role?: string };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(Array.isArray(body.content)).toBe(true);
  },
};

// Shape assertions that prove the models list came back in SOURCE format.
// Same table as tests/integration/pairs.test.ts — keep in sync.
export const MODEL_LIST_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const body = b as { object?: string; data?: { id: string }[] };
    expect(body.object).toBe('list');
    expect(body.data!.length).toBeGreaterThan(0);
    expect(body.data![0]!.id).toBeTruthy();
  },
  gemini: (b) => {
    const body = b as { models?: { name: string }[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models![0]!.name).toMatch(/^models\//);
  },
  ollama: (b) => {
    const body = b as { models?: { name: string }[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models![0]!.name).toBeTruthy();
  },
  anthropic: (b) => {
    const body = b as { data?: { id: string; type?: string }[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data![0]!.type).toBe('model');
  },
};

/** Pull the assistant text out of a source-shaped chat response. */
export const ASSISTANT_TEXT: Record<
  Provider,
  (body: unknown) => string | undefined
> = {
  openai: (b) =>
    (b as { choices?: { message?: { content?: string } }[] }).choices?.[0]
      ?.message?.content,
  gemini: (b) =>
    (b as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      .candidates?.[0]?.content?.parts?.[0]?.text,
  ollama: (b) => (b as { message?: { content?: string } }).message?.content,
  anthropic: (b) =>
    (b as { content?: { type?: string; text?: string }[] }).content?.find(
      (c) => c.type === 'text',
    )?.text,
};

/**
 * Usage assertions per source format — the source shapes that carry
 * usage must report real token counts from the upstream.
 */
export const USAGE_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const usage = (b as { usage?: { total_tokens?: number } }).usage;
    expect(usage?.total_tokens).toBeGreaterThan(0);
  },
  gemini: (b) => {
    const usage = (b as { usageMetadata?: { totalTokenCount?: number } })
      .usageMetadata;
    expect(usage?.totalTokenCount).toBeGreaterThan(0);
  },
  ollama: (b) => {
    const body = b as { prompt_eval_count?: number; eval_count?: number };
    expect((body.prompt_eval_count ?? 0) + (body.eval_count ?? 0)).toBeGreaterThan(
      0,
    );
  },
  anthropic: (b) => {
    const usage = (
      b as { usage?: { input_tokens?: number; output_tokens?: number } }
    ).usage;
    expect((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)).toBeGreaterThan(
      0,
    );
  },
};

/** Model ids in a source-shaped model-list response (Gemini prefix stripped). */
export const MODEL_IDS: Record<Provider, (body: unknown) => string[]> = {
  openai: (b) =>
    ((b as { data?: { id?: string }[] }).data ?? []).map((m) => m.id ?? ''),
  gemini: (b) =>
    ((b as { models?: { name?: string }[] }).models ?? []).map((m) =>
      (m.name ?? '').replace(/^models\//, ''),
    ),
  ollama: (b) =>
    ((b as { models?: { name?: string }[] }).models ?? []).map(
      (m) => m.name ?? '',
    ),
  anthropic: (b) =>
    ((b as { data?: { id?: string }[] }).data ?? []).map((m) => m.id ?? ''),
};
