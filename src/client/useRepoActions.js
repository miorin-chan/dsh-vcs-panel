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

import { branchActions, remoteBranchActions } from './branch.js'
import { COMMIT_ACTION_META, commitActions } from './commit.js'
import { tagActions } from './tag.js'
import { commitBranchRelation, reachableCommits } from './history/commits.js'
import {
  branchOpMessage, commitOpMessage, errorMessage, shortSha, switchMessage, syncMessage, tagOpMessage,
} from './format.js'
import { hasClass } from './keys.js'

/** Empty remote listing for the tag push dialog. */
function idleRemotes() {
  return { status: 'idle', list: [], truncated: false, error: null }
}

/** Extract the checked-out branch name from status data, or null when detached/unborn. */
function checkedOutBranch(statusData) {
  const info = statusData?.branch
  return info !== undefined && info !== null
    && info.detached !== true && info.unborn !== true && typeof info.name === 'string'
    ? info.name
    : null
}

/**
 * Manage repository writes, shared ref/commit menus, and action dialogs.
 *
 * @param {{ api: object, sessionId: string, stateRef: { current: object }, sessionRef: { current: string }, statusData: object | null, capabilities: object | null, commits: object[], commitIndex: Map<string, number>, head: string | null, rootRef: { current: any }, t: Function, locale?: string, refresh: (requester?: string) => void, resetReadingForNewHead: () => void, setNotice: (notice: { tone: 'error' | 'info', text: string } | null) => void, clearBranches: () => void, abortBranches: () => void }} params - panel state and callbacks.
 */
export function useRepoActions({
  api, sessionId, repo, stateRef, sessionRef, statusData, capabilities,
  commits, commitIndex, head, rootRef, onRestoreFocus, t, locale,
  refresh, resetReadingForNewHead, setNotice, clearBranches, abortBranches,
}) {
  const [inFlight, setInFlight] = useState({})
  const inFlightRef = useRef(new Map())
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [dialogError, setDialogError] = useState(null)
  const [tagRemotes, setTagRemotes] = useState(idleRemotes)

  const menuReturnRef = useRef(null)
  const tagRemotesControllerRef = useRef(null)
  const writeRootRef = useRef(repo)
  writeRootRef.current = repo

  useEffect(() => () => {
    tagRemotesControllerRef.current?.abort()
  }, [])

  const reachability = useMemo(() => reachableCommits(commits, head), [commits, head])

  const activeWrite = repo === null ? null : (inFlight[repo] ?? null)
  const repoBusy = activeWrite !== null
  const dialogWriting = activeWrite !== null && dialog !== null
    && activeWrite.domain === dialog.domain && activeWrite.action === dialog.kind

  /** Clear menu/dialog UI when switching repositories or sessions without disturbing in-flight locks. */
  const resetActionsUi = useCallback(() => {
    tagRemotesControllerRef.current?.abort()
    tagRemotesControllerRef.current = null
    setMenu(null)
    setDialog(null)
    setDialogError(null)
    setTagRemotes(idleRemotes())
    menuReturnRef.current = null
  }, [])

  /** Restore focus to a cancelled keyboard/badge opener or back to panel navigation. */
  const restoreFocus = useCallback((cancelled = false) => {
    const entry = menuReturnRef.current
    menuReturnRef.current = null
    const domain = entry?.domain
    requestAnimationFrame(() => {
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
        root?.querySelector('.vcs-branch-button')?.focus()
        return
      }
      const row = root?.querySelector('.vcs-timeline-row[aria-current="true"]')
        ?? root?.querySelector('.vcs-timeline-row')
      row?.focus({ preventScroll: true })
    })
  }, [onRestoreFocus, rootRef])

  /**
   * Run one write operation under the repository's client-side single-flight guard.
   * Calls `onSettled` before releasing the in-flight entry so follow-up state (such
   * as handover from `sync` to `refresh('sync')`) commits in the same render.
   * Returns `{ started: false }` if the repo is missing or already busy.
   */
  const runRepoWrite = useCallback(async (repo, domain, action, fn, onSettled) => {
    if (repo === null || inFlightRef.current.has(repo)) return { started: false }
    const entry = { domain, action }
    inFlightRef.current.set(repo, entry)
    setInFlight(prev => ({ ...prev, [repo]: entry }))
    try {
      let result
      try {
        const value = await fn()
        result = { started: true, ok: true, value }
      } catch (error) {
        result = { started: true, ok: false, error }
      }
      onSettled?.(result)
      return result
    } finally {
      inFlightRef.current.delete(repo)
      setInFlight(prev => {
        if (!(repo in prev)) return prev
        const next = { ...prev }
        delete next[repo]
        return next
      })
    }
  }, [])

  /** Load configured remotes for the tag push dialog. */
  const loadTagRemotes = useCallback(() => {
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
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (stateRef.current.repo !== repo) return
      setTagRemotes({ status: 'error', list: [], truncated: false, error })
    }).finally(() => {
      if (tagRemotesControllerRef.current === controller) tagRemotesControllerRef.current = null
    })
  }, [api, stateRef])

  /** Sync the chosen repository's branch with its upstream, then refresh. */
  const sync = useCallback(async () => {
    const repo = writeRootRef.current
    if (capabilities?.sync !== true || repo === null || inFlightRef.current.has(repo)) return
    setNotice(null)
    await runRepoWrite(repo, 'sync', 'sync', () => api.sync(repo), run => {
      const outcome = run.ok
        ? { tone: 'info', text: syncMessage(t, run.value, locale) }
        : { tone: 'error', text: errorMessage(t, run.error) }
      if (sessionRef.current === sessionId && stateRef.current.repo === repo) {
        refresh('sync')
        setNotice(outcome)
      }
    })
  }, [api, capabilities, locale, refresh, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Check out one local branch, resetting reading state on success. */
  const switchBranch = useCallback(async branch => {
    const repo = writeRootRef.current
    if (capabilities?.branchSwitch !== true || repo === null || inFlightRef.current.has(repo)) return
    setNotice(null)
    abortBranches()
    const run = await runRepoWrite(repo, 'switch', 'switch', () => api.switchBranch(repo, branch))
    if (!run.started || sessionRef.current !== sessionId || stateRef.current.repo !== repo) return
    if (!run.ok) {
      setNotice({ tone: 'error', text: errorMessage(t, run.error) })
      return
    }
    if (writeRootRef.current === repo) resetReadingForNewHead()
    clearBranches()
    refresh('switch')
    setNotice({ tone: 'info', text: switchMessage(t, run.value, branch) })
  }, [abortBranches, api, capabilities, clearBranches, refresh, resetReadingForNewHead, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Open the local or remote branch actions menu. */
  const openBranchActions = useCallback((entry, point, returnElement) => {
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
  const openTagActions = useCallback((reference, point, returnElement) => {
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
  const openCommitActions = useCallback((commit, point, returnElement) => {
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

  /** Dispatch a right-click or activated branch/remote/tag badge. */
  const onRefActions = useCallback((reference, event, returnElement) => {
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
  const closeMenu = useCallback(restore => {
    setMenu(null)
    if (restore) restoreFocus(true)
    else menuReturnRef.current = null
  }, [restoreFocus])

  /** Execute one branch action (`rename`, `delete`, `merge`, `rebase`, `push`, or remote actions). */
  const runBranchAction = useCallback(async (action, branch, options = {}) => {
    const repo = writeRootRef.current
    if (capabilities?.branchOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null)
    const run = await runRepoWrite(repo, 'branch', action, () => api.branchOp(repo, action, { branch, ...options }))
    if (!run.started || sessionRef.current !== sessionId || stateRef.current.repo !== repo) return
    if (!run.ok) {
      if (action === 'push') setNotice({ tone: 'error', text: errorMessage(t, run.error) })
      else setDialogError(run.error)
      return
    }
    setDialog(null)
    setDialogError(null)
    clearBranches()
    if (action === 'checkout-remote' && writeRootRef.current === repo) resetReadingForNewHead()
    refresh('branch')
    setNotice({ tone: 'info', text: branchOpMessage(t, action, branch, run.value) })
    if (action !== 'push') restoreFocus(false)
  }, [api, capabilities, clearBranches, refresh, resetReadingForNewHead, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Execute one tag action (`delete` or `push`). */
  const runTagAction = useCallback(async (action, tag, options = {}) => {
    const repo = writeRootRef.current
    if (capabilities?.tagOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null)
    const run = await runRepoWrite(repo, 'tag', action, () => api.tagOp(repo, action, { tag, ...options }))
    if (!run.started || sessionRef.current !== sessionId || stateRef.current.repo !== repo) return
    if (!run.ok) {
      setDialogError(run.error)
      return
    }
    setDialog(null)
    setDialogError(null)
    setTagRemotes(idleRemotes())
    refresh('tag')
    setNotice({ tone: 'info', text: tagOpMessage(t, action, tag, run.value) })
    restoreFocus(false)
  }, [api, capabilities, refresh, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Execute one commit action (`tag`, `branch`, `checkout`, `cherry-pick`, `revert`, `drop`, `merge`, `rebase`, `reset`). */
  const runCommitAction = useCallback(async (action, target, values = {}) => {
    const repo = writeRootRef.current
    if (capabilities?.commitOps !== true || repo === null || inFlightRef.current.has(repo)) return
    setDialogError(null)
    setNotice(null)
    const run = await runRepoWrite(repo, 'commit', action, () => api.commitOp(repo, action, { sha: target.sha, ...values }))
    if (!run.started || sessionRef.current !== sessionId || stateRef.current.repo !== repo) return
    if (!run.ok) {
      setDialogError(run.error)
      return
    }
    setDialog(null)
    setDialogError(null)
    clearBranches()
    if (
      action === 'checkout'
      || (action === 'reset' && values.mode === 'hard')
      || (action === 'branch' && values.checkout === true)
    ) {
      if (writeRootRef.current === repo) resetReadingForNewHead()
    }
    refresh('commit')
    setNotice({ tone: 'info', text: commitOpMessage(t, action, target, run.value) })
    restoreFocus(false)
  }, [api, capabilities, clearBranches, refresh, resetReadingForNewHead, restoreFocus, runRepoWrite, sessionId, sessionRef, setNotice, stateRef, t])

  /** Update the working tree's index and reload both staging groups. */
  const stage = useCallback(async target => {
    const repo = writeRootRef.current
    if (capabilities?.stageOps !== true || repo === null || inFlightRef.current.has(repo)) return false
    setNotice(null)
    const result = await runRepoWrite(repo, 'stage', target.scope, () => api.stage(repo, target), run => {
      if (sessionRef.current !== sessionId || writeRootRef.current !== repo) return
      if (run.ok || run.error?.code === 'stale-diff') refresh('stage')
      const key = target.scope === 'staged' ? 'stage.unstaged' : 'stage.staged'
      setNotice(run.ok
        ? { tone: 'info', text: t(key) }
        : { tone: 'error', text: errorMessage(t, run.error) })
    })
    return result.ok || result.error?.code === 'stale-diff'
  }, [api, capabilities, refresh, runRepoWrite, sessionId, sessionRef, setNotice, t])

  /** Handle selecting an item from the shared actions menu. */
  const chooseMenuAction = useCallback(action => {
    const target = menu
    if (target === null) return
    setMenu(null)
    if (target.domain === 'branch') {
      if (target.kind === 'remote') {
        const current = checkedOutBranch(statusData)
        setDialog({
          domain: 'branch',
          kind: action,
          branch: target.name,
          current,
          ...(action === 'checkout-remote'
            ? { remote: target.remote, local: target.shortBranch }
            : { remote: target.remote }),
        })
        setDialogError(null)
        return
      }
      if (action === 'checkout' || action === 'push') {
        restoreFocus(false)
        if (action === 'checkout') void switchBranch(target.name)
        else void runBranchAction('push', target.name)
        return
      }
      setDialog({
        domain: 'branch',
        kind: action,
        branch: target.name,
        current: checkedOutBranch(statusData),
      })
      setDialogError(null)
      return
    }
    if (target.domain === 'tag') {
      setDialog({ domain: 'tag', kind: action, tag: target.name })
      setDialogError(null)
      setTagRemotes(idleRemotes())
      if (action === 'push') loadTagRemotes()
      return
    }
    const kind = COMMIT_ACTION_META[action]?.dialogKind ?? action
    setDialog({
      domain: 'commit',
      kind,
      sha: target.sha,
      shortSha: shortSha(target.sha),
      current: checkedOutBranch(statusData),
      subject: target.subject ?? '',
    })
    setDialogError(null)
  }, [loadTagRemotes, menu, restoreFocus, runBranchAction, statusData, switchBranch])

  /** Submit the open confirmation dialog. */
  const confirmDialog = useCallback(values => {
    if (dialog === null) return
    if (dialog.domain === 'branch') {
      void runBranchAction(dialog.kind, dialog.branch, values)
    } else if (dialog.domain === 'tag') {
      void runTagAction(dialog.kind, dialog.tag, values)
    } else {
      void runCommitAction(dialog.kind, dialog, values)
    }
  }, [dialog, runBranchAction, runCommitAction, runTagAction])

  /** Close the open confirmation dialog unless its own write is running. */
  const cancelDialog = useCallback(() => {
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
    repoBusy,
    dialogWriting,
    syncing: activeWrite?.domain === 'sync',
    staging: activeWrite?.domain === 'stage',
    switching: activeWrite?.domain === 'switch',
    branchBusy: activeWrite?.domain === 'branch' ? activeWrite.action : null,
    tagBusy: activeWrite?.domain === 'tag' ? activeWrite.action : null,
    commitBusy: activeWrite?.domain === 'commit' ? activeWrite.action : null,
    resetActionsUi,
    sync,
    stage,
    switchBranch,
    openBranchActions,
    openCommitActions,
    onRefActions,
    closeMenu,
    chooseMenuAction,
    confirmDialog,
    cancelDialog,
  }
}
