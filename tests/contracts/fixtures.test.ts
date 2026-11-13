import { describe, it, expect } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import {
  canonicalRequestSchema,
  canonicalResponseSchema,
} from "../../src/types/canonical.schema";

import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";
import responsesFixtures from "../fixtures/responses.json";

interface ProviderFixtures {
  requests: Record<string, unknown>;
  responses: Record<string, unknown>;
}

const FIXTURES: Record<Provider, ProviderFixtures> = {
  openai: openaiFixtures,
  gemini: geminiFixtures,
  ollama: ollamaFixtures,
  anthropic: anthropicFixtures,
  responses: responsesFixtures,
};

const providers: Provider[] = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
];

describe("Adapter golden fixtures", () => {
  describe.each(providers)("%s", (provider) => {
    const adapter = adapters[provider];
    const fixtures = FIXTURES[provider];

    describe("request fixtures", () => {
      it.each(Object.keys(fixtures.requests))(
        "%s → canonical is schema-valid",
        (name) => {
          const canonical = adapter.toCanonicalRequest(fixtures.requests[name]);

          const result = canonicalRequestSchema.safeParse(canonical);
          expect(result.success, `${name}: schema validation`).toBe(true);
        },
      );

      it.each(Object.keys(fixtures.requests))(
        "%s → canonical matches snapshot",
        (name) => {
          const canonical = adapter.toCanonicalRequest(fixtures.requests[name]);
          expect(canonical).toMatchSnapshot();
        },
      );

      it.each(Object.keys(fixtures.requests))(
        "%s → provider roundtrip preserves data",
        (name) => {
          const original = fixtures.requests[name];
          const canonical = adapter.toCanonicalRequest(original);
          const restored = adapter.fromCanonicalRequest(canonical);

          // Roundtrip through canonical then back to canonical should
          // produce identical canonical output (idempotent)
          const reCanonical = adapter.toCanonicalRequest(restored);
          expect(reCanonical).toEqual(canonical);
        },
      );
    });

    describe("response fixtures", () => {
      it.each(Object.keys(fixtures.responses))(
        "%s → canonical is schema-valid",
        (name) => {
          const canonical = adapter.toCanonicalResponse(
            fixtures.responses[name],
            "test-model",
          );

          const result = canonicalResponseSchema.safeParse(canonical);
          expect(result.success, `${name}: schema validation`).toBe(true);
        },
      );

      it.each(Object.keys(fixtures.responses))(
        "%s → canonical matches snapshot",
        (name) => {
          const canonical = adapter.toCanonicalResponse(
            fixtures.responses[name],
            "test-model",
          );
          // Gemini/Ollama responses have no id field upstream — the
          // adapter generates a UUID, which is unstable for snapshots.
          const providersWithoutIds: Provider[] = ["gemini", "ollama"];
          const snapshot = providersWithoutIds.includes(provider)
            ? { ...canonical, id: "<generated>" }
            : canonical;
          expect(snapshot).toMatchSnapshot();
        },
      );

      it.each(Object.keys(fixtures.responses))(
        "%s → provider roundtrip is idempotent",
        (name) => {
          const original = fixtures.responses[name];
          const canonical = adapter.toCanonicalResponse(original, "test-model");
          const restored = adapter.fromCanonicalResponse(canonical);
          const reCanonical = adapter.toCanonicalResponse(
            restored,
            "test-model",
          );

          // Gemini/Ollama responses have no id field — a fresh UUID is
          // generated each pass, so compare everything except id.
          const providersWithoutIds: Provider[] = ["gemini", "ollama"];
          if (providersWithoutIds.includes(provider)) {
            const { id: _a, ...a } = canonical;
            const { id: _b, ...b } = reCanonical;
            expect(b).toEqual(a);
          } else {
            expect(reCanonical).toEqual(canonical);
          }
        },
      );
    });
  });
});
