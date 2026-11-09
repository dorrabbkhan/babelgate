import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../config/env-config";
import { registerSink, type TraceSink } from "../observe/emit";
import type { RequestTrace } from "../observe/trace";
import { streamCanonical } from "../services/chat-stream.service";
import type {
  CanonicalRequest,
  CanonicalUsage,
} from "../types/canonical.types";
import { ProxyError } from "../utils/errors";
import { uiError } from "./access";

/**
 * `POST /ui/api/playground` (spec §3.9): `{messages, system?, models:
 * string[2..4], params?}` runs every model through planRoute →
 * attempt → its own trace (`client: "playground"`, one per model),
 * multiplexed onto one SSE response:
 *   `event: delta data: {model, text}`
 *   `event: done  data: {model, usage, costUsd, ms}`
 *   `event: error data: {model, message}`   (canonical message only)
 * A client disconnect aborts every upstream at once.
 */

const playgroundBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
  system: z.string().optional(),
  models: z.array(z.string().min(1)).min(2).max(4),
  params: z
    .object({
      maxTokens: z.number().int().min(1).max(4096).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
});

/**
 * `done` needs the finished trace's priced fields (usage, costUsd,
 * totalMs). finishTrace prices in the background and then fans the
 * trace out to sinks, so this sink resolves per-requestId waiters:
 * the only place the response path may see a priced trace is after
 * emitTrace. Bodies are stripped before this sink (name "playground"
 * is not in BODY_SINKS), exactly like the log sink.
 */
const traceWaiters = new Map<string, (trace: RequestTrace) => void>();

const playgroundSink: TraceSink = {
  name: "playground",
  accept: (trace) => {
    const waiter = traceWaiters.get(trace.requestId);
    if (waiter !== undefined) {
      traceWaiters.delete(trace.requestId);
      waiter(trace);
    }
  },
};

/**
 * Resolve once the trace emits — every started stream emits exactly
 * once, so this waits only for pricing (a cold live-price model list
 * can take up to a full upstream attempt cycle, hence the generous
 * cap; it exists so a sink fault can't hold the response open).
 */
const TRACE_WAIT_MS = 65_000;

function waitForTrace(
  requestId: string,
): Promise<RequestTrace | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      traceWaiters.delete(requestId);
      resolve(undefined);
    }, TRACE_WAIT_MS);
    timer.unref();
    traceWaiters.set(requestId, (trace) => {
      clearTimeout(timer);
      resolve(trace);
    });
  });
}

function usageFromTrace(
  trace: RequestTrace | undefined,
): CanonicalUsage | undefined {
  if (
    trace === undefined ||
    trace.inputTokens === undefined ||
    trace.outputTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    totalTokens: trace.inputTokens + trace.outputTokens,
    ...(trace.cacheReadTokens !== undefined
      ? { cacheReadTokens: trace.cacheReadTokens }
      : {}),
    ...(trace.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: trace.cacheWriteTokens }
      : {}),
  };
}

export function playgroundRouter(): Router {
  const router = Router();

  router.post("/playground", async (req, res, next) => {
    const parsed = playgroundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return uiError(
        res,
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid playground body",
      );
    }
    const { messages, system, models, params } = parsed.data;
    const config = getConfig();
    registerSink(playgroundSink);

    // Client disconnect → abort every model's upstream at once. On a
    // completed response "close" still fires, so guard on completion.
    const ac = new AbortController();
    let completed = false;
    res.on("close", () => {
      if (!completed) ac.abort();
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const requestBase = String(req.id);

    const runModel = async (
      model: string,
      index: number,
    ): Promise<void> => {
      // One trace per model; `${req.id}:${i}` keeps the rows grouped
      // under the playground request that spawned them.
      const requestId = `${requestBase}:${index}`;
      // The waiter is registered before the stream starts so an
      // already-priced trace can't race past it.
      const tracePromise = waitForTrace(requestId);
      const canonical: CanonicalRequest = {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...(system !== undefined ? { systemPrompt: system } : {}),
        config: {
          maxTokens: params?.maxTokens ?? 512,
          ...(params?.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
        },
        stream: true,
      };
      const started = Date.now();
      let usage: CanonicalUsage | undefined;
      let message: string | undefined;
      try {
        for await (const event of streamCanonical(
          canonical,
          model,
          config,
          { requestId, signal: ac.signal, client: "playground" },
        )) {
          if (event.type === "text_delta") {
            send("delta", { model, text: event.text });
          } else if (event.type === "usage") {
            usage = event.usage;
          } else if (event.type === "error") {
            message = event.error.message;
          }
        }
      } catch (err) {
        // All targets failed before the stream started — the
        // canonical message, never the error's internals.
        message =
          err instanceof ProxyError
            ? err.toCanonical().message
            : "Playground request failed";
      }
      if (message !== undefined) {
        send("error", { model, message });
        return;
      }
      const trace = await tracePromise;
      send("done", {
        model,
        usage: usageFromTrace(trace) ?? usage ?? null,
        costUsd: trace?.costUsd ?? null,
        ms: trace?.totalMs ?? Date.now() - started,
      });
    };

    try {
      await Promise.all(
        models.map((model, index) => runModel(model, index)),
      );
    } catch (err) {
      return next(err);
    } finally {
      completed = true;
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}
