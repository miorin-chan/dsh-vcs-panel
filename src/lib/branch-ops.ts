/**
 * Git branch operations for local and remote-tracking branches.
 *
 * Local branches can be renamed, deleted, merged, rebased, or pushed. A remote
 * branch can be checked out as a tracking local branch, deleted on its remote,
 * merged into the current branch, or fetched and merged into it. Each operation
 * changes exactly the ref the menu names (and, for a remote checkout, the new
 * local branch) and leaves every other ref alone. Push and remote delete never
 * force, and a conflicting merge or rebase is aborted before the error is
 * reported, so a refused operation leaves the repository as it was.
 *
 * argv is fixed strings plus values already validated by the route and checked
 * against the local branch list or split from a remote-tracking ref; no value
 * is ever read from a shell.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import type { GitRunner } from './git.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import { readBranchUpstream, redactDetail, remoteNames, runPorcelainPush } from './git-utils.js'
import {
  commitAt,
  mergeRevisionIntoCurrent,
  rebaseCurrentOntoRevision,
  refExists,
  requireLocalBranch,
  validateRefFormat,
} from './ref-utils.js'

/** One validated local or remote-tracking branch action. */
export type GitBranchRequest =
  | { action: 'rename'; branch: string; name: string }
  | { action: 'delete'; branch: string; force?: boolean }
  | { action: 'checkout-remote'; branch: string; local: string }
  | {
    action: 'merge' | 'rebase' | 'delete-remote' | 'merge-remote' | 'pull-remote' | 'push'
    branch: string
  }

/** The outcome of one branch action. */
export type GitBranchOpResult =
  | { from: string; branch: string }
  | { branch: string }
  | { branch: string; current: string; result: string }
  | { branch: string; local: string }
  | { branch: string; current: string }
  | { branch: string; upstream: string; pushed: boolean }

/** One remote-tracking ref split into its remote, branch, and full ref name. */
interface RemoteBranch {
  /** The configured remote the ref belongs to. */
  remote: string
  /** The branch name on that remote. */
  branch: string
  /** The full `refs/remotes/...` ref name. */
  full: string
  /** The short `remote/branch` name the menu showed. */
  name: string
}

/** A missing or symbolic remote-tracking ref is not a branch this menu can act on. */
function remoteMissing(): VcsError {
  return new VcsError('remote-branch-missing', 'That remote branch is no longer available.')
}

/**
 * Resolve one remote-tracking ref to its configured remote and branch name.
 *
 * The short name is ambiguous when a remote name contains slashes, so the
 * configured remotes are matched longest-first and the exact tracking ref must
 * be a real ref, not the symbolic `<remote>/HEAD`.
 *
 * @param git - command runner.
 * @param root - repository root.
 * @param ref - the `remote/branch` short ref, validated by the route.
 * @param signal - cancellation.
 * @returns the split ref.
 */
async function resolveRemoteBranch(
  git: GitRunner,
  root: string,
  ref: string,
  signal: AbortSignal,
): Promise<RemoteBranch> {
  const remotes = await remoteNames(git, root, signal)
  const remote = remotes.find((name) => {
    if (!ref.startsWith(`${name}/`)) return false
    const rest = ref.slice(name.length + 1)
    return rest !== '' && rest !== 'HEAD'
  })
  if (remote === undefined) throw remoteMissing()
  const branch = ref.slice(remote.length + 1)

  const full = `refs/remotes/${ref}`
  const listed = await git.run(
    ['for-each-ref', '--format=%(refname)%00%(symref)', full],
    { cwd: root, signal },
  )
  if (listed.lossy) throw outputTooLarge()
  if (listed.exitCode !== 0) {
    throw new VcsError('internal', 'The remote branch could not be read.')
  }
  const line = listed.stdout.split('\n').find(entry => entry.split(String.fromCharCode(0))[0] === full)
  if (line === undefined) throw remoteMissing()
  const symref = line.split(String.fromCharCode(0))[1] ?? ''
  if (symref !== '') throw remoteMissing()
  return { remote, branch, full, name: ref }
}

/**
 * Classify a failed branch command into one stable error.
 * @param stderr - the command's stderr tail.
 * @param fallback - message for an unclassified failure.
 * @param context - whether the command was a delete.
 * @returns the route error.
 */
function branchFailure(stderr: string, fallback: string, { deletion = false }: { deletion?: boolean } = {}): VcsError {
  if (deletion && /not fully merged/iu.test(stderr)) {
    return new VcsError(
      'branch-unmerged',
      'This branch is not fully merged. Delete it anyway to remove its commits.',
      redactDetail(stderr),
    )
  }
  if (deletion && /checked out at/iu.test(stderr)) {
    return new VcsError(
      'branch-in-use',
      'This branch is checked out and cannot be deleted.',
      redactDetail(stderr),
    )
  }
  if (/already exists/iu.test(stderr)) {
    return new VcsError('branch-exists', 'A branch with that name already exists.', redactDetail(stderr))
  }
  if (/not a valid branch name|invalid branch name/iu.test(stderr)) {
    return new VcsError('branch-invalid', 'That name is not a valid branch name.', redactDetail(stderr))
  }
  return new VcsError('branch-failed', fallback, redactDetail(stderr))
}

/**
 * Rename one local branch, preserving its upstream configuration.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the existing local branch.
 * @param name - the new name, validated by the route.
 * @param signal - cancellation.
 * @returns the two names.
 */
export async function renameGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  name: string,
  signal: AbortSignal,
): Promise<{ from: string; branch: string }> {
  await requireLocalBranch(git, root, branch, signal)
  if (branch === name) return { from: branch, branch }
  await validateRefFormat(
    git,
    root,
    `refs/heads/${name}`,
    'branch-invalid',
    'That name is not a valid branch name.',
    signal,
  )
  if (await refExists(git, root, `refs/heads/${name}`, signal)) {
    throw new VcsError('branch-exists', 'A branch with that name already exists.')
  }
  const result = await git.run(['branch', '-m', branch, name], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw branchFailure(result.stderr, 'The branch could not be renamed.')
  }
  return { from: branch, branch: name }
}

/**
 * Delete one local branch. `force` is only reached after the confirmation
 * dialog has shown that the branch is not fully merged.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the local branch.
 * @param force - delete even when Git would keep an unmerged branch.
 * @param signal - cancellation.
 * @returns the deleted branch.
 */
export async function deleteGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  force: boolean,
  signal: AbortSignal,
): Promise<{ branch: string }> {
  const target = await requireLocalBranch(git, root, branch, signal)
  if (target.current) {
    throw new VcsError('branch-in-use', 'The checked-out branch cannot be deleted.')
  }
  const result = await git.run(['branch', force ? '-D' : '-d', branch], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw branchFailure(result.stderr, 'The branch could not be deleted.', { deletion: true })
  }
  return { branch }
}

/**
 * Merge one local branch into the checked-out branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the source branch.
 * @param signal - cancellation.
 * @returns what happened.
 */
export async function mergeGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  signal: AbortSignal,
): Promise<{ branch: string; current: string; result: string }> {
  await requireLocalBranch(git, root, branch, signal)
  const { current, result } = await mergeRevisionIntoCurrent(
    git,
    root,
    { targetRef: `refs/heads/${branch}`, allowSelfBranch: branch },
    signal,
  )
  return { branch, current, result }
}

/**
 * Merge one remote-tracking branch into the checked-out branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param ref - the `remote/branch` short ref.
 * @param signal - cancellation.
 * @returns what happened.
 */
export async function mergeGitRemoteBranch(
  git: GitRunner,
  root: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ branch: string; current: string; result: string }> {
  const target = await resolveRemoteBranch(git, root, ref, signal)
  const { current, result } = await mergeRevisionIntoCurrent(
    git,
    root,
    { targetRef: target.full },
    signal,
  )
  return { branch: target.name, current, result }
}

/**
 * Pull one remote-tracking branch into the checked-out branch: fetch that
 * branch into its tracking ref, then merge it. A merge conflict is aborted;
 * a fetch failure changes no local ref.
 * @param git - command runner.
 * @param root - repository root.
 * @param ref - the `remote/branch` short ref.
 * @param signal - cancellation.
 * @returns what happened.
 */
export async function pullGitRemoteBranch(
  git: GitRunner,
  root: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ branch: string; current: string; result: string }> {
  const target = await resolveRemoteBranch(git, root, ref, signal)
  const fetched = await git.run(
    ['fetch', '--quiet', target.remote, `+refs/heads/${target.branch}:refs/remotes/${target.remote}/${target.branch}`],
    { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
  )
  if (fetched.exitCode !== 0) {
    throw new VcsError(
      'remote-failed',
      'The remote branch could not be fetched.',
      redactDetail(fetched.stderr),
    )
  }
  const { current, result } = await mergeRevisionIntoCurrent(
    git,
    root,
    { targetRef: target.full },
    signal,
  )
  return { branch: target.name, current, result }
}

/**
 * Check out a remote-tracking branch as a new local branch that tracks it.
 * @param git - command runner.
 * @param root - repository root.
 * @param ref - the `remote/branch` short ref.
 * @param local - the new local branch name.
 * @param signal - cancellation.
 * @returns the remote ref and local branch.
 */
export async function checkoutGitRemoteBranch(
  git: GitRunner,
  root: string,
  ref: string,
  local: string,
  signal: AbortSignal,
): Promise<{ branch: string; local: string }> {
  const target = await resolveRemoteBranch(git, root, ref, signal)
  await validateRefFormat(
    git,
    root,
    `refs/heads/${local}`,
    'branch-invalid',
    'That name is not a valid branch name.',
    signal,
  )
  if (await refExists(git, root, `refs/heads/${local}`, signal)) {
    throw new VcsError('branch-exists', 'A branch with that name already exists.')
  }

  const result = await git.run(
    ['switch', '--no-guess', '--quiet', '--track', '-c', local, target.full],
    { cwd: root, signal },
  )
  if (result.exitCode !== 0) {
    const detail = redactDetail(result.stderr)
    // Classify from the full stderr: the diagnostic log keeps only its tail,
    // and Git's first line is where it names what blocked the switch.
    if (/would be overwritten|local changes|untracked working tree files|already checked out/iu.test(result.stderr)) {
      throw new VcsError(
        'switch-blocked',
        'Git refused to check out the branch because local changes would be overwritten.',
        detail,
      )
    }
    if (/already exists/iu.test(result.stderr)) {
      throw new VcsError('branch-exists', 'A branch with that name already exists.', detail)
    }
    if (/not a valid branch name/iu.test(result.stderr)) {
      throw new VcsError('branch-invalid', 'That name is not a valid branch name.', detail)
    }
    throw new VcsError('switch-failed', 'The branch could not be checked out.', detail)
  }
  return { branch: target.name, local }
}

/**
 * Delete one remote-tracking branch on its remote.
 *
 * The remote-tracking ref is removed after the remote accepts the deletion so
 * the panel stops offering the branch; local branches are untouched.
 *
 * @param git - command runner.
 * @param root - repository root.
 * @param ref - the `remote/branch` short ref.
 * @param signal - cancellation.
 * @returns the deleted remote ref.
 */
export async function deleteGitRemoteBranch(
  git: GitRunner,
  root: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ branch: string }> {
  const target = await resolveRemoteBranch(git, root, ref, signal)
  await runPorcelainPush(git, root, {
    remote: target.remote,
    args: ['--delete', `refs/heads/${target.branch}`],
    errorMessage: 'The remote did not accept the deletion.',
  }, signal)
  // The remote accepted the deletion; a stale tracking ref would keep showing
  // a branch that no longer exists. A missing ref here is already correct.
  await git.run(['update-ref', '-d', target.full], { cwd: root, signal })
  return { branch: target.name }
}

/**
 * Rebase the checked-out branch onto another local branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the new base.
 * @param signal - cancellation.
 * @returns the branch and its new base.
 */
export async function rebaseGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  signal: AbortSignal,
): Promise<{ branch: string; current: string }> {
  await requireLocalBranch(git, root, branch, signal)
  const { current } = await rebaseCurrentOntoRevision(
    git,
    root,
    { targetArg: branch, allowSelfBranch: branch },
    signal,
  )
  return { branch, current }
}

/**
 * Push one local branch to its configured upstream. Unlike sync this does not
 * fetch or fast-forward: the menu action only sends the branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the local branch.
 * @param signal - cancellation.
 * @returns where it went.
 */
export async function pushGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  signal: AbortSignal,
): Promise<{ branch: string; upstream: string; pushed: boolean }> {
  await requireLocalBranch(git, root, branch, signal)
  const tip = await commitAt(git, root, `refs/heads/${branch}`, signal)
  if (tip === null) throw badRequest('The branch has no commits to push.')

  const { remote, merge } = await readBranchUpstream(git, root, branch, signal, {
    allowLocal: false,
    missingMessage: 'This branch has no upstream to push to.',
  })
  const { pushed } = await runPorcelainPush(git, root, {
    remote,
    args: [`refs/heads/${branch}:${merge}`],
  }, signal)
  return {
    branch,
    upstream: `${remote}/${merge.slice('refs/heads/'.length)}`,
    pushed,
  }
}

/**
 * Dispatch one validated local or remote branch action.
 * @param git - command runner.
 * @param root - repository root.
 * @param request - validated request.
 * @param signal - cancellation.
 * @returns the action outcome.
 */
export function runGitBranchOp(
  git: GitRunner,
  root: string,
  request: GitBranchRequest,
  signal: AbortSignal,
): Promise<GitBranchOpResult> {
  switch (request.action) {
    case 'rename': return renameGitBranch(git, root, request.branch, request.name, signal)
    case 'delete': return deleteGitBranch(git, root, request.branch, request.force === true, signal)
    case 'merge': return mergeGitBranch(git, root, request.branch, signal)
    case 'rebase': return rebaseGitBranch(git, root, request.branch, signal)
    case 'checkout-remote': return checkoutGitRemoteBranch(git, root, request.branch, request.local, signal)
    case 'delete-remote': return deleteGitRemoteBranch(git, root, request.branch, signal)
    case 'merge-remote': return mergeGitRemoteBranch(git, root, request.branch, signal)
    case 'pull-remote': return pullGitRemoteBranch(git, root, request.branch, signal)
    default: return pushGitBranch(git, root, request.branch, signal)
  }
}
