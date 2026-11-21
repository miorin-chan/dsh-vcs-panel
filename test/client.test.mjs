import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultState, isNode, loadState, nodePatch, preferredNode, saveState, sanitizeState,
  SIDEBAR_MIN, SIDEBAR_MAX, storageKey, WORKING_COPY, WORKTREE, worktreeNode,
} from '../lib/client/state.js'
import {
  branchOpMessage, commitOpMessage, errorMessage, formatCommitTime, formatCount, formatDateTime, lineCounts,
  sessionRelativePath, shortChangeId, shortSha, splitPath, statusKey, switchMessage, syncMessage, tagOpMessage,
} from '../lib/client/format.js'
import { branchActions, isDestructiveAction, remoteBranchActions } from '../lib/client/branch.js'
import { tagActions } from '../lib/client/tag.js'
import { commitActions, isDestructiveCommitAction } from '../lib/client/commit.js'
import {
  buildNodeRows, buildRows, dirKey, isRowKey, rowBodyId, sectionKey, summarizeEntries,
} from '../lib/client/detail/tree.js'
import {
  FOLD_LINES, SPLIT_MIN_WIDTH, STREAM_BUDGET, allFileFolds, budgetFolds, changedLines, commitGroups,
  commitSummary, comparisonBase, diffTarget, estimateHeight, expandedFileFolds, hasUnfoldedFile, isFolded,
  diffTargets, mergedWorktreeGroups, rowAt, streamSections, worktreeGroups,
} from '../lib/client/detail/detail.js'
import { createQueue } from '../lib/client/detail/queue.js'
import { counterpartKey, isStageable, mergedStageState, STAGE, stageFiles, UNSTAGE } from '../lib/client/detail/stage.js'
import { graphInput, nodeAt, rowOf, worktreeSummary } from '../lib/client/history/timeline-model.js'
import { attachWorkingCopies, checkedWorktrees, preferredViewNode, sharedRefs, toggleWorktree } from '../lib/client/worktrees.js'
import { ApiError, createApi, queryString } from '../lib/client/api.js'
import {
  commitBranchRelation, hasSeveralAuthors, indexCommits, messageBody, reachableCommits,
} from '../lib/client/history/commits.js'

/** A Map-backed Storage stand-in. */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    map,
  }
}

test('defaultState is fresh each time', () => {
  const first = defaultState()
  const second = defaultState()
  assert.notEqual(first, second)
  assert.deepEqual(first, second)
  assert.equal(first.node, null)
  assert.equal(first.nodeChosen, false)
  assert.equal(first.ref, 'all')
  assert.equal(first.anchor, null)
  assert.equal(first.split, false)
  assert.equal(first.wrap, true)
  assert.equal(first.mergeStaging, true)
  assert.equal(first.twoColumns, true)
  assert.equal(first.sidebarWidth, 320)
})

test('sanitizeState keeps accepted values and drops unknown ones', () => {
  const state = sanitizeState({
    repo: '/repo',
    repositoryScope: 'selected',
    checkedRepositories: ['/repo', '/other', '/repo', 1, ''],
    node: 'abcdef1234567890',
    nodeChosen: true,
    dirs: { 'unstaged|tmp': true, 'untracked|old': true, bad: 'yes' },
    collapsed: { 'staged|src': true, 'untracked|old': true },
    folds: { 'commit|a.js': true, 'commit|b.js': false, bad: 'x' },
    anchor: { key: 'commit|a.js', offset: 120 },
    ref: 'all',
    split: true,
    wrap: true,
    sidebarWidth: 9999,
    timelineScroll: 88,
    tab: 'history',
  })
  assert.equal(state.repo, '/repo')
  assert.equal(state.repositoryScope, 'selected')
  assert.deepEqual(state.checkedRepositories, ['/repo', '/other'])
  assert.equal(state.expandedRepositories, null)
  assert.deepEqual(sanitizeState({ expandedRepositories: [] }).expandedRepositories, [])
  assert.deepEqual(sanitizeState({ expandedRepositories: ['/repo', '/repo', 1] }).expandedRepositories, ['/repo'])
  assert.equal(sanitizeState({ repositoryScope: 'unknown' }).repositoryScope, 'all')
  assert.equal(state.node, 'abcdef1234567890')
  assert.equal(state.nodeChosen, true)
  assert.deepEqual(state.dirs, { 'unstaged|tmp': true })
  assert.deepEqual(state.collapsed, { 'staged|src': true })
  assert.deepEqual(state.folds, { 'commit|a.js': true, 'commit|b.js': false })
  assert.deepEqual(state.anchor, { key: 'commit|a.js', offset: 120 })
  assert.equal(state.ref, 'all')
  assert.equal(state.split, true)
  assert.equal(state.wrap, true)
  assert.equal(state.sidebarWidth, SIDEBAR_MAX)
  assert.equal(state.timelineScroll, 88)
  assert.equal('tab' in state, false)
  assert.equal(sanitizeState({ node: WORKTREE }).node, WORKTREE)
  assert.equal(sanitizeState({ node: WORKING_COPY }).node, WORKING_COPY)
  assert.equal(sanitizeState({ ref: '@' }).ref, '@')
})

test('sanitizeState drops the old untracked row keys and keeps current ones', () => {
  const dropped = sanitizeState({
    dirs: { 'untracked|tmp': true },
    collapsed: { 'untracked|tmp': true },
    folds: { 'untracked|tmp/a.js': true },
    anchor: { key: 'untracked|tmp/a.js', offset: 10 },
  })
  assert.deepEqual(dropped.dirs, {})
  assert.deepEqual(dropped.collapsed, {})
  assert.deepEqual(dropped.folds, {})
  assert.equal(dropped.anchor, null, 'an old anchor returns to the default position')

  // Group rows, directories, and files of the current model all restore.
  for (const key of ['staged|', 'unstaged|src/client', 'commit|src/a.js']) {
    assert.deepEqual(
      sanitizeState({ anchor: { key, offset: 4 } }).anchor,
      { key, offset: 4 },
      key,
    )
  }
  assert.equal(sanitizeState({ anchor: { key: 'unknown|a', offset: 1 } }).anchor, null)
})

test('sanitizeState keeps default-on preferences unless an explicit false turns them off', () => {
  for (const field of ['wrap', 'mergeStaging', 'twoColumns']) {
    assert.equal(defaultState()[field], true, `${field} defaults on`)
    assert.equal(sanitizeState({})[field], true, `older state without ${field} keeps it on`)
    assert.equal(sanitizeState({ [field]: false })[field], false, `explicit false disables ${field}`)
    assert.equal(sanitizeState({ [field]: true })[field], true, `explicit true keeps ${field} on`)
    assert.equal(sanitizeState({ [field]: 0 })[field], true, `only an explicit false disables ${field}`)
    assert.equal(sanitizeState({ [field]: 'false' })[field], true)
  }
})

test('sanitizeState rejects malformed selections, anchors, and ranges', () => {
  const state = sanitizeState({
    node: 'not-hex',
    nodeChosen: true,
    anchor: { key: '', offset: 5 },
    ref: 'origin/main',
    sidebarWidth: -1,
    timelineScroll: -3,
  })
  assert.equal(state.node, null)
  assert.equal(state.nodeChosen, false, 'a choice without a node is no choice')
  assert.equal(state.anchor, null)
  assert.equal(state.ref, 'all')
  assert.equal(sanitizeState({ ref: 'HEAD' }).ref, 'HEAD')
  assert.equal(state.sidebarWidth, SIDEBAR_MIN)
  assert.equal(state.timelineScroll, 0)
  assert.equal(sanitizeState({ anchor: { key: 'a', offset: Number.NaN } }).anchor, null)
  assert.equal(isNode('abc123'), false, 'shorter than an abbreviated id')
  assert.equal(isNode('ABCDEF1'), true)
  assert.equal(isNode(WORKING_COPY), true)
})

test('preferredNode follows the working tree until the user chooses', () => {
  const dirty = { total: 3, branch: { oid: 'a'.repeat(40) } }
  const clean = { total: 0, branch: { oid: 'b'.repeat(40) } }
  const unborn = { total: 0, branch: { oid: null, unborn: true } }
  const unchosen = { node: null, nodeChosen: false }
  assert.equal(preferredNode(unchosen, dirty), WORKTREE)
  assert.equal(preferredNode(unchosen, clean), 'b'.repeat(40))
  assert.equal(preferredNode(unchosen, unborn), WORKTREE)
  assert.equal(preferredNode({ node: WORKTREE, nodeChosen: false }, clean), 'b'.repeat(40), 'a default moves with the tree')
  assert.equal(preferredNode({ node: WORKTREE, nodeChosen: true }, clean), WORKTREE, 'a choice stays')
  assert.equal(preferredNode({ node: 'c'.repeat(40), nodeChosen: true }, dirty), 'c'.repeat(40))
  assert.equal(preferredNode(unchosen, null), null, 'nothing to decide before the status answers')

  // A backend names its own default; the Jujutsu default is the working copy.
  const jj = { total: 2, branch: null, defaultNode: WORKING_COPY }
  assert.equal(preferredNode(unchosen, jj), WORKING_COPY)
  assert.equal(preferredNode({ node: 'c'.repeat(40), nodeChosen: true }, jj), 'c'.repeat(40))
})

test('nodePatch resets reading state and commit folders only when the node changes', () => {
  const state = {
    ...defaultState(),
    node: WORKTREE,
    nodeChosen: false,
    folds: { 'staged|a.js': true },
    anchor: { key: 'staged|a.js', offset: 10 },
    collapsed: { 'staged|src': true, 'commit|lib': true },
  }
  const moved = nodePatch(state, 'd'.repeat(40), true)
  assert.deepEqual(moved, {
    node: 'd'.repeat(40),
    nodeChosen: true,
    anchor: null,
    folds: {},
    collapsed: { 'staged|src': true },
  })
  assert.deepEqual(nodePatch(state, WORKTREE, true), { nodeChosen: true }, 'choosing the shown node keeps its reading state')
  assert.deepEqual(nodePatch(state, WORKTREE, false), {})
})

test('formatCount follows the supplied locale', () => {
  assert.equal(formatCount(1234, 'en-US'), '1,234')
  assert.equal(formatCount(1234, 'de-DE'), '1.234')
  assert.equal(formatCount(1234), new Intl.NumberFormat().format(1234))
})

test('loadState and saveState round-trip through sessionStorage', () => {
  const storage = fakeStorage()
  const stored = { ...defaultState(), repo: '/r', node: WORKTREE, nodeChosen: true, timelineScroll: 9,
    mergeStaging: true, anchor: { key: 'merged|a', offset: 4 }, folds: { 'merged|a': false } }
  saveState('session-1', stored, storage)
  assert.equal(storage.map.has(storageKey('session-1')), true)
  assert.deepEqual(loadState('session-1', storage), stored)
  assert.deepEqual(loadState('missing', storage), defaultState())
})

test('loadState survives unreadable storage', () => {
  const storage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  assert.deepEqual(loadState('s', storage), defaultState())
  assert.doesNotThrow(() => saveState('s', defaultState(), storage))
})

test('repository paths use the session directory without stripping unrelated prefixes', () => {
  assert.equal(sessionRelativePath('/project', '/project/packages/frontend/shared'), 'packages/frontend/shared')
  assert.equal(sessionRelativePath('/project/', '/project/packages/backend/shared'), 'packages/backend/shared')
  assert.equal(sessionRelativePath('/project/', '/project'), '.')
  assert.equal(sessionRelativePath('/project/packages/frontend', '/project'), '../..')
  assert.equal(sessionRelativePath('/project', '/project-other/shared'), '/project-other/shared')
  assert.equal(sessionRelativePath(null, '/project/shared'), '/project/shared')
  assert.equal(sessionRelativePath('/', '/project'), 'project')
  assert.equal(sessionRelativePath('C:\\project\\', 'C:\\project\\packages\\shared'), 'packages/shared')
  assert.equal(sessionRelativePath('C:\\project', 'D:\\project\\shared'), 'D:\\project\\shared')
  assert.equal(sessionRelativePath('/project', '/project/name\\with-backslash'), 'name\\with-backslash')
})

test('format helpers describe paths, ids, and statuses', () => {
  assert.deepEqual(splitPath('src/client/a.js'), { dir: 'src/client/', base: 'a.js' })
  assert.deepEqual(splitPath('README.md'), { dir: '', base: 'README.md' })
  assert.equal(shortSha('abcdef1234'), 'abcdef1')
  assert.equal(statusKey('A'), 'status.added')
  assert.equal(statusKey('U'), 'status.conflict')
  assert.equal(statusKey('U', true), 'status.untracked', 'the untracked U says untracked, not conflict')
  assert.equal(statusKey('Z'), 'status.changed')
  assert.deepEqual(lineCounts({ added: 3, deleted: 1 }), { added: 3, deleted: 1 })
  assert.deepEqual(lineCounts({}), { added: null, deleted: null })
  assert.deepEqual(lineCounts(null), { added: null, deleted: null })
})

test('errorMessage localizes known codes and falls back to the Host message', () => {
  const t = key => `t:${key}`
  assert.equal(errorMessage(t, { code: 'timeout', message: 'raw' }), 't:error.timeout')
  assert.equal(errorMessage(t, { code: 'network', message: 'raw' }), 't:error.network')
  assert.equal(errorMessage(t, { code: 'switch-blocked', message: 'raw' }), 't:error.switchBlocked')
  assert.equal(errorMessage(t, { code: 'switch-failed', message: 'raw' }), 't:error.switchFailed')
  assert.equal(errorMessage(t, { code: 'unheard-of', message: 'host text' }), 'host text')
  assert.equal(
    errorMessage(t, { code: 'vcs-missing', message: 'jj is not available on this host.' }),
    'jj is not available on this host.',
    'the missing-tool message names the backend',
  )
  assert.equal(errorMessage(t, null), 't:error.internal')
})

test('shortChangeId keeps change ids readable in a row', () => {
  assert.equal(shortChangeId('abcdefghijkl'), 'abcdefgh')
  assert.equal(shortChangeId('abc'), 'abc')
  assert.equal(shortChangeId(undefined), '')
  assert.equal(shortSha(undefined), '')
  assert.equal(formatDateTime(1e20, 'en-US'), '')
})

test('formatCommitTime is relative within a week and absolute beyond', () => {
  const now = Date.UTC(2026, 10, 14, 12, 0, 0)
  const fiveMinutes = formatCommitTime(now - 5 * 60_000, now, 'en-US')
  assert.match(fiveMinutes, /^5 min/)
  assert.doesNotMatch(fiveMinutes, /minutes/)
  const old = formatCommitTime(now - 30 * 86400_000, now, 'en-US')
  assert.match(old, /2026/)
})

test('buildRows nests staged files and respects collapsed directories', () => {
  const entries = [
    { path: 'src/b.js', status: 'M', added: 2, deleted: 1 },
    { path: 'src/a.js', status: 'A', added: 4, deleted: 0 },
    { path: 'README.md', status: 'M', added: 1, deleted: 1 },
  ]
  const rows = buildRows('staged', entries)
  assert.deepEqual(rows.map(row => row.kind), ['dir', 'file', 'file', 'file'])
  assert.equal(rows[0].name, 'src')
  assert.equal(rows[0].expanded, true)
  assert.deepEqual(rows.filter(row => row.kind === 'file').map(row => row.name), ['a.js', 'b.js', 'README.md'])
  assert.equal(rows[0].key, dirKey('staged', 'src'))
  assert.equal(rows[1].key, sectionKey('staged', 'src/a.js'))
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[1].depth, 1)

  const collapsed = buildRows('staged', entries, { collapsed: { [dirKey('staged', 'src')]: true } })
  assert.deepEqual(collapsed.filter(row => row.kind === 'file').map(row => row.name), ['README.md'])
  assert.equal(collapsed[0].expanded, false)
})

test('buildRows starts a working-tree group with a group row that counts its files', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 3, deleted: 1 },
    { path: 'b.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
    { path: 'docs/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 },
  ]
  const rows = buildRows('unstaged', entries, {}, { header: true })
  assert.equal(rows[0].kind, 'group')
  assert.equal(rows[0].key, dirKey('unstaged', ''))
  assert.equal(rows[0].expanded, true)
  assert.equal(rows[0].count, 3, 'untracked files and directories count')
  assert.equal(rows[0].added, 3)
  assert.equal(rows[0].deleted, 1)

  const closed = buildRows('unstaged', entries, { collapsed: { [dirKey('unstaged', '')]: true } }, { header: true })
  assert.deepEqual(closed.map(row => row.kind), ['group'])
  assert.equal(closed[0].expanded, false)
})

test('buildRows compresses a chain of single-child directories into one row', () => {
  const entries = [
    { path: 'src/client/detail/a.js', status: 'M', added: 1, deleted: 0 },
    { path: 'src/client/detail/b.js', status: 'M', added: 1, deleted: 0 },
    { path: 'top.txt', status: 'M', added: 1, deleted: 0 },
  ]
  const rows = buildRows('commit', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), [
    'dir:src/client/detail', 'file:a.js', 'file:b.js', 'file:top.txt',
  ])
  assert.equal(rows[0].path, 'src/client/detail/')
  assert.equal(rows[0].key, dirKey('commit', 'src/client/detail'))
  assert.equal(rows[1].depth, 1)
  assert.equal(rows[3].depth, 0)
})

test('group and directory rows carry the entries one staging write names', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 1, deleted: 0 },
    { path: 'src/lib/b.js', status: 'R', origPath: 'src/b.js', added: 0, deleted: 0 },
    { path: 'src/notes/', status: 'U', untracked: true, directory: true },
    { path: 'src/conflict.js', status: 'U', conflict: true },
  ]
  const notes = dirKey('unstaged', 'src/notes/')
  const rows = buildRows('unstaged', entries, {
    dirs: { [notes]: true },
    dirChildren: { [notes]: [
      { name: 'inner', path: 'src/notes/inner', type: 'directory' },
      { name: 'x.txt', path: 'src/notes/x.txt', type: 'file' },
    ] },
  }, { header: true })
  const row = name => rows.find(item => item.name === name)
  assert.deepEqual(rows[0].entries, entries, 'a group row stands for its whole group')
  assert.deepEqual(row('src').entries.map(entry => entry.path), ['src/a.js', 'src/lib/b.js', 'src/notes/', 'src/conflict.js'])
  assert.deepEqual(row('notes').entries, [entries[2]], 'an untracked directory stands for itself, not its loaded children')
  assert.deepEqual(stageFiles('unstaged', row('src').entries, STAGE), [
    { path: 'src/a.js' }, { path: 'src/lib/b.js', oldPath: 'src/b.js' }, { path: 'src/notes/' },
  ], 'the conflict stays out of the write')
  assert.deepEqual(stageFiles('unstaged', row('src').entries, UNSTAGE), [], 'rows under Unstaged only stage')
  assert.deepEqual(stageFiles('unstaged', row('inner').entries, STAGE), [{ path: 'src/notes/inner/' }])
  assert.equal(isStageable({ path: 'n.txt', status: 'U', untracked: true }), true)
  assert.equal(isStageable(entries[3]), false)

  const merged = mergedWorktreeGroups([
    { id: 'staged', entries: [{ path: 'a.js', status: 'M' }, { path: 'only-staged.js', status: 'A' }] },
    { id: 'unstaged', entries: [{ path: 'a.js', status: 'M' }, { path: 'n/', status: 'U', untracked: true, directory: true }] },
  ])[0].entries
  assert.deepEqual(stageFiles('merged', merged, STAGE), [{ path: 'a.js' }, { path: 'n/' }])
  assert.deepEqual(stageFiles('merged', merged, UNSTAGE), [{ path: 'a.js' }, { path: 'only-staged.js' }])
  assert.equal(mergedStageState(merged), 'mixed')
  assert.equal(mergedStageState(merged.filter(entry => entry.path === 'only-staged.js')), true)
  assert.equal(mergedStageState(merged.filter(entry => entry.path === 'n/')), false)
  assert.equal(counterpartKey('staged|src'), 'unstaged|src')
  assert.equal(counterpartKey('unstaged|'), 'staged|')
  assert.equal(counterpartKey('merged-dir|src'), undefined)
})

test('buildRows expands untracked directories only after their children load', () => {
  const entries = [
    { path: 'notes/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 },
    { path: 'scratch.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
  ]
  const key = dirKey('unstaged', 'notes/')
  const closed = buildRows('unstaged', entries)
  assert.deepEqual(closed.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'file:scratch.txt'])
  assert.equal(closed[0].expanded, false)
  assert.equal(closed[0].loadable, true, 'a directory Git reported whole loads on demand')

  const loading = buildRows('unstaged', entries, { dirs: { [key]: true }, loadingDirs: { [key]: true } })
  assert.deepEqual(loading.map(row => row.kind), ['dir', 'loading', 'file'])

  const opened = buildRows('unstaged', entries, {
    dirs: { [key]: true },
    dirChildren: {
      [key]: [
        { name: 'inner/', path: 'notes/inner/', type: 'directory' },
        { name: 'a.txt', path: 'notes/a.txt', type: 'file' },
      ],
    },
  })
  assert.deepEqual(opened.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:a.txt', 'file:scratch.txt'])
  const innerKey = dirKey('unstaged', 'notes/inner/')
  assert.equal(opened[1].expanded, false)
  const deeper = buildRows('unstaged', entries, {
    dirs: { [key]: true, [innerKey]: true },
    dirChildren: {
      [key]: [{ name: 'inner/', path: 'notes/inner/', type: 'directory' }],
      [innerKey]: [{ name: 'b.txt', path: 'notes/inner/b.txt', type: 'file' }],
    },
  })
  assert.deepEqual(deeper.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:b.txt', 'file:scratch.txt'])
})

test('buildRows expands untracked directories only after their children load', () => {
  const entries = [
    { path: 'notes/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 },
    { path: 'scratch.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
  ]
  const key = dirKey('untracked', 'notes/')
  const closed = buildRows('untracked', entries)
  assert.deepEqual(closed.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'file:scratch.txt'])
  assert.equal(closed[0].expanded, false)

  const loading = buildRows('untracked', entries, { dirs: { [key]: true }, loadingDirs: { [key]: true } })
  assert.deepEqual(loading.map(row => row.kind), ['dir', 'loading', 'file'])

  const opened = buildRows('untracked', entries, {
    dirs: { [key]: true },
    dirChildren: {
      [key]: [
        { name: 'inner/', path: 'notes/inner/', type: 'directory' },
        { name: 'a.txt', path: 'notes/a.txt', type: 'file' },
      ],
    },
  })
  assert.deepEqual(opened.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:a.txt', 'file:scratch.txt'])
  const innerKey = dirKey('untracked', 'notes/inner/')
  assert.equal(opened[1].expanded, false)
  const deeper = buildRows('untracked', entries, {
    dirs: { [key]: true, [innerKey]: true },
    dirChildren: {
      [key]: [{ name: 'inner/', path: 'notes/inner/', type: 'directory' }],
      [innerKey]: [{ name: 'b.txt', path: 'notes/inner/b.txt', type: 'file' }],
    },
  })
  assert.deepEqual(deeper.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:inner', 'file:b.txt', 'file:scratch.txt'])
})

test('queryString skips absent values and escapes the rest', () => {
  assert.equal(queryString({ a: 'x y', b: undefined, c: null, d: 2 }), '?a=x+y&d=2')
  assert.equal(queryString({}), '')
})

test('createApi builds exact Host routes', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url) => {
      calls.push(url)
      return {
        ok: true,
        async json() { return { ok: true } },
      }
    },
  })
  assert.deepEqual(await api.repositories(), { ok: true })
  await api.status('/repo')
  await api.branches('/repo')
  await api.untracked('/repo', 'dir/')
  await api.diff('/repo', { scope: 'commit', path: 'a.js', oldPath: 'old/a.js', rev: 'abc1234' })
  await api.log('/repo', { ref: 'all', skip: 300, limit: 300 })
  await api.commit('/repo', 'abc1234')
  await api.turn(3, 42)
  await api.turn(4, null)
  assert.equal(calls.length, 9)
  assert.match(calls[0], /^\/api\/vcs\.repositories\?sessionId=session\+1$/)
  assert.match(calls[1], /^\/api\/vcs\.status\?sessionId=session\+1&repo=%2Frepo$/)
  assert.match(calls[2], /^\/api\/vcs\.branches\?sessionId=session\+1&repo=%2Frepo$/)
  assert.match(calls[3], /path=dir%2F/)
  assert.match(calls[4], /scope=commit/)
  assert.match(calls[4], /oldPath=old%2Fa.js/)
  assert.match(calls[4], /rev=abc1234/)
  assert.match(calls[5], /skip=300/)
  assert.match(calls[5], /limit=300/)
  assert.match(calls[6], /sha=abc1234/)
  assert.equal(calls[7], '/api/vcs.turn?sessionId=session+1&turn=3&seq=42')
  assert.equal(calls[8], '/api/vcs.turn?sessionId=session+1&turn=4')
})

test('watch handles reconnect, ignores own writes, and closes its subscription', async () => {
  let source
  const requests = []
  const api = createApi('session 1', {
    clientId: 'local-panel',
    EventSourceImpl: class extends EventTarget {
      constructor(url) {
        super()
        this.url = url
        this.closed = false
        source = this
      }
      close() { this.closed = true }
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return Response.json({})
    },
  })
  let ready = 0
  const invalidations = []
  const close = api.watch('/repo', ['/tree 1', '/tree 2'], () => { ready += 1 }, domains => invalidations.push(domains))
  const target = new URL(source.url, 'http://127.0.0.1')
  assert.equal(target.pathname, '/api/vcs.watch')
  assert.equal(target.searchParams.get('sessionId'), 'session 1')
  assert.equal(target.searchParams.get('repo'), '/repo')
  assert.equal(target.searchParams.get('client'), 'local-panel')
  assert.deepEqual(target.searchParams.getAll('worktree'), ['/tree 1', '/tree 2'])
  source.dispatchEvent(new Event('ready'))
  source.dispatchEvent(new Event('ready'))
  for (const data of ['bad json', '{}', '{"domains":["working"],"origin":"local-panel"}', '{"domains":["history"]}']) {
    source.dispatchEvent(new MessageEvent('invalidate', { data }))
  }
  assert.equal(ready, 2)
  assert.deepEqual(invalidations, [['history']])
  close()
  assert.equal(source.closed, true)

  await api.status('/repo', undefined, { readOnly: true })
  await api.sync('/repo')
  assert.match(requests[0].url, /&readOnly=1$/)
  assert.equal(requests[1].init.headers['X-VCS-Client'], 'local-panel')
})

test('worktree content reads carry the allowed repository and the selected checkout separately', async () => {
  const calls = []
  const api = createApi('s', {
    worktreeOf: '/repo',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url, 'http://127.0.0.1')
      assert.equal(init.method, 'GET')
      assert.equal(parsed.searchParams.get('sessionId'), 's')
      assert.equal(parsed.searchParams.get('repo'), '/repo')
      assert.equal(parsed.searchParams.get('worktree'), '/cwd/other tree')
      calls.push(parsed.pathname)
      return Response.json({})
    },
  })
  const checkout = '/cwd/other tree'
  await api.status(checkout)
  await api.untracked(checkout, 'drafts/')
  await api.diff(checkout, { scope: 'staged', path: 'a.js' })
  await api.commit(checkout, 'abc1234')
  assert.deepEqual(calls, ['status', 'untracked', 'diff', 'commit'].map(name => `/api/vcs.${name}`))
})

test('the history request carries all checked worktree paths in one GET', async () => {
  const worktrees = ['/repo', '/another tree']
  const api = createApi('s', {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url, 'http://127.0.0.1')
      assert.equal(init.method, 'GET')
      assert.equal(parsed.pathname, '/api/vcs.log')
      assert.equal(parsed.searchParams.get('repo'), '/repo')
      assert.deepEqual(parsed.searchParams.getAll('worktree'), worktrees)
      assert.equal(parsed.searchParams.get('skip'), '300')
      return Response.json({ commits: [] })
    },
  })
  assert.deepEqual(await api.log('/repo', { ref: 'HEAD', worktrees, skip: 300 }), { commits: [] })
})

test('createApi sends sync as an uncancellable same-origin JSON POST and maps its refusals', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { upstream: 'origin/main', pulled: 0, pushed: 2 } } }
    },
  })
  assert.deepEqual(await api.sync('/repo'), { upstream: 'origin/main', pulled: 0, pushed: 2 })
  assert.equal(calls.length, 1)
  const [{ url, init }] = calls
  assert.equal(url, '/api/vcs.sync', 'the session and repository travel in the body, not the URL')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { sessionId: 'session 1', repo: '/repo' })
  assert.equal(init.signal, undefined, 'leaving the panel does not cut a push short')

  const diverged = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() { return { error: { code: 'diverged', message: 'The branch and its upstream have diverged.' } } },
    }),
  })
  await assert.rejects(diverged.sync('/r'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'diverged')
    assert.equal(error.status, 409)
    return true
  })

  const offline = createApi('s', { fetchImpl: async () => { throw new TypeError('offline') } })
  await assert.rejects(offline.sync('/r'), error => error.code === 'network')
})

test('createApi sends switch as a same-origin JSON POST and maps a refusal', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { branch: 'topic' } } }
    },
  })
  assert.deepEqual(await api.switchBranch('/repo', 'topic'), { branch: 'topic' })
  assert.equal(calls.length, 1)
  const [{ url, init }] = calls
  assert.equal(url, '/api/vcs.switch', 'the session, repository, and branch travel in the body')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { sessionId: 'session 1', repo: '/repo', branch: 'topic' })
  assert.equal(init.signal, undefined, 'leaving the panel does not cut a switch short')

  const blocked = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() {
        return { error: { code: 'switch-blocked', message: 'Git refused to switch because local changes would be overwritten.' } }
      },
    }),
  })
  await assert.rejects(blocked.switchBranch('/r', 'topic'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'switch-blocked')
    assert.equal(error.status, 409)
    return true
  })
})

test('switchMessage names the branch now checked out', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(switchMessage(t, { branch: 'topic' }, 'requested'), 'switch.done:{"branch":"topic"}')
  assert.equal(switchMessage(t, { branch: '' }, 'requested'), 'switch.done:{"branch":"requested"}', 'a malformed answer falls back to the pick')
  assert.equal(switchMessage(t, null, 'topic'), 'switch.done:{"branch":"topic"}')
})

test('syncMessage names what moved, preferring the push, and reports a level branch', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(syncMessage(t, { upstream: 'origin/main', pulled: 0, pushed: 1 }), 'sync.pushed.one:{"upstream":"origin/main","count":"1"}')
  assert.equal(
    syncMessage(t, { upstream: 'origin/main', pulled: 0, pushed: 1200 }, 'en-US'),
    'sync.pushed.other:{"upstream":"origin/main","count":"1,200"}',
  )
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 1, pushed: 0 }), 'sync.pulled.one:{"upstream":"up/x","count":"1"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 3, pushed: 0 }, 'en-US'), 'sync.pulled.other:{"upstream":"up/x","count":"3"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 2, pushed: 0 }, 'ru'), 'sync.pulled.few:{"upstream":"up/x","count":"2"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 5, pushed: 0 }, 'ru'), 'sync.pulled.many:{"upstream":"up/x","count":"5"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 21, pushed: 0 }, 'ru'), 'sync.pulled.one:{"upstream":"up/x","count":"21"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 1, pushed: 0 }, 'zh'), 'sync.pulled.other:{"upstream":"up/x","count":"1"}')
  assert.equal(syncMessage(t, { upstream: 'up/x', pulled: 0, pushed: 0 }), 'sync.level:{"upstream":"up/x"}')
  assert.equal(syncMessage(t, { pushed: -1, pulled: 'many' }), 'sync.level:{"upstream":""}', 'a malformed answer reads as level')
})

test('createApi sends branch actions as a same-origin JSON POST', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { from: 'old', branch: 'new' } } }
    },
  })
  assert.deepEqual(
    await api.branchOp('/repo', 'rename', { branch: 'old', name: 'new' }),
    { from: 'old', branch: 'new' },
  )
  const [{ url, init }] = calls
  assert.equal(url, '/api/vcs.branch', 'the session, repository, action, and target travel in the body')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'rename', branch: 'old', name: 'new',
  })
  assert.equal(init.signal, undefined, 'leaving the panel does not cut a branch action short')

  assert.deepEqual(await api.branchOp('/repo', 'delete', { branch: 'old', force: true }), { from: 'old', branch: 'new' })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'delete', branch: 'old', force: true,
  })

  await api.branchOp('/repo', 'push', { branch: 'old' })
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'push', branch: 'old',
  })

  await api.branchOp('/repo', 'checkout-remote', { branch: 'origin/topic', local: 'topic' })
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'checkout-remote', branch: 'origin/topic', local: 'topic',
  })

  const unmerged = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() { return { error: { code: 'branch-unmerged', message: 'This branch is not fully merged.' } } },
    }),
  })
  await assert.rejects(unmerged.branchOp('/r', 'delete', { branch: 'topic' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'branch-unmerged')
    assert.equal(error.status, 409)
    return true
  })
})

test('createApi loads remotes and sends tag actions as same-origin JSON POSTs', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init })
      if (url.startsWith('/api/vcs.remotes')) {
        return { ok: true, async json() { return { remotes: ['origin'], truncated: false } } }
      }
      return { ok: true, async json() { return { tag: 'v1', remote: 'origin', pushed: true } } }
    },
  })

  const controller = new AbortController()
  assert.deepEqual(await api.remotes('/repo', controller.signal), { remotes: ['origin'], truncated: false })
  assert.equal(calls[0].url, '/api/vcs.remotes?sessionId=session+1&repo=%2Frepo')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.signal, controller.signal)

  assert.deepEqual(
    await api.tagOp('/repo', 'push', { tag: 'v1', remote: 'origin' }),
    { tag: 'v1', remote: 'origin', pushed: true },
  )
  assert.equal(calls[1].url, '/api/vcs.tag')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.credentials, 'same-origin')
  assert.equal(calls[1].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'push', tag: 'v1', remote: 'origin',
  })
  assert.equal(calls[1].init.signal, undefined, 'leaving the panel does not cut a tag action short')

  await api.tagOp('/repo', 'delete', { tag: 'v1' })
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'delete', tag: 'v1',
  })
})

test('createApi sends commit actions as same-origin JSON POSTs', async () => {
  const calls = []
  const api = createApi('session 1', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json() { return { tag: 'v1', sha: 'a'.repeat(40) } } }
    },
  })

  assert.deepEqual(
    await api.commitOp('/repo', 'tag', { sha: 'a'.repeat(40), name: 'v1', message: 'release' }),
    { tag: 'v1', sha: 'a'.repeat(40) },
  )
  assert.equal(calls[0].url, '/api/vcs.commit-op')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'tag', sha: 'a'.repeat(40), name: 'v1', message: 'release',
  })
  assert.equal(calls[0].init.signal, undefined, 'leaving the panel does not cut a commit action short')

  await api.commitOp('/repo', 'reset', { sha: 'b'.repeat(40), mode: 'soft' })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sessionId: 'session 1', repo: '/repo', action: 'reset', sha: 'b'.repeat(40), mode: 'soft',
  })
})

test('branchActions keeps merge and rebase on a named current branch only', () => {
  assert.deepEqual(branchActions({ current: true, currentBranch: 'main' }), ['rename', 'push'])
  assert.deepEqual(
    branchActions({ current: false, currentBranch: 'main' }),
    ['checkout', 'rename', 'delete', 'merge', 'rebase', 'push'],
  )
  assert.deepEqual(
    branchActions({ current: false, currentBranch: null }),
    ['checkout', 'rename', 'delete', 'push'],
    'a detached HEAD has no current branch to merge or rebase',
  )
  assert.equal(isDestructiveAction('delete'), true)
  assert.equal(isDestructiveAction('delete-remote'), true)
  assert.equal(isDestructiveAction('merge'), false)
})

test('remoteBranchActions offers checkout and delete always, merge and pull on a branch', () => {
  assert.deepEqual(
    remoteBranchActions({ currentBranch: 'main' }),
    ['checkout-remote', 'delete-remote', 'merge-remote', 'pull-remote'],
  )
  assert.deepEqual(
    remoteBranchActions({ currentBranch: null }),
    ['checkout-remote', 'delete-remote'],
    'a detached HEAD has no current branch to merge or pull into',
  )
})

test('branchOpMessage names the ref each branch action moved', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(
    branchOpMessage(t, 'rename', 'old', { from: 'old', branch: 'new' }),
    'branch.renamed:{"from":"old","branch":"new"}',
  )
  assert.equal(branchOpMessage(t, 'delete', 'old', { branch: 'old' }), 'branch.deleted:{"branch":"old"}')
  assert.equal(
    branchOpMessage(t, 'merge', 'topic', { branch: 'topic', current: 'main', result: 'merged' }),
    'branch.merged:{"current":"main","branch":"topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'merge', 'topic', { branch: 'topic', current: 'main', result: 'fast-forward' }),
    'branch.fastForwarded:{"current":"main","branch":"topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'merge', 'topic', { branch: 'topic', current: 'main', result: 'up-to-date' }),
    'branch.upToDate:{"current":"main","branch":"topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'rebase', 'topic', { branch: 'topic', current: 'main' }),
    'branch.rebased:{"current":"main","branch":"topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'push', 'topic', { branch: 'topic', upstream: 'origin/topic', pushed: true }),
    'branch.pushed:{"branch":"topic","upstream":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'push', 'topic', { branch: 'topic', upstream: 'origin/topic', pushed: false }),
    'branch.pushLevel:{"branch":"topic","upstream":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'checkout-remote', 'origin/topic', { branch: 'origin/topic', local: 'topic' }),
    'branch.checkedOutRemote:{"branch":"origin/topic","local":"topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'delete-remote', 'origin/topic', { branch: 'origin/topic' }),
    'branch.deletedRemote:{"branch":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'merge-remote', 'origin/topic', { branch: 'origin/topic', current: 'main', result: 'merged' }),
    'branch.merged:{"current":"main","branch":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'pull-remote', 'origin/topic', { branch: 'origin/topic', current: 'main', result: 'merged' }),
    'branch.pulled:{"current":"main","branch":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'pull-remote', 'origin/topic', { branch: 'origin/topic', current: 'main', result: 'up-to-date' }),
    'branch.pulledLevel:{"current":"main","branch":"origin/topic"}',
  )
  assert.equal(
    branchOpMessage(t, 'rename', 'old', null),
    'branch.renamed:{"from":"old","branch":"old"}',
    'a malformed answer falls back to the pick',
  )
})

test('errorMessage maps every branch action refusal to localized copy', () => {
  const t = key => key
  for (const code of [
    'branch-invalid', 'branch-exists', 'branch-unmerged', 'branch-in-use',
    'merge-blocked', 'rebase-blocked', 'branch-failed', 'remote-branch-missing',
  ]) {
    assert.notEqual(errorMessage(t, { code }), 'error.internal', code)
  }
})

test('tagActions lists delete and push in menu order', () => {
  assert.deepEqual(tagActions(), ['delete', 'push'])
  assert.equal(isDestructiveAction('delete'), true)
})

test('tagOpMessage names the tag and the remote it reached', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  assert.equal(tagOpMessage(t, 'delete', 'v1', { tag: 'v1' }), 'tag.deleted:{"tag":"v1"}')
  assert.equal(
    tagOpMessage(t, 'push', 'v1', { tag: 'v1', remote: 'origin', pushed: true }),
    'tag.pushed:{"tag":"v1","remote":"origin"}',
  )
  assert.equal(
    tagOpMessage(t, 'push', 'v1', { tag: 'v1', remote: 'origin', pushed: false }),
    'tag.pushLevel:{"tag":"v1","remote":"origin"}',
  )
  assert.equal(
    tagOpMessage(t, 'push', 'v1', null),
    'tag.pushed:{"tag":"v1","remote":"v1"}',
    'a malformed answer falls back to the pick',
  )
})

test('commitActions follows the commit position and current branch', () => {
  const commit = { sha: 'a'.repeat(40), parents: ['b'.repeat(40)] }
  assert.deepEqual(
    commitActions({ commit, currentBranch: 'main', head: 'c'.repeat(40) }),
    ['add-tag', 'create-branch', 'checkout', 'cherry-pick', 'revert', 'drop', 'merge', 'rebase', 'reset'],
  )
  assert.deepEqual(
    commitActions({ commit, currentBranch: 'main', head: commit.sha }),
    ['add-tag', 'create-branch', 'revert', 'drop'],
    'HEAD itself cannot be checked out, cherry-picked, merged, rebased, or reset',
  )
  assert.deepEqual(
    commitActions({ commit, currentBranch: null, head: 'c'.repeat(40) }),
    ['add-tag', 'create-branch', 'checkout'],
    'a detached HEAD has no branch to pick, drop, merge, rebase, or reset',
  )
  assert.deepEqual(
    commitActions({ commit: { sha: 'a'.repeat(40), parents: [] }, currentBranch: 'main', head: 'c'.repeat(40) }),
    ['add-tag', 'create-branch', 'checkout', 'cherry-pick', 'revert', 'merge', 'rebase', 'reset'],
    'a root commit cannot be dropped',
  )
  assert.deepEqual(
    commitActions({ commit: { sha: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)] }, currentBranch: 'main', head: 'd'.repeat(40) }),
    ['add-tag', 'create-branch', 'checkout', 'cherry-pick', 'revert', 'merge', 'rebase', 'reset'],
    'a merge commit cannot be dropped',
  )
  assert.equal(isDestructiveCommitAction('drop'), true)
  assert.equal(isDestructiveCommitAction('reset'), true)
  assert.equal(isDestructiveCommitAction('revert'), false)
})

test('commitOpMessage names the commit and ref each action changed', () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  const sha = 'a'.repeat(40)
  assert.equal(
    commitOpMessage(t, 'tag', { sha, name: 'v1' }, { tag: 'v1', sha }),
    'commit.tagAdded:{"tag":"v1","sha":"aaaaaaa"}',
  )
  assert.equal(
    commitOpMessage(t, 'branch', { sha, name: 'topic' }, { branch: 'topic', sha }),
    'commit.branchCreated:{"branch":"topic","sha":"aaaaaaa"}',
  )
  assert.equal(commitOpMessage(t, 'checkout', { sha }, { sha }), 'commit.checkedOut:{"sha":"aaaaaaa"}')
  assert.equal(
    commitOpMessage(t, 'cherry-pick', { sha }, { sha, current: 'main' }),
    'commit.cherryPicked:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'revert', { sha }, { sha, current: 'main' }),
    'commit.reverted:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'drop', { sha }, { sha, current: 'main' }),
    'commit.dropped:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'merge', { sha }, { sha, current: 'main', result: 'fast-forward' }),
    'commit.fastForwarded:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'merge', { sha }, { sha, current: 'main', result: 'up-to-date' }),
    'commit.upToDate:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'merge', { sha }, { sha, current: 'main', result: 'merged' }),
    'commit.merged:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'rebase', { sha }, { sha, current: 'main' }),
    'commit.rebased:{"sha":"aaaaaaa","current":"main"}',
  )
  assert.equal(
    commitOpMessage(t, 'reset', { sha }, { sha, current: 'main', mode: 'hard' }),
    'commit.resetDone:{"sha":"aaaaaaa","current":"main","mode":"commit.resetHard:{}"}',
  )
  assert.equal(
    commitOpMessage(t, 'tag', { sha, name: 'v1' }, null),
    'commit.tagAdded:{"tag":"v1","sha":"aaaaaaa"}',
    'a malformed answer falls back to the pick',
  )
})

test('errorMessage maps every tag action refusal to localized copy', () => {
  const t = key => key
  for (const code of ['tag-invalid', 'tag-exists', 'tag-missing', 'remote-missing', 'tag-push-failed', 'tag-failed']) {
    assert.notEqual(errorMessage(t, { code }), 'error.internal', code)
  }

  for (const code of ['checkout-blocked', 'commit-not-on-branch', 'commit-conflict', 'commit-blocked', 'commit-failed']) {
    assert.notEqual(errorMessage(t, { code }), 'error.internal', code)
  }
})

test('createApi maps failure bodies and transport failures', async () => {
  const failing = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async json() { return { error: { code: 'not-found', message: 'File unavailable.' } } },
    }),
  })
  await assert.rejects(failing.diff('/r', { scope: 'unstaged', path: 'x' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'not-found')
    assert.equal(error.status, 404)
    assert.equal(error.message, 'File unavailable.')
    return true
  })

  const offline = createApi('s', {
    fetchImpl: async () => { throw new TypeError('offline') },
  })
  await assert.rejects(offline.repositories(), error => {
    assert.equal(error.code, 'network')
    return true
  })

  // A body-less non-2xx failure still carries its HTTP status.
  const gateway = createApi('s', {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() { throw new SyntaxError('bad gateway html') },
    }),
  })
  await assert.rejects(gateway.status('/r'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    assert.equal(error.status, 502)
    return true
  })
})

test('createApi preserves AbortError when cancelled during response body decoding and rejects malformed 200 bodies', async () => {
  // Cancelling a diff after 200 headers arrive (for example stepping past an
  // unloaded file with the keyboard) must reject as AbortError rather than
  // resolving null into FileDiff.
  const midBodyController = new AbortController()
  const abortedMidBody = createApi('s', {
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      async json() {
        midBodyController.abort()
        assert.equal(options.signal.aborted, true)
        throw new DOMException('The request was aborted.', 'AbortError')
      },
    }),
  })
  await assert.rejects(
    abortedMidBody.diff('/r', { scope: 'unstaged', path: 'a.js' }, midBodyController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // Some runtimes reject an aborted body stream with a TypeError while
  // signal.aborted is true; that is still an abort, not a null payload.
  const streamAbortController = new AbortController()
  const abortedStream = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        streamAbortController.abort()
        throw new TypeError('BodyStreamBuffer was aborted')
      },
    }),
  })
  await assert.rejects(
    abortedStream.diff('/r', { scope: 'unstaged', path: 'a.js' }, streamAbortController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // A transport rejection while signal.aborted is true also normalizes to AbortError.
  const fetchAbortController = new AbortController()
  fetchAbortController.abort('cancelled')
  const abortedFetch = createApi('s', {
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
  })
  await assert.rejects(
    abortedFetch.repositories(fetchAbortController.signal),
    error => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )

  // An uncancelled 200 response with unreadable JSON or a null body fails cleanly.
  const truncated200 = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError('Unexpected end of JSON input') },
    }),
  })
  await assert.rejects(truncated200.diff('/r', { scope: 'unstaged', path: 'a.js' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    return true
  })

  const null200 = createApi('s', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return null },
    }),
  })
  await assert.rejects(null200.diff('/r', { scope: 'unstaged', path: 'a.js' }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'internal')
    return true
  })
})

test('messageBody drops the subject paragraph and keeps the body verbatim', () => {
  assert.equal(messageBody('incr: one line'), '')
  assert.equal(messageBody('incr: subject\n'), '')
  assert.equal(messageBody('feat: subject\n\nWhy it changed.\n\n- detail'), 'Why it changed.\n\n- detail')
  // Git's %s joins a multi-line first paragraph; the body still starts after it.
  assert.equal(messageBody('first line\nsecond line\n\nbody'), 'body')
  // Whitespace-only separator lines, extra blank lines, and CRLF still split.
  assert.equal(messageBody('subject\n  \n\n\n  indented body\n\n'), '  indented body')
  assert.equal(messageBody('subject\r\n\r\nbody\r\n'), 'body')
  assert.equal(messageBody('subject\n\n   \n'), '')
  assert.equal(messageBody(''), '')
  assert.equal(messageBody(undefined), '')
})

test('hasSeveralAuthors is false for one author or none', () => {
  assert.equal(hasSeveralAuthors([]), false)
  assert.equal(hasSeveralAuthors([{ author: 'Ada' }, { author: 'Ada' }]), false)
  assert.equal(hasSeveralAuthors([{ author: 'Ada' }, { author: 'Ada' }, { author: 'Bob' }]), true)
})

test('indexCommits answers which commits are loaded and where', () => {
  const index = indexCommits([{ sha: 'a'.repeat(40) }, { sha: 'b'.repeat(40) }])
  assert.equal(index.get('b'.repeat(40)), 1)
  assert.equal(index.has('a'.repeat(40)), true)
  // A parent beyond the loaded pages is not selectable.
  assert.equal(index.has('c'.repeat(40)), false)
  assert.equal(indexCommits([]).size, 0)
})

test('timeline rows map independent worktrees above one shared commit sequence', () => {
  const commits = [{ sha: 'c1', parents: ['c2'], refs: [] }, { sha: 'c2', parents: [], refs: [] }]
  const index = indexCommits(commits)
  const worktrees = [{ id: worktreeNode('/repo'), head: 'c1' }, { id: worktreeNode('/unborn'), head: null }]
  assert.equal(nodeAt(commits, 0, { worktrees }), worktrees[0].id)
  assert.equal(nodeAt(commits, 1, { worktrees }), worktrees[1].id)
  assert.equal(nodeAt(commits, 2, { worktrees }), 'c1')
  assert.equal(nodeAt(commits, 4, { worktrees }), null)
  assert.equal(rowOf(index, worktrees[1].id, worktrees), 1)
  assert.equal(rowOf(index, 'c2', worktrees), 3)
  assert.equal(rowOf(index, 'missing', worktrees), -1)
  assert.equal(rowOf(index, null, worktrees), -1)
  assert.deepEqual(graphInput(commits, worktrees), [
    { sha: worktrees[0].id, parents: ['c1'], refs: [], worktree: true },
    { sha: worktrees[1].id, parents: [], refs: [], worktree: true },
    ...commits,
  ])

  // Without a synthetic row, the loaded commit at row 0 is the node.
  assert.equal(nodeAt(commits, 0), 'c1')
  assert.equal(nodeAt(commits, 1), 'c2')
  assert.equal(rowOf(index, WORKING_COPY), -1)
  assert.deepEqual(graphInput(commits, []), commits)
})

test('Jujutsu workspace paths index real commits, including two workspaces sharing one head', () => {
  const main = { path: '/repo', head: 'c1' }
  const sibling = { path: '/sibling', head: 'c1' }
  const commits = attachWorkingCopies([{ sha: 'c1' }, { sha: 'c2', workingCopy: true }], [main, sibling])
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0].workingCopies, [main, sibling])
  assert.equal(commits[0].workingCopy, true)
  assert.equal(commits[1].workingCopy, false, 'unchecked working-copy commits are ordinary history')
  const index = indexCommits(commits)
  assert.equal(nodeAt(commits, 0), worktreeNode(main.path))
  assert.equal(rowOf(index, worktreeNode(sibling.path)), 0)
  assert.equal(index.get('c1'), 0)
  assert.equal(nodeAt(commits, 1), 'c2')
  assert.deepEqual(graphInput(commits, []), commits)
  const legacy = { repo: '/repo', node: WORKING_COPY, nodeChosen: true }
  assert.equal(preferredViewNode(legacy, [main, sibling], null, true), worktreeNode(main.path))
  assert.equal(preferredViewNode(legacy, [sibling], null, true), worktreeNode(sibling.path))
})

test('the checklist restores valid choices, defaults to the anchor, and refuses an empty set', () => {
  const main = { path: '/repo', status: { total: 0 } }
  const sibling = { path: '/sibling', status: { total: 1 } }
  const trees = [main, sibling]
  const state = sanitizeState({ repo: '/repo', node: worktreeNode('/missing'), nodeChosen: true, worktrees: ['/sibling', 'gone', '/sibling', 1] })
  assert.deepEqual(state.worktrees, ['/sibling', 'gone'])
  assert.deepEqual(checkedWorktrees(trees, state.worktrees), [sibling])
  assert.deepEqual(checkedWorktrees(trees, ['gone']), [main])
  assert.deepEqual(toggleWorktree(trees, [], main.path), [main.path])
  assert.deepEqual(toggleWorktree(trees, [], sibling.path), [main.path, sibling.path])
  assert.deepEqual(toggleWorktree(trees, [sibling.path, main.path], main.path), [sibling.path])
  assert.equal(preferredViewNode(state, trees, null), worktreeNode(sibling.path))
  assert.equal(preferredViewNode({ ...state, node: WORKTREE }, [main], null), worktreeNode(main.path))
  assert.deepEqual(nodePatch({ ...state, dirs: { 'unstaged|docs': true } }, worktreeNode(sibling.path), true).dirs, {})
  assert.deepEqual(sharedRefs([{ kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'main', current: true }]), [{ kind: 'branch', name: 'main' }])
})

test('worktreeSummary counts tracked lines and untracked entries separately', () => {
  const status = {
    total: 4,
    groups: {
      staged: [{ path: 'a', status: 'A', added: 2, deleted: 0 }],
      unstaged: [{ path: 'b', added: 5, deleted: 1 }],
      untracked: [{ path: 'c', added: 0, deleted: 0 }, { path: 'dir/', directory: true }],
    },
  }
  assert.deepEqual(worktreeSummary(status), { changed: 4, added: 7, deleted: 1, untracked: 2 })
  assert.deepEqual(worktreeSummary({ ...status, total: 503, untrackedTotal: 501 }), {
    changed: 503, added: 7, deleted: 1, untracked: 501,
  })
  assert.deepEqual(worktreeSummary(null), { changed: 0, added: 0, deleted: 0, untracked: 0 })
})

test('the working tree has staged and unstaged groups, with untracked files merged', () => {
  const status = {
    groups: {
      staged: [{ path: 's.js', status: 'M', added: 1, deleted: 0 }],
      unstaged: [{ path: 'u.js', status: 'M', added: 2, deleted: 1 }],
      untracked: [{ path: 'n.txt', status: 'U', untracked: true, added: 0, deleted: 0 }],
    },
  }
  const groups = worktreeGroups(status)
  assert.deepEqual(groups.map(group => group.id), ['staged', 'unstaged'])
  assert.deepEqual(groups.map(group => group.header), [true, true])
  assert.deepEqual(groups[1].entries.map(entry => entry.path), ['u.js', 'n.txt'])
  const cappedGroup = worktreeGroups({ ...status, untrackedTotal: 501 })[1]
  const [cappedRow] = buildNodeRows([cappedGroup])
  assert.equal(cappedRow.count, 502)
  assert.equal(cappedRow.untracked, 501)
  assert.deepEqual(worktreeGroups(null), [])
  assert.deepEqual(worktreeGroups({ groups: {} }), [])

  // A working tree with only untracked files still has one group.
  assert.deepEqual(
    worktreeGroups({ groups: { untracked: [{ path: 'n.txt', status: 'U', untracked: true }] } }).map(group => group.id),
    ['unstaged'],
  )

  assert.deepEqual(commitGroups({ files: [{ path: 'x' }] }).map(group => group.id), ['commit'])
  assert.equal(commitGroups({ files: [{ path: 'x' }] })[0].header, false, 'commits draw no group row')
  assert.deepEqual(commitGroups({ files: [] }), [])
  assert.deepEqual(commitGroups(null), [])
})

test('merged worktree keeps both file sources and same-name untracked directories', () => {
  const groups = worktreeGroups({ groups: {
    staged: [{ path: 'shared', status: 'R', origPath: 'old' }, { path: 'replace', status: 'D' }],
    unstaged: [{ path: 'shared', status: 'M' }],
    untracked: [{ path: 'replace/', status: 'U', directory: true, untracked: true }],
  } })
  const rows = buildNodeRows(mergedWorktreeGroups(groups), {
    dirs: { 'unstaged|replace': true },
    dirChildren: { 'unstaged|replace': [{ name: 'new', path: 'replace/new', type: 'file' }] },
  })
  assert.deepEqual(rows.map(row => row.key), ['unstaged|replace', 'merged|replace/new', 'merged|replace', 'merged|shared'])
  const shared = rows.at(-1)
  assert.deepEqual(diffTargets(shared.group, shared.entry, null), [
    { scope: 'staged', path: 'shared', oldPath: 'old' }, { scope: 'unstaged', path: 'shared' },
  ])
  const child = rows[1]
  assert.deepEqual(diffTargets(child.group, child.entry, null), [{ scope: 'untracked', path: 'replace/new' }])
})

test('streamSections follow the fully expanded row order, not the current folds', () => {
  const groups = [
    { id: 'staged', entries: [{ path: 'src/b.js', status: 'M', added: 1, deleted: 0 }, { path: 'README.md', status: 'M' }], header: true },
    { id: 'unstaged', entries: [{ path: 'notes/', status: 'U', untracked: true, directory: true }, { path: 'z.txt', status: 'U', untracked: true }], header: true },
  ]
  const closed = streamSections(groups, {}, null)
  assert.deepEqual(closed.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'unstaged|z.txt'])

  const opened = streamSections(groups, { [dirKey('unstaged', 'notes/')]: [{ name: 'a.txt', path: 'notes/a.txt', type: 'file' }] }, null)
  assert.deepEqual(opened.map(section => section.key), ['staged|src/b.js', 'staged|README.md', 'unstaged|notes/a.txt', 'unstaged|z.txt'])
  assert.deepEqual(opened[0].target, { scope: 'staged', path: 'src/b.js' })
  assert.deepEqual(opened[2].target, { scope: 'untracked', path: 'notes/a.txt' })
})

test('buildNodeRows lists every group in order, group rows included', () => {
  const groups = [
    { id: 'staged', entries: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }], header: true },
    { id: 'unstaged', entries: [{ path: 'b.js', status: 'M', added: 1, deleted: 0 }], header: true },
  ]
  assert.deepEqual(buildNodeRows(groups).map(row => `${row.kind}:${row.key}`), [
    'group:staged|', 'file:staged|a.js', 'group:unstaged|', 'file:unstaged|b.js',
  ])
})

test('diffTarget takes its scope from the file, not from its group', () => {
  assert.deepEqual(diffTarget('commit', { path: 'new.js', origPath: 'old.js' }, 'c1'), {
    scope: 'commit', path: 'new.js', oldPath: 'old.js', rev: 'c1',
  })
  assert.deepEqual(diffTarget('unstaged', { path: 'a.js', status: 'M' }, 'ignored'), { scope: 'unstaged', path: 'a.js' })
  assert.deepEqual(
    diffTarget('unstaged', { path: 'n.txt', status: 'U', untracked: true }, null),
    { scope: 'untracked', path: 'n.txt' },
    'an untracked file compares its whole content against the index',
  )
})

test('budgetFolds reports the files that stay folded when every file is expanded', () => {
  const section = (key, added) => ({ key, entry: { added, deleted: 0 } })
  // Sections at the per-file limit fill the budget after this many.
  const fill = STREAM_BUDGET / FOLD_LINES
  const sections = [
    section('a', 10),
    section('huge', FOLD_LINES + 1),
    ...Array.from({ length: fill }, (_, index) => section(`full${index}`, FOLD_LINES)),
    section('c', 1),
    section('d', 1),
  ]
  const folds = budgetFolds(sections)
  assert.equal(folds.get('huge'), 'large')
  assert.equal(folds.has('a'), false)
  assert.equal(folds.has(`full${fill - 1}`), false, 'the section that crosses the budget still renders')
  assert.equal(folds.get('c'), 'budget')
  assert.equal(folds.get('d'), 'budget')
  assert.equal(budgetFolds([section('edge', FOLD_LINES)]).size, 0, 'exactly the limit stays open')

  assert.equal(isFolded('c', {}), true, 'files start folded')
  assert.equal(isFolded('c', { c: false }), false, 'the user can open a budget fold')
  assert.equal(isFolded('a', { a: false }), false, 'the user can open any file')
  assert.equal(isFolded('a', { a: true }), true, 'and fold it again')
})

test('changedLines and estimateHeight treat binaries and unknown counts as small', () => {
  assert.equal(changedLines({ added: 3, deleted: 2 }), 5)
  assert.equal(changedLines({ added: 3, deleted: 2, binary: true }), 0)
  assert.equal(changedLines({}), 0)
  assert.equal(estimateHeight({ binary: true }), 56)
  assert.equal(estimateHeight({ added: 0, deleted: 0 }), 120)
  assert.ok(estimateHeight({ added: 40, deleted: 0 }) > 40 * 20)
  assert.equal(estimateHeight({ added: 1e6, deleted: 0 }), 5000 * 20 + 24, 'capped at the rendered line limit')
})

test('rowAt finds the row a scroll offset is reading', () => {
  const tops = [0, 100, 250, 900]
  assert.equal(rowAt(tops, 0), 0)
  assert.equal(rowAt(tops, 99), 0)
  assert.equal(rowAt(tops, 100), 1)
  assert.equal(rowAt(tops, 5000), 3)
  assert.equal(rowAt([], 10), -1)
})

test('createQueue limits concurrency and drops cancelled waiting tasks', async () => {
  const queue = createQueue(2)
  const started = []
  const releases = []
  const task = name => () => {
    started.push(name)
    return new Promise(resolve => { releases.push(resolve) })
  }
  queue.enqueue(task('a'))
  queue.enqueue(task('b'))
  const cancelC = queue.enqueue(task('c'))
  queue.enqueue(task('d'))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(queue.running, 2)
  assert.equal(queue.waiting, 2)

  cancelC()
  assert.equal(queue.waiting, 1)
  releases[0]()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.deepEqual(started, ['a', 'b', 'd'], 'the cancelled task never starts')

  // A failing task frees its slot too.
  const failing = createQueue(1)
  const order = []
  failing.enqueue(() => Promise.reject(new Error('boom')))
  failing.enqueue(async () => { order.push('next') })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.deepEqual(order, ['next'])
})

test('summarizeEntries counts untracked paths separately from measured lines', () => {
  assert.deepEqual(summarizeEntries([]), { count: 0, added: 0, deleted: 0, untracked: 0 })
  assert.deepEqual(summarizeEntries([
    { path: 'a', status: 'U', added: 3, deleted: 1 },
    { path: 'dir/', status: 'U', untracked: true, added: 0, deleted: 0, directory: true },
    { path: 'draft.txt', status: 'U', untracked: true },
    { path: 'b', added: null, deleted: null },
  ]), { count: 4, added: 3, deleted: 1, untracked: 2 })
})

test('row keys, body ids, and the row key predicate agree', () => {
  assert.equal(isRowKey('staged|'), true)
  assert.equal(isRowKey('unstaged|src/a.js'), true)
  assert.equal(isRowKey('commit|src'), true)
  assert.equal(isRowKey('untracked|a'), false)
  assert.equal(isRowKey('bad'), false)
  assert.equal(isRowKey(null), false)
  assert.equal(rowBodyId('staged|src/a b.js'), rowBodyId('staged|src/a b.js'))
  assert.notEqual(rowBodyId('staged|a'), rowBodyId('staged|b'))
  assert.doesNotMatch(rowBodyId('staged|src/a b.js'), /\s/u, 'a DOM id cannot contain spaces')
})

test('comparisonBase names the comparison each commit kind uses', () => {
  const sha = 'a'.repeat(40)
  assert.deepEqual(comparisonBase({ parents: [sha] }, {}), { kind: 'parent', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [sha, 'b'.repeat(40)] }, {}), { kind: 'merge', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [] }, {}), { kind: 'root' })
  assert.deepEqual(comparisonBase(null, null), { kind: 'root' })
  // A backend with change ids compares against the parents' automatic merge.
  assert.deepEqual(comparisonBase({ parents: [sha] }, { changeId: true }), { kind: 'autoMerge', parent: sha })
  assert.deepEqual(comparisonBase({ parents: [] }, { changeId: true }), { kind: 'root' })
})

test('commitSummary counts the files and lines of a commit toolbar', () => {
  assert.deepEqual(commitSummary([{ added: 2, deleted: 1 }, { added: 5, deleted: 0 }, { binary: true, added: 0, deleted: 0 }]), {
    count: 3, added: 7, deleted: 1, untracked: 0,
  })
  assert.deepEqual(commitSummary(null), { count: 0, added: 0, deleted: 0, untracked: 0 })
})

test('the bulk fold button collapses every file and expansion follows the budget', () => {
  const large = { key: 'commit|large.js', entry: { added: FOLD_LINES + 1, deleted: 0 } }
  const small = { key: 'commit|small.js', entry: { added: 4, deleted: 0 } }
  const sections = [small, large]
  const budget = budgetFolds(sections)
  assert.equal(isFolded(small.key, {}), true, 'every file starts collapsed')
  assert.equal(hasUnfoldedFile(sections, {}), false)
  assert.equal(budget.get(large.key), 'large')

  // "Expand all files" opens the small file and leaves the large one folded.
  const expanded = expandedFileFolds(sections, budget)
  assert.deepEqual(expanded, { 'commit|small.js': false, 'commit|large.js': true })
  assert.equal(hasUnfoldedFile(sections, expanded), true)
  assert.equal(isFolded(small.key, expanded), false)
  assert.equal(isFolded(large.key, expanded), true, 'the budget keeps the large file folded')

  // "Collapse all files" folds the ones that were open, including hidden ones.
  const collapsed = allFileFolds(sections)
  assert.deepEqual(collapsed, { 'commit|small.js': true, 'commit|large.js': true })
  assert.equal(hasUnfoldedFile(sections, collapsed), false)
  assert.equal(isFolded(small.key, collapsed), true)
})

test('the folding budget does not depend on which directories are collapsed', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 10, deleted: 0 },
    { path: 'src/b.js', status: 'M', added: 10, deleted: 0 },
    { path: 'other/c.js', status: 'M', added: 10, deleted: 0 },
  ]
  const groups = [{ id: 'commit', entries, header: false }]
  const budget = budgetFolds(streamSections(groups, {}, 'rev'))
  const rowsClosed = buildNodeRows([groups[0]], { collapsed: { [dirKey('commit', 'src')]: true } })
  assert.deepEqual(rowsClosed.filter(row => row.kind === 'file').map(row => row.name), ['c.js'])
  assert.deepEqual([...budget.keys()], [], 'no file folds, so collapsing nothing else changes')
  const allFolds = allFileFolds(streamSections(groups, {}, 'rev'))
  assert.deepEqual(allFolds, { 'commit|other/c.js': true, 'commit|src/a.js': true, 'commit|src/b.js': true })
})

test('untracked files sort next to tracked files in the same directory', () => {
  const entries = [
    { path: 'src/a.js', status: 'M', added: 2, deleted: 0 },
    { path: 'src/b.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
    { path: 'notes/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 },
  ]
  const rows = buildRows('unstaged', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), ['dir:notes', 'dir:src', 'file:a.js', 'file:b.txt'])
  assert.equal(rows[1].depth, 0)
  assert.equal(rows[2].depth, 1)
  assert.equal(rows[3].depth, 1)
  assert.equal(rows[3].entry.status, 'U')
  assert.equal(rows[3].entry.untracked, true, 'a new file stays untracked')
  assert.equal(rows[0].loadable, true, 'the untracked directory stays a load-on-demand row')
})

test('a loadable directory is not compressed into the directory above it', () => {
  const entries = [{ path: 'src/tmp/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 }]
  const rows = buildRows('unstaged', entries)
  assert.deepEqual(rows.map(row => `${row.kind}:${row.name}`), ['dir:src', 'dir:tmp'])
  assert.equal(rows[1].loadable, true)
})

test('the split fallback width is the documented one', () => {
  assert.equal(SPLIT_MIN_WIDTH, 640)
})

test('reachableCommits and commitBranchRelation classify on-branch, off-branch, and truncated ancestry', () => {
  const root = '1'.repeat(40)
  const mainMid = '2'.repeat(40)
  const head = '3'.repeat(40)
  const sideRootEnded = '4'.repeat(40)
  const missingParent = '5'.repeat(40)
  const truncatedAncestor = '6'.repeat(40)
  const truncatedBeforeHead = '7'.repeat(40)

  // Complete history from head down to root: head -> mainMid -> root, sideRootEnded -> root.
  const completeCommits = [
    { sha: sideRootEnded, parents: [root] },
    { sha: head, parents: [mainMid] },
    { sha: mainMid, parents: [root] },
    { sha: root, parents: [] },
  ]
  const completeIndex = indexCommits(completeCommits, null)
  const completeReach = reachableCommits(completeCommits, head)

  assert.equal(completeReach.complete, true)
  assert.equal(completeReach.reachable.has(head), true)
  assert.equal(completeReach.reachable.has(mainMid), true)
  assert.equal(completeReach.reachable.has(root), true)
  assert.equal(completeReach.reachable.has(sideRootEnded), false)

  assert.equal(commitBranchRelation(completeCommits, completeIndex, head, mainMid, completeReach), 'on-branch')
  assert.equal(commitBranchRelation(completeCommits, completeIndex, head, root, completeReach), 'on-branch')
  assert.equal(commitBranchRelation(completeCommits, completeIndex, head, sideRootEnded, completeReach), 'off-branch')

  // Incomplete history: mainMid has an unloaded parent, so ancestry beyond mainMid is unknown.
  const pagedCommits = [
    { sha: truncatedBeforeHead, parents: [] },
    { sha: head, parents: [mainMid] },
    { sha: mainMid, parents: [missingParent] },
    { sha: truncatedAncestor, parents: [] },
  ]
  const pagedIndex = indexCommits(pagedCommits, null)
  const pagedReach = reachableCommits(pagedCommits, head)
  assert.equal(pagedReach.complete, false)
  assert.equal(
    commitBranchRelation(pagedCommits, pagedIndex, head, truncatedBeforeHead, pagedReach),
    'off-branch',
    'a commit ordered before HEAD in topo order cannot be its ancestor even when paged',
  )
  assert.equal(
    commitBranchRelation(pagedCommits, pagedIndex, head, truncatedAncestor, pagedReach),
    'unknown',
    'a commit below HEAD stays unknown when HEAD ancestry hits an unloaded parent',
  )
  assert.equal(
    commitBranchRelation(pagedCommits, pagedIndex, null, mainMid, pagedReach),
    'unknown',
    'missing head keeps relation unknown',
  )
})

test('commitActions prunes actions by commit branch relation', () => {
  const commit = { sha: 'a'.repeat(40), parents: ['b'.repeat(40)] }
  const head = 'c'.repeat(40)
  assert.deepEqual(
    commitActions({ commit, currentBranch: 'main', head, relation: 'on-branch' }),
    ['add-tag', 'create-branch', 'checkout', 'revert', 'drop', 'reset'],
    'an ancestor of HEAD skips cherry-pick, merge, and rebase',
  )
  assert.deepEqual(
    commitActions({ commit, currentBranch: 'main', head, relation: 'off-branch' }),
    ['add-tag', 'create-branch', 'checkout', 'cherry-pick', 'revert', 'merge', 'rebase', 'reset'],
    'an off-branch commit omits drop',
  )
  assert.deepEqual(
    commitActions({ commit, currentBranch: 'main', head, relation: 'unknown' }),
    ['add-tag', 'create-branch', 'checkout', 'cherry-pick', 'revert', 'drop', 'merge', 'rebase', 'reset'],
  )
})

test('commitOpMessage and createApi.commitOp handle branch checkout option', async () => {
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  const sha = 'a'.repeat(40)
  const target = { sha, name: 'topic' }
  assert.equal(
    commitOpMessage(t, 'branch', target, { branch: 'topic', sha, checkedOut: true }),
    `commit.branchCreatedCheckedOut:${JSON.stringify({ branch: 'topic', sha: sha.slice(0, 7) })}`,
  )
  assert.equal(
    commitOpMessage(t, 'branch', target, { branch: 'topic', sha }),
    `commit.branchCreated:${JSON.stringify({ branch: 'topic', sha: sha.slice(0, 7) })}`,
  )

  const calls = []
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, async json() { return { branch: 'topic', sha, checkedOut: true } } }
  }
  try {
    const api = createApi('session-1')
    await api.commitOp('/repo', 'branch', { sha, name: 'topic', checkout: true })
    await api.commitOp('/repo', 'branch', { sha, name: 'other' })
    assert.equal(calls[0].body.checkout, true)
    assert.equal('checkout' in calls[1].body, false)
  } finally {
    globalThis.fetch = savedFetch
  }
})
