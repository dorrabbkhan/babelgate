#!/usr/bin/env bash
# OpenRouter Anthropic-endpoint check (plan v1.4 Task 1 Step 3,
# spec §4.5 — the result decides gate B's codex-anthropic example
# config in Task 14): one non-streaming POST to OpenRouter's
# Anthropic-compatible Messages endpoint with extended thinking on,
# reporting only the reply's shape — HTTP status, top-level `type`,
# `stop_reason`, `error.type` if present, and for each content block
# its `type` and whether it carries a non-empty `signature` (boolean
# plus length). No prompt text, no completion or thinking text and no
# key is ever printed.
#
#   scripts/gates/check-openrouter-anthropic.sh
#
# Key: OPENROUTER_API_KEY from the environment, else the
# OPENROUTER_API_KEY= line in ./.env (same dotenv parse babelgate
# uses; only that variable is read and it is never echoed).
#
# Refs:
#   https://platform.claude.com/docs/en/build-with-claude/extended-thinking
#   https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f .env ]; then
  OPENROUTER_API_KEY="$(
    node -e 'process.stdout.write(
      require("dotenv").config({ quiet: true }).parsed?.OPENROUTER_API_KEY ?? "",
    )' 2>/dev/null || true
  )"
  export OPENROUTER_API_KEY
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "CHECK FAIL: OPENROUTER_API_KEY is not set (env or .env)" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status="$(
  curl -sS -o "$work/response.json" -w '%{http_code}' --max-time 120 \
    -X POST https://openrouter.ai/api/v1/messages \
    -H "authorization: Bearer $OPENROUTER_API_KEY" \
    -H "content-type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    --data '{
      "model": "anthropic/claude-haiku-4.5",
      "max_tokens": 2048,
      "thinking": {"type": "enabled", "budget_tokens": 1024},
      "messages": [
        {"role": "user", "content": "What is 17 + 28? Answer with just the number."}
      ]
    }'
)" || {
  echo "status: 000"
  echo "CHECK FAIL: request did not complete" >&2
  exit 1
}

echo "status: $status"
node - "$work/response.json" <<'EOF'
const fs = require("node:fs");
let body;
try {
  body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch {
  console.log("type: <unparsed response body>");
  process.exit(0);
}
console.log(`type: ${body.type ?? "<absent>"}`);
if (body.stop_reason !== undefined) {
  console.log(`stop_reason: ${body.stop_reason}`);
}
if (body.error?.type !== undefined) {
  console.log(`error.type: ${body.error.type}`);
}
if (Array.isArray(body.content)) {
  body.content.forEach((block, i) => {
    const sig =
      typeof block?.signature === "string" && block.signature.length > 0;
    console.log(
      `content[${i}]: type=${block?.type ?? "<absent>"} ` +
        `signature=${sig} sig_len=${sig ? block.signature.length : 0}`,
    );
  });
}
EOF
