import test from 'node:test'
import assert from 'node:assert/strict'

import { tileDirectActions } from '../lib/client/overview/directActions.js'
import { repositoryView } from '../lib/client/overview/model.js'
import { GIT_CAPABILITIES, JUJUTSU_CAPABILITIES } from '../lib/vcs/capabilities.js'
import type { RepositoryCapabilities, WorktreeInfo } from '../src/client/api.ts'
import type { OverviewCheckout, OverviewPointer } from '../src/client/overview/model.ts'
import type { RepoWrite } from '../src/client/useRepoActions.ts'

const root = '/work/repo'
const sibling = '/work/topic'
const mainSha = '1'.repeat(40)
const topicSha = '2'.repeat(40)
const mainTree: OverviewCheckout = {
  path: root, branch: 'main', head: mainSha, primary: true, locked: false, dirty: 0, operation: null,
}
const topicTree: OverviewCheckout = { ...mainTree, path: sibling, branch: 'topic', head: topicSha, primary: false }
const main: OverviewPointer = {
  kind: 'branch', name: 'main', sha: mainSha, checkout: root, subject: 'Main', time: null, isBase: true, base: 'main',
  ahead: 0, behind: 0, unique: 0, upstream: 'origin/main', track: { ahead: 0, behind: 0 },
}
const topic: OverviewPointer = {
  ...main, name: 'topic', sha: topicSha, checkout: null, subject: 'Topic',
  isBase: false, base: 'origin/main', upstream: 'origin/topic',
}
const foreign: OverviewPointer = {
  ...topic, kind: 'remote', name: 'origin/other', remote: 'origin', branch: 'other', upstream: undefined, track: undefined,
}
const linked: OverviewPointer = { ...topic, checkout: sibling }
const detached: OverviewPointer = { ...linked, kind: 'detached', name: sibling, upstream: undefined }
const unique = { ahead: 2, unique: 2 }
const diverged = { ...unique, behind: 2 }
const behind = { ahead: 1, behind: 2 }
const merged = { behind: 2 }

function fixture(pointer: OverviewPointer, options: {
  main?: Partial<OverviewPointer>
  primary?: Partial<OverviewCheckout>
  linked?: Partial<OverviewCheckout>
  row?: Partial<WorktreeInfo>
  baselines?: string[]
  path?: string
  vcs?: string
} = {}) {
  const primary = { ...mainTree, ...options.primary }
  const checkout = { ...topicTree, branch: pointer.kind === 'detached' ? null : topicTree.branch, ...options.linked }
  const repository = repositoryView({
    path: options.path ?? root, name: 'repo', vcs: options.vcs ?? 'git', registered: true,
    supported: true, remotes: ['origin'], fetchedAt: null, tags: 0, truncated: false,
    baselines: (options.baselines ?? []).map(name => ({ name, ahead: 0, behind: 0 })),
    checkouts: [primary, checkout],
    pointers: pointer.name === main.name ? [pointer] : [{ ...main, ...options.main }, pointer],
  }, '/work')
  const catalog = {
    enclosing: true,
    worktrees: [{ ...primary, name: 'repo', canRemove: false }, { ...checkout, name: 'topic', canRemove: true, ...options.row }],
  }
  const selected = repository.pointers.at(-1)!
  return {
    pointer: selected,
    actions: (capabilities: RepositoryCapabilities | null = GIT_CAPABILITIES, busy?: RepoWrite) =>
      tileDirectActions(selected, repository, capabilities, busy, catalog),
  }
}

const ids = (actions: ReturnType<typeof tileDirectActions>) => actions.map(item => item.action.kind)

const rows = [
  {
    name: 'the primary branch with an upstream difference', pointer: { ...main, track: { ahead: 0, behind: 2 } },
    expected: ['sync'], capability: 'sync',
  },
  { name: 'an unoccupied unique branch', pointer: { ...topic, ...unique }, expected: ['push', 'merge'], capability: 'branchOps' },
  { name: 'an unoccupied diverged branch', pointer: { ...topic, ...diverged }, expected: ['push', 'merge'], capability: 'branchOps' },
  { name: 'an unoccupied behind branch', pointer: { ...topic, ...behind }, expected: ['checkout', 'delete'], capability: 'branchOps' },
  { name: 'an unoccupied merged branch', pointer: { ...topic, ...merged }, expected: ['delete'], capability: 'branchOps' },
  { name: 'an unoccupied level branch', pointer: topic, expected: ['checkout'], capability: 'branchOps' },
  { name: 'a linked worktree’s unique branch', pointer: { ...linked, ...unique }, expected: ['push'], capability: 'branchOps' },
  { name: 'a linked worktree’s diverged branch', pointer: { ...linked, ...diverged }, expected: ['push'], capability: 'branchOps' },
  { name: 'a linked worktree’s level branch', pointer: linked, expected: ['remove'], capability: 'worktreeRemove' },
  { name: 'a linked worktree’s behind branch', pointer: { ...linked, ...behind }, expected: ['remove'], capability: 'worktreeRemove' },
  { name: 'a remote with no corresponding local branch', pointer: foreign, expected: ['checkout-remote', 'merge-remote'], capability: 'branchOps' },
  { name: 'a unique detached checkout', pointer: { ...detached, ...unique }, expected: ['create-branch'], capability: 'commitOps' },
  { name: 'a diverged detached checkout', pointer: { ...detached, ...diverged }, expected: ['create-branch'], capability: 'commitOps' },
  { name: 'a level detached checkout', pointer: detached, expected: ['remove'], capability: 'worktreeRemove' },
  { name: 'a behind detached checkout', pointer: { ...detached, ...behind }, expected: ['remove'], capability: 'worktreeRemove' },
  { name: 'a merged detached checkout', pointer: { ...detached, ...merged }, expected: ['remove'], capability: 'worktreeRemove' },
]

for (const { name, pointer, expected, capability } of rows) {
  test(`tiled direct actions for ${name} are ordered, capability-gated, and disabled during a write`, () => {
    const { actions } = fixture(pointer)
    const available = actions()
    assert.deepEqual(ids(available), expected)
    assert.ok(available.every(item => item.disabledReason === undefined))
    assert.deepEqual(actions({ ...GIT_CAPABILITIES, [capability]: false }), [])
    const busy = actions(GIT_CAPABILITIES, { domain: 'branch', action: 'push' })
    assert.deepEqual(busy.map(item => [item.action.kind, item.disabledReason]), expected.map(kind => [kind, 'branch.pushing']))
  })
}

test('unsaved or interrupted checkouts and stashes have no direct steps', () => {
  assert.deepEqual(ids(fixture({ ...linked, ...unique }).actions()), ['push'])
  assert.deepEqual(fixture({ ...linked, ...unique }, { linked: { dirty: 2 } }).actions(), [])
  assert.deepEqual(fixture({ ...linked, ...unique }, { linked: { operation: 'rebase' } }).actions(), [])
  const tracking = { ...main, track: { ahead: 1, behind: 1 } }
  assert.deepEqual(ids(fixture(tracking).actions()), ['sync'])
  assert.deepEqual(fixture(tracking, { primary: { operation: 'bisect' } }).actions(), [])
  assert.deepEqual(ids(fixture(detached).actions()), ['remove'])
  assert.deepEqual(fixture({ ...detached, kind: 'stash' }).actions(), [])
})

test('sync compares the primary branch to its own upstream and explains a missing upstream', () => {
  const tracking = { ...main, isBase: false, base: 'upstream/main', ahead: 4, behind: 8 }
  assert.deepEqual(ids(fixture({ ...tracking, track: { ahead: 1, behind: 0 } }).actions()), ['sync'])
  assert.deepEqual(fixture(tracking).actions(), [], 'distance from a different base is not a sync opportunity')
  assert.deepEqual(fixture({ ...tracking, track: { ahead: 1, behind: 0 } }, { primary: { dirty: 1 } }).actions(), [])
  assert.deepEqual(fixture({ ...tracking, track: { ahead: 1, behind: 0 } }, { primary: { head: null } }).actions(), [])
  const unpublished = fixture({ ...main, upstream: null, track: null })
  assert.deepEqual(unpublished.actions(), [
    { action: { domain: 'sync', kind: 'sync', branch: 'main' }, disabledReason: 'top.syncNoUpstream' },
  ])
  assert.equal(unpublished.actions(GIT_CAPABILITIES, { domain: 'sync', action: 'sync' })[0]?.disabledReason, 'top.syncing')
  for (const pointer of [topic, linked]) {
    const available = fixture({ ...pointer, ...unique }).actions()
    const disabled = fixture({ ...pointer, ...unique, upstream: null }).actions()
    assert.deepEqual(ids(disabled), ids(available))
    assert.equal(disabled[0]?.disabledReason, 'top.syncNoUpstream')
    assert.ok(disabled.slice(1).every(item => item.disabledReason === undefined))
  }
})

test('merge uses only a candidate trunk at the primary checkout, by its name or upstream', () => {
  for (const pointer of [{ ...topic, ...unique }, foreign]) {
    const [first, merge] = ids(fixture(pointer).actions())
    assert.match(merge, /^merge/u)
    for (const base of ['main', 'origin/main']) {
      const action = fixture({ ...pointer, base }).actions()[1]?.action
      assert.equal(action?.kind, merge)
      assert.equal(action?.domain === 'branch' && action.receiver, 'main')
    }
    assert.deepEqual(ids(fixture({ ...pointer, base: 'upstream/main' }).actions()), [first])
    assert.deepEqual(ids(fixture({ ...pointer, base: null }).actions()), [first])
    assert.deepEqual(ids(fixture(pointer, { main: { isBase: false } }).actions()), [first])
    assert.deepEqual(ids(fixture(pointer, { primary: { branch: null } }).actions()), [first])
    assert.deepEqual(ids(fixture(pointer, { primary: { operation: 'merge' } }).actions()), [first])
    assert.deepEqual(ids(fixture(pointer, { path: sibling }).actions()), [first], 'never merge into a linked entry’s HEAD')
  }
  assert.deepEqual(fixture({ ...main, track: { ahead: 1, behind: 0 } }, { path: sibling }).actions(), [])
})

test('checkout requires a free local branch and switch capability, or a valid unpaired remote ref', () => {
  assert.deepEqual(ids(fixture({ ...topic, ...behind }).actions({ ...GIT_CAPABILITIES, branchSwitch: false })), ['delete'])
  assert.deepEqual(ids(fixture({ ...topic, ...behind, checkout: sibling }).actions()), ['remove'])
  const checkout = fixture(foreign).actions()[0].action
  assert.deepEqual(checkout, {
    domain: 'branch', kind: 'checkout-remote', branch: 'origin/other', remote: 'origin', local: 'other', receiver: undefined,
  })
  assert.deepEqual(fixture({ ...foreign, remote: undefined }).actions(), [])
  assert.deepEqual(fixture(foreign, { main: { upstream: foreign.name } }).actions(), [])
  assert.deepEqual(ids(fixture(foreign, { baselines: [foreign.name] }).actions()), ['checkout-remote', 'merge-remote'])
})

test('worktree removal uses the catalog protections and the overview checkout’s current identity', () => {
  const action = fixture({ ...linked, ...behind }, { row: { branch: 'old', head: mainSha } }).actions()[0]?.action
  assert.equal(action?.domain, 'worktree')
  assert.equal(action.tree.branch, 'topic')
  assert.equal(action.tree.head, topicSha)
  assert.equal(fixture(linked, { row: { inUse: true, canRemove: false } }).actions()[0]?.disabledReason, 'error.worktreeInUse')
  assert.equal(fixture(linked, { linked: { locked: true } }).actions()[0]?.disabledReason, 'error.worktreeLocked')
  const detachedPrimary = { ...detached, name: root, checkout: root }
  assert.equal(fixture(detachedPrimary, { primary: { branch: null } }).actions()[0]?.disabledReason, 'worktree.sessionProtected')
  assert.equal(fixture(detachedPrimary, {
    path: sibling, primary: { branch: null },
  }).actions()[0]?.disabledReason, 'worktree.primaryProtected')
  assert.equal(fixture(linked).actions(GIT_CAPABILITIES, { domain: 'worktree', action: 'remove' })[0]?.disabledReason, 'worktree.removing')
})

test('detached branch creation names the commit; missing checkouts and Jujutsu are pruned', () => {
  assert.deepEqual(fixture({ ...detached, ...unique }).actions(), [
    { action: { domain: 'commit', kind: 'create-branch', sha: topicSha, subject: 'Topic' } },
  ])
  assert.deepEqual(fixture({ ...detached, ...unique, checkout: null }).actions(), [])
  const jj = fixture(detached, { vcs: 'jujutsu' })
  assert.deepEqual(jj.actions({ ...JUJUTSU_CAPABILITIES, worktreeRemove: true }), [])
  // The rule reads capabilities, not the backend name: a commit-based working
  // copy keeps its forget-or-remove choice in the menu, and no branch actions apply.
  assert.deepEqual(fixture(detached).actions({ ...GIT_CAPABILITIES, workingCopy: 'commit' }), [])
  assert.deepEqual(fixture({ ...topic, ...unique }, { vcs: 'jujutsu' }).actions(JUJUTSU_CAPABILITIES), [])
  assert.deepEqual(fixture({ ...linked, upstream: 'topic@origin' }, { vcs: 'jujutsu' })
    .actions({ ...JUJUTSU_CAPABILITIES, worktreeForget: true, worktreeRemove: true }), [])
  assert.deepEqual(fixture({ ...foreign, name: 'other@origin' }, { vcs: 'jujutsu' }).actions(JUJUTSU_CAPABILITIES), [])
  assert.deepEqual(fixture(detached).actions(null), [])
})
