import { atom, update } from 'claude-code'

import type { Issue, Priority, Project, Stored } from '../types'
import { session } from './context'
import type { Api } from './context'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads or writes it, so each module names the atoms it uses; types/index.d.ts
// declares them once.
const issues = atom({ plugin: 'notifly', key: 'issues' } as const, [])
// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'notifly', key: 'collapsed' } as const, [])
export const COLLAPSED_KEY = 'collapsed'
// The settings, the same in every project.
export const SETTINGS_KEY = 'settings'
// Every other project's list, for the pane's Projects tab.
const projects = atom({ plugin: 'notifly', key: 'projects' } as const, [])

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

// Called only after `load`, which took the stored `nextId` up into this one: it never goes back.
export async function save($: Api, list: Issue[]) {
  await update($, issues, () => list)
  const stored: Stored = {
    nextId: session.nextId,
    items: list,
    ...(session.remote ? { remote: session.remote } : {}),
    updatedAt: await $.clock.now(),
  }
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

// A new issue at the next number, noted by this session, unless one with the
// same title, ignoring case, is on the list already: that one is returned.
export async function addIssue($: Api, fields: Pick<Issue, 'title' | 'detail' | 'file' | 'priority'>) {
  const list = await load($)
  const same = list.find(i => i.title.toLowerCase() === fields.title.toLowerCase())

  if (same) {
    return { issue: same, isNew: false }
  }

  const { title, ...rest } = fields
  const issue: Issue = { id: session.nextId, title, createdAt: await $.clock.now(), noticedIn: await $.session.id(), ...rest }
  session.nextId += 1
  await save($, [...list, issue])
  await $.ui.toast(`⚑ noted #${issue.id}: ${title}`)

  return { issue, isNew: true }
}

// Each list in the store but this project's: those with issues first, then the
// most recently changed. A list kept per worktree before 0.4 shows as one of its
// own until a session in its repository folds it in.
export async function loadProjects($: Api) {
  const found: Project[] = []

  for (const key of await $.store.keys()) {
    if (!key.startsWith('issues:') || key === session.storeKey) continue
    const stored = (await $.store.get(key)) as Stored | undefined
    found.push({
      root: key.slice('issues:'.length),
      ...(typeof stored?.remote === 'string' ? { remote: stored.remote } : {}),
      ...(typeof stored?.updatedAt === 'number' ? { updatedAt: stored.updatedAt } : {}),
      items: Array.isArray(stored?.items) ? stored.items : [],
    })
  }
  found.sort(
    (a, b) =>
      Number(b.items.length > 0) - Number(a.items.length > 0) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      a.root.localeCompare(b.root),
  )
  await update($, projects, () => found)

  return found
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

// Up to 0.24 the plugin was called noticed-issues, and the engine keeps a plugin's
// `$.store` in a file named after it, so every list stayed in that file. Copy its
// keys over once, leaving any this store already has; the old file stays as it is.
export const ADOPTED_KEY = 'adoptedFrom'
const OLD_STORE = /^noticed-issues_.*\.json$/

export async function adoptOldStore($: Api) {
  if ((await $.store.get(ADOPTED_KEY)) !== undefined) {
    return
  }

  const ran = await $.process.run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"']).catch(() => undefined)
  if (ran?.exitCode !== 0 || ran.stdout === '') {
    return
  }

  const dir = `${ran.stdout}/plugins/store`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && OLD_STORE.test(f.name))
  const have = new Set(await $.store.keys())

  for (const file of files) {
    const old = await $.fs
      .read(`${dir}/${file.name}`)
      .then(text => JSON.parse(text) as Record<string, unknown>)
      .catch(() => ({}))
    for (const [key, value] of Object.entries(old)) {
      if (!have.has(key)) {
        await $.store.set(key, value)
        have.add(key)
      }
    }
  }
  await $.store.set(ADOPTED_KEY, files.map(f => f.name))
}

export async function toggleGroup($: Api, priority: Priority) {
  const next = await update($, collapsed, list =>
    list.includes(priority) ? list.filter(p => p !== priority) : [...list, priority],
  )
  await $.store.set(COLLAPSED_KEY, next)
}
