/**
 * The timeline: checked worktree rows, loaded commits, and the lane
 * graph overlaid.
 *
 * A backend with separate working trees contributes virtual rows; a backend whose
 * working copy is a commit contributes only its commits, one of which is `@`.
 * The graph and the rows share one scrollport and one row height, so lanes
 * never drift from their rows. Only the visible window is rendered; the graph
 * receives the same window bounds. Rows are two lines: the title gets the full
 * width, and refs, id, author, and time share the second line.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { graphWidth, Graph } from './Graph.jsx'
import { DEFAULT_ROW_HEIGHT } from './layout.js'
import { hasSeveralAuthors } from './commits.js'
import { worktreeSummary } from './timeline.js'
import { errorMessage, formatCommitTime, formatCount, formatPlural, shortChangeId, shortSha } from '../format.js'
import { DOWN, findAncestor, FORWARD, hasClass, isDiscreteActionButton, isEditableTarget, movement, unmodified, UP } from '../keys.js'
import { RefBadge, UntrackedStat, WorkingCopyBadge } from '../ui.jsx'
import { Bar, TimelineSkeleton } from '../skeleton.jsx'

/** Fixed row height in CSS pixels. */
export const ROW_HEIGHT = DEFAULT_ROW_HEIGHT
/** Rows drawn beyond each viewport edge. */
const OVERSCAN = 10
/** Ref badges shown on a row before the rest are left to the detail. */
const ROW_REFS = 3

/** Added/deleted counts in the diff colors; zero sides are left out. */
function LineStat({ added, deleted, locale }) {
  return (
    <>
      {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
      {deleted > 0 ? <span className="vcs-del">−{formatCount(deleted, locale)}</span> : null}
    </>
  )
}

/** The working-tree row's second line. */
function WorktreeMeta({ status, statusState, t, locale }) {
  if (status === null) {
    if (statusState === 'error') return <span className="vcs-timeline-error">{t('changes.error')}</span>
    return (
      <span className="vcs-skeleton vcs-timeline-meta-skeleton" role="status" aria-busy="true">
        <span className="vcs-sr-only">{t('changes.loading')}</span>
        <Bar width="96px" />
      </span>
    )
  }
  const summary = worktreeSummary(status)
  if (summary.changed === 0) return <span>{t('changes.clean')}</span>
  return (
    <>
      <span className="vcs-worktree-change-count">{formatPlural(t, 'timeline.changes', summary.changed, locale)}</span>
      <LineStat added={summary.added} deleted={summary.deleted} locale={locale} />
      <UntrackedStat count={summary.untracked} label={t('status.untracked')} locale={locale} />
    </>
  )
}

/**
 * Render the timeline.
 * @param {{ commits: object[], layout: object, worktrees?: object[], selectedRow: number, onSelectRow: (index: number) => void, onMove: (delta: number) => void, onOpen: () => void, onRefActions?: Function, onCommitActions?: Function, control?: { current: object | null }, t: Function, locale?: string, loading: boolean, loadingMore: boolean, error: object | null, hasMore: boolean, canLoadMore?: boolean, truncated: boolean, onLoadMore: Function, onRetry: Function, initialScrollTop?: number, onScrollOffset?: (top: number) => void }} props - timeline state.
 */
export function Timeline({
  commits, layout, worktrees = [], selectedRow, onSelectRow, onMove, onOpen,
  onRefActions, onCommitActions, control, t, locale,
  loading, loadingMore, error, hasMore, truncated, onLoadMore, onRetry,
  initialScrollTop = 0, onScrollOffset, canLoadMore = true,
}) {
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const restoreRef = useRef(initialScrollTop)
  const onScrollOffsetRef = useRef(onScrollOffset)
  onScrollOffsetRef.current = onScrollOffset

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    const measure = () => { setViewport(element.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // The first page may arrive after mount, when there is nothing to scroll
  // yet; apply the saved offset once commits are there.
  useEffect(() => {
    if (restoreRef.current === null || commits.length === 0) return
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = restoreRef.current
    setScrollTop(element.scrollTop)
    restoreRef.current = null
  }, [commits.length])

  // Keep the selected row in view; appending a page must not move the list.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null || selectedRow < 0 || element.clientHeight <= 0) return
    const top = selectedRow * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    let nextTop = element.scrollTop
    if (top < element.scrollTop) nextTop = top
    else if (bottom > element.scrollTop + element.clientHeight) nextTop = Math.max(0, bottom - element.clientHeight)
    if (nextTop !== element.scrollTop) {
      element.scrollTop = nextTop
      setScrollTop(nextTop)
      onScrollOffsetRef.current?.(nextTop)
    }
  }, [selectedRow])

  const rowCount = commits.length + worktrees.length
  const gutter = graphWidth(layout)
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const showAuthor = useMemo(() => hasSeveralAuthors(commits), [commits])
  const focusRow = rowCount === 0 ? -1 : Math.min(rowCount - 1, selectedRow >= 0 ? selectedRow : 0)
  const now = Date.now()

  const renderRow = index => {
    const worktree = worktrees[index]
    const common = {
      type: 'button',
      'data-timeline-index': index,
      'aria-current': index === selectedRow ? 'true' : undefined,
      tabIndex: index === focusRow ? 0 : -1,
      style: { top: `${index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, paddingLeft: `${gutter + 8}px` },
      onClick: event => {
        event?.currentTarget?.focus?.({ preventScroll: true })
        onSelectRow(index)
      },
    }
    if (worktree !== undefined) {
      const { status: treeStatus, statusState } = worktree
      const clean = treeStatus !== null && (treeStatus.total ?? 0) === 0
      return (
        <button key={worktree.id} className="vcs-timeline-row vcs-worktree-row" title={worktree.path} data-clean={clean ? 'true' : undefined} {...common}>
          <span className="vcs-timeline-title">{worktree.label}</span>
          <span className="vcs-timeline-meta">
            {worktree.refLabel === null ? null : <span className="vcs-worktree-ref">{worktree.refLabel}</span>}
            <WorktreeMeta status={treeStatus} statusState={statusState} t={t} locale={locale} />
          </span>
        </button>
      )
    }
    const commit = commits[index - worktrees.length]
    const copies = commit.workingCopies ?? []
    const copyLabels = copies.map(copy => copy.label)
    const observed = copies.find(copy => copy.statusState !== 'error' && copy.status?.workingCopy?.commitId === commit.sha)
    const workingSummary = observed?.status.workingCopy.summary
    const shortId = typeof commit.changeId === 'string' && commit.changeId !== ''
      ? shortChangeId(commit.changeId)
      : shortSha(commit.sha)
    const subject = commit.subject === '' ? t('commit.noDescription') : commit.subject
    const commitMenu = onCommitActions === undefined ? null : {
      onContextMenu: event => {
        if (event.defaultPrevented) return
        event.preventDefault()
        onCommitActions(commit, event, event.currentTarget)
      },
      onKeyDown: event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        onCommitActions(
          commit,
          { clientX: rect.left + 12, clientY: rect.bottom ?? (rect.top + rect.height) },
          event.currentTarget,
        )
      },
    }
    return (
      <button
        key={commit.sha}
        className={`vcs-timeline-row${copies.length > 0 ? ' vcs-working-copy-row' : ''}`}
        title={[copyLabels.join(', '), commit.changeId ?? shortSha(commit.sha), subject].filter(Boolean).join('  ')}
        {...common}
        onContextMenu={commitMenu?.onContextMenu}
        onKeyDown={commitMenu?.onKeyDown}
      >
        <span className="vcs-timeline-title">{subject}</span>
        <span className="vcs-timeline-meta">
          <WorkingCopyBadge labels={copyLabels} title={t('timeline.workingCopy')} />
          {commit.refs.slice(0, ROW_REFS).map(reference => (
            <RefBadge
              key={`${reference.kind}:${reference.name}`}
              reference={reference}
              onRefContextMenu={onRefActions === undefined
                ? undefined
                : (target, event) => {
                  onRefActions(
                    target,
                    event,
                    findAncestor(event.currentTarget, scrollRef.current, node => hasClass(node, 'vcs-timeline-row'))
                      ?? event.currentTarget,
                  )
                }}
            />
          ))}
          {commit.refs.length > ROW_REFS ? (
            <span
              className="vcs-ref vcs-ref-more"
              title={t('timeline.moreRefs', {
                refs: commit.refs.slice(ROW_REFS).map(reference => reference.name).join(', '),
              })}
            >
              +{commit.refs.length - ROW_REFS}
            </span>
          ) : null}
          <code className="vcs-timeline-sha" title={commit.sha}>{shortId}</code>
          {workingSummary?.changed > 0 ? (
            <>
              <span>{formatPlural(t, 'timeline.changes', workingSummary.changed, locale)}</span>
              <LineStat added={workingSummary.added} deleted={workingSummary.deleted} locale={locale} />
            </>
          ) : null}
          {copies.some(copy => copy.statusState === 'error') ? <span className="vcs-timeline-error">{t('changes.error')}</span> : null}
          {showAuthor ? <span className="vcs-timeline-author">{commit.author}</span> : null}
          <span className="vcs-timeline-time">{formatCommitTime(commit.authorTime, now, locale)}</span>
        </span>
      </button>
    )
  }

  const indices = []
  if (focusRow >= 0 && focusRow < first) indices.push(focusRow)
  for (let index = first; index < last; index += 1) indices.push(index)
  if (focusRow >= last && focusRow < rowCount) indices.push(focusRow)
  const rows = indices.map(renderRow)

  const pageStep = Math.max(1, Math.floor((viewport > 0 ? viewport : ROW_HEIGHT * 8) / ROW_HEIGHT) - 1)

  /** Keys of the timeline: move, page, jump to ends, or open the selected node's files. */
  const runKeyDown = useCallback(event => {
    if (!unmodified(event)) return false
    if (event.isComposing === true || isEditableTarget(event.target)) return false
    if (event.key === 'Enter' && isDiscreteActionButton(event.target, scrollRef.current)) return false
    const direction = movement(event)
    if (direction === DOWN) {
      event.preventDefault()
      onMove(1)
      return true
    }
    if (direction === UP) {
      event.preventDefault()
      onMove(-1)
      return true
    }
    if (event.key === 'PageDown') {
      event.preventDefault()
      onMove(pageStep)
      return true
    }
    if (event.key === 'PageUp') {
      event.preventDefault()
      onMove(-pageStep)
      return true
    }
    if (event.key === 'Home') {
      event.preventDefault()
      onMove(-Math.max(1, rowCount))
      return true
    }
    if (event.key === 'End') {
      event.preventDefault()
      onMove(Math.max(1, rowCount))
      return true
    }
    if (direction === FORWARD || event.key === 'Enter') {
      event.preventDefault()
      onOpen()
      return true
    }
    return false
  }, [onMove, onOpen, pageStep, rowCount])

  const restoreFocus = useCallback(() => {
    if (rowCount === 0 || focusRow < 0) return false
    const target = scrollRef.current?.querySelector(`[data-timeline-index="${focusRow}"]`)
    if (target === null || target === undefined) return false
    target.focus({ preventScroll: true })
    return true
  }, [focusRow, rowCount])

  useLayoutEffect(() => {
    if (control === undefined || control === null) return undefined
    control.current = {
      restoreFocus,
      handleKeyDown(event) {
        if (!runKeyDown(event)) return false
        const active = typeof document === 'undefined' ? null : document.activeElement
        if (active === null || active?.dataset?.timelineIndex === undefined || !scrollRef.current?.contains(active)) {
          restoreFocus()
        }
        return true
      },
    }
    return () => { control.current = null }
  }, [control, restoreFocus, runKeyDown])

  const onKeyDown = event => {
    runKeyDown(event)
  }

  return (
    <div className="vcs-timeline">
      <div className="vcs-timeline-viewport">
        <div
          ref={scrollRef}
          className="vcs-timeline-scroll"
          role="region"
          aria-label={t('timeline.label')}
          data-zone="timeline"
          onKeyDown={onKeyDown}
          onScroll={event => {
            setScrollTop(event.currentTarget.scrollTop)
            onScrollOffset?.(event.currentTarget.scrollTop)
          }}
        >
          <div className="vcs-timeline-rows" style={{ height: `${rowCount * ROW_HEIGHT}px` }}>
            {rows}
          </div>
          {loading && commits.length === 0 ? (
            <TimelineSkeleton
              rows={Math.max(1, Math.ceil(viewport / ROW_HEIGHT) - rowCount)}
              rowHeight={ROW_HEIGHT}
              gutter={gutter}
              label={t('history.loading')}
            />
          ) : null}
          {loadingMore ? <TimelineSkeleton rows={3} rowHeight={ROW_HEIGHT} gutter={gutter} /> : null}
          {!loading && error !== null ? (
            <div className="vcs-timeline-note">
              <span>{t('history.error')} {errorMessage(t, error)}</span>
              <button type="button" className="vcs-button" onClick={onRetry}>{t('error.retry')}</button>
            </div>
          ) : null}
          {!loading && error === null && commits.length === 0 ? (
            <div className="vcs-timeline-note"><span>{t('history.empty')}</span></div>
          ) : null}
        </div>
        <Graph
          rowCount={rowCount}
          layout={layout}
          rowHeight={ROW_HEIGHT}
          scrollTop={scrollTop}
          viewportHeight={viewport}
          width={gutter}
          selectedIndex={selectedRow}
        />
      </div>
      {commits.length === 0 ? null : (
        <div className="vcs-timeline-footer">
          <span className="vcs-timeline-count">
            {t('history.count', { count: `${formatCount(commits.length, locale)}${hasMore ? '+' : ''}` })}
          </span>
          {truncated ? <span className="vcs-note">{formatPlural(t, 'history.truncated', commits.length, locale)}</span> : null}
          {hasMore ? (
            <button
              type="button"
              className="vcs-load-more"
              aria-disabled={loadingMore || !canLoadMore ? 'true' : undefined}
              onClick={() => { if (!loadingMore && canLoadMore) onLoadMore() }}
            >
              {loadingMore ? t('history.loadingMore') : t('history.loadMore')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
