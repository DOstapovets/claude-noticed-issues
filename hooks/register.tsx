import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Issue, Priority, Tab } from '../types'
import { MINUTE, session } from './context'
import type { Api } from './context'
import { createGithubIssue, onGithub, refreshGithub } from './github'
import { age, arrange, cardColumnsOf, clip, count, DETAIL_LINES, firstCard, headRows, LIMITS, PRIORITIES, rank } from './layout'
import { startFeedback, startSession, whereRun } from './sessions'
import { change, COLLAPSED_KEY, load, migrate, save, toggleGroup } from './store'

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
// The pane's tab, for this session only.
const tab = atom({ plugin: 'noticed-issues', key: 'tab' } as const, 'all')
// The card whose ✕ asks to confirm, for this session only.
const deleting = atom({ plugin: 'noticed-issues', key: 'deleting' } as const, null)
// Where each open group is scrolled to, for this session only.
const scrolled = atom({ plugin: 'noticed-issues', key: 'scrolled' } as const, {})
// The time the cards' ages are told from, moved on once a minute: the pane redraws then, not on every tick.
const minute = atom({ plugin: 'noticed-issues', key: 'minute' } as const, 0)
const AGE_MS = 10_000

const openPane = ($: Api) => $.ui.open({ id: PANE, title: TITLE })

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

// The groups' colors in VS Code: its webview draws `warning` in the menus' grey and
// knows no `remember`, so the theme's terminal colors stand in. Any `#rrggbb` or
// `rgb(…)` is drawn too.
const VSCODE_COLORS: Record<Priority, string> = { high: 'red', medium: 'yellow', low: 'blue' }

// VS Code's spacing, in lines down and characters across, a fraction allowed: the
// terminal's whole rows are counted for its layout and stay as they are.
const VSCODE_SPACE = {
  // Between one group and the next, on top of the last card's own margin.
  betweenGroups: 0.5,
  // Between a group's heading and its first card.
  belowHeading: 0.5,
  // Cards stand in from the heading's dot, under its name.
  cardIndent: 2,
  // Between one card and the next.
  betweenCards: 0.75,
}

// -1 raises it a step, 1 lowers it; at either end it stays.
const shiftPriority = async ($: Api, id: number, step: -1 | 1) => {
  await change($, list =>
    list.map(i => {
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

// Off the terminal, a card's padding above and below and the room between its
// lines, in lines; VS Code draws a fraction of one.
const CARD_PADDING_Y = 0.5
const CARD_ROW_GAP = 0.3

const remove = async ($: Api, id: number) => {
  await change($, list => list.filter(i => i.id !== id))
}

const confirmRemove = async ($: Api, id: number) => {
  await update($, deleting, () => null)
  await remove($, id)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    session.cwd = ran.cwd
    // One list per repository, shared by its worktrees: the main working
    // tree's root names it. Outside a repository the directory does.
    const repo = await $.session.repo()
    session.storeKey = `issues:${repo?.root ?? session.cwd}`
    session.github = options.github === 'on' || (options.github !== 'off' && onGithub(repo?.remote))
    session.nextId = 1

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

    // Kept as read, so ages are not a minute short; written once the minute turns.
    const tick = async () => {
      const now = await $.clock.now()
      if (Math.floor((await read($, minute)) / MINUTE) !== Math.floor(now / MINUTE)) await update($, minute, () => now)
    }
    await tick()
    $.clock.every(AGE_MS, () => void tick())
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
    const cut: string[] = []
    const field = (name: keyof typeof LIMITS) => {
      const value = text(input[name])
      if (value === undefined || value.length <= LIMITS[name]) return value
      cut.push(`${name} cut to ${LIMITS[name]} characters`)
      return clip(value, LIMITS[name])
    }
    const title = field('title')

    if (title === undefined) {
      return { result: 'Not noted: `title` is required.' }
    }

    const list = await load($)
    const same = list.find(i => i.title.toLowerCase() === title.toLowerCase())

    if (same) {
      return { result: `Already on the list as #${same.id}.` }
    }

    const issue: Issue = { id: session.nextId, title, createdAt: await $.clock.now(), noticedIn: await $.session.id() }
    const detail = field('detail')
    const file = field('file')
    if (detail) issue.detail = detail
    if (file) issue.file = file
    if (PRIORITIES.some(p => p.value === input.priority)) issue.priority = input.priority as Priority

    session.nextId += 1
    await save($, [...list, issue])
    await $.ui.toast(`⚑ noted #${issue.id}: ${title}`)
    void openPane($)

    const note = cut.length > 0 ? ` (${cut.join(', ')})` : ''
    return { result: `Noted as #${issue.id}${note}; the user sees it under /issues.` }
  })

  on('tool.call', { tool: RESOLVE }, async ($, e) => {
    const id = Number((e as unknown as Record<string, unknown>).id)

    if (!Number.isInteger(id)) {
      return { result: 'Not resolved: `id` must be an issue number.' }
    }

    const list = await load($)

    if (!list.some(i => i.id === id)) {
      return { result: `No open issue #${id}.` }
    }

    await save($, list.filter(i => i.id !== id))

    return { result: `Resolved #${id}.` }
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    if (e.args.trim() === 'feedback') {
      // Typed at the terminal, the run says its layout; from elsewhere, the one surface
      // the session draws on, if only one.
      const surfaces = await $.session.surfaces()
      const where =
        e.origin.kind === 'composer' && surfaces.includes('terminal')
          ? whereRun('terminal', e.presentation.isFullscreen)
          : surfaces.length === 1
            ? whereRun(surfaces[0], undefined)
            : undefined
      await startFeedback($, where)
      return { text: 'Feedback session started in the background: attach to it to answer its questions.' }
    }

    if (e.args.trim() === 'clear') {
      await change($, () => [])
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
  // Elsewhere (VS Code, desktop, mobile) the groups flow and the pane scrolls whole.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!session.paneOnTerminal) {
      return next(e)
    }

    const { mine, shown } = await view($)
    const open = arrange(
      shown,
      await read($, collapsed),
      headRows(mine.length > 0),
      e.bodyRows,
      cardColumnsOf(session.paneColumns),
      await read($, deleting),
      await read($, minute),
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

    session.paneColumns = e.props.bodyColumns
    // Only the terminal draws a row as one cell high, so only there are the rows
    // worked out: a graphical surface draws borders, buttons and wrapped text at
    // heights of its own, and a fixed height leaves gaps or cuts cards off.
    const fitsRows = e.surface === 'terminal'
    session.paneOnTerminal = fitsRows
    if (fitsRows) session.paneFullscreen = e.viewport?.isFullscreen
    // VS Code's webview draws no `hover` (a Box drawn `display: "none"` stays hidden)
    // and a phone has no pointer, so there what a hover reveals is always shown.
    const hovers = e.surface !== 'vscode' && e.surface !== 'mobile'
    // VS Code draws a Button's children as plain text in its filled look, so the arrows
    // lose their groups' colors: there they are dim, below the card's own actions.
    const colorlessButtons = e.surface === 'vscode'
    const space = e.surface === 'vscode' ? VSCODE_SPACE : undefined
    const quietArrows = colorlessButtons ? { dimColor: true } : {}
    const cardColumns = cardColumnsOf(e.props.bodyColumns)
    const confirming = await read($, deleting)
    const now = await read($, minute)

    // The card's top right corner: when it was noted, and a red ✕, which asks once before it deletes.
    // VS Code draws its Buttons as framed chips, which a space does not part from the
    // text beside them: there the corner's parts are a character apart.
    const cornerRow = space ? { columnGap: 1, alignItems: 'center' as const } : {}
    const corner = (issue: Issue) =>
      confirming === issue.id ? (
        <Box flexShrink={0} marginLeft={1} {...cornerRow}>
          <Text color="error">Delete?</Text>
          <Button key={`confirm-delete-${issue.id}`} plain onPress={() => confirmRemove($, issue.id)}>
            <Text color="error" bold>
              {' ✓ '}
            </Text>
          </Button>
          <Button key={`cancel-delete-${issue.id}`} plain dimColor label=" ↩ " onPress={() => update($, deleting, () => null)} />
        </Box>
      ) : (
        <Box flexShrink={0} marginLeft={1} {...cornerRow}>
          <Text dimColor>
            {age(issue.createdAt, now)}
            {space ? '' : ' '}
          </Text>
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
        marginBottom={space?.betweenCards ?? 1}
        {...(space ? { marginLeft: space.cardIndent } : {})}
        paddingX={1}
        // Air inside the card where a surface draws part of a line: the terminal's rows are whole and counted.
        {...(fitsRows ? {} : { paddingY: CARD_PADDING_Y, rowGap: CARD_ROW_GAP })}
        flexShrink={0}
        borderStyle="round"
        borderDimColor
        hover={{ borderColor: 'claude', borderDimColor: false }}
      >
        {/* VS Code wraps a row by default: kept on one line there, a long title wraps
            inside its own column and the age and ✕ stay in the top right corner. */}
        <Box justifyContent="space-between" {...(space ? { flexWrap: 'nowrap' as const, alignItems: 'flex-start' as const } : {})}>
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
            {session.github && !issue.githubUrl && (
              <Button
                key={`github-${issue.id}`}
                label="↗ GitHub issue"
                onPress={() => createGithubIssue($, issue.id)}
              />
            )}
          </Box>
          {/* At the right edge, shown while the pointer is over the card: each arrow in the
              color of the group it moves the issue to, padded with a space a side so it is
              easier to hit. Hidden, it keeps no room, and shown it takes none from the row.
              Where no hover is drawn, always shown. */}
          <Box gap={2} {...(hovers ? { display: 'none' as const, hover: { display: 'flex' as const } } : {})}>
            {rank(issue) > 0 && (
              <Button key={`raise-${issue.id}`} plain {...quietArrows} onPress={() => shiftPriority($, issue.id, -1)}>
                <Text color={PRIORITIES[rank(issue) - 1]!.color} bold>
                  {' ▲ '}
                </Text>
              </Button>
            )}
            {rank(issue) < PRIORITIES.length - 1 && (
              <Button key={`lower-${issue.id}`} plain {...quietArrows} onPress={() => shiftPriority($, issue.id, 1)}>
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
    // VS Code fills every Button alike: there the current tab keeps the fill and the other is dim.
    const tabButton = (value: Tab, label: string) =>
      colorlessButtons ? (
        <Button
          key={`tab-${value}`}
          plain
          label={label}
          {...(current === value ? {} : { dimColor: true })}
          onPress={() => update($, tab, () => value)}
        />
      ) : (
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

    // The pane's own title, which VS Code already draws above it.
    const titled = e.surface === 'vscode'
    const feedback = (
      <Button
        key="feedback"
        plain
        dimColor
        label="✎ Feedback"
        onPress={press => startFeedback($, whereRun(press.surface, press.surface === 'terminal' ? session.paneFullscreen : undefined))}
      />
    )
    const tabs = (
      <Box gap={1}>
        {tabButton('session', `This session ${mine.length}`)}
        {tabButton('all', `All ${list.length}`)}
      </Box>
    )

    const bodyRows = e.props.scroll.bodyRows
    const groups = arrange(shown, await read($, collapsed), headRows(mine.length > 0), bodyRows, cardColumns, confirming, now)
    const at = await read($, scrolled)

    const group = ({ priority, items, isOpen, rows, lastFirst }: (typeof groups)[number], index: number) => {
      const first = fitsRows ? firstCard(at[priority.value], lastFirst) : 0

      return (
        <Box
          key={`priority-${priority.value}`}
          flexDirection="column"
          {...(fitsRows ? { height: rows, overflow: 'hidden' as const } : {})}
          marginTop={index > 0 ? (space?.betweenGroups ?? 1) : 0}
          flexShrink={0}
        >
          <Box
            flexDirection="row"
            flexShrink={0}
            {...(colorlessButtons ? { alignItems: 'center' as const } : {})}
            {...(space && isOpen ? { marginBottom: space.belowHeading } : {})}
          >
            {/* VS Code draws no color inside a Button, and Text cannot be pressed: the
                group's color is a dot beside its name, which is a dim, unfilled Button.
                Both sit directly in this row, no fragment between. */}
            {colorlessButtons && <Text color={VSCODE_COLORS[priority.value]}>● </Text>}
            {colorlessButtons ? (
              <Button
                key={`group-${priority.value}`}
                plain
                dimColor
                label={`${isOpen ? '▾' : '▸'} ${priority.label} ${items.length}`}
                onPress={() => toggleGroup($, priority.value)}
              />
            ) : (
              <Button key={`group-${priority.value}`} plain onPress={() => toggleGroup($, priority.value)}>
                <Text color={priority.color} bold>
                  {isOpen ? '▾' : '▸'} {priority.label} {items.length}
                </Text>
              </Button>
            )}
            {isOpen && first > 0 && <Text dimColor> ↑ {first} above</Text>}
          </Box>
          {isOpen && items.slice(first).map(card)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" {...(fitsRows ? { height: bodyRows, overflow: 'hidden' as const } : {})}>
        {titled ? (
          // VS Code heads the pane with its title already: there Feedback joins the tabs' row.
          <Box justifyContent="space-between" marginBottom={1}>
            {mine.length > 0 ? tabs : <Box />}
            {feedback}
          </Box>
        ) : (
          <>
            <Box justifyContent="space-between" marginBottom={1}>
              <Text bold>Noticed issues{list.length > 0 ? ` ${list.length}` : ''}</Text>
              {feedback}
            </Box>
            {mine.length > 0 && <Box marginBottom={1}>{tabs}</Box>}
          </>
        )}
        {list.length === 0 && <Text dimColor>Nothing noticed in this project.</Text>}
        {/* A folded group keeps its place in the priority order. */}
        {groups.map(group)}
      </Box>
    )
  })
}
