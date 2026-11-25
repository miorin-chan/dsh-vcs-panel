/** The cross-repository history page shared by Host and Client. */

import type { CommitNode } from './log.js'
import type { StashEntry } from './stash-types.js'

export const ACTIVITY_PAGE_SIZE = 200
export const ACTIVITY_PAGE_MAX = 300

export interface ActivityRequest {
  until: number | null
  limit: number
  heads: readonly string[]
}

type RepositoryEntry =
  | { kind: 'commit'; time: number; commit: CommitNode }
  | { kind: 'stash'; time: number; stash: StashEntry }

export interface ActivityRepositoryAnswer {
  entries: RepositoryEntry[]
  exhausted: boolean
}

export type ActivityEntry = RepositoryEntry & { repo: string }

export interface ActivityFailure {
  repo: string
  error: { code: string }
}

export interface ActivityAnswer {
  entries: ActivityEntry[]
  next: number | null
  failures: ActivityFailure[]
}

/** Take a global page without splitting any same-second group we have read. */
export function mergeActivity(
  results: readonly ({ repo: string; page: ActivityRepositoryAnswer } | ActivityFailure)[],
  limit: number,
): ActivityAnswer {
  const entries: ActivityEntry[] = []
  const failures: ActivityFailure[] = []
  let exhausted = true
  for (const result of results) {
    if ('error' in result) failures.push(result)
    else {
      exhausted &&= result.page.exhausted
      for (const entry of result.page.entries) entries.push({ ...entry, repo: result.repo })
    }
  }
  // Stable sort preserves discovery order and each repository's own order.
  entries.sort((a, b) => b.time - a.time)
  let end = Math.min(limit, entries.length)
  while (end < entries.length && entries[end].time === entries[end - 1].time) end += 1
  const last = entries[end - 1]
  const next = last === undefined || last.time <= 0 || (exhausted && end === entries.length) ? null : last.time - 1
  return { entries: entries.slice(0, end), next, failures }
}
