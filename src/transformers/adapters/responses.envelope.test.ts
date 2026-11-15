import { describe, it, expect } from "vitest";
import {
  packEnvelope,
  unpackEnvelope,
  type EnvelopePayload,
} from "./responses.envelope";
import { runWithTrace } from "../../observe/context";
import { newTrace, type RequestTrace } from "../../observe/trace";
import type { CanonicalContentPart } from "../../types/canonical.types";

/**
 * v1.4 Task 8 (spec §3.3): the `bg1.` envelope carries a turn's
 * canonical reasoning parts and tool-call/text signatures, verbatim,
 * inside a `reasoning` item's `encrypted_content`.
 */

const ORIGIN = { provider: "gem", model: "gem-1" };

const PARTS: CanonicalContentPart[] = [
  {
    type: "reasoning",
    reasoning: { text: "thought about it", origin: ORIGIN },
    signature: { origin: ORIGIN, data: "sig-r1" },
  },
];

const PAYLOAD: EnvelopePayload = {
  v: 1,
  reasoning: PARTS,
  signatures: [
    { toolCallId: "call_1", signature: { origin: ORIGIN, data: "sig-c1" } },
    { textIndex: 0, signature: { origin: ORIGIN, data: "sig-t0" } },
  ],
};

/** Run `fn` inside a trace scope and return the filled trace. */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: "r1",
    startedAt: 0,
    client: "other",
    sourceApi: "responses",
  });
  runWithTrace(trace, fn);
  return trace;
}

describe("responses envelope", () => {
  it("pack/unpack round-trip", () => {
    const packed = packEnvelope(PAYLOAD);
    expect(packed).toBeDefined();
    expect(packed!.startsWith("bg1.")).toBe(true);
    expect(unpackEnvelope(packed!)).toEqual(PAYLOAD);
  });

  it("not bg1 → undefined", () => {
    expect(unpackEnvelope("opaque-upstream-blob")).toBeUndefined();
    expect(unpackEnvelope("")).toBeUndefined();
    expect(
      unpackEnvelope("enc." + Buffer.from("{}").toString("base64url")),
    ).toBeUndefined();
  });

  it("corrupt base64 → undefined, no throw", () => {
    expect(unpackEnvelope("bg1.!!!not-base64!!!")).toBeUndefined();
    expect(
      unpackEnvelope("bg1." + Buffer.from("{not json").toString("base64url")),
    ).toBeUndefined();
    // Valid JSON, wrong shape.
    expect(
      unpackEnvelope(
        "bg1." + Buffer.from(JSON.stringify({ v: 2 })).toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      unpackEnvelope(
        "bg1." +
          Buffer.from(JSON.stringify({ v: 1, reasoning: "x" })).toString(
            "base64url",
          ),
      ),
    ).toBeUndefined();
  });

  it("pack returns undefined over the 1 MB cap", () => {
    const huge: EnvelopePayload = {
      v: 1,
      reasoning: [
        {
          type: "reasoning",
          reasoning: { text: "x".repeat(1_200_000), origin: ORIGIN },
        },
      ],
      signatures: [],
    };
    expect(packEnvelope(huge)).toBeUndefined();
  });
});

describe("envelope over cap is omitted with a note", () => {
  it("a >1MB reasoning text → reasoning item without encrypted_content, note recorded", async () => {
    // Review Focus 3: the response encode emits the reasoning item
    // anyway — without `encrypted_content` — and records
    // `reasoning_dropped`/`envelope_too_large`.
    const { fromCanonicalResponse } = await import("./responses.adapter");
    const trace = traced(() => {
      const res = fromCanonicalResponse({
        id: "resp_1",
        model: "m",
        message: {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              reasoning: { text: "x".repeat(1_200_000), origin: ORIGIN },
            },
            { type: "text", text: "answer" },
          ],
        },
        finishReason: "stop",
      });
      const reasoning = (res.output as unknown as Array<Record<string, unknown>>).find(
        (i) => i.type === "reasoning",
      );
      expect(reasoning).toBeDefined();
      expect(reasoning).not.toHaveProperty("encrypted_content");
    });
    expect(
      trace.notes.some(
        (n) =>
          n.code === "reasoning_dropped" && n.path === "envelope_too_large",
      ),
    ).toBe(true);
  });
});
