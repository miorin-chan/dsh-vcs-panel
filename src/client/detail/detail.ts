/**
 * Pure rules for the detail pane shared by the working tree and commits.
 *
 * A selected node is normalized into file groups: a backend with a separate
 * working tree supplies staged and unstaged groups, with untracked files
 * merged into unstaged; a commit (or a working-copy commit) has one group. The
 * change tree renders the groups' rows and reads one comparison per file row,
 * so a file's row and its diff are one thing.
 */

import type { DiffTarget } from '../api.js'
import { buildNodeRows, summarizeEntries } from './tree.js'
import type { FileEntry, TreeRow, UntrackedChild } from './tree.js'

/** Changed lines above which a file stays folded when every file is expanded. */
export const FOLD_LINES = 1000

/** Changed lines expanded files may render before the remaining files stay folded. */
export const STREAM_BUDGET = 20_000

/** Diff requests in flight at once. */
export const MAX_PARALLEL = 4

/** Below this tree width the side-by-side layout renders as one column. */
export const SPLIT_MIN_WIDTH = 640

/** Rendered height of one diff line at the default code font size, in CSS
 * pixels (`--vcs-diff-line-height` in FileDiff.css). */
const LINE_HEIGHT = 20

/** Lines `FileDiff` renders at most per comparison. */
const MAX_LINES = 5000

/** Working-tree groups of a backend that stages, in display order. */
const WORKTREE_GROUPS = ['staged', 'unstaged']

/** One file group of the change tree: a working-tree group or one commit. */
export interface FileGroup {
  id: string
  entries: readonly FileEntry[]
  header: boolean
  untrackedTotal?: number
}

/** The status groups one working-tree answer may carry. */
export interface WorktreeStatus {
  untrackedTotal?: number
  groups?: {
    staged?: readonly FileEntry[]
    unstaged?: readonly FileEntry[]
    untracked?: readonly FileEntry[]
  }
}

/** One file's section in the rendered comparison list. */
export interface Section {
  key: string
  group: string
  entry: FileEntry
  target: DiffTarget
}

/** Why the folding budget kept a file closed. */
export type FoldReason = 'large' | 'budget'

/** The comparison a commit's toolbar states. */
export interface ComparisonBase {
  kind: 'parent' | 'merge' | 'root' | 'autoMerge'
  parent?: string
}

/**
 * File groups of the working tree.
 *
 * Untracked files and directories join the unstaged group: the group answers
 * whether the change enters the next commit, and the answer is the same. Their
 * `untracked` flag marks them as untracked, not their group.
 *
 * @param status - the working-tree answer.
 * @returns the non-empty groups.
 */
export function worktreeGroups(status: WorktreeStatus | null): FileGroup[] {
  const untracked = status?.groups?.untracked ?? []
  return [
    { id: 'staged', entries: status?.groups?.staged ?? [], header: true },
    {
      id: 'unstaged',
      entries: [...(status?.groups?.unstaged ?? []), ...untracked],
      header: true,
      untrackedTotal: status?.untrackedTotal ?? untracked.length,
    },
  ].filter(group => group.entries.length > 0)
}

/** One Git row per path, with the original entries for its two comparisons. */
export function mergedWorktreeGroups(groups: readonly FileGroup[]): FileGroup[] {
  const files = new Map<string, Record<string, FileEntry>>()
  const directories: FileEntry[] = []
  for (const group of groups) {
    for (const entry of group.entries) {
      if (entry.directory === true) {
        directories.push(entry)
        continue
      }
      const sources: Record<string, FileEntry> = files.get(entry.path) ?? {}
      sources[group.id] = entry
      files.set(entry.path, sources)
    }
  }
  const entries: FileEntry[] = [...files.values()].map(sources => {
    const { staged, unstaged } = sources
    return {
      ...staged, ...unstaged, sources,
      origPath: staged?.origPath ?? unstaged?.origPath,
      added: (staged?.added ?? 0) + (unstaged?.added ?? 0),
      deleted: (staged?.deleted ?? 0) + (unstaged?.deleted ?? 0),
      binary: staged?.binary === true || unstaged?.binary === true,
    }
  })
  entries.push(...directories)
  return entries.length === 0 ? [] : [{ id: 'merged', entries, header: false }]
}

/** Preserve each comparison's scope and rename path in either layout. */
export function diffTargets(group: string, entry: FileEntry, rev: string | null): DiffTarget[] {
  if (group !== 'merged') return [diffTarget(group, entry, rev)]
  if (entry.sources === undefined) return [diffTarget('unstaged', entry, rev)]
  return ['staged', 'unstaged'].flatMap(side => {
    const source = entry.sources?.[side]
    return source === undefined ? [] : [diffTarget(side, source, rev)]
  })
}

/**
 * File groups of one commit.
 * @param commit - the commit detail.
 * @returns one group, or none.
 */
export function commitGroups(commit: { files?: readonly FileEntry[] } | null): FileGroup[] {
  const files = commit?.files ?? []
  return files.length === 0 ? [] : [{ id: 'commit', entries: files, header: false }]
}

/**
 * The comparison one file asks `vcs.diff` for. The scope comes from the file,
 * not from its group: an untracked file compares its whole content against the
 * index even though its row sits in the unstaged group.
 * @param group - the file's group.
 * @param entry - the file.
 * @param rev - the commit, for the commit group.
 * @returns the target.
 */
export function diffTarget(group: string, entry: FileEntry, rev: string | null): DiffTarget {
  const scope = group === 'commit' ? 'commit' : (entry.untracked === true ? 'untracked' : group)
  const target: DiffTarget = { scope, path: entry.path }
  if (entry.origPath !== undefined) target.oldPath = entry.origPath
  if (scope === 'commit') target.rev = rev
  return target
}

/**
 * The file sections one row list renders, in row order.
 * @param rows - the visible rows.
 * @param rev - the commit for the commit group.
 * @returns the sections.
 */
export function sectionsFromRows(rows: readonly TreeRow[], rev: string | null): Section[] {
  const sections: Section[] = []
  for (const row of rows) {
    if (row.kind !== 'file') continue
    sections.push({
      key: row.key,
      group: row.group,
      entry: row.entry,
      target: diffTargets(row.group, row.entry, rev)[0],
    })
  }
  return sections
}

/**
 * The diff sections of a node as if every directory were expanded, in the
 * order they would render.
 *
 * The expand action's folding budget is computed from this order, so collapsing or
 * expanding a directory does not change which other files start folded.
 * Untracked directories contribute only the children already loaded.
 *
 * @param groups - the node's groups.
 * @param dirChildren - loaded untracked children by directory key.
 * @param rev - the commit for the commit group.
 * @returns the sections.
 */
export function streamSections(
  groups: readonly FileGroup[],
  dirChildren: Record<string, readonly UntrackedChild[]>,
  rev: string | null,
): Section[] {
  const dirs: Record<string, boolean> = {}
  for (const key of Object.keys(dirChildren ?? {})) dirs[key] = true
  return sectionsFromRows(buildNodeRows(groups, { dirChildren, dirs, collapsed: {} }), rev)
}

/**
 * Changed lines one file states, or 0 when unknown (untracked files, binaries).
 * @param entry - the file.
 * @returns added plus deleted lines.
 */
export function changedLines(entry: FileEntry): number {
  if (entry?.binary === true) return 0
  const added = typeof entry?.added === 'number' ? entry.added : 0
  const deleted = typeof entry?.deleted === 'number' ? entry.deleted : 0
  return added + deleted
}

/**
 * Which files stay folded when every file is expanded, and why.
 *
 * The tree starts with every file folded, so this budget governs only the
 * toolbar's expand action. A file over {@link FOLD_LINES} changed lines stays
 * folded on its own. The others open in order until their changed lines pass
 * {@link STREAM_BUDGET}; the rest stay folded so one large node cannot render
 * an unbounded page. Changed lines stand in for rendered lines, which also
 * include a few lines of context.
 *
 * @param sections - sections in full expansion order.
 * @returns folded section keys with their reason.
 */
export function budgetFolds(sections: readonly Section[]): Map<string, FoldReason> {
  const folds = new Map<string, FoldReason>()
  let rendered = 0
  for (const section of sections) {
    const lines = changedLines(section.entry)
    if (lines > FOLD_LINES) {
      folds.set(section.key, 'large')
      continue
    }
    if (rendered >= STREAM_BUDGET) {
      folds.set(section.key, 'budget')
      continue
    }
    rendered += lines
  }
  return folds
}

/**
 * Whether one file is folded. A file opens only when the user asked for it:
 * the tree is a file list until then.
 * @param key - the file row key.
 * @param folds - the user's fold choices.
 * @returns true when folded.
 */
export function isFolded(key: string, folds: Record<string, boolean>): boolean {
  return folds?.[key] !== false
}

/**
 * Whether any file of the node is currently unfolded, which decides whether
 * the toolbar button collapses or expands.
 * @param sections - every file section of the node.
 * @param folds - the user's fold choices.
 * @returns true when at least one file is unfolded.
 */
export function hasUnfoldedFile(sections: readonly { key: string }[], folds: Record<string, boolean>): boolean {
  return sections.some(section => !isFolded(section.key, folds))
}

/**
 * The fold choices that collapse every file of the node.
 * @param sections - every file section of the node.
 * @returns one fold choice per file.
 */
export function allFileFolds(sections: readonly { key: string }[]): Record<string, boolean> {
  const folds: Record<string, boolean> = {}
  for (const section of sections) folds[section.key] = true
  return folds
}

/**
 * The fold choices that expand every file the folding budget allows. Files in
 * the budget stay folded and keep their localized reason.
 * @param sections - every file section of the node.
 * @param budget - from {@link budgetFolds}.
 * @returns one fold choice per file.
 */
export function expandedFileFolds(
  sections: readonly { key: string }[],
  budget: ReadonlyMap<string, FoldReason>,
): Record<string, boolean> {
  const folds: Record<string, boolean> = {}
  for (const section of sections) folds[section.key] = budget.has(section.key)
  return folds
}

/**
 * The comparison a commit row states in its toolbar.
 * @param commit - the commit node or detail.
 * @param capabilities - the backend's capability object.
 * @returns the comparison.
 */
export function comparisonBase(
  commit: { parents?: readonly string[] } | null,
  capabilities: { changeId?: boolean } | null,
): ComparisonBase {
  const parents = commit?.parents ?? []
  if (parents.length === 0) return { kind: 'root' }
  // Jujutsu compares a merge against its parents' automatic merge, not
  // against the first parent alone; a backend with change ids works that way.
  if (capabilities?.changeId === true) return { kind: 'autoMerge', parent: parents[0] }
  if (parents.length > 1) return { kind: 'merge', parent: parents[0] }
  return { kind: 'parent', parent: parents[0] }
}

/**
 * Placeholder height for a file whose comparison has not loaded, so the
 * tree's scroll height is close to its final height from the start.
 * @param entry - the file.
 * @returns the estimated body height in CSS pixels.
 */
export function estimateHeight(entry: FileEntry): number {
  if (entry?.binary === true) return 56
  const lines = changedLines(entry)
  if (lines === 0) return 120
  // Changed lines plus roughly one hunk header and six context lines per 20 lines.
  const rows = Math.min(MAX_LINES, lines + Math.ceil(lines / 20) * 7)
  return rows * LINE_HEIGHT + 24
}

/**
 * The row a scroll offset is reading: the last one whose top is at or above
 * the offset.
 * @param tops - row top offsets in row order (ascending).
 * @param offset - the scroll offset.
 * @returns the row index, or -1 without rows.
 */
export function rowAt(tops: readonly number[], offset: number): number {
  if (tops.length === 0) return -1
  let low = 0
  let high = tops.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (tops[middle] <= offset) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * What one commit's toolbar says about the work behind it.
 * @param files - the commit's changed files.
 * @returns the summary.
 */
export function commitSummary(files: readonly FileEntry[] | null | undefined): {
  count: number
  added: number
  deleted: number
} {
  return summarizeEntries(files ?? [])
}
