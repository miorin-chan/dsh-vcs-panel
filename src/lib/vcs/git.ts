/**
 * Git backend: status, one file's comparison, history, commit detail, branch
 * listing, switching, branch actions, tag actions, commit actions, and sync.
 *
 * Every route but the writes reads. Sync's fast-forward-or-push rules live in
 * `../sync.js`; the branch actions live in `../branch-ops.js`, the tag
 * actions in `../tag-ops.js`, and the commit actions in `../commit-ops.js`.
 * The runner states the fixed safety flags in `../git.js`; argv here is built
 * from fixed strings plus values already validated by the handler or by this
 * module, never from a shell.
 */

import { isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

import { TIMEOUT_MS } from '../command.js'
import type { RunOptions } from '../command.js'
import {
  badRequest,
  notFound,
  outputTooLarge,
  VcsError,
} from '../errors.js'
import {
  COMMIT_FILE_MAX,
  COMMIT_FORMAT,
  mergeCommitFiles,
  parseCommitMetadata,
  parseNameStatusZ,
} from '../commit.js'
import type { DiffHunk } from '../diff.js'
import {
  countRenderedLines,
  decodeFileContent,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  fileHeaderCount,
  isBinaryDiff,
  parseUnifiedDiff,
  syntheticNewFile,
} from '../diff.js'
import { GitRunner } from '../git.js'
import { annotateRemoteRefs, LOG_FORMAT, LOG_PAGE_MAX, LOG_SKIP_MAX, parseLog, parseRefNames } from '../log.js'
import { WORKING_TREE_NODE } from '../nodes.js'
import { EMPTY_TREE, isFullSha, validateRelPath, validateSha } from '../paths.js'
import type { IndexHead, IndexTransactionRunner } from '../index-transaction.js'
import type { StatusBranch } from '../status.js'
import { buildStatusGroups, parseNumstat, parsePorcelainV2 } from '../status.js'
import { canonicalDirectory, containPath } from '../contain.js'
import { listGitRemotes, redactDetail, remoteNames } from '../git-utils.js'
import { requireLocalBranch } from '../ref-utils.js'
import type { GitBranchOpResult, GitBranchRequest } from '../branch-ops.js'
import { runGitBranchOp } from '../branch-ops.js'
import type { GitTagOpResult, GitTagRequest } from '../tag-ops.js'
import { runGitTagOp } from '../tag-ops.js'
import type { GitCommitOpResult, GitCommitRequest } from '../commit-ops.js'
import { runGitCommitOp } from '../commit-ops.js'
import { syncGitBranch } from '../sync.js'
import {
  applyIndexPatch, readStagingPatch, requireStagingFiles, requireStagingTarget, selectedIndexPatch,
  staleDiff, stagingSourceFits, stagingUnsupported, updateIndexFiles,
} from '../staging.js'
import type {
  StagedLineAddress,
  StagingFilesRequest,
  StagingPatch,
  StagingTargetRequest,
} from '../staging.js'
import { StageHistory } from '../stage-history.js'
import type { StageHistoryTips, StageReplayResult, StageResult } from '../stage-history.js'
import type { Worktree, WorktreeOptions } from '../worktrees.js'
import { discoverGitWorktrees, gitCommonDirAt } from '../worktrees.js'
import { createGitWorktree, removeGitWorktree } from '../git-worktree-ops.js'
import type { GitVersion, Limiter, OverviewRepository, UnlistedRoots } from '../overview.js'
import { findUnlistedRepositories, readGitOverview, readGitVersion } from '../overview.js'
import type { RecheckTarget, WorktreeChange, WorktreeCreate } from '../worktree-ops.js'
import type { VcsCapabilities } from './capabilities.js'
import { GIT_CAPABILITIES, GIT_WORKTREE_CAPABILITIES } from './capabilities.js'
import type {
  BranchListing,
  CommitAnswer,
  DiffAnswer,
  DiffTarget,
  LogPage,
  LogPageAnswer,
  RemoteListing,
  ReplayOperation,
  SyncAnswer,
  UntrackedEntry,
  UntrackedListing,
  VcsHead,
  VcsStatus,
} from './index.js'

/** Most entries one expanded untracked directory lists. */
const UNTRACKED_MAX = 500

/** Concurrent content reads for one worktree's untracked line total. */
const UNTRACKED_READS = 4

/** Most local branches the switch menu lists. */
const BRANCH_MAX = 500

/** The four comparisons the diff route serves for Git. */
const SCOPES: Set<string> = new Set(['staged', 'unstaged', 'untracked', 'commit'])

/** A staging write applies only to the branch and commit its status read saw. */
function requireHead(branch: StatusBranch, head: IndexHead): void {
  const ref = branch.detached ? null : `refs/heads/${branch.name}`
  if (head.oid !== branch.oid || head.ref !== ref) throw staleDiff()
}

/**
 * One property of a caught failure, read only for classification.
 * @param error - the caught value.
 * @param key - which diagnostic property.
 * @returns the value, or undefined when the caught value has no such property.
 */
function errorPart(error: unknown, key: 'code' | 'message'): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  if (key === 'code') return 'code' in error ? error.code : undefined
  return 'message' in error ? error.message : undefined
}

/** The stable code a caught failure carries, for classification only. */
function caughtCode(error: unknown): unknown {
  return errorPart(error, 'code')
}

/** The error text a caught filesystem failure carries, for classification only. */
function caughtText(error: unknown): string {
  return `${String(errorPart(error, 'code') ?? '')} ${String(errorPart(error, 'message') ?? '')}`
}

/** One single-file staging write, as the route validated it. */
interface SingleFileStageTarget extends StagingTargetRequest {
  /** Fingerprint of the comparison the selected lines came from. */
  fingerprint?: string
  /** Selected changed-line addresses. */
  lines?: StagedLineAddress[]
  /** Never present on a single-file write; whole-file writes carry it instead. */
  files?: undefined
}

/** One staging write: whole files, or selected lines of one file. */
type GitStageTarget = SingleFileStageTarget | StagingFilesRequest

/** What one #readDiff call may receive: a route target or a staging target. */
interface ReadDiffTarget {
  /** `staged`, `unstaged`, `untracked`, or `commit`. */
  scope?: unknown
  /** Repository-relative file path. */
  path?: unknown
  /** Rename source. */
  oldPath?: unknown
  /** Commit id, for a commit comparison. */
  rev?: unknown
  /** True for a read-only worktree preview. */
  readOnly?: boolean
}

/** One text comparison as this backend parses it, before the public answer adds staging state. */
interface GitTextDiff {
  /** Which state. */
  kind: 'text'
  /** Repository-relative path. */
  path: string
  /** False when the old side is `/dev/null`. */
  before: boolean
  /** False when the new side is `/dev/null`. */
  after: boolean
  /** The hunks to render. */
  hunks: DiffHunk[]
  /** Shared-side object id the comparison saw, when known. */
  indexOid?: string
  /** Patch a line-staging write is checked against. */
  stagingPatch?: StagingPatch
}

/** A closed comparison, as this backend parses it. */
interface GitClosedDiff {
  /** Which closed state. */
  kind: 'oversized' | 'binary'
  /** Repository-relative path. */
  path: string
}

/** One comparison answer before the public answer adds staging state. */
type GitDiffAnswer = GitClosedDiff | GitTextDiff

/**
 * Prefix a repository-relative path with git's `literal` pathspec magic.
 * Without it a path that starts with `:` would be read as pathspec magic
 * (glob or exclude), which can widen the match far beyond the named file.
 * @param path - a validated repository-relative path.
 * @returns the literal pathspec.
 */
function literalPathspec(path: string): string {
  return `:(literal)${path}`
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
 * Ask which of a directory's direct children git ignores, in one batch.
 * @param git - command runner.
 * @param root - repository root.
 * @param paths - repository-relative child paths.
 * @param signal - cancellation.
 * @returns the ignored paths.
 */
async function ignoredPaths(
  git: GitRunner,
  root: string,
  paths: string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '-z', '--stdin', '--'], {
    cwd: root,
    signal,
    stdin: `${paths.join(String.fromCharCode(0))}${String.fromCharCode(0)}`,
  })
  // 0 means "some paths matched", 1 means "none matched"; both are answers.
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new VcsError('internal', 'Ignored paths could not be checked.')
  }
  return new Set(result.stdout.split(String.fromCharCode(0)).filter(value => value !== ''))
}

/** The Git backend. */
export class GitBackend {
  /** The Host context. */
  declare readonly ctx: Context
  /** The `git` runner with its fixed safety flags. */
  declare readonly git: GitRunner
  /** In-memory staging history for this backend's lifetime. */
  declare readonly stageHistory: StageHistory

  /**
   * @param ctx - Host context carrying `fs` and `subprocess`.
   */
  constructor(ctx: Context) {
    this.ctx = ctx
    this.git = new GitRunner(ctx)
    this.stageHistory = new StageHistory(ctx, this.git)
  }

  /** The installed release, read once it answers. */
  #version: GitVersion | undefined

  /** Capabilities the client reads to choose its layout. */
  get capabilities(): VcsCapabilities {
    return GIT_CAPABILITIES
  }

  /**
   * The installed Git release; an unreadable answer is asked again next time.
   * @param cwd - any directory to run in.
   * @param signal - cancellation.
   * @returns the release, or null when unreadable.
   */
  async version(cwd: string, signal: AbortSignal): Promise<GitVersion | null> {
    if (this.#version !== undefined) return this.#version
    const version = await readGitVersion(this.git, cwd, signal)
    if (version !== null) this.#version = version
    return version
  }

  /**
   * One repository's pointers, bases, and occupancy for the overview.
   * @param root - repository root.
   * @param options - whether discovery lists it, the shared status bound, and cancellation.
   * @returns the overview.
   */
  async overview(root: string, options: { registered: boolean, statusLimiter?: Limiter, signal: AbortSignal }): Promise<OverviewRepository> {
    const version = await this.version(root, options.signal)
    return readGitOverview({ ctx: this.ctx, git: this.git, root, version, ...options })
  }

  /**
   * Repositories under the session directory that discovery does not list.
   * @param cwd - canonical session directory.
   * @param listed - common directories and roots already listed.
   * @param signal - cancellation.
   * @returns the roots found.
   */
  unlisted(cwd: string, listed: { commons: readonly string[], roots: readonly string[] }, signal: AbortSignal): Promise<UnlistedRoots> {
    return findUnlistedRepositories(this.ctx, this.git, cwd, listed, signal)
  }

  /** Registered sibling trees can be browsed, never used for panel actions. */
  get worktreeCapabilities(): VcsCapabilities {
    return GIT_WORKTREE_CAPABILITIES
  }

  commonDir(root: string, signal: AbortSignal): Promise<string | null> {
    return gitCommonDirAt(this.git, root, signal)
  }

  async gitDir(root: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.git.run(['rev-parse', '--absolute-git-dir'], { cwd: root, signal })
    if (result.lossy || result.exitCode !== 0 || !result.stdout.endsWith('\n')) return null
    const path = result.stdout.slice(0, -1)
    return isAbsolute(path) ? await canonicalDirectory(this.ctx, path, signal) : null
  }

  ignoredPaths(root: string, paths: string[], signal: AbortSignal): Promise<Set<string>> {
    return ignoredPaths(this.git, root, paths, signal)
  }

  /** Full names include the configured upstream even while its loose ref is absent. */
  async watchedRefs(root: string, signal: AbortSignal): Promise<string[]> {
    const symbolic = await this.git.run(['symbolic-ref', '-q', 'HEAD'], { cwd: root, signal })
    if (symbolic.lossy || symbolic.exitCode !== 0 || !symbolic.stdout.endsWith('\n')) return []
    const head = symbolic.stdout.slice(0, -1)
    if (!head.startsWith('refs/heads/')) return []
    const refs = await this.git.run(['for-each-ref', '--format=%(refname)%00%(upstream)', head], { cwd: root, signal })
    const line = refs.exitCode === 0 && !refs.lossy && refs.stdout.split('\n').find(record => record.startsWith(`${head}\0`))
    const upstream = line ? line.slice(head.length + 1) : ''
    return upstream.startsWith('refs/') && upstream !== head ? [head, upstream] : [head]
  }

  worktrees(
    root: string,
    signal: AbortSignal,
    options?: WorktreeOptions,
  ): AsyncGenerator<Worktree> {
    return discoverGitWorktrees(this.ctx, this.git, root, signal, options)
  }

  createWorktree(root: string, common: string, request: WorktreeCreate, signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange): Promise<void> {
    return createGitWorktree(this.ctx, this.git, root, common, request, signal, recheck, changed)
  }

  deleteWorktree(root: string, _common: string, tree: Worktree, _action: 'remove' | 'forget', signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange): Promise<void> {
    return removeGitWorktree(this.ctx, this.git, root, tree, signal, recheck, changed)
  }

  /**
   * Fail with `vcs-missing` when this host has no git.
   * @param signal - cancellation.
   * @returns nothing; rejects when git is missing.
   */
  async require(signal: AbortSignal): Promise<void> {
    if (await this.git.resolve(signal) === null) {
      throw new VcsError('vcs-missing', 'git is not available on this host.')
    }
  }

  /**
   * Read-only head identity without scanning the working tree or index.
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns the head identity, or null when git cannot report one.
   */
  async head(root: string, signal: AbortSignal): Promise<VcsHead | null> {
    if (await this.git.resolve(signal) === null) return null
    const [symbolic, verified] = await Promise.all([
      this.git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal }),
      this.git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, signal }),
    ])
    if (symbolic.lossy || verified.lossy) return null
    const name = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ''
    const hasCommit = verified.exitCode === 0
    if (name !== '') return hasCommit ? { kind: 'branch', name } : { kind: 'unborn' }
    return hasCommit ? { kind: 'detached' } : null
  }

  /**
   * Working-tree status and the three file groups.
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns branch, groups, totals, and the default node.
   */
  async status(root: string, signal: AbortSignal): Promise<VcsStatus> {
    const statusResult = await this.git.run(
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
      { cwd: root, signal },
    )
    if (statusResult.lossy) throw outputTooLarge()
    if (statusResult.exitCode !== 0) {
      throw new VcsError('internal', 'The repository status could not be read.')
    }
    const parsed = parsePorcelainV2(statusResult.stdout)

    const untracked = parsed.entries.filter(entry => entry.untracked).map(entry => entry.path)
    const [staged, unstaged, untrackedAdded] = await Promise.all([
      this.git.run(['--no-pager', 'diff', '--numstat', '-z', '--cached'], {
        cwd: root,
        signal,
      }),
      this.git.run(['--no-pager', 'diff', '--numstat', '-z'], {
        cwd: root,
        signal,
      }),
      this.#untrackedLineTotal(root, untracked, signal),
    ])
    if (staged.lossy || unstaged.lossy) throw outputTooLarge()

    const grouped = buildStatusGroups(
      parsed.entries,
      parseNumstat(staged.stdout),
      parseNumstat(unstaged.stdout),
    )
    const defaultNode = grouped.total > 0
      ? WORKING_TREE_NODE
      : (parsed.branch.oid ?? WORKING_TREE_NODE)
    return {
      branch: parsed.branch,
      groups: grouped.groups,
      truncated: grouped.truncated,
      total: grouped.total,
      untrackedTotal: grouped.untrackedTotal,
      untrackedAdded,
      defaultNode,
    }
  }

  /** Count regular UTF-8 files before the status groups are capped. */
  async #untrackedLineTotal(root: string, paths: string[], signal: AbortSignal): Promise<number | null> {
    if (paths.length === 0) return 0
    const countSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    try {
      if (paths.some(path => path.endsWith('/'))) {
        const listed = await this.git.run(['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd: root,
          signal: countSignal,
        })
        if (listed.exitCode !== 0 || listed.lossy) return null
        // A trailing slash identifies a nested repository, which Git stages as a gitlink.
        paths = listed.stdout.split('\0').filter(path => path !== '' && !path.endsWith('/'))
      }
      const repository = await this.ctx.fs.resolve(root, { signal: countSignal })
      let added = 0
      for (let start = 0; start < paths.length; start += UNTRACKED_READS) {
        countSignal.throwIfAborted()
        const batch = await Promise.allSettled(paths.slice(start, start + UNTRACKED_READS).map(path =>
          this.#untrackedFileLines(repository, join(root, path), countSignal)))
        countSignal.throwIfAborted()
        for (const result of batch) {
          if (result.status === 'rejected') return null
          added += result.value
        }
      }
      return added
    } catch {
      signal.throwIfAborted()
      return null
    }
  }

  /** Use the new-file diff's LF and UTF-8 rules, including an unterminated last line. */
  async #untrackedFileLines(repository: FsTarget, path: string, signal: AbortSignal): Promise<number> {
    const fs = this.ctx.fs
    const info = await fs.lstat(path, undefined, signal)
    if (info?.type !== 'file') return 0
    const target = await fs.resolve(path, { signal })
    if (!fs.contains(repository, target)) throw badRequest('The path is outside the repository.')

    try {
      let chunks: Iterable<string> | AsyncIterable<string>
      if (info.size !== undefined && info.size <= DIFF_MAX_BYTES) {
        const content = decodeFileContent(await fs.readBytes(target, signal, DIFF_MAX_BYTES))
        if (content.binary) return 0
        chunks = [content.text]
      } else {
        chunks = await fs.streamText(target, signal)
      }

      let lines = 0
      let finalLine = 0
      for await (const text of chunks) {
        if (text === '') continue
        if (text.includes('\0')) return 0
        for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1
        finalLine = text.endsWith('\n') ? 0 : 1
      }
      return lines + finalLine
    } catch (error) {
      if (caughtCode(error) === 'FS_NOT_TEXT') return 0
      throw error
    }
  }

  /**
   * Direct children of one untracked directory.
   * @param root - repository root.
   * @param raw - the directory path, slash-suffixed.
   * @param signal - cancellation.
   * @returns the listing.
   */
  async untracked(root: string, raw: unknown, signal: AbortSignal): Promise<UntrackedListing> {
    if (typeof raw !== 'string' || !raw.endsWith('/')) {
      throw badRequest('path must be a directory path ending with /.')
    }
    const rel = validateRelPath(raw.slice(0, -1))
    if (rel === undefined) throw badRequest('path must be a repository-relative directory.')

    const target = await containPath(this.ctx, root, rel, signal)
    const info = await this.ctx.fs.stat(target, signal).catch(() => undefined)
    if (info === undefined) throw notFound('That directory is not present.')
    if (info.type !== 'directory') throw badRequest('That path is not a directory.')

    let listing
    try {
      listing = await this.ctx.fs.listDir(target, signal)
    } catch {
      throw notFound('That directory could not be read.')
    }

    const childPaths = listing.map(entry => `${rel}/${entry.name}`)
    const ignored = await ignoredPaths(this.git, root, childPaths, signal)

    const entries: UntrackedEntry[] = []
    for (const entry of listing) {
      const entryPath = `${rel}/${entry.name}`
      if (ignored.has(entryPath)) continue
      entries.push({
        name: entry.name,
        path: entryPath,
        type: entry.type === 'directory' ? 'directory' : 'file',
      })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const truncated = entries.length > UNTRACKED_MAX
    return {
      path: `${rel}/`,
      entries: truncated ? entries.slice(0, UNTRACKED_MAX) : entries,
      truncated,
    }
  }

  /**
   * Resolve `rev` for a commit diff into the two commits to compare.
   *
   * The id is hexadecimal and resolved to a full commit before it is used in
   * any further argv, so a request value never becomes an option or a revision
   * expression beyond `rev-parse --verify`.
   *
   * @param rawRev - the request value.
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns the two commits to compare.
   */
  async resolveDiffCommit(rawRev: unknown, root: string, signal: AbortSignal): Promise<{ from: string, to: string }> {
    const rev = validateSha(rawRev)
    if (rev === undefined) throw badRequest('rev must be a hexadecimal commit id.')
    const resolved = await this.git.run(['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd: root,
      signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const to = resolved.stdout.trim()
    if (!isFullSha(to)) throw notFound('That commit is not available.')

    const parentsResult = await this.git.run(['rev-list', '--parents', '-n', '1', to], {
      cwd: root,
      signal,
    })
    if (parentsResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit parents could not be read.')
    }
    const [, ...parents] = parentsResult.stdout.trim().split(' ').filter(value => value !== '')
    // A root commit has nothing to compare against, so it diffs from the empty
    // tree: every file in it renders as added.
    return { from: parents.length > 0 ? parents[0] : EMPTY_TREE, to }
  }

  /**
   * Ask whether git's numstat calls the requested comparison binary.
   * @param root - repository root.
   * @param scope - the comparison.
   * @param range - commit range when scope is commit.
   * @param paths - pathspec arguments.
   * @param rel - repository-relative file path.
   * @param signal - cancellation.
   * @param git - command runner.
   * @returns true when the comparison is binary.
   */
  async binaryFromNumstat(
    root: string,
    scope: string,
    range: { from: string, to: string } | undefined,
    paths: string[],
    rel: string,
    signal: AbortSignal,
    git: IndexTransactionRunner = this.git,
  ): Promise<boolean> {
    const args = ['--no-pager', 'diff', '--numstat', '-z', '--no-color']
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const result = await git.run(args, { cwd: root, signal })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) return false
    return parseNumstat(result.stdout).get(rel)?.binary === true
  }

  /**
   * Reject a request whose path names a directory or a broad pathspec rather
   * than the single file the view renders.
   * @param type - the object type git reported.
   * @returns nothing; throws for a tree.
   */
  refuseDirectory(type: string): void {
    if (type === 'tree') throw badRequest('The path names a directory, not a file.')
  }

  /**
   * Confirm that a path is present on the commit side of a commit comparison.
   * @param root - repository root.
   * @param rev - full commit id.
   * @param rel - repository-relative file path.
   * @param signal - cancellation.
   * @returns the object type.
   */
  async commitPathType(
    root: string,
    rev: string,
    rel: string,
    signal: AbortSignal,
  ): Promise<'blob' | 'tree' | 'absent'> {
    const result = await this.git.run(['cat-file', '-t', `${rev}:${rel}`], { cwd: root, signal })
    if (result.exitCode !== 0) return 'absent'
    const type = result.stdout.trim()
    return type === 'blob' || type === 'tree' ? type : 'absent'
  }

  /**
   * Confirm that a path is tracked in the index.
   * @param root - repository root.
   * @param rel - repository-relative file path.
   * @param signal - cancellation.
   * @param git - command runner.
   * @returns true when the index knows the path.
   */
  async trackedInIndex(
    root: string,
    rel: string,
    signal: AbortSignal,
    git: IndexTransactionRunner = this.git,
  ): Promise<boolean> {
    const result = await git.run(['ls-files', '-z', '--', literalPathspec(rel)], {
      cwd: root,
      signal,
    })
    if (result.exitCode !== 0 || result.lossy) return false
    return result.stdout !== ''
  }

  /**
   * Present one untracked file as a wholly new text or binary file.
   * @param root - repository root.
   * @param rel - repository-relative file path.
   * @param target - resolved filesystem target.
   * @param signal - cancellation.
   * @param allowStaging - whether the worktree accepts index writes.
   * @param git - command runner.
   * @returns the comparison answer.
   */
  async untrackedDiff(
    root: string,
    rel: string,
    target: FsTarget,
    signal: AbortSignal,
    allowStaging: boolean,
    git: IndexTransactionRunner = this.git,
  ): Promise<GitDiffAnswer> {
    const info = await this.ctx.fs.stat(target, signal).catch(() => undefined)
    if (info === undefined) throw notFound('That file is not present.')
    if (info.type !== 'file') throw badRequest('That path is not a file.')
    if (info.size !== undefined && info.size > DIFF_MAX_BYTES) {
      return { kind: 'oversized', path: rel }
    }

    let bytes
    try {
      bytes = await this.ctx.fs.readBytes(target, signal, DIFF_MAX_BYTES + 1)
    } catch (error) {
      if (/TOO_LARGE|too large/iu.test(caughtText(error))) return { kind: 'oversized', path: rel }
      throw notFound('That file is no longer available.')
    }
    if (bytes.byteLength > DIFF_MAX_BYTES) return { kind: 'oversized', path: rel }

    const decoded = decodeFileContent(bytes)
    if (decoded.binary) return { kind: 'binary', path: rel }
    const comparison = syntheticNewFile(decoded.text)
    if (countRenderedLines(comparison.hunks) > DIFF_MAX_LINES) {
      return { kind: 'oversized', path: rel }
    }
    const stagingPatch = allowStaging && comparison.hunks.length > 0 && !decoded.text.includes('\r')
      ? await this.#untrackedStagingPatch(root, rel, comparison.hunks[0].lines, signal, git)
      : undefined
    return { kind: 'text', path: rel, ...comparison, stagingPatch }
  }

  /** Confirm that Git sees the same regular file and can stage raw text bytes. */
  async #untrackedStagingPatch(
    root: string,
    path: string,
    lines: string[],
    signal: AbortSignal,
    git: IndexTransactionRunner,
  ): Promise<StagingPatch | undefined> {
    const options: RunOptions = { cwd: root, signal, maxBytes: DIFF_MAX_BYTES + 1 }
    const attrs = await git.run(['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', 'diff', '--', path], options)
    if (attrs.exitCode !== 0 || attrs.lossy) return undefined
    const values = attrs.stdout.split('\0').filter((_, index) => index % 3 === 2)
    if (values.length !== 4 || values[3] !== 'unspecified'
      || values.slice(0, 3).some(value => value !== 'unspecified' && value !== 'unset')) return undefined

    const output = await git.run([
      '--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', path,
    ], options)
    if (output.exitCode !== 1 || output.lossy) return undefined
    let raw = output.stdout
    const executableMode = /^new file mode 100755$/mu
    if (executableMode.test(raw)) {
      const fileMode = await git.run(['config', '--bool', '--get', 'core.fileMode'], options)
      if (fileMode.exitCode === 0 && fileMode.stdout.trim() === 'false') {
        raw = raw.replace(executableMode, 'new file mode 100644')
      }
    }
    const patch = readStagingPatch(raw, { scope: 'untracked', path })
    if (patch?.hunks.length !== 1) return undefined
    const [hunk] = patch.hunks
    if (lines.length !== hunk.lines.length || !lines.every((line, index) => line === hunk.lines[index])) return undefined
    return patch
  }

  /**
   * One file comparison, plus whether its lines can be staged.
   * @param root - repository root.
   * @param target - comparison target.
   * @param signal - cancellation.
   * @returns the comparison state.
   */
  async diff(root: string, target: DiffTarget, signal: AbortSignal): Promise<DiffAnswer> {
    const result = await this.#readDiff(root, target, signal)
    if (result.kind !== 'text') return result
    const { stagingPatch, ...answer } = result
    if (stagingPatch === undefined || !await stagingSourceFits(this.git, root, stagingPatch, signal)) {
      return answer
    }
    return { ...answer, lineStaging: true, fingerprint: stagingPatch.fingerprint }
  }

  stageHistoryTips(root: string): StageHistoryTips {
    return this.stageHistory.tips(root)
  }

  replayStage(root: string, operation: ReplayOperation, signal: AbortSignal): Promise<StageReplayResult> {
    return this.stageHistory.replay(root, operation, signal)
  }

  aroundHistoryWrite<T>(root: string, signal: AbortSignal, write: () => Promise<T>): Promise<T> {
    return this.stageHistory.aroundWrite(root, signal, write)
  }

  /** One staging write: whole files, or selected lines of one file. */
  stage(root: string, target: GitStageTarget, signal: AbortSignal): Promise<StageResult> {
    return this.stageHistory.stage(root, target, signal, (git, head) => this.#applyStage(git, root, target, head, signal))
  }

  async #applyStage(
    git: IndexTransactionRunner,
    root: string,
    target: GitStageTarget,
    head: IndexHead,
    signal: AbortSignal,
  ): Promise<{ paths: string[], files?: string[] }> {
    if (target.files !== undefined) {
      const resolved = await requireStagingFiles(git, root, target, signal)
      requireHead(resolved.branch, head)
      await updateIndexFiles(git, root, target.scope, resolved, signal)
      return { paths: resolved.paths, files: resolved.files }
    }
    const { scope, path, fingerprint, lines } = target
    const file = await requireStagingTarget(git, root, target, signal)
    requireHead(file.branch, head)
    if (fingerprint !== undefined || lines !== undefined) {
      if (file.renamed) throw stagingUnsupported()
      let comparison: GitDiffAnswer
      try {
        comparison = await this.#readDiff(root, target, signal, git)
      } catch (error) {
        if (caughtCode(error) === 'not-found' || caughtCode(error) === 'bad-request') throw staleDiff()
        throw error
      }
      if (comparison.kind !== 'text') throw stagingUnsupported()
      const patch = comparison.stagingPatch
      if (patch === undefined) throw stagingUnsupported()
      if (patch.fingerprint !== fingerprint) throw staleDiff()
      if (lines !== undefined) {
        const selection = await selectedIndexPatch(git, root, { scope, path, lines }, patch, signal)
        await applyIndexPatch(git, root, selection, signal)
        return { paths: [path] }
      }
    }
    await updateIndexFiles(git, root, scope, file, signal)
    return { paths: file.paths }
  }

  /**
   * One file comparison.
   * @param root - repository root.
   * @param target - comparison target.
   * @param signal - cancellation.
   * @param git - command runner.
   * @returns the comparison state.
   */
  async #readDiff(
    root: string,
    target: ReadDiffTarget,
    signal: AbortSignal,
    git: IndexTransactionRunner = this.git,
  ): Promise<GitDiffAnswer> {
    const scope = target.scope
    if (typeof scope !== 'string' || !SCOPES.has(scope)) {
      throw badRequest('scope is unstaged, staged, untracked, or commit.')
    }
    const rel = validateRelPath(target.path)
    if (rel === undefined) throw badRequest('path must be a repository-relative file path.')
    const rawOldPath = target.oldPath
    const oldPath = rawOldPath === null || rawOldPath === undefined ? undefined : validateRelPath(rawOldPath)
    if (rawOldPath !== null && rawOldPath !== undefined && oldPath === undefined) {
      throw badRequest('oldPath must be a repository-relative file path.')
    }

    const resolvedTarget = await containPath(this.ctx, root, rel, signal)
    if (scope === 'untracked') return this.untrackedDiff(root, rel, resolvedTarget, signal, target.readOnly !== true, git)
    if (oldPath !== undefined) await containPath(this.ctx, root, oldPath, signal)
    // A rename is only detected when both sides are named; one path reads as a
    // brand-new or deleted file instead.
    const paths = oldPath === undefined || oldPath === rel ? [rel] : [oldPath, rel]

    let range: { from: string, to: string } | undefined
    if (scope === 'commit') {
      const resolved = await this.resolveDiffCommit(target.rev, root, signal)
      range = { from: resolved.from, to: resolved.to }
    }

    const current = await this.ctx.fs.stat(resolvedTarget, signal).catch(() => undefined)
    if (scope === 'unstaged' && current?.type === 'directory') {
      throw badRequest('That path is a directory, not a file.')
    }

    const args = [
      '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', '-U3',
      '--src-prefix=a/', '--dst-prefix=b/', '--output-indicator-old=-', '--output-indicator-new=+', '--output-indicator-context= ',
    ]
    if (scope === 'staged') args.push('--cached')
    if (range !== undefined) args.push(range.from, range.to)
    args.push('--', ...paths.map(literalPathspec))
    const output = await git.run(args, {
      cwd: root,
      signal,
      maxBytes: DIFF_MAX_BYTES + 1,
    })
    if (output.lossy || Buffer.byteLength(output.stdout, 'utf8') > DIFF_MAX_BYTES) {
      return { kind: 'oversized', path: rel }
    }
    if (output.exitCode !== 0) {
      throw new VcsError('internal', 'The comparison could not be read.')
    }
    if (fileHeaderCount(output.stdout) > 1) {
      throw badRequest('The path matches more than one file.')
    }
    if (isBinaryDiff(output.stdout)) return { kind: 'binary', path: rel }

    const comparison = parseUnifiedDiff(output.stdout)
    if (comparison.hunks.length === 0) {
      if (await this.binaryFromNumstat(root, scope, range, paths, rel, signal, git)) {
        return { kind: 'binary', path: rel }
      }
      if (range !== undefined) {
        const type = await this.commitPathType(root, range.to, rel, signal)
        this.refuseDirectory(type)
        if (type !== 'blob') throw notFound('That file is not part of the commit.')
      } else if (scope === 'staged') {
        if (!(await this.trackedInIndex(root, rel, signal, git))) {
          throw notFound('That file is not staged.')
        }
      } else {
        const fresh = await this.ctx.fs.stat(resolvedTarget, signal).catch(() => undefined)
        if (fresh === undefined) throw notFound('That file is not present.')
        if (fresh.type === 'directory') throw badRequest('That path is a directory, not a file.')
      }
    }
    if (countRenderedLines(comparison.hunks) > DIFF_MAX_LINES) {
      return { kind: 'oversized', path: rel }
    }
    const stagingScope = scope === 'staged' || scope === 'unstaged' || scope === 'untracked' ? scope : undefined
    const stagingPatch = stagingScope !== undefined && oldPath === undefined && target.readOnly !== true
      && comparison.hunks.length > 0
      ? readStagingPatch(output.stdout, { scope: stagingScope, path: rel })
      : undefined
    // Full-index patch headers identify the exact shared side of both comparisons.
    const objects = /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})(?: |$)/mu.exec(output.stdout)
    const indexOid = scope === 'staged' ? objects?.[2] : scope === 'unstaged' ? objects?.[1] : undefined
    return { kind: 'text', path: rel, ...comparison, ...(indexOid === undefined ? {} : { indexOid }), stagingPatch }
  }

  /**
   * One page of commits.
   * @param root - repository root.
   * @param page - page and Host-resolved tips.
   * @param signal - cancellation.
   * @returns the page.
   */
  async log(root: string, page: LogPage, signal: AbortSignal): Promise<LogPageAnswer> {
    const ref = typeof page.ref === 'string' ? page.ref : GIT_CAPABILITIES.defaultRange
    if (ref !== 'HEAD' && ref !== 'all') throw badRequest('ref is HEAD or all.')
    const limit = clamp(page.limit, 1, LOG_PAGE_MAX)
    const skip = clamp(page.skip, 0, LOG_SKIP_MAX)

    const args = [
      '--no-pager',
      'log',
      '--no-color',
      '--topo-order',
      '--decorate=full',
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit}`,
      `--skip=${skip}`,
    ]
    if (ref === 'all') args.push('--all')
    else if (page.heads === undefined) args.push('HEAD')
    else if (page.heads.length === 0) return { commits: [], truncated: false, nextSkip: null }
    else args.push(...new Set(page.heads), '--')
    const result = await this.git.run(args, { cwd: root, signal })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      // An unborn branch has no HEAD to walk; that is an empty history, not a
      // failure. Every other complaint is a real read failure.
      if (ref === 'HEAD' && /unknown revision|does not have any commits|bad revision|ambiguous argument/iu.test(result.stderr)) {
        return { commits: [], truncated: false, nextSkip: null }
      }
      throw new VcsError('internal', 'The history could not be read.')
    }

    const parsed = parseLog(result.stdout)
    const commits = parsed.some(commit => commit.refs.some(ref => ref.kind === 'remote'))
      ? annotateRemoteRefs(parsed, await remoteNames(this.git, root, signal))
      : parsed
    const truncated = skip + commits.length >= LOG_SKIP_MAX
    return {
      commits,
      truncated,
      nextSkip: commits.length === 0 ? null : skip + commits.length,
    }
  }

  /**
   * One commit's metadata and changed files.
   * @param root - repository root.
   * @param rawSha - full or abbreviated commit id.
   * @param signal - cancellation.
   * @returns the commit.
   */
  async commit(root: string, rawSha: unknown, signal: AbortSignal): Promise<CommitAnswer> {
    const sha = validateSha(rawSha)
    if (sha === undefined) throw badRequest('sha must be a hexadecimal commit id.')
    const resolved = await this.git.run(['rev-parse', '--verify', `${sha}^{commit}`], {
      cwd: root,
      signal,
    })
    if (resolved.exitCode !== 0 || resolved.lossy) throw notFound('That commit is not available.')
    const full = resolved.stdout.trim()
    if (!isFullSha(full)) throw notFound('That commit is not available.')

    const [metadataResult, refsResult, headSymbolic, headCommit] = await Promise.all([
      this.git.run(
        ['--no-pager', 'show', '-s', '--no-color', `--format=${COMMIT_FORMAT}`, full],
        { cwd: root, signal },
      ),
      this.git.run(
        ['for-each-ref', '--format=%(refname)%00%(HEAD)', `--points-at=${full}`],
        { cwd: root, signal },
      ),
      this.git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal }),
      this.git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, signal }),
    ])
    if (metadataResult.lossy || refsResult.lossy) throw outputTooLarge()
    if (metadataResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }
    const metadata = parseCommitMetadata(metadataResult.stdout)
    if (metadata === undefined) {
      throw new VcsError('internal', 'The commit metadata could not be read.')
    }
    if (refsResult.exitCode !== 0) {
      throw new VcsError('internal', 'The commit refs could not be read.')
    }

    let refs = parseRefNames(refsResult.stdout)
    if (headSymbolic.exitCode !== 0 && headCommit.exitCode === 0 && headCommit.stdout.trim() === full) {
      refs = [{ name: 'HEAD', kind: 'head' }, ...refs]
    }
    const hasRemoteRefs = refs.some(ref => ref.kind === 'remote')

    // A merge commit has no default diff in diff-tree; the design compares a
    // selected file against the first parent, so that comparison is explicit.
    // `--no-ext-diff` keeps a repository-configured external diff program out
    // of every comparison, matching the diff route.
    const base = ['diff-tree', '--no-ext-diff', '--no-commit-id', '-r', '-M', '-z']
    const tree = metadata.parents.length > 1
      ? [metadata.parents[0], full]
      : ['--root', full]
    const [names, counts, remotes] = await Promise.all([
      this.git.run([...base, '--name-status', ...tree], { cwd: root, signal }),
      this.git.run([...base, '--numstat', ...tree], { cwd: root, signal }),
      hasRemoteRefs ? remoteNames(this.git, root, signal) : Promise.resolve(null),
    ])
    if (names.lossy || counts.lossy) throw outputTooLarge()
    if (names.exitCode !== 0 || counts.exitCode !== 0) {
      throw new VcsError('internal', 'The commit files could not be read.')
    }
    if (remotes !== null) {
      refs = annotateRemoteRefs([{ refs }], remotes)[0].refs
    }

    const files = mergeCommitFiles(parseNameStatusZ(names.stdout), parseNumstat(counts.stdout))
    const truncated = files.length > COMMIT_FILE_MAX
    return {
      commit: {
        sha: metadata.sha,
        parents: metadata.parents,
        refs,
        author: metadata.author,
        authorTime: metadata.authorTime,
        committer: metadata.committer,
        committerTime: metadata.committerTime,
        subject: metadata.subject,
        message: metadata.message,
        files: truncated ? files.slice(0, COMMIT_FILE_MAX) : files,
      },
      truncated,
    }
  }

  /**
   * Local branches, newest commit first, with the checked-out one marked.
   *
   * Only `refs/heads` is listed: switching to a remote-tracking branch would
   * create a local branch, which is a decision the panel leaves to the
   * terminal. A name that begins with `-` is refused by the route before it
   * gets here, so every listed name is safe as a positional argument.
   *
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns the listing.
   */
  async branches(root: string, signal: AbortSignal): Promise<BranchListing> {
    const result = await this.git.run(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--count', String(BRANCH_MAX + 1),
        '--format=%(refname)%00%(HEAD)%00%(worktreepath)%00',
        'refs/heads',
      ],
      { cwd: root, signal },
    )
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) {
      throw new VcsError('internal', 'Local branches could not be read.')
    }
    const branches = []
    for (const line of result.stdout.split(/\0\r?\n/u)) {
      if (line === '') continue
      const [ref, marker, worktreePath] = line.split('\0')
      // The full ref is unambiguous even when a tag or remote branch shares
      // the short name; the menu only ever shows the part below refs/heads/.
      if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) continue
      const name = ref.slice('refs/heads/'.length)
      if (name === '') continue
      branches.push({ name, current: marker === '*', occupied: Boolean(worktreePath) })
    }
    const truncated = branches.length > BRANCH_MAX
    return { branches: truncated ? branches.slice(0, BRANCH_MAX) : branches, truncated }
  }

  /**
   * Check out one local branch without forcing anything.
   *
   * Git itself decides whether the working tree can carry over: a switch that
   * would overwrite local or untracked changes is refused, and the panel
   * reports why instead of stashing, discarding, or retrying with `--force`.
   *
   * @param root - repository root.
   * @param branch - a name already validated by the route.
   * @param signal - cancellation.
   * @returns the checked-out branch.
   */
  async switchBranch(root: string, branch: string, signal: AbortSignal): Promise<{ branch: string }> {
    const target = await requireLocalBranch(this.git, root, branch, signal)
    if (target.current) return { branch }

    const result = await this.git.run(['switch', '--no-guess', '--quiet', branch], { cwd: root, signal })
    if (result.exitCode !== 0) {
      const detail = redactDetail(result.stderr)
      // Classify from the full stderr: the diagnostic log keeps only its tail,
      // and Git's first line is where it names what blocked the switch.
      if (/would be overwritten|local changes|untracked working tree files|already checked out/iu.test(result.stderr)) {
        throw new VcsError(
          'switch-blocked',
          'Git refused to switch because local changes would be overwritten.',
          detail,
        )
      }
      throw new VcsError('switch-failed', 'The branch could not be switched.', detail)
    }
    return { branch }
  }

  /**
   * Dispatch one local or remote branch action; see `../branch-ops.js`.
   * @param root - repository root.
   * @param request - validated branch action payload.
   * @param signal - cancellation.
   * @returns the action outcome.
   */
  branchOp(root: string, request: GitBranchRequest, signal: AbortSignal): Promise<GitBranchOpResult> {
    return runGitBranchOp(this.git, root, request, signal)
  }

  /**
   * The remotes a tag can be pushed to.
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns the listing.
   */
  remotes(root: string, signal: AbortSignal): Promise<RemoteListing> {
    return listGitRemotes(this.git, root, signal)
  }

  /**
   * Dispatch one tag action; see `../tag-ops.js`.
   * @param root - repository root.
   * @param request - validated tag action payload.
   * @param signal - cancellation.
   * @returns the action outcome.
   */
  tagOp(root: string, request: GitTagRequest, signal: AbortSignal): Promise<GitTagOpResult> {
    return runGitTagOp(this.git, root, request, signal)
  }

  /**
   * Dispatch one commit action; see `../commit-ops.js`.
   * @param root - repository root.
   * @param request - validated commit action payload.
   * @param signal - cancellation.
   * @returns the action outcome.
   */
  commitOp(root: string, request: GitCommitRequest, signal: AbortSignal): Promise<GitCommitOpResult> {
    return runGitCommitOp(this.git, root, request, signal)
  }

  /**
   * Sync the checked-out branch with its upstream; see `../sync.js`.
   * @param root - repository root.
   * @param signal - cancellation.
   * @returns what moved.
   */
  async sync(root: string, signal: AbortSignal): Promise<SyncAnswer> {
    return syncGitBranch(this.git, root, signal)
  }
}
