Closes #

<!--
The issue already says why this is worth doing. Do not restate it: one line of
framing, then the change. Delete any heading below you have nothing real to
write under.

The title must be a valid commit subject (feat: … / fix: … / docs: … / chore: …).
Conventions: docs/git_and_pr_conventions.md
-->

## What changed

<!-- The approach and the trade-off you took. Not a file list: GitHub shows
     those. If you rejected an alternative, say which and why. -->

## How it was verified

<!-- What you ran and the result:
       claude plugin validate .
       claude plugin test .
       tsc
     For anything visual (the pane, the ⚑ count, colors, hover, wrapping), say
     whether you looked at it in a real session and on which surface. The test
     kit draws none of these. A screenshot is the best evidence.
     Say plainly what you did not check. -->

## Risk

<!-- Stored data: can the new code read issues stored by the version before?
     Anything that renames a tool, a parameter, a userConfig option or an
     /issues argument is a breaking change.
     Conflicts with other open PRs, by number. -->

---

<!-- Version: the bump in .claude-plugin/plugin.json is made at merge time, as
     its own `chore: X.Y.Z` commit (feat → minor, fix → patch). -->
