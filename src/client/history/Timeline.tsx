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

import { useMemo } from 'react'
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { StashEntry } from '../../lib/stash-types.js'
import { graphWidth, Graph } from './Graph.jsx'
import type { GraphLayout } from './layout.js'
import { DEFAULT_ROW_HEIGHT } from './layout.js'
import { hasSeveralAuthors } from './commits.js'
import { worktreeSummary } from './timeline-model.js'
import type { TimelineRow, WorktreeStatus } from './timeline-model.js'
import { errorMessage, formatCommitTime, formatCount, formatPlural, shortChangeId, shortSha } from '../format.js'
import { findAncestor, hasClass } from '../keys.js'
import type { ElementLike } from '../keys.js'
import { RefBadge, UntrackedStat, WorkingCopyBadge } from '../ui.jsx'
import type { RefActivation, RefView } from '../ui.jsx'
import { Bar, TimelineSkeleton } from '../skeleton.jsx'
import { useTimelineNavigation } from './useTimelineNavigation.js'
import type { TimelineControl } from './useTimelineNavigation.js'

/** Fixed row height in CSS pixels. */
export const ROW_HEIGHT = DEFAULT_ROW_HEIGHT
/** Ref badges shown on a row before the rest are left to the detail. */
const ROW_REFS = 3

/** The status fields a working-copy row reads. */
export interface TimelineStatus extends WorktreeStatus {
  workingCopy?: {
    commitId?: string
    summary?: { changed: number; added: number; deleted: number }
  }
}

/** One checked working tree shown as a timeline row. */
export interface TimelineWorktree {
  id: string
  path: string
  name?: string
  head: string | null
  label: string
  refLabel: string | null
  status: TimelineStatus | null
  statusState: string
}

/** One working copy attached to a commit row. */
export interface TimelineWorkingCopy {
  path: string
  label: string
  statusState: string
  status?: TimelineStatus | null
}

/** The commit fields the timeline rows read. */
export interface TimelineCommit {
  sha: string
  changeId?: string | null
  subject: string
  author: string
  authorTime: number
  refs: readonly RefView[]
  workingCopies?: readonly TimelineWorkingCopy[]
}

/** One pointer position a menu opens at. */
export interface ActionPoint {
  clientX: number
  clientY: number
}

/** Open the ref actions menu for one ref badge. */
export type RefActionsHandler = (reference: RefView, event: RefActivation, anchor: ElementLike | null) => void

/** Open the commit actions menu for one commit row. */
export type CommitActionsHandler = (commit: TimelineCommit, point: ActionPoint, anchor: Element | null) => void
export type StashActionsHandler = (stash: StashEntry, point: ActionPoint, anchor: Element | null) => void

/** One row's mouse and keyboard routes into the same context menu. */
function rowActions(open: (point: ActionPoint, anchor: HTMLButtonElement) => void) {
  return {
    onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      open(event, event.currentTarget)
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      open({ clientX: rect.left + 12, clientY: rect.bottom ?? (rect.top + rect.height) }, event.currentTarget)
    },
  }
}

/** The badge context menu event; `RefActivation` omits the element it came from. */
interface RefMenuEvent extends RefActivation {
  currentTarget: Element | null
}

/** The timeline's props. */
export interface TimelineProps {
  rows: readonly TimelineRow<TimelineCommit>[]
  layout: GraphLayout
  worktrees?: readonly TimelineWorktree[]
  selectedRow: number
  onSelectRow: (index: number) => void
  onMove: (delta: number) => void
  onOpen: () => void
  onRefActions?: RefActionsHandler | undefined
  onCommitActions?: CommitActionsHandler | undefined
  onStashActions?: StashActionsHandler | undefined
  control?: { current: TimelineControl | null } | undefined
  t: Translate
  locale?: string
  loading: boolean
  loadingMore: boolean
  error: { code?: string; message?: string } | null
  hasMore: boolean
  canLoadMore?: boolean
  truncated: boolean
  stashesTruncated: boolean
  onLoadMore: () => void
  onRetry: () => void
  initialScrollTop?: number
  onScrollOffset?: (top: number) => void
}

/** Added/deleted counts in the diff colors; zero sides are left out. */
function LineStat({ added, deleted, locale }: { added: number; deleted: number; locale?: string }) {
  return (
    <>
      {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
      {deleted > 0 ? <span className="vcs-del">−{formatCount(deleted, locale)}</span> : null}
    </>
  )
}

/** The working-tree row's second line. */
function WorktreeMeta({ status, statusState, t, locale }: { status: TimelineStatus | null; statusState: string; t: Translate; locale?: string }) {
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
      <UntrackedStat added={summary.untrackedAdded} t={t} locale={locale} />
      <LineStat added={summary.added} deleted={summary.deleted} locale={locale} />
    </>
  )
}

/**
 * Render the timeline.
 * @param props - timeline state.
 */
export function Timeline({
  rows: timelineRows, layout, worktrees = [], selectedRow, onSelectRow, onMove, onOpen,
  onRefActions, onCommitActions, onStashActions, control, t, locale,
  loading, loadingMore, error, hasMore, truncated, stashesTruncated, onLoadMore, onRetry,
  initialScrollTop = 0, onScrollOffset, canLoadMore = true,
}: TimelineProps) {
  const commits = useMemo(() => timelineRows.flatMap(row => row.kind === 'commit' ? [row.commit] : []), [timelineRows])
  const rowCount = timelineRows.length
  const gutter = graphWidth(layout)
  const showAuthor = useMemo(() => hasSeveralAuthors(commits), [commits])
  const focusRow = rowCount === 0 ? -1 : Math.min(rowCount - 1, selectedRow >= 0 ? selectedRow : 0)
  const { scrollRef, scrollTop, viewport, indices, onScroll, onKeyDown } = useTimelineNavigation({
    rowCount, focusRow, selectedRow, readyToRestore: commits.length > 0, initialScrollTop, onScrollOffset,
    onMove, onOpen, control,
  })
  const now = Date.now()

  const renderRow = (index: number) => {
    const row = timelineRows[index]
    const common: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-timeline-index': number } = {
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
    if (row.kind === 'worktree') {
      const worktree = worktrees[index]
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
    if (row.kind === 'stash') {
      const { stash } = row
      const message = stash.message || t('stash.untitled')
      return (
        <button
          key={row.node}
          className="vcs-timeline-row vcs-stash-row"
          aria-label={t('stash.rowLabel', { selector: stash.selector, message })}
          aria-haspopup={onStashActions === undefined ? undefined : 'menu'}
          {...common}
          {...(onStashActions === undefined ? {} : rowActions((point, anchor) => { onStashActions(stash, point, anchor) }))}
        >
          <span className="vcs-timeline-title" title={message}>{message}</span>
          <span className="vcs-timeline-meta">
            <RefBadge reference={{ kind: 'stash', name: stash.selector }} />
            <span className="vcs-timeline-author">{stash.branch ?? t('stash.detached')}</span>
            <span className="vcs-timeline-time">{formatCommitTime(stash.time * 1_000, now, locale)}</span>
          </span>
        </button>
      )
    }
    const commit = row.commit
    const copies = commit.workingCopies ?? []
    const copyLabels = copies.map(copy => copy.label)
    const observed = copies.find(copy => copy.statusState !== 'error' && copy.status?.workingCopy?.commitId === commit.sha)
    const workingSummary = observed?.status?.workingCopy?.summary
    const shortId = typeof commit.changeId === 'string' && commit.changeId !== ''
      ? shortChangeId(commit.changeId)
      : shortSha(commit.sha)
    const subject = commit.subject === '' ? t('commit.noDescription') : commit.subject
    return (
      <button
        key={commit.sha}
        className={`vcs-timeline-row${copies.length > 0 ? ' vcs-working-copy-row' : ''}`}
        title={[copyLabels.join(', '), commit.changeId ?? shortSha(commit.sha), subject].filter(Boolean).join('  ')}
        {...common}
        {...(onCommitActions === undefined ? {} : rowActions((point, anchor) => { onCommitActions(commit, point, anchor) }))}
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
                  // The badge hands back the cancellation face of the React
                  // event; the menu anchor still needs the element it fired on.
                  const menuEvent = event as RefMenuEvent
                  onRefActions(
                    target,
                    event,
                    findAncestor(menuEvent.currentTarget, scrollRef.current, (node: unknown) => hasClass(node, 'vcs-timeline-row'))
                      ?? menuEvent.currentTarget,
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
          {workingSummary !== undefined && workingSummary.changed > 0 ? (
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

  return (
    <div className="vcs-timeline">
      <div className="vcs-timeline-viewport">
        <div
          ref={scrollRef}
          className="vcs-timeline-scroll"
          role="region"
          aria-label={t('timeline.label')}
          tabIndex={-1}
          data-zone="timeline"
          onKeyDown={onKeyDown}
          onScroll={onScroll}
        >
          <div className="vcs-timeline-rows" style={{ height: `${rowCount * ROW_HEIGHT}px` }}>
            {indices.map(renderRow)}
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
      {commits.length === 0 && !stashesTruncated ? null : (
        <div className="vcs-timeline-footer">
          <span className="vcs-timeline-count">
            {t('history.count', { count: `${formatCount(commits.length, locale)}${hasMore ? '+' : ''}` })}
          </span>
          {truncated ? <span className="vcs-note">{formatPlural(t, 'history.truncated', commits.length, locale)}</span> : null}
          {stashesTruncated ? <span className="vcs-note">{t('stash.listTruncated')}</span> : null}
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
