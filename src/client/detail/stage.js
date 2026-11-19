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

/** Directions a row's staging control can take. */
export const STAGE = 'stage'
export const UNSTAGE = 'unstage'

/**
 * Whether Git can stage or unstage this entry from the panel. A conflict is
 * resolved elsewhere.
 * @param {{ status?: string, untracked?: boolean, conflict?: boolean }} entry - a status entry.
 * @returns {boolean} true for an entry the panel may write.
 */
export function isStageable(entry) {
  return entry.untracked === true || (entry.status !== 'U' && entry.conflict !== true)
}

/** The file one write names for an entry: an untracked directory keeps its trailing slash. */
function stageFile(entry) {
  if (entry.directory === true) return { path: entry.path.endsWith('/') ? entry.path : `${entry.path}/` }
  return entry.origPath === undefined ? { path: entry.path } : { path: entry.path, oldPath: entry.origPath }
}

/** The side of one entry a direction writes, if the entry has it. */
function sideOf(group, entry, direction) {
  const side = direction === STAGE ? 'unstaged' : 'staged'
  if (group !== 'merged') return group === side ? entry : undefined
  if (entry.directory === true) return direction === STAGE ? entry : undefined
  return entry.sources?.[side]
}

/**
 * The files a group or folder row writes in one direction.
 * @param {string} group - `staged`, `unstaged`, or `merged`.
 * @param {object[]} entries - the entries below the row.
 * @param {string} direction - {@link STAGE} or {@link UNSTAGE}.
 * @returns {Array<{ path: string, oldPath?: string }>} the files, empty when nothing applies.
 */
export function stageFiles(group, entries, direction) {
  return entries.flatMap(entry => {
    const source = sideOf(group, entry, direction)
    return source === undefined || !isStageable(source) ? [] : [stageFile(source)]
  })
}

/**
 * The tri-state mark of a merged folder: checked when every stageable file is
 * fully staged, unchecked when none has staged changes, mixed otherwise.
 * @param {object[]} entries - merged entries below the folder.
 * @returns {boolean | 'mixed'} the mark.
 */
export function mergedStageState(entries) {
  const stageable = entries.filter(isStageable)
  const staged = stageable.some(entry => entry.sources?.staged !== undefined)
  const unstaged = stageable.some(entry => entry.directory === true || entry.sources?.unstaged !== undefined)
  if (!unstaged) return staged
  return staged ? 'mixed' : false
}

/**
 * The row key a staged folder or group lands on in the other group, so the
 * reading position can follow it after a refresh.
 * @param {string} key - a `staged|` or `unstaged|` row key.
 * @returns {string | undefined} the counterpart key, if the key has one.
 */
export function counterpartKey(key) {
  const bar = key.indexOf('|')
  const group = key.slice(0, bar)
  if (group !== 'staged' && group !== 'unstaged') return undefined
  return `${group === 'staged' ? 'unstaged' : 'staged'}${key.slice(bar)}`
}
