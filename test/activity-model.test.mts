import test from 'node:test'
import assert from 'node:assert/strict'

import type { ActivityAnswer, ActivityEntry } from '../src/lib/activity.js'
import { activityLayout, ACTIVITY_GUTTER } from '../lib/client/history/activity-layout.js'
import { activityCommitKey, activityNode, activitySelection, buildActivity, entryKey } from '../lib/client/history/activity-model.js'
import { ACTIVITY_ENTRY_MAX, appendActivityPage, resetActivityPage, spliceActivityPage } from '../lib/client/history/activity-pages.js'
import { graphWidth, LANE_UNIT } from '../lib/client/history/layout.js'
import { expandActivity, resolveTimelineScope, sanitizeState } from '../lib/client/state.js'

const repos = ['/alpha', '/beta', '/gamma', '/delta']
const [alpha, beta, gamma, delta] = repos
const day = 1_797_638_400 // 2026-12-20T00:00:00Z
const dayOf = (time: number) => new Date(time * 1000).toISOString().slice(0, 10)
const id = (number: number) => number.toString(16).padStart(40, '0')
const commit = (repo: string, number: number, time: number, subject = `commit ${number}`, parents: string[] = []): ActivityEntry => ({
  kind: 'commit', repo, time: day + time, commit: { sha: id(number), parents, refs: [], author: 'Author', authorTime: 0, subject },
})
const stash = (repo: string, number: number, time: number, message: string): ActivityEntry => ({
  kind: 'stash', repo, time: day + time, stash: { sha: id(number), time: day + time, selector: 'stash@{0}', message,
    base: id(1), index: id(9_999), untracked: null, branch: 'main' },
})
const ordered = (entries: ActivityEntry[]) => [...entries].sort((a, b) => b.time - a.time)
const model = (entries: ActivityEntry[], expanded: string[] = []) => buildActivity(ordered(entries), new Set(expanded), repos, dayOf)

test('a repository burst spans interleaving, joins at 2700 seconds, separates at 2701, and stops across midnight', () => {
  const newest = commit(alpha, 1, 9000)
  const other = commit(beta, 2, 8700)
  const boundary = commit(alpha, 3, 6300)
  const separated = commit(alpha, 4, 3599)
  const morning = commit(gamma, 5, 10)
  const previous = commit(gamma, 6, -10)
  const activity = model([newest, other, boundary, separated, morning, previous])
  assert.deepEqual(activity.rows.map(row => row.kind), ['day', 'burst', 'single', 'single', 'single', 'day', 'single'])
  assert.deepEqual(activity.rows[1], { kind: 'burst', key: entryKey(newest), event: entryKey(newest), entry: newest,
    earlier: 1, from: boundary.time, to: newest.time, expanded: false })
  assert.deepEqual(activity.selectable, [1, 2, 3, 4, 6])
  assert.equal(activity.rowForEntry(entryKey(boundary)), entryKey(newest))
})

test('exact subjects form 30-minute clusters from the newest, with two or more repositories in each batch', () => {
  const entries = [
    commit(beta, 1, 9000, 'sync'),
    commit(alpha, 2, 8800, 'sync'),
    commit(beta, 3, 7200, 'sync'),
    commit(gamma, 4, 7199, 'sync'),
    commit(delta, 5, 5900, 'sync'),
    commit(alpha, 6, 3200, 'local'),
    commit(alpha, 7, 3100, 'local'),
    commit(beta, 8, 3000, ''),
    commit(gamma, 9, 2999, ''),
    commit(delta, 10, 2000, 'Sync'),
  ]
  const activity = model(entries)
  const grouped = activity.rows.filter(row => row.kind === 'batch')
  assert.deepEqual(grouped.map(row => [row.entry, row.repos, row.count, row.from]),
    [[entries[0], [beta, alpha], 3, entries[2].time], [entries[3], [gamma, delta], 2, entries[4].time]])
  assert.equal(grouped[0].key, `batch\0${beta}\0${id(1)}`)
  assert.equal(activity.rows.find(row => row.key === entryKey(entries[5]))?.kind, 'burst')
  for (const entry of entries.slice(7)) assert.equal(activity.rows.find(row => row.key === entryKey(entry))?.kind, 'single')
})

test('batch members do not interrupt a burst; a stash stays its own event', () => {
  const start = commit(alpha, 1, 9000)
  const end = commit(alpha, 2, 7100)
  const batched = commit(alpha, 3, 8000, 'sync')
  const other = commit(beta, 4, 7900, 'sync')
  const saved = stash(alpha, 5, 8500, 'sync')
  const activity = model([start, end, batched, other, saved])
  assert.deepEqual(activity.rows.map(row => row.kind), ['day', 'burst', 'single', 'batch'])
  assert.deepEqual(activity.rows[0], { kind: 'day', key: `day\0${dayOf(start.time)}`, date: dayOf(start.time), commits: 4, repos: 2 })
  assert.equal(activity.rowForEntry(entryKey(end)), entryKey(start))
  assert.equal(activity.rowForEntry(entryKey(saved)), entryKey(saved))
  assert.equal(activityNode(start), id(1))
  assert.equal(activityNode(saved), `stash:${id(5)}`)
})

test('activity ties use discovery order first and input order within each repository', () => {
  const secondRepo = commit(beta, 1, 5000)
  const first = stash(alpha, 2, 5000, 'save')
  const second = commit(alpha, 3, 5000)
  const activity = model([secondRepo, first, second])
  assert.deepEqual(activity.rows.slice(1).map(row => row.entry), [first, second, secondRepo])
})

test('expanded activities are followed by their own rows; extending them retains their keys and indexes', () => {
  const newest = commit(alpha, 1, 10_000)
  const earlier = commit(alpha, 2, 8000)
  const batch = commit(beta, 3, 9000, 'sync')
  const second = commit(alpha, 4, 8400, 'sync')
  const entries = [newest, batch, second, earlier]
  const collapsed = model(entries)
  const burstKey = entryKey(newest)
  const batchKey = collapsed.eventOfEntry(entryKey(batch))!
  const expanded = [burstKey, batchKey]
  const open = model(entries, expanded)
  assert.deepEqual(open.rows.slice(1).map(row => [row.kind, row.key]), [
    ['burst', burstKey], ['child', entryKey(earlier)], ['batch', batchKey],
    ['member', entryKey(batch)], ['member', entryKey(second)],
  ])
  assert.equal(open.rowForEntry(entryKey(second)), entryKey(second))
  assert.equal(open.eventOfEntry(entryKey(second)), batchKey)
  assert.equal(open.rowIndex.get(entryKey(earlier)), 2)
  const olderBurst = commit(alpha, 5, 7800)
  const olderBatch = commit(gamma, 6, 7600, 'sync')
  const extended = model([...entries, olderBurst, olderBatch], expanded)
  assert.equal(extended.eventOfEntry(entryKey(olderBurst)), burstKey)
  assert.equal(extended.eventOfEntry(entryKey(olderBatch)), batchKey)
  assert.equal(extended.rows[activitySelection(extended, entryKey(second), entryKey(second))]?.key, entryKey(second))
})

test('selection recovers by entry when collapsing or when an older peer turns a single into a batch', () => {
  const a = commit(alpha, 1, 4000, 'sync')
  const b = commit(beta, 2, 3500, 'sync')
  const closed = model([a, b])
  const batchKey = closed.eventOfEntry(entryKey(a))
  assert.equal(closed.rows[activitySelection(closed, entryKey(a), entryKey(a))]?.key, batchKey)
  assert.equal(closed.rows[activitySelection(closed, entryKey(b), entryKey(b))]?.key, batchKey)
  assert.equal(closed.rows[activitySelection(closed, 'missing', 'also missing')]?.key, batchKey)
  assert.equal(activitySelection(model([]), null, null), -1)
})

test('activity layout has a neutral spine for each day and follows expansion with exactly two lanes', () => {
  const newest = commit(alpha, 1, 10_000)
  const merge = commit(alpha, 2, 8500, 'merge', [id(8), id(9)])
  const batch = commit(beta, 3, 9000, 'sync')
  const member = commit(gamma, 4, 8400, 'sync')
  const saved = stash(gamma, 5, 7000, 'keep')
  const previous = commit(delta, 6, -50)
  const entries = [newest, merge, batch, member, saved, previous]
  const collapsed = model(entries)
  const open = model(entries, [entryKey(newest), collapsed.eventOfEntry(entryKey(batch))!])
  const graph = activityLayout(open.rows, repos)
  const [dayDot, burst, mergeDot, square, firstMember, secondMember, diamond, previousDay, last] = graph.dots
  assert.equal(dayDot, null)
  assert.equal(previousDay, null)
  assert.equal(burst.type, 'burst')
  assert.equal(burst.color, 0)
  assert.equal(square.type, 'batch')
  assert.equal(square.neutral, true)
  assert.equal(mergeDot.type, 'merge')
  assert.equal(diamond.type, 'stash')
  assert.equal(last.type, 'default')
  assert.equal(last.color, 3)
  assert.deepEqual([firstMember.color, secondMember.color], [1, 2])
  const side = burst.center.x + LANE_UNIT
  assert.deepEqual([mergeDot.center.x, firstMember.center.x, secondMember.center.x], [side, side, side])
  const [today, yesterday, branch, fork] = graph.paths
  assert.equal(today.neutral, true)
  assert.equal(yesterday.neutral, true)
  assert.deepEqual(today.points, [burst.center, diamond.center])
  assert.deepEqual(yesterday.points, [last.center, last.center])
  assert.equal(branch.color, burst.color)
  assert.equal(fork.neutral, true)
  for (const path of [branch, fork]) {
    assert.deepEqual(path.points.map(point => point.x), [burst.center.x, side, side, burst.center.x])
    assert.ok(path.points[3].y > path.points[2].y)
  }
  assert.equal(graphWidth(graph), ACTIVITY_GUTTER)
  assert.equal(graphWidth(activityLayout(collapsed.rows, repos)), ACTIVITY_GUTTER)
})

test('activity state validates identities and preserves only the newest 200 expanded events', () => {
  const expanded = Array.from({ length: 201 }, (_, i) => activityCommitKey(alpha, id(i)))
  const active = sanitizeState({
    timelineScope: 'all', activitySelected: expanded[1], activityEntry: expanded[1], activityScroll: 44.5,
    activityExpanded: ['malformed', expanded[0], ...expanded, 'day\0date', 13],
  })
  assert.equal(active.timelineScope, 'all')
  assert.equal(active.activitySelected, expanded[1])
  assert.equal(active.activityEntry, expanded[1])
  assert.equal(active.activityScroll, 44.5)
  assert.deepEqual(active.activityExpanded, expanded.slice(1))
  assert.deepEqual(expandActivity(expanded.slice(0, 200), expanded[200]), active.activityExpanded)
  const invalid = sanitizeState({ timelineScope: 'network', activitySelected: 'day\0date', activityEntry: 'INVALID', activityScroll: -1 })
  assert.equal(invalid.timelineScope, 'repository')
  assert.equal(invalid.activitySelected, null)
  assert.equal(invalid.activityEntry, null)
  assert.equal(invalid.activityScroll, 0)
  assert.equal(resolveTimelineScope('all', 0), 'repository')
  assert.equal(resolveTimelineScope('all', 1), 'repository')
  assert.equal(resolveTimelineScope('all', 2), 'all')
})

test('activity first-page splice replaces the covered interval, deduplicates, and retains the deeper cursor only when needed', () => {
  const previous = { entries: [commit(alpha, 1, 9000), commit(alpha, 2, 8000), commit(beta, 3, 7000)], next: day + 6999,
    failures: [{ repo: gamma, error: { code: 'internal' } }] }
  const newFirst = commit(gamma, 4, 10_000)
  const moved = commit(beta, 3, 8000)
  const page = { entries: [newFirst, newFirst, moved], next: day + 7999, failures: [] }
  assert.deepEqual(resetActivityPage(page), { ...page, entries: [newFirst, moved] })
  assert.deepEqual(spliceActivityPage(previous, page), { entries: [newFirst, moved], next: previous.next, failures: [] })
  const shallow = { ...previous, entries: previous.entries.slice(0, 2) }
  assert.deepEqual(spliceActivityPage(shallow, page), resetActivityPage(page))
  const exhausted = { ...previous, next: null }
  assert.equal(spliceActivityPage(exhausted, page).next, null, 'an exhausted deeper read remains exhausted')
  const empty: ActivityAnswer = { entries: [], next: null, failures: [] }
  assert.deepEqual(spliceActivityPage(previous, empty), empty, 'an empty first page supersedes the old read')
})

test('paging caps unique activity entries and keeps failures from earlier pages', () => {
  const previous: ActivityAnswer = {
    entries: Array.from({ length: ACTIVITY_ENTRY_MAX - 1 }, (_, i) => commit(alpha, i, -i)),
    next: day - ACTIVITY_ENTRY_MAX,
    failures: [{ repo: gamma, error: { code: 'internal' } }],
  }
  const first = commit(beta, 1, -ACTIVITY_ENTRY_MAX)
  const last = commit(beta, 2, -ACTIVITY_ENTRY_MAX - 1)
  const next = { entries: [previous.entries.at(-1)!, first, last], next: null, failures: [{ repo: delta, error: { code: 'internal' } }] }
  const appended = appendActivityPage(previous, next)
  assert.equal(appended.entries.length, ACTIVITY_ENTRY_MAX)
  assert.equal(appended.entries.at(-1), first)
  assert.deepEqual(appended.failures.map(failure => failure.repo), [gamma, delta])
  assert.equal(resetActivityPage({ ...previous, entries: [...previous.entries, first, last] }).entries.length, ACTIVITY_ENTRY_MAX)
  assert.equal(spliceActivityPage(previous, { ...next, entries: [commit(beta, 3, 7), commit(beta, 4, 6)] }).entries.length, ACTIVITY_ENTRY_MAX)
})
