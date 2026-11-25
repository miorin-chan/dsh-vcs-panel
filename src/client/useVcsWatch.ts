/**
 * Watch one repository's Host invalidation stream and merge the announced
 * domains into one debounced trailing refresh.
 *
 * Reads and writes mark their own domains as in flight; an invalidation for a
 * busy domain waits in `queued` until that domain settles, then the trailing
 * timer runs every runnable domain in one callback.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Api } from './api.js'

/** The invalidation domains the Host announces. */
const DOMAINS: WatchDomain[] = ['working', 'history', 'repositories', 'activity']

/** One invalidation domain. */
export type WatchDomain = 'working' | 'history' | 'repositories' | 'activity'

const DEBOUNCE_MS = 160

/** Invalidation domains queued for one API client and repository scope. */
interface WatchQueue {
  api: Api
  scope: string
  domains: WatchDomain[]
}

/** The latest render's inputs, read by callbacks that outlive one render. */
interface WatchLatest {
  active: boolean
  api: Api
  onRefresh: (domains: WatchDomain[]) => void
  queued: WatchQueue | null
  scope: string
}

/** The panel state and callbacks one watch subscription reads. */
export interface VcsWatchOptions {
  /** The Session-scoped API client. */
  api: Api
  /** The repository the panel shows, or null before one is selected. */
  repo: string | null
  /** The backend id of that repository, part of the stream's scope. */
  vcs: string | null
  /** The selected checkout paths, serialized; part of the stream's scope. */
  pathsKey: string
  /** Whether the panel is visible. */
  visible: boolean
  /** Whether a write or overlay must hold invalidations back. */
  blocked: boolean
  /** Whether a working-tree read is in flight. */
  working: boolean
  /** Whether a history read is in flight. */
  history: boolean
  /** Whether a repository read is in flight. */
  repositories: boolean
  /** Whether an aggregate history read is in flight. */
  activity?: boolean
  /** Run the reads for the domains that settled. */
  onRefresh: (domains: WatchDomain[]) => void
}

/** Merge invalidations while reads or writes are in flight, with one trailing batch. */
export function useVcsWatch({
  api, repo, vcs, pathsKey, visible, blocked, working, history, repositories, activity = false, onRefresh,
}: VcsWatchOptions): void {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible')
  const [queued, setQueued] = useState<WatchQueue | null>(null)
  const latest = useRef<WatchLatest | null>(null)
  const active = visible && documentVisible
  // A backend change reopens the stream so it observes the right metadata.
  const scope = JSON.stringify([repo, vcs, pathsKey])
  const queue = useCallback((domains: readonly unknown[]) => {
    const current = latest.current
    if (current === null || current.api !== api || current.scope !== scope) return
    const affected = DOMAINS.filter(domain => domains.includes(domain))
    if (affected.length === 0) return
    setQueued(previous => {
      const pending = previous?.scope === scope && previous.api === api ? previous.domains : []
      return { api, scope, domains: DOMAINS.filter(domain => pending.includes(domain) || affected.includes(domain)) }
    })
  }, [api, scope])
  latest.current = { active, api, onRefresh, queued, scope }

  useEffect(() => {
    const onVisibility = () => { setDocumentVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  useEffect(() => {
    if (!active) return undefined
    const catchUp = () => { queue(repo === null ? ['repositories'] : DOMAINS) }
    // The view serializes the selected checkout paths for the subscription scope.
    const paths = JSON.parse(pathsKey) as string[]
    const worktrees = paths.length === 1 && paths[0] === repo ? [] : paths
    const close = api.watch(repo, worktrees, catchUp, queue)
    window.addEventListener('focus', catchUp)
    return () => {
      close()
      window.removeEventListener('focus', catchUp)
    }
  }, [active, api, pathsKey, queue, repo, vcs])

  useEffect(() => {
    if (!active || blocked || queued?.api !== api || queued.scope !== scope) return undefined
    const busy: Record<WatchDomain, boolean> = { working, history, repositories, activity }
    const runnable = queued.domains.filter(domain => !busy[domain])
    if (runnable.length === 0) return undefined
    const timer = setTimeout(() => {
      const current = latest.current
      if (current === null || !current.active || document.visibilityState !== 'visible' || current.queued !== queued
        || current.api !== api || current.scope !== scope) return
      const remaining = queued.domains.filter(domain => busy[domain])
      setQueued(previous => previous !== queued ? previous : remaining.length === 0 ? null : { ...queued, domains: remaining })
      current.onRefresh(runnable)
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [active, activity, api, blocked, history, queued, repositories, scope, working])
}
