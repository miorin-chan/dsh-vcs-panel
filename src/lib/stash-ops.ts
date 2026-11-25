/**
 * Stash writes and their preflight. Git has no stash-apply abort; do not run
 * it until both the index patch and the working-tree merge are known safe.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import type { RunOptions } from './command.js'
import { outputTooLarge, StashWriteError, VcsError } from './errors.js'
import type { GitRunner } from './git.js'
import { gitDirectory, hasGitOperation, redactDetail } from './git-utils.js'
import { snapshotIndex } from './index-transaction.js'
import { isFullSha } from './paths.js'
import { commitAt, refExists } from './ref-utils.js'
import { readStashEntries, requireStash } from './stash.js'
import { STASH_PATH_MAX } from './stash-types.js'
import type { StashCheck, StashEntry, StashMode, StashPaths, StashRequest, StashResult } from './stash-types.js'
import { parsePorcelainV2 } from './status.js'

const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color']

function checkFailed(): VcsError {
  return new VcsError('internal', 'The stash could not be checked.')
}

function stashPaths(paths: string[]): StashPaths {
  const unique = [...new Set(paths)].sort()
  return { paths: unique.slice(0, STASH_PATH_MAX), pathsTruncated: unique.length > STASH_PATH_MAX }
}

async function read(git: GitRunner, args: string[], options: RunOptions): Promise<string> {
  const result = await git.run(args, options)
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('internal', 'The stash could not be checked.', redactDetail(result.stderr))
  return result.stdout
}

function nulPaths(output: string): string[] {
  if (output !== '' && !output.endsWith('\0')) throw checkFailed()
  return output.split('\0').filter(Boolean)
}

function changedPaths(git: GitRunner, revs: string[], options: RunOptions): Promise<string[]> {
  return read(git, ['diff', ...SAFE_DIFF, '--no-renames', '--name-only', '-z', ...revs, '--'], options).then(nulPaths)
}

async function unmergedPaths(git: GitRunner, options: RunOptions): Promise<string[]> {
  const paths = await read(git, ['ls-files', '--unmerged', '-z'], options).then(nulPaths)
  return paths.map(line => line.slice(line.indexOf('\t') + 1))
}

async function operationState(ctx: Context, git: GitRunner, { cwd: root, signal }: RunOptions & { signal: AbortSignal }) {
  const dir = await gitDirectory(ctx, git, root, signal)
  if (dir === null) throw checkFailed()
  const [operation, unmerged] = await Promise.all([
    hasGitOperation(ctx, dir, signal), unmergedPaths(git, { cwd: root, signal }),
  ])
  return { dir, operation: operation || unmerged.length > 0, unmerged }
}

/** Find the path itself or its first non-directory ancestor without following symlinks. */
async function worktreeObstacle(ctx: Context, path: string, root: string, signal: AbortSignal) {
  const parts = path.split('/')
  if (isAbsolute(path) || path.includes('\ufffd') || parts.some(part =>
    part === '' || part === '.' || part === '..' || (process.platform === 'win32' && /[\\:]/u.test(part)))) {
    throw checkFailed()
  }
  let prefix = ''
  for (const part of parts) {
    prefix = prefix === '' ? part : `${prefix}/${part}`
    signal.throwIfAborted()
    const entry = await ctx.fs.lstat(join(root, prefix), undefined, signal)
    if (entry === undefined) return undefined
    if (entry.type !== 'directory' || prefix === path) return { path: prefix, type: entry.type }
  }
}

/**
 * Git can reject an untracked obstruction after restoring U, and can silently
 * replace ignored files. Inspect additions in the tree Git will install, not
 * just the U tree. Tracked file/directory replacements remain legal.
 */
async function incomingObstructions(
  ctx: Context, git: GitRunner, from: string, to: string, options: RunOptions & { signal: AbortSignal },
): Promise<string[]> {
  if (from === to) return []
  const added = await changedPaths(git, ['--diff-filter=A', from, to], options)
  if (added.length === 0) return []
  const removed = new Set(await changedPaths(git, ['--diff-filter=D', from, to], options))
  const obstructions = []
  for (const path of added) {
    const existing = await worktreeObstacle(ctx, path, options.cwd, options.signal)
    if (existing === undefined || removed.has(existing.path)) continue
    if (existing.type !== 'directory') obstructions.push(existing.path)
    else obstructions.push(...await read(git, [
      'ls-files', '--others', '--directory', '--no-empty-directory', '-z', '--', `:(literal)${path}`,
    ], options).then(nulPaths))
  }
  return obstructions
}

async function withIndexCopy<T>(dir: string, signal: AbortSignal, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-vcs-stash-'))
  try {
    const index = join(temporary, 'index')
    try {
      await snapshotIndex(join(dir, 'index'), index, signal)
    } catch {
      signal.throwIfAborted()
      throw checkFailed()
    }
    return await run({ GIT_INDEX_FILE: index })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Shared by the preview and by writes after they enter the repository lock. */
export async function checkStash(
  ctx: Context, git: GitRunner, root: string, stash: StashEntry, mode: StashMode, index: boolean, signal: AbortSignal,
): Promise<StashCheck> {
  const options = { cwd: root, signal }
  const [head, { dir, operation, unmerged }] = await Promise.all([
    commitAt(git, root, 'HEAD', signal), operationState(ctx, git, options),
  ])
  const ok: StashCheck = { head, baseIsHead: head === stash.base, block: null }
  const blocked = (reason: NonNullable<StashCheck['block']>['reason'], paths: string[]): StashCheck =>
    ({ ...ok, block: { reason, ...stashPaths(paths) } })

  if (operation) return blocked('operation', unmerged)
  const unstaged = await changedPaths(git, [], options)
  if (mode === 'branch') {
    const staged = await changedPaths(git, ['--cached'], options)
    if (staged.length > 0 || unstaged.length > 0) return blocked('dirty', [...staged, ...unstaged])
  }
  if (stash.untracked !== null) {
    const paths = await read(git, ['ls-tree', '-r', '--name-only', '-z', stash.untracked], options).then(nulPaths)
    const existing = []
    for (const path of paths) {
      if (await worktreeObstacle(ctx, path, root, signal) !== undefined) existing.push(path)
    }
    if (existing.length > 0) return blocked('untracked-exists', existing)
  }
  if (mode === 'apply' && unstaged.length > 0) {
    const changed = new Set(await changedPaths(git, [stash.base, stash.sha], options))
    const paths = unstaged.filter(path => changed.has(path))
    if (paths.length > 0) return blocked('overwrite', paths)
  }

  return withIndexCopy(dir, signal, async env => {
    const scratch = { ...options, env }
    const config = ['-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false']
    const currentTree = (await read(git, [...config, 'write-tree'], scratch)).trim()
    if (!isFullSha(currentTree)) throw checkFailed()

    if (mode === 'branch') {
      const [checkout, restore] = await Promise.all([
        incomingObstructions(ctx, git, currentTree, stash.base, scratch),
        incomingObstructions(ctx, git, currentTree, stash.sha, scratch),
      ])
      return checkout.length + restore.length > 0 ? blocked('untracked-exists', [...checkout, ...restore]) : ok
    }

    if (index) {
      const patch = await read(git, [
        'diff', ...SAFE_DIFF, '--binary', '--src-prefix=a/', '--dst-prefix=b/', stash.base, stash.index, '--',
      ], options)
      if (patch !== '') {
        const result = await git.run([...config, 'apply', '--cached', '--check'], { ...scratch, stdin: patch })
        if (result.exitCode !== 0) {
          const candidates = await changedPaths(git, [stash.base, stash.index], options)
          // Only echo repository paths obtained via -z, never raw stderr.
          const paths = candidates.filter(path => result.stderr.includes(`error: ${path}: `)
            || result.stderr.includes(`error: patch failed: ${path}:`))
          return blocked('index-conflict', paths.length > 0 ? paths : candidates)
        }
      }
    }

    const result = await git.run([
      'merge-tree', '--write-tree', '--name-only', '-z', '--no-messages',
      `--merge-base=${stash.base}^{tree}`, currentTree, `${stash.sha}^{tree}`,
    ], scratch)
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new VcsError('internal', 'The stash merge could not be checked.', redactDetail(result.stderr))
    }
    const [merged, ...paths] = nulPaths(result.stdout)
    if (!isFullSha(merged)) throw checkFailed()
    if (result.exitCode === 1) return blocked('conflict', paths)

    if (unstaged.length > 0) {
      // A rename already in HEAD can redirect a stash edit to a path that
      // was not in base → W. Git can restore U even when that edit is refused.
      const changed = new Set(await changedPaths(git, [currentTree, merged], scratch))
      const overwritten = unstaged.filter(path => changed.has(path))
      if (overwritten.length > 0) return blocked('overwrite', overwritten)
    }
    const obstructions = await incomingObstructions(ctx, git, currentTree, merged, scratch)
    return obstructions.length > 0 ? blocked('untracked-exists', obstructions) : ok
  })
}

export async function runStashOp(
  ctx: Context, git: GitRunner, root: string, request: StashRequest, signal: AbortSignal,
): Promise<StashResult> {
  const options = { cwd: root, signal }
  const run = async (args: string[], failure: string) => {
    const result = await git.run(args, options)
    if (result.exitCode !== 0) throw new VcsError('stash-failed', failure, redactDetail(result.stderr))
    return result
  }
  const drop = (selector: string) => run(['stash', 'drop', '-q', selector], 'The stash could not be dropped.')

  if (request.action === 'push') {
    const { operation, unmerged } = await operationState(ctx, git, options)
    if (operation) throw new StashWriteError('stash-blocked', { reason: 'operation', ...stashPaths(unmerged) })
    const files = await read(git, ['status', '--porcelain=v2', '-z', `--untracked-files=${request.untracked ? 'normal' : 'no'}`], options)
    const empty = () => new VcsError('stash-empty', 'There are no changes to stash.')
    if (parsePorcelainV2(files).entries.length === 0) throw empty()
    const result = await run(['stash', 'push', ...(request.untracked ? ['--include-untracked'] : []),
      ...(request.message ? ['-m', request.message] : [])], 'The changes could not be stashed.')
    // Git also exits zero if an external change made the worktree clean.
    if (/^No local changes to save\s*$/u.test(result.stdout)) throw empty()
    const [stash] = await readStashEntries(git, root, signal, 1)
    if (stash === undefined) throw new VcsError('stash-failed', 'The new stash could not be read.')
    return { sha: stash.sha, selector: stash.selector }
  }

  const stash = await requireStash(git, root, request.sha, signal)
  const { sha, selector } = stash
  if (request.action === 'drop') {
    await drop(selector)
    return { sha, selector }
  }

  const check = await checkStash(ctx, git, root, stash, request.action, request.action === 'apply' && request.index, signal)
  if (check.block !== null) throw new StashWriteError('stash-blocked', check.block)

  if (request.action === 'branch') {
    const { name } = request
    const valid = await git.run(['check-ref-format', '--branch', name], options)
    // --branch recognizes @{-n} shorthand; the output must be the literal input.
    if (valid.exitCode !== 0 || valid.stdout !== `${name}\n`) {
      throw new VcsError('branch-invalid', 'That name is not a valid branch name.')
    }
    if (await refExists(git, root, `refs/heads/${name}`, signal)) {
      throw new VcsError('branch-exists', 'A branch with that name already exists.')
    }
    const latest = await requireStash(git, root, sha, signal)
    await run(['stash', 'branch', name, latest.selector], 'The stash could not be recovered on a branch.')
    return { sha, selector: latest.selector, branch: name }
  }

  const result = await git.run(['stash', 'apply', request.index ? '--index' : '--no-index', sha], options)
  if (result.exitCode !== 0) {
    const paths = await unmergedPaths(git, options)
    if (paths.length > 0) throw new StashWriteError('stash-conflict', stashPaths(paths), redactDetail(result.stderr))
    throw new VcsError('stash-failed', 'The stash could not be applied.', redactDetail(result.stderr))
  }
  const dropped = request.drop && await requireStash(git, root, sha, signal)
    .then(latest => drop(latest.selector)).then(() => true, () => false)
  return { sha, selector, dropped }
}
