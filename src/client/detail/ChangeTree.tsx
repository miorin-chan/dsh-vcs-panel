/**
 * The change tree: one node's files as collapsible rows, where a file row is
 * also the header of its comparison.
 *
 * A file asks for its comparison only when it comes near the viewport, and a
 * shared queue keeps a few requests in flight; a file that scrolls away before
 * its turn never reaches the Host. Until its comparison arrives the file holds
 * an estimated height, so the scroll height settles early. The group row and
 * the expanded file row stick above the body they belong to, so the reader
 * always knows which group and file own the next hunk.
 *
 * Keyboard and scroll share one cursor over a single vertical list: tree rows
 * and the hunk headers of open comparisons. Up/down or `j`/`k` move this list,
 * brackets move rows, and the wheel, trackpad or paging move the cursor to the
 * stop being read. Neither input overrides the other.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { Api, DiffTarget, StageRequest } from '../api.js'
import { FileDiff, isValidDiff, MAX_RENDERED_LINES } from '../diff/FileDiff.js'
import type {
  DiffSide, HunkHandler, InteractionChange, RegisterHunks, RegisterSelectionClear, StageLines, StageMeta,
  StageSource, VcsFileDiff, VcsTextDiff,
} from '../diff/FileDiff.js'
import { mergeDiffs } from '../diff/merge.js'
import { formatCount, formatPlural, lineCounts, splitPath, statusKey } from '../format.js'
import {
  BACK, DOWN, findAncestor, FORWARD, hasAttr, hasClass, isDiscreteActionButton, isEditableTarget,
  isNavigationStop, isOverlayOrMenuTarget, movement, rowStep, unmodified, UP,
} from '../keys.js'
import type { ElementLike } from '../keys.js'
import { Chevron, UntrackedStat } from '../ui.jsx'
import { Bar, barWidth } from '../skeleton.jsx'
import {
  MAX_PARALLEL, changedLines, diffTargets, estimateHeight, isFolded, rowAt,
} from './detail.js'
import type { FoldReason } from './detail.js'
import { adoptComparison, keepsActiveFiles } from './comparison.js'
import type { ComparisonAnswer } from './comparison.js'
import { createQueue } from './queue.js'
import type { RequestQueue } from './queue.js'
import { StageAction } from './StageAction.js'
import { StageCheckbox } from './StageCheckbox.js'
import { FileStageMenu } from './FileStageMenu.jsx'
import { counterpartKey, isStageable, mergedStageState, STAGE, stageFiles, UNSTAGE } from './stage.js'
import type { StageDirection } from './stage.js'
import { rowBodyId } from './tree.js'
import type { DirRow, FileEntry, FileRow, GroupRow, LoadingRow, NavRow, TreeRow } from './tree.js'
import type { ReadingAnchor } from '../state.js'

/** Distance beyond the viewport at which a file starts loading. */
const PRELOAD_MARGIN = '800px 0px'

/** Comparisons kept across nodes and refreshes of the same revision. */
const CACHE_LIMIT = 300

/** Height of one tree row and of one expanded file header, in CSS pixels. */
const ROW_HEIGHT = 28

/** A ready comparison. Line-staging metadata only rides a text comparison. */
export type ReadyDiff = VcsFileDiff & Partial<Pick<VcsTextDiff, 'lineStaging' | 'fingerprint'>>

/** One answer the queue gives for one comparison target. */
export type DiffFetchResult =
  | { status: 'ready'; diff: ReadyDiff }
  | { status: 'missing' | 'error'; diff: null }

/** Ask for one target's comparison; the returned canceller drops it from the queue. */
export type DiffFetch = (
  target: DiffTarget,
  answerRevision: number,
  worktreeRevision: number | undefined,
  onAnswer: (result: DiffFetchResult) => void,
) => (() => void) | undefined

/** The identity of one comparison request; adopted into the next answer. */
export interface DiffComparison {
  load: DiffFetch
  repo: string
  revision: number
  worktreeRevision: number | undefined
  targetsKey: string
  attempt: number
}

/** One source's settled comparison, with the target it was asked for. */
export type DiffAnswerResult =
  | { target: string; source: DiffTarget; status: 'ready'; diff: ReadyDiff }
  | { target: string; source: DiffTarget; status: 'missing' | 'error'; diff: null }

/** One complete answer for every source of a file. */
export type DiffAnswer = ComparisonAnswer<DiffComparison, DiffAnswerResult>

/** Run one staging write; resolves whether the write was accepted. */
export type ChangeStage = (target: StageRequest, meta?: StageMeta) => Promise<boolean>

/** How one row expands or collapses. */
export interface RowExpansion {
  collapsed: Record<string, boolean>
  dirs: Record<string, boolean>
}

/** Bulk fold direction the toolbar asks for. */
export type BulkFoldMode = 'collapse' | 'expand'

/** The DOM stop a refresh restores focus to. */
type RestoreTo = 'row' | 'hunk' | 'line'

/** Where a staging write left the cursor, restored after the refresh. */
interface StageSourceState {
  key: string
  alternate: string | undefined
  hunk: number
  restoreTo: RestoreTo
}

/** The tree rows one render showed, kept until an interaction can end. */
interface DisplayedTree {
  rows: readonly TreeRow[]
  rowExpansion: RowExpansion
  revision: number
  api: Api
  repo: string
  before: ReactNode
}

/** Where the next render restores the reading position. */
interface RefreshedAnchor {
  key: string
  alternate: string | undefined
  hunk: number
  restoreTo: RestoreTo
  focused: boolean
  offset: number
  rows: readonly TreeRow[]
}

/** The cursor stop: one tree row and, inside an open file, one hunk. */
interface Cursor {
  row: number
  hunk: number
}

/** What one row's staging controls would write, or why they cannot. */
export interface RowStaging {
  merged: boolean
  mixed?: boolean
  conflict?: boolean
  state?: boolean | 'mixed'
  label: string
  unstaging: boolean
  stage?: () => Promise<boolean>
  unstage?: () => Promise<boolean>
  stagedWrite?: () => Promise<boolean>
  primaryWrite?: () => Promise<boolean>
  disabled: boolean
}

/** A React key event; React omits the native `isComposing` flag the handler reads. */
interface KeyEvent extends ReactKeyboardEvent<HTMLElement> {
  isComposing?: boolean
}

/** The tree controls the detail pane drives from outside the tree. */
export interface ChangeTreeControl {
  readingAnchor(): ReadingAnchor | null
  focusReading(): boolean
  restoreFocus(): boolean
  handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): boolean
  bulkFold(mode: BulkFoldMode): void
}

/** A failed request's readable fields: the DOM abort name and the Host code. */
interface RequestFailure {
  name?: string
  code?: string
}

/**
 * Read one `data-` attribute. The DOM types an observer target and the active
 * element as `Element`, which does not declare `dataset`; the fake DOM used by
 * tests exposes the same dataset fields.
 */
function dataValue(element: unknown, name: string): string | undefined {
  if (element === null || typeof element !== 'object') return undefined
  const dataset = (element as { dataset?: Record<string, string | undefined> }).dataset
  return dataset?.[name]
}

/** The identity of one comparison request. */
function targetKey(target: DiffTarget): string {
  return JSON.stringify([target.scope, target.path, target.oldPath, target.rev])
}

/** Store one answer, evicting the oldest past {@link CACHE_LIMIT}. */
function remember(cache: Map<string, DiffFetchResult>, key: string, value: DiffFetchResult): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

/** The localized reason a folded file gives when the folding budget kept it closed. */
function foldedText(reason: FoldReason, entry: FileEntry, t: Translate, locale: string | undefined): string {
  if (reason === 'large') return formatPlural(t, 'stream.foldedLarge', changedLines(entry), locale)
  return t('stream.foldedBudget')
}

/**
 * Keys a reading position may fall back to when its exact row is not rendered,
 * from the row itself up to its group row.
 * @param key - a row key.
 * @returns candidate keys, nearest first.
 */
function ancestorKeys(key: string): string[] {
  const candidates = [key]
  const bar = key.indexOf('|')
  if (bar < 0) return candidates
  const group = key.slice(0, bar + 1)
  let path = key.slice(bar + 1)
  while (path.includes('/')) {
    path = path.slice(0, path.lastIndexOf('/'))
    candidates.push(`${group}${path}`)
  }
  candidates.push(group)
  return candidates
}

/** Props of one file's comparison body. */
interface FileBodyProps {
  fileKey: string
  group: string
  entry: FileEntry
  repo: string
  rev: string | null
  near: boolean
  folded: boolean
  foldReason: FoldReason | undefined
  request: DiffFetch
  revision: number
  backgroundDiffRevision: number | undefined
  split: boolean
  wrap: boolean
  onStage: ChangeStage | undefined
  stageDisabled: boolean
  onRegisterHunks: ((fileKey: string, handlers: (HunkHandler | null)[]) => void) | undefined
  onRegisterSelectionClear: ((fileKey: string, clear: (() => boolean) | null) => void) | undefined
  onInteractionChange: ((fileKey: string, interacting: boolean) => void) | undefined
  interacting: boolean
  t: Translate
  locale: string | undefined
}

/**
 * One file's comparison, or the reason it is folded.
 *
 * The comparison is requested when the file is both unfolded and near the
 * viewport. A placeholder holds the estimated height until then, so rows below
 * do not jump when the answer arrives.
 */
const FileBody = memo(function FileBody({
  fileKey, group, entry, repo, rev, near, folded, foldReason, request, revision, backgroundDiffRevision,
  split, wrap, onStage, stageDisabled, onRegisterHunks, onRegisterSelectionClear, onInteractionChange, interacting, t, locale,
}: FileBodyProps) {
  const [shown, setShown] = useState<DiffAnswer | null>(null)
  const [loaded, setLoaded] = useState<DiffAnswer | null>(null)
  const [attempt, setAttempt] = useState(0)
  const targets = diffTargets(group, entry, rev)
  const targetsKey = targets.map(targetKey).join('\0')
  // A Jujutsu working copy uses commit targets. New snapshots have new SHAs,
  // so these cache entries can be shared with the immutable commit details.
  const worktreeRevision = rev === null ? backgroundDiffRevision : undefined
  const comparison = useMemo(() => ({ load: request, repo, revision, worktreeRevision, targetsKey, attempt }),
    [request, repo, revision, worktreeRevision, targetsKey, attempt])
  const answer = shown?.request.repo === repo ? shown : null
  const targetChanged = answer !== null && answer.request.targetsKey !== targetsKey
  const backgroundUpdate = answer !== null && answer.request.load === request && answer.request.revision === revision && (
    answer.request.worktreeRevision !== worktreeRevision
    || (rev !== null && backgroundDiffRevision !== undefined && targetChanged)
  )
  const selectionTargets = backgroundUpdate ? answer.request.targetsKey : targetsKey
  const selectionScope = useMemo(() => ({ request, revision, selectionTargets }), [request, revision, selectionTargets])
  const hunksBySourceRef = useRef(new Map<number, (HunkHandler | null)[]>())
  const clearBySourceRef = useRef(new Map<number, () => boolean>())

  const publishHunks = useCallback(() => {
    if (onRegisterHunks === undefined) return
    const combinedList: (HunkHandler | null)[] = []
    const keys = [...hunksBySourceRef.current.keys()].sort((a, b) => a - b)
    for (const key of keys) combinedList.push(...(hunksBySourceRef.current.get(key) ?? []))
    onRegisterHunks(fileKey, combinedList)
  }, [fileKey, onRegisterHunks])

  const registerSourceHunks = useMemo(() => {
    const cache = new Map<number, RegisterHunks>()
    return (sourceIndex: number): RegisterHunks => {
      let fn = cache.get(sourceIndex)
      if (fn === undefined) {
        fn = handlers => {
          if (handlers.length === 0) hunksBySourceRef.current.delete(sourceIndex)
          else hunksBySourceRef.current.set(sourceIndex, handlers)
          publishHunks()
        }
        cache.set(sourceIndex, fn)
      }
      return fn
    }
  }, [publishHunks])

  const registerSourceClear = useMemo(() => {
    const cache = new Map<number, RegisterSelectionClear>()
    return (sourceIndex: number): RegisterSelectionClear => {
      let fn = cache.get(sourceIndex)
      if (fn === undefined) {
        fn = clearer => {
          if (clearer === null) clearBySourceRef.current.delete(sourceIndex)
          else clearBySourceRef.current.set(sourceIndex, clearer)
          if (onRegisterSelectionClear === undefined) return
          if (clearBySourceRef.current.size === 0) {
            onRegisterSelectionClear(fileKey, null)
          } else {
            onRegisterSelectionClear(fileKey, () => {
              let cleared = false
              for (const clear of clearBySourceRef.current.values()) {
                if (clear()) cleared = true
              }
              return cleared
            })
          }
        }
        cache.set(sourceIndex, fn)
      }
      return fn
    }
  }, [fileKey, onRegisterSelectionClear])

  const reportSourceInteraction = useMemo<(sourceIndex: number) => InteractionChange | undefined>(() => {
    if (onInteractionChange === undefined) return () => undefined
    const active = new Set<number>()
    const callbacks = new Map<number, InteractionChange>()
    return (sourceIndex: number): InteractionChange => {
      if (!callbacks.has(sourceIndex)) {
        callbacks.set(sourceIndex, interacting => {
          if (interacting) active.add(sourceIndex)
          else active.delete(sourceIndex)
          onInteractionChange(fileKey, active.size > 0)
        })
      }
      return callbacks.get(sourceIndex) ?? (() => undefined)
    }
  }, [fileKey, onInteractionChange])

  useLayoutEffect(() => {
    if (!folded) return undefined
    hunksBySourceRef.current.clear()
    clearBySourceRef.current.clear()
    onRegisterHunks?.(fileKey, [])
    onRegisterSelectionClear?.(fileKey, null)
    return undefined
  }, [fileKey, folded, onRegisterHunks, onRegisterSelectionClear])

  useLayoutEffect(() => () => {
    hunksBySourceRef.current.clear()
    clearBySourceRef.current.clear()
    onRegisterHunks?.(fileKey, [])
    onRegisterSelectionClear?.(fileKey, null)
  }, [fileKey, onRegisterHunks, onRegisterSelectionClear])

  useEffect(() => {
    if (folded || !near || loaded?.request === comparison) return undefined
    // Settle both sources together so a merged file cannot mix revisions.
    const results = new Map<string, DiffAnswerResult>()
    const cancel = targets.map(target => request(target, revision, worktreeRevision, result => {
      results.set(target.scope, { ...result, target: targetKey(target), source: target })
      if (results.size === targets.length) {
        setLoaded({ results: targets.map(source => results.get(source.scope)!), request: comparison })
      }
    }))
    return () => { for (const stop of cancel) stop?.() }
    // `comparison` keys both `targets` and `loaded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, near, comparison])

  useLayoutEffect(() => {
    const next = adoptComparison(shown, loaded, comparison, backgroundUpdate && interacting)
    if (next !== shown) setShown(next)
  }, [shown, loaded, comparison, backgroundUpdate, interacting])

  const results = answer?.results ?? []
  const combined = useMemo(() => {
    const [staged, unstaged] = results
    if (group !== 'merged' || staged?.diff?.kind !== 'text' || unstaged?.diff?.kind !== 'text'
      || staged.diff.indexOid === undefined || staged.diff.indexOid !== unstaged.diff.indexOid
      || staged.diff.hunks.length === 0 || unstaged.diff.hunks.length === 0 || staged.diff.coarse || unstaged.diff.coarse) return null
    const diff = mergeDiffs(staged.diff, unstaged.diff)
    const length = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    return length <= MAX_RENDERED_LINES ? diff : null
  }, [results, group])

  if (folded) {
    if (foldReason === undefined) return null
    return <p className="vcs-tree-folded">{foldedText(foldReason, entry, t, locale)}</p>
  }
  if (answer === null) {
    return (
      <div className="vcs-tree-placeholder" style={{ height: `${estimateHeight(entry)}px` }}>
        <FileDiff state="loading" split={split} wrap={wrap} retry={() => undefined} t={t} locale={locale} />
      </div>
    )
  }
  const busy = stageDisabled || answer.request.load !== request || answer.request.revision !== revision
    || (targetChanged && !backgroundUpdate)
  const retry = () => { setAttempt(value => value + 1) }
  const stageLines = (target: DiffTarget): StageLines | undefined => onStage === undefined
    ? undefined
    : (fingerprint, lines, meta) => onStage({ ...target, fingerprint, lines }, meta)
  if (combined !== null) {
    const stageSources: Partial<Record<DiffSide, StageSource>> = Object.fromEntries(results.map(({ source, diff }) => [source.scope, {
      fingerprint: diff!.lineStaging === true ? diff!.fingerprint : undefined,
      onStageLines: stageLines(source),
    }]))
    return <FileDiff state={combined} split={split} wrap={wrap} retry={retry} stageSources={stageSources}
      stageDisabled={busy} showStageState={true} selectionScope={selectionScope}
      onRegisterHunks={registerSourceHunks(0)} onRegisterSelectionClear={registerSourceClear(0)}
      onInteractionChange={reportSourceInteraction(0)} t={t} locale={locale} />
  }
  const renderDiff = ({ status, diff, source }: DiffAnswerResult, sourceIndex: number) => (
    <FileDiff
      state={status === 'ready' ? diff : status}
      split={split}
      wrap={wrap}
      retry={retry}
      onStageLines={stageLines(source)}
      // The scope is `commit`/`untracked` too; FileDiff only reads it as a
      // staging side, and those scopes never enable line staging.
      stageScope={source.scope as DiffSide}
      stageDisabled={busy}
      showStageState={group === 'merged'}
      selectionScope={selectionScope}
      onRegisterHunks={registerSourceHunks(sourceIndex)}
      onRegisterSelectionClear={registerSourceClear(sourceIndex)}
      onInteractionChange={reportSourceInteraction(sourceIndex)}
      t={t}
      locale={locale}
    />
  )
  if (results.length === 1) return renderDiff(results[0], 0)
  return results.map((result, sourceIndex) => (
    <div className="vcs-diff-source" key={result.source.scope}>
      <div className="vcs-diff-source-label">{t(result.source.scope === 'staged' ? 'changes.staged' : 'changes.unstaged')}</div>
      {renderDiff(result, sourceIndex)}
    </div>
  ))
})

/** Props of the change tree of one node. */
export interface ChangeTreeProps {
  api: Api
  repo: string
  rev: string | null
  rows: readonly TreeRow[]
  rowExpansion: RowExpansion
  budget: ReadonlyMap<string, FoldReason>
  folds: Record<string, boolean>
  split: boolean
  wrap: boolean
  revision: number
  backgroundDiffRevision: number | undefined
  cache: Map<string, DiffFetchResult>
  initialAnchor: ReadingAnchor | null
  onReading: (anchor: ReadingAnchor | null) => void
  onToggleRow: (row: NavRow, expanded: boolean) => void
  onBulkFold: (mode: BulkFoldMode) => void
  onLeave: () => void
  control: MutableRefObject<ChangeTreeControl | null>
  before?: ReactNode
  onStage?: ChangeStage
  partiallyStaged?: ReadonlySet<string>
  stageDisabled: boolean
  onInteractionChange?: (interacting: boolean) => void
  t: Translate
  locale?: string
}

/**
 * Render the change tree of one node.
 * @param props - rows, expansion data, and panel state.
 */
export function ChangeTree({
  api, repo, rev, rows: nextRows, rowExpansion, budget, folds, split, wrap, revision, backgroundDiffRevision, cache,
  initialAnchor, onReading, onToggleRow, onBulkFold, onLeave, control, before = null, onStage,
  partiallyStaged, stageDisabled, onInteractionChange, t, locale,
}: ChangeTreeProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const displayedTree = useRef<DisplayedTree | null>(null)
  const [activeFiles, setActiveFiles] = useState<Set<string>>(() => new Set())
  const reportInteraction = useCallback((key: string, active: boolean) => {
    setActiveFiles(previous => {
      if (previous.has(key) === active) return previous
      const next = new Set(previous)
      if (active) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const interacting = activeFiles.size > 0
  const interactionListener = useRef<((interacting: boolean) => void) | undefined>(onInteractionChange)
  useLayoutEffect(() => { interactionListener.current = onInteractionChange }, [onInteractionChange])
  useLayoutEffect(() => {
    if (interacting) interactionListener.current?.(true)
    return () => { if (interacting) interactionListener.current?.(false) }
  }, [interacting])

  // A status update can remove a file or move it under a different compressed
  // directory. Keep its DOM mounted until the current interaction can end.
  const previous = displayedTree.current
  const holdTree = backgroundDiffRevision !== undefined && previous !== null
    && previous.revision === revision && previous.api === api && previous.repo === repo
    && previous.rowExpansion === rowExpansion
    && !keepsActiveFiles(previous.rows, nextRows, activeFiles)
  const rows = holdTree && previous !== null ? previous.rows : nextRows
  useLayoutEffect(() => {
    if (!holdTree) displayedTree.current = { rows, rowExpansion, revision, api, repo, before }
  }, [holdTree, rows, rowExpansion, revision, api, repo, before])
  const rowEls = useRef(new Map<string, HTMLElement>())
  const bodyEls = useRef(new Map<string, HTMLElement>())
  const sectionEls = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const frameRef = useRef(0)
  const pendingPreserve = useRef<{ key: string; screenTop: number } | null>(null)
  const pendingAlign = useRef<{ key: string; alignment: number } | null>(null)
  const refreshAnchor = useRef<RefreshedAnchor | null>(null)
  const pendingHunkFocusRef = useRef<{ key: string; hunk: number } | null>(null)
  const stageSource = useRef<StageSourceState | null>(null)
  const hunkActionsRef = useRef(new Map<string, (HunkHandler | null)[]>())
  const selectionClearersRef = useRef(new Map<string, () => boolean>())
  const restoredRef = useRef(false)
  const lastInputRef = useRef<'scroll' | 'keyboard'>('scroll')
  const queue = useMemo<RequestQueue>(() => createQueue(MAX_PARALLEL), [])
  const [near, setNear] = useState<Map<string, boolean>>(() => new Map())
  const [everyNear, setEveryNear] = useState(false)
  const [cursor, setCursor] = useState<Cursor>({ row: 0, hunk: -1 })
  const cursorRef = useRef<Cursor>({ row: 0, hunk: -1 })
  const readingRef = useRef<string | null>(initialAnchor?.key ?? null)
  const [readingKey, setReadingKey] = useState<string | null>(initialAnchor?.key ?? null)

  const navRows = useMemo(() => rows.filter((row): row is NavRow => row.kind !== 'loading'), [rows])
  const grouped = useMemo(() => rows.some(row => row.kind === 'group'), [rows])
  // A working tree that can be staged draws a gutter; merged rows keep it to
  // show their staged state even while writes are unavailable.
  const gutter = onStage !== undefined || rows.some(row => row.group === 'merged')
  const stagingRef = useRef<(row: NavRow) => RowStaging | null>(() => null)
  const navIndexByKey = useMemo(() => {
    const index = new Map<string, number>()
    navRows.forEach((row, at) => index.set(row.key, at))
    return index
  }, [navRows])
  const cursorKey = navRows[Math.max(0, Math.min(cursor.row, navRows.length - 1))]?.key ?? null

  /** Whether one file row is folded under the current rules. */
  const isRowFolded = useCallback((row: { key: string }) => isFolded(row.key, folds), [folds])

  // Folding reasons describe why some files stay closed while diffs are being
  // read; in the collapsed default they would only repeat the file list.
  const someUnfolded = useMemo(
    () => rows.some(row => row.kind === 'file' && !isRowFolded(row)),
    [isRowFolded, rows],
  )

  const setCursorAt = useCallback((row: number, hunk = -1) => {
    const next = { row, hunk }
    cursorRef.current = next
    setCursor(next)
  }, [])

  /** The top offset of one element inside the scrolling tree, ignoring sticky displacement. */
  const flowTop = useCallback((element: ElementLike | null | undefined): number => {
    const root = scrollRef.current
    if (element === null || element === undefined || root === null) return 0
    // Group and file heads stick while scrolling, shifting their own
    // `offsetTop`; the static container around each head holds its layout
    // position in the tree.
    let node: ElementLike | null | undefined = element
    if (hasClass(node, 'vcs-tree-file-head')) {
      node = findAncestor(node, root, candidate => hasClass(candidate, 'vcs-tree-file')) ?? node
    } else if (hasClass(node, 'vcs-tree-group-head')) {
      node = findAncestor(node, root, candidate => hasClass(candidate, 'vcs-tree-group')) ?? node
    }
    let top = 0
    while (node !== null && node !== undefined && node !== root) {
      top += node.offsetTop ?? 0
      node = node.offsetParent ?? null
    }
    return top
  }, [])

  /** The tree top a row is aligned to, leaving the sticky rows in view. */
  const alignmentTop = useCallback((row: NavRow) => {
    if (!grouped) return 0
    return row.kind === 'group' ? 0 : ROW_HEIGHT
  }, [grouped])

  /** A stable ref callback per row key, so rerenders do not rebind. */
  const bindRow = useMemo(() => {
    const callbacks = new Map<string, (element: HTMLElement | null) => void>()
    return (key: string) => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          if (element === null) rowEls.current.delete(key)
          else rowEls.current.set(key, element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  /** A stable ref callback per file body; hunk headers are looked up there. */
  const bindBody = useMemo(() => {
    const callbacks = new Map<string, (element: HTMLElement | null) => void>()
    return (key: string) => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          if (element === null) bodyEls.current.delete(key)
          else bodyEls.current.set(key, element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  /** A stable ref callback per file section, observed for loading. */
  const bindSection = useMemo(() => {
    const callbacks = new Map<string, (element: HTMLElement | null) => void>()
    return (key: string) => {
      let callback = callbacks.get(key)
      if (callback === undefined) {
        callback = element => {
          const previous = sectionEls.current.get(key)
          if (previous !== undefined) observerRef.current?.unobserve(previous)
          if (element === null) {
            sectionEls.current.delete(key)
            return
          }
          sectionEls.current.set(key, element)
          observerRef.current?.observe(element)
        }
        callbacks.set(key, callback)
      }
      return callback
    }
  }, [])

  const cacheRef = useRef(cache)
  cacheRef.current = cache

  /** Ask for one comparison through the cache and the queue; returns a canceller. */
  const request = useCallback<DiffFetch>((target, answerRevision, worktreeRevision, onAnswer) => {
    const requestCache = cacheRef.current
    const key = JSON.stringify([repo, targetKey(target), answerRevision, worktreeRevision])
    const cached = requestCache.get(key)
    if (cached !== undefined) {
      onAnswer(cached)
      return undefined
    }
    const controller = new AbortController()
    let settled = false
    const cancel = queue.enqueue(() => {
      if (controller.signal.aborted) return Promise.resolve()
      return api.diff(repo, target, controller.signal).then(diff => {
        if (controller.signal.aborted) return
        settled = true
        if (!isValidDiff(diff)) {
          onAnswer({ status: 'error', diff: null })
          return
        }
        const result: DiffFetchResult = { status: 'ready', diff }
        remember(requestCache, key, result)
        onAnswer(result)
      }, (error: RequestFailure) => {
        if (error?.name === 'AbortError' || controller.signal.aborted) return
        settled = true
        onAnswer({ status: error?.code === 'not-found' ? 'missing' : 'error', diff: null })
      })
    })
    return () => {
      if (settled) return
      cancel()
      controller.abort()
    }
  }, [api, queue, repo])

  // Files near the viewport, as the browser reports them.
  useEffect(() => {
    const root = scrollRef.current
    if (root === null) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setEveryNear(true)
      return undefined
    }
    const observer = new IntersectionObserver(entries => {
      setNear(previous => {
        const next = new Map(previous)
        for (const entry of entries) {
          const key = dataValue(entry.target, 'fileKey')
          if (key === undefined) continue
          next.set(key, entry.isIntersecting)
        }
        return next
      })
    }, { root, rootMargin: PRELOAD_MARGIN })
    observerRef.current = observer
    for (const element of sectionEls.current.values()) observer.observe(element)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [])

  /** The row index of one key, falling back to its nearest rendered ancestor. */
  const indexOfKey = useCallback((key: string | null) => {
    if (key === null) return -1
    for (const candidate of ancestorKeys(key)) {
      const index = navIndexByKey.get(candidate)
      if (index !== undefined) return index
    }
    return -1
  }, [navIndexByKey])

  /** Report the row being read and the offset below its top. */
  const report = useCallback((): ReadingAnchor | undefined => {
    const root = scrollRef.current
    if (root === null) return
    const tops: number[] = []
    const keys: string[] = []
    for (const row of navRows) {
      const element = rowEls.current.get(row.key)
      if (element === undefined) continue
      keys.push(row.key)
      tops.push(flowTop(element))
    }
    if (keys.length === 0) {
      readingRef.current = null
      setReadingKey(null)
      onReading(null)
      return
    }
    const offset = root.scrollTop + 1
    if (offset < tops[0]) {
      readingRef.current = null
      setReadingKey(null)
      onReading(null)
      return
    }
    const index = rowAt(tops, offset)
    const key = keys[index]
    readingRef.current = key
    setReadingKey(previous => (previous === key ? previous : key))
    const anchor = { key, offset: Math.max(0, root.scrollTop - tops[index]) }
    onReading(anchor)
    return anchor
  }, [flowTop, navRows, onReading])

  /** Align one row below the sticky rows, but only when it is out of view. */
  const scrollRowIntoView = useCallback((index: number) => {
    const root = scrollRef.current
    const row = navRows[index]
    if (root === null || row === undefined) return
    const element = rowEls.current.get(row.key)
    if (element === undefined) return
    const top = flowTop(element)
    const alignment = alignmentTop(row)
    const viewTop = root.scrollTop + alignment
    const viewBottom = root.scrollTop + root.clientHeight
    if (top < viewTop || top + ROW_HEIGHT > viewBottom) {
      root.scrollTop = Math.max(0, top - alignment)
    }
  }, [alignmentTop, flowTop, navRows])

  /** Focus one row without letting the browser scroll it again. */
  const focusRowElement = useCallback((key: string) => {
    rowEls.current.get(key)?.focus({ preventScroll: true })
  }, [])

  const clearAnyDiffSelection = useCallback(() => {
    let cleared = false
    for (const clear of selectionClearersRef.current.values()) {
      if (clear()) cleared = true
    }
    return cleared
  }, [])

  const registerSelectionClear = useCallback((fileKey: string, clearer: (() => boolean) | null) => {
    if (clearer === null) selectionClearersRef.current.delete(fileKey)
    else selectionClearersRef.current.set(fileKey, clearer)
  }, [])

  /** Focus one hunk header without letting the browser scroll it again. */
  const focusHunkElement = useCallback((key: string, hunk: number) => {
    const header = bodyEls.current.get(key)?.querySelectorAll<HTMLElement>('[data-diff-hunk-header]')[hunk]
    header?.focus?.({ preventScroll: true })
  }, [])

  const registerHunks = useCallback((fileKey: string, handlers: (HunkHandler | null)[]) => {
    if (handlers.length === 0) hunkActionsRef.current.delete(fileKey)
    else hunkActionsRef.current.set(fileKey, handlers)
    const pending = pendingHunkFocusRef.current
    if (pending === null || pending.key !== fileKey) return
    const index = navIndexByKey.get(fileKey)
    if (index === undefined) return
    const root = scrollRef.current
    const doc = root?.ownerDocument
    const active = doc?.activeElement
    const section = sectionEls.current.get(fileKey)
    const canMoveFocus = active === doc?.body || (section !== undefined && section.contains?.(active ?? null) === true)
    if (handlers.length > 0) {
      const nextHunk = Math.max(0, Math.min(pending.hunk, handlers.length - 1))
      pendingHunkFocusRef.current = null
      setCursorAt(index, nextHunk)
      if (canMoveFocus) focusHunkElement(fileKey, nextHunk)
    }
  }, [focusHunkElement, navIndexByKey, setCursorAt])

  /** Report a row as the reading position while leaving the scroll offset explicit. */
  const markReading = useCallback((row: NavRow, offset = 0) => {
    readingRef.current = row.key
    setReadingKey(previous => (previous === row.key ? previous : row.key))
    onReading({ key: row.key, offset })
  }, [onReading])

  /** Move the keyboard cursor to one row, without entering its diff. */
  const focusRowAt = useCallback((index: number) => {
    const row = navRows[index]
    if (row === undefined) return
    setCursorAt(index, -1)
    scrollRowIntoView(index)
    focusRowElement(row.key)
    markReading(row, 0)
  }, [focusRowElement, markReading, navRows, scrollRowIntoView, setCursorAt])

  /** Whether one row currently shows the content below it. */
  const isExpanded = useCallback((row: NavRow) => (row.kind === 'file' ? !isRowFolded(row) : row.expanded), [isRowFolded])

  /**
   * Collapse or expand one row. A file head that has already scrolled past its
   * sticky slot keeps that slot when it collapses, so the next file takes over
   * right below it instead of the reader being pushed back up.
   */
  const toggle = useCallback((row: NavRow, expanded: boolean) => {
    lastInputRef.current = 'keyboard'
    if (row.kind === 'file' && expanded) {
      const root = scrollRef.current
      const element = rowEls.current.get(row.key)
      if (root !== null && element !== undefined && flowTop(element) <= root.scrollTop + alignmentTop(row)) {
        pendingAlign.current = { key: row.key, alignment: alignmentTop(row) }
      }
    }
    onToggleRow(row, !expanded)
  }, [alignmentTop, flowTop, onToggleRow])

  /** Top offsets of the hunk headers inside one file's comparison. */
  const hunkOffsets = useCallback((row: NavRow) => {
    const body = bodyEls.current.get(row.key)
    if (body === undefined) return []
    const tops = new Set<number>()
    for (const header of body.querySelectorAll('[data-diff-hunk-header]')) tops.add(flowTop(header))
    // A side-by-side comparison draws one header per column; they align, and
    // the set keeps one offset per hunk in ascending order.
    return [...tops].sort((a, b) => a - b)
  }, [flowTop])

  /** Align one row directly below the sticky rows. */
  const alignRow = useCallback((index: number) => {
    const root = scrollRef.current
    const row = navRows[index]
    if (root === null || row === undefined) return
    const element = rowEls.current.get(row.key)
    if (element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - alignmentTop(row))
  }, [alignmentTop, flowTop, navRows])

  /** The hunk stop a scroll line is reading inside one row, or -1 for the row itself. */
  const hunkAtLine = useCallback((row: NavRow, line: number) => {
    if (row.kind !== 'file' || isRowFolded(row)) return -1
    const offsets = hunkOffsets(row)
    let found = -1
    for (let at = 0; at < offsets.length; at += 1) {
      if (offsets[at] <= line) found = at
      else break
    }
    return found
  }, [hunkOffsets, isRowFolded])

  // The cursor stays inside the rendered rows and their loaded hunks.
  useLayoutEffect(() => {
    if (navRows.length === 0) {
      const current = cursorRef.current
      if (current.row !== 0 || current.hunk !== -1) setCursorAt(0, -1)
      return
    }
    const row = Math.min(cursorRef.current.row, navRows.length - 1)
    if (row !== cursorRef.current.row) {
      setCursorAt(row, -1)
      return
    }
    if (cursorRef.current.hunk < 0) return
    const target = navRows[row]
    const offsets = target.kind === 'file' && !isRowFolded(target) ? hunkOffsets(target) : []
    if (cursorRef.current.hunk >= offsets.length) setCursorAt(row, -1)
  }, [hunkOffsets, isRowFolded, navRows, setCursorAt])

  /**
   * Focus one vertical stop: a tree row or one hunk header of an open file.
   * A cross-row row stop is aligned under the sticky headers so focus, reading
   * state, and the visible position describe the same place.
   */
  const focusStop = useCallback((index: number, hunk = -1, align = false) => {
    const root = scrollRef.current
    const row = navRows[index]
    if (row === undefined) return
    const stickyBottom = (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const offsets = hunk >= 0 && row.kind === 'file' && !isRowFolded(row) ? hunkOffsets(row) : []
    const target = hunk >= 0 && hunk < offsets.length ? hunk : -1
    setCursorAt(index, target)
    lastInputRef.current = 'keyboard'
    if (target >= 0) {
      if (root !== null) root.scrollTop = Math.max(0, offsets[target] - stickyBottom)
      focusHunkElement(row.key, target)
      const element = rowEls.current.get(row.key)
      const offset = root !== null && element !== undefined ? Math.max(0, root.scrollTop - flowTop(element)) : 0
      markReading(row, offset)
      return
    }
    if (align) alignRow(index)
    else scrollRowIntoView(index)
    focusRowElement(row.key)
    markReading(row, 0)
  }, [alignRow, focusHunkElement, flowTop, focusRowElement, grouped, hunkOffsets, isRowFolded, markReading, navRows, scrollRowIntoView, setCursorAt])

  /** Restore DOM focus to the current stop without changing scrollTop. */
  const restoreFocus = useCallback(() => {
    if (navRows.length === 0) return false
    const rowIndex = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
    const row = navRows[rowIndex]
    if (row === undefined) return false
    const offsets = cursorRef.current.hunk >= 0 && row.kind === 'file' && !isRowFolded(row)
      ? hunkOffsets(row)
      : []
    if (cursorRef.current.hunk >= 0 && cursorRef.current.hunk < offsets.length) {
      focusHunkElement(row.key, cursorRef.current.hunk)
    } else {
      focusRowElement(row.key)
    }
    return true
  }, [focusHunkElement, focusRowElement, hunkOffsets, isRowFolded, navRows])

  /** `→` / `l`: expand a collapsed row, enter an open file's first hunk, or step into an expanded group or directory. */
  const forward = useCallback(() => {
    const index = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
    const row = navRows[index]
    if (row === undefined) return
    lastInputRef.current = 'keyboard'
    if (!isExpanded(row)) {
      onToggleRow(row, true)
      return
    }
    if (row.kind === 'file') {
      if (cursorRef.current.hunk < 0) {
        const offsets = hunkOffsets(row)
        if (offsets.length > 0) focusStop(index, 0)
      }
      return
    }
    if (row.kind !== 'group' && row.kind !== 'dir') return
    const child = navRows[index + 1]
    if (child === undefined) return
    const inside = row.kind === 'group' ? child.kind !== 'group' : child.depth > row.depth
    if (inside) focusRowAt(index + 1)
  }, [focusRowAt, focusStop, hunkOffsets, isExpanded, navRows, onToggleRow])

  /**
   * `←` / `h`: close the focused file when it is open, so the first back
   * step leaves the diff level. A closed file row has nothing below it, so the
   * same key then leaves the tree. Returns `'left'` when it exits the tree.
   */
  const back = useCallback((): 'collapsed' | 'left' => {
    const index = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
    const row = navRows[index]
    if (row?.kind === 'file' && isExpanded(row)) {
      setCursorAt(index, -1)
      toggle(row, true)
      focusRowElement(row.key)
      markReading(row, 0)
      return 'collapsed'
    }
    onLeave()
    return 'left'
  }, [focusRowElement, isExpanded, markReading, navRows, onLeave, setCursorAt, toggle])

  /** Move the cursor through rows and the hunk headers of open files as one list. */
  const moveStop = useCallback((direction: number) => {
    if (navRows.length === 0) return
    const rowIndex = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
    const row = navRows[rowIndex]
    if (row === undefined) return
    const offsets = row.kind === 'file' && !isRowFolded(row) ? hunkOffsets(row) : []
    const hunk = cursorRef.current.hunk >= 0 && cursorRef.current.hunk < offsets.length ? cursorRef.current.hunk : -1
    if (hunk >= 0) {
      const next = hunk + direction
      if (next >= 0 && next < offsets.length) {
        focusStop(rowIndex, next)
        return
      }
      if (direction < 0) {
        focusStop(rowIndex, -1)
        return
      }
      if (rowIndex + 1 < navRows.length) focusStop(rowIndex + 1, -1, true)
      return
    }
    if (direction > 0) {
      if (offsets.length > 0) {
        focusStop(rowIndex, 0)
        return
      }
      if (rowIndex + 1 < navRows.length) focusStop(rowIndex + 1, -1)
      return
    }
    if (rowIndex > 0) {
      const previous = navRows[rowIndex - 1]
      const previousOffsets = previous.kind === 'file' && !isRowFolded(previous) ? hunkOffsets(previous) : []
      focusStop(rowIndex - 1, previousOffsets.length > 0 ? previousOffsets.length - 1 : -1)
      return
    }
    if (scrollRef.current !== null && scrollRef.current.scrollTop > 0) {
      lastInputRef.current = 'keyboard'
      scrollRef.current.scrollTop = 0
      focusRowElement(row.key)
      report()
    }
  }, [focusRowElement, focusStop, hunkOffsets, isRowFolded, navRows, report])

  /** Move one tree row, skipping the hunk level. */
  const moveRow = useCallback((direction: number) => {
    if (navRows.length === 0) return
    const current = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
    const target = Math.max(0, Math.min(current + direction, navRows.length - 1))
    if (target === current) {
      if (direction < 0 && current === 0 && cursorRef.current.hunk < 0
        && scrollRef.current !== null && scrollRef.current.scrollTop > 0) {
        lastInputRef.current = 'keyboard'
        scrollRef.current.scrollTop = 0
        focusRowElement(navRows[0].key)
        report()
      }
      return
    }
    focusStop(target, -1, cursorRef.current.hunk >= 0)
  }, [focusRowElement, focusStop, navRows, report])

  /** Sync the cursor (and tree focus when inside) to the current scroll reading position. */
  const syncCursorToScroll = useCallback(() => {
    const root = scrollRef.current
    if (root === null) return
    const key = readingRef.current
    if (key === null) return
    const index = navIndexByKey.get(key)
    if (index === undefined) return
    const row = navRows[index]
    if (row === undefined) return
    const line = root.scrollTop + (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const hunk = hunkAtLine(row, line)
    if (index === cursorRef.current.row && hunk === cursorRef.current.hunk) return
    setCursorAt(index, hunk)
    const active = typeof document === 'undefined' ? null : document.activeElement
    const focusInside = active !== null
      && root.contains(active)
      && (hasClass(active, 'vcs-tree-row') || hasAttr(active, 'data-diff-hunk-header'))
    if (!focusInside) return
    if (hunk >= 0) focusHunkElement(key, hunk)
    else focusRowElement(key)
  }, [focusHunkElement, focusRowElement, grouped, hunkAtLine, navIndexByKey, navRows, setCursorAt])

  /** Clicks on hunk headers or diff lines adopt the corresponding stop; header/empty clicks keep focus ready. */
  const onTreeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const hunkNode = findAncestor(event.target, event.currentTarget, node => hasAttr(node, 'data-diff-hunk-header'))
    if (hunkNode !== null) {
      const file = findAncestor(hunkNode, event.currentTarget, node => node?.dataset?.fileKey !== undefined)
      const key = dataValue(file, 'fileKey')
      if (key === undefined) return
      const index = navIndexByKey.get(key)
      if (index === undefined) return
      const row = navRows[index]
      const hunk = hunkOffsets(row).indexOf(flowTop(hunkNode))
      if (hunk < 0) return
      setCursorAt(index, hunk)
      lastInputRef.current = 'keyboard'
      hunkNode.focus?.({ preventScroll: true })
      const element = rowEls.current.get(key)
      const root = scrollRef.current
      const offset = root === null || element === undefined ? 0 : Math.max(0, root.scrollTop - flowTop(element))
      markReading(row, offset)
      return
    }
    if (isEditableTarget(event.target)) return
    const interactive = findAncestor(event.target, event.currentTarget, node => {
      const tag = typeof node?.tagName === 'string' ? node.tagName.toUpperCase() : ''
      return tag === 'BUTTON' || tag === 'A'
    })
    if (interactive !== null) return
    const selection = typeof window === 'undefined' ? null : window.getSelection?.()
    if (selection !== null && selection !== undefined && selection.isCollapsed === false && String(selection) !== '') {
      return
    }
    const file = findAncestor(event.target, event.currentTarget, node => node?.dataset?.fileKey !== undefined)
    if (file === null) {
      restoreFocus()
      return
    }
    const key = dataValue(file, 'fileKey')
    if (key === undefined) {
      restoreFocus()
      return
    }
    const index = navIndexByKey.get(key)
    if (index === undefined) {
      restoreFocus()
      return
    }
    const row = navRows[index]
    const hunkSection = findAncestor(event.target, file, node => hasClass(node, 'vcs-diff-hunk'))
    const hunkHeaderEl = hunkSection?.querySelector?.('[data-diff-hunk-header]') ?? null
    const hunk = hunkHeaderEl === null ? -1 : hunkOffsets(row).indexOf(flowTop(hunkHeaderEl))
    setCursorAt(index, hunk)
    lastInputRef.current = 'keyboard'
    if (hunk >= 0) focusHunkElement(key, hunk)
    else focusRowElement(key)
    const element = rowEls.current.get(key)
    const root = scrollRef.current
    const offset = root === null || element === undefined ? 0 : Math.max(0, root.scrollTop - flowTop(element))
    markReading(row, offset)
  }

  const runKeyDown = useCallback((event: KeyEvent, { fromOutside = false } = {}): boolean | 'collapsed' | 'left' => {
    if (isEditableTarget(event.target) || isOverlayOrMenuTarget(event.target, scrollRef.current)) return false
    if (event.isComposing === true) return false
    if ((event.key === 'Enter' || event.key === ' ') && !fromOutside && isDiscreteActionButton(event.target, scrollRef.current)) {
      return false
    }
    // Hunk headers are not buttons, so Space/Enter act on their owning file.
    if (cursorRef.current.hunk >= 0 && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      return back()
    }
    if (fromOutside && (event.key === 'Enter' || event.key === ' ') && navRows.length > 0) {
      event.preventDefault()
      const rowIndex = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
      const row = navRows[rowIndex]
      if (row !== undefined) {
        toggle(row, isExpanded(row))
        focusRowElement(row.key)
      }
      return true
    }
    // `s` stages and `u` unstages the row or hunk under the cursor.
    if (!fromOutside && (event.key === 's' || event.key === 'u') && unmodified(event)) {
      const current = navRows[Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))]
      if (current === undefined) return false
      let run
      if (cursorRef.current.hunk >= 0) {
        const hunkAction = hunkActionsRef.current.get(current.key)?.[cursorRef.current.hunk]
        run = event.key === 's' ? hunkAction?.stage : hunkAction?.unstage
      } else {
        const staging = stagingRef.current(current)
        run = event.key === 's' ? staging?.stage : staging?.unstage
      }
      if (run === undefined) return false
      event.preventDefault()
      if (!stageDisabled) void run()
      return true
    }
    const row = rowStep(event)
    if (row !== 0) {
      event.preventDefault()
      moveRow(row)
      return true
    }
    if (unmodified(event) && navRows.length > 0) {
      if (event.key === 'Home') {
        event.preventDefault()
        lastInputRef.current = 'keyboard'
        if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
        setCursorAt(0, -1)
        focusRowElement(navRows[0].key)
        report()
        return true
      }
      if (event.key === 'End') {
        event.preventDefault()
        const last = navRows.length - 1
        const lastRow = navRows[last]
        const lastOffsets = lastRow.kind === 'file' && !isRowFolded(lastRow) ? hunkOffsets(lastRow) : []
        focusStop(last, lastOffsets.length > 0 ? lastOffsets.length - 1 : -1, true)
        return true
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        const root = scrollRef.current
        if (root !== null && root.clientHeight > 0) {
          event.preventDefault()
          lastInputRef.current = 'scroll'
          const step = Math.max(ROW_HEIGHT, root.clientHeight - ROW_HEIGHT * 2)
          const delta = event.key === 'PageDown' ? step : -step
          const maxTop = typeof root.scrollHeight === 'number' && root.scrollHeight > root.clientHeight
            ? root.scrollHeight - root.clientHeight
            : Number.POSITIVE_INFINITY
          root.scrollTop = Math.max(0, Math.min(maxTop, root.scrollTop + delta))
          report()
          if (readingRef.current === null && event.key === 'PageUp') {
            setCursorAt(0, -1)
            const active = typeof document === 'undefined' ? null : document.activeElement
            if (isNavigationStop(active, root)) focusRowElement(navRows[0].key)
          } else {
            syncCursorToScroll()
          }
          return true
        }
      }
    }
    const direction = movement(event)
    if (direction === DOWN) {
      event.preventDefault()
      moveStop(1)
      return true
    }
    if (direction === UP) {
      event.preventDefault()
      moveStop(-1)
      return true
    }
    if (direction === FORWARD) {
      event.preventDefault()
      forward()
      return true
    }
    if (direction === BACK) {
      event.preventDefault()
      event.stopPropagation()
      return back()
    }
    if (event.key === 'Escape') {
      if (clearAnyDiffSelection()) {
        event.preventDefault()
        event.stopPropagation()
        return true
      }
      event.preventDefault()
      event.stopPropagation()
      onLeave()
      return 'left'
    }
    return false
  }, [
    back, clearAnyDiffSelection, focusRowElement, focusStop, forward, hunkOffsets, isExpanded, isRowFolded, moveRow, moveStop,
    navRows, onLeave, report, setCursorAt, stageDisabled, syncCursorToScroll, toggle,
  ])

  const onKeyDown = (event: KeyEvent) => {
    runKeyDown(event)
  }

  // Wheel and trackpad scrolling is the user moving the reading position.
  useEffect(() => {
    const root = scrollRef.current
    if (root === null) return undefined
    const markScrolled = () => { lastInputRef.current = 'scroll' }
    root.addEventListener('wheel', markScrolled, { passive: true })
    root.addEventListener('touchmove', markScrolled, { passive: true })
    return () => {
      root.removeEventListener('wheel', markScrolled)
      root.removeEventListener('touchmove', markScrolled)
    }
  }, [])

  const onScroll = () => {
    if (frameRef.current !== 0) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      report()
      if (lastInputRef.current !== 'scroll') return
      syncCursorToScroll()
    })
  }

  // A refresh reloads the node's data; remember the reading row so the same
  // row can be shown again once the new rows arrive.
  useEffect(() => {
    if (!restoredRef.current) return
    const root = scrollRef.current
    const staging = stageSource.current
    stageSource.current = null
    const key = staging?.key ?? readingRef.current
    if (root === null || key === null) return
    const element = rowEls.current.get(key)
    const rowHeadWrap = element === undefined
      ? null
      : findAncestor(element, root, candidate => hasClass(candidate, 'vcs-tree-head'))
    const container = sectionEls.current.get(key) ?? rowHeadWrap
    const active = root.ownerDocument.activeElement
    refreshAnchor.current = {
      key,
      alternate: staging?.alternate,
      hunk: staging?.hunk ?? -1,
      restoreTo: staging?.restoreTo ?? 'row',
      focused: staging !== null && (
        container?.contains?.(active) === true
        || (staging.restoreTo === 'hunk' && active === root.ownerDocument.body)
      ),
      offset: element === undefined ? 0 : Math.max(0, root.scrollTop - flowTop(element)),
      rows,
    }
  }, [revision, flowTop]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const pending = refreshAnchor.current
    if (pending === null || rows === pending.rows) return
    refreshAnchor.current = null
    pendingHunkFocusRef.current = null
    const root = scrollRef.current
    if (root === null) return
    const alternateIndex = pending.alternate === undefined ? undefined : navIndexByKey.get(pending.alternate)
    const index = navIndexByKey.get(pending.key) ?? alternateIndex ?? indexOfKey(pending.key)
    const row = navRows[index < 0 && pending.focused ? 0 : index]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (element !== undefined) {
      root.scrollTop = Math.max(0, flowTop(element) + (row.key === pending.key ? pending.offset : 0))
    }
    report()
    const doc = root.ownerDocument
    const active = doc.activeElement
    // Preserve hunk focus when a hunk write refreshes the same file; async
    // diff reloads finish via `pendingHunkFocusRef` once updated hunks mount.
    if (pending.restoreTo === 'hunk' && pending.hunk >= 0 && row !== undefined && row.key === pending.key) {
      const offsets = row.kind === 'file' && !isRowFolded(row) ? hunkOffsets(row) : []
      pendingHunkFocusRef.current = { key: row.key, hunk: pending.hunk }
      if (offsets.length > 0) {
        const nextHunk = Math.min(pending.hunk, offsets.length - 1)
        setCursorAt(index, nextHunk)
        if (pending.focused || active === doc.body || sectionEls.current.get(row.key)?.contains(active) === true) {
          focusHunkElement(row.key, nextHunk)
        }
        return
      }
    }
    // Focus marks the stop keys act on, so a row or hunk that kept focus
    // through the refresh stays the cursor even when the reading row is another one.
    if (root.contains(active)) {
      const focusedKey = dataValue(active, 'rowKey')
      const focusedIndex = focusedKey === undefined ? undefined : navIndexByKey.get(focusedKey)
      if (focusedIndex !== undefined) {
        setCursorAt(focusedIndex, -1)
        return
      }
      if (hasAttr(active, 'data-diff-hunk-header')) {
        const file = findAncestor(active, root, candidate => candidate?.dataset?.fileKey !== undefined)
        const fileKey = dataValue(file, 'fileKey')
        const fileIndex = fileKey === undefined ? undefined : navIndexByKey.get(fileKey)
        if (fileIndex !== undefined) {
          const fileRow = navRows[fileIndex]
          const focusedHunk = hunkOffsets(fileRow).indexOf(flowTop(active))
          if (focusedHunk >= 0) {
            setCursorAt(fileIndex, focusedHunk)
            return
          }
        }
      }
    }
    const line = root.scrollTop + (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const hunk = row === undefined ? -1 : hunkAtLine(row, line)
    setCursorAt(index >= 0 ? index : 0, hunk)
    if (pending.focused && active === doc.body) {
      if (pending.restoreTo === 'line' && pending.hunk >= 0 && row !== undefined && row.key === pending.key) {
        const offsets = row.kind === 'file' && !isRowFolded(row) ? hunkOffsets(row) : []
        if (offsets.length > 0) {
          const nextHunk = Math.min(pending.hunk, offsets.length - 1)
          setCursorAt(index, nextHunk)
          focusHunkElement(row.key, nextHunk)
          return
        }
      }
      if (row !== undefined) focusRowElement(row.key)
      else root.focus({ preventScroll: true })
    }
  }, [flowTop, focusHunkElement, focusRowElement, grouped, hunkAtLine, hunkOffsets, indexOfKey, isRowFolded, navIndexByKey, navRows, report, rows, setCursorAt])

  // Restore the reading position once the rows exist.
  useLayoutEffect(() => {
    if (restoredRef.current || navRows.length === 0) return
    restoredRef.current = true
    const root = scrollRef.current
    if (root === null || initialAnchor === null) {
      report()
      return
    }
    const index = indexOfKey(initialAnchor.key)
    const row = index < 0 ? undefined : navRows[index]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (element !== undefined) {
      const exact = row?.key === initialAnchor.key
      root.scrollTop = flowTop(element) + (exact ? initialAnchor.offset : 0)
    }
    const line = root.scrollTop + (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const hunk = row === undefined ? -1 : hunkAtLine(row, line)
    setCursorAt(index >= 0 ? index : 0, hunk)
    report()
  }, [flowTop, grouped, hunkAtLine, indexOfKey, initialAnchor, navRows, report, setCursorAt])

  // Rows changed: re-report the reading row so folding never leaves it stale.
  useLayoutEffect(() => {
    report()
  }, [report])

  // The tree's own width can change without the rows changing (window resize).
  useEffect(() => {
    const root = scrollRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { report() })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [report])

  useEffect(() => () => { cancelAnimationFrame(frameRef.current) }, [])

  /** Save the cursor row's screen position, run one change, then restore it. */
  const preserve = useCallback((callback: () => void) => {
    const root = scrollRef.current
    const row = navRows[Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (root === null || element === undefined) {
      pendingPreserve.current = null
    } else {
      const screenTop = typeof element.getBoundingClientRect === 'function' && typeof root.getBoundingClientRect === 'function'
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top
        : flowTop(element) - root.scrollTop
      pendingPreserve.current = { key: row.key, screenTop }
    }
    callback()
  }, [flowTop, navRows])

  useLayoutEffect(() => {
    const pending = pendingPreserve.current
    if (pending === null) return
    pendingPreserve.current = null
    const root = scrollRef.current
    const element = rowEls.current.get(pending.key)
    if (root === null || element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - pending.screenTop)
  })

  // Keep a just-collapsed file head in the slot it held while stuck.
  useLayoutEffect(() => {
    const pending = pendingAlign.current
    if (pending === null) return
    pendingAlign.current = null
    const root = scrollRef.current
    const element = rowEls.current.get(pending.key)
    if (root === null || element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - pending.alignment)
    report()
  })

  /** Expose the tree's focus, keyboard, and bulk-fold hooks to the detail pane. */
  useLayoutEffect(() => {
    control.current = {
      readingAnchor() {
        const anchor = report()
        if (anchor !== undefined) return anchor
        const row = navRows[cursorRef.current.row]
        return row === undefined ? null : { key: row.key, offset: 0 }
      },
      focusReading() {
        if (navRows.length === 0) return false
        const row = Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))
        focusStop(row, cursorRef.current.hunk)
        return true
      },
      restoreFocus,
      handleKeyDown(event: KeyEvent) {
        const root: ElementLike | null = scrollRef.current
        const fromOutside = !root?.contains?.(event.target)
        const result = runKeyDown(event, { fromOutside })
        if (result === false) return false
        if (result !== 'left') {
          const active = typeof document === 'undefined' ? null : document.activeElement
          if (!isNavigationStop(active, scrollRef.current)) restoreFocus()
        }
        return true
      },
      bulkFold(mode: BulkFoldMode) {
        preserve(() => { onBulkFold(mode) })
      },
    }
    return () => { control.current = null }
  }, [control, focusStop, navRows.length, onBulkFold, preserve, report, restoreFocus, runKeyDown])

  /** The click handler every row shares: move the cursor, focus it, and flip the row. */
  const activateRow = (row: NavRow, expanded: boolean) => {
    const index = navIndexByKey.get(row.key)
    if (index !== undefined) setCursorAt(index)
    focusRowElement(row.key)
    toggle(row, expanded)
  }

  /**
   * Run one staging write from a row, hunk, or line selection, keeping the
   * owning row (and hunk stop, when applicable) as the anchor across refresh.
   */
  const runStage = async (
    row: NavRow,
    target: StageRequest,
    alternate: string | undefined,
    { focusRow = false, hunk = -1, restoreTo = 'row' }: { focusRow?: boolean; hunk?: number; restoreTo?: RestoreTo } = {},
  ): Promise<boolean> => {
    const source = { key: row.key, alternate, hunk, restoreTo }
    stageSource.current = source
    const index = navIndexByKey.get(row.key)
    if (index !== undefined) setCursorAt(index, hunk >= 0 ? hunk : -1)
    if (focusRow) focusRowElement(row.key)
    const accepted = await onStage!(target)
    if (!accepted && stageSource.current === source) stageSource.current = null
    return accepted
  }

  /**
   * One row's staging: the writes `s` and `u` run, and the gutter control.
   * Separate groups give each row one direction; merged rows have both.
   */
  const rowStaging = (row: NavRow): RowStaging | null => {
    if (!gutter) return null
    const merged = row.group === 'merged'
    if (row.kind === 'file') {
      const targets = diffTargets(row.group, row.entry, rev)
      const stagedTarget = targets.find(target => target.scope === 'staged')
      const unstagedTarget = targets.find(target => target.scope !== 'staged')
      const primary = unstagedTarget ?? stagedTarget
      const mixed = row.entry.partiallyStaged === true || partiallyStaged?.has(row.entry.path) === true
      const unstaging = primary!.scope === 'staged' && (!merged || !mixed)
      const conflict = !isStageable(row.entry)
      const writable = onStage !== undefined && !conflict
      const alternate = merged ? undefined : counterpartKey(row.key)
      const write = (target: DiffTarget | undefined) => (writable && target !== undefined
        ? () => runStage(row, target, alternate, { focusRow: true })
        : undefined)
      const label = t(mixed
        ? (unstaging ? 'stage.unstageAllFileChanges' : 'stage.stageRemainingFileChanges')
        : (unstaging ? 'stage.unstageFile' : 'stage.stageFile'))
      return {
        merged, mixed, conflict, label: `${label} · ${row.entry.path}`, unstaging,
        stagedWrite: write(stagedTarget),
        primaryWrite: write(primary),
        stage: merged ? write(unstagedTarget) : (unstaging ? undefined : write(primary)),
        unstage: merged ? write(stagedTarget) : (unstaging ? write(primary) : undefined),
        disabled: stageDisabled || !writable || (merged && mixed && unstagedTarget === undefined),
      }
    }
    if (row.kind !== 'dir' && row.kind !== 'group') return null
    const entries = row.entries ?? []
    const write = (direction: StageDirection) => {
      const files = stageFiles(row.group, entries, direction)
      if (onStage === undefined || files.length === 0) return undefined
      const scope = direction === STAGE ? 'unstaged' : 'staged'
      return () => runStage(row, { scope, files }, merged ? undefined : counterpartKey(row.key), { focusRow: true })
    }
    const stage = write(STAGE)
    const unstage = write(UNSTAGE)
    const state = merged ? mergedStageState(entries) : undefined
    const unstaging = merged ? state === true : row.group === 'staged'
    const key = row.kind === 'group'
      ? (unstaging ? 'stage.unstageAll' : 'stage.stageAll')
      : (unstaging ? 'stage.unstageFolder' : 'stage.stageFolder')
    const target = row.kind === 'group' ? '' : ` · ${row.path}`
    return {
      merged, state, unstaging, stage, unstage, label: `${t(key)}${target}`,
      disabled: stageDisabled || (unstaging ? unstage : stage) === undefined,
    }
  }
  stagingRef.current = rowStaging

  /** The keys a row's staging answers to, for assistive technology. */
  const stageKeys = (staging: RowStaging | null) => [staging?.stage === undefined ? null : 's', staging?.unstage === undefined ? null : 'u']
    .filter(key => key !== null).join(' ') || undefined

  /** The gutter cell of one row: a command under separate groups, a tri-state mark when merged. */
  const renderGutter = (row: NavRow, staging: RowStaging | null) => {
    if (!gutter) return null
    let control = null
    if (staging !== null && !(row.kind === 'file' && staging.conflict)) {
      const className = row.kind === 'file' ? 'vcs-stage-file' : 'vcs-stage-folder'
      control = staging.merged
        ? (
          <StageCheckbox
            className={className}
            checked={row.kind === 'file' ? (staging.mixed ? 'mixed' : staging.unstaging) : staging.state}
            disabled={staging.disabled}
            label={staging.label}
            tabIndex={-1}
            onToggle={() => { void (row.kind === 'file' ? staging.primaryWrite : (staging.unstaging ? staging.unstage : staging.stage))?.() }}
          />
        )
        : (
          <StageAction
            className={className}
            direction={staging.unstaging ? UNSTAGE : STAGE}
            partial={row.kind === 'file' && staging.mixed}
            disabled={staging.disabled}
            label={staging.label}
            onRun={() => (staging.unstaging ? staging.unstage : staging.stage)?.()}
          />
        )
    }
    return <span className="vcs-stage-gutter">{control}</span>
  }

  /**
   * The tree level of a directory, file, or loading row, for the stylesheet:
   * the row's content, cursor pill, and open file card all start at its indent.
   * Group rows stay at the tree's root level.
   */
  const levelStyle = (row: DirRow | FileRow | LoadingRow) => ({ '--vcs-level': row.depth + (grouped ? 1 : 0) }) as CSSProperties
  const fileStat = (entry: FileEntry) => {
    if (entry.untracked === true) return null
    if (entry.binary === true) return <span className="vcs-tree-stat vcs-dim">{t('changes.binary')}</span>
    const counts = lineCounts(entry)
    return (
      <span className="vcs-tree-stat">
        {counts.added !== null && counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
        {counts.deleted !== null && counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
      </span>
    )
  }
  const rowProps = (row: NavRow) => ({
    'data-row-key': row.key,
    tabIndex: row.key === cursorKey ? 0 : -1,
    ref: bindRow(row.key),
  })
  const renderLoading = (row: LoadingRow) => (
    <div
      key={`loading:${row.key}`}
      className="vcs-tree-row vcs-tree-loading vcs-skeleton"
      role="status"
      aria-busy="true"
      style={levelStyle(row)}
    >
      <span className="vcs-sr-only">{t('changes.loadingDirectory')}</span>
      <span className="vcs-skeleton-shape vcs-skeleton-glyph" />
      <Bar width={barWidth(row.depth + 2, 0.4)} />
    </div>
  )
  const renderGroup = (row: GroupRow, children: ReactNode) => {
    const bodyId = rowBodyId(row.key)
    const staging = rowStaging(row)
    return (
      <div key={row.key} className="vcs-tree-group">
        <div className="vcs-tree-head vcs-tree-group-head-wrap">
          {renderGutter(row, staging)}
          <button
            type="button"
            className="vcs-tree-row vcs-tree-group-head"
            aria-expanded={row.expanded}
            aria-controls={bodyId}
            aria-current={readingKey === row.key ? 'location' : undefined}
            aria-keyshortcuts={stageKeys(staging)}
            {...rowProps(row)}
            onClick={() => { activateRow(row, row.expanded) }}
          >
            <Chevron open={row.expanded} />
            <span className="vcs-tree-group-name">{t(`changes.${row.group}`)}</span>
            <span className="vcs-tree-spacer" />
            <span className="vcs-tree-stat vcs-dim">{formatPlural(t, 'detail.fileCount', row.count, locale)}</span>
            <span className="vcs-tree-stat">
              <UntrackedStat count={row.untracked} label={t('status.untracked')} locale={locale} />
              {row.added > 0 ? <span className="vcs-add">+{formatCount(row.added, locale)}</span> : null}
              {row.deleted > 0 ? <span className="vcs-del">−{formatCount(row.deleted, locale)}</span> : null}
            </span>
          </button>
        </div>
        <div className="vcs-tree-group-body" id={bodyId}>{children}</div>
      </div>
    )
  }
  const renderDir = (row: DirRow, children: ReactNode) => {
    const bodyId = rowBodyId(row.key)
    const staging = rowStaging(row)
    return (
      <div key={row.key} className="vcs-tree-dir" style={levelStyle(row)}>
        <div className="vcs-tree-head vcs-tree-dir-head-wrap">
          {renderGutter(row, staging)}
          <button
            type="button"
            className="vcs-tree-row vcs-tree-dir-head"
            aria-expanded={row.expanded}
            aria-controls={bodyId}
            aria-current={readingKey === row.key ? 'location' : undefined}
            aria-keyshortcuts={stageKeys(staging)}
            title={row.path}
            {...rowProps(row)}
            onClick={() => { activateRow(row, row.expanded) }}
          >
            <Chevron open={row.expanded} />
            {row.loadable
              ? (
                <>
                  <span className="vcs-status vcs-status-untracked" aria-hidden="true">U</span>
                  <span className="vcs-sr-only">{t('status.untracked')}</span>
                </>
              )
              : null}
            <span className="vcs-tree-dir-name">{row.name}</span>
          </button>
        </div>
        <div className="vcs-tree-dir-body" id={bodyId}>{children}</div>
      </div>
    )
  }
  const renderFile = (row: FileRow) => {
    const expanded = !isRowFolded(row)
    const foldReason = expanded || !someUnfolded ? undefined : budget.get(row.key)
    const parts = splitPath(row.entry.path)
    const bodyId = rowBodyId(row.key)
    const statusClass = row.entry.untracked === true ? 'vcs-status-untracked' : `vcs-status-${row.entry.status}`
    const staging = rowStaging(row)
    // A line or hunk write belongs to the displayed comparison. The Host
    // validates its fingerprint even if newer status now reports a conflict.
    const stage = onStage === undefined ? undefined
      : (target: StageRequest, meta?: StageMeta) => runStage(row, target, row.group === 'merged' ? undefined : counterpartKey(row.key), meta)
    return (
      <section
        key={row.key}
        className="vcs-tree-file"
        data-file-key={row.key}
        data-open={expanded ? 'true' : undefined}
        style={levelStyle(row)}
        ref={bindSection(row.key)}
      >
        <div className="vcs-tree-head vcs-tree-file-head-wrap" data-open={expanded ? 'true' : undefined}>
          {renderGutter(row, staging)}
          <div className="vcs-card-head">
            <button
              type="button"
              className="vcs-tree-row vcs-tree-file-head"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-current={readingKey === row.key ? 'location' : undefined}
              aria-keyshortcuts={stageKeys(staging)}
              title={row.entry.origPath === undefined ? row.path : `${row.entry.origPath} → ${row.path}`}
              {...rowProps(row)}
              onClick={() => { activateRow(row, expanded) }}
            >
              <span className={`vcs-status ${statusClass}`} aria-hidden="true">{row.entry.status}</span>
              <span className="vcs-sr-only">{t(statusKey(row.entry.status, row.entry.untracked === true))}</span>
              <span className="vcs-tree-file-name">
                {row.entry.origPath === undefined
                  ? null
                  : <span className="vcs-dim">{splitPath(row.entry.origPath).base} →</span>}
                <strong>{row.name}</strong>
                {expanded && parts.dir !== '' ? <span className="vcs-tree-parent vcs-dim">{parts.dir}</span> : null}
              </span>
              {fileStat(row.entry)}
            </button>
            {staging?.merged && staging.mixed && staging.stagedWrite !== undefined ? (
              <FileStageMenu path={row.entry.path} disabled={stageDisabled} t={t} onUnstage={() => {
                focusRowElement(row.key)
                void staging.stagedWrite?.()
              }} />
            ) : null}
          </div>
        </div>
        <div className={expanded ? 'vcs-tree-file-body vcs-card-body' : 'vcs-tree-file-body'} id={bodyId} ref={bindBody(row.key)}>
          <FileBody
            fileKey={row.key}
            group={row.group}
            entry={row.entry}
            repo={repo}
            rev={rev}
            near={everyNear || near.get(row.key) === true}
            folded={!expanded}
            foldReason={foldReason}
            request={request}
            revision={revision}
            backgroundDiffRevision={backgroundDiffRevision}
            interacting={activeFiles.has(row.key)}
            onInteractionChange={backgroundDiffRevision === undefined ? undefined : reportInteraction}
            split={split}
            wrap={wrap}
            onStage={stage}
            stageDisabled={stageDisabled}
            onRegisterHunks={registerHunks}
            onRegisterSelectionClear={registerSelectionClear}
            t={t}
            locale={locale}
          />
        </div>
      </section>
    )
  }

  /** Render the flat row list as nested row groups. */
  const renderRows = () => {
    const renderRange = (from: number, to: number): ReactNode[] => {
      const elements: ReactNode[] = []
      let index = from
      while (index < to) {
        const row = rows[index]
        if (row.kind === 'file') {
          elements.push(renderFile(row))
          index += 1
          continue
        }
        if (row.kind === 'loading') {
          elements.push(renderLoading(row))
          index += 1
          continue
        }
        let end = index + 1
        if (row.kind === 'group') {
          while (end < to && rows[end].kind !== 'group') end += 1
        } else {
          while (end < to && rows[end].kind !== 'group' && rows[end].depth > row.depth) end += 1
        }
        const children = renderRange(index + 1, end)
        elements.push(row.kind === 'group' ? renderGroup(row, children) : renderDir(row, children))
        index = end
      }
      return elements
    }
    return renderRange(0, rows.length)
  }

  return (
    <div
      ref={scrollRef}
      className="vcs-tree"
      data-grouped={grouped ? 'true' : undefined}
      data-gutter={gutter ? 'true' : undefined}
      role="region"
      tabIndex={-1}
      aria-label={t('tree.label')}
      data-zone="tree"
      onClick={onTreeClick}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      {holdTree && previous !== null ? previous.before : before}
      {renderRows()}
    </div>
  )
}
