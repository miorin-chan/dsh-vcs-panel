/** Read cross-repository activity, with one in-flight request and a trailing refresh. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVITY_PAGE_SIZE } from '../../lib/activity.js'
import type { ActivityAnswer } from '../../lib/activity.js'
import { failureOf } from '../api.js'
import type { Api, ApiFailure } from '../api.js'
import { ACTIVITY_ENTRY_MAX, appendActivityPage, resetActivityPage, spliceActivityPage } from './activity-pages.js'

type RefreshMode = 'splice' | 'reset'
type Request = { kind: 'refresh'; mode: RefreshMode } | { kind: 'more'; until: number }

interface ActivityRead extends ActivityAnswer {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiFailure | null
  loadingMore: boolean
  revision: number
}

const EMPTY: ActivityRead = Object.freeze({
  status: 'idle', entries: [], next: null, failures: [], error: null, loadingMore: false, revision: 0,
})

export function useActivity(api: Api, { active, revalidateKey }: { active: boolean; revalidateKey: string }) {
  const [loaded, setLoaded] = useState<{ api: Api; read: ActivityRead } | null>(null)
  const [queued, setQueued] = useState<{ api: Api; mode: RefreshMode } | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const data = loaded?.api === api ? loaded.read : EMPTY
  const capped = data.entries.length >= ACTIVITY_ENTRY_MAX

  const refresh = useCallback((mode: RefreshMode = 'splice') => {
    setQueued(previous => previous?.api === api && previous.mode === 'reset' ? previous : { api, mode })
  }, [api])

  const read = useCallback(async (request: Request) => {
    if (!active || inFlight.current !== null) return
    const controller = new AbortController()
    inFlight.current = controller
    const update = (patch: (previous: ActivityRead) => ActivityRead) => {
      setLoaded(previous => ({ api, read: patch(previous?.api === api ? previous.read : EMPTY) }))
    }
    update(previous => ({
      ...previous, error: null, ...(request.kind === 'more' ? { loadingMore: true } : { status: 'loading' }),
    }))
    try {
      const page = await api.activity({ limit: ACTIVITY_PAGE_SIZE, until: request.kind === 'more' ? request.until : undefined }, controller.signal)
      if (controller.signal.aborted) return
      update(previous => ({
        ...previous,
        ...(request.kind === 'more' ? appendActivityPage(previous, page)
          : request.mode === 'reset' ? resetActivityPage(page) : spliceActivityPage(previous, page)),
        status: 'ready', error: null, loadingMore: false,
        revision: previous.revision + (request.kind === 'refresh' ? 1 : 0),
      }))
    } catch (error) {
      const failure = failureOf(error)
      if (controller.signal.aborted) return
      update(previous => ({ ...previous, status: 'error', error: failure, loadingMore: false }))
    } finally {
      if (inFlight.current === controller) inFlight.current = null
    }
  }, [active, api])

  useEffect(() => {
    if (active) refresh()
  }, [active, refresh, revalidateKey])

  useEffect(() => {
    if (!active) return undefined
    return () => {
      const controller = inFlight.current
      if (controller === null) return
      inFlight.current = null
      controller.abort()
      setLoaded(previous => previous?.api !== api ? previous : {
        api, read: { ...previous.read, loadingMore: false,
          status: previous.read.entries.length > 0 ? 'ready' : 'idle' },
      })
    }
  }, [active, api])

  useEffect(() => {
    if (!active || queued?.api !== api || inFlight.current !== null) return
    setQueued(previous => previous === queued ? null : previous)
    void read({ kind: 'refresh', mode: queued.mode })
  }, [active, api, data, queued, read])

  const loadMore = useCallback(() => {
    if (!capped && data.next !== null) void read({ kind: 'more', until: data.next })
  }, [capped, data.next, read])

  return { ...data, capped, loadMore, refresh }
}
