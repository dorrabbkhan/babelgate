#!/usr/bin/env bash
# Complements probe-anthropic-shim.sh: asks questions only real content can answer, to tell "used" from "silently dropped".
# Does the endpoint actually USE a URL image and a PDF, or silently drop them? Asks questions only the
# real content can answer and prints the model's short answer (this is the one place a completion is shown).
#   BASE=https://api.z.ai/api/anthropic MODEL=GLM-4.6V-Flash API_KEY=... ./semantic-check.sh
# Expect: image answer "pig"; pdf answer contains "KUMQUAT". Anything else = the content was ignored.
# Retries on 429/503/529 (busy free tiers). Needs node. Never prints the key.
set -uo pipefail
: "${BASE:?}"; : "${MODEL:?}"; BASE="${BASE%/}"; T="${TIMEOUT_S:-180}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
AUTH=(); [ -n "${API_KEY:-}" ] && AUTH=(-H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY")
HDR=(-H "content-type: application/json" -H "anthropic-version: 2023-06-01" "${AUTH[@]}")

ask() { # name, json content array, question already inside content
  local name="$1" body="$2" code try
  for try in 1 2 3 4; do
    code="$(curl -sS --max-time "$T" -o "$W/out" -w '%{http_code}' -X POST "${HDR[@]}" -d "$body" "$BASE/v1/messages" 2>"$W/err")" || { echo "$name curl-failed"; return; }
    case "$code" in 429|503|529) [ "$try" -lt 4 ] && { sleep $((try*8)); continue; } ;; esac
    break
  done
  node -e '
    const fs=require("fs");const [n,c,f]=process.argv.slice(1);let j;try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
    if(!j){console.log(n,c,"non-json");process.exit()}
    if(j.error){console.log(n,c,"error",JSON.stringify(String((j.error.message)||j.error.type).slice(0,140)));process.exit()}
    const t=(j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(" ").replace(/\s+/g," ").slice(0,160);
    console.log(n,c,"answer="+JSON.stringify(t));' "$name" "$code" "$W/out"
}

echo "# semantic check base=$BASE model=$MODEL $(date -u +%FT%TZ)"
ask url_image "{\"model\":\"$MODEL\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"url\",\"url\":\"https://httpbin.org/image/png\"}},{\"type\":\"text\",\"text\":\"What animal is in this image? One word.\"}]}]}"

# one-page PDF with real text and a correct xref table, built here
node -e '
  const objs=[
   "<</Type/Catalog/Pages 2 0 R>>",
   "<</Type/Pages/Kids[3 0 R]/Count 1>>",
   "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
   null,
   "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  const stream="BT /F1 24 Tf 20 40 Td (The secret word is KUMQUAT) Tj ET";
  objs[3]="<</Length "+stream.length+">>\nstream\n"+stream+"\nendstream";
  let out="%PDF-1.4\n",off=[];
  objs.forEach((o,i)=>{off.push(out.length);out+=(i+1)+" 0 obj\n"+o+"\nendobj\n"});
  const x=out.length;
  out+="xref\n0 6\n0000000000 65535 f \n"+off.map(o=>String(o).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n"+x+"\n%%EOF\n";
  process.stdout.write(Buffer.from(out,"latin1").toString("base64"));' > "$W/pdf.b64"
ask pdf_text "{\"model\":\"$MODEL\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{\"type\":\"base64\",\"media_type\":\"application/pdf\",\"data\":\"$(cat "$W/pdf.b64")\"}},{\"type\":\"text\",\"text\":\"What is the secret word in the document? One word.\"}]}]}"
