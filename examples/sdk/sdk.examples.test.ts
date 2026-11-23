import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  MOCK_BASE_URLS,
} from "../../tests/mocks/upstreams";
import type { Provider } from "../../src/transformers";
import openaiFixtures from "../../tests/fixtures/openai.json";
import { run as langchainExample } from "./langchain";
import { run as llamaIndexExample } from "./llamaindex";
import { run as vercelAiSdkExample } from "./vercel-ai-sdk";
import { run as ollamaAppExample } from "./ollama-app";

/**
 * The Task 12 SDK examples (spec §3.4): each example's run(baseUrl)
 * drives one real HTTP request through the gateway listener while msw
 * serves the upstream — the same pattern as the integration suite,
 * except the client is the real SDK, not supertest. The assertion that
 * a request was translated (not just answered) is on the captured
 * upstream body in the target's dialect.
 */

const server = setupServer(...upstreamHandlers);
let httpServer: Server;
/** http://127.0.0.1:<port> — the client-facing root every dialect mounts under. */
let gatewayBase: string;

beforeAll(async () => {
  // 'bypass' so the SDK's localhost requests reach the real listener;
  // only the *.mock upstream hosts are handled.
  server.listen({ onUnhandledRequest: "bypass" });
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = (httpServer.address() as AddressInfo) ?? { port: 0 };
  gatewayBase = `http://127.0.0.1:${port}`;
});

const ENV_KEYS = [
  "TARGET_API",
  "OPENAI_API_BASE_URL",
  "OPENAI_API_KEY",
  "GEMINI_API_BASE_URL",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_BASE_URL",
  "OLLAMA_API_KEY",
  "USAGE_STORE",
] as const;

/** Point env-only mode at the mock host for one provider. */
function useTarget(api: Provider): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TARGET_API = api;
  process.env[`${api.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[api];
  process.env[`${api.toUpperCase()}_API_KEY`] = `test-${api}-key`;
  process.env.USAGE_STORE = "off";
  resetConfig();
}

beforeEach(() => {
  resetCaptured();
  resetOverrides();
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  for (const key of ENV_KEYS) delete process.env[key];
  resetConfig();
});

afterAll(async () => {
  server.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("examples/sdk — SDK clients through the gateway", () => {
  it("langchain example answers", async () => {
    useTarget("gemini");

    const answer = await langchainExample(`${gatewayBase}/v1`);

    expect(answer).toContain("Hello! How can I help you?");
    // The SDK spoke OpenAI Chat Completions; the upstream heard Gemini.
    expect(capturedRequests.gemini).toHaveLength(1);
    const upstream = capturedRequests.gemini[0] as {
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(upstream.contents[0].parts[0].text).toContain("hello");
  });

  it("llamaindex example answers", async () => {
    useTarget("anthropic");

    const answer = await llamaIndexExample(`${gatewayBase}/v1`);

    expect(answer).toContain("Hello! How can I help you?");
    // The SDK spoke OpenAI Chat Completions; the upstream heard Anthropic.
    expect(capturedRequests.anthropic).toHaveLength(1);
    const upstream = capturedRequests.anthropic[0] as {
      messages: { role: string; content: unknown }[];
    };
    expect(upstream.messages[0].role).toBe("user");
  });

  it("vercel ai sdk example answers with a tool call", async () => {
    useTarget("openai");
    // Two-turn tool loop: the first upstream reply is the recorded
    // get_weather call, the SDK's execute() answers it, and the second
    // reply is the recorded text — both through the gateway.
    let turns = 0;
    server.use(
      http.post(
        `${MOCK_BASE_URLS.openai}/v1/chat/completions`,
        async ({ request }) => {
          const body = await request.json();
          capturedRequests.openai.push(body);
          turns += 1;
          return HttpResponse.json(
            turns === 1
              ? openaiFixtures.responses.tool_call
              : openaiFixtures.responses.basic,
          );
        },
      ),
    );

    const answer = await vercelAiSdkExample(`${gatewayBase}/v1`);

    expect(answer).toContain("Hello! How can I help you?");
    expect(capturedRequests.openai).toHaveLength(2);
    // Turn 2 replays the tool result, proving one tool call went
    // through babelgate in both directions.
    const second = capturedRequests.openai[1] as {
      messages: { role: string; tool_call_id?: string; content?: string }[];
    };
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.tool_call_id).toBe("call_xyz");
    expect(toolMessage?.content).toContain("sunny in Paris");
  });

  it("ollama app on a cloud model answers", async () => {
    useTarget("gemini");

    const answer = await ollamaAppExample(gatewayBase);

    expect(answer).toContain("Hello! How can I help you?");
    // The SDK spoke Ollama /api/chat; the upstream heard Gemini.
    expect(capturedRequests.gemini).toHaveLength(1);
    const upstream = capturedRequests.gemini[0] as {
      contents: { role: string }[];
    };
    expect(upstream.contents[0].role).toBe("user");
  });
});
