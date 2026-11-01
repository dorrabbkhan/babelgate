import { z } from "zod";
import type { Provider } from "../transformers";

/**
 * One entry in a babelgate.yaml `providers` map (spec §3.5).
 * `api_key_env` holds an environment variable name — never a key.
 */
export interface GatewayFileProvider {
  type: Provider;
  base_url: string;
  api_key_env?: string;
  context_window?: number;
  timeout_ms?: number;
  stream_idle_ms?: number;
}

/** One entry in a babelgate.yaml `routes` list (spec §3.5). */
export interface GatewayFileRoute {
  match: string;
  when?: { min_input_tokens?: number };
  to: string;
  fallback?: string[];
}

/** A parsed babelgate.yaml file, before targets are resolved (spec §3.5). */
export interface GatewayFile {
  default: string;
  providers: Record<string, GatewayFileProvider>;
  aliases?: Record<string, string>;
  routes?: GatewayFileRoute[];
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

const providerEntrySchema = z
  .strictObject({
    type: z.enum(["openai", "anthropic", "gemini", "ollama"]),
    base_url: z.string().min(1),
    api_key_env: z.string().optional(),
    context_window: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    stream_idle_ms: z.number().int().positive().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.type !== "ollama" && entry.api_key_env === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["api_key_env"],
        message: 'required unless type is "ollama"',
      });
    }
  });

/**
 * babelgate.yaml schema (spec §3.5): strict objects at every level, so
 * unknown keys are startup errors. Semantic checks (default is a
 * provider, targets resolve, key env vars are set) happen in
 * loadYamlConfig — they need the registry and the environment.
 */
export const gatewayFileSchema: z.ZodType<GatewayFile> = z.strictObject({
  default: z.string(),
  providers: z
    .record(z.string().regex(PROVIDER_NAME), providerEntrySchema)
    .refine((map) => Object.keys(map).length >= 1, {
      message: "at least one provider is required",
    }),
  aliases: z.record(z.string(), z.string()).optional(),
  routes: z
    .array(
      z.strictObject({
        match: z.string().min(1),
        when: z
          .strictObject({
            min_input_tokens: z.number().int().positive().optional(),
          })
          .optional(),
        to: z.string(),
        fallback: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
