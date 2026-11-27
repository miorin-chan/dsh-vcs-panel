/**
 * The panel's routes cover repository management, reads, staging, sync,
 * branch switching, the branch and remote-branch actions menus (rename,
 * delete, merge, rebase, push, checkout-remote, delete-remote, merge-remote,
 * pull-remote), the tag actions menu (delete, push), and the commit actions
 * menu (tag, branch, checkout, cherry-pick, revert, drop, merge, rebase,
 * reset).
 *
 * Every handler takes one authenticated `Request` and answers with a JSON
 * `Response`. Backend-specific work lives behind the registry in `vcs/`;
 * this module only resolves the session and the repository, validates the
 * request shape, and dispatches.
 *
 * `createHandlers` exists apart from the Cordis wiring so tests can drive the
 * routes with a fake host context, and so `apply` stays thin.
 */

import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { ACTIVITY_PAGE_MAX, ACTIVITY_PAGE_SIZE, mergeActivity } from './activity.js'
import type { ActivityFailure, ActivityRepositoryAnswer } from './activity.js'
import { canonicalDirectory } from './contain.js'
import { badRequest, errorResponse, json, notFound, VcsError } from './errors.js'
import { createBackends } from './vcs/index.js'
import type { BackendRegistry, VcsBackend, VcsCapabilities } from './vcs/index.js'
import { LOG_PAGE_MAX, LOG_SKIP_MAX } from './log.js'
import { createLimiter, mapLimited, unsupportedOverview } from './overview.js'
import type { OverviewRepository } from './overview.js'
import { WORKING_TREE_NODE } from './nodes.js'
import { isFullSha, repositoryName, sameRepoPath, validateRelPath, validateSha } from './paths.js'
import { RESET_MODES } from './ref-utils.js'
import { requireStashSha } from './stash.js'
import { STASH_MESSAGE_MAX } from './stash-types.js'
import type { StashRequest } from './stash-types.js'
import {
  discoverRepositories, previewRepositoryConfig, repositoryConfig as readRepositoryConfig, resolveSessionRepository,
  saveRepositoryConfig as persistRepositoryConfig,
} from './repositories.js'
import type { DiscoveredRepository, SaveRepositoryConfigBody } from './repositories.js'
import { DIFF_MAX_LINES } from './diff.js'
import { STAGING_FILES_MAX, STAGING_FILES_SCOPES, STAGING_SCOPES, stagingUnsupported } from './staging.js'
import { stageHistoryError } from './index-transaction.js'
import { EMPTY_STAGE_HISTORY } from './stage-history.js'
import type { TurnTracker } from './turns.js'
import { workspaceChangesService } from './turns.js'
import { recommendTurnRepositories } from './turn-repositories.js'
import { createReadFlight } from './read-flight.js'
import { createWatchHub, watchClientId } from './watch.js'
import type { WatchHub, WriteFinish } from './watch.js'
import { HISTORY, REFS, REPOSITORIES, WORKING } from './watch-repository.js'
import { newWorktreePath, worktreeInUse, worktreeSessionDirectories } from './worktree-ops.js'
import type { WatchedRepository } from './watch-repository.js'
import type { Worktree } from './worktrees.js'

/** The actions the branch and remote-branch menus can run. */
const BRANCH_ACTIONS = new Set([
  'rename', 'delete', 'merge', 'rebase', 'push',
  'checkout-remote', 'delete-remote', 'merge-remote', 'pull-remote',
])

/** The actions the tag menu can run. */
const TAG_ACTIONS = new Set(['delete', 'push'])

const BRANCH_HISTORY_ACTIONS = new Set(['rename', 'merge', 'rebase', 'checkout-remote', 'merge-remote', 'pull-remote'])

/** Most related worktrees the repository picker shows for one session. */
const WORKTREE_MAX = 50

/** The actions the commit menu can run. */
const COMMIT_ACTIONS = new Set([
  'tag', 'branch', 'checkout', 'cherry-pick', 'revert', 'drop', 'merge', 'rebase', 'reset',
])

/** One route handler: one authenticated request in, one JSON response out. */
export type RouteHandler = (request: Request) => Promise<Response>

/** The route handlers one Host context serves, keyed by route. */
export interface VcsRouteHandlers {
  repositories: RouteHandler
  repositoryConfig: RouteHandler
  repositoryPreview: RouteHandler
  repositoryScan: RouteHandler
  saveRepositoryConfig: RouteHandler
  overview: RouteHandler
  activity: RouteHandler
  watch: RouteHandler
  status: RouteHandler
  untracked: RouteHandler
  diff: RouteHandler
  log: RouteHandler
  commit: RouteHandler
  stash: RouteHandler
  stashCheck: RouteHandler
  stashOp: RouteHandler
  turn: RouteHandler
  sync: RouteHandler
  branches: RouteHandler
  remotes: RouteHandler
  switchBranch: RouteHandler
  branchOp: RouteHandler
  tagOp: RouteHandler
  commitOp: RouteHandler
  worktreeOp: RouteHandler
  stage: RouteHandler
  stageHistory: RouteHandler
}

/** The Host context plus the optional state the Host wires into the routes. */
export interface HandlersContext extends Context {
  /** The per-turn head recorder, also passed through the options. */
  turnTracker?: TurnTracker
}

/** The shared state the Host hands the routes. */
export interface CreateHandlersOptions {
  /** Backend instances by VCS id. */
  backends?: BackendRegistry
  /** The per-turn head recorder. */
  turnTracker?: TurnTracker
  /** The refresh-signal hub. */
  watchHub?: WatchHub
}

/** The session one request addresses. */
interface RequestSession {
  sessionId: string
  cwd: string
}

/** One selected repository, with the backend that reads it. */
interface RepositoryTarget {
  root: string
  name: string
  vcs: string
  backend: VcsBackend
}

/** One selected repository plus the capabilities the answer reports. */
interface BrowseTarget extends RepositoryTarget {
  capabilities: VcsCapabilities
  preview: boolean
}

/** One discovered repository as the picker answer groups it. */
interface GroupedRepository {
  path: string
  name: string
  enclosing: boolean
  vcs: string | undefined
  availableVcs: string[]
  sources: DiscoveredRepository['sources']
  capabilities: VcsCapabilities | undefined
  worktrees?: Worktree[]
}

/** One file a group or folder write names. */
interface StagingFile {
  path: string
  oldPath?: string
  directory?: true
}

/** One selected worktree's path and head, as the log route answers. */
interface WorktreeHead {
  path: string
  head: string | null
}

/** One parsed write request. */
interface WriteRequest {
  body: Record<string, unknown>
  query: URLSearchParams
  origin: string | undefined
}

/** One write's refresh bookkeeping. */
interface RunWriteOptions {
  /** Fail with the staging-history lock instead of the general busy error. */
  stageHistory?: boolean
  /** Wrap the write in the backend's history recording. */
  considerHistory?: boolean
  /** Changed view domains reported to watching panels. */
  domains?: readonly string[]
  /** Canonical owning store for a lifecycle request that already resolved it. */
  common?: string
  /** Lifecycle writes can change files or registration before returning an error. */
  changed?: () => boolean
}

/** Whether a parsed JSON value is an object the routes can read fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One changed line address. */
interface LineAddress {
  hunk: number
  line: number
}

/** Whether a parsed value is a changed line address. */
function isLineAddress(value: unknown): value is LineAddress {
  if (value === null || typeof value !== 'object') return false
  if (!('hunk' in value) || !('line' in value)) return false
  return typeof value.hunk === 'number' && Number.isSafeInteger(value.hunk) && value.hunk >= 0
    && typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line >= 0
}

/** The `code` field a caught failure reports, when it has one. */
function failureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/** The route's session id text as the branded id the session store keys on. */
function sessionIdOf(id: string): SessionId {
  return id as SessionId
}

/**
 * Clamp a number into a range.
 * @param value - the number.
 * @param min - lowest accepted value.
 * @param max - highest accepted value.
 * @returns the clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Read an optional integer query value.
 * @param value - the query value.
 * @param fallback - value when the query omits it.
 * @returns the number, or undefined when malformed.
 */
function readInteger(value: string | null, fallback: number): number | undefined {
  if (value === null) return fallback
  if (!/^-?\d+$/u.test(value)) return undefined
  return Number(value)
}

/**
 * Read a non-negative safe integer query value.
 * @param value - the query value.
 * @returns the integer, or undefined when missing or malformed.
 */
function readNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Validate the files of a group or folder write. Each names a repository-relative
 * file, or with a trailing slash an untracked directory to stage; a rename may
 * name its original path.
 * @param body - the request.
 * @returns the files.
 */
function readStagingFiles(body: Record<string, unknown>): StagingFile[] {
  const { scope, files } = body
  if (typeof scope !== 'string' || !STAGING_FILES_SCOPES.has(scope)) throw badRequest('scope is staged or unstaged for several files.')
  if (body.path !== undefined || body.oldPath !== undefined || body.fingerprint !== undefined || body.lines !== undefined) {
    throw badRequest('files replaces path, oldPath, fingerprint, and lines.')
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > STAGING_FILES_MAX) {
    throw badRequest(`files lists 1 to ${STAGING_FILES_MAX} files.`)
  }
  const entries: readonly unknown[] = files
  const seen = new Set<string>()
  return entries.map(file => {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw badRequest('Each file names a repository-relative path.')
    }
    const directory = file.path.endsWith('/')
    const path = validateRelPath(directory ? file.path.slice(0, -1) : file.path)
    if (path === undefined || (directory && scope !== 'unstaged')) {
      throw badRequest('Each file names a repository-relative path; only staging names an untracked directory.')
    }
    const oldPath = validateRelPath(file.oldPath)
    if (file.oldPath != null && (oldPath === undefined || oldPath === path || directory)) {
      throw badRequest('oldPath must name a different repository-relative file.')
    }
    if (seen.has(path)) throw badRequest('Each file appears once.')
    seen.add(path)
    return { path, ...(oldPath === undefined ? {} : { oldPath }), ...(directory ? { directory: true as const } : {}) }
  })
}

/**
 * Whether a request value can name a branch, tag, or remote. The backend
 * adds the repository's own listing and ref-format checks on top.
 * @param value - the request value.
 * @returns whether it is a usable name.
 */
function isRefName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 255
    && !/[\u0000-\u0020\u007f]/u.test(value) && !value.startsWith('-')
}

/**
 * Build the route handlers bound to one host context.
 *
 * @param ctx - Host context carrying `sessions`, `fs`, and `subprocess`.
 * @param options - shared backend and turn-head state.
 * @returns one request handler per route.
 */
export function createHandlers(ctx: HandlersContext, {
  backends = createBackends(ctx), turnTracker = ctx?.turnTracker, watchHub = createWatchHub(ctx),
}: CreateHandlersOptions = {}): VcsRouteHandlers {
  /** Resolve the optional Host per-turn change recorder service. */
  function workspaceChanges() {
    return workspaceChangesService(ctx)
  }

  /**
   * Resolve the session a request addresses to its working directory.
   * The client sends a session identity rather than a path, so the browser
   * cannot aim this plugin at an arbitrary directory.
   * @param query - the request query.
   * @returns the session id and working directory.
   * @throws when the session or its directory is missing.
   */
  async function requireSession(query: URLSearchParams): Promise<RequestSession> {
    const sessionId = query.get('sessionId')
    if (sessionId === null || sessionId === '') throw badRequest('sessionId is required.')
    const session = ctx.sessions.get(sessionIdOf(sessionId))
    if (session === undefined) {
      throw new VcsError('no-session', 'This session is no longer available.')
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new VcsError('no-cwd', 'This session has no working directory.')
    }
    return { sessionId, cwd }
  }

  /**
   * Resolve the request's repository query against what discovery offers,
   * never against the string alone.
   * @param query - the request query.
   * @param signal - cancellation.
   * @returns the repository.
   */
  async function requireRepository(query: URLSearchParams, signal: AbortSignal): Promise<RepositoryTarget> {
    const { cwd } = await requireSession(query)
    const repoQuery = query.get('repo')
    if (repoQuery === null || repoQuery === '') throw badRequest('repo is required.')
    const match = await requireRepositoryMatch(cwd, repoQuery, signal)
    const vcs = match.vcs
    if (vcs === undefined) {
      throw new VcsError('internal', 'This repository uses an unsupported version control backend.')
    }
    const backend = backends.get(vcs)
    if (backend === undefined) {
      throw new VcsError('internal', 'This repository uses an unsupported version control backend.')
    }
    return { root: match.path, name: repositoryName(match.path), vcs, backend }
  }

  async function requireRepositoryMatch(cwd: string, path: string, signal: AbortSignal) {
    const match = await resolveSessionRepository(ctx, cwd, path, signal)
    if (match === undefined) throw new VcsError('not-a-repo', 'The requested repository is not available in this session.')
    return match
  }

  /** Content reads can target a verified sibling of the allowed repository. */
  async function requireBrowseTarget(query: URLSearchParams, signal: AbortSignal): Promise<BrowseTarget> {
    const repo = await requireRepository(query, signal)
    const path = query.get('worktree')
    if (path === null) return { ...repo, capabilities: repo.backend.capabilities, preview: false }
    if (query.getAll('worktree').length !== 1) throw badRequest('Select one worktree for this request.')
    if (isAbsolute(path) && !sameRepoPath(path, repo.root) && typeof repo.backend.worktrees === 'function') {
      for await (const worktree of repo.backend.worktrees(repo.root, signal, { paths: [path] })) {
        return {
          ...repo,
          root: worktree.path,
          name: worktree.name ?? repositoryName(worktree.path),
          capabilities: repo.backend.worktreeCapabilities,
          preview: true,
        }
      }
    }
    throw new VcsError('not-a-repo', 'That worktree is not available from the selected repository.')
  }

  /** Group checkouts of the same backend and store under a session-allowed anchor. */
  async function groupRepositories(roots: DiscoveredRepository[], signal: AbortSignal): Promise<{ repositories: GroupedRepository[], worktreesTruncated: boolean }> {
    const repositories: GroupedRepository[] = []
    let sessionDirectories: Awaited<ReturnType<typeof worktreeSessionDirectories>> | null | undefined
    let siblings = 0
    let worktreesTruncated = false
    for (const repo of roots) {
      const backend = repo.vcs === undefined ? undefined : backends.get(repo.vcs)
      const entry: GroupedRepository = { ...repo, capabilities: backend?.capabilities }
      if (typeof backend?.worktrees !== 'function') {
        repositories.push(entry)
        continue
      }
      // Keep independently discovered roots when their store cannot supply a
      // verified path for them (for example an old Jujutsu registration).
      const group = repositories.find(item => item.vcs === repo.vcs
        && item.worktrees?.some(tree => sameRepoPath(tree.path, repo.path)))
      if (group !== undefined) {
        for (const source of repo.sources) {
          if (!group.sources.some(item => item.kind === source.kind && item.path === source.path)) group.sources.push(source)
        }
        continue
      }
      const worktrees: Worktree[] = [{ path: repo.path, name: repo.name, branch: null, head: null }]
      try {
        const lifecycle = await backend.lifecycleInfo?.(repo.path, signal)
        if (lifecycle?.forgotten === true) continue
        entry.capabilities = lifecycle?.capabilities ?? backend.capabilities
        const commonDir = await backend.commonDir(repo.path, signal)
        if (commonDir !== null) {
          for await (const tree of backend.worktrees(repo.path, signal, { commonDir })) {
            if (sameRepoPath(tree.path, repo.path)) {
              worktrees[0] = { ...tree, name: tree.name ?? repo.name, canRemove: false, canForget: false }
            } else if (!worktrees.some(existing => sameRepoPath(existing.path, tree.path))) {
              if (siblings === WORKTREE_MAX) {
                worktreesTruncated = true
                break
              }
              siblings += 1
              if (sessionDirectories === undefined) {
                sessionDirectories = await worktreeSessionDirectories(ctx, signal).catch(error => {
                  if (signal.aborted || isAbortError(error)) throw error
                  return null
                })
              }
              const inUse = sessionDirectories === null ? undefined : await worktreeInUse(ctx, tree.path, sessionDirectories, signal).catch(error => {
                if (signal.aborted || isAbortError(error)) throw error
                return undefined
              })
              const eligible = tree.primary === false && !tree.locked && inUse === false
              worktrees.push({ ...tree, name: tree.name ?? repositoryName(tree.path), inUse,
                canRemove: eligible && entry.capabilities.worktreeRemove,
                canForget: eligible && entry.capabilities.worktreeForget })
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error
        if (failureCode(error) === 'output-too-large') worktreesTruncated = true
      }
      repositories.push({ ...entry, worktrees })
    }
    return { repositories, worktreesTruncated }
  }

  async function findRepositories(cwd: string, signal: AbortSignal) {
    const found = await discoverRepositories(ctx, cwd, signal)
    return {
      ...found,
      ...await groupRepositories(found.repositories, signal),
    }
  }

  /** Handle `GET /api/vcs.repositories`. */
  async function repositories(request: Request): Promise<Response> {
    const { cwd } = await requireSession(new URL(request.url).searchParams)
    return json(await findRepositories(cwd, request.signal))
  }

  /** Handle `GET /api/vcs.activity` without taking a write lock or snapshot. */
  async function activity(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const rawUntil = query.get('until')
    const until = rawUntil === null ? null : readNonNegativeInteger(rawUntil)
    if (until === undefined || query.getAll('until').length > 1) {
      throw badRequest('until must be a non-negative safe integer.')
    }
    const limit = readInteger(query.get('limit'), ACTIVITY_PAGE_SIZE)
    if (limit === undefined || limit < 1 || limit > ACTIVITY_PAGE_MAX || query.getAll('limit').length > 1) {
      throw badRequest(`limit must be an integer from 1 to ${ACTIVITY_PAGE_MAX}.`)
    }
    const { signal } = request
    const { cwd } = await requireSession(query)
    signal.throwIfAborted()
    const { repositories } = await findRepositories(cwd, signal)
    const results = await mapLimited(repositories, 4, async (item): Promise<{ repo: string; page: ActivityRepositoryAnswer } | ActivityFailure> => {
      signal.throwIfAborted()
      const repo = item.path
      try {
        const match = await requireRepositoryMatch(cwd, repo, signal)
        if (match.vcs !== item.vcs) throw new VcsError('not-a-repo', 'The repository has changed.')
        const backend = match.vcs === undefined ? undefined : backends.get(match.vcs)
        if (typeof backend?.activity !== 'function') return { repo, error: { code: 'unsupported' } }
        await backend.require(signal)
        const heads = [...new Set((item.worktrees ?? []).map(tree => tree.head).filter(isFullSha))]
        return { repo, page: await backend.activity(match.path, { until, limit, heads }, signal) }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        if (!(error instanceof VcsError)) warn(error instanceof Error ? error.message : String(error))
        return { repo, error: { code: error instanceof VcsError ? error.code : 'internal' } }
      }
    })
    signal.throwIfAborted()
    return json(mergeActivity(results, limit))
  }

  async function repositoryConfig(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { cwd } = await requireSession(query)
    return json(await readRepositoryConfig(ctx, cwd, request.signal))
  }

  async function repositoryPreview(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { cwd } = await requireSession(query)
    return json(await previewRepositoryConfig(ctx, cwd, query.get('kind'), query.get('path'), request.signal))
  }

  /** Handle `GET /api/vcs.repository-scan` with discovery only, without reading repository summaries. */
  async function repositoryScan(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { signal } = request
    signal.throwIfAborted()
    if (query.getAll('sessionId').length > 1) throw badRequest('Request one session.')
    const { cwd: sessionCwd } = await requireSession(query)
    const cwd = await canonicalDirectory(ctx, sessionCwd, signal)
    if (cwd === null) throw new VcsError('no-cwd', 'The session working directory is not available.')
    const git = backends.get('git')
    if (typeof git?.unlisted !== 'function') return json({ roots: [], truncated: false })

    const { repositories } = await findRepositories(cwd, signal)
    const commons: string[] = []
    const roots: string[] = []
    for (const repo of repositories) {
      signal.throwIfAborted()
      roots.push(repo.path)
      const backend = repo.vcs === undefined ? undefined : backends.get(repo.vcs)
      if (backend === undefined) continue
      const common = await backend.commonDir(repo.path, signal).catch(error => {
        if (signal.aborted || isAbortError(error)) throw error
        return null
      })
      if (common !== null) commons.push(common)
    }
    signal.throwIfAborted()
    const found = await git.unlisted(cwd, { commons, roots }, signal)
    signal.throwIfAborted()
    return json({
      roots: found.roots.flatMap(root => {
        const path = validateRelPath(relative(cwd, root.path).split(sep).join('/'))
        return path === undefined ? [] : [{ path, vcs: root.vcs }]
      }),
      truncated: found.truncated,
    })
  }

  async function saveRepositoryConfig(request: Request): Promise<Response> {
    const { body, query, origin } = await readWrite(request, 'Repository configuration')
    const { sessionId, cwd } = await requireSession(query)
    const result = await persistRepositoryConfig(ctx, cwd, sessionId, {
      revision: body.revision,
      scanDirectories: body.scanDirectories,
      repositories: body.repositories,
      backends: body.backends,
    }, request.signal)
    watchHub.repositoryConfigChanged(sessionId, origin)
    return json(result)
  }

  /**
   * Handle `GET /api/vcs.overview`: one NDJSON line per repository, in the order
   * the reads finish, so the first answers draw before the slowest one. With
   * `repo`, only that discovered repository is read; without it, every
   * discovered repository is read.
   */
  async function overview(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { cwd: sessionCwd } = await requireSession(query)
    const requested = query.getAll('repo')
    if (requested.length > 1) throw badRequest('Request one repository or every repository.')
    const cwd = await canonicalDirectory(ctx, sessionCwd, request.signal)
    if (cwd === null) throw new VcsError('no-cwd', 'The session working directory is not available.')
    let targets: Array<{ path: string, vcs: string }>
    if (requested.length === 1) {
      const repo = await requireRepository(query, request.signal)
      await repo.backend.require(request.signal)
      targets = [{ path: repo.root, vcs: repo.vcs }]
    } else {
      const { repositories: grouped } = await findRepositories(sessionCwd, request.signal)
      targets = grouped.flatMap(entry => entry.vcs === undefined ? [] : [{ path: entry.path, vcs: entry.vcs }])
    }
    const reading = new AbortController()
    const signal = AbortSignal.any([request.signal, reading.signal])
    const statusLimiter = createLimiter(4)
    const encoder = new TextEncoder()

    const readOne = async (path: string, vcs: string): Promise<Record<string, unknown>> => {
      const registered = true
      const backend = backends.get(vcs)
      if (typeof backend?.overview !== 'function') return { type: 'repository', repository: unsupportedOverview(path, vcs, registered) }
      try {
        await backend.require(signal)
        const repository: OverviewRepository = await backend.overview(path, { registered, statusLimiter, signal })
        return { type: 'repository', repository }
      } catch (error) {
        if (signal.aborted) throw error
        const code = error instanceof VcsError ? error.code : 'internal'
        if (!(error instanceof VcsError)) warn(error instanceof Error ? error.message : String(error))
        return { type: 'error', path, vcs, registered, error: { code, message: error instanceof VcsError ? error.message : 'The repository could not be read.' } }
      }
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (line: Record<string, unknown>) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        }
        const run = async () => {
          send({ type: 'scope', cwd, repositories: targets.length })
          const limiter = createLimiter(4)
          await Promise.all(targets.map(target => limiter.run(async () => { send(await readOne(target.path, target.vcs)) })))
          send({ type: 'done' })
        }
        run().then(() => {
          if (!signal.aborted) controller.close()
        }, error => {
          if (signal.aborted) return
          warn(error instanceof Error ? error.message : String(error))
          send({ type: 'done', failed: true })
          controller.close()
        })
      },
      cancel() { reading.abort() },
    })
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
  }

  /** Handle `GET /api/vcs.watch` with the same repository and worktree validation as reads. */
  async function watch(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const signal = AbortSignal.any([request.signal, watchHub.signal])
    const { sessionId, cwd: sessionCwd } = await requireSession(query)
    const cwd = await canonicalDirectory(ctx, sessionCwd, signal)
    if (cwd === null) throw new VcsError('no-cwd', 'The session working directory is not available.')
    const repo = query.has('repo') ? await requireRepository(query, signal) : null
    const paths = query.getAll('worktree')
    validateWorktreeSelection(paths)
    if (repo === null && paths.length > 0) throw badRequest('A worktree selection requires a repository.')
    let roots: string[] = []
    let common: string | null = null
    if (repo !== null) {
      await repo.backend.require(signal)
      const siblings = paths.filter(path => !sameRepoPath(path, repo.root))
      const selected = await requireWorktrees(repo, siblings, signal)
      roots = selected.map(tree => tree.path)
      if (paths.length === 0 || paths.some(path => sameRepoPath(path, repo.root))) roots.unshift(repo.root)
      const path = await repo.backend.commonDir?.(repo.root, signal)
      if (path != null) common = await canonicalDirectory(ctx, path, signal)
    }
    return watchHub.open({
      sessionId, cwd, repo, roots, common,
      client: watchClientId(query.get('client')), request,
    })
  }

  /** Handle `GET /api/vcs.status`. */
  async function status(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)
    const readStatus = (signal: AbortSignal) => repo.backend.status(repo.root, signal, { snapshot: query.get('readOnly') !== '1' })
    const answer = repo.vcs === 'git'
      ? await watchHub.gitStatus.read(repo.root, readStatus, request.signal)
      : await readStatus(request.signal)
    return json({
      ...answer,
      stageHistory: repo.preview ? EMPTY_STAGE_HISTORY : repo.backend.stageHistoryTips?.(repo.root) ?? EMPTY_STAGE_HISTORY,
      repo: { path: repo.root, name: repo.name },
      vcs: repo.vcs,
      capabilities: repo.capabilities,
      defaultNode: repo.preview && repo.capabilities.workingCopy === 'row' ? WORKING_TREE_NODE : answer.defaultNode,
    })
  }

  /** Handle `GET /api/vcs.untracked`. */
  async function untracked(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    if (repo.capabilities.untracked !== true || typeof repo.backend.untracked !== 'function') {
      throw badRequest('This repository has no untracked directories to expand.')
    }
    await repo.backend.require(request.signal)
    const answer = await repo.backend.untracked(repo.root, query.get('path'), request.signal)
    return json(answer)
  }

  /** Handle `GET /api/vcs.diff`. */
  async function diff(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)

    const scope = query.get('scope')
    if (scope === null || scope === '') throw badRequest('scope is required.')
    if ((scope === 'stash' || scope === 'stash-untracked') && !repo.capabilities.stashOps) {
      throw badRequest('This repository has no stash detail.')
    }
    const rel = validateRelPath(query.get('path'))
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')
    const rawOldPath = query.get('oldPath')
    const oldPath = rawOldPath === null ? null : validateRelPath(rawOldPath)
    if (rawOldPath !== null && oldPath === undefined) {
      throw badRequest('oldPath must be a repository-relative file path.')
    }

    const answer = await repo.backend.diff(repo.root, {
      scope,
      path: rel,
      oldPath,
      rev: query.get('rev'),
      readOnly: repo.preview,
    }, request.signal)
    return json(answer)
  }

  /** Handle `GET /api/vcs.log`. */
  async function log(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    await repo.backend.require(request.signal)

    const { ranges, defaultRange } = repo.backend.capabilities
    const ref = query.get('ref') ?? defaultRange
    if (!ranges.some(range => range.value === ref)) {
      const values = ranges.map(range => range.value).join(', ')
      throw badRequest(`ref is ${values}.`)
    }
    const limitValue = readInteger(query.get('limit'), LOG_PAGE_MAX)
    const skipValue = readInteger(query.get('skip'), 0)
    if (limitValue === undefined) throw badRequest('limit must be an integer.')
    if (skipValue === undefined) throw badRequest('skip must be an integer.')
    const limit = clamp(limitValue, 1, LOG_PAGE_MAX)
    const skip = clamp(skipValue, 0, LOG_SKIP_MAX)

    const paths = query.getAll('worktree')
    if (paths.length === 0) return json(await repo.backend.log(repo.root, { ref, limit, skip }, request.signal))
    validateWorktreeSelection(paths)
    const worktreeHeads = await requireWorktrees(repo, paths, request.signal)
    const heads = worktreeHeads.flatMap(tree => tree.head === null ? [] : [tree.head])
    const page = await repo.backend.log(repo.root, { ref, limit, skip, heads }, request.signal)
    return json({ ...page, worktreeHeads })
  }

  function validateWorktreeSelection(paths: string[]): void {
    if (paths.length > WORKTREE_MAX + 1 || paths.some((path, index) => (
      !isAbsolute(path) || paths.slice(0, index).some(other => sameRepoPath(path, other))
    ))) {
      throw badRequest('The worktree selection is invalid.')
    }
  }

  async function requireWorktrees(repo: RepositoryTarget, paths: string[], signal: AbortSignal): Promise<WorktreeHead[]> {
    if (paths.length === 0) return []
    if (typeof repo.backend.worktrees !== 'function') throw badRequest('This repository has no worktree selection.')
    const remaining = [...paths]
    const worktreeHeads: WorktreeHead[] = []
    for await (const tree of repo.backend.worktrees(repo.root, signal, { paths })) {
      const index = remaining.findIndex(path => sameRepoPath(path, tree.path))
      if (index < 0) continue
      remaining.splice(index, 1)
      worktreeHeads.push({ path: tree.path, head: tree.head })
      if (remaining.length === 0) break
    }
    if (remaining.length > 0) throw new VcsError('not-a-repo', 'The worktree selection is no longer available from this repository.')
    return worktreeHeads
  }

  /** Handle `GET /api/vcs.commit`. */
  async function commit(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)

    const answer = await repo.backend.commit(repo.root, query.get('sha'), request.signal)
    return json(answer)
  }

  async function stash(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { backend, root } = await requireRepository(query, request.signal)
    if (!backend.capabilities.stashOps || backend.stash === undefined) throw badRequest('This repository has no stash detail.')
    const sha = requireStashSha(query.get('sha'))
    await backend.require(request.signal)
    return json(await backend.stash(root, sha, request.signal))
  }

  async function stashCheck(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { backend, root } = await requireRepository(query, request.signal)
    if (!backend.capabilities.stashOps || backend.stashCheck === undefined) throw badRequest('This repository has no stash actions.')
    const sha = requireStashSha(query.get('sha'))
    const mode = query.get('mode')
    const index = query.get('index')
    if (mode !== 'apply' && mode !== 'branch') throw badRequest('mode must be apply or branch.')
    if (index !== '0' && index !== '1') throw badRequest('index must be 0 or 1.')
    await backend.require(request.signal)
    return json(await backend.stashCheck(root, sha, mode, index === '1', request.signal))
  }

  /** Repository roots and stores with a write in flight. */
  const writing = new Set<string>()
  const creating = new Set<string>()

  /**
   * Run one write under the repository's single-flight lock.
   * @param repo - the resolved repository.
   * @param request - the write request.
   * @param run - the write, returning the JSON payload.
   * @param options - refresh bookkeeping for this write.
   * @returns the JSON answer.
   */
  async function runWrite(
    repo: RepositoryTarget,
    request: Request,
    run: () => Promise<unknown>,
    { stageHistory = false, considerHistory = false, domains = [WORKING], common, changed }: RunWriteOptions = {},
  ): Promise<Response> {
    const commonDir = common ?? await repo.backend.commonDir(repo.root, request.signal)
    const store = commonDir === null ? null : await canonicalDirectory(ctx, commonDir, request.signal)
    const keys = store === null ? [repo.root] : [repo.root, store]
    // Standard colocated stores have different metadata paths, but own the
    // same primary checkout. Other stores still synchronize by exact identity.
    if (store !== null && repo.vcs === 'git' && basename(store) === '.git') keys.push(dirname(store))
    if (store !== null && repo.vcs === 'jujutsu' && basename(store) === 'repo' && basename(dirname(store)) === '.jj') {
      keys.push(dirname(dirname(store)))
    }
    if (keys.some(key => writing.has(key))) {
      if (stageHistory) throw stageHistoryError('busy')
      throw new VcsError('busy', 'Another write is already running for this repository.')
    }
    for (const key of keys) writing.add(key)
    let finish: WriteFinish | undefined
    let succeeded = false
    try {
      finish = await watchHub.beginWrite(repo, request.signal, domains.includes(HISTORY))
      const result = considerHistory && typeof repo.backend.aroundHistoryWrite === 'function'
        ? await repo.backend.aroundHistoryWrite(repo.root, request.signal, run)
        : await run()
      succeeded = true
      return json(result)
    } finally {
      for (const key of keys) writing.delete(key)
      // Failed lifecycle or stash commands can leave changes. Invalidate the initiator too.
      finish?.(succeeded || changed?.() ? domains : undefined, succeeded ? watchClientId(request.headers.get('X-VCS-Client')) : undefined)
    }
  }

  /**
   * Read the JSON body of a write route and resolve its session and repository
   * fields into a query.
   *
   * The body is JSON, which a cross-site form cannot send without a CORS
   * preflight, and a browser-declared cross-site request is refused outright.
   * Only the session's ordinary repositories can be written to.
   *
   * @param request - the write request.
   * @param label - human name of the action, for messages.
   * @returns the parsed body and its target.
   */
  async function readWrite(request: Request, label: string, allowLifecycleTarget = false): Promise<WriteRequest> {
    if (request.method !== 'POST') throw badRequest(`${label} is a POST request.`)
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      throw new VcsError('forbidden', `${label} only accepts requests from this app.`)
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) {
      throw badRequest(`${label} expects a JSON body.`)
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw badRequest('The request body is not valid JSON.')
    }
    if (!isRecord(body)) {
      throw badRequest('The request body must be an object.')
    }
    if ((!allowLifecycleTarget && Object.hasOwn(body, 'worktree')) || new URL(request.url).searchParams.has('worktree')) {
      throw new VcsError('forbidden', 'Worktree previews are read-only.')
    }
    const query = new URLSearchParams()
    for (const key of ['sessionId', 'repo']) {
      const value = body[key]
      if (typeof value === 'string') query.set(key, value)
    }
    return { body, query, origin: watchClientId(request.headers.get('X-VCS-Client')) }
  }

  /**
   * Handle `POST /api/vcs.sync`.
   */
  async function sync(request: Request): Promise<Response> {
    const { query } = await readWrite(request, 'Sync')

    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.sync !== true || typeof backend.sync !== 'function') {
      throw badRequest('This repository cannot sync from the panel.')
    }
    await backend.require(request.signal)
    const runSync = backend.sync
    return runWrite(repo, request, () => runSync.call(backend, repo.root, request.signal), { considerHistory: true, domains: REFS })
  }

  /**
   * Handle `GET /api/vcs.branches`, the local branches a switch can target.
   */
  async function branches(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.branchSwitch !== true || typeof backend.branches !== 'function') {
      throw badRequest('This repository has no local branches to switch.')
    }
    await backend.require(request.signal)
    return json(await backend.branches(repo.root, request.signal))
  }

  /**
   * Handle `GET /api/vcs.remotes`, the destinations a tag can be pushed to.
   */
  async function remotes(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if ((backend.capabilities.tagOps !== true && backend.capabilities.branchOps !== true)
      || typeof backend.remotes !== 'function') {
      throw badRequest('This repository has no remotes to list.')
    }
    await backend.require(request.signal)
    return json(await backend.remotes(repo.root, request.signal))
  }

  /**
   * Handle `POST /api/vcs.switch`.
   *
   * The branch name is checked against the repository's own local branch list
   * by the backend, so only an existing local branch can reach `git switch`.
   */
  async function switchBranch(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Branch switching')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.branchSwitch !== true || typeof backend.switchBranch !== 'function') {
      throw badRequest('This repository cannot switch branches from the panel.')
    }
    const branch = body.branch
    if (!isRefName(branch)) throw badRequest('branch must name a local branch.')
    await backend.require(request.signal)
    const runSwitch = backend.switchBranch
    return runWrite(repo, request, () => runSwitch.call(backend, repo.root, branch, request.signal), { considerHistory: true, domains: REFS })
  }

  /**
   * Handle `POST /api/vcs.branch`, the branch actions menu's write.
   *
   * `action` selects one fixed command. The target branch and, for a rename,
   * the new name are strings checked here and then against the repository's
   * own branch list or ref rules, so no request value reaches git unverified.
   */
  async function branchOp(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Branch actions')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.branchOps !== true || typeof backend.branchOp !== 'function') {
      throw badRequest('This repository has no branch actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !BRANCH_ACTIONS.has(action)) {
      throw badRequest('action must be a branch or remote-branch action.')
    }
    const branch = body.branch
    if (!isRefName(branch)) throw badRequest('branch must name a branch.')

    let name: string | undefined
    if (action === 'rename') {
      if (!isRefName(body.name)) throw badRequest('name must name the renamed branch.')
      name = body.name
    }
    let local: string | undefined
    if (action === 'checkout-remote') {
      if (!isRefName(body.local)) throw badRequest('local must name the new local branch.')
      local = body.local
    }
    let force = false
    if (action === 'delete') {
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        throw badRequest('force must be a boolean.')
      }
      force = body.force === true
    }

    await backend.require(request.signal)
    const runBranchOp = backend.branchOp
    return runWrite(repo, request, () => runBranchOp.call(backend, repo.root, {
      action,
      branch,
      name,
      local,
      force,
    }, request.signal), { considerHistory: BRANCH_HISTORY_ACTIONS.has(action), domains: action === 'delete' ? [HISTORY] : REFS })
  }

  /**
   * Handle `POST /api/vcs.tag`, the tag actions menu's write.
   *
   * Deleting removes one local tag; pushing sends one tag to a remote the
   * backend confirms this repository lists. Both names are checked here and
   * again by the backend before reaching git.
   */
  async function tagOp(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Tag actions')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.tagOps !== true || typeof backend.tagOp !== 'function') {
      throw badRequest('This repository has no tag actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !TAG_ACTIONS.has(action)) {
      throw badRequest('action must be delete or push.')
    }
    const tag = body.tag
    if (!isRefName(tag)) throw badRequest('tag must name a local tag.')

    let remote: string | undefined
    if (action === 'push') {
      if (!isRefName(body.remote)) throw badRequest('remote must name a configured remote.')
      remote = body.remote
    }

    await backend.require(request.signal)
    const runTagOp = backend.tagOp
    return runWrite(repo, request, () => runTagOp.call(backend, repo.root, { action, tag, remote }, request.signal), { domains: [HISTORY] })
  }

  /**
   * Handle `POST /api/vcs.commit-op`, the commit actions menu's write.
   *
   * The commit id is hexadecimal. Tag and branch creation, optional checkout on
   * branch creation, reset, and the optional tag message are checked here and
   * again by the backend before reaching git. Every action names one existing
   * commit.
   */
  async function commitOp(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Commit actions')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.commitOps !== true || typeof backend.commitOp !== 'function') {
      throw badRequest('This repository has no commit actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !COMMIT_ACTIONS.has(action)) {
      throw badRequest('action must be tag, branch, checkout, cherry-pick, revert, drop, merge, rebase, or reset.')
    }
    const sha = validateSha(body.sha)
    if (sha === undefined) throw badRequest('sha must be a hexadecimal commit id.')

    let name: string | undefined
    if (action === 'tag' || action === 'branch') {
      if (!isRefName(body.name)) throw badRequest('name must name the new ref.')
      name = body.name
    }
    let message = ''
    if (action === 'tag' && body.message !== undefined) {
      if (typeof body.message !== 'string' || body.message.length > 4000) {
        throw badRequest('message must be text of at most 4000 characters.')
      }
      message = body.message
    }
    let checkout = false
    if (action === 'branch') {
      if (body.checkout !== undefined && typeof body.checkout !== 'boolean') {
        throw badRequest('checkout must be a boolean.')
      }
      checkout = body.checkout === true
    }
    let mode: string | undefined
    if (action === 'reset') {
      if (typeof body.mode !== 'string' || !RESET_MODES.has(body.mode)) {
        throw badRequest('mode must be soft, mixed, or hard.')
      }
      mode = body.mode
    }

    await backend.require(request.signal)
    const runCommitOp = backend.commitOp
    return runWrite(repo, request, () => runCommitOp.call(backend, repo.root, {
      action,
      sha,
      name,
      message,
      checkout,
      mode,
    }, request.signal), {
      considerHistory: action !== 'tag' && (action !== 'branch' || checkout),
      domains: action === 'tag' || (action === 'branch' && !checkout) ? [HISTORY] : REFS,
    })
  }

  /** Handle `POST /api/vcs.stash`; resolve selectors and repeat preflight inside runWrite. */
  async function stashOp(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Stash actions')
    const repo = await requireRepository(query, request.signal)
    const { backend, root } = repo
    const run = backend.stashOp
    if (!backend.capabilities.stashOps || run === undefined) throw badRequest('This repository has no stash actions.')

    const { action, message, untracked, index, drop, name } = body
    let target: StashRequest
    if (action === 'push') {
      if (typeof untracked !== 'boolean') throw badRequest('untracked must be a boolean.')
      if (message !== undefined && (typeof message !== 'string' || message.length > STASH_MESSAGE_MAX
        || /[\0\r\n\u2028\u2029]/u.test(message))) {
        throw badRequest('message must be a single line of at most 1000 characters.')
      }
      target = { action, message, untracked }
    } else if (action === 'apply') {
      if (typeof index !== 'boolean' || typeof drop !== 'boolean') throw badRequest('index and drop must be booleans.')
      target = { action, sha: requireStashSha(body.sha), index, drop }
    } else if (action === 'branch') {
      if (!isRefName(name)) throw new VcsError('branch-invalid', 'That name is not a valid branch name.')
      target = { action, sha: requireStashSha(body.sha), name }
    } else if (action === 'drop') {
      target = { action, sha: requireStashSha(body.sha) }
    } else throw badRequest('action must be push, apply, branch, or drop.')

    await backend.require(request.signal)
    let changed = false
    return runWrite(repo, request, async () => {
      try {
        return await run.call(backend, root, target, request.signal)
      } catch (error) {
        changed = action !== 'drop' && error instanceof VcsError
          && (error.code === 'stash-conflict' || error.code === 'stash-failed')
        throw error
      }
    }, { domains: action === 'drop' ? [HISTORY] : REFS, considerHistory: true, changed: () => changed })
  }

  /** Handle `POST /api/vcs.worktree` with a session-authorized repository as anchor. */
  async function worktreeOp(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Worktree lifecycle', true)
    const { action, path, worktree, mode, name, revision, expectedName, expectedBranch, expectedHead } = body
    if (action !== 'create' && action !== 'remove' && action !== 'forget') throw badRequest('Choose a worktree lifecycle action.')
    const signal = request.signal
    const { cwd } = await requireSession(query)
    const repo = await requireRepository(query, signal)
    const backend = repo.backend
    await backend.require(signal)
    const capabilities = (await backend.lifecycleInfo?.(repo.root, signal))?.capabilities ?? backend.capabilities
    const canRun = action === 'create' ? capabilities.worktreeCreate && backend.createWorktree !== undefined
      : (action === 'remove' ? capabilities.worktreeRemove : capabilities.worktreeForget) && backend.deleteWorktree !== undefined
    if (!canRun) throw new VcsError('worktree-unsupported', 'This repository does not support that worktree lifecycle action.')
    const commonDir = await backend.commonDir(repo.root, signal)
    const common = commonDir === null ? null : await canonicalDirectory(ctx, commonDir, signal)
    if (common === null) throw new VcsError('worktree-protected', 'The repository storage could not be verified.')

    let mutated = false
    const changed = () => { mutated = true }
    const options = { common, domains: [REPOSITORIES, ...REFS], changed: () => mutated }
    const recheckRepository = async () => {
      const fresh = await requireRepository(query, signal)
      const dir = await backend.commonDir(repo.root, signal)
      if (fresh.vcs !== repo.vcs || !sameRepoPath(fresh.root, repo.root)
        || dir === null || await canonicalDirectory(ctx, dir, signal) !== common) {
        throw new VcsError('worktree-stale', 'The repository has changed. Refresh and choose the worktree again.')
      }
    }
    if (action === 'create') {
      if (typeof path !== 'string') throw new VcsError('worktree-path-invalid', 'Choose a valid new worktree directory.')
      if (worktree !== undefined || expectedName !== undefined || expectedBranch !== undefined || expectedHead !== undefined) {
        throw badRequest('Creation takes a new directory, without an existing worktree target.')
      }
      if (mode !== undefined && mode !== 'new' && mode !== 'existing' && mode !== 'detach') throw badRequest('Choose a Git checkout mode.')
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '' || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name))) {
        throw badRequest('Choose a valid branch or workspace name.')
      }
      if (revision !== undefined && (typeof revision !== 'string' || revision.trim() === '' || revision.length > 1024
        || revision.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(revision))) {
        throw new VcsError('worktree-revision-invalid', 'Choose a valid worktree revision.')
      }
      return runWrite(repo, request, async () => {
        await recheckRepository()
        const destination = await newWorktreePath(ctx, cwd, repo.root, path, signal)
        const key = process.platform === 'win32' || process.platform === 'darwin' ? destination.toLowerCase() : destination
        if (creating.has(key)) throw new VcsError('busy', 'Another worktree creation is using this destination.')
        creating.add(key)
        try {
          await backend.createWorktree!(repo.root, common, { path: destination, mode, name, revision }, signal, recheckRepository, changed)
          return { path: destination }
        } finally {
          creating.delete(key)
        }
      }, options)
    }
    if (typeof worktree !== 'string' || !isAbsolute(worktree) || worktree.includes('\0') || worktree.length > 4096
      || path !== undefined || mode !== undefined || name !== undefined || revision !== undefined
      || expectedName !== undefined && typeof expectedName !== 'string'
      || expectedBranch !== undefined && expectedBranch !== null && typeof expectedBranch !== 'string'
      || expectedHead !== undefined && expectedHead !== null && validateSha(expectedHead) !== expectedHead) {
      throw badRequest('Choose a registered worktree by its absolute path.')
    }
    const readTarget = async (): Promise<Worktree> => {
      await recheckRepository()
      for await (const tree of backend.worktrees(repo.root, signal, { commonDir: common, paths: [worktree] })) {
        if (tree.path !== worktree) continue
        const target = await ctx.fs.resolve(tree.path, { signal })
        const storage = await ctx.fs.resolve(common, { signal })
        const anchor = await ctx.fs.resolve(repo.root, { signal })
        if (tree.primary !== false || ctx.fs.contains(target, storage) || ctx.fs.contains(target, anchor)) {
          throw new VcsError('worktree-protected', 'The primary or current checkout is protected.')
        }
        if (tree.locked) throw new VcsError('worktree-locked', 'Unlock this Git worktree before removing it.')
        if (expectedName !== undefined && expectedName !== tree.name
          || expectedBranch !== undefined && expectedBranch !== tree.branch
          || expectedHead !== undefined && expectedHead !== tree.head) {
          throw new VcsError('worktree-stale', 'The checkout has changed. Refresh and choose it again.')
        }
        if (await worktreeInUse(ctx, tree.path, await worktreeSessionDirectories(ctx, signal), signal)) {
          throw new VcsError('worktree-in-use', 'A DSH session is using this directory.')
        }
        return tree
      }
      throw new VcsError('worktree-stale', 'That worktree is no longer available from the selected repository.')
    }
    return runWrite(repo, request, async () => {
      const tree = await readTarget()
      await backend.deleteWorktree!(repo.root, common, tree, action, signal, async () => {
        const fresh = await readTarget()
        if (fresh.branch !== tree.branch || fresh.name !== tree.name || (fresh.branch === null && fresh.head !== tree.head)) {
          throw new VcsError('worktree-stale', 'The checkout has changed. Refresh and choose it again.')
        }
      }, changed)
      return { path: tree.path }
    }, options)
  }

  /** Handle `POST /api/vcs.stage`. */
  async function stage(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Staging')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.stageOps !== true || typeof backend.stage !== 'function') {
      throw stagingUnsupported()
    }
    const runStage = backend.stage
    const { scope, fingerprint, lines } = body
    if (body.files !== undefined) {
      const files = readStagingFiles(body)
      await backend.require(request.signal)
      return runWrite(repo, request, () => runStage.call(backend, repo.root, { scope, files }, request.signal))
    }
    if (typeof scope !== 'string' || !STAGING_SCOPES.has(scope)) throw badRequest('scope is staged, unstaged, or untracked.')
    const path = validateRelPath(body.path)
    if (path === undefined) throw badRequest('path must be a repository-relative file path.')
    const oldPath = validateRelPath(body.oldPath)
    if (body.oldPath != null && (oldPath === undefined || oldPath === path || scope === 'untracked')) {
      throw badRequest('oldPath must name a different repository-relative file.')
    }
    if ((fingerprint !== undefined || lines !== undefined)
      && (typeof fingerprint !== 'string' || !/^[\da-f]{64}$/u.test(fingerprint))) {
      throw badRequest('A valid comparison fingerprint is required for selected lines.')
    }
    if (lines !== undefined && (!Array.isArray(lines) || lines.length === 0 || lines.length > DIFF_MAX_LINES
      || !lines.every(isLineAddress))) {
      throw badRequest('lines must contain changed line addresses with non-negative hunk and line indexes.')
    }
    await backend.require(request.signal)
    return runWrite(repo, request, () => runStage.call(backend, repo.root, { scope, path, oldPath, fingerprint, lines }, request.signal))
  }

  /** Handle `POST /api/vcs.stage-history`. */
  async function stageHistory(request: Request): Promise<Response> {
    const { body, query } = await readWrite(request, 'Staging history')
    const repo = await requireRepository(query, request.signal)
    const backend = repo.backend
    if (backend.capabilities.stageOps !== true || typeof backend.replayStage !== 'function') {
      throw stageHistoryError('unavailable')
    }
    const { action, id } = body
    if (action !== 'undo' && action !== 'redo') throw badRequest('action must be undo or redo.')
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) {
      throw badRequest('id must identify a staging history entry.')
    }
    await backend.require(request.signal)
    const runReplay = backend.replayStage
    return runWrite(repo, request, () => runReplay.call(backend, repo.root, { action, id }, request.signal), { stageHistory: true })
  }

  // Several historical banners can mount together. Share their in-flight
  // catalog read without caching obsolete repository configuration.
  const turnCatalog = createReadFlight<Awaited<ReturnType<typeof findRepositories>>>()

  /** Handle `GET /api/vcs.turn`. */
  async function turn(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const { sessionId, cwd } = await requireSession(query)
    const turnNumber = readNonNegativeInteger(query.get('turn'))
    if (turnNumber === undefined || turnNumber < 1) {
      throw badRequest('turn must be a positive integer.')
    }
    const rawSeq = query.get('seq')
    const seq = rawSeq === null ? undefined : readNonNegativeInteger(rawSeq)
    if (rawSeq !== null && seq === undefined) {
      throw badRequest('seq must be a non-negative integer.')
    }

    const recordedHead = await turnTracker?.read?.(sessionId, turnNumber, request.signal)
    const recordedChanges = seq === undefined ? undefined : workspaceChanges()?.summary(sessionId, seq)
    if (recordedChanges !== undefined && recordedChanges !== null) {
      if (typeof recordedChanges !== 'object') {
        throw new VcsError('internal', 'The turn summary could not be read.')
      }
      if (recordedChanges.turn !== turnNumber) {
        throw badRequest('seq does not belong to turn.')
      }
      if (!Number.isSafeInteger(recordedChanges.total) || recordedChanges.total < 0
        || !Number.isSafeInteger(recordedChanges.added) || recordedChanges.added < 0
        || !Number.isSafeInteger(recordedChanges.deleted) || recordedChanges.deleted < 0) {
        throw new VcsError('internal', 'The turn summary could not be read.')
      }
    }
    if (recordedHead === undefined && (recordedChanges === undefined || recordedChanges === null)) {
      throw notFound('That turn summary is no longer available.')
    }

    let graphs: Awaited<ReturnType<typeof recommendTurnRepositories>> = []
    if (recordedChanges && recordedChanges.total > 0 && Array.isArray(recordedChanges.files) && recordedChanges.files.length > 0) {
      try {
        const listing = await turnCatalog.read(cwd, signal => findRepositories(cwd, signal), request.signal)
        graphs = await recommendTurnRepositories(ctx, listing.cwd, recordedChanges.files, listing.repositories, request.signal)
      } catch (error) {
        if (request.signal.aborted || isAbortError(error)) throw error
        warn(`turn graph attribution: ${failureCode(error) ?? 'internal'}`)
      }
    }
    const head = graphs.length === 0 || (graphs.length === 1 && graphs[0].path === recordedHead?.root)
      ? recordedHead?.head ?? null : null
    return json({
      turn: turnNumber,
      head,
      changed: recordedChanges?.total ?? null,
      added: recordedChanges?.added ?? null,
      deleted: recordedChanges?.deleted ?? null,
      ...(graphs.length === 0 ? {} : { graphs }),
    })
  }

  /** Write one diagnostic line to the Host log; a broken logger must not replace the answer. */
  function warn(text: string): void {
    try {
      ctx.logger?.warn?.(`dsh-vcs-panel: ${text}`)
    } catch {
      // The answer still goes out.
    }
  }

  /**
   * Turn a thrown route failure into its JSON answer, except for a cancelled
   * request, which keeps its abort so the transport can drop it.
   * @param handler - the route implementation.
   * @returns the guarded handler.
   */
  function wrap(handler: RouteHandler): RouteHandler {
    return async function route(request: Request): Promise<Response> {
      try {
        return await handler(request)
      } catch (error) {
        if (request.signal?.aborted) throw error
        if (error instanceof VcsError) {
          if (error.detail !== undefined) warn(`${error.code}: ${error.detail}`)
          return errorResponse(error)
        }
        warn(error instanceof Error ? error.message : String(error))
        return errorResponse(error)
      }
    }
  }

  return {
    repositories: wrap(repositories),
    repositoryConfig: wrap(repositoryConfig),
    repositoryPreview: wrap(repositoryPreview),
    repositoryScan: wrap(repositoryScan),
    saveRepositoryConfig: wrap(saveRepositoryConfig),
    overview: wrap(overview),
    activity: wrap(activity),
    watch: wrap(watch),
    status: wrap(status),
    untracked: wrap(untracked),
    diff: wrap(diff),
    log: wrap(log),
    commit: wrap(commit),
    stash: wrap(stash),
    stashCheck: wrap(stashCheck),
    stashOp: wrap(stashOp),
    turn: wrap(turn),
    sync: wrap(sync),
    branches: wrap(branches),
    remotes: wrap(remotes),
    switchBranch: wrap(switchBranch),
    branchOp: wrap(branchOp),
    tagOp: wrap(tagOp),
    commitOp: wrap(commitOp),
    worktreeOp: wrap(worktreeOp),
    stage: wrap(stage),
    stageHistory: wrap(stageHistory),
  }
}

/** Whether a caught failure is a cancelled read. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}
