/**
 * The loaded history each tiled column folds into its skeleton: the first page
 * of the repository's full history, read four repositories at a time in column
 * order while the layout is tiled.
 */

import { useEffect, useRef, useState } from 'react'

import type { Api, CommitNode } from '../api.js'
import { failureOf } from '../api.js'

/** One column's history read. */
export interface ColumnHistory {
  status: 'idle' | 'loading' | 'ready' | 'error'
  commits: readonly CommitNode[]
}

/** Commits per column, as one timeline page. */
const COLUMN_PAGE = 300
const CONCURRENCY = 4
const IDLE: ColumnHistory = Object.freeze({ status: 'idle', commits: [] })

/**
 * Read the history of each listed repository while active.
 * @param api - the Session's API.
 * @param paths - repositories in column order.
 * @param active - whether the layout is tiled.
 * @param reloadKey - changes when histories should be read again.
 * @returns the reads by repository.
 */
export function useTileHistories(api: Api, paths: readonly string[], active: boolean, reloadKey: string): ReadonlyMap<string, ColumnHistory> {
  const [histories, setHistories] = useState<ReadonlyMap<string, ColumnHistory>>(new Map())
  const loadedRef = useRef(new Map<string, string>())
  const pathsKey = JSON.stringify(paths)

  useEffect(() => {
    if (!active) return undefined
    const controller = new AbortController()
    const wanted = paths.filter(path => loadedRef.current.get(path) !== reloadKey)
    let next = 0
    const worker = async () => {
      while (next < wanted.length && !controller.signal.aborted) {
        const path = wanted[next]
        next += 1
        // Keep a drawn skeleton (and keyboard focus) in place during rereads.
        setHistories(previous => previous.get(path)?.status === 'ready' ? previous
          : new Map(previous).set(path, { status: 'loading', commits: [] }))
        try {
          const answer = await api.log(path, { ref: 'all', limit: COLUMN_PAGE }, controller.signal)
          if (controller.signal.aborted) return
          loadedRef.current.set(path, reloadKey)
          setHistories(previous => new Map(previous).set(path, { status: 'ready', commits: answer.commits }))
        } catch (error) {
          if (controller.signal.aborted || failureOf(error).name === 'AbortError') return
          setHistories(previous => new Map(previous).set(path, { status: 'error', commits: [] }))
        }
      }
    }
    void Promise.all(Array.from({ length: CONCURRENCY }, worker))
    return () => { controller.abort() }
    // pathsKey stands for paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api, pathsKey, reloadKey])

  return active ? histories : EMPTY_MAP
}

const EMPTY_MAP: ReadonlyMap<string, ColumnHistory> = new Map()

/** A column's read, or idle before it starts. */
export function historyOf(histories: ReadonlyMap<string, ColumnHistory>, path: string): ColumnHistory {
  return histories.get(path) ?? IDLE
}
