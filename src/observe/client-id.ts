import type { IncomingHttpHeaders } from "node:http";
import type { ClientId } from "./trace";

/**
 * §3.4 client identity, first match wins:
 *  1. `x-babelgate-client` header, if it matches the id shape — this is
 *     also how the playground labels itself ("playground").
 *  2. User-Agent patterns, in order. The Gemini CLI pattern is the one
 *     Task 1 recorded: `GeminiCLI-tui/<v>/<model> (<os>; <arch>;
 *     terminal)`.
 *  3. Otherwise "other".
 * The UA is returned truncated to 200 chars for the trace.
 */

const HEADER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const USER_AGENT_MAX = 200;

const UA_CLIENTS: [pattern: string, client: ClientId][] = [
  ["claude-cli/", "claude-code"],
  ["codex", "codex"],
  ["GeminiCLI", "gemini-cli"],
  ["OpenAI/JS", "openai-sdk"],
  ["OpenAI/Python", "openai-sdk"],
  ["Anthropic/", "anthropic-sdk"],
  ["google-genai", "google-genai"],
  ["ollama-js", "ollama-sdk"],
  ["ollama-python", "ollama-sdk"],
];

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function clientId(headers: IncomingHttpHeaders): {
  client: ClientId;
  userAgent?: string;
} {
  const override = firstHeader(headers["x-babelgate-client"]);
  const userAgent = firstHeader(headers["user-agent"])?.slice(
    0,
    USER_AGENT_MAX,
  );

  let client: ClientId | undefined;
  if (override !== undefined && HEADER_ID.test(override)) {
    client = override;
  } else if (userAgent !== undefined) {
    for (const [pattern, id] of UA_CLIENTS) {
      if (userAgent.includes(pattern)) {
        client = id;
        break;
      }
    }
  }
  return {
    client: client ?? "other",
    ...(userAgent !== undefined && { userAgent }),
  };
}
