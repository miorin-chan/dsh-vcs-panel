/**
 * Browser data layer for the Host routes: the reads and the writes behind
 * sync, branch switching, the branch actions menu, the tag actions menu, and
 * the commit actions menu.
 *
 * One instance serves one Session: every request carries the Session identity
 * and the repository the panel currently shows. Requests are cancellable with
 * an AbortSignal, and a non-2xx answer becomes an {@link ApiError} carrying the
 * Host's stable code so views can distinguish "missing" from "failed".
 */

/** A failed Host request with its stable error code. */
export class ApiError extends Error {
  /**
   * @param {string} code - Host error code.
   * @param {string} message - message safe to render.
   * @param {number} status - HTTP status.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Build the query string for one request.
 * @param {Record<string, string | number | string[] | undefined | null>} params - query values.
 * @returns {string} the query string including the leading `?`.
 */
export function queryString(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item)
    } else search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** Whether an async failure came from an AbortSignal cancellation. */
function isAborted(error, signal) {
  return error?.name === 'AbortError' || signal?.aborted === true
}

/** Normalize a cancelled request to an `AbortError`. */
function toAbortError(error) {
  if (error?.name === 'AbortError') return error
  return new DOMException('The request was aborted.', 'AbortError')
}

/**
 * Create the Session-scoped API.
 * @param {string} sessionId - the open Conversation Session.
 * @param {object} [options] - injection seam for tests.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {string} [options.base] - URL prefix; empty means relative to the app.
 * @param {string | null} [options.worktreeOf] - allowed repository anchoring a worktree preview.
 * @returns {object} the route methods.
 */
export function createApi(sessionId, { fetchImpl = globalThis.fetch, base = '', worktreeOf = null } = {}) {
  /** In a preview, the selected root is the worktree, not the allowed repository. */
  const browseTarget = repo => worktreeOf === null ? { repo } : { repo: worktreeOf, worktree: repo }

  /**
   * Decode one Host answer, turning a non-2xx status into an {@link ApiError}.
   * @param {Response} response - the transport answer.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} the decoded body.
   */
  async function decode(response, signal) {
    let body = null
    let bodyFailed = false
    try {
      body = await response.json()
    } catch (error) {
      if (isAborted(error, signal)) throw toAbortError(error)
      // A body-less failure still carries its HTTP status.
      bodyFailed = true
    }
    if (signal?.aborted === true) throw toAbortError(signal.reason)
    if (!response.ok) {
      const error = body?.error
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const message = typeof error?.message === 'string' ? error.message : `Request failed (${response.status}).`
      throw new ApiError(code, message, response.status)
    }
    if (bodyFailed || body === null || typeof body !== 'object') {
      throw new ApiError('internal', 'The version control response could not be read.', response.status)
    }
    return body
  }

  /**
   * One JSON read.
   * @param {string} path - exact Host route path.
   * @param {Record<string, string | number | string[] | undefined | null>} params - query values.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<unknown>} the decoded body.
   */
  async function get(path, params, signal) {
    let response
    try {
      response = await fetchImpl(`${base}${path}${queryString({ sessionId, ...params })}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
    } catch (error) {
      if (isAborted(error, signal)) throw toAbortError(error)
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return decode(response, signal)
  }

  /**
   * One JSON write. It carries no AbortSignal: once sent, the Host finishes it
   * even if the panel goes away.
   * @param {string} path - exact Host route path.
   * @param {Record<string, string>} values - body values besides the Session.
   * @returns {Promise<unknown>} the decoded body.
   */
  async function post(path, values) {
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...values }),
      })
    } catch {
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return decode(response)
  }

  return {
    /**
     * Repositories the Session may show.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{ repositories: object[], cwd: string, truncated: boolean, worktreesTruncated: boolean }>} the repositories and their checkouts.
     */
    repositories(signal) {
      return get('/api/vcs.repositories', {}, signal)
    },

    /**
     * Branch facts and the three working-tree groups.
     * @param {string} repo - repository root from the repositories answer.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the status.
     */
    status(repo, signal) {
      return get('/api/vcs.status', browseTarget(repo), signal)
    },

    /**
     * Direct children of one untracked directory.
     * @param {string} repo - repository root.
     * @param {string} path - directory path relative to the repository, slash-suffixed.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the directory listing.
     */
    untracked(repo, path, signal) {
      return get('/api/vcs.untracked', { ...browseTarget(repo), path }, signal)
    },

    /**
     * One file comparison.
     * @param {string} repo - repository root.
     * @param {{ scope: string, path: string, rev?: string | null }} target - comparison target.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the comparison state.
     */
    diff(repo, target, signal) {
      return get('/api/vcs.diff', {
        ...browseTarget(repo),
        scope: target.scope,
        path: target.path,
        oldPath: target.oldPath,
        rev: target.scope === 'commit' ? target.rev : undefined,
      }, signal)
    },

    /**
     * One page of commits.
     * @param {string} repo - repository root.
     * @param {{ ref?: string, skip?: number, limit?: number, worktrees?: string[] }} page - range, worktree roots, and pagination.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the commit page.
     */
    log(repo, page = {}, signal) {
      return get('/api/vcs.log', { repo, worktree: page.worktrees, ref: page.ref, skip: page.skip, limit: page.limit }, signal)
    },

    /**
     * One commit's metadata and changed files.
     * @param {string} repo - repository root.
     * @param {string} sha - full or abbreviated commit id.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the commit detail.
     */
    commit(repo, sha, signal) {
      return get('/api/vcs.commit', { ...browseTarget(repo), sha }, signal)
    },

    /**
     * One completed turn's recorded repository head and change totals.
     * @param {number} turn - 1-based turn number.
     * @param {number | null} [seq] - announcing `workspace/changes` event sequence, when present.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<object>} the turn summary.
     */
    turn(turn, seq, signal) {
      return get('/api/vcs.turn', { turn, seq }, signal)
    },

    /**
     * Bring the checked-out branch level with its upstream: fetch, then
     * fast-forward or push.
     * @param {string} repo - repository root.
     * @returns {Promise<{ upstream: string, pulled: number, pushed: number }>} what moved.
     */
    sync(repo) {
      return post('/api/vcs.sync', { repo })
    },

    /** Stage or unstage a file, or the selected lines of a specific diff. */
    stage(repo, { scope, path, oldPath, fingerprint, lines }) {
      return post('/api/vcs.stage', { repo, scope, path, oldPath, fingerprint, lines })
    },

    /** Undo or redo the entry currently shown in the working tree toolbar. */
    stageHistory(repo, action, id) {
      return post('/api/vcs.stage-history', { repo, action, id })
    },

    /**
     * Local branches a switch can target, newest commit first.
     * @param {string} repo - repository root.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{ branches: { name: string, current: boolean }[], truncated: boolean }>} the listing.
     */
    branches(repo, signal) {
      return get('/api/vcs.branches', { repo }, signal)
    },

    /**
     * Remotes a tag can be pushed to.
     * @param {string} repo - repository root.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{ remotes: string[], truncated: boolean }>} the listing.
     */
    remotes(repo, signal) {
      return get('/api/vcs.remotes', { repo }, signal)
    },

    /**
     * Check out one existing local branch. The Host refuses when local changes
     * would be overwritten; nothing is stashed or forced.
     * @param {string} repo - repository root.
     * @param {string} branch - exact local branch name.
     * @returns {Promise<{ branch: string }>} the checked-out branch.
     */
    switchBranch(repo, branch) {
      return post('/api/vcs.switch', { repo, branch })
    },

    /**
     * Run one branch action on an existing local or remote-tracking branch.
     * The Host validates the action, the branch, and the new name; merge and
     * rebase undo themselves when they conflict.
     * @param {string} repo - repository root.
     * @param {'rename'|'delete'|'merge'|'rebase'|'push'|'checkout-remote'|'delete-remote'|'merge-remote'|'pull-remote'} action - the action.
     * @param {{ branch: string, name?: string, local?: string, force?: boolean }} target - target branch and options.
     * @returns {Promise<object>} what the action did.
     */
    branchOp(repo, action, target) {
      return post('/api/vcs.branch', {
        repo,
        action,
        branch: target.branch,
        name: target.name,
        local: target.local,
        force: target.force === true ? true : undefined,
      })
    },

    /**
     * Run one tag action on an existing local tag. The Host validates the
     * action, the tag, and the remote; push never forces.
     * @param {string} repo - repository root.
     * @param {'delete'|'push'} action - the action.
     * @param {{ tag: string, remote?: string }} target - target tag and remote.
     * @returns {Promise<object>} what the action did.
     */
    tagOp(repo, action, target) {
      return post('/api/vcs.tag', {
        repo,
        action,
        tag: target.tag,
        remote: target.remote,
      })
    },

    /**
     * Run one commit action on an existing commit. The Host validates the
     * action, commit, new ref name, tag message, and reset mode; conflicts
     * abort before the failure is reported.
     * @param {string} repo - repository root.
     * @param {'tag'|'branch'|'checkout'|'cherry-pick'|'revert'|'drop'|'merge'|'rebase'|'reset'} action - the action.
     * @param {{ sha: string, name?: string, message?: string, checkout?: boolean, mode?: string }} target - commit and options.
     * @returns {Promise<object>} what the action did.
     */
    commitOp(repo, action, target) {
      return post('/api/vcs.commit-op', {
        repo,
        action,
        sha: target.sha,
        name: target.name,
        message: target.message,
        checkout: target.checkout === true ? true : undefined,
        mode: target.mode,
      })
    },
  }
}
