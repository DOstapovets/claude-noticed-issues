import { atom, read } from 'claude-code'

import type { GithubStatus, Issue } from '../types'
import { session } from './context'
import type { Api } from './context'
import { change } from './store'

// Named here as well as in register.tsx: the engine's scan reads a `$.state`
// value only from a const of the file that reads it.
const issues = atom({ plugin: 'noticed-issues', key: 'issues' } as const, [])

const GITHUB_ISSUE = /https:\/\/\S+\/issues\/\d+/

// `auto` asks the `origin` remote: ssh (`git@github.com:o/r.git`, `ssh://…`) or https.
export const onGithub = (remote: string | null | undefined) => {
  const host = remote?.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)/i)?.[1]

  return host !== undefined && /(^|\.)github\.com$/i.test(host)
}

// Ids whose `gh issue create` is still running, so a second press does not file it twice.
const filing = new Set<number>()

const githubBody = (issue: Issue) =>
  [issue.detail, issue.file && `Where: \`${issue.file}\``, '_Noticed by Claude Code._']
    .filter(Boolean)
    .join('\n\n')

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

export async function createGithubIssue($: Api, id: number) {
  const issue = (await read($, issues)).find(i => i.id === id)

  if (!session.github || !issue || issue.githubUrl || filing.has(id)) {
    return
  }

  filing.add(id)
  // gh files it in the repository of the session's directory and prints its URL.
  const ran = await $.process
    .run(['gh', 'issue', 'create', '--title', issue.title, '--body', githubBody(issue)], { cwd: session.cwd })
    .catch(() => undefined)
  filing.delete(id)
  const githubUrl = ran?.exitCode === 0 ? ran.stdout.match(GITHUB_ISSUE)?.[0] : undefined

  if (!githubUrl) {
    await $.ui.toast(`Could not create a GitHub issue for #${id}: ${ran?.stderr.trim() || 'gh issue create failed'}`)
    return
  }

  await change($, list => list.map(i => (i.id === id ? { ...i, githubUrl } : i)))
  await $.ui.toast(`↗ #${id} → ${githubUrl}`)
  void refreshGithub($)
}

// One pass at a time: the timer, `/issues` and a new issue may all ask for one.
let refreshing = false

type Viewed = {
  state: GithubStatus['state']
  projectItems: { status: { name: string } | null }[]
}

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

async function githubStatus($: Api, url: string): Promise<GithubStatus | undefined> {
  const ran = await $.process
    .run(['gh', 'issue', 'view', url, '--json', 'state,projectItems'], { cwd: session.cwd })
    .catch(() => undefined)

  const viewed = ran?.exitCode === 0 ? (parse(ran.stdout) as Partial<Viewed> | null | undefined) : undefined

  // An answer of another shape skips the issue this pass.
  if ((viewed?.state !== 'OPEN' && viewed?.state !== 'CLOSED') || !Array.isArray(viewed.projectItems)) {
    return undefined
  }

  const status: GithubStatus = { state: viewed.state }
  const board = viewed.projectItems.find(item => item?.status)?.status?.name
  if (board) status.board = board

  return status
}

export async function refreshGithub($: Api) {
  const linked = (await read($, issues)).filter(i => i.githubUrl)

  if (!session.github || refreshing || linked.length === 0) {
    return
  }

  refreshing = true
  const statuses = new Map<number, GithubStatus>()
  try {
    for (const issue of linked) {
      const status = await githubStatus($, issue.githubUrl!)
      if (status) statuses.set(issue.id, status)
    }
  } finally {
    // Whatever went wrong, the next pass still runs.
    refreshing = false
  }

  if (statuses.size === 0) {
    return
  }

  // Closed on GitHub, as completed or as not planned: nothing is left to notice.
  const closed = new Set([...statuses].filter(([, status]) => status.state === 'CLOSED').map(([id]) => id))
  await change($, list =>
    list.filter(i => !closed.has(i.id)).map(i => (statuses.has(i.id) ? { ...i, github: statuses.get(i.id) } : i)),
  )
  if (closed.size > 0) {
    await $.ui.toast(`✓ closed on GitHub, removed: ${[...closed].map(id => `#${id}`).join(', ')}`)
  }
}
