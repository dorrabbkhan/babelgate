/**
 * `POST /ui/api/playground` client (spec §3.9, Task 15) — kept apart
 * from api.ts because it is the only one-shot SSE POST; the other
 * endpoints are plain fetches and the `/live` reconnect loop.
 */
import { parseSseChunk, uiFetch } from "./api";

/** `POST /playground` body (spec §3.9). */
export interface PlaygroundRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  models: string[];
  params?: { maxTokens?: number; temperature?: number };
}

/** `POST /playground` `done` event payload. */
export interface PlaygroundDone {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
  costUsd: number | null;
  ms: number;
}

export interface PlaygroundHandlers {
  onDelta?: (event: { model: string; text: string }) => void;
  onDone?: (event: PlaygroundDone) => void;
  /** One model failed — the others keep streaming. */
  onModelError?: (event: { model: string; message: string }) => void;
  /** The run is over (all models done/errored) — success or fatal. */
  onEnd?: (err?: unknown) => void;
}

/**
 * `POST /playground` over fetch — EventSource cannot send
 * `x-babelgate-ui`, so the SSE stream is read and parsed here. A run
 * is one-shot: no reconnect; the stream ends when every model has
 * answered or the server closed the response.
 */
export function streamPlayground(
  body: PlaygroundRequest,
  handlers: PlaygroundHandlers,
): { close(): void } {
  const controller = new AbortController();
  let closed = false;

  const run = async (): Promise<void> => {
    try {
      const res = await uiFetch("/playground", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseChunk(buffer, (event, data) => {
          try {
            const parsed = JSON.parse(data) as { model: string };
            if (event === "delta")
              handlers.onDelta?.(
                parsed as { model: string; text: string },
              );
            else if (event === "done")
              handlers.onDone?.(parsed as PlaygroundDone);
            else if (event === "error")
              handlers.onModelError?.(
                parsed as { model: string; message: string },
              );
          } catch {
            // malformed frame — drop it, keep the stream
          }
        });
      }
      if (!closed) handlers.onEnd?.();
    } catch (err) {
      if (closed || controller.signal.aborted) return;
      handlers.onEnd?.(err);
    }
  };

  void run();
  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}
