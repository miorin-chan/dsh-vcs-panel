/**
 * Shared floating-menu dismissal, blur-exit, and roving keyboard navigation
 * used by the header pickers and the shared actions menu.
 */

import { useEffect } from 'react'
import type { FocusEvent, KeyboardEvent, RefObject } from 'react'

/** Keys a floating menu consumes so the panel's movement keys stay outside. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'])

/** The refs, dismissal rules, and callbacks one floating menu uses. */
export interface FloatingMenuOptions {
  /** Whether the menu is open; a closed menu installs no listeners. */
  open: boolean
  /** The menu element itself. */
  menuRef: RefObject<HTMLElement>
  /** The trigger that opens it; a click inside the trigger does not dismiss. */
  triggerRef?: RefObject<HTMLElement>
  /** Selector matching the menu's focusable items. */
  itemSelector: string
  /** Close the menu, restoring focus only when the user cancelled with Escape. */
  onClose: (restoreFocus: boolean) => void
  /** Whether an external scroll dismisses the menu. */
  dismissOnScroll?: boolean
}

/** The keyboard and blur handlers a floating menu attaches to its element. */
export interface FloatingMenuHandlers {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onBlur: (event: FocusEvent<HTMLElement>) => void
}

/**
 * Manage outside-click/resize/external-scroll dismissal, Tab blur exit, and
 * roving keyboard navigation for one floating menu.
 *
 * Scrolling inside `menuRef` itself is ignored so overflowing menus can scroll
 * via mouse wheel or Arrow keys without closing themselves.
 *
 * @param options - menu refs and dismissal rules.
 * @returns keyboard and blur handlers.
 */
export function useFloatingMenu({
  open, menuRef, triggerRef, itemSelector, onClose, dismissOnScroll = true,
}: FloatingMenuOptions): FloatingMenuHandlers {
  useEffect(() => {
    if (!open) return undefined
    const hasDocument = typeof document !== 'undefined'
    const hasWindow = typeof window !== 'undefined'
    const dismiss = (event: Event) => {
      // A real pointer or scroll event targets a Node; the DOM typings only
      // promise an EventTarget.
      const target = event.target as Node | null
      if (menuRef.current?.contains?.(target)) return
      if (triggerRef?.current?.contains?.(target)) return
      onClose(false)
    }
    const onResize = () => { onClose(false) }
    const onScroll = (event: Event) => {
      // Scrolling inside an overflowing menu must not dismiss itself.
      const target = event.target as Node | null
      if (menuRef.current?.contains?.(target)) return
      onClose(false)
    }
    if (hasDocument) document.addEventListener('pointerdown', dismiss, true)
    if (hasWindow) {
      window.addEventListener('resize', onResize)
      if (dismissOnScroll) window.addEventListener('scroll', onScroll, true)
    }
    return () => {
      if (hasDocument) document.removeEventListener('pointerdown', dismiss, true)
      if (hasWindow) {
        window.removeEventListener('resize', onResize)
        if (dismissOnScroll) window.removeEventListener('scroll', onScroll, true)
      }
    }
  }, [dismissOnScroll, menuRef, onClose, open, triggerRef])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!MENU_KEYS.has(event.key)) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
      return
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const active = typeof document === 'undefined' ? null : document.activeElement
    const index = active === null ? -1 : items.findIndex(item => item === active)
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
    else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!open) return
    if (event.relatedTarget !== null && event.relatedTarget !== undefined
      && event.currentTarget?.contains?.(event.relatedTarget as Node)) {
      return
    }
    onClose(false)
  }

  return { onKeyDown, onBlur }
}
