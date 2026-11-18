import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGapFixes } from "./gap-fixes";
import { passthroughCountTokens } from "./passthrough";
import { finishPassthroughTrace } from "./passthrough-trace";
import { loadYamlConfig } from "../config/yaml-config";
import { PROVIDER_PRESETS } from "../config/provider-presets";
import { ConfigurationError, ValidationError } from "../utils/errors";
import {
  estimateInputTokens,
  estimateOutputTokens,
} from "../utils/token-estimate";
import { newTrace } from "../observe/trace";
import { runWithTrace } from "../observe/context";
import type { GatewayConfig } from "../config/env-config";
import type { RoutePlan } from "../routing/plan-route";
import type { ProviderEntry } from "../routing/registry";
import type { CanonicalRequest } from "../types/canonical.types";
import type { MediaOptions } from "./media-inline";
import type { UpstreamStreamResponse } from "./http-client";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/**
 * Gap fixes and shim presets (v1.5 spec §3.3, Task 9): one fix per
 * declared gap on the pass-through body/reply, plus the preset merge
 * the config loader performs. Media fetches go through msw; DNS is
 * injected so the SSRF check sees a public address.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];
const MEDIA: MediaOptions = {
  fetch: true,
  allowPrivate: false,
  resolve: publicResolver,
};
const NO_FETCH: MediaOptions = { fetch: false, allowPrivate: false };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function anthropicBody(extra: Obj = {}): Obj {
  return {
    model: "claude-upstream",
    max_tokens: 64,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi there" }] },
    ],
    ...extra,
  };
}

function entry(extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    name: "shim",
    type: "anthropic",
    baseUrl: "http://anthropic.mock",
    passthrough: true,
    ...extra,
  };
}

function configWith(e: ProviderEntry): GatewayConfig {
  return {
    registry: {
      get: () => e,
      has: () => true,
      names: () => [e.name],
    },
    upstreamTimeoutMs: 1000,
    upstreamRetries: 0,
    media: { fetch: true, allowPrivate: false },
  } as unknown as GatewayConfig;
}

function yamlConfig(doc: string): GatewayConfig {
  const dir = mkdtempSync(join(tmpdir(), "gap-fixes-"));
  try {
    const path = join(dir, "babelgate.yaml");
    writeFileSync(path, doc);
    return loadYamlConfig(path, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("applyGapFixes (v1.5 spec §3.3)", () => {
  it("tool_choice removed with note", async () => {
    const out = await applyGapFixes(
      "anthropic",
      anthropicBody({ tool_choice: { type: "any" } }),
      ["tool_choice"],
      NO_FETCH,
    );
    expect(out.body.tool_choice).toBeUndefined();
    expect(out.notes.map((n) => n.code)).toContain("tool_choice_dropped");

    // The API-default "auto" is dropped silently.
    const quiet = await applyGapFixes(
      "anthropic",
      anthropicBody({ tool_choice: { type: "auto" } }),
      ["tool_choice"],
      NO_FETCH,
    );
    expect(quiet.body.tool_choice).toBeUndefined();
    expect(quiet.notes).toHaveLength(0);
  });

  it("count_tokens answered locally", async () => {
    // The entry declares the gap and could otherwise relay — the gap
    // suppresses the forward and the local estimate answers. msw
    // errors on any stray upstream call.
    const shim = entry({ gaps: ["count_tokens"] });
    const plan: RoutePlan = {
      targets: [{ provider: "shim", model: "claude-upstream" }],
      reason: "test",
    };
    const result = await passthroughCountTokens({
      source: "anthropic",
      sourceBody: anthropicBody(),
      plan,
      config: configWith(shim),
      requestId: "t-ct",
      estimate: 42,
      countTokensBody: (n) => ({ input_tokens: n }),
    });
    expect(result.headers?.["x-babelgate-token-estimate"]).toBe("true");
    expect(result.body).toEqual({ input_tokens: 42 });
  });

  it("cache_control stripped with note", async () => {
    const out = await applyGapFixes(
      "anthropic",
      anthropicBody({
        cache_control: { type: "ephemeral" },
        system: [
          {
            type: "text",
            text: "sys",
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: "t",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral" },
          },
        ],
      }),
      ["prompt_cache"],
      NO_FETCH,
    );
    // The top-level marker survives untouched; nested markers under
    // system/tools/messages are stripped with a note each.
    expect(out.body.cache_control).toEqual({ type: "ephemeral" });
    expect(out.body.system[0]).not.toHaveProperty("cache_control");
    expect(out.body.tools[0]).not.toHaveProperty("cache_control");
    const dropped = out.notes.filter(
      (n) => n.code === "cache_control_dropped",
    );
    expect(dropped.map((n) => n.path).sort()).toEqual([
      "system[0].cache_control",
      "tools[0].cache_control",
    ]);
  });

  it("top-level cache_control survives the prompt_cache gap", async () => {
    const body = anthropicBody({
      cache_control: { type: "ephemeral" },
    });
    const out = await applyGapFixes(
      "anthropic",
      body,
      ["prompt_cache"],
      NO_FETCH,
    );
    expect(out.body).toEqual(body);
    expect(
      out.notes.filter((n) => n.code === "cache_control_dropped"),
    ).toHaveLength(0);
  });

  it("message content cache_control stripped with note", async () => {
    const out = await applyGapFixes(
      "anthropic",
      anthropicBody({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi there",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      }),
      ["prompt_cache"],
      NO_FETCH,
    );
    expect(out.body.messages[0].content[0]).not.toHaveProperty(
      "cache_control",
    );
    const dropped = out.notes.filter(
      (n) => n.code === "cache_control_dropped",
    );
    expect(dropped.map((n) => n.path)).toEqual([
      "messages[0].content[0].cache_control",
    ]);
  });

  it("url image inlined in pass-through body", async () => {
    server.use(
      http.get(
        "http://media.example/pic.png",
        () =>
          new HttpResponse(PNG, {
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );
    const body = anthropicBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: {
                type: "url",
                url: "http://media.example/pic.png",
              },
            },
          ],
        },
      ],
    });
    const out = await applyGapFixes("anthropic", body, ["url_images"], MEDIA);
    const parts = out.body.messages[0].content as Obj[];
    expect(parts[1].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: PNG.toString("base64"),
    });

    // media.fetch: false refuses the fetch like the bridged path.
    await expect(
      applyGapFixes("anthropic", body, ["url_images"], NO_FETCH),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("document refused in source dialect", async () => {
    const body = anthropicBody({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "AAAA",
              },
            },
          ],
        },
      ],
    });
    await expect(
      applyGapFixes("anthropic", body, ["documents"], MEDIA),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("stream usage estimated and flagged", async () => {
    const canonical: CanonicalRequest = {
      model: "claude-req",
      messages: [{ role: "user", content: "hi there" }],
    };
    const events = [
      { type: "text_delta" as const, text: "hello world" },
      { type: "message_end" as const, finishReason: "stop" as const },
    ];
    const shim = entry({ gaps: ["stream_usage"] });
    const trace = newTrace({
      requestId: "t-su",
      startedAt: Date.now(),
      client: "test",
      sourceApi: "anthropic",
    });
    await runWithTrace(trace, () =>
      finishPassthroughTrace({
        reason: "test",
        requestedModel: "claude-req",
        canonical,
        result: {
          value: {
            upstream: {} as unknown as UpstreamStreamResponse,
            upstreamAc: new AbortController(),
          },
          target: { provider: "shim", model: "claude-upstream" },
          entry: shim,
          hops: [
            { provider: "shim", model: "claude-upstream", outcome: "ok", ms: 1 },
          ],
        },
        observation: { events, terminal: { type: "message_stop" } },
        signal: new AbortController().signal,
        iterated: true,
      }),
    );
    expect(trace.inputTokens).toBe(estimateInputTokens(canonical));
    expect(trace.outputTokens).toBe(estimateOutputTokens(events));
    expect(trace.costEstimated).toBe(true);
    expect(trace.notes.map((n) => n.code)).toContain("usage_estimated");
  });
});

describe("provider presets (v1.5 spec §3.3)", () => {
  it("ollama-anthropic preset fills type, base_url, gaps and passthrough", () => {
    const config = yamlConfig(`\
default: shim
providers:
  shim:
    preset: ollama-anthropic
`);
    const shim = config.registry.get("shim");
    expect(shim.type).toBe("anthropic");
    expect(shim.baseUrl).toBe("http://localhost:11434");
    expect(shim.passthrough).toBe(true);
    expect(shim.preset).toBe("ollama-anthropic");
    expect(shim.gaps).toEqual(
      expect.arrayContaining(["count_tokens", "url_images"]),
    );
    expect(shim.apiKey).toBeUndefined();
  });

  it("explicit gaps override preset", () => {
    const config = yamlConfig(`\
default: shim
providers:
  shim:
    preset: ollama-anthropic
    gaps: [stream_usage]
`);
    const shim = config.registry.get("shim");
    expect(shim.gaps).toEqual(["stream_usage"]);
    expect(shim.baseUrl).toBe("http://localhost:11434");
    expect(shim.passthrough).toBe(true);
  });

  it("unknown preset rejected at config load", () => {
    expect(() =>
      yamlConfig(`\
default: shim
providers:
  shim:
    preset: not-a-preset
`),
    ).toThrow(ConfigurationError);
  });

  it("lmstudio-anthropic preset gaps are the measured ones", () => {
    expect(PROVIDER_PRESETS["lmstudio-anthropic"].gaps).toEqual([
      "count_tokens",
      "documents",
      "tool_choice",
    ]);
  });

  it("glm-anthropic preset gaps are the measured ones", () => {
    expect(PROVIDER_PRESETS["glm-anthropic"].gaps).toEqual([
      "count_tokens",
      "documents",
      "tool_choice",
      "url_images",
    ]);
  });
});
