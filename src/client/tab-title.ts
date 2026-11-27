/**
 * Live right-Sidebar tab title state and formatting for `dsh-vcs-panel`.
 *
 * The panel body updates an in-memory per-Session snapshot store while mounted,
 * and `VcsTabTitle` subscribes to it so the chip keeps showing the active
 * branch, repository, or view even after switching to another tab (without
 * keeping background SSE streams alive). Before the tab mounts after a reload,
 * `fallbackTabTitleSnapshot` recovers the last view from `sessionStorage`.
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { RepositoryInfo, StatusData, WorktreeInfo } from './api.js'
import { formatCount, formatPlural, shortChangeId } from './format.js'
import { loadState, WORKING_COPY } from './state.js'
import { workingCopyLabel } from './worktrees.js'

/** Active head descriptor carried inside a repository snapshot. */
export type TabHead =
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'detached' }
  | { readonly kind: 'unborn' }
  | {
      readonly kind: 'workingCopy'
      readonly label: string
      readonly changeId: string | null
      readonly bookmark: string | null
    }

/** Last-known panel context shown in the tab chip and its tooltip. */
export type TabTitleSnapshot =
  | { readonly mode: 'empty' }
  | { readonly mode: 'tiled'; readonly repositoryCount: number | null }
  | { readonly mode: 'all'; readonly repositoryCount: number | null }
  | {
      readonly mode: 'repository'
      readonly repositoryCount: number | null
      readonly repoName: string
      readonly head: TabHead | null
      readonly checkoutCount: number
      readonly commitBased: boolean
      readonly changedCount: number | null
      readonly ahead: number
      readonly behind: number
    }

/** Formatted chip label, native tooltip, and whether the label carries user content. */
export interface TabTitleView {
  readonly label: string
  readonly tooltip: string
  readonly userNamed: boolean
}

/** Live `VcsView` facts reduced into a {@link TabTitleSnapshot}. */
export interface TabTitleInput {
  readonly repositoriesStatus: string
  readonly repositoryCount: number
  readonly tiled: boolean
  readonly allScope: boolean
  readonly repoInfo: Pick<RepositoryInfo, 'name' | 'path' | 'capabilities'> | null
  readonly checkedTrees: readonly WorktreeInfo[]
  readonly worktrees: readonly WorktreeInfo[]
  readonly status: StatusData | null
}

/** Per-Session store connecting `VcsView` updates to `VcsTabTitle`. */
export interface TabTitleStore {
  get(sessionId: string): TabTitleSnapshot | null
  set(sessionId: string, snapshot: TabTitleSnapshot): void
  subscribe(sessionId: string, listener: () => void): () => void
  dispose(): void
}

const DEFAULT_MAX_IDLE = 100

/** Whether two head descriptors carry identical fields. */
function sameTabHead(a: TabHead | null, b: TabHead | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'branch':
      return b.kind === 'branch' && a.name === b.name
    case 'detached':
    case 'unborn':
      return true
    case 'workingCopy':
      return b.kind === 'workingCopy'
        && a.label === b.label
        && a.changeId === b.changeId
        && a.bookmark === b.bookmark
  }
}

/**
 * Whether two snapshots represent the exact same tab title state.
 * @param a - previous snapshot.
 * @param b - candidate snapshot.
 * @returns true when both snapshots carry identical fields.
 */
export function sameTabTitleSnapshot(a: TabTitleSnapshot | null, b: TabTitleSnapshot | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.mode !== b.mode) return false
  switch (a.mode) {
    case 'empty':
      return true
    case 'tiled':
    case 'all':
      return (b.mode === a.mode) && a.repositoryCount === b.repositoryCount
    case 'repository':
      return b.mode === 'repository'
        && a.repositoryCount === b.repositoryCount
        && a.repoName === b.repoName
        && a.checkoutCount === b.checkoutCount
        && a.commitBased === b.commitBased
        && a.changedCount === b.changedCount
        && a.ahead === b.ahead
        && a.behind === b.behind
        && sameTabHead(a.head, b.head)
  }
}

/**
 * Extract the repository directory's basename from a persisted root path.
 * @param path - POSIX or Windows repository path.
 * @returns trailing directory name, or null for empty paths and filesystem roots.
 */
export function repoBaseName(path: string): string | null {
  if (typeof path !== 'string' || path === '') return null
  const trimmed = path.replace(/[/\\]+$/u, '')
  if (trimmed === '' || /^[A-Za-z]:$/u.test(trimmed)) return null
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const segment = cut < 0 ? trimmed : trimmed.slice(cut + 1)
  return segment === '' ? null : segment
}

/**
 * Recover a coarse tab title snapshot from `sessionStorage` before the panel mounts.
 * @param sessionId - Session owning the tab.
 * @param [storage] - sessionStorage-compatible store.
 * @returns restored snapshot, or null when no persisted view exists.
 */
export function fallbackTabTitleSnapshot(
  sessionId: string,
  storage: Storage | undefined = globalThis.sessionStorage,
): TabTitleSnapshot | null {
  if (sessionId === '') return null
  const state = loadState(sessionId, storage)
  if (state.tiled) return { mode: 'tiled', repositoryCount: null }
  if (state.timelineScope === 'all') return { mode: 'all', repositoryCount: null }
  if (state.repo !== null) {
    const repoName = repoBaseName(state.repo)
    if (repoName !== null) {
      return {
        mode: 'repository',
        repositoryCount: null,
        repoName,
        head: null,
        checkoutCount: state.worktrees.length,
        commitBased: false,
        changedCount: null,
        ahead: 0,
        behind: 0,
      }
    }
  }
  return null
}

/**
 * Derive a tab title snapshot from live `VcsView` state.
 *
 * Returns `null` during initial discovery before any repository is known so a
 * mounting panel keeps its `sessionStorage` fallback until discovery settles.
 * @param input - live panel inputs.
 * @returns snapshot to publish, or null while initial discovery is still pending.
 */
export function buildTabTitleSnapshot(input: TabTitleInput): TabTitleSnapshot | null {
  const repositoryCount = input.repositoryCount > 0 ? input.repositoryCount : null
  if (input.repositoriesStatus === 'idle' || input.repositoriesStatus === 'loading') {
    if (input.tiled) return { mode: 'tiled', repositoryCount }
    if (input.allScope) return { mode: 'all', repositoryCount }
    if (input.repoInfo === null) return null
  }
  if (input.repositoryCount === 0) return { mode: 'empty' }
  if (input.tiled) return { mode: 'tiled', repositoryCount }
  if (input.allScope && input.repositoryCount >= 2) {
    return { mode: 'all', repositoryCount: input.repositoryCount }
  }
  if (input.repoInfo === null) return { mode: 'empty' }

  const commitBased = input.repoInfo.capabilities.workingCopy === 'commit'
  const checkoutCount = input.checkedTrees.length
  let head: TabHead | null = null

  if (checkoutCount <= 1) {
    if (commitBased) {
      const wc = input.status?.workingCopy
      if (wc != null) {
        const activeWorkspace = input.worktrees.find(tree => tree.path === input.checkedTrees[0]?.path)
        const label = activeWorkspace === undefined
          ? WORKING_COPY
          : workingCopyLabel(activeWorkspace, input.worktrees.length > 1)
        const changeId = typeof wc.changeId === 'string' && wc.changeId !== ''
          ? shortChangeId(wc.changeId)
          : null
        const bookmark = wc.refs.find(ref => ref.kind === 'bookmark')?.name ?? null
        head = { kind: 'workingCopy', label, changeId, bookmark }
      }
    } else {
      const branch = input.status?.branch
      if (branch != null) {
        if (branch.unborn) head = { kind: 'unborn' }
        else if (branch.detached) head = { kind: 'detached' }
        else if (typeof branch.name === 'string' && branch.name !== '') head = { kind: 'branch', name: branch.name }
        else head = { kind: 'detached' }
      } else if (
        input.checkedTrees.length === 1
        && typeof input.checkedTrees[0]?.branch === 'string'
        && input.checkedTrees[0].branch !== ''
      ) {
        head = { kind: 'branch', name: input.checkedTrees[0].branch }
      }
    }
  }

  const changedCount = checkoutCount <= 1
    && typeof input.status?.total === 'number'
    && Number.isFinite(input.status.total)
    ? input.status.total
    : null
  const ahead = !commitBased
    && checkoutCount <= 1
    && typeof input.status?.branch?.ahead === 'number'
    && input.status.branch.ahead > 0
    ? input.status.branch.ahead
    : 0
  const behind = !commitBased
    && checkoutCount <= 1
    && typeof input.status?.branch?.behind === 'number'
    && input.status.branch.behind > 0
    ? input.status.branch.behind
    : 0

  return {
    mode: 'repository',
    repositoryCount,
    repoName: input.repoInfo.name,
    head,
    checkoutCount,
    commitBased,
    changedCount,
    ahead,
    behind,
  }
}

/**
 * Format a snapshot into the compact chip label and full hover tooltip.
 * @param snapshot - live or recovered snapshot, or null.
 * @param t - localized translate function in the `vcs` namespace.
 * @param [locale] - active BCP 47 locale tag for number and plural formatting.
 * @returns chip label, tooltip, and whether the label is user-named content.
 */
export function formatTabTitle(
  snapshot: TabTitleSnapshot | null,
  t: Translate,
  locale?: string,
): TabTitleView {
  if (snapshot === null || snapshot.mode === 'empty') {
    const label = t('view.label')
    return { label, tooltip: label, userNamed: false }
  }
  if (snapshot.mode === 'tiled') {
    const label = t('tile.title')
    const parts = [t('view.label'), label]
    if (snapshot.repositoryCount !== null && snapshot.repositoryCount > 0) {
      parts.push(formatPlural(t, 'all.count', snapshot.repositoryCount, locale))
    }
    return { label, tooltip: parts.join(' · '), userNamed: false }
  }
  if (snapshot.mode === 'all') {
    const label = t('all.title')
    const parts = [t('view.label'), label]
    if (snapshot.repositoryCount !== null && snapshot.repositoryCount > 0) {
      parts.push(formatPlural(t, 'all.count', snapshot.repositoryCount, locale))
    }
    return { label, tooltip: parts.join(' · '), userNamed: false }
  }

  const repoName = snapshot.repoName.trim()
  let label: string
  let userNamed: boolean
  if (snapshot.repositoryCount === 1 && snapshot.checkoutCount <= 1 && snapshot.head !== null) {
    switch (snapshot.head.kind) {
      case 'branch':
        label = snapshot.head.name
        userNamed = true
        break
      case 'detached':
        label = t('top.detached')
        userNamed = false
        break
      case 'unborn':
        label = t('top.unborn')
        userNamed = false
        break
      case 'workingCopy':
        if (snapshot.head.bookmark !== null) {
          label = snapshot.head.bookmark
          userNamed = true
        } else if (snapshot.head.changeId !== null) {
          label = `${snapshot.head.label} ${snapshot.head.changeId}`
          userNamed = true
        } else {
          label = snapshot.head.label
          userNamed = true
        }
        break
    }
  } else if (repoName !== '') {
    label = repoName
    userNamed = true
  } else {
    label = t('view.label')
    userNamed = false
  }

  const parts: string[] = []
  if (repoName !== '') parts.push(repoName)
  if (snapshot.checkoutCount > 1) {
    parts.push(t(
      snapshot.commitBased ? 'worktree.workspaceSelection' : 'top.worktreeSelection',
      { count: formatCount(snapshot.checkoutCount, locale) },
    ))
  } else if (snapshot.head !== null) {
    switch (snapshot.head.kind) {
      case 'branch':
        parts.push(snapshot.head.name)
        break
      case 'detached':
        parts.push(t('top.detached'))
        break
      case 'unborn':
        parts.push(t('top.unborn'))
        break
      case 'workingCopy':
        parts.push(
          snapshot.head.changeId !== null
            ? `${snapshot.head.label} ${snapshot.head.changeId}`
            : snapshot.head.label,
        )
        if (snapshot.head.bookmark !== null) parts.push(snapshot.head.bookmark)
        break
    }
  }
  if (snapshot.changedCount !== null && snapshot.changedCount > 0) {
    parts.push(formatPlural(t, 'timeline.changes', snapshot.changedCount, locale))
  }
  if (snapshot.ahead > 0 || snapshot.behind > 0) {
    const counts = [
      snapshot.ahead > 0 ? `↑${formatCount(snapshot.ahead, locale)}` : '',
      snapshot.behind > 0 ? `↓${formatCount(snapshot.behind, locale)}` : '',
    ].filter(Boolean).join(' ')
    if (counts !== '') parts.push(counts)
  }

  return {
    label,
    tooltip: parts.length > 0 ? parts.join(' · ') : t('view.label'),
    userNamed,
  }
}

/**
 * Create a per-Session in-memory store for tab title snapshots with bounded idle LRU eviction.
 * @param [options] - optional capacity settings.
 * @returns the store.
 */
export function createTabTitleStore({ maxIdle = DEFAULT_MAX_IDLE }: { maxIdle?: number } = {}): TabTitleStore {
  const snapshots = new Map<string, TabTitleSnapshot>()
  const listeners = new Map<string, Set<() => void>>()
  let disposed = false

  function isIdle(sessionId: string): boolean {
    const set = listeners.get(sessionId)
    return set === undefined || set.size === 0
  }

  function evictIdle(): void {
    let idle = 0
    for (const key of snapshots.keys()) {
      if (isIdle(key)) idle += 1
    }
    for (const key of [...snapshots.keys()]) {
      if (idle <= maxIdle) break
      if (!isIdle(key)) continue
      snapshots.delete(key)
      idle -= 1
    }
  }

  return {
    get(sessionId) {
      if (disposed || sessionId === '') return null
      return snapshots.get(sessionId) ?? null
    },

    set(sessionId, snapshot) {
      if (disposed || sessionId === '') return
      const previous = snapshots.get(sessionId) ?? null
      if (previous !== null && sameTabTitleSnapshot(previous, snapshot)) {
        snapshots.delete(sessionId)
        snapshots.set(sessionId, previous)
        return
      }
      snapshots.delete(sessionId)
      snapshots.set(sessionId, snapshot)
      evictIdle()
      const subs = listeners.get(sessionId)
      if (subs === undefined) return
      for (const listener of [...subs]) listener()
    },

    subscribe(sessionId, listener) {
      if (disposed || sessionId === '') return () => {}
      let subs = listeners.get(sessionId)
      if (subs === undefined) {
        subs = new Set()
        listeners.set(sessionId, subs)
      }
      subs.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        const current = listeners.get(sessionId)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) {
          listeners.delete(sessionId)
          evictIdle()
        }
      }
    },

    dispose() {
      disposed = true
      snapshots.clear()
      listeners.clear()
    },
  }
}
