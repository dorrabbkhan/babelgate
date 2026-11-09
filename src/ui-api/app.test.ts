import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { GatewayConfig } from "../config/env-config";
import { uiStatic } from "./static";

/**
 * The SPA fallback through a real express app (spec §3.9): the
 * static.test.ts fake mocks res.sendFile, so only a real send can see
 * the fallback fail when the install path itself contains a dot
 * segment (nvm/npx-style roots such as ~/.nvm, ~/.npm/_npx, ~/.local).
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

describe("uiStatic SPA fallback", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serves index.html when the install path has a dot segment", async () => {
    root = mkdtempSync(join(tmpdir(), "ui-app-"));
    const uiDir = join(root, ".hidden", "ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(
      join(uiDir, "index.html"),
      "<html>dotted-root-spa</html>",
    );

    const app = express();
    app.use("/ui", uiStatic(config(), uiDir));
    app.use((_req, res) => {
      res.status(404).json({ error: { code: "NOT_FOUND" } });
    });

    const res = await request(app).get("/ui/requests/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain("dotted-root-spa");
  });
});
