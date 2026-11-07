import { describe, it, expect } from "vitest";
import type {
  CanonicalTool,
  CanonicalToolCall,
} from "../types/canonical.types";
import {
  diagnoseToolCalls,
  repairArguments,
} from "./tool-diagnostics";

/**
 * §3.7 tool-call diagnostics and the three opt-in argument repairs.
 * Diagnostics describe the ORIGINAL arguments and carry codes and
 * missing-property names only — never argument text.
 */

const tools: CanonicalTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string" },
        },
        required: ["city", "units"],
      },
    },
  },
];

function call(
  args: string,
  name = "get_weather",
  id = "call_1",
): CanonicalToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("diagnoseToolCalls (spec §3.7)", () => {
  it("invalid_json", () => {
    expect(diagnoseToolCalls([call('{"city":')], tools)).toEqual([
      {
        toolCallId: "call_1",
        name: "get_weather",
        code: "invalid_json",
      },
    ]);
  });

  it("fenced_json", () => {
    expect(
      diagnoseToolCalls(
        [call('```json\n{"city":"x","units":"c"}\n```')],
        tools,
      ),
    ).toEqual([
      {
        toolCallId: "call_1",
        name: "get_weather",
        code: "fenced_json",
      },
    ]);
  });

  it("not_object", () => {
    expect(diagnoseToolCalls([call('["x"]')], tools)).toEqual([
      {
        toolCallId: "call_1",
        name: "get_weather",
        code: "not_object",
      },
    ]);
  });

  it("unknown_tool", () => {
    expect(
      diagnoseToolCalls([call("{}", "undeclared")], tools),
    ).toEqual([
      { toolCallId: "call_1", name: "undeclared", code: "unknown_tool" },
    ]);
  });

  it("missing_required", () => {
    expect(diagnoseToolCalls([call('{"city":"x"}')], tools)).toEqual([
      {
        toolCallId: "call_1",
        name: "get_weather",
        code: "missing_required",
        detail: "units",
      },
    ]);
  });

  it("valid call has no diagnostics", () => {
    expect(
      diagnoseToolCalls([call('{"city":"x","units":"c"}')], tools),
    ).toEqual([]);
  });

  it("diagnostics never contain argument text", () => {
    const diags = [
      // The sentinel sits inside malformed arguments…
      ...diagnoseToolCalls(
        [call('{"city": "SENTINEL-ARG-7q"')],
        tools,
      ),
      // …and inside valid ones — detail only ever carries a
      // schema's property name, never an argument value.
      ...diagnoseToolCalls([call('{"city":"SENTINEL-ARG-7q"}')], tools),
    ];
    expect(diags).toHaveLength(2);
    expect(JSON.stringify(diags)).not.toContain("SENTINEL-ARG-7q");
  });
});

describe("repairArguments (spec §3.7)", () => {
  it("strip_fence", () => {
    expect(repairArguments('```json\n{"a":1}\n```')).toEqual({
      args: '{"a":1}',
      steps: ["strip_fence"],
    });
  });

  it("extract_object", () => {
    expect(repairArguments('Sure: {"a":1} done')).toEqual({
      args: '{"a":1}',
      steps: ["extract_object"],
    });
  });

  it("trailing_comma", () => {
    expect(repairArguments('{"a":1,}')).toEqual({
      args: '{"a":1}',
      steps: ["trailing_comma"],
    });
  });

  it("two objects are not repaired", () => {
    expect(repairArguments('{"a":1} {"b":2}')).toBeUndefined();
  });

  // Seeded generator in the style of stream-properties.test.ts: for
  // any input that is already valid JSON, repair must return
  // undefined — names and fields are never changed or invented.
  it("names and fields never changed (property: valid JSON → undefined)", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rand = mulberry32(seed);
      const json = JSON.stringify(genJson(rand, 3));
      expect(repairArguments(json), `seed ${seed}: ${json}`).toBeUndefined();
    }
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genJson(rand: () => number, depth: number): unknown {
  const r = rand();
  if (depth <= 0 || r < 0.3) {
    const p = rand();
    if (p < 0.25) return Math.floor(rand() * 2000) - 1000;
    if (p < 0.5) return rand() < 0.5;
    if (p < 0.75) return `s${Math.floor(rand() * 1e6)}`;
    return null;
  }
  if (r < 0.65) {
    return Array.from({ length: Math.floor(rand() * 4) }, () =>
      genJson(rand, depth - 1),
    );
  }
  return Object.fromEntries(
    Array.from({ length: Math.floor(rand() * 5) }, (_, i) => [
      `k${i}_${Math.floor(rand() * 100)}`,
      genJson(rand, depth - 1),
    ]),
  );
}
