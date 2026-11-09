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
