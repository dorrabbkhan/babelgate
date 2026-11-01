import { describe, it, expect } from "vitest";
import { hopOutcome, isFallbackEligible } from "./fallback";
import {
  TransformError,
  UpstreamError,
  ValidationError,
} from "../utils/errors";

/**
 * Spec §3.4: transport failure, header/connect timeout and upstream
 * 429/500/502/503/504/529 move to the next target; every other error —
 * including non-JSON 2xx and anything raised before the upstream call —
 * fails immediately. hopOutcome classifies the same UpstreamError
 * shapes for the route log line.
 */

const timeout = () =>
  new UpstreamError(
    "Upstream timed out after 50ms",
    undefined,
    undefined,
    {},
    504,
  );

const transport = () => new UpstreamError("Upstream unreachable");

describe("isFallbackEligible", () => {
  it("eligibility table", () => {
    const eligible: [string, unknown][] = [
      ...[429, 500, 502, 503, 504, 529].map(
        (s): [string, unknown] => [
          `upstream ${s}`,
          new UpstreamError(`Upstream returned ${s}`, s, {}),
        ],
      ),
      ["header/connect timeout", timeout()],
      ["transport failure", transport()],
    ];
    for (const [name, err] of eligible) {
      expect(isFallbackEligible(err), name).toBe(true);
    }

    const ineligible: [string, unknown][] = [
      ...[400, 401, 403, 404, 413, 422].map(
        (s): [string, unknown] => [
          `upstream ${s}`,
          new UpstreamError(`Upstream returned ${s}`, s, {}),
        ],
      ),
      ["non-JSON 2xx", new UpstreamError("non-JSON body", 200)],
      ["ValidationError", new ValidationError("bad request")],
      ["TransformError", new TransformError("encode failed")],
      ["non-proxy error", new Error("boom")],
    ];
    for (const [name, err] of ineligible) {
      expect(isFallbackEligible(err), name).toBe(false);
    }
  });
});

describe("hopOutcome", () => {
  it("classifies the UpstreamError shapes; undefined for anything else", () => {
    expect(hopOutcome(new UpstreamError("e", 503, {}))).toBe("http_error");
    expect(hopOutcome(new UpstreamError("e", 200))).toBe("http_error");
    expect(hopOutcome(timeout())).toBe("timeout");
    expect(hopOutcome(transport())).toBe("transport");
    expect(hopOutcome(new ValidationError("x"))).toBeUndefined();
    expect(hopOutcome(new TransformError("x"))).toBeUndefined();
    expect(hopOutcome(new Error("x"))).toBeUndefined();
    expect(hopOutcome("not an error")).toBeUndefined();
  });
});
