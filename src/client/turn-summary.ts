/**
 * Fetch-once cache of per-turn repository head and line-diff summaries served
 * by `/api/vcs.turn`.
 *
 * A completed turn's recorded branch / `@` identity and change totals are
 * immutable facts of that turn: once resolved, a record stands for the browser
 * session's lifetime (bounded by LRU eviction of unsubscribed entries) so
 * scrolling Chat or returning from `VCS` paints synchronously without another
 * request. A `404` / `400` / `409` answer marks the turn `'missing'` so a
 * reopened conversation from before a Host restart never polls for gone data.
 */

import { createApi, failureOf, type Api } from './api.js'

/** Most unsubscribed turn summaries kept in memory before the oldest is dropped. */
export const MAX_IDLE_TURN_SUMMARIES = 500

/** The repository head one completed turn recorded. */
export type TurnHead =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  | { kind: 'unborn' }
  | { kind: 'workingCopy'; changeId: string | null }

/** One completed turn's immutable head and change totals. */
export interface TurnSummary {
  head: TurnHead | null
  changed: number | null
  added: number | null
  deleted: number | null
}

/** Whether a decoded value is an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Normalize a turn's repository head descriptor from `/api/vcs.turn`.
 * @param value - decoded `head` field.
 * @returns the descriptor, or null when it is not one this panel knows.
 */
export function normalizeTurnHead(value: unknown): TurnHead | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'branch':
      return typeof value.name === 'string' && value.name !== ''
        ? { kind: 'branch', name: value.name }
        : null
    case 'detached':
      return { kind: 'detached' }
    case 'unborn':
      return { kind: 'unborn' }
    case 'workingCopy':
      return {
        kind: 'workingCopy',
        changeId: typeof value.changeId === 'string' && value.changeId !== '' ? value.changeId : null,
      }
    default:
      return null
  }
}

/**
 * Normalize a decoded `/api/vcs.turn` answer.
 * @param value - decoded JSON body.
 * @returns the summary, or null when the answer is not one.
 */
export function normalizeTurnSummary(value: unknown): TurnSummary | null {
  if (!isRecord(value)) return null
  const answer = value
  const head = normalizeTurnHead(answer.head)
  const changed = answer.changed
  const added = answer.added
  const deleted = answer.deleted
  const hasCounts = typeof changed === 'number' && Number.isSafeInteger(changed) && changed >= 0
    && typeof added === 'number' && Number.isSafeInteger(added) && added >= 0
    && typeof deleted === 'number' && Number.isSafeInteger(deleted) && deleted >= 0
  if (hasCounts) {
    return { head, changed, added, deleted }
  }
  const countsAbsent = (changed === null || changed === undefined)
    && (added === null || added === undefined)
    && (deleted === null || deleted === undefined)
  if (countsAbsent && head !== null) {
    return { head, changed: null, added: null, deleted: null }
  }
  return null
}

/** Build the cache key for one `(sessionId, turn, seq)` tuple, or null when invalid. */
function recordKey(sessionId: unknown, turn: unknown, seq: unknown): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) return null
  const validSeq = seq === null || seq === undefined || (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
  if (!validSeq) return null
  return `${encodeURIComponent(sessionId)}:${turn}:${seq ?? 'none'}`
}

/** Whether a failed request indicates that the Host does not hold this turn's summary. */
function isPermanentAbsence(error: unknown): boolean {
  const failure = failureOf(error)
  return failure.code === 'not-found'
    || failure.code === 'bad-request'
    || failure.code === 'no-session'
    || failure.code === 'no-cwd'
    || failure.status === 404
    || failure.status === 400
    || failure.status === 409
}

/** Where one turn's summary read stands. */
type SummaryPhase = 'idle' | 'awaitingSummary' | 'ready' | 'missing' | 'failed'

/** One cached turn summary and its subscribers. */
interface SummaryRecord {
  sessionId: string
  turn: number
  seq: number | null
  phase: SummaryPhase
  summary: TurnSummary | null
  awaitingSummary: AbortController | null
  listeners: Set<() => void>
}

/** Injection seams for the store. */
export interface TurnSummaryStoreOptions {
  /** Session API factory. */
  createApiImpl?: typeof createApi
  /** Idle record cap. */
  maxIdle?: number
}

/** The per-turn summary cache. */
export interface TurnSummaryStore {
  /** Resolved summary for one turn, or null while pending or unavailable. */
  get(sessionId: string, turn: number, seq?: number | null): TurnSummary | null
  /** Subscribe to summary resolution for one turn; returns the unsubscribe function. */
  subscribe(sessionId: string, turn: number, seq: number | null | undefined, listener: () => void): () => void
  /** Trigger a summary read when not already resolved, missing, or in flight. */
  observe(sessionId: string, turn: number, seq?: number | null): void
  /** Clear transient or missing entries on Host connection replacement; settled turns stay valid. */
  reset(): void
  /** Cancel all in-flight reads and drop cached state. */
  dispose(): void
}

/**
 * Create a per-turn summary cache.
 * @param options - injection seams for tests.
 * @returns the store.
 */
export function createTurnSummaryStore({
  createApiImpl = createApi,
  maxIdle = MAX_IDLE_TURN_SUMMARIES,
}: TurnSummaryStoreOptions = {}): TurnSummaryStore {
  const records = new Map<string, SummaryRecord>()
  const apis = new Map<string, Api>()
  let disposed = false

  /** Reuse one API client per Session. */
  function apiFor(sessionId: string): Api {
    let api = apis.get(sessionId)
    if (api === undefined) {
      api = createApiImpl(sessionId)
      apis.set(sessionId, api)
    }
    return api
  }

  /** Touch or create the record for validated coordinates. */
  function ensure(key: string, sessionId: string, turn: number, seq: number | null | undefined): SummaryRecord {
    let record = records.get(key)
    if (record !== undefined) {
      records.delete(key)
      records.set(key, record)
      return record
    }
    record = {
      sessionId,
      turn,
      seq: seq ?? null,
      phase: 'idle',
      summary: null,
      awaitingSummary: null,
      listeners: new Set(),
    }
    records.set(key, record)
    return record
  }

  /** Drop the oldest unsubscribed records past `maxIdle`. */
  function evictIdle(): void {
    let idle = 0
    for (const record of records.values()) {
      if (record.listeners.size === 0) idle += 1
    }
    for (const [key, record] of records) {
      if (idle <= maxIdle) break
      if (record.listeners.size > 0) continue
      record.awaitingSummary?.abort()
      records.delete(key)
      idle -= 1
    }
  }

  /** Notify subscribers of one record. */
  function notify(record: SummaryRecord): void {
    for (const listener of [...record.listeners]) listener()
  }

  /** Start one `/api/vcs.turn` read for `record`. */
  async function loadRecord(key: string, record: SummaryRecord): Promise<void> {
    if (disposed || record.phase === 'ready' || record.phase === 'missing' || record.phase === 'awaitingSummary') {
      return
    }
    const controller = new AbortController()
    record.phase = 'awaitingSummary'
    record.awaitingSummary = controller
    try {
      const answer = await apiFor(record.sessionId).turn(
        record.turn,
        record.seq ?? undefined,
        controller.signal,
      )
      if (disposed || controller.signal.aborted || records.get(key) !== record) return
      record.awaitingSummary = null
      const summary = normalizeTurnSummary(answer)
      if (summary === null) {
        record.phase = 'missing'
        evictIdle()
        return
      }
      record.phase = 'ready'
      record.summary = summary
      notify(record)
      evictIdle()
    } catch (error) {
      if (disposed || failureOf(error).name === 'AbortError' || controller.signal.aborted || records.get(key) !== record) {
        return
      }
      record.awaitingSummary = null
      record.phase = isPermanentAbsence(error) ? 'missing' : 'failed'
      evictIdle()
    }
  }

  return {
    get(sessionId, turn, seq = null) {
      const key = recordKey(sessionId, turn, seq)
      if (key === null) return null
      const record = records.get(key)
      return record?.phase === 'ready' ? record.summary : null
    },

    subscribe(sessionId, turn, seq, listener) {
      const key = recordKey(sessionId, turn, seq)
      if (disposed || key === null) return () => {}
      const record = ensure(key, sessionId, turn, seq)
      record.listeners.add(listener)
      return () => {
        record.listeners.delete(listener)
        if (record.listeners.size === 0) {
          if (record.phase === 'awaitingSummary') {
            record.awaitingSummary?.abort()
            record.awaitingSummary = null
            records.delete(key)
          } else {
            evictIdle()
          }
        }
      }
    },

    observe(sessionId, turn, seq = null) {
      const key = recordKey(sessionId, turn, seq)
      if (disposed || key === null) return
      const record = ensure(key, sessionId, turn, seq)
      void loadRecord(key, record)
    },

    reset() {
      if (disposed) return
      for (const [key, record] of [...records]) {
        if (record.phase === 'ready') continue
        record.awaitingSummary?.abort()
        record.awaitingSummary = null
        if (record.listeners.size === 0) {
          records.delete(key)
        } else {
          record.phase = 'idle'
          void loadRecord(key, record)
        }
      }
    },

    dispose() {
      disposed = true
      for (const record of records.values()) {
        record.awaitingSummary?.abort()
      }
      records.clear()
      apis.clear()
    },
  }
}
