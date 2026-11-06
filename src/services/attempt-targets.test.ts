import { describe, it, expect, vi } from "vitest";
import {
  attemptTargets,
  canonicalForTarget,
  maxTokensClampOf,
  type Hop,
} from "./attempt-targets";
import { createRegistry } from "../routing/registry";
import type { ProviderEntry } from "../routing/registry";
import type { RoutePlan } from "../routing/plan-route";
import type { CanonicalRequest } from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import { runWithTrace } from "../observe/context";
import { newTrace } from "../observe/trace";

const registry = () =>
  createRegistry([
    { name: "ollama", type: "ollama", baseUrl: "http://ollama.test" },
  ]);

const registry2 = () =>
  createRegistry([
    { name: "primary", type: "ollama", baseUrl: "http://primary.test" },
    { name: "second", type: "openai", baseUrl: "http://second.test" },
  ]);

const plan2: RoutePlan = {
  targets: [
    { provider: "primary", model: "m1" },
    { provider: "second", model: "m2" },
  ],
  reason: "rule:0",
};

describe("attemptTargets", () => {
  it("single target success records one ok hop", async () => {
    const plan: RoutePlan = {
      targets: [{ provider: "ollama", model: "llama3" }],
      reason: "default",
    };
    const attempt = vi.fn().mockResolvedValue("done");

    const result = await attemptTargets(plan, registry(), attempt, {
      requestId: "r1",
    });

    expect(result.value).toBe("done");
    expect(result.target).toEqual({ provider: "ollama", model: "llama3" });
    expect(result.entry.name).toBe("ollama");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]).toMatchObject({
      provider: "ollama",
      model: "llama3",
      outcome: "ok",
    });
    expect(result.hops[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("single target failure rethrows the same error", async () => {
    const plan: RoutePlan = {
      targets: [{ provider: "ollama", model: "llama3" }],
      reason: "default",
    };
    const boom = new Error("boom");
    const attempt = vi.fn().mockRejectedValue(boom);

    const err = await attemptTargets(plan, registry(), attempt, {
      requestId: "r1",
    }).catch((e) => e);

    expect(err).toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("falls back on eligible errors and records hops", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError("down", 503, {}))
      .mockResolvedValueOnce("done");

    const result = await attemptTargets(plan2, registry2(), attempt, {
      requestId: "r1",
    });

    expect(result.value).toBe("done");
    expect(result.target).toEqual({ provider: "second", model: "m2" });
    expect(result.entry.name).toBe("second");
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0]).toMatchObject({
      provider: "primary",
      model: "m1",
      outcome: "http_error",
      status: 503,
    });
    expect(result.hops[1]).toMatchObject({
      provider: "second",
      model: "m2",
      outcome: "ok",
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("stops on a non-eligible error", async () => {
    const err400 = new UpstreamError("bad request", 400, {});
    const attempt = vi.fn().mockRejectedValue(err400);

    const err = await attemptTargets(plan2, registry2(), attempt, {
      requestId: "r1",
    }).catch((e) => e);

    expect(err).toBe(err400);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(err.responseHeaders?.["x-babelgate-attempts"]).toBe("1");
  });

  // Review Focus 2: a client disconnect mid-attempt ends the loop —
  // the signal check runs before eligibility, so the second attempt is
  // never made.
  it("client abort stops the fallback loop", async () => {
    const ac = new AbortController();
    const timeout = new UpstreamError(
      "Upstream timed out after 50ms",
      undefined,
      undefined,
      {},
      504,
    );
    const attempt = vi.fn().mockImplementation(() => {
      ac.abort();
      return Promise.reject(timeout);
    });

    const err = await attemptTargets(plan2, registry2(), attempt, {
      requestId: "r1",
      signal: ac.signal,
    }).catch((e) => e);

    expect(err).toBe(timeout);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("last error carries x-babelgate-attempts", async () => {
    const last = new UpstreamError("last", 500, {});
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError("first", 503, {}))
      .mockRejectedValueOnce(last);
    const hops: Hop[] = [];

    const err = await attemptTargets(plan2, registry2(), attempt, {
      requestId: "r1",
      hops,
    }).catch((e) => e);

    expect(err).toBe(last);
    expect(err.responseHeaders?.["x-babelgate-attempts"]).toBe("2");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(hops).toHaveLength(2);
    expect(hops[0]!.outcome).toBe("http_error");
    expect(hops[1]!.outcome).toBe("http_error");
  });
});

describe("canonicalForTarget", () => {
  const canonical = (): CanonicalRequest => ({
    model: "decoded-model",
    messages: [{ role: "user", content: "hi" }],
  });
  const entry = (contextWindow?: number): ProviderEntry => ({
    name: "ollama",
    type: "ollama",
    baseUrl: "http://ollama.test",
    ...(contextWindow === undefined ? {} : { contextWindow }),
  });
  const target = { provider: "ollama", model: "routed-model" };

  it("canonicalForTarget leaves config absent when contextWindow is unset", () => {
    const inRequest = canonical();

    const out = canonicalForTarget(inRequest, entry(), target);

    expect("config" in out).toBe(false);
    expect(out.model).toBe("routed-model");
    expect("config" in inRequest).toBe(false);
    expect(inRequest.model).toBe("decoded-model");
  });

  it("canonicalForTarget sets contextWindow on a copied config", () => {
    const inRequest: CanonicalRequest = {
      ...canonical(),
      config: { temperature: 0.2 },
    };

    const out = canonicalForTarget(inRequest, entry(32768), target);

    expect(out.config?.contextWindow).toBe(32768);
    expect(out.config?.temperature).toBe(0.2);
    expect(out.config).not.toBe(inRequest.config);
    expect(inRequest.config).toEqual({ temperature: 0.2 });
    expect(inRequest.model).toBe("decoded-model");
  });
});

describe("max_output_tokens cap (spec §3.3)", () => {
  const capped = (maxOutputTokens?: number): ProviderEntry => ({
    name: "ollama",
    type: "ollama",
    baseUrl: "http://ollama.test",
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
  const target = { provider: "ollama", model: "routed-model" };
  const withMax = (maxTokens?: number): CanonicalRequest => ({
    model: "decoded-model",
    messages: [{ role: "user", content: "hi" }],
    ...(maxTokens === undefined
      ? {}
      : { config: { maxTokens } }),
  });

  it("cap clamps a larger request", () => {
    const out = canonicalForTarget(withMax(32000), capped(8000), target);

    expect(out.config?.maxTokens).toBe(8000);
    expect(maxTokensClampOf(withMax(32000), capped(8000))).toEqual({
      from: 32000,
      to: 8000,
    });
  });

  it("cap fills an unset maxTokens", () => {
    const out = canonicalForTarget(withMax(), capped(8000), target);

    expect(out.config?.maxTokens).toBe(8000);
    expect(maxTokensClampOf(withMax(), capped(8000))).toEqual({
      to: 8000,
    });
  });

  it("smaller request untouched", () => {
    const out = canonicalForTarget(withMax(4000), capped(8000), target);

    expect(out.config?.maxTokens).toBe(4000);
    expect(maxTokensClampOf(withMax(4000), capped(8000))).toBeUndefined();
  });

  it("no cap, no change", () => {
    const inRequest = withMax(4000);

    const out = canonicalForTarget(inRequest, capped(), target);

    expect(out).toEqual({
      model: "routed-model",
      messages: [{ role: "user", content: "hi" }],
      config: { maxTokens: 4000 },
    });
    expect(maxTokensClampOf(inRequest, capped())).toBeUndefined();
  });

  it("decoded canonical never mutated", () => {
    const inRequest = withMax(32000);

    const out = canonicalForTarget(inRequest, capped(8000), target);

    expect(out.config).not.toBe(inRequest.config);
    expect(inRequest.config?.maxTokens).toBe(32000);
  });
});

describe("cache hints (spec §3.2)", () => {
  const hinted = (): CanonicalRequest => ({
    model: "decoded-model",
    systemPrompt: [
      { type: "text", text: "A", cache: { ttl: "1h" } },
      { type: "text", text: "B", cache: {} },
    ],
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "A", cache: { ttl: "1h" } },
          { type: "text", text: "B", cache: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache: {} },
          {
            type: "image",
            image: { data: "aGk=", mimeType: "image/png" },
            cache: { ttl: "5m" },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: { name: "get_weather" },
        cache: { ttl: "1h" },
      },
    ],
  });
  const provider = (
    type: ProviderEntry["type"],
    cacheHints?: boolean,
  ): ProviderEntry => ({
    name: type,
    type,
    baseUrl: `http://${type}.test`,
    ...(cacheHints === undefined ? {} : { cacheHints }),
  });
  const target = { provider: "openai", model: "routed-model" };

  it("hints stripped for openai without cache_hints", () => {
    const inRequest = hinted();

    const out = canonicalForTarget(inRequest, provider("openai"), target);

    // The parts prompt existed only to carry hints — it flattens to
    // the same string the decoders produce for unhinted systems.
    expect(out.systemPrompt).toBe("A\n\nB");
    // The system message's parts collapse the same way, keeping the
    // "\n\n" join encoders produce for hinted content today.
    expect(out.messages[0]!.content).toBe("A\n\nB");
    for (const m of out.messages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          expect(p).not.toHaveProperty("cache");
        }
      }
    }
    expect(out.tools?.[0]).not.toHaveProperty("cache");
    // The decoded canonical is never mutated.
    expect(inRequest.messages[1]!.content).toEqual([
      { type: "text", text: "hi", cache: {} },
      {
        type: "image",
        image: { data: "aGk=", mimeType: "image/png" },
        cache: { ttl: "5m" },
      },
    ]);
  });

  it("hints kept with cache_hints", () => {
    const inRequest = hinted();

    const out = canonicalForTarget(
      inRequest,
      provider("openai", true),
      target,
    );

    expect(out.systemPrompt).toEqual(inRequest.systemPrompt);
    expect(out.messages).toEqual(inRequest.messages);
    expect(out.tools).toEqual(inRequest.tools);
  });

  it("hints always kept for anthropic", () => {
    const inRequest = hinted();

    const out = canonicalForTarget(
      inRequest,
      provider("anthropic"),
      target,
    );

    expect(out.systemPrompt).toEqual(inRequest.systemPrompt);
    expect(out.messages).toEqual(inRequest.messages);
    expect(out.tools).toEqual(inRequest.tools);
  });

  // §3.5: the strip records a cache_control_dropped note on the trace —
  // the target provider is the note's adapter.
  it("stripped hints record cache_control_dropped", () => {
    const trace = newTrace({
      requestId: "r1",
      startedAt: 0,
      client: "other",
      sourceApi: "anthropic",
    });

    runWithTrace(trace, () => {
      canonicalForTarget(hinted(), provider("openai"), target);
    });

    expect(trace.notes).toContainEqual({
      stage: "encode",
      adapter: "openai",
      code: "cache_control_dropped",
    });
  });
});
