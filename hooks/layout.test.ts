import { expect, test } from 'claude-code/testing'

import type { Issue, Priority } from '../types'
import { MINUTE } from './context'
import { age, arrange, cardColumnsOf, cardRows, DETAIL_LINES, headRows, share, wrappedRows } from './layout'

// Local time, as `age` reads it.
const NOW = new Date(2026, 10, 6, 12, 0).getTime()

const issue = (fields: Partial<Issue> = {}): Issue => ({ id: 1, title: 'Short', createdAt: NOW, ...fields })

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

test('groups that fit get what they need, the rest share what is left', () => {
  expect(share([3, 4], 10)).toEqual([3, 4])
  expect(share([10, 10], 6)).toEqual([3, 3])
  // The small group takes its 2; the 7 rows left split 4 and 3, the odd row to the first.
  expect(share([2, 10, 10], 9)).toEqual([2, 4, 3])
  // A group never gets less than its heading's row, even when that is more than there is.
  expect(share([5, 5, 5], 1)).toEqual([1, 1, 1])
  expect(share([5, 5], 0)).toEqual([1, 1])
})

test('text wraps word by word, a word wider than a row broken', () => {
  expect(wrappedRows('', 10)).toBe(1)
  expect(wrappedRows('aaa bbb', 7)).toBe(1)
  expect(wrappedRows('aaa bbb ccc', 7)).toBe(2)
  // Ten, ten and five, the next word beside the five.
  expect(wrappedRows(`${'a'.repeat(25)} bb`, 10)).toBe(3)
  // A word that fills its row leaves no room beside it.
  expect(wrappedRows(`${'a'.repeat(10)} b`, 10)).toBe(2)
  // Counted in code points: each bug is two UTF-16 units.
  expect(wrappedRows('🐛🐛🐛🐛🐛', 5)).toBe(1)
  expect(wrappedRows('🐛🐛🐛 🐛', 5)).toBe(1)
})

test("a card's rows: heading, file, detail cut to three lines, border and controls", () => {
  // `#1 Short`, then the border's two rows, the controls' row and a blank row.
  expect(cardRows(issue(), 40, false, NOW)).toBe(5)
  expect(cardRows(issue({ file: 'src/a.ts' }), 40, false, NOW)).toBe(6)
  expect(cardRows(issue({ detail: 'one line' }), 40, false, NOW)).toBe(6)
  // Five hundred characters of detail are drawn cut to 3 × 40 characters.
  expect(DETAIL_LINES).toBe(3)
  expect(cardRows(issue({ detail: 'word '.repeat(100) }), 40, false, NOW)).toBe(5 + DETAIL_LINES)
  // A linked GitHub issue puts number, link and status on a line of their own.
  expect(cardRows(issue({ githubUrl: 'https://github.com/o/r/issues/42' }), 40, false, NOW)).toBe(6)
})

test('the corner beside the heading takes its width from the age, or from the delete prompt', () => {
  // 40 columns less `just now  ✕ ` and a column leave 27: `#1` and 24 characters fit.
  const title = 'x'.repeat(24)
  expect(cardRows(issue({ title }), 40, false, NOW)).toBe(5)
  // `Delete? ✓  ↩ ` and its margin take 14, so the same title wraps.
  expect(cardRows(issue({ title }), 40, true, NOW)).toBe(6)
  // `5m ago` is shorter than `just now`: two more columns.
  const longer = 'x'.repeat(26)
  expect(cardRows(issue({ title: longer }), 40, false, NOW)).toBe(6)
  expect(cardRows(issue({ title: longer, createdAt: NOW - 5 * MINUTE }), 40, false, NOW)).toBe(5)
})

test('age: how long ago within a day, then the date, the year when it is not this one', () => {
  expect(age(NOW, NOW)).toBe('just now')
  expect(age(NOW - MINUTE + 1, NOW)).toBe('just now')
  expect(age(NOW - 5 * MINUTE, NOW)).toBe('5m ago')
  expect(age(NOW - 59 * MINUTE, NOW)).toBe('59m ago')
  expect(age(NOW - 60 * MINUTE, NOW)).toBe('1h ago')
  expect(age(NOW - (24 * 60 - 1) * MINUTE, NOW)).toBe('23h ago')
  expect(age(new Date(2026, 2, 5, 9, 7).getTime(), NOW)).toBe('05.03 09:07')
  expect(age(new Date(2025, 11, 31, 23, 5).getTime(), NOW)).toBe('31.12.25 23:05')
  // Within a day across New Year is still hours.
  expect(age(new Date(2025, 11, 31, 23, 0).getTime(), new Date(2026, 0, 1, 1, 0).getTime())).toBe('2h ago')
})

test('a card is at least 20 columns wide, whatever the pane', () => {
  expect(cardColumnsOf(60)).toBe(56)
  expect(cardColumnsOf(24)).toBe(20)
  expect(cardColumnsOf(10)).toBe(20)
})

test('with over a hundred issues the groups stay inside the pane, each scrolled no further than its last card', () => {
  const priorities: Priority[] = ['high', 'medium', 'low']
  const many = Array.from({ length: 120 }, (_, i) =>
    issue({
      id: i + 1,
      title: `Issue ${i + 1} ${'long title '.repeat(i % 5)}`,
      priority: priorities[i % 3],
      createdAt: NOW - i * 7 * MINUTE,
      ...(i % 4 === 0 ? { detail: 'detail '.repeat(i % 30) } : {}),
      ...(i % 6 === 0 ? { file: 'src/a.ts' } : {}),
      ...(i % 9 === 0 ? { githubUrl: `https://github.com/o/r/issues/${i}` } : {}),
    }),
  )
  const columns = cardColumnsOf(60)
  const top = headRows(true)

  for (const folded of [[], ['medium']] as Priority[][]) {
    // From the least that gives each heading a row and a blank one between groups.
    for (let bodyRows = top + 5; bodyRows <= 80; bodyRows += 1) {
      const groups = arrange(many, folded, top, bodyRows, columns, 3, NOW)
      expect(groups.map(g => g.priority.value)).toEqual(priorities)

      let row = top
      for (const g of groups) {
        expect(g.top).toBe(row)
        expect(g.rows).toBeGreaterThanOrEqual(1)
        row += g.rows + 1

        const cards = g.items.map(i => cardRows(i, columns, i.id === 3, NOW))
        expect(g.lastFirst).toBeGreaterThanOrEqual(0)
        expect(g.lastFirst).toBeLessThanOrEqual(g.items.length - 1)
        // The cards from lastFirst on fit under the heading, one more would not.
        if (g.lastFirst < g.items.length - 1) expect(1 + sum(cards.slice(g.lastFirst))).toBeLessThanOrEqual(g.rows)
        if (g.lastFirst > 0) expect(1 + sum(cards.slice(g.lastFirst - 1))).toBeGreaterThan(g.rows)
      }
      expect(row - 1).toBeLessThanOrEqual(bodyRows)
      // A folded group keeps only its heading's row.
      if (folded.length > 0) expect(groups[1]!.rows).toBe(1)
    }
  }
})

test('a pane too short for every heading still gives each group its row', () => {
  const shown = (['high', 'medium', 'low'] as Priority[]).map((priority, i) => issue({ id: i + 1, priority }))
  const groups = arrange(shown, [], headRows(true), 6, 40, null, NOW)
  expect(groups.map(g => g.rows)).toEqual([1, 1, 1])
  // The last heading falls past the pane's sixth row.
  expect(groups[2]!.top).toBe(8)
})
