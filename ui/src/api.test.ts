import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamLive, UiApiError } from "./api";

/**
 * streamLive's reconnect loop (spec §3.9 /live): exponential backoff
 * 0.5 s → 30 s, reset by a successful connect; a 401/403 reports via
 * onError and stops — a saved key may fix it, blind retrying cannot.
 */

const fetchMock = vi.fn();

/** A response whose body is an SSE stream that ends immediately. */
function eofResponse(): Response {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => Promise.resolve({ done: true, value: undefined }),
      }),
    },
  } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () =>
      Promise.resolve({ error: { code: "ERROR", message } }),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streamLive reconnect", () => {
  it("live reconnects with backoff 500, 1000, 2000 ms and resets after a successful connect", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const feed = streamLive({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // attempt is now 3 → the next failure waits 4000 ms; then a
    // successful connect (stream ends cleanly) resets it to 0.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockResolvedValueOnce(eofResponse());
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // after the reset the first retry is 500 ms again, not 16 s
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    feed.close();
  });

  it("a 403 response stops reconnecting and calls onError", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const onError = vi.fn();
    const feed = streamLive({ onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as unknown;
    expect(err).toBeInstanceOf(UiApiError);
    expect((err as UiApiError).status).toBe(403);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    feed.close();
  });
});
