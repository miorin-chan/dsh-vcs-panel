import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { GitRunner } from './git.js'
import { abortError, VcsError } from './errors.js'
import { isFullSha, sameRepoPath } from './paths.js'

const INDEX_LIST_MAX_BYTES = 32 * 1024 * 1024
const INDEX_FLAGS = 0x60008000 // skip-worktree, intent-to-add, assume-unchanged
const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START']
const GIT_DIRECTORY_ARGS = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']
const O_READ_INDEX = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
const TRANSACTION_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false']
const ENTRY = /^(\d{6}) ([a-f\d]+) ([0-3])\t(.*)$/su
const ENTRY_DEBUG = /  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([a-f\d]+)\n/yu

/** A Git runner scoped to one transaction's scratch index. */
export interface IndexTransactionRunner {
  run: GitRunner['run']
}

/** One index entry as semantic history compares it, without the stat cache. */
export interface IndexEntry {
  /** The tree mode, six octal digits. */
  mode: string
  /** The blob or gitlink object id. */
  oid: string
  /** The merge stage; 0 for a normal entry. */
  stage: number
  /** Process-local index flags the history preserves. */
  flags: number
}

/** The commit HEAD names, or the branch it is on. */
export interface IndexHead {
  /** The symbolic ref HEAD names, or null when detached. */
  ref: string | null
  /** The commit id HEAD resolves to, or null on an unborn branch. */
  oid: string | null
}

/** The index and HEAD state one transaction sees. */
export interface IndexState {
  /** Identifies the Git metadata directory this state was read from. */
  identity: string
  head: IndexHead
  /** Semantic entries by path, or by `path\0stage` for a conflicted entry. */
  entries: Map<string, IndexEntry>
}

/** What a validated staging run may do inside one index transaction. */
export interface IndexTransaction {
  /** The Git runner bound to the scratch index. */
  git: IndexTransactionRunner
  /** The index and HEAD state read when the transaction opened. */
  state: IndexState
  /** Whether this state may be recorded in the staging history. */
  canRecord: boolean
  /** Read the scratch index again after a write. */
  readIndex: () => Promise<Map<string, IndexEntry>>
  /** Publish the scratch index over the real one. */
  publish: () => Promise<void>
}

/** The Git metadata directories one transaction needs. */
interface IndexLocation {
  /** The per-worktree Git directory. */
  dir: string
  /** The shared Git directory. */
  common: string
  /** The index file of this worktree. */
  indexPath: string
  /** Identifies the metadata directories and their inodes. */
  identity: string
}

/**
 * The `code` of a filesystem failure, or undefined for any other error.
 * @param error - the caught failure.
 * @returns the error code, when it has one.
 */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * One stable staging-history error.
 * @param kind - which failure the caller hit.
 * @returns the route error.
 */
export function stageHistoryError(kind: 'stale' | 'unavailable' | 'busy'): VcsError {
  const messages: Readonly<Record<'stale' | 'unavailable' | 'busy', string>> = {
    stale: 'The index or HEAD changed. Refresh the working tree and try again.',
    unavailable: 'The staging history is unavailable for the current repository state.',
    busy: 'Another write is using this Git index.',
  }
  return new VcsError(`stage-history-${kind}`, messages[kind])
}

/**
 * Stat one path, treating a missing path as absent rather than an error.
 * @param path - the path to stat.
 * @returns its bigint stat, or null when it does not exist.
 */
function optionalStat(path: string): Promise<BigIntStats | null> {
  return lstat(path, { bigint: true }).catch(error => {
    if (errorCode(error) !== 'ENOENT') throw error
    return null
  })
}

/**
 * Whether two stats name the same file.
 * @param a - one stat.
 * @param b - another stat.
 * @returns true when both exist and share device and inode.
 */
function sameFile(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return a !== null && b !== null && a.ino === b.ino && a.dev === b.dev
}

/**
 * Run one command that reports a single-line answer.
 * @param git - command runner.
 * @param root - repository root.
 * @param args - command argv.
 * @param signal - cancellation.
 * @returns the answer without its trailing newline.
 */
async function onePath(git: IndexTransactionRunner, root: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await git.run(args, { cwd: root, signal, maxBytes: 64 * 1024 })
  if (result.exitCode !== 0 || result.lossy || !result.stdout.endsWith('\n')) throw stageHistoryError('unavailable')
  return result.stdout.slice(0, -1)
}

/**
 * Read the linked worktree's backlink, verifying the handle still names the
 * file that was statted.
 * @param pointer - the open backlink.
 * @param info - the stat taken before opening.
 * @returns the path the backlink names.
 */
async function readBacklink(pointer: FileHandle, info: BigIntStats): Promise<string> {
  try {
    if (!sameFile(info, await pointer.stat({ bigint: true }))) throw stageHistoryError('stale')
    return (await pointer.readFile('utf8')).replace(/\r?\n$/u, '')
  } finally {
    await pointer.close()
  }
}

/**
 * Locate this worktree's Git metadata, refusing anything that would write
 * outside a checkout or a registered linked worktree.
 * @param ctx - Host context carrying `fs`.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the metadata directories and their identity.
 */
async function indexLocation(
  ctx: Context,
  git: GitRunner,
  root: string,
  signal: AbortSignal,
): Promise<IndexLocation> {
  // A metadata path containing a newline makes the multi-value rev-parse
  // response ambiguous. Git still supports browsing such checkouts.
  const [top, dir, common, ...extra] = (await onePath(git, root, GIT_DIRECTORY_ARGS, signal)).split('\n')
  if (extra.length !== 0 || !top || !dir || !common || ![top, dir, common].every(isAbsolute)
    || !sameRepoPath(top, root)) throw stageHistoryError('unavailable')
  const indexPath = join(dir, 'index')
  if (typeof ctx.fs.processPathFromHostPath === 'function') {
    const mapped = ctx.fs.processPathFromHostPath(indexPath)
    if (mapped === undefined || !sameRepoPath(mapped, indexPath)) throw stageHistoryError('unavailable')
  }
  const [rootPath, dirPath, commonPath, adminStat, marker] = await Promise.all([
    realpath(root), realpath(dir), realpath(common), optionalStat(dir), optionalStat(join(root, '.git')),
  ])
  if (!sameRepoPath(rootPath, root) || !sameRepoPath(dirPath, dir) || !sameRepoPath(commonPath, common)
    || !adminStat?.isDirectory()) throw stageHistoryError('unavailable')
  const local = sameRepoPath(dir, join(root, '.git')) && sameRepoPath(dir, common) && marker?.isDirectory()
  if (!local) {
    // Gitfiles may point at any repository. Only a reciprocal linked worktree
    // registration authorizes writes to metadata outside the checkout.
    if (!marker?.isFile() || !sameRepoPath(dirname(dir), join(common, 'worktrees')) || !basename(dir)) {
      throw stageHistoryError('unavailable')
    }
    const backlink = join(dir, 'gitdir')
    const info = await optionalStat(backlink)
    if (!info?.isFile() || info.size > 65536n) throw stageHistoryError('unavailable')
    const pointer = await open(backlink, O_READ_INDEX)
    const registered = await readBacklink(pointer, info)
    if (registered === '' || !sameRepoPath(await realpath(resolve(dir, registered)), join(root, '.git'))) {
      throw stageHistoryError('unavailable')
    }
  }
  return { dir, common, indexPath, identity: `${dir}\0${common}\0${adminStat.dev}:${adminStat.ino}` }
}

/**
 * Read HEAD as a symbolic ref and a resolved commit.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the ref and the commit id.
 */
async function readHead(git: IndexTransactionRunner, root: string, signal: AbortSignal): Promise<IndexHead> {
  const options = { cwd: root, signal, maxBytes: 64 * 1024 }
  const [symbolic, resolved] = await Promise.all([
    git.run(['symbolic-ref', '-q', 'HEAD'], options),
    git.run(['rev-parse', '-q', '--verify', 'HEAD'], options),
  ])
  const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null
  const oid = resolved.exitCode === 0 ? resolved.stdout.trim() : null
  if (symbolic.lossy || resolved.lossy || (symbolic.exitCode !== 0 && symbolic.exitCode !== 1)
    || (resolved.exitCode !== 0 && resolved.exitCode !== 1) || (oid === null && ref === null)
    || (ref !== null && !ref.startsWith('refs/heads/')) || (oid !== null && !isFullSha(oid))) {
    throw stageHistoryError('unavailable')
  }
  return { ref, oid }
}

/**
 * Whether two HEAD reads name the same state.
 * @param a - one read.
 * @param b - another read.
 * @returns true when both name the same ref and commit.
 */
export function sameHead(a: IndexHead, b: IndexHead): boolean {
  return a.ref === b.ref && a.oid === b.oid
}

/**
 * Fingerprint the in-progress operations of one Git directory.
 * @param dir - the per-worktree Git directory.
 * @returns a string that changes whenever one operation starts or ends.
 */
async function operationState(dir: string): Promise<string> {
  const markers = await Promise.all(OPERATIONS.map(name => optionalStat(join(dir, name))))
  return markers.map(info => info === null ? '' : `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`).join(';')
}

const NO_OPERATION = ';'.repeat(OPERATIONS.length - 1)

/**
 * Bind a Git runner to the transaction's scratch index.
 * @param git - the backend runner.
 * @param root - repository root.
 * @param location - the metadata directories the transaction writes.
 * @param indexPath - the scratch index file.
 * @returns the bound runner.
 */
function transactionGit(
  git: GitRunner,
  root: string,
  { dir, common }: IndexLocation,
  indexPath: string,
): IndexTransactionRunner {
  return {
    run: (args, options) => git.run([...TRANSACTION_CONFIG, ...args], {
      ...options,
      cwd: root,
      env: {
        GIT_DIR: dir,
        GIT_COMMON_DIR: common,
        GIT_WORK_TREE: root,
        GIT_INDEX_FILE: indexPath,
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
    }),
  }
}

/**
 * Read semantic entries, excluding the stat cache and process-local flags.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @param staging - whether conflicted entries may be listed.
 * @returns the entries by key.
 */
async function readIndex(
  git: IndexTransactionRunner,
  root: string,
  signal: AbortSignal,
  staging = false,
): Promise<Map<string, IndexEntry>> {
  const result = await git.run(['ls-files', '--stage', '--debug', '--sparse', '-z'], {
    cwd: root, signal, maxBytes: INDEX_LIST_MAX_BYTES,
  })
  if (result.exitCode !== 0 || result.lossy) throw stageHistoryError('unavailable')
  const entries = new Map<string, IndexEntry>()
  const debug = new RegExp(ENTRY_DEBUG)
  for (let offset = 0; offset < result.stdout.length;) {
    const end = result.stdout.indexOf('\0', offset)
    if (end < 0) throw stageHistoryError('unavailable')
    const match = ENTRY.exec(result.stdout.slice(offset, end))
    debug.lastIndex = end + 1
    const info = debug.exec(result.stdout)
    if (match === null || info === null || !isFullSha(match[2]) || match[4].includes('\uFFFD')) {
      throw stageHistoryError('unavailable')
    }
    const [, mode, oid, stage, path] = match
    const key = stage === '0' ? path : `${path}\0${stage}`
    if ((!staging && stage !== '0') || entries.has(key) || mode === '040000') throw stageHistoryError('unavailable')
    entries.set(key, { mode, oid, stage: Number(stage), flags: Number.parseInt(info[1], 16) & INDEX_FLAGS })
    offset = debug.lastIndex
  }
  return entries
}

/**
 * Whether the entries include a conflicted path.
 * @param entries - the index entries.
 * @returns true when any entry is at a merge stage.
 */
function hasConflicts(entries: Map<string, IndexEntry>): boolean {
  for (const entry of entries.values()) {
    if (entry.stage !== 0) return true
  }
  return false
}

/**
 * Compare before/after a separate Git command. These observations never
 * authorize publication.
 * @param ctx - Host context carrying `fs`.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the state the index and HEAD are in.
 */
export async function historyState(
  ctx: Context,
  git: GitRunner,
  root: string,
  signal: AbortSignal,
): Promise<IndexState> {
  const location = await indexLocation(ctx, git, root, signal)
  const { indexPath, identity } = location
  const info = await optionalStat(indexPath)
  if (info !== null && !info.isFile()) throw stageHistoryError('unavailable')
  const readGit = transactionGit(git, root, location, indexPath)
  const [head, entries] = await Promise.all([readHead(readGit, root, signal), readIndex(readGit, root, signal)])
  return { identity, head, entries }
}

/**
 * Copy one open file into another, reporting cancellation.
 * @param source - the open source file.
 * @param destination - the open destination file.
 * @param signal - cancellation.
 */
async function copyIndex(source: FileHandle, destination: FileHandle, signal: AbortSignal): Promise<void> {
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  while (true) {
    if (signal.aborted) throw abortError()
    const { bytesRead } = await source.read(buffer, 0, buffer.length)
    if (bytesRead === 0) return
    let written = 0
    while (written < bytesRead) {
      const { bytesWritten } = await destination.write(buffer, written, bytesRead - written)
      if (bytesWritten === 0) throw stageHistoryError('unavailable')
      written += bytesWritten
    }
  }
}

// Preserve a conservative index timestamp so copying a file never turns a
// racy worktree stat entry into one Git would consider safely older.
async function preserveIndexTimestamp(file: FileHandle, sourceStat: BigIntStats): Promise<void> {
  const mtime = Math.floor(Number(sourceStat.mtimeNs) / 1e9)
  await file.utimes(mtime, mtime)
}

/**
 * Snapshot the index into a scratch file.
 * @param indexPath - the real index file.
 * @param scratch - the scratch file to write.
 * @param signal - cancellation.
 * @returns the stat of the real index, or null when it does not exist yet.
 */
export async function snapshotIndex(
  indexPath: string,
  scratch: string,
  signal: AbortSignal,
): Promise<BigIntStats | null> {
  const sourceStat = await optionalStat(indexPath)
  if (sourceStat === null) return null
  if (!sourceStat.isFile()) throw stageHistoryError('unavailable')
  const source = await open(indexPath, O_READ_INDEX)
  try {
    if (!sameFile(sourceStat, await source.stat({ bigint: true }))) throw stageHistoryError('stale')
    const destination = await open(scratch, 'wx', 0o600)
    try {
      await copyIndex(source, destination, signal)
      await preserveIndexTimestamp(destination, sourceStat)
    } finally {
      await destination.close()
    }
    return sourceStat
  } finally {
    await source.close()
  }
}

/**
 * Whether the index file is byte-for-byte the state the transaction saw.
 * @param before - the stat taken before the transaction.
 * @param after - the stat taken before publication.
 * @returns true when both stats describe the same unmodified file.
 */
function unmodifiedIndex(before: BigIntStats | null, after: BigIntStats | null): boolean {
  if (before === null || after === null) return before === after
  return sameFile(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

/**
 * Remove one path, ignoring a path that is already absent.
 * @param path - the path to remove.
 * @param remove - the remover; `unlink` unless a directory is removed.
 */
async function removeIfPresent(
  path: string,
  remove: (path: string) => Promise<void> = unlink,
): Promise<void> {
  try {
    await remove(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

/**
 * Hold Git's native index lock across snapshot, validation, scratch Git writes
 * and publication.
 *
 * @param ctx - Host context carrying `fs` and `logger`.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @param run - the work to do inside the transaction.
 * @param options - whether a conflicted index may be used.
 * @returns whatever `run` returns.
 */
export async function withIndexTransaction<T>(
  ctx: Context,
  git: GitRunner,
  root: string,
  signal: AbortSignal,
  run: (transaction: IndexTransaction) => Promise<T>,
  { staging = false }: { staging?: boolean } = {},
): Promise<T> {
  let directory: string | undefined
  let scratch: string | undefined
  let lockPath: string | undefined
  let lock: FileHandle | undefined
  let lockStat: BigIntStats | undefined
  let published = false
  try {
    const location = await indexLocation(ctx, git, root, signal)
    const { dir, indexPath, identity } = location
    const lockFilePath = `${indexPath}.lock`
    lockPath = lockFilePath
    if (signal.aborted) throw abortError()
    let opened: FileHandle
    try {
      opened = await open(lockFilePath, 'wx', 0o666)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw stageHistoryError('busy')
      throw error
    }
    lock = opened
    const lockHandle = opened
    const lockInfo = await lockHandle.stat({ bigint: true })
    lockStat = lockInfo
    if ((await indexLocation(ctx, git, root, signal)).identity !== identity) throw stageHistoryError('stale')
    const operation = await operationState(dir)
    if (!staging && operation !== NO_OPERATION) throw stageHistoryError('unavailable')
    const transactionDirectory = await mkdtemp(join(dir, 'dsh-vcs-index-'))
    directory = transactionDirectory
    const scratchIndex = join(transactionDirectory, 'index')
    scratch = scratchIndex
    const sourceStat = await snapshotIndex(indexPath, scratchIndex, signal)
    const scratchGit = transactionGit(git, root, location, scratchIndex)
    const [head, entries] = await Promise.all([
      readHead(scratchGit, root, signal), readIndex(scratchGit, root, signal, staging),
    ])
    const state: IndexState = { identity, head, entries }
    const canRecord = operation === NO_OPERATION && !hasConflicts(entries)
    const publish = async (): Promise<void> => {
      if (sourceStat !== null) await lockHandle.chmod(Number(sourceStat.mode & 0o777n))
      const source = await open(scratchIndex, O_READ_INDEX)
      try {
        await copyIndex(source, lockHandle, signal)
        await preserveIndexTimestamp(lockHandle, await source.stat({ bigint: true }))
      } finally {
        await source.close()
      }
      await lockHandle.sync()
      await lockHandle.close()
      lock = undefined
      if ((await indexLocation(ctx, git, root, signal)).identity !== identity
        || !sameHead(head, await readHead(scratchGit, root, signal))
        || await operationState(dir) !== operation
        || !unmodifiedIndex(sourceStat, await optionalStat(indexPath))
        || !sameFile(lockInfo, await optionalStat(lockFilePath))) throw stageHistoryError('stale')
      if (signal.aborted) throw abortError()
      await rename(lockFilePath, indexPath)
      published = true
    }
    return await run({
      git: scratchGit,
      state,
      canRecord,
      readIndex: () => readIndex(scratchGit, root, signal, staging),
      publish,
    })
  } catch (error) {
    if (signal.aborted || error instanceof VcsError) throw error
    throw stageHistoryError('unavailable')
  } finally {
    // A cleanup error must never turn a published operation into a reported failure.
    const cleanup = async (action: () => Promise<void>, description: string): Promise<void> => {
      try {
        await action()
      } catch {
        try { ctx.logger?.warn?.(`dsh-vcs-panel: could not clean up ${description}`) } catch {}
      }
    }
    const currentLock = lock
    if (currentLock !== undefined) await cleanup(() => currentLock.close(), 'the index lock handle')
    const currentLockStat = lockStat
    const currentLockPath = lockPath
    if (currentLockStat !== undefined && currentLockPath !== undefined && !published) {
      await cleanup(async () => {
        if (sameFile(currentLockStat, await optionalStat(currentLockPath))) await removeIfPresent(currentLockPath)
      }, 'the index lock')
    }
    const currentDirectory = directory
    const currentScratch = scratch
    if (currentDirectory !== undefined && currentScratch !== undefined) {
      await cleanup(async () => {
        await removeIfPresent(`${currentScratch}.lock`)
        await removeIfPresent(currentScratch)
        await removeIfPresent(currentDirectory, rmdir)
      }, 'the scratch index')
    }
  }
}
