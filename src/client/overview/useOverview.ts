/**
 * The overview's data: one streamed read of every repository while the
 * overview or the tiled layout is showing, merged line by line so the first
 * repositories draw before the slowest one answers. A refresh keeps the rows on
 * screen and replaces each one as its new line arrives; a background change in
 * the current repository rereads only that repository.
 */

import { useEffect, useRef, useState } from 'react'

import type { Api, ApiFailure, OverviewLine } from '../api.js'
import { failureOf } from '../api.js'
import type { OverviewRepository } from './model.js'

/** One repository the read could not summarize. */
export interface OverviewFailure {
  path: string
  registered: boolean
  code: string
}

/** The overview data and the read around it. */
export interface OverviewData {
  status: 'idle' | 'loading' | 'ready' | 'error'
  cwd: string | null
  repositories: ReadonlyMap<string, OverviewRepository>
  failures: ReadonlyMap<string, OverviewFailure>
  /** Repositories the running read announced and has not answered yet. */
  pending: number
  unlistedTruncated: boolean
  error: ApiFailure | null
}

const EMPTY: OverviewData = Object.freeze({
  status: 'idle',
  cwd: null,
  repositories: new Map(),
  failures: new Map(),
  pending: 0,
  unlistedTruncated: false,
  error: null,
})

/** What decides when the overview reads. */
export interface UseOverviewOptions {
  /** Whether anything on screen needs the overview. */
  active: boolean
  /** Changes when every repository should be read again. */
  reloadKey: string
  /** The current repository and a key that changes when only it should be read again. */
  repo: string | null
  repoKey: string
}

function isAbort(error: unknown): boolean {
  return failureOf(error).name === 'AbortError'
}

/**
 * Read and keep the overview.
 * @param api - the Session's API.
 * @param options - when to read.
 * @returns the data so far.
 */
export function useOverview(api: Api, { active, reloadKey, repo, repoKey }: UseOverviewOptions): OverviewData {
  const [data, setData] = useState<OverviewData>(EMPTY)
  const loadedKey = useRef<string | null>(null)
  const repoKeyRef = useRef(repoKey)

  useEffect(() => {
    if (!active || loadedKey.current === reloadKey) return undefined
    const controller = new AbortController()
    const seen = new Set<string>()
    setData(previous => ({ ...previous, status: 'loading', error: null }))
    const apply = (line: OverviewLine) => {
      setData(previous => {
        if (line.type === 'scope') return { ...previous, cwd: line.cwd, pending: line.repositories }
        if (line.type === 'repository') {
          seen.add(line.repository.path)
          const repositories = new Map(previous.repositories)
          repositories.set(line.repository.path, line.repository)
          const failures = new Map(previous.failures)
          failures.delete(line.repository.path)
          return { ...previous, repositories, failures, pending: Math.max(0, previous.pending - 1) }
        }
        if (line.type === 'error') {
          seen.add(line.path)
          const failures = new Map(previous.failures)
          failures.set(line.path, { path: line.path, registered: line.registered !== false, code: line.error.code })
          const repositories = new Map(previous.repositories)
          repositories.delete(line.path)
          return { ...previous, repositories, failures, pending: Math.max(0, previous.pending - 1) }
        }
        // Done: drop the rows this read no longer reported.
        const repositories = new Map([...previous.repositories].filter(([path]) => seen.has(path)))
        const failures = new Map([...previous.failures].filter(([path]) => seen.has(path)))
        return { ...previous, repositories, failures, pending: 0, unlistedTruncated: line.unlistedTruncated === true, status: 'ready' }
      })
    }
    api.overview(apply, { signal: controller.signal }).then(() => {
      if (controller.signal.aborted) return
      loadedKey.current = reloadKey
      repoKeyRef.current = repoKey
      setData(previous => previous.status === 'loading' ? { ...previous, status: 'ready', pending: 0 } : previous)
    }, error => {
      if (controller.signal.aborted || isAbort(error)) return
      setData(previous => ({ ...previous, status: 'error', error: failureOf(error), pending: 0 }))
    })
    return () => { controller.abort() }
    // repoKey is recorded with the full read, not a reason to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api, reloadKey])

  useEffect(() => {
    if (!active || repo === null || loadedKey.current !== reloadKey || repoKeyRef.current === repoKey) return undefined
    const controller = new AbortController()
    // Wait for a burst of changes to settle before rereading.
    const timer = setTimeout(() => {
      api.overview(line => {
        if (line.type !== 'repository' || line.repository.path !== repo) return
        setData(previous => {
          const repositories = new Map(previous.repositories)
          // Keep the registration the full read found.
          repositories.set(repo, { ...line.repository, registered: previous.repositories.get(repo)?.registered ?? true })
          return { ...previous, repositories }
        })
      }, { repo, signal: controller.signal }).then(() => {
        if (!controller.signal.aborted) repoKeyRef.current = repoKey
      }, () => {})
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, api, reloadKey, repo, repoKey])

  return data
}
