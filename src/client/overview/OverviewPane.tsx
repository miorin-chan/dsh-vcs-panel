/**
 * The overview column: every repository's pointers ranked by state, pushed in
 * from the left of the panel. It is navigation; the timeline beside it reads.
 * Clicking a pointer moves the timeline to it, and the timeline's selection
 * marks the pointer here.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import { errorMessage, formatCommitTime, formatPlural } from '../format.js'
import { Chevron } from '../ui.jsx'
import type { OverviewData } from './useOverview.js'
import type { FilterId, PointerView, RepositoryView } from './model.js'
import {
  byAttention, checkoutLabel, elementWithData, FILTERS, filterCounts, gauge, headline, matchesFilter, matchesSearch, relativeTo,
} from './model.js'
import { FILTER_KEYS, STATE_KEYS } from './labels.js'

/** Calls the panel makes into the column. */
export interface OverviewControl {
  /** Focus the selected pointer row, or the first row. */
  focus(): boolean
  /** Focus the search box. */
  focusSearch(): void
}

export interface OverviewPaneProps {
  data: OverviewData
  views: readonly RepositoryView[]
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
    if (typeof pointer.upstream !== 'string') facts.push(t('overview.unpublished'))
    else if (pointer.track?.gone === true) facts.push(`${pointer.upstream} · ${t('overview.upstreamGone')}`)
    else if ((pointer.track?.ahead ?? 0) === 0 && (pointer.track?.behind ?? 0) === 0) facts.push(`≡ ${pointer.upstream.split('/')[0]}`)
    else facts.push(`${pointer.upstream} ${arrows(pointer.track?.ahead ?? 0, pointer.track?.behind ?? 0)}`)
  }
  if (pointer.kind === 'detached') facts.push(pointer.unique > 0 ? t('overview.detached') : t('overview.detachedClean'))
  if (pointer.kind === 'stash') facts.push(pointer.subject.replace(/^(?:WIP on|On) [^:]+: /u, ''))
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

export function OverviewPane({
  data, views, currentRepo, selected, width, onResize, onSelectRepository, onSelectPointer, onPointerActions,
  onAddUnlisted, control, t, locale,
}: OverviewPaneProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const dragRef = useRef<{ x: number, width: number } | null>(null)
  const [filter, setFilter] = useState<FilterId | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [quietOpen, setQuietOpen] = useState(false)
  const [unlistedOpen, setUnlistedOpen] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const cwd = data.cwd

  const registered = useMemo(() => views.filter(view => view.registered), [views])
  const unlisted = useMemo(() => views.filter(view => !view.registered).sort(byAttention), [views])
  const counts = useMemo(() => filterCounts(registered), [registered])
  const pointerOn = (pointer: PointerView) => (filter === null || matchesFilter(pointer, filter)) && matchesSearch(pointer, query, cwd)
  const repositoryOn = (view: RepositoryView) => (filter === null || view.list.some(pointer => matchesFilter(pointer, filter)))
    && (query === '' || view.list.some(pointer => matchesSearch(pointer, query, cwd)) || view.relativePath.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const narrowed = filter !== null || query !== ''
  const listed = registered.filter(repositoryOn).sort(byAttention)
  const loud = listed.filter(view => !view.quiet || narrowed)
  const quiet = listed.filter(view => view.quiet && !narrowed)

  // The rows keyboard navigation walks, in screen order.
  const rows: Array<{ key: string, repo: RepositoryView, pointer?: PointerView }> = []
  const pushRepository = (view: RepositoryView) => {
    rows.push({ key: `repo:${view.path}`, repo: view })
    if (!collapsed.has(view.path)) {
      for (const pointer of view.list) if (!narrowed || pointerOn(pointer)) rows.push({ key: pointer.id, repo: view, pointer })
    }
  }
  loud.forEach(pushRepository)
  if (quietOpen) quiet.forEach(view => rows.push({ key: `repo:${view.path}`, repo: view }))
  if (unlistedOpen && !narrowed) unlisted.forEach(pushRepository)
  const activeKey = rows.some(row => row.key === cursor) ? cursor
    : rows.find(row => row.pointer?.id === selected)?.key ?? rows[0]?.key ?? null

  const focusRow = (key: string | null) => {
    if (key === null) return false
    setCursor(key)
    const element = elementWithData(listRef.current, 'data-overview-key', key)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView?.({ block: 'nearest' })
    return element !== null
  }

  useImperativeHandle(control, () => ({
    focus: () => focusRow(activeKey),
    focusSearch: () => { searchRef.current?.focus() },
  }))

  // Follow the timeline: the selected pointer's row comes into view.
  useEffect(() => {
    if (selected === null) return
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

  const activate = (row: typeof rows[number]) => {
    if (row.pointer !== undefined) onSelectPointer(row.pointer, true)
    else onSelectRepository(row.repo.path, true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex(row => row.key === activeKey)
    const row = rows[index]
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'j') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'ArrowUp' || event.key === 'k') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if ((event.key === 'Enter' || event.key === 'ArrowRight' || event.key === 'l') && row !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      activate(row)
      return
    } else if ((event.key === 'ArrowLeft' || event.key === 'h') && row?.pointer === undefined && row !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      toggleRepository(row.repo.path)
      return
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const element = event.target as HTMLElement
      if (row?.pointer !== undefined) {
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
    return [formatPlural(t, 'overview.scope', registered.length, locale, { name: root }), fetchText].filter(Boolean).join(' · ')
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

  const repositoryRow = (view: RepositoryView) => {
    const open = !collapsed.has(view.path)
    const fetch = fetchNote(view, t, locale)
    const key = `repo:${view.path}`
    return (
      <div
        key={key}
        className="vcs-overview-repo"
        role="treeitem"
        aria-expanded={open}
        aria-level={1}
        aria-current={view.path === currentRepo || undefined}
        tabIndex={activeKey === key ? 0 : -1}
        data-overview-key={key}
        data-repo={view.path}
        onClick={() => {
          setCursor(key)
          onSelectRepository(view.path, false)
        }}
      >
        <button
          type="button"
          className="vcs-overview-twist"
          tabIndex={-1}
          aria-label={t(open ? 'overview.collapse' : 'overview.expand')}
          onClick={event => {
            event.stopPropagation()
            toggleRepository(view.path)
          }}
        >
          <Chevron open={open} />
        </button>
        <span className="vcs-overview-repo-name" title={view.relativePath}>
          {view.directory === '' ? null : <span className="vcs-overview-dir">{view.directory}</span>}
          {view.relativePath === '.' ? view.name : view.relativePath.split('/').at(-1)}
        </span>
        <span className="vcs-overview-repo-meta">
          {view.remotes.length > 1 ? <span className="vcs-overview-tag">{formatPlural(t, 'overview.remotes', view.remotes.length, locale)}</span> : null}
          {view.checkouts.length > 1 ? <span className="vcs-overview-tag" title={formatPlural(t, 'overview.checkouts', view.checkouts.length, locale)}>⌂{view.checkouts.length}</span> : null}
          {view.registered ? null : <span className="vcs-overview-tag" data-off="">{t('overview.unlistedTag')}</span>}
          <span data-stale={fetch.stale || undefined}>{fetch.text}</span>
        </span>
        {view.drift.length > 0 ? (
          <span className="vcs-overview-drift">
            {view.drift.map(line => (
              <span key={line.name}>{t('overview.drift', { name: view.baselines[0]?.name ?? '', base: line.name, ahead: String(line.ahead), behind: String(line.behind) })}</span>
            ))}
          </span>
        ) : null}
        {!view.supported ? <span className="vcs-overview-drift">{t('overview.unsupported')}</span> : null}
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

  const failures = [...data.failures.values()].filter(failure => failure.registered)

  return (
    <aside
      className="vcs-overview"
      aria-label={t('overview.title')}
      style={{ width: `${width}px` }}
      onMouseDown={event => { event.stopPropagation() }}
      onClick={(event: ReactMouseEvent) => { event.stopPropagation() }}
    >
      <div className="vcs-overview-head">
        <div className="vcs-overview-title">
          <h2>{t('overview.title')}</h2>
          <span className="vcs-overview-scope" title={cwd ?? undefined}>{scopeText}</span>
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
      <div className="vcs-overview-list" role="tree" aria-label={t('overview.list')} aria-busy={data.status === 'loading' || undefined} ref={listRef} onKeyDown={onKeyDown}>
        {data.error !== null ? <p className="vcs-note" role="alert">{errorMessage(t, data.error)}</p> : null}
        {loud.length > 0 ? <div className="vcs-overview-section">{formatPlural(t, 'overview.attention', loud.length, locale)}</div> : null}
        {loud.map(view => [repositoryRow(view), ...(collapsed.has(view.path) ? [] : view.list
          .filter(pointer => !narrowed || pointerOn(pointer)).map(pointer => pointerRow(view, pointer)))])}
        {quiet.length > 0 ? (quietOpen ? (
          <>
            <div className="vcs-overview-section">{formatPlural(t, 'overview.quietTitle', quiet.length, locale)}</div>
            {quiet.map(view => {
              const key = `repo:${view.path}`
              const main = view.checkouts.find(tree => tree.primary)
              return (
                <div key={key} className="vcs-overview-quiet-row" role="treeitem" aria-level={1} tabIndex={activeKey === key ? 0 : -1}
                  data-overview-key={key} aria-current={view.path === currentRepo || undefined}
                  onClick={() => { setCursor(key); onSelectRepository(view.path, false) }}>
                  <span className="vcs-overview-repo-name">{view.relativePath === '.' ? view.name : view.relativePath.split('/').at(-1)}</span>
                  <span className="vcs-overview-facts">{view.remotes.length === 0 ? t('overview.noRemote') : `${main?.branch ?? main?.head?.slice(0, 7) ?? ''} ≡ ${view.remotes[0]}`}</span>
                </div>
              )
            })}
          </>
        ) : (
          <button type="button" className="vcs-overview-quiet" onClick={() => { setQuietOpen(true) }}>
            <b>{formatPlural(t, 'overview.quiet', quiet.length, locale)}</b>
            <span>{quiet.map(view => view.relativePath.split('/').at(-1)).join(' · ')}</span>
          </button>
        )) : null}
        {!narrowed && unlisted.length > 0 ? (
          <>
            <div className="vcs-overview-section">{formatPlural(t, 'overview.unlistedTitle', unlisted.length, locale)}</div>
            <div className="vcs-overview-unlisted">
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
            </div>
            {unlistedOpen ? unlisted.map(view => [repositoryRow(view), ...(collapsed.has(view.path) ? [] : view.list.map(pointer => pointerRow(view, pointer)))]) : null}
          </>
        ) : null}
        {data.unlistedTruncated ? <p className="vcs-note">{t('overview.unlistedTruncated')}</p> : null}
        {failures.map(failure => (
          <p key={failure.path} className="vcs-note" title={failure.path}>
            {relativeTo(failure.path, cwd)}: {errorMessage(t, { code: failure.code })}
          </p>
        ))}
        {data.status === 'loading' && data.pending > 0 ? (
          <p className="vcs-note" role="status">{formatPlural(t, 'overview.loading', data.pending, locale)}</p>
        ) : null}
        {data.status === 'ready' && rows.length === 0 && narrowed ? <p className="vcs-note">{t('overview.empty')}</p> : null}
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
