import { describe, expect, it } from "vitest";
import {
  FCC_PROVIDER_ID,
  fccCustomProviders,
  fccModelRef,
  fccUpstreamModelId,
  redactGatewayOutput,
} from "./free-claude-code";

/**
 * The live-mode gateway log (v1.6 Task 13f): FCC's stdout/stderr are
 * teed to tmp/conformance/live/<gateway>-<scenario>.gateway.log with
 * the same key redaction the spy applies — sensitive header values
 * and key=/api_key=/access_token= query values land as <redacted>,
 * never in clear.
 */
describe("free-claude-code gateway log redaction (v1.6 Task 13f)", () => {
  it("redacts keys the same way the spy does", () => {
    const out = redactGatewayOutput(
      "GET /v1/chat/completions?key=sk-live-secret&api_key=hunter2 200\n" +
        "Authorization: Bearer sk-live-secret\n" +
        "x-goog-api-key: sk-live-secret\n" +
        '{"api_key": "sk-live-secret"}\n' +
        "listening on 127.0.0.1:8080 model deepseek/deepseek-v4.1-flash\n",
    );
    expect(out).not.toContain("sk-live-secret");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("<redacted>");
    // Ordinary output passes through untouched.
    expect(out).toContain("listening on 127.0.0.1:8080");
    expect(out).toContain("deepseek/deepseek-v4.1-flash");
  });
});

/**
 * The client model ref (v1.6 Task 13f): FCC resolves `provider/model`
 * on the request's own model field. A bare OpenRouter `vendor/model`
 * (`deepseek/deepseek-v4.1-flash`) collides with its built-in
 * `deepseek` provider id — it routes to api.deepseek.com with no key
 * and never reaches the configured custom provider (the 13d/13b live
 * cells' no-upstream-call 400/503). The client-facing ref must carry
 * the custom provider prefix; the upstream keeps the bare model id.
 */
describe("free-claude-code model refs (v1.6 Task 13f)", () => {
  it("fccModelRef prefixes a bare model and keeps a prefixed one", () => {
    expect(fccModelRef("mock-chat")).toBe(`${FCC_PROVIDER_ID}/mock-chat`);
    expect(
      fccModelRef(`${FCC_PROVIDER_ID}/deepseek/deepseek-v4.1-flash`),
    ).toBe(`${FCC_PROVIDER_ID}/deepseek/deepseek-v4.1-flash`);
    expect(FCC_PROVIDER_ID).toMatch(/^custom_[0-9a-f]{32}$/);
  });

  it("fccUpstreamModelId strips only the custom provider prefix", () => {
    expect(
      fccUpstreamModelId(
        `${FCC_PROVIDER_ID}/deepseek/deepseek-v4.1-flash`,
      ),
    ).toBe("deepseek/deepseek-v4.1-flash");
    expect(fccUpstreamModelId("mock-chat")).toBe("mock-chat");
  });

  it("the custom provider config lists the bare upstream model id", () => {
    const providers = JSON.parse(
      fccCustomProviders(
        "http://127.0.0.1:4599",
        `${FCC_PROVIDER_ID}/deepseek/deepseek-v4.1-flash`,
      ),
    ) as { provider_id: string; base_url: string; model_ids: string[] }[];
    expect(providers).toHaveLength(1);
    expect(providers[0].provider_id).toBe(FCC_PROVIDER_ID);
    expect(providers[0].base_url).toBe("http://127.0.0.1:4599/v1");
    // The model id the upstream sees — the ref minus the prefix.
    expect(providers[0].model_ids).toEqual([
      "deepseek/deepseek-v4.1-flash",
    ]);
  });
});
