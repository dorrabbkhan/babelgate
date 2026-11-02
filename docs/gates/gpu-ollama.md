# Gate runbook: Claude Code ↔ Ollama on a rented GPU

Release gates 1–3 (spec §4.5, owner decision D4). Gate 1 proves Claude
Code can do a real edit task through babelgate on local Ollama
`qwen3-coder:30b`; Gate 2 reruns the same edit task through the hybrid
YAML config on the same host; Gate 3 is a live Gemini run that only
needs a key plus any reachable Ollama. The owner's laptop is not a gate
machine — rent a GPU host, run the gate script against it, record the
result, tear down. **Target: ≤ 15 minutes of paid time per release.**

The gate itself lives in `scripts/gates/claude-code-edit.sh`; what this
runbook adds is the host. Have `claude` (Claude Code CLI) and Node ≥ 20
on *your* machine — only Ollama runs on the rented host.

## 1. Host requirements

- **≥ 24 GB VRAM** — `qwen3-coder:30b` is a ~19 GB download and wants
  headroom for context (`num_ctx` 32 768). An RTX 4090, L40S or A10G+
  class instance is enough; any GPU-rental marketplace works. Gate 2
  also routes haiku calls to `qwen2.5-coder:7b` (~5 GB): if the card
  can't hold both at once Ollama reloads per call and the gate can run
  past its timeouts — a ≥ 32 GB card removes the risk.
- ~30 GB free disk (both models ≈ 24 GB), outbound HTTPS (for
  `ollama pull`), SSH access.

## 2. Install Ollama and pull the models

On the host:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-coder:30b       # ~19 GB; the longest step, start it first
ollama pull qwen2.5-coder:7b      # ~5 GB; Gate 2 routes haiku calls here
```

## 3. Expose the port to your machine

Prefer an SSH tunnel — Ollama has no authentication, so binding it to a
public interface lets anyone on the internet run models on your dime.

```bash
# from your machine, in its own terminal:
ssh -N -L 11434:localhost:11434 <user>@<host>
```

If a tunnel is impossible, bind Ollama to the interface instead and
restrict it to your IP with a firewall rule:

```bash
sudo systemctl edit ollama   # add:  [Service]  Environment="OLLAMA_HOST=0.0.0.0"
sudo systemctl restart ollama
```

Check it answers before spending gate time:

```bash
curl http://localhost:11434/api/tags    # via the tunnel
# or http://<host>:11434/api/tags       # if you bound it directly
```

## 4. Run Gate 1 (Claude Code ↔ Ollama)

From the babelgate repo root on your machine, with
`OLLAMA_API_BASE_URL` pointed at the host:

```bash
# via SSH tunnel:
OLLAMA_API_BASE_URL=http://localhost:11434 \
  scripts/gates/claude-code-edit.sh ollama qwen3-coder:30b

# or direct:
OLLAMA_API_BASE_URL=http://<host>:11434 \
  scripts/gates/claude-code-edit.sh ollama qwen3-coder:30b
```

The script copies the failing-test fixture, starts
`babelgate --preset claude-code --target ollama`, lets Claude Code fix
the bug through the proxy, then runs the fixture's `npm test` itself.
It prints the `claude --version`, model, duration, and
`GATE PASS`/`GATE FAIL`.

## 5. Run Gate 2 (Claude Code ↔ hybrid config)

Same edit task, but babelgate loads `examples/claude-code-hybrid.yaml`
instead of a single target: `claude-*haiku*` goes straight to
`ollama/qwen2.5-coder:7b` (**no fallback**), `claude-*` goes to
`ollama/qwen3-coder:30b` with OpenRouter as the fallback, and long
contexts (≥ 60 000 estimated input tokens) go straight to OpenRouter.

Needs, on your machine:

- **Ollama reachable at `http://localhost:11434`** — the example YAML
  hard-codes that base URL, so keep the §3 SSH tunnel up (or copy the
  YAML to a writable path, edit `providers.ollama.base_url`, and pass
  your copy). Both models from §2 must be pulled.
- **`OPENROUTER_API_KEY`** set in the environment — the `openrouter`
  provider's `api_key_env`; without it babelgate refuses to start.
- Optional: `CLAUDE_CODE_MAX_OUTPUT_TOKENS=<n>` (e.g. `1024`) passes
  through to `claude` — set it if the OpenRouter key has a spend cap.

```bash
OPENROUTER_API_KEY=<key> \
  scripts/gates/claude-code-edit.sh config examples/claude-code-hybrid.yaml hybrid

# with a spend cap:
OPENROUTER_API_KEY=<key> CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024 \
  scripts/gates/claude-code-edit.sh config examples/claude-code-hybrid.yaml hybrid
```

**Seeing which provider served the requests:** every proxied response
carries `x-babelgate-provider` and `x-babelgate-attempts` (> 1 means a
fallback fired), and babelgate logs one route log line per request
(`"Request completed"` with `reason`, `hops` and `winner`). After the
Claude Code run the script prints a routing summary — request counts by
`winner` and by `reason`, plus the count of multi-hop (fallback)
requests — take the providers-used numbers for the record below from
it. The full log lives only in the script's temp dir and is deleted on
exit (it is tailed to stderr only when babelgate itself fails to
start); to watch routing live, start babelgate in a second terminal —
`OPENROUTER_API_KEY=<key> node dist/cli.js --config
examples/claude-code-hybrid.yaml --preset claude-code --port <port>` —
and read the route lines there.

## 6. Run Gate 3 (Gemini live run)

A clean live-suite run with the Gemini target enabled, on fresh quota
(or a paid tier). Every `gemini`-target case must pass; other targets
still need their own keys and are skipped when unset, but the suite
always needs a reachable Ollama:

```bash
GEMINI_API_KEY=<key> OLLAMA_API_BASE_URL=http://localhost:11434 \
  npm run test:live
```

`OLLAMA_API_BASE_URL` can keep pointing at the rented host through the
same tunnel, or at any local Ollama — the `ollama` target uses whatever
`LIVE_OLLAMA_MODEL` names (default `qwen2.5:0.5b`, pull it on whichever
host answers).

## 7. Record the results

Fill in the placeholders in this task's `docs/decisions.md` entry — one
line per gate:

```md
- **Gate 1 (Claude Code ↔ Ollama GPU):** `GATE PASS` — Claude Code
  <version>, `qwen3-coder:30b` on <GPU, e.g. RTX 4090 24 GB>, <duration>,
  <cost>. <date>
- **Gate 2 (Claude Code ↔ hybrid config):** `GATE PASS` — Claude Code
  <version>, providers used <winner counts from the script's routing
  summary, e.g. `ollama=10 openrouter=2`>, <duration>, <cost>. <date>
- **Gate 3 (Gemini live):** all `gemini`-target cases passed —
  <N passed>/<N total>, <date>
```

On `GATE FAIL`: keep the host up, save the script's tailed logs, and
rerun once before reporting — a cold-model timeout is the most common
flake. If it fails twice, record it as a failure; do not tune timeouts
or edit the script to make it pass.

## 8. Tear down

Stop the tunnel, then delete the instance (not just stop it — stopped
GPU instances often still bill). On the host, `ollama rm qwen3-coder:30b`
first if you want the disk back before imaging. Verify the provider
shows no running or reserved resources before closing the runbook.
