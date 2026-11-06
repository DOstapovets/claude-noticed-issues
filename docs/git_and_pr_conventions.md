# Git, commit and PR conventions

How work on this plugin is branched, committed, versioned and proposed. Written
for people and for coding agents.

Four GitHub workflows back this up:

| Workflow | Runs on | Does |
| --- | --- | --- |
| `checks.yml` | every PR, every push to `main` | `claude plugin validate .` and `claude plugin test .` on the latest Claude Code |
| `commitlint.yml` | every PR, every push to `main` | lints each commit message (`commitlint.config.mjs`) |
| `pr-title.yml` | PRs | requires the title to be a Conventional Commits subject |
| `release-please.yml` | every push to `main` | opens or updates the release PR (see Versions) |

None of them sees the pane, and the test kit does not draw it, so what a PR says
about how a change looks is still only as good as what its author checked.

## Branches

| Prefix | Use for |
| --- | --- |
| `feat/<slug>` | Something the user can now do or see |
| `fix/<slug>` | Behavior that was wrong |
| `docs/<slug>` | README, AGENTS.md, `docs/`, issue and PR templates |
| `chore/<slug>` | Tooling, repository settings, anything that does not ship |

Put the issue number in front of the slug when there is one: `fix/12-scroll-past-last-card`.
A slug is lower-case letters, digits and dashes. Nothing reads the prefix; it tells a
reader what to expect before opening the branch.

### Work in a worktree, not in the checkout Claude Code loads

Claude Code can load the plugin straight from a checkout of this repository: a
directory marketplace or `--plugin-dir` pointing at it. In that case
`/reload-plugins` loads whatever the working copy holds. Switching branches there
switches the plugin in every session on the machine, and two agents in one checkout
overwrite each other's files.

So leave that checkout on `main` and work in a worktree of your own:

```sh
git fetch origin
git worktree add -b feat/<slug> .claude/worktrees/<slug> origin/main
```

In Claude Code sessions in this repository, `.claude/hooks/guard-main-checkout.sh`
enforces this: it blocks edits and branch switches in the main working tree.
`.claude/worktrees/` is git-ignored. Try the branch with
`claude --plugin-dir .claude/worktrees/<slug>`. After the merge, remove the worktree
with `git worktree remove .claude/worktrees/<slug>`.

### One branch per theme, not per change

A body of work is one branch and one PR, even when it holds several independent
changes. In 0.17, for example, a new color for Low, the red ✕ with its
confirmation and the filled tabs reached `main` together, as one commit each.

Put the granularity in commits, where a reviewer can step through it, rather than
in PRs that each need a description and a place in the merge order. That only
works when every commit stands on its own and its message says what changed and why.

Split only when the parts ship at different times, or one is urgent and the other is not.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), linted by
`commitlint.yml` against `@commitlint/config-conventional` with `subject-case` off (a
subject may start with `AGENTS.md`). The lint runs in CI, after the push: nothing
stops a bad message locally, so check it before you push.
release-please reads the version from these messages, so a wrong type ships the wrong
release:

```
<type>(#<issue>): <what changed, imperative, no trailing period>

<body: what changed and why, not how>

<footer: BREAKING CHANGE: … when it applies>
```

- **Types:** `feat`, `fix`, `perf`, `revert`, `docs`, `chore`, `refactor`, `test`,
  `style`, `build`, `ci`.
- **Scope** is optional. Use `(#N)` when there is an issue.
- **Subject:** say what changed for the user where you can. `fix: an open group takes
  only the rows its cards need` is better than `fix: arrange()`.
- **Agents** end the message with their `Co-Authored-By:` trailer.

Run `claude plugin validate .` and `claude plugin test .` before each commit, not
only before the PR.

## Versions

The version in `.claude-plugin/plugin.json` is the plugin's release number.
`claude plugin list` shows it, and installs are recorded under it. **Do not edit it by
hand.** [release-please](https://github.com/googleapis/release-please) maintains it:

- On every push to `main`, `release-please.yml` opens or updates one release PR,
  titled `chore(main): release X.Y.Z`. That PR raises the version in `plugin.json` and
  `.release-please-manifest.json` and adds the release's entry to `CHANGELOG.md`.
- The version comes from the commits since the last release:

  | Commits since the last release | Bump |
  | --- | --- |
  | at least one `feat` | minor, `0.20.0` → `0.21.0` |
  | `fix`, `perf` or `revert` only | patch, `0.20.0` → `0.20.1` |
  | `docs`, `chore`, `refactor`, `test`, `style`, `build`, `ci` only | none: no release PR |
  | a `BREAKING CHANGE:` footer or a `!` after the type | minor while the version is `0.x` (`bump-minor-pre-major`) |

- Merging the release PR is the release: it tags `vX.Y.Z` and publishes a GitHub
  Release with the changelog. Merge it when you want the version out. Further merges
  to `main` before that only update it.
- The configuration is in `release-please-config.json`. `bootstrap-sha` keeps the
  first release PR from walking the history from before 0.20.0.

**What counts as breaking:** a stored issue that the new code cannot read, a renamed
or removed tool (`note_issue`, `resolve_issue`) or tool parameter, a removed
`userConfig` option, or a changed `/issues` argument.

The release PR is opened with the workflow's own token, and GitHub starts no workflow
for an event made with that token. So `checks.yml` does not run on the release PR;
its commits were already checked on `main`.

## Merging

- Your branches go into `main` by fast-forward. Rebase on `origin/main`, then
  `git merge --ff-only` and push. Never force-push `main`.
- The release PR is merged on GitHub, like any PR.
- The maintainer merges. An agent merges only when told to in the conversation, and
  that permission holds for that merge only.
- After the merge, delete the branch on GitHub and locally.
- If a contributor's PR is squash-merged, its title becomes the commit subject on
  `main`. `pr-title.yml` checks that it is a valid one.

## Issues and pull requests are different documents

> **An issue makes claims about the world. A pull request makes claims about your change.**

|  | Issue | Pull request |
| --- | --- | --- |
| Answers | Why is this worth someone's time? | Why is this safe to merge? |
| Owns | Symptoms, evidence, the outcome wanted, scope | Approach, trade-offs, verification, risk |
| True after merge | Yes | No: it describes one change |

- **The PR does not restate the issue:** `Closes #N`, one line of framing, then the change.
- **The issue describes an outcome, not an implementation.** "The pane's group
  headings stay on screen while the cards scroll", not "add a `ui.scroll` hook".
- **Acceptance criteria live in the issue, evidence in the PR.**

### Issues

The issue forms are in `.github/ISSUE_TEMPLATE/`: **Bug report** and **Feature
request**. Questions and ideas to talk through go to Discussions. The pane's
**✎ Feedback** button and `/issues feedback` start a session that interviews the
user and files one of these. Delete a heading rather than writing "N/A" under it.

## Pull requests

- **Open as a draft**, and run every check before `gh pr ready`.
- **The title is a commit subject:** same format, same type.
- **`.github/pull_request_template.md` prefills the body:** what changed, how it was
  verified, risk. Delete a heading that has nothing real under it.
- **Say what was verified, and how.** Name the commands you ran and their results.
  For anything visual (the pane, the count, colors, hover, wrapping), say whether you
  looked at it in a real session and on which surface (terminal, VS Code, desktop). The
  test kit draws none of these, so a passing suite says nothing about how it looks. A
  screenshot is the best evidence.
- **A claim in a PR is a commitment.** A reviewer reads the description instead of
  re-deriving it from the diff. If you did not run it, do not claim it; say plainly
  what you did not check.

### Checklist before `gh pr ready`

- `claude plugin validate .` passes
- `claude plugin test .` passes, with a new or updated test for what changed
- The `checks` and `commitlint` workflows are green
- `tsc` passes against the API declarations (see AGENTS.md, "Checks")
- The README describes the new behavior
- A new `$.state` or `$.store` value is declared in `types/index.d.ts`, and a new
  field on a stored issue is optional
- A card whose content changed still matches `cardRows`, which the pane's layout
  relies on

### Smells

- A PR body that repeats its issue, or lists the changed files.
- "Looks right" about a layout change that nobody opened in a session.
- A hand-edited version in `plugin.json`.
- A change that ships under `chore` or `docs`, which release-please does not release.
