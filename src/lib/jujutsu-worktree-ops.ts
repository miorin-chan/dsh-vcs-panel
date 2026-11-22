import { basename, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { CommandResult } from './command.js'
import { canonicalDirectory } from './contain.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import { GitRunner } from './git.js'
import { redactDetail } from './git-utils.js'
import { durableGitCommit, gitWorktreeGitDir, gitWorktreeRegistrations, requireIdleGitWorktree, requireNoPrivateGitRefs } from './git-worktree-ops.js'
import type { JujutsuRunner } from './jujutsu.js'
import { jjCommonDirAt, readWorkspaces, WORKSPACE_LIST } from './jujutsu-worktrees.js'
import type { JjWorkspaceRecord } from './jujutsu-worktrees.js'
import { isFullSha, sameRepoPath } from './paths.js'
import { checkWorktreeFiles, requireAbsentDestination } from './worktree-ops.js'
import type { RecheckTarget, WorktreeChange, WorktreeCreate } from './worktree-ops.js'
import { gitCommonDirAt } from './worktrees.js'
import type { Worktree } from './worktrees.js'

const JJ_METADATA = new Set(['.jj'])
const COLOCATED_METADATA = new Set(['.git', '.jj'])

async function registrations(runner: JujutsuRunner, cwd: string, signal: AbortSignal, paths = true): Promise<JjWorkspaceRecord[]> {
  const list = await readWorkspaces(runner, cwd, paths ? WORKSPACE_LIST : undefined, signal)
  if (list === null) throw new VcsError('worktree-failed', 'Jujutsu workspace registrations could not be read.')
  return list
}

export async function supportsJjWorkspaceRemove(runner: JujutsuRunner, cwd: string, signal: AbortSignal): Promise<boolean> {
  const help = await runner.run(['workspace', 'remove', '-h'], { cwd, signal })
  return help.exitCode === 0 && !help.lossy && /^Usage: jj workspace remove /mu.test(help.stdout)
}

export async function createJjWorkspace(
  ctx: Context, runner: JujutsuRunner, root: string, common: string, request: WorktreeCreate, signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange,
): Promise<void> {
  if (request.mode !== undefined) throw badRequest('Jujutsu workspaces take a parent revision instead of a Git checkout mode.')
  const { path, revision, name = basename(path) } = request
  const list = await registrations(runner, root, signal, false)
  if (list.some(entry => entry.name === name)) throw new VcsError('worktree-exists', 'A Jujutsu workspace with that name already exists.')
  let parent: string | undefined
  if (revision !== undefined) {
    const result = await runner.run(['--ignore-working-copy', '--at-op=@', 'log', '--no-graph', `--revisions=${revision}`, '-T', 'commit_id ++ "\\n"'], { cwd: root, signal })
    parent = result.stdout.trim()
    if (result.exitCode !== 0 || result.lossy || !isFullSha(parent)) {
      throw new VcsError('worktree-revision-invalid', 'The workspace parent must resolve to one commit.')
    }
  }
  const args = ['workspace', 'add', `--name=${name}`, ...(parent === undefined ? [] : [`--revision=${parent}`]), '--', path]
  await recheck()
  await requireAbsentDestination(ctx, path, signal)
  changed()
  let result: CommandResult | undefined
  let failure: unknown
  try {
    result = await runner.run(args, { cwd: root, signal })
  } catch (error) {
    if (signal.aborted) throw error
    failure = error
  }
  const after = await registrations(runner, root, signal, false)
  const exists = await ctx.fs.lstat(path, undefined, signal) !== undefined
  const created = after.some(entry => entry.name === name)
  const createdDir = exists ? await jjCommonDirAt(ctx, path, signal) : null
  if (result?.exitCode === 0 && created && createdDir !== null && sameRepoPath(createdDir, common)) {
    // Old CLI versions can confirm the named registration and store without reporting paths.
    const catalog = await readWorkspaces(runner, root, WORKSPACE_LIST, signal)
    if (catalog === null || catalog.some(entry => entry.name === name && entry.path !== null && sameRepoPath(entry.path, path))) return
  }
  if (exists || created) {
    throw new VcsError('worktree-partial', 'Jujutsu left a directory or workspace registration after creation failed.', redactDetail(result?.stderr ?? ''))
  }
  if (failure !== undefined) throw failure
  throw new VcsError('worktree-failed', 'Jujutsu could not create the workspace.', redactDetail(result?.stderr ?? ''))
}

/** Native forget and remove both unlink the Git worktree when colocated. */
async function checkColocatedWorkspace(
  ctx: Context, runner: JujutsuRunner, common: string, tree: Worktree, signal: AbortSignal,
): Promise<string | null> {
  const marker = await ctx.fs.lstat(join(tree.path, '.git'), undefined, signal)
  if (marker === undefined) return null
  const git = new GitRunner(ctx)
  const store = join(common, 'store')
  const pointerTarget = await ctx.fs.resolve(join(store, 'git_target'), { signal })
  const pointerInfo = await ctx.fs.stat(pointerTarget, signal)
  const pointer = pointerInfo?.type === 'file' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(await ctx.fs.readBytes(pointerTarget, signal, 16 * 1024)) : ''
  const gitCommon = pointer === '' || pointer.includes('\0') ? null : await canonicalDirectory(ctx, resolve(store, pointer), signal)
  const actual = marker.type === 'file' && await git.resolve(signal) !== null ? await gitCommonDirAt(git, tree.path, signal) : null
  if (actual === null || gitCommon === null || !sameRepoPath(actual, gitCommon)) {
    throw new VcsError('worktree-protected', 'This workspace contains Git metadata from another repository.')
  }
  const list = await gitWorktreeRegistrations(git, tree.path, signal)
  const checkout = list.find(entry => sameRepoPath(entry.path, tree.path) && !entry.prunable)
  const gitDir = await gitWorktreeGitDir(ctx, git, tree.path, signal)
  if (checkout === undefined || checkout.primary || gitDir === null || list.some(entry => entry.prunable)) {
    throw new VcsError('worktree-protected', 'The colocated worktree cannot be safely unlinked from Git.')
  }
  if (checkout.locked) throw new VcsError('worktree-locked', 'Unlock the colocated Git worktree before continuing.')
  await requireIdleGitWorktree(ctx, gitDir, signal)
  const opts = { cwd: tree.path, signal }
  const [staged, links] = await Promise.all([
    git.run(['diff', '--cached', '--quiet', '--no-ext-diff', '--ignore-submodules=none', '--ita-invisible-in-index', '--'], opts),
    git.run(['ls-files', '--stage', '-z'], opts),
    requireNoPrivateGitRefs(git, tree.path, signal),
  ])
  if (staged.exitCode !== 0 || links.exitCode !== 0 || links.lossy) {
    throw new VcsError('worktree-dirty', 'The colocated Git worktree has staged changes that could be lost.')
  }
  if (links.stdout.split('\0').some(entry => entry.startsWith('160000 '))) {
    throw new VcsError('worktree-protected', 'The colocated Git worktree contains a submodule.')
  }
  if (checkout.branch === null && checkout.head !== null && !await durableGitCommit(git, tree.path, checkout.head, signal)) {
    const parent = await runner.run(['--ignore-working-copy', '--at-op=@', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id ++ "\\n"'], opts)
    if (parent.exitCode !== 0 || parent.lossy || !parent.stdout.split('\n').includes(checkout.head)) {
      throw new VcsError('worktree-unreferenced', 'Create a branch or tag for the colocated detached Git commit before continuing.')
    }
  }
  return gitDir
}

async function requireSnapshottedFiles(ctx: Context, runner: JujutsuRunner, cwd: string, colocated: boolean, signal: AbortSignal): Promise<void> {
  const readOnly = ['--ignore-working-copy', '--at-op=@']
  const options = { cwd, signal }
  const [files, sparse] = await Promise.all([
    runner.run([...readOnly, 'file', 'list', '-T', 'json(path) ++ "\\n"'], options),
    runner.run([...readOnly, 'sparse', 'list'], options),
  ])
  if (files.lossy) throw outputTooLarge()
  if (files.exitCode !== 0) throw new VcsError('worktree-failed', 'Jujutsu could not read the workspace snapshot.', redactDetail(files.stderr))
  if (sparse.exitCode !== 0 || sparse.lossy || sparse.stdout.trim() !== '.') {
    throw new VcsError('worktree-unsupported', 'Use Forget for a workspace with sparse checkout patterns.')
  }
  const tracked = new Set<unknown>(files.stdout.split('\n').filter(line => line !== '').map(line => JSON.parse(line)))
  await checkWorktreeFiles(ctx, cwd, colocated ? COLOCATED_METADATA : JJ_METADATA, path => {
    if (path.includes('\ufffd') || !tracked.has(path)) {
      throw new VcsError('worktree-dirty', 'This workspace contains ignored or unsnapshotted files. Preserve those files or forget the workspace instead.')
    }
  }, signal)
}

export async function deleteJjWorkspace(
  ctx: Context, runner: JujutsuRunner, root: string, common: string, tree: Worktree, action: 'remove' | 'forget',
  signal: AbortSignal, recheck: RecheckTarget, changed: WorktreeChange,
): Promise<void> {
  const [jjDirectory, repoLink] = await Promise.all([
    ctx.fs.lstat(join(tree.path, '.jj'), undefined, signal),
    ctx.fs.lstat(join(tree.path, '.jj', 'repo'), undefined, signal),
  ])
  if (tree.name === undefined || jjDirectory?.type !== 'directory' || repoLink?.type !== 'file') {
    throw new VcsError('worktree-protected', 'The linked workspace metadata could not be verified.')
  }
  if (action === 'remove' && !await supportsJjWorkspaceRemove(runner, root, signal)) {
    throw new VcsError('worktree-unsupported', 'This Jujutsu version can forget workspaces but cannot remove them.')
  }
  const gitDir = await checkColocatedWorkspace(ctx, runner, common, tree, signal)
  if (action === 'remove') await requireSnapshottedFiles(ctx, runner, tree.path, gitDir !== null, signal)
  await recheck()
  changed()
  let result: CommandResult | undefined
  let failure: unknown
  try {
    result = await runner.run(['workspace', action, '--', tree.name], { cwd: root, signal })
  } catch (error) {
    if (signal.aborted) throw error
    failure = error
  }
  const entries = await registrations(runner, root, signal)
  const registered = entries.some(entry => entry.name === tree.name || entry.path !== null && sameRepoPath(entry.path, tree.path))
  const exists = (await ctx.fs.lstat(tree.path, undefined, signal))?.type === 'directory'
  const expectedExists = action === 'forget'
  const gitLinked = gitDir !== null && (await ctx.fs.lstat(join(tree.path, '.git'), undefined, signal) !== undefined
    || await ctx.fs.lstat(gitDir, undefined, signal) !== undefined)
  if (result?.exitCode === 0 && !registered && exists === expectedExists && !gitLinked) return
  if (!registered || !exists || gitDir !== null && await ctx.fs.lstat(join(tree.path, '.git'), undefined, signal) === undefined) {
    throw new VcsError('worktree-partial', 'Jujutsu partially changed the workspace. Refresh and inspect its registration and files before retrying.', redactDetail(result?.stderr ?? ''))
  }
  if (failure !== undefined) throw failure
  throw new VcsError('worktree-failed', 'Jujutsu could not finish the workspace operation.', redactDetail(result?.stderr ?? ''))
}
