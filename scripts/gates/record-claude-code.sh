#!/usr/bin/env bash
# Claude Code shape recorder (plan v1.5 Task 1, spec §3.1 "Evidence
# first", §3.2): puts record-shapes.ts in front of OpenRouter's
# Anthropic-compatible upstream and runs a non-interactive `claude -p`
# task pointed at the recorder with ANTHROPIC_BASE_URL. No babelgate in
# the loop: this records what Claude Code itself sends to a native
# Anthropic endpoint (Claude Code → recorder → upstream). Every request
# lands as one shape line — method, path, query keys, header names and
# a value-free body shape — in the JSONL the script prints.
#
#   scripts/gates/record-claude-code.sh thinking|media [--upstream <baseUrl>]
#     [--model <slug>]
#
# `thinking` runs the edit-task fixture copy with MAX_THINKING_TOKENS
# set (extended thinking on for every request — the Anthropic SDK env
# knob Claude Code passes through) so the second and later /v1/messages
# bodies show whether thinking blocks and their signatures come back
# unchanged. `media` instead runs in a scratch dir holding a generated
# 2-page PDF and serves a generated PNG over a second local port, then
# prompts Claude Code to read both — the recorded body shapes show how
# it sends a URL image and a document (block types, source.type).
#
# --model is the slug written to ANTHROPIC_MODEL (default
# anthropic/claude-haiku-4.5); --upstream is the Anthropic API base the
# recorder forwards to (default https://openrouter.ai/api — Claude Code
# appends /v1/messages, so requests land at <upstream>/v1/messages,
# https://openrouter.ai/api/v1/messages for the default; the
# check-openrouter-anthropic.sh probe uses the same endpoint).
#
# The recorder runs with RECORD_KEEP_ENUMS=1 (record-shapes.ts): type
# values (Anthropic content blocks carry `type` everywhere — the
# thinking/media evidence needs them verbatim), tool names, model and
# the SSE event names are kept; everything else stays a "<string:len>"
# shape, so signatures, prompt text and keys never reach the JSONL.
#
# Real upstream only — this script makes network calls and needs
# OPENROUTER_API_KEY: exported in the environment, or present as an
# OPENROUTER_API_KEY= line in ./.env, read with the same dotenv parse
# babelgate itself uses (only that variable is exported — the file is
# never sourced and the value is never printed; the key travels as
# ANTHROPIC_AUTH_TOKEN and never reaches the JSONL: header names only).
#
# Env overrides: CLAUDE_BIN (path to a claude binary, default: `claude`
# on PATH or `npx -y @anthropic-ai/claude-code`), RECORD_OUT (JSONL
# path, default tmp/ under the repo), CLAUDE_TIMEOUT_S (hard cap on the
# `claude -p` run, default 600), MAX_THINKING_TOKENS (thinking budget
# for `thinking` mode, default 1024 — the Anthropic minimum),
# RECORD_PNG_URL (`media` mode only: the image URL handed to Claude
# Code, default the locally served generated PNG — set it to a public
# PNG URL to record the real remote-fetch path instead).
set -euo pipefail

cd "$(dirname "$0")/../.."
FIXTURE="scripts/gates/fixtures/edit-task"
MODEL="anthropic/claude-haiku-4.5"

usage() {
  echo "usage: $0 thinking|media [--upstream <baseUrl>] [--model <slug>]" >&2
}

mode="${1:-}"
[ $# -gt 0 ] && shift
upstream="https://openrouter.ai/api"
while [ $# -gt 0 ]; do
  case "$1" in
    --upstream)
      upstream="${2:?--upstream needs a value}"
      shift 2
      ;;
    --model)
      MODEL="${2:?--model needs a value}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

case "$mode" in
  thinking|media) ;;
  *)
    usage
    exit 2
    ;;
esac

# Key from the environment first; if unset, the same ./.env babelgate
# loads — parsed with dotenv itself so quoting rules match, and only
# this variable is exported (the file is never sourced, the value
# never printed).
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f .env ]; then
  OPENROUTER_API_KEY="$(
    node -e 'process.stdout.write(
      require("dotenv").config({ quiet: true }).parsed?.OPENROUTER_API_KEY ?? "",
    )' 2>/dev/null || true
  )"
  export OPENROUTER_API_KEY
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "RECORD FAIL: OPENROUTER_API_KEY is not set (env or .env)" >&2
  exit 1
fi

# claude binary: CLAUDE_BIN, then PATH, then npx. ~/.npm can be
# read-only, so npx gets a throwaway cache.
if [ -n "${CLAUDE_BIN:-}" ]; then
  claude_cmd=("$CLAUDE_BIN")
elif command -v claude >/dev/null 2>&1; then
  claude_cmd=(claude)
else
  claude_cmd=(npx -y @anthropic-ai/claude-code)
fi

started="$(date +%s)"
work="$(mktemp -d)"
npm_cache="$(mktemp -d)"
recorder_pid=""
png_pid=""
out_jsonl="${RECORD_OUT:-$PWD/tmp/claude-code-records/$mode-$(date +%Y%m%d-%H%M%S).jsonl}"

cleanup() {
  for pid in "$recorder_pid" "$png_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$work" "$npm_cache"
}
trap cleanup EXIT

mkdir -p "$work/task" "$(dirname "$out_jsonl")"

# One free port, OS-assigned, for the recorder; media mode gets a
# second one for the PNG static server.
port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# Minimal generated media fixtures (media mode): a valid 2-page PDF
# written with correct xref offsets, and a 1×1 PNG built from chunks
# with real CRCs — both tiny but well-formed, so whatever tool Claude
# Code picks (Read, WebFetch, curl) can actually parse them.
write_pdf() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const out = process.argv[2];
const stream = (s) => `<</Length ${s.length}>>\nstream\n${s}\nendstream`;
const objs = [
  "<</Type/Catalog/Pages 2 0 R>>",
  "<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>",
  "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
    "/Contents 5 0 R/Resources<</Font<</F1 6 0 R>>>>>>",
  "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
    "/Contents 7 0 R/Resources<</Font<</F1 6 0 R>>>>>>",
  stream("BT /F1 24 Tf 72 700 Td (Page one) Tj ET"),
  "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  stream("BT /F1 24 Tf 72 700 Td (Page two) Tj ET"),
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(out, pdf, "latin1");
NODE
}

png_url="${RECORD_PNG_URL:-}"
if [ "$mode" = "media" ]; then
  write_pdf "$work/task/doc-2pages.pdf"
  if [ -z "$png_url" ]; then
    png_port="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
    node -e '
      const http = require("node:http");
      const zlib = require("node:zlib");
      const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(1, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = 8; // bit depth
      ihdr[9] = 2; // truecolour RGB
      const raw = Buffer.from([0, 0x80, 0x20, 0x20]); // filter byte + 1 px
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
      ]);
      http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
      }).listen(Number(process.argv[1]), "127.0.0.1");
    ' "$png_port" >"$work/png.log" 2>&1 &
    png_pid=$!
    png_url="http://127.0.0.1:$png_port/image.png"
  fi
else
  cp -R "$FIXTURE"/. "$work/task/"
fi

# RECORD_KEEP_ENUMS=1: Anthropic block `type` values, tool names and
# the SSE event names land verbatim in the JSONL — the thinking and
# media evidence needs the enum names; everything else stays a
# "<string:len>" shape.
npm_config_cache="$npm_cache" \
  RECORD_KEEP_ENUMS=1 \
  npx ts-node scripts/gates/record-shapes.ts \
  "$port" "$upstream" "$out_jsonl" \
  >"$work/recorder.log" 2>&1 &
recorder_pid=$!

# Readiness: the recorder prints one line when it binds.
ready=""
for _ in $(seq 1 30); do
  if grep -q "record-shapes listening" "$work/recorder.log" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$recorder_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "RECORD FAIL: recorder did not start on :$port" >&2
  tail -20 "$work/recorder.log" >&2 || true
  exit 1
fi

# Prompt and tool allow-list per mode (flag semantics from
# `claude --help`, same as claude-code-edit.sh: -p prints and exits,
# --permission-prompts none denies anything that would prompt,
# --strict-mcp-config and --setting-sources local keep the owner's
# ~/.claude and project config from widening the tool set).
claude_args=(-p --permission-prompts none --strict-mcp-config --setting-sources local)
extra_env=()
if [ "$mode" = "thinking" ]; then
  prompt="Make the failing test pass. Run npm test to check your work."
  claude_args+=(--allowedTools "Edit" "Write" "Bash(npm test)")
  # Extended thinking on for every request, at the API's minimum
  # budget — the point of the recording is whether the *next* request
  # carries the thinking blocks and signatures back unchanged.
  extra_env+=("MAX_THINKING_TOKENS=${MAX_THINKING_TOKENS:-1024}")
else
  prompt="Read the image at $png_url and the PDF at ./doc-2pages.pdf, then write one line about each to media-notes.txt."
  claude_args+=(--allowedTools "Read" "Write" "WebFetch" "Bash(curl:*)")
fi

# Non-interactive Claude Code run against the recorder.
# ANTHROPIC_BASE_URL points the Anthropic SDK at the recorder;
# ANTHROPIC_AUTH_TOKEN is forwarded as `authorization: Bearer` — what
# OpenRouter's /api/v1/messages expects. ANTHROPIC_API_KEY is unset so
# no x-api-key header competes with it. timeout + </dev/null: a dead
# upstream makes Claude Code retry, so the run gets a hard cap and no
# stdin to block on. Scratch HOME keeps the owner's ~/.claude state
# (auth, sessions, project history) out of the recording.
(
  cd "$work/task"
  env -u ANTHROPIC_API_KEY -u PROXY_API_KEY \
    HOME="$work/home" \
    npm_config_cache="$npm_cache" \
    ANTHROPIC_BASE_URL="http://localhost:$port" \
    ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" \
    ANTHROPIC_MODEL="$MODEL" \
    "${extra_env[@]+"${extra_env[@]}"}" \
    timeout -k 30 "${CLAUDE_TIMEOUT_S:-600}" \
      "${claude_cmd[@]}" "${claude_args[@]}" "$prompt" \
      </dev/null >"$work/claude.log" 2>&1
) || true

# Give the last requests a beat to flush through the recorder.
sleep 1

# A timed-out or never-connecting run leaves no JSONL — that is a
# recording failure, not an empty result.
if [ ! -s "$out_jsonl" ]; then
  echo "RECORD FAIL: no requests recorded" >&2
  echo "--- recorder log (tail) ---" >&2
  tail -20 "$work/recorder.log" >&2 || true
  echo "--- claude log (tail) ---" >&2
  tail -20 "$work/claude.log" >&2 || true
  exit 1
fi

elapsed="$(( $(date +%s) - started ))"
echo "claude version: $(npm_config_cache="$npm_cache" "${claude_cmd[@]}" --version 2>&1 | head -1)"
echo "model: $MODEL (mode: $mode, upstream: $upstream)"
echo "duration: ${elapsed}s"
echo "requests recorded: $(grep -c . "$out_jsonl")"
echo "jsonl: $out_jsonl"

# The edit-task fixture has a pass/fail of its own; media mode's
# proof is the recorded request shapes — a non-empty JSONL (checked
# above) already means the run reached the upstream.
if [ "$mode" = "thinking" ]; then
  if (cd "$work/task" && npm_config_cache="$npm_cache" npm test) \
    >"$work/npm-test.log" 2>&1; then
    echo "claude edit task: PASS"
  else
    echo "claude edit task: FAIL"
    echo "--- claude output (tail) ---" >&2
    tail -30 "$work/claude.log" >&2 || true
    exit 1
  fi
else
  echo "claude media task: recorded"
fi
