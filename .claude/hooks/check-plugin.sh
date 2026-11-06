#!/usr/bin/env bash
# PostToolUse on Edit|Write|MultiEdit: after a change to the plugin's code or its
# types, validate and test the checkout the file is in (a worktree or the main
# one). On a failure the output goes back to Claude, which then fixes it.
set -u

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -n "$file" ] || exit 0
root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/.claude-plugin/plugin.json" ] || exit 0
case "$file" in "$root"/hooks/* | "$root"/types/*) ;; *) exit 0 ;; esac

if ! out=$(claude plugin validate "$root" 2>&1); then
  printf 'claude plugin validate failed in %s:\n%s\n' "$root" "$(printf '%s\n' "$out" | tail -40)" >&2
  exit 2
fi
# Only what failed: the passing tests' lines would bury it.
if ! out=$(claude plugin test "$root" 2>&1); then
  printf 'claude plugin test failed in %s:\n%s\n' "$root" "$(printf '%s\n' "$out" | grep -v '^(pass)' | tail -40)" >&2
  exit 2
fi
