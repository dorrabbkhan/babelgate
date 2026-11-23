import { ChatOpenAI } from "@langchain/openai";

/**
 * LangChain (JS) through babelgate's OpenAI dialect — the example the
 * docs/recipes/langchain.md recipe is checked against
 * (examples/sdk/sdk.examples.test.ts).
 *
 * `baseUrl` is the gateway's OpenAI base URL, including the /v1
 * suffix — e.g. http://localhost:3000/v1. The model name is forwarded
 * to the configured provider unchanged.
 */
export async function run(baseUrl: string): Promise<string> {
  const model = new ChatOpenAI({
    model: "gpt-4",
    apiKey: "babelgate",
    configuration: { baseURL: baseUrl },
    maxRetries: 0,
  });
  const reply = await model.invoke("Say hello in one short sentence.");
  if (typeof reply.content === "string") return reply.content;
  return reply.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
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
