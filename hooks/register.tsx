import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { GithubStatus, Issue, Priority, Stored, Tab } from '../types'

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
// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'noticed-issues', key: 'collapsed' } as const, [])
const COLLAPSED_KEY = 'collapsed'
// The pane's tab, for this session only.
const tab = atom({ plugin: 'noticed-issues', key: 'tab' } as const, 'all')
// The card whose ✕ asks to confirm, for this session only.
const deleting = atom({ plugin: 'noticed-issues', key: 'deleting' } as const, null)
// Where each open group is scrolled to, for this session only.
const scrolled = atom({ plugin: 'noticed-issues', key: 'scrolled' } as const, {})

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

// Starts `claude --bg` with the prompt; its id, or undefined once a toast said why not.
const background = async ($: Api, text: string, what: string) => {
  const ran = await $.process.run(['claude', '--bg', text], { cwd }).catch(() => undefined)
  // `claude --bg` prints the id that `claude attach` takes.
  const sessionId = ran?.exitCode === 0 ? ran.stdout.match(SESSION_ID)?.[0] : undefined

  if (!sessionId) {
    await $.ui.toast(`Could not start a session for ${what}: ${ran?.stderr.trim() || 'claude --bg failed'}`)
  }

  return sessionId
}

const startSession = async ($: Api, id: number) => {
  const issue = (await read($, issues)).find(i => i.id === id)

  if (!issue) {
    return
  }

  const sessionId = await background($, prompt(issue), `#${id}`)

  if (!sessionId) {
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
  { value: 'low', label: 'Low', color: 'remember' },
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

// What the pane lists: every issue, or this session's on its tab, offered
// only while this session has noted something.
const view = async ($: Api) => {
  const list = await read($, issues)
  const session = await $.session.id()
  const mine = list.filter(issue => issue.noticedIn === session)
  const current: Tab = mine.length > 0 ? await read($, tab) : 'all'

  return { list, mine, current, shown: current === 'session' ? mine : list }
}

// Rows above the groups: the pane's heading, and the tabs with a blank line either side.
const headRows = (hasTabs: boolean) => (hasTabs ? 4 : 1)

// Splits `free` rows between groups that need `needs` rows each: one that
// needs no more than an even share gets what it needs, and the rows it leaves
// go to the rest, which share them evenly.
const share = (needs: number[], free: number) => {
  const rows = needs.map(() => 1)
  let left = free
  let rest = needs.map((_, i) => i)

  while (rest.length > 0) {
    const even = Math.floor(left / rest.length)
    const fits = rest.filter(i => needs[i]! <= even)

    if (fits.length === 0) {
      let spare = left - even * rest.length
      for (const i of rest) {
        rows[i] = Math.max(1, even + (spare > 0 ? 1 : 0))
        spare -= 1
      }
      break
    }
    for (const i of fits) {
      rows[i] = needs[i]!
      left -= needs[i]!
    }
    rest = rest.filter(i => !fits.includes(i))
  }

  return rows
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

// Each group's rows in the pane, top to bottom. The pane never scrolls as a
// whole, so a heading stays on screen: a folded group takes its heading's
// row, an open one what its cards need, as far as the rows go round; one
// that does not fit scrolls its cards inside its rows, never past the point
// where the last of them shows.
const arrange = (
  shown: Issue[],
  folded: Priority[],
  top: number,
  bodyRows: number,
  columns: number,
  confirming: number | null,
) => {
  const groups = PRIORITIES.map((priority, i) => ({
    priority,
    items: shown.filter(issue => rank(issue) === i),
    isOpen: !folded.includes(priority.value),
  })).filter(g => g.items.length > 0)
  const heights = groups.map(g => g.items.map(issue => cardRows(issue, columns, issue.id === confirming)))
  const open = groups.flatMap((g, i) => (g.isOpen ? [i] : []))
  const free = Math.max(0, bodyRows - top - (groups.length - open.length))
  const given = share(
    open.map(i => 1 + sum(heights[i]!)),
    free,
  )
  let row = top

  return groups.map((g, i) => {
    const rows = g.isOpen ? given[open.indexOf(i)]! : 1
    const cards = heights[i]!
    let lastFirst = 0
    while (lastFirst < cards.length - 1 && 1 + sum(cards.slice(lastFirst)) > rows) lastFirst += 1
    const placed = { ...g, top: row, rows, lastFirst }
    row += rows
    return placed
  })
}

// The first card a group shows, scrolled no further than its last full view.
const firstCard = (at: number | undefined, lastFirst: number) => Math.max(0, Math.min(at ?? 0, lastFirst))

const toggleGroup = async ($: Api, priority: Priority) => {
  const next = await update($, collapsed, list =>
    list.includes(priority) ? list.filter(p => p !== priority) : [...list, priority],
  )
  await $.store.set(COLLAPSED_KEY, next)
}

// A detail longer than this many card lines is cut; the GitHub issue keeps it whole.
const DETAIL_LINES = 3

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value)

// The rows `text` takes wrapped at `width`, word by word, a word wider than a row broken.
const wrappedRows = (text: string, width: number) => {
  let rows = 1
  let used = 0

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const length = [...word].length
    if (used > 0 && used + 1 + length <= width) {
      used += 1 + length
      continue
    }
    if (used > 0) rows += 1
    rows += Math.floor(Math.max(0, length - 1) / width)
    used = length % width || width
  }

  return rows
}

// The rows a card takes with `columns` inside its border. A plugin cannot
// measure what it drew, so a group's rows are worked out from these.
const cardRows = (issue: Issue, columns: number, isConfirming: boolean) => {
  // The corner beside the heading: ` ✕ `, or `Delete? ✓ ↩ `, and a column before it.
  const head = Math.max(1, columns - (isConfirming ? 14 : 4))
  const title = issue.githubUrl ? 1 + wrappedRows(issue.title, head) : wrappedRows(`#${issue.id} ${issue.title}`, head)
  const detail = issue.detail ? wrappedRows(clip(issue.detail, DETAIL_LINES * columns), columns) : 0

  // With the border's two rows, the controls' row and the blank row below the card.
  return title + (issue.file ? 1 : 0) + detail + 4
}

// Inside a card: its border and padding take two columns a side.
const cardColumnsOf = (bodyColumns: number) => Math.max(20, bodyColumns - 4)

// The pane's width as last drawn: `ui.scroll` does not carry it.
let paneColumns = 60

// Where reports about the plugin itself go.
const PLUGIN_REPO = 'DOstapovets/claude-noticed-issues'

const FEEDBACK_PROMPT = [
  `Help me send feedback about the noticed-issues Claude Code plugin to its GitHub repository, ${PLUGIN_REPO}.`,
  '1. Interview me with AskUserQuestion, a few questions at a time. First: is it a bug, a feature request, or a question or idea to talk through? Then what that kind needs: for a bug, what happened, the steps and what I expected; for a feature, the problem and what I would like; for a question or idea, the question itself.',
  '2. Collect the environment yourself rather than asking: `claude --version`, the noticed-issues version from `claude plugin list`, the OS, and whether this terminal uses the fullscreen layout. Leave out tokens, internal hostnames, private repository names and the contents of my projects.',
  `3. Look for an existing issue or discussion on the same thing (\`gh issue list --repo ${PLUGIN_REPO} --state all --search ...\`, and discussions through \`gh api graphql\`). If there is one, show it and offer to add a comment there instead.`,
  '4. Draft the title and body. A bug: sections What happened, Steps to reproduce, Plugin version, Claude Code version, Where you run Claude Code, Logs or screenshots. A feature: The problem, What you would like, Alternatives you considered. Show me the draft and post nothing until I confirm it.',
  `5. Once I confirm: a bug or a feature request becomes an issue, \`gh issue create --repo ${PLUGIN_REPO} --title ... --body-file ...\`; a question or an idea becomes a discussion through \`gh api graphql\` and its createDiscussion mutation, in the Q&A category for a question and Ideas for an idea (look up the repository id and the category ids first). Give me the link.`,
].join('\n')

const startFeedback = async ($: Api) => {
  const sessionId = await background($, FEEDBACK_PROMPT, 'feedback')

  if (sessionId) {
    await $.ui.toast(`✎ Feedback session ${sessionId} is waiting for your answers · claude attach ${sessionId}`)
  }
}

const remove = async ($: Api, id: number) => {
  await save($, (await read($, issues)).filter(i => i.id !== id))
}

const confirmRemove = async ($: Api, id: number) => {
  await update($, deleting, () => null)
  await remove($, id)
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
    const folded = (await $.store.get(COLLAPSED_KEY)) as Priority[] | undefined
    await update($, collapsed, () => folded ?? [])

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
      description:
        "Show this project's noticed issues; `/issues clear` empties the list, `/issues feedback` reports a bug or an idea about this plugin",
      argumentHint: '[clear|feedback]',
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

    const issue: Issue = { id: nextId, title, createdAt: await $.clock.now(), noticedIn: await $.session.id() }
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
    if (e.args.trim() === 'feedback') {
      await startFeedback($)
      return { text: 'Feedback session started in the background: attach to it to answer its questions.' }
    }

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
    const { list, mine } = await view($)
    const below = await next(e)

    if (e.props.hasSurvey || list.length === 0) {
      return below
    }

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Button
          key="open-issues"
          plain
          label={`⚑ ${count(list.length)}${mine.length > 0 ? ` · ${mine.length} this session` : ''}`}
          onPress={() => openPane($)}
        />
        {below}
      </Box>
    )
  })

  // The wheel, or the scroll keys, move the open group under the pointer (the
  // first open one for the keys) a card at a time; the pane itself stays put.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { mine, shown } = await view($)
    const open = arrange(
      shown,
      await read($, collapsed),
      headRows(mine.length > 0),
      e.bodyRows,
      cardColumnsOf(paneColumns),
      await read($, deleting),
    ).filter(g => g.isOpen)
    const row = e.pointer?.row
    const target = row === undefined ? open[0] : open.find(g => row >= g.top && row < g.top + g.rows)

    if (target && e.by !== 0) {
      const key = target.priority.value
      await update($, scrolled, was => ({ ...was, [key]: firstCard((was[key] ?? 0) + Math.sign(e.by), target.lastFirst) }))
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, issues)

    paneColumns = e.props.bodyColumns
    const cardColumns = cardColumnsOf(e.props.bodyColumns)
    const confirming = await read($, deleting)

    // The card's top right corner: a red ✕, which asks once before it deletes.
    const corner = (issue: Issue) =>
      confirming === issue.id ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text color="error">Delete?</Text>
          <Button key={`confirm-delete-${issue.id}`} plain onPress={() => confirmRemove($, issue.id)}>
            <Text color="error" bold>
              {' ✓ '}
            </Text>
          </Button>
          <Button key={`cancel-delete-${issue.id}`} plain dimColor label=" ↩ " onPress={() => update($, deleting, () => null)} />
        </Box>
      ) : (
        <Box flexShrink={0} marginLeft={1}>
          <Button key={`delete-${issue.id}`} plain onPress={() => update($, deleting, () => issue.id)}>
            <Text color="error" bold>
              {' ✕ '}
            </Text>
          </Button>
        </Box>
      )

    const card = (issue: Issue) => (
      <Box
        key={`issue-${issue.id}`}
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
        flexShrink={0}
        borderStyle="round"
        borderDimColor
        hover={{ borderColor: 'claude', borderDimColor: false }}
      >
        <Box justifyContent="space-between">
          {issue.githubUrl ? (
            // A linked issue: number, link and status on a line of their own that
            // never wraps, the title below at the card's full width.
            <Box key={`head-${issue.id}`} flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexShrink={0}>
                <Text color="claude" bold>
                  #{issue.id}
                </Text>
                <Box marginLeft={2} flexShrink={0}>
                  <Link href={issue.githubUrl} label={`↗ #${issue.githubUrl.split('/').pop()}`} />
                  {issue.github && (
                    <Text color="success"> · open{issue.github.board ? ` · ${issue.github.board}` : ''}</Text>
                  )}
                </Box>
              </Box>
              <Text bold wrap="wrap">
                {issue.title}
              </Text>
            </Box>
          ) : (
            <Box key={`head-${issue.id}`} flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">
                <Text color="claude" bold>
                  #{issue.id}
                </Text>{' '}
                <Text bold>{issue.title}</Text>
              </Text>
            </Box>
          )}
          {corner(issue)}
        </Box>
        {issue.file && (
          <Text dimColor wrap="truncate-middle">
            {issue.file}
          </Text>
        )}
        {issue.detail && (
          <Text dimColor wrap="wrap">
            {clip(issue.detail, DETAIL_LINES * cardColumns)}
          </Text>
        )}
        <Box justifyContent="space-between">
          <Box gap={2}>
            {issue.sessionId ? (
              <Text color="cyan">▶ {issue.sessionId}</Text>
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
          </Box>
          {/* At the right edge, each arrow in the color of the group it moves the issue to,
              padded with a space a side so it is easier to hit. */}
          <Box gap={2}>
            {rank(issue) > 0 && (
              <Button key={`raise-${issue.id}`} plain onPress={() => shiftPriority($, issue.id, -1)}>
                <Text color={PRIORITIES[rank(issue) - 1]!.color} bold>
                  {' ▲ '}
                </Text>
              </Button>
            )}
            {rank(issue) < PRIORITIES.length - 1 && (
              <Button key={`lower-${issue.id}`} plain onPress={() => shiftPriority($, issue.id, 1)}>
                <Text color={PRIORITIES[rank(issue) + 1]!.color} bold>
                  {' ▼ '}
                </Text>
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    )

    // The session tab is offered only while this session has noted something.
    const { mine, current, shown } = await view($)

    // The current tab is filled with the accent color, the other drawn in it on the pane's background.
    const tabButton = (value: Tab, label: string) => (
      <Button key={`tab-${value}`} plain onPress={() => update($, tab, () => value)}>
        {current === value ? (
          <Text backgroundColor="claude" color="inverseText" bold>
            {` ${label} `}
          </Text>
        ) : (
          <Text color="claude">{` ${label} `}</Text>
        )}
      </Button>
    )

    const bodyRows = e.props.scroll.bodyRows
    const groups = arrange(shown, await read($, collapsed), headRows(mine.length > 0), bodyRows, cardColumns, confirming)
    const at = await read($, scrolled)

    const group = ({ priority, items, isOpen, rows, lastFirst }: (typeof groups)[number]) => {
      const first = firstCard(at[priority.value], lastFirst)

      return (
        <Box key={`priority-${priority.value}`} flexDirection="column" height={rows} flexShrink={0} overflow="hidden">
          <Box flexShrink={0}>
            <Button key={`group-${priority.value}`} plain onPress={() => toggleGroup($, priority.value)}>
              <Text color={priority.color} bold>
                {isOpen ? '▾' : '▸'} {priority.label} {items.length}
              </Text>
            </Button>
            {isOpen && first > 0 && <Text dimColor> ↑ {first} above</Text>}
          </Box>
          {isOpen && items.slice(first).map(card)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        <Box justifyContent="space-between">
          <Text bold>Noticed issues{list.length > 0 ? ` ${list.length}` : ''}</Text>
          <Button key="feedback" plain dimColor label="✎ Feedback" onPress={() => startFeedback($)} />
        </Box>
        {mine.length > 0 && (
          <Box gap={1} marginTop={1} marginBottom={1}>
            {tabButton('session', `This session ${mine.length}`)}
            {tabButton('all', `All ${list.length}`)}
          </Box>
        )}
        {list.length === 0 && <Text dimColor>Nothing noticed in this project.</Text>}
        {/* A folded group keeps its place in the priority order. */}
        {groups.map(group)}
      </Box>
    )
  })
}
