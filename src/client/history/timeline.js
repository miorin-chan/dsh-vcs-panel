/**
 * Pure rules for the timeline: selected working trees above shared commits.
 *
 * The timeline is one list with worktree rows followed by loaded commits in
 * `--topo-order`. These helpers translate
 * between row indexes and timeline nodes and build the lane-graph input.
 */

import { worktreeNode } from '../state.js'

/**
 * The lane-graph input.
 *
 * Each selected working tree contributes a virtual node linked to its HEAD;
 * a backend whose working copy is a commit contributes
 * the commits as they came.
 * @param {object[]} commits - loaded commits in list order.
 * @param {{ id: string, head: string | null }[]} worktrees - virtual rows in display order.
 * @returns {object[]} nodes for `buildGraph`.
 */
export function graphInput(commits, worktrees) {
  return [...worktrees.map(({ id, head }) => ({ sha: id, parents: head === null ? [] : [head], refs: [], worktree: true })), ...commits]
}

/**
 * The node shown on one timeline row.
 * @param {object[]} commits - loaded commits.
 * @param {number} index - row index.
 * @param {{ worktrees?: { id: string }[] }} [options] - virtual worktree rows before the commits.
 * @returns {string | null} the node, or null past the end.
 */
export function nodeAt(commits, index, { worktrees = [] } = {}) {
  if (index < worktrees.length) return worktrees[index]?.id ?? null
  const commit = commits[index - worktrees.length]
  if (commit === undefined || commit === null) return null
  const copy = commit.workingCopies?.[0]
  return copy === undefined ? commit.sha : worktreeNode(copy.path)
}

/**
 * The timeline row showing one node.
 * @param {Map<string, number>} commitIndex - commit id to commit index.
 * @param {string | null} node - the node.
 * @param {{ id: string }[]} [worktrees] - worktree rows.
 * @returns {number} the row index, or -1 when the node is not loaded.
 */
export function rowOf(commitIndex, node, worktrees = []) {
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
 * @param {Array<{ path: string, enclosing?: boolean, capabilities?: object }>} repositories - discovered list.
 * @param {string | null} [preferredPath] - previously chosen repository path.
 * @returns {{ path: string, enclosing?: boolean, capabilities?: object } | null} the chosen entry, or null.
 */
export function pickRepository(repositories, preferredPath = null) {
  if (!Array.isArray(repositories) || repositories.length === 0) return null
  return (preferredPath === null ? undefined : repositories.find(entry => entry.path === preferredPath))
    ?? repositories.find(entry => entry.enclosing === true)
    ?? repositories[0]
    ?? null
}

/**
 * What the working-tree row and header say about the uncommitted changes.
 * Count untracked status entries, including collapsed directories, separately from lines.
 * @param {{ total?: number, untrackedTotal?: number, groups?: Record<string, object[]> } | null} status - the working-tree answer.
 * @returns {{ changed: number, added: number, deleted: number, untracked: number }} the summary.
 */
export function worktreeSummary(status) {
  let added = 0
  let deleted = 0
  for (const group of ['staged', 'unstaged']) {
    for (const entry of status?.groups?.[group] ?? []) {
      if (typeof entry.added === 'number') added += entry.added
      if (typeof entry.deleted === 'number') deleted += entry.deleted
    }
  }
  const untracked = status?.untrackedTotal ?? status?.groups?.untracked?.length ?? 0
  return { changed: status?.total ?? 0, added, deleted, untracked }
}
