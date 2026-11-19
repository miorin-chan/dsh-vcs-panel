import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useFloatingMenu } from '../useFloatingMenu.js'

/** The additional whole-file action for a mixed checkbox. */
export function FileStageMenu({ path, disabled, onUnstage, t }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const itemRef = useRef(null)
  const close = useCallback(restore => {
    setOpen(false)
    if (restore) triggerRef.current?.focus({ preventScroll: true })
  }, [])
  const { onKeyDown, onBlur } = useFloatingMenu({ open, menuRef, triggerRef, itemSelector: '[role="menuitem"]', onClose: close })
  useLayoutEffect(() => {
    if (open) itemRef.current?.focus({ preventScroll: true })
  }, [open])
  const label = `${t('stage.fileActions')} · ${path}`
  return (
    <span className="vcs-file-stage-menu">
      <button
        type="button"
        ref={triggerRef}
        className="vcs-icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        title={label}
        onClick={event => {
          event.stopPropagation()
          if (!disabled) setOpen(value => !value)
        }}
      >
        <svg className="vcs-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12.5" cy="8" r="1" />
        </svg>
      </button>
      {open ? (
        <span ref={menuRef} className="vcs-file-stage-popup" role="menu" aria-label={label} onKeyDown={onKeyDown} onBlur={event => {
          if (event.relatedTarget !== triggerRef.current) onBlur(event)
        }}>
          <button
            type="button"
            ref={itemRef}
            className="vcs-menu-item"
            role="menuitem"
            aria-disabled={disabled || undefined}
            onClick={event => {
              event.stopPropagation()
              if (disabled) return
              close(false)
              onUnstage()
            }}
          >
            {t('stage.unstageAllFileChanges')}
          </button>
        </span>
      ) : null}
    </span>
  )
}
