import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
} from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { http, HttpResponse, passthrough } from "msw";
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

  it("6to4 address embedding a private v4 is refused", async () => {
    await expectRejection(
      fetchMedia("http://app.example/pic.png", {
        allowPrivate: false,
        resolve: async () => ["2002:0a00:0001::1"],
      }),
      "private",
      "app.example",
    );
  });

  it("teredo address is refused", async () => {
    await expectRejection(
      fetchMedia("http://app.example/pic.png", {
        allowPrivate: false,
        resolve: async () => ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
      }),
      "private",
      "app.example",
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

  it("host-name url connects to the checked address", async () => {
    // Node ≥ 20 defaults net.autoSelectFamily to true, so http/https
    // call the pinned `lookup` with {all:true} and expect a
    // [{address, family}] callback — a lookup that ignores `all`
    // fails every host-name URL with "request failed"
    // (https://nodejs.org/api/net.html#socketconnectoptions-connectlistener).
    // A real loopback server exercises it end to end; msw bypasses
    // the request (passthrough keeps the request's own connect
    // options, `lookup` included).
    const pdfBody = "%PDF-1.4 babelgate loopback body";
    const real = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(pdfBody);
    });
    await new Promise<void>((resolveListen) =>
      real.listen(0, "127.0.0.1", resolveListen),
    );
    try {
      const port = (real.address() as AddressInfo).port;
      server.use(
        http.get(`http://localhost:${port}/*`, () => passthrough()),
      );

      const out = await fetchMedia(`http://localhost:${port}/doc.pdf`, {
        allowPrivate: true,
        resolve: async () => ["127.0.0.1"],
      });

      expect(out.mimeType).toBe("application/pdf");
      expect(Buffer.from(out.data, "base64").toString()).toBe(pdfBody);
    } finally {
      await new Promise<void>((resolveClose) =>
        real.close(() => resolveClose()),
      );
    }
  });

  it("host-name url follows a redirect to the checked address", async () => {
    // Same pinned-lookup path on the second hop: the 302 target is a
    // host name, so its lookup runs under autoSelectFamily too.
    const pdfBody = "%PDF-1.4 babelgate redirected body";
    const real = createServer((req, res) => {
      const port = (real.address() as AddressInfo).port;
      if (req.url === "/final.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(pdfBody);
      } else {
        res.writeHead(302, {
          Location: `http://localhost:${port}/final.pdf`,
        });
        res.end();
      }
    });
    await new Promise<void>((resolveListen) =>
      real.listen(0, "127.0.0.1", resolveListen),
    );
    try {
      const port = (real.address() as AddressInfo).port;
      server.use(
        http.get(`http://localhost:${port}/*`, () => passthrough()),
      );

      const out = await fetchMedia(`http://localhost:${port}/doc.pdf`, {
        allowPrivate: true,
        resolve: async () => ["127.0.0.1"],
      });

      expect(out.mimeType).toBe("application/pdf");
      expect(Buffer.from(out.data, "base64").toString()).toBe(pdfBody);
    } finally {
      await new Promise<void>((resolveClose) =>
        real.close(() => resolveClose()),
      );
    }
  });
});
