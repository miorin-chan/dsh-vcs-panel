/**
 * The motion between the stacked and the tiled layout: each repository group
 * moves from where it stood to where it lands (FLIP), staggered by about 26 ms,
 * while the detail pane fades out where it stood. Reduced motion skips it all.
 */

/** Stagger between groups and the most groups that wait for it. */
const STAGGER_MS = 26
const STAGGER_MAX = 16
const MOVE_MS = 520
const EASE = 'cubic-bezier(.2,.7,.2,1)'

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
 * Move each element from its old box to its new one.
 * @param root - the panel root.
 * @param selector - the elements in their new layout.
 * @param before - their boxes before the change.
 */
export function playGroups(root: HTMLElement | null, selector: string, before: ReadonlyMap<string, DOMRect>): void {
  if (root === null || reducedMotion()) return
  const frame = root.getBoundingClientRect()
  const elements = [...root.querySelectorAll<HTMLElement>(selector)]
  elements.forEach((element, index) => {
    if (typeof element.animate !== 'function') return
    const after = element.getBoundingClientRect()
    // Elements far outside the frame would only cost frames.
    if (after.left > frame.right + 60 || after.bottom < frame.top - 60 || after.top > frame.bottom + 60) return
    const delay = Math.min(index, STAGGER_MAX) * STAGGER_MS
    const start = before.get(element.dataset.repository ?? '')
    if (start === undefined) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay, fill: 'backwards' })
      return
    }
    element.animate([
      { transform: `translate(${start.left - after.left}px, ${start.top - after.top}px)`, opacity: 0.55 },
      { transform: 'none', opacity: 1 },
    ], { duration: MOVE_MS, delay, easing: EASE, fill: 'backwards' })
  })
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
  if (box.width === 0) return
  const ghost = element.cloneNode(true) as HTMLElement
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.classList.add('vcs-motion-ghost')
  Object.assign(ghost.style, {
    position: 'absolute', left: `${box.left - frame.left}px`, top: `${box.top - frame.top}px`,
    width: `${box.width}px`, height: `${box.height}px`, pointerEvents: 'none', zIndex: '3', margin: '0',
  })
  root.appendChild(ghost)
  ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(48px)' }], { duration: 300, easing: 'ease-in' })
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
