/**
 * The motion between the timeline and the tiled layout. The current column
 * follows the timeline; the other columns follow their overview rows (or the
 * panel's left edge). On exit inert copies of those columns fade as they move,
 * and the detail pane returns from the right. Reduced motion skips it all.
 */

/** Stagger between columns, capped so the last ones do not wait indefinitely. */
const STAGGER_MS = 26
const STAGGER_MAX = 16
const MOVE_MS = 520
const EASE = 'cubic-bezier(.2,.7,.2,1)'
const EDGE_OFFSET = 24
const EXIT_MS = 300

const stagger = (index: number) => Math.min(index, STAGGER_MAX) * STAGGER_MS
const translate = (x: number, y: number) => `translate(${x}px, ${y}px)`

/** Whether the system asks for reduced motion. */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The boxes of the elements carrying `data-repository`, by repository.
 * @param root - the panel root.
 * @param selector - which elements.
 * @returns each element's box.
 */
export function repositoryRects(root: HTMLElement | null, selector: string): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>()
  for (const element of root?.querySelectorAll<HTMLElement>(selector) ?? []) {
    const path = element.dataset.repository
    if (path !== undefined && path !== '') rects.set(path, element.getBoundingClientRect())
  }
  return rects
}

/**
 * Move each named column from its timeline or overview box; without a box,
 * start just outside the left edge, at the height of the arriving column.
 */
export function enterTiles(root: HTMLElement | null, before: ReadonlyMap<string, DOMRect>): void {
  if (root === null || reducedMotion()) return
  const leftEdge = root.getBoundingClientRect().left - EDGE_OFFSET
  const columns = tileElements(root).map(column => ({ column, after: column.getBoundingClientRect() }))
  columns.forEach(({ column, after }, index) => {
    const start = before.get(column.dataset.repository ?? '')
    moveFrom(column, after, start ?? { left: leftEdge, top: after.top }, start === undefined ? 0 : 0.55, stagger(index))
  })
}

function moveFrom(element: HTMLElement, after: DOMRect, start: Pick<DOMRect, 'left' | 'top'>, opacity: number, delay: number): void {
  element.animate?.([
    { transform: translate(start.left - after.left, start.top - after.top), opacity },
    { transform: 'none', opacity: 1 },
  ], { duration: MOVE_MS, delay, easing: EASE, fill: 'backwards' })
}

function tileElements(root: ParentNode | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('.vcs-tile-column[data-repository]') ?? [])
    .filter(element => Boolean(element.dataset.repository))
}

/** A tile's content and position before React removes the tiled layout. */
export interface LeavingTile {
  path: string
  box: DOMRect
  copy: HTMLElement
}

export function copyTiles(root: HTMLElement | null, boxes: ReadonlyMap<string, DOMRect>): LeavingTile[] {
  return tileElements(root).flatMap(column => {
    const path = column.dataset.repository as string
    const box = boxes.get(path)
    return box === undefined ? [] : [{ path, box, copy: column.cloneNode(true) as HTMLElement }]
  })
}

/** Restore the timeline from its column and send the other copies toward the overview. */
export function leaveTiles(
  root: HTMLElement | null, tiles: readonly LeavingTile[], current: string | null, rows: ReadonlyMap<string, DOMRect>,
): void {
  if (root === null || reducedMotion()) return
  const frame = root.getBoundingClientRect()
  const timeline = root.querySelector<HTMLElement>('.vcs-sidebar')
  const source = tiles.find(tile => tile.path === current)
  if (source !== undefined && timeline !== null) moveFrom(timeline, timeline.getBoundingClientRect(), source.box, 0.55, 0)
  tiles.filter(tile => tile.path !== current).forEach(({ path, box, copy }, index) => {
    const row = rows.get(path)
    const x = (row?.left ?? frame.left - EDGE_OFFSET) - box.left
    const y = row === undefined ? 0 : row.top - box.top
    fadeGhost(root, copy, frame, box, x, y, stagger(index), '5')
  })
}

/** Remove copies left by a transition interrupted by another layout change. */
export function clearMotionGhosts(root: HTMLElement | null): void {
  root?.querySelectorAll('.vcs-motion-ghost').forEach(ghost => { ghost.remove() })
}

/**
 * Leave a copy of an element fading out where it stood while the layout changes.
 * @param root - the panel root, which positions the copy.
 * @param element - the element leaving, such as the detail pane.
 */
export function fadeOutInPlace(root: HTMLElement | null, element: HTMLElement | null): void {
  if (root === null || element === null || reducedMotion() || typeof element.animate !== 'function') return
  const frame = root.getBoundingClientRect()
  const box = element.getBoundingClientRect()
  fadeGhost(root, element.cloneNode(true) as HTMLElement, frame, box, 48, 0, 0, '3')
}

function fadeGhost(
  root: HTMLElement, ghost: HTMLElement, frame: DOMRect, box: DOMRect, x: number, y: number, delay: number, zIndex: string,
): void {
  if (box.width === 0 || typeof ghost.animate !== 'function') return
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.removeAttribute('data-repository')
  ghost.classList.add('vcs-motion-ghost')
  Object.assign(ghost.style, {
    position: 'absolute', left: `${box.left - frame.left}px`, top: `${box.top - frame.top}px`,
    width: `${box.width}px`, height: `${box.height}px`, pointerEvents: 'none', zIndex, margin: '0',
  })
  root.appendChild(ghost)
  ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: translate(x, y) }],
    { duration: EXIT_MS, delay, easing: 'ease-in', fill: 'both' })
    .finished.catch(() => {}).finally(() => { ghost.remove() })
}

/**
 * Bring an element back in from the side after the layout returned.
 * @param element - the element returning, such as the detail pane.
 */
export function slideIn(element: HTMLElement | null): void {
  if (element === null || reducedMotion() || typeof element.animate !== 'function') return
  element.animate([{ opacity: 0, transform: 'translateX(32px)' }, { opacity: 1, transform: 'none' }],
    { duration: 320, delay: 140, easing: EASE, fill: 'backwards' })
}
