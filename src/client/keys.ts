/**
 * The panel's movement keys.
 *
 * The timeline and the change tree share one vocabulary: up/down or `k`/`j`
 * move through one vertical list, left/right or `h`/`l` move between panes or
 * into a row, and brackets move between tree rows. Each zone decides what a
 * direction means; command modifiers keep the key's usual meaning.
 */

/** Directions a movement key can ask for. */
export const UP = 'up'
export const DOWN = 'down'
export const BACK = 'back'
export const FORWARD = 'forward'

/** Key names by direction. */
const DIRECTIONS = new Map<string, string>([
  ['ArrowUp', UP],
  ['k', UP],
  ['ArrowDown', DOWN],
  ['j', DOWN],
  ['ArrowLeft', BACK],
  ['h', BACK],
  ['ArrowRight', FORWARD],
  ['l', FORWARD],
])

/** Keys that move to the next or previous row of the change tree. */
const ROW_NEXT = ']'
const ROW_PREV = '['

/** The attributes surface a real element or a test stub may expose. */
interface AttributeMapLike {
  has?(name: string): boolean
  get?(name: string): string | null
}

/** The document surface the focus helpers inspect. */
export interface DocumentLike {
  readonly activeElement?: ElementLike | null
  readonly body?: ElementLike | null
  readonly documentElement?: ElementLike | null
  hasFocus?(): boolean
}

/**
 * The subset of DOM element behavior the panel's keyboard helpers read.
 *
 * Real elements and the test stubs driven through these helpers both carry
 * these members; every optional member is checked before use.
 */
export interface ElementLike {
  readonly tagName?: string
  readonly isContentEditable?: boolean
  readonly classList?: {
    contains?(token: string): boolean
  }
  readonly dataset?: {
    readonly [name: string]: string | undefined
  }
  /** Real elements carry a NamedNodeMap; test stubs carry their own map. */
  readonly attributes?: unknown
  readonly parentElement?: ElementLike | null
  readonly offsetTop?: number
  readonly offsetParent?: ElementLike | null
  readonly ownerDocument?: DocumentLike | null
  getAttribute?(name: string): string | null
  hasAttribute?(name: string): boolean
  contains?(node: unknown): boolean
  querySelector?(selector: string): ElementLike | null
  querySelectorAll?(selector: string): ArrayLike<ElementLike> & Iterable<ElementLike>
  focus?(options?: FocusOptions): void
}

/**
 * Narrow one value to the element surface these helpers read.
 *
 * The helpers accept `unknown` because callers hand them `event.target` and
 * test stubs; a non-object value can carry none of the members, so it reads as
 * absent. The cast is the duck-typed boundary of this module.
 */
function elementOf(value: unknown): ElementLike | null {
  return value !== null && typeof value === 'object' ? value as ElementLike : null
}

/** The keyboard event fields the movement helpers read. */
export interface KeyEventLike {
  readonly key: string
  readonly altKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  getModifierState?(key: string): boolean
}

/**
 * Whether the event carries no command modifier. AltGr reports itself as Alt
 * on layouts where the right Alt key composes characters (German, French);
 * the character it produces is what the user asked for, so it still counts as
 * unmodified.
 * @param event - the key event.
 * @returns true when the key has no command modifier.
 */
export function unmodified(event: KeyEventLike): boolean {
  if (event.ctrlKey === true || event.metaKey === true) return false
  if (event.altKey !== true) return true
  return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph') === true
}

/**
 * The direction a key event asks for, or null when it asks for none.
 * @param event - the key event fields that matter.
 * @returns the direction, or null.
 */
export function movement(event: KeyEventLike): string | null {
  if (!unmodified(event)) return null
  return DIRECTIONS.get(event.key) ?? null
}

/**
 * The row step a key event asks for: 1 forward, -1 backward, 0 none.
 * @param event - the key event.
 * @returns the step.
 */
export function rowStep(event: KeyEventLike): number {
  if (!unmodified(event)) return 0
  if (event.key === ROW_NEXT) return 1
  if (event.key === ROW_PREV) return -1
  return 0
}

/**
 * Whether a key event originated in a form control or editable element whose
 * keys belong to text or option input rather than panel navigation.
 * @param target - `event.target`.
 * @returns true when panel keys must leave the event alone.
 */
export function isEditableTarget(target: unknown): boolean {
  const element = elementOf(target)
  if (element === null) return false
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
}

/**
 * Walk `node` and its `parentElement` ancestors until `stop` (exclusive)
 * looking for the nearest node satisfying `predicate`.
 * @param node - starting element.
 * @param stop - ancestor boundary (not visited), or null.
 * @param predicate - match test.
 * @returns the matching ancestor, or null.
 */
export function findAncestor(
  node: unknown,
  stop: unknown,
  predicate: (candidate: ElementLike) => boolean,
): ElementLike | null {
  let current = elementOf(node)
  const boundary = elementOf(stop)
  while (current !== null && current !== boundary) {
    if (predicate(current)) return current
    current = current.parentElement ?? null
  }
  return null
}

/**
 * Whether an element carries CSS class `token` (safe on DOM and test stubs).
 * @param element - candidate element.
 * @param token - class name.
 * @returns true when present.
 */
export function hasClass(element: unknown, token: string): boolean {
  const node = elementOf(element)
  return node?.classList?.contains?.(token) === true
}

/**
 * Whether an element carries attribute `name` (optionally matching `value`).
 * Supports both real DOM Elements and `FakeElement` in tests.
 * @param element - candidate element.
 * @param name - attribute name.
 * @param value - expected value when provided.
 * @returns true when present (and equal to `value`, if given).
 */
export function hasAttr(element: unknown, name: string, value?: string): boolean {
  const node = elementOf(element)
  if (node === null) return false
  if (typeof node.getAttribute === 'function') {
    if (value === undefined) return node.hasAttribute?.(name) ?? (node.getAttribute(name) !== null)
    return node.getAttribute(name) === value
  }
  const attributes = node.attributes
  if (attributes === null || attributes === undefined || typeof attributes !== 'object') return false
  const map = attributes as AttributeMapLike
  if (typeof map.has !== 'function') return false
  if (!map.has(name)) return false
  return value === undefined ? true : map.get?.(name) === value
}

/**
 * Which keyboard navigation zone (`'timeline'` or `'tree'`) contains
 * `element`, stopping before `stop`.
 * @param element - target or focused element.
 * @param stop - panel root boundary.
 * @returns the owning navigation zone.
 */
export function zoneOf(element: unknown, stop: unknown = null): 'timeline' | 'tree' | null {
  const found = findAncestor(element, stop, node => (
    node?.dataset?.zone === 'timeline'
    || node?.dataset?.timelineIndex !== undefined
    || node?.dataset?.zone === 'tree'
    || node?.dataset?.rowKey !== undefined
    || hasAttr(node, 'data-diff-hunk-header')
  ))
  if (found === null) return null
  if (found.dataset?.zone === 'timeline' || found.dataset?.timelineIndex !== undefined) return 'timeline'
  return 'tree'
}

/**
 * Whether `element` is (or sits inside) a cursor stop: a timeline row,
 * a change-tree row, or a diff hunk header.
 * @param element - candidate element.
 * @param stop - panel root boundary.
 * @returns true for navigation stops.
 */
export function isNavigationStop(element: unknown, stop: unknown = null): boolean {
  return findAncestor(element, stop, node => (
    hasClass(node, 'vcs-timeline-row')
    || hasClass(node, 'vcs-tree-row')
    || hasAttr(node, 'data-diff-hunk-header')
  )) !== null
}

/**
 * Whether this element is a panel overlay, which owns its keyboard behavior.
 * @param node - candidate element.
 * @returns true for a dialog layer or a menu.
 */
function isOverlay(node: ElementLike): boolean {
  return hasClass(node, 'vcs-dialog-layer') || hasAttr(node, 'role', 'menu')
}

/** Whether `element` lives inside a panel dialog or floating menu. */
export function isOverlayTarget(element: unknown, stop: unknown = null): boolean {
  return findAncestor(element, stop, isOverlay) !== null
}

/**
 * Whether `element` lives inside a dialog, floating menu, or menu trigger.
 * @param element - candidate element.
 * @param stop - panel root boundary.
 * @returns true for overlay/menu controls.
 */
export function isOverlayOrMenuTarget(element: unknown, stop: unknown = null): boolean {
  return findAncestor(element, stop, node => (
    isOverlay(node) || hasAttr(node, 'aria-haspopup', 'menu')
  )) !== null
}

/**
 * Whether `element` is (or sits inside) a discrete action button inside the
 * panel (such as sync, refresh, split/wrap/fold toggles, SHA copy, parent
 * commit jump, load more, or retry) rather than a navigation row or menu.
 * @param element - candidate element.
 * @param stop - panel root boundary.
 * @returns true for discrete action buttons.
 */
export function isDiscreteActionButton(element: unknown, stop: unknown = null): boolean {
  const button = findAncestor(element, stop, node => (
    typeof node?.tagName === 'string' && node.tagName.toUpperCase() === 'BUTTON'
  ))
  if (button === null) return false
  return !isNavigationStop(element, stop) && !isOverlayOrMenuTarget(element, stop)
}

/**
 * Whether the panel can claim keyboard focus for its active navigation stop
 * when becoming visible or when the browser/app window regains focus, without
 * stealing focus from an external input, modal dialog, or another pane.
 * @param active - current `document.activeElement`.
 * @param root - the panel's `.vcs-root` element.
 * @returns true when claiming focus for VCS navigation is safe.
 */
export function canClaimFocusFrom(active: unknown, root: unknown): boolean {
  const rootNode = elementOf(root)
  if (rootNode === null) return false
  const doc: DocumentLike | null = rootNode.ownerDocument
    ?? (typeof document === 'undefined' ? null : document)
  const isModalNode = (node: ElementLike): boolean => hasAttr(node, 'aria-modal', 'true') || hasAttr(node, 'role', 'dialog')
  const activeModal = findAncestor(active, null, isModalNode)
  if (activeModal !== null && !rootNode.contains?.(activeModal) && !activeModal.contains?.(rootNode)) {
    return false
  }
  const modals = doc?.body?.querySelectorAll?.('[aria-modal="true"]')
  if (modals !== undefined && modals !== null) {
    for (const modal of modals) {
      if (!rootNode.contains?.(modal) && !modal.contains?.(rootNode)) return false
    }
  }
  if (active === null || active === undefined || active === doc?.body || active === doc?.documentElement || active === rootNode) {
    return true
  }
  if (rootNode.contains?.(active)) {
    return !isEditableTarget(active) && !isOverlayOrMenuTarget(active, rootNode)
  }
  if (hasClass(active, 'vcs-turn-banner') || hasAttr(active, 'data-dockkit-pane') || hasAttr(active, 'data-dockkit-float')) {
    return true
  }
  const pane = findAncestor(rootNode, null, node => hasAttr(node, 'data-dockkit-pane') || hasAttr(node, 'data-dockkit-float'))
  if (pane !== null && pane.contains?.(active) && !isEditableTarget(active)) {
    return true
  }
  return false
}
