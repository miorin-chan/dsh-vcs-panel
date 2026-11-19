import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

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

export function stageHistoryError(kind) {
  const messages = {
    stale: 'The index or HEAD changed. Refresh the working tree and try again.',
    unavailable: 'The staging history is unavailable for the current repository state.',
    busy: 'Another write is using this Git index.',
  }
  return new VcsError(`stage-history-${kind}`, messages[kind])
}

function optionalStat(path) {
  return lstat(path, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
}

function sameFile(a, b) {
  return a !== null && b !== null && a.ino === b.ino && a.dev === b.dev
}

async function onePath(git, root, args, signal) {
  const result = await git.run(args, { cwd: root, signal, maxBytes: 64 * 1024 })
  if (result.exitCode !== 0 || result.lossy || !result.stdout.endsWith('\n')) throw stageHistoryError('unavailable')
  return result.stdout.slice(0, -1)
}

async function indexLocation(ctx, git, root, signal) {
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
    let registered
    try {
      if (!sameFile(info, await pointer.stat({ bigint: true }))) throw stageHistoryError('stale')
      registered = (await pointer.readFile('utf8')).replace(/\r?\n$/u, '')
    } finally {
      await pointer.close()
    }
    if (registered === '' || !sameRepoPath(await realpath(resolve(dir, registered)), join(root, '.git'))) {
      throw stageHistoryError('unavailable')
    }
  }
  return { dir, common, indexPath, identity: `${dir}\0${common}\0${adminStat.dev}:${adminStat.ino}` }
}

async function readHead(git, root, signal) {
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

export function sameHead(a, b) {
  return a.ref === b.ref && a.oid === b.oid
}

async function operationState(dir) {
  const markers = await Promise.all(OPERATIONS.map(name => optionalStat(join(dir, name))))
  return markers.map(info => info === null ? '' : `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`).join(';')
}

const NO_OPERATION = ';'.repeat(OPERATIONS.length - 1)

function transactionGit(git, root, { dir, common }, indexPath) {
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

/** Read semantic entries, excluding the stat cache and process-local flags. */
async function readIndex(git, root, signal, staging = false) {
  const result = await git.run(['ls-files', '--stage', '--debug', '--sparse', '-z'], {
    cwd: root, signal, maxBytes: INDEX_LIST_MAX_BYTES,
  })
  if (result.exitCode !== 0 || result.lossy) throw stageHistoryError('unavailable')
  const entries = new Map()
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

function hasConflicts(entries) {
  for (const entry of entries.values()) {
    if (entry.stage !== 0) return true
  }
  return false
}

/** Compare before/after a separate Git command. These observations never authorize publication. */
export async function historyState(ctx, git, root, signal) {
  const location = await indexLocation(ctx, git, root, signal)
  const { indexPath, identity } = location
  const info = await optionalStat(indexPath)
  if (info !== null && !info.isFile()) throw stageHistoryError('unavailable')
  const readGit = transactionGit(git, root, location, indexPath)
  const [head, entries] = await Promise.all([readHead(readGit, root, signal), readIndex(readGit, root, signal)])
  return { identity, head, entries }
}

async function copyIndex(source, destination, signal) {
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  while (true) {
    if (signal?.aborted) throw abortError()
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
async function preserveIndexTimestamp(file, sourceStat) {
  const mtime = Math.floor(Number(sourceStat.mtimeNs) / 1e9)
  await file.utimes(mtime, mtime)
}

async function snapshotIndex(indexPath, scratch, signal) {
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

function unmodifiedIndex(before, after) {
  if (before === null) return after === null
  return sameFile(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

async function removeIfPresent(path, remove = unlink) {
  try {
    await remove(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** Hold Git's native index lock across snapshot, validation, scratch Git writes and publication. */
export async function withIndexTransaction(ctx, git, root, signal, run, { staging = false } = {}) {
  let directory
  let scratch
  let lockPath
  let lock
  let lockStat
  let published = false
  try {
    const location = await indexLocation(ctx, git, root, signal)
    const { dir, indexPath, identity } = location
    lockPath = `${indexPath}.lock`
    if (signal?.aborted) throw abortError()
    try {
      lock = await open(lockPath, 'wx', 0o666)
    } catch (error) {
      if (error.code === 'EEXIST') throw stageHistoryError('busy')
      throw error
    }
    lockStat = await lock.stat({ bigint: true })
    if ((await indexLocation(ctx, git, root, signal)).identity !== identity) throw stageHistoryError('stale')
    const operation = await operationState(dir)
    if (!staging && operation !== NO_OPERATION) throw stageHistoryError('unavailable')
    directory = await mkdtemp(join(dir, 'dsh-vcs-index-'))
    scratch = join(directory, 'index')
    const sourceStat = await snapshotIndex(indexPath, scratch, signal)
    const scratchGit = transactionGit(git, root, location, scratch)
    const [head, entries] = await Promise.all([
      readHead(scratchGit, root, signal), readIndex(scratchGit, root, signal, staging),
    ])
    const state = { identity, head, entries }
    const canRecord = operation === NO_OPERATION && !hasConflicts(entries)
    const publish = async () => {
      if (sourceStat !== null) await lock.chmod(Number(sourceStat.mode & 0o777n))
      const source = await open(scratch, O_READ_INDEX)
      try {
        await copyIndex(source, lock, signal)
        await preserveIndexTimestamp(lock, await source.stat({ bigint: true }))
      } finally {
        await source.close()
      }
      await lock.sync()
      await lock.close()
      lock = undefined
      if ((await indexLocation(ctx, git, root, signal)).identity !== identity
        || !sameHead(head, await readHead(scratchGit, root, signal))
        || await operationState(dir) !== operation
        || !unmodifiedIndex(sourceStat, await optionalStat(indexPath))
        || !sameFile(lockStat, await optionalStat(lockPath))) throw stageHistoryError('stale')
      if (signal?.aborted) throw abortError()
      await rename(lockPath, indexPath)
      published = true
    }
    return await run({ git: scratchGit, state, canRecord, readIndex: () => readIndex(scratchGit, root, signal, staging), publish })
  } catch (error) {
    if (signal?.aborted || error instanceof VcsError) throw error
    throw stageHistoryError('unavailable')
  } finally {
    // A cleanup error must never turn a published operation into a reported failure.
    const cleanup = async (action, description) => {
      try {
        await action()
      } catch {
        try { ctx.logger?.warn?.(`dsh-vcs-panel: could not clean up ${description}`) } catch {}
      }
    }
    if (lock !== undefined) await cleanup(() => lock.close(), 'the index lock handle')
    if (lockStat !== undefined && !published) await cleanup(async () => {
      if (sameFile(lockStat, await optionalStat(lockPath))) await removeIfPresent(lockPath)
    }, 'the index lock')
    if (directory !== undefined) await cleanup(async () => {
      await removeIfPresent(`${scratch}.lock`)
      await removeIfPresent(scratch)
      await removeIfPresent(directory, rmdir)
    }, 'the scratch index')
  }
}
