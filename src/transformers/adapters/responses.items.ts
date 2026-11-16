/**
 * Responses input/output item codec (v1.4 spec §3.1): message,
 * function_call and function_call_output items to and from canonical
 * messages. Extracted from responses.adapter.ts (rule 7: ~400-line
 * files); the public request/response entry points live there.
 *
 * Wire-format sources:
 *  - Input item shapes (`message`, `function_call`,
 *    `function_call_output`; content parts `input_text`/`output_text`/
 *    `input_image`): https://platform.openai.com/docs/api-reference/responses/create
 *    and `openai` npm 7.30.1 `resources/responses/responses.d.ts`
 *    (`ResponseInputItem`, `EasyInputMessage`). Output content parts:
 *    `ResponseOutputItem` / `ResponseOutputMessage` in the same SDK
 *    typings + https://platform.openai.com/docs/api-reference/responses/object.
 *  - Codex's real item usage (roles, `call_id` round-trips): recorded
 *    in `tests/fixtures/codex/recording.jsonl` and `turns.json`
 *    (Codex 0.169.0, `codex-rs/core/src/client.rs`).
 *  - `phase` on message items is a responses-lite marker — pass-through
 *    only in v1.4 (owner decision, docs/conductor/notes/v1.4/task3.md).
 */
import type {
  CanonicalContentPart,
  CanonicalImage,
  CanonicalImageMimeType,
  CanonicalMessage,
} from "../../types/canonical.types";
import { ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import { systemText } from "../system-text";
import { originMatchesCurrent, signatureMatchesCurrent } from "../reasoning-origin";
import { packEnvelope, unpackEnvelope, type EnvelopePayload } from "./responses.envelope";
import type { ResponsesInputItem } from "../../types/responses.types";

function note(code: string, path: string, message: string): void {
  recordNote({ stage: "decode", adapter: "responses", code, path }, message);
}

function noteEncode(code: string, path: string, message: string): void {
  recordNote({ stage: "encode", adapter: "responses", code, path }, message);
}

// ============ Items: Responses → Canonical ============

/**
 * Reasoning-envelope decode state (v1.4 spec §3.3, Task 8). A
 * `reasoning` input item's `bg1.` payload re-attaches to the
 * assistant turn it introduces: reasoning parts prepend to that
 * turn's first assistant message; signatures resolve by
 * `toolCallId`/`textIndex` across that run. When a reasoning item
 * directly follows an assistant turn instead (a trailing
 * signature-only envelope), its signatures resolve against that
 * preceding run — positions emitted by the stream encoder.
 */
export interface InputDecodeState {
  /** Envelope payload awaiting the assistant turn it precedes. */
  pending?: {
    parts: CanonicalContentPart[];
    signatures: EnvelopePayload["signatures"];
  };
  /** `messages` index where the run pending attaches to starts. */
  attachIndex?: number;
}

export function createInputDecodeState(): InputDecodeState {
  return {};
}

/** The trailing run of assistant-role messages in `messages`. */
function lastAssistantRun(messages: CanonicalMessage[]): CanonicalMessage[] {
  const run: CanonicalMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") break;
    run.unshift(messages[i]);
  }
  return run;
}

/** Attach pending reasoning parts to `message` (prepended). */
function attachParts(
  message: CanonicalMessage,
  parts: CanonicalContentPart[],
): void {
  const content =
    typeof message.content === "string"
      ? message.content === ""
        ? []
        : [{ type: "text" as const, text: message.content }]
      : message.content;
  message.content = [...parts, ...content];
}

function resolveSignatures(
  run: CanonicalMessage[],
  signatures: EnvelopePayload["signatures"],
): EnvelopePayload["signatures"] {
  return signatures.filter((entry) => {
    if (entry.toolCallId !== undefined) {
      for (const m of run) {
        for (const call of m.toolCalls ?? []) {
          if (call.id === entry.toolCallId) {
            call.signature = entry.signature;
            return false;
          }
        }
      }
      return true;
    }
    if (entry.textIndex !== undefined) {
      for (const m of run) {
        if (!Array.isArray(m.content)) continue;
        const textParts = m.content.filter((p) => p.type === "text");
        const target = textParts[entry.textIndex];
        if (target !== undefined) {
          target.signature = entry.signature;
          return false;
        }
      }
      return true;
    }
    return true;
  });
}

/**
 * Apply any envelope payload buffered ahead of the assistant run
 * that `messages[attachIndex]` opens; call after each assistant item
 * is pushed so signatures resolve across the whole run.
 */
function settlePending(
  state: InputDecodeState,
  messages: CanonicalMessage[],
): void {
  const pending = state.pending;
  if (pending === undefined || state.attachIndex === undefined) return;
  if (pending.parts.length > 0) {
    attachParts(messages[state.attachIndex], pending.parts);
    pending.parts = [];
  }
  pending.signatures = resolveSignatures(
    messages.slice(state.attachIndex),
    pending.signatures,
  );
  if (pending.signatures.length === 0) {
    state.pending = undefined;
    state.attachIndex = undefined;
  }
}

/**
 * Flush pending payload at a non-assistant item or input end: a
 * reasoning item that directly followed an assistant turn resolves
 * its signatures — and any parts — against that run; anything else
 * is dropped with a `reasoning_dropped` note.
 */
export function flushPendingReasoning(
  state: InputDecodeState,
  messages: CanonicalMessage[],
): void {
  const pending = state.pending;
  if (pending === undefined) return;
  state.pending = undefined;
  state.attachIndex = undefined;
  const run = lastAssistantRun(messages);
  if (pending.parts.length > 0 && run.length > 0) {
    attachParts(run[0], pending.parts);
    pending.parts = [];
  }
  if (run.length > 0) {
    pending.signatures = resolveSignatures(run, pending.signatures);
  }
  if (pending.parts.length > 0 || pending.signatures.length > 0) {
    note(
      "reasoning_dropped",
      "input",
      "Dropping a reasoning envelope with no assistant turn to attach to",
    );
  }
}

export function decodeInputItem(
  item: ResponsesInputItem,
  index: number,
  messages: CanonicalMessage[],
  systemTexts: string[],
  state?: InputDecodeState,
): void {
  if (item === null || typeof item !== "object") {
    note("field_dropped", `input[${index}]`, "Dropping non-object input item");
    return;
  }
  const typed = item as { type?: string; role?: string };
  // Items may omit `type` when `role` is present (EasyInputMessage).
  const type = typed.type ?? (typed.role !== undefined ? "message" : undefined);
  const path = `input[${index}]`;

  if (type === "reasoning") {
    // Task 8 (spec §3.3): `bg1.` envelopes unpack to reasoning
    // parts/signatures for the turn they precede (or, directly after
    // an assistant turn, the run just decoded); any other
    // `encrypted_content` — a real upstream's opaque blob included —
    // is a `reasoning_dropped` note on the bridge.
    const enc = (item as { encrypted_content?: unknown }).encrypted_content;
    const payload =
      typeof enc === "string" ? unpackEnvelope(enc) : undefined;
    if (payload === undefined) {
      note(
        "reasoning_dropped",
        path,
        "Dropping a reasoning item (encrypted_content is not a bg1. envelope)",
      );
      return;
    }
    const pending = (state ??= {}).pending ??= {
      parts: [],
      signatures: [],
    };
    pending.parts.push(...payload.reasoning);
    pending.signatures.push(...payload.signatures);
    return;
  }

  if (type === "message") {
    decodeMessageItem(item, path, messages, systemTexts, state);
    return;
  }
  if (type === "function_call") {
    const call = item as {
      call_id?: string | null;
      id?: string;
      name?: string;
      namespace?: string;
      arguments?: string;
    };
    // `namespace` is Codex's explicit field on the call — its router
    // reads it at 0.169.0 (codex-rs/core/src/tools/router.rs); a flat
    // name never matches. Canonical keeps it verbatim on
    // `function.namespace` (the leaf stays in `name`).
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call.call_id ?? call.id ?? "",
          type: "function",
          function: {
            name: call.name ?? "",
            arguments: call.arguments ?? "",
            ...(typeof call.namespace === "string" && {
              namespace: call.namespace,
            }),
          },
        },
      ],
    });
    afterAssistantItem(state, messages);
    return;
  }
  if (type === "custom_tool_call") {
    // `custom_tool_call` {call_id, name, input} — the Responses object
    // reference and the SDK's ResponseCustomToolCall; raw `input`
    // stays the call's arguments verbatim, marked `custom` so
    // diagnostics and repair never parse it (v1.4 spec §3.6).
    // `namespace` rides it the same way it rides function_call —
    // custom_tool_call{namespace} is real Codex traffic
    // (recording-responses-lite.jsonl).
    const call = item as {
      call_id?: string | null;
      id?: string;
      name?: string;
      namespace?: string;
      input?: string;
    };
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call.call_id ?? call.id ?? "",
          type: "function",
          custom: true,
          function: {
            name: call.name ?? "",
            arguments: typeof call.input === "string" ? call.input : "",
            ...(typeof call.namespace === "string" && {
              namespace: call.namespace,
            }),
          },
        },
      ],
    });
    afterAssistantItem(state, messages);
    return;
  }
  if (type === "custom_tool_call_output") {
    if (state !== undefined) flushPendingReasoning(state, messages);
    const output = item as { call_id?: string | null; output?: unknown };
    messages.push({
      role: "tool",
      toolCallId: output.call_id ?? "",
      content: toolOutputText(output.output, path),
    });
    return;
  }
  if (type === "function_call_output") {
    if (state !== undefined) flushPendingReasoning(state, messages);
    const output = item as { call_id?: string | null; output?: unknown };
    messages.push({
      role: "tool",
      toolCallId: output.call_id ?? "",
      content: toolOutputText(output.output, path),
    });
    return;
  }
  // Everything else — reasoning (Task 8), additional_tools,
  // server-side tool calls and item references — is parsed and
  // dropped, never a 400.
  note(
    "field_dropped",
    path,
    `Dropping input item of type "${type}" (no canonical equivalent yet)`,
  );
}

/**
 * After an assistant-typed item is pushed: a pending envelope binds
 * to this run (first assistant message takes the parts; signatures
 * resolve across the run as it grows).
 */
function afterAssistantItem(
  state: InputDecodeState | undefined,
  messages: CanonicalMessage[],
): void {
  if (state === undefined) return;
  if (state.pending !== undefined) {
    state.attachIndex ??= messages.length - 1;
    settlePending(state, messages);
  }
}

function decodeMessageItem(
  item: ResponsesInputItem,
  path: string,
  messages: CanonicalMessage[],
  systemTexts: string[],
  state?: InputDecodeState,
): void {
  const message = item as {
    role?: string;
    content?: unknown;
    phase?: unknown;
  };
  if (message.phase !== undefined) {
    // responses-lite marker — noted, tolerated (owner decision: the
    // lite shape is refused at the service boundary, not here).
    note("field_dropped", `${path}.phase`, 'Dropping message field "phase"');
  }

  const content = decodeMessageContent(message.content, path);
  switch (message.role) {
    case "system":
    case "developer": {
      if (state !== undefined) flushPendingReasoning(state, messages);
      const text =
        typeof content === "string" ? content : systemText(content) ?? "";
      messages.push({ role: "system", content });
      if (text !== "") systemTexts.push(text);
      return;
    }
    case "assistant":
      messages.push({ role: "assistant", content });
      afterAssistantItem(state, messages);
      return;
    case "user":
      if (state !== undefined) flushPendingReasoning(state, messages);
      messages.push({ role: "user", content });
      return;
    default:
      note(
        "field_dropped",
        path,
        `Dropping message item with unrecognised role`,
      );
  }
}

function decodeMessageContent(
  content: unknown,
  path: string,
): string | CanonicalContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: CanonicalContentPart[] = [];
  for (const [i, part] of content.entries()) {
    const p = part as { type?: string; text?: string; image_url?: string };
    if (p.type === "input_text" || p.type === "output_text") {
      parts.push({ type: "text", text: p.text ?? "" });
      continue;
    }
    if (p.type === "input_image") {
      parts.push({ type: "image", image: toCanonicalImage(p, path, i) });
      continue;
    }
    // refusal, input_file and any unknown part are noted drops.
    note(
      "field_dropped",
      `${path}.content[${i}]`,
      `Dropping content part of type "${p.type ?? "unknown"}"`,
    );
  }
  return parts;
}

function toCanonicalImage(
  part: { image_url?: string },
  path: string,
  index: number,
): CanonicalImage {
  const url = part.image_url ?? "";
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) {
    // The plan's Task 3 Interfaces block makes a remote URL a 400
    // (`unsupported_image_url`) naming the limitation — new behaviour
    // for this dialect (other adapters degrade remote URLs); never a
    // silent drop or fetch.
    throw new ValidationError(
      `unsupported_image_url at ${path}.content[${index}]: only data: image URLs are supported`,
    );
  }
  const mimeType = match[1] as CanonicalImageMimeType;
  return {
    data: match[2],
    mimeType: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ].includes(mimeType)
      ? mimeType
      : "image/png",
  };
}

function toolOutputText(output: unknown, path: string): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part, i) => {
      const p = part as { type?: string; text?: string };
      if (p.type === "output_text" || p.type === "input_text") {
        return p.text ?? "";
      }
      note(
        "field_dropped",
        `${path}.output[${i}]`,
        `Dropping tool output part of type "${p.type ?? "unknown"}"`,
      );
      return "";
    })
    .join("");
}


// ============ Items: Canonical → Responses ============

export function encodeMessage(
  message: CanonicalMessage,
  customCallIds?: Set<string>,
  itemId?: () => string,
): Array<Record<string, unknown>> {
  switch (message.role) {
    case "system":
      return [
        {
          type: "message",
          role: "developer",
          content: toInputContent(message.content),
        },
      ];
    case "assistant": {
      const items: Array<Record<string, unknown>> = [];
      const reasoningItem = toReasoningItem(message, itemId);
      if (reasoningItem !== undefined) items.push(reasoningItem);
      const content = toOutputContent(message.content);
      if (content.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content,
          status: "completed",
        });
      }
      for (const call of message.toolCalls ?? []) {
        if (call.custom === true) {
          // `custom_tool_call` {call_id, name, input} — raw input
          // verbatim (v1.4 spec §3.6); `namespace` rides it the same
          // way it rides function_call (recording-responses-lite.jsonl).
          customCallIds?.add(call.id);
          items.push({
            type: "custom_tool_call",
            call_id: call.id,
            name: call.function.name,
            ...(call.function.namespace !== undefined && {
              namespace: call.function.namespace,
            }),
            input: call.function.arguments,
            status: "completed",
          });
          continue;
        }
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          // Codex's explicit `namespace` field — its router reads it
          // at 0.169.0 (codex-rs/core/src/tools/router.rs).
          ...(call.function.namespace !== undefined && {
            namespace: call.function.namespace,
          }),
          arguments: call.function.arguments,
          status: "completed",
        });
      }
      return items;
    }
    case "tool":
      // A result for a custom call re-encodes as
      // `custom_tool_call_output` (SDK ResponseCustomToolCallOutput).
      return customCallIds?.has(message.toolCallId ?? "")
        ? [
            {
              type: "custom_tool_call_output",
              call_id: message.toolCallId ?? "",
              output: toToolOutputText(message.content),
            },
          ]
        : [
            {
              type: "function_call_output",
              call_id: message.toolCallId ?? "",
              output: toToolOutputText(message.content),
            },
          ];
    default:
      return [
        {
          type: "message",
          role: "user",
          content: toInputContent(message.content),
        },
      ];
  }
}

function toInputContent(
  content: string | CanonicalContentPart[],
): Array<Record<string, unknown>> {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  return parts.map((part) => {
    if (part.type === "image" && part.image) {
      if (part.image.data === undefined) {
        // URL images resolve to bytes in the services (v1.5 Task 6).
        throw new ValidationError(
          'Unsupported "image" content: "url" without "data"',
        );
      }
      return {
        type: "input_image",
        image_url: `data:${part.image.mimeType};base64,${part.image.data}`,
        detail: "auto",
      };
    }
    return { type: "input_text", text: part.text ?? "" };
  });
}

export function toOutputContent(
  content: string | CanonicalContentPart[],
): Array<Record<string, unknown>> {
  if (content === "") return [];
  const parts =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;
  const out: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: "output_text", text: part.text ?? "", annotations: [] });
    } else if (part.type === "reasoning") {
      // Reasoning parts ride the turn's `reasoning` item instead —
      // toReasoningItem owns them (Task 8, spec §3.3).
      continue;
    } else {
      recordNote(
        {
          stage: "encode",
          adapter: "responses",
          code: "field_dropped",
        },
        `Dropping content part of type "${part.type}" on encode`,
      );
    }
  }
  return out;
}

/**
 * An assistant turn's reasoning item (Task 8, spec §3.3):
 * `{type:"reasoning", id, summary, encrypted_content}` emitted
 * before the message/function_call items it explains. The
 * `bg1.` envelope packs the turn's reasoning parts and
 * tool-call/text signatures verbatim — matching-origin only on the
 * upstream-bound encode (reasoning never crosses origin, spec
 * §3.2); a foreign part or signature is dropped with a
 * `reasoning_dropped` note. Over the 1 MiB cap the item emits
 * without `encrypted_content` plus an `envelope_too_large` note.
 */
export function toReasoningItem(
  message: CanonicalMessage,
  itemId?: () => string,
  clientFacing?: boolean,
): Record<string, unknown> | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const kept: CanonicalContentPart[] = [];
  const signatures: EnvelopePayload["signatures"] = [];
  for (const part of message.content) {
    if (part.type === "reasoning" && part.reasoning) {
      if (
        clientFacing === true ||
        (originMatchesCurrent(part.reasoning.origin) &&
          (part.signature === undefined ||
            signatureMatchesCurrent(part.signature)))
      ) {
        kept.push(part);
      } else {
        dropNote("reasoning");
      }
      continue;
    }
    if (part.signature !== undefined) {
      if (clientFacing === true || signatureMatchesCurrent(part.signature)) {
        const textIndex = message.content
          .filter((p) => p.type === "text")
          .indexOf(part);
        signatures.push({ textIndex, signature: part.signature });
      } else {
        dropNote("signature");
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    if (call.signature === undefined) continue;
    if (clientFacing === true || signatureMatchesCurrent(call.signature)) {
      signatures.push({ toolCallId: call.id, signature: call.signature });
    } else {
      dropNote("signature");
    }
  }
  if (kept.length === 0 && signatures.length === 0) return undefined;

  const summary = kept
    .filter((p) => p.reasoning?.text !== undefined && p.reasoning.text !== "")
    .map((p) => ({ type: "summary_text", text: p.reasoning!.text! }));
  const packed = packEnvelope({ v: 1, reasoning: kept, signatures });
  if (packed === undefined) {
    recordNote(
      {
        stage: "encode",
        adapter: "responses",
        code: "reasoning_dropped",
        path: "envelope_too_large",
      },
      "Dropping reasoning envelope over the 1 MiB cap",
    );
  }
  return {
    type: "reasoning",
    id: itemId?.() ?? "rs_0",
    summary,
    ...(packed !== undefined && { encrypted_content: packed }),
  };
}

function dropNote(path: string): void {
  noteEncode(
    "reasoning_dropped",
    path,
    `Dropping ${path} (origin does not match the current attempt)`,
  );
}

function toToolOutputText(content: string | CanonicalContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => p.text ?? "").join("");
}

