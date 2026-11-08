import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import { app } from "../app";
import {
  resetConfig,
  type GatewayConfig,
} from "../config/env-config";
import { uiAccess } from "./access";

/**
 * /ui/api access control (spec §3.9, D2): UI=off → 404; Host allowlist
 * (DNS rebinding) → 403; x-babelgate-ui: 1 required → 403; with
 * PROXY_API_KEY the key is required; without one only loopback sockets
 * (or UI_ALLOW_REMOTE) get in. No CORS headers are ever sent.
 */

const UI = { "x-babelgate-ui": "1" };

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    proxyApiKey: undefined,
    ...overrides,
    observe: {
      ui: true,
      uiAllowRemote: false,
      uiAllowedHosts: [],
      ...overrides.observe,
    },
  } as GatewayConfig;
}

/** Minimal req/res stubs for driving the middleware directly. */
function fakeReq(init: {
  headers?: Record<string, string>;
  remoteAddress?: string;
}): Request {
  return {
    headers: init.headers ?? {},
    socket: { remoteAddress: init.remoteAddress },
  } as unknown as Request;
}

function fakeRes(): Response & {
  statusCode: number;
  body: unknown;
} {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
  };
}

beforeEach(() => {
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = "http://ollama.mock";
  // No usage DB work for access tests — the routes answer empty.
  process.env.USAGE_STORE = "off";
  resetConfig();
});

afterEach(() => {
  delete process.env.TARGET_API;
  delete process.env.OLLAMA_API_BASE_URL;
  delete process.env.USAGE_STORE;
  delete process.env.PROXY_API_KEY;
  delete process.env.UI;
  delete process.env.UI_ALLOW_REMOTE;
  delete process.env.UI_ALLOWED_HOSTS;
  resetConfig();
});

describe("uiAccess through the app", () => {
  it("UI=off answers 404", async () => {
    process.env.UI = "off";
    resetConfig();
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "localhost:3000");
    expect(res.status).toBe(404);
  });

  it("missing x-babelgate-ui header is refused", async () => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set("Host", "localhost:3000");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBeDefined();
  });

  it("a wrong x-babelgate-ui value is refused", async () => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set("x-babelgate-ui", "yes")
      .set("Host", "localhost:3000");
    expect(res.status).toBe(403);
  });

  it("DNS rebinding host is refused", async () => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "evil.example:3000");
    expect(res.status).toBe(403);
  });

  it.each([
    "localhost:3000",
    "localhost",
    "127.0.0.1:3000",
    "127.0.0.1",
    "[::1]:3000",
    "[::1]",
  ])("loopback Host %s (any port) is accepted", async (host) => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", host);
    expect(res.status).toBe(200);
  });

  it("a bracketed Host with junk after ] is refused", async () => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "[::1]junk");
    expect(res.status).toBe(403);
  });

  it("a bracketed Host with a numeric port is accepted", async () => {
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "[::1]:3000");
    expect(res.status).toBe(200);
  });

  it("UI_ALLOWED_HOSTS admits a named host", async () => {
    process.env.UI_ALLOWED_HOSTS = "gateway.lan";
    resetConfig();
    const res = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "gateway.lan:3000");
    expect(res.status).toBe(200);
  });

  it("key set: missing and wrong keys are refused", async () => {
    process.env.PROXY_API_KEY = "secret-ui-key";
    resetConfig();
    const missing = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "localhost");
    expect(missing.status).toBe(403);
    const wrong = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "localhost")
      .set("Authorization", "Bearer nope");
    expect(wrong.status).toBe(403);
  });

  it("key set: Bearer and x-api-key are accepted", async () => {
    process.env.PROXY_API_KEY = "secret-ui-key";
    resetConfig();
    const bearer = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "localhost")
      .set("Authorization", "Bearer secret-ui-key");
    expect(bearer.status).toBe(200);
    const apiKey = await request(app)
      .get("/ui/api/requests")
      .set(UI)
      .set("Host", "localhost")
      .set("x-api-key", "secret-ui-key");
    expect(apiKey.status).toBe(200);
  });

  it("preflight is never approved", async () => {
    const res = await request(app)
      .options("/ui/api/requests")
      .set("Host", "localhost")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "x-babelgate-ui");
    const headers = Object.keys(res.headers);
    expect(
      headers.some((h) => h.startsWith("access-control-allow")),
    ).toBe(false);
    expect(res.status).toBe(403);
  });
});

describe("uiAccess socket rules (direct middleware calls)", () => {
  it("no key: a non-loopback socket gets the hint text", () => {
    const res = fakeRes();
    let passed = false;
    uiAccess(config())(
      fakeReq({
        headers: { host: "localhost", "x-babelgate-ui": "1" },
        remoteAddress: "10.0.0.5",
      }),
      res,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: expect.any(String),
        message:
          "The UI answers only this machine. Set PROXY_API_KEY, or UI_ALLOW_REMOTE=true, to open it to the network.",
      },
    });
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"])(
    "no key: loopback socket %s passes",
    (addr) => {
      const res = fakeRes();
      let passed = false;
      uiAccess(config())(
        fakeReq({
          headers: { host: "localhost", "x-babelgate-ui": "1" },
          remoteAddress: addr,
        }),
        res,
        () => {
          passed = true;
        },
      );
      expect(passed).toBe(true);
    },
  );

  it("UI_ALLOW_REMOTE lets a remote socket in without a key", () => {
    const res = fakeRes();
    let passed = false;
    uiAccess(config({ observe: { uiAllowRemote: true } as never }))(
      fakeReq({
        headers: { host: "localhost", "x-babelgate-ui": "1" },
        remoteAddress: "10.0.0.5",
      }),
      res,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });

  it("with a key set a remote socket still needs the key", () => {
    const res = fakeRes();
    let passed = false;
    uiAccess(config({ proxyApiKey: "k" }))(
      fakeReq({
        headers: { host: "localhost", "x-babelgate-ui": "1" },
        remoteAddress: "10.0.0.5",
      }),
      res,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
