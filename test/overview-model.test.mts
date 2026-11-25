import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSkeleton, columnOrder, filterCounts, gauge, headline, matchesSearch, pointerTarget, relativeTo, repositoryView,
  stepIndex, tileOrder, traversal,
} from '../lib/client/overview/model.js'
import { onPanelCommand, sendPanelCommand } from '../lib/client/commands.js'
import { createApi } from '../lib/client/api.js'
import { loadState, OVERVIEW_MAX, OVERVIEW_MIN, sanitizeState } from '../lib/client/state.js'

const sha = (digit: string) => digit.repeat(40)
const checkout = (path: string, extra: Record<string, unknown> = {}) => ({
  path, branch: null, head: null, primary: false, locked: false, dirty: 0, operation: null, ...extra,
})
const pointer = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  kind, name, sha: sha('a'), time: 1_700_000_000, subject: name, base: 'origin/main', isBase: false,
  ahead: 0, behind: 0, unique: 0, ...extra,
})

/** A fork-like repository with one pointer in every state. */
function repository(overrides: Record<string, unknown> = {}) {
  return {
    path: '/w/repo',
    name: 'repo',
    vcs: 'git',
    registered: true,
    supported: true,
    remotes: ['origin', 'upstream'],
    fetchedAt: 1_700_000_000,
    baselines: [{ name: 'origin/main', ahead: 0, behind: 0 }, { name: 'upstream/main', ahead: 3, behind: 72 }],
    checkouts: [
      checkout('/w/repo', { primary: true, branch: 'main', head: sha('1') }),
      checkout('/w/repo/.claude/worktrees/x', { branch: 'dirty', dirty: 2 }),
      checkout('/w/repo-op', { branch: 'busy', operation: 'rebase' }),
      checkout('/w/repo-loose', { head: sha('9') }),
    ],
    pointers: [
      pointer('branch', 'main', { isBase: true, upstream: 'origin/main', track: { ahead: 0, behind: 2 }, checkout: '/w/repo' }),
      pointer('branch', 'dirty', { unique: 4, ahead: 4, checkout: '/w/repo/.claude/worktrees/x' }),
      pointer('branch', 'busy', { unique: 1, ahead: 1, checkout: '/w/repo-op' }),
      pointer('branch', 'pr', { unique: 2, ahead: 3, base: 'upstream/main', upstream: 'origin/pr', track: { ahead: 2, behind: 0 } }),
      pointer('branch', 'fork', { unique: 1, ahead: 1, behind: 5 }),
      pointer('branch', 'old', { behind: 7 }),
      pointer('branch', 'lagging', { behind: 2, checkout: '/w/repo-loose' }),
      pointer('detached', '/w/repo-loose', { sha: sha('9'), behind: 1, checkout: '/w/repo-loose' }),
      pointer('stash', 'stash@{0}', { sha: sha('8'), onto: sha('1'), unique: 1, subject: 'On main: keep' }),
      pointer('remote', 'origin/main', { isBase: true }),
      pointer('remote', 'upstream/feature', { remote: 'upstream', branch: 'feature' }),
    ],
    tags: 3,
    truncated: false,
    ...overrides,
  }
}

test('each pointer takes its heaviest state from distance, uniqueness, and occupancy', () => {
  const view = repositoryView(repository() as never, '/w')
  const states = Object.fromEntries(view.pointers.map(entry => [entry.name, entry.state]))
  assert.deepEqual(states, {
    main: 'behind', // the trunk counts against its own upstream
    dirty: 'unsaved', // unpublished commits, but the checkout has changes
    busy: 'op',
    pr: 'unique',
    fork: 'diverged',
    old: 'merged', // nothing of its own, behind, and nobody holds it
    lagging: 'behind',
    '/w/repo-loose': 'merged',
    'stash@{0}': 'stash',
    'origin/main': 'shadow',
    'upstream/feature': 'foreign',
  })
  assert.equal(view.relativePath, 'repo')
  assert.equal(view.rank, 0)
  assert.equal(view.quiet, false)
  assert.equal(view.dirtyTrees, 1)
  assert.equal(view.unique, 4 + 1 + 2 + 1)
  assert.deepEqual(view.drift, [{ name: 'upstream/main', ahead: 3, behind: 72 }])
  // Shadowed remotes stay out of the list; the foreign one stays in.
  assert.deepEqual(view.list.map(entry => entry.name).slice(0, 3), ['busy', 'dirty', 'pr'])
  assert.equal(view.list.some(entry => entry.name === 'origin/main'), false)
  assert.equal(view.list.some(entry => entry.name === 'upstream/feature'), true)
  const trunk = view.pointers.find(entry => entry.name === 'main')
  assert.equal(trunk?.base, 'origin/main')
  assert.equal(trunk?.baseIsUpstream, true)
  assert.equal(trunk?.behind, 2)
  // A checkout nested in a linked checkout is marked; one under the primary is not.
  assert.equal(view.pointers.find(entry => entry.name === 'dirty')?.nested, false)
})

test('filters count the listed pointers, and a quiet repository has only level pointers', () => {
  const loud = repositoryView(repository() as never, '/w')
  const quiet = repositoryView(repository({
    path: '/w/quiet',
    checkouts: [checkout('/w/quiet', { primary: true, branch: 'main' })],
    pointers: [pointer('branch', 'main', { isBase: true, upstream: 'origin/main', track: { ahead: 0, behind: 0 }, checkout: '/w/quiet' }), pointer('remote', 'origin/main', { isBase: true })],
    baselines: [{ name: 'origin/main', ahead: 0, behind: 0 }],
  }) as never, '/w')
  assert.equal(quiet.quiet, true)
  assert.deepEqual(filterCounts([loud, quiet]), { unsaved: 1, unique: 2, diverged: 1, behind: 2, merged: 2, stash: 1, op: 1 })
  // A repository without remotes is quiet too when everything sits on its base.
  const local = repositoryView(repository({
    path: '/w', remotes: [], baselines: [{ name: 'main', ahead: 0, behind: 0 }],
    checkouts: [checkout('/w', { primary: true, branch: 'main' })],
    pointers: [pointer('branch', 'main', { isBase: true, base: 'main', checkout: '/w' })],
  }) as never, '/w')
  assert.equal(local.relativePath, '.')
  assert.equal(local.quiet, true)
})

test('search matches names, subjects, checkout paths, and upstreams; empty search matches all', () => {
  const view = repositoryView(repository() as never, '/w')
  const named = (name: string) => view.pointers.find(entry => entry.name === name) as never
  assert.equal(matchesSearch(named('pr'), 'ORIGIN/PR', '/w'), true)
  assert.equal(matchesSearch(named('dirty'), 'worktrees/x', '/w'), true)
  assert.equal(matchesSearch(named('stash@{0}'), 'keep', '/w'), true)
  assert.equal(matchesSearch(named('pr'), 'nothing-like-this', '/w'), false)
  assert.equal(matchesSearch(named('pr'), '', '/w'), true)
  assert.equal(relativeTo('/w/a/b', '/w'), 'a/b')
  assert.equal(relativeTo('/elsewhere', '/w'), '/elsewhere')
  assert.equal(relativeTo('/w2', '/w'), '/w2')
})

test('headlines and gauges carry the number that matters', () => {
  const view = repositoryView(repository() as never, '/w')
  const named = (name: string) => view.pointers.find(entry => entry.name === name) as never
  assert.deepEqual(headline(named('dirty')), { key: 'overview.metric.unsaved', count: 2 })
  assert.deepEqual(headline(named('fork')), { key: 'overview.metric.diverged', count: 1, behind: 5 })
  assert.deepEqual(headline(named('busy')), { key: 'overview.operation.rebase' })
  assert.deepEqual(headline(named('upstream/feature')), { key: 'overview.state.synced' })
  const pr = gauge(named('pr'))
  assert.ok(pr.unique > 0 && pr.published > 0 && pr.behind === 0)
  const old = gauge(named('old'))
  assert.ok(old.behind > 0 && old.unique === 0)
  // Logarithmic: 1 and 66 are both visible and neither overflows the half width.
  assert.ok(gauge({ ...named('old'), behind: 1 } as never).behind > 3)
  assert.ok(gauge({ ...named('old'), behind: 100_000 } as never).behind <= 29)
})

test('Jujutsu workspaces and bookmarks have distinct conflict headlines; an anonymous head keeps its change id', () => {
  const copy = sha('b')
  const view = repositoryView(repository({
    vcs: 'jujutsu',
    checkouts: [
      checkout('/w/repo', { branch: 'broken', workingCopy: copy, dirty: 1, operation: 'conflict' }),
      checkout('/w/clean', { workingCopy: sha('c') }),
      checkout('/w/dirty', { workingCopy: sha('d'), dirty: 1 }),
    ],
    pointers: [
      pointer('branch', 'broken', { checkout: '/w/repo', unique: 1, ahead: 1 }),
      pointer('branch', 'two-targets', { bookmarkConflict: true }),
      pointer('detached', 'yxwvutsrqpon', { ahead: 2, unique: 1 }),
      pointer('detached', '/w/clean', { checkout: '/w/clean' }),
      pointer('detached', '/w/dirty', { checkout: '/w/dirty' }),
    ],
  }) as never, '/w')
  const [workspace, bookmark, anonymous, clean, dirty] = view.pointers
  assert.equal(workspace.state, 'op')
  assert.deepEqual(headline(workspace), { key: 'overview.operation.conflict' })
  assert.deepEqual(pointerTarget(workspace), { commit: copy })
  assert.equal(bookmark.state, 'op')
  assert.deepEqual(headline(bookmark), { key: 'overview.operation.bookmarkConflict' })
  assert.deepEqual(pointerTarget(bookmark), { commit: bookmark.sha })
  assert.equal(anonymous.display, 'yxwvutsrqpon')
  assert.equal(anonymous.state, 'unique')
  assert.deepEqual(pointerTarget(anonymous), { commit: anonymous.sha })
  assert.equal(clean.display, 'clean')
  assert.equal(clean.state, 'synced')
  assert.equal(dirty.state, 'unsaved')
  assert.deepEqual(pointerTarget(dirty), { commit: sha('d') })
  assert.equal(filterCounts([view]).op, 2)
})

test('Jujutsu pairs remote bookmarks by local name and folds only a non-conflicted remote on the same commit', () => {
  const view = repositoryView(repository({
    vcs: 'jujutsu',
    baselines: [{ name: 'main@origin', ahead: 0, behind: 0 }],
    checkouts: [],
    pointers: [
      pointer('branch', 'feature/one', { upstream: null }),
      pointer('remote', 'feature/one@mirror', { branch: 'feature/one', remote: 'mirror' }),
      pointer('remote', 'feature/one@origin', { branch: 'feature/one', remote: 'origin', sha: sha('b') }),
      pointer('remote', 'feature/one@other', { branch: 'feature/one', remote: 'other', bookmarkConflict: true }),
      pointer('remote', 'main@origin', { branch: 'main', remote: 'origin', isBase: true }),
    ],
  }) as never, '/w')
  assert.deepEqual(view.pointers.map(p => p.state), ['synced', 'shadow', 'shadow', 'op', 'foreign'])
  assert.deepEqual(view.list.map(p => p.name), ['feature/one@other', 'main@origin', 'feature/one'])
  assert.deepEqual(view.pointers[0].levelRemotes, ['mirror'])
  const skeleton = buildSkeleton([{ sha: sha('b'), parents: [sha('a')] }, { sha: sha('a'), parents: [] }], view.pointers)
  const shown = skeleton.rows.flatMap(row => row.pointers.map(p => p.name))
  assert.ok(shown.includes('feature/one@origin'), 'an out-of-position shadow stays visible in the tile')
  assert.ok(shown.includes('feature/one@other'), 'a remote bookmark conflict is never folded')
  assert.ok(!shown.includes('feature/one@mirror'), 'the level remote is shown on the local chip instead')
  assert.deepEqual(traversal([{ repo: view.path, pointers: columnOrder(skeleton, view) }], 'op').map(p => p.name), ['feature/one@other'])
})

test('the skeleton keeps pointer commits and fork points, folds the rest, and lists the unplaced', () => {
  // main: m3 → m2 → m1 → root; topic forks at m1: t2 → t1 → m1; a tag sits on m2 and root.
  const [m3, m2, m1, root, t2, t1] = ['3', '2', '1', '0', '6', '5'].map(sha)
  const commits = [
    { sha: m3, parents: [m2], subject: 'm3' },
    { sha: t2, parents: [t1], subject: 't2' },
    { sha: m2, parents: [m1], subject: 'm2' },
    { sha: t1, parents: [m1], subject: 't1' },
    { sha: m1, parents: [root], subject: 'm1' },
    { sha: root, parents: [], subject: 'root' },
  ]
  const view = repositoryView(repository({
    checkouts: [checkout('/w/repo', { primary: true, branch: 'main' })],
    pointers: [
      pointer('branch', 'main', { sha: m3, isBase: true, checkout: '/w/repo' }),
      pointer('branch', 'topic', { sha: t2, unique: 2, ahead: 2 }),
      pointer('remote', 'origin/topic', { sha: t2 }),
      pointer('branch', 'gone', { sha: sha('7'), behind: 1 }),
      pointer('stash', 'stash@{0}', { sha: sha('8'), onto: m3, unique: 1 }),
    ],
  }) as never, '/w')
  const views = view.pointers
  // origin/topic is level with nothing local named after it, so it is drawn.
  const skeleton = buildSkeleton(commits, views, [{ name: 'v2', sha: m2 }, { name: 'v0', sha: root }])
  assert.deepEqual(skeleton.rows.map(row => row.subject), ['m3', 't2', 'm2', 'm1', 'root'])
  const byName = Object.fromEntries(skeleton.rows.map(row => [row.subject, row]))
  assert.deepEqual(byName.m3.pointers.map(entry => entry.name).sort(), ['main', 'stash@{0}'])
  assert.equal(byName.t2.between, 1) // t1 folded
  assert.equal(byName.t2.parent, m1)
  assert.deepEqual(byName.m2.tags, ['v2'])
  assert.equal(byName.m1.pointers.length, 0) // a fork point
  assert.equal(byName.root.root, true)
  assert.equal(byName.root.end, true)
  assert.deepEqual(skeleton.unplaced.map(entry => entry.name), ['gone'])
  assert.equal(skeleton.width, 2)
  assert.equal(skeleton.lanes.length, skeleton.rows.length)

  // Consecutive tag-only rows fold into one.
  const tagged = buildSkeleton(commits.filter(commit => commit.subject.startsWith('m') || commit.subject === 'root'), [], [
    { name: 'v3', sha: m3 }, { name: 'v2', sha: m2 }, { name: 'v1', sha: m1 },
  ])
  assert.deepEqual(tagged.rows.map(row => row.tags), [['v3', 'v2', 'v1']])
  // m2, m1, and the untagged root fold under the one row.
  assert.equal(tagged.rows[0].between, 3)
  assert.equal(tagged.rows[0].root, true)

  // A remote level with its local branch is drawn as the branch's shadow.
  const paired = repositoryView(repository({ pointers: [
    pointer('branch', 'main', { sha: m3, upstream: 'origin/main' }),
    pointer('remote', 'origin/main', { sha: m3 }),
  ] }) as never, '/w')
  const shadowed = buildSkeleton(commits, paired.pointers)
  assert.equal(shadowed.rows[0].pointers.length, 1)
  // A history that ends at a page boundary says so.
  const page = buildSkeleton(commits.slice(0, 3), [views[0]] as never)
  assert.equal(page.rows.at(-1)?.end, true)
  assert.equal(page.rows.at(-1)?.root, false)
})

test('traversal walks columns left to right and each column top to bottom, wrapping both ways', () => {
  const first = repositoryView(repository() as never, '/w')
  const second = repositoryView(repository({ path: '/w/two' }) as never, '/w')
  const columns = [first, second].map(view => ({ repo: view.path, pointers: columnOrder(null, view) }))
  const hits = traversal(columns, 'unique')
  assert.deepEqual(hits.map(entry => [entry.repo, entry.name]), [
    ['/w/repo', 'pr'], ['/w/repo', 'fork'], ['/w/two', 'pr'], ['/w/two', 'fork'],
  ])
  assert.equal(stepIndex(4, -1, 1), 0)
  assert.equal(stepIndex(4, -1, -1), 3)
  assert.equal(stepIndex(4, 3, 1), 0)
  assert.equal(stepIndex(4, 0, -1), 3)
  assert.equal(stepIndex(0, 2, 1), -1)
  assert.deepEqual(traversal(columns, 'op').map(entry => entry.name), ['busy', 'busy'])

  // Attention order puts known loud repositories before unread ones, then quiet ones.
  const quiet = repositoryView(repository({
    path: '/w/a-quiet', checkouts: [checkout('/w/a-quiet', { primary: true, branch: 'main' })],
    pointers: [pointer('branch', 'main', { isBase: true, upstream: 'origin/main', track: { ahead: 0, behind: 0 }, checkout: '/w/a-quiet' })],
  }) as never, '/w')
  const views = new Map([quiet, first].map(view => [view.path, view]))
  const entries = [{ path: '/w/a-quiet' }, { path: '/w/unread' }, { path: '/w/repo' }]
  assert.deepEqual(tileOrder(entries, views, 'directory').map(entry => entry.path), ['/w/a-quiet', '/w/unread', '/w/repo'])
  assert.deepEqual(tileOrder(entries, views, 'attention').map(entry => entry.path), ['/w/repo', '/w/unread', '/w/a-quiet'])
})

test('a pointer opens its working tree when unsaved, a stash its own node, anything else its commit', () => {
  const view = repositoryView(repository() as never, '/w')
  const named = (name: string) => view.pointers.find(entry => entry.name === name) as never
  assert.deepEqual(pointerTarget(named('dirty')), { worktree: '/w/repo/.claude/worktrees/x' })
  assert.deepEqual(pointerTarget(named('stash@{0}')), { stash: `stash:${sha('8')}` })
  assert.deepEqual(pointerTarget(named('pr')), { commit: sha('a') })
})

test('panel state keeps the overview and tiled layout, clamping and dropping bad values', () => {
  const state = sanitizeState({
    overview: true, overviewWidth: 9999, tiled: true, overviewBeforeTile: true, tileOrder: 'directory', tileExpanded: ['/a', '/a', 3],
  })
  assert.equal(state.overview, true)
  assert.equal(state.overviewWidth, OVERVIEW_MAX)
  assert.equal(state.tiled, true)
  assert.equal(state.overviewBeforeTile, true)
  assert.equal(state.tileOrder, 'directory')
  assert.deepEqual(state.tileExpanded, ['/a'])
  const rejected = sanitizeState({ overview: 'yes', overviewWidth: 10, tiled: 1, tileOrder: 'random', tileExpanded: 'x' })
  assert.equal(rejected.overview, false)
  assert.equal(rejected.overviewWidth, OVERVIEW_MIN)
  assert.equal(rejected.tiled, false)
  assert.equal(rejected.tileOrder, 'attention')
  assert.deepEqual(rejected.tileExpanded, [])
  assert.equal(loadState('none', undefined).overviewWidth, 400)
  assert.equal(sanitizeState({}).tileOrder, 'attention')
})

test('panel commands reach the Session they name, and wait for a panel that has not mounted', () => {
  const received: string[] = []
  sendPanelCommand('s-wait', 'tile')
  const stop = onPanelCommand('s-wait', command => { received.push(command) })
  sendPanelCommand('s-other', 'overview')
  sendPanelCommand('s-wait', 'overview')
  stop()
  sendPanelCommand('s-wait', 'tile')
  assert.deepEqual(received, ['tile', 'overview'])
  const late: string[] = []
  onPanelCommand('s-wait', command => { late.push(command) })()
  assert.deepEqual(late, ['tile'])
})

test('the overview stream decodes lines as they arrive, across chunk boundaries', async () => {
  const lines = [
    { type: 'scope', cwd: '/w', repositories: 1 },
    { type: 'repository', repository: { path: '/w/repo', pointers: [] } },
    { type: 'done', unlistedTruncated: false },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
  const encoder = new TextEncoder()
  const urls: string[] = []
  const fetchImpl = async (url: string) => {
    urls.push(url)
    const body = new ReadableStream({
      start(controller) {
        // Split mid-line to check the decoder keeps partial lines.
        for (let index = 0; index < lines.length; index += 17) controller.enqueue(encoder.encode(lines.slice(index, index + 17)))
        controller.enqueue(encoder.encode('not json\n'))
        controller.close()
      },
    })
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
  }
  const api = createApi('s1', { fetchImpl: fetchImpl as never })
  const seen: string[] = []
  await api.overview(line => { seen.push(line.type) }, { repo: '/w/repo' })
  assert.deepEqual(seen, ['scope', 'repository', 'done'])
  assert.match(urls[0], /\/api\/vcs\.overview\?sessionId=s1&repo=%2Fw%2Frepo$/u)

  const failing = createApi('s1', {
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 'not-a-repo', message: 'no' } }), { status: 400 })) as never,
  })
  await assert.rejects(failing.overview(() => {}), { code: 'not-a-repo', status: 400 })
})
