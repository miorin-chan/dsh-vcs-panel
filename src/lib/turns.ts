/**
 * Per-Session turn head recorder.
 *
 * DSH's `workspaceChanges` service records which files a turn changed and their
 * line counts, while the repository's active branch or Jujutsu working-copy
 * change id (`@`) can move in later turns. This tracker records the enclosing
 * repository's read-only head at the end of each turn that ran tools or emitted
 * `workspace/changes`, serialized per Session so the next turn's tools cannot
 * switch branches before the closing turn's head is read.
 *
 * Records live in Host memory for the lifetime of their Session, matching
 * `workspaceChanges`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { abortError } from './errors.js'
import { findEnclosingRepository } from './repositories.js'
import { createBackends } from './vcs/index.js'
import type { BackendRegistry, VcsHead } from './vcs/index.js'

/**
 * One turn's recorded change summary, as the Host's `workspaceChanges` service
 * reports it. Internal shape, verified against DSH 0.2.2-rc.5.
 */
export interface WorkspaceChangeSummary {
  /** The turn the summary belongs to. */
  turn: number
  /** Changed files in total, including the ones the listing omits. */
  total: number
  /** Lines added across the turn. */
  added: number
  /** Lines deleted across the turn. */
  deleted: number
  /** The recorded file listing, when the service kept one. */
  files?: ReadonlyArray<{ path?: string }>
  /** The directory the tool calls ran in. */
  cwd?: string
}

/**
 * The Host service that records what each turn changed. Internal shape,
 * verified against DSH 0.2.2-rc.5: `workspaceChanges` is provided by a DSH
 * package this plugin does not depend on, so it is read through `ctx.get`.
 */
export interface WorkspaceChangesService {
  /** The recorded summary for one committed event sequence number. */
  summary(sessionId: string, seq: number): WorkspaceChangeSummary | null | undefined
}

/** Most turn heads retained in memory for one long-running Session. */
export const MAX_TURNS_PER_SESSION = 2_000

/** First-party file tools that can mutate a subagent Session's working tree. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Turn records this tracker reads; other Session events keep their typed shape. */
const TRACKED_EVENT_TYPES = new Set<string>(['workspace/changes', 'tool/call', 'tool/result'])

/**
 * The session events this tracker reads:
 * `Extract<SessionEvent, …>` events arrive through the typed Host event, and
 * `workspace/changes` is appended by the DSH service this plugin observes but
 * is declared outside the session package's published event map.
 * Internal shape, verified against DSH 0.2.2-rc.5.
 */
type TrackedSessionEvent =
  | Extract<SessionEvent, { type: 'tool/call' }>
  | Extract<SessionEvent, { type: 'tool/result' }>
  | { type: 'workspace/changes'; seq: number; data: { turn: number } }

/** One tool execution a `tools/pre-execute` listener decides. Internal shape, verified against DSH 0.2.2-rc.5. */
interface ToolExecution {
  agent?: { session?: Session }
}

/** The closing payload of one agent turn. Internal shape, verified against DSH 0.2.2-rc.5. */
interface TurnStoppingPayload {
  agent?: { session?: Session }
  turn?: number
}

/** Agent lifecycle events this tracker subscribes to. Internal shape, verified against DSH 0.2.2-rc.5. */
interface AgentLifecycleEvents {
  'agent/turn-stopping': (payload: TurnStoppingPayload) => Promise<void>
  'tools/pre-execute': (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown>
}

/** One recorded turn head: the backend's own read, passed through unread. */
export interface TurnRecord {
  head: VcsHead | null
  root: string | null
}

/** Per-turn state before the first `turn/start`. */
interface TurnState {
  turn: number
  mutationCalls: Set<string>
  shouldRecord: boolean
  lastSignalSeq: number
  attemptedAfterSeq: number
}

/** The recorder for one live Session. */
interface TurnRecorder {
  start(turn: number): void
  observeEvent(event: SessionEvent): void
  stopping(turn: number): Promise<undefined>
  end(turn: number): void
  settled(): Promise<void>
  read(turn: number, requestSignal?: AbortSignal): Promise<TurnRecord | undefined>
  dispose(): void
}

/** What the Host owns: one tracker for every Session. */
export interface TurnTracker {
  attach(): () => void
  read(sessionId: string, turn: number, signal?: AbortSignal): Promise<TurnRecord | undefined>
  dispose(): void
}

/** The shared state a tracker is created with. */
export interface TurnTrackerOptions {
  /** Backend instances by VCS id; the Host shares one registry across routes. */
  backends?: BackendRegistry
  /** Plugin lifetime signal. */
  signal?: AbortSignal
}

/** Whether a value is the Host's turn-change recorder. */
function isWorkspaceChangesService(value: unknown): value is WorkspaceChangesService {
  return typeof value === 'object' && value !== null && 'summary' in value && typeof value.summary === 'function'
}

/** The recorder as a plain context property, for a context without `get`. */
function workspaceChangesProperty(ctx: Context): unknown {
  return 'workspaceChanges' in ctx ? ctx['workspaceChanges'] : undefined
}

/**
 * Resolve the optional Host per-turn change recorder.
 * @param ctx - Host context.
 * @returns the service, or null when this Host does not provide it.
 */
export function workspaceChangesService(ctx: Context): WorkspaceChangesService | null {
  const service: unknown = typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : workspaceChangesProperty(ctx)
  return isWorkspaceChangesService(service) ? service : null
}

/** Whether a Session is a delegated subagent rather than a top-level conversation. */
function isSubagentSession(session: Session | undefined): boolean {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/** Whether a positive safe integer turn number was supplied. */
function isTurnNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Empty per-turn state before the first `turn/start`. */
function freshTurn(turn: number): TurnState {
  return {
    turn,
    mutationCalls: new Set(),
    shouldRecord: false,
    lastSignalSeq: -1,
    attemptedAfterSeq: -1,
  }
}

/** Race a promise against an AbortSignal when one is provided. */
function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal === undefined || signal === null) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(abortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Subscribe to one agent lifecycle event. DSH declares these names in a
 * package this plugin does not depend on; the listener shapes above state what
 * this tracker reads.
 * @param ctx - Host context.
 * @param name - the event name.
 * @param listener - the listener.
 * @returns the disposer.
 */
function onAgentEvent<K extends keyof AgentLifecycleEvents>(
  ctx: Context,
  name: K,
  listener: AgentLifecycleEvents[K],
): () => boolean {
  const on = ctx.on as unknown as <N extends keyof AgentLifecycleEvents>(
    name: N,
    listener: AgentLifecycleEvents[N],
  ) => () => boolean
  return on(name, listener)
}

/**
 * Create the Host tracker that records each turn's active repository head.
 * @param ctx - Host context carrying `fs` and `subprocess`.
 * @param options - shared backends and plugin lifetime signal.
 * @returns the tracker the routes and the Host lifecycle use.
 */
export function createTurnTracker(
  ctx: Context,
  { backends = createBackends(ctx), signal }: TurnTrackerOptions = {},
): TurnTracker {
  const bySession = new Map<Session, TurnRecorder>()
  const byId = new Map<string, TurnRecorder>()
  const lifetime = new AbortController()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) lifetime.abort()
    else signal.addEventListener('abort', () => lifetime.abort(), { once: true })
  }

  /** Read the enclosing repository's head for one working directory. */
  async function readEnclosingHead(cwd: string, readSignal: AbortSignal): Promise<TurnRecord> {
    const enclosing = await findEnclosingRepository(ctx, cwd, readSignal)
    const backend = enclosing?.vcs === undefined ? undefined : backends.get(enclosing.vcs)
    return enclosing === null || typeof backend?.head !== 'function'
      ? { head: null, root: null }
      : { head: await backend.head(enclosing.path, readSignal), root: enclosing.path }
  }

  /** Create or look up the recorder for one live Session with a `cwd`. */
  function recorderFor(session: Session): TurnRecorder | undefined {
    let recorder = bySession.get(session)
    if (recorder !== undefined) return recorder
    const cwd = session?.header?.cwd
    const sessionId = session?.id
    if (typeof cwd !== 'string' || cwd === '' || typeof sessionId !== 'string' || sessionId === '') {
      return undefined
    }
    const subagent = isSubagentSession(session)
    const sessionLifetime = new AbortController()
    const combinedSignal = AbortSignal.any([lifetime.signal, sessionLifetime.signal])
    const records = new Map<number, TurnRecord>()
    const pendingTurns = new Set<number>()
    let chain: Promise<void> = Promise.resolve()
    let state = freshTurn(0)

    const storeHead = (turn: number, record: TurnRecord) => {
      records.delete(turn)
      records.set(turn, record)
      while (records.size > MAX_TURNS_PER_SESSION) {
        const oldest = records.keys().next().value
        if (oldest === undefined) break
        records.delete(oldest)
      }
    }

    const enqueue = (task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
      const next = chain.then(async () => {
        if (combinedSignal.aborted) return
        try {
          await task(combinedSignal)
        } catch (error) {
          if (!combinedSignal.aborted) {
            ctx.logger?.warn?.(
              `dsh-vcs-panel: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      })
      chain = next
      return next
    }

    const recordTurn = (turnState: TurnState): Promise<void> => {
      pendingTurns.add(turnState.turn)
      return enqueue(async activeSignal => {
        try {
          if (!turnState.shouldRecord) return
          turnState.attemptedAfterSeq = turnState.lastSignalSeq
          const head = await readEnclosingHead(cwd, activeSignal)
          if (activeSignal.aborted) return
          storeHead(turnState.turn, head)
        } finally {
          pendingTurns.delete(turnState.turn)
        }
      })
    }

    recorder = {
      start(turn) {
        state = freshTurn(turn)
      },
      observeEvent(event) {
        if (!TRACKED_EVENT_TYPES.has(event.type)) return
        // The Host appends `workspace/changes` beside the typed session events;
        // the tracked shape above states the fields this observer reads.
        const observed = event as unknown as TrackedSessionEvent
        const turn = observed.data.turn
        if (!isTurnNumber(turn) || turn !== state.turn) return
        if (observed.type === 'workspace/changes') {
          state.shouldRecord = true
          state.lastSignalSeq = Math.max(state.lastSignalSeq, observed.seq ?? 0)
          return
        }
        if (observed.type === 'tool/call') {
          if (subagent && MUTATION_TOOLS.has(observed.data.name) && observed.data.callId !== undefined) {
            state.mutationCalls.add(String(observed.data.callId))
          }
          return
        }
        if (observed.type === 'tool/result') {
          if (subagent) {
            if (observed.data.message?.isError === true) return
            const callId = observed.data.message?.source?.callId
            if (callId === undefined || !state.mutationCalls.has(String(callId))) return
          }
          state.shouldRecord = true
          state.lastSignalSeq = Math.max(state.lastSignalSeq, observed.seq ?? 0)
        }
      },
      async stopping(turn) {
        const current = state
        if (turn !== current.turn || !current.shouldRecord) return undefined
        await recordTurn(current)
        return undefined
      },
      end(turn) {
        const current = state
        if (turn !== current.turn || !current.shouldRecord) return
        if (current.attemptedAfterSeq >= current.lastSignalSeq) return
        void recordTurn(current)
      },
      settled() {
        return chain
      },
      async read(turn, requestSignal) {
        if (pendingTurns.has(turn) || (state.turn === turn && state.shouldRecord && !records.has(turn))) {
          await waitWithSignal(chain, requestSignal)
        }
        return records.get(turn)
      },
      dispose() {
        sessionLifetime.abort()
        pendingTurns.clear()
        records.clear()
      },
    }

    bySession.set(session, recorder)
    byId.set(sessionId, recorder)
    return recorder
  }

  /** Forget one Session and cancel any queued read for it. */
  function forget(session: Session): void {
    const recorder = bySession.get(session)
    if (recorder === undefined) return
    bySession.delete(session)
    if (typeof session?.id === 'string' && byId.get(session.id) === recorder) {
      byId.delete(session.id)
    }
    recorder.dispose()
  }

  /** Cancel every Session recorder. */
  function dispose(): void {
    lifetime.abort()
    for (const session of [...bySession.keys()]) forget(session)
    byId.clear()
  }

  /** Subscribe to Host Session and Agent lifecycle events when `ctx.on` exists. */
  function attach(): () => void {
    if (typeof ctx?.on !== 'function') return () => { dispose() }
    const disposers = [
      ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (event?.type === 'turn/start' && isTurnNumber(event.data?.turn)) {
          recorderFor(session)?.start(event.data.turn)
          return
        }
        if (event?.type === 'turn/end' && isTurnNumber(event.data?.turn)) {
          bySession.get(session)?.end(event.data.turn)
          return
        }
        bySession.get(session)?.observeEvent(event)
      }),
      ctx.on('session/disposed', (session: Session) => {
        forget(session)
      }),
      onAgentEvent(ctx, 'agent/turn-stopping', async (payload: TurnStoppingPayload) => {
        const session = payload?.agent?.session
        if (session === undefined || !isTurnNumber(payload?.turn)) return undefined
        await bySession.get(session)?.stopping(payload.turn)
        return undefined
      }),
      onAgentEvent(ctx, 'tools/pre-execute', async (exec: ToolExecution, next: () => Promise<unknown>) => {
        const session = exec?.agent?.session
        const recorder = session === undefined ? undefined : bySession.get(session)
        if (recorder !== undefined) await recorder.settled()
        return next()
      }),
    ]
    return () => {
      for (const off of disposers) {
        if (typeof off === 'function') off()
      }
      dispose()
    }
  }

  return {
    attach,
    async read(sessionId, turn, requestSignal) {
      const recorder = byId.get(sessionId)
      if (recorder === undefined) return undefined
      return await recorder.read(turn, requestSignal)
    },
    dispose,
  }
}
