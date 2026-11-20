/**
 * Session-scoped panel state.
 *
 * The Host owns Git; this module owns only what the panel remembers per
 * Session: repository, the selected timeline node, history range, expansion
 * and fold choices, layout choices, and the reading position. `sessionStorage`
 * is the boundary — losing it drops the panel back to defaults, never to an
 * error. Row keys left over from the old file-list model are dropped on read.
 */

import { isRowKey } from './detail/tree.js'

/** Prefix that keeps this plugin's keys apart from any other tab state. */
const KEY_PREFIX = 'vcs:'

/** The backend's virtual worktree token; the panel selects checkouts by path. */
export const WORKTREE = 'worktree'

const WORKTREE_PREFIX = 'worktree:'

export function worktreeNode(path) {
  return `${WORKTREE_PREFIX}${path}`
}

export function worktreePath(node) {
  return typeof node === 'string' && node.startsWith(WORKTREE_PREFIX) && node.length > WORKTREE_PREFIX.length
    ? node.slice(WORKTREE_PREFIX.length)
    : null
}

/** The legacy single-workspace selection and the backend's working-copy token. */
export const WORKING_COPY = '@'

/** Ref modes a persisted range may name; the active backend narrows this list. */
export const REFS = ['HEAD', '@', 'all']

/** Sidebar width bounds, in CSS pixels. */
export const SIDEBAR_MIN = 280
export const SIDEBAR_MAX = 480

/** Directory keys of the commit file group, which belong to one commit only. */
const COMMIT_DIR_PREFIX = 'commit|'

/**
 * The state a fresh Session starts with.
 * @returns {object} a new default state object.
 */
export function defaultState() {
  return {
    repo: null,
    worktrees: [],
    node: null,
    nodeChosen: false,
    ref: 'all',
    dirs: {},
    collapsed: {},
    folds: {},
    anchor: null,
    split: false,
    wrap: true,
    mergeStaging: true,
    twoColumns: true,
    sidebarWidth: 320,
    timelineScroll: 0,
  }
}

/** Clamp a finite number into a range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** A non-empty string, or null. */
function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Copy only boolean-true entries whose key addresses a current row. */
function trueKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, on] of Object.entries(value)) {
    if (on === true && isRowKey(key)) result[key] = true
  }
  return result
}

/** Copy only boolean entries whose key addresses a current row. */
function booleanKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, on] of Object.entries(value)) {
    if (typeof on === 'boolean' && isRowKey(key)) result[key] = on
  }
  return result
}

/**
 * Whether a value names a timeline node: the working tree or a commit id.
 * @param {unknown} value - candidate node.
 * @returns {boolean} true for {@link WORKTREE} or a hexadecimal commit id.
 */
export function isNode(value) {
  return value === WORKTREE
    || value === WORKING_COPY
    || worktreePath(value) !== null
    || (typeof value === 'string' && /^[0-9a-f]{7,64}$/iu.test(value))
}

/**
 * Normalize a reading position in the change tree: any row key plus the offset
 * below that row's top.
 * @param {unknown} value - persisted value.
 * @returns {{ key: string, offset: number } | null} the anchor or null.
 */
function anchorOrNull(value) {
  if (value === null || typeof value !== 'object') return null
  if (!isRowKey(value.key)) return null
  if (typeof value.offset !== 'number' || !Number.isFinite(value.offset) || value.offset < 0) return null
  return { key: value.key, offset: value.offset }
}

/**
 * Rebuild a persisted state, dropping anything this version does not accept.
 * @param {unknown} raw - parsed storage value.
 * @returns {object} a complete state.
 */
export function sanitizeState(raw) {
  const state = defaultState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state
  state.repo = textOrNull(raw.repo)
  if (Array.isArray(raw.worktrees)) {
    state.worktrees = [...new Set(raw.worktrees.filter(path => textOrNull(path) !== null))]
  }
  state.node = isNode(raw.node) ? raw.node : null
  state.nodeChosen = state.node !== null && raw.nodeChosen === true
  if (REFS.includes(raw.ref)) state.ref = raw.ref
  state.dirs = trueKeys(raw.dirs)
  state.collapsed = trueKeys(raw.collapsed)
  state.folds = booleanKeys(raw.folds)
  state.anchor = anchorOrNull(raw.anchor)
  state.split = raw.split === true
  // Line wrap, merged staging, and two columns are the defaults; only an explicit `false` turns them off.
  state.wrap = raw.wrap !== false
  state.mergeStaging = raw.mergeStaging !== false
  state.twoColumns = raw.twoColumns !== false
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    state.sidebarWidth = clamp(Math.round(raw.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX)
  }
  if (typeof raw.timelineScroll === 'number' && Number.isFinite(raw.timelineScroll) && raw.timelineScroll >= 0) {
    state.timelineScroll = raw.timelineScroll
  }
  return state
}

/**
 * Pick the node a panel shows when the user has not chosen one.
 *
 * An explicit choice always wins. Otherwise the working tree decides: its own
 * node when it has changes (that is what is being worked on), the HEAD commit
 * when it is clean, and the working tree again when there is no commit yet.
 *
 * @param {{ node: string | null, nodeChosen: boolean }} state - panel state.
 * @param {{ total?: number, branch?: { oid?: string | null } } | null} status - the working-tree answer.
 * @returns {string | null} the node to show, or null before the status answers.
 */
export function preferredNode(state, status) {
  if (state.nodeChosen && state.node !== null) return state.node
  if (status === null || status === undefined) return state.node
  // A backend names its own default (the working tree, or `@`). The Git-shaped
  // fallback below stays for older status payloads and for tests of that rule.
  if (typeof status.defaultNode === 'string' && status.defaultNode !== '') return status.defaultNode
  if ((status.total ?? 0) > 0) return WORKTREE
  return textOrNull(status.branch?.oid) ?? WORKTREE
}

/**
 * The state patch that moves the selection to another node.
 *
 * Reading position and fold choices describe one node's diff stream, and
 * commit-group folders belong to one commit, so they reset with the node.
 * Working-tree folders persist across nodes.
 *
 * @param {object} state - current panel state.
 * @param {string} node - the node to select.
 * @param {boolean} chosen - whether the user picked it.
 * @returns {object} the patch to merge into the state.
 */
export function nodePatch(state, node, chosen) {
  if (state.node === node) return chosen === state.nodeChosen ? {} : { nodeChosen: chosen }
  if ((worktreePath(state.node) ?? state.repo) !== (worktreePath(node) ?? state.repo)) {
    return { node, nodeChosen: chosen, anchor: null, folds: {}, collapsed: {}, dirs: {} }
  }
  const collapsed = {}
  for (const key of Object.keys(state.collapsed ?? {})) {
    if (!key.startsWith(COMMIT_DIR_PREFIX)) collapsed[key] = true
  }
  return { node, nodeChosen: chosen, anchor: null, folds: {}, collapsed }
}

/** The storage key for one Session. */
export function storageKey(sessionId) {
  return `${KEY_PREFIX}${sessionId}`
}

/**
 * Read one Session's panel state.
 * @param {string} sessionId - the Session whose panel is opening.
 * @param {Storage} [storage] - sessionStorage-compatible store.
 * @returns {object} the restored or default state.
 */
export function loadState(sessionId, storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem(storageKey(sessionId))
    if (raw === null || raw === undefined) return defaultState()
    return sanitizeState(JSON.parse(raw))
  } catch {
    return defaultState()
  }
}

/**
 * Persist one Session's panel state.
 * @param {string} sessionId - the Session the state belongs to.
 * @param {object} state - the complete state to write.
 * @param {Storage} [storage] - sessionStorage-compatible store.
 * @returns {void}
 */
export function saveState(sessionId, state, storage = globalThis.sessionStorage) {
  try {
    storage?.setItem(storageKey(sessionId), JSON.stringify(state))
  } catch {
    // A full or unavailable sessionStorage costs only restoration, never the panel.
  }
}
