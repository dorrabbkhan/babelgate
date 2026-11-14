import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters, type Provider } from "../../src/transformers";
import { canonicalStreamEventSchema } from "../../src/types/canonical.schema";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import { sequentialIds } from "../../src/utils/ids";
import type { CanonicalStreamEvent } from "../../src/types/canonical.types";

/**
 * Stream fixture corpus guard (spec §4.1): every tests/fixtures/streams/
 * <provider>/<case>.json must describe a real provider stream the decoders
 * in Tasks 4–7 will be tested against. Decoding the wire bytes themselves
 * is covered there; here we check the metadata is complete and the expected
 * canonical events are well-formed and reassemble cleanly.
 */
const STREAMS_DIR = join(__dirname, "..", "fixtures", "streams");

const WIRE_EXT: Record<Provider, string> = {
  openai: "sse",
  anthropic: "sse",
  gemini: "sse",
  ollama: "ndjson",
  responses: "sse",
};

interface StreamFixture {
  source: string;
  date: string;
  model: string;
  expectedEvents: CanonicalStreamEvent[];
  nonStreaming: unknown;
}

/**
 * Tool-call args objects from the wire bytes, in call order. Gemini and
 * Ollama send arguments as objects, so the canonical `argumentsDelta` is
 * their JSON.stringify (spec §3.3), not a wire substring.
 */
function wireToolArgs(provider: "gemini" | "ollama", text: string): unknown[] {
  const args: unknown[] = [];
  if (provider === "ollama") {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t) as {
        message?: { tool_calls?: { function?: { arguments?: unknown } }[] };
      };
      for (const tc of obj.message?.tool_calls ?? []) {
        args.push(tc.function?.arguments);
      }
    }
    return args;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).trimStart())
      .join("\n");
    if (!data) continue;
    const obj = JSON.parse(data) as {
      candidates?: {
        content?: { parts?: { functionCall?: { args?: unknown } }[] };
      }[];
    };
    for (const cand of obj.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall) args.push(part.functionCall.args);
      }
    }
  }
  return args;
}

const cases: { provider: Provider; name: string }[] = [];
for (const provider of readdirSync(STREAMS_DIR) as Provider[]) {
  const dir = join(STREAMS_DIR, provider);
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".json") && !file.endsWith(".nonstreaming.json")) {
      cases.push({ provider, name: file.slice(0, -".json".length) });
    }
  }
}

describe("stream fixture corpus", () => {
  it.each(cases)("$provider/$name fixture is well-formed", ({ provider, name }) => {
    const dir = join(STREAMS_DIR, provider);
    const fixture = JSON.parse(
      readFileSync(join(dir, `${name}.json`), "utf8"),
    ) as StreamFixture;

    const wireFile = join(dir, `${name}.${WIRE_EXT[provider]}`);
    expect(
      existsSync(wireFile),
      `${wireFile}: wire file must exist`,
    ).toBe(true);

    expect(fixture.source.length).toBeGreaterThan(0);
    expect(fixture.date.length).toBeGreaterThan(0);

    for (const [i, event] of fixture.expectedEvents.entries()) {
      const result = canonicalStreamEventSchema.safeParse(event);
      expect(
        result.success,
        `expectedEvents[${i}]: ${JSON.stringify(result.success ? {} : result.error.issues)}`,
      ).toBe(true);
    }

    if (provider === "gemini" || provider === "ollama") {
      const deltas = new Map<number, string>();
      for (const event of fixture.expectedEvents) {
        if (event.type === "tool_call_delta") {
          deltas.set(
            event.index,
            (deltas.get(event.index) ?? "") + event.argumentsDelta,
          );
        }
      }
      const concatenated = [...deltas.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, delta]) => delta);
      expect(concatenated).toEqual(
        wireToolArgs(provider, readFileSync(wireFile, "utf8")).map((args) =>
          JSON.stringify(args),
        ),
      );
    }

    if (name === "error" || fixture.expectedEvents.at(-1)?.type === "error") {
      // A fixture whose stream ends in a canonical error (named
      // "error", or responses' "failed": upstream dies mid-stream)
      // cannot reassemble — that's the assertion, not a failure.
      expect(fixture.expectedEvents.at(-1)?.type).toBe("error");
      expect(() => reassembleStream(fixture.expectedEvents)).toThrow();
      return;
    }

    let reassembled;
    expect(
      () => (reassembled = reassembleStream(fixture.expectedEvents)),
    ).not.toThrow();

    if (fixture.nonStreaming !== null && fixture.nonStreaming !== undefined) {
      const twin = adapters[provider].toCanonicalResponse(
        fixture.nonStreaming,
        fixture.model,
        sequentialIds(),
      );
      expect({
        message: reassembled!.message,
        finishReason: reassembled!.finishReason,
        usage: reassembled!.usage,
      }).toEqual({
        message: twin.message,
        finishReason: twin.finishReason,
        usage: twin.usage,
      });
    }
  });
});
