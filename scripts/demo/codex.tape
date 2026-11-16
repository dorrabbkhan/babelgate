# babelgate README demo: Codex CLI fixes a failing test through babelgate,
# bridged to Claude (anthropic/claude-haiku-4.5 via OpenRouter's
# /v1/messages — Responses → canonical → Anthropic). Run with
# scripts/demo/record-codex-demo.sh.
Output "/tmp/babelgate-codex-demo.gif"
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

# Off camera: quiet logs, a scratch CODEX_HOME inside the demo dir (the
# real ~/.codex stays untouched), the client-facing key, a warm npx cache
# (no "Ok to install?" prompt). OPENROUTER_API_KEY is inherited from the
# record script's environment and never printed.
Hide
Type "cd /tmp/babelgate-codex-demo && export PS1='$ ' LOG_LEVEL=warn CODEX_HOME=/tmp/babelgate-codex-demo/codex-home BABELGATE_KEY=babelgate && unset OPENAI_API_KEY && npx -y babelgate --help >/dev/null && clear" Enter
Wait /^\$ ?$/
Show

# 1. Start babelgate in front of Claude on OpenRouter (the config is the
#    record script's copy of examples/codex-anthropic.yaml). Its logs go
#    to a file so they can't scribble over Codex's screen.
Type "npx babelgate --config codex-anthropic.yaml > babelgate.log 2>&1 &" Enter
Sleep 4s
Type "grep OpenAI babelgate.log" Enter
Wait+Screen@60s /3000/
Sleep 2s
Type "clear" Enter

# 2. Codex's scratch config.toml (written by the record script): the
#    [model_providers.babelgate] block — Codex speaks Responses to
#    babelgate; babelgate bridges it to Anthropic.
Type "grep -A5 model_providers codex-home/config.toml" Enter
Sleep 2s

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
