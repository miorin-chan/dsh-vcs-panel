/**
 * The panel's routes: nine reads and seven write routes behind staging, sync,
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

import { isAbsolute } from 'node:path'

import { badRequest, errorResponse, json, notFound, VcsError } from './errors.js'
import { createBackends } from './vcs/index.js'
import { LOG_PAGE_MAX, LOG_SKIP_MAX } from './log.js'
import { WORKING_TREE_NODE } from './nodes.js'
import { repositoryName, sameRepoPath, validateRelPath, validateSha } from './paths.js'
import { RESET_MODES } from './ref-utils.js'
import { discoverRepositories } from './repositories.js'
import { DIFF_MAX_LINES } from './diff.js'
import { STAGING_SCOPES, stagingUnsupported } from './staging.js'
import { stageHistoryError } from './index-transaction.js'
import { EMPTY_STAGE_HISTORY } from './stage-history.js'

/**
 * Clamp a number into a range.
 * @param {number} value - the number.
 * @param {number} min - lowest accepted value.
 * @param {number} max - highest accepted value.
 * @returns {number} the clamped value.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Read an optional integer query value.
 * @param {string | null} value - the query value.
 * @param {number} fallback - value when the query omits it.
 * @returns {number | undefined} the number, or undefined when malformed.
 */
function readInteger(value, fallback) {
  if (value === null) return fallback
  if (!/^-?\d+$/u.test(value)) return undefined
  return Number(value)
}

/**
 * Read a non-negative safe integer query value.
 * @param {string | null} value - the query value.
 * @returns {number | undefined} the integer, or undefined when missing or malformed.
 */
function readNonNegativeInteger(value) {
  if (value === null || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

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

/**
 * Whether a request value can name a branch, tag, or remote. The backend
 * adds the repository's own listing and ref-format checks on top.
 * @param {unknown} value - the request value.
 * @returns {boolean} whether it is a usable name.
 */
function isRefName(value) {
  return typeof value === 'string' && value !== '' && value.length <= 255
    && !/[\u0000-\u0020\u007f]/u.test(value) && !value.startsWith('-')
}

/**
 * Build the route handlers bound to one host context.
 *
 * @param {object} ctx - Host context carrying `sessions`, `fs`, and `subprocess`.
 * @param {{ backends?: Map<string, object>, turnTracker?: { read: Function } }} [options] - shared backend and turn-head state.
 * @returns {{ repositories: Function, status: Function, untracked: Function, diff: Function, log: Function, commit: Function, turn: Function, sync: Function, branches: Function, remotes: Function, switchBranch: Function, branchOp: Function, tagOp: Function, commitOp: Function, stage: Function, stageHistory: Function }}
 *   one request handler per route.
 */
export function createHandlers(ctx, { backends = createBackends(ctx), turnTracker = ctx?.turnTracker } = {}) {
  /** Resolve the optional Host per-turn change recorder service. */
  function workspaceChanges() {
    const service = typeof ctx?.get === 'function'
      ? ctx.get('workspaceChanges')
      : ctx?.workspaceChanges
    return service !== null && service !== undefined && typeof service.summary === 'function'
      ? service
      : null
  }

  /**
   * Resolve the session a request addresses to its working directory.
   * The client sends a session identity rather than a path, so the browser
   * cannot aim this plugin at an arbitrary directory.
   * @param {URLSearchParams} query - the request query.
   * @returns {Promise<string>} the session working directory.
   * @throws {VcsError} when the session or its directory is missing.
   */
  async function requireCwd(query) {
    const sessionId = query.get('sessionId')
    if (sessionId === null || sessionId === '') throw badRequest('sessionId is required.')
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new VcsError('no-session', 'This session is no longer available.')
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new VcsError('no-cwd', 'This session has no working directory.')
    }
    return cwd
  }

  /**
   * Resolve the request's repository query against what discovery offers,
   * never against the string alone.
   * @param {URLSearchParams} query - the request query.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ root: string, name: string, vcs: string, backend: object }>} the repository.
   */
  async function requireRepository(query, signal) {
    const cwd = await requireCwd(query)
    const repoQuery = query.get('repo')
    if (repoQuery === null || repoQuery === '') throw badRequest('repo is required.')
    const discovered = await discoverRepositories(ctx, cwd, signal)
    const match = discovered.repositories.find(repo => sameRepoPath(repo.path, repoQuery))
    if (match === undefined) {
      throw new VcsError('not-a-repo', 'The requested repository is not available in this session.')
    }
    const backend = backends.get(match.vcs)
    if (backend === undefined) {
      throw new VcsError('internal', 'This repository uses an unsupported version control backend.')
    }
    return { root: match.path, name: match.name, vcs: match.vcs, backend }
  }

  /** Content reads can target a verified sibling of the allowed repository. */
  async function requireBrowseTarget(query, signal) {
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
  async function groupRepositories(roots, signal) {
    const repositories = []
    let siblings = 0
    let worktreesTruncated = false
    for (const repo of roots) {
      const backend = backends.get(repo.vcs)
      const entry = { ...repo, capabilities: backend?.capabilities }
      if (typeof backend?.worktrees !== 'function') {
        repositories.push(entry)
        continue
      }
      // Keep independently discovered roots when their store cannot supply a
      // verified path for them (for example an old Jujutsu registration).
      if (repositories.some(group => group.vcs === repo.vcs
        && group.worktrees?.some(tree => sameRepoPath(tree.path, repo.path)))) continue
      const worktrees = [{ path: repo.path, name: repo.name, branch: null, head: null }]
      try {
        const commonDir = await backend.commonDir(repo.path, signal)
        if (commonDir !== null) {
          for await (const tree of backend.worktrees(repo.path, signal, { commonDir })) {
            if (sameRepoPath(tree.path, repo.path)) {
              worktrees[0] = { ...tree, name: tree.name ?? repo.name }
            } else if (!worktrees.some(existing => sameRepoPath(existing.path, tree.path))) {
              if (siblings === WORKTREE_MAX) {
                worktreesTruncated = true
                break
              }
              siblings += 1
              worktrees.push({ ...tree, name: tree.name ?? repositoryName(tree.path) })
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error
        if (error?.code === 'output-too-large') worktreesTruncated = true
      }
      repositories.push({ ...entry, worktrees })
    }
    return { repositories, worktreesTruncated }
  }

  /** Handle `GET /api/vcs.repositories`. */
  async function repositories(request) {
    const query = new URL(request.url).searchParams
    const cwd = await requireCwd(query)
    const found = await discoverRepositories(ctx, cwd, request.signal)
    return json({
      ...found,
      ...await groupRepositories(found.repositories, request.signal),
    })
  }

  /** Handle `GET /api/vcs.status`. */
  async function status(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)
    const answer = await repo.backend.status(repo.root, request.signal)
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
  async function untracked(request) {
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
  async function diff(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)

    const scope = query.get('scope')
    if (scope === null || scope === '') throw badRequest('scope is required.')
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
  async function log(request) {
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
    if (paths.length > WORKTREE_MAX + 1 || paths.some((path, index) => (
      !isAbsolute(path) || paths.slice(0, index).some(other => sameRepoPath(path, other))
    ))) {
      throw badRequest('The worktree selection is invalid.')
    }
    if (typeof repo.backend.worktrees !== 'function') throw badRequest('This repository has no worktree selection.')
    const remaining = [...paths]
    const worktreeHeads = []
    for await (const tree of repo.backend.worktrees(repo.root, request.signal, { paths })) {
      const index = remaining.findIndex(path => sameRepoPath(path, tree.path))
      if (index < 0) continue
      remaining.splice(index, 1)
      worktreeHeads.push({ path: tree.path, head: tree.head })
      if (remaining.length === 0) break
    }
    if (remaining.length > 0) throw new VcsError('not-a-repo', 'The worktree selection is no longer available from this repository.')
    const heads = worktreeHeads.flatMap(tree => tree.head === null ? [] : [tree.head])
    const page = await repo.backend.log(repo.root, { ref, limit, skip, heads }, request.signal)
    return json({ ...page, worktreeHeads })
  }

  /** Handle `GET /api/vcs.commit`. */
  async function commit(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireBrowseTarget(query, request.signal)
    await repo.backend.require(request.signal)

    const answer = await repo.backend.commit(repo.root, query.get('sha'), request.signal)
    return json(answer)
  }

  /** Repository roots with a write in flight; a second write of one root is refused. */
  const writing = new Set()

  /**
   * Run one write under the repository's single-flight lock.
   * @param {{ root: string }} repo - the resolved repository.
   * @param {Function} run - the write, returning the JSON payload.
   * @returns {Promise<Response>} the JSON answer.
   */
  async function runWrite(repo, run, { stageHistory = false, considerHistory = false, signal } = {}) {
    if (writing.has(repo.root)) {
      if (stageHistory) throw stageHistoryError('busy')
      throw new VcsError('busy', 'Another write is already running for this repository.')
    }
    writing.add(repo.root)
    try {
      return json(considerHistory && typeof repo.backend.aroundHistoryWrite === 'function'
        ? await repo.backend.aroundHistoryWrite(repo.root, signal, run)
        : await run())
    } finally {
      writing.delete(repo.root)
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
   * @param {Request} request - the write request.
   * @param {string} label - human name of the action, for messages.
   * @returns {Promise<{ body: object, query: URLSearchParams }>} the parsed body and its target.
   */
  async function readWrite(request, label) {
    if (request.method !== 'POST') throw badRequest(`${label} is a POST request.`)
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      throw new VcsError('forbidden', `${label} only accepts requests from this app.`)
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) {
      throw badRequest(`${label} expects a JSON body.`)
    }
    let body
    try {
      body = await request.json()
    } catch {
      throw badRequest('The request body is not valid JSON.')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('The request body must be an object.')
    }
    if (Object.hasOwn(body, 'worktree') || new URL(request.url).searchParams.has('worktree')) {
      throw new VcsError('forbidden', 'Worktree previews are read-only.')
    }
    const query = new URLSearchParams()
    for (const key of ['sessionId', 'repo']) {
      if (typeof body[key] === 'string') query.set(key, body[key])
    }
    return { body, query }
  }

  /**
   * Handle `POST /api/vcs.sync`.
   */
  async function sync(request) {
    const { query } = await readWrite(request, 'Sync')

    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.sync !== true || typeof repo.backend.sync !== 'function') {
      throw badRequest('This repository cannot sync from the panel.')
    }
    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.sync(repo.root, request.signal), { considerHistory: true, signal: request.signal })
  }

  /**
   * Handle `GET /api/vcs.branches`, the local branches a switch can target.
   */
  async function branches(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.branchSwitch !== true || typeof repo.backend.branches !== 'function') {
      throw badRequest('This repository has no local branches to switch.')
    }
    await repo.backend.require(request.signal)
    return json(await repo.backend.branches(repo.root, request.signal))
  }

  /**
   * Handle `GET /api/vcs.remotes`, the destinations a tag can be pushed to.
   */
  async function remotes(request) {
    const query = new URL(request.url).searchParams
    const repo = await requireRepository(query, request.signal)
    if ((repo.backend.capabilities.tagOps !== true && repo.backend.capabilities.branchOps !== true)
      || typeof repo.backend.remotes !== 'function') {
      throw badRequest('This repository has no remotes to list.')
    }
    await repo.backend.require(request.signal)
    return json(await repo.backend.remotes(repo.root, request.signal))
  }

  /**
   * Handle `POST /api/vcs.switch`.
   *
   * The branch name is checked against the repository's own local branch list
   * by the backend, so only an existing local branch can reach `git switch`.
   */
  async function switchBranch(request) {
    const { body, query } = await readWrite(request, 'Branch switching')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.branchSwitch !== true || typeof repo.backend.switchBranch !== 'function') {
      throw badRequest('This repository cannot switch branches from the panel.')
    }
    const branch = body.branch
    if (!isRefName(branch)) throw badRequest('branch must name a local branch.')
    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.switchBranch(repo.root, branch, request.signal), { considerHistory: true, signal: request.signal })
  }

  /**
   * Handle `POST /api/vcs.branch`, the branch actions menu's write.
   *
   * `action` selects one fixed command. The target branch and, for a rename,
   * the new name are strings checked here and then against the repository's
   * own branch list or ref rules, so no request value reaches git unverified.
   */
  async function branchOp(request) {
    const { body, query } = await readWrite(request, 'Branch actions')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.branchOps !== true) {
      throw badRequest('This repository has no branch actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !BRANCH_ACTIONS.has(action)) {
      throw badRequest('action must be a branch or remote-branch action.')
    }
    const branch = body.branch
    if (!isRefName(branch)) throw badRequest('branch must name a branch.')

    let name
    if (action === 'rename') {
      if (!isRefName(body.name)) throw badRequest('name must name the renamed branch.')
      name = body.name
    }
    let local
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

    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.branchOp(repo.root, {
      action,
      branch,
      name,
      local,
      force,
    }, request.signal), { considerHistory: BRANCH_HISTORY_ACTIONS.has(action), signal: request.signal })
  }

  /**
   * Handle `POST /api/vcs.tag`, the tag actions menu's write.
   *
   * Deleting removes one local tag; pushing sends one tag to a remote the
   * backend confirms this repository lists. Both names are checked here and
   * again by the backend before reaching git.
   */
  async function tagOp(request) {
    const { body, query } = await readWrite(request, 'Tag actions')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.tagOps !== true) {
      throw badRequest('This repository has no tag actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !TAG_ACTIONS.has(action)) {
      throw badRequest('action must be delete or push.')
    }
    const tag = body.tag
    if (!isRefName(tag)) throw badRequest('tag must name a local tag.')

    let remote
    if (action === 'push') {
      if (!isRefName(body.remote)) throw badRequest('remote must name a configured remote.')
      remote = body.remote
    }

    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.tagOp(repo.root, { action, tag, remote }, request.signal))
  }

  /**
   * Handle `POST /api/vcs.commit-op`, the commit actions menu's write.
   *
   * The commit id is hexadecimal. Tag and branch creation, optional checkout on
   * branch creation, reset, and the optional tag message are checked here and
   * again by the backend before reaching git. Every action names one existing
   * commit.
   */
  async function commitOp(request) {
    const { body, query } = await readWrite(request, 'Commit actions')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.commitOps !== true) {
      throw badRequest('This repository has no commit actions.')
    }
    const action = body.action
    if (typeof action !== 'string' || !COMMIT_ACTIONS.has(action)) {
      throw badRequest('action must be tag, branch, checkout, cherry-pick, revert, drop, merge, rebase, or reset.')
    }
    const sha = validateSha(body.sha)
    if (sha === undefined) throw badRequest('sha must be a hexadecimal commit id.')

    let name
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
    let mode
    if (action === 'reset') {
      if (typeof body.mode !== 'string' || !RESET_MODES.has(body.mode)) {
        throw badRequest('mode must be soft, mixed, or hard.')
      }
      mode = body.mode
    }

    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.commitOp(repo.root, {
      action,
      sha,
      name,
      message,
      checkout,
      mode,
    }, request.signal), { considerHistory: action !== 'tag' && (action !== 'branch' || checkout), signal: request.signal })
  }

  /** Handle `POST /api/vcs.stage`. */
  async function stage(request) {
    const { body, query } = await readWrite(request, 'Staging')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.stageOps !== true || typeof repo.backend.stage !== 'function') {
      throw stagingUnsupported()
    }
    const { scope, fingerprint, lines } = body
    if (!STAGING_SCOPES.has(scope)) throw badRequest('scope is staged, unstaged, or untracked.')
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
      || lines.some(line => line === null || typeof line !== 'object'
        || !Number.isSafeInteger(line.hunk) || line.hunk < 0
        || !Number.isSafeInteger(line.line) || line.line < 0))) {
      throw badRequest('lines must contain changed line addresses with non-negative hunk and line indexes.')
    }
    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.stage(repo.root, { scope, path, oldPath, fingerprint, lines }, request.signal))
  }

  /** Handle `POST /api/vcs.stage-history`. */
  async function stageHistory(request) {
    const { body, query } = await readWrite(request, 'Staging history')
    const repo = await requireRepository(query, request.signal)
    if (repo.backend.capabilities.stageOps !== true || typeof repo.backend.replayStage !== 'function') {
      throw stageHistoryError('unavailable')
    }
    const { action, id } = body
    if (action !== 'undo' && action !== 'redo') throw badRequest('action must be undo or redo.')
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) {
      throw badRequest('id must identify a staging history entry.')
    }
    await repo.backend.require(request.signal)
    return runWrite(repo, () => repo.backend.replayStage(repo.root, { action, id }, request.signal), { stageHistory: true })
  }

  /** Handle `GET /api/vcs.turn`. */
  async function turn(request) {
    const query = new URL(request.url).searchParams
    await requireCwd(query)
    const sessionId = query.get('sessionId')
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

    return json({
      turn: turnNumber,
      head: recordedHead?.head ?? null,
      changed: recordedChanges?.total ?? null,
      added: recordedChanges?.added ?? null,
      deleted: recordedChanges?.deleted ?? null,
    })
  }

  /** Write one diagnostic line to the Host log; a broken logger must not replace the answer. */
  function warn(text) {
    try {
      ctx.logger?.warn?.(`dsh-vcs-panel: ${text}`)
    } catch {
      // The answer still goes out.
    }
  }

  /**
   * Turn a thrown route failure into its JSON answer, except for a cancelled
   * request, which keeps its abort so the transport can drop it.
   * @param {Function} handler - the route implementation.
   * @returns {(request: Request) => Promise<Response>} the guarded handler.
   */
  function wrap(handler) {
    return async function route(request) {
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
    status: wrap(status),
    untracked: wrap(untracked),
    diff: wrap(diff),
    log: wrap(log),
    commit: wrap(commit),
    turn: wrap(turn),
    sync: wrap(sync),
    branches: wrap(branches),
    remotes: wrap(remotes),
    switchBranch: wrap(switchBranch),
    branchOp: wrap(branchOp),
    tagOp: wrap(tagOp),
    commitOp: wrap(commitOp),
    stage: wrap(stage),
    stageHistory: wrap(stageHistory),
  }
}
