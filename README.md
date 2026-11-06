# noticed-issues

A Claude Code plugin that keeps a per-project list of problems Claude noticed
**outside the current task** and is not fixing right now: a bug next door, a leaked
secret, broken config, a failing check, stale docs. Instead of getting lost in the
conversation, each finding goes on a list that survives across sessions, grouped by
priority. From any entry you can start a background session to fix it, or file a
GitHub issue and follow its status.

## Install

At the prompt of a Claude Code terminal session:

```sh
/plugin install noticed-issues --marketplace DOstapovets/claude-noticed-issues
```

From a shell:

```sh
claude plugin install noticed-issues --marketplace DOstapovets/claude-noticed-issues
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box,
then **Plugins**, **Add marketplace** with `DOstapovets/claude-noticed-issues`, then **Add plugin**.

Then tell Claude to use it. Add a rule like this to `~/.claude/CLAUDE.md` (or a
project's `CLAUDE.md`), otherwise the model tends to mention findings in its reply
and move on:

```md
When you notice a problem outside the current task that you are not fixing now,
record it with the `note_issue` tool and mention it in one line in your reply.
Call `resolve_issue` once such an issue is fixed.
```

## What you get

**Two tools for the model**, always listed in the prompt (not behind ToolSearch):

| Tool | What it does |
| --- | --- |
| `note_issue` | Adds an entry: `title` (required), `detail`, `file` (`path[:line]`, a URL or a resource) and `priority` (`high`, `medium` or `low`; `medium` when left out). An entry with the same title, ignoring case, is not added twice. |
| `resolve_issue` | Removes an entry by its `id` once it is fixed or no longer relevant. |

**A count above the prompt**, `⚑ 3 issues`, that opens the pane when pressed. It is
hidden while the list is empty, and any band another plugin draws there stays below it.

**The "Noticed issues" pane** opens by itself when the list has something on it, and
with `/issues`. Entries are grouped under **● High**, **● Medium** and **● Low**, each
as a card with its number, title, file and detail, and these controls:

- **▶ New session** starts `claude --bg` with a prompt to fix the issue that ends by
  asking it to call `resolve_issue`. The card then shows the session id, which
  `claude attach <id>` connects to.
- **↗ GitHub issue** files it with `gh issue create` in the repository of the session's
  directory: the title becomes the issue title, `detail` and `file` its body. The card
  then links it as `↗ GitHub #42 · open · 📋 To do`, with the column of the project
  board it is on, if any.
- **✕ Delete** removes the entry.
- **▲ / ▼** move it one priority up or down.

**Commands:**

- `/issues` opens the pane (or prints the list, highest priority first, when no pane
  can be placed right now) and refreshes GitHub statuses.
- `/issues clear` empties the project's list.

## GitHub status

The status of each linked issue is read with
`gh issue view <url> --json state,projectItems`: at session start, right after the
issue is filed, on `/issues`, and every 5 minutes after that. Entries without a link
cost nothing. When `gh` does not answer, the last known status stays.

When the GitHub issue is **closed**, as completed or as not planned, the entry is
removed from the list and a toast says `✓ closed on GitHub, removed: #1`. This is
final: if the issue is reopened, the entry does not come back.

Requires the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`,
and for the project board column the `read:project` scope
(`gh auth refresh -s read:project`).

## Where the list is kept

In the plugin's own store, one list per repository, keyed by the root of its main
working tree. Every worktree of a repository sees the same list; a separate repository
nested inside it has its own. Outside a repository, the session's directory is the key.
Lists that versions before 0.4 kept per worktree are folded into the repository's list
on first start.

Open sessions of the same project pick up each other's changes every 30 seconds.

## Development

```sh
claude plugin validate .
claude plugin test .          # hooks/register.test.tsx
claude --plugin-dir .         # a session with this checkout loaded
```

| File | What is in it |
| --- | --- |
| `hooks/register.tsx` | The whole plugin: tools, `/issues`, the count, the pane, GitHub. |
| `hooks/register.test.tsx` | Tests on `claude-code/testing`, with `gh`, `git` and `claude --bg` stubbed. |
| `types/index.d.ts` | The `Issue`, `Priority`, `GithubStatus` and `Stored` types and the `$.state` contract. |

## License

[MIT](./LICENSE)
