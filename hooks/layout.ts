import type { Issue, Priority } from '../types'
import { MINUTE } from './context'

export const count = (n: number) => (n === 1 ? '1 issue' : `${n} issues`)

// Highest first: the order of the pane's groups and of `/issues` as text.
export const PRIORITIES = [
  { value: 'high', label: 'High', color: 'error' },
  { value: 'medium', label: 'Medium', color: 'warning' },
  { value: 'low', label: 'Low', color: 'remember' },
] as const

// An issue noted before priorities existed, or without one, is medium.
export const rank = (issue: Issue) => PRIORITIES.findIndex(p => p.value === (issue.priority ?? 'medium'))

// Rows above the groups: the pane's heading and a blank row, then the tabs and another.
export const headRows = (hasTabs: boolean) => (hasTabs ? 4 : 2)

// Splits `free` rows between groups that need `needs` rows each: one that
// needs no more than an even share gets what it needs, and the rows it leaves
// go to the rest, which share them evenly.
export const share = (needs: number[], free: number) => {
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
export const arrange = (
  shown: Issue[],
  folded: Priority[],
  top: number,
  bodyRows: number,
  columns: number,
  confirming: number | null,
  now: number,
) => {
  const groups = PRIORITIES.map((priority, i) => ({
    priority,
    // Newest first.
    items: shown.filter(issue => rank(issue) === i).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id),
    isOpen: !folded.includes(priority.value),
  })).filter(g => g.items.length > 0)
  const heights = groups.map(g => g.items.map(issue => cardRows(issue, columns, issue.id === confirming, now)))
  const open = groups.flatMap((g, i) => (g.isOpen ? [i] : []))
  // Less a heading's row for each folded group and a blank row between groups.
  const free = Math.max(0, bodyRows - top - (groups.length - open.length) - Math.max(0, groups.length - 1))
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
    row += rows + 1
    return placed
  })
}

// The first card a group shows, scrolled no further than its last full view.
export const firstCard = (at: number | undefined, lastFirst: number) => Math.max(0, Math.min(at ?? 0, lastFirst))

// A detail longer than this many card lines is cut; the GitHub issue keeps it whole.
export const DETAIL_LINES = 3

export const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value)

// The characters a note keeps of each field. The store is one JSON file for
// every project and refuses a write past 4 MiB, so a pasted log must not go in
// whole. 4000 is a screenful of detail, far more than a card shows.
export const LIMITS = { title: 200, detail: 4000, file: 500 } as const

// The rows `text` takes wrapped at `width`, word by word, a word wider than a row broken.
export const wrappedRows = (text: string, width: number) => {
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
export const cardRows = (issue: Issue, columns: number, isConfirming: boolean, now: number) => {
  // The corner beside the heading, and a column before it: `5m ago  ✕ `, or `Delete? ✓ ↩ `.
  const head = Math.max(1, columns - (isConfirming ? 14 : 5 + age(issue.createdAt, now).length))
  const title = issue.githubUrl ? 1 + wrappedRows(issue.title, head) : wrappedRows(`#${issue.id} ${issue.title}`, head)
  const detail = issue.detail ? wrappedRows(clip(issue.detail, DETAIL_LINES * columns), columns) : 0

  // With the border's two rows, the controls' row and the blank row below the card.
  return title + (issue.file ? 1 : 0) + detail + 4
}

const two = (n: number) => String(n).padStart(2, '0')

// When it was noted, compactly: how long ago within a day, the date and time
// after that, the year too when it is not this one.
export const age = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / MINUTE)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`

  const date = new Date(at)
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `.${two(date.getFullYear() % 100)}`

  return `${two(date.getDate())}.${two(date.getMonth() + 1)}${year} ${two(date.getHours())}:${two(date.getMinutes())}`
}

// Inside a card: its border and padding take two columns a side.
export const cardColumnsOf = (bodyColumns: number) => Math.max(20, bodyColumns - 4)
