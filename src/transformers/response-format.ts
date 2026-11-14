import { recordNote } from "../observe/context";
import type { Provider } from "./adapters";
import type { CanonicalResponseFormat } from "../types/canonical.types";

/**
 * Shared helpers for the structured-output codecs (v1.4 spec §3.5,
 * Task 9) — like system-text.ts and reasoning-effort.ts, this file
 * carries no provider knowledge; every function takes the adapter
 * name so the note lands on the right dialect.
 */

/**
 * The name supplied on decode for dialects whose wire format carries
 * none — canonical requires `name` on `json_schema` while Anthropic
 * `output_config.format`, Gemini `responseJsonSchema`/`responseSchema`
 * and Ollama `format` carry only the schema. A fixed placeholder:
 * never derived from the schema, the request or the model (it would
 * leak content). Those dialects' encoders never send it.
 */
export const DEFAULT_RESPONSE_FORMAT_NAME = "response";

/** Narrow an unknown wire value to a plain (non-array) object. */
export function isSchemaObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * `strict`/`description` are set on canonical `json_schema` but have
 * no slot on Anthropic, Gemini or Ollama — dropped visibly at encode
 * time (`name` has no slot either, but it is adapter-internal, so no
 * note). Only the dialects that can't express them call this.
 */
export function noteDroppedFormatExtras(
  adapter: Provider,
  format: CanonicalResponseFormat,
): void {
  if (format.type !== "json_schema") return;
  if (format.strict !== undefined) {
    recordNote(
      {
        stage: "encode",
        adapter,
        code: "field_dropped",
        path: "response_format.strict",
      },
      'Dropping response format field "strict" (no wire equivalent)',
    );
  }
  if (format.description !== undefined) {
    recordNote(
      {
        stage: "encode",
        adapter,
        code: "field_dropped",
        path: "response_format.description",
      },
      'Dropping response format field "description" (no wire equivalent)',
    );
  }
}
