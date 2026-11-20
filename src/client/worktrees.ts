/** The checked working copies are an ordered subset of a repository's catalog. */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { CommitNode, RepositoryInfo, VcsRef, WorktreeInfo } from './api.js'
import { shortSha } from './format.js'
import {
  preferredNode, WORKING_COPY, WORKTREE, worktreeNode, worktreePath,
  type PanelState, type PreferredNodeStatus,
} from './state.js'

/**
 * One checkout the panel may show, with the status read it displays.
 *
 * The status is attached by the view that read it, not by the repository
 * catalog; the default-node rule only looks at its total.
 */
export interface WorktreeChoice extends WorktreeInfo {
  status?: {
    total?: number
  }
}

/**
 * The checked working copies of one repository; a backend that cannot list
 * them still has the repository's own checkout.
 * @param repository - the repository the panel shows, or null.
 * @returns the checkouts, empty when the backend has no working copy.
 */
export function repositoryWorktrees(repository: RepositoryInfo | null | undefined): WorktreeInfo[] {
  if (repository?.capabilities?.workingCopy == null) return []
  return repository.worktrees !== undefined && repository.worktrees.length > 0
    ? repository.worktrees
    : [{ path: repository.path, name: repository.name, head: null, branch: null }]
}

/** Normalize missing and removed choices to the repository's first (session) tree. */
export function checkedWorktrees(worktrees: readonly WorktreeInfo[], paths: readonly string[]): WorktreeInfo[] {
  const checked = worktrees.filter(tree => paths.includes(tree.path))
  return checked.length > 0 || worktrees.length === 0 ? checked : [worktrees[0]]
}

/** Toggle one checkout's selection, keeping at least one selected. */
export function toggleWorktree(worktrees: readonly WorktreeInfo[], paths: readonly string[], path: string): string[] {
  const checked = checkedWorktrees(worktrees, paths).map(tree => tree.path)
  if (!worktrees.some(tree => tree.path === path)) return checked
  if (checked.includes(path)) return checked.length === 1 ? checked : checked.filter(value => value !== path)
  return checkedWorktrees(worktrees, [...checked, path]).map(tree => tree.path)
}

/**
 * The reference text of one checkout: the branch it has checked out, its short
 * detached head, or the working-copy token for a commit-based backend.
 */
export function worktreeRefLabel(
  tree: { branch?: string | null; head?: string | null },
  t: Translate,
  commitBased = false,
): string | null {
  if (commitBased) return WORKING_COPY
  if (tree.branch !== null && tree.branch !== undefined) return tree.branch
  return tree.head ? `${t('top.detached')} · ${shortSha(tree.head)}` : null
}

/** Name the working copy: the checkout's name, or the bare token when there is one checkout. */
export function workingCopyLabel(tree: { name: string }, named: boolean): string {
  return named ? `${tree.name}@` : WORKING_COPY
}

/** Name each checked working copy on its real commit, without cloning rows. */
export function attachWorkingCopies(commits: readonly CommitNode[], worktrees: readonly WorktreeInfo[]): CommitNode[] {
  const byHead = new Map<string, WorktreeInfo[]>()
  for (const tree of worktrees) {
    if (tree.head === null) continue
    const copies = byHead.get(tree.head)
    if (copies === undefined) byHead.set(tree.head, [tree])
    else copies.push(tree)
  }
  return commits.map(commit => {
    const workingCopies = byHead.get(commit.sha)
    if (workingCopies !== undefined) return { ...commit, workingCopy: true, workingCopies }
    return commit.workingCopy === true ? { ...commit, workingCopy: false } : commit
  })
}

/** In a multi-tree view (or a sibling preview), default to the working changes. */
export function preferredViewNode(
  state: PanelState,
  worktrees: readonly WorktreeChoice[],
  status: PreferredNodeStatus | null | undefined,
  commitBased = false,
): string | null {
  if (worktrees.length === 0) return preferredNode(state, status)
  const current = worktreePath(state.node)
  if (state.nodeChosen && state.node !== null) {
    if (state.node === WORKING_COPY) {
      return worktreeNode((worktrees.find(tree => tree.path === state.repo) ?? worktrees[0]).path)
    }
    if (state.node === WORKTREE) return worktreeNode(worktrees[0].path)
    if (current === null || worktrees.some(tree => tree.path === current)) return state.node
  }
  if (commitBased) return worktreeNode(worktrees[0].path)
  if (worktrees.length !== 1 || worktrees[0].path !== state.repo) {
    const tree = worktrees.find(entry => (entry.status?.total ?? 0) > 0) ?? worktrees[0]
    return worktreeNode(tree.path)
  }
  const node = preferredNode({ ...state, nodeChosen: false }, status)
  return node === WORKTREE || (current !== null && current !== worktrees[0].path)
    ? worktreeNode(worktrees[0].path)
    : node
}

/** HEAD decorations refer to the command's checkout, not the shared graph. */
export function sharedRefs(refs: readonly VcsRef[]): VcsRef[] {
  return refs.filter(ref => ref.kind !== 'head').map(ref => {
    if (ref.current !== true) return ref
    const { current, ...shared } = ref
    return shared
  })
}
