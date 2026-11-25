import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { canonicalDirectory } from './contain.js'
import { VcsError } from './errors.js'
import { sameRepoPath } from './paths.js'
import { resolveSessionRepository } from './repositories.js'
import type { StatusReader } from './status-flight.js'
import { createStatusReader } from './status-flight.js'
import type { WorkspaceChangeSummary } from './turns.js'
import { workspaceChangesService } from './turns.js'
import type { VcsStatus } from './vcs/index.js'
import type { FileWatches } from './watch-files.js'
import { createFileWatches } from './watch-files.js'
import { HISTORY, REFS, REPOSITORIES, WORKING, watchDiscovery, watchRepository } from './watch-repository.js'
import type { WatchedRepository, WatchReceive } from './watch-repository.js'

const STREAM_MAX = 64
const TURN_MAX = 16
const MUTATION_MAX = 128
const COALESCE_MS = 100
const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])
const SESSION_EVENTS = new Set(['tool/call', 'tool/result', 'workspace/changes', 'turn/end'])
const encoder = new TextEncoder()

/** One authenticated panel watching its session's repositories. */
export interface WatchStream {
  /** The session that owns this stream, when the request named one. */
  sessionId: string | null
  /** Canonical session working directory. */
  cwd: string
  /** The selected repository, or null while the session has none. */
  repo: WatchedRepository | null
  /** Selected checkout roots, anchor first. */
  roots: string[]
  /** The repository's common directory, when it has one. */
  common: string | null
  /** Cancellation for this stream. */
  signal: AbortSignal
  /** Forbid further sends and release the watches. */
  close(): void
  /** Report that one write finished, carrying its domains and origin. */
  completeWrite(changes: readonly string[], writer: string | undefined): void
  /** Mark domains stale, coalescing the notification. */
  invalidate(changes: readonly string[], writer?: string): void
  /** Arm the coalescing timer. */
  schedule(): void
  /** Re-check Jujutsu operation heads after a snapshot. */
  checkOperation?: () => Promise<void>
}

/** One write in flight, for streams that must wait for its notification. */
interface WriteInFlight {
  repo: WatchedRepository
  common: string | null
  resolving: boolean
}

/** One turn's observed changes, coalesced before a refresh. */
interface TurnObservation {
  calls: Map<string, string | null>
  paths: Set<string>
  snapshots: Set<string>
  ended: boolean
  workspaceChanged: boolean
  workspaceSent?: boolean
  unknown: boolean
  seq?: number
  summary?: WorkspaceChangeSummary | null
}

/** What one live Session has queued for the refresh hub. */
interface SessionState {
  session: Session
  turns: Map<number, TurnObservation>
  controller: AbortController
  signal: AbortSignal
  timer: ReturnType<typeof setTimeout> | undefined
  running: boolean
  queued?: boolean
}

/** The session events this hub reads. `workspace/changes` is appended by the
 * Host service this plugin observes but is declared outside the session
 * package's published event map. Internal shape, verified against DSH
 * 0.2.2-rc.5. */
interface ObservedEvent {
  type?: string
  seq?: number
  data?: {
    turn?: number
    name?: string
    callId?: string
    arguments?: string
    message?: { isError?: boolean, source?: { callId?: string } }
  }
}

/** One client opening the refresh stream. */
export interface WatchOpenOptions {
  /** The session the request named. */
  sessionId: string | null
  /** Canonical session working directory. */
  cwd: string
  /** The selected repository, or null while the session has none. */
  repo: WatchedRepository | null
  /** Selected checkout roots, anchor first. */
  roots: string[]
  /** The repository's common directory, when it has one. */
  common: string | null
  /** The panel's client id, echoed back with its own post-write refresh. */
  client: string | undefined
  /** The streaming request, whose abort link must stay alive until close. */
  request: Request
}

/** The callback that ends one write's bookkeeping. */
export type WriteFinish = (changes: readonly string[] | undefined, origin: string | undefined) => void

/** The refresh signals the Host routes share. */
export interface WatchHub {
  readonly signal: AbortSignal
  /** Open one authenticated invalidation stream. */
  open(options: WatchOpenOptions): Promise<Response>
  /** Subscribe to Session lifecycle events. */
  attach(): () => void
  /** Account for one write in flight and return its finisher. */
  beginWrite(repo: WatchedRepository, signal: AbortSignal, shared?: boolean): Promise<WriteFinish>
  /** Tell one session's streams that its discovery configuration changed. */
  repositoryConfigChanged(sessionId: string | null, origin: string | undefined): void
  /** The coalesced Git status reader routes read through. */
  gitStatus: StatusReader<VcsStatus>
}

/** The shared state a hub is created with. */
export interface WatchHubOptions {
  /** Plugin lifetime signal. */
  signal?: AbortSignal
  /** The watcher implementation; tests replace the OS watcher. */
  files?: FileWatches
}

/** The watched-client id a request may carry; it names one browser tab. */
export function watchClientId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined
}

/** Whether `path` is strictly below `root`. */
function within(root: string, path: string): boolean {
  const name = relative(root, path)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

/** The absolute path one tool call named, from its raw arguments. */
function callPath(raw: unknown, cwd: string): string | null {
  if (typeof raw !== 'string' || raw.length > 131_072) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const path = typeof parsed === 'object' && parsed !== null && 'path' in parsed ? parsed.path : undefined
    return typeof path === 'string' && path !== '' && !path.includes('\0') ? resolve(cwd, path) : null
  } catch {
    return null
  }
}

/** One Server-Sent Events frame. */
function sse(event: string, body: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)
}

/** A caught failure's message, for the Host log. */
function failureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/** Bridge filesystem and Session changes to authenticated, bounded invalidation streams. */
export function createWatchHub(
  ctx: Context,
  { signal, files = createFileWatches() }: WatchHubOptions = {},
): WatchHub {
  const streams = new Set<WatchStream>()
  const gitStatus = createStatusReader<VcsStatus>()
  const writes = new Set<WriteInFlight>()
  const sessions = new Map<string, SessionState>()
  const lifetime = new AbortController()
  if (signal !== undefined) {
    if (signal.aborted) lifetime.abort()
    else signal.addEventListener('abort', () => lifetime.abort(), { once: true })
  }

  function localMatch(stream: WatchStream, repo: WatchedRepository): boolean {
    const watched = stream.repo
    return watched !== null && watched.vcs === repo.vcs && (sameRepoPath(watched.root, repo.root)
      || stream.roots.some(root => sameRepoPath(root, repo.root)))
  }

  function storeMatch(stream: WatchStream, write: WriteInFlight): boolean {
    return stream.repo?.vcs === write.repo.vcs
      && (localMatch(stream, write.repo) || stream.common !== null && write.common !== null && sameRepoPath(stream.common, write.common))
  }

  /** Join explicit notifications and ambiguous OS events behind the existing write lock. */
  async function beginWrite(repo: WatchedRepository, signal: AbortSignal, shared = true): Promise<WriteFinish> {
    const write: WriteInFlight = { repo, common: null, resolving: shared }
    writes.add(write)
    try {
      if (shared && [...streams].some(stream => stream.repo?.vcs === repo.vcs)) {
        const path = await repo.backend.commonDir?.(repo.root, signal)
        if (path != null) write.common = await canonicalDirectory(ctx, path, signal)
      }
    } catch {
      // Filesystem observation stays optional even when shared metadata cannot be located.
    } finally {
      write.resolving = false
    }
    return (domains, origin) => {
      if (repo.vcs === 'git') gitStatus.invalidate(repo.root)
      writes.delete(write)
      for (const stream of streams) {
        if (domains !== undefined && (shared ? storeMatch(stream, write) : stream.roots.some(root => sameRepoPath(root, repo.root)))) {
          stream.completeWrite(domains, origin)
        } else if (domains?.includes(REPOSITORIES)) {
          // An unselected repository can still be in this panel's discovery list.
          stream.invalidate([REPOSITORIES], origin)
        }
        stream.schedule()
      }
    }
  }

  function repositoryConfigChanged(sessionId: string | null, origin: string | undefined): void {
    for (const stream of streams) {
      if (stream.sessionId === sessionId) stream.invalidate([REPOSITORIES], origin)
    }
  }

  function sessionState(session: Session): SessionState {
    let state = sessions.get(session.id)
    if (state === undefined) {
      const controller = new AbortController()
      state = { session, turns: new Map(), controller, signal: AbortSignal.any([controller.signal, lifetime.signal]), timer: undefined, running: false }
      sessions.set(session.id, state)
    }
    return state
  }

  function relevant(turn: TurnObservation, stream: WatchStream, root: string): boolean {
    const summary = turn.summary
    const coversCwd = sameRepoPath(root, stream.cwd) || within(root, stream.cwd)
    if (summary != null) {
      return (summary.files ?? []).some(file => typeof file.path === 'string' && within(root, resolve(summary.cwd ?? stream.cwd, file.path)))
        || summary.total > (summary.files?.length ?? 0) && coversCwd
    }
    return [...turn.paths].some(path => within(root, path))
      || coversCwd && (turn.unknown || turn.workspaceChanged && turn.paths.size === 0)
  }

  function loadSummary(state: SessionState, turn: TurnObservation): void {
    if (!turn.workspaceChanged || turn.seq === undefined) return
    // The installed recorder publishes the event before inserting its summary.
    // Look it up at flush time, after append and storage have both completed.
    const workspace = workspaceChangesService(ctx)
    turn.summary = workspace?.summary?.(state.session.id, turn.seq)
  }

  async function canSnapshot(stream: WatchStream, root: string, signal: AbortSignal): Promise<boolean> {
    const { repo, cwd, common } = stream
    if (repo === null) return false
    const match = await resolveSessionRepository(ctx, cwd, repo.root, signal)
    if (match?.vcs !== 'jujutsu') return false
    if (common === null || await repo.backend.commonDir(root, signal) !== common) return false
    if (sameRepoPath(root, repo.root)) return true
    for await (const tree of repo.backend.worktrees(repo.root, signal, { paths: [root], commonDir: common })) {
      if (sameRepoPath(tree.path, root)) return true
    }
    return false
  }

  async function flushTurns(state: SessionState): Promise<void> {
    const currentStreams = [...streams].filter(stream => stream.sessionId === state.session.id)
    for (const turn of state.turns.values()) {
      if (!turn.workspaceChanged && !turn.unknown && turn.paths.size === 0) continue
      loadSummary(state, turn)
      const workspacePending = turn.workspaceChanged && !turn.workspaceSent
      turn.workspaceSent = turn.workspaceChanged
      for (const stream of currentStreams) {
        if (state.signal.aborted || stream.signal.aborted) continue
        const streamRepo = stream.repo
        if (workspacePending && streamRepo?.vcs === 'git' && stream.roots.some(root => relevant(turn, stream, root))) {
          stream.invalidate([WORKING])
        }
        if (!turn.ended || streamRepo?.vcs !== 'jujutsu') continue
        for (const root of stream.roots) {
          if (turn.snapshots.has(root) || !relevant(turn, stream, root)) continue
          try {
            if (!await canSnapshot(stream, root, state.signal) || stream.signal.aborted) continue
            turn.snapshots.add(root)
            await streamRepo.backend.snapshot?.(root, state.signal)
          } catch (error) {
            if (!state.signal.aborted) ctx.logger?.warn?.(`dsh-vcs-panel: changed-turn snapshot: ${failureMessage(error)}`)
          }
          if (state.signal.aborted) return
          for (const target of streams) {
            const targetRepo = target.repo
            if (targetRepo?.vcs === 'jujutsu' && (target.roots.some(path => sameRepoPath(path, root))
              || stream.common !== null && target.common !== null && sameRepoPath(target.common, stream.common))) {
              if (target.checkOperation === undefined) target.invalidate(REFS)
              else await target.checkOperation()
            }
          }
        }
      }
    }
  }

  function scheduleTurns(state: SessionState | undefined): void {
    if (state === undefined || state.signal.aborted || ![...streams].some(stream => stream.sessionId === state.session.id && stream.repo !== null)) return
    if (state.running) {
      state.queued = true
      return
    }
    if (state.timer !== undefined) return
    state.timer = setTimeout(async () => {
      state.timer = undefined
      state.running = true
      try {
        await flushTurns(state)
      } finally {
        state.running = false
        if (state.queued) {
          state.queued = false
          scheduleTurns(state)
        }
      }
    }, COALESCE_MS)
    state.timer.unref?.()
  }

  function observe(session: Session, event: SessionEvent): void {
    // The Host appends `workspace/changes` beside the typed session events; the
    // observed shape above states the fields this hub reads.
    const { type, data, seq } = event as unknown as ObservedEvent
    const turnNumber = data?.turn
    if (!SESSION_EVENTS.has(type ?? '') || typeof session?.id !== 'string' || typeof session.header?.cwd !== 'string'
      || typeof turnNumber !== 'number' || !Number.isSafeInteger(turnNumber) || turnNumber < 1 || lifetime.signal.aborted) return
    if (type === 'tool/call' && (!MUTATION_TOOLS.has(data?.name ?? '') || data?.callId === undefined)) return
    if (type === 'tool/result' && !sessions.has(session.id)) return

    const state = sessionState(session)
    let turn = state.turns.get(turnNumber)
    if (turn === undefined) {
      if (type === 'tool/result') return
      turn = { calls: new Map(), paths: new Set(), snapshots: new Set(), ended: false, workspaceChanged: false, unknown: false }
      state.turns.set(turnNumber, turn)
      const oldest = state.turns.keys().next().value
      if (state.turns.size > TURN_MAX && oldest !== undefined) state.turns.delete(oldest)
    }

    if (type === 'tool/call') {
      if (turn.calls.size < MUTATION_MAX) turn.calls.set(String(data?.callId), callPath(data?.arguments, session.header.cwd))
      return
    }
    if (type === 'tool/result') {
      const id = data?.message?.source?.callId
      if (id === undefined || !turn.calls.has(String(id))) return
      const path = turn.calls.get(String(id))
      turn.calls.delete(String(id))
      if (data?.message?.isError === true) return
      if (path === null || path === undefined || turn.paths.size >= MUTATION_MAX) turn.unknown = true
      else turn.paths.add(path)
    } else if (type === 'workspace/changes') {
      turn.workspaceChanged = true
      turn.workspaceSent = false
      turn.seq = seq
    } else {
      turn.ended = true
      turn.calls.clear()
    }

    if (type !== 'turn/end') {
      for (const stream of streams) {
        if (stream.sessionId !== session.id) continue
        const streamRepo = stream.repo
        if (streamRepo === null) stream.invalidate([REPOSITORIES])
        else if (type === 'tool/result' && streamRepo.vcs === 'git' && stream.roots.some(root => relevant(turn, stream, root))) {
          stream.invalidate([WORKING])
        }
      }
    }
    if (turn.ended || type === 'workspace/changes') scheduleTurns(state)
  }

  function forget(session: Session): void {
    const state = sessions.get(session.id)
    if (state !== undefined) {
      state.controller.abort()
      if (state.timer !== undefined) clearTimeout(state.timer)
      sessions.delete(session.id)
    }
    for (const stream of streams) {
      if (stream.sessionId === session.id) stream.close()
    }
  }

  function attach(): () => void {
    const offEvent = ctx.on?.('session/event', observe)
    const offSession = ctx.on?.('session/disposed', forget)
    return () => {
      offEvent?.()
      offSession?.()
      lifetime.abort()
      for (const state of [...sessions.values()]) forget(state.session)
    }
  }

  async function open({ sessionId, cwd, repo, roots, common, client, request }: WatchOpenOptions): Promise<Response> {
    if (streams.size >= STREAM_MAX) throw new VcsError('busy', 'Too many panels are watching repositories.')
    const closeSignal = new AbortController()
    request.signal.throwIfAborted()
    const active = AbortSignal.any([lifetime.signal, closeSignal.signal])
    active.throwIfAborted()
    const abortRequest = () => closeSignal.abort(request.signal.reason)
    request.signal.addEventListener('abort', abortRequest, { once: true })
    const stops: Array<() => void> = []
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ready = false
    const domains = new Set<string>()
    let origin: string | undefined

    function keep(stop: (() => void) | null): void {
      if (stop === null) return
      if (active.aborted) stop()
      else stops.push(stop)
    }

    function dispose(): void {
      request.signal.removeEventListener('abort', abortRequest)
      streams.delete(stream)
      if (timer !== undefined) clearTimeout(timer)
      for (const stop of stops.splice(0)) stop()
      controller?.close()
    }

    function send(): void {
      if (active.aborted || !ready || controller === undefined || controller.desiredSize === null || controller.desiredSize <= 0 || domains.size === 0
        || [...writes].some(write => storeMatch(stream, write) || write.resolving && repo?.vcs === write.repo.vcs)) return
      const frame = sse('invalidate', { domains: [...domains], ...(origin === client && origin !== undefined ? { origin } : {}) })
      domains.clear()
      origin = undefined
      controller.enqueue(frame)
    }

    const stream: WatchStream = {
      sessionId, cwd, repo, roots, common, signal: active,
      close: () => closeSignal.abort(),
      completeWrite(changes, writer) {
        const covered = [...domains].every(domain => changes.includes(domain))
        this.invalidate(changes, writer)
        // All covered signals were already pending before the successful POST
        // returned. Its client's post-write reads will see that state too.
        origin = covered ? writer : undefined
      },
      invalidate(changes, writer) {
        if (repo?.vcs === 'git' && changes.includes(WORKING)) {
          for (const root of roots) gitStatus.invalidate(root)
        }
        if (domains.size === 0) origin = writer
        else if (origin !== writer) origin = undefined
        for (const domain of changes) domains.add(domain)
        this.schedule()
      },
      schedule() {
        if (active.aborted || timer !== undefined || domains.size === 0) return
        timer = setTimeout(() => {
          timer = undefined
          send()
        }, COALESCE_MS)
        timer.unref?.()
      },
    }
    streams.add(stream)
    active.addEventListener('abort', dispose, { once: true })
    try {
      const receive: WatchReceive = changes => stream.invalidate(changes)
      const [, checkOperation] = await Promise.all([
        watchDiscovery(files, cwd, repo === null, receive, active, keep),
        repo === null ? undefined : watchRepository(files, { repo, roots, common, receive, signal: active, keep }),
      ])
      stream.checkOperation = checkOperation
      active.throwIfAborted()
    } catch (error) {
      stream.close()
      throw error
    }
    const body = new ReadableStream<Uint8Array>({
      start(target) {
        controller = target
        controller.enqueue(sse('ready', {}))
        ready = true
      },
      pull() { if (timer === undefined) send() },
      cancel() {
        controller = undefined
        stream.close()
      },
    })
    scheduleTurns(sessionId === null ? undefined : sessions.get(sessionId))
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
  }

  return { signal: lifetime.signal, open, attach, beginWrite, repositoryConfigChanged, gitStatus }
}
