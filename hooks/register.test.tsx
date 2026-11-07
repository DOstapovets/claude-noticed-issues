import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, FoundElement } from 'claude-code/testing'

import { wrappedRows } from './layout'

const NOTE = 'mcp__noticed-issues__note_issue'
const RESOLVE = 'mcp__noticed-issues__resolve_issue'

const answer = (ran: { result?: unknown }) => String(ran.result)

const PANE = {
  plugin: 'noticed-issues',
  component: 'Pane',
  requestId: 'noticed-issues',
  props: {
    title: 'Noticed issues',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'noticed-issues',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// Stand in for the engine beneath the plugin.
const engine = (on: On, stored?: Record<string, unknown>) => {
  const clock = mock.clock(on, { now: 1_000 })
  // `$.store`, kept as JSON, as the engine keeps it; a test writes to it as another session would.
  const store = new Map(Object.entries(stored ?? {}).map(([key, value]) => [key, JSON.stringify(value)]))
  const kept = {
    get: (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : undefined),
    set: (key: string, value: unknown) => void store.set(key, JSON.stringify(value)),
  }
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => ({ value: kept.set(e.key, e.value) }))
  on('store.delete', (_, e) => ({ value: void store.delete(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  const seen = {
    clock,
    store: kept,
    toasts: [] as string[],
    opened: 0,
    argv: [] as (readonly string[])[],
    // The repository root `session.repo` answers, and each directory's git common dir.
    repo: null as string | null,
    remote: null as string | null,
    git: {} as Record<string, string>,
    // What `gh issue view` answers, and the URLs it was asked about.
    // A function answers per URL.
    github: { state: 'OPEN', projectItems: [] } as unknown,
    viewed: [] as string[],
    // What `session.id` answers.
    session: 'session-a',
    // What `session.surfaces` answers.
    surfaces: ['terminal'] as string[],
    // What `claude --bg` and `gh issue create` wait for before they answer.
    hold: undefined as Promise<void> | undefined,
    // The questions `$.ui.ask` put, and the label the user picks; null dismisses the dialog.
    asked: [] as string[],
    choice: 'Not now' as string | null,
  }
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const questions = (e as unknown as { questions: { question: string }[] }).questions
    const question = questions[0]?.question ?? ''
    seen.asked.push(question)
    if (seen.choice === null) throw new Error('dismissed')
    return { result: { questions, answers: { [question]: seen.choice } } }
  })
  // The engine's own band, which the count must not replace.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => {
    seen.opened += 1
    return { value: { isPlaced: true as const } }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__noticed-issues__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))
  on('session.id', () => ({ value: seen.session }))
  on('session.surfaces', () => ({ value: seen.surfaces as never }))
  on('session.repo', () => ({
    value: seen.repo === null ? null : { root: seen.repo, remote: seen.remote, internal: false, name: null },
  }))
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'git') {
      const dir = seen.git[e.argv[2] ?? '']
      return {
        value: {
          exitCode: dir ? 0 : 128,
          stdout: dir ? `${dir}\n` : '',
          stderr: dir ? '' : 'fatal: cannot change to directory',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (e.argv[0] === 'gh' && e.argv[2] === 'view') {
      seen.viewed.push(e.argv[3] ?? '')
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify(
            typeof seen.github === 'function' ? seen.github(e.argv[3]) : seen.github,
          ),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    seen.argv.push(e.argv)
    await seen.hold
    return {
      value: {
        exitCode: 0,
        stdout:
          e.argv[0] === 'gh'
            ? 'Creating issue in o/r\n\nhttps://github.com/o/r/issues/42\n'
            : 'Started background session 4b7cb777\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return seen
}

// The count the band above the prompt shows, if any; the band beneath stays.
const flag = async ($: Engine) => {
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const found = await band.find({ key: 'open-issues' })
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await band.unmount()

  return found?.text
}

// The pane's group headings and card headings, in the order drawn; a card's as
// `#<id> <its heading's text>`, the GitHub link and status included.
const lines = async (ui: { findAll: (query: object) => Promise<{ type: string; key?: string; text: string }[]> }) =>
  (await ui.findAll({})).flatMap(el =>
    el.type === 'Text' && /^[▾▸] /.test(el.text)
      ? [el.text]
      : el.key?.startsWith('head-')
        ? [el.text.replace(/^(#\d+) ?/, '$1 ')]
        : [],
  )

// A drawn element's children that are elements, not strings.
const kids = (el: FoundElement | undefined) =>
  (el?.children ?? []).filter((c): c is FoundElement => typeof c === 'object' && c !== null)

const start = (cwd: string) => ({ cwd, surface: 'terminal' as const, isInteractive: true })

test('issues are noted, deleted, resolved and kept per project', async ($, on) => {
  const seen = engine(on)

  await $.session.start(start('/proj/a'))
  expect(await flag($)).toBeUndefined()
  expect(seen.opened).toBe(0)

  const first = await $.tool.call({ tool: NOTE, title: 'JWT in settings.local.json', file: '.claude/settings.local.json' })
  expect(answer(first)).toContain('#1')
  expect(seen.opened).toBe(1)
  await $.tool.call({ tool: NOTE, title: 'Jest gate red on master', detail: 'since 2026-08-26' })
  const dup = await $.tool.call({ tool: NOTE, title: 'jest gate red on master' })
  expect(answer(dup)).toContain('Already on the list as #2')
  expect(await flag($)).toBe('⚑ 2 issues · 2 this session')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'JWT in settings.local.json' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'since 2026-08-26' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'delete-1' })
  await ui.press({ key: 'confirm-delete-1' })
  await ui.unmount()
  expect(await flag($)).toBe('⚑ 1 issue · 1 this session')

  await $.tool.call({ tool: RESOLVE, id: 2 })
  expect(await flag($)).toBeUndefined()

  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })

  // Another project starts empty; the first one's list comes back, and the
  // pane opens by itself when there is something on it.
  await $.session.start(start('/proj/b'))
  expect(await flag($)).toBeUndefined()
  const opened = seen.opened
  await $.session.start(start('/proj/a'))
  expect(await flag($)).toBe('⚑ 1 issue · 1 this session')
  expect(seen.opened).toBe(opened + 1)

  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(back)).toContain('#3 Stale playwright cache')
  await back.unmount()

  const cleared = await $.command.run({
    command: 'issues',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(cleared.text).toContain('cleared')
  expect(await flag($)).toBeUndefined()
})

test('a change in the pane keeps what another session noted meanwhile', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })
  await $.tool.call({ tool: NOTE, title: 'Jest gate red on master' })
  // Another session notes one more, before this one reloads the list.
  const elsewhere = (title: string) => {
    const was = seen.store.get('issues:/proj/a')
    seen.store.set('issues:/proj/a', {
      nextId: was.nextId + 1,
      items: [...was.items, { id: was.nextId, title, createdAt: 1 }],
    })
  }

  elsewhere('Lockfile out of date')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'lower-2' })
  elsewhere('Flaky e2e login')
  await ui.press({ key: 'delete-1' })
  await ui.press({ key: 'confirm-delete-1' })
  await ui.unmount()

  const kept = seen.store.get('issues:/proj/a')
  expect(kept.items.map((i: { id: number }) => i.id)).toEqual([2, 3, 4])
  expect(kept.nextId).toBe(5)
  expect(await flag($)).toBe('⚑ 3 issues · 1 this session')
  // The next one gets a number of its own, so resolving #3 resolves the one noted elsewhere.
  expect(answer(await $.tool.call({ tool: NOTE, title: 'Dead link in README' }))).toContain('#5')
  expect(answer(await $.tool.call({ tool: RESOLVE, id: 3 }))).toBe('Resolved #3.')
  expect(seen.store.get('issues:/proj/a').items.map((i: { title: string }) => i.title)).toEqual([
    'Jest gate red on master',
    'Flaky e2e login',
    'Dead link in README',
  ])
})

test('an issue is resolved only by its number', async ($, on) => {
  engine(on, { 'issues:/proj/a': { nextId: 2, items: 'not a list' } })
  await $.session.start(start('/proj/a'))
  expect(await flag($)).toBeUndefined()
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })

  for (const id of ['first', undefined, 1.5]) {
    expect(answer(await $.tool.call({ tool: RESOLVE, id }))).toBe('Not resolved: `id` must be an issue number.')
  }
  expect(await flag($)).toBe('⚑ 1 issue · 1 this session')
})

test('the count above the prompt opens the pane', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })
  const opened = seen.opened

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'open-issues' })
    await band.unmount()
  }

  expect(seen.opened).toBe(opened + 2)
})

test('a background session is started for an issue', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache', file: '~/.claude/plugins/cache' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'session-1' })
  expect(seen.argv).toHaveLength(1)
  expect(seen.argv[0]?.slice(0, 2)).toEqual(['claude', '--bg'])
  expect(seen.argv[0]?.[2]).toContain('Fix noticed issue #1: Stale playwright cache')
  expect(seen.argv[0]?.[2]).toContain('resolve_issue with id 1')
  expect(seen.toasts.at(-1)).toContain('claude attach 4b7cb777')
  await ui.unmount()

  // Started once: the pane now shows the session instead of the button.
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: '▶ 4b7cb777' })).toBeDefined()
  await after.unmount()
})

const GITHUB_ON = { options: { github: 'on' } }

test('a GitHub issue is created for an issue', GITHUB_ON, async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache', detail: 'cache is 2 GB', file: '~/.cache/ms-playwright' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'github-1' })
  expect(seen.argv).toHaveLength(1)
  expect(seen.argv[0]?.slice(0, 5)).toEqual(['gh', 'issue', 'create', '--title', 'Stale playwright cache'])
  expect(seen.argv[0]?.[6]).toContain('cache is 2 GB')
  expect(seen.argv[0]?.[6]).toContain('~/.cache/ms-playwright')
  expect(seen.toasts.at(-1)).toContain('https://github.com/o/r/issues/42')
  await ui.unmount()

  // The pane now links the issue instead of offering the button.
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ key: 'github-1' })).toBeUndefined()
  expect(await after.find({ type: 'Link', text: /↗ #42/ })).toBeDefined()
  await after.press({ key: 'session-1' })
  await after.unmount()
  expect(seen.argv.at(-1)?.[2]).toContain('GitHub issue: https://github.com/o/r/issues/42')
})

test('the GitHub issue\'s board column is shown, and a closed one is removed', GITHUB_ON, async ($, on) => {
  const seen = engine(on, {
    'issues:/proj/a': {
      nextId: 4,
      items: [
        { id: 1, title: 'Linked', createdAt: 1, githubUrl: 'https://github.com/o/r/issues/7' },
        { id: 2, title: 'Not linked', createdAt: 1 },
        { id: 3, title: 'Linked too', createdAt: 1, githubUrl: 'https://github.com/o/r/issues/8' },
      ],
    },
  })
  seen.github = { state: 'OPEN', projectItems: [{ status: { name: '📋 To do' }, title: 'Roadmap' }] }

  // Read at session start, only for the issues that have a GitHub link.
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(seen.viewed).toEqual(['https://github.com/o/r/issues/7', 'https://github.com/o/r/issues/8'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The link and its status sit in the card's heading, after the number.
  expect((await lines(ui)).find(line => line.startsWith('#1 '))).toMatch(/^#1 ↗ #7 · open · 📋 To do/)
  await ui.unmount()

  // Closed on GitHub, as not planned: gone on the next pass, here the one `/issues` starts.
  seen.github = (url: string) =>
    url.endsWith('/7') ? { state: 'CLOSED', projectItems: [] } : { state: 'OPEN', projectItems: [] }
  await $.command.run({
    command: 'issues',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await seen.clock.settle()
  expect(await flag($)).toBe('⚑ 2 issues')
  expect(seen.toasts.at(-1)).toContain('#1')

  // And by itself every five minutes: the other one closed as done.
  seen.github = { state: 'CLOSED', projectItems: [{ status: { name: '✅ Done' }, title: 'Roadmap' }] }
  await seen.clock.advance(5 * 60_000)
  expect(await flag($)).toBe('⚑ 1 issue')
  expect(seen.toasts.at(-1)).toContain('#3')
  const later = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(later)).toEqual(['▾ Medium 1', '#2 Not linked'])
  await later.unmount()
})

test('an odd answer from gh skips that issue and later passes still read it', GITHUB_ON, async ($, on) => {
  const seen = engine(on, {
    'issues:/proj/a': {
      nextId: 2,
      items: [{ id: 1, title: 'Linked', createdAt: 1, githubUrl: 'https://github.com/o/r/issues/7' }],
    },
  })
  // Valid JSON, but not the shape asked for.
  seen.github = { state: 'OPEN' }
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(seen.viewed).toHaveLength(1)
  expect(await flag($)).toBe('⚑ 1 issue')

  seen.github = { state: 'OPEN', projectItems: [{ status: { name: '📋 To do' }, title: 'Roadmap' }] }
  await seen.clock.advance(5 * 60_000)
  expect(seen.viewed).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await lines(ui)).find(line => line.startsWith('#1 '))).toMatch(/^#1 ↗ #7 · open · 📋 To do/)
  await ui.unmount()
})

test('a second press of ▶ while the first is starting starts no second session', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })

  // `claude --bg` answers only once released.
  let release = () => {}
  seen.hold = new Promise<void>(resolve => (release = resolve))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = ui.press({ key: 'session-1' })
  const second = ui.press({ key: 'session-1' })
  release()
  await Promise.all([first, second])
  expect(seen.argv).toHaveLength(1)
  await ui.unmount()
})

test('auto offers GitHub only where origin is on github.com', async ($, on) => {
  const seen = engine(on, {
    'issues:/repo': {
      nextId: 3,
      items: [
        { id: 1, title: 'Linked', createdAt: 1, githubUrl: 'https://github.com/o/r/issues/7' },
        { id: 2, title: 'Not linked', createdAt: 1 },
      ],
    },
  })
  seen.repo = '/repo'

  const offered = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const button = await ui.find({ key: 'github-2' })
    // A link made earlier stays whatever the setting.
    expect(await ui.find({ type: 'Link', text: /↗ #7/ })).toBeDefined()
    await ui.unmount()
    return button !== undefined
  }

  for (const remote of ['git@github.com:o/r.git', 'https://github.com/o/r', 'ssh://git@ssh.github.com:443/o/r.git']) {
    seen.remote = remote
    await $.session.start(start('/repo'))
    expect(await offered()).toBe(true)
  }

  seen.viewed = []
  for (const remote of ['git@gitlab.com:o/r.git', 'https://github.com.evil.example/o/r', null]) {
    seen.remote = remote
    await $.session.start(start('/repo'))
    await seen.clock.settle()
    expect(await offered()).toBe(false)
  }
  // Nor is a status read where GitHub is not on.
  expect(seen.viewed).toEqual([])
})

test('github: on offers it on any remote', GITHUB_ON, async ($, on) => {
  const seen = engine(on)
  seen.repo = '/repo'
  seen.remote = 'git@github.example.com:o/r.git'
  await $.session.start(start('/repo'))
  await $.tool.call({ tool: NOTE, title: 'Enterprise' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'github-1' })).toBeDefined()
  await ui.unmount()
})

test('github: off hides it even on github.com', { options: { github: 'off' } }, async ($, on) => {
  const seen = engine(on, {
    'issues:/repo': { nextId: 2, items: [{ id: 1, title: 'Linked', createdAt: 1, githubUrl: 'https://github.com/o/r/issues/7' }] },
  })
  seen.repo = '/repo'
  seen.remote = 'git@github.com:o/r.git'
  await $.session.start(start('/repo'))
  await seen.clock.advance(5 * 60_000)
  expect(seen.viewed).toEqual([])
  await $.tool.call({ tool: NOTE, title: 'Not linked' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'github-2' })).toBeUndefined()
  await ui.unmount()
})

test('issues are grouped by priority, highest first, and moved between groups', async ($, on) => {
  engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Typo in footer', priority: 'low' })
  await $.tool.call({ tool: NOTE, title: 'Stale doc' })
  await $.tool.call({ tool: NOTE, title: 'Leaked key', priority: 'high' })
  await $.tool.call({ tool: NOTE, title: 'Odd priority', priority: 'urgent' })

  // The order the groups and their issues are drawn in.
  const order = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const drawn = await lines(ui)
    await ui.unmount()
    return drawn
  }

  // No priority, or one it does not know, is medium; newest first within a group.
  expect(await order()).toEqual([
    '▾ High 1',
    '#3 Leaked key',
    '▾ Medium 2',
    '#4 Odd priority',
    '#2 Stale doc',
    '▾ Low 1',
    '#1 Typo in footer',
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The arrows are drawn hidden, one row of them per card: the card's hover shows them,
  // which the test kit does not draw.
  expect((await ui.findAll({ type: 'Box' })).filter(el => el.props.display === 'none')).toHaveLength(4)
  // Each end has only the button that leaves it.
  expect(await ui.find({ key: 'raise-3' })).toBeUndefined()
  expect(await ui.find({ key: 'lower-1' })).toBeUndefined()
  await ui.press({ key: 'raise-1' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await again.press({ key: 'raise-2' })
  await again.unmount()

  expect(await order()).toEqual([
    '▾ High 2',
    '#3 Leaked key',
    '#2 Stale doc',
    '▾ Medium 2',
    '#4 Odd priority',
    '#1 Typo in footer',
  ])
})

test('a priority group folds in its place, and stays folded', async ($, on) => {
  engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Leaked key', priority: 'high' })
  await $.tool.call({ tool: NOTE, title: 'Stale doc' })
  await $.tool.call({ tool: NOTE, title: 'Typo in footer', priority: 'low' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'group-high' })
  expect(await lines(ui)).toEqual(['▸ High 1', '▾ Medium 1', '#2 Stale doc', '▾ Low 1', '#3 Typo in footer'])
  // An open group takes what its cards need, its heading and a card of five rows;
  // a folded one only its heading.
  expect((await ui.find({ key: 'priority-medium' }))?.props.height).toBe(6)
  expect((await ui.find({ key: 'priority-low' }))?.props.height).toBe(6)
  expect((await ui.find({ key: 'priority-high' }))?.props.height).toBe(1)
  await ui.press({ key: 'group-medium' })
  expect(await lines(ui)).toEqual(['▸ High 1', '▸ Medium 1', '▾ Low 1', '#3 Typo in footer'])
  await ui.unmount()

  // Kept for the next session, in another project too.
  await $.session.start(start('/proj/b'))
  await $.tool.call({ tool: NOTE, title: 'Other project', priority: 'high' })
  const other = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(other)).toEqual(['▸ High 1'])
  await other.press({ key: 'group-high' })
  expect(await lines(other)).toEqual(['▾ High 1', '#1 Other project'])
  await other.unmount()
})

test('tabs show every issue or only those this session noted, once it has noted one', async ($, on) => {
  const seen = engine(on, {
    'issues:/proj/a': {
      nextId: 3,
      items: [
        { id: 1, title: 'From before', createdAt: 1 },
        { id: 2, title: 'Other session', createdAt: 1, noticedIn: 'session-z' },
      ],
    },
  })
  await $.session.start(start('/proj/a'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab-all' })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: NOTE, title: 'Noted here', priority: 'high' })
  const tabs = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tabs.find({ key: 'tab-all' }))?.text.trim()).toBe('All 3')
  expect((await tabs.find({ key: 'tab-session' }))?.text.trim()).toBe('This session 1')
  // The current tab is filled, the other drawn in the accent color on the pane's background.
  expect((await tabs.find({ type: 'Text', text: ' All 3 ' }))?.props.backgroundColor).toBe('claude')
  expect((await tabs.find({ type: 'Text', text: ' This session 1 ' }))?.props.backgroundColor).toBeUndefined()
  // This session's tab comes first.
  expect((await tabs.findAll({})).flatMap(el => (el.key?.startsWith('tab-') ? [el.key] : []))).toEqual([
    'tab-session',
    'tab-all',
  ])
  expect(await lines(tabs)).toEqual(['▾ High 1', '#3 Noted here', '▾ Medium 2', '#2 Other session', '#1 From before'])
  await tabs.press({ key: 'tab-session' })
  expect(await lines(tabs)).toEqual(['▾ High 1', '#3 Noted here'])
  expect((await tabs.find({ type: 'Text', text: ' This session 1 ' }))?.props.backgroundColor).toBe('claude')
  await tabs.press({ key: 'tab-all' })
  expect(await lines(tabs)).toHaveLength(5)
  await tabs.press({ key: 'tab-session' })
  await tabs.unmount()

  // Its last issue resolved, the session tab goes and the pane shows them all.
  await $.tool.call({ tool: RESOLVE, id: 3 })
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ key: 'tab-session' })).toBeUndefined()
  expect(await lines(after)).toEqual(['▾ Medium 2', '#2 Other session', '#1 From before'])
  await after.unmount()

  // To another session, an issue noted here is one of the rest.
  await $.tool.call({ tool: NOTE, title: 'Noted here too' })
  expect(await flag($)).toBe('⚑ 3 issues · 1 this session')
  seen.session = 'session-b'
  expect(await flag($)).toBe('⚑ 3 issues')
  const other = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await other.find({ key: 'tab-session' })).toBeUndefined()
  await other.unmount()
})

test('a list keeps its repository\'s remote and when it last changed', async ($, on) => {
  const seen = engine(on)
  seen.repo = '/repo'
  seen.remote = 'git@github.com:o/r.git'
  await $.session.start(start('/repo'))
  await $.tool.call({ tool: NOTE, title: 'Stale playwright cache' })

  expect(seen.store.get('issues:/repo')).toMatchObject({ remote: 'git@github.com:o/r.git', updatedAt: 1_000 })
})

test('the Projects tab lists the other projects and opens one read only', async ($, on) => {
  const seen = engine(on, {
    'issues:/proj/a': { nextId: 2, items: [{ id: 1, title: 'Here', createdAt: 1 }] },
    'issues:/proj/c': { nextId: 2, items: [], updatedAt: 900 },
    'issues:/proj/b': {
      nextId: 3,
      remote: 'git@github.com:o/b.git',
      updatedAt: 500,
      items: [
        { id: 1, title: 'Leak in b', createdAt: 1, priority: 'high' },
        { id: 2, title: 'Doc in b', createdAt: 2 },
      ],
    },
    collapsed: [],
  })
  await $.session.start(start('/proj/a'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab-session' })).toBeUndefined()
  // In the footer, with Feedback at its right, without a count, in a secondary color: no tabs' row above.
  expect((await ui.find({ key: 'tab-projects' }))?.text.trim()).toBe('Projects')
  expect((await ui.find({ type: 'Text', text: ' Projects ' }))?.props.color).toBe('subtle')
  expect((await ui.findAll({})).flatMap(el => (el.key?.startsWith('tab-') ? [el.key] : []))).toEqual(['tab-projects'])
  expect((await ui.find({ key: 'footer' }))?.text).toMatch(/^ Projects .*✎ Feedback$/)
  // Drawn last, below the groups and a space that keeps it at the pane's bottom edge.
  const drawn = await ui.findAll({})
  expect(drawn.filter(el => el.key).at(-1)?.key).toBe('feedback')
  expect(drawn.slice(0, drawn.findIndex(el => el.key === 'footer')).at(-1)?.props.flexGrow).toBe(1)
  expect(await lines(ui)).toEqual(['▾ Medium 1', '#1 Here'])

  // This project first, marked; then those with issues, named from the remote where there is one.
  await ui.press({ key: 'tab-projects' })
  expect((await ui.find({ type: 'Text', text: ' Projects ' }))?.props.backgroundColor).toBe('subtle')
  const rows = async () =>
    (await ui.findAll({})).flatMap(el => (el.key?.startsWith('project-/') && el.key !== 'project-/proj/a' ? [el.text] : []))
  expect((await ui.find({ key: 'project-/proj/a' }))?.text).toBe('a /proj/a● 1this project')
  expect((await ui.findAll({})).find(el => el.key?.startsWith('project-'))?.key).toBe('project-/proj/a')
  expect(await rows()).toEqual([
    expect.stringMatching(/^o\/b \/proj\/b● 1● 1just now$/),
    expect.stringMatching(/^c \/proj\/c.*no issues.*just now$/),
  ])
  expect(await lines(ui)).toEqual([])
  // The list of projects is not cut to the pane's rows: the pane scrolls it whole.
  expect((await ui.findAll({})).find(el => el.type === 'Box')?.props.height).toBeUndefined()

  // Its cards have no controls: only when each was noted.
  await ui.press({ key: 'open-/proj/b' })
  expect(await lines(ui)).toEqual(['▾ High 1', '#1 Leak in b', '▾ Medium 1', '#2 Doc in b'])
  expect((await ui.find({ key: 'project-head' }))?.text).toMatch(/← Projects.*o\/b.*\/proj\/b/)
  for (const key of ['delete-1', 'session-1', 'raise-2', 'lower-1']) expect(await ui.find({ key })).toBeUndefined()
  // Its title, and the border's two rows and the blank row below: no row of controls.
  expect((await ui.find({ key: 'priority-high' }))?.props.height).toBe(5)

  await ui.press({ key: 'projects-back' })
  expect(await rows()).toHaveLength(2)
  // This project's row leads back to its own list.
  await ui.press({ key: 'open-/proj/a' })
  expect(await lines(ui)).toEqual(['▾ Medium 1', '#1 Here'])

  // Another session's change shows when the tab is opened again.
  seen.store.set('issues:/proj/c', { nextId: 2, items: [{ id: 1, title: 'New in c', createdAt: 950 }], updatedAt: 950 })
  await ui.press({ key: 'tab-projects' })
  expect((await rows())[0]).toMatch(/^c \/proj\/c.*● 1/)
  await ui.unmount()

  // Off the terminal the same rows lead to the same read-only cards.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const other = await $.ui.mount({ ...PANE, surface })
    expect(await other.find({ key: 'open-/proj/b' })).toBeDefined()
    await other.press({ key: 'open-/proj/b' })
    expect((await lines(other)).filter(line => line.startsWith('#'))).toEqual(['#1 Leak in b', '#2 Doc in b'])
    expect(await other.find({ key: 'delete-1' })).toBeUndefined()
    await other.press({ key: 'projects-back' })
    await other.unmount()
  }

  // In VS Code, which fills a Button around all it holds, each project is a card:
  // its name a dim chip, the counts beside it, its directory on a line below.
  const vscode = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const card = await vscode.find({ key: 'project-/proj/b' })
  expect(card?.props.borderStyle).toBe('round')
  expect(card?.props.flexDirection).toBe('column')
  expect(card?.text).toBe('o/b● 1● 1just now/proj/b')
  expect(await vscode.find({ type: 'Text', text: '/proj/b' })).toMatchObject({ props: { wrap: 'truncate-middle' } })
  expect(await vscode.find({ key: 'open-/proj/b' })).toMatchObject({ text: 'o/b', props: { dimColor: true } })
  expect((await vscode.find({ key: 'project-/proj/a' }))?.text).toBe('a● 1this project/proj/a')
  await vscode.press({ key: 'open-/proj/b' })
  expect((await vscode.find({ key: 'projects-back' }))?.props.dimColor).toBe(true)
  await vscode.unmount()
})

test('each open group scrolls its cards under a heading that stays put', async ($, on) => {
  engine(on)
  await $.session.start(start('/proj/a'))
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await $.tool.call({ tool: NOTE, title: `Leak ${n}`, priority: 'high' })
  for (const n of [1, 2]) await $.tool.call({ tool: NOTE, title: `Doc ${n}` })

  // The pane never outgrows its 40 rows, so the engine has nothing to scroll. Between
  // the heading and the tabs above and the footer below, 34 rows, one of them blank
  // between the groups: Medium needs 11 and gets them, High the other 22.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'priority-medium' }))?.props.height).toBe(11)
  expect((await ui.find({ key: 'priority-medium' }))?.props.marginTop).toBe(1)
  expect((await ui.find({ key: 'priority-high' }))?.props.height).toBe(22)
  expect((await ui.find({ key: 'priority-high' }))?.props.marginTop).toBe(0)
  const scroll = (by: number, row?: number) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'noticed-issues',
      offset: 0,
      by,
      bodyRows: 40,
      contentRows: 40,
      origin: { kind: 'person' },
      ...(row === undefined ? {} : { pointer: { column: 10, row } }),
    } as never)
  const high = async () => (await lines(ui)).filter(line => line.startsWith('#') && line.includes('Leak'))

  // Rows 4 to 25 are High's, 27 to 37 Medium's; a tick moves one card.
  expect((await high())[0]).toBe('#8 Leak 8')
  await scroll(1, 10)
  expect((await high())[0]).toBe('#7 Leak 7')
  expect(await ui.find({ type: 'Text', text: / ↑ 1 above/ })).toBeDefined()
  await scroll(3, 10)
  expect((await high())[0]).toBe('#6 Leak 6')
  // No further than the view that shows the last card: 4 cards of 5 rows fit in 21.
  for (let i = 0; i < 6; i += 1) await scroll(1, 10)
  expect((await high())[0]).toBe('#4 Leak 4')
  // Medium shows all its cards, so it does not scroll.
  await scroll(1, 35)
  expect((await lines(ui)).slice(-3)).toEqual(['▾ Medium 2', '#10 Doc 2', '#9 Doc 1'])
  // The scroll keys, with no pointer, move the first open group, never above its first card.
  for (let i = 0; i < 6; i += 1) await scroll(-1)
  expect((await high())[0]).toBe('#8 Leak 8')
  await ui.unmount()
})

test('off the terminal the groups flow at their own height and the pane scrolls whole', async ($, on) => {
  engine(on)
  // Beneath the plugin, the surface's own scroll: whether the pane's ask reached it.
  let passed = 0
  on('ui.scroll', () => {
    passed += 1
    return {}
  })
  await $.session.start(start('/proj/a'))
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await $.tool.call({ tool: NOTE, title: `Leak ${n}`, priority: 'high' })
  for (const n of [1, 2]) await $.tool.call({ tool: NOTE, title: `Doc ${n}` })

  const scroll = () =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'noticed-issues',
      offset: 0,
      by: 1,
      bodyRows: 40,
      contentRows: 80,
      origin: { kind: 'person' },
      pointer: { column: 10, row: 10 },
    } as never)

  for (const surface of ['vscode', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const priority of ['high', 'medium']) {
      const group = await ui.find({ key: `priority-${priority}` })
      expect(group?.props.height).toBeUndefined()
      expect(group?.props.overflow).toBeUndefined()
    }
    // Every card is drawn, none scrolled out of its group.
    expect((await lines(ui)).filter(line => line.startsWith('#'))).toHaveLength(10)
    // VS Code draws no hover and a phone has no pointer: the priority arrows always show there.
    // More room inside a card than the terminal's whole rows allow.
    const card = await ui.find({ key: 'issue-1' })
    expect(card?.props.paddingY).toBeGreaterThan(0)
    expect(card?.props.rowGap).toBeGreaterThan(0)
    const hidden = (await ui.findAll({ type: 'Box' })).filter(box => box.props.display === 'none')
    expect(hidden).toHaveLength(surface === 'desktop' ? 10 : 0)
    // In VS Code, which draws no color inside a Button, the group's name is a dim
    // Button and its color a dot beside it.
    const heading = await ui.find({ key: 'group-high' })
    expect(heading?.text).toBe('▾ High 8')
    expect(heading?.props.dimColor).toBe(surface === 'vscode' ? true : undefined)
    const dots = (await ui.findAll({ type: 'Text', text: /^●/ })).map(dot => dot.props.color)
    expect(dots).toEqual(surface === 'vscode' ? ['red', 'yellow'] : [])
    // VS Code draws the pane's title itself: there is no heading of the plugin's, Feedback, in the footer, still is.
    expect(await ui.find({ type: 'Text', text: /^Noticed issues/ })).toEqual(surface === 'vscode' ? undefined : expect.anything())
    expect((await ui.find({ key: 'footer' }))?.text).toMatch(/✎ Feedback$/)
    // In VS Code the corner's age, ✕ and, once asked, Delete? ✓ ↩ are a character apart.
    const corner = async () => kids(kids(await ui.find({ key: 'issue-8' }))[0]).find(c => 'marginLeft' in c.props)
    expect((await corner())?.props.columnGap).toBe(surface === 'vscode' ? 1 : undefined)
    await ui.press({ key: 'delete-8' })
    expect((await corner())?.props.columnGap).toBe(surface === 'vscode' ? 1 : undefined)
    await ui.press({ key: 'cancel-delete-8' })
    // In VS Code, which fills every Button alike, the tab not shown is dim.
    if (surface === 'vscode') {
      expect((await ui.find({ key: 'tab-all' }))?.props.dimColor).toBeUndefined()
      expect((await ui.find({ key: 'tab-session' }))?.props.dimColor).toBe(true)
    }
    // A long title wraps in its own column, the age and ✕ kept in the corner: VS Code wraps rows by default.
    expect(kids(await ui.find({ key: 'issue-8' }))[0]?.props.flexWrap).toBe(surface === 'vscode' ? 'nowrap' : undefined)
    // VS Code's spacing: the cards stand in under the heading, with room above and between them.
    const first = await ui.find({ key: 'issue-8' })
    expect(first?.props.marginLeft).toBe(surface === 'vscode' ? 2 : undefined)
    expect(first?.props.marginBottom).toBe(surface === 'vscode' ? 0.75 : 1)
    expect((await ui.find({ key: 'priority-medium' }))?.props.marginTop).toBe(surface === 'vscode' ? 0.5 : 1)
    await ui.press({ key: 'group-high' })
    expect(await ui.find({ key: 'issue-1' })).toBeUndefined()
    await ui.press({ key: 'group-high' })
    // In VS Code, which drops their colors, the arrows are dim.
    expect((await ui.find({ key: 'lower-1' }))?.props.dimColor).toBe(surface === 'vscode' ? true : undefined)
    expect(await ui.find({ type: 'Text', text: /above/ })).toBeUndefined()
    const before = passed
    await scroll()
    expect(passed).toBe(before + 1)
    await ui.unmount()
  }

  // Back on the terminal the groups keep their rows and scroll inside them.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'priority-high' }))?.props.height).toBe(22)
  expect((await ui.find({ key: 'issue-1' }))?.props.paddingY).toBeUndefined()
  const before = passed
  await scroll()
  expect(passed).toBe(before)
  expect(await ui.find({ type: 'Text', text: / ↑ 1 above/ })).toBeDefined()
  await ui.unmount()
})

test('a card says when it was noted, newest first in its group', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Older' })
  await seen.clock.advance(2 * 60 * 60_000)
  await $.tool.call({ tool: NOTE, title: 'Newer' })

  const ages = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The ages as drawn, the newer card's first.
    const [newer, older] = (await ui.findAll({ type: 'Text' }))
      .map(el => el.text.trim())
      .filter(text => /^(just now|\d+[mh] ago|\d\d\.\d\d.* \d\d:\d\d)$/.test(text))
    const drawn = { order: (await lines(ui)).slice(1), older, newer }
    await ui.unmount()
    return drawn
  }

  expect(await ages()).toEqual({ order: ['#2 Newer', '#1 Older'], older: '2h ago', newer: 'just now' })
  // Told again as the minutes pass.
  await seen.clock.advance(5 * 60_000)
  expect((await ages()).newer).toBe('5m ago')
  // After a day, the date and time it was noted.
  for (let hour = 0; hour < 24; hour += 1) await seen.clock.advance(60 * 60_000)
  const noted = new Date(1_000)
  const two = (n: number) => String(n).padStart(2, '0')
  expect((await ages()).older).toBe(`${two(noted.getDate())}.${two(noted.getMonth() + 1)} ${two(noted.getHours())}:${two(noted.getMinutes())}`)
})

test('the red ✕ in a card\'s corner asks once before it deletes', async ($, on) => {
  engine(on)
  await $.session.start(start('/proj/a'))
  await $.tool.call({ tool: NOTE, title: 'Stale doc' })
  await $.tool.call({ tool: NOTE, title: 'Typo in footer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cross = await ui.find({ key: 'delete-1' })
  expect(cross?.text.trim()).toBe('✕')
  expect((await ui.find({ type: 'Text', text: ' ✕ ' }))?.props.color).toBe('error')
  expect(await ui.find({ key: 'confirm-delete-1' })).toBeUndefined()

  // The first press only asks, and only on that card.
  await ui.press({ key: 'delete-1' })
  expect(await ui.find({ type: 'Text', text: 'Delete?' })).toBeDefined()
  expect(await ui.find({ key: 'confirm-delete-2' })).toBeUndefined()
  expect(await flag($)).toBe('⚑ 2 issues · 2 this session')

  // ↩ takes it back; ✓ deletes.
  await ui.press({ key: 'cancel-delete-1' })
  expect(await ui.find({ key: 'confirm-delete-1' })).toBeUndefined()
  expect(await flag($)).toBe('⚑ 2 issues · 2 this session')
  await ui.press({ key: 'delete-1' })
  await ui.press({ key: 'confirm-delete-1' })
  expect(await flag($)).toBe('⚑ 1 issue · 1 this session')
  expect(await lines(ui)).toEqual(['▾ Medium 1', '#2 Typo in footer'])
  await ui.unmount()
})

test('a long detail is cut to three card lines, the file kept on a line of its own', async ($, on) => {
  engine(on)
  await $.session.start(start('/proj/a'))
  const detail = 'word '.repeat(100).trim()
  await $.tool.call({ tool: NOTE, title: 'Long', detail, file: 'specs/a/very/long/path/to/some.spec.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cut = await ui.find({ type: 'Text', text: /^word/ })
  // The pane is 60 columns, the card's text 56 of them: three rows of eleven
  // words, the last one ending in `…`.
  expect(cut?.text.split(' ').length).toBe(33)
  expect(wrappedRows(cut!.text, 56)).toBe(3)
  expect(cut?.text.endsWith('word…')).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'specs/a/very/long/path/to/some.spec.js' }))?.props.wrap).toBe('truncate-middle')
  await ui.unmount()
})

test('a very long note is stored cut, and the answer says so', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  const title = 't'.repeat(300)
  const long = await $.tool.call({ tool: NOTE, title, detail: 'd'.repeat(10_000), file: 'f'.repeat(600) })
  expect(answer(long)).toBe(
    'Noted as #1 (title cut to 200 characters, detail cut to 4000 characters, file cut to 500 characters); ' +
      'the user sees it under /issues.',
  )

  // What was kept, as the fix session is told it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'session-1' })
  await ui.unmount()
  expect(seen.argv.at(-1)?.[2]?.split('\n').slice(0, 3)).toEqual([
    `Fix noticed issue #1: ${'t'.repeat(199)}…`,
    `Where: ${'f'.repeat(499)}…`,
    `Detail: ${'d'.repeat(3999)}…`,
  ])

  // The same title, whatever follows past the cut, is the same entry.
  const dup = await $.tool.call({ tool: NOTE, title: `${title}, again` })
  expect(answer(dup)).toBe('Already on the list as #1.')

  const short = await $.tool.call({ tool: NOTE, title: 'Short', detail: 'd'.repeat(4000) })
  expect(answer(short)).toBe('Noted as #2; the user sees it under /issues.')
})

test('Feedback starts a session that interviews the user and posts only once they confirm', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))

  // In the pane's heading even with nothing on the list.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'feedback' })
  await ui.unmount()
  expect(seen.argv).toHaveLength(1)
  expect(seen.argv[0]?.slice(0, 2)).toEqual(['claude', '--bg'])
  const text = seen.argv[0]?.[2] ?? ''
  expect(text).toContain('DOstapovets/claude-noticed-issues')
  expect(text).toContain('AskUserQuestion')
  expect(text).toContain('post nothing until I confirm')
  expect(text).toContain('createDiscussion')
  expect(seen.toasts.at(-1)).toContain('claude attach 4b7cb777')

  const ran = await $.command.run({
    command: 'issues',
    args: 'feedback',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('Feedback session started')
  expect(seen.argv).toHaveLength(2)
})

test('Feedback tells the session where it was started from', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  const prompt = () => seen.argv.at(-1)?.[2] ?? ''

  const press = async (surface: 'terminal' | 'desktop' | 'vscode') => {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'feedback' })
    await ui.unmount()
    return prompt()
  }

  expect(await press('terminal')).toContain('I started this feedback from Terminal')
  expect(prompt()).not.toContain('VS Code extension')
  seen.surfaces = ['vscode']
  expect(await press('vscode')).toContain('I started this feedback from VS Code.')
  expect(prompt()).toContain('code --list-extensions --show-versions')
  seen.surfaces = ['desktop']
  expect(await press('desktop')).toContain('I started this feedback from Desktop app.')

  // Typed at the terminal: the run says the layout.
  seen.surfaces = ['terminal']
  await $.command.run({
    command: 'issues',
    args: 'feedback',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(prompt()).toContain('from Terminal, main screen.')

  // From the VS Code extension's prompt: the one surface the session draws on.
  seen.surfaces = ['vscode']
  await $.command.run({
    command: 'issues',
    args: 'feedback',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(prompt()).toContain('from VS Code.')

  // Several surfaces and no telling which: the session asks.
  seen.surfaces = ['vscode', 'mobile']
  await $.command.run({
    command: 'issues',
    args: 'feedback',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(prompt()).toContain('is not known: ask it')
})

test('both tools stay in the prompt rather than behind ToolSearch', async ($, on) => {
  engine(on)
  // The engine defers a plugin's MCP-style tools by default.
  on('tool.describe', (_, e) => ({ description: e.description, isDeferred: true }))
  await $.session.start(start('/proj/a'))

  for (const tool of [NOTE, RESOLVE]) {
    const described = await $.tool.describe({
      tool,
      description: 'd',
      isDeferred: true,
      provider: { plugin: 'noticed-issues', tier: 'user' },
    })
    expect(described.isDeferred).toBe(false)
    expect(described.description).toBe('d')
  }
})

test('worktrees share the repository list, and their old lists fold into it', async ($, on) => {
  const seen = engine(on, {
    'issues:/repo': { nextId: 5, items: [{ id: 4, title: 'Leaked key', createdAt: 1 }] },
    'issues:/repo/.claude/worktrees/wt': {
      nextId: 3,
      items: [
        { id: 1, title: 'leaked key', createdAt: 2 },
        { id: 2, title: 'No memory limit', createdAt: 3 },
      ],
    },
    // A worktree removed since: its list has nowhere else to go.
    'issues:/repo/.claude/worktrees/gone': { nextId: 2, items: [{ id: 1, title: 'Stale doc', createdAt: 4 }] },
    // A repository of its own inside this one.
    'issues:/repo/vendor/lib': { nextId: 2, items: [{ id: 1, title: 'Vendored issue', createdAt: 5 }] },
  })
  seen.repo = '/repo'
  seen.git = {
    '/repo': '/repo/.git',
    '/repo/.claude/worktrees/wt': '/repo/.git',
    '/repo/vendor/lib': '/repo/vendor/lib/.git',
  }

  await $.session.start(start('/repo/.claude/worktrees/wt'))
  expect(await flag($)).toBe('⚑ 3 issues')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(ui)).toEqual(['▾ Medium 3', '#6 Stale doc', '#5 No memory limit', '#4 Leaked key'])
  expect(await ui.find({ type: 'Text', text: /Vendored issue/ })).toBeUndefined()
  await ui.unmount()
  expect(answer(await $.tool.call({ tool: NOTE, title: 'Noted from a worktree' }))).toContain('#7')

  // The main working tree reads the same list, folded once.
  await $.session.start(start('/repo'))
  expect(await flag($)).toBe('⚑ 4 issues · 1 this session')

  // The nested repository kept its own.
  seen.repo = '/repo/vendor/lib'
  await $.session.start(start('/repo/vendor/lib'))
  expect(await flag($)).toBe('⚑ 1 issue')
})

test('outside a repository the list is the directory\'s', async ($, on) => {
  engine(on, { 'issues:/scratch': { nextId: 3, items: [{ id: 2, title: 'Loose note', createdAt: 1 }] } })
  await $.session.start(start('/scratch'))
  expect(await flag($)).toBe('⚑ 1 issue')
})

const SAVE_RULE = 'mcp__noticed-issues__save_issue_rule'
const RULE_BLOCK = 'noticedIssuesRule'

// The blocks the plugin adds to a conversation's context.
const context = async ($: Engine) => (await $.prompt.context({ blocks: [] })).blocks

test('the first start in a repository offers an analysis once, which writes when to note an issue there', async ($, on) => {
  const seen = engine(on)
  seen.repo = '/repo'
  seen.choice = 'Analyze'
  await $.session.start(start('/repo/.claude/worktrees/wt'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toContain('Analyze this repository')
  expect(seen.argv).toHaveLength(1)
  expect(seen.argv[0]?.slice(0, 2)).toEqual(['claude', '--bg'])
  const text = seen.argv[0]?.[2] ?? ''
  expect(text).toContain('save_issue_rule')
  expect(text).toContain('AskUserQuestion')
  expect(text).toContain('whether to note the problems')
  expect(seen.toasts.at(-1)).toContain('claude attach 4b7cb777')

  // Asked once per repository, whichever of its worktrees a session starts in.
  await $.session.start(start('/repo'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(1)
  expect(seen.argv).toHaveLength(1)
})

test('Not now, or a dismissed dialog, starts nothing and is not asked again', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(1)
  expect(seen.argv).toHaveLength(0)
  expect(seen.toasts.at(-1)).toContain('/issues setup')
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(1)

  seen.choice = null
  await $.session.start(start('/proj/b'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(2)
  expect(seen.argv).toHaveLength(0)
  await $.session.start(start('/proj/b'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(2)
})

test('a session with no one at the prompt does not ask, and leaves the question for one that has', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/proj/a', surface: null, isInteractive: false })
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(0)
  expect(seen.store.get('rule:/proj/a')).toBeUndefined()
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(seen.asked).toHaveLength(1)
})

test('a saved rule goes into the context of the repository\'s sessions', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  expect(await context($)).toEqual([])

  const saved = await $.tool.call({ tool: SAVE_RULE, rule: '- Note a failing `make check` as high.' })
  expect(answer(saved)).toContain('Saved')
  expect(seen.store.get('rule:/proj/a')).toMatchObject({ text: '- Note a failing `make check` as high.', savedAt: 1_000 })

  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  const blocks = await context($)
  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.name).toBe(RULE_BLOCK)
  expect(blocks[0]?.text).toContain('- Note a failing `make check` as high.')

  // Another project has none.
  await $.session.start(start('/proj/b'))
  await seen.clock.settle()
  expect(await context($)).toEqual([])

  const long = await $.tool.call({ tool: SAVE_RULE, rule: 'r'.repeat(5000) })
  expect(answer(long)).toContain('cut to 4000 characters')
  expect(seen.store.get('rule:/proj/b').text).toHaveLength(4000)
  expect(answer(await $.tool.call({ tool: SAVE_RULE, rule: ' ' }))).toContain('`rule` is required')
})

test('/issues setup starts the analysis whenever asked', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start('/proj/a'))
  await seen.clock.settle()
  const ran = await $.command.run({
    command: 'issues',
    args: 'setup',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toContain('Setup session started')
  expect(seen.argv).toHaveLength(1)
  expect(seen.argv[0]?.[2]).toContain('save_issue_rule')
})
