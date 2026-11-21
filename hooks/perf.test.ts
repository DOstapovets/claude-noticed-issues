import { expect, test } from 'claude-code/testing'

import type { Issue } from '../types'
import { arrange, LIMITS } from './layout'
import { similar } from './store'
import { parseTodos } from './todos'

// What runs on every draw, scroll, note and scan, timed on lists far longer
// than usual. A machine's speed is not known, so each check is either a
// budget ten times what a laptop takes, or how the time grows from n to 4n:
// about 4 when the work is linear, 16 when it is quadratic.

const NOW = new Date(2026, 10, 6, 12, 0).getTime()

// The best of five runs, in milliseconds: the least disturbed by anything else.
const best = (run: () => unknown) => {
  let least = Infinity
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    run()
    least = Math.min(least, performance.now() - started)
  }
  return least
}

const growth = (make: (n: number) => () => unknown, n: number) => best(make(4 * n)) / best(make(n))

// Issues at every field's limit, in all three groups.
const full = (n: number): Issue[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `#${i} ${'word '.repeat(40)}`.slice(0, LIMITS.title),
    detail: 'lorem ipsum dolor '.repeat(250).slice(0, LIMITS.detail),
    file: `hooks/${'dir/'.repeat(130)}f${i}.ts:${i}`.slice(0, LIMITS.file),
    createdAt: NOW - i * 60_000,
    priority: (['high', 'medium', 'low'] as const)[i % 3],
  }))

test('the pane lays out a hundred full cards within a draw, and the time grows with the list, not its square', () => {
  const list = full(100)
  expect(best(() => arrange(list, [], 2, 40, 56, null, NOW))).toBeLessThan(70)
  const make = (n: number) => {
    const many = full(n)
    return () => arrange(many, [], 2, 40, 56, null, NOW)
  }
  expect(growth(make, 100)).toBeLessThan(8)
})

test('near duplicates are found in a thousand issues at once, and the time grows with the list', () => {
  const list = full(1000)
  expect(best(() => similar(list, 'word word in the store', 'hooks/x.ts:1'))).toBeLessThan(50)
  const make = (n: number) => {
    const many = full(n)
    return () => similar(many, 'word word in the store', 'hooks/x.ts:1')
  }
  expect(growth(make, 250)).toBeLessThan(8)
})

test("git grep's answer is read in time that grows with it, a minified line's strings of tags too", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i % 500}.ts:${i + 1}:  // TODO: step ${i}`).join('\n')
  const answer = rows(20_000)
  expect(best(() => parseTodos(answer))).toBeLessThan(300)
  expect(growth(n => () => parseTodos(rows(n)), 5_000)).toBeLessThan(8)

  // Every tag inside a string: each is looked at, none is a comment.
  const line = (n: number) => `min.js:1:${'var a="// TODO x";'.repeat(n)}`
  expect(parseTodos(line(10))).toEqual([])
  expect(growth(n => () => parseTodos(line(n)), 750)).toBeLessThan(8)
})

test('800 issues at every field limit fit in the 4 MiB the store takes, 900 do not', () => {
  // The store is one file for every project, so this is the room all of them share:
  // about 4.7 KB a full issue in ASCII, more where the text is not.
  const size = (n: number) => JSON.stringify({ nextId: n + 1, items: full(n) }).length
  expect(size(800)).toBeLessThan(4 * 1024 * 1024)
  expect(size(900)).toBeGreaterThan(4 * 1024 * 1024)
})
