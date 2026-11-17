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
import { fetchMedia, MediaFetchError } from "./media-fetch";

/**
 * fetchMedia (v1.5 spec §3.2.2): scheme + private-address guard on
 * every resolved IP and every redirect hop, 20 MB / 15 s caps, no
 * unbounded buffering. DNS is injected so tests never touch the
 * network; msw intercepts the checked requests.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function expectRejection(
  promise: Promise<unknown>,
  reason: string,
  host?: string,
): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MediaFetchError);
  const fetchErr = err as MediaFetchError;
  expect(fetchErr.reason).toBe(reason);
  if (host !== undefined) expect(fetchErr.host).toBe(host);
}

describe("fetchMedia (v1.5 spec §3.2.2)", () => {
  it("fetches a public png", async () => {
    server.use(
      http.get(
        "http://media.example/pic.png",
        () =>
          new HttpResponse(PNG, {
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );

    const out = await fetchMedia("http://media.example/pic.png", {
      allowPrivate: false,
      resolve: publicResolver,
    });

    expect(out.mimeType).toBe("image/png");
    expect(Buffer.from(out.data, "base64")).toEqual(PNG);
  });

  it("non-http scheme refused", async () => {
    await expectRejection(
      fetchMedia("ftp://media.example/pic.png", {
        allowPrivate: false,
        resolve: publicResolver,
      }),
      "scheme",
      "media.example",
    );
    await expectRejection(
      fetchMedia("file:///etc/passwd", { allowPrivate: false }),
      "scheme",
    );
    await expectRejection(
      fetchMedia("data:image/png;base64,aGk=", { allowPrivate: false }),
      "scheme",
    );
  });

  it("loopback refused", async () => {
    await expectRejection(
      fetchMedia("http://app.example/pic.png", {
        allowPrivate: false,
        resolve: async () => ["127.0.0.1"],
      }),
      "private",
      "app.example",
    );
    // a loopback literal never even reaches the resolver
    await expectRejection(
      fetchMedia("http://127.0.0.1/pic.png", {
        allowPrivate: false,
        resolve: publicResolver,
      }),
      "private",
      "127.0.0.1",
    );
  });

  it("metadata address refused", async () => {
    await expectRejection(
      fetchMedia("http://169.254.169.254/latest/meta-data", {
        allowPrivate: false,
      }),
      "private",
      "169.254.169.254",
    );
  });

  it("redirect to private address is refused", async () => {
    let internalRequested = false;
    server.use(
      http.get("http://pub.example/redirect", () =>
        HttpResponse.redirect("http://internal.example/secret.png", 302),
      ),
      http.get("http://internal.example/secret.png", () => {
        internalRequested = true;
        return new HttpResponse(PNG, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    await expectRejection(
      fetchMedia("http://pub.example/redirect", {
        allowPrivate: false,
        resolve: async (host) =>
          host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"],
      }),
      "private",
      "internal.example",
    );
    expect(internalRequested).toBe(false);
  });

  it("rebinding resolver is refused", async () => {
    // A DNS answer mixing a public and a private address is the
    // rebinding signature — every resolved IP is checked before any
    // connection, so the request is refused outright.
    await expectRejection(
      fetchMedia("http://rebind.example/pic.png", {
        allowPrivate: false,
        resolve: async () => ["93.184.216.34", "10.0.0.5"],
      }),
      "private",
      "rebind.example",
    );
  });

  it("over-cap download aborted", async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    server.use(
      http.get(
        "http://media.example/big.pdf",
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                // 25 MB > the 20 MB cap; no Content-Length header so
                // the cap must fire mid-stream, before all of it is
                // buffered.
                for (let i = 0; i < 25; i++) controller.enqueue(megabyte);
                controller.close();
              },
            }),
            { headers: { "Content-Type": "application/pdf" } },
          ),
      ),
    );

    await expectRejection(
      fetchMedia("http://media.example/big.pdf", {
        allowPrivate: false,
        resolve: publicResolver,
      }),
      "size",
      "media.example",
    );
  });

  it("slow host times out", async () => {
    server.use(
      http.get(
        "http://media.example/slow.png",
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(4));
                // never closes — the host trickles bytes forever
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      ),
    );

    await expectRejection(
      fetchMedia("http://media.example/slow.png", {
        allowPrivate: false,
        timeoutMs: 50,
        resolve: publicResolver,
      }),
      "timeout",
      "media.example",
    );
  });

  it("allow_private permits 10.0.0.5", async () => {
    server.use(
      http.get(
        "http://lan.example/pic.png",
        () =>
          new HttpResponse(PNG, {
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );

    const out = await fetchMedia("http://lan.example/pic.png", {
      allowPrivate: true,
      resolve: async () => ["10.0.0.5"],
    });

    expect(out.mimeType).toBe("image/png");
    expect(Buffer.from(out.data, "base64")).toEqual(PNG);
  });
});
