#!/usr/bin/env bash
# conformance-live.sh — rerun ONE conformance scenario through a
# gateway against the live provider (v1.6 spec §3.10, plan Task 13b).
#
#   scripts/research/conformance-live.sh <gateway> <scenario> [--dry-run]
#
#   <gateway>:  babelgate | ccr | free-claude-code
#   <scenario>: a scenario name from conformance.process.test.ts, e.g.
#               streamed-tool-args:anthropic->openai
#
# How it works: the conformance suite's "live mode" points the
# gateway's provider config at a localhost logging forward-proxy (the
# "spy") instead of the replay mock. The spy injects the real provider
# key, forwards to the live provider, and records every upstream
# request (headers redacted) plus the upstream status as JSONL — so
# the same scenario turns and pass rules apply, and the turn-2
# upstream request can be inspected for the reasoning field.
#
# Keys come from env, never from flags:
#   openai upstream — OPENROUTER_API_KEY (target openrouter.ai/api,
#                     model default deepseek/deepseek-r1-0528) or
#                     OPENAI_API_KEY (api.openai.com, gpt-4o-mini)
#   gemini upstream — GEMINI_API_KEY (generativelanguage.googleapis.com,
#                     gemini-3.5-flash)
# Model overrides: CONFORMANCE_LIVE_MODEL_{OPENAI,GEMINI} or
# CONFORMANCE_LIVE_MODEL.
#
# Offline-verifiable: argument parsing, the missing-key error and
# --dry-run make no network calls.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage() {
  echo "usage: $0 <gateway> <scenario> [--dry-run]" >&2
  echo "  gateway:  babelgate | ccr | free-claude-code" >&2
  echo "  scenario: <name>:<client>-><upstream>, e.g. streamed-tool-args:anthropic->openai" >&2
  exit 2
}

gateway=""
scenario=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) if [ -z "$gateway" ]; then gateway="$1"; elif [ -z "$scenario" ]; then scenario="$1"; else usage; fi; shift ;;
  esac
done
[ -n "$gateway" ] && [ -n "$scenario" ] || usage

case "$gateway" in
  babelgate|ccr|free-claude-code) ;;
  *) echo "conformance-live: unknown gateway '$gateway' (babelgate | ccr | free-claude-code)" >&2; exit 2 ;;
esac

case "$scenario" in
  *"->"*) ;;
  *) echo "conformance-live: scenario '$scenario' is not '<name>:<client>-><upstream>'" >&2; exit 2 ;;
esac
upstream="${scenario##*->}"
case "$upstream" in
  openai|gemini) ;;
  *) echo "conformance-live: upstream '$upstream' is not openai or gemini" >&2; exit 2 ;;
esac

key_env=""
target=""
key_header=""
model_default=""
case "$upstream" in
  openai)
    key_header="authorization"
    # dry-run picks the preferred env name even when unset so the
    # missing-key line can name it
    if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
      key_env="OPENROUTER_API_KEY"
      target="https://openrouter.ai/api"
      model_default="deepseek/deepseek-r1-0528"
    else
      key_env="OPENAI_API_KEY"
      target="https://api.openai.com"
      model_default="gpt-4o-mini"
    fi
    ;;
  gemini)
    key_header="x-goog-api-key"
    key_env="GEMINI_API_KEY"
    target="https://generativelanguage.googleapis.com"
    model_default="gemini-3.5-flash"
    ;;
esac
if [ -z "${!key_env:-}" ] && [ "$dry_run" = 0 ]; then
  echo "conformance-live: $upstream upstream needs \$$key_env" >&2
  exit 2
fi

model_var="CONFORMANCE_LIVE_MODEL_${upstream^^}"
model="${!model_var:-${CONFORMANCE_LIVE_MODEL:-$model_default}}"
spy_dir="tmp/conformance/live"
spy_log="$spy_dir/$gateway-${scenario//[^A-Za-z0-9_.-]/_}.jsonl"
spy_port="${CONFORMANCE_SPY_PORT:-4599}"
spy_js="$spy_dir/spy.mjs"

if [ "$dry_run" = 1 ]; then
  key_state="set"; [ -n "${!key_env:-}" ] || key_state="NOT SET"
  cat <<EOF
conformance-live dry run
  gateway:   $gateway
  scenario:  $scenario
  upstream:  $upstream -> $target (key from \$$key_env [$key_state], header $key_header)
  model:     $model (override: $model_var / CONFORMANCE_LIVE_MODEL)
  spy:       http://127.0.0.1:$spy_port -> $target, log $spy_log
  command:
    CONFORMANCE_GATEWAYS=$gateway \\
      CONFORMANCE_LIVE_UPSTREAM=http://127.0.0.1:$spy_port \\
      CONFORMANCE_LIVE_SPY_LOG=$spy_log \\
      $model_var=$model \\
      npx vitest run --config vitest.process.config.ts \\
        tests/process/conformance.process.test.ts -t "$scenario"
EOF
  exit 0
fi

mkdir -p "$spy_dir"
cat > "$spy_js" <<'SPY_EOF'
// conformance-live spy: localhost forward-proxy that injects the real
// provider key, logs each upstream request (headers redacted) as JSONL
// to SPY_LOG, then forwards the response verbatim. Written by
// scripts/research/conformance-live.sh; gitignored under tmp/.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const target = process.env.SPY_TARGET.replace(/\/$/, "");
const key = process.env.SPY_KEY;
const keyHeader = process.env.SPY_KEY_HEADER;
const logPath = process.env.SPY_LOG;
const targetUrl = new URL(target);

const SENSITIVE = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
]);

const server = http.createServer((req, res) => {
  if (req.url === "/__health") {
    res.writeHead(200).end("ok");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers["content-length"];
    delete headers["connection"];
    headers.host = targetUrl.host;
    let path = req.url;
    // inject the real key (header or key= query param); the recorded
    // copy keeps redacted headers only
    if (keyHeader === "x-goog-api-key") {
      headers["x-goog-api-key"] = key;
      if (/([?&])key=/.test(path)) {
        path = path.replace(/([?&])key=[^&]*/, `$1key=${key}`);
      }
    } else {
      headers.authorization = `Bearer ${key}`;
    }
    const safeHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k,
        SENSITIVE.has(k.toLowerCase()) ? "<redacted>" : v,
      ]),
    );
    const fwd = https.request(
      {
        method: req.method,
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path,
        headers,
      },
      (up) => {
        const rec = {
          method: req.method,
          url: req.url,
          headers: safeHeaders,
          body: body.toString("utf8"),
          upstreamStatus: up.statusCode,
        };
        // record at response headers time: the entry exists before
        // the gateway finishes relaying the stream to the client
        fs.appendFileSync(logPath, JSON.stringify(rec) + "\n");
        res.writeHead(up.statusCode, up.headers);
        up.on("data", (c) => res.write(c));
        up.on("end", () => res.end());
      },
    );
    fwd.on("error", (err) => {
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: safeHeaders,
          body: body.toString("utf8"),
          upstreamStatus: 0,
          error: String(err),
        }) + "\n",
      );
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("spy upstream error");
    });
    fwd.write(body);
    fwd.end();
  });
});
server.listen(Number(process.env.SPY_PORT), "127.0.0.1");
SPY_EOF

: > "$spy_log"
spy_pid=""
cleanup() {
  [ -n "$spy_pid" ] && kill "$spy_pid" 2>/dev/null || true
}
trap cleanup EXIT

key_value="${!key_env}"
SPY_TARGET="$target" SPY_KEY="$key_value" SPY_KEY_HEADER="$key_header" \
  SPY_LOG="$spy_log" SPY_PORT="$spy_port" \
  node "$spy_js" &
spy_pid=$!
for i in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$spy_port/__health" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$spy_pid" 2>/dev/null; then
    echo "conformance-live: spy failed to start" >&2
    exit 1
  fi
  sleep 0.1
done

set +e
env \
  CONFORMANCE_GATEWAYS="$gateway" \
  CONFORMANCE_LIVE_UPSTREAM="http://127.0.0.1:$spy_port" \
  CONFORMANCE_LIVE_SPY_LOG="$spy_log" \
  "$model_var"="$model" \
  npx vitest run --config vitest.process.config.ts \
    tests/process/conformance.process.test.ts -t "$scenario"
vitest_status=$?
set -e

# Interpret the spy log: no upstream call or an upstream error means
# the live run cannot confirm either direction.
upstream_calls=$(grep -c '"method"' "$spy_log" 2>/dev/null || true)
upstream_ok=$(grep -c '"upstreamStatus":2' "$spy_log" 2>/dev/null || true)
if [ "$vitest_status" = 0 ]; then
  echo "conformance-live: $gateway $scenario PASS (live)"
  exit 0
fi
if [ "$upstream_calls" = 0 ]; then
  echo "conformance-live: $gateway $scenario INCONCLUSIVE — gateway made no upstream call (spy log $spy_log)"
  exit 1
fi
if [ "$upstream_ok" -lt "$upstream_calls" ]; then
  echo "conformance-live: $gateway $scenario INCONCLUSIVE — upstream returned non-2xx (spy log $spy_log)"
  exit 1
fi
echo "conformance-live: $gateway $scenario CONFIRMED FAILURE (live) — see $spy_log"
exit 1
