/** Group a time-ordered activity stream for the rows, graph, and navigation. */

import type { ActivityEntry } from '../../lib/activity.js'
import { stashNode } from '../stash.js'

export type ActivityRow =
  | { kind: 'day'; key: string; date: string; commits: number; repos: number }
  | { kind: 'single'; key: string; entry: ActivityEntry }
  | { kind: 'burst'; key: string; event: string; entry: ActivityEntry; earlier: number; from: number; to: number; expanded: boolean }
  | { kind: 'batch'; key: string; event: string; entry: ActivityEntry; repos: string[]; count: number; from: number; to: number; expanded: boolean }
  | { kind: 'child' | 'member'; key: string; entry: ActivityEntry; event: string }

export type ActivityStop = Exclude<ActivityRow, { kind: 'day' }>

export interface ActivityModel {
  rows: ActivityRow[]
  rowIndex: ReadonlyMap<string, number>
  selectable: number[]
  eventOfEntry(key: string): string | undefined
  rowForEntry(key: string): string | undefined
}

export function activityCommitKey(repo: string, sha: string): string {
  return `commit\0${repo}\0${sha}`
}

export function entryKey(entry: ActivityEntry): string {
  return entry.kind === 'commit' ? activityCommitKey(entry.repo, entry.commit.sha)
    : `stash\0${entry.repo}\0${entry.stash.sha}`
}

/** The corresponding node in the repository's own timeline. */
export function activityNode(entry: ActivityEntry): string {
  return entry.kind === 'stash' ? stashNode(entry.stash.sha) : entry.commit.sha
}

export function isActivityEntryKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:commit|stash)\0[^\0]+\0(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}

function isBatchKey(value: unknown): value is string {
  return typeof value === 'string' && /^batch\0[^\0]+\0(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}

export function isActivityEventKey(value: unknown): value is string {
  return isBatchKey(value) || (isActivityEntryKey(value) && value.startsWith('commit\0'))
}

export function isActivityStopKey(value: unknown): value is string {
  return isActivityEntryKey(value) || isBatchKey(value)
}

const BATCH_SECONDS = 30 * 60
const BURST_SECONDS = 45 * 60

/** Local calendar date, independent of the language used to display it. */
export function localActivityDay(time: number): string {
  const date = new Date(time * 1000)
  if (!Number.isFinite(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  const yearText = year >= 0 && year < 10_000 ? String(year).padStart(4, '0')
    : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`
  return `${yearText}-${month}-${day}`
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const key = keyOf(value)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [value])
    else group.push(value)
  }
  return groups
}

/** Split ordered members where the interval from the cluster start or predecessor exceeds the bound. */
function clusters<T extends ActivityEntry>(entries: readonly T[], seconds: number, from: 'start' | 'previous'): T[][] {
  const result: T[][] = []
  let group: T[] | undefined
  for (const entry of entries) {
    const reference = from === 'start' ? group?.[0] : group?.at(-1)
    if (group === undefined || reference!.time - entry.time > seconds) {
      group = []
      result.push(group)
    }
    group.push(entry)
  }
  return result
}

type ActivityCommit = Extract<ActivityEntry, { kind: 'commit' }>
type Event = { kind: 'single' | 'burst' | 'batch'; members: readonly ActivityEntry[] }

/** Remove batches first, so their members do not interrupt a repository's burst. */
function dayEvents(entries: readonly ActivityEntry[]): Event[] {
  const commits = entries.filter((entry): entry is ActivityCommit => entry.kind === 'commit')
  const bySubject = groupBy(commits.filter(entry => entry.commit.subject !== ''), entry => entry.commit.subject)
  const batchMembers = new Set<ActivityEntry>()
  const batches: Event[] = []
  for (const matching of bySubject.values()) {
    for (const members of clusters(matching, BATCH_SECONDS, 'start')) {
      if (members.every(entry => entry.repo === members[0].repo)) continue
      members.forEach(entry => { batchMembers.add(entry) })
      batches.push({ kind: 'batch', members })
    }
  }
  const byRepo = groupBy(commits.filter(entry => !batchMembers.has(entry)), entry => entry.repo)
  return [
    ...batches,
    ...[...byRepo.values()].flatMap(sameRepo => clusters(sameRepo, BURST_SECONDS, 'previous')
      .map((members): Event => ({ kind: members.length === 1 ? 'single' : 'burst', members }))),
    ...entries.flatMap((entry): Event[] => entry.kind === 'stash' ? [{ kind: 'single', members: [entry] }] : []),
  ]
}

export function buildActivity(
  entries: readonly ActivityEntry[],
  expanded: ReadonlySet<string>,
  repositories: readonly string[],
  dayOf = localActivityDay,
): ActivityModel {
  const orderedRepos = new Map(repositories.map((repo, index) => [repo, index]))
  const inputOrder = new Map(entries.map((entry, index) => [entry, index]))
  const rows: ActivityRow[] = []
  const events = new Map<string, string>()
  const visibleRows = new Map<string, string>()
  for (const [date, day] of groupBy(entries, entry => dayOf(entry.time))) {
    rows.push({ kind: 'day', key: `day\0${date}`, date,
      commits: day.filter(entry => entry.kind === 'commit').length,
      repos: new Set(day.map(entry => entry.repo)).size })
    const byTime = dayEvents(day).sort(({ members: [a] }, { members: [b] }) => b.time - a.time
      || (orderedRepos.get(a.repo) ?? Infinity) - (orderedRepos.get(b.repo) ?? Infinity)
      || inputOrder.get(a)! - inputOrder.get(b)!)
    for (const { kind, members } of byTime) {
      const entry = members[0]
      const key = kind === 'batch' && entry.kind === 'commit' ? `batch\0${entry.repo}\0${entry.commit.sha}` : entryKey(entry)
      const open = expanded.has(key)
      const range = { from: members.at(-1)!.time, to: entry.time }
      if (kind === 'single') rows.push({ kind, key, entry })
      else if (kind === 'burst') rows.push({ kind, key, entry, event: key, earlier: members.length - 1, ...range, expanded: open })
      else rows.push({ kind, key, entry, event: key, repos: [...new Set(members.map(member => member.repo))],
        count: members.length, ...range, expanded: open })
      for (const [index, member] of members.entries()) {
        const memberKey = entryKey(member)
        const child = open && (kind === 'batch' || (kind === 'burst' && index > 0))
        events.set(memberKey, key)
        visibleRows.set(memberKey, child ? memberKey : key)
        if (child) rows.push({ kind: kind === 'batch' ? 'member' : 'child', key: memberKey, event: key, entry: member })
      }
    }
  }
  return {
    rows, rowIndex: new Map(rows.map((row, index) => [row.key, index])),
    selectable: rows.flatMap((row, index) => row.kind === 'day' ? [] : [index]),
    eventOfEntry: key => events.get(key),
    rowForEntry: key => visibleRows.get(key),
  }
}

/** Restore a visible row, then the entry's current activity, then the first stop. */
export function activitySelection(model: ActivityModel, key: string | null, entry: string | null): number {
  const index = key === null ? undefined : model.rowIndex.get(key)
  if (index !== undefined && model.rows[index].kind !== 'day') return index
  const recovered = entry === null ? undefined : model.rowForEntry(entry)
  return (recovered === undefined ? undefined : model.rowIndex.get(recovered)) ?? model.selectable[0] ?? -1
}
