/**
 * Git tag operations: delete one local tag and push one tag to a remote.
 *
 * These are the writes behind the tag actions menu. Deleting removes only the
 * local ref; a tag already pushed stays on its remote. Pushing sends exactly
 * the named tag to a remote this repository lists, without `--force`, so a
 * remote tag that has moved is refused rather than overwritten. argv is fixed
 * strings plus values already checked by the route and by this module; no
 * value is ever read from a shell.
 */

import type { GitRunner } from './git.js'
import { VcsError } from './errors.js'
import { listGitRemotes, redactDetail, runPorcelainPush } from './git-utils.js'
import { refExists, validateRefFormat } from './ref-utils.js'

export { listGitRemotes, REMOTE_MAX } from './git-utils.js'

/** One validated tag action: deleting one tag, or pushing one to a remote. */
export type GitTagRequest =
  | { action: 'delete'; tag: string }
  | { action: 'push'; tag: string; remote: string }

/** The outcome of one tag action. */
export type GitTagOpResult = { tag: string } | { tag: string; remote: string; pushed: boolean }

/**
 * Check that one local tag exists before a write names it.
 * @param git - command runner.
 * @param root - repository root.
 * @param tag - the tag name.
 * @param signal - cancellation.
 */
async function requireGitTag(git: GitRunner, root: string, tag: string, signal: AbortSignal): Promise<void> {
  await validateRefFormat(git, root, `refs/tags/${tag}`, 'bad-request', 'That is not a valid tag name.', signal)
  if (!(await refExists(git, root, `refs/tags/${tag}`, signal))) {
    throw new VcsError('tag-missing', 'That tag no longer exists.')
  }
}

/**
 * Delete one local tag. A tag on a remote is untouched.
 * @param git - command runner.
 * @param root - repository root.
 * @param tag - an existing tag, checked here.
 * @param signal - cancellation.
 * @returns the deleted tag.
 */
export async function deleteGitTag(
  git: GitRunner,
  root: string,
  tag: string,
  signal: AbortSignal,
): Promise<{ tag: string }> {
  await requireGitTag(git, root, tag, signal)
  const result = await git.run(['tag', '--delete', tag], { cwd: root, signal })
  if (result.exitCode !== 0) {
    throw new VcsError('tag-failed', 'The tag could not be deleted.', redactDetail(result.stderr))
  }
  return { tag }
}

/**
 * Push one local tag to a remote, without force.
 * @param git - command runner.
 * @param root - repository root.
 * @param tag - an existing tag, checked here.
 * @param remote - one of the repository's remotes, checked here.
 * @param signal - cancellation.
 * @returns where it went.
 */
export async function pushGitTag(
  git: GitRunner,
  root: string,
  tag: string,
  remote: string,
  signal: AbortSignal,
): Promise<{ tag: string; remote: string; pushed: boolean }> {
  const [, listed] = await Promise.all([
    requireGitTag(git, root, tag, signal),
    listGitRemotes(git, root, signal),
  ])
  if (!listed.remotes.includes(remote)) {
    throw new VcsError('remote-missing', 'That remote is not available.')
  }

  const { pushed } = await runPorcelainPush(git, root, {
    remote,
    args: [`refs/tags/${tag}:refs/tags/${tag}`],
    errorCode: 'tag-push-failed',
    errorMessage: 'The remote did not accept the tag.',
  }, signal)
  return { tag, remote, pushed }
}

/**
 * Dispatch one validated tag action.
 * @param git - command runner.
 * @param root - repository root.
 * @param request - validated request.
 * @param signal - cancellation.
 * @returns the action outcome.
 */
export function runGitTagOp(
  git: GitRunner,
  root: string,
  request: GitTagRequest,
  signal: AbortSignal,
): Promise<GitTagOpResult> {
  if (request.action === 'delete') return deleteGitTag(git, root, request.tag, signal)
  return pushGitTag(git, root, request.tag, request.remote, signal)
}
