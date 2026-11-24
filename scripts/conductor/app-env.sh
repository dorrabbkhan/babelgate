# Source this to act as the babelgate-conductor GitHub App (bash).
# - gh: the wrapper in bin/ goes first on PATH (fresh token per call).
# - git: github.com SSH remotes are rewritten to HTTPS and authenticated
#   by bin/git-credential-babelgate; commits are authored by the bot.
# Used by devin.sh, as-app.sh and start.sh. Your own shell is unaffected.
# dirname and the ls below run on a fixed PATH: this file may be sourced
# while PATH is already poisoned by an entry env can't exec through.
_conductor_bin="$(cd "$(PATH=/usr/bin:/bin dirname "${BASH_SOURCE[0]}")/bin" && pwd)"
# Drop PATH entries that exist but can't be listed — a stale mount's
# ENOTCONN or an unreadable dir's EACCES — because env's execvp stops at
# the first one and every `#!/usr/bin/env` script then fails. Entries
# that don't exist are left alone: ENOENT ("No such file or directory")
# is the only ls failure that keeps an entry.
_conductor_path=""
_conductor_rest="${PATH:+${PATH}:}"
while [[ "$_conductor_rest" == *:* ]]; do
  _conductor_d="${_conductor_rest%%:*}"
  _conductor_rest="${_conductor_rest#*:}"
  if ! _conductor_err="$(PATH=/usr/bin:/bin LC_ALL=C ls -- "$_conductor_d" 2>&1 >/dev/null)"; then
    [[ "$_conductor_err" == *"No such file or directory"* ]] || continue
  fi
  _conductor_path="${_conductor_path:+${_conductor_path}:}${_conductor_d}"
done
export PATH="$_conductor_bin${_conductor_path:+:$_conductor_path}"
unset _conductor_path _conductor_rest _conductor_d _conductor_err
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0="url.https://github.com/.insteadOf" GIT_CONFIG_VALUE_0="git@github.com:"
export GIT_CONFIG_KEY_1="credential.https://github.com.helper" GIT_CONFIG_VALUE_1=""
export GIT_CONFIG_KEY_2="credential.https://github.com.helper" GIT_CONFIG_VALUE_2="$_conductor_bin/git-credential-babelgate"
export GIT_AUTHOR_NAME="babelgate-conductor[bot]" GIT_COMMITTER_NAME="babelgate-conductor[bot]"
export GIT_AUTHOR_EMAIL="349243292+babelgate-conductor[bot]@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export CONDUCTOR_ACTOR="babelgate-conductor[bot]"
unset _conductor_bin
