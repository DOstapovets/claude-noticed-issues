# Performance

What the plugin costs, where that cost is checked, and what is left as it is.
Measured on Claude Code 2.1.323, on a laptop, on 2026-11-21.

## What is expensive here

- **`$.store` is one JSON file for every project.** Each `get` reads the whole
  file, each `set` rewrites it under a lock. So a call costs as much as all the
  lists together, up to the 4 MiB the store takes.
- **Every `$.state` write redraws** each pane and band that read the value, at
  the redraw rate, even when the value is the same as before.
- **Timers run in every session:** the list is read again every 30 seconds
  (`RELOAD_MS`), the other projects and the comments in the code too while their
  tab is open, and GitHub every 5 minutes (`GITHUB_MS`).

## Where it is checked

Tests that count calls are in `hooks/register.test.tsx`, at the end, under
"What the plugin costs". They count each `$.store` key's `get` and `set` and
each `$.state` write, so they do not depend on the machine's speed:

| Action | Budget |
| --- | --- |
| A reload that finds nothing new | no `$.state` write, on every tab |
| A reload | 1 read of the list; with Projects open, 1 more for each other project |
| `resolve_issue`, a press in the pane | 1 read and 1 write of the list |
| `note_issue` | 2 reads (near duplicates, then the add) and 1 write |
| A GitHub pass | 1 `gh api graphql` per 25 linked issues, one host a query; no pass while one runs |
| A repository's sessions | 1 GitHub pass in 5 minutes between them; none while the rate limit is low |

Timing tests are in `hooks/perf.test.ts`, on lists far longer than usual. Each
is either a budget about ten times what a laptop takes, or how the time grows
from n to 4n: about 4 when the work is linear, 16 when it is quadratic, failed
past 8.

| Function | Laptop | Budget |
| --- | --- | --- |
| `arrange`, 100 cards at every field limit | 7 ms | 70 ms, growth < 8 |
| `similar`, 1000 issues | 5 ms | 50 ms, growth < 8 |
| `parseTodos`, 20,000 rows | 34 ms | 300 ms, growth < 8 |
| `parseTodos`, a minified line with strings of tags | | growth < 8 |
| The store | about 4.7 KB per issue at every field limit, so about 850 fit in 4 MiB | 800 fit, 900 do not |

## Fixed in this review

- **A reload redrew the pane and the count every 30 seconds** with nothing
  changed. `load`, `loadProjects` and `scanTodos` wrote their value each time.
  Now they compare it as JSON first, and write only when it changed.
- **`parseTodos` was quadratic on a long line.** For each tag it counted the
  quotes from the start of the line again: a minified line with 3000 tags inside
  strings took 99 ms. The line is now walked once for all of its tags.

## GitHub

A pass used to call `gh issue view` once per linked issue, in every session of the
repository. Now one `gh api graphql` query asks about 25 issues and the pull
requests that close them, and costs one point of the 5000 an hour. The first
query also searches for the pull requests that fix sessions marked. A
repository's sessions share `github:<root>` in `$.store`:

- `checkedAt`: a pass is made only when the last one, by any of the sessions, is
  at least 4.5 minutes old. `/noticely` and a newly filed issue skip this check.
- `pausedUntil`: below 200 points left, until the reset GitHub reports. After a
  rate-limit refusal, for 15 minutes. No pass at all, forced or not, until then.

A pass that learns nothing new writes nothing.

## Left as it is

- **`note_issue` reads the list twice.** Both reads see what other sessions
  saved meanwhile. One read fewer would let a near duplicate noted elsewhere in
  the last 30 seconds go unseen.
- **The Projects tab reads each other project's list on every reload.** The
  store has no call that reads several keys at once. It only happens while that
  tab is open.
- **`arrange` takes about 0.07 ms per card**, mostly `clipRows`, which cuts a
  detail one character at a time. It is linear and fast enough for any list the
  store can hold.

## Not checked

- How often the engine draws `AbovePrompt`, which calls `view` each time. The
  test kit does not count draws. Check it in a real session before changing it.
