/**
 * The smoke test's "upstream" (spec §4.4): a real HTTP server on
 * loopback serving the same fixture bodies tests/mocks/upstreams.ts
 * feeds to msw — reusing the oracle keeps the e2e aligned with the
 * unit corpus. Only the OpenAI chat-completions route is needed:
 * ui-smoke.sh points OPENAI_API_BASE_URL here.
 *
 * Run: `MOCK_PORT=9711 npx ts-node ui/e2e/mock-server.ts`
 */
import { createServer } from "node:http";
import { nonStreamBody } from "../../tests/mocks/upstreams";

const port = Number(process.env.MOCK_PORT ?? 9711);

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(nonStreamBody("openai")));
    return;
  }
  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { message: "mock: unknown route" } }));
}).listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on 127.0.0.1:${port}`);
});
