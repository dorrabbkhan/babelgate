# babelgate README demo: Codex fixes a failing test through babelgate
# on the Gemini free tier — the release binary's free first run
# (`--preset codex --provider gemini-free` prints the key line, writes
# the model catalog under ~/.babelgate and prints the config.toml
# block; Responses → canonical → Gemini upstream). Record with
# scripts/demo/record-codex-demo.sh.
Output "/tmp/babelgate-codex-demo.gif"
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

# Off camera: quiet logs, the release binary on PATH (the record script
# symlinks it into /tmp/babelgate-bin), a scratch CODEX_HOME inside the
# demo dir (the real ~/.codex stays untouched), GEMINI_API_KEY
# inherited from the record script's environment and never printed.
Hide
Type "cd /tmp/babelgate-codex-demo && export PS1='$ ' LOG_LEVEL=warn CODEX_HOME=/tmp/babelgate-codex-demo/codex-home && unset OPENAI_API_KEY && babelgate --version >/dev/null && clear" Enter
Wait /^\$ ?$/
Show

# 1. One command: the binary on the free preset — it fills the target,
#    base URL, key env var and the proven model itself. Its logs go to
#    a file so they can't scribble over Codex's screen.
Type "babelgate --preset codex --provider gemini-free > babelgate.log 2>&1 &" Enter
Sleep 4s
Type "sed -n '/Paste into/,/end of config.toml block/p' babelgate.log" Enter
Wait+Screen@60s /wire_api/
Sleep 2s

# 2. The printed key line, then the block pasted into the scratch
#    config.toml — written from the same lines by the record script
#    (plus exec-mode settings so the run needs no approvals).
Type "export BABELGATE_KEY=babelgate" Enter
Type "cat codex-home/config.toml" Enter
Sleep 2s
Type "clear" Enter

# 3. The bug, then Codex (exec mode, like the release gate) fixes it.
Type "cat src/sum.js" Enter
Sleep 2s
Type `codex exec --skip-git-repo-check "Make the failing test pass."` Enter
# Cut the model's thinking time: 2s on camera, then skip to the answer.
Sleep 2s
Hide
Wait@240s /^\$ ?$/
Show
Sleep 3s

# 4. Proof.
Type "cat src/sum.js && npm test 2>&1 | grep -E '(pass|fail) [0-9]'" Enter
Sleep 5s
