/**
 * Visible rows of the change tree.
 *
 * A selected node normalizes into file groups: a Git working tree has two
 * groups (staged and unstaged, with untracked files merged into unstaged) and a
 * commit has one. A working-tree group draws a group row above its tree; a
 * commit draws its files directly. Every row is addressed by one key, so the
 * renderer, the keyboard and the reading anchor walk the same list.
 */

/** Keys of rows the current layouts can persist. */
const ROW_KEY = /^(?:staged|unstaged|merged|merged-dir|commit)\|/u

/**
 * The key of one tree row: a group key, a directory path without a trailing
 * slash, or a file path.
 * @param {string} group - the row's group id.
 * @param {string} path - the path inside that group.
 * @returns {string} the row key.
 */
export function dirKey(group, path) {
  return `${group}|${path.replace(/\/+$/, '')}`
}

/**
 * The key of one file row, which is also its comparison's section key.
 * @param {string} group - the row's group id.
 * @param {string} path - the file path.
 * @returns {string} the file row key.
 */
export function sectionKey(group, path) {
  return `${group}|${path}`
}

/**
 * Whether a persisted key still addresses a row of this model. Older sessions
 * keyed untracked files by an `untracked|` group, which no longer exists.
 * @param {unknown} key - candidate key.
 * @returns {boolean} true for a current row key.
 */
export function isRowKey(key) {
  return typeof key === 'string' && ROW_KEY.test(key)
}

/**
 * The DOM id of the content one row expands and collapses. `aria-controls`
 * points at it, so it must be unique per row and free of spaces.
 * @param {string} key - the row key.
 * @returns {string} the element id.
 */
export function rowBodyId(key) {
  return `vcs-body-${encodeURIComponent(key)}`
}

/**
 * File count and line counts one group row states. The file count includes
 * untracked files and directories; the line counts only add entries the Host
 * measured.
 * @param {object[]} entries - the group's file entries.
 * @returns {{ count: number, added: number, deleted: number }} the summary.
 */
export function summarizeEntries(entries) {
  let added = 0
  let deleted = 0
  for (const entry of entries) {
    if (typeof entry?.added === 'number') added += entry.added
    if (typeof entry?.deleted === 'number') deleted += entry.deleted
  }
  return { count: entries.length, added, deleted }
}

/** Stable, locale-independent name order: directories before files. */
function compareNodes(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Create a directory node. */
function makeDir(name, path, loadable) {
  return { type: 'dir', name, path, loadable, children: new Map() }
}

/** Find or create a directory child. */
function childDir(node, name, path, loadable = false) {
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
 * @param {object} node - parent directory node.
 * @param {string[]} segments - remaining path segments.
 * @param {object} entry - file or directory entry.
 * @param {string} path - full path accumulated so far.
 */
function insertAt(node, segments, entry, path) {
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
    childDir(node, name, full, true)
    return
  }
  node.children.set(name, { type: 'file', name, path: entry.path, entry })
}

/** Split one entry path into segments, ignoring a trailing slash. */
function segmentsOf(path) {
  return path.replace(/\/+$/, '').split('/').filter(segment => segment !== '')
}

/**
 * Build the tree for one group.
 * @param {string} group - the group id.
 * @param {object[]} entries - status entries for this group.
 * @param {object} state - expansion state.
 * @param {Record<string, object[]>} state.dirChildren - loaded untracked children by row key.
 * @returns {object} the root directory node.
 */
function buildTree(group, entries, state) {
  const root = makeDir('', '', false)
  for (const entry of entries) {
    const segments = segmentsOf(entry.path)
    if (segments.length === 0) continue
    insertAt(root, segments, entry, '')
  }
  const directoryGroup = group === 'merged' ? 'unstaged' : group
  for (const [key, children] of Object.entries(state.dirChildren ?? {})) {
    if (!key.startsWith(`${directoryGroup}|`)) continue
    const path = key.slice(directoryGroup.length + 1)
    const segments = segmentsOf(path)
    let node = root
    for (const segment of segments) {
      const next = node.children.get(`${segment}/`)
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
 * The visible row of one directory, compressing a chain of single-child
 * directories into one row. A directory whose children are not loaded (Git
 * reported it whole) never compresses: its contents are unknown.
 * @param {object} child - the directory node.
 * @returns {{ node: object, name: string }} the row's node and display name.
 */
function chainOf(child) {
  let node = child
  const names = [child.name]
  while (!node.loadable && node.children.size === 1) {
    const only = node.children.values().next().value
    if (only.type !== 'dir' || only.loadable) break
    names.push(only.name)
    node = only
  }
  return { node, name: names.join('/') }
}

/**
 * Flatten a directory node into visible rows.
 * @param {object} node - directory node to walk.
 * @param {number} depth - indentation depth of the node's children.
 * @param {string} group - the group id.
 * @param {object} state - expansion state.
 * @param {object[]} rows - destination list.
 */
function flatten(node, depth, group, state, rows) {
  const children = [...node.children.values()].sort(compareNodes)
  for (const child of children) {
    if (child.type === 'file') {
      rows.push({
        kind: 'file',
        group,
        key: sectionKey(group, child.entry.path),
        depth,
        name: child.name,
        path: child.entry.path,
        entry: child.entry,
      })
      continue
    }
    const { node: last, name } = chainOf(child)
    const directoryGroup = group === 'merged' ? (last.loadable ? 'unstaged' : 'merged-dir') : group
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
function groupRow(group, entries, state) {
  const key = dirKey(group, '')
  return {
    kind: 'group',
    group,
    key,
    depth: 0,
    expanded: state.collapsed?.[key] !== true,
    ...summarizeEntries(entries),
  }
}

/**
 * Flat, visible rows for one group.
 * @param {string} group - the group id.
 * @param {object[]} entries - the group's file entries.
 * @param {object} [state] - expansion and loading data.
 * @param {{ header?: boolean }} [options] - whether the group draws a group row.
 * @returns {object[]} rows in display order.
 */
export function buildRows(group, entries, state = {}, { header = false } = {}) {
  const rows = []
  const headerRow = header ? groupRow(group, entries, state) : null
  if (headerRow !== null) rows.push(headerRow)
  if (headerRow === null || headerRow.expanded) flatten(buildTree(group, entries, state), 0, group, state, rows)
  return rows
}

/**
 * Flat, visible rows of one node across all its groups.
 * @param {Array<{ id: string, entries: object[], header?: boolean }>} groups - the node's groups.
 * @param {object} [state] - expansion and loading data.
 * @returns {object[]} rows in display order.
 */
export function buildNodeRows(groups, state = {}) {
  const rows = []
  for (const group of groups) {
    rows.push(...buildRows(group.id, group.entries, state, { header: group.header === true }))
  }
  return rows
}
