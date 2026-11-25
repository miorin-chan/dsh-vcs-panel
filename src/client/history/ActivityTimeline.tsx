/** A virtual timeline of local activity across the session's repositories. */

import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityEntry, ActivityFailure } from '../../lib/activity.js'
import type { RepositoryInfo } from '../api.js'
import { errorMessage, formatCount, formatPlural, sessionRelativePath, shortSha } from '../format.js'
import { findAncestor } from '../keys.js'
import { TimelineSkeleton } from '../skeleton.jsx'
import { Button, Chevron, RefBadge } from '../ui.jsx'
import { ACTIVITY_GUTTER, activityLayout } from './activity-layout.js'
import { localActivityDay } from './activity-model.js'
import type { ActivityModel, ActivityStop } from './activity-model.js'
import { hasSeveralAuthors } from './commits.js'
import { Graph } from './Graph.jsx'
import { DEFAULT_ROW_HEIGHT as ROW_HEIGHT, resolveColor } from './layout.js'
import { useTimelineNavigation } from './useTimelineNavigation.js'
import type { TimelineControl, TimelineKeyEvent } from './useTimelineNavigation.js'

const TOP_INSET = 24
const ROW_REFS = 2

export interface ActivityRepository extends RepositoryInfo {
  color: number
  relativePath: string
}

export function activityRepositories(repositories: readonly RepositoryInfo[], cwd?: string | null): Map<string, ActivityRepository> {
  return new Map(repositories.map((repo, color) => [repo.path, { ...repo, color, relativePath: sessionRelativePath(cwd, repo.path) }]))
}

export function ActivityRepositoryName({ repo }: { repo: ActivityRepository }) {
  return (
    <span className="vcs-activity-repo" title={repo.relativePath}
      style={{ '--vcs-activity-color': resolveColor(repo.color) } as CSSProperties}>
      <span className="vcs-activity-repo-dot" aria-hidden="true" />
      <span className="vcs-activity-repo-name">{repo.name}</span>
    </span>
  )
}

interface ActivityTimelineProps {
  model: ActivityModel
  entries: readonly ActivityEntry[]
  repositories: ReadonlyMap<string, ActivityRepository>
  selectedRow: number
  onSelect: (row: ActivityStop) => void
  onOpen: (row: ActivityStop) => void
  onReveal: (entry: ActivityEntry, keyboard: boolean) => void
  onToggle: (eventKey: string, returnToEvent: boolean) => void
  singleColumn: boolean
  control: { current: TimelineControl | null }
  t: Translate
  locale?: string
  loading: boolean
  loadingMore: boolean
  error: { code?: string; message?: string } | null
  failures: readonly ActivityFailure[]
  hasMore: boolean
  capped: boolean
  onLoadMore: () => void
  onRetry: () => void
  initialScrollTop: number
  onScrollOffset: (top: number) => void
  scrollRequest: number
}

function clockText(format: Intl.DateTimeFormat, time: number): string {
  const date = new Date(time * 1000)
  return Number.isFinite(date.getTime()) ? format.format(date) : ''
}

function dateTitle(date: string, today: Date, t: Translate, locale?: string): string {
  const day = new Date(`${date}T12:00:00`)
  if (!Number.isFinite(day.getTime())) return date
  const label = new Intl.DateTimeFormat(locale, {
    month: 'long', day: 'numeric', weekday: 'short',
    ...(day.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
  }).format(day)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  return date === localActivityDay(today.getTime() / 1000) ? `${t('all.today')} · ${label}`
    : date === localActivityDay(yesterday.getTime() / 1000) ? `${t('all.yesterday')} · ${label}` : label
}

function rowLabel(row: ActivityStop, repo: string, subject: string, t: Translate, locale?: string): string {
  if (row.kind === 'burst') return formatPlural(t, 'all.burstLabel', row.earlier, locale, { repo, subject })
  if (row.kind === 'batch') return formatPlural(t, 'all.batchLabel', row.repos.length, locale, { subject })
  if (row.entry.kind === 'stash') subject = t('stash.rowLabel', { selector: row.entry.stash.selector, message: subject })
  return t('all.rowLabel', { repo, subject })
}

export function ActivityTimeline({
  model, entries, repositories, selectedRow, onSelect, onOpen, onReveal, onToggle, singleColumn, control, t, locale,
  loading, loadingMore, error, failures, hasMore, capped, onLoadMore, onRetry, initialScrollTop, onScrollOffset, scrollRequest,
}: ActivityTimelineProps) {
  const { rows, rowIndex, selectable } = model
  const layout = useMemo(() => activityLayout(rows, [...repositories.keys()]), [repositories, rows])
  const severalAuthors = useMemo(() => hasSeveralAuthors(entries.flatMap(entry => entry.kind === 'commit' ? [entry.commit] : [])), [entries])
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), [locale])
  const today = new Date()
  const todayKey = localActivityDay(today.getTime() / 1000)
  const dates = useMemo(() => {
    let title = ''
    return rows.map(row => {
      if (row.kind === 'day') title = dateTitle(row.date, today, t, locale)
      return title
    })
    // Only the local calendar day (not the current clock time) affects the titles.
  }, [rows, todayKey, t, locale])
  const selectedKey = rows[selectedRow]?.key
  // Clicking a disclosure moves the cursor but leaves the selected detail alone.
  const [cursor, setCursor] = useState<{ key: string; selection: string | undefined } | null>(null)
  const cursorIndex = cursor !== null && cursor.selection === selectedKey ? rowIndex.get(cursor.key) : undefined
  const focusRow = cursorIndex ?? (selectedRow >= 0 ? selectedRow : selectable[0] ?? -1)
  const focused = rows[focusRow]
  const openFocused = () => {
    if (focused === undefined || focused.kind === 'day') return
    setCursor(null)
    onOpen(focused)
  }
  const onKey = (event: TimelineKeyEvent): boolean => {
    if (focused === undefined || focused.kind === 'day') return false
    if (findAncestor(event.target, null, node => node.dataset?.zone === 'timeline') === null) return false
    if (event.key === 'o') {
      event.preventDefault()
      onReveal(focused.entry, true)
      return true
    }
    if (event.key !== ' ') return false
    event.preventDefault()
    if (focused.kind !== 'single') {
      const child = focused.kind === 'child' || focused.kind === 'member'
      setCursor(child ? null : { key: focused.key, selection: selectedKey })
      onToggle(focused.event, child)
    }
    return true
  }
  const navigation = useTimelineNavigation({
    control, rowCount: rows.length, focusRow, selectedRow,
    readyToRestore: rows.length > 0, initialScrollTop, onScrollOffset, anchors: model, scrollRequest, topInset: TOP_INSET,
    unshifted: true, onKey, onOpen: openFocused,
    onMove(delta) {
      if (selectable.length === 0) return
      const position = Math.max(0, selectable.indexOf(focusRow))
      const target = rows[selectable[Math.max(0, Math.min(selectable.length - 1, position + delta))]]
      if (target.kind === 'day') return
      setCursor(null)
      onSelect(target)
    },
  })

  const repositoryName = (repo: string) => repositories.get(repo)?.name ?? repo
  const separator = t('all.listSeparator')
  const makeRow = (index: number) => {
    const row = rows[index]
    const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: ACTIVITY_GUTTER + 8 }
    if (row.kind === 'day') return (
      <div key={row.key} className="vcs-activity-day" role="presentation" style={style}>
        <span className="vcs-activity-day-title">{dates[index]}</span>
        <span className="vcs-activity-day-meta">
          {formatPlural(t, 'all.dayCommits', row.commits, locale)} · {formatPlural(t, 'all.count', row.repos, locale)}
        </span>
      </div>
    )
    const { entry } = row
    const repo = repositories.get(entry.repo)
    const name = repositoryName(entry.repo)
    const subject = entry.kind === 'stash' ? entry.stash.message || t('stash.untitled') : entry.commit.subject || t('commit.noDescription')
    const repoLabel = repo === undefined ? name : <ActivityRepositoryName repo={repo} />
    const expandable = row.kind === 'burst' || row.kind === 'batch' ? row : null
    const toggle = expandable === null ? null : (
      <button
        type="button" className="vcs-activity-toggle" tabIndex={-1}
        aria-expanded={expandable.expanded}
        aria-label={expandable.kind === 'burst'
          ? formatPlural(t, expandable.expanded ? 'all.hideEarlier' : 'all.showEarlier', expandable.earlier, locale)
          : formatPlural(t, expandable.expanded ? 'all.hideRepositories' : 'all.showRepositories', expandable.repos.length, locale)}
        onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
        onClick={event => {
          event.stopPropagation()
          setCursor({ key: row.key, selection: selectedKey })
          findAncestor(event.currentTarget, navigation.scrollRef.current, node => node.dataset?.timelineIndex !== undefined)
            ?.focus?.({ preventScroll: true })
          onToggle(expandable.event, false)
        }}
        onDoubleClick={event => { event.stopPropagation() }}
      >
        <Chevron open={expandable.expanded} />
        {expandable.kind === 'burst' ? formatCount(expandable.earlier, locale) : formatPlural(t, 'all.count', expandable.repos.length, locale)}
      </button>
    )
    const from = clockText(clock, row.kind === 'burst' ? row.from : entry.time)
    const to = clockText(clock, entry.time)
    return (
      <div
        key={row.key} className="vcs-timeline-row vcs-activity-row" data-kind={row.kind} role="button"
        data-timeline-index={index} tabIndex={index === focusRow ? 0 : -1} style={style}
        aria-current={index === selectedRow || undefined} aria-expanded={expandable?.expanded}
        aria-label={rowLabel(row, name, subject, t, locale)}
        onClick={event => {
          event.currentTarget.focus({ preventScroll: true })
          setCursor(null)
          // One column reads like the repository timeline: a click opens the detail.
          if (singleColumn) onOpen(row)
          else onSelect(row)
        }}
        onDoubleClick={() => { onReveal(entry, false) }}
      >
        <span className="vcs-timeline-title" title={row.kind === 'member' ? undefined : subject}>
          {row.kind === 'member' ? repoLabel : subject}
        </span>
        <span className="vcs-timeline-meta">
          {row.kind === 'single' || row.kind === 'burst' ? repoLabel : null}
          {toggle}
          {row.kind === 'batch' ? (
            <span className="vcs-activity-names" title={row.repos.map(repositoryName).join(separator)}>{row.repos.map(repositoryName).join(separator)}</span>
          ) : entry.kind === 'stash' ? (
            <>
              <RefBadge reference={{ kind: 'stash', name: entry.stash.selector }} />
              <span className="vcs-timeline-author">{entry.stash.branch ?? t('stash.detached')}</span>
              <span className="vcs-timeline-time">{to}</span>
            </>
          ) : (
            <>
              {entry.commit.refs.slice(0, ROW_REFS).map(reference => (
                <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />
              ))}
              {entry.commit.refs.length <= ROW_REFS ? null : (
                <span className="vcs-ref vcs-ref-more"
                  title={t('timeline.moreRefs', { refs: entry.commit.refs.slice(ROW_REFS).map(ref => ref.name).join(separator) })}>
                  +{entry.commit.refs.length - ROW_REFS}
                </span>
              )}
              <code className="vcs-timeline-sha" title={entry.commit.sha}>{shortSha(entry.commit.sha)}</code>
              {severalAuthors ? <span className="vcs-timeline-author">{entry.commit.author}</span> : null}
              <span className="vcs-timeline-time">{from === to ? to : `${from}–${to}`}</span>
            </>
          )}
        </span>
      </div>
    )
  }

  const first = navigation.visibleFirst
  const sticky = rows[first] !== undefined && rows[first].kind !== 'day' ? dates[first] : null
  const failedNames = failures.slice(0, 5).map(({ repo }) => repositoryName(repo)).join(separator)
  const moreFailures = failures.length > 5 ? ` ${formatPlural(t, 'all.more', failures.length - 5, locale)}` : ''

  return (
    <div className="vcs-timeline" data-scope="all">
      {failures.length === 0 ? null : (
        <div className="vcs-timeline-note vcs-activity-failures" role="status">
          <span>{formatPlural(t, 'all.failed', failures.length, locale, { names: failedNames + moreFailures })}</span>
          <Button onClick={onRetry}>{t('error.retry')}</Button>
        </div>
      )}
      <div className="vcs-timeline-viewport">
        <div
          className="vcs-timeline-scroll" ref={navigation.scrollRef} role="region" aria-label={t('all.title')}
          tabIndex={-1} data-zone="timeline" onScroll={navigation.onScroll} onKeyDown={navigation.onKeyDown}
        >
          <div className="vcs-timeline-rows" style={{ height: rows.length * ROW_HEIGHT }}>
            {navigation.indices.map(makeRow)}
          </div>
          {loading && rows.length === 0 ? (
            <TimelineSkeleton rows={Math.max(1, Math.ceil(navigation.viewport / ROW_HEIGHT))}
              rowHeight={ROW_HEIGHT} gutter={ACTIVITY_GUTTER} label={t('all.loading')} />
          ) : null}
          {loadingMore ? <TimelineSkeleton rows={3} rowHeight={ROW_HEIGHT} gutter={ACTIVITY_GUTTER} /> : null}
          {!loading && error !== null ? (
            <div className="vcs-timeline-note">
              <span>{t('history.error')} {errorMessage(t, error)}</span>
              <Button onClick={onRetry}>{t('error.retry')}</Button>
            </div>
          ) : null}
          {!loading && error === null && rows.length === 0 ? <div className="vcs-timeline-note">{t('all.empty')}</div> : null}
        </div>
        <Graph rowCount={rows.length} layout={layout} width={ACTIVITY_GUTTER}
          scrollTop={navigation.scrollTop} viewportHeight={navigation.viewport} selectedIndex={selectedRow} highlightStash />
        {sticky === null ? null : (
          <div className="vcs-activity-day-sticky" aria-hidden="true" style={{ paddingLeft: ACTIVITY_GUTTER + 8 }}>{sticky}</div>
        )}
      </div>
      {hasMore || capped ? (
        <div className="vcs-timeline-footer">
          {capped ? <span className="vcs-note">{formatPlural(t, 'all.capped', entries.length, locale)}</span>
            : !hasMore ? null : (
              <button type="button" className="vcs-load-more" aria-disabled={loadingMore || loading || undefined}
                onClick={() => { if (!loadingMore && !loading) onLoadMore() }}>
                {loadingMore ? t('history.loadingMore') : t('history.loadMore')}
              </button>
            )}
        </div>
      ) : null}
    </div>
  )
}
