/** The scroll window, roving focus, and movement keys shared by both timelines. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { DOWN, FORWARD, isDiscreteActionButton, isEditableTarget, movement, unmodified, UP } from '../keys.js'
import { RENDER_BUFFER_ROWS } from './Graph.jsx'
import { DEFAULT_ROW_HEIGHT as ROW_HEIGHT } from './layout.js'

/** The keyboard event fields both DOM and React events carry. */
export interface TimelineKeyEvent {
  key: string
  isComposing?: boolean
  shiftKey: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  target: EventTarget | null
  preventDefault(): void
  getModifierState?: ((...args: never[]) => boolean)
}

export interface TimelineControl {
  restoreFocus: () => boolean
  handleKeyDown: (event: TimelineKeyEvent) => boolean
}

interface AnchorRows {
  rows: readonly { key: string }[]
  rowIndex: ReadonlyMap<string, number>
}

interface TimelineNavigationOptions {
  rowCount: number
  focusRow: number
  selectedRow: number
  /** Allow saved scroll to restore once the rows it describes have loaded. */
  readyToRestore: boolean
  initialScrollTop: number
  onScrollOffset?: (top: number) => void
  onMove: (delta: number) => void
  onOpen: () => void
  control?: { current: TimelineControl | null }
  /** A changing row model can preserve the first visible row by key. */
  anchors?: AnchorRows
  /** With anchors, only explicit moves request scrolling to the selection. */
  scrollRequest?: number
  topInset?: number
  unshifted?: boolean
  onKey?: (event: TimelineKeyEvent) => boolean
}

export function useTimelineNavigation({
  rowCount, focusRow, selectedRow, readyToRestore, initialScrollTop, onScrollOffset,
  onMove, onOpen, control, anchors, scrollRequest, topInset = 0, unshifted = false, onKey,
}: TimelineNavigationOptions) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const latestTop = useRef(0)
  const restoreRef = useRef<number | null>(initialScrollTop)
  const previousRows = useRef<AnchorRows>()
  const onScrollOffsetRef = useRef(onScrollOffset)
  onScrollOffsetRef.current = onScrollOffset
  const selectedRef = useRef(selectedRow)
  selectedRef.current = selectedRow
  const recordScroll = useCallback((top: number) => {
    latestTop.current = top
    setScrollTop(top)
    onScrollOffsetRef.current?.(top)
  }, [])
  const setScroll = useCallback((element: HTMLDivElement, top: number) => {
    element.scrollTop = top
    recordScroll(element.scrollTop)
  }, [recordScroll])
  const onScroll = (event: UIEvent<HTMLDivElement>) => { recordScroll(event.currentTarget.scrollTop) }

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

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || restoreRef.current === null || !readyToRestore) return
    setScroll(element, restoreRef.current)
    restoreRef.current = null
  }, [readyToRestore, setScroll])

  useLayoutEffect(() => {
    const previous = previousRows.current
    previousRows.current = anchors
    const element = scrollRef.current
    if (anchors === undefined || previous === undefined || element === null || restoreRef.current !== null) return
    const top = latestTop.current
    const index = Math.floor(top / ROW_HEIGHT)
    const first = previous.rows[index]
    const next = first === undefined ? undefined : anchors.rowIndex.get(first.key)
    if (next !== undefined) setScroll(element, top + (next - index) * ROW_HEIGHT)
    else recordScroll(element.scrollTop)
  }, [anchors, recordScroll, setScroll])

  const follow = scrollRequest ?? selectedRow
  useLayoutEffect(() => {
    const element = scrollRef.current
    const selected = selectedRef.current
    if (element === null || selected < 0 || element.clientHeight <= 0) return
    const top = selected * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    let nextTop = element.scrollTop
    if (top < element.scrollTop + topInset) nextTop = Math.max(0, top - topInset)
    else if (bottom > element.scrollTop + element.clientHeight) nextTop = Math.max(0, bottom - element.clientHeight)
    if (nextTop !== element.scrollTop) setScroll(element, nextTop)
  }, [follow, setScroll, topInset])

  const visibleFirst = Math.floor(scrollTop / ROW_HEIGHT)
  const first = Math.max(0, visibleFirst - RENDER_BUFFER_ROWS)
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + RENDER_BUFFER_ROWS)
  const indices: number[] = []
  if (focusRow >= 0 && focusRow < first) indices.push(focusRow)
  for (let index = first; index < last; index += 1) indices.push(index)
  if (focusRow >= last && focusRow < rowCount) indices.push(focusRow)
  const pageStep = Math.max(1, Math.floor((viewport > 0 ? viewport : ROW_HEIGHT * 8) / ROW_HEIGHT) - 1)

  const runKeyDown = useCallback((event: TimelineKeyEvent) => {
    if (!unmodified(event) || (unshifted && event.shiftKey)) return false
    if (event.isComposing === true || isEditableTarget(event.target)) return false
    if (event.key === 'Enter' && isDiscreteActionButton(event.target, scrollRef.current)) return false
    const direction = movement(event)
    const delta = direction === DOWN ? 1 : direction === UP ? -1
      : event.key === 'PageDown' ? pageStep : event.key === 'PageUp' ? -pageStep
        : event.key === 'Home' ? -Math.max(1, rowCount) : event.key === 'End' ? Math.max(1, rowCount) : 0
    if (delta !== 0) {
      event.preventDefault()
      onMove(delta)
      return true
    }
    if (direction === FORWARD || event.key === 'Enter') {
      event.preventDefault()
      onOpen()
      return true
    }
    return onKey?.(event) === true
  }, [onKey, onMove, onOpen, pageStep, rowCount, unshifted])

  const restoreFocus = useCallback(() => {
    const scroll = scrollRef.current
    if (scroll === null) return false
    const target = scroll.querySelector<HTMLElement>(`[data-timeline-index="${focusRow}"]`) ?? scroll
    target.focus({ preventScroll: true })
    return true
  }, [focusRow])

  useLayoutEffect(() => {
    if (control === undefined || control === null) return undefined
    control.current = {
      restoreFocus,
      handleKeyDown(event) {
        if (!runKeyDown(event)) return false
        const active = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
        if (active?.dataset?.timelineIndex === undefined || !scrollRef.current?.contains(active)) restoreFocus()
        return true
      },
    }
    return () => { control.current = null }
  }, [control, restoreFocus, runKeyDown])

  return { scrollRef, scrollTop, viewport, visibleFirst, indices, onScroll, onKeyDown: runKeyDown }
}
