/**
 * record-streams-reasoning-cases.ts — the replay-only reasoning cases
 * for record-streams-cases.ts (v1.6 Task 13b, spec §3.10). They run
 * only when RECORD_OUT_DIR redirects the output — they are
 * process-suite replays under tests/process/replays/, not oracle
 * fixtures, and a default `npm run record:streams` must not write new
 * files into tests/fixtures/streams/.
 */
import type { RecCase } from "./record-streams-cases";

export const REPLAYS_ONLY =
  process.env.RECORD_OUT_DIR !== undefined &&
  process.env.RECORD_OUT_DIR !== "";

const WEATHER_Q = "What is the weather in Paris?";
const REASONING_Q = "Is 9.11 greater than 9.9? Think briefly.";
const userMsg = (content: string) => [{ role: "user", content }];
const geminiUser = (text: string) => [
  { role: "user", parts: [{ text }] },
];

const OPENAI_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  },
];
const GEMINI_TOOL = [
  {
    functionDeclarations: [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      },
    ],
  },
];

/**
 * Chat reasoning via the unified OpenRouter `reasoning` request object
 * (https://openrouter.ai/docs/use-cases/reasoning-tokens); the
 * response then carries `reasoning`/`reasoning_details` (DeepSeek
 * direct: `reasoning_content`,
 * https://api-docs.deepseek.com/guides/reasoning_model).
 */
export function openaiReasoningCases(): Record<string, RecCase> {
  if (!REPLAYS_ONLY) return {};
  return {
    reasoning: {
      request: {
        messages: userMsg(REASONING_Q),
        reasoning: { enabled: true },
        temperature: 0,
        max_tokens: 1024,
      },
      sourceNote:
        "; reasoning requested via the OpenRouter `reasoning` object",
    },
    reasoning_tool_call: {
      request: {
        messages: userMsg(WEATHER_Q),
        tools: OPENAI_TOOL,
        tool_choice: "required",
        reasoning: { enabled: true },
        temperature: 0,
        max_tokens: 1024,
      },
      sourceNote:
        "; reasoning requested via the OpenRouter `reasoning` object; tool call forced with tool_choice required",
    },
  };
}

/**
 * Gemini thinking models return `thought: true` parts and
 * `thoughtSignature` when generationConfig.thinkingConfig.includeThoughts
 * is true (https://ai.google.dev/gemini-api/docs/thinking).
 */
export function geminiThinkingCases(): Record<string, RecCase> {
  if (!REPLAYS_ONLY) return {};
  const generationConfig = {
    temperature: 0,
    maxOutputTokens: 2048,
    thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
  };
  return {
    thinking: {
      request: {
        contents: geminiUser(REASONING_Q),
        generationConfig,
      },
      sourceNote: "; includeThoughts:true",
    },
    thinking_tool_call: {
      request: {
        contents: geminiUser(WEATHER_Q),
        tools: GEMINI_TOOL,
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig,
      },
      sourceNote: "; includeThoughts:true",
    },
  };
}
