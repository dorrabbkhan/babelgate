import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import express from "express";
import pino from "pino";
import request from "supertest";
import { app } from "../../src/app";
import { createRequestLogger } from "../../src/middleware/request-logger";
import { resetConfig } from "../../src/config/env-config";
import { adapters, type Provider } from "../../src/transformers";
import { makeCanonicalError } from "../../src/utils/canonical-error";
import { logger } from "../../src/utils/logger";
import type { CanonicalErrorKind } from "../../src/types/canonical.types";
import {
  upstreamHandlers,
  capturedRequests,
  capturedHeaders,
  resetCaptured,
  resetOverrides,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";

/**
 * Error-path coverage (spec §3.3): every upstream failure mode, rendered
 * in the *source* provider's dialect, generated over every source ×
 * target pair like pairs.test.ts.
 */

const server = setupServer(...upstreamHandlers);

const providers: Provider[] = ["openai", "gemini", "ollama", "anthropic"];
const pairs = providers.flatMap((source) =>
  providers.map((target) => ({ source, target })),
);

// A valid non-streaming chat request per source format. Ollama's
// /api/chat streams NDJSON unless stream:false is sent (api.md,
// default true) — the explicit flag keeps these cases on the
// non-streaming error path they assert.
const SOURCE_CALL: Record<Provider, { path: string; body: object }> = {
  openai: { path: "/v1/chat/completions", body: openaiFixtures.requests.basic as object },
  gemini: { path: "/v1beta/models/gpt-4:generateContent", body: geminiFixtures.requests.basic as object },
  ollama: {
    path: "/api/chat",
    body: { ...ollamaFixtures.requests.basic, stream: false } as object,
  },
  anthropic: { path: "/v1/messages", body: anthropicFixtures.requests.basic as object },
};

// Upstream chat endpoint pattern per target (for msw server.use)
const UPSTREAM_CHAT_PATH: Record<Provider, string> = {
  openai: "/v1/chat/completions",
  gemini: "/v1beta/models/*",
  ollama: "/api/chat",
  anthropic: "/v1/messages",
};

const UPSTREAM_MESSAGE = "upstream says no";

// An error body in the *target* provider's documented shape
function upstreamErrorBody(target: Provider, message: string): unknown {
  switch (target) {
    case "openai":
      return {
        error: {
          message,
          type: "invalid_request_error",
          param: null,
          code: "test_code",
        },
      };
    case "anthropic":
      return {
        type: "error",
        error: { type: "invalid_request_error", message },
      };
    case "gemini":
      return { error: { code: 400, message, status: "INVALID_ARGUMENT" } };
    case "ollama":
      return { error: message };
  }
}

// spec §3.3 mapping table — one row per case
const MAPPING_CASES: {
  name: string;
  upstreamStatus: number;
  expectedKind: CanonicalErrorKind;
  expectedStatus: number;
  message: (target: Provider) => string;
  upstreamHeaders?: Record<string, string>;
}[] = [
  {
    name: "upstream 400",
    upstreamStatus: 400,
    expectedKind: "invalid_request",
    expectedStatus: 400,
    message: () => UPSTREAM_MESSAGE,
  },
  {
    name: "upstream 404",
    upstreamStatus: 404,
    expectedKind: "not_found",
    expectedStatus: 404,
    message: () => UPSTREAM_MESSAGE,
  },
  {
    name: "upstream 413",
    upstreamStatus: 413,
    expectedKind: "request_too_large",
    expectedStatus: 413,
    message: () => UPSTREAM_MESSAGE,
  },
  {
    name: "upstream 429",
    upstreamStatus: 429,
    expectedKind: "rate_limit",
    expectedStatus: 429,
    message: () => UPSTREAM_MESSAGE,
    upstreamHeaders: { "Retry-After": "7" },
  },
  {
    name: "upstream 401",
    upstreamStatus: 401,
    expectedKind: "upstream",
    expectedStatus: 502,
    message: (target) =>
      `Upstream ${target} rejected the proxy's credentials (401)`,
  },
  {
    name: "upstream 503",
    upstreamStatus: 503,
    expectedKind: "unavailable",
    expectedStatus: 503,
    message: () => UPSTREAM_MESSAGE,
  },
  {
    name: "upstream 500",
    upstreamStatus: 500,
    expectedKind: "upstream",
    expectedStatus: 502,
    message: () => UPSTREAM_MESSAGE,
  },
];

function setPair(source: Provider, target: Provider): void {
  process.env.SOURCE_API = source;
  process.env.TARGET_API = target;
  resetConfig();
}

function mockUpstream(
  target: Provider,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  server.use(
    http.post(`${MOCK_BASE_URLS[target]}${UPSTREAM_CHAT_PATH[target]}`, () =>
      HttpResponse.json(body, { status, headers }),
    ),
  );
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });

  for (const p of providers) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

beforeEach(() => {
  // One attempt: the last-attempt code path is identical and the suite
  // stays fast (no backoff sleeps on 429/503).
  process.env.UPSTREAM_RETRIES = "0";
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  vi.restoreAllMocks();
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.UPSTREAM_TIMEOUT_MS;
});

afterAll(() => {
  server.close();
});

describe("upstream status mapping (spec §3.3)", () => {
  it.each(
    pairs.flatMap(({ source, target }) =>
      MAPPING_CASES.map((c) => ({ source, target, c })),
    ),
  )(
    "$source ← $target: $c.name → $c.expectedStatus $c.expectedKind in source dialect",
    async ({ source, target, c }) => {
      setPair(source, target);
      mockUpstream(
        target,
        c.upstreamStatus,
        upstreamErrorBody(target, UPSTREAM_MESSAGE),
        c.upstreamHeaders,
      );

      const call = SOURCE_CALL[source];
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status, JSON.stringify(res.body)).toBe(c.expectedStatus);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError(c.expectedKind, c.message(target)),
        ),
      );
      if (c.upstreamHeaders?.["Retry-After"]) {
        expect(res.headers["retry-after"]).toBe("7");
      }
    },
  );

  it.each(pairs)(
    "$source ← $target: upstream timeout → 504 timeout in source dialect",
    async ({ source, target }) => {
      process.env.UPSTREAM_TIMEOUT_MS = "50";
      setPair(source, target);
      server.use(
        http.post(
          `${MOCK_BASE_URLS[target]}${UPSTREAM_CHAT_PATH[target]}`,
          async () => {
            await delay(1000);
            return HttpResponse.json({});
          },
        ),
      );

      const call = SOURCE_CALL[source];
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status, JSON.stringify(res.body)).toBe(504);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError("timeout", "Upstream timed out after 50ms"),
        ),
      );
    },
  );

  it.each(pairs)(
    "$source ← $target: HTML 502 page from upstream renders in source dialect",
    async ({ source, target }) => {
      setPair(source, target);
      server.use(
        http.post(
          `${MOCK_BASE_URLS[target]}${UPSTREAM_CHAT_PATH[target]}`,
          () =>
            new HttpResponse("<html><body>502 Bad Gateway</body></html>", {
              status: 502,
              headers: { "content-type": "text/html" },
            }),
        ),
      );

      const call = SOURCE_CALL[source];
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status, JSON.stringify(res.body)).toBe(502);
      // Unrecognised body → the adapter's documented fallback message
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError("upstream", `Upstream ${target} returned 502`),
        ),
      );
    },
  );

  it.each(providers)(
    "gemini 400 API_KEY_INVALID → 502 credentials message in $source dialect",
    async (source) => {
      setPair(source, "gemini");
      mockUpstream("gemini", 400, {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "API_KEY_INVALID",
              domain: "googleapis.com",
              metadata: { service: "generativelanguage.googleapis.com" },
            },
          ],
        },
      });

      const call = SOURCE_CALL[source];
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError(
            "upstream",
            "Upstream gemini rejected the proxy's credentials (400)",
          ),
        ),
      );
      expect(JSON.stringify(res.body)).not.toContain("API key not valid");
    },
  );
});

describe("client-side errors in the source dialect", () => {
  it.each(providers)(
    "malformed JSON body → 400 invalid_request in $source dialect",
    async (source) => {
      setPair(source, "ollama");

      const res = await request(app)
        .post(SOURCE_CALL[source].path)
        .set("Content-Type", "application/json")
        .send('{"broken":');

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError("invalid_request", "Malformed JSON body"),
        ),
      );
      expect(capturedRequests.ollama).toHaveLength(0);
    },
  );

  it.each(providers)(
    "body over MAX_BODY_SIZE → 413 in $source dialect",
    async (source) => {
      setPair(source, "ollama");

      // ~11 MB — the app is built with the default 10mb limit
      const res = await request(app)
        .post(SOURCE_CALL[source].path)
        .send({
          ...(SOURCE_CALL[source].body as Record<string, unknown>),
          padding: "a".repeat(11 * 1024 * 1024),
        });

      expect(res.status, JSON.stringify(res.body)).toBe(413);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError({
          kind: "request_too_large",
          status: 413,
          message: expect.any(String) as unknown as string,
        }),
      );
      expect(capturedRequests.ollama).toHaveLength(0);
    },
  );

  it("gemini path with an empty model → 400 invalid_request, no upstream call", async () => {
    setPair("gemini", "ollama");

    const res = await request(app)
      .post("/v1beta/models/:generateContent")
      .send(geminiFixtures.requests.basic as object);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual(
      adapters.gemini.fromCanonicalError(
        makeCanonicalError("invalid_request", expect.any(String) as unknown as string),
      ),
    );
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("unknown path keeps the generic 404 shape", async () => {
    setPair("openai", "ollama");

    const res = await request(app).post("/unmapped/path").send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { message: "Not Found", code: "NOT_FOUND", status: 404 },
    });
  });
});

describe("privacy (spec §3.3)", () => {
  /**
   * Serialize every captured logger call as pino would — pino uses a
   * circular-safe stringify (request/response objects appear in
   * pino-http's log objects).
   */
  function safeStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  }

  function capturedLogLines(): string {
    const spies = ["info", "warn", "error", "debug"] as const;
    return spies
      .flatMap((level) => {
        const spy = logger[level] as unknown as ReturnType<typeof vi.fn>;
        return (spy.mock?.calls ?? []) as unknown[][];
      })
      .map((args) => safeStringify(args))
      .join("\n");
  }

  it.each(providers)(
    "upstream 401 message never reaches client or log ($source)",
    async (source) => {
      setPair(source, "openai");
      mockUpstream("openai", 401, {
        error: {
          message: "Incorrect API key provided: sk-test***abcd",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
      vi.spyOn(logger, "info");
      vi.spyOn(logger, "warn");
      vi.spyOn(logger, "error");
      vi.spyOn(logger, "debug");

      const call = SOURCE_CALL[source];
      const res = await request(app).post(call.path).send(call.body);

      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain("sk-test");
      // The upstream message may be echoed as masked key text — it must
      // not reach any log line (§3.3: no message at all for 401/403).
      expect(capturedLogLines()).not.toContain("sk-test");
    },
  );

  it("malformed request body is not echoed into the log", async () => {
    setPair("openai", "ollama");
    vi.spyOn(logger, "info");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "debug");

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .send('{"prompt_secret_xyz":');

    expect(res.status).toBe(400);
    // body-parser errors carry the raw request body on err.body and echo
    // a fragment in err.message — neither may reach a log line
    expect(capturedLogLines()).not.toContain("prompt_secret_xyz");
  });

  it("upstream body is never written to a log line", async () => {
    setPair("openai", "ollama");
    mockUpstream("ollama", 500, { error: "upstream exploded" });
    vi.spyOn(logger, "info");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "debug");

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);

    expect(res.status).toBe(502);
    const logged = capturedLogLines();
    expect(logged).not.toContain("upstreamBody");
    // the raw upstream body object must not appear either
    expect(logged).not.toContain('"error":"upstream exploded"');
  });

  it("non-JSON 2xx bodyPreview reaches the client details but never a log line", async () => {
    setPair("openai", "ollama");
    const ndjson = '{"a":1}\n{"b":2}\n';
    server.use(
      http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, () =>
        new HttpResponse(ndjson, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
      ),
    );
    vi.spyOn(logger, "info");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "debug");

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);

    expect(res.status).toBe(502);
    // outside production the preview is still in the response details
    // (owner decision, Task 4) — but it can be completion text, so it is
    // never logged
    expect(res.body.details?.bodyPreview).toBe(ndjson.slice(0, 200));
    const logged = capturedLogLines();
    expect(logged).not.toContain("bodyPreview");
    expect(logged).not.toContain('{"a":1}');
  });

  it("gemini API_KEY_INVALID upstream message never reaches the log", async () => {
    setPair("openai", "gemini");
    mockUpstream("gemini", 400, {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_INVALID",
          },
        ],
      },
    });
    vi.spyOn(logger, "info");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "debug");

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);

    expect(res.status).toBe(502);
    expect(capturedLogLines()).not.toContain("API key not valid");
  });
});

describe("client auth in native headers (spec §3.4)", () => {
  // Distinctive value — assertions check it never reaches the upstream
  // request or a log line.
  const CLIENT_KEY = "client-key-9f8e7d6c";

  const AUTH_STYLES: {
    style: string;
    apply: (r: request.Test, key: string) => request.Test;
  }[] = [
    {
      style: "Authorization: Bearer",
      apply: (r, key) => r.set("Authorization", `Bearer ${key}`),
    },
    { style: "x-api-key", apply: (r, key) => r.set("x-api-key", key) },
    {
      style: "x-goog-api-key",
      apply: (r, key) => r.set("x-goog-api-key", key),
    },
    {
      style: "?key= query parameter",
      apply: (r, key) => r.query({ key }),
    },
  ];

  /**
   * app.ts reads PROXY_API_KEY when the app is built, so each test needs
   * a fresh module graph — including the env-config from that same
   * graph (the static imports point at the un-authed app).
   */
  async function authedApp(source: Provider, target: Provider) {
    vi.stubEnv("PROXY_API_KEY", CLIENT_KEY);
    process.env.SOURCE_API = source;
    process.env.TARGET_API = target;
    vi.resetModules();
    const { app: authed } = await import("../../src/app");
    const { resetConfig: freshReset } = await import(
      "../../src/config/env-config"
    );
    freshReset();
    return authed;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(
    (["openai", "anthropic", "gemini"] as Provider[]).flatMap((source) =>
      AUTH_STYLES.map((style) => ({ source, style })),
    ),
  )(
    "rejects a wrong key via $style.style → 401 in $source dialect",
    async ({ source, style }) => {
      const authed = await authedApp(source, "ollama");
      const call = SOURCE_CALL[source];

      const res = await style.apply(
        request(authed).post(call.path).send(call.body),
        "wrong-key",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.body).toEqual(
        adapters[source].fromCanonicalError(
          makeCanonicalError("authentication", "Invalid or missing API key"),
        ),
      );
      expect(capturedRequests.ollama).toHaveLength(0);
    },
  );

  it("client key is never forwarded upstream (gemini target)", async () => {
    const authed = await authedApp("gemini", "gemini");

    const upstreamUrls: string[] = [];
    const onRequest = ({ request: req }: { request: Request }) => {
      upstreamUrls.push(req.url);
    };
    server.events.on("request:start", onRequest);
    try {
      const res = await request(authed)
        .post("/v1beta/models/gpt-4:generateContent")
        .query({ key: CLIENT_KEY })
        .send(geminiFixtures.requests.basic as object);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      server.events.removeListener("request:start", onRequest);
    }

    // The upstream gets only the proxy's own key — in the header, never
    // the client's.
    const headers = capturedHeaders.gemini[0]!;
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    for (const value of headers.values()) {
      expect(value).not.toContain(CLIENT_KEY);
    }

    // And the upstream URL carries no key= parameter at all.
    const geminiUrls = upstreamUrls.filter((u) =>
      u.startsWith(MOCK_BASE_URLS.gemini),
    );
    expect(geminiUrls).toHaveLength(1);
    for (const url of geminiUrls) {
      expect(url).not.toContain("key=");
      expect(url).not.toContain(CLIENT_KEY);
    }
  });

  it("client key is never forwarded upstream (anthropic target)", async () => {
    const authed = await authedApp("anthropic", "anthropic");

    const upstreamUrls: string[] = [];
    const onRequest = ({ request: req }: { request: Request }) => {
      upstreamUrls.push(req.url);
    };
    server.events.on("request:start", onRequest);
    try {
      const res = await request(authed)
        .post("/v1/messages")
        .set("x-api-key", CLIENT_KEY)
        .send(anthropicFixtures.requests.basic as object);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      server.events.removeListener("request:start", onRequest);
    }

    const headers = capturedHeaders.anthropic[0]!;
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("authorization")).toBeNull();
    for (const value of headers.values()) {
      expect(value).not.toContain(CLIENT_KEY);
    }

    const anthropicUrls = upstreamUrls.filter((u) =>
      u.startsWith(MOCK_BASE_URLS.anthropic),
    );
    expect(anthropicUrls).toHaveLength(1);
    for (const url of anthropicUrls) {
      expect(url).not.toContain("key=");
      expect(url).not.toContain(CLIENT_KEY);
    }
  });

  it("a request authenticated via ?key= leaves no key in the request log", async () => {
    // Assert on the written line, not on logger call arguments:
    // pino-http's serializers (which carry the redaction) run at write
    // time, so the raw req/res in the call args still hold the key.
    const lines: string[] = [];
    const capture = pino(
      { level: "debug" },
      {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    );
    const mini = express();
    mini.use(createRequestLogger(capture));
    mini.post("/v1/chat/completions", (_req, res) => res.json({ ok: true }));

    const res = await request(mini)
      .post("/v1/chat/completions")
      .query({ key: CLIENT_KEY, other: "1" })
      .set("Authorization", `Bearer ${CLIENT_KEY}`)
      .set("x-api-key", CLIENT_KEY)
      .set("x-goog-api-key", CLIENT_KEY)
      .send({});

    expect(res.status).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(CLIENT_KEY);
  });
});

describe("unsupported gemini methods (spec §3.2)", () => {
  it.each(
    providers.flatMap((target) =>
      ["embedContent"].map((method) => ({ target, method })),
    ),
  )(
    "gemini non-chat method :$method → 501 in gemini dialect ($target)",
    async ({ target, method }) => {
      setPair("gemini", target);

      const res = await request(app)
        .post(`/v1beta/models/gemini-2.0-flash:${method}`)
        .send(geminiFixtures.requests.basic as object);

      expect(res.status, JSON.stringify(res.body)).toBe(501);
      expect(res.body).toEqual(
        adapters.gemini.fromCanonicalError(
          makeCanonicalError("unsupported", `${method} is not supported`),
        ),
      );
      expect(capturedRequests[target]).toHaveLength(0);
    },
  );

  it("gemini non-chat method on a tunedModels path → 501", async () => {
    setPair("gemini", "ollama");

    const res = await request(app)
      .post("/v1beta/models/tunedModels/my-model:embedContent")
      .send(geminiFixtures.requests.basic as object);

    expect(res.status, JSON.stringify(res.body)).toBe(501);
    expect(res.body).toEqual(
      adapters.gemini.fromCanonicalError(
        makeCanonicalError("unsupported", "embedContent is not supported"),
      ),
    );
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it.each(providers)(
    "stream:false is accepted ($source → ollama)",
    async (source) => {
      setPair(source, "ollama");

      const call = SOURCE_CALL[source];
      const res = await request(app)
        .post(call.path)
        .send({ ...(call.body as Record<string, unknown>), stream: false });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(capturedRequests.ollama).toHaveLength(1);
    },
  );
});
