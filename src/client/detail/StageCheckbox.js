import { createElement as h } from 'react'

/** A Git index state whose action is applied by the Host before the state changes. */
export function StageCheckbox({ checked, disabled, label, onToggle, className = '', ...props }) {
  return h('button', {
    ...props,
    type: 'button',
    role: 'checkbox',
    className: `vcs-stage-checkbox ${className}`,
    'aria-checked': checked,
    'aria-disabled': disabled || undefined,
    'aria-label': label,
    title: label,
    onClick: event => {
      event.stopPropagation()
      if (disabled) return
      event.currentTarget.focus({ preventScroll: true })
      void onToggle(event.currentTarget)
    },
  }, h('span', { className: 'vcs-stage-mark', 'aria-hidden': 'true' }))
}
