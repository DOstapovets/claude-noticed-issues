# Noticed Issues — Refactoring Plan

## Goal

Make the plugin's persistence correct across sessions, then split `hooks/register.tsx`
(about 1000 lines) into a few modules, without changing what the user sees.

- Fix the concrete reliability bugs found in the current code first.
- Split the module along the seams it already has: store, GitHub, background
  sessions, layout, pane.
- Make the pure layout code unit-testable.
- Stay a lightweight modular monolith. No layers, no interfaces with one implementation.

**Status:** Phases 1 and 2 are on `main` (0.21.0). Still open: the live check of the
pane after the split, and a test for `gh` failing with invalid JSON or an
authentication error.

## Guiding principles

1. Every item names the code it changes. An item that names no code gets cut.
2. A bug gets a test that reproduces it, then the fix. Tests land with the change, not
   in a later phase.
3. Preserve behavior and stored data (AGENTS.md → State the plugin keeps). New fields
   are optional. A rename or removal gets a migration in `session.start`, as `migrate`
   does.
4. Follow AGENTS.md: simplicity first, surgical changes, nothing speculative.
5. Work only with what the engine offers (`claude-code.d.ts`). Do not plan around
   capabilities it lacks.

## What the engine does and does not give us

These facts decide several items below:

- `$.store` has only `get / set / delete / keys`, with no versions and no
  compare-and-set. It is one JSON file for the whole plugin, every repository's list
  included, and `set` rejects past 4 MiB in all.
- `$.state` has `ifVersion`, which `update()` uses, but it lasts only for the session.
  It cannot coordinate two sessions.
- `$.process.run` times out after 30 s by default and rejects. Every call site already
  `.catch`es that.
- The engine has no API that reports a `claude --bg` session's state. The plugin knows
  only that a session started. It learns that the session finished when the issue is
  resolved and leaves the list.
- A hooks module may import other files of the plugin with static `import`
  declarations. `import()` is not allowed.

---

# Phase 1 — Correctness fixes (P0)

Branch `fix/phase1-correctness`. Commit type `fix:`, which makes a patch release. Each
fix comes with a test in `hooks/register.test.tsx` that fails without it. A test plays
"another session" by writing the stored list directly between two actions.

### 1.1 Lost updates and reused ids

Only `note_issue`, `resolve_issue` and `/issues` read `$.store` before they write. Other
writers save the session's `issues` atom, which can be up to 30 s behind the store
(`RELOAD_MS`): `startSession`, `createGithubIssue`, `refreshGithub`, `shiftPriority`,
`remove` and `/issues clear`. `save` also stores the module's `nextId`, and that value
may be behind too.

Example: a background session notes #5. Within 30 s the user presses ▲ in the main
session. The store is rewritten without #5 and with `nextId` 5, so the next note is #5
again. A stale `resolve_issue 5` then removes the wrong issue.

- [x] Add one write path, `change($, fn)`: `load` from the store, apply `fn`, `save`.
  Every mutation above goes through it.
- [x] `nextId` never decreases.
- [x] Note in the code that, with no compare-and-set, a `get → set` window between
  sessions remains. It is accepted.

Sequential ids stay. `#id` is part of the UX (the card, the toasts, the background
session's prompt, `resolve_issue(id: number)`), and 1.1 fixes the bug without UUIDs.

### 1.2 GitHub status refresh can stall for the session

Suppose `gh issue view --json state,projectItems` returns JSON without `projectItems`.
`githubStatus` then throws, `refreshing` stays `true`, and no later refresh runs.

- [x] `githubStatus` checks the shape: `state` is `OPEN` or `CLOSED` and `projectItems`
  is an array. Otherwise that issue is skipped this round.
- [x] `refreshGithub` resets `refreshing` in `finally`.

### 1.3 A second ▶ press starts a second background session

`createGithubIssue` is guarded by `filing`. `startSession` has no guard.

- [x] Add `starting: Set<number>`, checked at the top of `startSession` and cleared in
  `finally`.

### 1.4 One huge note can break the store for every project

`note_issue` stores `title`, `detail` and `file` whole. Only the pane clips `detail`.

- [x] Cap the stored lengths with `clip`. The tool's answer says when it cut a field.
  Add a README line.

### 1.5 Small input hardening (low)

- [x] `resolve_issue` with an id that is not an integer gets a clear answer instead of
  `#NaN`.
- [x] `load` reads a stored value whose `items` is not an array as an empty list.

### Dropped from the original Phase 1

| Item | Why |
| --- | --- |
| Command timeouts | `$.process.run` already times out (30 s) and the rejection is caught |
| Unavailable GitHub CLI | Already reported in a toast |
| Duplicate GitHub issue | `filing` covers one session; 1.1 covers the case across sessions |
| Investigate CAS | Answered: `$.store` has none (above) |
| UUIDs | Rejected: see 1.1 |
| `idle/starting/running/completed/failed` lifecycle | No engine API to observe it; only the in-memory `starting` of 1.3 can be built |
| Schema version | The AGENTS.md convention (optional fields + `migrate`) already covers it |

---

# Phase 2 — Split `register.tsx` (P1)

Branch `chore/split-register`. Commit type `refactor:`, which makes no release. One
commit per module, and behavior does not change. The files stay in `hooks/`, because
`hooks.json`, `.claude/hooks/check-plugin.sh` and the AGENTS.md layout all point there.

| File | Holds |
| --- | --- |
| `hooks/register.tsx` | Wiring only: `session.start`, the tools, `/issues`, the ui hooks |
| `hooks/context.ts` | The per-session values (`cwd`, `storeKey`, `nextId`, `github`, the pane's last surface and width) in one object, replacing module `let`s |
| `hooks/store.ts` | `load`, `save`, `change`, `migrate`, `commonDir` |
| `hooks/layout.ts` | Pure functions: `PRIORITIES`, `rank`, `share`, `arrange`, `firstCard`, `wrappedRows`, `cardRows`, `age`, `clip`, `headRows` |
| `hooks/github.ts` | `onGithub`, `createGithubIssue`, `githubStatus`, `refreshGithub` |
| `hooks/sessions.ts` | `background`, `prompt`, `startSession`, and Feedback (`whereRun`, `feedbackPrompt`, `startFeedback`) |
| `hooks/pane.tsx` | The Pane render: card, corner, tabs, groups |

Order: `context`, `store` and `layout` come first, because everything else imports
them. `github`, `sessions` and `pane` can then be split in parallel.

- [x] Unit tests for `layout.ts` in `hooks/layout.test.ts`: `share`, `wrappedRows`,
  `cardRows`, `age`.
- [ ] After `pane.tsx`, check the pane live in the terminal and in VS Code
  (`claude --plugin-dir <worktree>`). The test kit does not draw.
- [x] Update the Layout section of AGENTS.md. README describes behavior, so it stays
  as is.

### Rejected from the original Phase 2

- **The `src/domain|application|infrastructure|ui|plugin` tree (about 30 files).** It
  is too much for 1000 lines. It also moves code out of `hooks/`, where the check hook
  and `hooks.json` look.
- **An `IssueTracker` interface.** It would have one implementation, and AGENTS.md
  says: "No abstraction for code used once".
- **A committed `types/claude-code.d.ts`.** The engine generates that file per build.
  It is not repository content.

---

# Phase 3 — Remaining test gaps (P1)

Only the tests that Phases 1–2 do not already add:

- [x] A narrow pane (`cardColumnsOf` floors at 20 columns).
- [x] 100+ issues through `arrange`.
- [ ] `gh` returns invalid JSON, or fails authentication (stderr reaches the toast).

---

# Deferred until measured

- One batched `gh` call instead of one per linked issue. Calls are already sequential,
  one per linked issue every 5 min, and a failed one is skipped.
- Render optimization or pagination. `arrange` is linear per draw; act only on a
  report.

# Out of scope

- Restarting ▶ for a background session that died (a `feat` of its own: the button
  never comes back today).
- GitLab, Linear and a provider-neutral tracker.
- A local issue status. A resolved issue is deleted, so there is no status to separate.
- Team sharing, AI triage, similarity dedup, stale-issue detection.

---

# Execution

| Phase | Branch | Commit type | Parallel? |
| --- | --- | --- | --- |
| 1 | `fix/phase1-correctness` | `fix:` | 1.1 / 1.2+1.3 / 1.4 touch separate functions |
| 2 | `chore/split-register` | `refactor:` | `context`+`store`+`layout` first, then `github` / `sessions` / `pane` / tests |
| 3 | with Phase 2 | `test:` | yes |

## Implementation rules

1. Do not rewrite the plugin from scratch.
2. Keep the tools' names and inputs, `/issues` and the stored shape.
3. Add no runtime dependencies, no database, no backend.
4. Run `claude plugin validate .`, `claude plugin test .` and `tsc` before every commit
   (AGENTS.md → Checks).
5. Branch, commit and PR conventions are in `docs/git_and_pr_conventions.md`. Never edit
   the version in `plugin.json`.
6. Architecture changes go into AGENTS.md (Layout). Behavior changes go into README.

## Definition of done

- [x] No mutation writes a list it did not just read from the store; `nextId` never
  decreases.
- [x] No in-flight flag (`refreshing`, `filing`, `starting`) can stay set after a
  failure.
- [x] A single note cannot grow the store without bound.
- [x] `register.tsx` is wiring only; the pure layout code is unit-tested.
- [ ] Existing and new tests pass; the pane was checked live on the terminal and in
  VS Code.
