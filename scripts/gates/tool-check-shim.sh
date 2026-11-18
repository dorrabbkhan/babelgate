#!/usr/bin/env bash
# Complements scripts/gates/probe-anthropic-shim.sh: that probe prints shapes, this measures whether the upstream honours tool_choice.
# Is `tool_choice` honoured, or does the model just not call tools? Four requests with a control:
#   direct      "What time is it? Use the tool."          no tool_choice          -> can the model call tools AT ALL?
#   any_say_hi  "Say hi."                                 tool_choice any         -> forced call? (a tool_use here = honoured)
#   named       "Say hi."                                 tool_choice tool get_time -> forced named call?
#   none_direct "What time is it? Use the tool."          tool_choice none        -> suppressed call? (no tool_use = honoured)
# Prints only shapes: block types, tool names, stop_reason. No completions, no key.
#   BASE=http://localhost:1234 MODEL=qwen/qwen3-vl-8b ./tool-check.sh
#   BASE=https://api.z.ai/api/anthropic MODEL=GLM-4.5-Flash API_KEY=... ./tool-check.sh
# Env: ONLY (e.g. ONLY="any_say_hi named" runs just those), TIMEOUT_S (180), RETRIES (6, on 429/503/529 with growing waits), MAX_TOKENS (1024: reasoning models think first).
# Reading it: if `direct` has no tool_use, the model/endpoint can't call tools and the other lines prove nothing.
# If `direct` has tool_use and `any_say_hi`/`named` also do -> honoured. If `any_say_hi` has no tool_use -> NOT honoured.
# If `none_direct` still has tool_use -> `none` is NOT honoured.
set -uo pipefail
: "${BASE:?}"; : "${MODEL:?}"; BASE="${BASE%/}"; T="${TIMEOUT_S:-180}"; R="${RETRIES:-6}"; MT="${MAX_TOKENS:-1024}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
AUTH=(); [ -n "${API_KEY:-}" ] && AUTH=(-H "x-api-key: $API_KEY" -H "Authorization: Bearer $API_KEY")
HDR=(-H "content-type: application/json" -H "anthropic-version: 2023-06-01" "${AUTH[@]}")
TOOL='"tools":[{"name":"get_time","description":"Returns the current time. Call it whenever the user asks what time it is.","input_schema":{"type":"object","properties":{}}}]'

run() { # name, user text, tool_choice json (or empty)
  local name="$1" text="$2" tc="$3" body code try
  if [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $name "* ]]; then return; fi
  body="{\"model\":\"$MODEL\",\"max_tokens\":$MT,$TOOL${tc:+,\"tool_choice\":$tc},\"messages\":[{\"role\":\"user\",\"content\":\"$text\"}]}"
  for try in $(seq 1 "$R"); do
    code="$(curl -sS --max-time "$T" -o "$W/out" -w '%{http_code}' -X POST "${HDR[@]}" -d "$body" "$BASE/v1/messages" 2>"$W/err")" || { echo "$name curl-failed: $(head -c 140 "$W/err" | tr '\n' ' ')"; return; }
    case "$code" in 429|503|529) [ "$try" -lt "$R" ] && { sleep $((try*10)); continue; } ;; esac
    break
  done
  node -e '
    const fs=require("fs");const [n,c,f]=process.argv.slice(1);let j;try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
    if(!j){console.log(n,c,"non-json");process.exit()}
    if(j.error){console.log(n,c,"error",JSON.stringify(String(j.error.message||j.error.type).slice(0,120)));process.exit()}
    const b=j.content||[];const tu=b.filter(x=>x.type==="tool_use").map(x=>x.name);
    console.log(n,c,"blocks="+b.map(x=>x.type).join(",")+" tool_use="+(tu.length?tu.join(","):"NONE")+" stop_reason="+j.stop_reason);' "$name" "$code" "$W/out"
}

echo "# tool check base=$BASE model=$MODEL max_tokens=$MT $(date -u +%FT%TZ)"
run direct      "What time is it? Use the tool." ""
run any_say_hi  "Say hi." '{"type":"any"}'
run named       "Say hi." '{"type":"tool","name":"get_time"}'
run none_direct "What time is it? Use the tool." '{"type":"none"}'
