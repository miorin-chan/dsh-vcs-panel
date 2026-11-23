import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDiffs } from '../lib/client/diff/merge.js'

function diff(...hunks) {
  return { kind: 'text', path: 'example.txt', before: true, after: true, hunks }
}

function hunk(oldStart, newStart, lines) {
  return {
    oldStart, newStart, lines,
    oldLines: lines.filter(line => line[0] !== '+').length,
    newLines: lines.filter(line => line[0] !== '-').length,
  }
}

test('merged patches share context and retain the origin of each action', () => {
  const staged = diff(hunk(4, 4, [' context', ' old', '+staged']))
  const unstaged = diff(hunk(4, 4, [' context', '-old', ' staged', '+worktree']))
  assert.deepEqual(mergeDiffs(staged, unstaged).hunks, [{
    ...hunk(4, 4, [' context', '-old', '+staged', '+worktree']),
    origins: [null, { side: 'unstaged', hunk: 0, line: 1 }, { side: 'staged', hunk: 0, line: 2 }, { side: 'unstaged', hunk: 0, line: 3 }],
  }])
})

test('merged patches preserve intermediate edits and original numbering on overlap', () => {
  const staged = diff(hunk(8, 8, ['-original', '+index']))
  const unstaged = diff(hunk(8, 8, ['-index', '+original']))
  const merged = mergeDiffs(staged, unstaged).hunks
  assert.deepEqual(merged.map(({ side, lines }) => ({ side, lines })), [
    { side: 'staged', lines: ['-original', '+index'] },
    { side: 'unstaged', lines: ['-index', '+original'] },
  ])
  assert.deepEqual(merged[1].origins[0], { side: 'unstaged', hunk: 0, line: 0 })
  assert.equal(merged[1].oldStart, 8)
})

test('zero-width edits and earlier length changes use outer line coordinates', () => {
  const staged = diff(hunk(1, 0, ['-first']))
  const unstaged = diff(hunk(6, 7, ['+later']))
  assert.deepEqual(mergeDiffs(staged, unstaged).hunks.map(({ origins, ...value }) => value), [
    hunk(1, 0, ['-first']), hunk(7, 7, ['+later']),
  ])
})
