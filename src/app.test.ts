import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "./app";

describe("app", () => {
  it("returns 413 for bodies over MAX_BODY_SIZE", async () => {
    vi.stubEnv("MAX_BODY_SIZE", "1kb");
    vi.resetModules();
    const { app: limitedApp } = await import("./app");

    const res = await request(limitedApp)
      .post("/v1/chat/completions")
      .send({ data: "x".repeat(2000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("request_too_large");
    vi.unstubAllEnvs();
  });
  describe("PROXY_API_KEY auth", () => {
    it("rejects proxy requests with 401 when key is set and missing/wrong", async () => {
      vi.stubEnv("PROXY_API_KEY", "test-proxy-key");
      vi.resetModules();
      const { app: authedApp } = await import("./app");

      const noHeader = await request(authedApp)
        .post("/v1/chat/completions")
        .send({});
      expect(noHeader.status).toBe(401);
      expect(noHeader.body.error.code).toBe("authentication");

      const wrongKey = await request(authedApp)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer nope")
        .send({});
      expect(wrongKey.status).toBe(401);
      vi.unstubAllEnvs();
    });

    it("keeps /health open even when PROXY_API_KEY is set", async () => {
      vi.stubEnv("PROXY_API_KEY", "test-proxy-key");
      vi.resetModules();
      const { app: authedApp } = await import("./app");

      const res = await request(authedApp).get("/health");
      expect(res.status).toBe(200);
      vi.unstubAllEnvs();
    });
  });

  describe("GET /health", () => {
    it("should return 200 with status ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("404 handler", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await request(app).get("/unknown-route");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /ui (spec §3.9)", () => {
    it("UI=off answers the same 404 as an unmatched route", async () => {
      process.env.TARGET_API = "ollama";
      process.env.OLLAMA_API_BASE_URL = "http://ollama.mock";
      process.env.USAGE_STORE = "off";
      process.env.UI = "off";
      const { resetConfig } = await import("./config/env-config");
      resetConfig();
      try {
        const res = await request(app).get("/ui");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          error: { message: "Not Found", code: "NOT_FOUND", status: 404 },
        });
      } finally {
        delete process.env.TARGET_API;
        delete process.env.OLLAMA_API_BASE_URL;
        delete process.env.USAGE_STORE;
        delete process.env.UI;
        resetConfig();
      }
    });
  });
});
