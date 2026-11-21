import { atom, read, update } from 'claude-code'

import type { Issue, Priority, Project, Stored } from '../types'
import { session } from './context'
import type { Api } from './context'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads or writes it, so each module names the atoms it uses; types/index.d.ts
// declares them once.
const issues = atom({ plugin: 'noticely', key: 'issues' } as const, [])
// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'noticely', key: 'collapsed' } as const, [])
export const COLLAPSED_KEY = 'collapsed'
// The settings, the same in every project.
export const SETTINGS_KEY = 'settings'
// Every other project's list, for the pane's Projects tab.
const projects = atom({ plugin: 'noticely', key: 'projects' } as const, [])

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

// Called only after `load`, which took the stored `nextId` up into this one: it never goes back.
async function save($: Api, list: Issue[]) {
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
  // Every write redraws the pane and the count: a reload that finds the list as it was writes nothing.
  if (JSON.stringify(await read($, issues)) !== JSON.stringify(list)) await update($, issues, () => list)

  return list
}

// This session's changes, one at a time: parallel tool calls, a press in the pane
// and a GitHub pass would otherwise each read the list before the other saved it.
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(run: () => Promise<T>) {
  const ran = queue.then(run)
  queue = ran.catch(() => undefined)
  return ran
}

// Every change starts from the stored list, not the session's copy, which may be
// up to RELOAD_MS behind another session's. `$.store` has no compare-and-set
// (only get, set, delete and keys; each one alone is atomic across sessions), so
// two sessions writing in the same moment can still lose one change; that window
// is accepted.
export async function change($: Api, fn: (list: Issue[]) => Issue[]) {
  return serial(async () => save($, fn(await load($))))
}

// A new issue at the next number, noted by this session, unless one with the
// same title, ignoring case, is on the list already: that one is returned.
export async function addIssue($: Api, fields: Pick<Issue, 'title' | 'detail' | 'file' | 'priority'>) {
  const createdAt = await $.clock.now()
  const noticedIn = await $.session.id()
  const added = await serial(async () => {
    const list = await load($)
    const same = list.find(i => i.title.toLowerCase() === fields.title.toLowerCase())

    if (same) {
      return { issue: same, isNew: false }
    }

    const { title, ...rest } = fields
    const issue: Issue = { id: session.nextId, title, createdAt, noticedIn, ...rest }
    session.nextId += 1
    await save($, [...list, issue])

    return { issue, isNew: true }
  })

  if (added.isNew) {
    await $.ui.toast(`⚑ noted #${added.issue.id}: ${added.issue.title}`)
  }

  return added
}

// Words of three letters or more, and numbers: `Leak 1` and `Leak 2` stay apart.
const words = (title: string) => new Set(title.toLowerCase().match(/\p{L}{3,}|\p{N}+/gu) ?? [])
const place = (file?: string) => file?.replace(/:\d+(:\d+)?$/, '')

// Up to three issues on the list that may be the same problem: seen in the same
// file, whatever the line, or with half the words of the title or more in common.
// shortcut: word overlap misses synonyms; look at embeddings only if misses show up.
export function similar(list: Issue[], title: string, file?: string) {
  const mine = words(title)
  const overlap = (issue: Issue) => {
    const theirs = words(issue.title)
    const shared = [...mine].filter(w => theirs.has(w)).length
    return shared / (mine.size + theirs.size - shared || 1)
  }

  return list
    .map(issue => ({ issue, score: overlap(issue) }))
    .filter(({ issue, score }) => score >= 0.5 || (place(file) !== undefined && place(file) === place(issue.file)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ issue }) => issue)
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
  if (JSON.stringify(await read($, projects)) !== JSON.stringify(found)) await update($, projects, () => found)

  return found
}

// A list written before 0.4 is read as found: what is not an issue with a title and a number is left out.
function issuesOf(stored: Stored | undefined) {
  const items: unknown[] = Array.isArray(stored?.items) ? stored.items : []
  return items.filter((i): i is Issue => typeof (i as Issue)?.title === 'string' && Number.isInteger((i as Issue).id))
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
  const items = issuesOf(stored)
  // Past every number on the list too, so a folded issue never takes one already in use.
  let next = Math.max(typeof stored?.nextId === 'number' ? stored.nextId : 1, ...items.map(i => i.id + 1))
  const folded: string[] = []

  for (const key of nested) {
    // null: the directory is gone (a removed worktree), so its list has no other home.
    const git = await commonDir($, key.slice('issues:'.length))

    if (git === undefined || (git !== null && git !== repoGit)) {
      continue
    }

    for (const issue of issuesOf((await $.store.get(key)) as Stored | undefined)) {
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

  const remote = stored?.remote ?? session.remote
  const merged: Stored = { nextId: next, items, ...(remote ? { remote } : {}), updatedAt: await $.clock.now() }
  await $.store.set(session.storeKey, merged)
  for (const key of folded) {
    await $.store.delete(key)
  }
}

// Up to 0.24 the plugin was called noticed-issues, and briefly after that notifly,
// and the engine keeps a plugin's `$.store` in a file named after it, so every list
// stayed in those files. Copy their keys over once, notifly's first as the newer,
// leaving any this store already has; the old files stay as they are.
export const ADOPTED_KEY = 'adoptedFrom'
const OLD_STORE = /^(notifly|noticed-issues)_.*\.json$/

export async function adoptOldStore($: Api) {
  if ((await $.store.get(ADOPTED_KEY)) !== undefined) {
    return
  }

  const ran = await $.process.run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"']).catch(() => undefined)
  if (ran?.exitCode !== 0 || ran.stdout === '') {
    return
  }

  const dir = `${ran.stdout}/plugins/store`
  const files = (await $.fs.list(dir).catch(() => []))
    .filter(f => f.kind === 'file' && OLD_STORE.test(f.name))
    .sort((a, b) => Number(b.name.startsWith('notifly_')) - Number(a.name.startsWith('notifly_')))
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
