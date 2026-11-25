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

import type { BranchOpAction } from './branch.js'
import type { OverviewRepository } from './overview/model.js'
import type { StashBlockInfo, StashCheck, StashDetailAnswer, StashEntry, StashMode, StashPaths, StashRequest, StashResult } from '../lib/stash-types.js'
import { stashFailureFields } from './stash.js'

/** The parts of a thrown failure the panel reads. */
export interface ApiFailure {
  readonly name?: string
  readonly code?: string
  readonly message?: string
  readonly status?: number
  readonly stashBlock?: StashBlockInfo
  readonly stashPaths?: StashPaths
}

/**
 * Read a caught value as a failure.
 *
 * The value is thrown by the transport, a JSON decode, or the Host's error
 * response; the panel only ever inspects these fields.
 * @param error - the caught value.
 * @returns the failure fields, or an empty object for a non-object value.
 */
export function failureOf(error: unknown): ApiFailure {
  return typeof error === 'object' && error !== null ? error as ApiFailure : {}
}

/** A failed Host request with its stable error code. */
export class ApiError extends Error {
  /** Host error code. */
  readonly code: string
  /** HTTP status. */
  readonly status: number
  readonly stashBlock?: StashBlockInfo
  readonly stashPaths?: StashPaths

  /**
   * @param code - Host error code.
   * @param message - message safe to render.
   * @param status - HTTP status.
   */
  constructor(code: string, message: string, status: number, error?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    Object.assign(this, stashFailureFields(error))
  }
}

/** One query value a request may carry. */
export type QueryParam = string | number | string[] | undefined | null

/** Query values by name. */
export type QueryParams = Record<string, QueryParam>

/** Injection seams and the Session identity a request scope uses. */
export interface ApiOptions {
  /** fetch implementation. */
  fetchImpl?: typeof fetch
  /** URL prefix; empty means relative to the app. */
  base?: string
  /** allowed repository anchoring a worktree preview. */
  worktreeOf?: string | null
  /** Identifies writes made by this panel subscription. */
  clientId?: string | null
  /** Subscription transport. */
  EventSourceImpl?: typeof EventSource
}

/** One history range the panel may ask for. */
export interface HistoryRange {
  readonly value: string
  readonly label: string
  readonly title: string
}

/** What the client may assume about one version control model. */
export interface RepositoryCapabilities {
  readonly id: string
  readonly name: string
  /** `row` puts the working tree above the commits; `commit` makes it a row. */
  readonly workingCopy: 'row' | 'commit'
  /** The stable node token of the working copy, when it is a commit. */
  readonly workingCopyNode: string | null
  /** Whether the status has three groups rather than one changes group. */
  readonly staging: boolean
  /** Whether files and selected lines can be staged and unstaged. */
  readonly stageOps: boolean
  /** Whether untracked directories can be expanded on demand. */
  readonly untracked: boolean
  /** Whether commits have a stable change id. */
  readonly changeId: boolean
  /** Whether the branch reports ahead/behind counts. */
  readonly aheadBehind: boolean
  /** Whether reading may write backend bookkeeping. */
  readonly snapshots: boolean
  /** Whether the branch can sync with its upstream. */
  readonly sync: boolean
  /** Whether local branches can be listed and checked out from the header. */
  readonly branchSwitch: boolean
  /** Whether the branch menus' writes are available. */
  readonly branchOps: boolean
  /** Whether the tag menu's writes are available. */
  readonly tagOps: boolean
  /** Whether the commit menu's writes are available. */
  readonly commitOps: boolean
  /** Whether Git stash rows, detail, and writes are available. */
  readonly stashOps: boolean
  readonly worktreeCreate?: boolean
  readonly worktreeRemove?: boolean
  readonly worktreeForget?: boolean
  /** History ranges, in menu order. */
  readonly ranges: readonly HistoryRange[]
  /** The range the panel starts in. */
  readonly defaultRange: string
}

/** One checkout of a repository. */
export interface WorktreeInfo {
  /** Absolute path of the checkout. */
  path: string
  /** Display name. */
  name: string
  /** The commit it has checked out, or null. */
  head: string | null
  /** The branch it has checked out, or null when detached. */
  branch: string | null
  primary?: boolean
  canRemove?: boolean
  canForget?: boolean
  locked?: boolean
  inUse?: boolean
}

export type WorktreeRemovalAction = 'remove' | 'forget'
export type WorktreeCreateMode = 'new' | 'existing' | 'detach'

export type WorktreeCreateRequest = { action: 'create'; path: string } & (
  | { mode: 'new'; name?: string; revision?: string }
  | { mode: 'existing'; name: string }
  | { mode: 'detach'; revision?: string }
  | { mode?: undefined; name?: string; revision?: string }
)

export type WorktreeRequest = WorktreeCreateRequest | ({ action: WorktreeRemovalAction; worktree: string } & (
  | { expectedName: string }
  | { expectedBranch: string | null; expectedHead?: string }
))

/** Where discovery found a repository. */
export interface RepositorySource {
  kind: 'default' | 'repository' | 'directory'
  path?: string
}

/** One repository the Session may show. */
export interface RepositoryInfo {
  /** Absolute repository root. */
  path: string
  /** Display name. */
  name: string
  /** Backend id that reads it. */
  vcs: string
  /** What that backend promises. */
  capabilities: RepositoryCapabilities
  /** Whether this repository contains the session directory. */
  enclosing?: boolean
  /** Backends whose markers are present, and the rules that found the root. */
  availableVcs?: string[]
  sources?: RepositorySource[]
  /** Checkouts, when the backend can list them. */
  worktrees?: WorktreeInfo[]
}

/** The repositories a Session may show. */
export interface RepositoriesAnswer {
  repositories: RepositoryInfo[]
  cwd: string
  truncated: boolean
  worktreesTruncated: boolean
  /** Set when the discovery configuration could not be read. */
  configError?: string
}

/** One reference a commit points at. */
export interface VcsRef {
  name: string
  kind: 'branch' | 'remote' | 'tag' | 'head'
  /** Whether this is the checked-out branch. */
  current?: boolean
  /** The remote part of a split remote-branch reference. */
  remote?: string
  /** The branch part of a split remote-branch reference. */
  branch?: string
}

/** One row the change tree renders. */
export interface FileEntry {
  /** Repository-relative path. */
  path: string
  /** The letter this row shows. */
  status: string
  /** Rename or copy source, on the side that reports R or C. */
  origPath?: string
  /** Lines added. */
  added: number
  /** Lines deleted. */
  deleted: number
  /** True when the backend cannot render a textual diff. */
  binary?: boolean
  /** True for an untracked file. */
  untracked?: boolean
  /** True for an untracked directory row. */
  directory?: boolean
  /** True for a conflicted path. */
  conflict?: boolean
  /** True when the other side also lists this path. */
  partiallyStaged?: boolean
}

/**
 * The three groups a Git status serves.
 *
 * A backend without staging groups omits them; readers default a missing group
 * to an empty list.
 */
export interface StatusGroups {
  staged?: FileEntry[]
  unstaged?: FileEntry[]
  untracked?: FileEntry[]
}

/** The branch facts a status read reports. */
export interface StatusBranch {
  name: string | null
  oid: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  ahead: number
  behind: number
}

/** The working-copy commit a snapshotting backend reports. */
export interface WorkingCopyStatus {
  /** Stable node token for the working-copy commit. */
  node: string
  /** Full commit id. */
  commitId: string
  /** Short change id, when the backend has one. */
  changeId: string | null | undefined
  /** Full parent commit ids. */
  parents: string[]
  /** Ref badges pointing at the commit. */
  refs: VcsRef[]
  /** First description line. */
  subject: string
  /** Author name. */
  author: string
  /** Author time in epoch milliseconds, or NaN. */
  authorTime: number
  /** True when the commit changes nothing. */
  empty: boolean
  /** True when the commit has unresolved conflicts. */
  conflict: boolean
  /** Per-file totals for the change tree's header. */
  summary: {
    changed: number
    added: number
    deleted: number
  }
}

/** One staging write the undo and redo controls name. */
export interface StageHistoryEntry {
  id: string
  scope: string
  path: string
  lineCount?: number
  fileCount?: number
}

/** The staging writes the undo and redo controls can replay. */
export interface StageHistoryAnswer {
  undo: StageHistoryEntry | null
  redo: StageHistoryEntry | null
}

/** The answer to one staging-history replay. */
export interface StageHistoryWriteAnswer {
  action: string
  stageHistory: StageHistoryAnswer
}

/** The answer to one status read. */
export interface StatusData {
  branch: StatusBranch | null
  groups: StatusGroups
  total: number
  untrackedTotal?: number
  untrackedAdded?: number | null
  truncated: boolean
  defaultNode: string
  stageHistory: StageHistoryAnswer
  repo: {
    path: string
    name: string
  }
  vcs: string
  capabilities: RepositoryCapabilities
  workingCopy?: WorkingCopyStatus
  /** The background revision this read belongs to, attached by the view. */
  backgroundRevision?: number
}

/** Direct children of one untracked directory. */
export interface UntrackedAnswer {
  path: string
  entries: Array<{
    name: string
    path: string
    type: 'directory' | 'file'
  }>
  truncated: boolean
}

/** One hunk of a served comparison. */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** The comparison one file asks `vcs.diff` for. */
export interface DiffTarget {
  scope: string
  path: string
  oldPath?: string | null
  rev?: string | null
}

/** A text comparison as the Host serves it. */
export interface TextComparison {
  kind: 'text'
  path: string
  hunks: DiffHunk[]
  before: boolean
  after: boolean
  /** Whether selected lines can be staged from this comparison. */
  lineStaging?: boolean
  /** Identifies the exact comparison a line write was selected from. */
  fingerprint?: string
  /** The index object one side of the comparison names. */
  indexOid?: string
}

/** A comparison the Host declines to send in text form. */
export interface BinaryComparison {
  kind: 'binary'
  path: string
}

/** A comparison too large to send. */
export interface OversizedComparison {
  kind: 'oversized'
  path: string
}

/** One file comparison. */
export type FileComparison = TextComparison | BinaryComparison | OversizedComparison

/** One commit row of a history page. */
export interface CommitNode {
  sha: string
  parents: string[]
  refs: VcsRef[]
  author: string
  authorTime: number
  subject: string
  changeId?: string
  committer?: string
  committerTime?: number
  message?: string
  empty?: boolean
  conflict?: boolean
  /** True when this row stands for one checkout's working copy. */
  workingCopy?: boolean
  /** The checkouts whose working copy sits on this commit. */
  workingCopies?: WorktreeInfo[]
}

/** One changed file of one commit. */
export interface CommitFile {
  path: string
  status: string
  origPath?: string
  added: number
  deleted: number
  binary: boolean
}

/** One commit's metadata and changed files. */
export interface CommitDetail extends CommitNode {
  committer: string
  committerTime: number
  message: string
  files: CommitFile[]
}

/** The answer to one commit read. */
export interface CommitAnswer {
  commit: CommitDetail
  truncated: boolean
}

/** One page of history. */
export interface LogPage {
  commits: CommitNode[]
  truncated: boolean
  nextSkip: number | null
  stashes?: StashEntry[]
  stashesTruncated?: boolean
}

/** One page of history with the checkouts it was scoped to. */
export interface LogAnswer extends LogPage {
  worktreeHeads?: Array<{
    path: string
    head: string | null
  }>
}

/** The pagination and range one history read uses. */
export interface LogQuery {
  ref?: string
  skip?: number
  limit?: number
  worktrees?: string[]
}

/** The answer to one branch listing. */
export interface BranchesAnswer {
  branches: Array<{
    name: string
    current: boolean
    occupied?: boolean
  }>
  truncated: boolean
}

/** The answer to one remote listing. */
export interface RemotesAnswer {
  remotes: string[]
  truncated: boolean
}

/** What one sync moved. */
export interface SyncAnswer {
  upstream: string
  pulled: number
  pushed: number
}

/** The checked-out branch a switch landed on. */
export interface SwitchAnswer {
  branch: string
}

/** One file a group or folder write names. */
export interface StageTargetFile {
  path: string
  oldPath?: string
}

/** One staging write, or one selection of a comparison's lines. */
export interface StageRequest {
  scope: string
  path?: string
  oldPath?: string | null
  rev?: string | null
  /** Identifies the comparison the selected lines came from. */
  fingerprint?: string
  lines?: ReadonlyArray<{
    hunk: number
    line: number
  }>
  files?: ReadonlyArray<StageTargetFile>
}

/** The paths one staging write changed. */
export interface StageAnswer {
  paths?: string[]
}

/** One configured path of the discovery configuration. */
export interface RepositoryConfigPath {
  path: string
  available: boolean
}

/** One backend preference of the discovery configuration. */
export interface RepositoryConfigBackend {
  path: string
  vcs: string
  available: boolean
}

/** The discovery configuration one Session uses. */
export interface RepositoryConfigAnswer {
  scanDirectories: RepositoryConfigPath[]
  repositories: RepositoryConfigPath[]
  backends: RepositoryConfigBackend[]
  revision: string
  error?: string
}

/** One repository a candidate path would contribute. */
export interface RepositoryPreviewEntry {
  path: string
  name: string
  vcs: string
  availableVcs: string[]
}

/** What one candidate path would contribute to the configuration. */
export interface RepositoryPreviewAnswer {
  repositories: RepositoryPreviewEntry[]
  truncated: boolean
}

/** The target one branch action acts on. */
export interface BranchOpTarget {
  branch: string
  name?: string
  local?: string
  force?: boolean
}

/** The answer to one branch action, matching the copy format.ts renders. */
export interface BranchOpAnswer {
  current?: string
  branch?: string
  from?: string
  local?: string
  upstream?: string
  pushed?: boolean
  result?: string
}

/** The target one tag action acts on. */
export interface TagOpTarget {
  tag: string
  remote?: string
}

/** The answer to one tag action. */
export interface TagOpAnswer {
  remote?: string
  pushed?: boolean
}

/** One commit action the menu can run. */
export type CommitMenuAction =
  | 'tag'
  | 'branch'
  | 'checkout'
  | 'cherry-pick'
  | 'revert'
  | 'drop'
  | 'merge'
  | 'rebase'
  | 'reset'

/** The target one commit action acts on. */
export interface CommitOpTarget {
  sha: string
  name?: string
  message?: string
  checkout?: boolean
  mode?: string
}

/** The answer to one commit action, matching the copy format.ts renders. */
export interface CommitOpAnswer {
  sha?: string
  tag?: string
  branch?: string
  checkedOut?: boolean
  current?: string
  mode?: string
  result?: string
}

/** The route methods one Session-scoped client exposes. */
/** One line of the overview stream. */
export type OverviewLine =
  | { type: 'scope', cwd: string, repositories: number }
  | { type: 'repository', repository: OverviewRepository }
  | { type: 'error', path: string, vcs?: string, registered?: boolean, error: { code: string, message?: string } }
  | { type: 'done', unlistedTruncated?: boolean, failed?: boolean }

export interface Api {
  /** Repositories the Session may show. */
  repositories(signal?: AbortSignal): Promise<RepositoriesAnswer>
  /**
   * Stream every repository's pointers, one line per repository as the Host
   * finishes it; `repo` reads only that discovered repository.
   */
  overview(onLine: (line: OverviewLine) => void, options?: { repo?: string, signal?: AbortSignal }): Promise<void>
  /** Subscribe while the panel is visible. Returns the unsubscribe function. */
  watch(
    repo: string | null,
    worktrees: string[],
    onReady: () => void,
    onInvalidate: (domains: unknown[]) => void,
  ): () => void
  /** The discovery configuration of the Session directory. */
  repositoryConfig(signal?: AbortSignal): Promise<RepositoryConfigAnswer>
  /** What one candidate path would contribute. */
  repositoryPreview(path: string, kind: 'directory' | 'repository', signal?: AbortSignal): Promise<RepositoryPreviewAnswer>
  /** Persist one discovery configuration. */
  saveRepositoryConfig(
    revision: string,
    scanDirectories: string[],
    repositories: string[],
    backends: Array<{ path: string; vcs: string }>,
  ): Promise<RepositoryConfigAnswer>
  /** Branch facts and the working-tree groups. */
  status(repo: string, signal?: AbortSignal, options?: { readOnly?: boolean }): Promise<StatusData>
  /** Direct children of one untracked directory. */
  untracked(repo: string, path: string, signal?: AbortSignal): Promise<UntrackedAnswer>
  /** One file comparison. */
  diff(repo: string, target: DiffTarget, signal?: AbortSignal): Promise<FileComparison>
  /** One page of commits. */
  log(repo: string, page?: LogQuery, signal?: AbortSignal): Promise<LogAnswer>
  /** One commit's metadata and changed files. */
  commit(repo: string, sha: string, signal?: AbortSignal): Promise<CommitAnswer>
  stash(repo: string, sha: string, signal?: AbortSignal): Promise<StashDetailAnswer>
  stashCheck(repo: string, sha: string, mode: StashMode, index: boolean, signal?: AbortSignal): Promise<StashCheck>
  stashOp<T extends StashRequest>(repo: string, request: T): Promise<StashResult<T>>
  /** One completed turn's recorded repository head and change totals. */
  turn(turn: number, seq?: number | null, signal?: AbortSignal): Promise<unknown>
  /** Bring the checked-out branch level with its upstream. */
  sync(repo: string): Promise<SyncAnswer>
  /** Stage or unstage a file, selected lines, or the files of a group or folder. */
  stage(repo: string, target: StageRequest): Promise<StageAnswer>
  /** Undo or redo the entry currently shown in the working tree toolbar. */
  stageHistory(repo: string, action: string, id: string): Promise<StageHistoryWriteAnswer>
  /** Local branches a switch can target, newest commit first. */
  branches(repo: string, signal?: AbortSignal): Promise<BranchesAnswer>
  /** Remotes a tag can be pushed to. */
  remotes(repo: string, signal?: AbortSignal): Promise<RemotesAnswer>
  /** Check out one existing local branch. */
  switchBranch(repo: string, branch: string): Promise<SwitchAnswer>
  /** Run one branch action on an existing local or remote-tracking branch. */
  branchOp(repo: string, action: BranchOpAction, target: BranchOpTarget): Promise<BranchOpAnswer>
  /** Run one tag action on an existing local tag. */
  tagOp(repo: string, action: 'delete' | 'push', target: TagOpTarget): Promise<TagOpAnswer>
  /** Run one commit action on an existing commit. */
  commitOp(repo: string, action: CommitMenuAction, target: CommitOpTarget): Promise<CommitOpAnswer>
  /** Create, remove, or forget a checkout of the selected repository. */
  worktree(repo: string, request: WorktreeRequest): Promise<{ path: string }>
}

/** Whether a decoded body is an object or array, as the route answers always are. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Build the query string for one request.
 * @param params - query values.
 * @returns the query string including the leading `?`.
 */
export function queryString(params: QueryParams): string {
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
function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return failureOf(error).name === 'AbortError' || signal?.aborted === true
}

/** Normalize a cancelled request to an `AbortError`. */
function toAbortError(error: unknown): unknown {
  if (failureOf(error).name === 'AbortError') return error
  return new DOMException('The request was aborted.', 'AbortError')
}

/**
 * Create the Session-scoped API.
 * @param sessionId - the open Conversation Session.
 * @param options - injection seams for tests.
 * @returns the route methods.
 */
export function createApi(sessionId: string, options: ApiOptions = {}): Api {
  const {
    fetchImpl = globalThis.fetch, base = '', worktreeOf = null, clientId = null,
    EventSourceImpl = globalThis.EventSource,
  } = options

  /** In a preview, the selected root is the worktree, not the allowed repository. */
  const browseTarget = (repo: string): { repo: string; worktree?: string } => (
    worktreeOf === null ? { repo } : { repo: worktreeOf, worktree: repo }
  )

  /**
   * Decode one Host answer, turning a non-2xx status into an {@link ApiError}.
   * @param response - the transport answer.
   * @param signal - cancellation.
   * @returns the decoded body.
   */
  async function decode(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let body: unknown = null
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
      const error = isRecord(body) ? body.error : undefined
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'internal'
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : `Request failed (${response.status}).`
      throw new ApiError(code, message, response.status, isRecord(error) ? error : undefined)
    }
    if (bodyFailed || body === null || typeof body !== 'object') {
      throw new ApiError('internal', 'The version control response could not be read.', response.status)
    }
    return body as Record<string, unknown>
  }

  /**
   * One JSON read.
   *
   * The Host answers with the JSON the calling method declares; `decode`
   * validates only that the body is an object.
   * @param path - exact Host route path.
   * @param params - query values.
   * @param signal - cancellation.
   * @returns the decoded body.
   */
  async function get<T>(path: string, params: QueryParams, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}${queryString({ sessionId, ...params })}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: signal ?? undefined,
      })
    } catch (error) {
      if (isAborted(error, signal)) throw toAbortError(error)
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return await decode(response, signal) as T
  }

  /**
   * One JSON write. It carries no AbortSignal: once sent, the Host finishes it
   * even if the panel goes away.
   * @param path - exact Host route path.
   * @param values - body values besides the Session.
   * @returns the decoded body.
   */
  async function post<T>(path: string, values: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...(clientId === null ? {} : { 'X-VCS-Client': clientId }),
        },
        body: JSON.stringify({ sessionId, ...values }),
      })
    } catch {
      throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
    }
    return await decode(response) as T
  }

  return {
    repositories(signal) {
      return get('/api/vcs.repositories', {}, signal)
    },

    async overview(onLine, { repo, signal } = {}) {
      let response: Response
      try {
        response = await fetchImpl(`${base}/api/vcs.overview${queryString({ sessionId, repo })}`, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: signal ?? undefined,
        })
      } catch (error) {
        if (isAborted(error, signal)) throw toAbortError(error)
        throw new ApiError('network', 'The version control panel could not reach the Host.', 0)
      }
      if (!response.ok || response.body === null) {
        await decode(response, signal)
        throw new ApiError('internal', 'The version control response could not be read.', response.status)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const emit = (text: string) => {
        if (text.trim() === '') return
        let line: unknown
        try {
          line = JSON.parse(text)
        } catch {
          return
        }
        if (isRecord(line) && typeof line.type === 'string') onLine(line as OverviewLine)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let end = buffer.indexOf('\n')
          while (end >= 0) {
            emit(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            end = buffer.indexOf('\n')
          }
        }
        emit(buffer + decoder.decode())
      } catch (error) {
        if (isAborted(error, signal)) throw toAbortError(error)
        throw new ApiError('network', 'The version control panel lost the Host connection.', 0)
      }
    },

    /** Subscribe while the panel is visible. EventSource reconnects after transport failures. */
    watch(repo, worktree, onReady, onInvalidate) {
      if (typeof EventSourceImpl !== 'function') {
        onReady()
        return () => {}
      }
      const query = queryString({ sessionId, repo, worktree, client: clientId })
      const source = new EventSourceImpl(`${base}/api/vcs.watch${query}`)
      source.addEventListener('ready', onReady)
      source.addEventListener('error', () => {
        if (source.readyState === EventSourceImpl.CLOSED) onReady()
      })
      source.addEventListener('invalidate', event => {
        // `invalidate` is a MessageEvent carrying JSON; the DOM typings only
        // declare the standard EventSource events.
        const data = (event as MessageEvent).data as string
        let change: unknown
        try {
          change = JSON.parse(data)
        } catch {
          return
        }
        if (!isRecord(change)) return
        if (change.origin === clientId && clientId !== null) return
        if (Array.isArray(change.domains)) onInvalidate(change.domains)
      })
      return () => { source.close() }
    },

    repositoryConfig(signal) {
      return get('/api/vcs.repository-config', {}, signal)
    },

    repositoryPreview(path, kind, signal) {
      return get('/api/vcs.repository-preview', { path, kind }, signal)
    },

    saveRepositoryConfig(revision, scanDirectories, repositories, backends) {
      return post('/api/vcs.repository-config', { revision, scanDirectories, repositories, backends })
    },

    status(repo, signal, { readOnly = false } = {}) {
      return get('/api/vcs.status', { ...browseTarget(repo), readOnly: readOnly ? 1 : undefined }, signal)
    },

    untracked(repo, path, signal) {
      return get('/api/vcs.untracked', { ...browseTarget(repo), path }, signal)
    },

    diff(repo, target, signal) {
      return get('/api/vcs.diff', {
        ...browseTarget(repo),
        scope: target.scope,
        path: target.path,
        oldPath: target.oldPath,
        rev: target.scope === 'commit' || target.scope === 'stash' || target.scope === 'stash-untracked' ? target.rev : undefined,
      }, signal)
    },

    log(repo, page = {}, signal) {
      return get('/api/vcs.log', { repo, worktree: page.worktrees, ref: page.ref, skip: page.skip, limit: page.limit }, signal)
    },

    commit(repo, sha, signal) {
      return get('/api/vcs.commit', { ...browseTarget(repo), sha }, signal)
    },

    stash(repo, sha, signal) {
      return get('/api/vcs.stash', { repo, sha }, signal)
    },

    stashCheck(repo, sha, mode, index, signal) {
      return get('/api/vcs.stash-check', { repo, sha, mode, index: index ? 1 : 0 }, signal)
    },

    stashOp(repo, request) {
      return post('/api/vcs.stash', { repo, ...request })
    },

    turn(turn, seq, signal) {
      return get('/api/vcs.turn', { turn, seq }, signal)
    },

    sync(repo) {
      return post('/api/vcs.sync', { repo })
    },

    stage(repo, { scope, path, oldPath, fingerprint, lines, files }) {
      return post('/api/vcs.stage', { repo, scope, path, oldPath, fingerprint, lines, files })
    },

    stageHistory(repo, action, id) {
      return post('/api/vcs.stage-history', { repo, action, id })
    },

    branches(repo, signal) {
      return get('/api/vcs.branches', { repo }, signal)
    },

    remotes(repo, signal) {
      return get('/api/vcs.remotes', { repo }, signal)
    },

    switchBranch(repo, branch) {
      return post('/api/vcs.switch', { repo, branch })
    },

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

    tagOp(repo, action, target) {
      return post('/api/vcs.tag', {
        repo,
        action,
        tag: target.tag,
        remote: target.remote,
      })
    },

    worktree(repo, request) {
      return post('/api/vcs.worktree', { repo, ...request })
    },

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
