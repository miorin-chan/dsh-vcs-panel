import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { RepositoryRow } from './TopBar.jsx'
import { Chevron } from './ui.jsx'

interface RepositoryTimelinesProps {
  repositories: readonly RepositoryRow[]
  current: string
  expanded: readonly string[]
  onToggle: (path: string) => void
  renderTimeline: (entry: RepositoryRow, active: boolean) => ReactNode
  t: Translate
}

export function RepositoryTimelines({ repositories, current, expanded, onToggle, renderTimeline, t }: RepositoryTimelinesProps) {
  const groupsRef = useRef<HTMLDivElement | null>(null)

  function moveGroup(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return
    const headers = Array.from(groupsRef.current?.querySelectorAll<HTMLButtonElement>('.vcs-repository-group-header') ?? [])
    const index = headers.indexOf(event.currentTarget)
    if (index < 0) return
    event.preventDefault()
    const next = key === 'Home' ? 0 : key === 'End' ? headers.length - 1
      : Math.max(0, Math.min(headers.length - 1, index + (key === 'ArrowDown' ? 1 : -1)))
    headers[next]?.focus()
  }

  return (
    <div className="vcs-repository-groups" aria-label={t('repositories.scope')} role="group" ref={groupsRef}>
      {repositories.map(entry => {
        const active = entry.path === current
        const open = expanded.includes(entry.path)
        const showPath = repositories.some(other => other.path !== entry.path && other.name === entry.name)
        return (
          <section className="vcs-repository-group" data-active={active || undefined} data-open={open || undefined} key={entry.path}>
            <button
              type="button"
              className="vcs-menu-item vcs-repository-group-header"
              data-zone="timeline"
              aria-expanded={open}
              aria-current={active || undefined}
              title={entry.path}
              onKeyDown={moveGroup}
              onMouseDown={event => { event.stopPropagation() }}
              onClick={event => {
                event.stopPropagation()
                event.currentTarget.focus({ preventScroll: true })
                onToggle(entry.path)
              }}
            >
              <Chevron open={open} />
              <span className="vcs-menu-item-name">
                {entry.name}
                {showPath ? <small>{entry.path}</small> : null}
              </span>
              {active ? <span className="vcs-worktree-current">{t('repositories.current')}</span> : null}
            </button>
            {open ? renderTimeline(entry, active) : null}
          </section>
        )
      })}
    </div>
  )
}
