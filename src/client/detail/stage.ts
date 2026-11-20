/**
 * What a change-tree row stages or unstages.
 *
 * A file row writes its own comparison. A group or folder row writes every
 * stageable file below it in one request, so the Host changes the index in one
 * transaction and undo restores the whole folder in one step. The separate
 * groups state a direction by themselves: rows under Unstaged only stage and
 * rows under Staged only unstage. Merged rows have both sides and a tri-state
 * mark.
 */

import type { FileEntry } from './tree.js'

/** Directions a row's staging control can take. */
export const STAGE = 'stage'
export const UNSTAGE = 'unstage'

/** One direction a row's staging control can take. */
export type StageDirection = typeof STAGE | typeof UNSTAGE

/** The file one write request names. */
export interface StageFile {
  path: string
  oldPath?: string
}

/**
 * Whether Git can stage or unstage this entry from the panel. A conflict is
 * resolved elsewhere.
 * @param entry - a status entry.
 * @returns true for an entry the panel may write.
 */
export function isStageable(entry: FileEntry): boolean {
  return entry.untracked === true || (entry.status !== 'U' && entry.conflict !== true)
}

/** The file one write names for an entry: an untracked directory keeps its trailing slash. */
function stageFile(entry: FileEntry): StageFile {
  if (entry.directory === true) return { path: entry.path.endsWith('/') ? entry.path : `${entry.path}/` }
  return entry.origPath === undefined ? { path: entry.path } : { path: entry.path, oldPath: entry.origPath }
}

/** The side of one entry a direction writes, if the entry has it. */
function sideOf(group: string, entry: FileEntry, direction: StageDirection): FileEntry | undefined {
  const side = direction === STAGE ? 'unstaged' : 'staged'
  if (group !== 'merged') return group === side ? entry : undefined
  if (entry.directory === true) return direction === STAGE ? entry : undefined
  return entry.sources?.[side]
}

/**
 * The files a group or folder row writes in one direction.
 * @param group - `staged`, `unstaged`, or `merged`.
 * @param entries - the entries below the row.
 * @param direction - {@link STAGE} or {@link UNSTAGE}.
 * @returns the files, empty when nothing applies.
 */
export function stageFiles(group: string, entries: readonly FileEntry[], direction: StageDirection): StageFile[] {
  return entries.flatMap(entry => {
    const source = sideOf(group, entry, direction)
    return source === undefined || !isStageable(source) ? [] : [stageFile(source)]
  })
}

/**
 * The tri-state mark of a merged folder: checked when every stageable file is
 * fully staged, unchecked when none has staged changes, mixed otherwise.
 * @param entries - merged entries below the folder.
 * @returns the mark.
 */
export function mergedStageState(entries: readonly FileEntry[]): boolean | 'mixed' {
  const stageable = entries.filter(isStageable)
  const staged = stageable.some(entry => entry.sources?.staged !== undefined)
  const unstaged = stageable.some(entry => entry.directory === true || entry.sources?.unstaged !== undefined)
  if (!unstaged) return staged
  return staged ? 'mixed' : false
}

/**
 * The row key a staged folder or group lands on in the other group, so the
 * reading position can follow it after a refresh.
 * @param key - a `staged|` or `unstaged|` row key.
 * @returns the counterpart key, if the key has one.
 */
export function counterpartKey(key: string): string | undefined {
  const bar = key.indexOf('|')
  const group = key.slice(0, bar)
  if (group !== 'staged' && group !== 'unstaged') return undefined
  return `${group === 'staged' ? 'unstaged' : 'staged'}${key.slice(bar)}`
}
