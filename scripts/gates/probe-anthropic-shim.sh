#!/usr/bin/env bash
# Generalizes scripts/gates/probe-ollama-anthropic.sh for any Anthropic-compatible endpoint (BASE, MODEL, optional API_KEY).
# Probe an Anthropic-compatible endpoint (LM Studio, z.ai, ...) for the six gaps in
# babelgate's v1.5 Task 9: tool_choice, count_tokens, cache_control, url image, pdf, stream usage.
# Prints "<probe> <HTTP status> <shape>" lines only: error types and (truncated) error messages,
# content-block types, usage key names, SSE event names. Never completions, never your key.
#
#   BASE=http://localhost:1234 MODEL=ibm/granite-4-micro ./probe-anthropic-shim.sh | tee probe-lmstudio.txt
#   BASE=https://api.z.ai/api/anthropic MODEL=<glm model> API_KEY=... ./probe-anthropic-shim.sh | tee probe-glm.txt
#
# Env: BASE (required), MODEL (required), API_KEY (optional; sent as x-api-key AND Bearer),
#      PNG_URL (default https://httpbin.org/image/png), TIMEOUT_S (default 120).
# Note: a text-only model (e.g. granite-4-micro) may refuse images/PDFs for that reason alone.
# The error message in the output tells you which: "image/vision not supported by the model" is the
# model; "unsupported source type" is the endpoint.
set -uo pipefail

: "${BASE:?set BASE, e.g. http://localhost:1234}"
: "${MODEL:?set MODEL}"
BASE="${BASE%/}"
PNG_URL="${PNG_URL:-https://httpbin.org/image/png}"
T="${TIMEOUT_S:-120}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

AUTH=()
if [ -n "${API_KEY:-}" ]; then AUTH=(-H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY"); fi
HDR=(-H "content-type: application/json" -H "anthropic-version: 2023-06-01" "${AUTH[@]}")

# post <name> <path> <json> : prints "<name> <status> <shape>"
post() {
  local name="$1" path="$2" body="$3" code
  code="$(curl -sS --max-time "$T" -o "$W/out" -w '%{http_code}' -X POST "${HDR[@]}" -d "$body" "$BASE$path" 2>"$W/err")" || {
    echo "$name 000 curl-failed: $(head -c 120 "$W/err" | tr '\n' ' ')"; return; }
  node -e '
    const fs=require("fs"); const [name,code,f]=process.argv.slice(1);
    let t=fs.readFileSync(f,"utf8"), j; try{j=JSON.parse(t)}catch{}
    let s;
    if(!j) s="non-json body ("+t.length+" bytes)";
    else if(j.error){const e=j.error; s="error type="+(e.type||"?")+" msg="+JSON.stringify(String(e.message||e).slice(0,160));}
    else if(j.type==="error"){s="error type="+(j.error&&j.error.type)}
    else if(Array.isArray(j.content)) s="ok content_types="+j.content.map(b=>b.type).join(",")+" stop_reason="+j.stop_reason+" usage_keys="+Object.keys(j.usage||{}).join(",");
    else s="ok keys="+Object.keys(j).join(",")+(j.input_tokens!==undefined?" input_tokens="+j.input_tokens:"");
    console.log(name+" "+code+" "+s);' "$name" "$code" "$W/out"
}

U='"messages":[{"role":"user","content":"Say hi."}]'
TOOL='"tools":[{"name":"get_time","description":"Get the time","input_schema":{"type":"object","properties":{}}}]'

echo "# base=$BASE model=$MODEL $(date -u +%FT%TZ)"

post baseline /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,$U}"
post tool_choice_any /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":256,$U,$TOOL,\"tool_choice\":{\"type\":\"any\"}}"
post tool_choice_none /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":32,$U,$TOOL,\"tool_choice\":{\"type\":\"none\"}}"
post count_tokens /v1/messages/count_tokens "{\"model\":\"$MODEL\",$U}"
post cache_control_system /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,\"system\":[{\"type\":\"text\",\"text\":\"Be brief.\",\"cache_control\":{\"type\":\"ephemeral\"}}],$U}"
post cache_control_toplevel /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,\"cache_control\":{\"type\":\"ephemeral\"},$U}"
post url_image /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"url\",\"url\":\"$PNG_URL\"}},{\"type\":\"text\",\"text\":\"Describe.\"}]}]}"

# base64 PNG (1x1) for comparison: separates "no URL images" from "no images at all"
PNG64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
post b64_image /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"$PNG64\"}},{\"type\":\"text\",\"text\":\"Describe.\"}]}]}"

# tiny 1-page PDF, generated here
printf '%%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$W/t.pdf"
PDF64="$(base64 -w0 "$W/t.pdf")"
post pdf_base64 /v1/messages "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{\"type\":\"base64\",\"media_type\":\"application/pdf\",\"data\":\"$PDF64\"}},{\"type\":\"text\",\"text\":\"Summarise.\"}]}]}"

# streaming: event names + where usage appears (shape only)
code="$(curl -sS --max-time "$T" -N -o "$W/sse" -w '%{http_code}' -X POST "${HDR[@]}" -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"stream\":true,$U}" "$BASE/v1/messages" 2>"$W/err")" || code="000"
node -e '
  const fs=require("fs"); const code=process.argv[1]; const t=fs.readFileSync(process.argv[2],"utf8");
  const ev=[...new Set([...t.matchAll(/^event: (.+)$/gm)].map(m=>m[1].trim()))];
  let startUsage=null, deltaUsage=null;
  for(const m of t.matchAll(/^data: (\{.*\})$/gm)){ let j; try{j=JSON.parse(m[1])}catch{continue}
    if(j.type==="message_start"&&j.message&&j.message.usage) startUsage=Object.keys(j.message.usage).join(",");
    if(j.type==="message_delta"&&j.usage) deltaUsage=Object.keys(j.usage).join(","); }
  console.log("stream_usage "+code+" events="+(ev.join(",")||"none")+" message_start.usage="+(startUsage||"absent")+" message_delta.usage="+(deltaUsage||"absent"));
' "$code" "$W/sse"
