# noticed-issues

## What this is

A Claude Code plugin. It adds two tools, `note_issue` and `resolve_issue`, through
which Claude records problems it noticed outside the current task. They go on a
per-repository list, which the user sees in a pane and in a `⚑` count above the
prompt. From the pane they can start a background session to fix an entry, file it
as a GitHub issue, change its priority or delete it. [README.md](./README.md)
describes what the user sees; this file is for working on the code.

## Stack

There is no build, no `package.json` and no dependencies. The plugin is one hooks
module, `hooks/register.tsx`, and the files it imports, which Claude Code loads as
they are:

- **Language:** TypeScript with JSX, compiled by the engine against its global `h`
- **API:** the `claude-code` plugin API: hooks registered with `on(event, matcher?, hook)`, and the
  engine reached through `$` (`$.store`, `$.state`, `$.ui`, `$.process`, `$.clock`, ...)
- **Tests:** `claude-code/testing`, run by `claude plugin test`
- **Environment:** the module runs with no DOM and no Node. `gh`, `git` and `claude --bg`
  are reached through `$.process.run`

### Splitting into modules

The engine reads the module before it runs it, and its scan follows an import only
so far. Three rules keep code in another file visible to it:

1. A `$.state` atom cannot be imported. Each module that reads or updates one
   declares it itself, with the same ref and initial value; `types/index.d.ts`
   declares its type once.
2. A function that takes `$` and is called from another file is a `function`
   declaration, not an arrow const, and the call passes it as `$`.
3. The matcher constants of `on()`, such as the pane's `requestId`, stay in the
   file that calls `on()`.

Break one and the module fails to load, or `claude plugin validate .` shows the
state or the matcher as `?`.

## Layout

```
.claude-plugin/plugin.json       Manifest: name, version, userConfig (`github`), types
.claude-plugin/marketplace.json  Lets the repository be added as a marketplace of its own
hooks/hooks.json                 Names the hooks module, hooks/register.tsx
hooks/register.tsx               Wiring: session.start, the tools, /issues, the ui hooks
hooks/context.ts                 What the modules share for the session (`session`), Api, MINUTE
hooks/store.ts                   The list and the folded groups in $.store: load, save, change, migrate
hooks/layout.ts                  Pure layout and card text: arrange, cardRows, age, clip, LIMITS
hooks/github.ts                  GitHub issues through gh: filing one, reading its status
hooks/sessions.ts                Background sessions through claude --bg: a fix, Feedback
hooks/pane.tsx                   The pane: groups, cards, tabs, scrolling
hooks/*.test.ts(x)               Tests; register.test.tsx stubs gh, git and claude --bg
types/index.d.ts                 Issue, Priority, Tab, GithubStatus, Stored and the $.state contract
docs/                            Conventions for contributors and agents
.claude/settings.json            Project hooks; their scripts are in .claude/hooks/
.github/workflows/               Checks, commit and PR-title lint, release-please
release-please-config.json       How release-please versions the plugin
```

## Checks

Run all three before every commit, from the repository root:

```sh
claude plugin validate .   # manifest and module, read the way the engine reads them
claude plugin test .       # hooks/*.test.ts(x)
```

Then type-check with `tsc`. The plugin API's declarations are not in the
repository. When the engine hot-reloads a plugin from a `--plugin-dir` folder or a
mods folder, it writes them to `.claude-plugin/types/` (git-ignored), and `tsc -p
<that folder>` works. It does not write them for a plugin loaded through a
marketplace. In that case load the `plugin-authoring` skill, which writes
`claude-code.d.ts` for the running Claude Code build and gives its path. Point a
`tsconfig.json` kept outside the repository at that file and at `hooks/` and
`types/`; the header of the file lists the compiler options.

Two hooks in `.claude/settings.json` enforce some of this for Claude Code sessions in
the repository. The scripts are in `.claude/hooks/`:

- `check-plugin.sh` runs `validate` and `test` after every edit under `hooks/` or
  `types/`, and sends a failure back to the agent.
- `guard-main-checkout.sh` blocks edits, `git switch` and `git checkout` in the
  repository's main working tree (switching back to `main` is allowed) and asks for a
  worktree instead (see below).

A passing suite does not show how the pane looks. The test kit does not draw
hover, colors or real wrapping, so check anything visual in a real session (below)
and say in the PR that you did.

## Trying a change live

- `claude --plugin-dir .` starts a session with this checkout loaded.
- When the repository is the folder a directory marketplace points at, every
  `/reload-plugins` reloads it from the working copy, whatever branch is checked out.
  Switching branches in that checkout changes the plugin every session loads, so do
  your work in a worktree (below) and leave that checkout on `main`.

## State the plugin keeps

- `$.store`, which lasts across sessions: one list per repository under
  `issues:<main worktree root>` (`issues:<cwd>` outside a repository), and the folded
  groups under `collapsed`.
- `$.state`, which lasts for the session and is mirrored for drawing: the list, the
  folded groups, the tab, the card that asks to confirm a delete, where each group is
  scrolled, and the minute a card's age is told from. Each value is declared in
  `types/index.d.ts`.

A stored issue outlives every version of the plugin. A new field must be optional,
and code must read an issue that lacks it (`priority` and `noticedIn` are examples).
Removing or renaming a field needs a migration in `session.start`, as `migrate` does
for lists kept per worktree before 0.4.

## Behavioral guidelines

### 1. Think before coding

- State assumptions explicitly. If uncertain, ask.
- If a request can be read more than one way, present the readings. Do not pick one silently.
- If a simpler approach exists, say so, and push back when warranted.

### 2. Simplicity first

- Write the minimum code that solves the problem, with nothing speculative and no
  features beyond what was asked.
- No abstraction for code used once, and no error handling for what cannot happen.

### 3. Surgical changes

- Touch only what the change needs and match the surrounding style: comment density,
  naming, the way JSX is laid out.
- Remove what **your** change made unused, and leave dead code you found as it is.

### 4. Goal-driven execution

- A bug gets a test that reproduces it, then the fix.
- A change in behavior gets a test in `hooks/register.test.tsx` and a line in the README.
- The plugin cannot measure what it draws. Layout that depends on heights
  (`cardRows`, `arrange`) is worked out from text, so a change to a card's content
  must keep `cardRows` in step with it.

## Git and PR workflow

Read [docs/git_and_pr_conventions.md](./docs/git_and_pr_conventions.md) **before
opening a branch or writing a commit.** In short:

- One branch per theme, named `feat/`, `fix/`, `docs/` or `chore/` plus a slug. Work
  in a worktree under `.claude/worktrees/`, never in the checkout Claude Code loads
  the plugin from.
- Commit subjects follow Conventional Commits; CI lints them. Never edit the version
  in `.claude-plugin/plugin.json`: release-please raises it from the commit types
  (`feat` → minor, `fix` → patch) in a release PR, and merging that PR is the release.
- Your branches reach `main` by fast-forward. Never force-push it.
