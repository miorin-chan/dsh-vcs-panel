/**
 * The tiled layout: the repositories in the overview laid side by side as
 * columns. Each column is the repository's vertical skeleton,
 * only the commits pointers name and the fork points between them; a quiet
 * repository is a narrow spine. The state buttons step through pointers, the
 * action bar acts on the focused one, and the rail shows where the viewport is.
 */

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, Ref, WheelEvent as ReactWheelEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { RepositoryInfo } from '../api.js'
import { BRANCH_ACTION_META } from '../branch.js'
import { COMMIT_ACTION_META } from '../commit.js'
import { formatCount, formatPlural } from '../format.js'
import { resolveColor } from '../history/layout.js'
import type { Notice, RepoWrite } from '../useRepoActions.js'
import { tileDirectActions } from './directActions.js'
import type { TileDirectAction } from './directActions.js'
import type { FilterId, LaneStep, PointerView, RepositoryView, Skeleton } from './model.js'
import { elementWithData, FILTERS, LOUD_STATES, matchesFilter, STATE_RANK } from './model.js'
import { STATE_KEYS, FILTER_KEYS } from './labels.js'
import { arrows, fetchNote, headlineText, KindGlyph, pointerFacts } from './OverviewPane.jsx'
import { reducedMotion, repositoryRects } from './motion.js'

/** One repository's loaded history for its skeleton. */
export interface TileHistory {
  status: 'idle' | 'loading' | 'ready' | 'error'
}

/** One column in display order. */
export interface TileColumn {
  entry: RepositoryInfo
  view: RepositoryView | null
  skeleton: Skeleton | null
  history: TileHistory
}

/** Calls the panel makes into the tiled layout. */
export interface TiledControl {
  /** Scroll one column left or right. */
  scrollColumns(direction: 1 | -1): void
  /** Bring a pointer chip into view and focus it. */
  reveal(pointerId: string): void
  /** Each column's box, for the motion that leaves the layout. */
  columnRects(): Map<string, DOMRect>
  /** Take keyboard focus: the focused chip, else the row of columns. */
  focus(): void
}

export interface TiledViewProps {
  columns: readonly TileColumn[]
  unlisted: readonly RepositoryView[]
  cwd: string | null
  currentRepo: string | null
  expanded: readonly string[]
  filter: FilterId | null
  focus: string | null
  narrow: boolean
  inFlight: ReadonlyMap<string, RepoWrite>
  notices: ReadonlyMap<string | null, Notice>
  onFocusPointer: (id: string | null) => void
  onOpenTimeline: (path: string, pointer: PointerView | null) => void
  onExpand: (path: string) => void
  onCollapse: (path: string) => void
  onPointerActions: (pointer: PointerView, point: { clientX: number, clientY: number }, element: HTMLElement | null) => void
  onDirectAction: (pointer: PointerView, action: TileDirectAction['action'], restore: () => void) => void
  onAddUnlisted: (paths: string[]) => void
  control: Ref<TiledControl | null>
  t: Translate
  locale?: string
}

/** Lane geometry of a skeleton row. */
const LANE_ROW = 26
const LANE_MID = 13
const LANE_STEP = 11
const laneX = (index: number) => 7 + index * LANE_STEP

/** One skeleton row's lane cell: the lines through it, the dot, and the lanes running on below. */
function LaneCell({ step, width, dot }: { step: LaneStep, width: number, dot: string }) {
  const pixels = width * LANE_STEP + 4
  const color = (index: number) => resolveColor(index)
  const paths: Array<{ d: string, color: string }> = []
  step.before.forEach((sha, index) => {
    if (sha === null) return
    paths.push({
      d: step.merging.includes(index)
        ? `M${laneX(index)} 0C${laneX(index)} ${LANE_MID * 0.6} ${laneX(step.column)} ${LANE_MID * 0.4} ${laneX(step.column)} ${LANE_MID}`
        : `M${laneX(index)} 0V${LANE_MID}`,
      color: color(index),
    })
  })
  step.after.forEach((sha, index) => {
    if (sha === null) return
    paths.push({
      d: step.forks.includes(index) && step.before[index] !== sha && index !== step.column
        ? `M${laneX(step.column)} ${LANE_MID}C${laneX(step.column)} ${LANE_MID + 8} ${laneX(index)} ${LANE_MID + 6} ${laneX(index)} ${LANE_ROW}`
        : `M${laneX(index)} ${LANE_MID}V${LANE_ROW}`,
      color: color(index),
    })
  })
  return (
    <span className="vcs-tile-lane" style={{ width: `${pixels}px` }} aria-hidden="true">
      <svg width={pixels} height={LANE_ROW} fill="none" strokeWidth="1.6">
        {paths.map((path, index) => <path key={index} d={path.d} stroke={path.color} />)}
        <circle cx={laneX(step.column)} cy={LANE_MID} r="4.5" fill={dot} stroke="var(--dsw-alias-bg-base)" strokeWidth="2" />
      </svg>
      {step.after.map((sha, index) => sha === null ? null : (
        <i key={index} style={{ left: `${laneX(index) - 0.8}px`, background: color(index) }} />
      ))}
    </span>
  )
}

/** The color token of one state. */
export function stateColor(state: PointerView['state']): string {
  return `var(--vcs-state-${state})`
}

/** One pointer chip. */
function PointerChip({ pointer, focused, hit, onFocus, onActions, t, locale }: {
  pointer: PointerView
  focused: boolean
  hit: boolean
  onFocus: TiledViewProps['onFocusPointer']
  onActions: TiledViewProps['onPointerActions']
  t: Translate
  locale?: string
}) {
  const metric = LOUD_STATES.has(pointer.state) || pointer.state === 'merged' ? headlineText(pointer, t, locale) : null
  return (
    <button
      type="button"
      className="vcs-pointer-chip"
      data-state={pointer.state}
      data-kind={pointer.kind}
      data-loud={LOUD_STATES.has(pointer.state) || undefined}
      data-focused={focused || undefined}
      data-hit={hit || undefined}
      data-pointer-id={pointer.id}
      tabIndex={focused ? 0 : -1}
      title={`${pointer.display} · ${t(STATE_KEYS[pointer.state])}`}
      onClick={() => { onFocus(pointer.id) }}
      onContextMenu={event => {
        event.preventDefault()
        onFocus(pointer.id)
        onActions(pointer, event, event.currentTarget)
      }}
    >
      <KindGlyph kind={pointer.kind} />
      <span className="vcs-pointer-chip-name">{pointer.display}</span>
      {pointer.levelRemotes.length > 0 ? <span className="vcs-pointer-chip-shadow">≡ {pointer.levelRemotes.join(', ')}</span> : null}
      {metric === null ? null : <em>{metric}</em>}
    </button>
  )
}

/** The worst state among a repository's listed pointers, for its rail segment. */
function worstState(view: RepositoryView | null): PointerView['state'] | null {
  const worst = view?.list.filter(pointer => LOUD_STATES.has(pointer.state) || pointer.state === 'merged')
    .sort((first, second) => STATE_RANK[first.state] - STATE_RANK[second.state])[0]
  return worst?.state ?? null
}

/** The header of one column. */
function ColumnHead({ column, quiet, onCollapse, onOpen, t, locale }: {
  column: TileColumn
  quiet: boolean
  onCollapse: () => void
  onOpen: () => void
  t: Translate
  locale?: string
}) {
  const view = column.view
  const main = view?.checkouts.find(tree => tree.primary) ?? null
  const trunk = main?.branch === null || main?.branch === undefined ? null
    : view?.pointers.find(pointer => pointer.kind === 'branch' && pointer.name === main.branch) ?? null
  const fetch = view === null ? null : fetchNote(view, t, locale)
  const meta = [
    view?.directory === '' || view === null ? null : view.directory,
    view === null ? null : view.remotes.length === 0 ? t('overview.noRemote') : formatPlural(t, 'overview.remotes', view.remotes.length, locale),
    view !== null && view.checkouts.length > 1 ? formatPlural(t, 'overview.checkouts', view.checkouts.length, locale) : null,
    fetch === null || view?.remotes.length === 0 ? null : fetch.text,
  ].filter((part): part is string => part !== null)
  return (
    <header className="vcs-tile-head" tabIndex={-1}>
      <div className="vcs-tile-title">
        <h3 title={column.entry.path}>{column.entry.name}</h3>
        {quiet ? (
          <button type="button" className="vcs-icon-button" aria-label={t('tile.collapse')} title={t('tile.collapse')} onClick={onCollapse}>
            <svg className="vcs-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M8 2 4 6l4 4" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
        ) : null}
        <button type="button" className="vcs-icon-button" aria-label={t('tile.openTimeline')} title={t('tile.openTimeline')} onClick={onOpen}>
          <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7.5 8.5" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
      </div>
      <div className="vcs-tile-meta">
        {main === null ? null : (
          <span className="vcs-tile-branch">
            {main.branch ?? main.head?.slice(0, 7) ?? ''}
            {trunk !== null && typeof trunk.upstream === 'string'
              ? ` ${arrows(trunk.track?.ahead ?? 0, trunk.track?.behind ?? 0) || '≡'}`
              : ''}
          </span>
        )}
        {meta.map(part => <span key={part}>{part}</span>)}
      </div>
      {view !== null && view.drift.length > 0 ? (
        <div className="vcs-tile-drift">
          {view.drift.map(line => (
            <span key={line.name}>{t('overview.drift', { name: view.baselines[0]?.name ?? '', base: line.name, ahead: String(line.ahead), behind: String(line.behind) })}</span>
          ))}
        </div>
      ) : null}
      {view === null ? null : (
        <div className="vcs-tile-counts">
          {FILTERS.map(id => {
            const count = id === 'unsaved' ? view.dirtyTrees : id === 'unique' ? view.unique : view.list.filter(pointer => matchesFilter(pointer, id)).length
            return count > 0 ? <span key={id} data-state={id}>{t(FILTER_KEYS[id])} {count}</span> : null
          })}
        </div>
      )}
    </header>
  )
}

/** The body of one column: its skeleton rows and the pointers outside the loaded history. */
function ColumnBody({ column, focus, filter, cwd, onFocus, onActions, t, locale }: {
  column: TileColumn
  focus: string | null
  filter: FilterId | null
  cwd: string | null
  onFocus: TiledViewProps['onFocusPointer']
  onActions: TiledViewProps['onPointerActions']
  t: Translate
  locale?: string
}) {
  const { view, skeleton } = column
  if (view === null || (skeleton === null && column.history.status !== 'error')) {
    return <p className="vcs-note vcs-tile-loading" role="status">{t('tile.loading')}</p>
  }
  const chip = (pointer: PointerView) => (
    <PointerChip key={pointer.id} pointer={pointer} focused={focus === pointer.id} hit={filter !== null && matchesFilter(pointer, filter)}
      onFocus={onFocus} onActions={onActions} t={t} locale={locale} />
  )
  const info = (pointer: PointerView) => {
    if (pointer.occupant === null && pointer.kind !== 'stash' && !(pointer.kind === 'branch' && pointer.upstream == null && LOUD_STATES.has(pointer.state))) return null
    const facts = pointerFacts(pointer, view, cwd, t, locale).slice(0, pointer.kind === 'stash' ? 1 : 2)
    return <span key={`${pointer.id}:info`} className="vcs-tile-info">{facts.join(' · ')}</span>
  }
  const rows = skeleton?.rows ?? []
  const unplaced = skeleton?.unplaced ?? view.list
  return (
    <div className="vcs-tile-body">
      {rows.map((row, index) => {
        const step = skeleton?.lanes[index]
        const pointers = row.pointers
        const loud = pointers.find(pointer => LOUD_STATES.has(pointer.state) || pointer.state === 'merged')
        const dot = loud === undefined ? resolveColor(step?.column ?? 0) : stateColor(loud.state)
        const tags = row.tags.length > 3
          ? formatPlural(t, 'tile.tagRange', row.tags.length, locale, { first: row.tags[0], last: row.tags.at(-1) ?? '' })
          : row.tags.join(' · ')
        return (
          <div key={row.sha} className="vcs-tile-row">
            {step === undefined ? null : <LaneCell step={step} width={skeleton?.width ?? 1} dot={dot} />}
            <div className="vcs-tile-chips">
              {pointers.map(chip)}
              {tags === '' ? null : <span className="vcs-tile-tags" title={row.tags.join(', ')}>◆ {tags}</span>}
              {pointers.length === 0 && row.tags.length === 0 ? <span className="vcs-tile-gap">{t('tile.forkPoint', { sha: row.sha.slice(0, 7) })}</span> : null}
              {pointers.map(info)}
              {row.between > 0 ? <span className="vcs-tile-gap">{formatPlural(t, 'tile.folded', row.between, locale)}</span> : null}
              {row.end && !row.root ? <span className="vcs-tile-gap">{t('tile.earlier')}</span> : null}
            </div>
          </div>
        )
      })}
      {unplaced.length > 0 ? (
        <div className="vcs-tile-unplaced">
          <span className="vcs-tile-gap">{t('tile.unplaced')}</span>
          {unplaced.map(chip)}
        </div>
      ) : null}
    </div>
  )
}

function actionLabel(action: TileDirectAction['action'], t: Translate): string {
  switch (action.domain) {
    case 'sync': return t('tile.sync')
    case 'branch': return action.receiver === undefined
      ? t(BRANCH_ACTION_META[action.kind].labelKey) : t('tile.mergeInto', { name: action.receiver })
    case 'commit': return t(COMMIT_ACTION_META[action.kind].labelKey)
    case 'worktree': return t('worktree.removeWorktree')
    case 'stash': return t(action.kind === 'apply' ? 'stash.apply' : 'stash.drop')
  }
}

/** The selected pointer's facts and buttons. */
function ActionBar({ pointer, view, cwd, directActions, stashOps, onOpen, onActions, onDirectAction, t, locale }: {
  pointer: PointerView
  view: RepositoryView
  cwd: string | null
  directActions: readonly TileDirectAction[]
  stashOps: boolean
  onOpen: () => void
  onActions: (element: HTMLElement) => void
  onDirectAction: (action: TileDirectAction['action'], element: HTMLElement) => void
  t: Translate
  locale?: string
}) {
  const facts: string[] = [view.relativePath === '.' ? view.name : view.relativePath,
    pointer.state === 'op' ? headlineText(pointer, t, locale) : t(STATE_KEYS[pointer.state])]
  if (pointer.kind === 'stash') facts.push(pointer.subject || t('stash.untitled'))
  else if (pointer.base !== null) {
    facts.push(t('tile.distance', { base: pointer.base, ahead: String(pointer.ahead ?? 0), behind: String(pointer.behind ?? 0) }))
    if (pointer.unique > 0) facts.push(formatPlural(t, 'tile.local', pointer.unique, locale))
  }
  if (pointer.kind === 'branch') facts.push(typeof pointer.upstream === 'string' ? t('tile.upstream', { name: pointer.upstream }) : t('overview.unpublished'))
  if (pointer.occupant !== null) {
    const facts2 = pointerFacts(pointer, view, cwd, t, locale)[0]
    facts.push(pointer.occupant.dirty !== null && pointer.occupant.dirty > 0
      ? `${facts2} · ${formatPlural(t, 'overview.metric.unsaved', pointer.occupant.dirty, locale)}`
      : facts2)
  }
  facts.push(pointer.sha.slice(0, 7))
  const hasActions = pointer.kind === 'stash' ? stashOps
    : view.vcs === 'jujutsu' || pointer.kind === 'detached' ? pointer.occupant !== null : true
  return (
    <>
      <span className="vcs-tile-actionbar-who" data-state={pointer.state}>
        <KindGlyph kind={pointer.kind} />
        <span>
          <span className="vcs-tile-actionbar-name">{pointer.display}</span>
          <span className="vcs-tile-actionbar-facts">{facts.join(' · ')}</span>
        </span>
      </span>
      <span className="vcs-tile-actionbar-buttons">
        {directActions.map(({ action, disabledReason }) => {
          const label = actionLabel(action, t)
          const reason = disabledReason === undefined ? undefined : t(disabledReason)
          const title = reason ?? (action.domain === 'sync' && typeof pointer.upstream === 'string'
            ? `${t('top.syncLabel', {
              upstream: pointer.upstream,
              ahead: formatCount(pointer.track?.ahead ?? 0, locale),
              behind: formatCount(pointer.track?.behind ?? 0, locale),
            })}\n${t('top.syncHint')}` : label)
          return (
            <button
              key={action.kind}
              type="button"
              className={`vcs-button vcs-tile-direct-action${action.domain === 'stash' && action.kind === 'drop' ? ' vcs-button-danger' : ''}`}
              data-tile-action={action.kind}
              title={title}
              aria-disabled={reason === undefined ? undefined : true}
              aria-description={reason}
              onClick={event => { if (reason === undefined) onDirectAction(action, event.currentTarget) }}
            >
              <span>{label}</span>
            </button>
          )
        })}
        {hasActions ? (
          <button type="button" className="vcs-button" onClick={event => { onActions(event.currentTarget) }}>{t('tile.actions')}</button>
        ) : null}
        <button type="button" className="vcs-button vcs-button-primary" onClick={onOpen}>
          {t('tile.openTimeline')} <kbd aria-hidden="true">↵</kbd>
        </button>
      </span>
    </>
  )
}

/** The opener and the pointers below it in this column's pre-write order. */
interface ActionOrigin {
  repo: string
  pointerId: string
  button: HTMLElement
  successors: string[]
}

export function TiledView({
  columns, unlisted, cwd, currentRepo, expanded, filter, focus, narrow, inFlight, notices, onFocusPointer, onOpenTimeline, onExpand,
  onCollapse, onPointerActions, onDirectAction, onAddUnlisted, control, t, locale,
}: TiledViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const actionOriginRef = useRef<ActionOrigin | null>(null)
  const focusSelectionRef = useRef({ focus, onFocusPointer })
  focusSelectionRef.current = { focus, onFocusPointer }
  const [viewport, setViewport] = useState({ left: 0, width: 1, total: 1 })

  const renderedColumn = (repo: string) => elementWithData(scrollerRef.current, 'data-repository', repo)
  const restoreActionFocus = (origin: ActionOrigin) => {
    if (actionOriginRef.current !== origin || focusSelectionRef.current.focus !== origin.pointerId || scrollerRef.current === null) return
    if (origin.button.isConnected) {
      origin.button.focus({ preventScroll: true })
      return
    }
    const column = renderedColumn(origin.repo)
    const chips = new Map(Array.from(column?.querySelectorAll<HTMLElement>('[data-pointer-id]') ?? [],
      chip => [chip.dataset.pointerId, chip]))
    const same = chips.get(origin.pointerId)
    const next = origin.successors.find(id => chips.has(id))
    const target = same ?? (next === undefined ? null : chips.get(next)) ?? column?.querySelector<HTMLElement>('.vcs-tile-head')
    actionOriginRef.current = null
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    target?.focus({ preventScroll: true })
    if (same === undefined) focusSelectionRef.current.onFocusPointer(next ?? null)
  }

  // A dialog can close before the refreshed overview reports the deletion.
  // Follow a focused opener that vanishes on that render, but do not take
  // focus back if the user has already moved elsewhere.
  const origin = actionOriginRef.current
  const openerHadFocus = origin !== null && origin.button.ownerDocument.activeElement === origin.button
  useLayoutEffect(() => {
    if (openerHadFocus && origin !== null && !origin.button.isConnected) restoreActionFocus(origin)
  })

  const measure = () => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    setViewport({ left: scroller.scrollLeft, width: scroller.clientWidth, total: Math.max(1, scroller.scrollWidth) })
  }
  useEffect(() => {
    measure()
    const scroller = scrollerRef.current
    if (scroller === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [columns.length, expanded])

  useImperativeHandle(control, () => ({
    scrollColumns(direction) {
      const scroller = scrollerRef.current
      if (scroller === null) return
      const column = scroller.querySelector<HTMLElement>('.vcs-tile-column:not([data-spine])')
      scroller.scrollBy({ left: direction * ((column?.offsetWidth ?? 360) + 12), behavior: reducedMotion() ? 'auto' : 'smooth' })
    },
    reveal(pointerId) {
      const element = elementWithData(scrollerRef.current, 'data-pointer-id', pointerId)
      if (element === null) return
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
      element.focus({ preventScroll: true })
    },
    focus() {
      const chip = focus === null ? null : elementWithData(scrollerRef.current, 'data-pointer-id', focus)
      ;(chip ?? scrollerRef.current)?.focus({ preventScroll: true })
    },
    columnRects() {
      return repositoryRects(scrollerRef.current, '.vcs-tile-column[data-repository]')
    },
  }))

  // A vertical wheel outside a column's list slides the row of columns sideways.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current
    if (scroller === null || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if ((event.target as HTMLElement).closest?.('.vcs-tile-body') !== null) return
    scroller.scrollLeft += event.deltaY
  }

  const focused = focus === null ? null : columns.flatMap(column => column.view?.pointers ?? []).find(pointer => pointer.id === focus)
    ?? unlisted.flatMap(view => view.pointers).find(pointer => pointer.id === focus) ?? null
  const focusedColumn = focused === null ? undefined : columns.find(column => column.view?.path === focused.repo)
  const focusedView = focusedColumn?.view ?? null
  const notice = notices.get(focused?.repo ?? currentRepo)

  const stop = (event: ReactMouseEvent) => { event.stopPropagation() }

  return (
    <div className="vcs-tiled" data-filtering={filter !== null || undefined} data-narrow={narrow || undefined} onMouseDown={stop} onClick={stop}>
      <div className="vcs-tile-columns" ref={scrollerRef} tabIndex={0} onScroll={measure} onWheel={onWheel} aria-label={t('tile.columns')} role="group">
        {columns.map(column => {
          const quiet = column.view?.quiet === true
          const path = column.entry.path
          if (quiet && !expanded.includes(path)) {
            return (
              <button
                key={path}
                type="button"
                className="vcs-tile-column vcs-tile-spine"
                data-spine=""
                data-repository={path}
                data-remote={column.view?.remotes.length === 0 ? undefined : ''}
                title={column.view?.remotes.length === 0
                  ? t('tile.expandSpineLocal', { name: column.entry.name })
                  : t('tile.expandSpine', { name: column.entry.name })}
                onClick={() => { onExpand(path) }}
              >
                <span className="vcs-tile-spine-mark" aria-hidden="true" />
                <span className="vcs-tile-spine-name">{column.entry.name}</span>
              </button>
            )
          }
          const hit = filter !== null && (column.view?.list.some(pointer => matchesFilter(pointer, filter)) ?? false)
          return (
            <section
              key={path}
              className="vcs-tile-column"
              data-repository={path}
              data-current={path === currentRepo || undefined}
              data-no-hit={filter !== null && !hit ? '' : undefined}
              aria-label={column.entry.name}
            >
              <ColumnHead column={column} quiet={quiet} onCollapse={() => { onCollapse(path) }} onOpen={() => { onOpenTimeline(path, null) }} t={t} locale={locale} />
              <ColumnBody column={column} focus={focus} filter={filter} cwd={cwd} onFocus={onFocusPointer} onActions={onPointerActions} t={t} locale={locale} />
            </section>
          )
        })}
        {unlisted.length > 0 ? (
          <aside className="vcs-tile-column vcs-tile-unlisted" data-repository="">
            <b>{formatPlural(t, 'overview.unlisted', unlisted.length, locale)}</b>
            <ul>
              {unlisted.map(view => (
                <li key={view.path} title={view.path}>
                  {view.relativePath}
                  {view.unique > 0 ? <span data-state="unique"> · {formatPlural(t, 'overview.metric.unique', view.unique, locale)}</span> : null}
                  {view.dirty > 0 ? <span data-state="unsaved"> · {formatPlural(t, 'overview.metric.unsaved', view.dirty, locale)}</span> : null}
                </li>
              ))}
            </ul>
            <button type="button" className="vcs-button" onClick={() => { onAddUnlisted(unlisted.map(view => view.relativePath)) }}>{t('overview.unlistedAdd')}</button>
          </aside>
        ) : null}
      </div>
      {focusedView !== null || notice !== undefined ? (
        <div className="vcs-tile-actionbar" role="region" aria-label={t('tile.selected')}>
          {focused !== null && focusedColumn !== undefined && focusedView !== null ? (
            <ActionBar
              key={focused.id}
              pointer={focused}
              view={focusedView}
              cwd={cwd}
              directActions={tileDirectActions(focused, focusedView, focusedColumn.entry.capabilities, inFlight.get(focused.repo), focusedColumn.entry)}
              stashOps={focusedColumn.entry.capabilities.stashOps === true}
              onOpen={() => { onOpenTimeline(focused.repo, focused) }}
              onActions={element => {
                const box = element.getBoundingClientRect()
                onPointerActions(focused, { clientX: box.left, clientY: box.top - 4 }, element)
              }}
              onDirectAction={(action, button) => {
                const chips = Array.from(renderedColumn(focused.repo)?.querySelectorAll<HTMLElement>('[data-pointer-id]') ?? [])
                const index = chips.findIndex(chip => chip.dataset.pointerId === focused.id)
                const opener = {
                  repo: focused.repo, pointerId: focused.id, button,
                  successors: index < 0 ? [] : chips.slice(index + 1).map(chip => chip.dataset.pointerId ?? ''),
                }
                actionOriginRef.current = opener
                button.focus({ preventScroll: true })
                onDirectAction(focused, action, () => { restoreActionFocus(opener) })
              }}
              t={t}
              locale={locale}
            />
          ) : null}
          {notice === undefined ? null : (
            <p
              className={notice.tone === 'info' ? 'vcs-notice vcs-notice-info' : 'vcs-notice'}
              role={notice.tone === 'info' ? 'status' : 'alert'}
              title={notice.text}
            >{notice.text}</p>
          )}
        </div>
      ) : null}
      <div
        className="vcs-tile-rail"
        aria-hidden="true"
        onClick={event => {
          const scroller = scrollerRef.current
          if (scroller === null) return
          const box = event.currentTarget.getBoundingClientRect()
          scroller.scrollTo({ left: ((event.clientX - box.left) / box.width) * scroller.scrollWidth - scroller.clientWidth / 2, behavior: reducedMotion() ? 'auto' : 'smooth' })
        }}
      >
        <span className="vcs-tile-rail-segments">
          {columns.map(column => {
            const spine = column.view?.quiet === true && !expanded.includes(column.entry.path)
            const worst = worstState(column.view)
            return (
              <span
                key={column.entry.path}
                className="vcs-tile-rail-segment"
                data-spine={spine || undefined}
                data-hit={filter !== null && (column.view?.list.some(pointer => matchesFilter(pointer, filter)) ?? false) || undefined}
                style={{ flexGrow: spine ? 44 : narrow ? 300 : 360, borderBottomColor: worst === null ? 'transparent' : stateColor(worst) }}
              />
            )
          })}
        </span>
        <span
          className="vcs-tile-rail-view"
          style={{ left: `${(viewport.left / viewport.total) * 100}%`, width: `${Math.min(100, (viewport.width / viewport.total) * 100)}%` }}
        />
      </div>
    </div>
  )
}
