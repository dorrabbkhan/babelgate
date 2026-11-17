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
import { inlineMediaForTarget } from "./media-inline";
import { MEDIA_SUPPORT } from "../transformers/adapters";
import { runWithAttempt } from "../observe/context";
import { ValidationError } from "../utils/errors";
import type {
  CanonicalContentPart,
  CanonicalRequest,
} from "../types/canonical.types";

/**
 * inlineMediaForTarget (v1.5 spec §3.2.2): per target-attempt, URL
 * media the target can take by URL passes through untouched; URL media
 * it can't is fetched (guarded by media-fetch) and inlined; media it
 * can't take at all is a ValidationError naming the field path and the
 * target.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
const PDF = Buffer.from("%PDF-1.4 babelgate");
const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];
const MEDIA = {
  fetch: true,
  allowPrivate: false,
  resolve: publicResolver,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function requestWithParts(parts: CanonicalContentPart[]): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: parts }],
  };
}

describe("inlineMediaForTarget (v1.5 spec §3.2.2)", () => {
  it("url image kept for url-capable target", async () => {
    const req = requestWithParts([
      { type: "text", text: "see" },
      { type: "image", image: { url: "http://media.example/pic.png" } },
    ]);

    const out = await inlineMediaForTarget(req, MEDIA_SUPPORT.openai, MEDIA);

    expect(out).toBe(req);
  });

  it("url image inlined for ollama", async () => {
    server.use(
      http.get(
        "http://media.example/pic.png",
        () =>
          new HttpResponse(PNG, {
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );
    const req = requestWithParts([
      { type: "text", text: "see" },
      { type: "image", image: { url: "http://media.example/pic.png" } },
    ]);

    const out = await runWithAttempt(
      { providerName: "local-ollama", upstreamModel: "m" },
      () => inlineMediaForTarget(req, MEDIA_SUPPORT.ollama, MEDIA),
    );

    expect(out.messages[0].content).toEqual([
      { type: "text", text: "see" },
      {
        type: "image",
        image: { data: PNG.toString("base64"), mimeType: "image/png" },
      },
    ]);
    // the input request is never mutated
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "image", image: { url: "http://media.example/pic.png" } },
    ]);
  });

  it("pdf to ollama refused naming the field", async () => {
    const req = requestWithParts([
      { type: "text", text: "read" },
      {
        type: "document",
        document: {
          data: PDF.toString("base64"),
          mimeType: "application/pdf",
          name: "spec.pdf",
        },
      },
    ]);

    const promise = runWithAttempt(
      { providerName: "local-ollama", upstreamModel: "m" },
      () => inlineMediaForTarget(req, MEDIA_SUPPORT.ollama, MEDIA),
    );
    await expect(promise).rejects.toThrow(ValidationError);
    await expect(promise).rejects.toThrow(/messages\[0\]\.content\[1\]/);
    await expect(promise).rejects.toThrow(/local-ollama/);
  });

  it("fetch:false refuses when bytes needed", async () => {
    const req = requestWithParts([
      { type: "image", image: { url: "http://media.example/pic.png" } },
    ]);

    await expect(
      inlineMediaForTarget(req, MEDIA_SUPPORT.ollama, {
        fetch: false,
        allowPrivate: false,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("url document kept for url-capable target", async () => {
    const req = requestWithParts([
      {
        type: "document",
        document: {
          url: "http://media.example/spec.pdf",
          mimeType: "application/pdf",
          name: "spec.pdf",
        },
      },
    ]);

    const out = await inlineMediaForTarget(
      req,
      MEDIA_SUPPORT.anthropic,
      MEDIA,
    );

    expect(out).toBe(req);
  });

  it("url document inlined for data-only target", async () => {
    server.use(
      http.get(
        "http://media.example/spec.pdf",
        () =>
          new HttpResponse(PDF, {
            headers: { "Content-Type": "application/pdf" },
          }),
      ),
    );
    const req = requestWithParts([
      {
        type: "document",
        document: {
          url: "http://media.example/spec.pdf",
          mimeType: "application/pdf",
          name: "spec.pdf",
        },
      },
    ]);

    const out = await runWithAttempt(
      { providerName: "gw", upstreamModel: "m" },
      () => inlineMediaForTarget(req, MEDIA_SUPPORT.openai, MEDIA),
    );

    expect(out.messages[0].content).toEqual([
      {
        type: "document",
        document: {
          data: PDF.toString("base64"),
          mimeType: "application/pdf",
          name: "spec.pdf",
        },
      },
    ]);
  });

  it("text/plain document becomes a text part for every target", async () => {
    const req = requestWithParts([
      {
        type: "document",
        document: {
          data: Buffer.from("plain words").toString("base64"),
          mimeType: "text/plain",
          name: "notes.txt",
        },
      },
    ]);

    for (const support of Object.values(MEDIA_SUPPORT)) {
      const out = await inlineMediaForTarget(req, support, MEDIA);
      expect(out.messages[0].content).toEqual([
        { type: "text", text: "plain words" },
      ]);
    }
  });
});
