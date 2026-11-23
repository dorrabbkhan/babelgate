/**
 * record-streams-cases.ts — per-provider endpoints and case definitions
 * for record-streams.ts. Each provider's entry is only constructed when
 * its prerequisites are met (key set / base URL reachable).
 */
import { join } from "node:path";
import type { Provider } from "../src/transformers";
import {
  geminiThinkingCases,
  openaiReasoningCases,
} from "./record-streams-reasoning-cases";

const WEATHER_DESCRIPTION = "Get the current weather for a city";
const WEATHER_SCHEMA = {
  type: "object",
  properties: { location: { type: "string", description: "City name" } },
  required: ["location"],
};
const OPENAI_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: WEATHER_DESCRIPTION,
      parameters: WEATHER_SCHEMA,
    },
  },
];
const ANTHROPIC_TOOL = [
  {
    name: "get_weather",
    description: WEATHER_DESCRIPTION,
    input_schema: WEATHER_SCHEMA,
  },
];
const GEMINI_TOOL = [
  {
    functionDeclarations: [
      {
        name: "get_weather",
        description: WEATHER_DESCRIPTION,
        parameters: WEATHER_SCHEMA,
      },
    ],
  },
];

const HELLO = "Reply with exactly one word: hello";
const WEATHER_Q = "What is the weather in Paris?";
const TWO_CITIES =
  "What is the weather in Paris and what is the weather in London?";
const COUNT = "Count from 1 to 50.";
const TOOL_RESULT = "15 degrees Celsius, partly cloudy";
const userMsg = (content: string) => [{ role: "user", content }];
const geminiUser = (text: string) => [{ role: "user", parts: [{ text }] }];

export interface RecCase {
  /** Fields merged into the request body (provider-shaped). */
  request: Record<string, unknown>;
  /**
   * Shell command run once `midStreamAfterLines` stream lines have
   * arrived — for inducing a real mid-stream failure (ollama error).
   */
  midStreamAction?: string;
  midStreamAfterLines?: number;
  /** Bytes must contain an in-stream error on a 2xx response. */
  expectInStreamError?: boolean;
  /** Extra provenance appended to the fixture's `source`. */
  sourceNote?: string;
}

export interface ProviderRecording {
  dir: string;
  ext: "sse" | "ndjson";
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
  /** Request path for the streamed call. */
  streamPath: (model: string) => string;
  /** Request path for the non-streaming twin (default: same). */
  twinPath?: (model: string) => string;
  body: (
    model: string,
    stream: boolean,
    extra: Record<string, unknown>,
  ) => Record<string, unknown>;
  sourcePrefix: string;
  /** Appended after the case's sourceNote (e.g. a closing paren). */
  sourceSuffix?: string;
  cases: Record<string, RecCase>;
}

function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

async function ollamaSetup(
  streamsDir: string,
  killCmd: string | undefined,
): Promise<ProviderRecording | string> {
  const baseUrl = envOr("OLLAMA_API_BASE_URL", "http://localhost:11434");
  const model = envOr("RECORD_OLLAMA_MODEL", "qwen2.5:7b");
  let version = "unknown";
  try {
    const res = await fetch(`${baseUrl}/api/version`);
    if (res.ok) {
      version =
        ((await res.json()) as { version?: string }).version ?? version;
    }
  } catch {
    return `not reachable at ${baseUrl}`;
  }
  return {
    dir: join(streamsDir, "ollama"),
    ext: "ndjson" as const,
    baseUrl,
    model,
    headers: { "Content-Type": "application/json" },
    streamPath: () => "/api/chat",
    body: (m: string, stream: boolean, extra: Record<string, unknown>) => ({
      model: m,
      stream,
      ...extra,
    }),
    sourcePrefix: `recorded: ollama ${version}, ${model} (via npm run record:streams`,
    sourceSuffix: ")",
    cases: {
      text: {
        request: {
          messages: userMsg(HELLO),
          options: { temperature: 0, num_predict: 32 },
        },
      },
      tool_call: {
        request: {
          messages: userMsg(WEATHER_Q),
          tools: OPENAI_TOOL,
          options: { temperature: 0 },
        },
      },
      parallel_tool_calls: {
        request: {
          messages: userMsg(TWO_CITIES),
          tools: OPENAI_TOOL,
          options: { temperature: 0 },
        },
      },
      after_tool_result: {
        request: {
          messages: [
            { role: "user", content: WEATHER_Q },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  function: {
                    index: 0,
                    name: "get_weather",
                    arguments: { location: "Paris" },
                  },
                },
              ],
            },
            { role: "tool", content: TOOL_RESULT },
          ],
          tools: OPENAI_TOOL,
          options: { temperature: 0, num_predict: 64 },
        },
      },
      max_tokens: {
        request: {
          messages: userMsg(COUNT),
          options: { temperature: 0, num_predict: 5 },
        },
      },
      error: {
        request: {
          messages: userMsg("Count from 1 to 500, one number per line."),
          options: { temperature: 0, num_predict: 2000 },
        },
        expectInStreamError: true,
        midStreamAction: killCmd,
        midStreamAfterLines: 6,
        sourceNote:
          "; mid-stream error induced by stopping the llama runner mid-generation",
      },
    },
  };
}

function openaiSetup(streamsDir: string) {
  // OpenRouter is a second key source for the Chat dialect: its
  // reasoning models stream `reasoning` / `reasoning_details` on the
  // assistant message
  // (https://openrouter.ai/docs/use-cases/reasoning-tokens); DeepSeek
  // direct uses `reasoning_content`
  // (https://api-docs.deepseek.com/guides/reasoning_model). OPENAI_API_KEY
  // wins when both are set (a bare OPENROUTER_API_KEY run defaults to
  // the OpenRouter base URL and a reasoning model).
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const key = openaiKey ?? openrouterKey;
  if (!key) return "OPENAI_API_KEY / OPENROUTER_API_KEY not set";
  const viaOpenRouter = openaiKey === undefined && openrouterKey !== undefined;
  const baseUrl = envOr(
    "OPENAI_API_BASE_URL",
    viaOpenRouter ? "https://openrouter.ai/api" : "https://api.openai.com",
  );
  const model = envOr(
    "RECORD_OPENAI_MODEL",
    viaOpenRouter ? "deepseek/deepseek-r1-0528" : "gpt-4o-mini",
  );
  return {
    dir: join(streamsDir, "openai"),
    ext: "sse" as const,
    baseUrl,
    model,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    streamPath: () => "/v1/chat/completions",
    body: (m: string, stream: boolean, extra: Record<string, unknown>) => ({
      model: m,
      stream,
      ...(stream && { stream_options: { include_usage: true } }),
      ...extra,
    }),
    sourcePrefix: `recorded: openai API, ${model} (via npm run record:streams`,
    sourceSuffix: ")",
    cases: {
      text: {
        request: {
          messages: userMsg(HELLO),
          temperature: 0,
          max_tokens: 32,
        },
      },
      tool_call: {
        request: {
          messages: userMsg(WEATHER_Q),
          tools: OPENAI_TOOL,
          tool_choice: "auto",
          temperature: 0,
        },
      },
      parallel_tool_calls: {
        request: {
          messages: userMsg(TWO_CITIES),
          tools: OPENAI_TOOL,
          tool_choice: "auto",
          parallel_tool_calls: true,
          temperature: 0,
          max_tokens: 128,
        },
      },
      after_tool_result: {
        request: {
          messages: [
            { role: "user", content: WEATHER_Q },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"Paris"}',
                  },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_0", content: TOOL_RESULT },
          ],
          tools: OPENAI_TOOL,
          temperature: 0,
          max_tokens: 64,
        },
      },
      max_tokens: {
        request: {
          messages: userMsg(COUNT),
          temperature: 0,
          max_tokens: 5,
        },
      },
      // Reasoning replays (v1.6 Task 13b): defined in
      // record-streams-reasoning-cases.ts, empty unless RECORD_OUT_DIR
      // redirects the output to tests/process/replays/.
      ...openaiReasoningCases(),
      // No deterministic trigger for an OpenAI in-stream error is known;
      // the case stays unrecorded until one is found.
    },
  };
}

function anthropicSetup(streamsDir: string) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "ANTHROPIC_API_KEY not set";
  const baseUrl = envOr("ANTHROPIC_API_BASE_URL", "https://api.anthropic.com");
  const model = envOr("RECORD_ANTHROPIC_MODEL", "claude-haiku-4-5");
  return {
    dir: join(streamsDir, "anthropic"),
    ext: "sse" as const,
    baseUrl,
    model,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    streamPath: () => "/v1/messages",
    body: (m: string, stream: boolean, extra: Record<string, unknown>) => ({
      model: m,
      stream,
      ...extra,
    }),
    sourcePrefix: `recorded: anthropic API, ${model} (via npm run record:streams`,
    sourceSuffix: ")",
    cases: {
      text: {
        request: {
          messages: userMsg(HELLO),
          max_tokens: 32,
          temperature: 0,
        },
      },
      tool_call: {
        request: {
          messages: userMsg(WEATHER_Q),
          tools: ANTHROPIC_TOOL,
          tool_choice: { type: "any" },
          max_tokens: 256,
          temperature: 0,
        },
      },
      parallel_tool_calls: {
        request: {
          messages: userMsg(TWO_CITIES),
          tools: ANTHROPIC_TOOL,
          tool_choice: { type: "any" },
          max_tokens: 192,
          temperature: 0,
        },
      },
      after_tool_result: {
        request: {
          messages: [
            { role: "user", content: WEATHER_Q },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_0",
                  name: "get_weather",
                  input: { location: "Paris" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_0",
                  content: TOOL_RESULT,
                },
              ],
            },
          ],
          tools: ANTHROPIC_TOOL,
          max_tokens: 128,
          temperature: 0,
        },
      },
      max_tokens: {
        request: {
          messages: userMsg(COUNT),
          max_tokens: 8,
          temperature: 0,
        },
      },
      // `error` already has a documented fixture on main.
    },
  };
}

function geminiSetup(streamsDir: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "GEMINI_API_KEY not set";
  const baseUrl = envOr(
    "GEMINI_API_BASE_URL",
    "https://generativelanguage.googleapis.com",
  );
  const model = envOr("RECORD_GEMINI_MODEL", "gemini-2.5-flash");
  return {
    dir: join(streamsDir, "gemini"),
    ext: "sse" as const,
    baseUrl,
    model,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    streamPath: (m: string) =>
      `/v1beta/models/${m}:streamGenerateContent?alt=sse`,
    twinPath: (m: string) => `/v1beta/models/${m}:generateContent`,
    body: (_m: string, _stream: boolean, extra: Record<string, unknown>) => ({
      ...extra,
    }),
    sourcePrefix: `recorded: gemini API, ${model} (via npm run record:streams`,
    sourceSuffix: ")",
    cases: {
      text: {
        request: {
          contents: geminiUser(HELLO),
          generationConfig: { temperature: 0, maxOutputTokens: 32 },
        },
      },
      tool_call: {
        request: {
          contents: geminiUser(WEATHER_Q),
          tools: GEMINI_TOOL,
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
          generationConfig: { temperature: 0, maxOutputTokens: 128 },
        },
      },
      parallel_tool_calls: {
        request: {
          contents: geminiUser(TWO_CITIES),
          tools: GEMINI_TOOL,
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
        },
      },
      after_tool_result: {
        request: {
          contents: [
            ...geminiUser(WEATHER_Q),
            {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "get_weather",
                    args: { location: "Paris" },
                  },
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "get_weather",
                    response: { result: TOOL_RESULT },
                  },
                },
              ],
            },
          ],
          tools: GEMINI_TOOL,
          generationConfig: { temperature: 0, maxOutputTokens: 128 },
        },
      },
      max_tokens: {
        request: {
          contents: geminiUser(COUNT),
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        },
      },
      // Thinking replays (v1.6 Task 13b): defined in
      // record-streams-reasoning-cases.ts, empty unless RECORD_OUT_DIR
      // redirects the output to tests/process/replays/.
      ...geminiThinkingCases(),
      // No deterministic trigger for a Gemini in-stream error is known;
      // the case stays unrecorded until one is found.
    },
  };
}

/** Returns the recording setup, or a skip reason (e.g. missing key). */
export function providerSetups(
  streamsDir: string,
  ollamaKillCmd?: string,
): Partial<
  Record<
    Provider,
    () => ProviderRecording | string | Promise<ProviderRecording | string>
  >
> {
  return {
    ollama: () => ollamaSetup(streamsDir, ollamaKillCmd),
    openai: () => openaiSetup(streamsDir),
    anthropic: () => anthropicSetup(streamsDir),
    gemini: () => geminiSetup(streamsDir),
  };
}
