/**
 * streamed-tool-args (v1.6 plan Task 13b): the upstream streams one
 * tool call's arguments in >= 5 deltas (the recorded
 * `openai/tool_call.sse` — 8 argument chunks). Pass: the client
 * stream carries exactly one tool call whose concatenated arguments
 * parse as the recorded JSON. Wire rules: Chat Completions streams
 * `tool_calls[].function.arguments` as string fragments
 * (https://platform.openai.com/docs/api-reference/chat-streaming);
 * Anthropic streams them as `input_json_delta.partial_json` and
 * Responses as `response.function_call_arguments.delta`
 * (https://platform.openai.com/docs/api-reference/responses-streaming).
 */
import { anthropicAssistantContent, responsesOutputItems } from "./client";
import type { Scenario, TurnResult } from "./types";
import { shape } from "./types";

const TOOLS_ANTHROPIC = [
  {
    name: "get_weather",
    description: "Get the weather",
    input_schema: {
      type: "object",
      properties: { location: { type: "string" } },
    },
  },
];

const TOOLS_RESPONSES = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
    },
  },
];

/** The recorded arguments in tests/fixtures/streams/openai/tool_call.sse. */
const RECORDED_ARGS = { location: "Santorini, Greece" };

function anthropicToolCalls(r: TurnResult): {
  count: number;
  inputs: unknown[];
} {
  // Non-stream reply: the message content directly.
  const blocks = anthropicAssistantContent(r.body);
  const toolCalls = blocks.filter((b) => b.type === "tool_use");
  return { count: toolCalls.length, inputs: toolCalls.map((b) => b.input) };
}

function responsesToolCalls(r: TurnResult): {
  count: number;
  inputs: unknown[];
} {
  const calls = responsesOutputItems(r.body).filter(
    (i) => i?.type === "function_call",
  );
  const inputs = calls.map((c) => {
    try {
      return JSON.parse(c.arguments ?? "");
    } catch {
      return c.arguments;
    }
  });
  return { count: calls.length, inputs };
}

function verdict(
  results: TurnResult[],
  calls: { count: number; inputs: unknown[] },
): ReturnType<Scenario["assert"]> {
  const last = results[results.length - 1];
  const evidence = {
    request: shape({ status: last?.status, events: last?.sseEvents }),
    response: shape({
      toolCallCount: calls.count,
      inputs: calls.inputs,
    }),
  };
  if (last?.status !== 200) {
    return { pass: false, reason: `client got HTTP ${last?.status}`, evidence };
  }
  if (calls.count !== 1) {
    return {
      pass: false,
      reason: `expected exactly one tool call, got ${calls.count}`,
      evidence,
    };
  }
  const args = calls.inputs[0];
  if (JSON.stringify(args) !== JSON.stringify(RECORDED_ARGS)) {
    return {
      pass: false,
      reason:
        "concatenated tool-call arguments do not parse as the recorded JSON",
      evidence,
    };
  }
  return { pass: true, evidence };
}

function build(client: "anthropic" | "responses"): Scenario {
  return {
    name: `streamed-tool-args:${client}->openai`,
    client,
    upstream: "openai",
    // tests/process/replays/openai/tool_call.sse — verbatim events
    // from tests/fixtures/streams/openai/tool_call.sse (the
    // OpenAI Go SDK streamaccumulator_test.go recording) re-framed
    // with the blank-line event separator the SSE wire format uses
    // (https://html.spec.whatwg.org/multipage/server-sent-events.html):
    // the fixture lost its empty lines on extraction and stricter
    // upstream readers (CCR, free-claude-code) parse the whole file
    // as one event. Every other corpus fixture is blank-separated.
    replay: "openai/tool_call.sse",
    turns: [
      {
        request:
          client === "anthropic"
            ? {
                model: "$MODEL",
                max_tokens: 128,
                stream: true,
                messages: [
                  { role: "user", content: "What is the weather in Paris?" },
                ],
                tools: TOOLS_ANTHROPIC,
              }
            : {
                model: "$MODEL",
                stream: true,
                input: "What is the weather in Paris?",
                tools: TOOLS_RESPONSES,
              },
      },
    ],
    assert: (results) =>
      verdict(
        results,
        client === "anthropic"
          ? anthropicToolCalls(results[0])
          : responsesToolCalls(results[0]),
      ),
  };
}

// Upstream: "openai" only — the Gemini wire format sends functionCall
// args as one complete `args` object, never as >=5 argument deltas, so
// no gemini variant exists (there is nothing to split).
export const scenarios: Scenario[] = [build("anthropic"), build("responses")];
