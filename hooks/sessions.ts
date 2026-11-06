import { atom, read } from 'claude-code'

import type { Issue } from '../types'
import { session } from './context'
import type { Api } from './context'
import { change } from './store'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads it, so this module names the atom itself; types/index.d.ts declares it once.
const issues = atom({ plugin: 'noticed-issues', key: 'issues' } as const, [])

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

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
async function background($: Api, text: string, what: string) {
  const ran = await $.process.run(['claude', '--bg', text], { cwd: session.cwd }).catch(() => undefined)
  // `claude --bg` prints the id that `claude attach` takes.
  const sessionId = ran?.exitCode === 0 ? ran.stdout.match(SESSION_ID)?.[0] : undefined

  if (!sessionId) {
    await $.ui.toast(`Could not start a session for ${what}: ${ran?.stderr.trim() || 'claude --bg failed'}`)
  }

  return sessionId
}

// Ids whose `claude --bg` is still running, so a second press does not start a second session.
const starting = new Set<number>()

export async function startSession($: Api, id: number) {
  const issue = (await read($, issues)).find(i => i.id === id)

  if (!issue || starting.has(id)) {
    return
  }

  starting.add(id)
  try {
    const sessionId = await background($, prompt(issue), `#${id}`)

    if (!sessionId) {
      return
    }

    // Held until the id is saved: until then the pane still draws ▶.
    await change($, list => list.map(i => (i.id === id ? { ...i, sessionId } : i)))
    await $.ui.toast(`▶ #${id} → background session ${sessionId} · claude attach ${sessionId}`)
  } finally {
    starting.delete(id)
  }
}

// Where reports about the plugin itself go.
const PLUGIN_REPO = 'DOstapovets/claude-noticed-issues'

// Where feedback was started from, as the bug report's "Where you run Claude Code" names it.
// A background session draws nowhere, so it cannot tell this itself.
export const whereRun = (surface: string | undefined, isFullscreen: boolean | undefined) => {
  switch (surface) {
    case 'terminal':
      return isFullscreen === undefined
        ? 'Terminal'
        : isFullscreen
          ? 'Terminal, fullscreen layout'
          : 'Terminal, main screen'
    case 'desktop':
      return 'Desktop app'
    case 'vscode':
      return 'VS Code'
    case 'mobile':
      return 'Other (the mobile app)'
    default:
      return undefined
  }
}

const feedbackPrompt = (where: string | undefined, surfaces: readonly string[]) => [
  `Help me send feedback about the noticed-issues Claude Code plugin to its GitHub repository, ${PLUGIN_REPO}.`,
  '1. Interview me with AskUserQuestion, a few questions at a time. First: is it a bug, a feature request, or a question or idea to talk through? Then what that kind needs: for a bug, what happened, the steps and what I expected; for a feature, the problem and what I would like; for a question or idea, the question itself.',
  [
    '2. Collect the environment yourself rather than asking: `claude --version`, the noticed-issues version from `claude plugin list` and the OS.',
    where
      ? `Where I run Claude Code is known, as this session cannot see it: I started this feedback from ${where}${surfaces.length > 1 ? ` (my session draws on: ${surfaces.join(', ')})` : ''}. Put that under "Where you run Claude Code" without asking.`
      : 'Where I run Claude Code (terminal with the fullscreen layout or the main screen, the desktop app, VS Code) is not known: ask it with the other questions.',
    where === 'VS Code' || surfaces.includes('vscode')
      ? 'Add the Claude Code VS Code extension\'s version too: `code --list-extensions --show-versions | grep anthropic.claude-code`, or the `anthropic.claude-code-*` folder name under `~/.vscode/extensions`.'
      : '',
    'Leave out tokens, internal hostnames, private repository names and the contents of my projects.',
  ]
    .filter(Boolean)
    .join(' '),
  `3. Look for an existing issue or discussion on the same thing (\`gh issue list --repo ${PLUGIN_REPO} --state all --search ...\`, and discussions through \`gh api graphql\`). If there is one, show it and offer to add a comment there instead.`,
  '4. Draft the title and body. A bug: sections What happened, Steps to reproduce, Plugin version, Claude Code version, Where you run Claude Code, Logs or screenshots. A feature: The problem, What you would like, Alternatives you considered. Show me the draft and post nothing until I confirm it.',
  `5. Once I confirm: a bug or a feature request becomes an issue, \`gh issue create --repo ${PLUGIN_REPO} --title ... --body-file ...\`; a question or an idea becomes a discussion through \`gh api graphql\` and its createDiscussion mutation, in the Q&A category for a question and Ideas for an idea (look up the repository id and the category ids first). Give me the link.`,
].join('\n')

export async function startFeedback($: Api, where: string | undefined) {
  const surfaces = await $.session.surfaces()
  const sessionId = await background($, feedbackPrompt(where, surfaces), 'feedback')

  if (sessionId) {
    await $.ui.toast(`✎ Feedback session ${sessionId} is waiting for your answers · claude attach ${sessionId}`)
  }
}

const setupPrompt = () => [
  'Work out when Claude should note an issue in this repository with the noticed-issues plugin, and save it as the repository\'s rule.',
  '1. Study the repository: its README, CLAUDE.md and AGENTS.md, the stack, the checks (CI, tests, lint, type checks), the docs, the config and where secrets could leak, and what is already on the list (`/issues`).',
  '2. Draft the rule as a short Markdown list, under 4000 characters: when to call `note_issue` here, with concrete examples of problems outside a task for this stack and these paths; how to choose `high`, `medium` or `low` here; and when not to call it (steps of the current task belong in the task list; what is fixed in passing).',
  '3. Interview me with AskUserQuestion: show me the draft and ask whether to save it or what to change, and ask whether to note the problems you found while studying the repository.',
  '4. Once I confirm, save it with the `save_issue_rule` tool (`mcp__noticed-issues__save_issue_rule`, load it through ToolSearch). If I said yes, note each problem found with `note_issue`.',
].join('\n')

export async function startSetup($: Api) {
  const sessionId = await background($, setupPrompt(), 'the setup')

  if (sessionId) {
    await $.ui.toast(`⚙ Setup session ${sessionId} studies this repository · claude attach ${sessionId}`)
  }

  return sessionId
}

// Asked once per repository, on its first start: the caller has already kept that it asked.
export async function offerSetup($: Api) {
  const chosen = await $.ui
    .ask('Analyze this repository so Claude knows when to note an issue here?', {
      options: ['Analyze', 'Not now'],
      header: 'Issues',
    })
    .catch(() => undefined)

  if (chosen === 'Analyze') {
    await startSetup($)
  } else {
    await $.ui.toast('⚑ /issues setup analyzes this repository whenever you want')
  }
}

const SESSION_ID =/\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/
