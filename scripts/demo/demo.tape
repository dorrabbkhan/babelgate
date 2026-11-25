# babelgate README demo: Claude Code fixes a failing test through
# babelgate on the Gemini free tier — the release binary's free first
# run (`--provider gemini-free` → the preset's proven suggested model).
# Record with scripts/demo/record-demo.sh.
Output "/tmp/babelgate-demo.gif"
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

# Off camera: quiet logs, the release binary on PATH (record-demo.sh
# symlinks it into /tmp/babelgate-bin), GEMINI_API_KEY inherited from
# the record script's environment and never printed, and a sanity check
# that the binary runs.
Hide
Type "cd /tmp/babelgate-demo && export PS1='$ ' LOG_LEVEL=warn && unset ANTHROPIC_API_KEY && babelgate --version >/dev/null && clear" Enter
Wait /^\$ ?$/
Show

# 1. One command: the binary on the free preset — it fills the target,
#    base URL, key env var and the proven model itself. Its logs go to
#    a file so they can't scribble over Claude Code's screen.
Type "babelgate --preset claude-code --provider gemini-free > /tmp/babelgate.log 2>&1 &" Enter
Sleep 4s
Type "grep ^export /tmp/babelgate.log" Enter
Wait+Screen@60s /ANTHROPIC_AUTH_TOKEN/
Sleep 2s

# 2. Paste the two lines it printed.
Type "export ANTHROPIC_BASE_URL=http://localhost:3000 ANTHROPIC_AUTH_TOKEN=babelgate" Enter
Type "clear" Enter

# 3. The bug, then Claude Code (print mode, like the release gate: no dialogs) fixes it.
Type "cat src/sum.js" Enter
Sleep 2s
Type `claude -p "Make the failing test pass." --permission-mode acceptEdits --allowedTools "Bash(npm test:*)" 2>/dev/null` Enter
# Cut the model's thinking time: 2s on camera, then skip to the answer.
Sleep 2s
Hide
Wait@240s /^\$ ?$/
Show
Sleep 3s

# 4. Proof.
Type "cat src/sum.js && npm test 2>&1 | grep -E '(pass|fail) [0-9]'" Enter
Sleep 5s
