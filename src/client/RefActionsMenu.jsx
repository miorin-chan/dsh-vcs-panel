/**
 * The ref and commit actions menu, shared by the header's branch control,
 * the local/remote branch and tag ref badges in the timeline and detail
 * toolbar, and the commit rows in the timeline.
 *
 * The caller names the target, its kind, its actionable entries, optional
 * per-action disable reasons, and where it opened; this component places,
 * measures, paints, and keys the menu, and reports how it closed so focus can
 * return to the control that opened it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { BRANCH_ACTION_META, isDestructiveAction } from './branch.js'
import { COMMIT_ACTION_META, isDestructiveCommitAction } from './commit.js'
import { TAG_ACTION_META } from './tag.js'
import { useFloatingMenu } from './useFloatingMenu.js'

/** Fallback menu dimensions before DOM measurement (used in headless harnesses). */
const MENU_WIDTH = 252
const ITEM_HEIGHT = 28
const EXTRA_HEIGHT = 72
const MARGIN = 8

/** Look up descriptor metadata for one action of one target kind. */
function actionMeta(kind, action) {
  if (kind === 'commit') return COMMIT_ACTION_META[action]
  if (kind === 'tag') return TAG_ACTION_META[action]
  return BRANCH_ACTION_META[action]
}

/**
 * Keep one menu inside the viewport.
 * @param {{ x: number, y: number }} point - the opening point.
 * @param {{ width: number, height: number }} size - measured or estimated menu size.
 * @returns {{ left: number, top: number }} the fixed position.
 */
function menuPosition(point, size) {
  if (typeof window === 'undefined') return { left: point.x, top: point.y }
  return {
    left: Math.max(MARGIN, Math.min(point.x, window.innerWidth - size.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(point.y, window.innerHeight - size.height - MARGIN)),
  }
}

/** The localized row label for one action of one target kind. */
function actionLabel(target, action, t) {
  if (target.kind === 'branch' && action === 'merge') {
    return t('branch.merge', { branch: target.name })
  }
  if (target.kind === 'branch' && action === 'rebase') {
    return t('branch.rebase', { branch: target.name })
  }
  const key = actionMeta(target.kind, action)?.labelKey
  return key === undefined ? action : t(key)
}

/**
 * Render the open ref or commit actions menu.
 * @param {{ target: { kind: 'branch' | 'remote' | 'tag' | 'commit', name: string, detail?: string, current?: boolean, actions: string[], disabledActions?: Record<string, string>, x: number, y: number } | null, busy: boolean, t: Function, onChoose: Function, onClose: (restoreFocus: boolean) => void }} props - target, busy state, and callbacks.
 */
export function RefActionsMenu({ target, busy, t, onChoose, onClose }) {
  const menuRef = useRef(null)
  const [measured, setMeasured] = useState(null)

  const { onKeyDown, onBlur } = useFloatingMenu({
    open: target !== null,
    menuRef,
    itemSelector: '[data-ops-item]',
    onClose,
  })

  // Measure actual rendered size so clamping stays exact across font sizes and separators.
  useLayoutEffect(() => {
    if (target === null) {
      setMeasured(null)
      return
    }
    const element = menuRef.current
    if (element === null) return
    const width = element.offsetWidth ?? 0
    const height = element.offsetHeight ?? 0
    if (width > 0 && height > 0) setMeasured({ target, width, height })
  }, [target])

  // Move focus into the menu once it appears.
  useEffect(() => {
    if (target === null) return undefined
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector('[data-ops-item]')?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [target])

  if (target === null) return null

  const size = measured?.target === target
    ? measured
    : { width: MENU_WIDTH, height: target.actions.length * ITEM_HEIGHT + EXTRA_HEIGHT }
  const position = menuPosition(target, size)
  const menuLabel = target.kind === 'commit'
    ? t('commit.menuLabel', { sha: target.name })
    : target.kind === 'tag'
      ? t('tag.menuLabel', { tag: target.name })
      : t('branch.menuLabel', { branch: target.name })

  return (
    <div
      ref={menuRef}
      className="vcs-ref-ops"
      role="menu"
      aria-label={menuLabel}
      data-ref-kind={target.kind}
      tabIndex={-1}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onMouseDown={event => {
        if (!event.target?.closest?.('button')) event.preventDefault()
      }}
    >
      <p className="vcs-ref-ops-title">
        <span className="vcs-ref-ops-name">{target.name}</span>
        {target.kind === 'commit' && target.detail ? (
          <span className="vcs-ref-ops-detail" title={target.detail}>{target.detail}</span>
        ) : null}
        {target.kind === 'branch' && target.current ? <span className="vcs-ref-ops-current">{t('branch.current')}</span> : null}
        {target.kind === 'remote' ? <span className="vcs-ref-ops-remote">{t('branch.remoteTag')}</span> : null}
      </p>
      {target.actions.map((action, index) => {
        const label = actionLabel(target, action, t)
        const group = actionMeta(target.kind, action)?.group
        const previousGroup = index > 0 ? actionMeta(target.kind, target.actions[index - 1])?.group : group
        const separated = index > 0 && group !== previousGroup
        const destructive = target.kind === 'commit'
          ? isDestructiveCommitAction(action)
          : isDestructiveAction(action)
        const disabledReason = target.disabledActions?.[action]
        const disabled = busy || disabledReason !== undefined
        return (
          <div key={action}>
            {separated ? <div className="vcs-ref-ops-sep" role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`vcs-menu-item vcs-ref-ops-item${destructive ? ' vcs-ref-ops-danger' : ''}`}
              data-ops-item=""
              aria-disabled={disabled ? 'true' : undefined}
              title={disabledReason ?? label}
              onClick={() => { if (!disabled) onChoose(action) }}
            >
              <span className="vcs-menu-item-name">{label}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
