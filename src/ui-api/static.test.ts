import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { GatewayConfig } from "../config/env-config";
import { uiStatic } from "./static";

/**
 * /ui static mount (spec §3.9 access): without a key the socket must
 * be loopback (or UI_ALLOW_REMOTE); with a key the assets are served
 * without it — they contain no data. Driven directly with a fake
 * socket address, like the uiAccess socket-rule tests; the dir holds
 * a real index.html so "served" means the fallback actually ran.
 */

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

function fakeReq(init: { remoteAddress?: string }): Request {
  return {
    method: "GET",
    url: "/does-not-exist.js",
    path: "/does-not-exist.js",
    headers: {},
    socket: { remoteAddress: init.remoteAddress },
  } as unknown as Request;
}

function fakeRes(): Response & {
  statusCode: number;
  body: unknown;
  sendFile: ReturnType<typeof vi.fn>;
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
    sendFile: vi.fn((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as
        | ((err?: Error) => void)
        | undefined;
      cb?.();
    }),
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    sendFile: ReturnType<typeof vi.fn>;
  };
}

let uiDir: string;

beforeEach(() => {
  uiDir = mkdtempSync(join(tmpdir(), "ui-static-"));
  writeFileSync(join(uiDir, "index.html"), "<html>spa</html>");
});

afterEach(() => {
  rmSync(uiDir, { recursive: true, force: true });
});

describe("uiStatic socket rules", () => {
  it("static ui: no key, remote socket gets 403 with the hint", () => {
    const res = fakeRes();
    const next = vi.fn();
    uiStatic(config(), uiDir)(
      fakeReq({ remoteAddress: "10.0.0.5" }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "FORBIDDEN",
        message:
          "The UI answers only this machine. Set PROXY_API_KEY, or UI_ALLOW_REMOTE=true, to open it to the network.",
      },
    });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "::ffff:127.0.0.1"])(
    "static ui: no key, loopback socket %s is served",
    async (addr) => {
      const res = fakeRes();
      const next = vi.fn();
      uiStatic(config(), uiDir)(
        fakeReq({ remoteAddress: addr }),
        res,
        next,
      );
      // express.static resolves the miss asynchronously, then the
      // SPA fallback answers with index.html.
      await vi.waitFor(() => {
        // root-relative, not an absolute path: send()'s dotfiles
        // check must not see the install path's dot segments.
        expect(res.sendFile).toHaveBeenCalledWith(
          "index.html",
          { root: uiDir },
          expect.any(Function),
        );
      });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    },
  );

  it("static ui: key set, remote socket is served without the key", async () => {
    const res = fakeRes();
    const next = vi.fn();
    uiStatic(config({ proxyApiKey: "secret" }), uiDir)(
      fakeReq({ remoteAddress: "10.0.0.5" }),
      res,
      next,
    );
    await vi.waitFor(() => {
      expect(res.sendFile).toHaveBeenCalled();
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("static ui: UI_ALLOW_REMOTE serves a remote socket", async () => {
    const res = fakeRes();
    const next = vi.fn();
    uiStatic(
      config({ observe: { uiAllowRemote: true } as never }),
      uiDir,
    )(fakeReq({ remoteAddress: "10.0.0.5" }), res, next);
    await vi.waitFor(() => {
      expect(res.sendFile).toHaveBeenCalled();
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

/**
 * The SEA asset source (v1.6 spec §3.2): the same handler serves the
 * same paths from an in-memory get("ui/<rel>") map instead of disk —
 * same index.html fallback, same access rules.
 */
function assetReq(path: string, remoteAddress = "127.0.0.1"): Request {
  return {
    method: "GET",
    url: path,
    path,
    headers: {},
    socket: { remoteAddress },
  } as unknown as Request;
}

function assetRes(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

describe("uiStatic assets source (SEA)", () => {
  const files: Record<string, string> = {
    "ui/index.html": "<html>spa</html>",
    "ui/assets/app-a1b2c3.js": "console.log('app')",
  };
  const assets = {
    get(path: string): Buffer | undefined {
      const file = files[path];
      return file === undefined ? undefined : Buffer.from(file);
    },
  };

  it("assets source serves index and a hashed asset with content-type", () => {
    const index = assetRes();
    const indexNext = vi.fn();
    uiStatic(config(), undefined, assets)(assetReq("/"), index, indexNext);
    expect(indexNext).not.toHaveBeenCalled();
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(String(index.body)).toBe("<html>spa</html>");

    const res = assetRes();
    const next = vi.fn();
    uiStatic(config(), undefined, assets)(
      assetReq("/assets/app-a1b2c3.js"),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(String(res.body)).toBe("console.log('app')");
  });

  it("assets source falls back to index for client routes", () => {
    const res = assetRes();
    const next = vi.fn();
    uiStatic(config(), undefined, assets)(assetReq("/routing"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(String(res.body)).toBe("<html>spa</html>");
  });

  it("assets source keeps the loopback rule", () => {
    const get = vi.fn(assets.get);
    const res = assetRes();
    const next = vi.fn();
    uiStatic(config(), undefined, { get })(
      assetReq("/", "10.0.0.5"),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "FORBIDDEN",
        message:
          "The UI answers only this machine. Set PROXY_API_KEY, or UI_ALLOW_REMOTE=true, to open it to the network.",
      },
    });
    expect(get).not.toHaveBeenCalled();
  });
});
