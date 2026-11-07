import { expect, test } from 'claude-code/testing'

import { parseTodos, todoIssues } from './todos'

test('a comment is read from git grep: its tag, where it is and what follows', () => {
  const found = parseTodos(
    [
      'src/a.ts:3:  // TODO: cache the result',
      'src/b.py:10:    # FIXME(dima): crashes on empty input',
      'c.css:1:/* XXX - odd margin */',
      'd.html:2:<!-- HACK keep for now -->',
      'e.sql:4:-- TODO',
      // A colon in the path.
      'w:x/y.ts:7: * TODO colon in the path',
      // Not a tag: part of a name, or a word that only starts like one.
      'f.ts:5:const TODO_LIST = 1 // fine',
      'g.ts:6:// TODOS are fine',
      // Markdown's bold is not a comment.
      'h.md:8:headed by **FIXME** and',
      '',
    ].join('\n'),
  )

  expect(found).toEqual([
    { tag: 'TODO', file: 'src/a.ts', line: 3, text: 'cache the result' },
    { tag: 'FIXME', file: 'src/b.py', line: 10, text: 'crashes on empty input' },
    { tag: 'XXX', file: 'c.css', line: 1, text: 'odd margin' },
    { tag: 'HACK', file: 'd.html', line: 2, text: 'keep for now' },
    { tag: 'TODO', file: 'e.sql', line: 4, text: 'TODO in e.sql:4' },
    { tag: 'TODO', file: 'w:x/y.ts', line: 7, text: 'colon in the path' },
  ])
})

test('a tag inside a string is not a comment, and the text stops where the comment does', () => {
  const found = parseTodos(
    [
      // Fixtures in a test file: the comment's opening is inside quotes.
      "t.ts:1:  'src/a.ts:3:// TODO: cache the result',",
      "t.ts:2:  seen.grep = 'src/b.py:10:    # FIXME(dima): crashes on empty input'",
      "t.ts:3:  'd.html:2:<!-- HACK keep for now -->',",
      't.ts:4:  seen.grep = Array.from({ length: 205 }, (_, i) => `a.ts:${i + 1}:// TODO: step ${i + 1}`).join(\'\\n\')',
      String.raw`t.ts:5:  parseTodos('a.ts:1:// FIXME: one\nb.ts:2:// TODO: two\n')`,
      // A comment after a string that holds one; an escaped quote does not open a string.
      "t.ts:6:const s = '// TODO not this' // TODO: this one",
      String.raw`t.ts:7:const s = 'it\'s' // FIXME: after an escaped quote`,
      // Code after a closed comment, and a tag with nothing to say but punctuation.
      't.ts:8:/* XXX: odd margin */ x()',
      't.ts:9:<!-- HACK keep for now --> <p>',
      't.ts:10:# TODO: ,',
      // Text in any script.
      't.ts:11:// TODO: перевірити вхід',
    ].join('\n'),
  )

  expect(found).toEqual([
    { tag: 'TODO', file: 't.ts', line: 6, text: 'this one' },
    { tag: 'FIXME', file: 't.ts', line: 7, text: 'after an escaped quote' },
    { tag: 'XXX', file: 't.ts', line: 8, text: 'odd margin' },
    { tag: 'HACK', file: 't.ts', line: 9, text: 'keep for now' },
    { tag: 'TODO', file: 't.ts', line: 10, text: 'TODO in t.ts:10' },
    { tag: 'TODO', file: 't.ts', line: 11, text: 'перевірити вхід' },
  ])
})

test('a comment is a card in its tag\'s group, in the order found', () => {
  const cards = todoIssues(parseTodos('a.ts:1:// FIXME: one\nb.ts:2:// TODO: two\n'))

  expect(cards.map(c => [c.id, c.title, c.file, c.priority])).toEqual([
    [1, 'one', 'a.ts:1', 'high'],
    [2, 'two', 'b.ts:2', 'low'],
  ])
  expect(cards[0]!.createdAt).toBeGreaterThan(cards[1]!.createdAt)
})
