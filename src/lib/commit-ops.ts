/**
 * Git commit operations: tag, branch, checkout, cherry-pick, revert, drop,
 * merge, rebase, and reset, all aimed at one commit.
 *
 * These are the writes behind the commit actions menu. They follow the same
 * shape as the branch actions: an operation changes one named ref or the
 * checked-out branch, a conflict is aborted before the error is reported, and
 * a refused operation leaves the repository as it was. Tagging and creating a
 * branch only add a ref (with optional checkout on branch creation); checkout
 * detaches HEAD; cherry-pick and revert add a commit; merge adds a merge or
 * fast-forwards; rebase and drop rewrite the checked-out branch; reset moves
 * it and chooses how much of the index and working tree to keep. Nothing is
 * force-pushed.
 *
 * argv is fixed strings plus values already checked by the route and by this
 * module; no value is ever read from a shell.
 */

import type { GitRunner } from './git.js'
import { badRequest, notFound, VcsError } from './errors.js'
import { redactDetail } from './git-utils.js'
import {
  abortCherryPickIfStarted,
  abortRebaseIfStarted,
  abortRevertIfStarted,
  commitAt,
  currentBranch,
  mergeRevisionIntoCurrent,
  rebaseCurrentOntoRevision,
  refExists,
  RESET_MODES,
  runAbortableOp,
  validateRefFormat,
} from './ref-utils.js'

export { RESET_MODES } from './ref-utils.js'

/** The modes a commit reset may choose. */
export type ResetMode = 'soft' | 'mixed' | 'hard'

/** The outcome of a merge operation. */
export type MergeOutcome = 'fast-forward' | 'merged' | 'up-to-date'

/** One validated commit action, aimed at one commit. */
export type GitCommitRequest =
  | { action: 'tag'; sha: string; name: string; message?: string }
  | { action: 'branch'; sha: string; name: string; checkout?: boolean }
  | { action: 'reset'; sha: string; mode: ResetMode }
  | {
    action: 'checkout' | 'cherry-pick' | 'revert' | 'drop' | 'merge' | 'rebase'
    sha: string
  }

/** The outcome of one commit action. */
export type GitCommitOpResult =
  | { tag: string; sha: string }
  | { branch: string; sha: string; checkedOut?: true }
  | { sha: string }
  | { sha: string; current: string }
  | { sha: string; current: string; result: MergeOutcome }
  | { sha: string; current: string; mode: ResetMode }

/** Whether stderr says the working tree or index blocked the command. */
function workingTreeBlocked(stderr: string): boolean {
  return /local changes|would be overwritten|untracked working tree files|uncommitted changes|index contains|unstaged changes/iu.test(stderr)
}

/**
 * Resolve one request revision to a full commit id.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - hexadecimal commit id.
 * @param signal - cancellation.
 * @returns the resolved commit id.
 */
async function requireCommit(git: GitRunner, root: string, rawSha: string, signal: AbortSignal): Promise<string> {
  const sha = await commitAt(git, root, rawSha, signal)
  if (sha === null) throw notFound('That commit is not available.')
  return sha
}

/**
 * The checked-out branch, or a refusal when HEAD is detached.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the branch name.
 */
async function requireCurrentBranch(git: GitRunner, root: string, signal: AbortSignal): Promise<string> {
  const branch = await currentBranch(git, root, signal)
  if (branch === '') throw badRequest('This action needs a checked-out branch.')
  return branch
}

/**
 * Split one `<commit> <parent>...` line into the commit and its parents.
 * @param stdout - `git rev-list --parents -n 1` output.
 * @returns the parsed line.
 */
function parseParents(stdout: string): { sha: string; parents: string[] } | null {
  const line = stdout.trim().split('\n')[0] ?? ''
  const [sha, ...parents] = line.split(/\s+/u).filter(part => part !== '')
  if (sha === undefined) return null
  return { sha, parents }
}

/**
 * Map a failed checkout to the stable error.
 * @param stderr - the command's stderr tail.
 * @returns the route error.
 */
function checkoutFailure(stderr: string): VcsError {
  if (workingTreeBlocked(stderr) || /already checked out/iu.test(stderr)) {
    return new VcsError(
      'checkout-blocked',
      'Git refused to check out the commit because local changes would be overwritten.',
      redactDetail(stderr),
    )
  }
  return new VcsError('commit-failed', 'The commit could not be checked out.', redactDetail(stderr))
}

/**
 * Map a failed work-tree operation to the stable error.
 * @param stderr - the command's stderr tail.
 * @param fallback - message for an unclassified failure.
 * @returns the route error.
 */
function workTreeFailure(stderr: string, fallback: string): VcsError {
  if (workingTreeBlocked(stderr)) {
    return new VcsError(
      'commit-blocked',
      'Git refused the operation because local changes would be overwritten or another operation is in progress.',
      redactDetail(stderr),
    )
  }
  return new VcsError('commit-failed', fallback, redactDetail(stderr))
}

/**
 * Create one tag at a commit. A message makes the tag annotated.
 * @param git - command runner.
 * @param root - repository root.
 * @param tag - the new tag name, already checked by the route.
 * @param rawSha - the commit to tag.
 * @param message - optional annotation message.
 * @param signal - cancellation.
 * @returns the tag and its commit.
 */
export async function addGitTag(
  git: GitRunner,
  root: string,
  tag: string,
  rawSha: string,
  message: string,
  signal: AbortSignal,
): Promise<{ tag: string; sha: string }> {
  await validateRefFormat(git, root, `refs/tags/${tag}`, 'tag-invalid', 'That is not a valid tag name.', signal)
  if (await refExists(git, root, `refs/tags/${tag}`, signal)) {
    throw new VcsError('tag-exists', 'A tag with that name already exists.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  // A lightweight tag has no message, so skip tag.gpgSign instead of letting
  // Git promote it to a signed tag and fail waiting for an editor.
  const args = message === ''
    ? ['tag', '--no-sign', tag, sha]
    : ['tag', '--annotate', '--message', message, tag, sha]
  const result = await git.run(args, { cwd: root, signal })
  if (result.exitCode !== 0) {
    const stderr = result.stderr
    if (/already exists/iu.test(stderr)) {
      throw new VcsError('tag-exists', 'A tag with that name already exists.', redactDetail(stderr))
    }
    throw new VcsError('tag-failed', 'The tag could not be created.', redactDetail(stderr))
  }
  return { tag, sha }
}

/**
 * Create one local branch at a commit, optionally checking it out.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - the new branch name, already checked by the route.
 * @param rawSha - the commit the branch points at.
 * @param checkout - whether to switch to the new branch.
 * @param signal - cancellation.
 * @returns the branch and its commit.
 */
export async function createGitBranch(
  git: GitRunner,
  root: string,
  branch: string,
  rawSha: string,
  checkout: boolean,
  signal: AbortSignal,
): Promise<{ branch: string; sha: string; checkedOut?: true }> {
  await validateRefFormat(git, root, `refs/heads/${branch}`, 'branch-invalid', 'That name is not a valid branch name.', signal)
  if (await refExists(git, root, `refs/heads/${branch}`, signal)) {
    throw new VcsError('branch-exists', 'A branch with that name already exists.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  if (checkout === true) {
    const result = await git.run(['switch', '--no-guess', '--quiet', '-c', branch, sha], { cwd: root, signal })
    if (result.exitCode !== 0) throw checkoutFailure(result.stderr)
    return { branch, sha, checkedOut: true }
  }
  const result = await git.run(['branch', branch, sha], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('branch-failed', 'The branch could not be created.', redactDetail(result.stderr))
  }
  return { branch, sha }
}

/**
 * Check out one commit with a detached HEAD.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to check out.
 * @param signal - cancellation.
 * @returns the checked-out commit.
 */
export async function checkoutGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string }> {
  const sha = await requireCommit(git, root, rawSha, signal)
  const result = await git.run(['switch', '--detach', '--quiet', sha], { cwd: root, signal })
  if (result.exitCode !== 0) throw checkoutFailure(result.stderr)
  return { sha }
}

/**
 * Cherry-pick one commit onto the checked-out branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to pick.
 * @param signal - cancellation.
 * @returns the picked commit and branch.
 */
export async function cherryPickGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string; current: string }> {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'CHERRY_PICK_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'Another cherry-pick is already in progress.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  await runAbortableOp(git, root, {
    stateHead: 'CHERRY_PICK_HEAD',
    preflight: false,
    args: ['cherry-pick', sha],
    abort: abortCherryPickIfStarted,
    onFailure: (result, started) => {
      if (started) {
        throw new VcsError(
          'commit-conflict',
          'The cherry-pick hit a conflict and was aborted; the branch was left unchanged.',
          redactDetail(result.stderr),
        )
      }
      throw workTreeFailure(result.stderr, 'The commit could not be cherry-picked.')
    },
  }, signal)
  return { sha, current }
}

/**
 * Revert one commit on the checked-out branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to revert.
 * @param signal - cancellation.
 * @returns the reverted commit and branch.
 */
export async function revertGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string; current: string }> {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'REVERT_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'Another revert is already in progress.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)
  await runAbortableOp(git, root, {
    stateHead: 'REVERT_HEAD',
    preflight: false,
    args: ['revert', '--no-edit', sha],
    abort: abortRevertIfStarted,
    onFailure: (result, started) => {
      if (started) {
        throw new VcsError(
          'commit-conflict',
          'The revert hit a conflict and was aborted; the branch was left unchanged.',
          redactDetail(result.stderr),
        )
      }
      throw workTreeFailure(result.stderr, 'The commit could not be reverted.')
    },
  }, signal)
  return { sha, current }
}

/**
 * Drop one commit from the checked-out branch by rebasing its descendants
 * onto its parent. The commit must be a single-parent ancestor of HEAD.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to drop.
 * @param signal - cancellation.
 * @returns the dropped commit and branch.
 */
export async function dropGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string; current: string }> {
  const current = await requireCurrentBranch(git, root, signal)
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('commit-blocked', 'A rebase is already in progress in this repository.')
  }
  const sha = await requireCommit(git, root, rawSha, signal)

  const [ancestor, parentsResult] = await Promise.all([
    git.run(['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, signal }),
    git.run(['rev-list', '--parents', '-n', '1', sha], { cwd: root, signal }),
  ])
  if (ancestor.exitCode !== 0) {
    throw new VcsError('commit-not-on-branch', 'That commit is not on the checked-out branch.')
  }
  const parsed = parseParents(parentsResult.stdout)
  if (parsed === null || parsed.parents.length !== 1) {
    throw new VcsError(
      'commit-blocked',
      'Only a commit with one parent can be dropped from the branch.',
      redactDetail(parentsResult.stderr),
    )
  }

  await runAbortableOp(git, root, {
    stateHead: 'REBASE_HEAD',
    preflight: false,
    args: ['rebase', '--onto', parsed.parents[0], sha, current],
    abort: abortRebaseIfStarted,
    onFailure: (result, started) => {
      if (started) {
        throw new VcsError(
          'commit-conflict',
          'The drop hit a conflict and was aborted; the branch was left unchanged.',
          redactDetail(result.stderr),
        )
      }
      throw workTreeFailure(result.stderr, 'The commit could not be dropped.')
    },
  }, signal)
  return { sha, current }
}

/**
 * Merge one commit into the checked-out branch.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to merge.
 * @param signal - cancellation.
 * @returns what happened.
 */
export async function mergeGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string; current: string; result: MergeOutcome }> {
  const sha = await requireCommit(git, root, rawSha, signal)
  const { current, result } = await mergeRevisionIntoCurrent(
    git,
    root,
    { targetRef: sha, targetSha: sha, noBranchMessage: 'This action needs a checked-out branch.' },
    signal,
  )
  return { sha, current, result }
}

/**
 * Rebase the checked-out branch onto one commit.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the new base commit.
 * @param signal - cancellation.
 * @returns the commit and branch.
 */
export async function rebaseGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  signal: AbortSignal,
): Promise<{ sha: string; current: string }> {
  const sha = await requireCommit(git, root, rawSha, signal)
  const { current } = await rebaseCurrentOntoRevision(
    git,
    root,
    { targetArg: sha, targetSha: sha, noBranchMessage: 'This action needs a checked-out branch.' },
    signal,
  )
  return { sha, current }
}

/**
 * Move the checked-out branch to one commit with the chosen reset mode.
 * @param git - command runner.
 * @param root - repository root.
 * @param rawSha - the commit to reset to.
 * @param mode - how much of the index and tree to reset.
 * @param signal - cancellation.
 * @returns the moved branch.
 */
export async function resetGitCommit(
  git: GitRunner,
  root: string,
  rawSha: string,
  mode: ResetMode,
  signal: AbortSignal,
): Promise<{ sha: string; current: string; mode: ResetMode }> {
  if (!RESET_MODES.has(mode)) throw badRequest('mode must be soft, mixed, or hard.')
  const current = await requireCurrentBranch(git, root, signal)
  const sha = await requireCommit(git, root, rawSha, signal)
  const result = await git.run(['reset', `--${mode}`, sha], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('commit-failed', 'The branch could not be reset.', redactDetail(result.stderr))
  }
  return { sha, current, mode }
}

/**
 * Dispatch one validated commit action.
 * @param git - command runner.
 * @param root - repository root.
 * @param request - validated request.
 * @param signal - cancellation.
 * @returns the action outcome.
 */
export function runGitCommitOp(
  git: GitRunner,
  root: string,
  request: GitCommitRequest,
  signal: AbortSignal,
): Promise<GitCommitOpResult> {
  switch (request.action) {
    case 'tag': return addGitTag(git, root, request.name, request.sha, request.message ?? '', signal)
    case 'branch': return createGitBranch(git, root, request.name, request.sha, request.checkout === true, signal)
    case 'checkout': return checkoutGitCommit(git, root, request.sha, signal)
    case 'cherry-pick': return cherryPickGitCommit(git, root, request.sha, signal)
    case 'revert': return revertGitCommit(git, root, request.sha, signal)
    case 'drop': return dropGitCommit(git, root, request.sha, signal)
    case 'merge': return mergeGitCommit(git, root, request.sha, signal)
    case 'rebase': return rebaseGitCommit(git, root, request.sha, signal)
    default: return resetGitCommit(git, root, request.sha, request.mode, signal)
  }
}
