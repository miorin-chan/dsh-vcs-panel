import test from 'node:test'
import assert from 'node:assert/strict'

import { DICTIONARIES } from '../lib/client/locales.js'
import { scriptRuns } from '../lib/client/script-runs.js'
import { saveState, defaultState } from '../lib/client/state.js'
import {
  buildTabTitleSnapshot, createTabTitleStore, fallbackTabTitleSnapshot, formatTabTitle,
  repoBaseName, sameTabTitleSnapshot,
} from '../lib/client/tab-title.js'

function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    map,
  }
}

function translatorFor(locale) {
  const chain = locale === 'en' || DICTIONARIES[locale] === undefined ? ['en'] : [locale, 'en']
  return (key, params) => {
    let template
    for (const loc of chain) {
      if (DICTIONARIES[loc]?.[key] !== undefined) {
        template = DICTIONARIES[loc][key]
        break
      }
    }
    if (template === undefined) return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
  }
}

function gitCapabilities(overrides = {}) {
  return {
    id: 'git',
    name: 'Git',
    workingCopy: 'row',
    workingCopyNode: null,
    staging: true,
    stageOps: true,
    untracked: true,
    changeId: false,
    aheadBehind: true,
    snapshots: false,
    sync: true,
    branchSwitch: true,
    branchOps: true,
    tagOps: true,
    commitOps: true,
    stashOps: true,
    ranges: [],
    defaultRange: 'all',
    ...overrides,
  }
}

function jjCapabilities(overrides = {}) {
  return gitCapabilities({
    id: 'jujutsu',
    name: 'Jujutsu',
    workingCopy: 'commit',
    workingCopyNode: '@',
    staging: false,
    stageOps: false,
    untracked: false,
    changeId: true,
    aheadBehind: false,
    snapshots: true,
    sync: false,
    branchSwitch: false,
    branchOps: false,
    tagOps: false,
    commitOps: false,
    stashOps: false,
    ...overrides,
  })
}

function makeStatus(capabilities, overrides = {}) {
  return {
    branch: null,
    groups: {},
    total: 0,
    truncated: false,
    defaultNode: 'worktree',
    stageHistory: { undo: null, redo: null },
    repo: { path: '/workspace/dsh-vcs-panel', name: 'dsh-vcs-panel' },
    vcs: capabilities.id,
    capabilities,
    ...overrides,
  }
}

test('scriptRuns splits user names by script and folds neutral characters into neighbors', () => {
  assert.deepEqual(scriptRuns(''), [])
  assert.deepEqual(scriptRuns('main'), [{ text: 'main', script: 'alphabetic' }])
  assert.deepEqual(scriptRuns('前端'), [{ text: '前端', script: 'cjk' }])
  assert.deepEqual(scriptRuns('my-app 前端'), [
    { text: 'my-app ', script: 'alphabetic' },
    { text: '前端', script: 'cjk' },
  ])
  assert.deepEqual(scriptRuns('123'), [{ text: '123', script: 'other' }])
  assert.deepEqual(scriptRuns('12-fix'), [{ text: '12-fix', script: 'alphabetic' }])
})

test('repoBaseName extracts repository folder names and rejects roots or empty paths', () => {
  assert.equal(repoBaseName('/Users/me/workspace/dsh-vcs-panel'), 'dsh-vcs-panel')
  assert.equal(repoBaseName('/Users/me/workspace/dsh-vcs-panel///'), 'dsh-vcs-panel')
  assert.equal(repoBaseName('C:\\repos\\app\\'), 'app')
  assert.equal(repoBaseName('dsh-vcs-panel'), 'dsh-vcs-panel')
  assert.equal(repoBaseName('/'), null)
  assert.equal(repoBaseName('///'), null)
  assert.equal(repoBaseName('\\'), null)
  assert.equal(repoBaseName('C:'), null)
  assert.equal(repoBaseName('C:\\'), null)
  assert.equal(repoBaseName(''), null)
})

test('fallbackTabTitleSnapshot restores persisted views and survives unreadable storage', () => {
  const storage = fakeStorage()
  assert.equal(fallbackTabTitleSnapshot('', storage), null)
  assert.equal(fallbackTabTitleSnapshot('s1', storage), null)

  saveState('s-tiled', { ...defaultState(), tiled: true, timelineScope: 'all', repo: '/a/b' }, storage)
  assert.deepEqual(fallbackTabTitleSnapshot('s-tiled', storage), { mode: 'tiled', repositoryCount: null })

  saveState('s-all', { ...defaultState(), timelineScope: 'all', repo: '/a/b' }, storage)
  assert.deepEqual(fallbackTabTitleSnapshot('s-all', storage), { mode: 'all', repositoryCount: null })

  saveState('s-repo', { ...defaultState(), repo: '/a/b/dsh-vcs-panel', worktrees: ['/a/b/dsh-vcs-panel', '/a/b/wt'] }, storage)
  assert.deepEqual(fallbackTabTitleSnapshot('s-repo', storage), {
    mode: 'repository',
    repositoryCount: null,
    repoName: 'dsh-vcs-panel',
    head: null,
    checkoutCount: 2,
    commitBased: false,
    changedCount: null,
    ahead: 0,
    behind: 0,
  })

  saveState('s-root', { ...defaultState(), repo: '/' }, storage)
  assert.equal(fallbackTabTitleSnapshot('s-root', storage), null)

  const brokenStorage = {
    getItem() { throw new Error('storage blocked') },
  }
  assert.equal(fallbackTabTitleSnapshot('s-repo', brokenStorage), null)
})

test('buildTabTitleSnapshot avoids flashing empty during discovery and handles 0-repo states', () => {
  const caps = gitCapabilities()
  const repoInfo = { name: 'dsh-vcs-panel', path: '/ws/dsh-vcs-panel', capabilities: caps }

  // Initial discovery before repoInfo settles keeps fallback intact.
  assert.equal(buildTabTitleSnapshot({
    repositoriesStatus: 'idle',
    repositoryCount: 0,
    tiled: false,
    allScope: false,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), null)
  assert.equal(buildTabTitleSnapshot({
    repositoriesStatus: 'loading',
    repositoryCount: 0,
    tiled: false,
    allScope: false,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), null)

  // Loading with tiled or allScope reflects immediately.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'loading',
    repositoryCount: 0,
    tiled: true,
    allScope: false,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), { mode: 'tiled', repositoryCount: null })
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'loading',
    repositoryCount: 0,
    tiled: false,
    allScope: true,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), { mode: 'all', repositoryCount: null })

  // Loading while keeping an existing repository stays in repository mode.
  assert.equal(buildTabTitleSnapshot({
    repositoriesStatus: 'loading',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo,
    checkedTrees: [{ path: repoInfo.path, name: 'dsh-vcs-panel', head: 'abc', branch: 'main' }],
    worktrees: [{ path: repoInfo.path, name: 'dsh-vcs-panel', head: 'abc', branch: 'main' }],
    status: null,
  })?.mode, 'repository')

  // Ready or error with 0 repositories settles to empty even if tiled/allScope was persisted.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 0,
    tiled: true,
    allScope: true,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), { mode: 'empty' })
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'error',
    repositoryCount: 0,
    tiled: false,
    allScope: false,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), { mode: 'empty' })
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 2,
    tiled: false,
    allScope: false,
    repoInfo: null,
    checkedTrees: [],
    worktrees: [],
    status: null,
  }), { mode: 'empty' })
})

test('buildTabTitleSnapshot captures single/multi-repo, Git, and Jujutsu states', () => {
  const gitCaps = gitCapabilities()
  const gitRepo = { name: 'dsh-vcs-panel', path: '/ws/dsh-vcs-panel', capabilities: gitCaps }
  const tree1 = { path: '/ws/dsh-vcs-panel', name: 'dsh-vcs-panel', head: 'aaa', branch: 'main' }
  const tree2 = { path: '/ws/dsh-vcs-panel-wt', name: 'wt', head: 'bbb', branch: 'feat/wt' }

  // Git named branch with dirty count and ahead/behind.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: makeStatus(gitCaps, {
      total: 4,
      branch: { name: 'feat/title', oid: 'aaa', detached: false, unborn: false, upstream: 'origin/feat/title', ahead: 2, behind: 1 },
    }),
  }), {
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'branch', name: 'feat/title' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 4,
    ahead: 2,
    behind: 1,
  })

  // Git detached, unborn, and catalog fallback before status arrives.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: makeStatus(gitCaps, {
      branch: { name: null, oid: 'aaa', detached: true, unborn: false, upstream: null, ahead: 0, behind: 0 },
    }),
  })?.head, { kind: 'detached' })

  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: makeStatus(gitCaps, {
      branch: { name: null, oid: null, detached: false, unborn: true, upstream: null, ahead: 0, behind: 0 },
    }),
  })?.head, { kind: 'unborn' })

  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: null,
  })?.head, { kind: 'branch', name: 'main' })

  // Multiple checked worktrees clear single-head and changedCount.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: gitRepo,
    checkedTrees: [tree1, tree2],
    worktrees: [tree1, tree2],
    status: makeStatus(gitCaps, { total: 5 }),
  }), {
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: null,
    checkoutCount: 2,
    commitBased: false,
    changedCount: null,
    ahead: 0,
    behind: 0,
  })

  // Jujutsu with and without bookmark, single and multiple workspaces.
  const jjCaps = jjCapabilities()
  const jjRepo = { name: 'jj-repo', path: '/ws/jj-repo', capabilities: jjCaps }
  const ws1 = { path: '/ws/jj-repo', name: 'default', head: '111', branch: null }
  const ws2 = { path: '/ws/jj-repo-ws', name: 'review', head: '222', branch: null }

  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: jjRepo,
    checkedTrees: [ws1],
    worktrees: [ws1],
    status: makeStatus(jjCaps, {
      total: 2,
      workingCopy: {
        node: '@',
        commitId: '111',
        changeId: 'qpvuntsm9999',
        parents: [],
        refs: [{ kind: 'tag', name: 'v1' }, { kind: 'bookmark', name: 'main' }],
        subject: '',
        author: '',
        authorTime: 0,
        empty: false,
        conflict: false,
        summary: { changed: 2, added: 5, deleted: 1 },
      },
    }),
  }), {
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'jj-repo',
    head: { kind: 'workingCopy', label: '@', changeId: 'qpvuntsm', bookmark: 'main' },
    checkoutCount: 1,
    commitBased: true,
    changedCount: 2,
    ahead: 0,
    behind: 0,
  })

  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: false,
    repoInfo: jjRepo,
    checkedTrees: [ws2],
    worktrees: [ws1, ws2],
    status: makeStatus(jjCaps, {
      workingCopy: {
        node: '@',
        commitId: '222',
        changeId: 'kmpzabcd1234',
        parents: [],
        refs: [],
        subject: '',
        author: '',
        authorTime: 0,
        empty: true,
        conflict: false,
        summary: { changed: 0, added: 0, deleted: 0 },
      },
    }),
  })?.head, { kind: 'workingCopy', label: 'review@', changeId: 'kmpzabcd', bookmark: null })

  // Multi-repo: all, tiled, and single-repo guard for allScope.
  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 4,
    tiled: false,
    allScope: true,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: null,
  }), { mode: 'all', repositoryCount: 4 })

  assert.deepEqual(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 4,
    tiled: true,
    allScope: true,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: null,
  }), { mode: 'tiled', repositoryCount: 4 })

  assert.equal(buildTabTitleSnapshot({
    repositoriesStatus: 'ready',
    repositoryCount: 1,
    tiled: false,
    allScope: true,
    repoInfo: gitRepo,
    checkedTrees: [tree1],
    worktrees: [tree1],
    status: null,
  })?.mode, 'repository')
})

test('formatTabTitle formats chip labels, userNamed flags, and tooltips in zh and en', () => {
  const tZh = translatorFor('zh')
  const tEn = translatorFor('en')

  assert.deepEqual(formatTabTitle(null, tZh, 'zh'), { label: '版本管理', tooltip: '版本管理', userNamed: false })
  assert.deepEqual(formatTabTitle({ mode: 'empty' }, tEn, 'en'), { label: 'VCS', tooltip: 'VCS', userNamed: false })

  assert.deepEqual(formatTabTitle({ mode: 'tiled', repositoryCount: null }, tZh, 'zh'), {
    label: '平铺仓库', tooltip: '版本管理 · 平铺仓库', userNamed: false,
  })
  assert.deepEqual(formatTabTitle({ mode: 'tiled', repositoryCount: 3 }, tEn, 'en'), {
    label: 'Tiled', tooltip: 'VCS · Tiled · 3 repositories', userNamed: false,
  })

  assert.deepEqual(formatTabTitle({ mode: 'all', repositoryCount: 1 }, tEn, 'en'), {
    label: 'All repositories', tooltip: 'VCS · All repositories · 1 repository', userNamed: false,
  })
  assert.deepEqual(formatTabTitle({ mode: 'all', repositoryCount: 12 }, tZh, 'zh'), {
    label: '全部仓库', tooltip: '版本管理 · 全部仓库 · 12 个仓库', userNamed: false,
  })

  // Single-repo Git branch, detached, unborn, and multi-worktree.
  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'branch', name: 'main' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 4,
    ahead: 2,
    behind: 1,
  }, tZh, 'zh'), {
    label: 'main',
    tooltip: 'dsh-vcs-panel · main · 4 个改动 · ↑2 ↓1',
    userNamed: true,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'branch', name: 'main' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 1,
    ahead: 0,
    behind: 3,
  }, tEn, 'en'), {
    label: 'main',
    tooltip: 'dsh-vcs-panel · main · 1 changed · ↓3',
    userNamed: true,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'detached' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 0,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: '分离头指针',
    tooltip: 'dsh-vcs-panel · 分离头指针',
    userNamed: false,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'unborn' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 0,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: '尚无提交',
    tooltip: 'dsh-vcs-panel · 尚无提交',
    userNamed: false,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'dsh-vcs-panel',
    head: null,
    checkoutCount: 2,
    commitBased: false,
    changedCount: null,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: 'dsh-vcs-panel',
    tooltip: 'dsh-vcs-panel · 工作树 · 2',
    userNamed: true,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'jj-repo',
    head: null,
    checkoutCount: 2,
    commitBased: true,
    changedCount: null,
    ahead: 0,
    behind: 0,
  }, tEn, 'en'), {
    label: 'jj-repo',
    tooltip: 'jj-repo · Workspaces · 2',
    userNamed: true,
  })

  // Single-repo Jujutsu with bookmark vs changeId-only vs bare label.
  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'jj-repo',
    head: { kind: 'workingCopy', label: '@', changeId: 'qpvuntsm', bookmark: 'main' },
    checkoutCount: 1,
    commitBased: true,
    changedCount: 0,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: 'main',
    tooltip: 'jj-repo · @ qpvuntsm · main',
    userNamed: true,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'jj-repo',
    head: { kind: 'workingCopy', label: '@', changeId: 'qpvuntsm', bookmark: null },
    checkoutCount: 1,
    commitBased: true,
    changedCount: 0,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: '@ qpvuntsm',
    tooltip: 'jj-repo · @ qpvuntsm',
    userNamed: true,
  })

  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'jj-repo',
    head: { kind: 'workingCopy', label: '@', changeId: null, bookmark: null },
    checkoutCount: 1,
    commitBased: true,
    changedCount: 0,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: '@',
    tooltip: 'jj-repo · @',
    userNamed: true,
  })

  // Multi-repo repository view shows repoName on chip even when branch is main.
  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: 5,
    repoName: 'dsh-vcs-panel',
    head: { kind: 'branch', name: 'main' },
    checkoutCount: 1,
    commitBased: false,
    changedCount: 2,
    ahead: 1,
    behind: 0,
  }, tZh, 'zh'), {
    label: 'dsh-vcs-panel',
    tooltip: 'dsh-vcs-panel · main · 2 个改动 · ↑1',
    userNamed: true,
  })

  // Defensive blank repoName without head falls back to view.label.
  assert.deepEqual(formatTabTitle({
    mode: 'repository',
    repositoryCount: null,
    repoName: '   ',
    head: null,
    checkoutCount: 0,
    commitBased: false,
    changedCount: null,
    ahead: 0,
    behind: 0,
  }, tZh, 'zh'), {
    label: '版本管理',
    tooltip: '版本管理',
    userNamed: false,
  })
})

test('sameTabTitleSnapshot compares modes, scalar counts, and heads accurately', () => {
  const base = {
    mode: 'repository',
    repositoryCount: 1,
    repoName: 'repo',
    head: { kind: 'workingCopy', label: '@', changeId: 'abcd1234', bookmark: 'main' },
    checkoutCount: 1,
    commitBased: true,
    changedCount: 2,
    ahead: 0,
    behind: 0,
  }
  assert.equal(sameTabTitleSnapshot(base, { ...base, head: { ...base.head } }), true)
  assert.equal(sameTabTitleSnapshot(base, { ...base, head: { ...base.head, bookmark: null } }), false)
  assert.equal(sameTabTitleSnapshot(base, { ...base, changedCount: 3 }), false)
  assert.equal(sameTabTitleSnapshot({ mode: 'tiled', repositoryCount: 2 }, { mode: 'all', repositoryCount: 2 }), false)
  assert.equal(sameTabTitleSnapshot(null, { mode: 'empty' }), false)
})

test('createTabTitleStore notifies session subscribers, avoids redundant emits, evicts idle LRU, and disposes cleanly', () => {
  const store = createTabTitleStore({ maxIdle: 2 })
  assert.equal(store.get('s1'), null)

  let s1Calls = 0
  let s2Calls = 0
  const unsub1 = store.subscribe('s1', () => { s1Calls += 1 })
  const unsub2 = store.subscribe('s2', () => { s2Calls += 1 })

  const snap1 = { mode: 'all', repositoryCount: 3 }
  store.set('s1', snap1)
  store.set('s2', { mode: 'tiled', repositoryCount: 2 })
  assert.deepEqual(store.get('s1'), snap1)
  assert.equal(s1Calls, 1)
  assert.equal(s2Calls, 1)

  // Identical snapshot does not trigger duplicate notifications.
  store.set('s1', { mode: 'all', repositoryCount: 3 })
  assert.equal(s1Calls, 1)

  // Unsubscribing stops notifications and is idempotent.
  unsub1()
  unsub1()
  store.set('s1', { mode: 'tiled', repositoryCount: 3 })
  assert.equal(s1Calls, 1)

  // Idle LRU eviction keeps subscribed s2 and the 2 most recently touched idle entries.
  store.set('s3', { mode: 'empty' })
  assert.notEqual(store.get('s1'), null)
  assert.notEqual(store.get('s3'), null)

  // Refreshing s1 moves it ahead of s3, so adding s4 evicts s3 while keeping s1, s4, and subscribed s2.
  store.set('s1', { mode: 'all', repositoryCount: 4 })
  store.set('s4', { mode: 'empty' })
  assert.equal(store.get('s3'), null)
  assert.deepEqual(store.get('s1'), { mode: 'all', repositoryCount: 4 })
  assert.notEqual(store.get('s4'), null)
  assert.deepEqual(store.get('s2'), { mode: 'tiled', repositoryCount: 2 })

  store.set('s2', { mode: 'empty' })
  assert.equal(s2Calls, 2)
  unsub2()
  // Now 3 idle entries exist (s1, s4, s2); unsubscribing s2 evicts the oldest idle entry (s1).
  assert.equal(store.get('s1'), null)
  assert.notEqual(store.get('s4'), null)
  assert.notEqual(store.get('s2'), null)

  store.dispose()
  assert.equal(store.get('s2'), null)
  store.set('s6', { mode: 'empty' })
  assert.equal(store.get('s6'), null)
  const afterDisposeUnsub = store.subscribe('s6', () => { s1Calls += 1 })
  afterDisposeUnsub()
})
