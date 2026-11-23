import { OpenAI } from "@llamaindex/openai";
import type { MessageContent } from "@llamaindex/core/llms";

/**
 * LlamaIndex.TS through babelgate's OpenAI dialect — the example the
 * docs/recipes/llamaindex.md recipe is checked against
 * (examples/sdk/sdk.examples.test.ts).
 *
 * `baseUrl` is the gateway's OpenAI base URL, including the /v1
 * suffix — e.g. http://localhost:3000/v1. The model name is forwarded
 * to the configured provider unchanged.
 */
export async function run(baseUrl: string): Promise<string> {
  const llm = new OpenAI({
    model: "gpt-4",
    apiKey: "babelgate",
    baseURL: baseUrl,
    maxRetries: 0,
  });
  const reply = await llm.chat({
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });
  return textOf(reply.message.content);
}

function textOf(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (detail): detail is { type: "text"; text: string } =>
        detail.type === "text",
    )
    .map((detail) => detail.text)
    .join("");
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
