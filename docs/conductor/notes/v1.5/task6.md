# v1.5 Task 6 — owner decisions carried from Task 2

**Accepted by the owner on 2026-11-17 (PR #116, Task 2 OWNER REVIEW).** Task 2 changed the canonical
interface as follows; build on it and don't STOP on these points:

1. `CanonicalImage` is the union `{data, mimeType, url?: never} | {url, mimeType?, data?: never}`, and
   `CanonicalImageMimeType` is the exported mime-type alias. Use the alias; don't redefine the union.
2. `document` parts are valid on `role: "user"` messages only (not assistant, system or tool). Tool
   messages carry `text` and `image` parts only.
3. `imageSchema` is strict: an image object with any key besides `data`/`url`/`mimeType` fails validation.
   Decoders must build image objects with exactly those keys.
4. The five encoders (`src/transformers/adapters/anthropic.messages.ts`, `openai.adapter.ts`,
   `gemini.adapter.ts`, `ollama.adapter.ts`, `responses.items.ts`) throw `ValidationError` on a url-only
   image. Task 6 replaces these guards with the real behaviour (fetch/inline before encode, or URL
   pass-through where the target accepts URLs, or a 400 refusal per `MEDIA_SUPPORT`).

**Must be closed in Task 6 (left open by Task 2):**
- `src/transformers/adapters/responses.items.ts` `toInputContent` maps unknown parts to an empty
  `input_text`, so a `document` part would be dropped silently. Encode it (Responses `input_file`) or
  refuse it with a 400; a named test pins whichever applies.
- The OpenAI decoder's `[Image: <url>]` text placeholder (D5 pre-approved change): replace it with a
  canonical url image.
