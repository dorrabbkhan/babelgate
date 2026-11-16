#!/usr/bin/env bash
# Ollama Anthropic-endpoint probe (plan v1.5 Task 1, spec §3.3, E7,
# D8): sends one request per probe to a local Ollama's
# Anthropic-compatible endpoint and prints one "<probe> <status> <note>"
# line each — the measurements the `ollama-anthropic` preset's gap list
# is verified against in Task 9. Shape-only output: HTTP status, error
# `type`s, content-block `type`s, usage key names and SSE event names —
# never prompt text, completions or keys (Ollama needs none).
#
#   scripts/gates/probe-ollama-anthropic.sh [baseUrl]
#
# baseUrl defaults to http://localhost:11434. Probes:
#   tool_choice_any  POST /v1/messages with tool_choice {type:"any"}
#   count_tokens     POST /v1/messages/count_tokens
#   cache_control    POST /v1/messages, system block cache_control ephemeral
#   url_image        POST /v1/messages, image block source.type "url"
#   pdf_base64       POST /v1/messages, document block source.type "base64"
#                    (a generated 2-page PDF, ~1 kB)
#   stream_usage     POST /v1/messages stream:true — SSE event names and
#                    whether a usage object rides the message events
#
# Env overrides: PROBE_MODEL (default qwen3-coder:30b — pick a
# tool-capable model from `ollama list`), PROBE_PNG_URL (default
# https://httpbin.org/image/png — any public PNG works; Ollama fetches
# it itself), PROBE_TIMEOUT_S (per-request cap, default 180 — a cold
# model load can be slow).
#
# A gap that answers 4xx/5xx is a measurement, not a script failure —
# the script only fails (exit 1) when Ollama is unreachable or a probe
# cannot be sent at all.
set -euo pipefail

cd "$(dirname "$0")/../.."

base="${1:-http://localhost:11434}"
case "$base" in
  http://*|https://*) ;;
  *)
    echo "usage: $0 [baseUrl]  (http:// or https://, default http://localhost:11434)" >&2
    exit 2
    ;;
esac
base="${base%/}"
model="${PROBE_MODEL:-qwen3-coder:30b}"
png_url="${PROBE_PNG_URL:-https://httpbin.org/image/png}"
timeout_s="${PROBE_TIMEOUT_S:-180}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Reachability first: /api/version is Ollama's own endpoint.
version="$(curl -sfS --max-time 10 "$base/api/version" 2>/dev/null | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    try { process.stdout.write(JSON.parse(d).version ?? "unknown"); }
    catch { process.stdout.write("unknown"); }
  });
' || true)"
if [ -z "$version" ]; then
  echo "PROBE FAIL: ollama not reachable at $base (/api/version)" >&2
  exit 1
fi
echo "ollama version: $version"
echo "model: $model (base: $base)"

# A valid 2-page PDF (~1 kB) for pdf_base64, generated with correct
# xref offsets — the same document record-claude-code.sh media uses.
node - "$work/doc.pdf" <<'NODE'
const fs = require("node:fs");
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
fs.writeFileSync(process.argv[2], pdf, "latin1");
NODE

# One note line per probe: status plus enum-only fields parsed from
# the reply (error.type, content block types, usage key names). For
# SSE replies the note is the distinct event names in first-seen order
# and whether a usage object appeared in the stream. Nothing else from
# the body is printed.
probe() {
  local name="$1" path="$2" body_file="$3"
  local resp="$work/$name.resp" status
  status="$(curl -sS -o "$resp" -w '%{http_code}' --max-time "$timeout_s" \
    -X POST "$base$path" \
    -H "content-type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    --data "@$body_file")" || status="000"
  if [ "$status" = "000" ]; then
    echo "$name 000 request did not complete"
    return 0
  fi
  node - "$name" "$status" "$resp" <<'NODE'
const fs = require("node:fs");
const [name, status, file] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
let note = "unparsed body";
const isSse = raw.startsWith("event:") || raw.startsWith("data:") ||
  /\n(event|data):/.test(raw);
if (isSse) {
  const seen = [];
  let usage = false;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let ev = null;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5));
    }
    if (ev === null && data.length === 0) continue;
    let name2 = ev;
    try {
      const p = JSON.parse(data.join("\n").trim());
      if (name2 === null && typeof p?.type === "string") name2 = p.type;
      if (p && typeof p === "object" && (p.usage || p?.message?.usage)) {
        usage = true;
      }
    } catch {
      if (name2 === null) name2 = "<untyped>";
    }
    if (name2 && !seen.includes(name2)) seen.push(name2);
  }
  note = `events=${seen.join(",") || "none"} usage_in_stream=${usage}`;
} else {
  try {
    const p = JSON.parse(raw);
    const bits = [];
    if (p?.error?.type) bits.push(`error_type=${p.error.type}`);
    if (p?.type) bits.push(`type=${p.type}`);
    if (p?.stop_reason) bits.push(`stop_reason=${p.stop_reason}`);
    if (Array.isArray(p?.content)) {
      bits.push(
        `content_types=${p.content.map((b) => b?.type ?? "?").join(",")}`,
      );
    }
    if (typeof p?.input_tokens === "number") bits.push("input_tokens=present");
    if (p?.usage && typeof p.usage === "object") {
      bits.push(`usage_keys=${Object.keys(p.usage).join("|")}`);
    }
    if (bits.length === 0) bits.push("no enum fields");
    note = bits.join(" ");
  } catch {
    note = "unparsed body";
  }
}
console.log(`${name} ${status} ${note}`);
NODE
}

json() { cat > "$work/$1.json"; }

# tool_choice: {type:"any"} — forces a tool call where supported.
json tool_choice_any <<'EOF'
{"model":"__MODEL__","max_tokens":256,
 "tools":[{"name":"get_time","description":"Current local time.",
   "input_schema":{"type":"object","properties":{"tz":{"type":"string"}},
   "required":["tz"]}}],
 "tool_choice":{"type":"any"},
 "messages":[{"role":"user","content":"What time is it in Europe/Paris?"}]}
EOF

# count_tokens — Anthropic endpoint sibling route.
json count_tokens <<'EOF'
{"model":"__MODEL__",
 "messages":[{"role":"user","content":"How many tokens is this?"}]}
EOF

# cache_control on a system block — prompt caching.
json cache_control <<'EOF'
{"model":"__MODEL__","max_tokens":64,
 "system":[{"type":"text","text":"Answer tersely.",
   "cache_control":{"type":"ephemeral"}}],
 "messages":[{"role":"user","content":"Say hi."}]}
EOF

# URL image — source.type "url" (the server fetches it).
json url_image <<EOF
{"model":"__MODEL__","max_tokens":64,
 "messages":[{"role":"user","content":[
   {"type":"image","source":{"type":"url","url":"$png_url"}},
   {"type":"text","text":"One word: what colour dominates?"}]}]}
EOF

# base64 PDF — a document block carrying the generated 2-page file.
b64="$(base64 -w0 "$work/doc.pdf" 2>/dev/null || base64 "$work/doc.pdf")"
json pdf_base64 <<EOF
{"model":"__MODEL__","max_tokens":64,
 "messages":[{"role":"user","content":[
   {"type":"document","source":{"type":"base64",
     "media_type":"application/pdf","data":"$b64"}},
   {"type":"text","text":"How many pages does this document have?"}]}]}
EOF

# stream:true — does the stream carry a usage object.
json stream_usage <<'EOF'
{"model":"__MODEL__","max_tokens":32,"stream":true,
 "messages":[{"role":"user","content":"Say hi."}]}
EOF

# Substitute the model name into every probe body.
for f in "$work"/*.json; do
  node -e '
    const fs = require("fs");
    const [p, m] = process.argv.slice(1);
    fs.writeFileSync(p, JSON.stringify({...JSON.parse(fs.readFileSync(p, "utf8")), model: m}));
  ' "$f" "$model"
done

probe tool_choice_any /v1/messages "$work/tool_choice_any.json"
probe count_tokens /v1/messages/count_tokens "$work/count_tokens.json"
probe cache_control /v1/messages "$work/cache_control.json"
probe url_image /v1/messages "$work/url_image.json"
probe pdf_base64 /v1/messages "$work/pdf_base64.json"
probe stream_usage /v1/messages "$work/stream_usage.json"

echo "PROBE DONE"
