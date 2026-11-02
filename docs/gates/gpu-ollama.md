# Gate runbook: Claude Code ↔ Ollama on a rented GPU

Release gate 1 (spec §4.5, owner decision D4): prove Claude Code can do
a real edit task through babelgate on local Ollama `qwen3-coder:30b`.
The owner's laptop is not a gate machine — rent a GPU host, run the gate
script against it, record the result, tear down. **Target: ≤ 15 minutes
of paid time per release.**

The gate itself lives in `scripts/gates/claude-code-edit.sh`; what this
runbook adds is the host. Have `claude` (Claude Code CLI) and Node ≥ 20
on *your* machine — only Ollama runs on the rented host.

## 1. Host requirements

- **≥ 24 GB VRAM** — `qwen3-coder:30b` is a ~19 GB download and wants
  headroom for context (`num_ctx` 32 768). An RTX 4090, L40S or A10G+
  class instance is enough; any GPU-rental marketplace works.
- ~25 GB free disk, outbound HTTPS (for `ollama pull`), SSH access.

## 2. Install Ollama and pull the model

On the host:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-coder:30b     # ~19 GB; the longest step, start it first
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

## 4. Run the gate

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

## 5. Record the result

Append the run to this task's entry in `docs/decisions.md` — one line per
run is enough:

```md
- **Gate 1 (Claude Code ↔ Ollama GPU):** `GATE PASS` — Claude Code
  <version>, `qwen3-coder:30b` on <GPU, e.g. RTX 4090 24 GB>, <duration>,
  <cost>. <date>
```

On `GATE FAIL`: keep the host up, save the script's tailed logs, and
rerun once before reporting — a cold-model timeout is the most common
flake. If it fails twice, record it as a failure; do not tune timeouts
or edit the script to make it pass.

## 6. Tear down

Stop the tunnel, then delete the instance (not just stop it — stopped
GPU instances often still bill). On the host, `ollama rm qwen3-coder:30b`
first if you want the disk back before imaging. Verify the provider
shows no running or reserved resources before closing the runbook.
