import { Ollama } from "ollama";

/**
 * An Ollama-only app on a cloud model through babelgate — the example
 * the docs/recipes/ollama-apps.md recipe is checked against
 * (examples/sdk/sdk.examples.test.ts).
 *
 * `baseUrl` is the gateway's Ollama host — the bare origin, no path
 * (the SDK appends /api/chat itself) — e.g. http://localhost:3000.
 * The model name is forwarded to the configured provider unchanged,
 * so an Ollama-only app can run on a cloud model it could never speak
 * to directly.
 */
export async function run(baseUrl: string): Promise<string> {
  const client = new Ollama({ host: baseUrl });
  const reply = await client.chat({
    model: "gpt-4",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    // Ollama's API streams NDJSON when `stream` is omitted — ask for
    // the single JSON reply so the answer comes back in one object.
    stream: false,
  });
  return reply.message.content;
}

if (require.main === module) {
  run(process.argv[2] ?? "http://localhost:3000").then(
    (text) => console.log(text),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
