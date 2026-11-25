/**
 * The overview column switches repositories as soon as discovery lists them,
 * then fills in their pointers as they arrive. Selecting a pointer also moves
 * the timeline to its node, and the timeline's selection marks the pointer here.
 */

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { ApiFailure, RepositoryInfo } from '../api.js'
import { errorMessage, formatCommitTime, formatPlural } from '../format.js'
import { Bar, Skeleton } from '../skeleton.jsx'
import { Chevron, IconButton, SettingsIcon } from '../ui.jsx'
import type { OverviewData } from './useOverview.js'
import type { FilterId, PointerView, RepositoryView } from './model.js'
import {
  byAttention, checkoutLabel, elementWithData, FILTERS, filterCounts, gauge, headline, matchesFilter, matchesSearch, relativeTo,
} from './model.js'
import { FILTER_KEYS, STATE_KEYS } from './labels.js'
import { repositoryRects } from './motion.js'

/** Calls the panel makes into the column. */
export interface OverviewControl {
  /** Focus the last cursor position, falling back to the default row. */
  focus(): boolean
  /** Focus the current repository row, or the manage button when there are no rows. */
  focusCurrent(): void
  /** Focus the search box. */
  focusSearch(): void
  /** Each visible repository row's box; collapsed quiet repositories share the summary's box. */
  repositoryRects(): Map<string, DOMRect>
}

export interface OverviewPaneProps {
  data: OverviewData
  repositories: readonly RepositoryInfo[]
  views: readonly RepositoryView[]
  cwd: string | null
  currentRepo: string | null
  /** The pointer the timeline's selection names. */
  selected: string | null
  width: number
  onResize: (width: number) => void
  /** Select a repository; `keyboard` hands focus to the timeline. */
  onSelectRepository: (path: string, keyboard: boolean) => void
  /** Move the timeline to a pointer; `keyboard` hands focus to the timeline. */
  onSelectPointer: (pointer: PointerView, keyboard: boolean) => void
  onPointerActions: (pointer: PointerView, point: { clientX: number, clientY: number }, element: HTMLElement | null) => void
  onManageRepositories: (restoreFocus: () => void) => void
  onAddUnlisted: (paths: string[]) => void
  control: Ref<OverviewControl | null>
  t: Translate
  locale?: string
}

/** The fetch note of one repository. */
export function fetchNote(view: RepositoryView, t: Translate, locale?: string): { text: string, stale: boolean } {
  if (view.remotes.length === 0) return { text: t('overview.noRemote'), stale: false }
  if (view.fetchedAt === null) return { text: t('overview.neverFetched'), stale: true }
  const ms = view.fetchedAt * 1000
  return { text: t('overview.fetched', { time: formatCommitTime(ms, Date.now(), locale) }), stale: Date.now() - ms > 2 * 86_400_000 }
}

/** The headline of one pointer, localized. */
export function headlineText(pointer: PointerView, t: Translate, locale?: string): string {
  const line = headline(pointer)
  return line.count === undefined
    ? t(line.key)
    : formatPlural(t, line.key, line.count, locale, line.behind === undefined ? undefined : { behind: String(line.behind) })
}

/** The second line of one pointer row. */
export function pointerFacts(pointer: PointerView, view: RepositoryView, cwd: string | null, t: Translate, locale?: string): string[] {
  const facts: string[] = []
  if (pointer.occupant !== null) {
    const label = pointer.occupant.primary ? t('overview.mainCheckout') : checkoutLabel(pointer.occupant.path, view.path, cwd)
    facts.push(`${pointer.nested ? '⊂' : '⌂'} ${label}`)
  }
  if (pointer.kind === 'branch') {
    const distance = arrows(pointer.track?.ahead ?? 0, pointer.track?.behind ?? 0)
    if (typeof pointer.upstream !== 'string') {
      if (pointer.levelRemotes.length === 0) facts.push(t('overview.unpublished'))
    } else if (pointer.track?.gone === true) facts.push(`${pointer.upstream} · ${t('overview.upstreamGone')}`)
    else if (distance !== '' || pointer.levelRemotes.length === 0) facts.push(`${pointer.upstream} ${distance}`.trim())
    if (pointer.levelRemotes.length > 0) facts.push(`≡ ${pointer.levelRemotes.join(', ')}`)
  }
  if (pointer.kind === 'detached') facts.push(pointer.unique > 0 ? t('overview.detached') : t('overview.detachedClean'))
  if (pointer.kind === 'stash') facts.push(pointer.subject || t('stash.untitled'))
  if (pointer.base !== null && !pointer.baseIsUpstream && !pointer.isBase && pointer.kind !== 'stash') {
    facts.push(`${t('overview.versus', { base: pointer.base })} ${arrows(pointer.ahead ?? 0, pointer.behind ?? 0)}`.trim())
  }
  if (pointer.time !== null) facts.push(formatCommitTime(pointer.time * 1000, Date.now(), locale))
  return facts
}

/** Ahead and behind as arrows; a zero side is left out. */
export function arrows(ahead: number, behind: number): string {
  return [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ')
}

/** The glyph of a pointer kind: filled branch, hollow detached head, stash diamond, thin remote ring. */
export function KindGlyph({ kind }: { kind: PointerView['kind'] }) {
  return <span className="vcs-pointer-glyph" data-kind={kind} aria-hidden="true" />
}

/** The gauge around a pointer's base. */
function Gauge({ pointer }: { pointer: PointerView }) {
  const widths = gauge(pointer)
  return (
    <span className="vcs-gauge" aria-hidden="true">
      {widths.behind > 0 ? <span className="vcs-gauge-behind" data-merged={pointer.state === 'merged' || undefined} style={{ width: `${widths.behind}px` }} /> : null}
      {widths.published > 0 ? <span className="vcs-gauge-published" style={{ width: `${widths.published}px` }} /> : null}
      {widths.unique > 0 ? <span className="vcs-gauge-unique" style={{ left: `calc(50% + ${widths.published}px)`, width: `${widths.unique}px` }} /> : null}
    </span>
  )
}

/** Clamp the column width while dragging. */
function clampWidth(width: number): number {
  return Math.min(600, Math.max(320, Math.round(width)))
}

type RepositorySummary =
  | { status: 'ready'; view: RepositoryView }
  | { status: 'pending' }
  | { status: 'failed'; error: ApiFailure }

type NavigationRow =
  | { key: string; path: string; expandable: boolean }
  | { key: string; pointer: PointerView }

const repoKey = (path: string) => `repo:${path}`

function PendingPointers() {
  return (
    <Skeleton className="vcs-overview-pending">
      <div className="vcs-overview-pointer">
        <span className="vcs-skeleton-shape vcs-pointer-glyph" />
        <Bar width="68%" />
        <Bar width="34px" className="vcs-overview-placeholder-fact" />
      </div>
      <div className="vcs-overview-pointer">
        <span className="vcs-skeleton-shape vcs-pointer-glyph" />
        <Bar width="44%" />
      </div>
    </Skeleton>
  )
}

export function OverviewPane({
  data, repositories, views, cwd, currentRepo, selected, width, onResize, onSelectRepository, onSelectPointer, onPointerActions,
  onManageRepositories, onAddUnlisted, control, t, locale,
}: OverviewPaneProps) {
  const titleRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const focusAfterFilterRef = useRef(false)
  const dragRef = useRef<{ x: number, width: number } | null>(null)
  const [filter, setFilter] = useState<FilterId | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [quietOpen, setQuietOpen] = useState(false)
  const [unlistedOpen, setUnlistedOpen] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const discovered = useMemo(() => new Set(repositories.map(entry => entry.path)), [repositories])
  const registered = useMemo(() => views.filter(view => view.registered && discovered.has(view.path)), [discovered, views])
  const unlisted = useMemo(() => views.filter(view => !view.registered && !discovered.has(view.path)).sort(byAttention), [discovered, views])
  const counts = useMemo(() => filterCounts(registered), [registered])
  const summarized = useMemo(() => new Set(registered.map(view => view.path)), [registered])
  const unread = repositories.filter(entry => !summarized.has(entry.path))
  const reading = data.status === 'idle' || data.status === 'loading'
  const pending = reading ? unread.filter(entry => !data.failures.has(entry.path)) : []
  const failed = unread.flatMap(entry => {
    const error = data.failures.get(entry.path) ?? (reading ? null : data.error ?? { code: 'internal' })
    return error === null ? [] : [{ entry, error }]
  })
  const pointerOn = (pointer: PointerView) => (filter === null || matchesFilter(pointer, filter)) && matchesSearch(pointer, query, cwd)
  const repositoryOn = (view: RepositoryView) => (filter === null || view.list.some(pointer => matchesFilter(pointer, filter)))
    && (query === '' || view.list.some(pointer => matchesSearch(pointer, query, cwd)) || view.relativePath.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const narrowed = filter !== null || query !== ''
  const listed = registered.filter(repositoryOn).sort(byAttention)
  const loud = listed.filter(view => !view.quiet || narrowed)
  const quiet = listed.filter(view => view.quiet && !narrowed)
  const currentKey = currentRepo === null ? null : repoKey(currentRepo)
  // Moving a keyed element to another section can detach it in the DOM. Capture
  // only actual list focus, so an inactive cursor never steals focus on a read.
  const focused = listRef.current?.ownerDocument.activeElement as HTMLElement | null | undefined
  const focusedKey = focused != null && listRef.current?.contains(focused) ? focused.dataset.overviewKey : undefined
  const focusedTop = focusedKey === undefined ? null : focused?.offsetTop
  const quietExpanded = quietOpen || quiet.some(view => {
    const key = repoKey(view.path)
    return key === currentKey || key === cursor || key === focusedKey
  })
  useLayoutEffect(() => {
    if (quietExpanded && !quietOpen) setQuietOpen(true)
  }, [quietExpanded, quietOpen])

  const shownPointers = (view: RepositoryView) => collapsed.has(view.path) ? [] : view.list.filter(pointer => !narrowed || pointerOn(pointer))
  const repositoryStop = (path: string, expandable = false): NavigationRow => ({ key: repoKey(path), path, expandable })
  const stopsWithPointers = (view: RepositoryView): NavigationRow[] => [
    repositoryStop(view.path, true),
    ...shownPointers(view).map(pointer => ({ key: pointer.id, pointer })),
  ]
  const rows = [
    ...loud.flatMap(stopsWithPointers),
    ...failed.map(({ entry }) => repositoryStop(entry.path)),
    ...pending.map(entry => repositoryStop(entry.path)),
    ...(quietExpanded ? quiet.map(view => repositoryStop(view.path)) : []),
    ...(unlistedOpen && !narrowed ? unlisted.flatMap(stopsWithPointers) : []),
  ]
  const hasRow = (key: string | null) => rows.some(row => row.key === key)
  const defaultKey = hasRow(currentKey) ? currentKey : hasRow(selected) ? selected : rows[0]?.key ?? null
  const activeKey = hasRow(cursor) ? cursor : defaultKey

  const focusRow = (key: string | null) => {
    if (key === null) return false
    const element = elementWithData(listRef.current, 'data-overview-key', key)
    if (element === null) return false
    setCursor(key)
    element.focus({ preventScroll: true })
    element.scrollIntoView?.({ block: 'nearest' })
    return true
  }

  const focusDefault = () => {
    if (!focusRow(defaultKey)) titleRef.current?.querySelector<HTMLElement>('.vcs-overview-manage')?.focus({ preventScroll: true })
  }

  useImperativeHandle(control, () => ({
    focus: () => focusRow(activeKey),
    focusCurrent: () => {
      if (currentKey !== null && !hasRow(currentKey) && narrowed) {
        // A quick close and reopen can reuse a pane that still has a filter.
        focusAfterFilterRef.current = true
        setFilter(null)
        setQuery('')
      } else focusDefault()
    },
    focusSearch: () => { searchRef.current?.focus() },
    repositoryRects: () => {
      const list = listRef.current
      const rects = repositoryRects(list, '[data-repository]')
      const summary = list?.querySelector('.vcs-overview-quiet')?.getBoundingClientRect()
      if (summary !== undefined) for (const view of quiet) rects.set(view.path, summary)
      return rects
    },
  }))

  useLayoutEffect(() => {
    if (focusAfterFilterRef.current && !narrowed) {
      focusAfterFilterRef.current = false
      focusDefault()
    } else if (focusedKey !== undefined) {
      const doc = listRef.current?.ownerDocument
      const active = doc?.activeElement
      if (active === focused || active === doc?.body || active === doc?.documentElement) {
        const row = elementWithData(listRef.current, 'data-overview-key', focusedKey)
        if (row !== null && row !== active) focusRow(focusedKey)
        else if (row !== null && row.offsetTop !== focusedTop) row.scrollIntoView?.({ block: 'nearest' })
      }
    }
  })

  // Follow the timeline: the selected pointer's row comes into view.
  useEffect(() => {
    if (selected === null || listRef.current?.contains(listRef.current.ownerDocument.activeElement)) return
    elementWithData(listRef.current, 'data-pointer-id', selected)?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const toggleRepository = (path: string) => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).dataset.overviewKey
    if (key === undefined || event.altKey || event.ctrlKey || event.metaKey) return
    const index = rows.findIndex(row => row.key === key)
    const row = rows[index]
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'j') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'ArrowUp' || event.key === 'k') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if ((event.key === 'Enter' || event.key === 'ArrowRight' || event.key === 'l') && row !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      setCursor(row.key)
      if ('pointer' in row) onSelectPointer(row.pointer, true)
      else onSelectRepository(row.path, true)
      return
    } else if ((event.key === 'ArrowLeft' || event.key === 'h') && row !== undefined && 'path' in row && row.expandable) {
      event.preventDefault()
      event.stopPropagation()
      toggleRepository(row.path)
      return
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const element = event.target as HTMLElement
      if (row !== undefined && 'pointer' in row) {
        event.preventDefault()
        event.stopPropagation()
        const box = element.getBoundingClientRect()
        onPointerActions(row.pointer, { clientX: box.left + 24, clientY: box.bottom }, element)
      }
      return
    }
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    focusRow(rows[next]?.key ?? null)
  }

  const scopeText = (() => {
    const root = cwd === null ? '' : cwd.split('/').filter(Boolean).at(-1) ?? cwd
    const unfetched = registered.filter(view => view.remotes.length > 0 && view.fetchedAt === null).length
    const times = registered.filter(view => view.fetchedAt !== null).map(view => view.fetchedAt as number)
    const fetchText = unfetched > 0 ? formatPlural(t, 'overview.unfetched', unfetched, locale)
      : times.length > 0 ? t('overview.oldestFetch', { time: formatCommitTime(Math.min(...times) * 1000, Date.now(), locale) }) : ''
    return [formatPlural(t, 'overview.scope', repositories.length, locale, { name: root }), fetchText].filter(Boolean).join(' · ')
  })()

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic pointer skips capture.
    }
    dragRef.current = { x: event.clientX, width }
  }

  const currentTag = (path: string) => path === currentRepo
    ? <span className="vcs-overview-tag" data-current="">{t('overview.current')}</span>
    : null

  const chooseRepository = (path: string) => {
    focusRow(repoKey(path))
    onSelectRepository(path, false)
  }

  const repositoryRow = ({ path, name }: Pick<RepositoryInfo, 'path' | 'name'>, summary: RepositorySummary) => {
    const view = summary.status === 'ready' ? summary.view : null
    const relativePath = view?.relativePath ?? relativeTo(path, cwd)
    const slash = relativePath.lastIndexOf('/')
    const directory = view?.directory ?? relativePath.slice(0, slash + 1)
    const open = view !== null && !collapsed.has(path)
    const fetch = view === null ? null : fetchNote(view, t, locale)
    const error = summary.status === 'failed' ? errorMessage(t, summary.error) : null
    const key = repoKey(path)
    return (
      <div
        key={key}
        className="vcs-overview-repo"
        role="treeitem"
        aria-expanded={summary.status === 'failed' ? undefined : open}
        aria-level={1}
        aria-current={path === currentRepo || undefined}
        tabIndex={activeKey === key ? 0 : -1}
        data-overview-key={key}
        data-repository={path}
        data-pending={summary.status === 'pending' || undefined}
        data-failed={summary.status === 'failed' || undefined}
        onClick={() => { chooseRepository(path) }}
      >
        <button
          type="button"
          className="vcs-overview-twist"
          tabIndex={-1}
          disabled={view === null}
          aria-label={t(open ? 'overview.collapse' : 'overview.expand')}
          onClick={event => {
            event.stopPropagation()
            if (view !== null) toggleRepository(path)
          }}
        >
          <Chevron open={open} />
        </button>
        <span className="vcs-overview-repo-name" title={relativePath}>
          {directory === '' ? null : <span className="vcs-overview-dir">{directory}</span>}
          {relativePath === '.' ? name : relativePath.slice(slash + 1)}
        </span>
        <span className="vcs-overview-repo-meta">
          {currentTag(path)}
          {view !== null && fetch !== null ? (
            <>
              {view.remotes.length > 1 ? <span className="vcs-overview-tag">{formatPlural(t, 'overview.remotes', view.remotes.length, locale)}</span> : null}
              {view.checkouts.length > 1 ? <span className="vcs-overview-tag" title={formatPlural(t, 'overview.checkouts', view.checkouts.length, locale)}>⌂{view.checkouts.length}</span> : null}
              {view.registered ? null : <span className="vcs-overview-tag" data-off="">{t('overview.unlistedTag')}</span>}
              <span data-stale={fetch.stale || undefined}>{fetch.text}</span>
            </>
          ) : error === null ? (
            <span className="vcs-skeleton" aria-hidden="true"><Bar width="50px" /></span>
          ) : <span className="vcs-overview-error" title={error}>{error}</span>}
        </span>
        {view !== null && view.drift.length > 0 ? (
          <span className="vcs-overview-drift">
            {view.drift.map(line => (
              <span key={line.name}>{t('overview.drift', { name: view.baselines[0]?.name ?? '', base: line.name, ahead: String(line.ahead), behind: String(line.behind) })}</span>
            ))}
          </span>
        ) : null}
        {view !== null && !view.supported ? <span className="vcs-overview-drift">{t('overview.unsupported')}</span> : null}
      </div>
    )
  }

  const pointerRow = (view: RepositoryView, pointer: PointerView) => {
    const facts = pointerFacts(pointer, view, cwd, t, locale)
    return (
      <div
        key={pointer.id}
        className="vcs-overview-pointer"
        role="treeitem"
        aria-level={2}
        aria-current={pointer.id === selected || undefined}
        tabIndex={activeKey === pointer.id ? 0 : -1}
        data-overview-key={pointer.id}
        data-pointer-id={pointer.id}
        data-state={pointer.state}
        data-kind={pointer.kind}
        data-faded={narrowed && !pointerOn(pointer) ? '' : undefined}
        title={`${pointer.display} · ${t(STATE_KEYS[pointer.state])}`}
        onClick={() => {
          setCursor(pointer.id)
          onSelectPointer(pointer, false)
        }}
        onContextMenu={event => {
          event.preventDefault()
          setCursor(pointer.id)
          onPointerActions(pointer, event, event.currentTarget)
        }}
      >
        <KindGlyph kind={pointer.kind} />
        <span className="vcs-overview-pointer-name">{pointer.display}</span>
        <Gauge pointer={pointer} />
        <span className="vcs-overview-metric" data-quiet={['synced', 'foreign', 'merged', 'shadow'].includes(pointer.state) || undefined}>
          {headlineText(pointer, t, locale)}
        </span>
        <span className="vcs-overview-facts">{facts.join(' · ')}</span>
      </div>
    )
  }

  const rowsWithPointers = (view: RepositoryView) => [
    repositoryRow(view, { status: 'ready', view }),
    ...shownPointers(view).map(pointer => pointerRow(view, pointer)),
  ]
  const quietRow = (view: RepositoryView) => {
    const key = repoKey(view.path)
    const main = view.checkouts.find(tree => tree.primary)
    return (
      <div
        key={key}
        className="vcs-overview-quiet-row"
        role="treeitem"
        aria-level={1}
        aria-current={view.path === currentRepo || undefined}
        tabIndex={activeKey === key ? 0 : -1}
        data-overview-key={key}
        data-repository={view.path}
        onClick={() => { chooseRepository(view.path) }}
      >
        <span className="vcs-overview-quiet-name">
          <span className="vcs-overview-repo-name">{view.relativePath === '.' ? view.name : view.relativePath.split('/').at(-1)}</span>
          {currentTag(view.path)}
        </span>
        <span className="vcs-overview-facts">{view.remotes.length === 0 ? t('overview.noRemote') : `${main?.branch ?? main?.head?.slice(0, 7) ?? ''} ≡ ${view.remotes[0]}`}</span>
      </div>
    )
  }
  const heading = (key: string, count: number, live = false) => (
    <div key={key} className="vcs-overview-section" role={live ? 'status' : undefined}>
      {formatPlural(t, key, count, locale)}
    </div>
  )

  return (
    <aside
      className="vcs-overview"
      aria-label={t('overview.title')}
      style={{ width: `${width}px` }}
      onMouseDown={event => { event.stopPropagation() }}
      onClick={(event: ReactMouseEvent) => { event.stopPropagation() }}
    >
      <div className="vcs-overview-head">
        <div className="vcs-overview-title" ref={titleRef}>
          <h2>{t('overview.title')}</h2>
          <span className="vcs-overview-scope" title={cwd ?? undefined}>{scopeText}</span>
          <IconButton
            className="vcs-overview-manage"
            label={t('repositoryConfig.manage')}
            onClick={event => {
              const gear = event.currentTarget
              onManageRepositories(() => { gear.focus({ preventScroll: true }) })
            }}
          >
            <SettingsIcon />
          </IconButton>
        </div>
        <label className="vcs-overview-search">
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t('overview.search')}
            aria-label={t('overview.searchLabel')}
            autoComplete="off"
            onChange={event => { setQuery(event.target.value.trim()) }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
                focusRow(activeKey)
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                event.stopPropagation()
                focusRow(rows[0]?.key ?? null)
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div className="vcs-overview-chips" role="group" aria-label={t('overview.filters')}>
          {FILTERS.map(id => (
            <button
              key={id}
              type="button"
              className="vcs-state-chip"
              data-state={id}
              aria-pressed={filter === id}
              data-zero={counts[id] === 0 || undefined}
              onClick={() => { setFilter(previous => previous === id ? null : id) }}
            >
              <span className="vcs-state-dot" aria-hidden="true" />
              {t(FILTER_KEYS[id])}
              <b>{counts[id]}</b>
            </button>
          ))}
        </div>
      </div>
      <div
        className="vcs-overview-list"
        role="tree"
        aria-label={t('overview.list')}
        ref={listRef}
        onKeyDown={onKeyDown}
        onFocus={event => {
          const key = (event.target as HTMLElement).dataset.overviewKey
          if (key !== undefined) setCursor(key)
        }}
      >
        {/* Keep repository keys at the same level as they move between sections. */}
        {[
          data.error === null ? null : <p key="read-error" className="vcs-note" role="alert">{errorMessage(t, data.error)}</p>,
          loud.length + failed.length > 0 ? heading('overview.attention', loud.length + failed.length) : null,
          ...loud.flatMap(rowsWithPointers),
          ...failed.map(({ entry, error }) => repositoryRow(entry, { status: 'failed', error })),
          pending.length > 0 ? heading('overview.loading', pending.length, true) : null,
          ...pending.flatMap(entry => [
            repositoryRow(entry, { status: 'pending' }),
            <PendingPointers key={`pending:${entry.path}`} />,
          ]),
          ...(quiet.length === 0 ? [] : quietExpanded ? [
            heading('overview.quietTitle', quiet.length),
            ...quiet.map(quietRow),
          ] : [
            <button key="quiet-summary" type="button" className="vcs-overview-quiet" onClick={() => { setQuietOpen(true) }}>
              <b>{formatPlural(t, 'overview.quiet', quiet.length, locale)}</b>
              <span>{quiet.map(view => view.relativePath.split('/').at(-1)).join(' · ')}</span>
            </button>,
          ]),
          ...(!narrowed && unlisted.length > 0 ? [
            heading('overview.unlistedTitle', unlisted.length),
            <div key="unlisted-summary" className="vcs-overview-unlisted">
              <span>
                {formatPlural(t, 'overview.unlisted', unlisted.length, locale)}
                {unlisted.some(view => !view.quiet)
                  ? ` ${formatPlural(t, 'overview.unlistedAttention', unlisted.filter(view => !view.quiet).length, locale)}`
                  : ''}
              </span>
              <span className="vcs-overview-actions">
                <button type="button" className="vcs-button" onClick={() => { setUnlistedOpen(open => !open) }}>
                  {t(unlistedOpen ? 'overview.unlistedHide' : 'overview.unlistedShow')}
                </button>
                <button type="button" className="vcs-button" onClick={() => { onAddUnlisted(unlisted.map(view => relativeTo(view.path, cwd))) }}>
                  {t('overview.unlistedAdd')}
                </button>
              </span>
            </div>,
            ...(unlistedOpen ? unlisted.flatMap(rowsWithPointers) : []),
          ] : []),
          data.unlistedTruncated ? <p key="truncated" className="vcs-note">{t('overview.unlistedTruncated')}</p> : null,
          data.status === 'ready' && rows.length === 0 && narrowed ? <p key="empty" className="vcs-note">{t('overview.empty')}</p> : null,
        ]}
      </div>
      <div
        className="vcs-overview-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('overview.resize')}
        aria-valuenow={width}
        aria-valuemin={320}
        aria-valuemax={600}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={event => { if (dragRef.current !== null) onResize(clampWidth(dragRef.current.width + event.clientX - dragRef.current.x)) }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          onResize(clampWidth(width + (event.key === 'ArrowLeft' ? -16 : 16)))
        }}
      />
    </aside>
  )
}
