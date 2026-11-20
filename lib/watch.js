import { isAbsolute, relative, resolve, sep } from 'node:path'

import { canonicalDirectory } from './contain.js'
import { VcsError } from './errors.js'
import { sameRepoPath } from './paths.js'
import { resolveSessionRepository } from './repositories.js'
import { createStatusReader } from './status-flight.js'
import { createFileWatches } from './watch-files.js'
import { HISTORY, REFS, REPOSITORIES, WORKING, watchDiscovery, watchRepository } from './watch-repository.js'

const STREAM_MAX = 64
const TURN_MAX = 16
const MUTATION_MAX = 128
const COALESCE_MS = 100
const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])
const SESSION_EVENTS = new Set(['tool/call', 'tool/result', 'workspace/changes', 'turn/end'])
const encoder = new TextEncoder()

export function watchClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined
}

function within(root, path) {
  const name = relative(root, path)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

function callPath(raw, cwd) {
  if (typeof raw !== 'string' || raw.length > 131_072) return null
  try {
    const { path } = JSON.parse(raw)
    return typeof path === 'string' && path !== '' && !path.includes('\0') ? resolve(cwd, path) : null
  } catch {
    return null
  }
}

function sse(event, body) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)
}

/** Bridge filesystem and Session changes to authenticated, bounded invalidation streams. */
export function createWatchHub(ctx, { signal, files = createFileWatches() } = {}) {
  const streams = new Set()
  const gitStatus = createStatusReader()
  const writes = new Set()
  const sessions = new Map()
  const lifetime = new AbortController()
  if (signal !== undefined) {
    if (signal.aborted) lifetime.abort()
    else signal.addEventListener('abort', () => lifetime.abort(), { once: true })
  }

  function localMatch(stream, repo) {
    return stream.repo?.vcs === repo.vcs && (sameRepoPath(stream.repo.root, repo.root)
      || stream.roots.some(root => sameRepoPath(root, repo.root)))
  }

  function storeMatch(stream, write) {
    return stream.repo?.vcs === write.repo.vcs
      && (localMatch(stream, write.repo) || stream.common !== null && write.common !== null && sameRepoPath(stream.common, write.common))
  }

  /** Join explicit notifications and ambiguous OS events behind the existing write lock. */
  async function beginWrite(repo, signal, shared = true) {
    const write = { repo, common: null, resolving: shared }
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
        }
        stream.schedule()
      }
    }
  }

  function repositoryConfigChanged(sessionId, origin) {
    for (const stream of streams) {
      if (stream.sessionId === sessionId) stream.invalidate([REPOSITORIES], origin)
    }
  }

  function sessionState(session) {
    let state = sessions.get(session.id)
    if (state === undefined) {
      const controller = new AbortController()
      state = { session, turns: new Map(), controller, signal: AbortSignal.any([controller.signal, lifetime.signal]), timer: undefined, running: false }
      sessions.set(session.id, state)
    }
    return state
  }

  function relevant(turn, stream, root) {
    const summary = turn.summary
    const coversCwd = sameRepoPath(root, stream.cwd) || within(root, stream.cwd)
    if (summary != null) {
      return (summary.files ?? []).some(file => typeof file.path === 'string' && within(root, resolve(summary.cwd ?? stream.cwd, file.path)))
        || summary.total > (summary.files?.length ?? 0) && coversCwd
    }
    return [...turn.paths].some(path => within(root, path))
      || coversCwd && (turn.unknown || turn.workspaceChanged && turn.paths.size === 0)
  }

  function loadSummary(state, turn) {
    if (!turn.workspaceChanged || turn.seq === undefined) return
    // The installed recorder publishes the event before inserting its summary.
    // Look it up at flush time, after append and storage have both completed.
    const workspace = typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : ctx.workspaceChanges
    turn.summary = workspace?.summary?.(state.session.id, turn.seq)
  }

  async function canSnapshot(stream, root, signal) {
    const { repo, cwd, common } = stream
    const match = await resolveSessionRepository(ctx, cwd, repo.root, signal)
    if (match?.vcs !== 'jujutsu') return false
    if (common === null || await repo.backend.commonDir(root, signal) !== common) return false
    if (sameRepoPath(root, repo.root)) return true
    for await (const tree of repo.backend.worktrees(repo.root, signal, { paths: [root], commonDir: common })) {
      if (sameRepoPath(tree.path, root)) return true
    }
    return false
  }

  async function flushTurns(state) {
    const currentStreams = [...streams].filter(stream => stream.sessionId === state.session.id)
    for (const turn of state.turns.values()) {
      if (!turn.workspaceChanged && !turn.unknown && turn.paths.size === 0) continue
      loadSummary(state, turn)
      const workspacePending = turn.workspaceChanged && !turn.workspaceSent
      turn.workspaceSent = turn.workspaceChanged
      for (const stream of currentStreams) {
        if (state.signal.aborted || stream.signal.aborted) continue
        if (workspacePending && stream.repo?.vcs === 'git' && stream.roots.some(root => relevant(turn, stream, root))) {
          stream.invalidate([WORKING])
        }
        if (!turn.ended || stream.repo?.vcs !== 'jujutsu') continue
        for (const root of stream.roots) {
          if (turn.snapshots.has(root) || !relevant(turn, stream, root)) continue
          try {
            if (!await canSnapshot(stream, root, state.signal) || stream.signal.aborted) continue
            turn.snapshots.add(root)
            await stream.repo.backend.snapshot(root, state.signal)
          } catch (error) {
            if (!state.signal.aborted) ctx.logger?.warn?.(`dsh-vcs-panel: changed-turn snapshot: ${error?.message ?? String(error)}`)
          }
          if (state.signal.aborted) return
          for (const target of streams) {
            if (target.repo?.vcs === 'jujutsu' && (target.roots.some(path => sameRepoPath(path, root))
              || stream.common !== null && target.common !== null && sameRepoPath(target.common, stream.common))) {
              if (target.checkOperation === undefined) target.invalidate(REFS)
              else await target.checkOperation()
            }
          }
        }
      }
    }
  }

  function scheduleTurns(state) {
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

  function observe(session, event) {
    const { type, data, seq } = event ?? {}
    if (!SESSION_EVENTS.has(type) || typeof session?.id !== 'string' || typeof session.header?.cwd !== 'string'
      || !Number.isSafeInteger(data?.turn) || data.turn < 1 || lifetime.signal.aborted) return
    if (type === 'tool/call' && (!MUTATION_TOOLS.has(data.name) || data.callId === undefined)) return
    if (type === 'tool/result' && !sessions.has(session.id)) return

    const state = sessionState(session)
    let turn = state.turns.get(data.turn)
    if (turn === undefined) {
      if (type === 'tool/result') return
      turn = { calls: new Map(), paths: new Set(), snapshots: new Set(), ended: false, workspaceChanged: false, unknown: false }
      state.turns.set(data.turn, turn)
      if (state.turns.size > TURN_MAX) state.turns.delete(state.turns.keys().next().value)
    }

    if (type === 'tool/call') {
      if (turn.calls.size < MUTATION_MAX) turn.calls.set(String(data.callId), callPath(data.arguments, session.header.cwd))
      return
    }
    if (type === 'tool/result') {
      const id = data.message?.source?.callId
      if (id === undefined || !turn.calls.has(String(id))) return
      const path = turn.calls.get(String(id))
      turn.calls.delete(String(id))
      if (data.message.isError === true) return
      if (path === null || turn.paths.size >= MUTATION_MAX) turn.unknown = true
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
        if (stream.repo === null) stream.invalidate([REPOSITORIES])
        else if (type === 'tool/result' && stream.repo.vcs === 'git' && stream.roots.some(root => relevant(turn, stream, root))) {
          stream.invalidate([WORKING])
        }
      }
    }
    if (turn.ended || type === 'workspace/changes') scheduleTurns(state)
  }

  function forget(session) {
    const state = sessions.get(session.id)
    if (state !== undefined) {
      state.controller.abort()
      clearTimeout(state.timer)
      sessions.delete(session.id)
    }
    for (const stream of streams) {
      if (stream.sessionId === session.id) stream.close()
    }
  }

  function attach() {
    const offEvent = ctx.on?.('session/event', observe)
    const offSession = ctx.on?.('session/disposed', forget)
    return () => {
      offEvent?.()
      offSession?.()
      lifetime.abort()
      for (const state of sessions.values()) forget(state.session)
    }
  }

  async function open({ sessionId, cwd, repo, roots, common, client, signal }) {
    if (streams.size >= STREAM_MAX) throw new VcsError('busy', 'Too many panels are watching repositories.')
    const closeSignal = new AbortController()
    const active = AbortSignal.any([signal, lifetime.signal, closeSignal.signal])
    active.throwIfAborted()
    const stops = []
    let controller
    let timer
    let ready = false
    const domains = new Set()
    let origin

    function keep(stop) {
      if (stop === null) return
      if (active.aborted) stop()
      else stops.push(stop)
    }

    function dispose() {
      streams.delete(stream)
      clearTimeout(timer)
      for (const stop of stops.splice(0)) stop()
      controller?.close()
    }

    function send() {
      if (active.aborted || !ready || controller.desiredSize <= 0 || domains.size === 0
        || [...writes].some(write => storeMatch(stream, write) || write.resolving && repo?.vcs === write.repo.vcs)) return
      const frame = sse('invalidate', { domains: [...domains], ...(origin === client && origin !== undefined ? { origin } : {}) })
      domains.clear()
      origin = undefined
      controller.enqueue(frame)
    }

    const stream = {
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
      const receive = changes => stream.invalidate(changes)
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
    const body = new ReadableStream({
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
    scheduleTurns(sessions.get(sessionId))
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
  }

  return { open, attach, beginWrite, repositoryConfigChanged, gitStatus }
}
