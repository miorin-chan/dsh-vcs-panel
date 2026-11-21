import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { RepositoryRow } from './TopBar.jsx'
import { Chevron } from './ui.jsx'

interface RepositoryTimelinesProps {
  repositories: readonly RepositoryRow[]
  current: string
  onActivate: (entry: RepositoryRow) => void
  children: ReactNode
  t: Translate
}

/** One expanded timeline keeps the graph, detail, and operations on the same repository. */
export function RepositoryTimelines({ repositories, current, onActivate, children, t }: RepositoryTimelinesProps) {
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const currentHeaderRef = useRef<HTMLButtonElement | null>(null)
  const grouped = repositories.length > 1

  useLayoutEffect(() => {
    const groups = groupsRef.current
    const header = currentHeaderRef.current
    if (groups !== null && header !== null) groups.scrollTop = header.offsetTop
  }, [current, grouped])

  if (!grouped) return children

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
        const showPath = repositories.some(other => other.path !== entry.path && other.name === entry.name)
        return (
          <section className="vcs-repository-group" data-active={active || undefined} key={entry.path}>
            <button
              type="button"
              className="vcs-menu-item vcs-repository-group-header"
              data-zone="timeline"
              ref={active ? currentHeaderRef : undefined}
              aria-expanded={active}
              aria-disabled={active || undefined}
              tabIndex={active ? 0 : -1}
              title={entry.path}
              onKeyDown={moveGroup}
              onMouseDown={event => { event.stopPropagation() }}
              onClick={event => {
                event.stopPropagation()
                if (!active) onActivate(entry)
              }}
            >
              <Chevron open={active} />
              <span className="vcs-menu-item-name">
                {entry.name}
                {showPath ? <small>{entry.path}</small> : null}
              </span>
              {active ? <span className="vcs-worktree-current">{t('repositories.current')}</span> : null}
            </button>
            {active ? children : null}
          </section>
        )
      })}
    </div>
  )
}
