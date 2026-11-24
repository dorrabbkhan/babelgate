/**
 * Turn execution + client-stream reassembly for conformance
 * scenarios. Reassembling assistant content from a streamed reply is
 * what a real client (Claude Code, Codex) does before sending the
 * next turn — thinking blocks and tool calls must be echoed
 * faithfully or the test asserts on the wrong thing.
 */
import type { RunningGateway } from "../harness";
import type {
  ClientDialect,
  Scenario,
  TurnResult,
  UpstreamRequest,
} from "./types";
import { parseSse, sseJson } from "./types";

const MODEL_PLACEHOLDER = "$MODEL";

function substituteModel(value: unknown, model: string): unknown {
  if (typeof value === "string") {
    return value === MODEL_PLACEHOLDER ? model : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteModel(v, model));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteModel(v, model);
    }
    return out;
  }
  return value;
}

/**
 * Extra headers a gateway needs on the client path (CCR's static API
 * key). Anthropic-version is always set on the anthropic dialect.
 */
function clientHeaders(
  extra: Record<string, string> | undefined,
  client: ClientDialect,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(extra ?? {}),
  };
  if (client === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function clientUrl(gw: RunningGateway, client: ClientDialect): string {
  return client === "anthropic"
    ? `${gw.anthropicBase}/v1/messages`
    : `${gw.responsesBase}/responses`;
}

/**
 * Send one turn through the gateway and capture the client response.
 * `upstreamBefore` is the count of recorded upstream requests before
 * this turn, so the slice is per-turn.
 */
export async function sendTurn(
  gw: RunningGateway,
  model: string,
  extraHeaders: Record<string, string> | undefined,
  scenario: Scenario,
  turnIndex: number,
  prev: TurnResult[],
  upstreamRequests: { url: string; body: string }[],
): Promise<TurnResult> {
  const spec = scenario.turns[turnIndex];
  const raw =
    typeof spec.request === "function" ? spec.request(prev) : spec.request;
  const body = substituteModel(raw, model);
  const upstreamBefore = upstreamRequests.length;
  const res = await fetch(clientUrl(gw, scenario.client), {
    method: "POST",
    headers: clientHeaders(extraHeaders, scenario.client),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = parseSse(text).map((e) => e.event || "message");
  const upstream: UpstreamRequest[] = upstreamRequests
    .slice(upstreamBefore)
    .map((r) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        parsed = undefined;
      }
      return { url: r.url, body: parsed, rawBody: r.body };
    });
  return { turn: turnIndex + 1, status: res.status, body: text, sseEvents: events, upstream };
}

/* ---- stream reassembly helpers (what a real client rebuilds) ---- */

export interface AnthropicBlock {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  input?: unknown;
}

/**
 * Reassemble the assistant `content` array of an Anthropic streamed
 * reply: thinking (with signature), redacted_thinking, text and
 * tool_use blocks in index order. This is what turn 2 echoes back.
 */
export function anthropicAssistantContent(body: string): AnthropicBlock[] {
  const blocks = new Map<number, AnthropicBlock>();
  for (const { json } of sseJson(body)) {
    const type = json?.type as string | undefined;
    if (type === "content_block_start") {
      const index = json.index as number;
      const block = json.content_block as AnthropicBlock;
      blocks.set(index, {
        type: block.type,
        id: block.id,
        name: block.name,
        text: block.type === "text" ? (block.text ?? "") : undefined,
        thinking: block.type === "thinking" ? (block.thinking ?? "") : undefined,
        data: block.type === "redacted_thinking" ? block.data : undefined,
        input: block.type === "tool_use" ? "" : undefined,
      });
    } else if (type === "content_block_delta") {
      const block = blocks.get(json.index as number);
      const delta = json.delta ?? {};
      if (!block) continue;
      if (delta.type === "text_delta") {
        block.text = (block.text ?? "") + (delta.text ?? "");
      } else if (delta.type === "thinking_delta") {
        block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
      } else if (delta.type === "signature_delta") {
        block.signature = (block.signature ?? "") + (delta.signature ?? "");
      } else if (delta.type === "input_json_delta") {
        block.input = String(block.input ?? "") + (delta.partial_json ?? "");
      }
    }
  }
  const out: AnthropicBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index)!;
    if (block.type === "tool_use") {
      try {
        block.input = JSON.parse(String(block.input ?? ""));
      } catch {
        // leave the raw string — the verdict records the shape either way
      }
    }
    for (const key of ["text", "thinking", "data"] as const) {
      if (block[key] === undefined) delete block[key];
    }
    if (block.input === undefined) delete block.input;
    out.push(block);
  }
  return out;
}

/**
 * Reassemble `output` items of a Responses streamed reply (the
 * response.completed event's output array, falling back to
 * output_item.done items). Reasoning items keep `encrypted_content`
 * verbatim — that is what a Codex client echoes on the next turn.
 */
export function responsesOutputItems(body: string): any[] {
  let completed: any[] | undefined;
  const items: any[] = [];
  for (const { json } of sseJson(body)) {
    const type = json?.type as string | undefined;
    if (type === "response.completed" && Array.isArray(json.response?.output)) {
      completed = json.response.output;
    } else if (type === "response.output_item.done" && json.item) {
      items.push(json.item);
    }
  }
  return completed ?? items;
}

/** JSON body of a non-streamed client response, or undefined. */
export function jsonBody(result: TurnResult): unknown {
  try {
    return JSON.parse(result.body);
  } catch {
    return undefined;
  }
}

/* ---- pass-rule helpers used by the reasoning scenarios ----
 * The request field that carries reasoning back to the upstream, per
 * provider docs:
 * - OpenRouter Chat: `reasoning` / `reasoning_details` on a message
 *   (https://openrouter.ai/docs/use-cases/reasoning-tokens)
 * - DeepSeek Chat: `reasoning_content` on the assistant message
 *   (https://api-docs.deepseek.com/guides/reasoning_model)
 * - Gemini: `thought: true` / `thoughtSignature` on a model part
 *   (https://ai.google.dev/gemini-api/docs/thinking)
 */

/* Doc URLs the pass rules cite — one constant per rule so the
 * scenario modules and the report's Rules section cannot drift. */
export const DOC = {
  /** Anthropic streamed Messages contract (event sequence, 2xx). */
  anthropicStream: "https://docs.anthropic.com/en/api/messages-streaming",
  /** Anthropic extended thinking: signed thinking blocks, echo-back. */
  anthropicThinking:
    "https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
  /** Responses streaming contract. */
  responsesStream:
    "https://platform.openai.com/docs/api-reference/responses-streaming",
  /** OpenAI reasoning guide: `reasoning` request param; reasoning
   * items are part of a Responses `output`. */
  openaiReasoning: "https://platform.openai.com/docs/guides/reasoning",
  /** OpenRouter: preserve reasoning_details/reasoning across tool use;
   * "the Responses API ... always returns `reasoning` items in `output`". */
  openrouterReasoning: "https://openrouter.ai/docs/use-cases/reasoning-tokens",
  /** DeepSeek reasoning guide: earlier reasoning_content is NOT part
   * of the next turn's context (cited as counter-evidence only). */
  deepseekReasoning: "https://api-docs.deepseek.com/guides/reasoning_model",
  /** Gemini thought signatures on functionCall parts. */
  geminiThoughtSignatures:
    "https://ai.google.dev/gemini-api/docs/thought-signatures",
} as const;

const REASONING_MESSAGE_FIELDS = [
  "reasoning_content",
  "reasoning_details",
  "reasoning",
];

function nonEmpty(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null;
}

/** Does the recorded upstream request carry reasoning per the
 * target's wire rules? `dialect` picks the field set. */
export function upstreamCarriesReasoning(
  req: { body: unknown },
  dialect: "openai" | "gemini",
): boolean {
  if (req.body === null || typeof req.body !== "object") return false;
  const body = req.body as Record<string, unknown>;
  if (dialect === "openai") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        REASONING_MESSAGE_FIELDS.some((f) => nonEmpty(m[f])),
    );
  }
  // gemini: model-role contents keep the thought part + signature
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return contents.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const parts = Array.isArray((c as { parts?: unknown[] }).parts)
      ? (c as { parts: unknown[] }).parts
      : [];
    return parts.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as Record<string, unknown>).thought === true ||
          nonEmpty((p as Record<string, unknown>).thoughtSignature)),
    );
  });
}

/**
 * Does the client stream hold a valid reasoning block before any
 * text? Anthropic: a `thinking`/`redacted_thinking` content block
 * opens before the first `text` block, and a `signature_delta`
 * accompanies it (Anthropic requires the signature to echo thinking
 * back — https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
 * Responses: a `reasoning` output item completes before any `message`
 * item and carries `encrypted_content` or summary content.
 */
export function clientStreamHasReasoningBeforeText(
  result: TurnResult,
  client: "anthropic" | "responses",
): boolean {
  const frames = sseJson(result.body);
  if (client === "anthropic") {
    let firstTextIndex = Number.POSITIVE_INFINITY;
    let thinkingIndex = Number.POSITIVE_INFINITY;
    let signed = false;
    for (const { json } of frames) {
      const type = json?.type as string | undefined;
      const index = typeof json?.index === "number" ? json.index : -1;
      if (type === "content_block_start") {
        const bt = json.content_block?.type;
        if (bt === "text" && index < firstTextIndex) {
          firstTextIndex = index;
        }
        if (
          (bt === "thinking" || bt === "redacted_thinking") &&
          index < thinkingIndex
        ) {
          thinkingIndex = index;
          if (bt === "redacted_thinking") signed = true;
        }
      } else if (
        type === "content_block_delta" &&
        index === thinkingIndex &&
        json.delta?.type === "signature_delta" &&
        nonEmpty(json.delta?.signature)
      ) {
        signed = true;
      }
    }
    return thinkingIndex < firstTextIndex && signed;
  }
  // responses: a completed reasoning item before any message item
  for (const { json } of frames) {
    const type = json?.type as string | undefined;
    const item = json?.item ?? json?.part ?? json;
    if (
      (type === "response.output_item.done" || type === "response.output_item.added") &&
      item?.type === "reasoning" &&
      (nonEmpty(item.encrypted_content) ||
        (Array.isArray(item.summary) && item.summary.length > 0) ||
        (Array.isArray(item.content) && item.content.length > 0))
    ) {
      return true;
    }
    if (
      (type === "response.output_item.done" && item?.type === "message") ||
      type === "response.output_text.delta"
    ) {
      return false;
    }
  }
  return false;
}

/**
 * The exact field path where a recorded upstream request should have
 * carried reasoning — for the report's one-line failing cell. Mirrors
 * `upstreamCarriesReasoning`'s expectations.
 */
export function reasoningMissDetail(
  req: { body: unknown } | undefined,
  dialect: "openai" | "gemini",
): string {
  const body =
    req !== undefined && typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : undefined;
  if (body === undefined) {
    return "upstream turn produced no JSON request body to inspect";
  }
  if (dialect === "openai") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (
        typeof m === "object" &&
        m !== null &&
        (m as { role?: unknown }).role === "assistant"
      ) {
        return (
          `messages[${i}] (assistant) carries no ` +
          `reasoning/reasoning_content/reasoning_details field`
        );
      }
    }
    return "messages[] has no assistant turn to carry reasoning fields";
  }
  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const c = contents[i];
    if (typeof c !== "object" || c === null) continue;
    const parts = Array.isArray((c as { parts?: unknown[] }).parts)
      ? (c as { parts: unknown[] }).parts
      : [];
    const fc = parts.findIndex(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as Record<string, unknown>).functionCall !== undefined ||
          (p as Record<string, unknown>).function_call !== undefined),
    );
    if (fc >= 0) {
      return (
        `contents[${i}].parts[${fc}] functionCall has no ` +
        `thoughtSignature`
      );
    }
    if ((c as { role?: unknown }).role === "model") {
      return (
        `contents[${i}] (model turn) has no part with thought:true ` +
        `or thoughtSignature`
      );
    }
  }
  return "contents[] has no model turn at all";
}

/** The field path a client stream's reasoning block should occupy —
 * per dialect, for the report's one-line failing cell. */
export function clientReasoningMissDetail(
  client: "anthropic" | "responses",
): string {
  return client === "anthropic"
    ? "client SSE: no content_block_start{thinking|redacted_thinking} + signature_delta before the first text block"
    : "client SSE: no output_item.done{type:reasoning, encrypted_content|summary|content} before the first message item";
}
