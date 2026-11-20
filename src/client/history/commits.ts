/**
 * Pure helpers over loaded commit rows and one commit's detail.
 *
 * The History list and the commit pane both read these answers; keeping them
 * here lets the components stay layout code and the rules stay testable.
 */

import { worktreeNode } from '../state.js'

/** The commit fields these helpers read; commit rows may carry more. */
export interface CommitRow {
  sha: string
  parents?: readonly string[]
  author?: string
  workingCopies?: readonly { path: string }[]
}

/** One decoration on a commit row. */
export interface CommitRef {
  name: string
  kind: string
  current?: boolean
}

/** The commit relation to `HEAD`, or uncertainty an incomplete history leaves. */
export type CommitBranchRelation = 'on-branch' | 'off-branch' | 'unknown'

/** Reachability from `HEAD` across the loaded commits. */
export interface Reachability {
  reachable: Set<string>
  complete: boolean
}

/**
 * The part of a commit message below its subject.
 *
 * Git's `%s` is the first paragraph with its lines joined, so the body starts
 * after the first blank line; a message without one has no body. Blank lines
 * that open the body and trailing whitespace are dropped, indentation inside
 * the body is kept.
 *
 * @param message - the full message (`%B`).
 * @returns the body, or '' when the message is only a subject.
 */
export function messageBody(message: unknown): string {
  if (typeof message !== 'string') return ''
  const separator = /\r?\n[ \t]*\r?\n/u.exec(message)
  if (separator === null) return ''
  return message
    .slice(separator.index + separator[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/u, '')
    .trimEnd()
}

/**
 * Whether the loaded commits name more than one author; with a single author
 * the per-row author column repeats one name and is left out.
 * @param commits - loaded commit rows.
 * @returns true when at least two authors appear.
 */
export function hasSeveralAuthors(commits: readonly { readonly author?: string }[]): boolean {
  const first = commits[0]?.author
  return commits.some(commit => commit.author !== first)
}

/**
 * Index loaded commits by full id.
 *
 * Map each checked workspace to its commit too, so its selection survives a
 * working-copy rewrite. Multiple workspaces can point to the same row.
 * @param commits - loaded commit rows in list order.
 * @returns commit id or working-copy token to row index.
 */
export function indexCommits(commits: readonly CommitRow[]): Map<string, number> {
  const index = new Map(commits.map((commit, position) => [commit.sha, position]))
  commits.forEach((commit, position) => {
    for (const copy of commit.workingCopies ?? []) index.set(worktreeNode(copy.path), position)
  })
  return index
}

/**
 * Walk parent links from `head` across loaded commits.
 * `complete` is true when `head` is loaded and every encountered parent is also
 * present in `commits`, meaning no unloaded history can hide an ancestor link.
 * @param commits - loaded commit rows.
 * @param head - the commit id HEAD points to.
 * @returns reachable commit ids and completeness.
 */
export function reachableCommits(commits: readonly CommitRow[], head: string | null): Reachability {
  const reachable = new Set<string>()
  if (typeof head !== 'string' || head === '' || !Array.isArray(commits) || commits.length === 0) {
    return { reachable, complete: false }
  }
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  if (!bySha.has(head)) return { reachable, complete: false }

  const stack = [head]
  let complete = true
  while (stack.length > 0) {
    const sha = stack.pop()!
    if (reachable.has(sha)) continue
    const commit = bySha.get(sha)
    if (commit === undefined) {
      complete = false
      continue
    }
    reachable.add(sha)
    for (const parent of commit.parents ?? []) {
      if (!reachable.has(parent)) stack.push(parent)
    }
  }
  return { reachable, complete }
}

/**
 * Classify whether one commit is an ancestor of `head`, strictly off the current
 * branch, or uncertain due to an incomplete history frontier.
 * @param commits - loaded commits in topo order.
 * @param commitIndex - sha-to-index map.
 * @param head - the HEAD commit id.
 * @param sha - candidate commit id.
 * @param [reachability] - precomputed reachability from `head`.
 * @returns the commit's relation to `HEAD`.
 */
export function commitBranchRelation(
  commits: readonly CommitRow[],
  commitIndex: ReadonlyMap<string, number>,
  head: string | null,
  sha: string,
  reachability: Reachability = reachableCommits(commits, head),
): CommitBranchRelation {
  if (typeof sha !== 'string' || sha === '') return 'unknown'
  if (typeof head !== 'string' || head === '' || !commitIndex.has(head)) return 'unknown'
  if (reachability.reachable.has(sha)) return 'on-branch'
  const shaIndex = commitIndex.get(sha)
  if (reachability.complete || (shaIndex !== undefined && shaIndex < commitIndex.get(head)!)) {
    return 'off-branch'
  }
  return 'unknown'
}
