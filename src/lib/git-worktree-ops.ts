import { basename, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { CommandResult } from './command.js'
import { canonicalDirectory } from './contain.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import type { GitRunner } from './git.js'
import { gitDirectory, hasGitOperation, redactDetail } from './git-utils.js'
import { isFullSha, sameRepoPath } from './paths.js'
import { refExists, validateRefFormat } from './ref-utils.js'
import { checkWorktreeFiles, requireAbsentDestination } from './worktree-ops.js'
import type { RecheckTarget, WorktreeChange, WorktreeCreate } from './worktree-ops.js'
import { gitCommonDirAt, parseGitWorktrees } from './worktrees.js'
import type { GitWorktree, Worktree } from './worktrees.js'

const GIT_METADATA = new Set(['.git'])

export async function gitWorktreeRegistrations(git: GitRunner, cwd: string, signal: AbortSignal): Promise<GitWorktree[]> {
  const result = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0 || !result.stdout.endsWith('\0\0')) {
    throw new VcsError('worktree-failed', 'Git worktree registrations could not be read.', redactDetail(result.stderr))
  }
  return [...parseGitWorktrees(result.stdout)]
}

export async function createGitWorktree(
  ctx: Context, git: GitRunner, root: string, common: string, request: WorktreeCreate, signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange,
): Promise<void> {
  const { mode = 'new', path, revision } = request
  if (mode === 'existing' && (request.name === undefined || revision !== undefined)) {
    throw badRequest('An existing worktree branch requires a local branch name.')
  }
  if (mode === 'detach' && request.name !== undefined) throw badRequest('A detached worktree does not take a branch name.')
  const branch = mode === 'detach' ? undefined : request.name ?? basename(path)
  const fullRef = branch === undefined ? undefined : `refs/heads/${branch}`
  if (branch !== undefined && (branch.startsWith('-') || branch === 'HEAD')) throw badRequest('Choose a valid local branch name.')

  const list = await gitWorktreeRegistrations(git, root, signal)
  if (list.some(entry => sameRepoPath(entry.path, path))) {
    throw new VcsError('worktree-exists', 'Git already has a worktree registered at this destination.')
  }
  if (fullRef !== undefined) {
    await validateRefFormat(git, root, fullRef, 'branch-invalid', 'Choose a valid local branch name.', signal)
    const exists = await refExists(git, root, fullRef, signal)
    if (mode === 'existing' && !exists) throw new VcsError('branch-invalid', 'That branch is not a local branch of this repository.')
    if (mode === 'existing' && list.some(entry => entry.branch === branch)) {
      throw new VcsError('branch-in-use', 'That branch is already checked out in a Git worktree.')
    }
    if (mode === 'new' && exists) throw new VcsError('branch-exists', 'A local branch with that name already exists.')
  }

  const base = mode === 'existing' ? fullRef! : revision ?? 'HEAD'
  const resolved = await git.run(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { cwd: root, signal })
  const oid = resolved.stdout.trim()
  if (resolved.exitCode !== 0 || resolved.lossy || !isFullSha(oid)) {
    throw new VcsError('worktree-revision-invalid', 'The worktree base must resolve to one commit.')
  }
  const args = mode === 'detach' ? ['--detach', '--', path, oid]
    : mode === 'existing' ? ['--', path, branch!] : ['-b', branch!, '--', path, oid]
  await recheck()
  await requireAbsentDestination(ctx, path, signal)
  changed()
  let result: CommandResult | undefined
  let failure: unknown
  try {
    result = await git.run(['-c', 'branch.autoSetupMerge=false', 'worktree', 'add', '--no-guess-remote', ...args], { cwd: root, signal })
  } catch (error) {
    if (signal.aborted) throw error
    failure = error
  }
  const created = (await gitWorktreeRegistrations(git, root, signal)).find(entry => sameRepoPath(entry.path, path))
  const exists = await ctx.fs.lstat(path, undefined, signal) !== undefined
  const createdDir = exists ? await gitCommonDirAt(git, path, signal) : null
  if (result?.exitCode === 0 && created !== undefined && !created.prunable && created.branch === (branch ?? null)
    && (mode === 'existing' ? created.head !== null : created.head === oid)
    && createdDir !== null && sameRepoPath(createdDir, common)) return

  if (exists || created !== undefined || (mode === 'new' && fullRef !== undefined && await refExists(git, root, fullRef, signal))) {
    throw new VcsError('worktree-partial', 'Git left a worktree directory, registration, or branch after creation failed.', redactDetail(result?.stderr ?? ''))
  }
  if (failure !== undefined) throw failure
  throw new VcsError('worktree-failed', 'Git could not create the worktree.', redactDetail(result?.stderr ?? ''))
}

export async function requireIdleGitWorktree(ctx: Context, gitDir: string, signal: AbortSignal): Promise<void> {
  if (await hasGitOperation(ctx, gitDir, signal)) throw new VcsError('worktree-dirty', 'Finish the Git operation in this checkout before continuing.')
}

export async function requireNoPrivateGitRefs(git: GitRunner, cwd: string, signal: AbortSignal): Promise<void> {
  const refs = await git.run(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/worktree', 'refs/bisect', 'refs/rewritten'], { cwd, signal })
  if (refs.exitCode !== 0 || refs.lossy || refs.stdout !== '') {
    throw new VcsError('worktree-dirty', 'This Git checkout has private refs that could be lost.')
  }
}

export async function durableGitCommit(git: GitRunner, cwd: string, oid: string, signal: AbortSignal): Promise<boolean> {
  const refs = await git.run([
    '--no-replace-objects', 'for-each-ref', `--contains=${oid}`, '--count=1', '--format=%(refname)', 'refs/heads', 'refs/tags',
  ], { cwd, signal })
  return refs.exitCode === 0 && !refs.lossy && refs.stdout !== ''
}

export async function removeGitWorktree(
  ctx: Context, git: GitRunner, root: string, tree: Worktree,
  signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange,
): Promise<void> {
  if (tree.locked) throw new VcsError('worktree-locked', 'Unlock this Git worktree before removing it.')
  const { path } = tree
  const marker = await ctx.fs.lstat(join(path, '.git'), undefined, signal)
  const gitDir = marker?.type === 'file' ? await gitDirectory(ctx, git, path, signal) : null
  if (gitDir === null) throw new VcsError('worktree-protected', 'Git worktree metadata could not be verified.')
  await requireIdleGitWorktree(ctx, gitDir, signal)
  await requireNoPrivateGitRefs(git, path, signal)
  await checkWorktreeFiles(ctx, path, GIT_METADATA, () => {}, signal)
  const status = await git.run([
    '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none',
  ], { cwd: path, signal })
  if (status.exitCode !== 0) throw new VcsError('worktree-failed', 'Git could not verify that the worktree is clean.', redactDetail(status.stderr))
  if (status.lossy || status.stdout !== '') throw new VcsError('worktree-dirty', 'This Git worktree contains changed, untracked, or ignored files.')

  const index = await git.run(['ls-files', '--stage', '-v', '-z'], { cwd: path, signal })
  if (index.lossy) throw outputTooLarge()
  if (index.exitCode !== 0) throw new VcsError('worktree-failed', 'Git could not verify the worktree index.', redactDetail(index.stderr))
  for (const entry of index.stdout.split('\0')) {
    if (/^[A-Za-z] 160000 /u.test(entry)) throw new VcsError('worktree-protected', 'This Git worktree contains a submodule.')
    if (/^[a-z] /u.test(entry) || entry.startsWith('S ')) {
      const filename = entry.slice(entry.indexOf('\t') + 1)
      if (await ctx.fs.lstat(join(path, filename), undefined, signal) !== undefined) {
        throw new VcsError('worktree-dirty', 'This Git worktree contains files hidden from status by index flags.')
      }
    }
  }

  if (tree.branch == null && (tree.head === null || !await durableGitCommit(git, root, tree.head, signal))) {
    throw new VcsError('worktree-unreferenced', 'Create a branch or tag for this detached commit before removing the worktree.')
  }
  await recheck()
  changed()
  let result: CommandResult | undefined
  let failure: unknown
  try {
    result = await git.run(['-c', 'status.showUntrackedFiles=all', '-c', 'core.fsmonitor=false', 'worktree', 'remove', '--', path], { cwd: root, signal })
  } catch (error) {
    if (signal.aborted) throw error
    failure = error
  }
  const registered = (await gitWorktreeRegistrations(git, root, signal)).some(entry => sameRepoPath(entry.path, path))
  const exists = await ctx.fs.lstat(path, undefined, signal) !== undefined
  if (result?.exitCode === 0 && !registered && !exists) return
  if (!registered || !exists || await canonicalDirectory(ctx, gitDir, signal) === null) {
    throw new VcsError('worktree-partial', 'Git only partially removed the worktree. Refresh and inspect the directory before retrying.', redactDetail(result?.stderr ?? ''))
  }
  if (failure !== undefined) throw failure
  throw new VcsError('worktree-failed', 'Git could not remove the worktree.', redactDetail(result?.stderr ?? ''))
}
