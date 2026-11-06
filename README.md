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

**A count above the prompt**, `⚑ 3 issues`, that opens the pane when pressed. Once the
current session has noted something it says how many, `⚑ 3 issues · 1 this session`. It is
hidden while the list is empty, and any band another plugin draws there stays below it.

**The "Noticed issues" pane** opens by itself when the list has something on it, and
with `/issues`. Entries are grouped under **▾ High**, **▾ Medium** and **▾ Low**. Press
a group's heading to fold it (`▸ High 2`) or open it again; a folded group keeps its
place, so High stays on top. As in an accordion, the open groups share the pane's whole
height evenly, even with one or two entries each. The pane itself never scrolls, so the
group headings stay on screen: the wheel scrolls the cards of the group under the pointer,
one card at a time, and the scroll keys the first open group. A scrolled group says how
many cards are above, `▾ High 5 ↑ 2 above`. Which groups are folded is remembered across
sessions and projects. Once the current session has noted something, two tabs sit at
the top of the pane, **This session 2** and **All 5**: the first shows only the entries
this session noted. The tab goes away again when none of them are left, and the pane
then shows every entry. Each entry is a card with its number and title in bold, then, dimmed, the
file on one line (shortened in the middle when it does not fit) and the detail cut to
three lines. These are its controls:

- **▶ New session** starts `claude --bg` with a prompt to fix the issue that ends by
  asking it to call `resolve_issue`. The card then shows the session id, which
  `claude attach <id>` connects to.
- **↗ GitHub issue** files it with `gh issue create` in the repository of the session's
  directory: the title becomes the issue title, `detail` and `file` its body. The card's
  heading then links it next to the number, on a line of its own above the title:
  `#3  ↗ #42 · open · 📋 To do`, with the column of the project board it is on, if any.
  Shown only where GitHub is on: see [Settings](#settings).
- **✕**, red, in the card's top right corner, deletes the entry. The first press only
  asks, `Delete? ✓ ↩`: **✓** deletes it, **↩** leaves it be.
- **▲ / ▼**, at the card's right edge, move it one priority up or down; each is drawn
  in the color of the group it moves the issue to.

**Commands:**

- `/issues` opens the pane (or prints the list, highest priority first, when no pane
  can be placed right now) and refreshes GitHub statuses.
- `/issues clear` empties the project's list.
- `/issues feedback` does what the pane's **✎ Feedback** button does, below.

**✎ Feedback**, in the pane's heading, is for reporting something about this plugin
itself. It starts a background session (`claude attach <id>` joins it, as the toast
says) that asks you what it is, a bug, a feature request, or a question or idea, and
what that needs. It collects the Claude Code and plugin versions by itself, looks for
an existing issue or discussion on the same thing, and shows you a draft. Only once
you confirm does it post: a bug or feature request as an issue in this repository, a
question or idea as a discussion, and it gives you the link.

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

## Settings

One option, `github`, asked for at install and listed in the plugin's config menu
(stored under `pluginConfigs` in settings):

| Value | GitHub button and statuses |
| --- | --- |
| `auto` (default) | Only where the repository's `origin` remote is on `github.com`, over ssh or https. Not in a repository with no remote, on GitLab, Bitbucket and the like, or outside a repository. |
| `on` | Always. Use it for GitHub Enterprise on a domain of its own. |
| `off` | Never. |

Where GitHub is off, no `gh` call is made. Links to issues filed earlier stay on
their cards.

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

## Feedback

Found a bug or want something changed? Press **✎ Feedback** in the pane, or
[open an issue](https://github.com/DOstapovets/claude-noticed-issues/issues/new/choose)
with the **Bug report** or **Feature request** form. Questions go to
[Discussions](https://github.com/DOstapovets/claude-noticed-issues/discussions), security
problems to the private report described in [SECURITY.md](./SECURITY.md). Pull requests:
see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
