/**
 * Pure rules for the timeline: selected working trees above shared commits.
 *
 * The timeline is one list with worktree rows followed by loaded commits in
 * `--topo-order`. These helpers translate
 * between row indexes and timeline nodes and build the lane-graph input.
 */

import { worktreeNode } from '../state.js'
import type { GraphCommit } from './layout.js'

/** The commit fields the row↔node mapping reads; commit rows may carry more. */
export interface TimelineCommitRow {
  sha: string
  workingCopies?: readonly { readonly path: string }[]
}

/** One selected working tree as the graph input lists it. */
export interface WorktreeHead {
  id: string
  head: string | null
}

/** One changed file's line counts inside a status group. */
export interface WorktreeStatusEntry {
  added?: number
  deleted?: number
}

/** The working-tree status fields the summary reads. */
export interface WorktreeStatus {
  total?: number
  untrackedTotal?: number
  groups?: Readonly<Partial<Record<'staged' | 'unstaged' | 'untracked', readonly WorktreeStatusEntry[]>>>
}

/** What the working-tree row and header say about the uncommitted changes. */
export interface WorktreeSummary {
  changed: number
  added: number
  deleted: number
  untracked: number
}

/** One discovered repository entry; `pickRepository` preserves the caller's shape. */
export interface RepositoryEntry {
  path: string
  enclosing?: boolean
}

/**
 * The lane-graph input.
 *
 * Each selected working tree contributes a virtual node linked to its HEAD;
 * a backend whose working copy is a commit contributes
 * the commits as they came.
 * @param commits - loaded commits in list order.
 * @param worktrees - virtual rows in display order.
 * @returns nodes for `buildGraph`.
 */
export function graphInput(commits: readonly GraphCommit[], worktrees: readonly WorktreeHead[]): GraphCommit[] {
  return [...worktrees.map(({ id, head }) => ({ sha: id, parents: head === null ? [] : [head], refs: [], worktree: true })), ...commits]
}

/**
 * The node shown on one timeline row.
 * @param commits - loaded commits.
 * @param index - row index.
 * @param [options] - virtual worktree rows before the commits.
 * @returns the node, or null past the end.
 */
export function nodeAt(
  commits: readonly TimelineCommitRow[],
  index: number,
  { worktrees = [] }: { worktrees?: readonly { id: string }[] } = {},
): string | null {
  if (index < worktrees.length) return worktrees[index]?.id ?? null
  const commit: TimelineCommitRow | undefined = commits[index - worktrees.length]
  if (commit === undefined || commit === null) return null
  const copy = commit.workingCopies?.[0]
  return copy === undefined ? commit.sha : worktreeNode(copy.path)
}

/**
 * The timeline row showing one node.
 * @param commitIndex - commit id to commit index.
 * @param node - the node.
 * @param [worktrees] - worktree rows.
 * @returns the row index, or -1 when the node is not loaded.
 */
export function rowOf(
  commitIndex: ReadonlyMap<string, number>,
  node: string | null,
  worktrees: readonly { id: string }[] = [],
): number {
  if (node === null) return -1
  const treeIndex = worktrees.findIndex(tree => tree.id === node)
  if (treeIndex >= 0) return treeIndex
  const index = commitIndex.get(node)
  if (index === undefined) return -1
  return index + worktrees.length
}

/**
 * Choose the repository a Session opens by default: the persisted choice when
 * still listed, else the enclosing repository, else the first listed.
 * @param repositories - discovered list.
 * @param [preferredPath] - previously chosen repository path.
 * @returns the chosen entry, or null.
 */
export function pickRepository<T extends RepositoryEntry>(
  repositories: readonly T[],
  preferredPath: string | null = null,
): T | null {
  if (!Array.isArray(repositories) || repositories.length === 0) return null
  return (preferredPath === null ? undefined : repositories.find(entry => entry.path === preferredPath))
    ?? repositories.find(entry => entry.enclosing === true)
    ?? repositories[0]
    ?? null
}

/**
 * What the working-tree row and header say about the uncommitted changes.
 * Count untracked status entries, including collapsed directories, separately from lines.
 * @param status - the working-tree answer.
 * @returns the summary.
 */
export function worktreeSummary(status: WorktreeStatus | null | undefined): WorktreeSummary {
  let added = 0
  let deleted = 0
  for (const group of ['staged', 'unstaged'] as const) {
    for (const entry of status?.groups?.[group] ?? []) {
      if (typeof entry.added === 'number') added += entry.added
      if (typeof entry.deleted === 'number') deleted += entry.deleted
    }
  }
  const untracked = status?.untrackedTotal ?? status?.groups?.untracked?.length ?? 0
  return { changed: status?.total ?? 0, added, deleted, untracked }
}
