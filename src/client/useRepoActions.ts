/**
 * Unified repository write, context-menu, and confirmation-dialog controller.
 *
 * Replaces the parallel branch/tag/commit menu states, dialog states, and
 * cross-slice busy flags in `VcsView` with:
 * - one per-repository single-flight lock (`inFlightRef` / `inFlight`) matching
 *   the Host's per-repo lock, so a write in one repository never blocks another
 * - one active `menu` (`RefActionsMenu`) and one active `dialog`
 * - shared focus restoration to the opener or domain fallback
 * - graph-aware commit action pruning and upstream-aware Push disabling
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import {
  failureOf, type Api, type CommitNode, type RepositoryCapabilities, type StageRequest, type StatusData,
  type WorktreeCreateRequest, type WorktreeInfo, type WorktreeRemovalAction, type WorktreeRequest,
} from './api.js'
import { worktreeActionReason } from './worktrees.js'
import { branchActions, remoteBranchActions, type BranchMenuAction, type BranchOpAction } from './branch.js'
import { COMMIT_ACTION_META, commitActions, type CommitAction, type CommitDialogKind } from './commit.js'
import { tagActions, type TagAction } from './tag.js'
import { commitBranchRelation, reachableCommits } from './history/commits.js'
import {
  branchOpMessage, commitOpMessage, errorMessage, shortSha, switchMessage, syncMessage, tagOpMessage,
} from './format.js'
import { hasClass } from './keys.js'
import type { PanelState } from './state.js'

/** One write domain under the per-repository lock. */
export type RepoWriteDomain = 'sync' | 'switch' | 'branch' | 'tag' | 'commit' | 'stage' | 'worktree'

/** One write in flight for one repository. */
export interface RepoWrite {
  domain: RepoWriteDomain
  action: string
}

/** A result notice in the top bar or tiled action bar. */
export interface Notice {
  tone: 'error' | 'info'
  text: string
  domain?: 'worktree'
}

/** The outcome of one write that was under the lock. */
export type RepoWriteSettled<T> =
  | { started: true; ok: true; value: T }
  | { started: true; ok: false; error: ReturnType<typeof failureOf> }

/** The outcome of one write: refused, or settled. */
export type RepoWriteResult<T> = { started: false } | RepoWriteSettled<T>

/** The three destinations of the tag push dialog's remote list. */
export interface TagRemotesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  list: string[]
  truncated: boolean
  error: ReturnType<typeof failureOf> | null
}

/** The pointer origin a menu opens at. */
export interface MenuPoint {
  readonly clientX: number
  readonly clientY: number
}

/** The reference event the menu opens from; it cancels the browser's own menu. */
export interface RefActionEvent extends MenuPoint {
  preventDefault(): void
  stopPropagation(): void
}

/** One reference as the menus classify it. */
export interface RefEntry {
  kind: string
  name: string
  current?: boolean
  remote?: string
  branch?: string
}

/** The target the shared ref and commit actions menu paints. */
export interface RefMenuTargetBase {
  name: string
  detail?: string
  current?: boolean
  disabledActions?: Record<string, string>
  x: number
  y: number
}

/** One branch or remote-branch menu. */
export interface BranchMenuTarget extends RefMenuTargetBase {
  domain: 'branch'
  kind: 'branch' | 'remote'
  actions: BranchMenuAction[]
  remote?: string
  shortBranch?: string
}

/** One tag menu. */
export interface TagMenuTarget extends RefMenuTargetBase {
  domain: 'tag'
  kind: 'tag'
  actions: TagAction[]
}

/** One commit menu. */
export interface CommitMenuTarget extends RefMenuTargetBase {
  domain: 'commit'
  kind: 'commit'
  actions: CommitAction[]
  sha: string
  subject: string
}

/** The open actions menu. */
export type RefMenuTarget = BranchMenuTarget | TagMenuTarget | CommitMenuTarget | WorktreeMenuTarget

interface WorktreeMenuTarget extends RefMenuTargetBase {
  domain: 'worktree'
  kind: 'worktree'
  tree: WorktreeInfo
  commitBased: boolean
  actions: WorktreeRemovalAction[]
}

/** An existing action and its explicit target, independent of menu placement. */
export type RepoAction =
  | { domain: 'sync'; kind: 'sync'; branch: string }
  | { domain: 'branch'; kind: BranchMenuAction; branch: string; remote?: string; local?: string; receiver?: string }
  | { domain: 'tag'; kind: TagAction; tag: string }
  | { domain: 'commit'; kind: CommitAction; sha: string; subject: string }
  | { domain: 'worktree'; kind: WorktreeRemovalAction; tree: WorktreeInfo }

/** One branch confirmation dialog. */
export interface BranchDialogRequest {
  domain: 'branch'
  kind: BranchOpAction
  branch: string
  current: string | null
  remote?: string
  local?: string
}

/** One tag confirmation dialog. */
export interface TagDialogRequest {
  domain: 'tag'
  kind: TagAction
  tag: string
}

/** One commit confirmation dialog. */
export interface CommitDialogRequest {
  domain: 'commit'
  kind: CommitDialogKind
  sha: string
  shortSha: string
  current: string | null
  subject: string
}

/** The open confirmation dialog. */
export type RepoDialogRequest = BranchDialogRequest | TagDialogRequest | CommitDialogRequest | WorktreeDialogRequest

export type WorktreeDialogRequest = { domain: 'worktree'; repo: string; commitBased: boolean } & (
  | { kind: 'create' }
  | { kind: WorktreeRemovalAction; tree: WorktreeInfo }
)

/** The extra fields one branch action takes. */
export interface BranchActionOptions {
  name?: string
  local?: string
  force?: boolean
}

/** The extra fields one tag action takes. */
export interface TagActionOptions {
  remote?: string
}

/** The extra fields one commit action takes. */
export interface CommitActionOptions {
  name?: string
  message?: string
  checkout?: boolean
  mode?: string
}

/** What one confirmation dialog reports on submit. */
export interface DialogConfirmValues extends BranchActionOptions, CommitActionOptions, TagActionOptions {}

/** The reading position a line-stage write should return to. */
export interface StageWriteMeta {
  hunk: number
  restoreTo: 'hunk' | 'line'
}

/** Where focus returns after a menu closes. */
interface MenuReturn {
  element: HTMLElement | null
  domain: 'branch' | 'tag' | 'commit' | 'worktree'
  restore?: () => void
}

/** The commits' reachability from HEAD, as the action pruning reads it. */
export interface CommitReachability {
  reachable: Set<string>
  complete: boolean
}

/** The panel state and callbacks the action controller reads. */
export interface UseRepoActionsParams {
  /** The Session-scoped API client. */
  api: Api
  /** The open Conversation Session. */
  sessionId: string
  /** The repository writes act on, or null while it is not writable. */
  repo: string | null
  /** The live panel state. */
  stateRef: MutableRefObject<PanelState>
  /** The live Session id. */
  sessionRef: MutableRefObject<string>
  /** The working-tree answer of the shown repository. */
  statusData: StatusData | null
  /** Its backend's capabilities. */
  capabilities: RepositoryCapabilities | null
  /** The loaded commit rows. */
  commits: CommitNode[]
  /** Commit id to loaded row index. */
  commitIndex: Map<string, number>
  /** The HEAD commit id of the shown checkout. */
  head: string | null
  /** The panel's root element, for focus fallbacks. */
  rootRef: RefObject<HTMLElement>
  /** Restore focus through the panel's own navigation. */
  onRestoreFocus?: () => void
  /** The panel's translate function. */
  t: Translate
  /** The active BCP 47 locale. */
  locale?: string
  /** Ask the panel to re-read after a write. */
  refresh: (requester: string, repo: string) => void
  onWorktreeChange: (repo: string, createdPath?: string) => void
  /** Reset the reading position after the checked-out commit moved. */
  resetReadingForNewHead: () => void
  /** State one notice, or clear it. */
  setNotice: (notice: Notice | null, repo: string) => void
  /** Drop the header's branch listing. */
  clearBranches: () => void
  /** Cancel the header's branch read. */
  abortBranches: () => void
}

/** The controller the panel calls into. */
export interface RepoActions {
  menu: RefMenuTarget | null
  dialog: RepoDialogRequest | null
  dialogError: ReturnType<typeof failureOf> | null
  tagRemotes: TagRemotesState
  inFlight: ReadonlyMap<string, RepoWrite>
  repoBusy: boolean
  dialogWriting: boolean
  syncing: boolean
  staging: boolean
  switching: boolean
  branchBusy: string | null
  tagBusy: string | null
  commitBusy: string | null
  worktreeBusy: boolean
  openWorktreeCreate: (restore: () => void) => void
  openWorktreeActions: (tree: WorktreeInfo, sessionPath: string | null | undefined, point: MenuPoint, restore: () => void) => void
  confirmWorktree: (request?: WorktreeCreateRequest) => void
  resetActionsUi: () => void
  sync: () => Promise<void>
  stage: (target: StageRequest) => Promise<boolean>
  stageHistory: (action: string, id: string) => Promise<boolean>
  switchBranch: (branch: string) => Promise<void>
  openBranchActions: (entry: RefEntry, point: MenuPoint, returnElement?: HTMLElement | null) => void
  openCommitActions: (commit: CommitNode, point: MenuPoint, returnElement?: HTMLElement | null) => void
  onRefActions: (reference: RefEntry, event: RefActionEvent, returnElement?: HTMLElement | null) => void
  closeMenu: (restoreFocus: boolean) => void
  chooseMenuAction: (action: string) => void
  openAction: (action: RepoAction, restore?: () => void) => boolean
  confirmDialog: (values: DialogConfirmValues) => void
  cancelDialog: () => void
}

/** Empty remote listing for the tag push dialog. */
function idleRemotes(): TagRemotesState {
  return { status: 'idle', list: [], truncated: false, error: null }
}

/** Extract the checked-out branch name from status data, or null when detached/unborn. */
function checkedOutBranch(statusData: StatusData | null): string | null {
  const info = statusData?.branch
  return info !== undefined && info !== null
    && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
    ? info.name
    : null
}

/**
 * Manage repository writes, shared ref/commit menus, and action dialogs.
 * @param params - panel state and callbacks.
 * @returns the controller the panel renders and calls.
 */
export function useRepoActions({
  api, sessionId, repo, stateRef, sessionRef, statusData, capabilities,
  commits, commitIndex, head, rootRef, onRestoreFocus, t, locale,
  refresh, onWorktreeChange, resetReadingForNewHead, setNotice, clearBranches, abortBranches,
}: UseRepoActionsParams): RepoActions {
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, RepoWrite>>(new Map())
  const inFlightRef = useRef<Map<string, RepoWrite>>(new Map())
  const [menu, setMenu] = useState<RefMenuTarget | null>(null)
  const [dialog, setDialog] = useState<RepoDialogRequest | null>(null)
  const [dialogError, setDialogError] = useState<ReturnType<typeof failureOf> | null>(null)
  const [tagRemotes, setTagRemotes] = useState<TagRemotesState>(idleRemotes)

  const menuReturnRef = useRef<MenuReturn | null>(null)
  const tagRemotesControllerRef = useRef<AbortController | null>(null)
  const writeRootRef = useRef<string | null>(repo)
  writeRootRef.current = repo

  useEffect(() => () => {
    tagRemotesControllerRef.current?.abort()
  }, [])

  const reachability = useMemo<CommitReachability>(() => reachableCommits(commits, head), [commits, head])

  const selectedRepo = stateRef.current.repo
  const activeWrite = selectedRepo === null ? null : (inFlight.get(selectedRepo) ?? null)
  const repoBusy = activeWrite !== null
  const dialogWriting = activeWrite !== null && dialog !== null
    && activeWrite.domain === dialog.domain && activeWrite.action === dialog.kind

  /** Clear menu/dialog UI when switching repositories or sessions without disturbing in-flight locks. */
  const resetActionsUi = useCallback((): void => {
    tagRemotesControllerRef.current?.abort()
    tagRemotesControllerRef.current = null
    setMenu(null)
    setDialog(null)
    setDialogError(null)
    setTagRemotes(idleRemotes())
    menuReturnRef.current = null
  }, [])

  /** Restore focus to a cancelled keyboard/badge opener or back to panel navigation. */
  const restoreFocus = useCallback((cancelled = false): void => {
    const entry = menuReturnRef.current
    menuReturnRef.current = null
    const domain = entry?.domain
    requestAnimationFrame(() => {
      if (entry?.restore !== undefined) {
        entry.restore()
        return
      }
      if (
        cancelled === true
        && entry?.element !== null
        && entry?.element !== undefined
        && entry.element.isConnected === true
        && (
          hasClass(entry.element, 'vcs-branch-button')
          || hasClass(entry.element, 'vcs-ref-button')
          || hasClass(entry.element, 'vcs-timeline-row')
        )
      ) {
        entry.element.focus({ preventScroll: true })
        return
      }
      if (typeof onRestoreFocus === 'function') {
        onRestoreFocus()
        return
      }
      const root = rootRef.current
      if (domain === 'branch') {
        root?.querySelector<HTMLElement>('.vcs-branch-button')?.focus()
        return
      }
      const row = root?.querySelector<HTMLElement>('.vcs-timeline-row[aria-current="true"]')
        ?? root?.querySelector<HTMLElement>('.vcs-timeline-row')
      row?.focus({ preventScroll: true })
    })
  }, [onRestoreFocus, rootRef])

  /**
   * Run one write operation under the repository's client-side single-flight guard.
   * Calls `onSettled` before releasing the in-flight entry so follow-up state (such
   * as the transition from sync to refresh) commits in the same render.
   * Returns `{ started: false }` if the repo is missing or already busy.
   */
  const runRepoWrite = useCallback(async <T,>(
    repo: string | null,
    domain: RepoWriteDomain,
    action: string,
    fn: () => Promise<T>,
    onSettled?: (result: RepoWriteSettled<T>) => void,
  ): Promise<RepoWriteResult<T>> => {
    if (repo === null || inFlightRef.current.has(repo)) return { started: false }
    const entry: RepoWrite = { domain, action }
    inFlightRef.current.set(repo, entry)
    setInFlight(prev => new Map(prev).set(repo, entry))
    try {
      let result: RepoWriteSettled<T>
      try {
        const value = await fn()
        result = { started: true, ok: true, value }
      } catch (error) {
        result = { started: true, ok: false, error: failureOf(error) }
      }
      onSettled?.(result)
      return result
    } finally {
      inFlightRef.current.delete(repo)
      setInFlight(prev => {
        const next = new Map(prev)
        next.delete(repo)
        return next
      })
    }
  }, [])

  /** Load configured remotes for the tag push dialog. */
  const loadTagRemotes = useCallback((): void => {
    const repo = writeRootRef.current
    if (repo === null) return
    tagRemotesControllerRef.current?.abort()
    const controller = new AbortController()
    tagRemotesControllerRef.current = controller
    setTagRemotes({ status: 'loading', list: [], truncated: false, error: null })
    api.remotes(repo, controller.signal).then(answer => {
      if (controller.signal.aborted || stateRef.current.repo !== repo) return
      const list = Array.isArray(answer?.remotes)
        ? answer.remotes.filter(name => typeof name === 'string' && name !== '')
        : []
      setTagRemotes({
        status: 'ready',
        list,
        truncated: answer?.truncated === true,
        error: null,
      })
    }).catch(error => {
      if (failureOf(error).name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setTagRemotes({ status: 'error', list: [], truncated: false, error: failureOf(error) })
    }).finally(() => {
      if (tagRemotesControllerRef.current === controller) tagRemotesControllerRef.current = null
    })
  }, [api, stateRef])

  /** Sync the chosen repository's branch with its upstream, then refresh. */
  const sync = useCallback(async (): Promise<void> => {
    const repo = writeRootRef.current
    if (capabilities?.sync !== true || repo === null || inFlightRef.current.has(repo)) return
    setNotice(null, repo)
    await runRepoWrite(repo, 'sync', 'sync', () => api.sync(repo), run => {
      const outcome: Notice = run.ok
        ? { tone: 'info', text: syncMessage(t, run.value, locale) }
        : { tone: 'error', text: errorMessage(t, run.error) }
      if (sessionRef.current === sessionId) {
        refresh('sync', repo)
        setNotice(outcome, repo)
      }
    })
  }, [api, capabilities, locale, refresh, runRepoWrite, sessionId, sessionRef, setNotice, t])

  /** Check out one local branch, resetting reading state on success. */
  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    const repo = writeRootRef.current
    if (capabilities?.branchSwitch !== true || repo === null || inFlightRef.current.has(repo)) return
    setNotice(null, repo)
    abortBranches()
    const run = await runRepoWrite(repo, 'switch', 'switch', () => api.switchBranch(repo, branch))
    if (!run.started || sessionRef.current !== sessionId) return
    if (!run.ok) {
      refresh('switch', repo)
      setNotice({ tone: 'error', text: errorMessage(t, run.error) }, repo)
      return
    }
    if (writeRootRef.current === repo) resetReadingForNewHead()
    if (stateRef.current.repo === repo) clearBranches()
    refresh('switch', repo)
    setNotice({ tone: 'info', text: switchMessage(t, run.value, branch) }, repo)
  }, [abortBranches, api, capabilities, clearBranches, refresh, resetReadingForNewHead, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Open the local or remote branch actions menu. */
  const openBranchActions = useCallback((entry: RefEntry, point: MenuPoint, returnElement?: HTMLElement | null): void => {
    if (capabilities?.branchOps !== true) return
    const currentBranch = checkedOutBranch(statusData)
    const remote = entry.kind === 'remote'
    if (remote && (typeof entry.remote !== 'string' || typeof entry.branch !== 'string')) return
    menuReturnRef.current = { element: returnElement ?? null, domain: 'branch' }
    const isCurrent = remote ? false : entry.current === true
    const hasUpstream = statusData?.branch?.upstream !== null && statusData?.branch?.upstream !== undefined
    const disabledActions = isCurrent && statusData?.branch !== undefined && statusData?.branch !== null && !hasUpstream
      ? { push: t('top.syncNoUpstream') }
      : undefined
    setMenu({
      domain: 'branch',
      kind: remote ? 'remote' : 'branch',
      name: entry.name,
      remote: remote ? entry.remote : undefined,
      shortBranch: remote ? entry.branch : undefined,
      current: isCurrent,
      actions: remote
        ? remoteBranchActions({ currentBranch })
        : branchActions({ current: isCurrent, currentBranch }),
      disabledActions,
      x: point.clientX,
      y: point.clientY,
    })
  }, [capabilities, statusData, t])

  /** Open the tag actions menu. */
  const openTagActions = useCallback((reference: RefEntry, point: MenuPoint, returnElement?: HTMLElement | null): void => {
    if (capabilities?.tagOps !== true) return
    menuReturnRef.current = { element: returnElement ?? null, domain: 'tag' }
    setMenu({
      domain: 'tag',
      kind: 'tag',
      name: reference.name,
      actions: tagActions(),
      x: point.clientX,
      y: point.clientY,
    })
  }, [capabilities])

  /** Open the commit actions menu for one timeline commit. */
  const openCommitActions = useCallback((commit: CommitNode, point: MenuPoint, returnElement?: HTMLElement | null): void => {
    if (capabilities?.commitOps !== true) return
    const currentBranch = checkedOutBranch(statusData)
    const oid = statusData?.branch?.oid
    const currentHead = typeof oid === 'string' && oid !== '' ? oid : null
    const relation = commitBranchRelation(commits, commitIndex, head, commit.sha, reachability)
    menuReturnRef.current = { element: returnElement ?? null, domain: 'commit' }
    setMenu({
      domain: 'commit',
      kind: 'commit',
      name: shortSha(commit.sha),
      detail: commit.subject ?? '',
      sha: commit.sha,
      subject: commit.subject ?? '',
      actions: commitActions({ commit, currentBranch, head: currentHead, relation }),
      x: point.clientX,
      y: point.clientY,
    })
  }, [capabilities, commitIndex, commits, head, reachability, statusData])

  const openWorktreeCreate = useCallback((restore: () => void): void => {
    const repo = stateRef.current.repo
    if (repo === null || capabilities?.worktreeCreate !== true || inFlightRef.current.has(repo)) return
    menuReturnRef.current = { element: null, domain: 'worktree', restore }
    setDialogError(null)
    setDialog({ domain: 'worktree', kind: 'create', repo, commitBased: capabilities.workingCopy === 'commit' })
  }, [capabilities, stateRef])

  const openWorktreeActions = useCallback((
    tree: WorktreeInfo, sessionPath: string | null | undefined, point: MenuPoint, restore: () => void,
  ): void => {
    if (capabilities === null) return
    const commitBased = capabilities.workingCopy === 'commit'
    const actions: WorktreeRemovalAction[] = commitBased ? ['forget', 'remove'] : ['remove']
    const disabledActions = Object.fromEntries(actions.flatMap(action => {
      const reason = worktreeActionReason(action, tree, sessionPath, capabilities)
      return reason === undefined ? [] : [[action, t(reason)]]
    }))
    menuReturnRef.current = { element: null, domain: 'worktree', restore }
    setMenu({
      domain: 'worktree', kind: 'worktree', name: tree.name, detail: tree.path,
      tree, commitBased, actions, disabledActions, x: point.clientX, y: point.clientY,
    })
  }, [capabilities, t])

  /** Dispatch a right-click or activated branch/remote/tag badge. */
  const onRefActions = useCallback((reference: RefEntry, event: RefActionEvent, returnElement?: HTMLElement | null): void => {
    if (reference.kind === 'branch' && capabilities?.branchOps === true) {
      event.preventDefault()
      event.stopPropagation()
      openBranchActions(reference, event, returnElement)
    } else if (reference.kind === 'remote' && capabilities?.branchOps === true) {
      if (typeof reference.remote !== 'string' || typeof reference.branch !== 'string') return
      event.preventDefault()
      event.stopPropagation()
      openBranchActions(reference, event, returnElement)
    } else if (reference.kind === 'tag' && capabilities?.tagOps === true) {
      event.preventDefault()
      event.stopPropagation()
      openTagActions(reference, event, returnElement)
    }
  }, [capabilities, openBranchActions, openTagActions])

  /** Close the open actions menu. */
  const closeMenu = useCallback((restore: boolean): void => {
    setMenu(null)
    if (restore) restoreFocus(true)
    else menuReturnRef.current = null
  }, [restoreFocus])

  /** Execute one branch action (`rename`, `delete`, `merge`, `rebase`, `push`, or remote actions). */
  const runBranchAction = useCallback(async (action: BranchOpAction, branch: string, options: BranchActionOptions = {}): Promise<void> => {
    const repo = writeRootRef.current
    if (capabilities?.branchOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null, repo)
    const run = await runRepoWrite(repo, 'branch', action, () => api.branchOp(repo, action, { branch, ...options }))
    if (!run.started || sessionRef.current !== sessionId) return
    if (!run.ok) {
      if (action === 'push') {
        refresh('branch', repo)
        setNotice({ tone: 'error', text: errorMessage(t, run.error) }, repo)
      } else if (stateRef.current.repo === repo) setDialogError(run.error)
      return
    }
    const current = stateRef.current.repo === repo
    if (current) {
      setDialog(null)
      setDialogError(null)
      clearBranches()
      if (action === 'checkout-remote' && writeRootRef.current === repo) resetReadingForNewHead()
    }
    refresh('branch', repo)
    setNotice({ tone: 'info', text: branchOpMessage(t, action, branch, run.value) }, repo)
    if (current && action !== 'push') restoreFocus(false)
  }, [api, capabilities, clearBranches, refresh, resetReadingForNewHead, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Execute one tag action (`delete` or `push`). */
  const runTagAction = useCallback(async (action: TagAction, tag: string, options: TagActionOptions = {}): Promise<void> => {
    const repo = writeRootRef.current
    if (capabilities?.tagOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null, repo)
    const run = await runRepoWrite(repo, 'tag', action, () => api.tagOp(repo, action, { tag, ...options }))
    if (!run.started || sessionRef.current !== sessionId || stateRef.current.repo !== repo) return
    if (!run.ok) {
      setDialogError(run.error)
      return
    }
    setDialog(null)
    setDialogError(null)
    setTagRemotes(idleRemotes())
    refresh('tag', repo)
    setNotice({ tone: 'info', text: tagOpMessage(t, action, tag, run.value) }, repo)
    restoreFocus(false)
  }, [api, capabilities, refresh, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Execute one commit action (`tag`, `branch`, `checkout`, `cherry-pick`, `revert`, `drop`, `merge`, `rebase`, `reset`). */
  const runCommitAction = useCallback(async (action: CommitDialogKind, target: { sha: string }, values: CommitActionOptions = {}): Promise<void> => {
    const repo = writeRootRef.current
    if (capabilities?.commitOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null, repo)
    const run = await runRepoWrite(repo, 'commit', action, () => api.commitOp(repo, action, { sha: target.sha, ...values }))
    if (!run.started || sessionRef.current !== sessionId) return
    const current = stateRef.current.repo === repo
    if (!run.ok) {
      if (current) setDialogError(run.error)
      return
    }
    if (current) {
      setDialog(null)
      setDialogError(null)
      clearBranches()
      if (writeRootRef.current === repo && (
        action === 'checkout' || (action === 'reset' && values.mode === 'hard') || (action === 'branch' && values.checkout === true)
      )) resetReadingForNewHead()
    }
    refresh('commit', repo)
    setNotice({ tone: 'info', text: commitOpMessage(t, action, target, run.value) }, repo)
    if (current) restoreFocus(false)
  }, [api, capabilities, clearBranches, refresh, resetReadingForNewHead, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Run any index action under the same guard and refresh both staging groups. */
  const runStageWrite = useCallback(async (
    action: string,
    execute: (repo: string) => Promise<unknown>,
    successKey: string,
  ): Promise<boolean> => {
    const repo = writeRootRef.current
    if (capabilities?.stageOps !== true || repo === null || inFlightRef.current.has(repo)) return false
    const needsRefresh = (run: RepoWriteSettled<unknown>): boolean => (
      run.ok || ['stale-diff', 'stage-history-stale', 'stage-history-unavailable'].includes(run.error.code ?? '')
    )
    setNotice(null, repo)
    const result = await runRepoWrite(repo, 'stage', action, () => execute(repo), run => {
      if (sessionRef.current !== sessionId || writeRootRef.current !== repo) return
      if (needsRefresh(run)) refresh('stage', repo)
      setNotice(run.ok
        ? { tone: 'info', text: t(successKey) }
        : { tone: 'error', text: errorMessage(t, run.error) }, repo)
    })
    return result.started && needsRefresh(result)
  }, [capabilities, refresh, runRepoWrite, sessionId, sessionRef, setNotice, t])

  const stage = useCallback((target: StageRequest): Promise<boolean> => runStageWrite(target.scope, repo => api.stage(repo, target),
    target.scope === 'staged' ? 'stage.unstaged' : 'stage.staged'), [api, runStageWrite])

  const stageHistory = useCallback((action: string, id: string): Promise<boolean> => runStageWrite(action, repo => api.stageHistory(repo, action, id),
    action === 'undo' ? 'stage.undone' : 'stage.redone'), [api, runStageWrite])

  /** Open the existing confirmation or run the action directly, with or without a menu. */
  const openAction = useCallback((action: RepoAction, restore?: () => void): boolean => {
    const repo = stateRef.current.repo
    // A write already in flight only disables the dialog's confirm button, as
    // the menu always did; direct buttons are disabled before they get here.
    if (repo === null || capabilities === null
      || (action.domain !== 'worktree' && writeRootRef.current !== repo)) return false
    const current = checkedOutBranch(statusData)
    let request: RepoDialogRequest | undefined
    let run: (() => Promise<void>) | undefined
    switch (action.domain) {
      case 'sync':
        if (capabilities.sync !== true || current !== action.branch || statusData?.branch?.upstream == null) return false
        run = sync
        break
      case 'branch': {
        const { kind, branch, remote, local, receiver } = action
        if (capabilities.branchOps !== true || (receiver !== undefined && receiver !== current)) return false
        if (kind === 'checkout') {
          if (capabilities.branchSwitch !== true) return false
          run = () => switchBranch(branch)
        } else if (kind === 'push') run = () => runBranchAction(kind, branch)
        else request = { domain: 'branch', kind, branch, current, remote, local }
        break
      }
      case 'tag':
        if (capabilities.tagOps !== true) return false
        request = { domain: 'tag', kind: action.kind, tag: action.tag }
        break
      case 'commit':
        if (capabilities.commitOps !== true) return false
        request = {
          domain: 'commit', kind: COMMIT_ACTION_META[action.kind].dialogKind,
          sha: action.sha, shortSha: shortSha(action.sha), current, subject: action.subject,
        }
        break
      case 'worktree':
        if ((action.kind === 'remove' ? capabilities.worktreeRemove : capabilities.worktreeForget) !== true) return false
        request = { domain: 'worktree', kind: action.kind, repo, tree: action.tree, commitBased: capabilities.workingCopy === 'commit' }
        break
    }
    setMenu(null)
    setDialogError(null)
    if (run !== undefined) {
      // Direct controls already hold focus; only the closed menu needs to return it.
      if (restore === undefined) restoreFocus(false)
      else menuReturnRef.current = null
      void run()
    } else if (request !== undefined) {
      if (restore !== undefined) menuReturnRef.current = { element: null, domain: request.domain, restore }
      setDialog(request)
      if (request.domain === 'tag') {
        setTagRemotes(idleRemotes())
        if (request.kind === 'push') loadTagRemotes()
      }
    }
    return true
  }, [capabilities, loadTagRemotes, restoreFocus, runBranchAction, stateRef, statusData, switchBranch, sync])

  /** Translate one enabled menu item into the same explicit target used by direct buttons. */
  const chooseMenuAction = useCallback((action: string): void => {
    if (menu === null || menu.disabledActions?.[action] !== undefined) return
    const chosen = <T extends string,>(kinds: readonly T[]) => kinds.find(kind => kind === action)
    switch (menu.domain) {
      case 'branch': {
        const kind = chosen(menu.actions)
        if (kind !== undefined) openAction({
          domain: 'branch', kind, branch: menu.name, remote: menu.remote, local: kind === 'checkout-remote' ? menu.shortBranch : undefined,
        })
        break
      }
      case 'tag': {
        const kind = chosen(menu.actions)
        if (kind !== undefined) openAction({ domain: 'tag', kind, tag: menu.name })
        break
      }
      case 'commit': {
        const kind = chosen(menu.actions)
        if (kind !== undefined) openAction({ domain: 'commit', kind, sha: menu.sha, subject: menu.subject })
        break
      }
      case 'worktree': {
        const kind = chosen(menu.actions)
        if (kind !== undefined) openAction({ domain: 'worktree', kind, tree: menu.tree })
        break
      }
    }
  }, [menu, openAction])

  /** Submit the open confirmation dialog. */
  const confirmDialog = useCallback((values: DialogConfirmValues): void => {
    if (dialog === null) return
    if (dialog.domain === 'branch') {
      void runBranchAction(dialog.kind, dialog.branch, values)
    } else if (dialog.domain === 'tag') {
      void runTagAction(dialog.kind, dialog.tag, values)
    } else if (dialog.domain === 'commit') {
      void runCommitAction(dialog.kind, dialog, values)
    }
  }, [dialog, runBranchAction, runCommitAction, runTagAction])

  const confirmWorktree = useCallback((create?: WorktreeCreateRequest): void => {
    if (dialog?.domain !== 'worktree' || stateRef.current.repo !== dialog.repo) return
    const request: WorktreeRequest | undefined = dialog.kind === 'create'
      ? create
      : {
        action: dialog.kind,
        worktree: dialog.tree.path,
        ...(dialog.commitBased ? { expectedName: dialog.tree.name } : {
          expectedBranch: dialog.tree.branch,
          expectedHead: dialog.tree.branch === null ? dialog.tree.head ?? undefined : undefined,
        }),
      }
    const repo = dialog.repo
    if (request === undefined || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null, repo)
    void runRepoWrite(repo, 'worktree', request.action, () => api.worktree(repo, request), run => {
      if (sessionRef.current !== sessionId) return
      if (run.ok || ['worktree-partial', 'worktree-stale'].includes(run.error.code ?? '')) {
        onWorktreeChange(repo, run.ok && request.action === 'create' ? run.value.path : undefined)
      }
      const current = stateRef.current.repo === repo
      if (!run.ok) {
        if (current) setDialogError(run.error)
        return
      }
      if (current) {
        abortBranches()
        clearBranches()
        setDialog(null)
      }
      const key = request.action === 'create' ? 'worktree.created'
        : request.action === 'forget' ? 'worktree.forgotten' : 'worktree.removed'
      setNotice({ tone: 'info', text: t(key, { path: run.value.path }), domain: 'worktree' }, repo)
      if (current) restoreFocus()
    })
  }, [abortBranches, api, clearBranches, dialog, onWorktreeChange, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Close the open confirmation dialog unless its own write is running. */
  const cancelDialog = useCallback((): void => {
    if (dialogWriting) return
    if (dialog?.domain === 'tag') {
      tagRemotesControllerRef.current?.abort()
      tagRemotesControllerRef.current = null
      setTagRemotes(idleRemotes())
    }
    setDialog(null)
    setDialogError(null)
    restoreFocus(true)
  }, [dialog, dialogWriting, restoreFocus])

  return {
    menu,
    dialog,
    dialogError,
    tagRemotes,
    inFlight,
    repoBusy,
    dialogWriting,
    syncing: activeWrite?.domain === 'sync',
    staging: activeWrite?.domain === 'stage',
    switching: activeWrite?.domain === 'switch',
    branchBusy: activeWrite?.domain === 'branch' ? activeWrite.action : null,
    tagBusy: activeWrite?.domain === 'tag' ? activeWrite.action : null,
    commitBusy: activeWrite?.domain === 'commit' ? activeWrite.action : null,
    worktreeBusy: activeWrite?.domain === 'worktree',
    openWorktreeCreate,
    openWorktreeActions,
    confirmWorktree,
    resetActionsUi,
    sync,
    stage,
    stageHistory,
    switchBranch,
    openBranchActions,
    openCommitActions,
    onRefActions,
    closeMenu,
    chooseMenuAction,
    openAction,
    confirmDialog,
    cancelDialog,
  }
}
