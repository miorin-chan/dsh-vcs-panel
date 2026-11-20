/**
 * Ref and worktree-operation helpers shared by the Git write operations.
 *
 * These answer the checks every write runs first (which branch is checked out,
 * whether a ref exists or is valid, whether a revision resolves to a commit)
 * and run abortable worktree operations so a failed merge, rebase,
 * cherry-pick, or revert never touches an unrelated in-progress operation.
 */

import type { CommandResult } from './command.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import type { VcsErrorCode } from './errors.js'
import type { GitRunner } from './git.js'
import { redactDetail } from './git-utils.js'

/** Reset modes a commit reset may choose. */
export const RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/** Undo one in-progress operation. */
export type AbortOperation = (git: GitRunner, root: string, signal?: AbortSignal) => Promise<void>

/** Classify one failed operation; it throws its own error. */
export type FailureHandler = (result: CommandResult, started: boolean) => void

/** One abortable Git worktree operation. */
export interface AbortableOpSpec {
  /** Sentinel ref that marks the operation as in progress. */
  stateHead: string
  /** Stable code when the operation is already in progress. */
  inProgressCode?: VcsErrorCode
  /** Browser-safe message when the operation is already in progress. */
  inProgressMessage?: string
  /** Refuse to start when the sentinel ref already exists; true by default. */
  preflight?: boolean
  /** git arguments for the operation. */
  args: string[]
  /** Undo this invocation's in-progress state. */
  abort: AbortOperation
  /** Classify a nonzero exit; it throws. */
  onFailure: FailureHandler
}

/** One branch or commit id to merge. */
export interface MergeTarget {
  /** Ref or revision expression to merge. */
  targetRef: string
  /** Already-resolved commit id, when the caller has one. */
  targetSha?: string | null
  /** The checked-out branch itself, which is a no-op. */
  allowSelfBranch?: string | null
  /** Message when HEAD is detached. */
  noBranchMessage?: string
}

/** One branch or commit id to rebase onto. */
export interface RebaseTarget {
  /** git's positional rebase argument. */
  targetArg: string
  /** Already-resolved commit id, when the caller has one. */
  targetSha?: string | null
  /** The checked-out branch itself, which is a no-op. */
  allowSelfBranch?: string | null
  /** Message when HEAD is detached. */
  noBranchMessage?: string
}

/**
 * The symbolic name of the checked-out branch, or an empty string when HEAD is detached.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the branch name, or an empty string.
 */
export async function currentBranch(git: GitRunner, root: string, signal?: AbortSignal): Promise<string> {
  const result = await git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal })
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

/**
 * Resolve one revision to a commit id.
 * @param git - command runner.
 * @param root - repository root.
 * @param revision - revision expression.
 * @param signal - cancellation.
 * @returns the id, or null when it does not resolve.
 */
export async function commitAt(
  git: GitRunner,
  root: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await git.run(['rev-parse', '-q', '--verify', `${revision}^{commit}`], { cwd: root, signal })
  if (result.exitCode !== 0) return null
  const id = result.stdout.trim()
  return id === '' ? null : id
}

/**
 * Whether an exact full ref (e.g. `refs/heads/main`, `refs/tags/v1`) exists.
 * @param git - command runner.
 * @param root - repository root.
 * @param fullRef - full ref name.
 * @param signal - cancellation.
 * @returns true when the ref exists.
 */
export async function refExists(
  git: GitRunner,
  root: string,
  fullRef: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await git.run(['show-ref', '--verify', '--quiet', fullRef], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  return result.exitCode === 0
}

/**
 * Validate a full ref name with `git check-ref-format`, rejecting revision syntax.
 * @param git - command runner.
 * @param root - repository root.
 * @param fullRef - full ref name such as `refs/heads/<name>` or `refs/tags/<name>`.
 * @param invalidCode - VcsError code when malformed.
 * @param invalidMessage - browser-safe error message when malformed.
 * @param signal - cancellation.
 * @returns nothing; the promise rejects when malformed.
 */
export async function validateRefFormat(
  git: GitRunner,
  root: string,
  fullRef: string,
  invalidCode: VcsErrorCode,
  invalidMessage: string,
  signal?: AbortSignal,
): Promise<void> {
  // The full ref is checked, not `--branch`: `--branch` also expands `@{…}`
  // syntax, which would let a revision expression through as a new name.
  const checked = await git.run(['check-ref-format', fullRef], { cwd: root, signal })
  if (checked.exitCode !== 0) {
    throw new VcsError(invalidCode, invalidMessage)
  }
}

/**
 * Confirm one local branch exists in `refs/heads/` and whether it is checked out.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - local branch name.
 * @param signal - cancellation.
 * @returns branch state.
 */
export async function requireLocalBranch(
  git: GitRunner,
  root: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ name: string, current: boolean }> {
  const [exists, current] = await Promise.all([
    refExists(git, root, `refs/heads/${branch}`, signal),
    currentBranch(git, root, signal),
  ])
  if (!exists) {
    throw badRequest('That branch is not a local branch of this repository.')
  }
  return { name: branch, current: current === branch }
}

/**
 * Undo an operation this panel started, and only that one.
 * @param git - command runner.
 * @param root - repository root.
 * @param stateHead - sentinel ref (`MERGE_HEAD`, `REBASE_HEAD`, etc.).
 * @param abortArgs - git abort command argv.
 * @param signal - cancellation.
 * @returns nothing; cleanup failures are swallowed.
 */
async function abortIfStarted(
  git: GitRunner,
  root: string,
  stateHead: string,
  abortArgs: string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (await commitAt(git, root, stateHead, signal) !== null) {
      await git.run(abortArgs, { cwd: root, signal })
    }
  } catch {
    // The original failure is the answer; a failed cleanup cannot improve it.
  }
}

/** Undo a merge this panel started, and only that one. */
export function abortMergeIfStarted(git: GitRunner, root: string, signal?: AbortSignal): Promise<void> {
  return abortIfStarted(git, root, 'MERGE_HEAD', ['merge', '--abort'], signal)
}

/** Undo a rebase this panel started, and only that one. */
export function abortRebaseIfStarted(git: GitRunner, root: string, signal?: AbortSignal): Promise<void> {
  return abortIfStarted(git, root, 'REBASE_HEAD', ['rebase', '--abort'], signal)
}

/** Undo a cherry-pick this panel started, and only that one. */
export function abortCherryPickIfStarted(git: GitRunner, root: string, signal?: AbortSignal): Promise<void> {
  return abortIfStarted(git, root, 'CHERRY_PICK_HEAD', ['cherry-pick', '--abort'], signal)
}

/** Undo a revert this panel started, and only that one. */
export function abortRevertIfStarted(git: GitRunner, root: string, signal?: AbortSignal): Promise<void> {
  return abortIfStarted(git, root, 'REVERT_HEAD', ['revert', '--abort'], signal)
}

/**
 * Run one abortable Git worktree operation (merge, rebase, cherry-pick, revert, drop).
 * Refuses to disturb an existing in-progress state head and aborts only the state
 * created by this invocation before delegating error classification to `onFailure`.
 *
 * @param git - command runner.
 * @param root - repository root.
 * @param spec - operation spec.
 * @param signal - cancellation.
 * @returns the successful command result.
 */
export async function runAbortableOp(
  git: GitRunner,
  root: string,
  {
    stateHead,
    inProgressCode,
    inProgressMessage,
    preflight = true,
    args,
    abort,
    onFailure,
  }: AbortableOpSpec,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (preflight && await commitAt(git, root, stateHead, signal) !== null) {
    // The preflight call sites always name the code and message; the fallbacks
    // reproduce what the error constructor already did for a missing one.
    throw new VcsError(inProgressCode ?? 'internal', inProgressMessage ?? '')
  }
  let result
  try {
    result = await git.run(args, { cwd: root, signal })
  } catch (error) {
    await abort(git, root, signal)
    throw error
  }
  if (result.exitCode !== 0) {
    const started = await commitAt(git, root, stateHead, signal) !== null
    await abort(git, root, signal)
    onFailure(result, started)
  }
  return result
}

/**
 * Merge one branch ref or commit id into the checked-out branch, aborting on conflict.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - merge target.
 * @param signal - cancellation.
 * @returns the checked-out branch, the merged commit, and how it landed.
 */
export async function mergeRevisionIntoCurrent(
  git: GitRunner,
  root: string,
  {
    targetRef,
    targetSha = null,
    allowSelfBranch = null,
    noBranchMessage = 'Merging needs a checked-out branch.',
  }: MergeTarget,
  signal?: AbortSignal,
): Promise<{ current: string, sha: string, result: 'fast-forward' | 'merged' | 'up-to-date' }> {
  // An unfinished merge belongs to the user; never touch it.
  if (await commitAt(git, root, 'MERGE_HEAD', signal) !== null) {
    throw new VcsError('merge-blocked', 'A merge is already in progress in this repository.')
  }
  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest(noBranchMessage)
  if (allowSelfBranch !== null && current === allowSelfBranch) {
    return { current, sha: targetSha ?? '', result: 'up-to-date' }
  }
  const [resolvedTarget, before] = await Promise.all([
    targetSha !== null ? Promise.resolve(targetSha) : commitAt(git, root, targetRef, signal),
    commitAt(git, root, 'HEAD', signal),
  ])
  if (resolvedTarget === null) throw badRequest('That branch has no commit to merge.')
  if (before === resolvedTarget) return { current, sha: resolvedTarget, result: 'up-to-date' }

  await runAbortableOp(git, root, {
    stateHead: 'MERGE_HEAD',
    preflight: false,
    args: ['merge', '--no-edit', '--quiet', targetRef],
    abort: abortMergeIfStarted,
    onFailure: result => {
      throw new VcsError(
        'merge-blocked',
        'The merge was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
        redactDetail(result.stderr),
      )
    },
  }, signal)

  const after = await commitAt(git, root, 'HEAD', signal)
  const outcome: 'up-to-date' | 'fast-forward' | 'merged' = after === before
    ? 'up-to-date'
    : after === resolvedTarget ? 'fast-forward' : 'merged'
  return { current, sha: resolvedTarget, result: outcome }
}

/**
 * Rebase the checked-out branch onto one branch or commit id, aborting on conflict.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - new base.
 * @param signal - cancellation.
 * @returns the checked-out branch.
 */
export async function rebaseCurrentOntoRevision(
  git: GitRunner,
  root: string,
  {
    targetArg,
    targetSha = null,
    allowSelfBranch = null,
    noBranchMessage = 'Rebasing needs a checked-out branch.',
  }: RebaseTarget,
  signal?: AbortSignal,
): Promise<{ current: string }> {
  // Check REBASE_HEAD before currentBranch: a stopped rebase leaves HEAD detached.
  if (await commitAt(git, root, 'REBASE_HEAD', signal) !== null) {
    throw new VcsError('rebase-blocked', 'A rebase is already in progress in this repository.')
  }
  const current = await currentBranch(git, root, signal)
  if (current === '') throw badRequest(noBranchMessage)
  if (allowSelfBranch !== null && current === allowSelfBranch) return { current }
  if (targetSha !== null && await commitAt(git, root, 'HEAD', signal) === targetSha) {
    return { current }
  }

  await runAbortableOp(git, root, {
    stateHead: 'REBASE_HEAD',
    preflight: false,
    args: ['rebase', targetArg],
    abort: abortRebaseIfStarted,
    onFailure: result => {
      throw new VcsError(
        'rebase-blocked',
        'The rebase was stopped and the branch was left unchanged. Resolve the conflict or local changes in a terminal.',
        redactDetail(result.stderr),
      )
    },
  }, signal)
  return { current }
}
