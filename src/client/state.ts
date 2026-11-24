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

/** The node token of one checkout, from its path. */
export function worktreeNode(path: string): string {
  return `${WORKTREE_PREFIX}${path}`
}

/** The checkout path one node token names, or null when it names another node. */
export function worktreePath(node: unknown): string | null {
  return typeof node === 'string' && node.startsWith(WORKTREE_PREFIX) && node.length > WORKTREE_PREFIX.length
    ? node.slice(WORKTREE_PREFIX.length)
    : null
}

/** The legacy single-workspace selection and the backend's working-copy token. */
export const WORKING_COPY = '@'

/** Ref modes a persisted range may name; the active backend narrows this list. */
export const REFS: readonly string[] = ['HEAD', '@', 'all']

/** Sidebar width bounds, in CSS pixels. */
export const SIDEBAR_MIN = 280
export const SIDEBAR_MAX = 480

/** Overview column width bounds and default, in CSS pixels. */
export const OVERVIEW_MIN = 320
export const OVERVIEW_MAX = 600
export const OVERVIEW_WIDTH = 400

/** How the tiled columns are ordered. */
export type TileOrder = 'directory' | 'attention'

/** Directory keys of the commit file group, which belong to one commit only. */
const COMMIT_DIR_PREFIX = 'commit|'

/** A persisted reading position in the change tree. */
export interface ReadingAnchor {
  /** The row key the position sits on. */
  key: string
  /** The offset below that row's top. */
  offset: number
}

export type RepositoryScope = 'all' | 'selected'

/** What the panel remembers per Session. */
export interface PanelState {
  /** The selected repository root, or null before one is chosen. */
  repo: string | null
  /** Which repositories get timeline groups, and the paths checked for selected mode. */
  repositoryScope: RepositoryScope
  checkedRepositories: string[]
  /** Null opens the initial repository, while an empty list keeps every group closed. */
  expandedRepositories: string[] | null
  /** The selected checkout paths, in display order. */
  worktrees: string[]
  /** The selected timeline node, or null before the status answers. */
  node: string | null
  /** Whether the user picked the node rather than the status defaulting it. */
  nodeChosen: boolean
  /** The history range the timeline asks for. */
  ref: string
  /** Expanded directory keys. */
  dirs: Record<string, boolean>
  /** Collapsed change-tree keys. */
  collapsed: Record<string, boolean>
  /** Folded change-tree keys. */
  folds: Record<string, boolean>
  /** The reading position in the change tree. */
  anchor: ReadingAnchor | null
  /** Whether the diff renders split rather than unified. */
  split: boolean
  /** Whether diff lines wrap. */
  wrap: boolean
  /** Whether staged and unstaged rows merge into one tree. */
  mergeStaging: boolean
  /** Whether the timeline sits beside the changes. */
  twoColumns: boolean
  /** The timeline width, in CSS pixels. */
  sidebarWidth: number
  /** The timeline's vertical scroll offset. */
  timelineScroll: number
  /** Whether the overview column is pushed in from the left. */
  overview: boolean
  /** The overview column width, in CSS pixels. */
  overviewWidth: number
  /** Whether the repository groups are tiled as columns. */
  tiled: boolean
  /** Whether the overview was open when tiling started, so leaving restores it. */
  overviewBeforeTile: boolean
  /** The tiled column order. */
  tileOrder: TileOrder
  /** Quiet repositories whose spine the user opened into a column. */
  tileExpanded: string[]
}

/** The status fields that pick the node a panel shows. */
export interface PreferredNodeStatus {
  /** Changed-file count. */
  total?: number
  /** The backend's own default node. */
  defaultNode?: string
  /** Branch facts, when the backend reports a branch. */
  branch?: {
    oid?: string | null
  } | null
}

/**
 * The state a fresh Session starts with.
 * @returns a new default state object.
 */
export function defaultState(): PanelState {
  return {
    repo: null,
    repositoryScope: 'selected',
    checkedRepositories: [],
    expandedRepositories: null,
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
    overview: false,
    overviewWidth: OVERVIEW_WIDTH,
    tiled: false,
    overviewBeforeTile: false,
    tileOrder: 'directory',
    tileExpanded: [],
  }
}

/** Clamp a finite number into a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Whether a value is a plain object to read persisted fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** A non-empty string, or null. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Copy only boolean-true entries whose key addresses a current row. */
function trueKeys(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, on] of Object.entries(value)) {
    if (on === true && isRowKey(key)) result[key] = true
  }
  return result
}

/** Copy only boolean entries whose key addresses a current row. */
function booleanKeys(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, on] of Object.entries(value)) {
    if (typeof on === 'boolean' && isRowKey(key)) result[key] = on
  }
  return result
}

/**
 * Whether a value names a timeline node: the working tree or a commit id.
 * @param value - candidate node.
 * @returns true for {@link WORKTREE} or a hexadecimal commit id.
 */
export function isNode(value: unknown): value is string {
  return value === WORKTREE
    || value === WORKING_COPY
    || worktreePath(value) !== null
    || (typeof value === 'string' && /^[0-9a-f]{7,64}$/iu.test(value))
}

/**
 * Normalize a reading position in the change tree: any row key plus the offset
 * below that row's top.
 * @param value - persisted value.
 * @returns the anchor or null.
 */
function anchorOrNull(value: unknown): ReadingAnchor | null {
  if (!isRecord(value)) return null
  const stored = value
  if (!isRowKey(stored.key) || typeof stored.key !== 'string') return null
  if (typeof stored.offset !== 'number' || !Number.isFinite(stored.offset) || stored.offset < 0) return null
  return { key: stored.key, offset: stored.offset }
}

/**
 * Rebuild a persisted state, dropping anything this version does not accept.
 * @param raw - parsed storage value.
 * @returns a complete state.
 */
export function sanitizeState(raw: unknown): PanelState {
  const state = defaultState()
  if (!isRecord(raw) || Array.isArray(raw)) return state
  const stored = raw
  state.repo = textOrNull(stored.repo)
  if (stored.repositoryScope === 'all' || stored.repositoryScope === 'selected') {
    state.repositoryScope = stored.repositoryScope
  }
  for (const field of ['checkedRepositories', 'expandedRepositories', 'worktrees', 'tileExpanded'] as const) {
    const paths = stored[field]
    if (Array.isArray(paths)) {
      state[field] = [...new Set(paths.filter((path): path is string => textOrNull(path) !== null))]
    }
  }
  state.node = isNode(stored.node) ? stored.node : null
  state.nodeChosen = state.node !== null && stored.nodeChosen === true
  if (typeof stored.ref === 'string' && REFS.includes(stored.ref)) state.ref = stored.ref
  state.dirs = trueKeys(stored.dirs)
  state.collapsed = trueKeys(stored.collapsed)
  state.folds = booleanKeys(stored.folds)
  state.anchor = anchorOrNull(stored.anchor)
  state.split = stored.split === true
  // Line wrap, merged staging, and two columns are the defaults; only an explicit `false` turns them off.
  state.wrap = stored.wrap !== false
  state.mergeStaging = stored.mergeStaging !== false
  state.twoColumns = stored.twoColumns !== false
  if (typeof stored.sidebarWidth === 'number' && Number.isFinite(stored.sidebarWidth)) {
    state.sidebarWidth = clamp(Math.round(stored.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX)
  }
  if (typeof stored.timelineScroll === 'number' && Number.isFinite(stored.timelineScroll) && stored.timelineScroll >= 0) {
    state.timelineScroll = stored.timelineScroll
  }
  state.overview = stored.overview === true
  if (typeof stored.overviewWidth === 'number' && Number.isFinite(stored.overviewWidth)) {
    state.overviewWidth = clamp(Math.round(stored.overviewWidth), OVERVIEW_MIN, OVERVIEW_MAX)
  }
  state.tiled = stored.tiled === true
  state.overviewBeforeTile = stored.overviewBeforeTile === true
  if (stored.tileOrder === 'attention') state.tileOrder = 'attention'
  return state
}

/**
 * Pick the node a panel shows when the user has not chosen one.
 *
 * An explicit choice always wins. Otherwise the working tree decides: its own
 * node when it has changes (that is what is being worked on), the HEAD commit
 * when it is clean, and the working tree again when there is no commit yet.
 *
 * @param state - panel state.
 * @param status - the working-tree answer.
 * @returns the node to show, or null before the status answers.
 */
export function preferredNode(
  state: Pick<PanelState, 'node' | 'nodeChosen'>,
  status: PreferredNodeStatus | null | undefined,
): string | null {
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
 * @param state - current panel state.
 * @param node - the node to select.
 * @param chosen - whether the user picked it.
 * @returns the patch to merge into the state.
 */
export function nodePatch(state: PanelState, node: string, chosen: boolean): Partial<PanelState> {
  if (state.node === node) return chosen === state.nodeChosen ? {} : { nodeChosen: chosen }
  if ((worktreePath(state.node) ?? state.repo) !== (worktreePath(node) ?? state.repo)) {
    return { node, nodeChosen: chosen, anchor: null, folds: {}, collapsed: {}, dirs: {} }
  }
  const collapsed: Record<string, boolean> = {}
  for (const key of Object.keys(state.collapsed ?? {})) {
    if (!key.startsWith(COMMIT_DIR_PREFIX)) collapsed[key] = true
  }
  return { node, nodeChosen: chosen, anchor: null, folds: {}, collapsed }
}

/** The storage key for one Session. */
export function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`
}

/**
 * Read one Session's panel state.
 * @param sessionId - the Session whose panel is opening.
 * @param storage - sessionStorage-compatible store.
 * @returns the restored or default state.
 */
export function loadState(sessionId: string, storage: Storage | undefined = globalThis.sessionStorage): PanelState {
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
 * @param sessionId - the Session the state belongs to.
 * @param state - the complete state to write.
 * @param storage - sessionStorage-compatible store.
 * @returns nothing.
 */
export function saveState(sessionId: string, state: PanelState, storage: Storage | undefined = globalThis.sessionStorage): void {
  try {
    storage?.setItem(storageKey(sessionId), JSON.stringify(state))
  } catch {
    // A full or unavailable sessionStorage costs only restoration, never the panel.
  }
}
