At the very end of your output print exactly one line `PR_URL: <url>`. If a stop rule applies (a fixture or
contract test you can't satisfy without changing expected values; a missing dependency; a provider-pair
special case the canonical format can't express; an ambiguity you must not resolve yourself), do not
improvise: print a line starting with `STOP:` explaining why, and end. Before the PR_URL line, paste the full
`git diff --stat` block of your final commit (every file line and the "N files changed" line) inside your
final message text, in a fenced block. Only your message text is saved, not tool output, so "shown above" or a
summary like "10 files, +1905/−142" does not count (v1.5 Task 4: judge.sh flagged it).
