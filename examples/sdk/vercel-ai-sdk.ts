import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

/**
 * Vercel AI SDK through babelgate's OpenAI dialect — the example the
 * docs/recipes/vercel-ai-sdk.md recipe is checked against
 * (examples/sdk/sdk.examples.test.ts).
 *
 * `baseUrl` is the gateway's OpenAI base URL, including the /v1
 * suffix — e.g. http://localhost:3000/v1. `openai.chat()` pins the
 * Chat Completions dialect (the default `openai()` uses the Responses
 * API, which babelgate also serves at POST /v1/responses). The tool
 * loop is the SDK's: the upstream's tool_call is executed locally and
 * the result goes back through the gateway on the next request.
 */
export async function run(baseUrl: string): Promise<string> {
  const openai = createOpenAI({ baseURL: baseUrl, apiKey: "babelgate" });
  const result = await generateText({
    model: openai.chat("gpt-4"),
    prompt: "What is the weather in Paris? Use the get_weather tool.",
    tools: {
      get_weather: tool({
        description: "Get the current weather for a location",
        inputSchema: z.object({ location: z.string() }),
        execute: async ({ location }) => `sunny in ${location}`,
      }),
    },
    // One model turn with the call plus one turn after the result.
    stopWhen: stepCountIs(3),
  });
  return result.text;
}

if (require.main === module) {
  run(process.argv[2] ?? "http://localhost:3000/v1").then(
    (text) => console.log(text),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
