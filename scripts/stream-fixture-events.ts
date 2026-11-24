/**
 * stream-fixture-events.ts — build a stream fixture's <case>.json from
 * recorded wire bytes (see stream-fixture-decode.ts for the per-provider
 * generators and the conventions they follow).
 */
import { deepStrictEqual } from "node:assert";
import { adapters, type Provider } from "../src/transformers";
import { sequentialIds } from "../src/utils/ids";
import { reassembleStream } from "../src/utils/stream-reassemble";
import type { CanonicalStreamEvent } from "../src/types/canonical.types";
import {
  anthropicEvents,
  geminiEvents,
  ollamaEvents,
  openaiEvents,
} from "./stream-fixture-decode";

export { FixtureAmbiguity } from "./stream-fixture-decode";

export function expectedEventsFromWire(
  provider: Provider,
  wireText: string,
  model: string,
): CanonicalStreamEvent[] {
  const ids = sequentialIds();
  switch (provider) {
    case "openai":
      return openaiEvents(wireText, model, ids);
    case "anthropic":
      return anthropicEvents(wireText, model, ids);
    case "gemini":
      return geminiEvents(wireText, model, ids);
    case "ollama":
      return ollamaEvents(wireText, model, ids);
    default:
      throw new Error(`no stream-fixture decoder for provider ${provider}`);
  }
}

export interface FixtureJson {
  source: string;
  date: string;
  model: string;
  expectedEvents: CanonicalStreamEvent[];
  nonStreaming: unknown;
}

/**
 * Build a <case>.json from recorded bytes. The non-streaming twin is
 * embedded only where the current adapter's toCanonicalResponse produces
 * the same canonical message/finishReason/usage (the same check the
 * contract test applies).
 */
export function buildFixtureJson(
  provider: Provider,
  wireText: string,
  model: string,
  source: string,
  date: string,
  twinBody: unknown | undefined,
): FixtureJson {
  const expectedEvents = expectedEventsFromWire(provider, wireText, model);
  let nonStreaming: unknown = null;
  if (twinBody !== undefined) {
    try {
      const reassembled = reassembleStream(expectedEvents);
      const twin = adapters[provider].toCanonicalResponse(
        twinBody,
        model,
        sequentialIds(),
      );
      const pick = (r: {
        message: unknown;
        finishReason: unknown;
        usage?: unknown;
      }) => ({
        message: r.message,
        finishReason: r.finishReason,
        usage: r.usage,
      });
      deepStrictEqual(pick(reassembled), pick(twin));
      nonStreaming = twinBody;
    } catch {
      // reassembly or twin conversion failed, or the twin differs on
      // message/finishReason/usage — keep null
    }
  }
  return { source, date, model, expectedEvents, nonStreaming };
}
