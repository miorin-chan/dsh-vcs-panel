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

import { createElement as h, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StageCheckbox } from '../detail/StageCheckbox.js'
import { formatCount } from '../format.js'
import { findAncestor, hasAttr } from '../keys.js'
import { highlightLines } from './highlight.js'

/** Maximum rendered lines per comparison. */
export const MAX_RENDERED_LINES = 5000

const comparePatchPosition = new Intl.Collator('en', { numeric: true }).compare

/**
 * Number a hunk's lines: context lines count on both sides, deletions on the
 * old side, additions on the new side.
 * @param {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: readonly string[] }} hunk - a served hunk.
 * @returns {Array<{ kind: 'add' | 'del' | 'context', old: number | undefined, new: number | undefined, text: string }>} the rows in order.
 */
export function hunkRows(hunk) {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map(line => {
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
 * @param {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: readonly string[] }} hunk - a served hunk.
 * @returns {Array<{ left?: { no: number, text: string, kind: 'del' | 'context' }, right?: { no: number, text: string, kind: 'add' | 'context' } }>} the rows in order.
 */
export function splitRows(hunk) {
  const rows = []
  let dels = []
  let adds = []
  const flush = () => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left = dels[at]
      const right = adds[at]
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
 * @param {readonly object[]} hunks - served hunks.
 * @returns {{ hunks: object[], truncated: boolean }} the hunks with the last one shortened as needed, and whether anything was cut.
 */
export function renderedHunks(hunks) {
  let budget = MAX_RENDERED_LINES
  const kept = []
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
 * @param {{ hunks: readonly { lines: readonly string[] }[] }} diff - a text comparison.
 * @returns {boolean} true when exactly one of additions/deletions is present.
 */
export function isOneSided(diff) {
  const hasAdditions = diff.hunks.some(hunk => hunk.lines.some(line => line.startsWith('+')))
  const hasDeletions = diff.hunks.some(hunk => hunk.lines.some(line => line.startsWith('-')))
  return hasAdditions !== hasDeletions
}

/** The one-line fact about a text comparison worth stating above its hunks, if any. */
function noteOf(diff) {
  if (!diff.before) return 'diff.created'
  if (!diff.after) return 'diff.deleted'
  if (diff.hunks.length === 0) return 'diff.unchanged'
  return undefined
}

/** Theme class for a token kind; kinds are colored by FileDiff.css via Shiki variables. */
const HIGHLIGHT_CLASS = {
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
function DiffText({ text, spans }) {
  if (spans === undefined) {
    return h('span', { className: 'vcs-diff-text' }, text)
  }
  return h('span', { className: 'vcs-diff-text', 'data-diff-code': '' },
    spans.map((span, index) => h('span', {
      key: index,
      className: HIGHLIGHT_CLASS[span.kind] ?? undefined,
    }, span.text)))
}

/** A hunk's header line. */
function hunkHeader(hunk, t) {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return hunk.side === undefined ? range : `${t(`changes.${hunk.side}`)}  ${range}`
}

function renderHunkHeader(label, checkbox) {
  return h('div', { className: 'vcs-diff-hunk-header', 'data-diff-hunk-header': '', tabIndex: -1 },
    checkbox, label)
}

/**
 * Highlight one side of a hunk, keyed by line number.
 * The highlighter returns one token run per input line; empty terminal rows
 * stay aligned because the input lines are exactly the side's numbered rows.
 */
function highlightedSide(rows, side, path) {
  const source = rows.flatMap(row => {
    const no = row[side]
    return no === undefined ? [] : [{ no, text: row.text }]
  })
  if (source.length === 0) return new Map()
  const highlighted = highlightLines(path, source.map(line => line.text))
  if (highlighted === undefined) return undefined
  return new Map(source.map((line, index) => [line.no, highlighted[index] ?? []]))
}

/** Old- and new-side token runs for one hunk. */
function hunkHighlights(hunk, path) {
  const rows = hunkRows(hunk)
  return { old: highlightedSide(rows, 'old', path), new: highlightedSide(rows, 'new', path) }
}

/** The kind a paired row carries: a deletion or addition on either side, otherwise context. */
function splitRowKind(row) {
  if (row.left?.kind === 'del') return 'del'
  if (row.right?.kind === 'add') return 'add'
  return 'context'
}

/** Class list for one side cell of a split row. */
function cellClass(cell) {
  return cell === undefined ? 'vcs-diff-cell vcs-diff-empty' : `vcs-diff-cell vcs-diff-${cell.kind}`
}

/**
 * The side-by-side view without wrapping: two columns that clip their long
 * lines and scroll together on both axes, so a long line on one side never
 * runs under the other and both sides show the same rows and columns of text.
 * Every line is one fixed-height row, which keeps the sides aligned.
 */
function SplitColumns({ hunks, highlights, stageControl, stageHunk, t }) {
  const paired = useMemo(() => hunks.map(hunk => ({ header: hunkHeader(hunk, t), rows: splitRows(hunk) })), [hunks, t])
  const columns = useRef({ left: null, right: null })
  const offsets = useRef({ left: { scrollLeft: 0, scrollTop: 0 }, right: { scrollLeft: 0, scrollTop: 0 } })
  const follow = side => event => {
    const peer = side === 'left' ? 'right' : 'left'
    const other = columns.current[peer]
    if (other === null) return
    for (const axis of ['scrollLeft', 'scrollTop']) {
      const value = event.currentTarget[axis]
      if (offsets.current[side][axis] === value) continue
      offsets.current[side][axis] = value
      other[axis] = value
      // Record the browser-clamped offset so its scroll event cannot pull the source back.
      offsets.current[peer][axis] = other[axis]
    }
  }
  return h('div', { className: 'vcs-diff-columns' },
    ['left', 'right'].map(side => h('div', {
      key: side,
      className: 'vcs-diff-column',
      'data-diff-side': side,
      ref: element => { columns.current[side] = element },
      onScroll: follow(side),
    },
    paired.map((hunk, position) => h('section', { key: position, className: 'vcs-diff-hunk' },
      renderHunkHeader(hunk.header, side === 'left' ? stageHunk(position) : null),
      hunk.rows.map((row, at) => {
        const cell = row[side]
        const spans = cell === undefined ? undefined : highlights[position]?.[side === 'left' ? 'old' : 'new']?.get(cell.no)
        return h('div', {
          key: at,
          className: `vcs-diff-side-line ${cell === undefined ? 'vcs-diff-empty' : `vcs-diff-${cell.kind}`}`,
          'data-diff-line': splitRowKind(row),
        },
        stageControl(position, cell?.kind, cell?.no),
        lineNumber(cell?.no),
        h(DiffText, { text: cell?.text ?? '', spans }))
      })))))
  )
}

function lineNumber(number) {
  return h('span', { className: 'vcs-diff-number' }, number ?? '')
}

/**
 * The hunks of a text comparison with their line numbers, unified or side by side.
 */
function TextDiff({ diff, split, wrap, onStageLines, stageScope, stageDisabled, stageSources, showStageState, t, locale }) {
  const note = noteOf(diff)
  const { hunks, truncated } = useMemo(() => renderedHunks(diff.hunks), [diff.hunks])
  const highlights = useMemo(() => hunks.map(hunk => hunkHighlights(hunk, diff.path)), [hunks, diff.path])
  const [active, setActive] = useState(null)
  const bodyRef = useRef(null)
  const stageFocus = useRef(null)
  const canStage = showStageState || (!truncated && diff.lineStaging === true
    && typeof diff.fingerprint === 'string' && typeof onStageLines === 'function')
  const stageTargets = useMemo(() => canStage ? hunks.map((hunk, position) => {
    const targets = new Map()
    hunkRows(hunk).forEach((row, line) => {
      if (row.kind === 'context') return
      const origin = hunk.origins?.[line] ?? { side: stageScope, hunk: position, line }
      const checked = origin.side === 'staged'
      const action = t(checked ? 'stage.unstageLine' : 'stage.stageLine')
      const added = row.kind === 'add'
      const number = added ? row.new : row.old
      const description = t(added ? 'stage.addedLine' : 'stage.deletedLine', { number: formatCount(number, locale) })
      targets.set(`${row.kind}:${number}`, { origin, checked, key: `${position}:${line}`, label: `${action} · ${description}` })
    })
    return targets
  }) : [], [canStage, hunks, locale, stageScope, t])
  const firstLine = stageTargets.find(targets => targets.size > 0)?.values().next().value.key
  const activeLine = active?.diff === diff && active?.split === split && active?.wrap === wrap
    ? active.key : firstLine
  // Patch order stays consistent across unified and both split layouts.
  const controls = kind => {
    const buttons = Array.from(bodyRef.current.querySelectorAll(`[data-stage-${kind}]`))
    if (kind === 'line') buttons.sort((left, right) => comparePatchPosition(left.dataset.stageLine, right.dataset.stageLine))
    return buttons
  }

  useLayoutEffect(() => {
    const pending = stageFocus.current
    if (pending === null || pending.diff === diff) return
    stageFocus.current = null
    const element = bodyRef.current
    const doc = element.ownerDocument
    if (doc.activeElement !== pending.button && doc.activeElement !== doc.body) return
    const buttons = controls(pending.kind)
    const file = findAncestor(element, null, node => hasAttr(node, 'data-file-key'))
    const fallback = file?.querySelector('.vcs-tree-file-head')
    const next = buttons[Math.min(pending.index, buttons.length - 1)] ?? fallback
    next?.focus({ preventScroll: true })
  }, [diff])

  const sourceFor = side => {
    if (stageSources !== undefined) return stageSources[side]
    return { onStageLines, fingerprint: diff.lineStaging === true ? diff.fingerprint : undefined }
  }
  const canApply = source => !stageDisabled && !truncated
    && typeof source?.onStageLines === 'function' && typeof source.fingerprint === 'string'
  const applyChanges = async (button, kind, source, lines) => {
    const pending = { button, diff, kind, index: controls(kind).indexOf(button) }
    stageFocus.current = pending
    if (!await source.onStageLines(source.fingerprint, lines) && stageFocus.current === pending) {
      stageFocus.current = null
    }
  }
  const stageHunk = position => {
    const targets = stageTargets[position]
    if (targets === undefined || targets.size === 0) return null
    const changes = [...targets.values()]
    const unstaged = changes.filter(change => !change.checked)
    const checked = unstaged.length === 0 ? true : unstaged.length === changes.length ? false : 'mixed'
    const selected = checked === true ? changes : unstaged
    const side = selected[0].origin.side
    const source = sourceFor(side)
    const labelKey = checked === true ? 'stage.unstageHunk' : checked === 'mixed' ? 'stage.stageRemainingHunk' : 'stage.stageHunk'
    return h(StageCheckbox, {
      className: 'vcs-stage-hunk',
      'data-stage-hunk': position,
      checked,
      label: t(labelKey, { number: formatCount(position + 1, locale) }),
      disabled: !canApply(source),
      onKeyDown: event => {
        // The surrounding hunk header uses these keys to fold the file.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      },
      onToggle: button => applyChanges(button, 'hunk', source, selected.map(({ origin }) => ({ hunk: origin.hunk, line: origin.line }))),
    })
  }

  const stageControl = (hunk, kind, number) => {
    if (!canStage) return null
    const target = stageTargets[hunk].get(`${kind}:${number}`)
    if (target === undefined) return h('span', { 'aria-hidden': 'true' })
    const { origin, checked, key, label } = target
    const source = sourceFor(origin.side)
    return h(StageCheckbox, {
      className: 'vcs-stage-line',
      checked,
      label,
      disabled: !canApply(source),
      'data-stage-line': key,
      tabIndex: key === activeLine ? 0 : -1,
      onFocus: () => { setActive({ diff, split, wrap, key }) },
      onKeyDown: event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        const buttons = controls('line')
        const next = buttons.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)
        buttons[next]?.focus()
      },
      onToggle: button => applyChanges(button, 'line', source, [{ hunk: origin.hunk, line: origin.line }]),
    })
  }
  const children = []
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
      t('diff.truncated', { count: formatCount(MAX_RENDERED_LINES, locale) })))
  }
  if (split && !wrap) {
    children.push(h(SplitColumns, { key: 'columns', hunks, highlights, stageControl, stageHunk, t }))
  } else {
    hunks.forEach((hunk, position) => {
      const highlighted = highlights[position]
      const rows = split
        ? splitRows(hunk).map((row, at) => h('div', {
          key: at,
          className: 'vcs-diff-split-line',
          'data-diff-line': splitRowKind(row),
        },
        h('span', { className: cellClass(row.left) },
          stageControl(position, row.left?.kind, row.left?.no),
          lineNumber(row.left?.no),
          h(DiffText, {
            text: row.left?.text ?? '',
            spans: row.left === undefined ? undefined : highlighted?.old?.get(row.left.no),
          })),
        h('span', { className: cellClass(row.right) },
          stageControl(position, row.right?.kind, row.right?.no),
          lineNumber(row.right?.no),
          h(DiffText, {
            text: row.right?.text ?? '',
            spans: row.right === undefined ? undefined : highlighted?.new?.get(row.right.no),
          }))))
        : hunkRows(hunk).map((row, at) => h('div', {
          key: at,
          className: `vcs-diff-line vcs-diff-${row.kind}`,
          'data-diff-line': row.kind,
        },
        stageControl(position, row.kind, row.kind === 'add' ? row.new : row.old),
        lineNumber(row.old),
        lineNumber(row.new),
        h('span', { className: 'vcs-diff-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
        h(DiffText, {
          text: row.text,
          spans: row.kind === 'add' ? highlighted?.new?.get(row.new) : highlighted?.old?.get(row.old),
        })))
      children.push(h('section', { key: position, className: 'vcs-diff-hunk' },
        renderHunkHeader(hunkHeader(hunk, t), stageHunk(position)),
        rows))
    })
  }
  return h('div', {
    className: 'vcs-diff-body',
    ref: bodyRef,
    'data-review-view': split ? 'split' : 'unified',
    'data-review-wrap': wrap || undefined,
    'data-line-staging': canStage || undefined,
  }, children)
}

/**
 * Whether a value is a renderable `VcsFileDiff` payload.
 * @param {unknown} value - candidate comparison state.
 * @returns {boolean} true for a binary, oversized, or hunk-bearing text diff.
 */
export function isValidDiff(value) {
  if (value === null || typeof value !== 'object') return false
  if (value.kind === 'binary' || value.kind === 'oversized') return true
  return value.kind === 'text' && Array.isArray(value.hunks)
}

/** Cycled code-line widths (percent) for a comparison still on its way. */
const SKELETON_LINES = [58, 74, 41, 66, 83, 52]

/**
 * The outline of a comparison on its way: a hunk header, then numbered code
 * lines, at the diff's own line height. It is the status region for the
 * loading comparison and fades in after the shared skeleton delay.
 * @param {string} label - localized loading label.
 * @returns {object} the loading shape.
 */
function diffSkeleton(label) {
  const shape = className => h('span', { className: `vcs-skeleton-shape vcs-skeleton-bar ${className}` })
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
 * @param {{ state: '*' | 'loading' | 'missing' | 'error' | object | undefined, split: boolean, wrap: boolean, retry: Function, t: Function, locale?: string }} props - comparison state, layout choices, retry action, and localized copy.
 * @returns {object} the comparison or its loading, unavailable, or error state.
 */
export function FileDiff({ state, split, wrap, retry, onStageLines, stageScope, stageDisabled, stageSources, showStageState, t, locale }) {
  let content
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
    content = h(TextDiff, { diff: state, split: split && !oneSided, wrap, onStageLines, stageScope, stageDisabled, stageSources, showStageState, t, locale })
  }
  return h('div', { className: 'vcs-diff-root' }, content)
}

export default FileDiff
