import { createElement as h } from 'react'
import type { StageDirection } from './stage.js'

/** Props of the staging command in one row's gutter. */
export interface StageActionProps {
  direction: StageDirection
  partial?: boolean
  disabled?: boolean
  label: string
  onRun: () => void | Promise<unknown>
  className?: string
}

/**
 * A staging command in the tree's gutter. The group names the state, so the
 * command only shows on the row being pointed at or focused; a partly staged
 * file keeps a half-filled mark there until then.
 */
export function StageAction({ direction, partial = false, disabled, label, onRun, className = '' }: StageActionProps) {
  return h('button', {
    type: 'button',
    className: `vcs-stage-action ${className}`,
    'data-stage-direction': direction,
    'data-partial': partial ? '' : undefined,
    'aria-label': label,
    'aria-disabled': disabled || undefined,
    title: label,
    tabIndex: -1,
    onClick: event => {
      event.stopPropagation()
      if (disabled) return
      void onRun()
    },
  },
  partial ? h('span', { className: 'vcs-stage-partial', 'aria-hidden': 'true' }) : null,
  h('svg', { className: 'vcs-stage-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'aria-hidden': 'true' },
    h('path', { d: direction === 'stage' ? 'M8 3.5v9M3.5 8h9' : 'M3.5 8h9', strokeWidth: 1.5, strokeLinecap: 'round' })))
}
