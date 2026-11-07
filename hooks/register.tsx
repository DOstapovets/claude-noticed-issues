import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Issue, Priority, Rule } from '../types'
import { MINUTE, session } from './context'
import type { Api } from './context'
import { onGithub, refreshGithub } from './github'
import { arrange, cardColumnsOf, clip, count, firstCard, FOOT_ROWS, headRows, LIMITS, PRIORITIES, rank } from './layout'
import { renderPane, view } from './pane'
import { offerSetup, startFeedback, startSetup, whereRun } from './sessions'
import { change, COLLAPSED_KEY, load, loadProjects, migrate, save } from './store'

const PANE = 'noticed-issues'
const TITLE = 'Noticed issues'
const NOTE = 'mcp__noticed-issues__note_issue'
const RESOLVE = 'mcp__noticed-issues__resolve_issue'
const SAVE_RULE = 'mcp__noticed-issues__save_issue_rule'
const RULE_LIMIT = 4000
// Another session of this project (a background one started from the pane)
// may resolve issues; pick its changes up this often.
const RELOAD_MS = 30_000
// Each linked GitHub issue costs one `gh` call, so its status is read less often.
const GITHUB_MS = 5 * 60_000

// The priority groups folded in the pane, the same in every project.
const collapsed = atom({ plugin: 'noticed-issues', key: 'collapsed' } as const, [])
// The card whose ✕ asks to confirm, for this session only.
const deleting = atom({ plugin: 'noticed-issues', key: 'deleting' } as const, null)
// The pane's tab, for this session only.
const tab = atom({ plugin: 'noticed-issues', key: 'tab' } as const, 'all')
// Where each open group is scrolled to, for this session only.
const scrolled = atom({ plugin: 'noticed-issues', key: 'scrolled' } as const, {})
// The time the cards' ages are told from, moved on once a minute: the pane redraws then, not on every tick.
const minute = atom({ plugin: 'noticed-issues', key: 'minute' } as const, 0)
const AGE_MS = 10_000

const openPane = ($: Api) => $.ui.open({ id: PANE, title: TITLE })

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    session.cwd = ran.cwd
    // One list per repository, shared by its worktrees: the main working
    // tree's root names it. Outside a repository the directory does.
    const repo = await $.session.repo()
    session.storeKey = `issues:${repo?.root ?? session.cwd}`
    session.ruleKey = `rule:${repo?.root ?? session.cwd}`
    session.remote = repo?.remote ?? undefined
    session.github = options.github === 'on' || (options.github !== 'off' && onGithub(repo?.remote))
    session.nextId = 1

    if (repo) {
      await migrate($, repo.root)
    }
    const list = await load($)
    await loadProjects($)
    const folded = (await $.store.get(COLLAPSED_KEY)) as Priority[] | undefined
    await update($, collapsed, () => folded ?? [])
    const rule = (await $.store.get(session.ruleKey)) as Rule | undefined
    session.rule = rule?.text

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
    // Left behind ToolSearch: only the setup session calls it.
    await $.tool.register({
      name: 'save_issue_rule',
      description:
        'Save when to note an issue in this repository, as the noticed-issues setup worked it out with the user. ' +
        'It goes into the context of every later session in the repository and replaces the rule saved before.',
      inputSchema: {
        type: 'object',
        properties: { rule: { type: 'string', description: 'The rule, a short Markdown list' } },
        required: ['rule'],
      },
    })
    await $.command.register({
      name: 'issues',
      description:
        "Show this project's noticed issues; `/issues clear` empties the list, `/issues setup` analyzes the repository to write when to note an issue here, `/issues feedback` reports a bug or an idea about this plugin",
      argumentHint: '[clear|setup|feedback]',
    })

    // Kept as read, so ages are not a minute short; written once the minute turns.
    const tick = async () => {
      const now = await $.clock.now()
      if (Math.floor((await read($, minute)) / MINUTE) !== Math.floor(now / MINUTE)) await update($, minute, () => now)
    }
    await tick()
    $.clock.every(AGE_MS, () => void tick())
    // The other projects are read again only while their tab is open: pressing it, and `/issues`, read them too.
    $.clock.every(RELOAD_MS, async () => {
      await load($)
      if ((await read($, tab)) === 'projects') await loadProjects($)
    })
    $.clock.every(GITHUB_MS, () => void refreshGithub($))
    void refreshGithub($)

    if (list.length > 0) {
      void openPane($)
    }

    // Kept as asked before asking, so the setup session, and any other started
    // meanwhile, does not ask again.
    if (e.isInteractive && rule === undefined) {
      const asked: Rule = { askedAt: await $.clock.now() }
      await $.store.set(session.ruleKey, asked)
      void offerSetup($)
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

  on('tool.call', { tool: SAVE_RULE }, async ($, e) => {
    const rule = text((e as unknown as Record<string, unknown>).rule)

    if (rule === undefined) {
      return { result: 'Not saved: `rule` is required.' }
    }

    const stored = (await $.store.get(session.ruleKey)) as Rule | undefined
    const now = await $.clock.now()
    session.rule = clip(rule, RULE_LIMIT)
    const saved: Rule = { askedAt: stored?.askedAt ?? now, text: session.rule, savedAt: now }
    await $.store.set(session.ruleKey, saved)

    const note = rule.length > RULE_LIMIT ? ` (cut to ${RULE_LIMIT} characters)` : ''
    return { result: `Saved the rule${note}; sessions in this repository started from now on carry it.` }
  })

  // The rule rides in the context of each conversation in the repository, once, as the instruction files do.
  on('prompt.context', async (_, e, next) => {
    const ran = await next(e)

    if (session.rule === undefined) {
      return ran
    }

    return {
      ...ran,
      blocks: [
        ...ran.blocks,
        { name: 'noticedIssuesRule', text: `When to note an issue in this repository (noticed-issues):\n${session.rule}` },
      ],
    }
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    if (e.args.trim() === 'setup') {
      const sessionId = await startSetup($)
      return {
        text: sessionId
          ? 'Setup session started in the background: attach to it to go through the rule it drafts.'
          : 'Could not start the setup session.',
      }
    }

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
    await loadProjects($)
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
  // Elsewhere (VS Code, desktop, mobile), and on the list of projects, the groups
  // flow and the pane scrolls whole.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { hasTabs, current, opened, shown } = await view($)

    if (!session.paneOnTerminal || (current === 'projects' && !opened)) {
      return next(e)
    }

    const open = arrange(
      shown,
      await read($, collapsed),
      headRows(hasTabs, opened !== undefined),
      e.bodyRows - FOOT_ROWS,
      cardColumnsOf(session.paneColumns),
      opened ? null : await read($, deleting),
      await read($, minute),
      opened !== undefined,
    ).filter(g => g.isOpen)
    const row = e.pointer?.row
    const target = row === undefined ? open[0] : open.find(g => row >= g.top && row < g.top + g.rows)

    if (target && e.by !== 0) {
      const key = target.priority.value
      await update($, scrolled, was => ({ ...was, [key]: firstCard((was[key] ?? 0) + Math.sign(e.by), target.lastFirst) }))
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e))
}
