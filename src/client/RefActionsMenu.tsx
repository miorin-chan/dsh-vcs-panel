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
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import { branchActionMeta, isDestructiveAction } from './branch.js'
import type { BranchActionMeta } from './branch.js'
import { commitActionMeta, isDestructiveCommitAction } from './commit.js'
import type { CommitActionMeta } from './commit.js'
import { tagActionMeta } from './tag.js'
import type { TagActionMeta } from './tag.js'
import type { RefMenuTarget } from './useRepoActions.js'
import { useFloatingMenu } from './useFloatingMenu.js'

/** Fallback menu dimensions before DOM measurement (used in headless harnesses). */
const MENU_WIDTH = 252
const ITEM_HEIGHT = 28
const EXTRA_HEIGHT = 72
const MARGIN = 8

/** Descriptor metadata of any one action of any one target kind. */
type AnyActionMeta = CommitActionMeta | TagActionMeta | BranchActionMeta

/** Look up descriptor metadata for one action of one target kind. */
function actionMeta(kind: RefMenuTarget['kind'], action: string): AnyActionMeta | undefined {
  if (kind === 'commit') return commitActionMeta(action)
  if (kind === 'tag') return tagActionMeta(action)
  return branchActionMeta(action)
}

/** The fixed position the menu opens at. */
interface MenuPosition {
  left: number
  top: number
}

/** The measured or estimated menu box. */
interface MenuSize {
  width: number
  height: number
}

/** The pointer origin the menu opens from. */
interface MenuPoint {
  x: number
  y: number
}

/**
 * Keep one menu inside the viewport.
 * @param point - the opening point.
 * @param size - measured or estimated menu size.
 * @returns the fixed position.
 */
function menuPosition(point: MenuPoint, size: MenuSize): MenuPosition {
  if (typeof window === 'undefined') return { left: point.x, top: point.y }
  return {
    left: Math.max(MARGIN, Math.min(point.x, window.innerWidth - size.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(point.y, window.innerHeight - size.height - MARGIN)),
  }
}

/** The localized row label for one action of one target kind. */
function actionLabel(target: RefMenuTarget, action: string, t: Translate): string {
  if (target.kind === 'branch' && action === 'merge') {
    return t('branch.merge', { branch: target.name })
  }
  if (target.kind === 'branch' && action === 'rebase') {
    return t('branch.rebase', { branch: target.name })
  }
  const key = actionMeta(target.kind, action)?.labelKey
  return key === undefined ? action : t(key)
}

/** Target, busy state, and callbacks of the open actions menu. */
export interface RefActionsMenuProps {
  target: RefMenuTarget | null
  busy: boolean
  t: Translate
  onChoose: (action: string) => void
  onClose: (restoreFocus: boolean) => void
}

/** One measured menu box, tagged with the target it was measured for. */
interface MeasuredMenu {
  target: RefMenuTarget
  width: number
  height: number
}

/**
 * Render the open ref or commit actions menu.
 * @param props - target, busy state, and callbacks.
 */
export function RefActionsMenu({ target, busy, t, onChoose, onClose }: RefActionsMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [measured, setMeasured] = useState<MeasuredMenu | null>(null)

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
      menuRef.current?.querySelector<HTMLElement>('[data-ops-item]')?.focus()
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
        // A pointer event's target is an Element; the DOM typings only promise
        // an EventTarget. A non-element target also has no button ancestor.
        const source = event.target as Element | null
        if (!source?.closest?.('button')) event.preventDefault()
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
