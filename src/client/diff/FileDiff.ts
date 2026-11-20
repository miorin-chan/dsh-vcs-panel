/**
 * Adapted from DSH FileDiff, Copyright (c) 2026 DeepSeek, MIT.
 *
 * Vendored from DeepSeek Harness
 * `@deepseek-ai/dsh-client-ui-deliverables/src/client/FileDiff.tsx` and
 * adapted to the plugin's local `VcsHunk` data contract. The two Harness
 * Client imports were replaced locally so this module stays importable by an
 * external plugin:
 *
 *   - `Button`                                   -> a plain styled <button type="button">
 *   - `languageForPath` + `useCodeHighlighter`   -> ./highlight.js
 *
 * The layout, line numbering, truncation, one-sided fallback, scroll syncing,
 * and state copy behavior follow the original. The module is written without
 * JSX syntax so `node --test` can import the exported pure helpers directly.
 */

import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  UIEvent as ReactUIEvent,
} from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatCount, formatPlural } from '../format.js'
import { findAncestor } from '../keys.js'
import type { ElementLike } from '../keys.js'
import type { CodeToken } from './highlight.js'
import { highlightLines } from './highlight.js'

/** Which comparison one hunk or line came from. */
export type DiffSide = 'staged' | 'unstaged'

/**
 * The scope a rendered comparison belongs to. A single-working-tree diff is
 * `'staged'` or `'unstaged'`; an untracked file is `'untracked'`; a commit
 * detail comparison is `'commit'`. The prop stays `string` because the Host's
 * `DiffTarget.scope` is a string today.
 */
export type StageScope = DiffSide | 'commit' | 'untracked'

/** Where one rendered line may be staged from, in its comparison's coordinates. */
export interface LineOrigin {
  readonly side: DiffSide
  readonly hunk: number
  readonly line: number
}

/** One served hunk: header coordinates and lines keeping their ` `, `+` or `-`. */
export interface VcsHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
  /** Present on each half of a merged comparison, naming its source. */
  side?: DiffSide
  /** Present on merged comparisons, one per line, in line order. */
  origins?: (LineOrigin | null)[]
}

/** A text comparison as the Host serves it. */
export interface VcsTextDiff {
  kind: 'text'
  path: string
  before: boolean
  after: boolean
  hunks: VcsHunk[]
  coarse?: boolean
  lineStaging?: boolean
  fingerprint?: string
  indexOid?: string
}

/** A comparison the Host declines to send in text form. */
export type VcsFileNotice =
  | { kind: 'binary'; path: string }
  | { kind: 'oversized'; path: string }

/** A renderable comparison payload. */
export type VcsFileDiff = VcsTextDiff | VcsFileNotice

/** What `FileDiff` can be asked to render. */
export type FileDiffState = 'loading' | 'missing' | 'error' | VcsFileDiff | undefined

/** One changed line addressed for staging. */
export interface LineRef {
  hunk: number
  line: number
}

/** Where the view should return after a staging write. */
export interface StageMeta {
  hunk: number
  restoreTo: 'hunk' | 'line'
}

/** Write selected lines to the index; resolves to whether the write ran. */
export type StageLines = (fingerprint: string, lines: LineRef[], meta: StageMeta) => boolean | Promise<boolean>

/** One comparison's line-staging writer state. */
export interface StageSource {
  fingerprint: string | undefined
  onStageLines: StageLines | undefined
}

/** One hunk's registered staging actions. */
export interface HunkHandler {
  stage: (() => boolean | Promise<boolean>) | undefined
  unstage: (() => boolean | Promise<boolean>) | undefined
}

/** Report the hunk actions of one rendered comparison. */
export type RegisterHunks = (handlers: (HunkHandler | null)[]) => void

/** Register a clearer for the current line selection, or `null` on unmount. */
export type RegisterSelectionClear = (clear: (() => boolean) | null) => void

/** Report whether the comparison currently holds a selection or native text range. */
export type InteractionChange = (interacting: boolean) => void

/** Opaque identity of the selection this comparison belongs to; compared by reference. */
export type SelectionScope = object

/** One numbered line of a hunk. */
export type HunkRow =
  | { kind: 'del'; old: number; new: undefined; text: string }
  | { kind: 'add'; old: undefined; new: number; text: string }
  | { kind: 'context'; old: number; new: number; text: string }

/** One side cell of a paired split row. */
export interface SplitCell {
  no: number
  text: string
  kind: 'add' | 'del' | 'context'
}

/** One row of the side-by-side view; a side is absent when the other has no peer. */
export interface SplitRow {
  left?: SplitCell
  right?: SplitCell
}

/** The row kind a paired split row reads as. */
export type SplitRowKind = 'del' | 'add' | 'context'

/** A side a rendered line can belong to. */
export type RenderSide = 'left' | 'right' | 'unified'

/** Token runs for one hunk's old and new sides, when highlighting is supported. */
export interface HunkHighlights {
  old: Map<number, CodeToken[]> | undefined
  new: Map<number, CodeToken[]> | undefined
}

/** One staging target collected from a changed line. */
export interface StageTarget {
  origin: LineOrigin
  checked: boolean
  key: string
  hunkPosition: number
  kind: HunkRow['kind']
  number: number
  label: string
}

/** One visual row position holding a staging target. */
export interface OrderedTarget {
  seq: number
  key: string
}

/** Stageable rows per rendered layout. */
export interface OrderedBySide {
  unified: OrderedTarget[]
  left: OrderedTarget[]
  right: OrderedTarget[]
}

/** One hunk's staged-write actions and shortcut hints. */
export interface HunkSpec {
  position: number
  mixed: boolean
  hasStage: boolean
  hasUnstage: boolean
  stageable: boolean
  unstageable: boolean
  stage: (() => Promise<boolean>) | undefined
  unstage: (() => Promise<boolean>) | undefined
  shortcuts: string | undefined
}

/** One hunk header's stage/unstage controls. */
export interface HunkUi {
  keyShortcuts: string | undefined
  node: ReactElement
}

/** One comparison whose fingerprint and writer make a line staging source. */
export type ApplicableStageSource = StageSource & { onStageLines: StageLines; fingerprint: string }

/** The line selection currently shown in the floating bar. */
export interface DiffSelection {
  mode: 'gutter' | 'text'
  side: string
  keys: string[]
  top: number
}

/** An active gutter drag. */
export interface GutterDrag {
  pointerId: number
  side: RenderSide
  startSeq: number
  currentSeq: number
  moved: boolean
}

/** A pointer event that may also arrive as a window blur. */
export interface PointerEndEvent {
  type: string
  pointerId?: number
}

/** Render one line's number cell. */
export type RenderNumber = (
  position: number,
  kind: HunkRow['kind'] | undefined,
  number: number | undefined,
  seq: number,
  side: RenderSide,
) => ReactElement

/** Staging state of one rendered line. */
export type LineState = (
  position: number,
  kind: HunkRow['kind'] | undefined,
  number: number | undefined,
) => 'staged' | 'unstaged' | undefined

/** Whether one rendered line is in the current selection. */
export type IsSelected = (
  position: number,
  kind: HunkRow['kind'] | undefined,
  number: number | undefined,
) => boolean

/** The staging controls for one hunk position. */
export type StageHunk = (position: number) => HunkUi | null

/** The side-by-side view's props. */
export interface SplitColumnsProps {
  hunks: readonly VcsHunk[]
  highlights: readonly HunkHighlights[]
  renderNumber: RenderNumber
  lineState: LineState
  isSelected: IsSelected
  stageHunk: StageHunk
  onHorizontalScroll: (element: HTMLElement | null | undefined) => void
  t: Translate
}

/** The text comparison's props. */
export interface TextDiffProps {
  diff: VcsTextDiff
  split: boolean
  wrap: boolean
  onStageLines?: StageLines | undefined
  /** The comparison's `DiffTarget.scope`. */
  stageScope?: StageScope | undefined
  stageDisabled?: boolean
  stageSources?: Partial<Record<DiffSide, StageSource>> | undefined
  showStageState?: boolean
  onRegisterHunks?: RegisterHunks | undefined
  onRegisterSelectionClear?: RegisterSelectionClear | undefined
  onInteractionChange?: InteractionChange | undefined
  selectionScope?: SelectionScope
  t: Translate
  locale?: string
}

/** The file comparison view's props. */
export interface FileDiffProps {
  state: FileDiffState
  split: boolean
  wrap: boolean
  retry: () => void
  onStageLines?: StageLines | undefined
  /** The comparison's `DiffTarget.scope`. */
  stageScope?: StageScope | undefined
  stageDisabled?: boolean
  stageSources?: Partial<Record<DiffSide, StageSource>> | undefined
  showStageState?: boolean
  onRegisterHunks?: RegisterHunks | undefined
  onRegisterSelectionClear?: RegisterSelectionClear | undefined
  onInteractionChange?: InteractionChange | undefined
  selectionScope?: SelectionScope
  t: Translate
  locale?: string
}

/** Maximum rendered lines per comparison. */
export const MAX_RENDERED_LINES = 5000

/** Delay (ms) before hiding the horizontal scrollbar thumb after scrolling stops. */
const HSCROLL_IDLE_MS = 900

/**
 * Number a hunk's lines: context lines count on both sides, deletions on the
 * old side, additions on the new side.
 * @param hunk - a served hunk.
 * @returns the rows in order.
 */
export function hunkRows(hunk: VcsHunk): HunkRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line): HunkRow => {
    const text = line.slice(1)
    switch (line[0]) {
      case '+': return { kind: 'add', old: undefined, new: newNo++, text }
      case '-': return { kind: 'del', old: oldNo++, new: undefined, text }
      default: return { kind: 'context', old: oldNo++, new: newNo++, text }
    }
  })
}

/**
 * Pair a hunk's lines for the side-by-side view: each run of deletions is
 * aligned with the run of additions that follows it, row by row, and context
 * lines sit on both sides.
 * @param hunk - a served hunk.
 * @returns the rows in order.
 */
export function splitRows(hunk: VcsHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: SplitCell[] = []
  let adds: SplitCell[] = []
  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left: SplitCell | undefined = dels[at]
      const right: SplitCell | undefined = adds[at]
      rows.push({ ...left === undefined ? {} : { left }, ...right === undefined ? {} : { right } })
    }
    dels = []
    adds = []
  }
  for (const row of hunkRows(hunk)) {
    if (row.kind === 'del') dels.push({ no: row.old, text: row.text, kind: 'del' })
    else if (row.kind === 'add') adds.push({ no: row.new, text: row.text, kind: 'add' })
    else {
      flush()
      rows.push({ left: { no: row.old, text: row.text, kind: 'context' }, right: { no: row.new, text: row.text, kind: 'context' } })
    }
  }
  flush()
  return rows
}

/**
 * The hunks to draw, cut at {@link MAX_RENDERED_LINES} lines in total.
 * @param hunks - served hunks.
 * @returns the hunks with the last one shortened as needed, and whether anything was cut.
 */
export function renderedHunks(hunks: readonly VcsHunk[]): { hunks: VcsHunk[]; truncated: boolean } {
  let budget = MAX_RENDERED_LINES
  const kept: VcsHunk[] = []
  for (const hunk of hunks) {
    if (budget === 0) return { hunks: kept, truncated: true }
    kept.push(hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) })
    budget -= Math.min(budget, hunk.lines.length)
  }
  return { hunks: kept, truncated: hunks.some((hunk, at) => kept[at] !== hunk) }
}

/**
 * Whether a text comparison only adds or only removes lines.
 * Such comparisons render one column even when split was requested, matching
 * the original component.
 * @param diff - a text comparison.
 * @returns true when exactly one of additions/deletions is present.
 */
export function isOneSided(diff: VcsTextDiff): boolean {
  const hasAdditions = diff.hunks.some(hunk => hunk.lines.some(line => line.startsWith('+')))
  const hasDeletions = diff.hunks.some(hunk => hunk.lines.some(line => line.startsWith('-')))
  return hasAdditions !== hasDeletions
}

/** The one-line fact about a text comparison worth stating above its hunks, if any. */
function noteOf(diff: VcsTextDiff): string | undefined {
  if (!diff.before) return 'diff.created'
  if (!diff.after) return 'diff.deleted'
  if (diff.hunks.length === 0) return 'diff.unchanged'
  return undefined
}

/** Theme class for a token kind; kinds are colored by FileDiff.css via Shiki variables. */
const HIGHLIGHT_CLASS: Readonly<Record<string, string>> = {
  keyword: 'vcs-hl-keyword',
  string: 'vcs-hl-string',
  number: 'vcs-hl-number',
  comment: 'vcs-hl-comment',
  function: 'vcs-hl-function',
  parameter: 'vcs-hl-parameter',
  constant: 'vcs-hl-constant',
  punctuation: 'vcs-hl-punctuation',
  link: 'vcs-hl-link',
}

/** One line of highlighted text: a plain text node, or token spans. */
function DiffText({ text, spans }: { text: string; spans: CodeToken[] | undefined }) {
  if (spans === undefined) {
    return h('span', { className: 'vcs-diff-text' }, text)
  }
  return h('span', { className: 'vcs-diff-text', 'data-diff-code': '' },
    spans.map((span, index) => h('span', {
      key: index,
      className: span.kind === undefined ? undefined : HIGHLIGHT_CLASS[span.kind],
    }, span.text)))
}

/** A hunk's header line. */
function hunkHeader(hunk: VcsHunk, t: Translate): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return hunk.side === undefined ? range : `${t(`changes.${hunk.side}`)}  ${range}`
}

/** Plus or minus glyph for the line-number staging hover button. */
function lineStageGlyph(direction: 'stage' | 'unstage') {
  return h('svg', {
    className: 'vcs-diff-line-stage-icon',
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'aria-hidden': 'true',
  }, h('path', {
    d: direction === 'stage' ? 'M8 3.5v9M3.5 8h9' : 'M3.5 8h9',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
  }))
}

function renderHunkHeader(label: string, actions: ReactNode, keyShortcuts: string | undefined) {
  return h('div', {
    className: 'vcs-diff-hunk-header',
    'data-diff-hunk-header': '',
    'aria-keyshortcuts': keyShortcuts,
    tabIndex: -1,
  },
  h('span', { className: 'vcs-diff-hunk-range' }, label),
  actions)
}

/**
 * Highlight one side of a hunk, keyed by line number.
 * The highlighter returns one token run per input line; empty terminal rows
 * stay aligned because the input lines are exactly the side's numbered rows.
 */
function highlightedSide(rows: readonly HunkRow[], side: 'old' | 'new', path: string): Map<number, CodeToken[]> | undefined {
  const source = rows.flatMap((row): { no: number; text: string }[] => {
    const no = row[side]
    return no === undefined ? [] : [{ no, text: row.text }]
  })
  if (source.length === 0) return new Map<number, CodeToken[]>()
  const highlighted = highlightLines(path, source.map(line => line.text))
  if (highlighted === undefined) return undefined
  return new Map(source.map((line, index): [number, CodeToken[]] => [line.no, highlighted[index] ?? []]))
}

/** Old- and new-side token runs for one hunk. */
function hunkHighlights(hunk: VcsHunk, path: string): HunkHighlights {
  const rows = hunkRows(hunk)
  return { old: highlightedSide(rows, 'old', path), new: highlightedSide(rows, 'new', path) }
}

/** The kind a paired row carries: a deletion or addition on either side, otherwise context. */
function splitRowKind(row: SplitRow): SplitRowKind {
  if (row.left?.kind === 'del') return 'del'
  if (row.right?.kind === 'add') return 'add'
  return 'context'
}

/** Class list for one side cell of a split row. */
function cellClass(cell: SplitCell | undefined): string {
  return cell === undefined ? 'vcs-diff-cell vcs-diff-empty' : `vcs-diff-cell vcs-diff-${cell.kind}`
}

/** Mark one scroll container as horizontally scrolling until idle, without React rerenders. */
function useHorizontalScrollFlag(): (element: HTMLElement | null | undefined) => void {
  const timers = useRef(new Map<HTMLElement, ReturnType<typeof setTimeout>>())
  const lastLeft = useRef(new WeakMap<HTMLElement, number>())
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])
  return useCallback((element: HTMLElement | null | undefined): void => {
    if (element === null || element === undefined) return
    const left = element.scrollLeft ?? 0
    const previous = lastLeft.current.get(element) ?? 0
    if (left === previous) return
    lastLeft.current.set(element, left)
    if (element.dataset !== undefined) element.dataset.hScrolling = 'true'
    const existing = timers.current.get(element)
    if (existing !== undefined) clearTimeout(existing)
    timers.current.set(element, setTimeout(() => {
      timers.current.delete(element)
      if (element.dataset !== undefined) delete element.dataset.hScrolling
    }, HSCROLL_IDLE_MS))
  }, [])
}

/**
 * The side-by-side view without wrapping: two columns that clip their long
 * lines and scroll together on both axes, so a long line on one side never
 * runs under the other and both sides show the same rows and columns of text.
 * Every line is one fixed-height row, which keeps the sides aligned.
 */
function SplitColumns({
  hunks, highlights, renderNumber, lineState, isSelected, stageHunk, onHorizontalScroll, t,
}: SplitColumnsProps) {
  const paired = useMemo(() => hunks.map(hunk => ({ header: hunkHeader(hunk, t), rows: splitRows(hunk) })), [hunks, t])
  const columns = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({ left: null, right: null })
  const offsets = useRef({ left: { scrollLeft: 0, scrollTop: 0 }, right: { scrollLeft: 0, scrollTop: 0 } })
  const follow = (side: 'left' | 'right') => (event: ReactUIEvent<HTMLDivElement>) => {
    const current = event.currentTarget
    onHorizontalScroll(current)
    const peer = side === 'left' ? 'right' : 'left'
    const other = columns.current[peer]
    if (other === null) return
    for (const axis of ['scrollLeft', 'scrollTop'] as const) {
      const value = current[axis]
      if (offsets.current[side][axis] === value) continue
      offsets.current[side][axis] = value
      other[axis] = value
      // Record the browser-clamped offset so its scroll event cannot pull the source back.
      offsets.current[peer][axis] = other[axis]
      if (axis === 'scrollLeft') onHorizontalScroll(other)
    }
  }
  const rowBaseByHunk = useMemo(() => {
    const bases: number[] = []
    let count = 0
    for (const hunk of paired) {
      bases.push(count)
      count += hunk.rows.length
    }
    return bases
  }, [paired])
  return h('div', { className: 'vcs-diff-columns' },
    (['left', 'right'] as const).map(side => h('div', {
      key: side,
      className: 'vcs-diff-column',
      'data-diff-side': side,
      ref: (element: HTMLDivElement | null): void => { columns.current[side] = element },
      onScroll: follow(side),
    },
    paired.map((hunk, position) => {
      const hunkUi = side === 'left' ? stageHunk(position) : null
      return h('section', { key: position, className: 'vcs-diff-hunk' },
        renderHunkHeader(hunk.header, hunkUi?.node ?? null, hunkUi?.keyShortcuts),
        hunk.rows.map((row, at) => {
          const cell = row[side]
          const seq = rowBaseByHunk[position] + at
          const spans = cell === undefined ? undefined : highlights[position]?.[side === 'left' ? 'old' : 'new']?.get(cell.no)
          const stateAttr = lineState(position, cell?.kind, cell?.no)
          const selected = isSelected(position, cell?.kind, cell?.no)
          return h('div', {
            key: at,
            className: `vcs-diff-side-line ${cell === undefined ? 'vcs-diff-empty' : `vcs-diff-${cell.kind}`}`,
            'data-diff-line': splitRowKind(row),
            'data-diff-row-seq': seq,
            'data-diff-side': side,
            'data-stage-state': stateAttr,
            'data-line-selected': selected ? '' : undefined,
          },
          renderNumber(position, cell?.kind, cell?.no, seq, side),
          h(DiffText, { text: cell?.text ?? '', spans }))
        }))
    })))
  )
}

function plainNumber(number: number | undefined, seq: number, side: RenderSide) {
  return h('span', {
    className: 'vcs-diff-number',
    'data-stage-row-seq': seq,
    'data-stage-side': side,
  }, number ?? '')
}

/**
 * Compute the floating bar's vertical offset relative to the diff root.
 * @param root - `.vcs-diff-root`.
 * @param anchor - last selected row element.
 * @returns top offset in pixels.
 */
function floatingTop(root: HTMLElement | null, anchor: Element | null): number {
  if (root === null || anchor === null) return 8
  if (typeof root.getBoundingClientRect !== 'function' || typeof anchor.getBoundingClientRect !== 'function') return 8
  const rootRect = root.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const below = anchorRect.bottom - rootRect.top + 4
  const maxTop = Math.max(8, (root.clientHeight || rootRect.height || 0) - 34)
  if (below <= maxTop) return Math.max(8, below)
  const above = anchorRect.top - rootRect.top - 32
  return Math.max(8, Math.min(maxTop, above))
}

/** A noncollapsed browser selection that uses any text in this comparison. */
function nativeDiffSelection(body: HTMLElement | null): Selection | null {
  if (body === null) return null
  const selection = body.ownerDocument?.getSelection?.() ?? globalThis.window?.getSelection?.()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode?.(body)) return selection
  }
  return null
}

/**
 * The hunks of a text comparison with their line numbers, unified or side by side.
 */
function TextDiff({
  diff, split, wrap, onStageLines, stageScope, stageDisabled, stageSources, showStageState,
  onRegisterHunks, onRegisterSelectionClear, onInteractionChange, selectionScope, t, locale,
}: TextDiffProps) {
  const note = noteOf(diff)
  const { hunks, truncated } = useMemo(() => renderedHunks(diff.hunks), [diff.hunks])
  const highlights = useMemo(() => hunks.map(hunk => hunkHighlights(hunk, diff.path)), [hunks, diff.path])
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const onHorizontalScroll = useHorizontalScrollFlag()
  const [selection, setSelection] = useState<DiffSelection | null>(null) // { mode: 'gutter' | 'text', side, keys: string[], top: number }
  const dragRef = useRef<GutterDrag | null>(null)
  const gutterReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAnchorRef = useRef<{ side: string; seq: number } | null>(null) // { side, seq }
  const suppressClickRef = useRef(false)
  const selectingSideRef = useRef<string | null>(null)
  const textPointerRef = useRef<number | null>(null)
  const selectionRef = useRef<DiffSelection | null>(null)
  const pendingWritesRef = useRef(new Set<object>())
  const interactionRef = useRef(false)

  const reportInteraction = useCallback(() => {
    if (onInteractionChange === undefined) return
    const body = bodyRef.current
    const active = body !== null && (dragRef.current !== null || gutterReleaseRef.current !== null
      || textPointerRef.current !== null || selectionRef.current !== null || pendingWritesRef.current.size > 0
      || nativeDiffSelection(body) !== null)
    if (active === interactionRef.current) return
    interactionRef.current = active
    onInteractionChange(active)
  }, [onInteractionChange])

  const canStage = showStageState || (!truncated && diff.lineStaging === true
    && typeof diff.fingerprint === 'string' && typeof onStageLines === 'function')

  const { stageTargets, targetByKey, orderedBySide } = useMemo((): {
    stageTargets: Map<string, StageTarget>[]
    targetByKey: Map<string, StageTarget>
    orderedBySide: OrderedBySide
  } => {
    const byKey = new Map<string, StageTarget>()
    const bySide: OrderedBySide = { unified: [], left: [], right: [] }
    if (!canStage) return { stageTargets: [], targetByKey: byKey, orderedBySide: bySide }
    const maps = hunks.map((hunk, position) => {
      const targets = new Map<string, StageTarget>()
      hunkRows(hunk).forEach((row, line) => {
        if (row.kind === 'context') return
        // The fallback side only feeds the staged/unstaged check; untracked and
        // commit comparisons never expose staging targets, so the wider scope
        // narrows here without changing which lines can be written.
        const origin: LineOrigin = hunk.origins?.[line] ?? { side: stageScope as DiffSide, hunk: position, line }
        const checked = origin.side === 'staged'
        const action = t(checked ? 'stage.unstageLine' : 'stage.stageLine')
        const added = row.kind === 'add'
        const number = row.kind === 'add' ? row.new : row.old
        const description = t(added ? 'stage.addedLine' : 'stage.deletedLine', { number: formatCount(number, locale) })
        const key = `${position}:${line}`
        const item: StageTarget = {
          origin, checked, key, hunkPosition: position, kind: row.kind, number,
          label: `${action} · ${description}`,
        }
        targets.set(`${row.kind}:${number}`, item)
        byKey.set(key, item)
      })
      return targets
    })
    // Map visual row sequences per side so gutter drag and Shift+Click select contiguous lines cleanly.
    let unifiedSeq = 0
    let splitSeq = 0
    hunks.forEach((hunk, position) => {
      const targets = maps[position]
      hunkRows(hunk).forEach(row => {
        const number = row.kind === 'add' ? row.new : row.old
        const target = row.kind === 'context' ? undefined : targets.get(`${row.kind}:${number}`)
        if (target !== undefined) bySide.unified.push({ seq: unifiedSeq, key: target.key })
        unifiedSeq += 1
      })
      splitRows(hunk).forEach(row => {
        for (const side of ['left', 'right'] as const) {
          const cell = row[side]
          if (cell !== undefined && cell.kind !== 'context') {
            const target = targets.get(`${cell.kind}:${cell.no}`)
            if (target !== undefined) bySide[side].push({ seq: splitSeq, key: target.key })
          }
        }
        splitSeq += 1
      })
    })
    return { stageTargets: maps, targetByKey: byKey, orderedBySide: bySide }
  }, [canStage, hunks, locale, stageScope, t])

  // Scope changes and explicit refreshes end a selection before it can act
  // on a different comparison. Equal background payloads keep `diff` stable.
  useLayoutEffect(() => {
    const body = bodyRef.current
    setSelection(null)
    dragRef.current = null
    textPointerRef.current = null
    selectingSideRef.current = null
    lastAnchorRef.current = null
    selectionRef.current = null
    pendingWritesRef.current = new Set<object>()
    if (body !== null) delete body.dataset.selectingSide
    return () => {
      clearTimeout(gutterReleaseRef.current ?? undefined)
      gutterReleaseRef.current = null
      suppressClickRef.current = false
      if (interactionRef.current) onInteractionChange?.(false)
      interactionRef.current = false
      nativeDiffSelection(body)?.removeAllRanges()
    }
  }, [diff, split, wrap, selectionScope, onInteractionChange])

  useLayoutEffect(() => {
    selectionRef.current = selection
    reportInteraction()
  }, [selection, reportInteraction])

  const clearSelection = useCallback(() => {
    const native = nativeDiffSelection(bodyRef.current)
    if (selection === null && native === null && dragRef.current === null) return false
    setSelection(null)
    dragRef.current = null
    native?.removeAllRanges()
    reportInteraction()
    return true
  }, [selection, reportInteraction])

  useLayoutEffect(() => {
    if (onRegisterSelectionClear === undefined) return undefined
    onRegisterSelectionClear(clearSelection)
    return () => { onRegisterSelectionClear(null) }
  }, [clearSelection, onRegisterSelectionClear])

  // Allow Escape to clear a diff line selection even if focus is outside the tree.
  useEffect(() => {
    if (selection === null || typeof window === 'undefined') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const body = bodyRef.current
      if (body !== null) {
        const tree = findAncestor(body, null, (node: ElementLike) => node?.dataset?.zone === 'tree')
        if (tree !== null && tree.contains?.(event.target)) return
      }
      event.preventDefault()
      clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [clearSelection, selection])

  const sourceFor = useCallback((side: DiffSide): StageSource | undefined => {
    if (stageSources !== undefined) return stageSources[side]
    return { onStageLines, fingerprint: diff.lineStaging === true ? diff.fingerprint : undefined }
  }, [diff.fingerprint, diff.lineStaging, onStageLines, stageSources])

  const canApply = useCallback((source: StageSource | undefined): source is ApplicableStageSource => !stageDisabled && !truncated
    && typeof source?.onStageLines === 'function' && typeof source?.fingerprint === 'string', [stageDisabled, truncated])

  const applyChanges = useCallback(async (source: StageSource | undefined, lines: LineRef[], meta: StageMeta): Promise<boolean> => {
    if (!canApply(source) || lines.length === 0) return false
    const pendingWrites = pendingWritesRef.current
    const write: object = {}
    pendingWrites.add(write)
    reportInteraction()
    try {
      return await source.onStageLines(source.fingerprint, lines, meta)
    } finally {
      pendingWrites.delete(write)
      reportInteraction()
    }
  }, [canApply, reportInteraction])

  const hunkSpecs = useMemo((): (HunkSpec | null)[] => hunks.map((_, position) => {
    const targets = stageTargets[position]
    if (targets === undefined || targets.size === 0) return null
    const changes = [...targets.values()]
    const unstaged = changes.filter(change => !change.checked)
    const staged = changes.filter(change => change.checked)
    const stageSource = unstaged.length > 0 ? sourceFor(unstaged[0].origin.side) : undefined
    const unstageSource = staged.length > 0 ? sourceFor(staged[0].origin.side) : undefined
    const stageable = unstaged.length > 0 && canApply(stageSource)
    const unstageable = staged.length > 0 && canApply(unstageSource)
    const stageLinesPayload = unstaged.map(({ origin }): LineRef => ({ hunk: origin.hunk, line: origin.line }))
    const unstageLinesPayload = staged.map(({ origin }): LineRef => ({ hunk: origin.hunk, line: origin.line }))
    const meta: StageMeta = { hunk: position, restoreTo: 'hunk' }
    const stage = unstaged.length > 0
      ? () => applyChanges(stageSource, stageLinesPayload, meta)
      : undefined
    const unstage = staged.length > 0
      ? () => applyChanges(unstageSource, unstageLinesPayload, meta)
      : undefined
    const mixed = unstaged.length > 0 && staged.length > 0
    const shortcuts = [stageable ? 's' : null, unstageable ? 'u' : null].filter(Boolean).join(' ') || undefined
    return {
      position,
      mixed,
      hasStage: unstaged.length > 0,
      hasUnstage: staged.length > 0,
      stageable,
      unstageable,
      stage,
      unstage,
      shortcuts,
    }
  }), [applyChanges, canApply, hunks, sourceFor, stageTargets])

  // Expose hunk-level s / u handlers to ChangeTree without DOM scraping.
  useLayoutEffect(() => {
    if (onRegisterHunks === undefined) return undefined
    onRegisterHunks(hunkSpecs.map(spec => (spec === null
      ? null
      : {
        stage: spec.hasStage ? spec.stage : undefined,
        unstage: spec.hasUnstage ? spec.unstage : undefined,
      })))
    return () => { onRegisterHunks([]) }
  }, [hunkSpecs, onRegisterHunks])

  const stageHunk = (position: number): HunkUi | null => {
    const spec = hunkSpecs[position]
    if (spec === null || spec === undefined) return null
    const number = formatCount(position + 1, locale)
    const buttons: ReactElement[] = []
    if (spec.hasStage) {
      const label = t(spec.mixed ? 'stage.stageRemainingHunk' : 'stage.stageHunk', { number })
      const text = t(spec.mixed ? 'stage.stageRemainingHunkButton' : 'stage.stageHunkButton')
      buttons.push(h('button', {
        key: 'stage',
        type: 'button',
        className: 'vcs-diff-hunk-btn',
        tabIndex: -1,
        'data-stage-hunk': position,
        'data-stage-direction': 'stage',
        'aria-label': label,
        'aria-disabled': !spec.stageable ? 'true' : undefined,
        title: label,
        onMouseDown: (event: ReactMouseEvent) => { event.preventDefault() },
        onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() },
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation()
          if (spec.stageable) void spec.stage?.()
        },
      }, text))
    }
    if (spec.hasUnstage) {
      const label = t('stage.unstageHunk', { number })
      const text = t('stage.unstageHunkButton')
      buttons.push(h('button', {
        key: 'unstage',
        type: 'button',
        className: 'vcs-diff-hunk-btn',
        tabIndex: -1,
        'data-stage-hunk': position,
        'data-stage-direction': 'unstage',
        'aria-label': label,
        'aria-disabled': !spec.unstageable ? 'true' : undefined,
        title: label,
        onMouseDown: (event: ReactMouseEvent) => { event.preventDefault() },
        onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() },
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation()
          if (spec.unstageable) void spec.unstage?.()
        },
      }, text))
    }
    if (buttons.length === 0) return null
    return {
      keyShortcuts: spec.shortcuts,
      node: h('span', { className: 'vcs-diff-hunk-actions' }, buttons),
    }
  }

  /** Collect all stageable keys between two visual row indices on one side. */
  const keysInRange = useCallback((side: RenderSide, startSeq: number, endSeq: number): string[] => {
    const low = Math.min(startSeq, endSeq)
    const high = Math.max(startSeq, endSeq)
    const list = orderedBySide[side] ?? []
    return list.filter(entry => entry.seq >= low && entry.seq <= high).map(entry => entry.key)
  }, [orderedBySide])

  /** Find the DOM element for one visual row so the floating bar aligns near it. */
  const rowElementFor = useCallback((side: RenderSide, seq: number): Element | null => {
    const body = bodyRef.current
    if (body === null) return null
    return body.querySelector(`[data-diff-row-seq="${seq}"][data-diff-side="${side}"]`)
      ?? body.querySelector(`[data-diff-row-seq="${seq}"]`)
  }, [])

  const applyGutterRange = useCallback((side: RenderSide, startSeq: number, endSeq: number): void => {
    const keys = keysInRange(side, startSeq, endSeq)
    if (keys.length === 0) {
      setSelection(null)
      return
    }
    const anchorEl = rowElementFor(side, Math.max(startSeq, endSeq))
    setSelection({ mode: 'gutter', side, keys, top: floatingTop(rootRef.current, anchorEl) })
  }, [keysInRange, rowElementFor])

  // Track active gutter drag until pointerup on window.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || event.pointerId !== drag.pointerId) return
      const doc = bodyRef.current?.ownerDocument
      const hit = doc?.elementFromPoint?.(event.clientX, event.clientY)
      const cell = hit === null || hit === undefined
        ? null
        : findAncestor(hit, bodyRef.current, (node: ElementLike) => node?.dataset?.stageRowSeq !== undefined)
      if (cell === null) return
      if (cell.dataset?.stageSide !== drag.side) return
      const seq = Number(cell.dataset?.stageRowSeq)
      if (!Number.isFinite(seq) || seq === drag.currentSeq) return
      drag.currentSeq = seq
      drag.moved = true
      applyGutterRange(drag.side, drag.startSeq, seq)
    }
    const onPointerUp = (event: PointerEndEvent): void => {
      const drag = dragRef.current
      if (drag === null || (event.type !== 'blur' && event.pointerId !== drag.pointerId)) return
      dragRef.current = null
      if (drag.moved) {
        suppressClickRef.current = true
        lastAnchorRef.current = { side: drag.side, seq: drag.currentSeq }
      }
      // Keep the original line under the pointer until its click can dispatch.
      clearTimeout(gutterReleaseRef.current ?? undefined)
      gutterReleaseRef.current = setTimeout(() => {
        gutterReleaseRef.current = null
        suppressClickRef.current = false
        reportInteraction()
      }, 0)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('blur', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('blur', onPointerUp)
    }
  }, [applyGutterRange, reportInteraction])

  // Inspect native browser text selection for multi-line code drag staging (without disturbing copy).
  const syncTextSelection = useCallback((): void => {
    const body = bodyRef.current
    if (body === null || !canStage || typeof window === 'undefined') return
    const native = window.getSelection?.()
    if (native === null || native === undefined || native.isCollapsed || native.rangeCount === 0) {
      setSelection(prev => (prev?.mode === 'text' ? null : prev))
      return
    }
    const range = native.getRangeAt(0)
    const startInside = body.contains?.(range.startContainer)
    const endInside = body.contains?.(range.endContainer)
    if (!startInside || !endInside) {
      setSelection(prev => (prev?.mode === 'text' ? null : prev))
      return
    }
    const startRowEl = findAncestor(
      range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement,
      body,
      (node: ElementLike) => node?.dataset?.diffRowSeq !== undefined,
    )
    const activeSide = selectingSideRef.current ?? startRowEl?.dataset?.diffSide ?? 'unified'
    const rowNodes = Array.from(body.querySelectorAll<HTMLElement>('[data-diff-row-seq]'))
    const intersected: HTMLElement[] = []
    for (const node of rowNodes) {
      if (split && node.dataset?.diffSide !== activeSide) continue
      if (typeof range.intersectsNode === 'function' && !range.intersectsNode(node)) continue
      intersected.push(node)
    }
    // Single-line word selection (e.g. double-click to copy an identifier) does not show a popup.
    if (intersected.length < 2) {
      setSelection(prev => (prev?.mode === 'text' ? null : prev))
      return
    }
    const keys = []
    const seen = new Set()
    for (const node of intersected) {
      const btn = node.querySelector?.<HTMLElement>('[data-stage-line]')
      const key = btn?.dataset?.stageLine
      if (key === undefined || seen.has(key) || !targetByKey.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
    if (keys.length === 0) {
      setSelection(prev => (prev?.mode === 'text' ? null : prev))
      return
    }
    const anchorEl = intersected.at(-1) ?? null
    setSelection({ mode: 'text', side: activeSide, keys, top: floatingTop(rootRef.current, anchorEl) })
  }, [canStage, split, targetByKey])

  useEffect(() => {
    const doc = bodyRef.current?.ownerDocument
    const view = doc?.defaultView ?? globalThis.window
    if (!view || (!canStage && onInteractionChange === undefined)) return undefined
    const onSelectionChange = () => {
      if (dragRef.current !== null) return
      if (selectionRef.current?.mode === 'text' && nativeDiffSelection(bodyRef.current) === null) {
        setSelection(previous => (previous?.mode === 'text' ? null : previous))
      }
      reportInteraction()
    }
    const onWindowPointerUp = (event: PointerEndEvent): void => {
      if (textPointerRef.current !== null && event.type !== 'blur' && event.pointerId !== textPointerRef.current) return
      if (bodyRef.current !== null) delete bodyRef.current.dataset.selectingSide
      if (event.type === 'pointerup') syncTextSelection()
      selectingSideRef.current = null
      textPointerRef.current = null
      reportInteraction()
    }
    doc?.addEventListener('selectionchange', onSelectionChange)
    view.addEventListener('pointerup', onWindowPointerUp)
    view.addEventListener('pointercancel', onWindowPointerUp)
    view.addEventListener('blur', onWindowPointerUp)
    return () => {
      doc?.removeEventListener('selectionchange', onSelectionChange)
      view.removeEventListener('pointerup', onWindowPointerUp)
      view.removeEventListener('pointercancel', onWindowPointerUp)
      view.removeEventListener('blur', onWindowPointerUp)
    }
  }, [canStage, onInteractionChange, reportInteraction, syncTextSelection])

  const handleNumberPointerDown = (event: ReactPointerEvent<HTMLSpanElement>, target: StageTarget, seq: number, side: RenderSide): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const source = sourceFor(target.origin.side)
    if (!canApply(source)) return
    nativeDiffSelection(bodyRef.current)?.removeAllRanges()
    if (event.shiftKey && lastAnchorRef.current !== null && lastAnchorRef.current.side === side) {
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 0)
      applyGutterRange(side, lastAnchorRef.current.seq, seq)
      return
    }
    if (event.pointerType === 'touch') {
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 0)
      setSelection(prev => {
        const nextSet = new Set(prev?.mode === 'gutter' && prev.side === side ? prev.keys : [])
        if (nextSet.has(target.key)) nextSet.delete(target.key)
        else nextSet.add(target.key)
        if (nextSet.size === 0) return null
        const keys = (orderedBySide[side] ?? []).map(item => item.key).filter(key => nextSet.has(key))
        const anchorEl = rowElementFor(side, seq)
        return { mode: 'gutter', side, keys, top: floatingTop(rootRef.current, anchorEl) }
      })
      lastAnchorRef.current = { side, seq }
      return
    }
    dragRef.current = { pointerId: event.pointerId, side, startSeq: seq, currentSeq: seq, moved: false }
    reportInteraction()
  }

  const handleNumberPointerEnter = (seq: number, side: RenderSide): void => {
    const drag = dragRef.current
    if (drag === null || drag.side !== side || seq === drag.currentSeq) return
    drag.currentSeq = seq
    drag.moved = true
    applyGutterRange(side, drag.startSeq, seq)
  }

  const handleLineButtonClick = (event: ReactMouseEvent<HTMLButtonElement>, target: StageTarget, seq: number, side: RenderSide): void => {
    event.stopPropagation()
    if (suppressClickRef.current) return
    const source = sourceFor(target.origin.side)
    if (!canApply(source)) return
    if (event.shiftKey && lastAnchorRef.current !== null && lastAnchorRef.current.side === side) {
      applyGutterRange(side, lastAnchorRef.current.seq, seq)
      return
    }
    lastAnchorRef.current = { side, seq }
    setSelection(null)
    void applyChanges(source, [{ hunk: target.origin.hunk, line: target.origin.line }], {
      hunk: target.hunkPosition,
      restoreTo: 'line',
    })
  }

  const handleBodyPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (findAncestor(target, bodyRef.current, (node: ElementLike) => node?.classList?.contains?.('vcs-diff-selection-bar') === true)) return
    if (findAncestor(target, bodyRef.current, (node: ElementLike) => node?.dataset?.lineStageable !== undefined)) return
    if (selection?.mode === 'gutter') setSelection(null)
    if (onInteractionChange !== undefined && event.button === 0
      && findAncestor(target, bodyRef.current, (node: ElementLike) => node?.dataset?.diffRowSeq !== undefined) !== null) {
      textPointerRef.current = event.pointerId
      reportInteraction()
    }
    if (split) {
      const cell = findAncestor(target, bodyRef.current, (node: ElementLike) => node?.dataset?.diffSide !== undefined)
      const side = cell?.dataset?.diffSide ?? null
      selectingSideRef.current = side
      if (wrap && side !== null && bodyRef.current?.dataset !== undefined) {
        bodyRef.current.dataset.selectingSide = side
      }
    }
  }

  const selectedSet = useMemo(() => new Set(selection?.keys ?? []), [selection])

  const lineState: LineState = (position, kind, number) => {
    if (!showStageState || kind === undefined || kind === 'context') return undefined
    const target = stageTargets[position]?.get(`${kind}:${number}`)
    if (target === undefined) return undefined
    return target.checked ? 'staged' : 'unstaged'
  }

  const isSelected: IsSelected = (position, kind, number) => {
    if (selectedSet.size === 0 || kind === undefined || kind === 'context') return false
    const target = stageTargets[position]?.get(`${kind}:${number}`)
    return target !== undefined && selectedSet.has(target.key)
  }

  const renderNumber: RenderNumber = (position, kind, number, seq, side) => {
    if (!canStage || kind === undefined || kind === 'context') return plainNumber(number, seq, side)
    const target = stageTargets[position]?.get(`${kind}:${number}`)
    if (target === undefined) return plainNumber(number, seq, side)
    const source = sourceFor(target.origin.side)
    const disabled = !canApply(source)
    const direction: 'stage' | 'unstage' = target.checked ? 'unstage' : 'stage'
    return h('span', {
      className: 'vcs-diff-number vcs-diff-number-stageable',
      'data-line-stageable': '',
      'data-stage-row-seq': seq,
      'data-stage-side': side,
      'data-stage-line-key': target.key,
      onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => { handleNumberPointerDown(event, target, seq, side) },
      onPointerEnter: () => { handleNumberPointerEnter(seq, side) },
    },
    h('span', { className: 'vcs-diff-number-text', 'aria-hidden': 'true' }, number ?? ''),
    h('button', {
      type: 'button',
      className: 'vcs-diff-line-stage',
      tabIndex: -1,
      'data-stage-line': target.key,
      'data-stage-direction': direction,
      'aria-label': target.label,
      'aria-disabled': disabled || undefined,
      title: target.label,
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => { handleLineButtonClick(event, target, seq, side) },
    }, lineStageGlyph(direction)))
  }

  // Build floating action bar for multi-line selection (supports mixed staged/unstaged in merged view).
  const selectionBar = useMemo((): ReactElement | null => {
    if (selection === null || selection.keys.length === 0) return null
    const toStage: StageTarget[] = []
    const toUnstage: StageTarget[] = []
    for (const key of selection.keys) {
      const target = targetByKey.get(key)
      if (target === undefined) continue
      if (target.checked) toUnstage.push(target)
      else toStage.push(target)
    }
    const buttons: ReactElement[] = []
    if (toStage.length > 0) {
      const source = sourceFor(toStage[0].origin.side)
      const disabled = !canApply(source)
      buttons.push(h('button', {
        key: 'stage',
        type: 'button',
        className: 'vcs-diff-selection-btn',
        'data-stage-selection': 'stage',
        'aria-disabled': disabled || undefined,
        onMouseDown: (event: ReactMouseEvent) => { event.preventDefault() },
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation()
          if (disabled) return
          const payload = toStage.map(({ origin }): LineRef => ({ hunk: origin.hunk, line: origin.line }))
          const hunkPosition = toStage[0].hunkPosition
          clearSelection()
          void applyChanges(source, payload, { hunk: hunkPosition, restoreTo: 'line' })
        },
      }, t('stage.stageSelected', { count: formatCount(toStage.length, locale) })))
    }
    if (toUnstage.length > 0) {
      const source = sourceFor(toUnstage[0].origin.side)
      const disabled = !canApply(source)
      buttons.push(h('button', {
        key: 'unstage',
        type: 'button',
        className: 'vcs-diff-selection-btn',
        'data-stage-selection': 'unstage',
        'aria-disabled': disabled || undefined,
        onMouseDown: (event: ReactMouseEvent) => { event.preventDefault() },
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation()
          if (disabled) return
          const payload = toUnstage.map(({ origin }): LineRef => ({ hunk: origin.hunk, line: origin.line }))
          const hunkPosition = toUnstage[0].hunkPosition
          clearSelection()
          void applyChanges(source, payload, { hunk: hunkPosition, restoreTo: 'line' })
        },
      }, t('stage.unstageSelected', { count: formatCount(toUnstage.length, locale) })))
    }
    if (buttons.length === 0) return null
    return h('div', {
      className: 'vcs-diff-selection-bar',
      role: 'toolbar',
      style: { top: `${selection.top}px` },
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault() },
    }, buttons)
  }, [applyChanges, canApply, clearSelection, locale, selection, sourceFor, t, targetByKey])

  const children: ReactNode[] = []
  if (note !== undefined) {
    children.push(h('p', {
      key: 'note',
      className: 'vcs-diff-note',
      'data-diff-note': hunks.length === 0 ? 'empty' : 'metadata',
    }, t(note)))
  }
  if (diff.coarse) {
    children.push(h('p', { key: 'coarse', className: 'vcs-diff-note', 'data-diff-coarse': '' }, t('diff.coarse')))
  }
  if (truncated) {
    children.push(h('p', { key: 'truncated', className: 'vcs-diff-note', 'data-diff-truncated': '' },
      formatPlural(t, 'diff.truncated', MAX_RENDERED_LINES, locale)))
  }
  if (split && !wrap) {
    children.push(h(SplitColumns, {
      key: 'columns', hunks, highlights, renderNumber, lineState, isSelected, stageHunk, onHorizontalScroll, t,
    }))
  } else {
    let rowSeq = 0
    hunks.forEach((hunk, position) => {
      const highlighted = highlights[position]
      const hunkUi = stageHunk(position)
      const rows = split
        ? splitRows(hunk).map((row, at) => {
          const seq = rowSeq++
          const leftState = lineState(position, row.left?.kind, row.left?.no)
          const rightState = lineState(position, row.right?.kind, row.right?.no)
          const leftSelected = isSelected(position, row.left?.kind, row.left?.no)
          const rightSelected = isSelected(position, row.right?.kind, row.right?.no)
          return h('div', {
            key: at,
            className: 'vcs-diff-split-line',
            'data-diff-line': splitRowKind(row),
          },
          h('span', {
            className: cellClass(row.left),
            'data-diff-row-seq': seq,
            'data-diff-side': 'left',
            'data-stage-state': leftState,
            'data-line-selected': leftSelected ? '' : undefined,
          },
          renderNumber(position, row.left?.kind, row.left?.no, seq, 'left'),
          h(DiffText, {
            text: row.left?.text ?? '',
            spans: row.left === undefined ? undefined : highlighted?.old?.get(row.left.no),
          })),
          h('span', {
            className: cellClass(row.right),
            'data-diff-row-seq': seq,
            'data-diff-side': 'right',
            'data-stage-state': rightState,
            'data-line-selected': rightSelected ? '' : undefined,
          },
          renderNumber(position, row.right?.kind, row.right?.no, seq, 'right'),
          h(DiffText, {
            text: row.right?.text ?? '',
            spans: row.right === undefined ? undefined : highlighted?.new?.get(row.right.no),
          })))
        })
        : hunkRows(hunk).map((row, at) => {
          const seq = rowSeq++
          const activeNo = row.kind === 'add' ? row.new : row.old
          const stateAttr = lineState(position, row.kind, activeNo)
          const selected = isSelected(position, row.kind, activeNo)
          return h('div', {
            key: at,
            className: `vcs-diff-line vcs-diff-${row.kind}`,
            'data-diff-line': row.kind,
            'data-diff-row-seq': seq,
            'data-diff-side': 'unified',
            'data-stage-state': stateAttr,
            'data-line-selected': selected ? '' : undefined,
          },
          row.kind === 'del' ? renderNumber(position, 'del', row.old, seq, 'unified') : plainNumber(row.old, seq, 'unified'),
          row.kind === 'add' ? renderNumber(position, 'add', row.new, seq, 'unified') : plainNumber(row.new, seq, 'unified'),
          h('span', { className: 'vcs-diff-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
          h(DiffText, {
            text: row.text,
            spans: row.kind === 'add' ? highlighted?.new?.get(row.new) : highlighted?.old?.get(row.old),
          }))
        })
      children.push(h('section', { key: position, className: 'vcs-diff-hunk' },
        renderHunkHeader(hunkHeader(hunk, t), hunkUi?.node ?? null, hunkUi?.keyShortcuts),
        rows))
    })
  }
  return h('div', { className: 'vcs-diff-surface', ref: rootRef },
    h('div', {
      className: 'vcs-diff-body',
      ref: bodyRef,
      'data-review-view': split ? 'split' : 'unified',
      'data-review-wrap': wrap || undefined,
      'data-line-staging': canStage || undefined,
      onPointerDown: handleBodyPointerDown,
      onScroll: (event: ReactUIEvent<HTMLDivElement>) => { onHorizontalScroll(event.currentTarget) },
    }, children),
    selectionBar)
}

/**
 * Whether a value is a renderable `VcsFileDiff` payload.
 * @param value - candidate comparison state.
 * @returns true for a binary, oversized, or hunk-bearing text diff.
 */
export function isValidDiff(value: unknown): value is VcsFileDiff {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Record<'kind' | 'hunks', unknown>>
  if (candidate.kind === 'binary' || candidate.kind === 'oversized') return true
  return candidate.kind === 'text' && Array.isArray(candidate.hunks)
}

/** Cycled code-line widths (percent) for a comparison still on its way. */
const SKELETON_LINES = [58, 74, 41, 66, 83, 52]

/**
 * The outline of a comparison on its way: a hunk header, then numbered code
 * lines, at the diff's own line height. It is the status region for the
 * loading comparison and fades in after the shared skeleton delay.
 * @param label - localized loading label.
 * @returns the loading shape.
 */
function diffSkeleton(label: string) {
  const shape = (className: string) => h('span', { className: `vcs-skeleton-shape vcs-skeleton-bar ${className}` })
  return h('div', { className: 'vcs-skeleton vcs-diff-skeleton', role: 'status', 'aria-busy': 'true' },
    h('span', { className: 'vcs-sr-only' }, label),
    h('div', { className: 'vcs-diff-skeleton-line vcs-diff-skeleton-hunk' }, shape('vcs-diff-skeleton-header')),
    ...SKELETON_LINES.map((width, index) => h('div', { key: index, className: 'vcs-diff-skeleton-line' },
      shape('vcs-diff-skeleton-number'),
      h('span', {
        className: 'vcs-skeleton-shape vcs-skeleton-bar',
        style: { width: `${width}%` },
      }))))
}

/**
 * Render a file comparison with the same states, numbering, and layout choices
 * as DSH's built-in `FileDiff`.
 * Addition-only and deletion-only comparisons use one column without changing
 * the requested layout.
 * @param props - comparison state, layout choices, retry action, and localized copy.
 * @returns the comparison or its loading, unavailable, or error state.
 */
export function FileDiff({
  state, split, wrap, retry, onStageLines, stageScope, stageDisabled, stageSources, showStageState,
  onRegisterHunks, onRegisterSelectionClear, onInteractionChange, selectionScope, t, locale,
}: FileDiffProps) {
  let content: ReactNode
  if (state === undefined || state === 'loading') {
    content = diffSkeleton(t('diff.loading'))
  } else if (state === 'missing') {
    content = h('p', { className: 'vcs-diff-status' }, t('diff.missing'))
  } else if (state === 'error' || !isValidDiff(state)) {
    content = h('div', { className: 'vcs-diff-status' },
      h('span', null, t('diff.error')),
      h('button', {
        type: 'button',
        className: 'vcs-diff-retry',
        onClick: retry,
      }, t('diff.retry')))
  } else if (state.kind === 'binary') {
    content = h('p', { className: 'vcs-diff-status' }, t('diff.binary'))
  } else if (state.kind === 'oversized') {
    content = h('p', { className: 'vcs-diff-status' }, t('diff.oversized'))
  } else {
    const oneSided = isOneSided(state)
    content = h(TextDiff, {
      diff: state, split: split && !oneSided, wrap, onStageLines, stageScope, stageDisabled,
      stageSources, showStageState, onRegisterHunks, onRegisterSelectionClear, onInteractionChange, selectionScope, t, locale,
    })
  }
  return h('div', { className: 'vcs-diff-root' }, content)
}

export default FileDiff
