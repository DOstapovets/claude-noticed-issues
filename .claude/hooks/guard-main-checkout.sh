#!/usr/bin/env bash
# PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash: keep work out of this
# repository's main working tree. Claude Code may load the plugin straight from
# it, so an edit or a branch switch there changes the plugin in every session on
# the machine, and two agents in it overwrite each other. Work goes in a worktree
# under .claude/worktrees/ instead (docs/git_and_pr_conventions.md).
#
# Allowed there: switching back to main, and everything other than edits and
# `git switch` / `git checkout` (a fast-forward merge, a pull, reading).
set -u

input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")

if [ "$tool" = Bash ]; then
  cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
  grep -qE '\bgit( +-C +[^ ]+)? +(switch|checkout)\b' <<<"$cmd" || exit 0
  grep -qE '\bgit( +-C +[^ ]+)? +(switch|checkout)( +-q)? +main *($|[;&|])' <<<"$cmd" && exit 0
  dir=$(sed -nE 's/(^|.*[^[:alnum:]_])git +-C +([^ ]+) +(switch|checkout)([^[:alnum:]_].*)?$/\2/p' <<<"$cmd" | head -1)
  [ -n "$dir" ] || dir=$(jq -r '.cwd // empty' <<<"$input")
  what="\`git switch\` / \`git checkout\`"
else
  file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
  [ -n "$file" ] || exit 0
  # A new file may sit in a folder that does not exist yet: ask its nearest existing parent.
  dir=$(dirname "$file")
  while [ ! -d "$dir" ] && [ "$dir" != / ]; do dir=$(dirname "$dir"); done
  what="Editing $file"
fi

# Only this repository: the file's or the command's checkout must share its git directory.
here=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
there=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$here" = "$there" ] || exit 0

top=$(git -C "$dir" rev-parse --show-toplevel)
main=$(git -C "$dir" worktree list --porcelain | sed -n '1s/^worktree //p')
[ "$top" = "$main" ] || exit 0

cat >&2 <<EOF
$what in the main checkout ($main) is blocked: Claude Code may load the plugin from it.
Work in a worktree instead:
  git -C "$main" fetch origin
  git -C "$main" worktree add -b <type>/<slug> .claude/worktrees/<slug> origin/main
See docs/git_and_pr_conventions.md.
EOF
exit 2
