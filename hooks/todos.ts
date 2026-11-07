import { atom, update } from 'claude-code'

import type { Issue, Priority, Todo } from '../types'
import { session } from './context'
import type { Api } from './context'
import { clip, LIMITS } from './layout'
import { startSession } from './sessions'
import { addIssue } from './store'

// The engine's scan reads a `$.state` value only from a const of the file that
// reads or writes it, so this module names the atom itself; types/index.d.ts declares it once.
const todos = atom({ plugin: 'noticed-issues', key: 'todos' } as const, [])

// What takes `$` here is a function declaration: past an import the scan
// follows `$` into nothing else.

// A tag counts only after a comment's opening, so `TODO_LIST` and a word in a
// string do not; a lone `*` only at the start of a line, as inside `/* */`, so
// Markdown's `**FIXME**` does not either. POSIX classes: `git grep -E` knows no
// `\b` on every system.
const PATTERN = '(//|#|/\\*|^[[:space:]]*\\*|--|<!--|;)[[:space:]]*(TODO|FIXME|HACK|XXX)([^A-Za-z0-9_]|$)'
const ROW = /^(.+?):(\d+):(.*)$/
// The tag, an author in parentheses, `:` or `-`, then the text.
const TAG = /(?:\/\/|#|\/\*|^\s*\*|--|<!--|;)\s*(TODO|FIXME|HACK|XXX)(?![A-Za-z0-9_])(?:\([^)]*\))?\s*[:-]?\s*(.*)$/

// The Code tab holds this many at most and says when there were more.
export const TODO_LIMIT = 200

// Each tag takes a priority's group: what is broken first, what is left to do last.
export const TAG_PRIORITY: Record<Todo['tag'], Priority> = { FIXME: 'high', HACK: 'medium', XXX: 'medium', TODO: 'low' }
// Those groups' headings on the Code tab.
export const TAG_LABELS: Record<Priority, string> = { high: 'FIXME', medium: 'HACK · XXX', low: 'TODO' }

// `git grep -n`'s answer, `path:line:text` a row, as the comments it found.
export const parseTodos = (stdout: string) =>
  stdout.split('\n').flatMap((row): Todo[] => {
    const [, file, line, code] = row.match(ROW) ?? []
    const [, tag, rest] = code?.match(TAG) ?? []

    if (!file || !tag) {
      return []
    }

    const text = (rest ?? '').replace(/\s*(\*\/|-->)\s*$/, '').trim()
    return [{ tag: tag as Todo['tag'], file, line: Number(line), text: clip(text || `${tag} in ${file}:${line}`, LIMITS.title) }]
  })

// The comments as cards in the pane's groups, in the order found: `arrange` puts the newest first.
export const todoIssues = (found: Todo[]): Issue[] =>
  found.map((todo, i) => ({
    id: i + 1,
    title: todo.text,
    file: `${todo.file}:${todo.line}`,
    createdAt: -i,
    priority: TAG_PRIORITY[todo.tag],
  }))

// Every tracked file of this working tree, paths from its root. Outside a
// repository, or when git does not answer, there is nothing to show.
export async function scanTodos($: Api) {
  const ran = await $.process
    .run(['git', '-C', session.cwd, '-c', 'core.quotePath=off', 'grep', '-nIE', '--full-name', PATTERN, '--', ':/'])
    .catch(() => undefined)
  // 1: nothing found.
  const found = ran?.exitCode === 0 ? parseTodos(ran.stdout) : []
  session.todosCut = found.length > TODO_LIMIT || ran?.isStdoutTruncated === true
  await update($, todos, () => found.slice(0, TODO_LIMIT))
}

// On the list it is an issue like any other, kept until resolved, the comment its place.
export async function listTodo($: Api, todo: Todo) {
  return addIssue($, {
    title: todo.text,
    detail: `From a ${todo.tag} comment in the code: remove the comment once this is fixed.`,
    file: `${todo.file}:${todo.line}`,
    priority: TAG_PRIORITY[todo.tag],
  })
}

// A session for a comment works on its issue, which it resolves when done.
export async function startTodoSession($: Api, todo: Todo) {
  const { issue } = await listTodo($, todo)
  await startSession($, issue.id)
}
