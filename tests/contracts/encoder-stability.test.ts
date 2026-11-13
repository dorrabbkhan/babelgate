import { describe, it, expect } from "vitest";
import { adapters, type Provider } from "../../src/transformers";
import type {
  CanonicalCacheHint,
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalToolCall,
} from "../../src/types/canonical.types";

/**
 * Request-encoder stability properties (spec §3.2 "Byte-stable
 * prefixes", §4.1): for each of the 4 encoders,
 *
 * (a) "deterministic" — the same canonical input yields identical
 *     bytes, with no timestamps, random ids or unstable key order:
 *     JSON.stringify(encode(r)) === JSON.stringify(encode(clone(r))).
 *
 * (b) "earlier messages stable when a turn is appended" — encoding
 *     r + one turn leaves the encoded form of every earlier message
 *     deep-equal: encode(r).messages[0..n-1] (Gemini: contents)
 *     deep-equals encode(r + turn).messages[0..n-1], including
 *     tool-call/tool-result pairs inside r.
 *
 * Requests come from a seeded mulberry32 generator in the style of
 * stream-properties.test.ts; the case seed is printed on failure.
 * Two generator rules keep the properties honest rather than
 * weakened: generated requests carry at most 4 cache hints (the
 * Anthropic 4-breakpoint cap drops the earliest — a hinted appended
 * turn could legitimately push one out, which is the cap's designed
 * behaviour, not encoder instability), and appended turns are
 * user/assistant messages — a bare tool message is not a "turn" and
 * Anthropic merges it into the previous tool-result user message,
 * a wire rule, not a stability violation.
 */

const SEED = 0xec0d;
const CASES_PER_PROVIDER = 100;
const PROVIDERS: Provider[] = ["openai", "anthropic", "gemini", "ollama"];

const MESSAGE_FIELD: Record<Provider, "messages" | "contents" | "input"> = {
  openai: "messages",
  anthropic: "messages",
  ollama: "messages",
  gemini: "contents",
  responses: "input",
};

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

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)] as T;
}

const TEXT_POOL = ["Hi", " there", "é", "😀", ".\n\n", "Paris"];
const NAME_POOL = ["get_weather", "sum", "lookup_user"];
const ARGS_POOL = [
  '{"location":"Paris"}',
  '{"a":2,"b":3}',
  "{}",
  "not json",
];
const MIME_POOL = ["image/png", "image/jpeg", "image/webp"] as const;

interface GenState {
  /** Call ids from earlier assistant messages a tool message may reference. */
  pending: string[];
  /** Cache hints remaining — capped at 4 so Anthropic's cap never fires. */
  hintsLeft: number;
  callSeq: number;
}

function genHint(
  rand: () => number,
  st: GenState,
): CanonicalCacheHint | undefined {
  if (st.hintsLeft <= 0 || rand() >= 0.2) return undefined;
  st.hintsLeft--;
  return rand() < 0.3 ? { ttl: "1h" } : {};
}

function genPart(rand: () => number, st: GenState): CanonicalContentPart {
  const cache = genHint(rand, st);
  if (rand() < 0.15) {
    return {
      type: "image",
      image: {
        data: "aGk=",
        mimeType: pick(rand, MIME_POOL),
      },
      ...(cache && { cache }),
    };
  }
  return {
    type: "text",
    text: pick(rand, TEXT_POOL),
    ...(cache && { cache }),
  };
}

function genTextPart(rand: () => number, st: GenState): CanonicalContentPart {
  const cache = genHint(rand, st);
  return {
    type: "text",
    text: pick(rand, TEXT_POOL),
    ...(cache && { cache }),
  };
}

function genContent(
  rand: () => number,
  st: GenState,
): string | CanonicalContentPart[] {
  if (rand() < 0.55) return pick(rand, TEXT_POOL);
  return Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
    genPart(rand, st),
  );
}

function genCall(
  rand: () => number,
  st: GenState,
  n: number,
): CanonicalToolCall {
  const call: CanonicalToolCall = {
    id: `call_${n}_${st.callSeq++}`,
    type: "function",
    function: {
      name: pick(rand, NAME_POOL),
      arguments: pick(rand, ARGS_POOL),
    },
  };
  st.pending.push(call.id);
  return call;
}

function genMessage(
  rand: () => number,
  st: GenState,
  n: number,
): CanonicalMessage {
  const options = ["user", "user", "assistant"] as const;
  const role =
    st.pending.length > 0 && rand() < 0.3 ? "tool" : pick(rand, options);

  if (role === "assistant") {
    const calls =
      rand() < 0.4
        ? Array.from({ length: 1 + Math.floor(rand() * 2) }, () =>
            genCall(rand, st, n),
          )
        : [];
    return {
      role: "assistant",
      content: genContent(rand, st),
      ...(calls.length > 0 && { toolCalls: calls }),
    };
  }
  if (role === "tool") {
    const toolCallId = st.pending.splice(
      Math.floor(rand() * st.pending.length),
      1,
    )[0]!;
    return {
      role: "tool",
      toolCallId,
      content: pick(rand, TEXT_POOL),
      ...(rand() < 0.1 && { isError: true }),
    };
  }
  return { role: "user", content: genContent(rand, st) };
}

/** A random valid canonical request every encoder accepts. */
function generateRequest(rand: () => number, n: number): CanonicalRequest {
  const st: GenState = { pending: [], hintsLeft: 4, callSeq: 0 };
  const request: CanonicalRequest = {
    model: "m",
    messages: [],
  };

  // Optional system prompt, mirrored into a leading system message
  // the way the decoders produce it; parts are text-only (schema).
  const sys = rand();
  if (sys < 0.3) {
    request.systemPrompt = pick(rand, TEXT_POOL);
    request.messages.push({ role: "system", content: request.systemPrompt });
  } else if (sys < 0.55) {
    const parts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
      genTextPart(rand, st),
    );
    request.systemPrompt = parts;
    request.messages.push({ role: "system", content: parts });
  }

  for (let i = 0; i < 1 + Math.floor(rand() * 5); i++) {
    request.messages.push(genMessage(rand, st, n));
  }

  if (rand() < 0.4) {
    request.tools = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
      const cache = genHint(rand, st);
      return {
        type: "function" as const,
        function: {
          name: pick(rand, NAME_POOL),
          description: pick(rand, TEXT_POOL),
          parameters: { type: "object" },
        },
        ...(cache && { cache }),
      };
    });
  }

  if (rand() < 0.5) {
    request.config = {
      ...(rand() < 0.7 && { temperature: Math.floor(rand() * 20) / 10 }),
      ...(rand() < 0.7 && { maxTokens: 1 + Math.floor(rand() * 4000) }),
      ...(rand() < 0.3 && { seed: Math.floor(rand() * 1000) }),
    };
  }

  if (rand() < 0.3) request.stream = true;
  return request;
}

/** A user or assistant turn — never a bare tool message, never hinted. */
function generateTurn(rand: () => number): CanonicalMessage {
  if (rand() < 0.3) {
    const calls = Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, i) => ({
      id: `call_turn_${i}`,
      type: "function" as const,
      function: {
        name: pick(rand, NAME_POOL),
        arguments: pick(rand, ARGS_POOL),
      },
    }));
    return {
      role: "assistant",
      content: rand() < 0.5 ? pick(rand, TEXT_POOL) : "",
      toolCalls: calls,
    };
  }
  return {
    role: "user",
    content:
      rand() < 0.5
        ? pick(rand, TEXT_POOL)
        : [{ type: "text", text: pick(rand, TEXT_POOL) }],
  };
}

function encode(provider: Provider, r: CanonicalRequest): Record<string, unknown> {
  return adapters[provider].fromCanonicalRequest(r) as Record<
    string,
    unknown
  >;
}

const cases = PROVIDERS.flatMap((provider) =>
  Array.from({ length: CASES_PER_PROVIDER }, (_, i) => ({
    provider,
    i,
    seed: SEED + PROVIDERS.indexOf(provider) * CASES_PER_PROVIDER + i,
  })),
);

describe("request encoder stability (spec §3.2)", () => {
  it.each(cases)("$provider deterministic (case $i)", ({ provider, i, seed }) => {
    const rand = mulberry32(seed);
    const request = generateRequest(rand, i);

    const a = JSON.stringify(encode(provider, request));
    const b = JSON.stringify(encode(provider, structuredClone(request)));

    expect(b, `seed ${seed}: encode(clone) must equal encode(r)`).toBe(a);
  });

  it.each(cases)(
    "$provider earlier messages stable when a turn is appended (case $i)",
    ({ provider, i, seed }) => {
      const rand = mulberry32(seed);
      const request = generateRequest(rand, i);
      const turn = generateTurn(rand);
      const appended: CanonicalRequest = {
        ...structuredClone(request),
        messages: [...request.messages, turn],
      };

      const field = MESSAGE_FIELD[provider];
      const before = encode(provider, request)[field] as unknown[];
      const after = encode(provider, appended)[field] as unknown[];

      expect(
        after.slice(0, before.length),
        `seed ${seed}: appended turn changed an earlier encoded message`,
      ).toEqual(before);
    },
  );
});
