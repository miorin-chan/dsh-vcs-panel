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

type RepositoryLine = Extract<OverviewLine, { type: 'repository' | 'error' }>

/** The overview data and the read around it. */
export interface OverviewData {
  status: 'idle' | 'loading' | 'ready' | 'error'
  cwd: string | null
  repositories: ReadonlyMap<string, OverviewRepository>
  failures: ReadonlyMap<string, ApiFailure>
  error: ApiFailure | null
}

const EMPTY: OverviewData = Object.freeze({
  status: 'idle',
  cwd: null,
  repositories: new Map(),
  failures: new Map(),
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

/** Replace a repository's last summary or failure with the latest answer. */
function mergeRepository(data: OverviewData, line: RepositoryLine): OverviewData {
  const repositories = new Map(data.repositories)
  const failures = new Map(data.failures)
  if (line.type === 'repository') {
    repositories.set(line.repository.path, line.repository)
    failures.delete(line.repository.path)
  } else {
    failures.set(line.path, line.error)
    repositories.delete(line.path)
  }
  return { ...data, repositories, failures }
}

/**
 * Read and keep the overview.
 * @param api - the Session's API.
 * @param options - when to read.
 * @returns the data so far.
 */
export function useOverview(api: Api, { active, reloadKey, repo, repoKey }: UseOverviewOptions): OverviewData {
  const [data, setData] = useState<OverviewData>(EMPTY)
  // The full read that finished last, and the current repository's key when it started.
  const [loaded, setLoaded] = useState<{ reloadKey: string, repoKey: string } | null>(null)
  const repoKeyRef = useRef(repoKey)
  repoKeyRef.current = repoKey

  useEffect(() => {
    if (!active || loaded?.reloadKey === reloadKey) return undefined
    const controller = new AbortController()
    // A change that lands while this read runs is read again afterwards.
    const startedWith = repoKeyRef.current
    const seen = new Set<string>()
    setData(previous => ({ ...previous, status: 'loading', error: null }))
    const apply = (line: OverviewLine) => {
      if (controller.signal.aborted) return
      if (line.type === 'repository' || line.type === 'error') {
        seen.add(line.type === 'repository' ? line.repository.path : line.path)
        setData(previous => mergeRepository(previous, line))
        return
      }
      setData(previous => {
        if (line.type === 'scope') return { ...previous, cwd: line.cwd }
        // Done: drop the rows this read no longer reported.
        const repositories = new Map([...previous.repositories].filter(([path]) => seen.has(path)))
        const failures = new Map([...previous.failures].filter(([path]) => seen.has(path)))
        return { ...previous, repositories, failures, status: 'ready' }
      })
    }
    api.overview(apply, { signal: controller.signal }).then(() => {
      if (controller.signal.aborted) return
      setLoaded({ reloadKey, repoKey: startedWith })
      setData(previous => previous.status === 'loading' ? { ...previous, status: 'ready' } : previous)
    }, error => {
      if (controller.signal.aborted || isAbort(error)) return
      setData(previous => ({ ...previous, status: 'error', error: failureOf(error) }))
    })
    return () => { controller.abort() }
    // `loaded` only gates the start; a finished read does not start another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api, reloadKey])

  useEffect(() => {
    if (!active || repo === null || loaded === null || loaded.reloadKey !== reloadKey || loaded.repoKey === repoKey) return undefined
    const controller = new AbortController()
    // Wait for a burst of changes to settle before rereading.
    const timer = setTimeout(() => {
      api.overview(line => {
        if (controller.signal.aborted) return
        if ((line.type === 'repository' && line.repository.path === repo) || (line.type === 'error' && line.path === repo)) {
          setData(previous => mergeRepository(previous, line))
        }
      }, { repo, signal: controller.signal }).then(() => {
        if (!controller.signal.aborted) setLoaded(previous => previous === null ? previous : { ...previous, repoKey })
      }, () => {})
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, api, loaded, reloadKey, repo, repoKey])

  return data
}
