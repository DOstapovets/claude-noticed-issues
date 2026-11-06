import { atom, update } from 'claude-code'

import type { Issue, Priority, Stored } from '../types'
import { session } from './context'
import type { Api } from './context'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads or writes it, so each module names the atoms it uses; types/index.d.ts
// declares them once.
const issues = atom({ plugin: 'noticed-issues', key: 'issues' } as const, [])
// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'noticed-issues', key: 'collapsed' } as const, [])
export const COLLAPSED_KEY = 'collapsed'

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

// Called only after `load`, which took the stored `nextId` up into this one: it never goes back.
export async function save($: Api, list: Issue[]) {
  await update($, issues, () => list)
  const stored: Stored = { nextId: session.nextId, items: list }
  await $.store.set(session.storeKey, stored)
}

export async function load($: Api) {
  const stored = (await $.store.get(session.storeKey)) as Stored | undefined
  session.nextId = Math.max(session.nextId, stored?.nextId ?? 1)
  const list = Array.isArray(stored?.items) ? stored.items : []
  await update($, issues, () => list)

  return list
}

// Every change starts from the stored list, not the session's copy, which may be
// up to RELOAD_MS behind another session's. `$.store` has no compare-and-set
// (only get, set, delete and keys), so two sessions writing in the same moment
// can still lose one change; that window is accepted.
export async function change($: Api, fn: (list: Issue[]) => Issue[]) {
  return save($, fn(await load($)))
}

async function commonDir($: Api, dir: string) {
  const ran = await $.process
    .run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    .catch(() => undefined)

  return ran === undefined ? undefined : ran.exitCode === 0 ? ran.stdout.trim() : null
}

// Up to 0.4 the list was kept per working directory, so each worktree of a
// repository, and each subdirectory a session started in, had one of its own.
// Fold those into the repository's list, renumbered after it; a title already
// on it is dropped. A repository of its own nested inside keeps its list.
export async function migrate($: Api, root: string) {
  const nested = (await $.store.keys()).filter(key => key.startsWith(`${session.storeKey}/`))
  const repoGit = nested.length > 0 ? await commonDir($, root) : undefined

  if (!repoGit) {
    return
  }

  const stored = (await $.store.get(session.storeKey)) as Stored | undefined
  const items = [...(stored?.items ?? [])]
  let next = stored?.nextId ?? 1
  const folded: string[] = []

  for (const key of nested) {
    // null: the directory is gone (a removed worktree), so its list has no other home.
    const git = await commonDir($, key.slice('issues:'.length))

    if (git === undefined || (git !== null && git !== repoGit)) {
      continue
    }

    for (const issue of ((await $.store.get(key)) as Stored | undefined)?.items ?? []) {
      if (!items.some(i => i.title.toLowerCase() === issue.title.toLowerCase())) {
        items.push({ ...issue, id: next })
        next += 1
      }
    }
    folded.push(key)
  }

  if (folded.length === 0) {
    return
  }

  const merged: Stored = { nextId: next, items }
  await $.store.set(session.storeKey, merged)
  for (const key of folded) {
    await $.store.delete(key)
  }
}

export async function toggleGroup($: Api, priority: Priority) {
  const next = await update($, collapsed, list =>
    list.includes(priority) ? list.filter(p => p !== priority) : [...list, priority],
  )
  await $.store.set(COLLAPSED_KEY, next)
}
