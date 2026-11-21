/**
 * The detail of one timeline node, the same for the working tree and commits:
 * a toolbar and the change tree.
 *
 * The node decides only the toolbar metadata, the header block, and where the
 * files come from — the working-tree status, or the commit's changed files from
 * `vcs.commit`. Both become file groups (`detail.js`), and the change tree
 * turns those groups plus the expansion state into rows.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  Api, ApiFailure, CommitDetail, CommitNode, RepositoryCapabilities, StageHistoryEntry, StatusData, VcsRef,
} from '../api.js'
import { sharedRefs } from '../worktrees.js'
import { errorMessage, formatCount, formatDateTime, formatPlural, shortChangeId, shortSha } from '../format.js'
import { messageBody } from '../history/commits.js'
import { worktreeSummary } from '../history/timeline-model.js'
import {
  BackIcon, BranchIcon, Button, CheckIcon, CompareSplitIcon, CopyIcon, FoldIcon, IconButton,
  NowrapIcon, RefBadge, StagingLayoutIcon, UntrackedStat, WorkingCopyBadge, WrapIcon,
} from '../ui.jsx'
import type { RefActivation } from '../ui.jsx'
import { MetaSkeleton, TreeSkeleton } from '../skeleton.jsx'
import { buildNodeRows, summarizeEntries } from './tree.js'
import type { DirRow, GroupRow, NavRow, UntrackedChild } from './tree.js'
import {
  SPLIT_MIN_WIDTH, allFileFolds, budgetFolds, commitGroups, commitSummary, comparisonBase,
  expandedFileFolds, hasUnfoldedFile, mergedWorktreeGroups, streamSections, worktreeGroups,
} from './detail.js'
import { ChangeTree } from './ChangeTree.jsx'
import type { BulkFoldMode, ChangeStage, ChangeTreeControl, DiffFetchResult, RowExpansion } from './ChangeTree.js'
import type { ReadingAnchor } from '../state.js'

/* The arrow turns back on itself: a U-turn, not a corner with a stub. */
const STAGE_HISTORY_PATHS: Readonly<Record<'undo' | 'redo', string>> = {
  undo: 'M6.17 2.5 2.5 6.17l3.67 3.66M2.5 6.17h7.33a3.67 3.67 0 0 1 0 7.33H7',
  redo: 'M9.83 2.5 13.5 6.17l-3.67 3.66M13.5 6.17H6.17a3.67 3.67 0 0 0 0 7.33H9',
}

/** The two directions the staging history toolbar offers, in display order. */
const STAGE_HISTORY_ACTIONS: readonly ('undo' | 'redo')[] = ['undo', 'redo']

/** Props of one staging-history control. */
interface StageHistoryButtonProps {
  action: 'undo' | 'redo'
  entry: StageHistoryEntry | null | undefined
  busy: boolean
  onAction: (action: string, id: string) => Promise<boolean>
  t: Translate
  locale?: string
}

function StageHistoryButton({ action, entry, busy, onAction, t, locale }: StageHistoryButtonProps) {
  const undo = action === 'undo'
  const label = t(undo ? 'stage.undo' : 'stage.redo')
  const available = typeof entry?.id === 'string' && typeof entry.path === 'string'
  let title = t(undo ? 'stage.noUndo' : 'stage.noRedo')
  if (available) {
    const unstaged = entry.scope === 'staged'
    let operation = t(unstaged ? 'stage.unstageFile' : 'stage.stageFile')
    if (entry.lineCount === 1) operation = t(unstaged ? 'stage.unstageLine' : 'stage.stageLine')
    else if (Number.isSafeInteger(entry.lineCount)) {
      operation = t(unstaged ? 'stage.unstageSelected' : 'stage.stageSelected', { count: formatCount(entry.lineCount!, locale) })
    } else if (Number.isSafeInteger(entry.fileCount)) {
      operation = formatPlural(t, unstaged ? 'stage.unstageFiles' : 'stage.stageFiles', entry.fileCount!, locale)
    }
    const path = entry.path === '' ? t('stage.repositoryRoot') : entry.path
    const target = t(undo ? 'stage.undoTarget' : 'stage.redoTarget', { operation, path })
    title = busy ? `${t('stage.historyBusy')} ${target}` : target
  }
  return (
    <span className="vcs-stage-history-control">
      <button
        type="button"
        className="vcs-icon-button vcs-stage-history-button"
        data-stage-history={action}
        aria-label={label}
        aria-description={title}
        aria-disabled={busy || !available ? true : undefined}
        title={title}
        onClick={busy || !available ? undefined : event => {
          event.stopPropagation()
          event.currentTarget.focus({ preventScroll: true })
          void onAction(action, entry.id)
        }}
      >
        <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d={STAGE_HISTORY_PATHS[action]}
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="vcs-stage-history-preview" aria-hidden="true">{title}</span>
    </span>
  )
}

/** Props of the commit-id copy control. */
interface ShaButtonProps {
  sha: string
  t: Translate
}

/** Commit id with a copy action. */
function ShaButton({ sha, t }: ShaButtonProps) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => { setCopied(false) }, 1600)
    return () => { clearTimeout(timer) }
  }, [copied])
  const copy = () => {
    if (navigator.clipboard?.writeText === undefined) return
    navigator.clipboard.writeText(sha).then(() => { setCopied(true) }).catch(() => { setCopied(false) })
  }
  return (
    <Button className="vcs-sha-button" onClick={copy} title={t(copied ? 'status.copied' : 'commit.copySha')} aria-label={t('commit.copySha')}>
      <code>{shortSha(sha)}</code>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

/** The commit read one detail pane holds. */
export interface CommitState {
  status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'
  commit: CommitDetail | null
  truncated: boolean
  error: ApiFailure | null
}

/** Props of the commit header block. */
interface CommitHeaderProps {
  commitState: CommitState
  summary: CommitNode | null | undefined
  copyLabels: readonly string[]
  onSelectCommit: (sha: string) => void
  isLoaded: (sha: string) => boolean
  onRetry: () => void
  t: Translate
  locale?: string
}

/** The commit header block: subject, people, parents, and message body. */
function CommitHeader({ commitState, summary, copyLabels, onSelectCommit, isLoaded, onRetry, t, locale }: CommitHeaderProps) {
  const detail = commitState.commit
  const subject = detail?.subject ?? summary?.subject ?? ''
  const body = messageBody(detail?.message)
  const changeId = detail?.changeId ?? summary?.changeId
  const parents = Array.isArray(detail?.parents) ? detail.parents : []
  const files = Array.isArray(detail?.files) ? detail.files : []
  return (
    <header className="vcs-node-header">
      <div className="vcs-node-heading">
        <WorkingCopyBadge labels={copyLabels} title={t('commit.workingCopy')} />
        <h2 className="vcs-node-title">{subject === '' ? t('commit.noDescription') : subject}</h2>
      </div>
      {commitState.status === 'error' ? (
        <div className="vcs-node-status">
          <span>{t('commit.error')} {errorMessage(t, commitState.error)}</span>
          <Button onClick={onRetry}>{t('error.retry')}</Button>
        </div>
      ) : detail === null || detail === undefined ? (
        <MetaSkeleton label={t('commit.loading')} />
      ) : (
        <>
          <dl className="vcs-commit-meta">
            {changeId === undefined ? null : (
              <>
                <dt>{t('commit.changeId')}</dt>
                <dd><code>{changeId}</code></dd>
              </>
            )}
            <dt>{t('commit.author')}</dt>
            <dd>{detail.author} <span className="vcs-dim">{formatDateTime(detail.authorTime, locale)}</span></dd>
            {detail.committer !== undefined
              && (detail.committer !== detail.author || detail.committerTime !== detail.authorTime) ? (
                <>
                  <dt>{t('commit.committer')}</dt>
                  <dd>{detail.committer} <span className="vcs-dim">{formatDateTime(detail.committerTime, locale)}</span></dd>
                </>
              ) : null}
            <dt>{t('commit.parents')}</dt>
            <dd>
              {parents.length === 0
                ? <span className="vcs-dim">{t('commit.root')}</span>
                : parents.map(parent => (isLoaded(parent) ? (
                  <button
                    key={parent}
                    type="button"
                    className="vcs-parent vcs-parent-link"
                    title={t('commit.showParent', { sha: shortSha(parent) })}
                    onClick={() => { onSelectCommit(parent) }}
                  >
                    <code>{shortSha(parent)}</code>
                  </button>
                ) : <code key={parent} className="vcs-parent" title={parent}>{shortSha(parent)}</code>))}
            </dd>
          </dl>
          {body === '' ? null : <pre className="vcs-commit-message">{body}</pre>}
          {files.length === 0 ? <p className="vcs-note">{t('commit.noFiles')}</p> : null}
          {commitState.truncated ? <p className="vcs-note">{formatPlural(t, 'commit.filesTruncated', files.length, locale)}</p> : null}
        </>
      )}
    </header>
  )
}

/** Props of the working-tree header block. */
interface WorktreeHeaderProps {
  status: StatusData | null
  statusState: DetailStatusState
  statusError: ApiFailure | null
  t: Translate
}

/** The working-tree header block: only states that replace the change tree. */
function WorktreeHeader({ status, statusState, statusError, t }: WorktreeHeaderProps) {
  if (status === null) {
    if (statusState === 'error') {
      return <header className="vcs-node-header"><p className="vcs-node-status">{t('changes.error')} {errorMessage(t, statusError)}</p></header>
    }
    // The groups and files are on their way: draw tree rows where they will land.
    return <TreeSkeleton label={t('changes.loading')} />
  }
  if ((status.total ?? 0) > 0) return null
  return (
    <header className="vcs-node-header vcs-node-empty">
      <p className="vcs-empty-title">{t('changes.clean')}</p>
      <p className="vcs-note">{t('changes.cleanHint')}</p>
    </header>
  )
}

/** Maximum commit details kept across node switches of the same revision. */
const COMMIT_CACHE_LIMIT = 200

/** Store one commit detail, evicting the oldest past {@link COMMIT_CACHE_LIMIT}. */
function rememberCommit(cache: Map<string, CommitState> | null | undefined, key: string, value: CommitState): void {
  if (cache === undefined || cache === null) return
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > COMMIT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

/** The status read state the working-tree header distinguishes. */
export type DetailStatusState = 'idle' | 'loading' | 'ready' | 'error'

/** One working-copy marker the header names. */
export interface WorkingCopyLabel {
  label: string
}

/** The checkout the worktree header names. */
export interface DetailWorktree {
  path: string
  label: string
}

/** What the detail pane can drive in the change tree from outside it. */
export interface DetailPaneControl {
  focusNav(): boolean
  restoreFocus(): boolean
  handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): boolean
  isSettled(): boolean
}

/** Props of the detail pane of one node. */
export interface DetailPaneProps {
  api: Api
  repo: string
  node: string
  summary?: CommitNode | null
  status: StatusData | null
  statusState: DetailStatusState
  statusError: ApiFailure | null
  dirChildren: Record<string, readonly UntrackedChild[]>
  loadingDirs: Record<string, boolean>
  dirs: Record<string, boolean>
  collapsed: Record<string, boolean>
  onToggleDir: (row: DirRow | GroupRow) => void
  folds: Record<string, boolean>
  onToggleFold: (key: string, folded: boolean) => void
  onSetFolds: (folds: Record<string, boolean>) => void
  split: boolean
  wrap: boolean
  onToggleSplit: (split: boolean) => void
  onToggleWrap: (wrap: boolean) => void
  mergeStaging?: boolean
  onToggleStageLayout?: (mergeStaging: boolean, anchor: ReadingAnchor | null, folds: Record<string, boolean>) => void
  singleColumn: boolean
  onBack: () => void
  onLeaveNav: () => void
  onSelectCommit: (sha: string) => void
  isLoaded: (sha: string) => boolean
  onMissing: () => void
  onSettled?: (hasRows: boolean) => void
  revision: number
  backgroundDiffRevision: number | undefined
  cache: Map<string, DiffFetchResult>
  commitCache?: Map<string, CommitState> | null
  initialAnchor: ReadingAnchor | null
  onReading: (anchor: ReadingAnchor | null) => void
  control: MutableRefObject<DetailPaneControl | null>
  capabilities: RepositoryCapabilities | null
  onRefActions?: (reference: VcsRef, point: RefActivation, target: HTMLElement) => void
  onStage?: ChangeStage
  stageDisabled: boolean
  onStageHistory?: (action: string, id: string) => Promise<boolean>
  onInteractionChange?: (interacting: boolean) => void
  worktree?: DetailWorktree | null
  workingCopies?: readonly WorkingCopyLabel[]
  snapshotError?: ApiFailure | null
  showCurrentHead?: boolean
  t: Translate
  locale?: string
}

/**
 * Render the detail of one node. The parent keys this component by node, so
 * every node starts with fresh local state.
 * @param props - node, data, and handlers from the panel.
 */
export function DetailPane({
  api, repo, node, summary, status, statusState, statusError,
  dirChildren, loadingDirs, dirs, collapsed, onToggleDir,
  folds, onToggleFold, onSetFolds, split, wrap, onToggleSplit, onToggleWrap,
  mergeStaging = true, onToggleStageLayout,
  singleColumn, onBack, onLeaveNav, onSelectCommit, isLoaded, onMissing, onSettled,
  revision, backgroundDiffRevision, cache, commitCache, initialAnchor, onReading, control, capabilities, onRefActions, onStage, stageDisabled, t, locale,
  onStageHistory, onInteractionChange, worktree = null, workingCopies = [], snapshotError = null, showCurrentHead = true,
}: DetailPaneProps) {
  const isWorktree = worktree !== null
  const canMergeStaging = isWorktree && capabilities?.staging === true
  const merged = canMergeStaging && mergeStaging
  const stageHistory = isWorktree && onStageHistory !== undefined ? status?.stageHistory : undefined
  const copyLabels = workingCopies.map(copy => copy.label)
  const commitCacheKey = `${repo}|${node}|${revision}`
  const [commitState, setCommitState] = useState<CommitState>(() => {
    if (!isWorktree && commitCache !== undefined && commitCache !== null) {
      const cached = commitCache.get(commitCacheKey)
      if (cached !== undefined) return cached
    }
    return { status: 'idle', commit: null, truncated: false, error: null }
  })
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const treeControl = useRef<ChangeTreeControl | null>(null)

  useEffect(() => {
    if (isWorktree) return undefined
    if (attempt === 0 && commitCache !== undefined && commitCache !== null) {
      const cached = commitCache.get(commitCacheKey)
      if (cached !== undefined) {
        setCommitState(cached)
        return undefined
      }
    }
    const controller = new AbortController()
    setCommitState(previous => ({ ...previous, status: previous.commit === null ? 'loading' : 'refreshing', error: null }))
    api.commit(repo, node, controller.signal).then(answer => {
      if (controller.signal.aborted) return
      if (answer?.commit === null || typeof answer?.commit !== 'object') {
        setCommitState({ status: 'error', commit: null, truncated: false, error: null })
        return
      }
      const next: CommitState = { status: 'ready', commit: answer.commit, truncated: answer.truncated === true, error: null }
      rememberCommit(commitCache, commitCacheKey, next)
      setCommitState(next)
    }).catch((error: ApiFailure) => {
      if (error?.name === 'AbortError' || controller.signal.aborted) return
      if (error?.code === 'not-found') onMissing()
      setCommitState({ status: 'error', commit: null, truncated: false, error })
    })
    return () => { controller.abort() }
  }, [api, attempt, commitCache, commitCacheKey, isWorktree, node, onMissing, repo, revision])

  // The tree's own width decides whether a side-by-side comparison fits.
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

  const sourceGroups = useMemo(
    () => (isWorktree ? worktreeGroups(status) : commitGroups(commitState.commit)),
    [commitState.commit, isWorktree, status],
  )
  const mergedGroups = useMemo(() => canMergeStaging ? mergedWorktreeGroups(sourceGroups) : [], [canMergeStaging, sourceGroups])
  const groups = merged ? mergedGroups : sourceGroups
  // A running Host may still serve the previous status shape during a Client reload.
  const partiallyStaged = useMemo(() => {
    const staged = new Set(sourceGroups.find(group => group.id === 'staged')?.entries.map(entry => entry.path))
    const unstaged = sourceGroups.find(group => group.id === 'unstaged')?.entries ?? []
    return new Set(unstaged.filter(entry => staged.has(entry.path)).map(entry => entry.path))
  }, [sourceGroups])
  // Use the id of the files we are showing even if a snapshot is in flight.
  const rev = isWorktree ? null : (commitState.commit?.sha ?? node)
  // The expand action follows the fully expanded order, so collapsing a
  // directory never changes which other files stay folded.
  const allSections = useMemo(() => streamSections(groups, dirChildren, rev), [dirChildren, groups, rev])
  const budget = useMemo(() => budgetFolds(allSections), [allSections])
  const rowExpansion = useMemo<RowExpansion>(() => ({ collapsed, dirs }), [collapsed, dirs])
  const rows = useMemo(
    () => buildNodeRows(groups, { ...rowExpansion, dirChildren, loadingDirs }),
    [dirChildren, groups, loadingDirs, rowExpansion],
  )
  const someUnfolded = useMemo(
    () => hasUnfoldedFile(allSections, folds),
    [allSections, folds],
  )
  const splitFits = width === 0 || width >= SPLIT_MIN_WIDTH
  const showSplit = split && splitFits
  const splitAction = t(splitFits
    ? (split ? 'diff.unified' : 'diff.split')
    : (split ? 'diff.splitNarrowOff' : 'diff.splitNarrowOn'))
  const constrainedSplitTitle = splitFits ? undefined : `${splitAction} ${t('diff.splitNarrow')}`

  /** Collapse or expand one row: file folds, group and directory expansion. */
  const toggleRow = useCallback((row: NavRow, nextExpanded: boolean) => {
    if (row.kind === 'file') {
      onToggleFold(row.key, !nextExpanded)
      return
    }
    onToggleDir(row)
  }, [onToggleDir, onToggleFold])

  /** Collapse every file of the node, or expand every file the budget allows. */
  const bulkFold = useCallback((mode: BulkFoldMode) => {
    onSetFolds(mode === 'collapse' ? allFileFolds(allSections) : expandedFileFolds(allSections, budget))
  }, [allSections, budget, onSetFolds])

  const toggleAll = () => {
    const mode = someUnfolded ? 'collapse' : 'expand'
    if (treeControl.current !== null) treeControl.current.bulkFold(mode)
    else bulkFold(mode)
  }

  const toggleStageLayout = () => {
    const anchor = treeControl.current?.readingAnchor() ?? null
    const nextSections = streamSections(merged ? sourceGroups : mergedGroups, dirChildren, rev)
    const open = new Set(allSections.filter(section => folds[section.key] === false).map(section => section.entry.path))
    const nextFolds = { ...folds }
    for (const section of nextSections) {
      if (open.has(section.entry.path)) nextFolds[section.key] = false
    }
    let nextAnchor: ReadingAnchor | null = null
    if (anchor !== null) {
      const path = anchor.key.slice(anchor.key.indexOf('|') + 1)
      const matches = nextSections.filter(section => section.entry.path === path)
      const target = matches.find(section => section.group === 'unstaged') ?? matches[0]
      if (target !== undefined) nextAnchor = { key: target.key, offset: 0 }
      else if (path !== '') {
        const group = merged ? 'unstaged' : 'merged-dir'
        const key = anchor.key.startsWith('unstaged|') && dirs[anchor.key] === true ? anchor.key : `${group}|${path}`
        nextAnchor = { key, offset: 0 }
      }
    }
    onToggleStageLayout?.(!merged, nextAnchor, nextFolds)
  }

  const settled = isWorktree
    ? status !== null || statusState === 'error'
    : commitState.commit !== null || commitState.status === 'error'

  useLayoutEffect(() => {
    control.current = {
      focusNav() {
        return treeControl.current?.focusReading() === true
      },
      restoreFocus() {
        return treeControl.current?.restoreFocus() === true
      },
      handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
        return treeControl.current?.handleKeyDown(event) === true
      },
      isSettled() {
        return settled
      },
    }
    return () => { control.current = null }
  }, [control, settled])

  useEffect(() => {
    if (!settled) return
    onSettled?.(rows.length > 0)
  }, [onSettled, rows.length, settled])

  const header = isWorktree
    ? <WorktreeHeader status={status} statusState={statusState} statusError={statusError} t={t} />
    : (
      <CommitHeader
        commitState={commitState}
        summary={summary}
        copyLabels={copyLabels}
        onSelectCommit={onSelectCommit}
        isLoaded={isLoaded}
        onRetry={() => { setAttempt(value => value + 1) }}
        t={t}
        locale={locale}
      />
    )

  const before = (
    <>
      {snapshotError === null ? null : (
        <p className="vcs-note" role="alert">{t('changes.error')} {errorMessage(t, snapshotError)}</p>
      )}
      {header}
      {isWorktree && status?.truncated === true ? <p className="vcs-note">{t('changes.truncatedMany')}</p> : null}
      {/* The commit's files arrive with its facts; the facts' shape already speaks for both. */}
      {!isWorktree && commitState.commit === null && commitState.status !== 'error' ? <TreeSkeleton /> : null}
    </>
  )

  const refs = summary?.refs ?? commitState.commit?.refs ?? []
  const displayedRefs = showCurrentHead ? refs : sharedRefs(refs)
  const mergedCounts = merged ? summarizeEntries(mergedGroups[0]?.entries ?? []) : null
  const worktreeCounts = isWorktree ? worktreeSummary(status) : null
  const summaryCounts = mergedCounts === null || worktreeCounts === null
    ? worktreeCounts
    : {
        added: mergedCounts.added,
        deleted: mergedCounts.deleted,
        untracked: worktreeCounts.untracked,
        changed: mergedCounts.count + (worktreeCounts.untracked - mergedCounts.untracked),
      }
  const worktreeStat = summaryCounts !== null && summaryCounts.changed > 0 ? (
    <>
      <span className="vcs-dim">{formatPlural(t, 'detail.fileCount', summaryCounts.changed, locale)}</span>
      <UntrackedStat count={summaryCounts.untracked} label={t('status.untracked')} locale={locale} />
      {summaryCounts.added > 0 ? <span className="vcs-add">+{formatCount(summaryCounts.added, locale)}</span> : null}
      {summaryCounts.deleted > 0 ? <span className="vcs-del">−{formatCount(summaryCounts.deleted, locale)}</span> : null}
    </>
  ) : null
  const commitCounts = isWorktree || commitState.commit === null ? null : commitSummary(commitState.commit.files)
  const commitSource = commitState.commit ?? summary ?? null
  const base = isWorktree || commitSource === null ? null : comparisonBase(commitSource, capabilities)
  const baseText = base === null
    ? null
    : base.kind === 'root'
      ? t('commit.baseRoot')
      : base.kind === 'autoMerge'
        ? t('commit.baseAutoMerge')
        : base.kind === 'merge'
          ? t('commit.baseMerge', { sha: shortSha(base.parent!) })
          : t('commit.baseParent', { sha: shortSha(base.parent!) })

  return (
    <div className="vcs-detail" ref={rootRef}>
      <div className="vcs-detail-toolbar" data-stage-tools={stageHistory !== undefined ? '' : undefined}>
        {singleColumn ? <IconButton label={t('detail.back')} onClick={onBack}><BackIcon /></IconButton> : null}
        {isWorktree ? (
          <>
            <strong className="vcs-detail-title" title={worktree?.path}>{worktree?.label}</strong>
            {status?.branch?.name ? <span className="vcs-detail-branch vcs-dim"><BranchIcon /><span className="vcs-detail-branch-name">{status.branch.name}</span></span> : null}
            {worktreeStat === null ? null : <span className="vcs-detail-stat">{worktreeStat}</span>}
          </>
        ) : (
          <>
            <WorkingCopyBadge labels={copyLabels} title={t('commit.workingCopy')} />
            <ShaButton sha={commitState.commit?.sha ?? summary?.sha ?? node} t={t} />
            {typeof commitState.commit?.changeId === 'string' && commitState.commit.changeId !== '' ? (
              <code className="vcs-detail-change" title={t('commit.changeId')}>{shortChangeId(commitState.commit.changeId)}</code>
            ) : null}
            {displayedRefs.length === 0 ? null : (
              <span className="vcs-detail-refs">
                {displayedRefs.map(reference => (
                  <RefBadge
                    key={`${reference.kind}:${reference.name}`}
                    reference={reference}
                    onRefActivate={onRefActions}
                  />
                ))}
              </span>
            )}
            {commitCounts === null ? null : (
              <span className="vcs-detail-stat">
                <span className="vcs-dim">{formatPlural(t, 'detail.fileCount', commitCounts.count, locale)}</span>
                {commitCounts.added > 0 ? <span className="vcs-add">+{formatCount(commitCounts.added, locale)}</span> : null}
                {commitCounts.deleted > 0 ? <span className="vcs-del">−{formatCount(commitCounts.deleted, locale)}</span> : null}
              </span>
            )}
            {baseText === null ? null : <span className="vcs-detail-base vcs-dim">{baseText}</span>}
          </>
        )}
        <span className="vcs-detail-spacer" />
        {stageHistory !== undefined ? (
          <span className="vcs-diff-tools">
            {STAGE_HISTORY_ACTIONS.map(action => (
              <StageHistoryButton
                key={action}
                action={action}
                entry={stageHistory[action]}
                busy={stageDisabled}
                onAction={onStageHistory!}
                t={t}
                locale={locale}
              />
            ))}
          </span>
        ) : null}
        <span className="vcs-diff-tools">
          {canMergeStaging && onToggleStageLayout !== undefined ? (
            <IconButton
              label={t('changes.mergeStaging')}
              title={t(merged ? 'changes.showSeparateStaging' : 'changes.showMergedStaging')}
              pressed={merged}
              onClick={toggleStageLayout}
              className="vcs-diff-tool vcs-stage-layout"
            >
              <StagingLayoutIcon merged={merged} />
            </IconButton>
          ) : null}
          <IconButton
            label={someUnfolded ? t('tree.collapseAll') : t('tree.expandAll')}
            title={someUnfolded ? t('tree.collapseAllHint') : t('tree.expandAllHint')}
            onClick={toggleAll}
            className="vcs-diff-tool"
          >
            <FoldIcon expanded={someUnfolded} />
          </IconButton>
          <IconButton
            label={t('diff.splitAria')}
            pressed={split}
            title={constrainedSplitTitle ?? splitAction}
            description={constrainedSplitTitle}
            onClick={() => { onToggleSplit(!split) }}
            className="vcs-diff-tool vcs-diff-split"
          >
            <CompareSplitIcon split={showSplit} />
          </IconButton>
          <IconButton
            label={t('diff.wrapAria')}
            pressed={wrap}
            title={wrap ? t('diff.unwrap') : t('diff.wrap')}
            onClick={() => { onToggleWrap(!wrap) }}
            className="vcs-diff-tool"
          >
            {wrap ? <WrapIcon /> : <NowrapIcon />}
          </IconButton>
        </span>
      </div>
      {stageHistory !== undefined && (summaryCounts?.untracked ?? 0) > 0 ? (
        <div className="vcs-detail-stat vcs-detail-stat-narrow">{worktreeStat}</div>
      ) : null}
      <ChangeTree
        key={merged ? 'merged' : 'separate'}
        api={api}
        repo={repo}
        rev={rev}
        rows={rows}
        rowExpansion={rowExpansion}
        budget={budget}
        folds={folds}
        split={showSplit}
        wrap={wrap}
        revision={revision}
        backgroundDiffRevision={backgroundDiffRevision}
        cache={cache}
        initialAnchor={initialAnchor}
        onReading={onReading}
        onToggleRow={toggleRow}
        onBulkFold={bulkFold}
        onLeave={onLeaveNav}
        control={treeControl}
        partiallyStaged={partiallyStaged}
        onStage={isWorktree ? onStage : undefined}
        stageDisabled={stageDisabled}
        onInteractionChange={onInteractionChange}
        before={before}
        t={t}
        locale={locale}
      />
    </div>
  )
}
