/**
 * The version control panel, drawn as a right-Sidebar tab.
 *
 * One Session, one repository, one timeline (checked worktrees, then shared
 * commits) and one detail pane for the selected node. Host data is read
 * through `api.js`; this component owns request lifecycle, selection, paging,
 * layout, and the sessionStorage-backed state. `focusRequest` signals that the
 * Sidebar opened or revealed the pane, so it can refresh and prepare keyboard
 * navigation.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createApi } from './api.js'
import {
  loadState, nodePatch, saveState, SIDEBAR_MAX, SIDEBAR_MIN, WORKING_COPY, WORKTREE, worktreeNode, worktreePath,
} from './state.js'
import {
  attachWorkingCopies, checkedWorktrees, preferredViewNode, repositoryWorktrees, sharedRefs,
  toggleWorktree, workingCopyLabel, worktreeRefLabel,
} from './worktrees.js'
import {
  errorMessage, formatPlural,
} from './format.js'
import {
  BACK, canClaimFocusFrom, findAncestor, hasAttr, hasClass, isDiscreteActionButton, isEditableTarget,
  isNavigationStop, isOverlayOrMenuTarget, isOverlayTarget, movement, rowStep, zoneOf,
} from './keys.js'
import { dirKey } from './detail/tree.js'
import { buildGraph } from './history/layout.js'
import { indexCommits } from './history/commits.js'
import { graphInput, nodeAt, pickRepository, rowOf } from './history/timeline.js'
import { ROW_HEIGHT, Timeline } from './history/Timeline.jsx'
import { DetailPane } from './detail/DetailPane.jsx'
import { TopBar } from './TopBar.jsx'
import { RefActionsMenu } from './RefActionsMenu.jsx'
import { BranchDialog } from './BranchDialogs.jsx'
import { TagDialog } from './TagDialog.jsx'
import { CommitDialog } from './CommitDialog.jsx'
import { useRepoActions } from './useRepoActions.js'
import { TimelineSkeleton, TreeSkeleton } from './skeleton.jsx'

/** Rows per history page. */
const PAGE_SIZE = 300
/** Limit concurrent reads for backends that don't snapshot into a shared store. */
const STATUS_CONCURRENCY = 4
/** Below this width the panel shows one column at a time, whatever the preference. */
const NARROW_WIDTH = 760
/** Width of the divider between the timeline and the detail. */
const RESIZER_WIDTH = 5

/** Row-key prefix of the unstaged group, where untracked directories load. */
const UNSTAGED_PREFIX = 'unstaged|'

/** Empty status answer. */
const IDLE_STATUS = Object.freeze({ status: 'idle', data: null, error: null })
const NO_WORKTREE_ROWS = Object.freeze([])

/** Empty history answer. */
function idleLog() {
  return { status: 'idle', commits: [], worktreeHeads: null, error: null, truncated: false, hasMore: false, loadingMore: false }
}

function samePaths(a, b) {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/** Clamp a sidebar width. */
function clampWidth(value) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value))
}

/** Copy a record without one key. */
function omit(record, key) {
  const next = { ...(record ?? {}) }
  delete next[key]
  return next
}

/**
 * Render the version control panel for one Session.
 * @param {{ sessionId: string, t: Function, locale?: string, visible?: boolean, focusRequest?: number }} props - standard Sidebar tab props plus the active UI locale, visibility, and a one-shot request to land keyboard focus in the panel.
 */
export function VcsView({
  sessionId, t, locale, visible = true, focusRequest = 0,
}) {
  const [state, setState] = useState(() => loadState(sessionId))
  const stateRef = useRef(state)
  stateRef.current = state
  // Live reading positions: written on every scroll, persisted lazily.
  const anchorRef = useRef(state.anchor)
  const timelineScrollRef = useRef(state.timelineScroll)
  const persistTimer = useRef(null)

  const api = useMemo(() => createApi(sessionId), [sessionId])
  const [repositories, setRepositories] = useState({ status: 'loading', list: [], truncated: false, worktreesTruncated: false, error: null })
  const [statuses, setStatuses] = useState({})
  const [settledStatusKey, setSettledStatusKey] = useState(null)
  const [log, setLog] = useState(idleLog)
  const [revision, setRevision] = useState(0)
  // The action whose refresh is waiting for status, including 'auto' on activation.
  const [refreshing, setRefreshing] = useState(null)
  const [width, setWidth] = useState(0)
  // The column the single-column layout shows: 'timeline' or 'detail'.
  const [singleView, setSingleView] = useState('timeline')
  const [dirChildren, setDirChildren] = useState({})
  const [loadingDirs, setLoadingDirs] = useState({})
  // The top bar's message, right of the branch and sync: `{ tone: 'error' | 'info', text }`.
  const [notice, setNotice] = useState(null)
  // Local branches for the header menu, loaded when the menu opens.
  const [branches, setBranches] = useState({ status: 'idle', list: [], truncated: false, error: null })
  // Bumped after the Sidebar host focuses its pane, so the settle effect retries.
  const [focusTick, setFocusTick] = useState(0)

  const rootRef = useRef(null)
  const sessionRef = useRef(sessionId)
  const logKeyRef = useRef('')
  const dragRef = useRef(null)
  const attemptedDirsRef = useRef(new Set())
  const directoryRequestsRef = useRef(new Map())
  const perRepoRef = useRef(new Map())
  const pageControllerRef = useRef(null)
  const branchesControllerRef = useRef(null)
  const loadingBranchesRef = useRef(false)
  const diffCacheRef = useRef(new Map())
  const commitCacheRef = useRef(new Map())
  const timelineControl = useRef(null)
  const detailControl = useRef(null)
  const navZoneRef = useRef('timeline')
  const panelOwnsFocusRef = useRef(false)
  const pendingReadyFocusRef = useRef(false)
  const pendingRestoreFocusRef = useRef(false)
  const pendingDetailFocusRef = useRef(false)
  const restoreNavFocusRef = useRef(() => false)
  // A focus request waits for the Sidebar host to focus its pane first.
  const hostFocusPendingRef = useRef(false)

  const narrow = width > 0 && width < NARROW_WIDTH
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
  const statusPathsKey = JSON.stringify(checkedPaths.length > 0 ? checkedPaths : state.repo === null ? [] : [state.repo])
  const statusKey = JSON.stringify([state.repo, revision, statusPathsKey])
  const statusPath = checkedPaths[0] ?? state.repo
  const status = statuses[statusPath] ?? IDLE_STATUS
  const missingTool = status.status === 'error' && status.error?.code === 'vcs-missing'
  const showCurrentHead = checkedPaths.length === 0 || (checkedPaths.length === 1 && checkedPaths[0] === state.repo)
  const baseCapabilities = repoInfo?.capabilities ?? status.data?.capabilities ?? null
  const commitBased = baseCapabilities?.workingCopy === 'commit'
  const snapshots = baseCapabilities?.snapshots === true
  const waitingForSnapshots = snapshots && settledStatusKey !== statusKey
  const capabilities = useMemo(() => showCurrentHead || baseCapabilities === null ? baseCapabilities : {
    ...baseCapabilities, sync: false, branchSwitch: false, branchOps: false, tagOps: false, commitOps: false, stageOps: false,
  }, [baseCapabilities, showCurrentHead])
  const siblingApi = useMemo(() => createApi(sessionId, { worktreeOf: state.repo }), [sessionId, state.repo])
  // In selected scope send the full checked set, except for the anchor alone.
  // Snapshotting backends also send it in all scope so the request doesn't
  // snapshot an unchecked anchor in order to read the repository-wide graph.
  const historyPathsKey = !showCurrentHead && (state.ref !== 'all' || snapshots) ? statusPathsKey : '[]'
  const historyWorktrees = useMemo(() => JSON.parse(historyPathsKey), [historyPathsKey])
  const historyScope = JSON.stringify([state.repo, state.ref, state.ref === 'all' ? [] : historyWorktrees])
  const historyKey = JSON.stringify([historyScope, revision, snapshots ? statusPathsKey : null])
  const historyKeyRef = useRef(historyKey)
  historyKeyRef.current = historyKey
  const currentHistory = logKeyRef.current === historyKey
  const treeViews = useMemo(() => {
    const heads = new Map(log.worktreeHeads?.map(tree => [tree.path, tree.head]))
    const anchorCopy = commitBased ? log.commits.find(commit => commit.workingCopy === true)?.sha : undefined
    return checkedTrees.map(tree => {
      const reading = statuses[tree.path] ?? IDLE_STATUS
      const branch = reading.data?.branch
      let head
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
  const commits = useMemo(() => {
    if (commitBased) return attachWorkingCopies(log.commits, workspaceViews)
    if (showCurrentHead) return log.commits
    return log.commits.map(commit => ({ ...commit, refs: sharedRefs(commit.refs ?? []) }))
  }, [commitBased, log.commits, showCurrentHead, workspaceViews])
  const worktreeRows = commitBased ? NO_WORKTREE_ROWS : treeViews
  const selectedTree = treeViews.find(tree => tree.id === state.node) ?? null
  const selectedWorktree = commitBased ? null : selectedTree
  // Jujutsu commit contents live in the shared store. Use the same immutable
  // revision for both detail and diff, without reading another checkout.
  const detailNode = commitBased && selectedTree !== null ? selectedTree.head : state.node
  const detailRoot = selectedWorktree?.path ?? state.repo
  const detailApi = detailRoot === state.repo ? api : siblingApi
  const detailStatus = selectedTree === null ? status : statuses[selectedTree.path] ?? IDLE_STATUS
  const canStage = capabilities?.stageOps === true && selectedWorktree?.path === state.repo
  const anchorHead = showCurrentHead ? worktreeRows[0]?.head ?? null : null
  const graphWorktreesKey = JSON.stringify(worktreeRows.map(({ id, head }) => ({ id, head })))
  const layout = useMemo(
    () => buildGraph(graphInput(commits, JSON.parse(graphWorktreesKey))),
    [commits, graphWorktreesKey],
  )
  const commitIndex = useMemo(
    () => indexCommits(commits),
    [commits],
  )

  /** The state as it should be stored, including the live reading positions. */
  const persisted = useCallback(() => ({
    ...stateRef.current,
    anchor: anchorRef.current,
    timelineScroll: timelineScrollRef.current,
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
    pendingReadyFocusRef.current = true
    hostFocusPendingRef.current = true
    if (focusRequest > 0) {
      navZoneRef.current = singleColumn && singleView === 'detail' ? 'tree' : 'timeline'
    }
    let second
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
    const onPointerDown = event => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
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
    saveState(sessionId, persisted())
  }, [persisted, sessionId, state])

  /** Update a slice of persisted state. */
  const update = useCallback(patch => {
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
  const selectNode = useCallback((node, chosen) => {
    if (chosen) pendingDetailFocusRef.current = false
    const patch = nodePatch(stateRef.current, node, chosen)
    if ('anchor' in patch) anchorRef.current = null
    if ('dirs' in patch) resetDirectories()
    if (Object.keys(patch).length > 0) update(patch)
  }, [resetDirectories, update])

  /**
   * Refresh repositories, status, history, and every open comparison.
   * `requester` identifies the action that owns the progress indicator.
   */
  const refresh = useCallback((requester = 'refresh') => {
    setRefreshing(requester)
    if (requester !== 'auto') setNotice(null)
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
    resetDirectories()
    diffCacheRef.current.clear()
    commitCacheRef.current.clear()
    setRevision(value => value + 1)
  }, [resetDirectories])

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
    commitCacheRef.current.clear()
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

  const actions = useRepoActions({
    api,
    sessionId,
    repo: showCurrentHead ? state.repo : null,
    stateRef,
    sessionRef,
    statusData: status.data,
    capabilities,
    commits,
    commitIndex,
    head: anchorHead,
    rootRef,
    onRestoreFocus: () => {
      if (!restoreNavFocusRef.current()) pendingReadyFocusRef.current = true
    },
    t,
    locale,
    refresh,
    resetReadingForNewHead,
    setNotice,
    clearBranches,
    abortBranches,
  })
  const { resetActionsUi } = actions
  const hasOpenOverlay = actions.menu !== null || actions.dialog !== null

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

  /** Remember one repository's selection and restore the next one's. */
  const switchRepo = useCallback(entry => {
    const nextRepo = entry?.path ?? null
    const nextCapabilities = entry?.capabilities
    pendingDetailFocusRef.current = false
    navZoneRef.current = 'timeline'
    const current = stateRef.current
    if (current.repo !== null && current.repo !== nextRepo) {
      perRepoRef.current.set(current.repo, {
        node: current.node,
        nodeChosen: current.nodeChosen,
        worktrees: current.worktrees,
        dirs: current.dirs,
        collapsed: current.collapsed,
        ref: current.ref,
      })
    }
    const saved = nextRepo === null ? undefined : perRepoRef.current.get(nextRepo)
    const ranges = Array.isArray(nextCapabilities?.ranges) ? nextCapabilities.ranges : null
    const savedRef = saved?.ref
    const ref = ranges?.some(range => range.value === savedRef)
      ? savedRef
      : (nextCapabilities?.defaultRange ?? 'HEAD')
    setStatuses({})
    setSingleView('timeline')
    setNotice(null)
    resetDirectories()
    diffCacheRef.current.clear()
    commitCacheRef.current.clear()
    abortBranches()
    clearBranches()
    resetActionsUi()
    anchorRef.current = null
    timelineScrollRef.current = 0
    update({
      repo: nextRepo,
      worktrees: checkedWorktrees(repositoryWorktrees(entry), saved?.worktrees ?? []).map(tree => tree.path),
      node: saved?.node ?? null,
      nodeChosen: saved?.nodeChosen ?? false,
      dirs: saved?.dirs ?? {},
      collapsed: saved?.collapsed ?? {},
      folds: {},
      anchor: null,
      ref,
    })
  }, [abortBranches, clearBranches, resetActionsUi, resetDirectories, update])

  /** Change only the view. No operation may infer a write target from a checked set. */
  const toggleCheckedWorktree = path => {
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

  // Repositories: reload on mount and refresh.
  useEffect(() => {
    const controller = new AbortController()
    setRepositories(previous => ({ ...previous, status: previous.list.length === 0 ? 'loading' : 'ready', error: null }))
    api.repositories(controller.signal).then(answer => {
      if (controller.signal.aborted) return
      const list = Array.isArray(answer?.repositories) ? answer.repositories : []
      setRepositories({ status: 'ready', list, truncated: answer?.truncated === true, worktreesTruncated: answer?.worktreesTruncated === true, error: null })
      const previousRepo = stateRef.current.repo
      const nextEntry = pickRepository(list, previousRepo)
      const nextRepo = nextEntry?.path ?? null
      if (nextRepo !== previousRepo) switchRepo(nextEntry)
      else {
        const previous = stateRef.current.worktrees
        const checked = checkedWorktrees(repositoryWorktrees(nextEntry), previous).map(tree => tree.path)
        if (!samePaths(checked, previous)) update({ worktrees: checked })
      }
      if (list.length === 0) setRefreshing(null)
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      setRepositories({ status: 'error', list: [], truncated: false, worktreesTruncated: false, error })
      setRefreshing(null)
    })
    return () => { controller.abort() }
  }, [api, revision, switchRepo, update])

  // Snapshotting backends serialize refreshes of the shared store so working
  // copies don't create concurrent operations in the same repository.
  useEffect(() => {
    if (!repositoryReady) return undefined
    const controller = new AbortController()
    const paths = JSON.parse(statusPathsKey)
    if (snapshots) setSettledStatusKey(null)
    setStatuses(previous => Object.fromEntries(paths.map(path => {
      const data = previous[path]?.data ?? null
      return [path, { status: data === null ? 'loading' : 'refreshing', data, error: null }]
    })))
    let cursor = 0
    async function readStatus() {
      while (!controller.signal.aborted && cursor < paths.length) {
        const path = paths[cursor++]
        const reader = path === state.repo ? api : siblingApi
        try {
          const data = await reader.status(path, controller.signal)
          if (controller.signal.aborted) return
          setStatuses(previous => ({ ...previous, [path]: { status: 'ready', data, error: null } }))
        } catch (error) {
          if (error?.name === 'AbortError' || controller.signal.aborted) return
          setStatuses(previous => ({ ...previous, [path]: { status: 'error', data: previous[path]?.data ?? null, error } }))
        }
      }
    }
    const concurrency = snapshots ? 1 : STATUS_CONCURRENCY
    Promise.all(Array.from({ length: Math.min(paths.length, concurrency) }, readStatus)).then(() => {
      if (controller.signal.aborted) return
      if (snapshots) setSettledStatusKey(statusKey)
      setRefreshing(null)
    })
    return () => { controller.abort() }
  }, [api, repositoryReady, siblingApi, snapshots, state.repo, statusKey, statusPathsKey])

  useEffect(() => {
    if (!repositoryReady) return
    const current = stateRef.current
    const node = preferredViewNode(current, treeViews, status.data, commitBased)
    if (node !== null && node !== current.node) {
      selectNode(node, current.nodeChosen && (current.node === WORKTREE || current.node === WORKING_COPY))
    }
  }, [commitBased, repositoryReady, selectNode, status.data, treeViews])

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

  // First history page, invalidated by refresh.
  useEffect(() => {
    if (!repositoryReady || waitingForSnapshots) return undefined
    if (baseCapabilities !== null && Array.isArray(baseCapabilities.ranges) && !baseCapabilities.ranges.some(range => range.value === state.ref)) return undefined
    if (logKeyRef.current === historyKey) return undefined
    const controller = new AbortController()
    let settled = false
    setLog(previous => ({ ...previous, status: 'loading', loadingMore: false, error: null }))
    api.log(state.repo, { ref: state.ref, worktrees: historyWorktrees, skip: 0, limit: PAGE_SIZE }, controller.signal).then(page => {
      if (controller.signal.aborted) return
      settled = true
      logKeyRef.current = historyKey
      const commits = Array.isArray(page?.commits) ? page.commits : []
      setLog({
        status: 'ready',
        commits,
        worktreeHeads: Array.isArray(page?.worktreeHeads) ? page.worktreeHeads : null,
        error: null,
        truncated: page?.truncated === true,
        hasMore: commits.length >= PAGE_SIZE && page?.truncated !== true,
        loadingMore: false,
      })
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      logKeyRef.current = ''
      setLog({ ...idleLog(), status: 'error', error })
    })
    return () => {
      controller.abort()
      if (!settled && logKeyRef.current === historyKey) logKeyRef.current = ''
    }
  }, [api, baseCapabilities, historyKey, historyWorktrees, repositoryReady, state.repo, state.ref, waitingForSnapshots])

  const handledFocusRequest = useRef(focusRequest)
  const canAutoRefresh = useRef(false)
  canAutoRefresh.current = visible && !actions.repoBusy && refreshing === null
    && repositories.status !== 'loading'
    && !Object.values(statuses).some(entry => entry.status === 'loading' || entry.status === 'refreshing')

  // The first mount already loads the data. On later activations, group the
  // pane, window, and document events that can accompany a single focus change.
  useEffect(() => {
    const opened = handledFocusRequest.current !== focusRequest
    handledFocusRequest.current = focusRequest
    if (!visible) return undefined
    let frame = null
    const queueRefresh = () => {
      if (frame !== null || !canAutoRefresh.current || document.visibilityState !== 'visible') return
      frame = requestAnimationFrame(() => {
        frame = null
        if (canAutoRefresh.current && document.visibilityState === 'visible') refresh('auto')
      })
    }
    const onFocusIn = ({ target, relatedTarget }) => {
      // A missing origin can be focus restoration after a render or window switch.
      if (relatedTarget == null) return
      const root = rootRef.current
      const pane = findAncestor(root, null, node => (
        hasAttr(node, 'data-dockkit-pane') || hasAttr(node, 'data-dockkit-float')
      )) ?? root
      if (pane?.contains(target) && !pane.contains(relatedTarget)) queueRefresh()
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('visibilitychange', queueRefresh)
    window.addEventListener('focus', queueRefresh)
    if (opened) queueRefresh()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('visibilitychange', queueRefresh)
      window.removeEventListener('focus', queueRefresh)
    }
  }, [focusRequest, refresh, sessionId, visible])

  // A different Session may reuse this component instance; reload its state.
  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    const restored = loadState(sessionId)
    anchorRef.current = restored.anchor
    timelineScrollRef.current = restored.timelineScroll
    logKeyRef.current = ''
    setState(restored)
    setStatuses({})
    setSettledStatusKey(null)
    setLog(idleLog())
    setRepositories({ status: 'loading', list: [], truncated: false, worktreesTruncated: false, error: null })
    resetDirectories()
    setSingleView('timeline')
    setNotice(null)
    clearBranches()
    abortBranches()
    resetActionsUi()
    navZoneRef.current = 'timeline'
    pendingReadyFocusRef.current = false
    pendingRestoreFocusRef.current = false
    pendingDetailFocusRef.current = false
    perRepoRef.current.clear()
    diffCacheRef.current.clear()
    commitCacheRef.current.clear()
    pageControllerRef.current?.abort()
    pageControllerRef.current = null
  }, [abortBranches, clearBranches, resetActionsUi, resetDirectories, sessionId])

  const selectedRow = rowOf(commitIndex, state.node, worktreeRows)
  const summary = commits[commitIndex.get(state.node)] ?? null
  const hasTimelineRows = worktreeRows.length > 0 || commits.length > 0
  const timelineSettled = hasTimelineRows || log.status === 'ready' || log.status === 'error'

  /**
   * Restore keyboard focus to the panel's active navigation stop without
   * scrolling the viewport.
   */
  const restoreNavFocus = useCallback(() => {
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
    if (showTimeline && timelineControl.current?.restoreFocus() === true) {
      panelOwnsFocusRef.current = true
      navZoneRef.current = 'timeline'
      return true
    }
    return false
  }, [missingTool, repositories.status, showTimeline, singleColumn, singleView, visible])
  restoreNavFocusRef.current = restoreNavFocus

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
    if (!visible || selectedRow < 0 || !showTimeline || hasOpenOverlay) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active === null || active?.dataset?.timelineIndex === undefined) return
    if (!rootRef.current?.contains(active)) return
    if (active.dataset.timelineIndex === String(selectedRow)) return
    timelineControl.current?.restoreFocus()
  }, [hasOpenOverlay, selectedRow, showTimeline, visible])

  // Once the panel settles after becoming visible or receiving an open
  // request, land focus on its active navigation stop unless another control owns it.
  useEffect(() => {
    if (!visible || !pendingReadyFocusRef.current) return
    // A Sidebar request waits two frames for the host to focus its pane.
    if (hostFocusPendingRef.current) return
    if (repositories.status === 'loading') return
    if (repositories.status === 'ready' && state.repo === null && repositories.list.length > 0) return
    if (repositories.status !== 'ready' || state.repo === null || missingTool) {
      pendingReadyFocusRef.current = false
      return
    }
    if (showTimeline && !timelineSettled) return
    pendingReadyFocusRef.current = false
    if (hasOpenOverlay) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (!canClaimFocusFrom(active, rootRef.current)) return
    restoreNavFocus()
  }, [
    focusRequest, focusTick, hasOpenOverlay, missingTool, repositories.list.length,
    repositories.status, restoreNavFocus, showTimeline, state.repo, timelineSettled, visible,
  ])

  // Switching back to this window or browser tab finds keyboard navigation ready.
  useEffect(() => {
    if (!visible) return undefined
    const ensureReadyFocus = () => {
      if (hasOpenOverlay) return
      const active = typeof document === 'undefined' ? null : document.activeElement
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
      const list = Array.isArray(answer?.branches)
        ? answer.branches.filter(entry => entry !== null && typeof entry === 'object'
          && typeof entry.name === 'string' && entry.name !== '')
        : []
      setBranches({
        status: 'ready',
        list: list.map(entry => ({ name: entry.name, current: entry.current === true })),
        truncated: answer?.truncated === true,
        error: null,
      })
    }).catch(error => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setBranches(previous => ({ status: 'error', list: previous.list, truncated: false, error }))
    }).finally(() => {
      if (branchesControllerRef.current === controller) {
        branchesControllerRef.current = null
        loadingBranchesRef.current = false
      }
    })
  }, [api])

  /** Load the direct children of one untracked directory. */
  const expandUntracked = useCallback(async (key, path) => {
    if (!repositoryReady || detailRoot === null || directoryRequestsRef.current.has(key)) return
    const controller = new AbortController()
    directoryRequestsRef.current.set(key, controller)
    attemptedDirsRef.current.add(key)
    setLoadingDirs(previous => ({ ...previous, [key]: true }))
    try {
      const answer = await detailApi.untracked(detailRoot, path, controller.signal)
      if (controller.signal.aborted) return
      const entries = Array.isArray(answer.entries) ? answer.entries : []
      setDirChildren(previous => ({ ...previous, [key]: entries }))
      if (answer.truncated === true) {
        setNotice({ tone: 'error', text: formatPlural(t, 'changes.untrackedTruncated', entries.length, locale) })
      }
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      update({ dirs: omit(stateRef.current.dirs, key) })
      setNotice({ tone: 'error', text: errorMessage(t, error) })
    } finally {
      if (directoryRequestsRef.current.get(key) === controller) {
        directoryRequestsRef.current.delete(key)
        setLoadingDirs(previous => omit(previous, key))
      }
    }
  }, [detailApi, detailRoot, repositoryReady, t, locale, update])

  // Re-open persisted untracked directories once their repository's status is
  // known. The directories live in the unstaged group now; a path that is no
  // longer an untracked directory is simply dropped.
  useEffect(() => {
    if (selectedWorktree === null || detailStatus.data === null) return
    const loadable = new Set(
      (detailStatus.data.groups?.untracked ?? [])
        .filter(entry => entry.directory === true)
        .map(entry => dirKey('unstaged', entry.path)),
    )
    for (const key of Object.keys(state.dirs)) {
      if (!key.startsWith(UNSTAGED_PREFIX)) continue
      if (!loadable.has(key)) continue
      if (dirChildren[key] !== undefined || loadingDirs[key] === true) continue
      if (attemptedDirsRef.current.has(key)) continue
      void expandUntracked(key, `${key.slice(UNSTAGED_PREFIX.length)}/`)
    }
  }, [selectedWorktree, state.dirs, detailStatus.data, dirChildren, loadingDirs, expandUntracked])

  /** Toggle a group or directory row; an untracked directory loads on open. */
  const toggleRow = useCallback(row => {
    const key = row.key
    if (row.loadable === true) {
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
  const toggleFold = useCallback((key, folded) => {
    update({ folds: { ...stateRef.current.folds, [key]: folded } })
  }, [update])

  /** Choose the node on one timeline row. */
  const selectRow = useCallback(index => {
    const node = nodeAt(commits, index, { worktrees: worktreeRows })
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
  }, [commits, selectNode, singleColumn, worktreeRows])

  /** Keyboard movement along the timeline; the selection follows the cursor. */
  const moveTimeline = useCallback(delta => {
    const maxIndex = commits.length + worktreeRows.length - 1
    if (maxIndex < 0) return
    const base = selectedRow < 0 ? 0 : selectedRow
    const next = Math.max(0, Math.min(maxIndex, base + delta))
    const node = nodeAt(commits, next, { worktrees: worktreeRows })
    if (node === null) return
    panelOwnsFocusRef.current = true
    navZoneRef.current = 'timeline'
    const sameNode = node === stateRef.current.node && stateRef.current.nodeChosen
    pendingRestoreFocusRef.current = !sameNode
    selectNode(node, true)
    if (sameNode) timelineControl.current?.restoreFocus()
  }, [commits, selectNode, selectedRow, worktreeRows])

  /** Move the keyboard into the selected node's files, or wait while they load. */
  const openDetail = useCallback(() => {
    panelOwnsFocusRef.current = true
    if (selectedRow < 0 && hasTimelineRows) {
      const first = nodeAt(commits, 0, { worktrees: worktreeRows })
      if (first !== null) selectNode(first, true)
    }
    pendingDetailFocusRef.current = true
    if (singleColumn) {
      navZoneRef.current = 'tree'
      pendingRestoreFocusRef.current = true
      setSingleView('detail')
      return
    }
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
  }, [commits, hasTimelineRows, selectNode, selectedRow, singleColumn, worktreeRows])

  /** Complete a deferred detail focus once the selected node's rows arrive. */
  const onDetailSettled = useCallback(hasRows => {
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
  const setTwoColumns = useCallback(next => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const keepButtonFocus = active !== null
      && rootRef.current?.contains(active) === true
      && isDiscreteActionButton(active, rootRef.current)
    if (!next && !narrow) {
      if (stateRef.current.node !== null) {
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
  }, [narrow, update])

  /** Jump to a loaded commit named in the detail, such as a parent. */
  const selectCommit = useCallback(sha => {
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

  // Read through a ref so the detail's request effects do not restart on every status answer.
  const fallbackNodeRef = useRef(null)
  fallbackNodeRef.current = preferredViewNode({ ...state, node: null, nodeChosen: false }, treeViews, status.data, commitBased)
    ?? treeViews[0]?.id ?? null

  /** A selected commit vanished (amend, rebase): fall back to the default. */
  const onMissing = useCallback(() => {
    selectNode(fallbackNodeRef.current, false)
  }, [selectNode])

  const onReading = useCallback(anchor => {
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
        refresh()
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
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (historyKeyRef.current !== historyKey) return
      setLog(previous => ({ ...previous, loadingMore: false }))
      setNotice({ tone: 'error', text: errorMessage(t, error) })
    } finally {
      if (pageControllerRef.current === controller) pageControllerRef.current = null
    }
  }, [api, currentHistory, historyKey, historyWorktrees, log.commits.length, log.worktreeHeads, log.hasMore, log.loadingMore, refresh, state.repo, state.ref, t, waitingForSnapshots])

  /** Keep focus on the active navigation stop across primary clicks on discrete buttons. */
  const onMouseDown = event => {
    if (event.button !== undefined && event.button !== 0) return
    if (hasOpenOverlay) return
    if (!isDiscreteActionButton(event.target, rootRef.current)) return
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active !== null && rootRef.current?.contains(active)) {
      event.preventDefault()
    }
  }

  /** Restore navigation focus after pointer clicks on non-editable panel controls or blank space. */
  const onClick = event => {
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

  /** Route navigation keys from the panel root, buttons, or divider back to the active zone. */
  const onKeyDown = event => {
    if (event.defaultPrevented || event.isComposing === true || isEditableTarget(event.target) || hasOpenOverlay) return
    if (isOverlayTarget(event.target, rootRef.current)) return
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
  const startResize = event => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic or already-released pointer simply skips capture.
    }
    dragRef.current = { x: event.clientX, width: state.sidebarWidth }
  }
  const resize = event => {
    if (dragRef.current === null) return
    update({ sidebarWidth: clampWidth(dragRef.current.width + event.clientX - dragRef.current.x) })
  }
  const stopResize = () => { dragRef.current = null }

  if (repositories.status === 'error') {
    const missing = repositories.error?.code === 'vcs-missing'
    return (
      <div className="vcs-root" ref={rootRef} tabIndex={-1}>
        <div className="vcs-center">
          <p className="vcs-empty-title">{missing ? t('error.vcsMissing') : t('repositories.error')}</p>
          <p className="vcs-note">{missing ? t('error.vcsMissingHint') : errorMessage(t, repositories.error)}</p>
          <button type="button" className="vcs-button" onClick={refresh}>{t('error.retry')}</button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="vcs-root"
      data-narrow={narrow ? 'true' : undefined}
      data-single-column={singleColumn ? 'true' : undefined}
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
        repositories={repositories.list}
        repo={state.repo}
        worktrees={worktrees}
        checkedPaths={checkedPaths}
        onToggleWorktree={toggleCheckedWorktree}
        sessionPath={repoInfo?.enclosing === true ? state.repo : null}
        onRepoChange={(repo, fromPointer) => {
          const entry = repositories.list.find(candidate => candidate.path === repo)
          if (entry === undefined || entry.path === state.repo) return
          switchRepo(entry)
          if (fromPointer) {
            panelOwnsFocusRef.current = true
            pendingReadyFocusRef.current = true
          }
        }}
        status={checkedPaths.length > 1 ? null : status.data}
        capabilities={capabilities}
        refMode={state.ref}
        onRefMode={ref => { update({ ref }) }}
        onRefresh={() => { refresh() }}
        refreshing={refreshing === 'refresh'}
        revalidating={refreshing === 'auto' || Object.values(statuses).some(entry => entry.status === 'refreshing')}
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
        notice={notice}
        twoColumns={state.twoColumns}
        twoColumnsFit={!narrow}
        onTwoColumns={setTwoColumns}
        t={t}
        locale={locale}
      />
      {repositories.truncated ? <p className="vcs-note">{formatPlural(t, 'repositories.truncated', repositories.list.length, locale)}</p> : null}
      {repositories.worktreesTruncated ? <p className="vcs-note">{t('repositories.worktreesTruncated')}</p> : null}
      {repositories.status === 'loading' ? (
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
      ) : missingTool ? (
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('error.vcsMissing')}</p>
          <p className="vcs-note">{t('error.vcsMissingHint')} {errorMessage(t, status.error)}</p>
          <button type="button" className="vcs-button" onClick={refresh}>{t('error.retry')}</button>
        </div>
      ) : (
        <div className="vcs-main">
          {showTimeline ? (
            <section className="vcs-sidebar" style={singleColumn ? undefined : { width: `${state.sidebarWidth}px` }}>
              <Timeline
                key={historyScope}
                commits={commits}
                layout={layout}
                worktrees={worktreeRows}
                selectedRow={selectedRow}
                onSelectRow={selectRow}
                onMove={moveTimeline}
                onOpen={openDetail}
                control={timelineControl}
                t={t}
                locale={locale}
                loading={log.status === 'loading' || waitingForSnapshots}
                loadingMore={log.loadingMore}
                error={log.error}
                hasMore={log.hasMore}
                truncated={log.truncated}
                onLoadMore={() => { void loadMore() }}
                onRetry={refresh}
                onRefActions={capabilities?.branchOps === true || capabilities?.tagOps === true
                  ? actions.onRefActions
                  : undefined}
                onCommitActions={capabilities?.commitOps === true ? actions.openCommitActions : undefined}
                initialScrollTop={timelineScrollRef.current}
                onScrollOffset={top => {
                  timelineScrollRef.current = top
                  persistSoon()
                }}
              />
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
              {detailNode === null || state.node === WORKTREE || state.node === WORKING_COPY
                || (worktreePath(state.node) !== null && selectedTree === null) ? (
                commitBased && selectedTree !== null && detailStatus.status === 'error'
                  ? <p className="vcs-note" role="alert">{t('changes.error')} {errorMessage(t, detailStatus.error)}</p>
                  : <TreeSkeleton label={t('changes.loading')} />
              ) : (
                <DetailPane
                  key={`${state.repo}|${state.node}`}
                  api={detailApi}
                  repo={detailRoot}
                  node={detailNode}
                  worktree={selectedWorktree}
                  workingCopies={summary?.workingCopies ?? (commitBased && selectedTree !== null ? [selectedTree] : NO_WORKTREE_ROWS)}
                  snapshotError={commitBased && selectedTree !== null && detailStatus.status === 'error' ? detailStatus.error : null}
                  showCurrentHead={showCurrentHead}
                  summary={summary}
                  status={detailStatus.data}
                  statusState={detailStatus.status}
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
                  revision={revision}
                  cache={diffCacheRef.current}
                  commitCache={commitCacheRef.current}
                  initialAnchor={anchorRef.current}
                  onReading={onReading}
                  control={detailControl}
                  capabilities={capabilities}
                  onStage={canStage ? actions.stage : undefined}
                  onStageHistory={canStage ? actions.stageHistory : undefined}
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
