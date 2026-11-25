/**
 * Visible rows of the change tree.
 *
 * A selected node normalizes into file groups: a Git working tree has two
 * groups (staged and unstaged, with untracked files merged into unstaged) and a
 * commit has one. A working-tree group draws a group row above its tree; a
 * commit draws its files directly. Every row is addressed by one key, so the
 * renderer, the keyboard and the reading anchor walk the same list.
 */

/**
 * One file entry as the tree sees it: the Host's status or commit entry, plus
 * the staged/unstaged originals and the tree-only flags a synthesized untracked
 * entry needs. Optional fields keep the permissive side of the shape; every
 * producer supplies at least `path` and `status`.
 */
export interface FileEntry {
  path: string
  status: string
  origPath?: string
  added?: number
  deleted?: number
  binary?: boolean
  untracked?: boolean
  directory?: boolean
  conflict?: boolean
  partiallyStaged?: boolean
  sources?: Record<string, FileEntry>
}

/** One direct child of an untracked directory, as `vcs.untracked` lists it. */
export interface UntrackedChild {
  name: string
  path: string
  type: 'directory' | 'file'
}

/** File count and line counts one group row states. */
export interface EntrySummary {
  count: number
  added: number
  deleted: number
  untracked: number
}

/** Expansion and loading data shared by the row builders. */
export interface TreeState {
  dirs?: Record<string, boolean>
  collapsed?: Record<string, boolean>
  dirChildren?: Record<string, readonly UntrackedChild[]>
  loadingDirs?: Record<string, boolean>
}

/** One file row, which is also the header of its comparison. */
export interface FileRow {
  kind: 'file'
  group: string
  key: string
  depth: number
  name: string
  path: string
  entry: FileEntry
}

/** One directory row, with the entries it stands for when staged whole. */
export interface DirRow {
  kind: 'dir'
  group: string
  key: string
  depth: number
  name: string
  path: string
  loadable: boolean
  expanded: boolean
  entries: readonly FileEntry[]
}

/** The placeholder row of a directory whose children are loading. */
export interface LoadingRow {
  kind: 'loading'
  group: string
  key: string
  depth: number
}

/** The row above one working-tree group's tree. */
export interface GroupRow extends EntrySummary {
  kind: 'group'
  group: string
  key: string
  depth: number
  expanded: boolean
  entries: readonly FileEntry[]
  untrackedAdded?: number | null
}

/** One visible row of the change tree. */
export type TreeRow = FileRow | DirRow | LoadingRow | GroupRow

/** One visible row the cursor and the keyboard walk; loading rows are not stops. */
export type NavRow = FileRow | DirRow | GroupRow

/** One node's file group, as the row builders consume it. */
export interface RowGroup {
  id: string
  entries: readonly FileEntry[]
  header?: boolean
  untrackedTotal?: number
  untrackedAdded?: number | null
}

/** One directory node of the built tree. */
interface DirNode {
  type: 'dir'
  name: string
  path: string
  loadable: boolean
  children: Map<string, TreeNode>
  entry?: FileEntry
}

/** One file node of the built tree. */
interface FileNode {
  type: 'file'
  name: string
  path: string
  entry: FileEntry
}

type TreeNode = DirNode | FileNode

/** Keys of rows the current layouts can persist. */
const ROW_KEY = /^(?:staged|unstaged|merged|merged-dir|commit|stash|stash-dir|stash-untracked)\|/u

/**
 * The key of one tree row: a group key, a directory path without a trailing
 * slash, or a file path.
 * @param group - the row's group id.
 * @param path - the path inside that group.
 * @returns the row key.
 */
export function dirKey(group: string, path: string): string {
  return `${group}|${path.replace(/\/+$/, '')}`
}

/**
 * The key of one file row, which is also its comparison's section key.
 * @param group - the row's group id.
 * @param path - the file path.
 * @returns the file row key.
 */
export function sectionKey(group: string, path: string): string {
  return `${group}|${path}`
}

/**
 * Whether a persisted key still addresses a row of this model. Older sessions
 * keyed untracked files by an `untracked|` group, which no longer exists.
 * @param key - candidate key.
 * @returns true for a current row key.
 */
export function isRowKey(key: unknown): boolean {
  return typeof key === 'string' && ROW_KEY.test(key)
}

/**
 * The DOM id of the content one row expands and collapses. `aria-controls`
 * points at it, so it must be unique per row and free of spaces.
 * @param key - the row key.
 * @returns the element id.
 */
export function rowBodyId(key: string): string {
  return `vcs-body-${encodeURIComponent(key)}`
}

/**
 * File count and line counts one group row states. The file count includes
 * untracked files and directories; the line counts only add entries the Host
 * measured.
 * @param entries - the group's file entries.
 * @returns the summary.
 */
export function summarizeEntries(entries: readonly FileEntry[]): EntrySummary {
  let added = 0
  let deleted = 0
  let untracked = 0
  for (const entry of entries) {
    if (typeof entry?.added === 'number') added += entry.added
    if (typeof entry?.deleted === 'number') deleted += entry.deleted
    if (entry?.untracked === true) untracked += 1
  }
  return { count: entries.length, added, deleted, untracked }
}

/** Stable, locale-independent name order: directories before files. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Create a directory node. */
function makeDir(name: string, path: string, loadable: boolean): DirNode {
  return { type: 'dir', name, path, loadable, children: new Map() }
}

/** Find or create a directory child. */
function childDir(node: DirNode, name: string, path: string, loadable = false): DirNode {
  const key = `${name}/`
  const existing = node.children.get(key)
  if (existing !== undefined && existing.type === 'dir') {
    if (loadable) existing.loadable = true
    return existing
  }
  const created = makeDir(name, path, loadable)
  node.children.set(key, created)
  return created
}

/**
 * Insert one entry below a directory node, relative to that node's path.
 * @param node - parent directory node.
 * @param segments - remaining path segments.
 * @param entry - file or directory entry.
 * @param path - full path accumulated so far.
 */
function insertAt(node: DirNode, segments: readonly string[], entry: FileEntry, path: string, stash = false): void {
  let parent = path
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]
    const next = parent === '' ? name : `${parent}/${name}`
    node = childDir(node, name, next)
    parent = next
  }
  const name = segments[segments.length - 1]
  const full = parent === '' ? name : `${parent}/${name}`
  if (entry.directory) {
    childDir(node, name, full, true).entry = entry
    return
  }
  // Staging a deletion and then recreating the file can put the same path
  // in both stash comparisons. Keep both stops in the same tree.
  const key = stash && entry.untracked === true ? `${name}\0` : name
  node.children.set(key, { type: 'file', name, path: entry.path, entry })
}

/** Split one entry path into segments, ignoring a trailing slash. */
function segmentsOf(path: string): string[] {
  return path.replace(/\/+$/, '').split('/').filter(segment => segment !== '')
}

/**
 * Build the tree for one group.
 * @param group - the group id.
 * @param entries - status entries for this group.
 * @param state - expansion state.
 * @returns the root directory node.
 */
function buildTree(group: string, entries: readonly FileEntry[], state: TreeState): DirNode {
  const root = makeDir('', '', false)
  for (const entry of entries) {
    const segments = segmentsOf(entry.path)
    if (segments.length === 0) continue
    insertAt(root, segments, entry, '', group === 'stash')
  }
  const directoryGroup = group === 'merged' ? 'unstaged' : group
  for (const [key, children] of Object.entries(state.dirChildren ?? {})) {
    if (!key.startsWith(`${directoryGroup}|`)) continue
    const path = key.slice(directoryGroup.length + 1)
    const segments = segmentsOf(path)
    let node: DirNode | undefined = root
    for (const segment of segments) {
      const next: TreeNode | undefined = node.children.get(`${segment}/`)
      if (next === undefined || next.type !== 'dir') {
        node = undefined
        break
      }
      node = next
    }
    if (node?.loadable !== true) continue
    for (const child of children) {
      const rel = child.path.startsWith(`${path}/`) ? child.path.slice(path.length + 1) : child.name
      insertAt(node, segmentsOf(rel), {
        path: child.path,
        directory: child.type === 'directory' || child.path.endsWith('/'),
        status: 'U',
        untracked: true,
        added: 0,
        deleted: 0,
      }, path)
    }
  }
  return root
}

/**
 * The entries a directory row stands for when it is staged as a whole: an
 * untracked directory Git reported whole is one entry, and any other directory
 * collects the entries below it.
 * @param node - the directory node.
 * @returns the entries below the node.
 */
function entriesBelow(node: DirNode): FileEntry[] {
  if (node.loadable) {
    const path = node.entry?.path ?? `${node.path}/`
    return [node.entry ?? { path, directory: true, status: 'U', untracked: true }]
  }
  return [...node.children.values()].flatMap(child => (child.type === 'file' ? [child.entry] : entriesBelow(child)))
}

/**
 * The visible row of one directory, compressing a chain of single-child
 * directories into one row. A directory whose children are not loaded (Git
 * reported it whole) never compresses: its contents are unknown.
 * @param child - the directory node.
 * @returns the row's node and display name.
 */
function chainOf(child: DirNode): { node: DirNode; name: string } {
  let node = child
  const names = [child.name]
  while (!node.loadable && node.children.size === 1) {
    const only = node.children.values().next().value
    if (only === undefined || only.type !== 'dir' || only.loadable) break
    names.push(only.name)
    node = only
  }
  return { node, name: names.join('/') }
}

/**
 * Flatten a directory node into visible rows.
 * @param node - directory node to walk.
 * @param depth - indentation depth of the node's children.
 * @param group - the group id.
 * @param state - expansion state.
 * @param rows - destination list.
 */
function flatten(node: DirNode, depth: number, group: string, state: TreeState, rows: TreeRow[]): void {
  const children = [...node.children.values()].sort(compareNodes)
  for (const child of children) {
    if (child.type === 'file') {
      rows.push({
        kind: 'file',
        group,
        key: sectionKey(group === 'stash' && child.entry.untracked === true ? 'stash-untracked' : group, child.entry.path),
        depth,
        name: child.name,
        path: child.entry.path,
        entry: child.entry,
      })
      continue
    }
    const { node: last, name } = chainOf(child)
    const directoryGroup = group === 'stash' ? 'stash-dir' : group === 'merged' ? (last.loadable ? 'unstaged' : 'merged-dir') : group
    const key = dirKey(directoryGroup, last.path)
    const expanded = last.loadable
      ? state.dirs?.[key] === true
      : state.collapsed?.[key] !== true
    rows.push({
      kind: 'dir',
      group,
      key,
      depth,
      name,
      path: `${last.path}/`,
      loadable: last.loadable,
      expanded,
      entries: entriesBelow(last),
    })
    if (!expanded) continue
    if (last.loadable && state.dirChildren?.[key] === undefined) {
      if (state.loadingDirs?.[key] === true) {
        rows.push({ kind: 'loading', group, key, depth: depth + 1 })
      }
      continue
    }
    flatten(last, depth + 1, group, state, rows)
  }
}

/** The group row above one working-tree group's tree. */
function groupRow(
  group: string,
  entries: readonly FileEntry[],
  state: TreeState,
  { untrackedTotal, untrackedAdded }: Pick<RowGroup, 'untrackedTotal' | 'untrackedAdded'>,
): GroupRow {
  const key = dirKey(group, '')
  const summary = summarizeEntries(entries)
  const untracked = untrackedTotal ?? summary.untracked
  return {
    kind: 'group',
    group,
    key,
    depth: 0,
    expanded: state.collapsed?.[key] !== true,
    entries,
    ...summary,
    count: summary.count + (untracked - summary.untracked),
    untracked,
    untrackedAdded,
  }
}

/**
 * Flat, visible rows for one group.
 * @param group - the group id.
 * @param entries - the group's file entries.
 * @param [state] - expansion and loading data.
 * @param [options] - whether the group draws a group row.
 * @returns rows in display order.
 */
export function buildRows(
  group: string,
  entries: readonly FileEntry[],
  state: TreeState = {},
  options: Pick<RowGroup, 'header' | 'untrackedTotal' | 'untrackedAdded'> = {},
): TreeRow[] {
  const rows: TreeRow[] = []
  const headerRow = options.header ? groupRow(group, entries, state, options) : null
  if (headerRow !== null) rows.push(headerRow)
  if (headerRow === null || headerRow.expanded) flatten(buildTree(group, entries, state), 0, group, state, rows)
  return rows
}

/**
 * Flat, visible rows of one node across all its groups.
 * @param groups - the node's groups.
 * @param [state] - expansion and loading data.
 * @returns rows in display order.
 */
export function buildNodeRows(groups: readonly RowGroup[], state: TreeState = {}): TreeRow[] {
  const rows: TreeRow[] = []
  for (const group of groups) {
    rows.push(...buildRows(group.id, group.entries, state, group))
  }
  return rows
}
