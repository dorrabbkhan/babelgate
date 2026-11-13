import { describe, it, expect } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import { canonicalErrorSchema } from "../../src/types/canonical.schema";
import {
  CANONICAL_ERROR_STATUS,
  kindFromStatus,
  makeCanonicalError,
} from "../../src/utils/canonical-error";
import type { CanonicalErrorKind } from "../../src/types/canonical.types";

import openaiErrors from "../fixtures/errors/openai.json";
import geminiErrors from "../fixtures/errors/gemini.json";
import ollamaErrors from "../fixtures/errors/ollama.json";
import anthropicErrors from "../fixtures/errors/anthropic.json";
import responsesErrors from "../fixtures/errors/responses.json";

/**
 * Contract tests for canonical errors (spec v1.0.1 §3.3): every adapter
 * renders a CanonicalError in its provider's dialect, parses that dialect's
 * documented error bodies back, and never throws on unrecognised bodies.
 */

interface ErrorFixture {
  source: string;
  render: Record<string, unknown>;
  parse: {
    status: number;
    body: unknown;
    expectKind: CanonicalErrorKind;
    expectMessage: string;
  }[];
}

const FIXTURES: Record<Provider, ErrorFixture> = {
  openai: openaiErrors,
  gemini: geminiErrors,
  ollama: ollamaErrors,
  anthropic: anthropicErrors,
  responses: responsesErrors,
};

const providers: Provider[] = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
];

const KINDS: CanonicalErrorKind[] = [
  "invalid_request",
  "authentication",
  "permission",
  "not_found",
  "request_too_large",
  "rate_limit",
  "internal",
  "unsupported",
  "upstream",
  "unavailable",
  "timeout",
];

describe("adapter error contracts", () => {
  describe.each(providers)("%s", (provider) => {
    const adapter = adapters[provider];
    const fixture = FIXTURES[provider];

    describe("fromCanonicalError", () => {
      it.each(KINDS)("renders %s", (kind) => {
        const body = adapter.fromCanonicalError(
          makeCanonicalError(kind, "test message"),
        );
        expect(body).toEqual(fixture.render[kind]);
      });
    });

    describe("toCanonicalError", () => {
      it.each(fixture.parse.map((c, i) => [i, c] as const))(
        "parses documented error body #%s",
        (_i, c) => {
          const err = adapter.toCanonicalError(c.status, c.body);
          expect(err.kind).toBe(c.expectKind);
          expect(err.message).toBe(c.expectMessage);
        },
      );

      it.each(fixture.parse.map((c, i) => [i, c] as const))(
        "output for documented body #%s is schema-valid",
        (_i, c) => {
          const err = adapter.toCanonicalError(c.status, c.body);
          const result = canonicalErrorSchema.safeParse(err);
          expect(result.success, "schema validation").toBe(true);
        },
      );
    });
  });
});

describe("gemini error details", () => {
  it("gemini API_KEY_INVALID reads as authentication", () => {
    const err = adapters.gemini.toCanonicalError(400, {
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
    expect(err.kind).toBe("authentication");
    expect(err.status).toBe(401);
    expect(err.message).toBe(
      "API key not valid. Please pass a valid API key.",
    );
  });

  it("gemini details of the wrong shape fall back to the status kind", () => {
    for (const details of ["x", [1], [{ reason: 5 }]]) {
      let err;
      expect(() => {
        err = adapters.gemini.toCanonicalError(400, {
          error: {
            code: 400,
            message: "bad request",
            status: "INVALID_ARGUMENT",
            details,
          },
        });
      }).not.toThrow();
      expect(err!.kind).toBe("invalid_request");
    }
  });
});

describe("toCanonicalError tolerates unrecognised bodies", () => {
  const badBodies: unknown[] = [
    null,
    "",
    "<html>Bad Gateway</html>",
    { unexpected: true },
  ];

  it.each(
    providers.flatMap((provider) =>
      badBodies.map((body) => [provider, body] as const),
    ),
  )("%s falls back for body %j", (provider, body) => {
    let err;
    expect(() => {
      err = adapters[provider].toCanonicalError(502, body);
    }).not.toThrow();
    expect(err!.kind).toBe("upstream");
    expect(err!.status).toBe(502);
    expect(err!.message).toBe(`Upstream ${provider} returned 502`);
  });
});

describe("kindFromStatus covers the spec table", () => {
  it.each([
    [400, "invalid_request"],
    [422, "invalid_request"],
    [401, "authentication"],
    [403, "permission"],
    [404, "not_found"],
    [413, "request_too_large"],
    [429, "rate_limit"],
    [500, "internal"],
    [501, "unsupported"],
    [502, "upstream"],
    [503, "unavailable"],
    [529, "unavailable"],
    [504, "timeout"],
    [418, "invalid_request"],
    [599, "upstream"],
  ] as [number, CanonicalErrorKind][])(
    "status %i → %s",
    (status, kind) => {
      expect(kindFromStatus(status)).toBe(kind);
    },
  );
});

describe("CANONICAL_ERROR_STATUS", () => {
  it.each([
    ["invalid_request", 400],
    ["authentication", 401],
    ["permission", 403],
    ["not_found", 404],
    ["request_too_large", 413],
    ["rate_limit", 429],
    ["internal", 500],
    ["unsupported", 501],
    ["upstream", 502],
    ["unavailable", 503],
    ["timeout", 504],
  ] as [CanonicalErrorKind, number][])(
    "kind %s → status %i",
    (kind, status) => {
      expect(CANONICAL_ERROR_STATUS[kind]).toBe(status);
    },
  );
});
