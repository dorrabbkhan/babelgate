import { describe, it, expect } from "vitest";
import type { CanonicalStreamEvent } from "../types/canonical.types";
import { runWithTrace } from "./context";
import { newTrace, type RequestTrace } from "./trace";
import { createRepairTransform } from "./tool-repair-stream";

/**
 * §3.7 streaming repair: tool_call_deltas are held per index and
 * released as one delta (repaired when possible) before that call's
 * tool_call_end; a stream that ends mid-call releases what it held
 * unrepaired, with a diagnostic — held arguments are never lost.
 */

const started = (index: number, id: string, name: string) =>
  ({
    type: "tool_call_start",
    index,
    id,
    name,
  }) as const;

const delta = (index: number, argumentsDelta: string) =>
  ({ type: "tool_call_delta", index, argumentsDelta }) as const;

const ended = (index: number) =>
  ({ type: "tool_call_end", index }) as const;

function testTrace(): RequestTrace {
  return newTrace({
    requestId: "r1",
    startedAt: 0,
    client: "other",
    sourceApi: "openai",
  });
}

it("text streams while a call is held", () => {
  const trace = testTrace();
  const transform = createRepairTransform();
  const events: CanonicalStreamEvent[] = [
    { type: "message_start", id: "m", model: "m" },
    { type: "text_delta", text: "a" },
    started(0, "call_1", "get_weather"),
    delta(0, '{"city"'),
    { type: "text_delta", text: "b" },
    delta(0, ':"x"}'),
    ended(0),
    { type: "text_delta", text: "c" },
    { type: "message_end", finishReason: "tool_call" },
  ];
  const out = runWithTrace(trace, () => events.flatMap(transform));

  // Nothing but the held deltas is reordered: text flows through while
  // the call is open; one merged delta lands before its end.
  expect(out).toEqual([
    { type: "message_start", id: "m", model: "m" },
    { type: "text_delta", text: "a" },
    started(0, "call_1", "get_weather"),
    { type: "text_delta", text: "b" },
    delta(0, '{"city":"x"}'),
    ended(0),
    { type: "text_delta", text: "c" },
    { type: "message_end", finishReason: "tool_call" },
  ]);
  // Valid arguments are released as they came — no repair recorded.
  expect(trace.repairs).toEqual([]);
  expect(trace.diagnostics).toEqual([]);
});

// Review Focus 5: deltas of two parallel calls interleave — each
// call's held arguments release in their own order before their own
// end; a stream that ends mid-call releases what it held unrepaired
// with a diagnostic before the terminal event.
it("interleaved and truncated calls with repair on", () => {
  const trace = testTrace();
  const transform = createRepairTransform();
  const events: CanonicalStreamEvent[] = [
    { type: "message_start", id: "m", model: "m" },
    started(0, "call_0", "t0"),
    started(1, "call_1", "t1"),
    delta(0, '```json\n{"a":'),
    delta(1, 'prefix {"b":1} suffix'),
    delta(0, "1}\n```"),
    ended(0),
    // call 1 never ends — the upstream dies mid-call.
    {
      type: "error",
      error: {
        kind: "upstream",
        status: 502,
        message: "upstream broke",
      },
    },
  ];
  const out = runWithTrace(trace, () => events.flatMap(transform));

  expect(out).toEqual([
    { type: "message_start", id: "m", model: "m" },
    started(0, "call_0", "t0"),
    started(1, "call_1", "t1"),
    // call 0 released repaired as ONE delta before its own end,
    // in its own argument order.
    delta(0, '{"a":1}'),
    ended(0),
    // call 1's held text is released unrepaired before the error —
    // a truncated stream gets no repair pass (extract_object would
    // have fixed it had the call ended normally).
    delta(1, 'prefix {"b":1} suffix'),
    {
      type: "error",
      error: { kind: "upstream", status: 502, message: "upstream broke" },
    },
  ]);
  expect(trace.repairs).toEqual([
    { toolCallId: "call_0", steps: ["strip_fence"] },
  ]);
  // The held call gets its diagnostic before the terminal event —
  // never silently lost.
  expect(trace.diagnostics).toEqual([
    { toolCallId: "call_1", name: "t1", code: "invalid_json" },
  ]);
});
