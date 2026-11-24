import { describe, expect, it } from "vitest";
import { scenarios as multiTurnReasoning } from "./multi-turn-reasoning";
import { scenarios as thinkingAfterTool } from "./thinking-after-tool";
import type { TurnResult } from "./types";

/**
 * Item-shape regression for the Responses scenario turns (v1.6 Task
 * 13d). The Responses API's `input` array items are objects — the
 * scenarios used to send user text as bare strings inside the array,
 * which babelgate's decoder drops with a `field_dropped` note
 * (`src/transformers/adapters/responses.items.ts`), leaving the
 * upstream request with no user question after turn 1. Every
 * Responses user turn is now a message item
 * `{role: "user", content: "<text>"}` — the shape a real Codex
 * client sends.
 */
const RESPONSES_SCENARIOS = [...thinkingAfterTool, ...multiTurnReasoning].filter(
  (s) => s.client === "responses",
);

/** A stand-in prior-turn history for function turns: an empty body
 * reassembles to no output items, so the turn still produces its
 * user items (and a `call_unknown` tool output where one is needed). */
function stubPrev(count: number): TurnResult[] {
  return Array.from({ length: count }, (_, i) => ({
    turn: i + 1,
    status: 200,
    body: "",
    sseEvents: [],
    upstream: [],
  }));
}

describe("responses scenario input items (v1.6 Task 13d)", () => {
  it("responses scenario turns send user text as message items", () => {
    expect(RESPONSES_SCENARIOS.length).toBeGreaterThan(0);
    const firstItems: unknown[] = [];
    for (const scenario of RESPONSES_SCENARIOS) {
      for (const turn of scenario.turns) {
        const request =
          typeof turn.request === "function"
            ? turn.request(stubPrev(3))
            : turn.request;
        const input = (request as { input?: unknown }).input;
        expect(
          Array.isArray(input),
          `${scenario.name}: input is not an array`,
        ).toBe(true);
        for (const [index, item] of (input as unknown[]).entries()) {
          expect(
            typeof item === "object" && item !== null,
            `${scenario.name}: input[${index}] is not a message item`,
          ).toBe(true);
        }
        firstItems.push((input as unknown[])[0]);
      }
    }
    // The first user item every Responses turn opens with: the
    // question as a message item, never a bare string.
    expect(firstItems[0]).toEqual({
      role: "user",
      content: "What is the weather in Paris?",
    });
  });
});
