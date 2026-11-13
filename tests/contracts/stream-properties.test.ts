import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters, type Provider } from "../../src/transformers";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import { parseToolArguments } from "../../src/utils/tool-args";
import { sequentialIds } from "../../src/utils/ids";
import { estimateInputTokens } from "../../src/utils/token-estimate";
import type {
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalUsage,
} from "../../src/types/canonical.types";

/**
 * Stream round-trip properties (spec §4.4):
 *
 * (a) "<provider> decode(encode(events)) equals events" — 200 random
 *     valid event sequences per adapter from a seeded mulberry32
 *     generator (the case seed is printed on failure). The decoded
 *     events are compared EVENT BY EVENT against
 *     `wireNormalForm(provider, events)` — the exact sequence that
 *     provider's wire can carry, since wires differ in what they can
 *     express:
 *       - Anthropic buffers each call's arguments and writes one
 *         normalized JSON delta at tool_call_end — the plan's
 *         documented exception;
 *       - Ollama and Gemini likewise buffer per canonical index and
 *         emit each call whole at tool_call_end;
 *       - OpenAI has no wire position for tool_call_end (its decoder
 *         closes calls at the finish chunk), emits usage at [DONE]
 *         regardless of the event's position, and cannot carry an
 *         empty-string arguments delta;
 *       - Ollama has no message id — its decoder generates one
 *         ("call_0" under sequentialIds) — and always reports usage.
 *     The reassembled {message, finishReason, usage} is asserted too,
 *     as an additional end-to-end check; tool arguments compare in
 *     wire form (the raw JSON string for OpenAI, the
 *     parseToolArguments-normalized object for the others — the same
 *     rule the encoders apply, including the `_invalid_arguments`
 *     wrapper).
 *
 * (b) "<provider>/<case> stream reassembles to the non-streaming twin"
 *     — for every fixture carrying a `nonStreaming` body, decoding the
 *     wire bytes and reassembling equals `toCanonicalResponse` of the
 *     twin on message, finishReason and usage.
 */
const STREAMS_DIR = join(__dirname, "..", "fixtures", "streams");

const WIRE_EXT: Record<Provider, string> = {
  openai: "sse",
  anthropic: "sse",
  gemini: "sse",
  ollama: "ndjson",
  responses: "sse",
};

const SEED = 0x5eed;
const CASES_PER_PROVIDER = 200;
const PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "responses",
];

/** Seeded generator — small fast PRNG, deterministic per run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCE_REQUESTS: Record<
  Provider,
  { sourceRequest: unknown; query: Record<string, string> }
> = {
  openai: {
    sourceRequest: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    },
    query: {},
  },
  anthropic: {
    sourceRequest: {
      model: "m",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    query: {},
  },
  gemini: {
    sourceRequest: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    query: { alt: "sse" },
  },
  ollama: {
    sourceRequest: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    query: {},
  },
  responses: {
    sourceRequest: {
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      stream: true,
    },
    query: {},
  },
};

const TEXT_POOL = [
  "Hi",
  " there",
  "é",
  "😀",
  ".\n\n",
  "Paris",
  " 15",
  "°C",
  "…",
];
const NAME_POOL = ["get_weather", "sum", "lookup_user"];
const ARGS_POOL = [
  '{"location":"Paris"}',
  '{"a":2,"b":3}',
  "{}",
  // "" exercises the empty-arguments edge (Review Focus 5):
  // Anthropic/Gemini/Ollama clients must get {}.
  "",
  '{"city":"Berlin","ok":true,"tags":["x","y"]}',
  "not json",
  "[1,2]",
];

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)] as T;
}

/** Split a string into 1–3 non-empty fragments at random points. */
function splitIntoFragments(rand: () => number, s: string): string[] {
  if (s === "") return [""];
  const count = Math.min(s.length, 1 + Math.floor(rand() * 3));
  const cuts = new Set<number>();
  while (cuts.size < count - 1) {
    cuts.add(1 + Math.floor(rand() * (s.length - 1)));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const fragments: string[] = [];
  let prev = 0;
  for (const c of sorted) {
    fragments.push(s.slice(prev, c));
    prev = c;
  }
  fragments.push(s.slice(prev));
  return fragments;
}

/**
 * One random valid canonical event sequence (spec §3.1): message_start,
 * then any mix of text deltas and 0–3 tool calls whose argument deltas
 * may interleave, optional usage, then message_end. Tool-call ends stay
 * in index order — every adapter emits wire calls in tool_call_end
 * order, so an out-of-order end would renumber the decoded calls
 * (a wire limitation, not a canonical one). A call's own deltas always
 * precede its end.
 */
function generateEvents(
  rand: () => number,
  provider: Provider,
  n: number,
): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [
    { type: "message_start", id: `msg_${provider}_${n}`, model: "m" },
  ];

  const calls = Array.from(
    { length: Math.floor(rand() * 4) },
    (_, i) => ({
      id: `call_${provider}_${n}_${i}`,
      name: pick(rand, NAME_POOL),
      fragments: splitIntoFragments(rand, pick(rand, ARGS_POOL)),
    }),
  );
  const texts = Array.from({ length: Math.floor(rand() * 5) }, () =>
    pick(rand, TEXT_POOL),
  );

  const remaining = calls.map((c) => c.fragments.length);
  let started = 0;
  let ended = 0;
  let t = 0;
  for (;;) {
    const options: string[] = [];
    if (t < texts.length) options.push("text", "text");
    if (started < calls.length) options.push("start");
    // Any open call may emit its next fragment — deltas interleave.
    const ready = calls
      .map((_, i) => i)
      .filter((i) => i >= ended && i < started && remaining[i] > 0);
    if (ready.length > 0) options.push("delta");
    if (ended < started && remaining[ended] === 0) options.push("end");
    if (options.length === 0) break;
    switch (pick(rand, options)) {
      case "text":
        events.push({ type: "text_delta", text: texts[t++] });
        break;
      case "start": {
        const call = calls[started];
        events.push({
          type: "tool_call_start",
          index: started,
          id: call.id,
          name: call.name,
        });
        started++;
        break;
      }
      case "delta": {
        const i = pick(rand, ready);
        events.push({
          type: "tool_call_delta",
          index: i,
          argumentsDelta: calls[i].fragments[
            calls[i].fragments.length - remaining[i]
          ],
        });
        remaining[i]--;
        break;
      }
      default:
        events.push({ type: "tool_call_end", index: ended });
        ended++;
    }
  }

  // Usage is optional; anthropic/ollama wire streams always carry
  // counts (their decoders emit a usage event even when the encoder
  // saw none), so the generated sequence always includes one there.
  const withUsage =
    provider === "anthropic" || provider === "ollama"
      ? true
      : rand() < 0.75;
  if (withUsage) {
    const inputTokens = Math.floor(rand() * 2000);
    const outputTokens = Math.floor(rand() * 500);
    // Anthropic/Ollama recompute the total from the parts — keep the
    // generated triple internally consistent.
    events.push({
      type: "usage",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    });
  }
  events.push({
    type: "message_end",
    finishReason:
      calls.length > 0 ? "tool_call" : rand() < 0.8 ? "stop" : "length",
  });
  return events;
}

function encode(provider: Provider, events: CanonicalStreamEvent[]): string {
  const { sourceRequest, query } = SOURCE_REQUESTS[provider];
  const encoder = adapters[provider].createStreamEncoder({
    sourceRequest,
    query,
    requestedModel: "m",
  });
  let out = "";
  for (const event of events) out += encoder.encode(event);
  return out + encoder.end();
}

/** Decode the whole wire reply, split into up to three byte chunks. */
function decode(
  provider: Provider,
  wire: string,
  rand: () => number,
): CanonicalStreamEvent[] {
  const decoder = adapters[provider].createStreamDecoder(
    "m",
    sequentialIds(),
  );
  const bytes = new TextEncoder().encode(wire);
  const events: CanonicalStreamEvent[] = [];
  const cuts = [
    ...new Set([
      0,
      bytes.length,
      Math.floor(rand() * (bytes.length + 1)),
      Math.floor(rand() * (bytes.length + 1)),
    ]),
  ].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    events.push(...decoder.feed(bytes.subarray(cuts[i], cuts[i + 1])));
  }
  events.push(...decoder.end());
  return events;
}

// ---------- wire normal forms ----------
//
// `wireNormalForm(provider, events)` rewrites a generated event
// sequence into the exact sequence that provider's wire can carry —
// what `decode(encode(events))` must equal, event by event. Each
// rewrite below names the encoder/decoder line it comes from and is a
// genuine wire limitation: message ids (except Ollama's), text-delta
// boundaries, interleaved tool deltas, ids, names and raw argument
// strings round-trip verbatim.

/** What the decoder emits as the terminal `usage` event. */
function decodedUsage(
  provider: Provider,
  usage: CanonicalUsage | undefined,
): CanonicalUsage | undefined {
  switch (provider) {
    case "anthropic": {
      // The decoder always emits usage at message_stop: input_tokens
      // comes from the encoded `usage` event's message_delta field,
      // or — when no usage event was encoded — from the message_start
      // estimate the encoder writes (anthropic.stream.ts:
      // `usage: { input_tokens: estimatedInput, ... }` on
      // message_start; `input_tokens` on message_delta only
      // `...(usage && ...)`). output_tokens is always written
      // (`usage?.outputTokens ?? 0`).
      const input = usage?.inputTokens ?? ANTHROPIC_ESTIMATED_INPUT;
      const output = usage?.outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      };
    }
    case "ollama": {
      // The decoder always emits usage on `done: true`
      // (ollama.stream.ts handleObject); the encoder's done line
      // carries `usage?.inputTokens ?? 0` / `usage?.outputTokens ?? 0`.
      const input = usage?.inputTokens ?? 0;
      const output = usage?.outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      };
    }
    default:
      // OpenAI/Gemini emit usage only when the sequence carried one
      // (openai: the `choices: []` usage chunk is held into [DONE];
      // gemini: usageMetadata is attached to the finish element only
      // when `usage !== undefined`).
      return usage;
  }
}

/**
 * Collapse each generated tool call into the three events the wire
 * carries. Anthropic, Gemini and Ollama all buffer `id`/`name`/
 * concatenated `argumentsDelta`s keyed by canonical `index` until
 * `tool_call_end`, then write the whole call at once — the plan's
 * named exception (anthropic.stream.ts `case "tool_call_end"`:
 * content_block_start{tool_use} + ONE input_json_delta whose
 * `partial_json` is `JSON.stringify(parsed.args)` +
 * content_block_stop; gemini.stream.ts `toolCallChunk`: one
 * functionCall element with `args: parsed.args`; ollama.stream.ts
 * `toolCallLine`: one message.tool_calls line with `arguments:
 * parsed.args`). Their decoders emit start + one delta + end at that
 * position, the delta being `JSON.stringify(parseToolArguments(args).args)`
 * for all three. Non-tool events between a call's start and end stay
 * in their order before the collapsed group; `usage` is held into the
 * terminal event in all three encoders (`case "usage"` stores it and
 * returns "") and emitted just before `message_end`.
 */
function collapseBufferedCalls(
  events: CanonicalStreamEvent[],
): { out: CanonicalStreamEvent[]; usage: CanonicalUsage | undefined } {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const out: CanonicalStreamEvent[] = [];
  let usage: CanonicalUsage | undefined;
  for (const event of events) {
    switch (event.type) {
      case "tool_call_start":
        calls.set(event.index, {
          id: event.id,
          name: event.name,
          args: "",
        });
        break;
      case "tool_call_delta": {
        const call = calls.get(event.index);
        if (call) call.args += event.argumentsDelta;
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.index);
        if (!call) break;
        calls.delete(event.index);
        out.push(
          {
            type: "tool_call_start",
            index: event.index,
            id: call.id,
            name: call.name,
          },
          {
            type: "tool_call_delta",
            index: event.index,
            argumentsDelta: JSON.stringify(
              parseToolArguments(call.args).args,
            ),
          },
          event,
        );
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      default:
        out.push(event);
    }
  }
  return { out, usage };
}

// The input-token count Anthropic's decoder reports when the sequence
// carried no usage event: the encoder stamps the locally estimated
// input tokens of the client's request into message_start.usage
// (anthropic.stream.ts, `estimateInputTokens(toCanonicalRequest(
// ctx.sourceRequest))`).
const ANTHROPIC_ESTIMATED_INPUT = estimateInputTokens(
  adapters.anthropic.toCanonicalRequest(
    SOURCE_REQUESTS.anthropic.sourceRequest,
  ),
);

/**
 * The exact canonical event sequence `decode(encode(events))`
 * produces per provider — only what the wire genuinely cannot carry
 * is normalised:
 * - openai: `tool_call_end` encodes to nothing (openai.stream.ts
 *   `case "tool_call_end": return ""`); the decoder closes every open
 *   call in start order at the finish chunk (`closeAll` in
 *   handleChunk on `choice.finish_reason`), so ends collect just
 *   before the trailing usage/message_end. `usage` is held by the
 *   decoder and emitted at `[DONE]` (handleLine), so it sits just
 *   before `message_end`, after the ends. A `tool_call_delta` with
 *   `argumentsDelta: ""` is dropped: the decoder only emits a delta
 *   for a non-empty `function.arguments` string
 *   (`tc.function.arguments.length > 0`), and an empty delta leaves
 *   the concatenated arguments unchanged — the wire cannot carry it.
 * - anthropic/gemini/ollama: each call collapses to
 *   [tool_call_start, one tool_call_delta, tool_call_end] at the
 *   position of its `tool_call_end` (see collapseBufferedCalls);
 *   usage is emitted just before `message_end` per decodedUsage.
 * - ollama additionally has no message id on the wire: the decoder
 *   generates one (`id: ids()` in ollama.stream.ts handleObject →
 *   "call_0" under sequentialIds).
 */
/**
 * Responses wire normal form: like the buffered adapters the encoder
 * serialises each call as one output item emitted at its
 * `tool_call_end` (output items never interleave on the wire), but
 * Responses arguments are a raw wire string — the single
 * `function_call_arguments.delta` carries the concatenated
 * `argumentsDelta`s verbatim (no parseToolArguments normalisation),
 * and an empty-arguments call emits no delta at all. `usage` is held
 * into `response.completed`, so it lands just before `message_end`.
 * Text deltas and the message id round-trip verbatim.
 */
function collapseResponsesCalls(
  events: CanonicalStreamEvent[],
): { out: CanonicalStreamEvent[]; usage: CanonicalUsage | undefined } {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const out: CanonicalStreamEvent[] = [];
  let usage: CanonicalUsage | undefined;
  for (const event of events) {
    switch (event.type) {
      case "tool_call_start":
        calls.set(event.index, {
          id: event.id,
          name: event.name,
          args: "",
        });
        break;
      case "tool_call_delta": {
        const call = calls.get(event.index);
        if (call) call.args += event.argumentsDelta;
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.index);
        if (!call) break;
        calls.delete(event.index);
        out.push({
          type: "tool_call_start",
          index: event.index,
          id: call.id,
          name: call.name,
        });
        if (call.args !== "") {
          out.push({
            type: "tool_call_delta",
            index: event.index,
            argumentsDelta: call.args,
          });
        }
        out.push(event);
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      default:
        out.push(event);
    }
  }
  return { out, usage };
}

function wireNormalForm(
  provider: Provider,
  events: CanonicalStreamEvent[],
): CanonicalStreamEvent[] {
  if (provider === "responses") {
    const { out, usage } = collapseResponsesCalls(events);
    const endAt = out.findIndex((e) => e.type === "message_end");
    if (usage) out.splice(endAt, 0, { type: "usage", usage });
    return out;
  }

  if (provider === "openai") {
    const startOrder: number[] = [];
    const endByIndex = new Map<number, CanonicalStreamEvent>();
    const out: CanonicalStreamEvent[] = [];
    let usage: CanonicalStreamEvent | undefined;
    for (const event of events) {
      switch (event.type) {
        case "tool_call_start":
          startOrder.push(event.index);
          out.push(event);
          break;
        case "tool_call_delta":
          if (event.argumentsDelta !== "") out.push(event);
          break;
        case "tool_call_end":
          endByIndex.set(event.index, event);
          break;
        case "usage":
          usage = event;
          break;
        default:
          out.push(event);
      }
    }
    const tail = startOrder
      .map((index) => endByIndex.get(index))
      .filter((e): e is CanonicalStreamEvent => e !== undefined);
    if (usage) tail.push(usage);
    const endAt = out.findIndex((e) => e.type === "message_end");
    out.splice(endAt, 0, ...tail);
    return out;
  }

  const { out, usage } = collapseBufferedCalls(events);
  const usageEvent = decodedUsage(provider, usage);
  const endAt = out.findIndex((e) => e.type === "message_end");
  if (usageEvent) {
    out.splice(endAt, 0, { type: "usage", usage: usageEvent });
  }
  if (provider === "ollama") {
    const first = out[0];
    if (first?.type === "message_start") {
      out[0] = { ...first, id: "call_0" };
    }
  }
  return out;
}

/** The reply shape the round-trip must preserve (see file header). */
function normalized(response: CanonicalResponse, provider: Provider) {
  return {
    message: {
      role: response.message.role,
      content: response.message.content,
      toolCalls: (response.message.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments:
          provider === "openai" || provider === "responses"
            ? tc.function.arguments
            : JSON.stringify(
                parseToolArguments(tc.function.arguments).args,
              ),
      })),
    },
    finishReason: response.finishReason,
    usage: response.usage,
  };
}

const cases = PROVIDERS.flatMap((provider) =>
  Array.from({ length: CASES_PER_PROVIDER }, (_, i) => ({
    provider,
    i,
    seed: SEED + PROVIDERS.indexOf(provider) * CASES_PER_PROVIDER + i,
  })),
);

describe("stream round-trip properties", () => {
  it.each(cases)(
    "$provider decode(encode(events)) equals events (case $i)",
    ({ provider, i, seed }) => {
      const rand = mulberry32(seed);
      const events = generateEvents(rand, provider, i);
      const wire = encode(provider, events);
      const decodedEvents = decode(provider, wire, rand);

      const first = decodedEvents[0];
      expect(first?.type, `seed ${seed}: first event`).toBe(
        "message_start",
      );
      if (first?.type === "message_start") {
        expect(first.model, `seed ${seed}: requested model`).toBe("m");
        // Ollama has no message id on the wire — its decoder generates
        // one (sequentialIds → "call_0"); the others echo the event id.
        expect(first.id, `seed ${seed}: message id`).toBe(
          provider === "ollama"
            ? "call_0"
            : (events[0] as { id: string }).id,
        );
      }

      // Event-by-event: decode(encode(events)) must equal exactly what
      // this wire can carry (see wireNormalForm for each rewrite and
      // the encoder/decoder line it comes from).
      expect(
        decodedEvents,
        `seed ${seed}: decoded events must equal ` +
          `wireNormalForm(${provider}, events)`,
      ).toEqual(wireNormalForm(provider, events));

      // Additional end-to-end check: the reassembled reply is equal too.
      const expected = reassembleStream(events);
      const actual = reassembleStream(decodedEvents);
      expect(
        normalized(actual, provider),
        `seed ${seed}: decoded stream must reassemble to the same ` +
          `message/finishReason/usage`,
      ).toEqual(normalized(expected, provider));
    },
  );
});

// ===== (b) recorded streams vs their non-streaming twins =====

interface StreamFixture {
  model: string;
  expectedEvents: CanonicalStreamEvent[];
  nonStreaming?: unknown;
}

const twinCases: { provider: Provider; name: string; fixture: StreamFixture }[] =
  [];
for (const provider of PROVIDERS) {
  const dir = join(STREAMS_DIR, provider);
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".json") && !file.endsWith(".nonstreaming.json")) {
      const fixture = JSON.parse(
        readFileSync(join(dir, file), "utf8"),
      ) as StreamFixture;
      if (fixture.nonStreaming != null) {
        twinCases.push({
          provider,
          name: file.slice(0, -".json".length),
          fixture,
        });
      }
    }
  }
}

describe("stream vs non-streaming twin", () => {
  it.each(twinCases)(
    "$provider/$name stream reassembles to the non-streaming twin",
    ({ provider, name, fixture }) => {
      const bytes = readFileSync(
        join(STREAMS_DIR, provider, `${name}.${WIRE_EXT[provider]}`),
      );
      const decoder = adapters[provider].createStreamDecoder(
        fixture.model,
        sequentialIds(),
      );
      const events = [...decoder.feed(bytes), ...decoder.end()];
      const reassembled = reassembleStream(events);
      const twin = adapters[provider].toCanonicalResponse(
        fixture.nonStreaming,
        fixture.model,
        sequentialIds(),
      );
      expect({
        message: reassembled.message,
        finishReason: reassembled.finishReason,
        usage: reassembled.usage,
      }).toEqual({
        message: twin.message,
        finishReason: twin.finishReason,
        usage: twin.usage,
      });
    },
  );
});
