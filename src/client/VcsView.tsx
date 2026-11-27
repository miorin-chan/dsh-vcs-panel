/**
 * The version control panel, drawn as a right-Sidebar tab.
 *
 * One Session, a repository or activity timeline, and one detail pane for
 * the selected node. Host data is read
 * through `api.js`; this component owns request lifecycle, selection, paging,
 * layout, and the sessionStorage-backed state. `focusRequest` signals that the
 * Sidebar opened or revealed the pane, so it can prepare keyboard navigation.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { ApiError, createApi, failureOf } from './api.js'
import type {
  Api, ApiFailure, BranchesAnswer, CommitNode, LogAnswer, RepositoryInfo, StatusData, WorktreeInfo,
} from './api.js'
import type { ActivityEntry } from '../lib/activity.js'
import type { StashEntry } from '../lib/stash-types.js'
import { stashNode, stashSha } from './stash.js'
import type { StashTarget } from './stash.js'
import {
  expandActivity, loadState, nodePatch, resolveOverviewDefault, resolveTimelineScope, saveState,
  SIDEBAR_MAX, SIDEBAR_MIN, WORKING_COPY, WORKTREE, worktreeNode, worktreePath,
} from './state.js'
import type { PanelState, ReadingAnchor } from './state.js'
import type { DirRow, GroupRow, UntrackedChild } from './detail/tree.js'
import type { RevisionState, DetailPaneControl, DetailStatusState } from './detail/DetailPane.jsx'
import type { DiffFetchResult } from './detail/ChangeTree.jsx'
import type { CommitActionsHandler, RefActionsHandler, StashActionsHandler } from './history/Timeline.jsx'
import type { TimelineControl } from './history/useTimelineNavigation.js'
import type { MenuPoint, Notice } from './useRepoActions.js'
import type { WorktreeChoice } from './worktrees.js'
import {
  attachWorkingCopies, checkedWorktrees, preferredViewNode, repositoryWorktrees, sharedRefs,
  toggleWorktree, workingCopyLabel, worktreeRefLabel,
} from './worktrees.js'
import {
  errorMessage, formatPlural,
} from './format.js'
import {
  BACK, canClaimFocusFrom, findAncestor, hasClass, isDiscreteActionButton, isEditableTarget,
  isNavigationStop, isOverlayOrMenuTarget, isOverlayTarget, movement, rowStep, zoneOf,
} from './keys.js'
import { dirKey } from './detail/tree.js'
import { buildGraph } from './history/layout.js'
import { indexCommits } from './history/commits.js'
import { graphInput, indexTimelineRows, nodeAt, pickRepository, rowOf, timelineRows } from './history/timeline-model.js'
import type { WorktreeHead } from './history/timeline-model.js'
import { ROW_HEIGHT, Timeline } from './history/Timeline.jsx'
import { ActivityTimeline, activityRepositories } from './history/ActivityTimeline.jsx'
import { ActivityDetail } from './history/ActivityDetail.jsx'
import type { ActivityReading } from './history/ActivityDetail.jsx'
import { activityCommitKey, activityNode, activitySelection, buildActivity, entryKey } from './history/activity-model.js'
import type { ActivityStop } from './history/activity-model.js'
import { useActivity } from './history/useActivity.js'
import { DetailPane, detailCacheKey } from './detail/DetailPane.jsx'
import { TopBar } from './TopBar.jsx'
import { RefActionsMenu } from './RefActionsMenu.jsx'
import { BranchDialog } from './BranchDialogs.jsx'
import { TagDialog } from './TagDialog.jsx'
import { CommitDialog } from './CommitDialog.jsx'
import { StashDialog } from './StashDialog.jsx'
import { WorktreeDialog } from './WorktreeDialog.jsx'
import { RepositoryConfigDialog } from './RepositoryConfigDialog.jsx'
import { useRepoActions } from './useRepoActions.js'
import { useVcsWatch } from './useVcsWatch.js'
import { TimelineSkeleton, TreeSkeleton } from './skeleton.jsx'
import { onPanelCommand } from './commands.js'
import type { FilterId, PointerView } from './overview/model.js'
import {
  FILTERS,
  buildSkeleton, columnOrder, filterCounts, pointerTarget, repositoryView, selectedPointerId, stashPointerTarget, stepIndex, tileOrder, traversal,
} from './overview/model.js'
import { tileDirectActions } from './overview/directActions.js'
import type { TileDirectAction } from './overview/directActions.js'
import { useOverview } from './overview/useOverview.js'
import { historyOf, useTileHistories } from './overview/useTileHistories.js'
import { OverviewPane } from './overview/OverviewPane.jsx'
import type { OverviewControl } from './overview/OverviewPane.jsx'
import { TiledView } from './overview/TiledView.jsx'
import type { TileColumn, TiledControl } from './overview/TiledView.jsx'
import { StateButtons } from './overview/StateButtons.jsx'
import { clearMotionGhosts, copyTiles, enterTiles, fadeOutInPlace, leaveTiles, reducedMotion, slideIn } from './overview/motion.js'
import type { LeavingTile } from './overview/motion.js'

/** Rows per history page. */
const PAGE_SIZE = 300
/** Limit concurrent reads for backends that don't snapshot into a shared store. */
const STATUS_CONCURRENCY = 4
/** Below this width the panel shows one column at a time, whatever the preference. */
const NARROW_WIDTH = 760
/** Width of the divider between the timeline and the detail. */
const RESIZER_WIDTH = 5
/** Below this width beside the overview, the overview covers the panel as a drawer instead. */
const OVERVIEW_DRAWER_REST = 360
/** The width the tiled layout asks the Sidebar for before requesting fullscreen. */
const TILE_ROOM = 900
/** How long the overview takes to slide; matches `.vcs-overview` in `styles.css`. */
const OVERVIEW_SLIDE_MS = 280

/** Row-key prefix of the unstaged group, where untracked directories load. */
const UNSTAGED_PREFIX = 'unstaged|'

/** One checkout's status read and the revision it belongs to. */
interface StatusEntry {
  status: string
  data: StatusData | null
  error: ApiFailure | null
  backgroundRevision?: number
}

/** The status reads of the selected checkouts, by on-demand node path. */
type StatusMap = Record<string, StatusEntry>

/** One local branch as the header menu lists it. */
type BranchRow = BranchesAnswer['branches'][number]

/** One checkout's head as a history page reported it. */
type WorktreeHeadRow = NonNullable<LogAnswer['worktreeHeads']>[number]

/** The loaded history and the pagination state around it. */
interface HistoryLog {
  status: string
  commits: CommitNode[]
  stashes: StashEntry[]
  stashesTruncated: boolean
  worktreeHeads: WorktreeHeadRow[] | null
  error: ApiFailure | null
  truncated: boolean
  hasMore: boolean
  loadingMore: boolean
}

/** The discovered repositories and the discovery state around them. */
interface RepositoryListingState {
  status: string
  list: RepositoryInfo[]
  truncated: boolean
  worktreesTruncated: boolean
  error: ApiFailure | null
  cwd?: string | null
  configError?: string | null
}

/** The local-branch menu's listing state. */
interface BranchListingState {
  status: string
  list: BranchRow[]
  truncated: boolean
  error: ApiFailure | null
}

/** The manual refresh revision of each watch domain. */
interface Revisions {
  working: number
  history: number
  repositories: number
  activity: number
}

/** The selection and detail reading position remembered during a repository switch. */
type PerRepoSelection = Pick<PanelState, 'node' | 'nodeChosen' | 'worktrees' | 'dirs' | 'collapsed' | 'ref' | 'anchor' | 'folds'> & {
  historyLength: number
}

/** The open repository-management dialog and the focus it restores. */
interface RepositoryManagement {
  sessionId: string
  restoreFocus: () => void
}

/** One checkout row as the panel renders it: the catalog row plus its reading. */
interface ViewWorktree extends WorktreeInfo {
  id: string
  label: string
  refLabel: string | null
  status: StatusData | null
  statusState: string
}

/** One commit row with the checkout rows the timeline shows. */
type ViewCommit = Omit<CommitNode, 'workingCopies'> & {
  workingCopies?: ViewWorktree[]
}

/** Empty status answer. */
const IDLE_STATUS: StatusEntry = Object.freeze({ status: 'idle', data: null, error: null })
const NO_WORKTREE_ROWS: readonly ViewWorktree[] = Object.freeze([])
const NO_STASHES: readonly StashEntry[] = Object.freeze([])
const INITIAL_REVISIONS: Revisions = Object.freeze({ working: 0, history: 0, repositories: 0, activity: 0 })

/** Advance the revision of every domain in one refresh request. */
function advanceRevisions(previous: Revisions, domains: readonly string[]): Revisions {
  const next: Revisions = { ...previous }
  for (const domain of domains) {
    if (domain === 'working' || domain === 'history' || domain === 'repositories' || domain === 'activity') next[domain] += 1
  }
  return next
}

/** Empty history answer. */
function idleLog(): HistoryLog {
  return { status: 'idle', commits: [], stashes: [], stashesTruncated: false, worktreeHeads: null, error: null,
    truncated: false, hasMore: false, loadingMore: false }
}

/** Writes that only invalidate the history and overview, not the worktree. */
function historyOnlyRefresh(requester: string | null): boolean {
  return requester === 'tag' || requester === 'stash-drop'
}

/** Whether two path lists name the same paths in the same order. */
function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/** Clamp a sidebar width. */
function clampWidth(value: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value))
}

/** Copy a record without one key. */
function omit<TValue>(record: Readonly<Record<string, TValue>>, key: string): Record<string, TValue> {
  const next = { ...(record ?? {}) }
  delete next[key]
  return next
}

/**
 * Read commit rows as the panel's rows.
 *
 * `attachWorkingCopies` declares only the catalog fields on the checkout rows
 * it attaches, while the panel hands it checkout views that also carry the
 * timeline's `label` and `statusState`; the timeline rows read those.
 * @param rows - commit rows, with any attached checkout rows.
 * @returns the same rows as the timeline rows.
 */
function viewCommits(rows: readonly CommitNode[]): ViewCommit[] {
  return rows as unknown as ViewCommit[]
}

/**
 * Read checkout views as the default-node rule's choices.
 *
 * That rule declares only the status count it reads; the view holds the full
 * status answer, absent or present.
 * @param rows - the panel's checkout views.
 * @returns the same rows as default-node choices.
 */
function viewChoices(rows: readonly ViewWorktree[]): readonly WorktreeChoice[] {
  return rows as unknown as readonly WorktreeChoice[]
}

/**
 * Decode a JSON value the panel itself serialized.
 * @param text - the serialized value.
 * @returns the decoded value.
 */
function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

/** How the Sidebar presents the panel, and the one presentation change it may ask for. */
export interface PanelPresentation {
  fullscreen: boolean
  floating: boolean
  /** Toggle the Sidebar's own fullscreen presentation for the pane holding `element`. */
  toggleFullscreen: (element: HTMLElement | null) => boolean
}

type TurnGraphNavigation = import('./turn-summary.js').TurnGraphTarget & { revision: number }
type TurnGraphs = TurnGraphNavigation['graphs']

/** Standard Sidebar tab props plus locale, visibility, and one-shot navigation requests. */
export interface VcsViewProps {
  sessionId: string
  t: Translate
  locale?: string
  visible?: boolean
  focusRequest?: number
  presentation?: PanelPresentation
  turnGraph?: TurnGraphNavigation
}

/** Where the tiled layout's state traversal stands. */
interface TileTraversal {
  filter: FilterId | null
  index: number
  focus: string | null
}

const NO_TRAVERSAL: TileTraversal = Object.freeze({ filter: null, index: -1, focus: null })

type TileTransition =
  | { into: 'tile'; sources: ReadonlyMap<string, DOMRect> }
  | { into: 'timeline'; tiles: readonly LeavingTile[] }

/** A pointer's request waiting for its repository to become current and readable. */
type PointerActionRequest = { pointer: PointerView } & (
  | { kind: 'menu'; point: MenuPoint; element: HTMLElement | null }
  | { kind: 'direct'; action: TileDirectAction['action']; restore: () => void }
)

/**
 * Render the version control panel for one Session.
 * @param props - standard Sidebar tab props plus the active UI locale, visibility, and a one-shot request to land keyboard focus in the panel.
 */
export function VcsView({
  sessionId, t, locale, visible = true, focusRequest = 0, presentation, turnGraph,
}: VcsViewProps) {
  const [state, setState] = useState<PanelState>(() => loadState(sessionId))
  const stateRef = useRef<PanelState>(state)
  stateRef.current = state
  // Live reading positions: written on every scroll, persisted lazily.
  const anchorRef = useRef<ReadingAnchor | null>(state.anchor)
  const timelineScrollRef = useRef(state.timelineScroll)
  const activityScrollRef = useRef(state.activityScroll)
  const [activityScrollRequest, setActivityScrollRequest] = useState(0)
  const activityScrollOnReturn = useRef(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [clientId] = useState(() => globalThis.crypto.randomUUID?.()
    ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''))
  const api = useMemo(() => createApi(sessionId, { clientId }), [clientId, sessionId])
  const [repositories, setRepositories] = useState<RepositoryListingState>({ status: 'loading', list: [], truncated: false, worktreesTruncated: false, error: null })
  const [repositoryManagement, setRepositoryManagement] = useState<RepositoryManagement | null>(null)
  const [turnGraphs, setTurnGraphs] = useState<TurnGraphs>([])
  const [turnFilter, setTurnFilter] = useState(false)
  const [turnGraphUnavailable, setTurnGraphUnavailable] = useState(false)
  const consumedGraph = useRef<TurnGraphNavigation | null>(null)
  const manageCurrentRepositories = repositoryManagement?.sessionId === sessionId
  const [statuses, setStatuses] = useState<StatusMap>({})
  const [settledStatusKey, setSettledStatusKey] = useState<string | null>(null)
  const [log, setLog] = useState<HistoryLog>(idleLog)
  const [manual, setManual] = useState<Revisions>(INITIAL_REVISIONS)
  const [background, setBackground] = useState<Revisions>(INITIAL_REVISIONS)
  const [overviewWriteRevision, setOverviewWriteRevision] = useState(0)
  const [settledRepositoriesKey, setSettledRepositoriesKey] = useState<string | null>(null)
  const [settledHistoryKey, setSettledHistoryKey] = useState<string | null>(null)
  const [detailInteracting, setDetailInteracting] = useState(false)
  // The toolbar action whose foreground read is in progress.
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const refreshingRef = useRef(refreshing)
  refreshingRef.current = refreshing
  const [width, setWidth] = useState(0)
  // The column the single-column layout shows: 'timeline' or 'detail'.
  const [singleView, setSingleView] = useState<'timeline' | 'detail'>('timeline')
  const [dirChildren, setDirChildren] = useState<Record<string, readonly UntrackedChild[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({})
  // Results stay with their repository when a write outlives its selection.
  const [notices, setNotices] = useState<ReadonlyMap<string | null, Notice>>(new Map())
  const notice = notices.get(state.repo) ?? null
  const setNotice = useCallback((next: Notice | null, repo: string | null = stateRef.current.repo) => {
    setNotices(previous => {
      if (next === null && !previous.has(repo)) return previous
      const updated = new Map(previous)
      if (next === null) updated.delete(repo)
      else updated.set(repo, next)
      return updated
    })
  }, [])
  // Local branches for the header menu, loaded when the menu opens.
  const [branches, setBranches] = useState<BranchListingState>({ status: 'idle', list: [], truncated: false, error: null })
  // Bumped after the Sidebar host focuses its pane, so the settle effect retries.
  const [focusTick, setFocusTick] = useState(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef(sessionId)
  const logKeyRef = useRef('')
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const attemptedDirsRef = useRef(new Map<string, number>())
  const directoryRequestsRef = useRef(new Map<string, AbortController>())
  const perRepoRef = useRef(new Map<string, PerRepoSelection>())
  const createdWorktreesRef = useRef(new Map<string, Set<string>>())
  const repositoryScrollRef = useRef(new Map<string, number>())
  // A restored offset may need more than the first page of history.
  const historyResumeRef = useRef<{ repo: string; ref: string; length: number } | null>(null)
  // The backend each discovered repository used on the last answer.
  const repositoryVcsRef = useRef(new Map<string, string>())
  const pageControllerRef = useRef<AbortController | null>(null)
  const branchesControllerRef = useRef<AbortController | null>(null)
  const loadingBranchesRef = useRef(false)
  const diffCacheRef = useRef(new Map<string, DiffFetchResult>())
  const detailCacheRef = useRef(new Map<string, RevisionState>())
  const activityReading = useRef<ActivityReading>(new Map())
  const activityDiffCache = useRef(new Map<string, DiffFetchResult>())
  const activityDetailCache = useRef(new Map<string, RevisionState>())
  const timelineControl = useRef<TimelineControl | null>(null)
  const detailControl = useRef<DetailPaneControl | null>(null)
  const navZoneRef = useRef<'timeline' | 'tree'>('timeline')
  const panelOwnsFocusRef = useRef(false)
  const pendingReadyFocusRef = useRef(false)
  const pendingRestoreFocusRef = useRef(false)
  const pendingDetailFocusRef = useRef(false)
  const restoreNavFocusRef = useRef<() => boolean>(() => false)
  // A focus request waits for the Sidebar host to focus its pane first.
  const hostFocusPendingRef = useRef(false)

  // The overview pushes the panel right; what remains decides the columns,
  // unless too little remains and the overview covers the panel instead.
  const overviewOpen = state.overview === true && !state.tiled
  const allScope = state.timelineScope === 'all'
  const overviewNeedsDrawer = width > 0 && width - state.overviewWidth < OVERVIEW_DRAWER_REST
  const overviewDrawer = overviewOpen && overviewNeedsDrawer
  const contentWidth = overviewOpen && !overviewDrawer ? width - state.overviewWidth : width
  const narrow = contentWidth > 0 && contentWidth < NARROW_WIDTH
  // One column at a time when the panel is too narrow for two, or when the
  // user put the timeline away.
  const singleColumn = narrow || !state.twoColumns
  const showTimeline = !singleColumn || singleView === 'timeline'
  const showDetail = !singleColumn || singleView === 'detail'
  const repoInfo = repositories.list.find(entry => entry.path === state.repo) ?? null
  const repositoryReady = repositories.status === 'ready' && repoInfo !== null && sessionRef.current === sessionId
  const worktrees = useMemo(() => repositoryWorktrees(repoInfo), [repoInfo])
  const checkedTrees = useMemo(() => checkedWorktrees(worktrees, state.worktrees), [worktrees, state.worktrees])
  const checkedPaths = checkedTrees.map(tree => tree.path)
  const statusPaths = checkedPaths.length > 0 ? checkedPaths : state.repo === null ? [] : [state.repo]
  const statusPathsKey = JSON.stringify(statusPaths)
  // Tiled Git actions address the repository entry, independently of which
  // worktrees the stacked timeline shows.
  const tileAnchorActions = state.tiled && repoInfo?.capabilities.workingCopy === 'row'
  const statusReadPathsKey = tileAnchorActions && state.repo !== null && !statusPaths.includes(state.repo)
    ? JSON.stringify([state.repo, ...statusPaths]) : statusPathsKey
  const statusScope = JSON.stringify([sessionId, state.repo, manual.working, statusReadPathsKey])
  const statusKey = JSON.stringify([statusScope, background.working])
  const graphRevision = turnGraph?.sessionId === sessionId ? turnGraph.revision : 0
  const repositoriesScope = JSON.stringify([sessionId, manual.repositories, graphRevision])
  const repositoriesKey = JSON.stringify([repositoriesScope, background.repositories])
  const statusPath = checkedPaths[0] ?? state.repo
  const status = statuses[statusPath] ?? IDLE_STATUS
  const actionStatus = tileAnchorActions && state.repo !== null ? statuses[state.repo] ?? IDLE_STATUS : status
  const missingTool = !allScope && status.status === 'error' && status.error?.code === 'vcs-missing'
  const showCurrentHead = checkedPaths.length === 0 || (checkedPaths.length === 1 && checkedPaths[0] === state.repo)
  const baseCapabilities = repoInfo?.capabilities ?? status.data?.capabilities ?? null
  const commitBased = baseCapabilities?.workingCopy === 'commit'
  const snapshots = baseCapabilities?.snapshots === true
  const waitingForRepositories = (refreshing === 'refresh' || refreshing === 'worktree') && settledRepositoriesKey !== repositoriesKey
  const waitingForSnapshots = snapshots && refreshing === 'refresh' && settledStatusKey !== statusKey
  const capabilities = useMemo(() => showCurrentHead || baseCapabilities === null ? baseCapabilities : {
    ...baseCapabilities, sync: false, branchSwitch: false, branchOps: false, tagOps: false, commitOps: false, stageOps: false,
  }, [baseCapabilities, showCurrentHead])
  const siblingApi = useMemo(() => createApi(sessionId, { worktreeOf: state.repo }), [sessionId, state.repo])
  // In selected scope send the full checked set, except for the anchor alone.
  // Snapshotting backends also send it in all scope so the request doesn't
  // snapshot an unchecked anchor in order to read the repository-wide graph.
  const historyPathsKey = !showCurrentHead && (state.ref !== 'all' || snapshots) ? statusPathsKey : '[]'
  const historyWorktrees = useMemo<string[]>(() => parseJson<string[]>(historyPathsKey), [historyPathsKey])
  const historyScope = JSON.stringify([state.repo, state.ref, state.ref === 'all' ? [] : historyWorktrees])
  const historyReadScope = JSON.stringify([sessionId, historyScope, manual.history, snapshots ? statusPathsKey : null])
  const historyKey = JSON.stringify([historyReadScope, background.history])
  const revision = manual.working
  const historyKeyRef = useRef(historyKey)
  historyKeyRef.current = historyKey
  const currentHistory = logKeyRef.current === historyKey
  const treeViews = useMemo<ViewWorktree[]>(() => {
    const heads = new Map<string, string | null>((log.worktreeHeads ?? []).map(tree => [tree.path, tree.head]))
    const anchorCopy = commitBased ? log.commits.find(commit => commit.workingCopy === true)?.sha : undefined
    return checkedTrees.map((tree): ViewWorktree => {
      const reading = statuses[tree.path] ?? IDLE_STATUS
      const branch = reading.data?.branch
      let head: string | null | undefined
      if (commitBased) {
        const observed = reading.data?.workingCopy?.commitId
        const recorded = heads.get(tree.path) ?? (tree.path === state.repo ? anchorCopy : undefined)
        head = (currentHistory ? recorded : undefined) ?? observed ?? recorded ?? tree.head
      } else {
        head = heads.has(tree.path) ? heads.get(tree.path)
          : branch !== undefined ? branch?.oid ?? null
            : showCurrentHead && state.ref === 'HEAD' ? log.commits[0]?.sha ?? tree.head : tree.head
      }
      return {
        ...tree,
        head: head ?? null,
        id: worktreeNode(tree.path),
        label: commitBased ? workingCopyLabel(tree, worktrees.length > 1)
          : worktrees.length > 1 ? t('timeline.worktreeNamed', { name: tree.name }) : t('timeline.worktree'),
        refLabel: !commitBased && worktrees.length > 1
          ? worktreeRefLabel({ branch: branch === undefined ? tree.branch : branch?.name, head }, t) : null,
        status: reading.data,
        statusState: reading.status,
      }
    })
  }, [checkedTrees, commitBased, currentHistory, log.commits, log.worktreeHeads, showCurrentHead, state.ref, state.repo, statuses, t, worktrees.length])
  const workspaceViews = commitBased ? treeViews : NO_WORKTREE_ROWS
  const commits = useMemo<ViewCommit[]>(() => {
    if (commitBased) return viewCommits(attachWorkingCopies(log.commits, workspaceViews))
    if (showCurrentHead) return viewCommits(log.commits)
    return viewCommits(log.commits.map(commit => ({ ...commit, refs: sharedRefs(commit.refs ?? []) })))
  }, [commitBased, log.commits, showCurrentHead, workspaceViews])
  const worktreeRows = commitBased ? NO_WORKTREE_ROWS : treeViews
  const stashes = baseCapabilities?.stashOps === true ? log.stashes : NO_STASHES
  const selectedStashSha = stashSha(state.node)
  const selectedStash = selectedStashSha === null ? undefined : stashes.find(stash => stash.sha === selectedStashSha)
  const stashRevision = manual.history + background.history
  const selectedTree = treeViews.find(tree => tree.id === state.node) ?? null
  const selectedWorktree = commitBased ? null : selectedTree
  // Jujutsu commit contents live in the shared store. Use the same immutable
  // revision for both detail and diff, without reading another checkout.
  const detailNode = commitBased && selectedTree !== null ? selectedTree.head : state.node
  const detailRoot = selectedWorktree?.path ?? state.repo
  const detailApi = detailRoot === state.repo ? api : siblingApi
  const detailStatus = selectedTree === null ? status : statuses[selectedTree.path] ?? IDLE_STATUS
  const backgroundDiffRevision = detailStatus.backgroundRevision ?? 0
  const canStage = capabilities?.stageOps === true && selectedWorktree?.path === state.repo
  const anchorHead = showCurrentHead ? worktreeRows[0]?.head ?? null : null
  const graphWorktreesKey = JSON.stringify(worktreeRows.map(({ id, head }) => ({ id, head })))
  const rows = useMemo(() => timelineRows(commits, parseJson<WorktreeHead[]>(graphWorktreesKey), stashes), [commits, graphWorktreesKey, stashes])
  const rowIndex = useMemo(() => indexTimelineRows(rows), [rows])
  const layout = useMemo(() => buildGraph(graphInput(rows)), [rows])
  const commitIndex = useMemo(
    () => indexCommits(commits),
    [commits],
  )

  /** The state as it should be stored, including the live reading positions. */
  const persisted = useCallback(() => ({
    ...stateRef.current,
    anchor: anchorRef.current,
    timelineScroll: timelineScrollRef.current,
    activityScroll: activityScrollRef.current,
  }), [])

  /** Persist reading positions a moment after the last scroll event. */
  const persistSoon = useCallback(() => {
    if (persistTimer.current !== null) return
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      saveState(sessionId, persisted())
    }, 300)
  }, [persisted, sessionId])

  // Claim focus into the panel when opened, revealed, or visibly mounted
  // without an external owner (wait two frames for the Sidebar host's pane focus).
  useEffect(() => {
    if (!visible) {
      pendingReadyFocusRef.current = false
      hostFocusPendingRef.current = false
      return undefined
    }
    if (focusRequest === 0 && stateRef.current.overview) return undefined
    pendingReadyFocusRef.current = true
    hostFocusPendingRef.current = true
    if (focusRequest > 0) {
      navZoneRef.current = singleColumn && singleView === 'detail' ? 'tree' : 'timeline'
    }
    let second: number | undefined
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // The host's pane focus is in place by now; let the settle effect
        // move on from it.
        hostFocusPendingRef.current = false
        setFocusTick(value => value + 1)
      })
    })
    return () => {
      cancelAnimationFrame(first)
      if (second !== undefined) cancelAnimationFrame(second)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, visible])

  // Clicking outside the panel relinquishes panel focus ownership so background
  // updates never pull focus back out of Chat or Terminal.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onPointerDown = (event: PointerEvent) => {
      // A pointer event's target is a Node; the DOM typings only promise an
      // EventTarget.
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node | null)) {
        panelOwnsFocusRef.current = false
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [])

  useEffect(() => () => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current)
    saveState(sessionId, persisted())
  }, [persisted, sessionId])

  useEffect(() => {
    if (sessionRef.current === sessionId) saveState(sessionId, persisted())
  }, [persisted, sessionId, state])

  /** Update a slice of persisted state. */
  const update = useCallback((patch: Partial<PanelState>) => {
    setState(previous => ({ ...previous, ...patch }))
  }, [])

  const abortDirectoryRequests = useCallback(() => {
    for (const controller of directoryRequestsRef.current.values()) controller.abort()
    directoryRequestsRef.current.clear()
  }, [])

  const resetDirectories = useCallback(() => {
    abortDirectoryRequests()
    setDirChildren({})
    setLoadingDirs({})
    attemptedDirsRef.current.clear()
  }, [abortDirectoryRequests])

  /** Move the selection; checkout-relative directories must never cross roots. */
  const selectNode = useCallback((node: string | null, chosen: boolean) => {
    if (chosen) pendingDetailFocusRef.current = false
    // A null node is the repository root; `nodePatch` handles it although its
    // declared parameter narrows to timeline nodes.
    const patch = nodePatch(stateRef.current, node as string, chosen)
    if ('anchor' in patch) anchorRef.current = null
    if ('dirs' in patch) resetDirectories()
    if (Object.keys(patch).length > 0) update(patch)
  }, [resetDirectories, update])

  /** Refresh the domains affected by the explicit action. */
  const refresh = useCallback((requester = 'refresh', targetRepo = stateRef.current.repo): void => {
    setNotice(null, targetRepo)
    if (targetRepo !== stateRef.current.repo) {
      // The existing foreground refresh already rereads both tile models. A
      // write in another repository needs those reads without resetting this timeline.
      setOverviewWriteRevision(previous => previous + 1)
      if (requester === 'worktree') setBackground(previous => advanceRevisions(previous, ['repositories']))
      return
    }
    const domains = requester === 'stage' ? ['working']
      : historyOnlyRefresh(requester) ? ['history']
        : requester === 'repositories' ? ['repositories']
          : requester === 'refresh' || requester === 'worktree' ? ['working', 'history', 'repositories'] : ['working', 'history']
    setRefreshing(requester)
    if (domains.includes('working')) {
      resetDirectories()
      diffCacheRef.current.clear()
    }
    if (domains.includes('history')) {
      pageControllerRef.current?.abort()
      pageControllerRef.current = null
      detailCacheRef.current.clear()
    }
    setManual(previous => advanceRevisions(previous, domains))
  }, [resetDirectories, setNotice])

  const onWorktreeChange = useCallback((repo: string, createdPath?: string) => {
    if (createdPath !== undefined) {
      const pending = createdWorktreesRef.current.get(repo) ?? new Set<string>()
      pending.add(createdPath)
      createdWorktreesRef.current.set(repo, pending)
    }
    refresh('worktree', repo)
  }, [refresh])

  const refreshInBackground = useCallback((domains: readonly string[]) => {
    setBackground(previous => advanceRevisions(previous, domains))
  }, [])

  /**
   * Drop everything that described the old HEAD after a checkout: selection,
   * folds, directory expansions, reading position, and the diff cache. Status
   * then picks the new head's default node, exactly as after a refresh.
   */
  const resetReadingForNewHead = useCallback(() => {
    anchorRef.current = null
    timelineScrollRef.current = 0
    navZoneRef.current = 'timeline'
    resetDirectories()
    diffCacheRef.current.clear()
    detailCacheRef.current.clear()
    update({ node: null, nodeChosen: false, anchor: null, folds: {}, collapsed: {}, dirs: {} })
  }, [resetDirectories, update])

  const clearBranches = useCallback(() => {
    setBranches({ status: 'idle', list: [], truncated: false, error: null })
  }, [])

  const abortBranches = useCallback(() => {
    branchesControllerRef.current?.abort()
    branchesControllerRef.current = null
    loadingBranchesRef.current = false
  }, [])

  const getStashDetail = useCallback(({ repo, sha }: StashTarget) => {
    const reading = detailCacheRef.current.get(detailCacheKey(repo, stashNode(sha), stashRevision))
    return reading?.detail?.kind === 'stash' ? reading.detail.stash : undefined
  }, [stashRevision])
  const selectStashResult = useCallback((node: string | null) => {
    selectNode(node, node !== null)
    if (stashSha(node) !== null) pendingRevealRef.current = node
  }, [selectNode])
  const refreshMissingStash = useCallback((repo: string) => { refresh('stash-drop', repo) }, [refresh])

  const actions = useRepoActions({
    api,
    sessionId,
    repo: showCurrentHead || tileAnchorActions ? state.repo : null,
    stateRef,
    sessionRef,
    statusData: actionStatus.data,
    capabilities: tileAnchorActions ? baseCapabilities : capabilities,
    commits,
    commitIndex,
    getStashDetail,
    selectStashResult,
    head: anchorHead,
    rootRef,
    onRestoreFocus: () => {
      if (!restoreNavFocusRef.current()) pendingReadyFocusRef.current = true
    },
    t,
    locale,
    refresh,
    onWorktreeChange,
    resetReadingForNewHead,
    setNotice,
    clearBranches,
    abortBranches,
  })
  const { resetActionsUi } = actions
  const hasOpenOverlay = actions.menu !== null || actions.dialog !== null || manageCurrentRepositories
  // The timeline hands over its structural row and anchor types; the actions
  // controller holds the same objects as the panel's rows.
  const timelineRefActions: RefActionsHandler | undefined = capabilities?.branchOps === true || capabilities?.tagOps === true
    ? (reference, event, anchor) => { actions.onRefActions(reference, event, anchor as unknown as HTMLElement | null) }
    : undefined
  const timelineCommitActions: CommitActionsHandler | undefined = capabilities?.commitOps === true
    ? (commit, point, anchor) => { actions.openCommitActions(commit as unknown as CommitNode, point, anchor as unknown as HTMLElement | null) }
    : undefined
  const timelineStashActions: StashActionsHandler | undefined = capabilities?.stashOps === true && showCurrentHead && state.repo !== null
    ? (stash, point, anchor) => {
      actions.openStashActions({ ...stash, repo: state.repo! }, point, anchor as HTMLElement | null)
    }
    : undefined

  const closeRepositoryManagement = () => {
    if (repositoryManagement !== null) repositoryManagement.restoreFocus()
    setRepositoryManagement(null)
  }

  // Snapshot live focus ownership before reconciliation so layout recovery sees
  // when a render unmounted the currently focused stop.
  const activeDuringRender = typeof document === 'undefined' ? null : document.activeElement
  if (rootRef.current !== null && activeDuringRender !== null && rootRef.current.contains(activeDuringRender)) {
    panelOwnsFocusRef.current = true
    if (!pendingRestoreFocusRef.current && !pendingDetailFocusRef.current) {
      const activeZone = zoneOf(activeDuringRender, rootRef.current)
      if (activeZone !== null) navZoneRef.current = activeZone
    }
  }

  /** Select newly created paths once the refreshed catalog can read them. */
  const selectDiscoveredWorktrees = useCallback((entry: RepositoryInfo | null, previous: readonly string[]) => {
    const catalog = repositoryWorktrees(entry)
    const pending = entry === null ? undefined : createdWorktreesRef.current.get(entry.path)
    const selected = [...checkedWorktrees(catalog, previous).map(tree => tree.path), ...(pending ?? [])]
    if (entry !== null && pending !== undefined) {
      for (const tree of catalog) pending.delete(tree.path)
      if (pending.size === 0) createdWorktreesRef.current.delete(entry.path)
    }
    return checkedWorktrees(catalog, selected).map(tree => tree.path)
  }, [])

  /** Remember one repository's selection and restore the next one's. */
  const switchRepo = useCallback((entry: RepositoryInfo | null, node?: string) => {
    const nextRepo = entry?.path ?? null
    const nextCapabilities = entry?.capabilities
    pendingDetailFocusRef.current = false
    navZoneRef.current = 'timeline'
    const current = stateRef.current
    if (current.repo !== null && current.repo !== nextRepo) {
      const resume = historyResumeRef.current
      repositoryScrollRef.current.set(current.repo, timelineScrollRef.current)
      perRepoRef.current.set(current.repo, {
        node: current.node,
        nodeChosen: current.nodeChosen,
        worktrees: current.worktrees,
        dirs: current.dirs,
        collapsed: current.collapsed,
        ref: current.ref,
        anchor: anchorRef.current,
        folds: current.folds,
        historyLength: resume?.repo === current.repo && resume.ref === current.ref ? resume.length : loadedHistoryLength.current,
      })
    }
    const saved = nextRepo === null ? undefined : perRepoRef.current.get(nextRepo)
    const reading = node === undefined || node === saved?.node ? saved : undefined
    const ranges = Array.isArray(nextCapabilities?.ranges) ? nextCapabilities.ranges : null
    const ref = saved !== undefined && ranges?.some(range => range.value === saved.ref)
      ? saved.ref
      : (nextCapabilities?.defaultRange ?? 'all')
    historyResumeRef.current = node === undefined && nextRepo !== null && saved !== undefined && saved.ref === ref
      ? { repo: nextRepo, ref, length: saved.historyLength }
      : null
    setStatuses({})
    setLog(idleLog())
    logKeyRef.current = ''
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
    setSingleView('timeline')
    if (!current.tiled) setNotice(null, nextRepo)
    resetDirectories()
    diffCacheRef.current.clear()
    detailCacheRef.current.clear()
    abortBranches()
    clearBranches()
    resetActionsUi()
    anchorRef.current = reading?.anchor ?? null
    timelineScrollRef.current = node === undefined && nextRepo !== null ? repositoryScrollRef.current.get(nextRepo) ?? 0 : 0
    update({
      repo: nextRepo,
      worktrees: selectDiscoveredWorktrees(entry, saved?.worktrees ?? []),
      node: node ?? saved?.node ?? null,
      nodeChosen: node !== undefined || (saved?.nodeChosen ?? false),
      dirs: reading?.dirs ?? {},
      collapsed: reading?.collapsed ?? {},
      folds: reading?.folds ?? {},
      anchor: anchorRef.current,
      ref,
    })
  }, [abortBranches, clearBranches, resetActionsUi, resetDirectories, selectDiscoveredWorktrees, setNotice, update])

  /** Change only the timeline within the current repository. */
  const toggleCheckedWorktree = (path: string) => {
    const current = stateRef.current
    const next = toggleWorktree(worktrees, current.worktrees, path)
    if (samePaths(next, checkedPaths)) return
    abortBranches()
    clearBranches()
    resetActionsUi()
    setNotice(null)
    if (current.ref !== 'all' && worktreePath(current.node) === null
      && current.node !== null && current.node !== WORKTREE && current.node !== WORKING_COPY) {
      selectNode(worktreeNode(next[0]), false)
    }
    update({ worktrees: next })
  }


  // Overview column and tiled layout -------------------------------------------
  const overviewControl = useRef<OverviewControl | null>(null)
  const overviewFocusRequestRef = useRef<{ from: Element | null } | null>(null)
  const tiledControl = useRef<TiledControl | null>(null)
  const [tileTraversal, setTileTraversal] = useState<TileTraversal>(NO_TRAVERSAL)
  const [overviewPhase, setOverviewPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>(
    () => (state.overview && !state.tiled ? 'open' : 'closed'),
  )
  const [pointerRequestTick, setPointerRequestTick] = useState(0)
  const pendingPointerActionRef = useRef<{ sessionId: string; request: PointerActionRequest } | null>(null)
  const pendingRevealRef = useRef<string | null>(null)
  const fullscreenRequestedRef = useRef(false)
  const motionRef = useRef<TileTransition | null>(null)
  const tileTransition = motionRef.current
  // Tile transitions lay out their destination at once; the columns animate
  // between the two positions instead of also chasing the overview slide.
  const overviewPresentation = state.tiled ? 'closed' : tileTransition?.into === 'timeline'
    ? (overviewOpen ? 'open' : 'closed') : overviewPhase
  const presentationRef = useRef(presentation)
  presentationRef.current = presentation
  const widthRef = useRef(width)
  widthRef.current = width

  const activity = useActivity(api, {
    active: allScope && !state.tiled && visible && repositories.status === 'ready' && repositories.list.length >= 2
      && sessionRef.current === sessionId,
    revalidateKey: JSON.stringify([background.history, background.repositories, background.activity]),
  })
  const activityBusy = activity.status === 'loading' || activity.loadingMore
  const activityRepos = useMemo(() => activityRepositories(repositories.list, repositories.cwd), [repositories.list, repositories.cwd])
  const activityEntries = useMemo(() => activity.entries.filter(entry => activityRepos.has(entry.repo)), [activity.entries, activityRepos])
  const activityModel = useMemo(() => buildActivity(activityEntries, new Set(state.activityExpanded), [...activityRepos.keys()]),
    [activityEntries, activityRepos, state.activityExpanded])
  const activityIndex = activitySelection(activityModel, state.activitySelected, state.activityEntry)
  const activityRow = activityModel.rows[activityIndex]
  const selectedActivity = allScope && activityRow !== undefined && activityRow.kind !== 'day' ? activityRow : null
  const activityRepo = selectedActivity === null ? undefined : activityRepos.get(selectedActivity.entry.repo)

  const refreshPanel = () => {
    if (allScope) {
      // Discovery and activity are both read-only. The one-repository manual
      // refresh can snapshot Jujutsu and resets its reading state.
      refresh('repositories')
      if (!state.tiled) {
        activityDiffCache.current.clear()
        activityDetailCache.current.clear()
        activity.refresh('reset')
      }
    } else refresh()
  }

  useEffect(() => {
    if (!allScope || activity.status !== 'ready') return
    const key = selectedActivity?.key ?? null
    const identity = selectedActivity === null ? null : entryKey(selectedActivity.entry)
    if (state.activitySelected !== key || state.activityEntry !== identity) {
      update({ activitySelected: key, activityEntry: identity })
    }
  }, [activity.status, allScope, selectedActivity, state.activityEntry, state.activitySelected, update])

  const overviewData = useOverview(api, {
    active: (overviewOpen || state.tiled) && !waitingForSnapshots,
    reloadKey: JSON.stringify([sessionId, manual.repositories, background.repositories, manual.history, manual.working, overviewWriteRevision]),
    repo: state.repo,
    repoKey: JSON.stringify([state.repo, background.history, background.working]),
  })
  const overviewCwd = repositories.cwd ?? overviewData.cwd ?? null
  const overviewViews = useMemo(
    () => [...overviewData.repositories.values()].map(repository => repositoryView(repository, overviewCwd)),
    [overviewCwd, overviewData.repositories],
  )
  const viewByPath = useMemo(() => new Map(overviewViews.map(view => [view.path, view])), [overviewViews])

  const tilePathsKey = JSON.stringify(repositories.list.map(entry => entry.path))
  const tilePaths = useMemo(() => parseJson<string[]>(tilePathsKey), [tilePathsKey])
  const tileHistories = useTileHistories(
    api, tilePaths, state.tiled, JSON.stringify([sessionId, manual.history, background.history, overviewWriteRevision,
      allScope ? manual.repositories : null]),
    waitingForSnapshots,
  )
  const skeletons = useMemo(() => {
    const result = new Map<string, ReturnType<typeof buildSkeleton>>()
    for (const [path, history] of tileHistories) {
      const view = viewByPath.get(path)
      if (view === undefined || history.status !== 'ready') continue
      const tags = history.commits.flatMap(commit => (commit.refs ?? [])
        .filter(reference => reference.kind === 'tag').map(reference => ({ name: reference.name, sha: commit.sha })))
      result.set(path, buildSkeleton(history.commits, view.pointers, tags))
    }
    return result
  }, [tileHistories, viewByPath])
  const tileColumns = useMemo<TileColumn[]>(() => tileOrder(
    repositories.list, viewByPath, state.tileOrder,
  ).map(entry => ({
    entry,
    view: viewByPath.get(entry.path) ?? null,
    skeleton: skeletons.get(entry.path) ?? null,
    history: historyOf(tileHistories, entry.path),
  })), [repositories.list, skeletons, state.tileOrder, tileHistories, viewByPath])
  const tileCounts = useMemo(
    () => filterCounts(tileColumns.flatMap(column => column.view === null ? [] : [column.view])),
    [tileColumns],
  )
  const tileHits = useMemo(() => tileTraversal.filter === null ? [] : traversal(
    tileColumns.flatMap(column => column.view === null ? [] : [{ repo: column.entry.path, pointers: columnOrder(column.skeleton, column.view) }]),
    tileTraversal.filter,
  ), [tileColumns, tileTraversal.filter])

  // The pointer the timeline's selection names, marked in the overview.
  const pointerRepo = allScope ? selectedActivity?.entry.repo ?? null : state.repo
  const pointerNode = allScope ? (selectedActivity === null ? null : activityNode(selectedActivity.entry)) : state.node
  const selectedPointer = selectedPointerId(pointerRepo === null ? undefined : viewByPath.get(pointerRepo), pointerNode)

  /** Ask the Sidebar for its fullscreen presentation when the panel is narrower than `needed`. */
  const requestRoom = useCallback((needed: number) => {
    const current = presentationRef.current
    if (current === undefined || current.fullscreen || current.floating || widthRef.current >= needed) return
    if (current.toggleFullscreen(rootRef.current)) fullscreenRequestedRef.current = true
  }, [])
  /** Give back the fullscreen presentation this panel asked for. */
  const releaseRoom = useCallback(() => {
    if (!fullscreenRequestedRef.current) return
    fullscreenRequestedRef.current = false
    const current = presentationRef.current
    if (current?.fullscreen === true) current.toggleFullscreen(rootRef.current)
  }, [])
  const measured = width > 0
  useEffect(() => {
    if (!visible || !measured) return
    if (state.tiled) requestRoom(TILE_ROOM)
    else if (overviewOpen) requestRoom(stateRef.current.overviewWidth + NARROW_WIDTH)
    else releaseRoom()
  }, [measured, overviewOpen, releaseRoom, requestRoom, state.tiled, visible])

  // The overview slides in from the left and out again; reduced motion and the
  // switch into the tiled layout skip the slide.
  useEffect(() => {
    if (overviewOpen) {
      if (overviewPhase === 'closed' || overviewPhase === 'closing') setOverviewPhase(reducedMotion() ? 'open' : 'opening')
      return undefined
    }
    if (overviewPhase === 'closed') return undefined
    if (state.tiled || reducedMotion()) {
      setOverviewPhase('closed')
      return undefined
    }
    setOverviewPhase('closing')
    const timer = setTimeout(() => { setOverviewPhase('closed') }, OVERVIEW_SLIDE_MS)
    return () => { clearTimeout(timer) }
  }, [overviewOpen, overviewPhase, state.tiled])
  useEffect(() => {
    if (overviewPhase !== 'opening') return undefined
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { setOverviewPhase('open') }) })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [overviewPhase])

  /** Switch layouts, recording the boxes that will be gone after the render. */
  const setTiled = useCallback((on: boolean, restoreOverview?: boolean) => {
    const current = stateRef.current
    if (current.tiled === on) return
    const root = rootRef.current
    clearMotionGhosts(root)
    const animate = typeof root?.animate === 'function' && !reducedMotion()
    if (on) {
      const sources = (animate && current.overview ? overviewControl.current?.repositoryRects() : undefined) ?? new Map()
      if (animate) {
        const sidebar = root?.querySelector<HTMLElement>('.vcs-sidebar')
        if (current.timelineScope === 'all') fadeOutInPlace(root, sidebar ?? null, 0)
        else if (current.repo !== null && sidebar != null) sources.set(current.repo, sidebar.getBoundingClientRect())
        fadeOutInPlace(root, root?.querySelector<HTMLElement>('.vcs-content') ?? null, current.timelineScope === 'all' ? 0 : undefined)
      }
      motionRef.current = { into: 'tile', sources }
      update({ tiled: true, overviewBeforeTile: current.overview === true, overview: false })
    } else {
      const boxes = animate ? tiledControl.current?.columnRects() : undefined
      motionRef.current = { into: 'timeline', tiles: boxes === undefined ? [] : copyTiles(root, boxes) }
      setTileTraversal(NO_TRAVERSAL)
      update({ tiled: false, overview: restoreOverview ?? current.overviewBeforeTile, overviewBeforeTile: false })
    }
  }, [update])
  useLayoutEffect(() => {
    if (tileTransition === null || (tileTransition.into === 'tile') !== state.tiled) return
    motionRef.current = null
    const root = rootRef.current
    setOverviewPhase(overviewPresentation)
    if (tileTransition.into === 'tile') {
      enterTiles(root, tileTransition.sources)
      // The timeline or overview that held focus is gone; the columns take it.
      if (panelOwnsFocusRef.current) tiledControl.current?.focus()
    } else {
      leaveTiles(root, tileTransition.tiles, allScope ? null : state.repo, overviewControl.current?.repositoryRects() ?? new Map())
      slideIn(root?.querySelector<HTMLElement>('.vcs-content') ?? null, allScope ? 0 : undefined)
      if (panelOwnsFocusRef.current && overviewFocusRequestRef.current === null) {
        navZoneRef.current = 'timeline'
        pendingReadyFocusRef.current = true
        if (!restoreNavFocus()) rootRef.current?.focus({ preventScroll: true })
      }
    }
  })

  const toggleOverview = useCallback(() => {
    const current = stateRef.current
    overviewFocusRequestRef.current = current.tiled || !current.overview
      ? { from: rootRef.current?.ownerDocument.activeElement ?? null }
      : null
    if (current.tiled) {
      // The overview is closed while tiled, so its button opens it and leaves the tiled layout.
      setTiled(false, true)
    } else update({ overview: !current.overview })
  }, [setTiled, update])

  /** An overview choice gives the timeline its usual view, focus, and drawer behavior. */
  const finishOverviewChoice = useCallback((keyboard: boolean, showTimeline: boolean) => {
    if (showTimeline || keyboard) {
      navZoneRef.current = 'timeline'
      pendingDetailFocusRef.current = false
      setSingleView('timeline')
    }
    if (keyboard) {
      // Hand focus to the timeline now, and to the selected row once it is read.
      panelOwnsFocusRef.current = true
      pendingRestoreFocusRef.current = true
      pendingReadyFocusRef.current = true
    }
    if (overviewDrawer) update({ overview: false })
    if (keyboard) setFocusTick(value => value + 1)
  }, [overviewDrawer, update])

  /** Reveal any node in its repository, extending the loaded history if necessary. */
  const revealInRepository = useCallback((repo: string, node: string, keyboard: boolean, occupant?: string) => {
    const entry = repositories.list.find(item => item.path === repo)
    if (entry === undefined || (stashSha(node) !== null && entry.capabilities.stashOps !== true)) return
    if (stateRef.current.repo !== entry.path) switchRepo(entry, node)
    else selectNode(node, true)
    const worktree = worktreePath(node) !== null
    update({ timelineScope: 'repository', ...(!worktree && { ref: 'all' }) })
    if (occupant !== undefined) {
      setState(previous => {
        const catalog = repositoryWorktrees(entry)
        if (!catalog.some(tree => tree.path === occupant)) return previous
        const checked = checkedWorktrees(catalog, previous.worktrees).map(tree => tree.path)
        return checked.includes(occupant) ? previous : { ...previous, worktrees: [...checked, occupant] }
      })
    }
    pendingRevealRef.current = worktree ? null : node
    finishOverviewChoice(keyboard, true)
  }, [finishOverviewChoice, repositories.list, selectNode, switchRepo, update])

  const cancelTurnNavigation = useCallback(() => {
    if (turnGraph?.sessionId === sessionId) consumedGraph.current = turnGraph
    setTurnFilter(false)
    setTurnGraphUnavailable(false)
  }, [sessionId, turnGraph])

  const revealPointer = useCallback((pointer: PointerView, keyboard: boolean) => {
    cancelTurnNavigation()
    const target = pointerTarget(pointer)
    const node = 'worktree' in target ? worktreeNode(target.worktree) : 'stash' in target ? target.stash : target.commit
    revealInRepository(pointer.repo, node, keyboard, pointer.occupant?.path)
  }, [cancelTurnNavigation, revealInRepository])

  const revealActivity = useCallback((entry: ActivityEntry, keyboard: boolean) => {
    cancelTurnNavigation()
    revealInRepository(entry.repo, activityNode(entry), keyboard)
  }, [cancelTurnNavigation, revealInRepository])

  const selectOverviewRepository = useCallback((path: string, keyboard: boolean) => {
    const entry = repositories.list.find(item => item.path === path)
    if (entry === undefined) return
    const fromAll = stateRef.current.timelineScope === 'all'
    if (stateRef.current.repo !== path) switchRepo(entry)
    if (fromAll) update({ timelineScope: 'repository' })
    finishOverviewChoice(keyboard, fromAll || turnFilter)
    cancelTurnNavigation()
  }, [cancelTurnNavigation, finishOverviewChoice, repositories.list, switchRepo, turnFilter, update])

  const selectAllRepositories = useCallback((keyboard: boolean) => {
    if (repositories.list.length < 2) return
    const switching = stateRef.current.timelineScope !== 'all'
    pendingRevealRef.current = null
    if (switching) update({ timelineScope: 'all' })
    finishOverviewChoice(keyboard, switching)
    cancelTurnNavigation()
  }, [cancelTurnNavigation, finishOverviewChoice, repositories.list.length, update])

  /** Both menu and direct actions first bring the pointer's repository into scope. */
  const requestPointerAction = useCallback((request: PointerActionRequest) => {
    const { pointer } = request
    const entry = repositories.list.find(item => item.path === pointer.repo)
    if (entry === undefined || (pointer.kind === 'stash' && entry.capabilities.stashOps !== true)) return
    pendingPointerActionRef.current = null
    // Opening actions is not navigation: keep the drawer and its opener visible.
    if (stateRef.current.repo !== pointer.repo) switchRepo(entry)
    if (!stateRef.current.tiled && stateRef.current.timelineScope === 'all') update({ timelineScope: 'repository' })
    pendingPointerActionRef.current = { sessionId, request }
    setPointerRequestTick(value => value + 1)
  }, [repositories.list, sessionId, switchRepo, update])

  const openPointerActions = useCallback((pointer: PointerView, point: MenuPoint, element: HTMLElement | null) => {
    requestPointerAction({ kind: 'menu', pointer, point: { clientX: point.clientX, clientY: point.clientY }, element })
  }, [requestPointerAction])

  /** Step to the next or previous pointer of one state; a spine holding it opens. */
  const stepTraversal = useCallback((filter: FilterId, direction: 1 | -1) => {
    const hits = traversal(
      tileColumns.flatMap(column => column.view === null ? [] : [{ repo: column.entry.path, pointers: columnOrder(column.skeleton, column.view) }]),
      filter,
    )
    if (hits.length === 0) return
    const index = tileTraversal.filter === filter ? stepIndex(hits.length, tileTraversal.index, direction) : direction > 0 ? 0 : hits.length - 1
    const hit = hits[index]
    setTileTraversal({ filter, index, focus: hit.id })
    if (viewByPath.get(hit.repo)?.quiet === true && !stateRef.current.tileExpanded.includes(hit.repo)) {
      update({ tileExpanded: [...stateRef.current.tileExpanded, hit.repo] })
    }
  }, [tileColumns, tileTraversal.filter, tileTraversal.index, update, viewByPath])

  const focusTilePointer = useCallback((id: string | null) => {
    setTileTraversal(previous => {
      const index = previous.filter === null ? -1 : tileHits.findIndex(hit => hit.id === id)
      return { filter: previous.filter, index: index >= 0 ? index : Math.min(previous.index, tileHits.length - 1), focus: id }
    })
  }, [tileHits])

  /** Leave the tiled layout and read a pointer, or a repository, in the stacked timeline. */
  const openFromTile = useCallback((path: string, pointer: PointerView | null) => {
    setTiled(false)
    if (pointer !== null) revealPointer(pointer, true)
    else selectOverviewRepository(path, true)
  }, [revealPointer, selectOverviewRepository, setTiled])

  // A traversal step brings its chip into view once the columns rendered it.
  useEffect(() => {
    if (!state.tiled || tileTraversal.focus === null) return
    tiledControl.current?.reveal(tileTraversal.focus)
  }, [state.tiled, tileTraversal.focus, tileTraversal.index])

  // The application shortcuts for the overview and the tiled layout.
  useEffect(() => onPanelCommand(sessionId, command => {
    if (command === 'overview') toggleOverview()
    else setTiled(!stateRef.current.tiled)
  }), [sessionId, setTiled, toggleOverview])

  // The persisted range belongs to one backend; a Jujutsu selection must not
  // start on `HEAD`, and a Git selection must not start on `@`.
  useEffect(() => {
    if (capabilities === null) return
    const ranges = Array.isArray(capabilities.ranges) ? capabilities.ranges : []
    if (ranges.length === 0 || ranges.some(range => range.value === state.ref)) return
    update({ ref: capabilities.defaultRange ?? ranges[0].value })
  }, [capabilities, state.ref, update])

  // Panel width decides the single-column layout.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null) return undefined
    const measure = () => { setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const lastDiscoveryScope = useRef<string | null>(null)
  // Rediscover repositories independently of working-tree and history reads.
  useEffect(() => {
    const controller = new AbortController()
    const foreground = lastDiscoveryScope.current !== repositoriesScope
    if (foreground) setRepositories(previous => ({ ...previous, status: previous.list.length === 0 ? 'loading' : 'ready', error: null }))
    api.repositories(controller.signal).then(answer => {
      if (controller.signal.aborted) return
      const list: RepositoryInfo[] = Array.isArray(answer?.repositories) ? answer.repositories : []
      setState(previous => resolveOverviewDefault({
        ...previous, timelineScope: resolveTimelineScope(previous.timelineScope, list.length),
      }, list.length))
      setRepositories({
        status: 'ready', list, truncated: answer?.truncated === true, worktreesTruncated: answer?.worktreesTruncated === true,
        error: null, cwd: typeof answer?.cwd === 'string' ? answer.cwd : null,
        configError: typeof answer?.configError === 'string' ? answer.configError : null,
      })
      const previousRepo = stateRef.current.repo
      const previousVcs = previousRepo === null ? undefined : repositoryVcsRef.current.get(previousRepo)
      repositoryVcsRef.current = new Map(list.map((entry): [string, string] => [entry.path, entry.vcs]))
      const nextEntry = pickRepository(list, previousRepo)
      const nextRepo = nextEntry?.path ?? null
      if (nextRepo !== previousRepo) switchRepo(nextEntry)
      else if (previousVcs !== undefined && previousVcs !== nextEntry?.vcs) {
        // The same path now reads through another backend: drop the old
        // backend's selection, folds, and caches instead of reusing them.
        if (nextRepo !== null) {
          perRepoRef.current.delete(nextRepo)
          repositoryScrollRef.current.delete(nextRepo)
        }
        switchRepo(nextEntry)
      } else {
        const previous = stateRef.current.worktrees
        const checked = selectDiscoveredWorktrees(nextEntry, previous)
        if (!samePaths(checked, previous)) update({ worktrees: checked })
      }
      if (foreground && list.length === 0) setRefreshing(null)
    }).catch(error => {
      const failure = failureOf(error)
      if (failure.name === 'AbortError' || controller.signal.aborted) return
      if (foreground) {
        setRepositories({ status: 'error', list: [], truncated: false, worktreesTruncated: false, error: failure })
        setRefreshing(null)
      }
    }).finally(() => {
      if (controller.signal.aborted) return
      lastDiscoveryScope.current = repositoriesScope
      setSettledRepositoriesKey(repositoriesKey)
      if (foreground) setRefreshing(action => action === 'repositories' ? null : action)
    })
    return () => { controller.abort() }
  }, [api, repositoriesKey, repositoriesScope, selectDiscoveredWorktrees, switchRepo, update])

  const lastStatusScope = useRef<string | null>(null)
  // Jujutsu status snapshots only for the manual refresh button. Snapshot reads
  // serialize within the shared store; other status reads can run in parallel.
  useEffect(() => {
    if (!repositoryReady || waitingForRepositories) return undefined
    const controller = new AbortController()
    const paths = parseJson<string[]>(statusReadPathsKey)
    const foreground = lastStatusScope.current !== statusScope
    const snapshot = snapshots && foreground && refreshingRef.current === 'refresh'
    if (foreground) setStatuses(previous => Object.fromEntries(paths.map((path): [string, StatusEntry] => {
      const data = previous[path]?.data ?? null
      return [path, { status: data === null ? 'loading' : 'refreshing', data, error: null, backgroundRevision: previous[path]?.backgroundRevision }]
    })))
    let cursor = 0
    const backgroundResults: StatusMap = {}
    async function readStatus() {
      while (!controller.signal.aborted && cursor < paths.length) {
        const path = paths[cursor++]
        const reader: Api = path === state.repo ? api : siblingApi
        try {
          const data = await reader.status(path, controller.signal, { readOnly: snapshots && !snapshot })
          if (controller.signal.aborted) return
          const next: StatusEntry = { status: 'ready', data, error: null }
          if (foreground) {
            setStatuses(previous => ({ ...previous, [path]: { ...next, backgroundRevision: previous[path]?.backgroundRevision } }))
          } else backgroundResults[path] = { ...next, backgroundRevision: background.working }
        } catch (error) {
          if (failureOf(error).name === 'AbortError' || controller.signal.aborted) return
          const next: StatusEntry = { status: 'error', data: null, error: failureOf(error) }
          if (foreground) setStatuses(previous => ({
            ...previous, [path]: { ...previous[path], ...next, data: previous[path]?.data ?? null },
          }))
          else backgroundResults[path] = next
        }
      }
    }
    const concurrency = snapshot ? 1 : STATUS_CONCURRENCY
    Promise.all(Array.from({ length: Math.min(paths.length, concurrency) }, readStatus)).then(() => {
      if (controller.signal.aborted) return
      lastStatusScope.current = statusScope
      setSettledStatusKey(statusKey)
      if (foreground) {
        setRefreshing(action => historyOnlyRefresh(action) || action === 'repositories' ? action : null)
      } else {
        setStatuses(previous => {
          const next = { ...previous }
          for (const [path, result] of Object.entries(backgroundResults)) {
            if (result.status === 'ready' || previous[path]?.data == null) next[path] = result
          }
          return next
        })
      }
    })
    return () => { controller.abort() }
  }, [api, background.working, repositoryReady, siblingApi, snapshots, state.repo, statusKey, statusReadPathsKey, statusScope, waitingForRepositories])

  useEffect(() => {
    if (!repositoryReady || detailInteracting || allScope) return
    const current = stateRef.current
    const node = preferredViewNode(current, viewChoices(treeViews), status.data, commitBased)
    if (node !== null && node !== current.node) {
      selectNode(node, current.nodeChosen && (current.node === WORKTREE || current.node === WORKING_COPY))
    }
  }, [allScope, commitBased, detailInteracting, repositoryReady, selectNode, status.data, treeViews])

  // Keep an all-range timeline in place when only its working states change.
  useEffect(() => {
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
  }, [historyKey])
  useEffect(() => {
    setLog(idleLog())
    logKeyRef.current = ''
  }, [historyScope])

  useEffect(() => () => {
    pageControllerRef.current?.abort()
    branchesControllerRef.current?.abort()
    abortDirectoryRequests()
  }, [abortDirectoryRequests])

  const lastHistoryScope = useRef<string | null>(null)
  const loadedHistoryLength = useRef(0)
  loadedHistoryLength.current = log.commits.length
  const validHistoryRange = baseCapabilities === null || !Array.isArray(baseCapabilities.ranges)
    || baseCapabilities.ranges.some(range => range.value === state.ref)
  // A background history read keeps the previous graph usable and replaces all
  // loaded pages together, so readers beyond the first page keep their place.
  useEffect(() => {
    if (!repositoryReady || waitingForRepositories || waitingForSnapshots || !validHistoryRange || logKeyRef.current === historyKey) return undefined
    const repo = state.repo
    if (repo === null) return undefined
    const controller = new AbortController()
    const signal = controller.signal
    const foreground = lastHistoryScope.current !== historyReadScope
    const resume = historyResumeRef.current
    const restoredLength = resume?.repo === repo && resume.ref === state.ref ? resume.length : 0
    const targetLength = Math.max(PAGE_SIZE, restoredLength, foreground ? 0 : loadedHistoryLength.current)
    setLog(previous => ({ ...previous, ...(foreground ? { status: 'loading', error: null } : {}), loadingMore: false }))
    async function readHistory(repoRoot: string) {
      const commits: CommitNode[] = []
      let stashes: StashEntry[] = []
      let stashesTruncated = false
      let worktreeHeads: WorktreeHeadRow[] | null = null
      let truncated = false
      let hasMore = false
      do {
        const boundary = commits.at(-1)
        const remaining = targetLength - commits.length
        const limit = boundary === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, remaining + 2)
        const page = await api.log(repoRoot, {
          ref: state.ref, worktrees: historyWorktrees, skip: boundary === undefined ? 0 : commits.length - 1, limit,
        }, signal)
        if (signal.aborted) return
        const heads: WorktreeHeadRow[] | null = Array.isArray(page?.worktreeHeads) ? page.worktreeHeads : null
        const rows: CommitNode[] = Array.isArray(page?.commits) ? page.commits : []
        if (boundary === undefined) {
          worktreeHeads = heads
          stashes = Array.isArray(page?.stashes) ? page.stashes : []
          stashesTruncated = page?.stashesTruncated === true
        }
        else if (rows[0]?.sha !== boundary.sha || JSON.stringify(heads) !== JSON.stringify(worktreeHeads)) {
          throw new ApiError('internal', 'The repository changed while reading history.', 409)
        }
        const results = boundary === undefined ? rows : rows.slice(1)
        commits.push(...results.slice(0, remaining))
        truncated = page?.truncated === true && results.length <= remaining
        hasMore = results.length > remaining || (rows.length >= limit && !truncated)
      } while (hasMore && commits.length < targetLength)
      if (historyResumeRef.current === resume) historyResumeRef.current = null
      logKeyRef.current = historyKey
      setLog({ status: 'ready', commits, stashes, stashesTruncated, worktreeHeads, error: null, truncated, hasMore, loadingMore: false })
    }
    readHistory(repo).catch(error => {
      if (failureOf(error).name === 'AbortError' || signal.aborted) return
      setLog(previous => ({ ...(foreground ? idleLog() : previous), status: 'error', error: failureOf(error) }))
    }).finally(() => {
      if (signal.aborted) return
      lastHistoryScope.current = historyReadScope
      setSettledHistoryKey(historyKey)
      if (foreground) setRefreshing(action => historyOnlyRefresh(action) ? null : action)
    })
    return () => { controller.abort() }
  }, [api, historyKey, historyReadScope, historyWorktrees, repositoryReady, state.repo, state.ref, validHistoryRange, waitingForRepositories, waitingForSnapshots])

  useVcsWatch({
    api,
    repo: repositoryReady ? state.repo : null,
    vcs: repositoryReady ? repoInfo?.vcs ?? null : null,
    pathsKey: repositoryReady ? statusReadPathsKey : '[]',
    visible: visible && settledRepositoriesKey !== null && sessionRef.current === sessionId,
    blocked: actions.repoBusy || hasOpenOverlay || refreshing !== null,
    repositories: settledRepositoriesKey !== repositoriesKey,
    working: repositoryReady && settledStatusKey !== statusKey,
    history: activityBusy || repositoryReady && validHistoryRange && settledHistoryKey !== historyKey,
    activity: activityBusy,
    onRefresh: refreshInBackground,
  })

  // A different Session may reuse this component instance; reload its state.
  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    const restored = loadState(sessionId)
    anchorRef.current = restored.anchor
    timelineScrollRef.current = restored.timelineScroll
    activityScrollRef.current = restored.activityScroll
    activityScrollOnReturn.current = false
    activityReading.current.clear()
    activityDiffCache.current.clear()
    activityDetailCache.current.clear()
    logKeyRef.current = ''
    setState(restored)
    setStatuses({})
    setSettledStatusKey(null)
    setLog(idleLog())
    setRepositories({ status: 'loading', list: [], truncated: false, worktreesTruncated: false, error: null })
    resetDirectories()
    setSingleView('timeline')
    setNotices(new Map())
    setRepositoryManagement(null)
    setTurnGraphs([])
    setTurnFilter(false)
    setTurnGraphUnavailable(false)
    consumedGraph.current = null
    overviewFocusRequestRef.current = null
    setOverviewPhase(restored.overview && !restored.tiled ? 'open' : 'closed')
    clearBranches()
    abortBranches()
    resetActionsUi()
    pendingPointerActionRef.current = null
    setTileTraversal(NO_TRAVERSAL)
    navZoneRef.current = 'timeline'
    pendingReadyFocusRef.current = false
    pendingRestoreFocusRef.current = false
    pendingDetailFocusRef.current = false
    perRepoRef.current.clear()
    createdWorktreesRef.current.clear()
    repositoryScrollRef.current.clear()
    historyResumeRef.current = null
    repositoryVcsRef.current.clear()
    diffCacheRef.current.clear()
    detailCacheRef.current.clear()
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
  }, [abortBranches, clearBranches, resetActionsUi, resetDirectories, sessionId])

  const availableTurnGraphs = useMemo(
    () => turnGraphs.filter(graph => repositories.list.some(entry => entry.path === graph.path)),
    [turnGraphs, repositories.list],
  )
  useEffect(() => {
    if (graphRevision !== 0) return
    setTurnGraphs(previous => previous.length === 0 ? previous : [])
    setTurnFilter(false)
    setTurnGraphUnavailable(false)
  }, [graphRevision])

  // A new tab navigation waits for fresh discovery, then consumes that revision
  // once. A background refresh must not undo any later manual repository choice.
  useEffect(() => {
    if (!visible || turnGraph === undefined || graphRevision === 0 || sessionRef.current !== sessionId
      || (consumedGraph.current?.sessionId === sessionId && consumedGraph.current.revision === graphRevision)
      || settledRepositoriesKey !== repositoriesKey || repositories.status !== 'ready') return
    consumedGraph.current = turnGraph
    const graphs = turnGraph.graphs.filter(graph => repositories.list.some(entry => entry.path === graph.path))
    setTurnGraphUnavailable(graphs.length < turnGraph.graphs.length)
    const choose = turnGraph.graphs.length > 1 && graphs.length > 0
    setTurnGraphs(choose ? turnGraph.graphs : [])
    setTurnFilter(choose)
    if (choose) {
      pendingReadyFocusRef.current = true
      if (stateRef.current.tiled) setTiled(false, true)
      else update({ overview: true })
    } else if (graphs.length === 1) {
      const entry = repositories.list.find(item => item.path === graphs[0].path)
      if (stateRef.current.tiled) setTiled(false, false)
      if (entry !== undefined && stateRef.current.repo !== entry.path) switchRepo(entry)
      update({ timelineScope: 'repository', ...(overviewNeedsDrawer && { overview: false }) })
      finishOverviewChoice(false, true)
      pendingReadyFocusRef.current = true
    }
  }, [finishOverviewChoice, graphRevision, overviewNeedsDrawer, repositories, repositoriesKey, sessionId,
    settledRepositoriesKey, setTiled, switchRepo, turnGraph, update, visible])

  const selectedRow = rowOf(rowIndex, state.node)
  const summaryIndex = state.node === null ? undefined : commitIndex.get(state.node)
  const summary = summaryIndex === undefined ? null : commits[summaryIndex] ?? null
  const hasTimelineRows = rows.length > 0
  const activeSelectedRow = allScope ? activityIndex : selectedRow
  const timelineSettled = allScope ? selectedActivity !== null || activity.status === 'ready' || activity.status === 'error'
    : hasTimelineRows || log.status === 'ready' || log.status === 'error'

  /**
   * Restore keyboard focus to the panel's active navigation stop without
   * scrolling the viewport.
   */
  const restoreNavFocus = useCallback((): boolean => {
    if (!visible || repositories.status !== 'ready' || stateRef.current.repo === null || missingTool) {
      return false
    }
    const wantTree = singleColumn ? singleView === 'detail' : navZoneRef.current === 'tree'
    if (wantTree) {
      if (detailControl.current?.restoreFocus() === true) {
        panelOwnsFocusRef.current = true
        navZoneRef.current = 'tree'
        return true
      }
      if (singleColumn || pendingDetailFocusRef.current) {
        if (rootRef.current === null) return false
        rootRef.current.focus({ preventScroll: true })
        panelOwnsFocusRef.current = true
        return true
      }
    }
    if (!showTimeline) return false
    if (timelineControl.current?.restoreFocus() !== true) return false
    panelOwnsFocusRef.current = true
    navZoneRef.current = 'timeline'
    return true
  }, [missingTool, repositories.status, showTimeline, singleColumn, singleView, visible])
  restoreNavFocusRef.current = restoreNavFocus

  // An explicit opening requests focus on the current repository. Discovery
  // is enough to land on that row; the pointer stream can still be pending.
  useLayoutEffect(() => {
    const request = overviewFocusRequestRef.current
    if (request === null || !overviewOpen || overviewPresentation !== 'open'
      || !visible || hasOpenOverlay || repositories.status === 'loading') return
    overviewFocusRequestRef.current = null
    const root = rootRef.current
    const active = root?.ownerDocument.activeElement
    if (active !== request.from && !canClaimFocusFrom(active, root)) return
    pendingRestoreFocusRef.current = false
    pendingReadyFocusRef.current = false
    overviewControl.current?.focusCurrent()
  })

  // Apply deferred navigation focus and recover synchronously when a render
  // unmounted the currently focused stop while the panel owned focus.
  useLayoutEffect(() => {
    if (pendingRestoreFocusRef.current) {
      pendingRestoreFocusRef.current = false
      if (visible && !hasOpenOverlay) restoreNavFocus()
      return
    }
    if (!visible || !panelOwnsFocusRef.current || hasOpenOverlay) return
    const doc = typeof document === 'undefined' ? null : document
    const active = doc?.activeElement ?? null
    if (active === null || active === doc?.body || active === doc?.documentElement) {
      if (canClaimFocusFrom(active, rootRef.current)) restoreNavFocus()
    }
  })

  // Keep timeline DOM focus aligned with the active row whenever a timeline
  // row holds focus (such as after range switches or status default updates).
  useLayoutEffect(() => {
    if (!visible || activeSelectedRow < 0 || !showTimeline || hasOpenOverlay) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active === null) return
    // A focused timeline row is an element carrying the row's `data-` index; the
    // DOM typings only promise an Element.
    const index = (active as HTMLElement).dataset.timelineIndex
    if (index === undefined) return
    if (!rootRef.current?.contains(active)) return
    if (index === String(activeSelectedRow)) return
    timelineControl.current?.restoreFocus()
  }, [activeSelectedRow, allScope, hasOpenOverlay, showTimeline, visible])

  // Once the panel settles after becoming visible or receiving an open
  // request, land focus on its active navigation stop unless another control owns it.
  useEffect(() => {
    if (!visible || !pendingReadyFocusRef.current) return
    // A Sidebar request waits two frames for the host to focus its pane.
    if (hostFocusPendingRef.current) return
    if (repositories.status === 'loading') return
    if (repositories.status === 'ready' && state.repo === null && repositories.list.length > 0) return
    const chooseTurnGraph = turnFilter && availableTurnGraphs.length > 0 && !state.tiled && overviewOpen
    if (repositories.status !== 'ready' || (!chooseTurnGraph && (state.repo === null || missingTool))) {
      pendingReadyFocusRef.current = false
      return
    }
    if ((overviewDrawer || chooseTurnGraph) ? overviewPresentation !== 'open' : showTimeline && !timelineSettled) return
    pendingReadyFocusRef.current = false
    if (hasOpenOverlay) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (!canClaimFocusFrom(active, rootRef.current)) return
    if (overviewDrawer || chooseTurnGraph) {
      if (overviewControl.current?.focus() === true) panelOwnsFocusRef.current = true
    } else restoreNavFocus()
  }, [
    availableTurnGraphs.length, focusRequest, focusTick, hasOpenOverlay, missingTool, overviewDrawer, overviewOpen,
    overviewPresentation, repositories.list.length, repositories.status, restoreNavFocus, showTimeline, state.repo,
    state.tiled, timelineSettled, graphRevision, turnFilter, visible,
  ])

  // Switching back to this window or browser tab finds keyboard navigation ready.
  useEffect(() => {
    if (!visible) return undefined
    const ensureReadyFocus = () => {
      if (hasOpenOverlay) return
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (findAncestor(active, rootRef.current, node => hasClass(node, 'vcs-overview')) !== null) return
      if (!canClaimFocusFrom(active, rootRef.current)) return
      if (!restoreNavFocus()) pendingReadyFocusRef.current = true
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ensureReadyFocus()
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('focus', ensureReadyFocus)
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', ensureReadyFocus)
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [hasOpenOverlay, restoreNavFocus, visible])

  /**
   * Load the local branches behind the header menu. Opening the menu again
   * reloads: branches are created and renamed outside the panel, and the
   * current one is part of the answer. The previous list stays visible while
   * the reload runs.
   */
  const loadBranches = useCallback(() => {
    const repo = stateRef.current.repo
    if (repo === null || loadingBranchesRef.current) return
    loadingBranchesRef.current = true
    branchesControllerRef.current?.abort()
    const controller = new AbortController()
    branchesControllerRef.current = controller
    setBranches(previous => ({ ...previous, status: 'loading', error: null }))
    api.branches(repo, controller.signal).then(answer => {
      if (controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      const list: BranchRow[] = Array.isArray(answer?.branches)
        ? answer.branches.filter(entry => entry !== null && typeof entry === 'object'
          && typeof entry.name === 'string' && entry.name !== '')
        : []
      setBranches({
        status: 'ready',
        list: list.map(entry => ({ name: entry.name, current: entry.current === true, occupied: entry.occupied === true })),
        truncated: answer?.truncated === true,
        error: null,
      })
    }).catch(error => {
      if (failureOf(error).name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setBranches(previous => ({ status: 'error', list: previous.list, truncated: false, error: failureOf(error) }))
    }).finally(() => {
      if (branchesControllerRef.current === controller) {
        branchesControllerRef.current = null
        loadingBranchesRef.current = false
      }
    })
  }, [api])

  /** Load the direct children of one untracked directory. */
  const expandUntracked = useCallback(async (key: string, path: string, silent = false) => {
    if (!repositoryReady || detailRoot === null || directoryRequestsRef.current.has(key)) return
    const controller = new AbortController()
    directoryRequestsRef.current.set(key, controller)
    attemptedDirsRef.current.set(key, backgroundDiffRevision)
    if (!silent) setLoadingDirs(previous => ({ ...previous, [key]: true }))
    try {
      const answer = await detailApi.untracked(detailRoot, path, controller.signal)
      if (controller.signal.aborted) return
      const entries: UntrackedChild[] = Array.isArray(answer.entries) ? answer.entries : []
      setDirChildren(previous => ({ ...previous, [key]: entries }))
      if (!silent && answer.truncated === true) {
        setNotice({ tone: 'error', text: formatPlural(t, 'changes.untrackedTruncated', entries.length, locale) })
      }
    } catch (error) {
      if (failureOf(error).name === 'AbortError' || controller.signal.aborted) return
      if (!silent) {
        update({ dirs: omit(stateRef.current.dirs, key) })
        setNotice({ tone: 'error', text: errorMessage(t, failureOf(error)) })
      }
    } finally {
      if (directoryRequestsRef.current.get(key) === controller) {
        directoryRequestsRef.current.delete(key)
        if (!silent) setLoadingDirs(previous => omit(previous, key))
      }
    }
  }, [backgroundDiffRevision, detailApi, detailRoot, repositoryReady, t, locale, update])

  // Revalidate visible untracked folders, including descendants from previously
  // loaded listings. A cached collapsed folder is revalidated when expanded.
  useEffect(() => {
    if (allScope || !showDetail || selectedWorktree === null || detailStatus.data === null) return
    const loadable = (detailStatus.data.groups?.untracked ?? [])
      .filter(entry => entry.directory === true).map(entry => dirKey('unstaged', entry.path))
    for (const key of Object.keys(state.dirs)) {
      if (!key.startsWith(UNSTAGED_PREFIX) || attemptedDirsRef.current.get(key) === backgroundDiffRevision) continue
      const ancestor = loadable.find(root => key === root || key.startsWith(`${root}/`))
      if (ancestor === undefined || state.dirs[ancestor] !== true) continue
      const cached = dirChildren[key] !== undefined
      const parent = key.slice(0, key.lastIndexOf('/'))
      if (!cached && key !== ancestor && !dirChildren[parent]?.some(entry => dirKey('unstaged', entry.path) === key)) continue
      const segments = key.slice(ancestor.length + 1).split('/').slice(0, -1)
      if (segments.some((_, index) => state.dirs[`${ancestor}/${segments.slice(0, index + 1).join('/')}`] !== true)) continue
      void expandUntracked(key, `${key.slice(UNSTAGED_PREFIX.length)}/`, cached)
    }
  }, [allScope, backgroundDiffRevision, detailStatus.data, dirChildren, expandUntracked, loadingDirs, selectedWorktree, showDetail, state.dirs])

  /** Toggle a group or directory row; an untracked directory loads on open. */
  const toggleRow = useCallback((row: DirRow | GroupRow) => {
    const key = row.key
    if (row.kind === 'dir' && row.loadable === true) {
      if (row.expanded) {
        update({ dirs: omit(stateRef.current.dirs, key) })
        return
      }
      update({ dirs: { ...stateRef.current.dirs, [key]: true } })
      if (dirChildren[key] === undefined && loadingDirs[key] !== true) void expandUntracked(key, row.path)
      return
    }
    if (row.expanded) update({ collapsed: { ...stateRef.current.collapsed, [key]: true } })
    else update({ collapsed: omit(stateRef.current.collapsed, key) })
  }, [dirChildren, expandUntracked, loadingDirs, update])

  /** Fold or unfold one diff section against its default. */
  const toggleFold = useCallback((key: string, folded: boolean) => {
    update({ folds: { ...stateRef.current.folds, [key]: folded } })
  }, [update])

  /** Choose the node on one timeline row. */
  const selectRow = useCallback((index: number) => {
    const node = nodeAt(rows, index)
    if (node === null) return
    panelOwnsFocusRef.current = true
    if (singleColumn) {
      navZoneRef.current = 'tree'
      pendingRestoreFocusRef.current = true
      selectNode(node, true)
      pendingDetailFocusRef.current = true
      setSingleView('detail')
      return
    }
    navZoneRef.current = 'timeline'
    pendingRestoreFocusRef.current = true
    selectNode(node, true)
  }, [rows, selectNode, singleColumn])

  /** Keyboard movement along the timeline; the selection follows the cursor. */
  const moveTimeline = useCallback((delta: number) => {
    const maxIndex = rows.length - 1
    if (maxIndex < 0) return
    const base = selectedRow < 0 ? 0 : selectedRow
    const next = Math.max(0, Math.min(maxIndex, base + delta))
    const node = nodeAt(rows, next)
    if (node === null) return
    panelOwnsFocusRef.current = true
    navZoneRef.current = 'timeline'
    const sameNode = node === stateRef.current.node && stateRef.current.nodeChosen
    pendingRestoreFocusRef.current = !sameNode
    selectNode(node, true)
    if (sameNode) timelineControl.current?.restoreFocus()
  }, [rows, selectNode, selectedRow])

  const selectActivity = useCallback((row: ActivityStop) => {
    panelOwnsFocusRef.current = true
    pendingDetailFocusRef.current = false
    pendingRestoreFocusRef.current = true
    navZoneRef.current = 'timeline'
    update({ activitySelected: row.key, activityEntry: entryKey(row.entry) })
    setActivityScrollRequest(value => value + 1)
  }, [update])

  const toggleActivity = useCallback((key: string, returnToEvent: boolean) => {
    const index = activityModel.rowIndex.get(key)
    const event = index === undefined ? undefined : activityModel.rows[index]
    if (event?.kind !== 'burst' && event?.kind !== 'batch') return
    setState(previous => ({
      ...previous,
      activityExpanded: previous.activityExpanded.includes(key)
        ? previous.activityExpanded.filter(value => value !== key) : expandActivity(previous.activityExpanded, key),
    }))
    if (returnToEvent) selectActivity(event)
  }, [activityModel, selectActivity])

  /** Move the keyboard into the selected node's files, or wait while they load. */
  const openDetail = useCallback((activityStop?: ActivityStop) => {
    panelOwnsFocusRef.current = true
    if (!allScope && selectedRow < 0 && hasTimelineRows) {
      const first = nodeAt(rows, 0)
      if (first !== null) selectNode(first, true)
    }
    const newActivity = activityStop !== undefined && activityStop.key !== selectedActivity?.key
    if (newActivity) update({ activitySelected: activityStop.key, activityEntry: entryKey(activityStop.entry) })
    pendingDetailFocusRef.current = true
    if (singleColumn) {
      navZoneRef.current = 'tree'
      pendingRestoreFocusRef.current = true
      setSingleView('detail')
      return
    }
    if (newActivity) return
    if (detailControl.current?.focusNav() === true) {
      pendingDetailFocusRef.current = false
      navZoneRef.current = 'tree'
      return
    }
    if (detailControl.current?.isSettled() === true) {
      pendingDetailFocusRef.current = false
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pendingDetailFocusRef.current) return
        if (detailControl.current?.focusNav() === true) {
          pendingDetailFocusRef.current = false
          navZoneRef.current = 'tree'
        } else if (detailControl.current?.isSettled() === true) {
          pendingDetailFocusRef.current = false
        }
      })
    })
  }, [allScope, rows, hasTimelineRows, selectNode, selectedActivity?.key, selectedRow, singleColumn, update])

  /** Complete a deferred detail focus once the selected node's rows arrive. */
  const onDetailSettled = useCallback((hasRows: boolean) => {
    if (!pendingDetailFocusRef.current) return
    pendingDetailFocusRef.current = false
    if (!hasRows) {
      if (!singleColumn) navZoneRef.current = 'timeline'
      return
    }
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (!canClaimFocusFrom(active, rootRef.current)) return
    if (detailControl.current?.focusNav() === true) {
      panelOwnsFocusRef.current = true
      navZoneRef.current = 'tree'
    }
  }, [singleColumn])

  /** Return the keyboard to the timeline, closing the single-column detail. */
  const leaveDetail = useCallback(() => {
    pendingDetailFocusRef.current = false
    panelOwnsFocusRef.current = true
    navZoneRef.current = 'timeline'
    if (singleColumn) {
      pendingRestoreFocusRef.current = true
      setSingleView('timeline')
      return
    }
    if (!restoreNavFocus()) pendingRestoreFocusRef.current = true
  }, [restoreNavFocus, singleColumn])

  /**
   * Show the timeline beside the changes, or one column at a time. Putting the
   * timeline away on a wide panel leaves the selected node's changes in front:
   * reading them is what wants the width. A narrow panel already shows one
   * column, so only the stored preference changes there.
   */
  const setTwoColumns = useCallback((next: boolean) => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const keepButtonFocus = active !== null
      && rootRef.current?.contains(active) === true
      && isDiscreteActionButton(active, rootRef.current)
    if (!next && !narrow) {
      if (allScope ? selectedActivity !== null : stateRef.current.node !== null) {
        navZoneRef.current = 'tree'
        if (!keepButtonFocus) {
          pendingDetailFocusRef.current = true
          pendingRestoreFocusRef.current = true
        }
        setSingleView('detail')
      } else {
        navZoneRef.current = 'timeline'
        if (!keepButtonFocus) pendingRestoreFocusRef.current = true
        setSingleView('timeline')
      }
    } else if (panelOwnsFocusRef.current && !keepButtonFocus) {
      pendingRestoreFocusRef.current = true
    }
    update({ twoColumns: next })
  }, [allScope, narrow, selectedActivity, update])

  /** Jump to a loaded commit named in the detail, such as a parent. */
  const selectCommit = useCallback((sha: string) => {
    panelOwnsFocusRef.current = true
    if (singleColumn) {
      navZoneRef.current = 'tree'
      pendingRestoreFocusRef.current = true
      selectNode(sha, true)
      pendingDetailFocusRef.current = true
      setSingleView('detail')
      return
    }
    navZoneRef.current = 'timeline'
    pendingRestoreFocusRef.current = true
    selectNode(sha, true)
  }, [selectNode, singleColumn])

  const selectedActivityRepo = selectedActivity?.entry.repo
  const isActivityCommitLoaded = (sha: string) => selectedActivityRepo !== undefined
    && activityModel.eventOfEntry(activityCommitKey(selectedActivityRepo, sha)) !== undefined
  const selectActivityParent = (sha: string) => {
    if (selectedActivityRepo === undefined) return
    const entry = activityCommitKey(selectedActivityRepo, sha)
    const event = activityModel.eventOfEntry(entry)
    if (event === undefined) return
    const index = activityModel.rowIndex.get(event)
    const row = index === undefined ? undefined : activityModel.rows[index]
    panelOwnsFocusRef.current = true
    pendingRestoreFocusRef.current = true
    pendingDetailFocusRef.current = singleColumn
    navZoneRef.current = singleColumn ? 'tree' : 'timeline'
    setState(previous => ({
      ...previous, activitySelected: entry, activityEntry: entry,
      activityExpanded: row?.kind === 'batch' || row?.kind === 'burst'
        ? expandActivity(previous.activityExpanded, event) : previous.activityExpanded,
    }))
    if (showTimeline) setActivityScrollRequest(value => value + 1)
    else activityScrollOnReturn.current = true
  }

  useEffect(() => {
    if (!allScope || !showTimeline || state.tiled || !activityScrollOnReturn.current) return
    activityScrollOnReturn.current = false
    setActivityScrollRequest(value => value + 1)
  }, [allScope, showTimeline, state.tiled])

  // Read through a ref so the detail's request effects do not restart on every status answer.
  const fallbackNodeRef = useRef<string | null>(null)
  fallbackNodeRef.current = preferredViewNode(
    { ...state, node: null, nodeChosen: false },
    viewChoices(treeViews),
    status.data,
    commitBased,
  ) ?? treeViews[0]?.id ?? null

  /** A selected commit or stash vanished: fall back to the default. */
  const onMissing = useCallback(() => {
    if (stashSha(stateRef.current.node) !== null) refreshInBackground(['history'])
    selectNode(fallbackNodeRef.current, false)
  }, [refreshInBackground, selectNode])

  useEffect(() => {
    if (allScope || selectedStashSha === null || !repositoryReady || hasOpenOverlay || detailInteracting) return
    if (baseCapabilities?.stashOps !== true
      || (currentHistory && log.status === 'ready' && !log.stashesTruncated && selectedStash === undefined)) {
      selectNode(fallbackNodeRef.current, false)
    }
  }, [allScope, baseCapabilities, currentHistory, detailInteracting, hasOpenOverlay, log.stashesTruncated, log.status,
    repositoryReady, selectedStash, selectedStashSha, selectNode])

  const onReading = useCallback((anchor: ReadingAnchor | null) => {
    anchorRef.current = anchor
    persistSoon()
  }, [persistSoon])

  /** Load the next history page. */
  const loadMore = useCallback(async () => {
    if (state.repo === null || log.loadingMore || !log.hasMore || !currentHistory || waitingForSnapshots) return
    const repo = state.repo
    const ref = state.ref
    pageControllerRef.current?.abort()
    const controller = new AbortController()
    pageControllerRef.current = controller
    setLog(previous => ({ ...previous, loadingMore: true }))
    try {
      const page = await api.log(repo, { ref, worktrees: historyWorktrees, skip: log.commits.length, limit: PAGE_SIZE }, controller.signal)
      if (controller.signal.aborted || historyKeyRef.current !== historyKey) return
      if (JSON.stringify(page?.worktreeHeads ?? null) !== JSON.stringify(log.worktreeHeads)) {
        setLog(previous => ({ ...previous, loadingMore: false }))
        refreshInBackground(['history'])
        return
      }
      const nextCommits = Array.isArray(page?.commits) ? page.commits : []
      setLog(previous => ({
        ...previous,
        loadingMore: false,
        commits: [...previous.commits, ...nextCommits],
        truncated: page?.truncated === true,
        hasMore: nextCommits.length >= PAGE_SIZE && page?.truncated !== true,
      }))
    } catch (error) {
      if (failureOf(error).name === 'AbortError' || controller.signal.aborted) return
      if (historyKeyRef.current !== historyKey) return
      setLog(previous => ({ ...previous, loadingMore: false }))
      setNotice({ tone: 'error', text: errorMessage(t, failureOf(error)) })
    } finally {
      if (pageControllerRef.current === controller) pageControllerRef.current = null
    }
  }, [api, currentHistory, historyKey, historyWorktrees, log.commits.length, log.worktreeHeads, log.hasMore, log.loadingMore, refreshInBackground, state.repo, state.ref, t, waitingForSnapshots])

  // A pointer or restored stash outside the loaded history: keep loading its base.
  useEffect(() => {
    if (allScope) return
    const node = pendingRevealRef.current
      ?? (selectedStash !== undefined && log.hasMore && selectedRow < 0 ? state.node : null)
    if (node === null) return
    if (state.node !== node || rowIndex.has(node)) {
      pendingRevealRef.current = null
      return
    }
    if (!currentHistory || log.status !== 'ready' || log.loadingMore) return
    if (log.hasMore) {
      pendingRevealRef.current = node
      void loadMore()
      return
    }
    pendingRevealRef.current = null
    setNotice({ tone: 'info', text: t('overview.beyondHistory') })
  }, [allScope, currentHistory, loadMore, log.hasMore, log.loadingMore, log.status, rowIndex, selectedRow, selectedStash, state.node, setNotice, t])

  // Open the menu or act directly once the pointer's repository is current and read.
  useEffect(() => {
    const pending = pendingPointerActionRef.current
    if (pending === null) return
    const { request } = pending
    const { pointer } = request
    if (pending.sessionId !== sessionId || state.repo !== pointer.repo
      || (request.kind === 'direct' && (!state.tiled || tileTraversal.focus !== pointer.id))) {
      pendingPointerActionRef.current = null
      return
    }
    if (actionStatus.status === 'error') {
      pendingPointerActionRef.current = null
      setNotice({ tone: 'error', text: errorMessage(t, actionStatus.error) }, pointer.repo)
      return
    }
    const actionPath = tileAnchorActions ? state.repo : statusPath
    if (actionStatus.status !== 'ready' || actionStatus.data?.repo?.path !== actionPath || baseCapabilities === null) return
    pendingPointerActionRef.current = null
    if (request.kind === 'direct') {
      const view = viewByPath.get(pointer.repo)
      const latest = view?.pointers.find(item => item.id === pointer.id)
      const offered = view === undefined || latest === undefined ? undefined
        : tileDirectActions(latest, view, baseCapabilities, actions.inFlight.get(pointer.repo), repoInfo ?? undefined)
          .find(item => item.action.kind === request.action.kind)
      if (offered === undefined || offered.disabledReason !== undefined || !actions.openAction(offered.action, request.restore)) {
        setNotice({ tone: 'info', text: t(offered?.disabledReason ?? 'tile.actionUnavailable') }, pointer.repo)
        return
      }
      // A write can turn a loud column quiet. Keep it open for the result and
      // for the pointer (or header) that will receive keyboard focus.
      const expanded = stateRef.current.tileExpanded
      if (!expanded.includes(pointer.repo)) update({ tileExpanded: [...expanded, pointer.repo] })
      return
    }
    const { point, element } = request
    if (pointer.kind === 'stash') {
      const stash = stashPointerTarget(pointer)
      if (stash !== null) actions.openStashActions(stash, point, element)
    } else if (pointer.kind === 'detached' || baseCapabilities.workingCopy === 'commit') {
      const tree = worktrees.find(item => item.path === pointer.occupant?.path)
      if (tree !== undefined) {
        actions.openWorktreeActions(tree, repoInfo?.enclosing === true ? state.repo : null, point, () => { element?.focus({ preventScroll: true }) })
      }
    } else if (pointer.kind === 'branch') {
      actions.openBranchActions({ kind: 'branch', name: pointer.name, current: actionStatus.data.branch?.name === pointer.name }, point, element)
    } else if (pointer.kind === 'remote' && typeof pointer.remote === 'string' && typeof pointer.branch === 'string') {
      actions.openBranchActions({ kind: 'remote', name: pointer.name, remote: pointer.remote, branch: pointer.branch }, point, element)
    }
  }, [actions, actionStatus, baseCapabilities, pointerRequestTick, repoInfo, sessionId, setNotice, state.repo, state.tiled,
    statusPath, t, tileAnchorActions, tileTraversal.focus, update, viewByPath, worktrees])

  /** Keep focus on the active navigation stop across primary clicks on discrete buttons. */
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button !== 0) return
    if (hasOpenOverlay) return
    if (!isDiscreteActionButton(event.target, rootRef.current)) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active !== null && rootRef.current?.contains(active)) {
      event.preventDefault()
    }
  }

  /** Restore navigation focus after pointer clicks on non-editable panel controls or blank space. */
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || hasOpenOverlay) return
    if (event.detail === 0) return
    if (isEditableTarget(event.target)) return
    if (isOverlayOrMenuTarget(event.target, rootRef.current)) return
    if (isNavigationStop(event.target, rootRef.current)) {
      if (zoneOf(event.target, rootRef.current) === 'tree') navZoneRef.current = 'tree'
      return
    }
    if (isDiscreteActionButton(event.target, rootRef.current)) {
      restoreNavFocus()
      return
    }
    const selection = typeof window === 'undefined' ? null : window.getSelection?.()
    if (selection !== null && selection !== undefined && selection.isCollapsed === false && String(selection) !== '') {
      panelOwnsFocusRef.current = true
      const zone = zoneOf(event.target, rootRef.current)
      if (zone !== null) navZoneRef.current = zone
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active === null || !rootRef.current?.contains(active)) {
        rootRef.current?.focus({ preventScroll: true })
      }
      return
    }
    const zone = zoneOf(event.target, rootRef.current)
    if (zone !== null) navZoneRef.current = zone
    else if (findAncestor(event.target, rootRef.current, node => hasClass(node, 'vcs-sidebar')) !== null) {
      navZoneRef.current = 'timeline'
    }
    restoreNavFocus()
  }

  /**
   * Keys of the overview and the tiled layout: `T` tiles, `/` searches the open
   * overview, `←` in the timeline returns to it; while tiled, `1`–`7` step
   * through a state (Shift steps back), `n` continues, `←`/`→` move along the
   * columns, `Enter` opens the focused pointer in the timeline, and `Esc` first
   * clears the traversal, then leaves the tiled layout.
   * @param event - the key event at the panel root.
   * @returns whether the key was handled.
   */
  const handleLayoutKey = (event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    if (event.key === 't' || event.key === 'T') {
      setTiled(!state.tiled)
      return handled()
    }
    if (event.key === '/' && overviewOpen) {
      overviewControl.current?.focusSearch()
      return handled()
    }
    if (state.tiled) {
      const digit = /^Digit([1-7])$/u.exec(event.code ?? '')
      const insideList = findAncestor(event.target, rootRef.current, node => hasClass(node, 'vcs-tile-body')) !== null
      if (digit !== null) {
        stepTraversal(FILTERS[Number(digit[1]) - 1], event.shiftKey ? -1 : 1)
        return handled()
      }
      if ((event.key === 'n' || event.key === 'N') && tileTraversal.filter !== null) {
        stepTraversal(tileTraversal.filter, event.shiftKey ? -1 : 1)
        return handled()
      }
      if (event.key === 'Escape') {
        if (tileTraversal.filter !== null) setTileTraversal(previous => ({ ...previous, filter: null, index: -1 }))
        else setTiled(false)
        return handled()
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !insideList) {
        tiledControl.current?.scrollColumns(event.key === 'ArrowRight' ? 1 : -1)
        return handled()
      }
      if (event.key === 'Enter' && tileTraversal.focus !== null) {
        const onOtherButton = findAncestor(event.target, rootRef.current, node => (
          typeof node?.tagName === 'string' && node.tagName.toUpperCase() === 'BUTTON' && !hasClass(node, 'vcs-pointer-chip')
        )) !== null
        if (onOtherButton) return false
        const pointer = tileColumns.flatMap(column => column.view?.pointers ?? []).find(item => item.id === tileTraversal.focus)
        if (pointer !== undefined) openFromTile(pointer.repo, pointer)
        return handled()
      }
      // The stacked timeline is not mounted while tiled.
      return event.key !== 'Tab'
    }
    if (overviewOpen && movement(event) === BACK && zoneOf(event.target, rootRef.current) !== 'tree'
      && !(singleColumn && singleView === 'detail') && navZoneRef.current === 'timeline') {
      if (overviewControl.current?.focus() === true) {
        pendingReadyFocusRef.current = false
        return handled()
      }
    }
    return false
  }

  /** Route navigation keys from the panel root, buttons, or divider back to the active zone. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // React's synthetic keyboard event carries `isComposing` at runtime although
    // its declaration does not expose it.
    const composing = (event as ReactKeyboardEvent<HTMLDivElement> & { isComposing?: boolean }).isComposing
    if (event.defaultPrevented || composing === true || isEditableTarget(event.target) || hasOpenOverlay) return
    if (isOverlayTarget(event.target, rootRef.current)) return
    if (handleLayoutKey(event)) return
    if (isOverlayOrMenuTarget(event.target, rootRef.current)) {
      if (event.key === 'Escape') {
        event.preventDefault()
        restoreNavFocus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return
      if (movement(event) === null && rowStep(event) === 0) return
    }
    if (zoneOf(event.target, rootRef.current) !== null) {
      if (singleColumn && singleView === 'detail' && (event.key === 'Escape' || movement(event) === BACK)) {
        event.preventDefault()
        leaveDetail()
      }
      return
    }
    const onButton = findAncestor(event.target, rootRef.current, node => (
      typeof node?.tagName === 'string' && node.tagName.toUpperCase() === 'BUTTON'
    )) !== null
    if (onButton && (event.key === 'Enter' || event.key === ' ')) return
    if (event.key === 'Escape' && event.target !== rootRef.current && !(singleColumn && singleView === 'detail')) {
      event.preventDefault()
      restoreNavFocus()
      return
    }
    if (singleColumn && singleView === 'detail') {
      if (detailControl.current?.handleKeyDown(event) === true) return
      if (event.key === 'Escape' || movement(event) === BACK) {
        event.preventDefault()
        leaveDetail()
      }
      return
    }
    const wantTree = !singleColumn && navZoneRef.current === 'tree'
    if (wantTree) {
      if (detailControl.current?.handleKeyDown(event) === true) return
      if (showTimeline && timelineControl.current?.handleKeyDown(event) === true) return
      return
    }
    if (showTimeline && timelineControl.current?.handleKeyDown(event) === true) return
    if (!singleColumn && showDetail) detailControl.current?.handleKeyDown(event)
  }

  /** Drag the sidebar divider. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic or already-released pointer simply skips capture.
    }
    dragRef.current = { x: event.clientX, width: state.sidebarWidth }
  }
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return
    update({ sidebarWidth: clampWidth(dragRef.current.width + event.clientX - dragRef.current.x) })
  }
  const stopResize = (): void => { dragRef.current = null }

  const discoveryToolMissing = repositories.error?.code === 'vcs-missing'

  const missingToolMessage = missingTool ? (
    <div className="vcs-center">
      <p className="vcs-empty-title">{t('error.vcsMissing')}</p>
      <p className="vcs-note">{t('error.vcsMissingHint')} {errorMessage(t, status.error)}</p>
      <button type="button" className="vcs-button" onClick={() => { refresh() }}>{t('error.retry')}</button>
    </div>
  ) : null

  const activeTimeline = allScope ? (
    <ActivityTimeline
      key={sessionId} model={activityModel} entries={activityEntries} repositories={activityRepos} selectedRow={activityIndex}
      onSelect={selectActivity} onOpen={openDetail} onReveal={revealActivity} onToggle={toggleActivity} singleColumn={singleColumn}
      control={timelineControl} t={t} locale={locale}
      loading={activity.status === 'idle' || activity.status === 'loading'} loadingMore={activity.loadingMore}
      error={activity.error} failures={activity.failures} hasMore={activity.next !== null} capped={activity.capped}
      onLoadMore={activity.loadMore} onRetry={() => { activity.refresh() }}
      initialScrollTop={activityScrollRef.current} scrollRequest={activityScrollRequest}
      onScrollOffset={top => { activityScrollRef.current = top; persistSoon() }}
    />
  ) : missingToolMessage ?? (
    <Timeline
      key={historyScope}
      rows={rows}
      layout={layout}
      worktrees={worktreeRows}
      selectedRow={selectedRow}
      onSelectRow={selectRow}
      onMove={moveTimeline}
      onOpen={openDetail}
      control={timelineControl}
      t={t}
      locale={locale}
      loading={log.status === 'loading' || waitingForSnapshots || (log.error !== null && settledHistoryKey !== historyKey)}
      loadingMore={log.loadingMore}
      error={log.error}
      hasMore={log.hasMore}
      truncated={log.truncated}
      stashesTruncated={baseCapabilities?.stashOps === true && log.stashesTruncated}
      onLoadMore={() => { void loadMore() }}
      canLoadMore={currentHistory && !waitingForSnapshots}
      onRetry={() => { refreshInBackground(['history']) }}
      onRefActions={timelineRefActions}
      onCommitActions={timelineCommitActions}
      onStashActions={timelineStashActions}
      initialScrollTop={timelineScrollRef.current}
      onScrollOffset={top => {
        timelineScrollRef.current = top
        persistSoon()
      }}
    />
  )

  return (
    <div
      ref={rootRef}
      className="vcs-root"
      data-narrow={narrow ? 'true' : undefined}
      data-single-column={singleColumn ? 'true' : undefined}
      data-overview={overviewPresentation === 'closed' ? undefined : overviewPresentation}
      data-overview-drawer={overviewPresentation !== 'closed' && overviewNeedsDrawer ? 'true' : undefined}
      data-tiled={state.tiled ? 'true' : undefined}
      data-tile-transition={tileTransition !== null || undefined}
      style={overviewPresentation === 'closed' ? undefined : { '--vcs-overview-width': `${state.overviewWidth}px` } as CSSProperties}
      tabIndex={-1}
      onFocus={event => {
        panelOwnsFocusRef.current = true
        const zone = zoneOf(event.target, rootRef.current)
        if (zone !== null) navZoneRef.current = zone
      }}
      onBlur={event => {
        if (event.relatedTarget !== null && event.relatedTarget !== undefined && !rootRef.current?.contains(event.relatedTarget)) {
          panelOwnsFocusRef.current = false
        }
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <TopBar
        repository={repoInfo}
        cwd={repositories.cwd}
        worktrees={worktrees}
        checkedPaths={checkedPaths}
        onToggleWorktree={toggleCheckedWorktree}
        onCreateWorktree={actions.openWorktreeCreate}
        onWorktreeActions={actions.openWorktreeActions}
        repoBusy={actions.repoBusy}
        worktreeBusy={actions.worktreeBusy || refreshing === 'worktree'}
        sessionPath={repoInfo?.enclosing === true ? state.repo : null}
        status={checkedPaths.length > 1 ? null : status.data}
        capabilities={capabilities}
        refMode={state.ref}
        onRefMode={ref => { update({ ref }) }}
        onRefresh={refreshPanel}
        refreshing={allScope ? activity.status === 'loading' || refreshing === 'repositories' : refreshing === 'refresh'}
        revalidating={Object.values(statuses).some(entry => entry.status === 'refreshing')}
        onSync={() => { void actions.sync() }}
        syncing={actions.syncing || refreshing === 'sync'}
        staging={actions.staging || refreshing === 'stage'}
        branches={branches.list}
        branchesStatus={branches.status}
        branchesError={branches.error}
        branchesTruncated={branches.truncated}
        onLoadBranches={loadBranches}
        onSwitchBranch={branch => { void actions.switchBranch(branch) }}
        onBranchActions={actions.openBranchActions}
        onRestoreFocus={() => { if (!restoreNavFocus()) pendingReadyFocusRef.current = true }}
        switching={actions.switching}
        branchBusy={actions.branchBusy}
        tagBusy={actions.tagBusy}
        commitBusy={actions.commitBusy}
        notice={notice?.domain === 'worktree' ? null : notice}
        twoColumns={state.twoColumns}
        twoColumnsFit={!narrow}
        onTwoColumns={setTwoColumns}
        overviewOpen={overviewOpen}
        onOverview={toggleOverview}
        allRepositoryCount={allScope ? repositories.list.length : null}
        tiled={state.tiled}
        onTile={() => { setTiled(!state.tiled) }}
        tileControls={state.tiled ? (
          <StateButtons
            counts={tileCounts}
            filter={tileTraversal.filter}
            index={tileTraversal.index}
            total={tileHits.length}
            order={state.tileOrder}
            onStep={stepTraversal}
            onOrder={tileOrder => { update({ tileOrder }) }}
            t={t}
          />
        ) : null}
        t={t}
        locale={locale}
      />
      <div className="vcs-body">
        {overviewPresentation === 'closed' ? null : (
          <OverviewPane
            data={overviewData}
            repositories={repositories.list}
            views={overviewViews}
            cwd={overviewCwd}
            currentRepo={allScope ? null : state.repo}
            turnGraphs={availableTurnGraphs}
            turnRevision={consumedGraph.current?.revision}
            turnFilter={turnFilter && availableTurnGraphs.length > 0}
            onTurnFilter={setTurnFilter}
            allRepositories={repositories.list.length >= 2 ? { active: allScope, count: repositories.list.length } : null}
            onSelectAll={selectAllRepositories}
            selected={selectedPointer}
            width={state.overviewWidth}
            onResize={overviewWidth => { update({ overviewWidth }) }}
            onSelectRepository={selectOverviewRepository}
            onSelectPointer={revealPointer}
            onPointerActions={openPointerActions}
            onManageRepositories={restoreFocus => { setRepositoryManagement({ sessionId, restoreFocus }) }}
            writes={actions.inFlight}
            notices={notices}
            onSync={path => { void actions.syncRepository(path) }}
            control={overviewControl}
            t={t}
            locale={locale}
          />
        )}
        {!state.tiled && notice?.domain === 'worktree' ? (
          <p className="vcs-note vcs-worktree-path" role="status">{notice.text}</p>
        ) : null}
        {graphRevision > 0 && consumedGraph.current?.revision !== graphRevision
          && settledRepositoriesKey !== repositoriesKey && repositories.status === 'ready' ? (
          <p className="vcs-note" role="status">{t('loading.repositories')}</p>
        ) : null}
        {(turnGraphUnavailable || (turnFilter && availableTurnGraphs.length < turnGraphs.length)) && repositories.status === 'ready' ? (
          <p className="vcs-note" role="status">{t('turn.graphUnavailable')}</p>
        ) : null}
        {repositories.truncated ? <p className="vcs-note">{formatPlural(t, 'repositories.truncated', repositories.list.length, locale)}</p> : null}
        {repositories.worktreesTruncated ? <p className="vcs-note">{t('repositories.worktreesTruncated')}</p> : null}
        {repositories.configError ? (
          <p className="vcs-note" role="alert">{errorMessage(t, { code: repositories.configError })}</p>
        ) : null}
        {repositories.status === 'error' ? (
          <div className="vcs-center">
            <p className="vcs-empty-title">{discoveryToolMissing ? t('error.vcsMissing') : t('repositories.error')}</p>
            <p className="vcs-note">{discoveryToolMissing ? t('error.vcsMissingHint') : errorMessage(t, repositories.error)}</p>
            <button type="button" className="vcs-button" onClick={refreshPanel}>{t('error.retry')}</button>
          </div>
        ) : repositories.status === 'loading' ? (
          // Nothing is known yet, not even the backend: draw both columns as
          // they will be, so the panel settles in place instead of popping in.
          <div className="vcs-main">
            <section
              className="vcs-sidebar vcs-sidebar-loading"
              style={singleColumn ? undefined : { width: `${state.sidebarWidth}px` }}
            >
              <TimelineSkeleton rowHeight={ROW_HEIGHT} label={t('loading.repositories')} />
            </section>
            {singleColumn ? null : <section className="vcs-content"><TreeSkeleton /></section>}
          </div>
        ) : state.repo === null ? (
          <div className="vcs-center">
            <p className="vcs-empty-title">{t('empty.repository')}</p>
            <p className="vcs-note">{t('empty.repositoryHint')}</p>
          </div>
        ) : state.tiled ? (
          <div className="vcs-main vcs-main-tiled">
            <TiledView
              columns={tileColumns}
              cwd={overviewCwd}
              currentRepo={allScope ? null : state.repo}
              expanded={state.tileExpanded}
              filter={tileTraversal.filter}
              focus={tileTraversal.focus}
              narrow={narrow}
              inFlight={actions.inFlight}
              notices={notices}
              onFocusPointer={focusTilePointer}
              onOpenTimeline={(path, pointer) => { openFromTile(path, pointer) }}
              onExpand={path => { update({ tileExpanded: [...state.tileExpanded.filter(item => item !== path), path] }) }}
              onCollapse={path => { update({ tileExpanded: state.tileExpanded.filter(item => item !== path) }) }}
              onPointerActions={openPointerActions}
              onDirectAction={(pointer, action, restore) => { requestPointerAction({ kind: 'direct', pointer, action, restore }) }}
              control={tiledControl}
              t={t}
              locale={locale}
            />
          </div>
        ) : (
          <div className="vcs-main">
            {showTimeline ? (
              <section className="vcs-sidebar" style={singleColumn ? undefined : { width: `${state.sidebarWidth}px` }}>
                {activeTimeline}
              </section>
            ) : null}
            {!singleColumn ? (
              <div
                className="vcs-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('panel.resize')}
                aria-valuenow={state.sidebarWidth}
                aria-valuemin={SIDEBAR_MIN}
                aria-valuemax={SIDEBAR_MAX}
                tabIndex={0}
                onPointerDown={startResize}
                onPointerMove={resize}
                onPointerUp={stopResize}
                onPointerCancel={stopResize}
                onKeyDown={event => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  update({ sidebarWidth: clampWidth(state.sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16)) })
                }}
              />
            ) : null}
            {showDetail ? (
              <section className="vcs-content">
                {allScope ? (
                  selectedActivity === null || activityRepo === undefined
                    ? activityBusy || activity.status === 'idle' ? <TreeSkeleton label={t('changes.loading')} /> : null
                    : <ActivityDetail
                        key={selectedActivity.key} row={selectedActivity} repository={activityRepo} memory={activityReading.current}
                        onReveal={revealActivity} api={api} split={state.split} wrap={state.wrap}
                        onToggleSplit={split => { update({ split }) }} onToggleWrap={wrap => { update({ wrap }) }}
                        singleColumn={singleColumn} onBack={leaveDetail} onLeaveNav={leaveDetail}
                        onSelectCommit={selectActivityParent} isLoaded={isActivityCommitLoaded} onSettled={onDetailSettled}
                        revision={activity.revision} cache={activityDiffCache.current} detailCache={activityDetailCache.current}
                        control={detailControl} t={t} locale={locale}
                      />
                ) : missingTool ? (singleColumn ? missingToolMessage : null)
                  : detailNode === null || state.node === WORKTREE || state.node === WORKING_COPY
                  || (selectedStashSha !== null && baseCapabilities?.stashOps !== true)
                  || (worktreePath(state.node) !== null && selectedTree === null) ? (
                  commitBased && selectedTree !== null && detailStatus.status === 'error'
                    ? <p className="vcs-note" role="alert">{t('changes.error')} {errorMessage(t, detailStatus.error)}</p>
                    : <TreeSkeleton label={t('changes.loading')} />
                ) : (
                  <DetailPane
                    key={`${state.repo}|${state.node}`}
                    api={detailApi}
                    repo={detailRoot as string}
                    node={detailNode}
                    worktree={selectedWorktree}
                    workingCopies={summary?.workingCopies ?? (commitBased && selectedTree !== null ? [selectedTree] : NO_WORKTREE_ROWS)}
                    snapshotError={commitBased && selectedTree !== null && detailStatus.status === 'error' ? detailStatus.error : null}
                    showCurrentHead={showCurrentHead}
                    summary={summary}
                    stashEntry={selectedStash ?? null}
                    status={detailStatus.data}
                    statusState={detailStatus.status as DetailStatusState}
                    statusError={detailStatus.error}
                    dirChildren={dirChildren}
                    loadingDirs={loadingDirs}
                    dirs={state.dirs}
                    collapsed={state.collapsed}
                    onToggleDir={toggleRow}
                    folds={state.folds}
                    onToggleFold={toggleFold}
                    onSetFolds={folds => { update({ folds }) }}
                    split={state.split}
                    wrap={state.wrap}
                    onToggleSplit={split => { update({ split }) }}
                    onToggleWrap={wrap => { update({ wrap }) }}
                    mergeStaging={state.mergeStaging}
                    onToggleStageLayout={(mergeStaging, anchor, folds) => {
                      anchorRef.current = anchor
                      update({ mergeStaging, anchor, folds })
                    }}
                    singleColumn={singleColumn}
                    onBack={leaveDetail}
                    onLeaveNav={leaveDetail}
                    onSelectCommit={selectCommit}
                    isLoaded={sha => commitIndex.has(sha)}
                    onMissing={onMissing}
                    onSettled={onDetailSettled}
                    revision={selectedStashSha !== null ? stashRevision : selectedTree === null ? manual.history : revision}
                    backgroundDiffRevision={selectedTree === null ? undefined : backgroundDiffRevision}
                    onInteractionChange={setDetailInteracting}
                    cache={diffCacheRef.current}
                    detailCache={detailCacheRef.current}
                    initialAnchor={anchorRef.current}
                    onReading={onReading}
                    control={detailControl}
                    capabilities={capabilities}
                    onStage={canStage ? actions.stage : undefined}
                    onStageHistory={canStage ? actions.stageHistory : undefined}
                    onSaveStash={canStage && capabilities?.stashOps === true ? actions.openStashSave : undefined}
                    onStashActions={timelineStashActions}
                    stageDisabled={actions.repoBusy || refreshing !== null || detailStatus.status !== 'ready'}
                    onRefActions={capabilities?.branchOps === true || capabilities?.tagOps === true
                      ? actions.onRefActions
                      : undefined}
                    t={t}
                    locale={locale}
                  />
                )}
              </section>
            ) : null}
          </div>
        )}
      </div>
      {manageCurrentRepositories ? (
        <RepositoryConfigDialog
          api={api}
          cwd={repositories.cwd}
          repositories={repositories.list}
          onCancel={closeRepositoryManagement}
          onSaved={() => {
            closeRepositoryManagement()
            refresh('repositories')
          }}
          t={t}
        />
      ) : null}
      <RefActionsMenu
        target={actions.menu}
        busy={actions.repoBusy}
        t={t}
        onChoose={actions.chooseMenuAction}
        onClose={actions.closeMenu}
      />
      {actions.dialog === null ? null : actions.dialog.domain === 'branch' ? (
        <BranchDialog
          key={`${actions.dialog.kind}:${actions.dialog.branch}`}
          request={actions.dialog}
          error={actions.dialogError}
          busy={actions.dialogWriting}
          blocked={actions.repoBusy && !actions.dialogWriting}
          onCancel={actions.cancelDialog}
          onConfirm={actions.confirmDialog}
          t={t}
        />
      ) : actions.dialog.domain === 'tag' ? (
        <TagDialog
          key={`${actions.dialog.kind}:${actions.dialog.tag}`}
          request={actions.dialog}
          error={actions.dialogError}
          busy={actions.dialogWriting}
          blocked={actions.repoBusy && !actions.dialogWriting}
          remotes={actions.tagRemotes}
          onCancel={actions.cancelDialog}
          onConfirm={actions.confirmDialog}
          t={t}
          locale={locale}
        />
      ) : actions.dialog.domain === 'worktree' ? (
        <WorktreeDialog
          key={`${actions.dialog.repo}:${actions.dialog.kind}`}
          request={actions.dialog}
          error={actions.dialogError}
          busy={actions.dialogWriting}
          blocked={actions.repoBusy && !actions.dialogWriting}
          branches={branches.list.filter(branch => !branch.current && !branch.occupied
            && !worktrees.some(tree => tree.branch === branch.name))}
          branchesStatus={branches.status}
          branchesError={branches.error}
          branchesTruncated={branches.truncated}
          loadBranches={loadBranches}
          onCancel={actions.cancelDialog}
          onConfirm={actions.confirmWorktree}
          t={t}
        />
      ) : actions.dialog.domain === 'stash' ? (
        <StashDialog
          key={actions.dialog.kind === 'push' ? actions.dialog.repo : `${actions.dialog.kind}:${actions.dialog.stash.sha}`}
          api={api}
          request={actions.dialog}
          error={actions.dialogError}
          busy={actions.dialogWriting}
          blocked={actions.repoBusy && !actions.dialogWriting}
          onCancel={actions.cancelDialog}
          onConfirm={actions.confirmStash}
          onBranch={actions.branchFromStash}
          onClearError={actions.clearDialogError}
          onMissing={refreshMissingStash}
          t={t}
          locale={locale}
        />
      ) : (
        <CommitDialog
          key={`${actions.dialog.kind}:${actions.dialog.sha}`}
          request={actions.dialog}
          error={actions.dialogError}
          busy={actions.dialogWriting}
          blocked={actions.repoBusy && !actions.dialogWriting}
          onCancel={actions.cancelDialog}
          onConfirm={actions.confirmDialog}
          t={t}
        />
      )}
    </div>
  )
}
