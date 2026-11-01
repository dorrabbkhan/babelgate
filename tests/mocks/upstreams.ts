import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { adapters, type Provider } from "../../src/transformers";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";

import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";

/** Mock hostnames used as *_API_BASE_URL in tests */
export const MOCK_BASE_URLS: Record<Provider, string> = {
  openai: "http://openai.mock",
  gemini: "http://gemini.mock",
  ollama: "http://ollama.mock",
  anthropic: "http://anthropic.mock",
};

/** A second OpenAI-type host for multi-provider (fallback) tests. */
export const OPENAI2_BASE_URL = "http://openai2.mock";

/** Nothing listens on this port — a guaranteed transport failure. */
export const DEAD_BASE_URL = "http://127.0.0.1:9";

/** Captured request bodies per provider (reset between tests) */
export const capturedRequests: Record<Provider, unknown[]> = {
  openai: [],
  gemini: [],
  ollama: [],
  anthropic: [],
};

/** Captured auth headers per provider */
export const capturedHeaders: Record<Provider, Headers[]> = {
  openai: [],
  gemini: [],
  ollama: [],
  anthropic: [],
};

/** Captured requests/headers on the second OpenAI-type host */
export const capturedRequests2: unknown[] = [];
export const capturedHeaders2: Headers[] = [];

export function resetCaptured(): void {
  for (const p of Object.keys(capturedRequests) as Provider[]) {
    capturedRequests[p].length = 0;
    capturedHeaders[p].length = 0;
  }
  capturedRequests2.length = 0;
  capturedHeaders2.length = 0;
}

/** Responses to return per provider — overridable per test */
export const responseOverrides: Partial<
  Record<Provider, { status?: number; body?: unknown }>
> = {};

export function resetOverrides(): void {
  for (const key of Object.keys(responseOverrides) as Provider[]) {
    delete responseOverrides[key];
  }
  delete responseOverrides2.status;
  delete responseOverrides2.body;
}

/** Overrides for the second OpenAI-type host (cleared by resetOverrides) */
export const responseOverrides2: { status?: number; body?: unknown } = {};

/**
 * Which fixture case each provider's upstream serves (default "text").
 * Streaming requests get the case's recorded wire bytes; non-streaming
 * requests get nonStreamBody(provider).
 */
export const streamCase: Partial<Record<Provider, string>> = {};

export function resetStreamCase(): void {
  for (const key of Object.keys(streamCase) as Provider[]) {
    delete streamCase[key];
  }
}

const FIXTURE_RESPONSES: Record<Provider, Record<string, unknown>> = {
  openai: openaiFixtures.responses,
  gemini: geminiFixtures.responses,
  ollama: ollamaFixtures.responses,
  anthropic: anthropicFixtures.responses,
};

// Named responses in tests/fixtures/<p>.json for cases that have one.
const CASE_RESPONSE: Record<Provider, Record<string, string>> = {
  openai: { tool_call: "tool_call" },
  anthropic: { tool_call: "tool_use" },
  ollama: {},
  gemini: {},
};

/**
 * What a non-streaming request gets for the provider's selected
 * streamCase: either `{body}` — a recorded reply ("text" →
 * `responses.basic`, a named fixture response, or the recorded
 * non-streaming twin `<case>.nonstreaming.json` / the `nonStreaming`
 * field) — or `{expectedEvents}` when no recording exists, which
 * nonStreamBody reassembles and re-encodes in the provider's dialect.
 * Tests use this to pick expectations from the same oracle the mock
 * serves, so the derive path is never asserted by re-parsing the
 * adapter-derived body.
 */
export function nonStreamSource(
  provider: Provider,
): { body: unknown } | { expectedEvents: CanonicalStreamEvent[] } {
  const name = streamCase[provider] ?? "text";
  if (name === "text") return { body: FIXTURE_RESPONSES[provider].basic };
  const key = CASE_RESPONSE[provider][name];
  if (key !== undefined) {
    return { body: FIXTURE_RESPONSES[provider][key] };
  }
  const dir = join(__dirname, "..", "fixtures", "streams", provider);
  const twin = join(dir, `${name}.nonstreaming.json`);
  if (existsSync(twin)) {
    return { body: JSON.parse(readFileSync(twin, "utf8")) as unknown };
  }
  const meta = JSON.parse(
    readFileSync(join(dir, `${name}.json`), "utf8"),
  ) as { nonStreaming?: unknown; expectedEvents: CanonicalStreamEvent[] };
  if (meta.nonStreaming != null) return { body: meta.nonStreaming };
  return { expectedEvents: meta.expectedEvents };
}

/**
 * The non-stream reply for a provider's selected streamCase —
 * nonStreamSource's recorded body, or the case's documented stream
 * events reassembled and re-encoded in the provider's dialect.
 */
export function nonStreamBody(provider: Provider): unknown {
  const source = nonStreamSource(provider);
  if ("expectedEvents" in source) {
    return adapters[provider].fromCanonicalResponse(
      reassembleStream(source.expectedEvents),
    );
  }
  return source.body;
}

const WIRE_EXT: Record<Provider, string> = {
  openai: "sse",
  anthropic: "sse",
  gemini: "sse",
  ollama: "ndjson",
};

const STREAM_CONTENT_TYPE: Record<Provider, string> = {
  openai: "text/event-stream",
  anthropic: "text/event-stream",
  gemini: "text/event-stream",
  ollama: "application/x-ndjson",
};

/**
 * Serve the recorded stream corpus as the upstream reply, in 7-byte
 * chunks so split-point handling is exercised on every proxied stream.
 */
function streamFixtureResponse(provider: Provider): HttpResponse {
  const name = streamCase[provider] ?? "text";
  const file = join(
    __dirname,
    "..",
    "fixtures",
    "streams",
    provider,
    `${name}.${WIRE_EXT[provider]}`,
  );
  const bytes = readFileSync(file);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.subarray(i, i + 7));
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "content-type": STREAM_CONTENT_TYPE[provider] },
  });
}

/** A request body asks for a stream via `stream:true` (or the Gemini path). */
function wantsStream(url: string, body: unknown): boolean {
  if (url.includes(":streamGenerateContent")) return true;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { stream?: unknown }).stream === true
  );
}

export const upstreamHandlers = [
  http.post(
    `${MOCK_BASE_URLS.openai}/v1/chat/completions`,
    async ({ request }) => {
      const body = await request.json();
      capturedRequests.openai.push(body);
      capturedHeaders.openai.push(request.headers);
      const override = responseOverrides.openai;
      if (override) {
        return HttpResponse.json(override.body ?? {}, {
          status: override.status ?? 200,
        });
      }
      if (wantsStream(request.url, body)) {
        return streamFixtureResponse("openai");
      }
      return HttpResponse.json(nonStreamBody("openai"));
    },
  ),

  http.post(`${MOCK_BASE_URLS.gemini}/v1beta/models/*`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.gemini.push(body);
    capturedHeaders.gemini.push(request.headers);
    const override = responseOverrides.gemini;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("gemini");
    }
    return HttpResponse.json(nonStreamBody("gemini"));
  }),

  http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.ollama.push(body);
    capturedHeaders.ollama.push(request.headers);
    const override = responseOverrides.ollama;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("ollama");
    }
    return HttpResponse.json(nonStreamBody("ollama"));
  }),

  http.post(`${MOCK_BASE_URLS.anthropic}/v1/messages`, async ({ request }) => {
    const body = await request.json();
    capturedRequests.anthropic.push(body);
    capturedHeaders.anthropic.push(request.headers);
    const override = responseOverrides.anthropic;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("anthropic");
    }
    return HttpResponse.json(nonStreamBody("anthropic"));
  }),

  // ===== Model list endpoints =====

  http.get(`${MOCK_BASE_URLS.openai}/v1/models`, ({ request }) => {
    capturedHeaders.openai.push(request.headers);
    const override = responseOverrides.openai;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(openaiFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.gemini}/v1beta/models`, ({ request }) => {
    capturedHeaders.gemini.push(request.headers);
    const override = responseOverrides.gemini;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(geminiFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.ollama}/api/tags`, ({ request }) => {
    capturedHeaders.ollama.push(request.headers);
    const override = responseOverrides.ollama;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(ollamaFixtures.models);
  }),

  http.get(`${MOCK_BASE_URLS.anthropic}/v1/models`, ({ request }) => {
    capturedHeaders.anthropic.push(request.headers);
    const override = responseOverrides.anthropic;
    if (override) {
      return HttpResponse.json(override.body ?? {}, {
        status: override.status ?? 200,
      });
    }
    return HttpResponse.json(anthropicFixtures.models);
  }),

  // ===== Second OpenAI-type host (fallback tests) =====

  http.post(`${OPENAI2_BASE_URL}/v1/chat/completions`, async ({ request }) => {
    const body = await request.json();
    capturedRequests2.push(body);
    capturedHeaders2.push(request.headers);
    if (
      responseOverrides2.status !== undefined ||
      responseOverrides2.body !== undefined
    ) {
      return HttpResponse.json(responseOverrides2.body ?? {}, {
        status: responseOverrides2.status ?? 200,
      });
    }
    if (wantsStream(request.url, body)) {
      return streamFixtureResponse("openai");
    }
    return HttpResponse.json(openaiFixtures.responses.basic);
  }),

  http.get(`${OPENAI2_BASE_URL}/v1/models`, ({ request }) => {
    capturedHeaders2.push(request.headers);
    if (
      responseOverrides2.status !== undefined ||
      responseOverrides2.body !== undefined
    ) {
      return HttpResponse.json(responseOverrides2.body ?? {}, {
        status: responseOverrides2.status ?? 200,
      });
    }
    return HttpResponse.json(openaiFixtures.models);
  }),
];
