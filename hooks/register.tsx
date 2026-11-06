import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { GithubStatus, Issue, Priority, Stored } from '../types'

type Api = Parameters<Hook<'tool.call'>>[0]

const PANE = 'noticed-issues'
const TITLE = 'Noticed issues'
const NOTE = 'mcp__noticed-issues__note_issue'
const RESOLVE = 'mcp__noticed-issues__resolve_issue'
// Another session of this project (a background one started from the pane)
// may resolve issues; pick its changes up this often.
const RELOAD_MS = 30_000
// Each linked GitHub issue costs one `gh` call, so its status is read less often.
const GITHUB_MS = 5 * 60_000

const issues = atom({ plugin: 'noticed-issues', key: 'issues' } as const, [])

// Set by session.start, which also runs again on every reload.
let cwd = ''
let storeKey = ''
let nextId = 1
// Whether this session offers GitHub issues and reads their status.
let github = false

const count = (n: number) => (n === 1 ? '1 issue' : `${n} issues`)

const save = async ($: Api, list: Issue[]) => {
  await update($, issues, () => list)
  const stored: Stored = { nextId, items: list }
  await $.store.set(storeKey, stored)
}

const load = async ($: Api) => {
  const stored = (await $.store.get(storeKey)) as Stored | undefined
  nextId = Math.max(nextId, stored?.nextId ?? 1)
  const list = stored?.items ?? []
  await update($, issues, () => list)

  return list
}

// `auto` asks the `origin` remote: ssh (`git@github.com:o/r.git`, `ssh://…`) or https.
const onGithub = (remote: string | null | undefined) => {
  const host = remote?.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)/i)?.[1]

  return host !== undefined && /(^|\.)github\.com$/i.test(host)
}

const commonDir = async ($: Api, dir: string) => {
  const ran = await $.process
    .run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    .catch(() => undefined)

  return ran === undefined ? undefined : ran.exitCode === 0 ? ran.stdout.trim() : null
}

// Up to 0.4 the list was kept per working directory, so each worktree of a
// repository, and each subdirectory a session started in, had one of its own.
// Fold those into the repository's list, renumbered after it; a title already
// on it is dropped. A repository of its own nested inside keeps its list.
const migrate = async ($: Api, root: string) => {
  const nested = (await $.store.keys()).filter(key => key.startsWith(`${storeKey}/`))
  const repoGit = nested.length > 0 ? await commonDir($, root) : undefined

  if (!repoGit) {
    return
  }

  const stored = (await $.store.get(storeKey)) as Stored | undefined
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
  await $.store.set(storeKey, merged)
  for (const key of folded) {
    await $.store.delete(key)
  }
}

const openPane = ($: Api) => $.ui.open({ id: PANE, title: TITLE })

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const prompt = (issue: Issue) =>
  [
    `Fix noticed issue #${issue.id}: ${issue.title}`,
    issue.file && `Where: ${issue.file}`,
    issue.detail && `Detail: ${issue.detail}`,
    issue.githubUrl && `GitHub issue: ${issue.githubUrl}`,
    `When it is fixed, call resolve_issue with id ${issue.id}.`,
  ]
    .filter(Boolean)
    .join('\n')

const startSession = async ($: Api, id: number) => {
  const issue = (await read($, issues)).find(i => i.id === id)

  if (!issue) {
    return
  }

  const ran = await $.process.run(['claude', '--bg', prompt(issue)], { cwd }).catch(() => undefined)
  // `claude --bg` prints the id that `claude attach` takes.
  const sessionId = ran?.exitCode === 0 ? ran.stdout.match(SESSION_ID)?.[0] : undefined

  if (!sessionId) {
    await $.ui.toast(`Could not start a session for #${id}: ${ran?.stderr.trim() || 'claude --bg failed'}`)
    return
  }

  await save(
    $,
    (await read($, issues)).map(i => (i.id === id ? { ...i, sessionId } : i)),
  )
  await $.ui.toast(`▶ #${id} → background session ${sessionId} · claude attach ${sessionId}`)
}

// Ids whose `gh issue create` is still running, so a second press does not file it twice.
const filing = new Set<number>()

const githubBody = (issue: Issue) =>
  [issue.detail, issue.file && `Where: \`${issue.file}\``, '_Noticed by Claude Code._']
    .filter(Boolean)
    .join('\n\n')

const createGithubIssue = async ($: Api, id: number) => {
  const issue = (await read($, issues)).find(i => i.id === id)

  if (!github || !issue || issue.githubUrl || filing.has(id)) {
    return
  }

  filing.add(id)
  // gh files it in the repository of the session's directory and prints its URL.
  const ran = await $.process
    .run(['gh', 'issue', 'create', '--title', issue.title, '--body', githubBody(issue)], { cwd })
    .catch(() => undefined)
  filing.delete(id)
  const githubUrl = ran?.exitCode === 0 ? ran.stdout.match(GITHUB_ISSUE)?.[0] : undefined

  if (!githubUrl) {
    await $.ui.toast(`Could not create a GitHub issue for #${id}: ${ran?.stderr.trim() || 'gh issue create failed'}`)
    return
  }

  await save(
    $,
    (await read($, issues)).map(i => (i.id === id ? { ...i, githubUrl } : i)),
  )
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

const githubStatus = async ($: Api, url: string): Promise<GithubStatus | undefined> => {
  const ran = await $.process
    .run(['gh', 'issue', 'view', url, '--json', 'state,projectItems'], { cwd })
    .catch(() => undefined)

  const viewed = ran?.exitCode === 0 ? (parse(ran.stdout) as Viewed | undefined) : undefined

  if (!viewed) {
    return undefined
  }

  const status: GithubStatus = { state: viewed.state }
  const board = viewed.projectItems.find(item => item.status)?.status?.name
  if (board) status.board = board

  return status
}

const refreshGithub = async ($: Api) => {
  const linked = (await read($, issues)).filter(i => i.githubUrl)

  if (!github || refreshing || linked.length === 0) {
    return
  }

  refreshing = true
  const statuses = new Map<number, GithubStatus>()
  for (const issue of linked) {
    const status = await githubStatus($, issue.githubUrl!)
    if (status) statuses.set(issue.id, status)
  }
  refreshing = false

  if (statuses.size === 0) {
    return
  }

  // Closed on GitHub, as completed or as not planned: nothing is left to notice.
  const closed = new Set([...statuses].filter(([, status]) => status.state === 'CLOSED').map(([id]) => id))
  await save(
    $,
    (await read($, issues))
      .filter(i => !closed.has(i.id))
      .map(i => (statuses.has(i.id) ? { ...i, github: statuses.get(i.id) } : i)),
  )
  if (closed.size > 0) {
    await $.ui.toast(`✓ closed on GitHub, removed: ${[...closed].map(id => `#${id}`).join(', ')}`)
  }
}

// Highest first: the order of the pane's groups and of `/issues` as text.
const PRIORITIES = [
  { value: 'high', label: 'High', color: 'error' },
  { value: 'medium', label: 'Medium', color: 'warning' },
  { value: 'low', label: 'Low', color: 'subtle' },
] as const

// An issue noted before priorities existed, or without one, is medium.
const rank = (issue: Issue) => PRIORITIES.findIndex(p => p.value === (issue.priority ?? 'medium'))

// -1 raises it a step, 1 lowers it; at either end it stays.
const shiftPriority = async ($: Api, id: number, step: -1 | 1) => {
  await save(
    $,
    (await read($, issues)).map(i => {
      const to = PRIORITIES[rank(i) + step]
      return i.id === id && to ? { ...i, priority: to.value } : i
    }),
  )
}

const remove = async ($: Api, id: number) => {
  await save($, (await read($, issues)).filter(i => i.id !== id))
}

const GITHUB_ISSUE = /https:\/\/\S+\/issues\/\d+/

const SESSION_ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    cwd = ran.cwd
    // One list per repository, shared by its worktrees: the main working
    // tree's root names it. Outside a repository the directory does.
    const repo = await $.session.repo()
    storeKey = `issues:${repo?.root ?? cwd}`
    github = options.github === 'on' || (options.github !== 'off' && onGithub(repo?.remote))
    nextId = 1

    if (repo) {
      await migrate($, repo.root)
    }
    const list = await load($)

    await $.tool.register({
      name: 'note_issue',
      description:
        'Record a problem you noticed that is NOT part of the current task and that you are not fixing now ' +
        '(a bug, a leaked secret, broken config, a failing check, stale docs). It goes on the user\'s ' +
        'per-project "noticed issues" list, kept across sessions. Mention it in one line in your reply too. ' +
        'Do not use it for steps of the current task: those belong in the task list.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line: what is wrong' },
          detail: { type: 'string', description: 'Why it matters or what to do about it' },
          file: { type: 'string', description: 'Where it was seen: path[:line], URL or resource' },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'high: a security problem, data loss or something broken for users; low: cosmetic or nice to have; medium otherwise (the default)',
          },
        },
        required: ['title'],
      },
    })
    await $.tool.register({
      name: 'resolve_issue',
      description: 'Remove an issue from the noticed-issues list once it has been fixed or is no longer relevant.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'The issue number, as note_issue returned it' } },
        required: ['id'],
      },
    })
    await $.command.register({
      name: 'issues',
      description: "Show this project's noticed issues; `/issues clear` empties the list",
      argumentHint: '[clear]',
    })

    $.clock.every(RELOAD_MS, () => void load($))
    $.clock.every(GITHUB_MS, () => void refreshGithub($))
    void refreshGithub($)

    if (list.length > 0) {
      void openPane($)
    }

    return ran
  })

  // ToolSpec has no placement of its own: an MCP-style tool is listed behind
  // ToolSearch unless a tool.describe hook keeps it in the prompt's list.
  on('tool.describe', { tool: NOTE }, async (_, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: RESOLVE }, async (_, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: NOTE }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const title = text(input.title)

    if (title === undefined) {
      return { result: 'Not noted: `title` is required.' }
    }

    const list = await load($)
    const same = list.find(i => i.title.toLowerCase() === title.toLowerCase())

    if (same) {
      return { result: `Already on the list as #${same.id}.` }
    }

    const issue: Issue = { id: nextId, title, createdAt: await $.clock.now() }
    const detail = text(input.detail)
    const file = text(input.file)
    if (detail) issue.detail = detail
    if (file) issue.file = file
    if (PRIORITIES.some(p => p.value === input.priority)) issue.priority = input.priority as Priority

    nextId += 1
    await save($, [...list, issue])
    await $.ui.toast(`⚑ noted #${issue.id}: ${title}`)
    void openPane($)

    return { result: `Noted as #${issue.id}; the user sees it under /issues.` }
  })

  on('tool.call', { tool: RESOLVE }, async ($, e) => {
    const id = Number((e as unknown as Record<string, unknown>).id)
    const list = await load($)

    if (!list.some(i => i.id === id)) {
      return { result: `No open issue #${id}.` }
    }

    await save($, list.filter(i => i.id !== id))

    return { result: `Resolved #${id}.` }
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await save($, [])
      return { text: 'Noticed issues cleared for this project.' }
    }

    const list = await load($)
    void refreshGithub($)
    const opened = await openPane($)

    if (opened.isPlaced) {
      return { text: `Noticed issues: ${count(list.length)}.` }
    }

    return {
      text:
        list.length === 0
          ? 'No noticed issues.'
          : [...list]
              .sort((a, b) => rank(a) - rank(b))
              .map(i => `[${PRIORITIES[rank(i)]!.label}] #${i.id} ${i.title}${i.file ? ` (${i.file})` : ''}`)
              .join('\n'),
    }
  })

  // A status line cannot be pressed, so the count is a Button above the prompt
  // that opens the pane. It wraps the band beneath rather than replacing it,
  // so task-progress's bar stays on screen whichever plugin draws first.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, issues)
    const below = await next(e)

    if (e.props.hasSurvey || list.length === 0) {
      return below
    }

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Button key="open-issues" plain label={`⚑ ${count(list.length)}`} onPress={() => openPane($)} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, issues)

    const card = (issue: Issue) => (
      <Box
        key={`issue-${issue.id}`}
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
        borderStyle="round"
        borderDimColor
        hover={{ borderColor: 'claude', borderDimColor: false }}
      >
        <Box key={`head-${issue.id}`}>
          <Text color="claude" bold>
            #{issue.id}
          </Text>
          {issue.githubUrl && (
            <Box marginLeft={1}>
              <Link href={issue.githubUrl} label={`↗ GitHub #${issue.githubUrl.split('/').pop()}`} />
              {issue.github && (
                <Text color="success"> · open{issue.github.board ? ` · ${issue.github.board}` : ''}</Text>
              )}
            </Box>
          )}
          <Box marginLeft={1} flexShrink={1}>
            <Text wrap="wrap">{issue.title}</Text>
          </Box>
        </Box>
        {(issue.file || issue.detail) && (
          <Text dimColor wrap="wrap">
            {[issue.file, issue.detail].filter(Boolean).join(' — ')}
          </Text>
        )}
        <Box justifyContent="space-between">
          <Box>
            {issue.sessionId ? (
              <Text color="cyan">▶ {issue.sessionId} </Text>
            ) : (
              <Button
                key={`session-${issue.id}`}
                label="▶ New session"
                variant="primary"
                onPress={() => startSession($, issue.id)}
              />
            )}
            {github && !issue.githubUrl && (
              <Button
                key={`github-${issue.id}`}
                label="↗ GitHub issue"
                onPress={() => createGithubIssue($, issue.id)}
              />
            )}
            <Button key={`delete-${issue.id}`} label="✕ Delete" dimColor onPress={() => remove($, issue.id)} />
          </Box>
          {/* At the right edge, each arrow in the color of the group it moves the issue to. */}
          <Box gap={3} paddingRight={1}>
            {rank(issue) > 0 && (
              <Button key={`raise-${issue.id}`} plain onPress={() => shiftPriority($, issue.id, -1)}>
                <Text color={PRIORITIES[rank(issue) - 1]!.color} bold>
                  ▲
                </Text>
              </Button>
            )}
            {rank(issue) < PRIORITIES.length - 1 && (
              <Button key={`lower-${issue.id}`} plain onPress={() => shiftPriority($, issue.id, 1)}>
                <Text color={PRIORITIES[rank(issue) + 1]!.color} bold>
                  ▼
                </Text>
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>Noticed issues{list.length > 0 ? ` ${list.length}` : ''}</Text>
        {list.length === 0 && <Text dimColor>Nothing noticed in this project.</Text>}
        {PRIORITIES.map((priority, i) => {
          const group = list.filter(issue => rank(issue) === i)

          return (
            group.length > 0 && (
              <Box key={`priority-${priority.value}`} flexDirection="column">
                <Text color={priority.color} bold>
                  ● {priority.label} {group.length}
                </Text>
                {group.map(card)}
              </Box>
            )
          )
        })}
      </Box>
    )
  })
}
