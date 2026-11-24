import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientStreamHasReasoningBeforeText,
  upstreamResponseHasReasoning,
} from "./client";
import type { TurnResult } from "./types";

/**
 * Unit tests for the reasoning-detection helpers (v1.6 Task 13b fix
 * round 3). The client-side rule may only require a gateway to
 * surface reasoning the upstream actually sent in that turn, so the
 * verdict needs to know whether the upstream response carried
 * reasoning — read from the recorded replay bytes in mock mode.
 */
const REPLAYS = join(__dirname, "..", "replays");

function replay(name: string): string {
  return readFileSync(join(REPLAYS, name), "utf8");
}

function turn(body: string): TurnResult {
  return { turn: 1, status: 200, body, sseEvents: [], upstream: [] };
}

describe("upstreamResponseHasReasoning", () => {
  it("detects Chat reasoning deltas in the recorded openai SSE", () => {
    expect(
      upstreamResponseHasReasoning(replay("openai/reasoning.sse"), "openai"),
    ).toBe(true);
    expect(
      upstreamResponseHasReasoning(
        replay("openai/reasoning_tool_call.sse"),
        "openai",
      ),
    ).toBe(true);
  });

  it("is false on the recorded openai tool_call stream (no reasoning)", () => {
    expect(
      upstreamResponseHasReasoning(replay("openai/tool_call.sse"), "openai"),
    ).toBe(false);
  });

  it("detects Gemini thought parts and thoughtSignature in the recorded SSE", () => {
    expect(
      upstreamResponseHasReasoning(replay("gemini/thinking.sse"), "gemini"),
    ).toBe(true);
    expect(
      upstreamResponseHasReasoning(
        replay("gemini/thinking_tool_call.sse"),
        "gemini",
      ),
    ).toBe(true);
  });

  it("detects reasoning in a non-streaming Chat JSON body", () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "chain",
          },
          finish_reason: "stop",
        },
      ],
    });
    expect(upstreamResponseHasReasoning(body, "openai")).toBe(true);
  });

  it("detects thoughtSignature in a non-streaming Gemini JSON body", () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "ok" },
              { functionCall: { name: "f", args: {} }, thoughtSignature: "sig" },
            ],
          },
        },
      ],
    });
    expect(upstreamResponseHasReasoning(body, "gemini")).toBe(true);
  });

  it("is false when the fields are empty or absent", () => {
    expect(
      upstreamResponseHasReasoning(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi", reasoning: "" },
              finish_reason: "stop",
            },
          ],
        }),
        "openai",
      ),
    ).toBe(false);
    expect(
      upstreamResponseHasReasoning(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "hi", thought: false }],
              },
            },
          ],
        }),
        "gemini",
      ),
    ).toBe(false);
  });
});

describe("clientStreamHasReasoningBeforeText", () => {
  const ANTHROPIC_SIGNED_THINKING =
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n';

  const ANTHROPIC_TEXT =
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n';

  const ANTHROPIC_TOOL_USE =
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}\n\n';

  it("anthropic: signed thinking block before text passes", () => {
    expect(
      clientStreamHasReasoningBeforeText(
        turn(ANTHROPIC_SIGNED_THINKING + ANTHROPIC_TEXT),
        "anthropic",
      ),
    ).toBe(true);
  });

  it(
    "anthropic: a signature-carrying thinking block right after its " +
      "tool_use passes (the Gemini tool-call thoughtSignature shape)",
    () => {
      expect(
        clientStreamHasReasoningBeforeText(
          turn(
            ANTHROPIC_TOOL_USE +
              ANTHROPIC_SIGNED_THINKING.replaceAll('"index":0', '"index":1'),
          ),
          "anthropic",
        ),
      ).toBe(true);
    },
  );

  it("anthropic: an unsigned thinking block after tool_use fails", () => {
    const unsignedThinking =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"…"}}\n\n';
    expect(
      clientStreamHasReasoningBeforeText(
        turn(ANTHROPIC_TOOL_USE + unsignedThinking),
        "anthropic",
      ),
    ).toBe(false);
  });

  it("anthropic: a signed thinking block after tool_use and text fails", () => {
    expect(
      clientStreamHasReasoningBeforeText(
        turn(
          ANTHROPIC_TOOL_USE +
            'event: content_block_start\n' +
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
            ANTHROPIC_SIGNED_THINKING.replaceAll('"index":0', '"index":2'),
        ),
        "anthropic",
      ),
    ).toBe(false);
  });

  it("anthropic: thinking before the tool_use block passes", () => {
    expect(
      clientStreamHasReasoningBeforeText(
        turn(
          ANTHROPIC_SIGNED_THINKING +
            'event: content_block_start\n' +
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}\n\n',
        ),
        "anthropic",
      ),
    ).toBe(true);
  });

  it("responses: a reasoning item done before the function_call passes", () => {
    const body =
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","summary":[],"encrypted_content":"bg1.x"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"c1","name":"f","arguments":"{}"}}\n\n';
    expect(clientStreamHasReasoningBeforeText(turn(body), "responses")).toBe(
      true,
    );
  });

  it("responses: a function_call item done before the reasoning item fails", () => {
    const body =
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"f","arguments":"{}"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"reasoning","summary":[],"encrypted_content":"bg1.x"}}\n\n';
    expect(clientStreamHasReasoningBeforeText(turn(body), "responses")).toBe(
      false,
    );
  });

  it("responses: reasoning added before a function_call completes passes", () => {
    const body =
      'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","summary":[],"encrypted_content":"bg1.x"}}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"c1","name":"f","arguments":"{}"}}\n\n';
    expect(clientStreamHasReasoningBeforeText(turn(body), "responses")).toBe(
      true,
    );
  });
});
