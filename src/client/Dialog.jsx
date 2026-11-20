/**
 * The modal shell shared by branch and tag action dialogs.
 *
 * It sits over the panel, labels itself with the caller's heading, moves focus
 * to the marked control on mount, keeps Tab inside, and closes on Escape or a
 * backdrop press unless a write is already running. The caller supplies the
 * heading, body, and buttons; this component owns only the focus, dismissal,
 * and form semantics those dialogs share.
 */

import { useEffect, useRef } from 'react'

/** Elements a Tab press may land on inside the dialog. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Render one modal dialog.
 * @param {{ titleId: string, busy: boolean, onCancel: Function, onSubmit: Function, children: unknown, className?: string }} props - dialog identity and handlers.
 */
export function Dialog({ titleId, busy, onCancel, onSubmit, children, className = '' }) {
  const rootRef = useRef(null)

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const target = root.querySelector('[data-autofocus]') ?? root.querySelector(FOCUSABLE)
    target?.focus()
    if (target?.tagName === 'INPUT') target.select()
  }, [])

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const items = Array.from(rootRef.current?.querySelectorAll(FOCUSABLE) ?? [])
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement)
    if (event.shiftKey && index <= 0) {
      event.preventDefault()
      items[items.length - 1]?.focus()
    } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
      event.preventDefault()
      items[0]?.focus()
    }
  }

  return (
    <div
      className="vcs-dialog-layer"
      onPointerDown={event => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
      onKeyDown={onKeyDown}
    >
      <form
        ref={rootRef}
        className={className ? `vcs-dialog ${className}` : 'vcs-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={event => {
          event.preventDefault()
          if (!busy) onSubmit()
        }}
      >
        {children}
      </form>
    </div>
  )
}
