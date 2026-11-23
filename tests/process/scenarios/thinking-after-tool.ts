/**
 * thinking-after-tool (v1.6 plan Task 13b): turn 1 produces reasoning
 * plus a tool call; turn 2 sends the tool result *with* turn 1's
 * thinking block echoed, exactly as Claude Code/Codex do. Pass =
 * the upstream request still carries the reasoning per the target's
 * wire rules and the client stream has a valid thinking block before
 * text.
 *
 * Wire rules cited for the upstream-request check:
 * - OpenRouter Chat: `reasoning` / `reasoning_details` on a message —
 *   https://openrouter.ai/docs/use-cases/reasoning-tokens
 * - DeepSeek Chat: `reasoning_content` on the assistant message —
 *   https://api-docs.deepseek.com/guides/reasoning_model
 * - Gemini: `thought: true` / `thoughtSignature` on a model part —
 *   https://ai.google.dev/gemini-api/docs/thinking
 */
import {
  anthropicAssistantContent,
  clientStreamHasReasoningBeforeText,
  responsesOutputItems,
  upstreamCarriesReasoning,
} from "./client";
import type { Scenario, TurnResult } from "./types";
import { shape } from "./types";

const TOOL_RESULT = "15 degrees Celsius, partly cloudy";

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

/** Turn 2, Anthropic dialect: echo thinking + tool_use, then the
 * tool_result — the ordering Claude Code uses. */
function anthropicTurn2(prev: TurnResult[]): unknown {
  const assistant = anthropicAssistantContent(prev[0].body);
  const toolUse = assistant.find((b) => b.type === "tool_use");
  return {
    model: "$MODEL",
    max_tokens: 512,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 256 },
    tools: TOOLS_ANTHROPIC,
    messages: [
      { role: "user", content: "What is the weather in Paris?" },
      { role: "assistant", content: assistant },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse?.id ?? "toolu_unknown",
            content: TOOL_RESULT,
          },
        ],
      },
    ],
  };
}

/** Turn 2, Responses dialect: echo the output items (reasoning +
 * function_call) then the function_call_output — the Codex shape. */
function responsesTurn2(prev: TurnResult[]): unknown {
  const output = responsesOutputItems(prev[0].body);
  const call = output.find((i) => i?.type === "function_call");
  return {
    model: "$MODEL",
    stream: true,
    reasoning: { effort: "low" },
    tools: TOOLS_RESPONSES,
    input: [
      "What is the weather in Paris?",
      ...output,
      {
        type: "function_call_output",
        call_id: call?.call_id ?? call?.id ?? "call_unknown",
        output: TOOL_RESULT,
      },
    ],
  };
}

function build(
  client: "anthropic" | "responses",
  upstream: "openai" | "gemini",
): Scenario {
  return {
    name: `thinking-after-tool:${client}->${upstream}`,
    client,
    upstream,
    // recorded by the conductor (npm run record:streams,
    // RECORD_OUT_DIR=tests/process/replays): OpenRouter reasoning +
    // tool call, or Gemini includeThoughts + functionCall
    replay:
      upstream === "openai"
        ? "openai/reasoning_tool_call.sse"
        : "gemini/thinking_tool_call.sse",
    turns: [
      {
        request:
          client === "anthropic"
            ? {
                model: "$MODEL",
                max_tokens: 512,
                stream: true,
                thinking: { type: "enabled", budget_tokens: 256 },
                tools: TOOLS_ANTHROPIC,
                messages: [
                  { role: "user", content: "What is the weather in Paris?" },
                ],
              }
            : {
                model: "$MODEL",
                stream: true,
                reasoning: { effort: "low" },
                tools: TOOLS_RESPONSES,
                input: "What is the weather in Paris?",
              },
      },
      { request: client === "anthropic" ? anthropicTurn2 : responsesTurn2 },
    ],
    assert: (results) => {
      const turn2 = results[1];
      const upReq = turn2?.upstream.find((r) => r.body !== undefined);
      const evidence = {
        request: shape(upReq?.body ?? turn2?.body ?? null),
        response: shape(
          turn2?.body
            ? { status: turn2.status, events: turn2.sseEvents }
            : null,
        ),
      };
      if (turn2 === undefined || results[0]?.status !== 200) {
        return {
          pass: false,
          reason: `turn 1 status ${results[0]?.status}`,
          evidence,
        };
      }
      if (turn2.status !== 200) {
        return {
          pass: false,
          reason: `turn 2 status ${turn2.status}`,
          evidence,
        };
      }
      const carried =
        upReq !== undefined && upstreamCarriesReasoning(upReq, upstream);
      if (!carried) {
        return {
          pass: false,
          reason:
            "turn 2 upstream request carries no reasoning field per the target's wire rules",
          evidence,
        };
      }
      if (!clientStreamHasReasoningBeforeText(turn2, client)) {
        return {
          pass: false,
          reason:
            "turn 2 client stream has no signed thinking block before text",
          evidence,
        };
      }
      return { pass: true, evidence };
    },
  };
}

export const scenarios: Scenario[] = [
  build("anthropic", "openai"),
  build("responses", "openai"),
  build("anthropic", "gemini"),
  build("responses", "gemini"),
];
