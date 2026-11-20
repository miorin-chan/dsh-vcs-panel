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
import { FileDiff, isValidDiff, MAX_RENDERED_LINES } from '../diff/FileDiff.jsx'
import { mergeDiffs } from '../diff/merge.js'
import { formatCount, formatPlural, lineCounts, splitPath, statusKey } from '../format.js'
import {
  BACK, DOWN, findAncestor, FORWARD, hasAttr, hasClass, isDiscreteActionButton, isEditableTarget,
  isNavigationStop, isOverlayOrMenuTarget, movement, rowStep, unmodified, UP,
} from '../keys.js'
import { Chevron } from '../ui.jsx'
import { Bar, barWidth } from '../skeleton.jsx'
import {
  MAX_PARALLEL, changedLines, diffTargets, estimateHeight, isFolded, rowAt,
} from './detail.js'
import { createQueue } from './queue.js'
import { StageAction } from './StageAction.js'
import { StageCheckbox } from './StageCheckbox.js'
import { FileStageMenu } from './FileStageMenu.jsx'
import { counterpartKey, isStageable, mergedStageState, STAGE, stageFiles, UNSTAGE } from './stage.js'
import { rowBodyId } from './tree.js'

/** Distance beyond the viewport at which a file starts loading. */
const PRELOAD_MARGIN = '800px 0px'

/** Comparisons kept across nodes and refreshes of the same revision. */
const CACHE_LIMIT = 300

/** Height of one tree row and of one expanded file header, in CSS pixels. */
const ROW_HEIGHT = 28

/** Indentation per tree level, in CSS pixels. */
const INDENT = 14

/** Width of the staging gutter at the left edge of a working-tree tree, in CSS pixels. */
const GUTTER_WIDTH = 22

/** The identity of one comparison request. */
function targetKey(target) {
  return `${target.scope}|${target.path}|${target.oldPath ?? ''}|${target.rev ?? ''}`
}

/** Store one answer, evicting the oldest past {@link CACHE_LIMIT}. */
function remember(cache, key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
}

/** The localized reason a folded file gives when the folding budget kept it closed. */
function foldedText(reason, entry, t, locale) {
  if (reason === 'large') return formatPlural(t, 'stream.foldedLarge', changedLines(entry), locale)
  return t('stream.foldedBudget')
}

/**
 * Keys a reading position may fall back to when its exact row is not rendered,
 * from the row itself up to its group row.
 * @param {string} key - a row key.
 * @returns {string[]} candidate keys, nearest first.
 */
function ancestorKeys(key) {
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

/**
 * One file's comparison, or the reason it is folded.
 *
 * The comparison is requested when the file is both unfolded and near the
 * viewport. A placeholder holds the estimated height until then, so rows below
 * do not jump when the answer arrives.
 */
const FileBody = memo(function FileBody({
  group, entry, rev, near, folded, foldReason, request, revision,
  split, wrap, onStage, stageDisabled, t, locale,
}) {
  const [answer, setAnswer] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const targets = diffTargets(group, entry, rev)
  const targetsKey = targets.map(targetKey).join('\0')

  useEffect(() => {
    if (folded || !near) return undefined
    if (answer !== null && answer.revision === revision && answer.attempt === attempt && answer.targetsKey === targetsKey) {
      return undefined
    }
    // Apply both answers together so a refresh cannot mix different revisions.
    const results = new Map()
    const cancel = targets.map(target => request(target, revision, result => {
      results.set(target.scope, { ...result, target })
      if (results.size === targets.length) {
        setAnswer({ results: targets.map(source => results.get(source.scope)), revision, attempt, targetsKey })
      }
    }))
    return () => { for (const stop of cancel) stop?.() }
    // `answer` and `targets` are keyed by `revision`, `attempt`, and `targetsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, near, revision, attempt, request, targetsKey])

  const combined = useMemo(() => {
    const [staged, unstaged] = answer?.results ?? []
    if (group !== 'merged' || staged?.diff?.kind !== 'text' || unstaged?.diff?.kind !== 'text'
      || staged.diff.indexOid === undefined || staged.diff.indexOid !== unstaged.diff.indexOid
      || staged.diff.hunks.length === 0 || unstaged.diff.hunks.length === 0 || staged.diff.coarse || unstaged.diff.coarse) return null
    const diff = mergeDiffs(staged.diff, unstaged.diff)
    const length = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    return length <= MAX_RENDERED_LINES ? diff : null
  }, [answer, group])

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
  const busy = stageDisabled || answer.targetsKey !== targetsKey || answer.revision !== revision
  const retry = () => { setAttempt(value => value + 1) }
  const stageLines = target => onStage === undefined ? undefined : (fingerprint, lines) => onStage({ ...target, fingerprint, lines })
  if (combined !== null) {
    const stageSources = Object.fromEntries(answer.results.map(({ target, diff }) => [target.scope, {
      fingerprint: diff.lineStaging === true ? diff.fingerprint : undefined,
      onStageLines: stageLines(target),
    }]))
    return <FileDiff state={combined} split={split} wrap={wrap} retry={retry} stageSources={stageSources}
      stageDisabled={busy} showStageState={true} t={t} locale={locale} />
  }
  const renderDiff = ({ status, diff, target }) => (
    <FileDiff
      state={status === 'ready' ? diff : status}
      split={split}
      wrap={wrap}
      retry={retry}
      onStageLines={stageLines(target)}
      stageScope={target.scope}
      stageDisabled={busy}
      showStageState={group === 'merged'}
      t={t}
      locale={locale}
    />
  )
  if (answer.results.length === 1) return renderDiff(answer.results[0])
  return answer.results.map(result => (
    <div className="vcs-diff-source" key={result.target.scope}>
      <div className="vcs-diff-source-label">{t(result.target.scope === 'staged' ? 'changes.staged' : 'changes.unstaged')}</div>
      {renderDiff(result)}
    </div>
  ))
})

/**
 * Render the change tree of one node.
 * @param {object} props - rows, expansion data, and panel state.
 */
export function ChangeTree({
  api, repo, rev, rows, budget, folds, split, wrap, revision, cache,
  initialAnchor, onReading, onToggleRow, onBulkFold, onLeave, control, before = null, onStage, partiallyStaged, stageDisabled, t, locale,
}) {
  const scrollRef = useRef(null)
  const rowEls = useRef(new Map())
  const bodyEls = useRef(new Map())
  const sectionEls = useRef(new Map())
  const observerRef = useRef(null)
  const frameRef = useRef(0)
  const pendingPreserve = useRef(null)
  const pendingAlign = useRef(null)
  const refreshAnchor = useRef(null)
  const stageSource = useRef(null)
  const restoredRef = useRef(false)
  const lastInputRef = useRef('scroll')
  const queue = useMemo(() => createQueue(MAX_PARALLEL), [])
  const [near, setNear] = useState(() => new Map())
  const [everyNear, setEveryNear] = useState(false)
  const [cursor, setCursor] = useState({ row: 0, hunk: -1 })
  const cursorRef = useRef({ row: 0, hunk: -1 })
  const readingRef = useRef(initialAnchor?.key ?? null)
  const [readingKey, setReadingKey] = useState(initialAnchor?.key ?? null)

  const navRows = useMemo(() => rows.filter(row => row.kind !== 'loading'), [rows])
  const grouped = useMemo(() => rows.some(row => row.kind === 'group'), [rows])
  // A working tree that can be staged draws a gutter; merged rows keep it to
  // show their staged state even while writes are unavailable.
  const gutter = onStage !== undefined || rows.some(row => row.group === 'merged')
  const stagingRef = useRef(() => null)
  const navIndexByKey = useMemo(() => {
    const index = new Map()
    navRows.forEach((row, at) => index.set(row.key, at))
    return index
  }, [navRows])
  const cursorKey = navRows[Math.max(0, Math.min(cursor.row, navRows.length - 1))]?.key ?? null

  /** Whether one file row is folded under the current rules. */
  const isRowFolded = useCallback(row => isFolded(row.key, folds), [folds])

  // Folding reasons describe why some files stay closed while diffs are being
  // read; in the collapsed default they would only repeat the file list.
  const someUnfolded = useMemo(
    () => rows.some(row => row.kind === 'file' && !isRowFolded(row)),
    [isRowFolded, rows],
  )

  const setCursorAt = useCallback((row, hunk = -1) => {
    const next = { row, hunk }
    cursorRef.current = next
    setCursor(next)
  }, [])

  /** The top offset of one element inside the scrolling tree, ignoring sticky displacement. */
  const flowTop = useCallback(element => {
    const root = scrollRef.current
    if (element === null || element === undefined || root === null) return 0
    // Group and file heads stick while scrolling, shifting their own
    // `offsetTop`; the static container around each head holds its layout
    // position in the tree.
    let node = element
    if (node.classList?.contains('vcs-tree-file-head') || node.classList?.contains('vcs-tree-group-head')) {
      node = node.parentElement?.parentElement ?? node
    }
    let top = 0
    while (node !== null && node !== undefined && node !== root) {
      top += node.offsetTop ?? 0
      node = node.offsetParent ?? null
    }
    return top
  }, [])

  /** The tree top a row is aligned to, leaving the sticky rows in view. */
  const alignmentTop = useCallback(row => {
    if (!grouped) return 0
    return row.kind === 'group' ? 0 : ROW_HEIGHT
  }, [grouped])

  /** A stable ref callback per row key, so rerenders do not rebind. */
  const bindRow = useMemo(() => {
    const callbacks = new Map()
    return key => {
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
    const callbacks = new Map()
    return key => {
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
    const callbacks = new Map()
    return key => {
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

  /** Ask for one comparison through the cache and the queue; returns a canceller. */
  const request = useCallback((target, answerRevision, onAnswer) => {
    const key = `${repo}|${targetKey(target)}|${answerRevision}`
    const cached = cache.get(key)
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
        const result = { status: 'ready', diff }
        remember(cache, key, result)
        onAnswer(result)
      }, error => {
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
  }, [api, cache, queue, repo])

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
          const key = entry.target.dataset.fileKey
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
  const indexOfKey = useCallback(key => {
    if (key === null) return -1
    for (const candidate of ancestorKeys(key)) {
      const index = navIndexByKey.get(candidate)
      if (index !== undefined) return index
    }
    return -1
  }, [navIndexByKey])

  /** Report the row being read and the offset below its top. */
  const report = useCallback(() => {
    const root = scrollRef.current
    if (root === null) return
    const tops = []
    const keys = []
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
  const scrollRowIntoView = useCallback(index => {
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
  const focusRowElement = useCallback(key => {
    rowEls.current.get(key)?.focus({ preventScroll: true })
  }, [])

  /** Focus one hunk header without letting the browser scroll it again. */
  const focusHunkElement = useCallback((key, hunk) => {
    const header = bodyEls.current.get(key)?.querySelectorAll('[data-diff-hunk-header]')[hunk]
    header?.focus?.({ preventScroll: true })
  }, [])

  /** Report a row as the reading position while leaving the scroll offset explicit. */
  const markReading = useCallback((row, offset = 0) => {
    readingRef.current = row.key
    setReadingKey(previous => (previous === row.key ? previous : row.key))
    onReading({ key: row.key, offset })
  }, [onReading])

  /** Move the keyboard cursor to one row, without entering its diff. */
  const focusRowAt = useCallback(index => {
    const row = navRows[index]
    if (row === undefined) return
    setCursorAt(index, -1)
    scrollRowIntoView(index)
    focusRowElement(row.key)
    markReading(row, 0)
  }, [focusRowElement, markReading, navRows, scrollRowIntoView, setCursorAt])

  /** Whether one row currently shows the content below it. */
  const isExpanded = useCallback(row => (row.kind === 'file' ? !isRowFolded(row) : row.expanded), [isRowFolded])

  /**
   * Collapse or expand one row. A file head that has already scrolled past its
   * sticky slot keeps that slot when it collapses, so the next file takes over
   * right below it instead of the reader being pushed back up.
   */
  const toggle = useCallback((row, expanded) => {
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
  const hunkOffsets = useCallback(row => {
    const body = bodyEls.current.get(row.key)
    if (body === undefined) return []
    const tops = new Set()
    for (const header of body.querySelectorAll('[data-diff-hunk-header]')) tops.add(flowTop(header))
    // A side-by-side comparison draws one header per column; they align, and
    // the set keeps one offset per hunk in ascending order.
    return [...tops].sort((a, b) => a - b)
  }, [flowTop])

  /** Align one row directly below the sticky rows. */
  const alignRow = useCallback(index => {
    const root = scrollRef.current
    const row = navRows[index]
    if (root === null || row === undefined) return
    const element = rowEls.current.get(row.key)
    if (element === undefined) return
    root.scrollTop = Math.max(0, flowTop(element) - alignmentTop(row))
  }, [alignmentTop, flowTop, navRows])

  /** The hunk stop a scroll line is reading inside one row, or -1 for the row itself. */
  const hunkAtLine = useCallback((row, line) => {
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
  const focusStop = useCallback((index, hunk = -1, align = false) => {
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
  const back = useCallback(() => {
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
  const moveStop = useCallback(direction => {
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
  const moveRow = useCallback(direction => {
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
  const onTreeClick = event => {
    const hunkNode = findAncestor(event.target, event.currentTarget, node => hasAttr(node, 'data-diff-hunk-header'))
    if (hunkNode !== null) {
      const file = findAncestor(hunkNode, event.currentTarget, node => node?.dataset?.fileKey !== undefined)
      const key = file?.dataset?.fileKey
      const index = key === undefined ? undefined : navIndexByKey.get(key)
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
    const key = file.dataset.fileKey
    const index = key === undefined ? undefined : navIndexByKey.get(key)
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

  const runKeyDown = useCallback((event, { fromOutside = false } = {}) => {
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
    // `s` stages and `u` unstages the row under the cursor; hunks keep their own controls.
    if (!fromOutside && cursorRef.current.hunk < 0 && (event.key === 's' || event.key === 'u') && unmodified(event)) {
      const current = navRows[Math.max(0, Math.min(cursorRef.current.row, navRows.length - 1))]
      const staging = current === undefined ? null : stagingRef.current(current)
      const run = event.key === 's' ? staging?.stage : staging?.unstage
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
      event.preventDefault()
      event.stopPropagation()
      onLeave()
      return 'left'
    }
    return false
  }, [
    back, focusRowElement, focusStop, forward, hunkOffsets, isExpanded, isRowFolded, moveRow, moveStop,
    navRows, onLeave, report, setCursorAt, stageDisabled, syncCursorToScroll, toggle,
  ])

  const onKeyDown = event => {
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
    refreshAnchor.current = {
      key,
      alternate: staging?.alternate,
      focused: staging !== null
        && (sectionEls.current.get(key) ?? rowEls.current.get(key)?.parentElement)?.contains(root.ownerDocument.activeElement),
      offset: element === undefined ? 0 : Math.max(0, root.scrollTop - flowTop(element)),
      rows,
    }
  }, [revision, flowTop]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const pending = refreshAnchor.current
    if (pending === null || rows === pending.rows) return
    refreshAnchor.current = null
    const root = scrollRef.current
    if (root === null) return
    const index = navIndexByKey.get(pending.key) ?? navIndexByKey.get(pending.alternate) ?? indexOfKey(pending.key)
    const row = navRows[index < 0 && pending.focused ? 0 : index]
    const element = row === undefined ? undefined : rowEls.current.get(row.key)
    if (element !== undefined) {
      root.scrollTop = Math.max(0, flowTop(element) + (row.key === pending.key ? pending.offset : 0))
    }
    report()
    const doc = root.ownerDocument
    // Focus marks the stop keys act on, so a row that kept focus through the
    // refresh stays the cursor even when the reading row is another one.
    const focusedIndex = root.contains(doc.activeElement) ? navIndexByKey.get(doc.activeElement.dataset?.rowKey) : undefined
    if (focusedIndex !== undefined) {
      setCursorAt(focusedIndex, -1)
      return
    }
    const line = root.scrollTop + (grouped ? ROW_HEIGHT : 0) + ROW_HEIGHT
    const hunk = row === undefined ? -1 : hunkAtLine(row, line)
    setCursorAt(index >= 0 ? index : 0, hunk)
    if (pending.focused && doc.activeElement === doc.body) {
      if (row !== undefined) focusRowElement(row.key)
      else root.focus({ preventScroll: true })
    }
  }, [flowTop, focusRowElement, grouped, hunkAtLine, indexOfKey, navIndexByKey, navRows, report, rows, setCursorAt])

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
      const exact = row.key === initialAnchor.key
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
  const preserve = useCallback(callback => {
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
      handleKeyDown(event) {
        const fromOutside = !scrollRef.current?.contains?.(event.target)
        const result = runKeyDown(event, { fromOutside })
        if (result === false) return false
        if (result !== 'left') {
          const active = typeof document === 'undefined' ? null : document.activeElement
          if (!isNavigationStop(active, scrollRef.current)) restoreFocus()
        }
        return true
      },
      bulkFold(mode) {
        preserve(() => { onBulkFold(mode) })
      },
    }
    return () => { control.current = null }
  }, [control, focusStop, navRows.length, onBulkFold, preserve, report, restoreFocus, runKeyDown])

  /** The click handler every row shares: move the cursor, focus it, and flip the row. */
  const activateRow = (row, expanded) => {
    const index = navIndexByKey.get(row.key)
    if (index !== undefined) setCursorAt(index)
    focusRowElement(row.key)
    toggle(row, expanded)
  }

  /**
   * Run one staging write from a row, keeping the row as the reading anchor
   * across the refresh. A row command also takes focus, so the next key acts
   * from the row; a line or hunk keeps focus on its own control.
   */
  const runStage = async (row, target, alternate, { focusRow = false } = {}) => {
    const source = { key: row.key, alternate }
    stageSource.current = source
    const index = navIndexByKey.get(row.key)
    if (index !== undefined) setCursorAt(index)
    if (focusRow) focusRowElement(row.key)
    const accepted = await onStage(target)
    if (!accepted && stageSource.current === source) stageSource.current = null
    return accepted
  }

  /**
   * One row's staging: the writes `s` and `u` run, and the gutter control.
   * Separate groups give each row one direction; merged rows have both.
   */
  const rowStaging = row => {
    if (!gutter) return null
    const merged = row.group === 'merged'
    if (row.kind === 'file') {
      const targets = diffTargets(row.group, row.entry, rev)
      const stagedTarget = targets.find(target => target.scope === 'staged')
      const unstagedTarget = targets.find(target => target.scope !== 'staged')
      const primary = unstagedTarget ?? stagedTarget
      const mixed = row.entry.partiallyStaged === true || partiallyStaged?.has(row.entry.path) === true
      const unstaging = primary.scope === 'staged' && (!merged || !mixed)
      const conflict = !isStageable(row.entry)
      const writable = onStage !== undefined && !conflict
      const alternate = merged ? undefined : counterpartKey(row.key)
      const write = target => (writable && target !== undefined
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
    const write = direction => {
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
  const stageKeys = staging => [staging?.stage === undefined ? null : 's', staging?.unstage === undefined ? null : 'u']
    .filter(key => key !== null).join(' ') || undefined

  /** The gutter cell of one row: a command under separate groups, a tri-state mark when merged. */
  const renderGutter = (row, staging) => {
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

  const indentOf = depth => `${(gutter ? 6 : 8) + (depth + (grouped ? 1 : 0)) * INDENT}px`
  const totalStat = (added, deleted) => (
    <span className="vcs-tree-stat">
      {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
      {deleted > 0 ? <span className="vcs-del">−{formatCount(deleted, locale)}</span> : null}
    </span>
  )
  const fileStat = entry => {
    if (entry.untracked === true) return null
    if (entry.binary === true) return <span className="vcs-tree-stat vcs-dim">{t('changes.binary')}</span>
    const counts = lineCounts(entry)
    return (
      <span className="vcs-tree-stat">
        {counts.added > 0 ? <span className="vcs-add">+{formatCount(counts.added, locale)}</span> : null}
        {counts.deleted > 0 ? <span className="vcs-del">−{formatCount(counts.deleted, locale)}</span> : null}
      </span>
    )
  }
  const rowProps = row => ({
    'data-row-key': row.key,
    tabIndex: row.key === cursorKey ? 0 : -1,
    ref: bindRow(row.key),
  })
  const renderLoading = row => (
    <div
      key={`loading:${row.key}`}
      className="vcs-tree-row vcs-tree-loading vcs-skeleton"
      role="status"
      aria-busy="true"
      style={{ paddingLeft: gutter ? `calc(${GUTTER_WIDTH}px + ${indentOf(row.depth)})` : indentOf(row.depth) }}
    >
      <span className="vcs-sr-only">{t('changes.loadingDirectory')}</span>
      <span className="vcs-skeleton-shape vcs-skeleton-glyph" />
      <Bar width={barWidth(row.depth + 2, 0.4)} />
    </div>
  )
  const renderGroup = (row, children) => {
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
            style={{ paddingLeft: gutter ? '6px' : '8px' }}
            {...rowProps(row)}
            onClick={() => { activateRow(row, row.expanded) }}
          >
            <Chevron open={row.expanded} />
            <span className="vcs-tree-group-name">{t(`changes.${row.group}`)}</span>
            <span className="vcs-tree-spacer" />
            <span className="vcs-tree-stat vcs-dim">{formatPlural(t, 'detail.fileCount', row.count, locale)}</span>
            {totalStat(row.added, row.deleted)}
          </button>
        </div>
        <div className="vcs-tree-group-body" id={bodyId}>{children}</div>
      </div>
    )
  }
  const renderDir = (row, children) => {
    const bodyId = rowBodyId(row.key)
    const staging = rowStaging(row)
    return (
      <div key={row.key} className="vcs-tree-dir">
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
            style={{ paddingLeft: indentOf(row.depth) }}
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
  const renderFile = row => {
    const expanded = !isRowFolded(row)
    const foldReason = expanded || !someUnfolded ? undefined : budget.get(row.key)
    const parts = splitPath(row.entry.path)
    const bodyId = rowBodyId(row.key)
    const statusClass = row.entry.untracked === true ? 'vcs-status-untracked' : `vcs-status-${row.entry.status}`
    const staging = rowStaging(row)
    // The file stage the row body writes: lines and hunks act on their own comparison.
    const stage = onStage === undefined || staging === null || staging.conflict ? undefined
      : target => runStage(row, target, staging.merged ? undefined : counterpartKey(row.key))
    return (
      <section
        key={row.key}
        className="vcs-tree-file"
        data-file-key={row.key}
        ref={bindSection(row.key)}
      >
        <div className="vcs-tree-head vcs-tree-file-head-wrap" data-open={expanded ? 'true' : undefined}>
          {renderGutter(row, staging)}
          <button
            type="button"
            className="vcs-tree-row vcs-tree-file-head"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-current={readingKey === row.key ? 'location' : undefined}
            aria-keyshortcuts={stageKeys(staging)}
            title={row.entry.origPath === undefined ? row.path : `${row.entry.origPath} → ${row.path}`}
            style={{ paddingLeft: indentOf(row.depth) }}
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
              void staging.stagedWrite()
            }} />
          ) : null}
        </div>
        <div className="vcs-tree-file-body" id={bodyId} ref={bindBody(row.key)}>
          <FileBody
            group={row.group}
            entry={row.entry}
            rev={rev}
            near={everyNear || near.get(row.key) === true}
            folded={!expanded}
            foldReason={foldReason}
            request={request}
            revision={revision}
            split={split}
            wrap={wrap}
            onStage={stage}
            stageDisabled={stageDisabled}
            t={t}
            locale={locale}
          />
        </div>
      </section>
    )
  }

  /** Render the flat row list as nested row groups. */
  const renderRows = () => {
    const renderRange = (from, to) => {
      const elements = []
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
      role="region"
      tabIndex={-1}
      aria-label={t('tree.label')}
      data-zone="tree"
      onClick={onTreeClick}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      {before}
      {renderRows()}
    </div>
  )
}
