/**
 * Pure rules for the timeline: worktrees first, then stashes and shared commits.
 *
 * The row model is also the source of the graph and the keyboard's row index.
 */

import { worktreeNode } from '../state.js'
import { stashNode } from '../stash.js'
import type { StashEntry } from '../../lib/stash-types.js'
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

export type TimelineRow<C extends TimelineCommitRow = TimelineCommitRow> =
  | { kind: 'worktree'; node: string; head: string | null }
  | { kind: 'stash'; node: string; stash: StashEntry }
  | { kind: 'commit'; node: string; commit: C }

/** One changed file's line counts inside a status group. */
export interface WorktreeStatusEntry {
  added?: number
  deleted?: number
}

/** The working-tree status fields the summary reads. */
export interface WorktreeStatus {
  total?: number
  untrackedTotal?: number
  untrackedAdded?: number | null
  groups?: Readonly<Partial<Record<'staged' | 'unstaged' | 'untracked', readonly WorktreeStatusEntry[]>>>
}

/** What the working-tree row and header say about the uncommitted changes. */
export interface WorktreeSummary {
  changed: number
  added: number
  deleted: number
  untracked: number
  untrackedAdded: number | null
}

/** One discovered repository entry; `pickRepository` preserves the caller's shape. */
export interface RepositoryEntry {
  path: string
  enclosing?: boolean
}

/** Put each stash immediately above its loaded base, newest first at that base. */
export function timelineRows<C extends TimelineCommitRow>(
  commits: readonly C[], worktrees: readonly WorktreeHead[], stashes: readonly StashEntry[],
): TimelineRow<C>[] {
  const byBase = new Map<string, TimelineRow<C>[]>()
  const seen = new Set<string>()
  for (const stash of stashes) {
    // Two reflog entries can contain the exact same W object. One node per
    // object preserves the same identity used for writes (the newest match).
    if (seen.has(stash.sha)) continue
    seen.add(stash.sha)
    const row = { kind: 'stash', node: stashNode(stash.sha), stash } as const
    const group = byBase.get(stash.base)
    if (group === undefined) byBase.set(stash.base, [row])
    else group.push(row)
  }
  return [
    ...worktrees.map(({ id, head }) => ({ kind: 'worktree', node: id, head } as const)),
    ...commits.flatMap((commit): TimelineRow<C>[] => {
      const copy = commit.workingCopies?.[0]
      return [...byBase.get(commit.sha) ?? [], { kind: 'commit', node: copy === undefined ? commit.sha : worktreeNode(copy.path), commit }]
    }),
  ]
}

export function graphInput(rows: readonly TimelineRow<GraphCommit>[]): GraphCommit[] {
  return rows.map(row => row.kind === 'commit' ? row.commit : {
    sha: row.node,
    kind: row.kind,
    parents: row.kind === 'stash' ? [row.stash.base] : row.head === null ? [] : [row.head],
    refs: [],
  })
}

export function nodeAt(rows: readonly TimelineRow[], index: number): string | null {
  return rows[index]?.node ?? null
}

/** Jujutsu workspaces sharing a commit are aliases for the same row. */
export function indexTimelineRows(rows: readonly TimelineRow[]): Map<string, number> {
  const index = new Map<string, number>()
  rows.forEach((row, position) => {
    index.set(row.node, position)
    if (row.kind === 'commit') {
      index.set(row.commit.sha, position)
      for (const copy of row.commit.workingCopies ?? []) index.set(worktreeNode(copy.path), position)
    }
  })
  return index
}

export function rowOf(rowIndex: ReadonlyMap<string, number>, node: string | null): number {
  return node === null ? -1 : rowIndex.get(node) ?? -1
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
 * Use the Host's untracked line total, which also covers files in collapsed directories.
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
  const { total = 0, untrackedAdded = 0 } = status ?? {}
  const untracked = status?.untrackedTotal ?? status?.groups?.untracked?.length ?? 0
  return { changed: total, added, deleted, untracked, untrackedAdded }
}
