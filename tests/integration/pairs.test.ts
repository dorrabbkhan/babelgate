import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import {
  PROVIDER_PATHS,
  PROVIDER_ROUTES,
  type Provider,
} from "../../src/transformers";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  resetCachedUsage,
  cachedUsage,
  CACHED_USAGE,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";
import responsesFixtures from "../fixtures/responses.json";

/**
 * Registry-driven coverage: every provider pair gets a generated
 * end-to-end test through the full HTTP pipeline. Adding a provider
 * without fixtures/adapter support fails loudly here.
 */

const server = setupServer(...upstreamHandlers);

const FIXTURES: Record<
  Provider,
  { requests: Record<string, unknown>; responses: Record<string, unknown> }
> = {
  openai: openaiFixtures,
  gemini: geminiFixtures,
  ollama: ollamaFixtures,
  anthropic: anthropicFixtures,
  responses: responsesFixtures,
};

// Shape assertions that prove the response came back in SOURCE format
const SOURCE_FORMAT_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const body = b as { object?: string; choices?: unknown[] };
    expect(body.object).toBe("chat.completion");
    expect(Array.isArray(body.choices)).toBe(true);
  },
  gemini: (b) => {
    const body = b as { candidates?: unknown[] };
    expect(Array.isArray(body.candidates)).toBe(true);
  },
  ollama: (b) => {
    const body = b as { message?: unknown; done?: boolean };
    expect(body.message).toBeDefined();
    expect(typeof body.done).toBe("boolean");
  },
  anthropic: (b) => {
    const body = b as { type?: string; content?: unknown[]; role?: string };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
  },
  responses: (b) => {
    const body = b as { object?: string; output?: unknown[] };
    expect(body.object).toBe("response");
    expect(Array.isArray(body.output)).toBe(true);
  },
};

// Shape assertions that prove the models list came back in SOURCE format
const MODEL_LIST_CHECKS: Record<Provider, (body: unknown) => void> = {
  openai: (b) => {
    const body = b as { object?: string; data?: { id: string }[] };
    expect(body.object).toBe("list");
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
    expect(body.data![0]!.type).toBe("model");
  },
  // A responses source's model list is the OpenAI list shape.
  responses: (b) => {
    const body = b as { object?: string; data?: { id: string }[] };
    expect(body.object).toBe("list");
    expect(body.data!.length).toBeGreaterThan(0);
    expect(body.data![0]!.id).toBeTruthy();
  },
};

const providers = Object.keys(PROVIDER_PATHS) as Provider[];
const pairs = providers.flatMap((source) =>
  providers.map((target) => ({ source, target })),
);

/**
 * The canonical usage a target's cached-usage mock decodes to
 * (spec §3.2): Ollama's dialect has no cache fields; Gemini's carries
 * reads only.
 */
function expectedCanonical(target: Provider): {
  read?: number;
  write?: number;
} {
  if (target === "ollama") return {};
  if (target === "gemini") return { read: CACHED_USAGE.readTokens };
  return {
    read: CACHED_USAGE.readTokens,
    write: CACHED_USAGE.writeTokens,
  };
}

/**
 * The client must receive the surviving counts in its own dialect —
 * or no cache fields at all when the source wire cannot carry them
 * (Ollama: inputTokens only; Gemini: reads only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function expectCachedUsage(
  source: Provider,
  target: Provider,
  body: unknown,
): void {
  const expected = expectedCanonical(target);
  const b = body as Record<string, any>;
  if (source === "openai") {
    const details = b.usage?.prompt_tokens_details;
    if (expected.read === undefined && expected.write === undefined) {
      expect(details).toBeUndefined();
    } else {
      expect(details).toEqual({
        ...(expected.read !== undefined && {
          cached_tokens: expected.read,
        }),
        ...(expected.write !== undefined && {
          cache_write_tokens: expected.write,
        }),
      });
    }
    expect(b.usage.prompt_tokens).toBe(CACHED_USAGE.inputTokens);
    return;
  }
  if (source === "anthropic") {
    const usage = b.usage;
    expect(usage.cache_read_input_tokens).toBe(expected.read);
    expect(usage.cache_creation_input_tokens).toBe(expected.write);
    // input_tokens on the wire excludes the cached tokens.
    expect(usage.input_tokens).toBe(
      CACHED_USAGE.inputTokens -
        (expected.read ?? 0) -
        (expected.write ?? 0),
    );
    expect(usage.output_tokens).toBe(CACHED_USAGE.outputTokens);
    return;
  }
  if (source === "gemini") {
    expect(b.usageMetadata?.cachedContentTokenCount).toBe(expected.read);
    expect(b.usageMetadata?.promptTokenCount).toBe(
      CACHED_USAGE.inputTokens,
    );
    return;
  }
  if (source === "responses") {
    // input_tokens_details is always emitted; zero when the target's
    // dialect carried nothing.
    const details = b.usage?.input_tokens_details;
    expect(details?.cached_tokens).toBe(expected.read ?? 0);
    expect(details?.cache_write_tokens).toBe(expected.write ?? 0);
    expect(b.usage.input_tokens).toBe(CACHED_USAGE.inputTokens);
    expect(b.usage.output_tokens).toBe(CACHED_USAGE.outputTokens);
    return;
  }
  // ollama: inputTokens only — the wire has no cache fields.
  expect(b.prompt_eval_count).toBe(CACHED_USAGE.inputTokens);
  expect(b.eval_count).toBe(CACHED_USAGE.outputTokens);
  expect(JSON.stringify(b)).not.toContain("cache");
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });

  for (const p of providers) {
    const envVar = `${p.toUpperCase()}_API_BASE_URL`;
    process.env[envVar] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetCachedUsage();
});

afterAll(() => {
  server.close();
});

describe("provider pair coverage", () => {
  it.each(pairs)(
    "$source → $target proxies end-to-end",
    async ({ source, target }) => {
      process.env.SOURCE_API = source;
      process.env.TARGET_API = target;
      resetConfig();

      const sourceFixture = FIXTURES[source].requests["basic"];
      expect(
        sourceFixture,
        `missing basic request fixture for ${source}`,
      ).toBeDefined();

      // Ollama's /api/chat streams NDJSON unless stream:false is sent
      // (api.md, default true) — the single-object reply this check
      // parses needs the explicit opt-out.
      const body =
        source === "ollama"
          ? { ...(sourceFixture as Record<string, unknown>), stream: false }
          : (sourceFixture as object);

      const res = await request(app)
        .post(PROVIDER_PATHS[source].pathPrefix)
        .send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // Upstream was hit in target provider format
      expect(capturedRequests[target]).toHaveLength(1);

      // Response came back translated to source format
      SOURCE_FORMAT_CHECKS[source](res.body);
    },
  );

  it.each(pairs)(
    "$source → $target proxies GET /models end-to-end",
    async ({ source, target }) => {
      process.env.SOURCE_API = source;
      process.env.TARGET_API = target;
      resetConfig();

      const modelsRoute = PROVIDER_ROUTES[source].find(
        (r) => r.kind === "models",
      )!;
      // GET /v1/models is shared by openai and anthropic: real Anthropic
      // clients always send anthropic-version, which is how detectSource
      // tells them apart (spec §3.2).
      let req = request(app).get(modelsRoute.pathPrefix);
      if (source === "anthropic") {
        req = req.set("anthropic-version", "2023-06-01");
      }
      const res = await req;

      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // Response must be a list of models in the SOURCE provider's shape
      MODEL_LIST_CHECKS[source](res.body);
    },
  );

  it.each(pairs)(
    "$source → $target: cached usage survives every pair (spec §3.2)",
    async ({ source, target }) => {
      process.env.SOURCE_API = source;
      process.env.TARGET_API = target;
      resetConfig();
      cachedUsage[target] = true;

      const sourceFixture = FIXTURES[source].requests["basic"];
      const body =
        source === "ollama"
          ? { ...(sourceFixture as Record<string, unknown>), stream: false }
          : (sourceFixture as object);

      const res = await request(app)
        .post(PROVIDER_PATHS[source].pathPrefix)
        .send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectCachedUsage(source, target, res.body);
    },
  );

  it("returns 404 for GET chat paths (method mismatch)", async () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "ollama";
    resetConfig();

    const res = await request(app).get("/v1/chat/completions");
    expect(res.status).toBe(404);
  });
});
