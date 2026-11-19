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
import { sharedRefs } from '../worktrees.js'
import { errorMessage, formatCount, formatDateTime, shortChangeId, shortSha } from '../format.js'
import { messageBody } from '../history/commits.js'
import { worktreeSummary } from '../history/timeline.js'
import {
  BackIcon, BranchIcon, Button, CheckIcon, CompareSplitIcon, CopyIcon, FoldIcon, IconButton,
  NowrapIcon, RefBadge, WorkingCopyBadge, WrapIcon,
} from '../ui.jsx'
import { MetaSkeleton, TreeSkeleton } from '../skeleton.jsx'
import { buildNodeRows } from './tree.js'
import {
  SPLIT_MIN_WIDTH, allFileFolds, budgetFolds, commitGroups, commitSummary, comparisonBase,
  expandedFileFolds, hasUnfoldedFile, streamSections, worktreeGroups,
} from './detail.js'
import { ChangeTree } from './ChangeTree.jsx'

function StageHistoryButton({ action, entry, busy, onAction, t, locale }) {
  const undo = action === 'undo'
  const label = t(undo ? 'stage.undo' : 'stage.redo')
  const available = typeof entry?.id === 'string' && typeof entry.path === 'string'
  let title = t(undo ? 'stage.noUndo' : 'stage.noRedo')
  if (available) {
    const unstaged = entry.scope === 'staged'
    const operation = Number.isSafeInteger(entry.lineCount)
      ? t(unstaged ? 'stage.unstageSelected' : 'stage.stageSelected', { count: formatCount(entry.lineCount, locale) })
      : t(unstaged ? 'stage.unstageFile' : 'stage.stageFile')
    title = t(undo ? 'stage.undoTarget' : 'stage.redoTarget', { operation, path: entry.path })
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
            d={undo ? 'M6 3 2.5 6.5 6 10M3 6.5h6.5a4 4 0 0 1 4 4V13' : 'm10 3 3.5 3.5L10 10m3-3.5H6.5a4 4 0 0 0-4 4V13'}
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="vcs-stage-history-preview" aria-hidden="true">{title}</span>
    </span>
  )
}

/** Commit id with a copy action. */
function ShaButton({ sha, t }) {
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
    <Button className="vcs-sha-button" onClick={copy} title={t('commit.copySha')} aria-label={t('commit.copySha')}>
      <code>{shortSha(sha)}</code>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

/** The commit header block: subject, people, parents, and message body. */
function CommitHeader({ commitState, summary, copyLabels, onSelectCommit, isLoaded, onRetry, t, locale }) {
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
          {commitState.truncated ? <p className="vcs-note">{t('commit.filesTruncated', { count: formatCount(files.length, locale) })}</p> : null}
        </>
      )}
    </header>
  )
}

/** The working-tree header block: only states that replace the change tree. */
function WorktreeHeader({ status, statusState, statusError, t }) {
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
function rememberCommit(cache, key, value) {
  if (cache === undefined || cache === null) return
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > COMMIT_CACHE_LIMIT) cache.delete(cache.keys().next().value)
}

/**
 * Render the detail of one node. The parent keys this component by node, so
 * every node starts with fresh local state.
 * @param {object} props - node, data, and handlers from the panel.
 */
export function DetailPane({
  api, repo, node, summary, status, statusState, statusError,
  dirChildren, loadingDirs, dirs, collapsed, onToggleDir,
  folds, onToggleFold, onSetFolds, split, wrap, onToggleSplit, onToggleWrap,
  singleColumn, onBack, onLeaveNav, onSelectCommit, isLoaded, onMissing, onSettled,
  revision, cache, commitCache, initialAnchor, onReading, control, capabilities, onRefActions, onStage, stageDisabled, t, locale,
  onStageHistory, worktree = null, workingCopies = [], snapshotError = null, showCurrentHead = true,
}) {
  const isWorktree = worktree !== null
  const stageHistory = isWorktree && onStageHistory !== undefined ? status?.stageHistory : undefined
  const copyLabels = workingCopies.map(copy => copy.label)
  const commitCacheKey = `${repo}|${node}|${revision}`
  const [commitState, setCommitState] = useState(() => {
    if (!isWorktree && commitCache !== undefined && commitCache !== null) {
      const cached = commitCache.get(commitCacheKey)
      if (cached !== undefined) return cached
    }
    return { status: 'idle', commit: null, truncated: false, error: null }
  })
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(0)
  const rootRef = useRef(null)
  const treeControl = useRef(null)

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
      const next = { status: 'ready', commit: answer.commit, truncated: answer.truncated === true, error: null }
      rememberCommit(commitCache, commitCacheKey, next)
      setCommitState(next)
    }).catch(error => {
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

  const groups = useMemo(
    () => (isWorktree ? worktreeGroups(status) : commitGroups(commitState.commit)),
    [commitState.commit, isWorktree, status],
  )
  // Use the id of the files we are showing even if a snapshot is in flight.
  const rev = isWorktree ? null : (commitState.commit?.sha ?? node)
  // The expand action follows the fully expanded order, so collapsing a
  // directory never changes which other files stay folded.
  const allSections = useMemo(() => streamSections(groups, dirChildren, rev), [dirChildren, groups, rev])
  const budget = useMemo(() => budgetFolds(allSections), [allSections])
  const rows = useMemo(
    () => buildNodeRows(groups, { collapsed, dirs, dirChildren, loadingDirs }),
    [collapsed, dirChildren, dirs, groups, loadingDirs],
  )
  const someUnfolded = useMemo(
    () => hasUnfoldedFile(allSections, folds),
    [allSections, folds],
  )
  const splitNarrow = split && width > 0 && width < SPLIT_MIN_WIDTH

  /** Collapse or expand one row: file folds, group and directory expansion. */
  const toggleRow = useCallback((row, nextExpanded) => {
    if (row.kind === 'file') {
      onToggleFold(row.key, !nextExpanded)
      return
    }
    onToggleDir(row)
  }, [onToggleDir, onToggleFold])

  /** Collapse every file of the node, or expand every file the budget allows. */
  const bulkFold = useCallback(mode => {
    onSetFolds(mode === 'collapse' ? allFileFolds(allSections) : expandedFileFolds(allSections, budget))
  }, [allSections, budget, onSetFolds])

  const toggleAll = () => {
    const mode = someUnfolded ? 'collapse' : 'expand'
    if (treeControl.current !== null) treeControl.current.bulkFold(mode)
    else bulkFold(mode)
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
      handleKeyDown(event) {
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
  const summaryCounts = isWorktree ? worktreeSummary(status) : null
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
          ? t('commit.baseMerge', { sha: shortSha(base.parent) })
          : t('commit.baseParent', { sha: shortSha(base.parent) })

  return (
    <div className="vcs-detail" ref={rootRef}>
      <div className="vcs-detail-toolbar" data-stage-tools={stageHistory !== undefined ? '' : undefined}>
        {singleColumn ? <IconButton label={t('detail.back')} onClick={onBack}><BackIcon /></IconButton> : null}
        {isWorktree ? (
          <>
            <strong className="vcs-detail-title" title={worktree.path}>{worktree.label}</strong>
            {status?.branch?.name ? <span className="vcs-detail-branch vcs-dim"><BranchIcon /><span className="vcs-detail-branch-name">{status.branch.name}</span></span> : null}
            {summaryCounts !== null && summaryCounts.changed > 0 ? (
              <span className="vcs-detail-stat">
                <span className="vcs-dim">{t('detail.fileCount', { count: formatCount(summaryCounts.changed, locale) })}</span>
                {summaryCounts.added > 0 ? <span className="vcs-add">+{formatCount(summaryCounts.added, locale)}</span> : null}
                {summaryCounts.deleted > 0 ? <span className="vcs-del">−{formatCount(summaryCounts.deleted, locale)}</span> : null}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <WorkingCopyBadge labels={copyLabels} title={t('commit.workingCopy')} />
            <ShaButton sha={commitState.commit?.sha ?? summary?.sha ?? node} t={t} />
            {typeof commitState.commit?.changeId === 'string' && commitState.commit.changeId !== '' ? (
              <code className="vcs-detail-change" title={t('commit.changeId')}>{shortChangeId(commitState.commit.changeId)}</code>
            ) : null}
            <span className="vcs-detail-refs">
              {displayedRefs.map(reference => (
                <RefBadge
                  key={`${reference.kind}:${reference.name}`}
                  reference={reference}
                  onRefActivate={onRefActions}
                />
              ))}
            </span>
            {commitCounts === null ? null : (
              <span className="vcs-detail-stat">
                <span className="vcs-dim">{t('detail.fileCount', { count: formatCount(commitCounts.count, locale) })}</span>
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
            {['undo', 'redo'].map(action => (
              <StageHistoryButton
                key={action}
                action={action}
                entry={stageHistory?.[action]}
                busy={stageDisabled}
                onAction={onStageHistory}
                t={t}
                locale={locale}
              />
            ))}
          </span>
        ) : null}
        <span className="vcs-diff-tools">
          <IconButton
            label={someUnfolded ? t('tree.collapseAll') : t('tree.expandAll')}
            title={someUnfolded ? t('tree.collapseAllHint') : t('tree.expandAllHint')}
            onClick={toggleAll}
            className="vcs-diff-tool"
          >
            <FoldIcon open={someUnfolded} />
          </IconButton>
          <IconButton
            label={t('diff.splitAria')}
            pressed={split}
            title={splitNarrow ? t('diff.splitNarrow') : split ? t('diff.unified') : t('diff.split')}
            onClick={() => { onToggleSplit(!split) }}
            className="vcs-diff-tool vcs-diff-split"
          >
            <CompareSplitIcon />
          </IconButton>
          <IconButton
            label={t('diff.wrapAria')}
            pressed={wrap}
            title={wrap ? t('diff.unwrap') : t('diff.wrap')}
            onClick={() => { onToggleWrap(!wrap) }}
            className="vcs-diff-tool"
          >
            {wrap ? <NowrapIcon /> : <WrapIcon />}
          </IconButton>
        </span>
      </div>
      <ChangeTree
        api={api}
        repo={repo}
        rev={rev}
        rows={rows}
        budget={budget}
        folds={folds}
        split={split && !splitNarrow}
        wrap={wrap}
        revision={revision}
        cache={cache}
        initialAnchor={initialAnchor}
        onReading={onReading}
        onToggleRow={toggleRow}
        onBulkFold={bulkFold}
        onLeave={onLeaveNav}
        control={treeControl}
        onStage={isWorktree ? onStage : undefined}
        stageDisabled={stageDisabled}
        before={before}
        t={t}
        locale={locale}
      />
    </div>
  )
}
