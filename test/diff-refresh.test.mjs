import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptComparison, keepsActiveFiles } from '../src/client/detail/comparison.js'

const load = () => {}
const comparison = (worktreeRevision, revision = 0, targetsKey = 'unstaged') => ({
  load, revision, worktreeRevision, targetsKey,
})
const text = (fingerprint, line = '+first') => ({
  kind: 'text', path: 'notes.txt', lineStaging: true, fingerprint,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', line] }],
})
const source = (target, diff) => ({ target, diff, status: 'ready' })
const answer = (request, ...results) => ({ request, results })

test('identical background payloads keep the displayed comparison and staging source identity', () => {
  const shown = answer(comparison(0), source('unstaged', text('current')))
  const loaded = answer(comparison(1), source('unstaged', structuredClone(shown.results[0].diff)))
  const adopted = adoptComparison(shown, loaded, loaded.request, true)
  assert.equal(adopted.request, loaded.request)
  assert.equal(adopted.results, shown.results)
  assert.equal(adopted.results[0].diff, shown.results[0].diff)
  assert.equal(adoptComparison(adopted, loaded, loaded.request, false), adopted)
})

test('changed staging fingerprint defers a merged comparison and retains its original source until release', () => {
  const staged = source('staged', text('staged'))
  const shown = answer(comparison(0), staged, source('unstaged', text('original')))
  const loaded = answer(comparison(1), structuredClone(staged), source('unstaged', text('replacement')))
  const held = adoptComparison(shown, loaded, loaded.request, true)
  assert.equal(held, shown)
  assert.equal(held.results[1].diff.fingerprint, 'original')
  const adopted = adoptComparison(held, loaded, loaded.request, false)
  assert.equal(adopted.request, loaded.request)
  assert.equal(adopted.results[0], staged)
  assert.equal(adopted.results[1].diff.fingerprint, 'replacement')
})

test('the latest request supersedes buffered results after a manual refresh or scope change', () => {
  const shown = answer(comparison(0), source('unstaged', text('shown')))
  const buffered = answer(comparison(1), source('unstaged', text('buffered', '+buffered')))
  assert.equal(adoptComparison(shown, buffered, buffered.request, true), shown)

  const manual = answer(comparison(1, 1), source('unstaged', text('manual')))
  assert.equal(adoptComparison(shown, buffered, manual.request, false), shown)
  assert.equal(adoptComparison(shown, manual, manual.request, true), manual)

  const nextTarget = answer(comparison(2, 0, 'staged'), source('staged', text('target')))
  assert.equal(adoptComparison(shown, buffered, nextTarget.request, false), shown)
  assert.equal(adoptComparison(shown, nextTarget, nextTarget.request, true), shown)
  assert.equal(adoptComparison(shown, nextTarget, nextTarget.request, false).results[0].target, 'staged')

  const anotherWorktree = answer({ ...comparison(2), load() {} }, source('unstaged', text('other')))
  assert.equal(adoptComparison(shown, buffered, anotherWorktree.request, false), shown)
  assert.equal(adoptComparison(shown, anotherWorktree, anotherWorktree.request, true), anotherWorktree)
})

test('an active file keeps its row when status becomes clean or changes its directory wrapper', () => {
  const group = { kind: 'group', key: 'unstaged|' }
  const dir = { kind: 'dir', key: 'unstaged|src/nested', depth: 0 }
  const file = { kind: 'file', key: 'unstaged|src/nested/notes.txt', depth: 1 }
  const previous = [group, dir, file]
  const active = new Set([file.key])
  assert.equal(keepsActiveFiles(previous, [], active), false)
  assert.equal(keepsActiveFiles(previous, [], new Set()), true)

  const directorySplit = [group, { ...dir, key: 'unstaged|src' }, { ...dir, depth: 1 }, { ...file, depth: 2 }]
  assert.equal(keepsActiveFiles(previous, directorySplit, active), false)
  const adjacentFile = { kind: 'file', key: 'unstaged|README.md', depth: 0 }
  assert.equal(keepsActiveFiles(previous, [group, dir, file, adjacentFile], active), true)
  assert.equal(keepsActiveFiles(previous, [group, { ...dir }, { ...file }], active), true)
})
