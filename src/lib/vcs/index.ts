/**
 * The version control backends this plugin knows how to read.
 *
 * Discovery is marker-driven: each entry names the directory that marks a
 * repository root. When several markers are present, a configured preference
 * wins if its marker exists; otherwise the first marker found while walking up
 * (and the first marker on a candidate child) wins, so a colocated Jujutsu
 * repository defaults to Jujutsu rather than to its Git side.
 *
 * A backend implements `require`, `status`, `log`, `commit`, `diff`, and
 * optionally `untracked` and `worktrees`, and exposes `capabilities`.
 * The routes and the client never branch on an id.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { ActivityRepositoryAnswer, ActivityRequest } from '../activity.js'
import type { DiffComparison } from '../diff.js'
import type { Limiter, OverviewRepository, UnlistedRoots } from '../overview.js'
import type { JjRef } from '../jujutsu.js'
import type { StashCheck, StashDetailAnswer, StashEntry, StashMode, StashRequest, StashResult } from '../stash-types.js'
import type { StatusBranch, StatusGroups } from '../status.js'
import type { Worktree, WorktreeOptions } from '../worktrees.js'
import type { RecheckTarget, WorktreeChange, WorktreeCreate } from '../worktree-ops.js'
import type { VcsCapabilities } from './capabilities.js'
export type { VcsCapabilities, VcsRange } from './capabilities.js'
import { GitBackend } from './git.js'
import { JujutsuBackend } from './jujutsu.js'

/** The read-only identity of the checked-out branch or working copy. */
export type VcsHead =
  | { kind: 'branch', name: string }
  | { kind: 'detached' }
  | { kind: 'unborn' }
  | { kind: 'workingCopy', changeId: string | null }

/** The working-copy facts a backend where the working copy is a commit reports. */
export interface WorkingCopySummary {
  /** Stable node token for the working-copy commit. */
  node: string
  /** Full commit id. */
  commitId: string
  /** Short change id, when the backend has one. */
  changeId: string | undefined
  /** Full parent commit ids. */
  parents: string[]
  /** Ref badges pointing at the commit. */
  refs: JjRef[]
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
  summary: { changed: number, added: number, deleted: number }
}

/** One status answer, as the routes forward it. */
export interface VcsStatus {
  /** Branch facts, or null for a backend where the working copy is a commit. */
  branch: StatusBranch | null
  /** The file groups; a backend without staging groups leaves them empty. */
  groups: Partial<StatusGroups>
  /** Raw record count. */
  total: number
  /** Number of Git untracked entries before the display cap. */
  untrackedTotal?: number
  /** Added lines in Git untracked text files, or null when the total could not be read. */
  untrackedAdded?: number | null
  /** True when a group was capped. */
  truncated: boolean
  /** The node the view selects first. */
  defaultNode: string
  /** Working-copy facts, for a backend where the working copy is a commit. */
  workingCopy?: WorkingCopySummary
}

/** One history page request. */
export interface LogPage {
  /** Range value; the backend's default when absent. */
  ref?: unknown
  /** Requested page size. */
  limit: number
  /** Requested offset. */
  skip: number
  /** Full commit ids of selected worktree heads, when the client selected some. */
  heads?: string[]
}

/** One history page answer. */
export interface LogPageAnswer {
  /** The commits, newest first. */
  commits: unknown[]
  /** True when the walk reached the offset cap. */
  truncated: boolean
  /** Offset for the next page, or null when the walk ended. */
  nextSkip: number | null
  /** Stash-capable backends report the reflog only on the first page. */
  stashes?: StashEntry[]
  stashesTruncated?: boolean
}

/** One comparison request. */
export interface DiffTarget {
  /** `staged`, `unstaged`, `untracked`, `commit`, `stash`, or `stash-untracked`. */
  scope: unknown
  /** Repository-relative file path. */
  path: unknown
  /** Rename source, when the client saw one. */
  oldPath?: unknown
  /** Commit id, for a commit comparison. */
  rev?: unknown
  /** True for a read-only worktree preview. */
  readOnly?: boolean
}

/** A comparison the view renders as binary or refuses as too large. */
export interface ClosedDiffAnswer {
  /** Which closed state. */
  kind: 'oversized' | 'binary'
  /** Repository-relative path. */
  path: string
}

/** A text comparison, with optional line-staging metadata. */
export interface TextDiffAnswer extends DiffComparison {
  /** Which state. */
  kind: 'text'
  /** Repository-relative path. */
  path: string
  /** Shared-side object id the comparison saw, when known. */
  indexOid?: string
  /** Patch a line-staging write is checked against. */
  stagingPatch?: unknown
  /** True when selected lines can be staged from this comparison. */
  lineStaging?: true
  /** Fingerprint of the staging patch. */
  fingerprint?: string
}

/** One comparison answer. */
export type DiffAnswer = ClosedDiffAnswer | TextDiffAnswer

/** One commit-detail answer. */
export interface CommitAnswer {
  /** The commit metadata and files. */
  commit: unknown
  /** True when the file list was capped. */
  truncated: boolean
}

/** One untracked-directory listing. */
export interface UntrackedListing {
  /** The listed directory, slash-suffixed. */
  path: string
  /** Direct children, sorted by name. */
  entries: UntrackedEntry[]
  /** True when the listing was capped. */
  truncated: boolean
}

/** One direct child of an untracked directory. */
export interface UntrackedEntry {
  /** Basename. */
  name: string
  /** Repository-relative path. */
  path: string
  /** Whether the child is a directory. */
  type: 'directory' | 'file'
}

/** One staging write target: files, or one path with an optional line selection. */
export interface StagingTarget {
  /** `staged`, `unstaged`, or `untracked`. */
  scope?: unknown
  /** Repository-relative path. */
  path?: unknown
  /** Rename source. */
  oldPath?: unknown
  /** Fingerprint of the comparison the selection was made on. */
  fingerprint?: unknown
  /** Selected changed-line addresses. */
  lines?: unknown
  /** Whole files to move. */
  files?: unknown
}

/** One staging-history replay request. */
export interface ReplayOperation {
  /** `undo` or `redo`. */
  action: 'undo' | 'redo'
  /** The history entry id. */
  id: string
}

/** What one upstream sync moved. */
export interface SyncAnswer {
  /** The upstream ref synced with. */
  upstream: string
  /** Commits pulled. */
  pulled: number
  /** Commits pushed. */
  pushed: number
}

/** One local-branch listing. */
export interface BranchListing {
  /** Local branches, newest commit first. */
  branches: { name: string, current: boolean, occupied?: boolean }[]
  /** True when the listing was capped. */
  truncated: boolean
}

/** One remote listing. */
export interface RemoteListing {
  /** Safe remote names. */
  remotes: string[]
  /** True when the listing was capped. */
  truncated: boolean
}

/**
 * The read and write surface a version control backend offers the routes.
 *
 * Every method a route reaches with an optional `typeof backend.x ===
 * 'function'` guard is optional here, so a backend that does not support a
 * capability simply omits it.
 */
export interface VcsBackend {
  /** Capabilities the client reads to choose its layout. */
  readonly capabilities: VcsCapabilities
  /** Capabilities of a browsable sibling tree. */
  readonly worktreeCapabilities: VcsCapabilities
  /** Fail with `vcs-missing` when this host does not have the backend. */
  require(signal: AbortSignal): Promise<void>
  /** Read-only head identity without scanning the working tree. */
  head(root: string, signal: AbortSignal): Promise<VcsHead | null>
  /** Working state and the file groups. */
  status(root: string, signal: AbortSignal, options?: { snapshot?: boolean }): Promise<VcsStatus>
  /** The repository's common directory, for sibling discovery and watching. */
  commonDir(root: string, signal: AbortSignal): Promise<string | null>
  /** Live sibling trees, anchor first. */
  worktrees(root: string, signal: AbortSignal, options?: WorktreeOptions): AsyncIterable<Worktree>
  /** Resolve available lifecycle commands for the installed backend. */
  lifecycleInfo?(root: string, signal: AbortSignal): Promise<{ capabilities: VcsCapabilities, forgotten?: boolean }>
  createWorktree?(root: string, common: string, request: WorktreeCreate, signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange): Promise<void>
  deleteWorktree?(root: string, common: string, tree: Worktree, action: 'remove' | 'forget', signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange): Promise<void>
  /** The repository's backend metadata directory, when there is one. */
  gitDir?(root: string, signal: AbortSignal): Promise<string | null>
  /** Which of a batch of paths the backend ignores. */
  ignoredPaths?(root: string, paths: string[], signal: AbortSignal): Promise<Set<string>>
  /** Full ref names whose changes matter to the view. */
  watchedRefs?(root: string, signal: AbortSignal): Promise<string[]>
  /** Snapshot the working copy, for a backend whose reads may write. */
  snapshot?(root: string, signal: AbortSignal): Promise<void>
  /** Direct children of one untracked directory. */
  untracked?(root: string, raw: string | null, signal: AbortSignal): Promise<UntrackedListing>
  /** One file comparison. */
  diff(root: string, target: DiffTarget, signal: AbortSignal): Promise<DiffAnswer>
  /** One page of history. */
  log(root: string, page: LogPage, signal: AbortSignal): Promise<LogPageAnswer>
  /** One page of local activity, without snapshotting a working copy. */
  activity?(root: string, request: ActivityRequest, signal: AbortSignal): Promise<ActivityRepositoryAnswer>
  /** One commit's metadata and changed files. */
  commit(root: string, rawSha: string | null, signal: AbortSignal): Promise<CommitAnswer>
  /** The staging history's undo and redo tips. */
  stageHistoryTips?(root: string): unknown
  /** Move files or selected lines into the index, or out of it. */
  stage?(root: string, target: StagingTarget, signal: AbortSignal): Promise<unknown>
  /** Replay one staging-history entry. */
  replayStage?(root: string, operation: ReplayOperation, signal: AbortSignal): Promise<unknown>
  /** Run one index write with history recording around it. */
  aroundHistoryWrite?<T>(root: string, signal: AbortSignal, write: () => Promise<T>): Promise<T>
  /** Sync the checked-out branch with its upstream. */
  sync?(root: string, signal: AbortSignal): Promise<SyncAnswer>
  /** Local branches a switch can target. */
  branches?(root: string, signal: AbortSignal): Promise<BranchListing>
  /** Remotes a tag can be pushed to. */
  remotes?(root: string, signal: AbortSignal): Promise<RemoteListing>
  /** Check out one local branch without forcing anything. */
  switchBranch?(root: string, branch: string, signal: AbortSignal): Promise<{ branch: string }>
  /** Dispatch one branch action. */
  branchOp?(root: string, request: unknown, signal: AbortSignal): Promise<unknown>
  /** Dispatch one tag action. */
  tagOp?(root: string, request: unknown, signal: AbortSignal): Promise<unknown>
  /** Dispatch one commit action. */
  commitOp?(root: string, request: unknown, signal: AbortSignal): Promise<unknown>
  stash?(root: string, sha: string, signal: AbortSignal): Promise<StashDetailAnswer>
  stashCheck?(root: string, sha: string, mode: StashMode, index: boolean, signal: AbortSignal): Promise<StashCheck>
  stashOp?(root: string, request: StashRequest, signal: AbortSignal): Promise<StashResult>
  /** One repository's pointers, bases, and occupancy for the overview. */
  overview?(root: string, options: { registered: boolean, statusLimiter?: Limiter, signal: AbortSignal }): Promise<OverviewRepository>
  /** Repositories under the session directory that discovery does not list. */
  unlisted?(cwd: string, listed: { commons: readonly string[], roots: readonly string[] }, signal: AbortSignal): Promise<UnlistedRoots>
}

/** One backend's discovery definition. */
export interface VcsBackendDefinition {
  /** Backend id. */
  id: string
  /** Directory that marks a repository root for this backend. */
  marker: string
  /** Instantiate the backend for one Host context. */
  create(ctx: Context): VcsBackend
}

/** The instantiated backends for one Host context, by id. */
export interface BackendRegistry {
  /** The backend with this id, or undefined when this build has none. */
  get(id: string): VcsBackend | undefined
  /** Every instantiated backend. */
  list(): VcsBackend[]
}

/** Backends in precedence order; the marker is enough to identify one. */
export const VCS_BACKENDS: readonly VcsBackendDefinition[] = Object.freeze([
  Object.freeze({ id: 'jujutsu', marker: '.jj', create: (ctx: Context) => new JujutsuBackend(ctx) }),
  Object.freeze({ id: 'git', marker: '.git', create: (ctx: Context) => new GitBackend(ctx) }),
])

/** Markers discovery tests, in the same precedence order. */
export const VCS_MARKERS: readonly { vcs: string, marker: string }[] = Object.freeze(
  VCS_BACKENDS.map(backend => Object.freeze({ vcs: backend.id, marker: backend.marker })),
)

/**
 * Instantiate every backend once for one Host context.
 * @param ctx - Host context carrying `fs` and `subprocess`.
 * @returns the registry.
 */
export function createBackends(ctx: Context): BackendRegistry {
  const instances = new Map<string, VcsBackend>(VCS_BACKENDS.map(backend => [backend.id, backend.create(ctx)]))
  return {
    get: (id: string) => instances.get(id),
    list: () => [...instances.values()],
  }
}
