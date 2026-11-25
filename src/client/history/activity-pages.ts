/** Page accumulation and the two ways to replace the first page. */

import type { ActivityAnswer, ActivityEntry } from '../../lib/activity.js'
import { entryKey } from './activity-model.js'

export const ACTIVITY_ENTRY_MAX = 10_000

function uniqueEntries(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>()
  const kept: ActivityEntry[] = []
  for (const entry of entries) {
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(entry)
    if (kept.length === ACTIVITY_ENTRY_MAX) break
  }
  return kept
}

export function resetActivityPage(page: ActivityAnswer): ActivityAnswer {
  return { ...page, entries: uniqueEntries(page.entries) }
}

/** Replace the covered interval, leaving a previously loaded older suffix alone. */
export function spliceActivityPage(previous: ActivityAnswer, page: ActivityAnswer): ActivityAnswer {
  const boundary = page.entries.at(-1)?.time
  if (boundary === undefined) return resetActivityPage(page)
  const older = previous.entries.filter(entry => entry.time < boundary)
  return { ...page, entries: uniqueEntries([...page.entries, ...older]), next: older.length > 0 ? previous.next : page.next }
}

export function appendActivityPage(previous: ActivityAnswer, page: ActivityAnswer): ActivityAnswer {
  const failures = new Map(previous.failures.map(failure => [failure.repo, failure]))
  for (const failure of page.failures) failures.set(failure.repo, failure)
  return { ...page, entries: uniqueEntries([...previous.entries, ...page.entries]), failures: [...failures.values()] }
}
