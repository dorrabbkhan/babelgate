import { describe, it, expect, vi, afterEach } from "vitest";
import { adapters } from "../transformers";
import { proxyChat } from "./chat.service";
import { attemptStreamTarget } from "./stream-attempt";
import { attemptTargets } from "./attempt-targets";
import { createRegistry } from "../routing/registry";
import { currentAttempt } from "../observe/context";
import type { AttemptContext } from "../observe/context";
import type { GatewayConfig } from "../config/env-config";
import type { RoutePlan } from "../routing/plan-route";
import type {
  CanonicalRequest,
  StreamDecoder,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";

vi.mock("./http-client", () => ({
  postJson: vi.fn(),
  postStream: vi.fn(),
}));

import { postJson, postStream } from "./http-client";

const mockPostJson = vi.mocked(postJson);
const mockPostStream = vi.mocked(postStream);

const registry = () =>
  createRegistry([
    { name: "primary", type: "ollama", baseUrl: "http://primary.test" },
    { name: "second", type: "ollama", baseUrl: "http://second.test" },
  ]);

const plan: RoutePlan = {
  targets: [
    { provider: "primary", model: "m1" },
    { provider: "second", model: "m2" },
  ],
  reason: "default",
};

const config = (): GatewayConfig =>
  ({
    registry: registry(),
    upstreamTimeoutMs: 1000,
    upstreamRetries: 0,
  }) as GatewayConfig;

const canonical: CanonicalRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attempt context (v1.4 spec §3.2)", () => {
  it("each fallback hop runs in its own attempt", async () => {
    const encodeCtxs: (AttemptContext | undefined)[] = [];
    const decodeCtxs: (AttemptContext | undefined)[] = [];

    const encode = adapters.ollama.fromCanonicalRequest;
    vi.spyOn(adapters.ollama, "fromCanonicalRequest").mockImplementation(
      (req) => {
        encodeCtxs.push(currentAttempt());
        return encode(req);
      },
    );
    const decode = adapters.ollama.toCanonicalResponse;
    vi.spyOn(adapters.ollama, "toCanonicalResponse").mockImplementation(
      (resp, model, ids) => {
        decodeCtxs.push(currentAttempt());
        return decode(resp, model, ids);
      },
    );

    mockPostJson
      .mockRejectedValueOnce(new UpstreamError("down", 503, {}))
      .mockResolvedValueOnce({
        status: 200,
        body: {
          model: "m2",
          message: { role: "assistant", content: "Hi" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 5,
          eval_count: 1,
        },
        durationMs: 1,
      });

    const result = await proxyChat({
      source: "openai",
      sourceBody: {},
      canonical,
      requestedModel: "m",
      plan,
      config: config(),
      requestId: "r1",
    });

    expect(result.body).toBeDefined();
    // Hop 1's encode saw the first target; hop 2's encode and the
    // winning decode saw the second.
    expect(encodeCtxs).toEqual([
      { providerName: "primary", upstreamModel: "m1" },
      { providerName: "second", upstreamModel: "m2" },
    ]);
    expect(decodeCtxs).toEqual([
      { providerName: "second", upstreamModel: "m2" },
    ]);
    expect(currentAttempt()).toBeUndefined();
  });

  it("each fallback hop runs in its own attempt (stream)", async () => {
    const encodeCtxs: (AttemptContext | undefined)[] = [];
    const feedCtxs: (AttemptContext | undefined)[] = [];

    const encode = adapters.ollama.fromCanonicalRequest;
    vi.spyOn(adapters.ollama, "fromCanonicalRequest").mockImplementation(
      (req) => {
        encodeCtxs.push(currentAttempt());
        return encode(req);
      },
    );
    const makeDecoder = adapters.ollama.createStreamDecoder;
    vi.spyOn(adapters.ollama, "createStreamDecoder").mockImplementation(
      (model, ids) => {
        const inner = makeDecoder(model, ids);
        const wrapped: StreamDecoder = {
          feed: (chunk) => {
            feedCtxs.push(currentAttempt());
            return inner.feed(chunk);
          },
          end: () => inner.end(),
        };
        return wrapped;
      },
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    mockPostStream
      .mockRejectedValueOnce(new UpstreamError("down", 503, {}))
      .mockResolvedValueOnce({
        status: 200,
        body: stream,
        durationMs: 1,
      });

    const result = await attemptTargets(
      plan,
      registry(),
      attemptStreamTarget(canonical, config(), "r1", undefined),
      { requestId: "r1" },
    );

    expect(encodeCtxs).toEqual([
      { providerName: "primary", upstreamModel: "m1" },
      { providerName: "second", upstreamModel: "m2" },
    ]);

    // The decoder's feed/end run in the pipeline's async scope, not
    // the attempt's — they re-enter the winning attempt's context.
    result.value.decoder.feed("");
    expect(feedCtxs).toEqual([
      { providerName: "second", upstreamModel: "m2" },
    ]);
    expect(currentAttempt()).toBeUndefined();
  });
});
