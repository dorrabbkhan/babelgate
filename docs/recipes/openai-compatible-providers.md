# Recipe: OpenAI-compatible providers as targets

Any backend that serves OpenAI's chat-completions shape works as a
`type: openai` provider in `babelgate.yaml` — no adapter work needed.
Two things to get right:

- **`base_url` stops before `/v1`.** babelgate appends
  `/v1/chat/completions` and `/v1/models` itself, so take the base URL
  the provider's docs give OpenAI SDKs and drop the trailing `/v1`.
- **`api_key_env` is required for `type: openai`** and names an
  environment variable — never holds a key. For keyless local servers
  (LM Studio, vLLM, llama.cpp in open mode), point it at any variable
  you set to a placeholder value; the server ignores the Bearer header.

## Provider table

| Provider   | `base_url`                        | `api_key_env`        | Evidence |
| ---------- | --------------------------------- | -------------------- | -------- |
| OpenRouter | `https://openrouter.ai/api`       | `OPENROUTER_API_KEY` | **live-tested** — the release gate runs `qwen/qwen3-coder` through it (`docs/decisions.md`, v1.1 Task 15) |
| Ollama     | `http://localhost:11434`          | — (`type: ollama`)   | **live-tested** — launch target, nightly live suite |
| Groq       | `https://api.groq.com/openai`     | `GROQ_API_KEY`       | **from provider docs** — <https://console.groq.com/docs/openai>, checked 2026-11-02 |
| DeepSeek   | `https://api.deepseek.com`        | `DEEPSEEK_API_KEY`   | **from provider docs** — <https://api-docs.deepseek.com/>, checked 2026-11-02 |
| Together   | `https://api.together.ai`         | `TOGETHER_API_KEY`   | **from provider docs** — <https://docs.together.ai/docs/inference/openai-compatibility>, checked 2026-11-02 |
| LM Studio  | `http://localhost:1234`           | any dummy env var    | **from provider docs** — <https://lmstudio.ai/docs/developer/openai-compat>, checked 2026-11-02 |
| vLLM       | `http://localhost:8000`           | any dummy env var    | **from provider docs** — <https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/>, checked 2026-11-02 |
| llama.cpp  | `http://localhost:8080`           | any dummy env var    | **from provider docs** — <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>, checked 2026-11-02 |

"Live-tested" means a request has actually gone through babelgate to
that backend; "from provider docs" means the base URL comes from the
linked documentation and the row hasn't been exercised end to end.

## Example

```yaml
default: groq
providers:
  groq:
    type: openai
    base_url: https://api.groq.com/openai
    api_key_env: GROQ_API_KEY
  deepseek:
    type: openai
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
  lmstudio:
    type: openai
    base_url: http://localhost:1234
    api_key_env: LMSTUDIO_API_KEY   # set LMSTUDIO_API_KEY=unused; LM Studio ignores it
routes:
  - match: deepseek-*
    to: deepseek/deepseek-flash
    fallback:
      - groq/openai/gpt-oss-120b
```

```bash
GROQ_API_KEY=<key> DEEPSEEK_API_KEY=<key> LMSTUDIO_API_KEY=unused \
  npx babelgate --config babelgate.yaml
```

## Notes

- **Model names are the provider's own.** A route's `to` and a request's
  explicit `<provider>/<model>` must use the id the backend knows
  (`qwen/qwen3-coder` on OpenRouter, `deepseek-flash` on DeepSeek, the
  identifier LM Studio shows). Copy slugs from the provider's model list
  rather than guessing — OpenRouter aliases like
  `anthropic/claude-sonnet-4.5` differ from the vendor's own
  `claude-sonnet-4-5`.
- **Merged model list.** `GET /v1/models` returns aliases bare, the
  default provider's models bare, and every other provider's as
  `<provider>/<model>` — one list any OpenAI client can drive.
- **Tool calling and streaming pass through unchanged** — they're the
  same OpenAI wire format in both directions, so compatibility is the
  backend's own.
- **Reasoning is not mapped.** Providers that split reasoning into a
  separate field (some vLLM/llama.cpp and reasoning-model deployments)
  emit content babelgate can't represent yet; see the README's Known
  limitations.
