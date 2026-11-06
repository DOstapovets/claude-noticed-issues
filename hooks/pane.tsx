import { atom, read, update } from 'claude-code'
import type { Frozen, MatchedEvent } from 'claude-code'

import type { Issue, Priority, Tab } from '../types'
import { session } from './context'
import type { Api } from './context'
import { createGithubIssue } from './github'
import { age, arrange, cardColumnsOf, clip, DETAIL_LINES, firstCard, headRows, PRIORITIES, rank } from './layout'
import { startFeedback, startSession, whereRun } from './sessions'
import { change, toggleGroup } from './store'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads or writes it, so this module names the atoms it uses; types/index.d.ts
// declares them once.
const issues = atom({ plugin: 'noticed-issues', key: 'issues' } as const, [])
// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'noticed-issues', key: 'collapsed' } as const, [])
// The pane's tab, for this session only.
const tab = atom({ plugin: 'noticed-issues', key: 'tab' } as const, 'all')
// The card whose ✕ asks to confirm, for this session only.
const deleting = atom({ plugin: 'noticed-issues', key: 'deleting' } as const, null)
// Where each open group is scrolled to, for this session only.
const scrolled = atom({ plugin: 'noticed-issues', key: 'scrolled' } as const, {})
// The time the cards' ages are told from, moved on once a minute.
const minute = atom({ plugin: 'noticed-issues', key: 'minute' } as const, 0)

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

// The pane's `ui.render` event, as the hook in register.tsx receives it.
type PaneRender = Frozen<MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>>

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
async function shiftPriority($: Api, id: number, step: -1 | 1) {
  await change($, list =>
    list.map(i => {
      const to = PRIORITIES[rank(i) + step]
      return i.id === id && to ? { ...i, priority: to.value } : i
    }),
  )
}

// What the pane lists: every issue, or this session's on its tab, offered
// only while this session has noted something.
export async function view($: Api) {
  const list = await read($, issues)
  const sessionId = await $.session.id()
  const mine = list.filter(issue => issue.noticedIn === sessionId)
  const current: Tab = mine.length > 0 ? await read($, tab) : 'all'

  return { list, mine, current, shown: current === 'session' ? mine : list }
}

// Off the terminal, a card's padding above and below and the room between its
// lines, in lines; VS Code draws a fraction of one.
const CARD_PADDING_Y = 0.5
const CARD_ROW_GAP = 0.3

async function remove($: Api, id: number) {
  await change($, list => list.filter(i => i.id !== id))
}

async function confirmRemove($: Api, id: number) {
  await update($, deleting, () => null)
  await remove($, id)
}

export async function renderPane($: Api, e: PaneRender) {
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
}
