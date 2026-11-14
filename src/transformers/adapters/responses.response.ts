/**
 * Responses response codec (v1.4 spec §3.1): the Response object to
 * and from CanonicalResponse — output items, status/incomplete
 * details, and the Responses usage shape. Extracted from
 * responses.adapter.ts (rule 7).
 *
 * Wire-format sources:
 *  - Response object, `status`, `incomplete_details`, `output` items
 *    and `output_text`: https://platform.openai.com/docs/api-reference/responses/object
 *    and `openai` npm 7.30.1 `resources/responses/responses.d.ts`
 *    (`Response`, `ResponseOutputItem`).
 *  - Usage (`input_tokens`/`output_tokens`/`total_tokens`,
 *    `*_tokens_details`): same object reference + SDK `ResponseUsage`.
 *    `cache_write_tokens` and the response echo `access_programs` are
 *    evidenced only by the SDK typings — the API reference omits them.
 */
import { randomUUID } from "crypto";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalResponse,
  CanonicalUsage,
} from "../../types/canonical.types";
import { recordNote } from "../../observe/context";
import { toOutputContent } from "./responses.items";
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesUsage,
} from "../../types/responses.types";

function note(code: string, path: string, message: string): void {
  recordNote({ stage: "decode", adapter: "responses", code, path }, message);
}

// ============ RESPONSE: Responses → Canonical ============

export function toCanonicalResponse(
  response: ResponsesResponse,
  model: string,
): CanonicalResponse {
  const parts: CanonicalContentPart[] = [];
  const toolCalls: CanonicalMessage["toolCalls"] = [];

  for (const [i, item] of (response.output ?? []).entries()) {
    const typed = item as ResponsesOutputItem & { type?: string };
    if (typed.type === "message") {
      const content = (item as { content?: unknown[] }).content ?? [];
      for (const [j, part] of content.entries()) {
        const p = part as { type?: string; text?: string };
        if (p.type === "output_text") {
          parts.push({ type: "text", text: p.text ?? "" });
        } else {
          note(
            "field_dropped",
            `output[${i}].content[${j}]`,
            `Dropping output content part of type "${p.type ?? "unknown"}"`,
          );
        }
      }
      continue;
    }
    if (typed.type === "function_call") {
      const call = item as {
        call_id?: string;
        id?: string;
        name?: string;
        arguments?: string;
      };
      (toolCalls as NonNullable<typeof toolCalls>).push({
        id: call.call_id ?? call.id ?? "",
        type: "function",
        function: { name: call.name ?? "", arguments: call.arguments ?? "" },
      });
      continue;
    }
    // reasoning (Task 8), custom_tool_call (Task 5), server-side calls.
    note(
      "field_dropped",
      `output[${i}]`,
      `Dropping output item of type "${typed.type ?? "unknown"}"`,
    );
  }

  return {
    id: response.id ?? `resp_${randomUUID()}`,
    model: response.model ?? model,
    message: {
      role: "assistant",
      content: parts,
      ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
    },
    finishReason: toCanonicalFinish(response),
    ...(response.usage && { usage: toCanonicalUsage(response.usage) }),
    ...(typeof response.created_at === "number" && {
      created: response.created_at,
    }),
  };
}

function toCanonicalFinish(
  response: ResponsesResponse,
): CanonicalResponse["finishReason"] {
  const hasToolCalls = (response.output ?? []).some(
    (item) => (item as { type?: string }).type === "function_call",
  );
  switch (response.status) {
    case "completed":
    case undefined:
      return hasToolCalls ? "tool_call" : "stop";
    case "incomplete": {
      const reason = response.incomplete_details?.reason;
      if (reason === "content_filter") return "content_filter";
      // max_output_tokens, max_messages, steered — all truncated output.
      return reason === undefined || reason === "steered"
        ? "stop"
        : "length";
    }
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "unknown";
  }
}

function toCanonicalUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
}): CanonicalUsage {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
    ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
    ...(reasoning > 0 && { reasoningTokens: reasoning }),
  };
}


// ============ RESPONSE: Canonical → Responses ============

/**
 * The one Response object field set shared by the unary body and
 * every stream frame's `response` — the `response.created` /
 * `in_progress` skeleton carries it with `output: []` and
 * `usage: null`; the terminal `response.completed`/`incomplete`/
 * `failed` object carries the same keys (the stream encoder in
 * responses.stream.encode.ts builds both through this helper — no
 * duplicated literal). `usage` is always present: the usage object
 * when one arrived, `null` otherwise — the field is nullable per the
 * object reference and per Codex's `Response` (`usage: Option<…>` in
 * `codex-rs/codex-api/src/sse/responses.rs` at Codex 0.169.0).
 * Field sources: https://platform.openai.com/docs/api-reference/responses/object
 * and `openai` npm 7.30.1 `resources/responses/responses.d.ts`.
 */
export function toResponsesResponseObject(fields: {
  id: string;
  createdAt: number;
  status: NonNullable<ResponsesResponse["status"]>;
  model: string;
  output: Array<Record<string, unknown>>;
  outputText: string;
  error: { code: string; message: string } | null;
  incompleteDetails: { reason: string } | null;
  usage: ResponsesUsage | null;
}): ResponsesResponse {
  return {
    id: fields.id,
    object: "response",
    created_at: fields.createdAt,
    status: fields.status,
    incomplete_details: fields.incompleteDetails,
    model: fields.model,
    output: fields.output,
    output_text: fields.outputText,
    error: fields.error,
    instructions: null,
    metadata: null,
    access_programs: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    store: false,
    usage: fields.usage,
  } as unknown as ResponsesResponse;
}

export function fromCanonicalResponse(
  response: CanonicalResponse,
): ResponsesResponse {
  const status = toResponsesStatus(response.finishReason);
  const output: Array<Record<string, unknown>> = [];
  let itemSeq = 0;

  const content = toOutputContent(response.message.content);
  if (content.length > 0) {
    output.push({
      type: "message",
      id: `msg_${itemSeq++}`,
      status: status === "incomplete" ? "incomplete" : "completed",
      role: "assistant",
      content,
    });
  }
  for (const call of response.message.toolCalls ?? []) {
    output.push({
      type: "function_call",
      id: `fc_${itemSeq++}`,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
    });
  }
  if (output.length === 0) {
    output.push({
      type: "message",
      id: "msg_0",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

  return toResponsesResponseObject({
    id: response.id.startsWith("resp_")
      ? response.id
      : `resp_${response.id}`,
    createdAt: response.created ?? Math.floor(Date.now() / 1000),
    status,
    incompleteDetails: toIncompleteDetails(response.finishReason),
    model: response.model,
    output,
    outputText: content
      .filter((p) => p.type === "output_text")
      .map((p) => p.text)
      .join(""),
    error: null,
    usage: response.usage ? toResponsesUsage(response.usage) : null,
  });
}

function toResponsesStatus(
  finish: CanonicalResponse["finishReason"],
): "completed" | "incomplete" | "failed" {
  switch (finish) {
    case "length":
    case "content_filter":
      return "incomplete";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

function toIncompleteDetails(
  finish: CanonicalResponse["finishReason"],
): { reason: string } | null {
  switch (finish) {
    case "length":
      return { reason: "max_output_tokens" };
    case "content_filter":
      return { reason: "content_filter" };
    default:
      return null;
  }
}

export function toResponsesUsage(usage: CanonicalUsage): ResponsesUsage {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: {
      cached_tokens: usage.cacheReadTokens ?? 0,
      cache_write_tokens: usage.cacheWriteTokens ?? 0,
    },
    output_tokens: usage.outputTokens,
    output_tokens_details: {
      reasoning_tokens: usage.reasoningTokens ?? 0,
    },
    total_tokens: usage.totalTokens,
  };
}

