import { atom, read } from 'claude-code'

import type { GithubChecked, GithubStatus, Issue, Pull } from '../types'
import { session } from './context'
import type { Api } from './context'
import { change } from './store'

// Named here as well as in register.tsx: the engine's scan reads a `$.state`
// value only from a const of the file that reads it.
const issues = atom({ plugin: 'noticely', key: 'issues' } as const, [])

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
  void refreshGithub($, true)
}

// How often a repository's list is read on GitHub, by whichever of its sessions comes first.
export const GITHUB_MS = 5 * 60_000
// A pass due within this much is made now: the sessions' timers do not tick together.
const SLACK = 30_000
// Issues asked about in one query: each query costs one point of the 5000 an hour.
const BATCH = 25
// Below this many points left, passes wait for the hour to reset, so the rest of gh keeps some.
const RESERVE = 200
// How long passes wait after GitHub refused one as over its rate limit.
const RATE_PAUSE_MS = 3 * GITHUB_MS

// The line a fix session ends its pull request's description with, so a pass finds it.
export const pullMarker = (issue: Issue) => `Noticely issue #${issue.id} (noticed ${issue.createdAt})`
const MARKER = /Noticely issue #(\d+) \(noticed (-?\d+)\)/g

// One pass at a time: the timer, `/noticely` and a new issue may all ask for one.
let refreshing = false

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

// `https://<host>/<owner>/<name>/issues/<n>`, as `gh issue create` prints it.
const ISSUE_URL = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)/
// The remote's host and `owner/name`: ssh (`git@host:o/r.git`, `ssh://git@host:443/o/r.git`) or https.
const REMOTE = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i
// gh's API host: github.com's ssh hosts (`ssh.github.com`) are github.com.
const apiHost = (host: string) => (/(^|\.)github\.com$/i.test(host) ? 'github.com' : host)

const ISSUE_FIELDS =
  'state ' +
  'projectItems(first: 10) { nodes { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } ' +
  'closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number url state isDraft } }'
const PULL_FIELDS = 'number url state isDraft'

type Answered = {
  state?: unknown
  projectItems?: { nodes?: ({ fieldValueByName?: { name?: string } | null } | null)[] }
  closedByPullRequestsReferences?: { nodes?: unknown[] }
}

const pullOf = (node: unknown): Pull | undefined => {
  const { number, url, state, isDraft } = (node ?? {}) as Record<string, unknown>
  if (typeof number !== 'number' || typeof url !== 'string' || (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')) {
    return undefined
  }
  return { number, url, state, ...(isDraft === true ? { isDraft: true } : {}) }
}

// An open one first, then a merged one, then the newest.
const better = (a: Pull | undefined, b: Pull) => {
  const order = { OPEN: 0, MERGED: 1, CLOSED: 2 }
  return !a || order[b.state] < order[a.state] || (order[b.state] === order[a.state] && b.number > a.number) ? b : a
}

// What one pass learnt: each issue's status and pull request, and until when GitHub is not to be asked.
type Found = { statuses: Map<number, GithubStatus>; pulls: Map<number, Pull>; pausedUntil?: number }

// The queries of one pass: each host's linked issues, BATCH a query, and with the
// first of the repository's own host the search for pull requests its sessions marked.
const queries = (linked: Issue[], working: Issue[]) => {
  const byHost = new Map<string, string[]>()
  for (const issue of linked) {
    const [, host, owner, name, number] = issue.githubUrl!.match(ISSUE_URL) ?? []
    if (!host) continue
    const parts = byHost.get(apiHost(host)) ?? []
    parts.push(`i${issue.id}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issue(number: ${number}) { ${ISSUE_FIELDS} } }`)
    byHost.set(apiHost(host), parts)
  }

  const [, host, repo] = session.remote?.match(REMOTE) ?? []
  const search =
    host && repo && working.length > 0
      ? `marked: search(query: ${JSON.stringify(`repo:${repo} is:pr in:body "Noticely issue" sort:updated-desc`)}, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${PULL_FIELDS} body } } }`
      : undefined
  if (search && !byHost.has(apiHost(host!))) byHost.set(apiHost(host!), [])

  return [...byHost].flatMap(([on, parts]) => {
    const batches = Array.from({ length: Math.max(1, Math.ceil(parts.length / BATCH)) }, (_, i) => parts.slice(i * BATCH, (i + 1) * BATCH))
    return batches.map((batch, i) => ({
      host: on,
      query: `query { rateLimit { remaining resetAt } ${batch.join(' ')}${i === 0 && search && on === apiHost(host!) ? ` ${search}` : ''} }`,
    }))
  })
}

// Asks GitHub one query at a time, and stops once the rate limit runs low.
async function ask($: Api, linked: Issue[], working: Issue[]): Promise<Found> {
  const found: Found = { statuses: new Map(), pulls: new Map() }
  const offer = (id: number, pull: Pull | undefined) => {
    if (pull) found.pulls.set(id, better(found.pulls.get(id), pull))
  }

  for (const { host, query } of queries(linked, working)) {
    const ran = await $.process
      .run(['gh', 'api', 'graphql', '--hostname', host, '-f', `query=${query}`], { cwd: session.cwd })
      .catch(() => undefined)

    if (!ran) {
      // gh could not start, or timed out: the next pass tries again.
      break
    }
    if (/rate limit/i.test(`${ran.stderr} ${ran.exitCode === 0 ? '' : ran.stdout}`)) {
      found.pausedUntil = (await $.clock.now()) + RATE_PAUSE_MS
      break
    }

    // gh exits 1 when any part of the query failed, an issue deleted say, and still prints what the rest found.
    const data = (parse(ran.stdout) as { data?: Record<string, unknown> } | undefined)?.data ?? {}
    for (const issue of linked) {
      const answered = (data[`i${issue.id}`] as { issue?: Answered | null } | undefined)?.issue
      const nodes = answered?.projectItems?.nodes
      // An answer of another shape skips the issue this pass.
      if ((answered?.state !== 'OPEN' && answered?.state !== 'CLOSED') || !Array.isArray(nodes)) continue

      const status: GithubStatus = { state: answered.state }
      const board = nodes.find(node => node?.fieldValueByName?.name)?.fieldValueByName?.name
      if (board) status.board = board
      found.statuses.set(issue.id, status)
      for (const node of answered.closedByPullRequestsReferences?.nodes ?? []) offer(issue.id, pullOf(node))
    }

    const marked = (data.marked as { nodes?: unknown[] } | undefined)?.nodes ?? []
    for (const node of marked) {
      const body = (node as { body?: unknown } | null)?.body
      for (const [, id, noticed] of typeof body === 'string' ? body.matchAll(MARKER) : []) {
        const issue = working.find(i => i.id === Number(id) && i.createdAt === Number(noticed))
        if (issue) offer(issue.id, pullOf(node))
      }
    }

    const rate = data.rateLimit as { remaining?: unknown; resetAt?: unknown } | undefined
    if (typeof rate?.remaining === 'number' && rate.remaining < RESERVE) {
      const reset = typeof rate.resetAt === 'string' ? Date.parse(rate.resetAt) : NaN
      found.pausedUntil = Number.isNaN(reset) ? (await $.clock.now()) + RATE_PAUSE_MS : reset
      break
    }
  }

  return found
}

// `force`, for `/noticely` and a newly linked issue, makes a pass even when another
// session of the repository made one moments ago; nothing makes one while GitHub is paused.
export async function refreshGithub($: Api, force = false) {
  const list = await read($, issues)
  const linked = list.filter(i => i.githubUrl)
  const working = list.filter(i => i.sessionId)

  if (!session.github || refreshing || (linked.length === 0 && working.length === 0)) {
    return
  }

  refreshing = true
  let found: Found
  try {
    const key = `github:${session.storeKey.slice('issues:'.length)}`
    const now = await $.clock.now()
    // A pass of a session that reloaded meanwhile is refused the store: it asks nothing.
    const shared = (await $.store.get(key).catch(() => null)) as GithubChecked | null | undefined

    if (shared === null) {
      return
    }

    if (now < (shared?.pausedUntil ?? 0) || (!force && now - (shared?.checkedAt ?? -Infinity) < GITHUB_MS - SLACK)) {
      return
    }

    // Kept before asking, so a session that starts meanwhile does not ask too.
    const checked: GithubChecked = { checkedAt: now }
    await $.store.set(key, checked)
    found = await ask($, linked, working)
    if (found.pausedUntil) await $.store.set(key, { ...checked, pausedUntil: found.pausedUntil })
  } finally {
    // Whatever went wrong, the next pass still runs.
    refreshing = false
  }

  // Closed on GitHub, as completed or as not planned: nothing is left to notice.
  const closed = new Set([...found.statuses].filter(([, status]) => status.state === 'CLOSED').map(([id]) => id))
  const learnt = (i: Issue): Issue => ({
    ...i,
    ...(found.statuses.has(i.id) ? { github: found.statuses.get(i.id) } : {}),
    ...(found.pulls.has(i.id) ? { pull: found.pulls.get(i.id) } : {}),
  })

  // Nothing new: the list is not written, so nothing is drawn again.
  if (closed.size === 0 && list.every(i => JSON.stringify(learnt(i)) === JSON.stringify(i))) {
    return
  }

  await change($, list => list.filter(i => !closed.has(i.id)).map(learnt))
  if (closed.size > 0) {
    await $.ui.toast(`✓ closed on GitHub, removed: ${[...closed].map(id => `#${id}`).join(', ')}`)
  }
}
