/**
 * Helpers shared by Git's write operations.
 *
 * A remote or ref value reaches a later argv, so it is checked here once:
 * options, control characters, and refs outside `refs/heads/` are refused.
 * `redactDetail` keeps credentials out of the Host log.
 */

import { REMOTE_TIMEOUT_MS } from './command.js'
import { outputTooLarge, VcsError } from './errors.js'
import type { VcsErrorCode } from './errors.js'
import type { GitRunner } from './git.js'

/** Names that would read as an option or carry control characters are refused. */
export const UNSAFE_NAME = /^-|[\u0000-\u001f\u007f]/u

/** An upstream ref a push may target. */
export const MERGE_REF = /^refs\/heads\/[^\u0000-\u001f\u007f]+$/u

/** Most remotes a listing exposes. */
export const REMOTE_MAX = 500

/** A remote name safe as a positional argument and readable in the dialog. */
const SAFE_REMOTE = /^[^\u0000-\u0020\u007f]+$/u

/** The newest stderr lines kept for the Host log. */
const DETAIL_LINES = 3

/** How a failed remote read is reported. */
export interface RemoteReadOptions {
  /** Stable error code; `internal` by default. */
  errorCode?: VcsErrorCode
  /** Browser-safe message. */
  errorMessage?: string
}

/** How a branch's upstream is validated. */
export interface BranchUpstreamOptions {
  /** Accept `.` (the branch's own repository) as its remote. */
  allowLocal?: boolean
  /** Message when the branch has no upstream. */
  missingMessage?: string
  /** Message when the upstream config is unusable. */
  invalidMessage?: string
}

/** One remote push destination and its refspecs. */
export interface PorcelainPushTarget {
  /** Configured remote name. */
  remote: string
  /** Refspecs after the remote name. */
  args: string[]
  /** Stable error code; `remote-failed` by default. */
  errorCode?: VcsErrorCode
  /** Browser-safe message. */
  errorMessage?: string
}

/**
 * Reduce a failed command's stderr to a short diagnostic safe for the Host
 * log: the last few lines, with any URL credentials removed.
 * @param stderr - the captured stderr tail.
 * @returns the diagnostic.
 */
export function redactDetail(stderr: string): string {
  return stderr
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-DETAIL_LINES)
    .join(' | ')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1***@')
}

/**
 * Read safe configured remote names in git's own order.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @param options - failure mapping.
 * @returns safe remote names.
 */
async function readSafeRemotes(
  git: GitRunner,
  root: string,
  signal: AbortSignal | undefined,
  { errorCode = 'internal', errorMessage = 'The remotes could not be read.' }: RemoteReadOptions = {},
): Promise<string[]> {
  const result = await git.run(['remote'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) {
    throw new VcsError(errorCode, errorMessage, redactDetail(result.stderr))
  }
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(name => name !== '' && SAFE_REMOTE.test(name) && !UNSAFE_NAME.test(name))
}

/**
 * List the remotes this repository has configured, capped at {@link REMOTE_MAX}.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns the listing.
 */
export async function listGitRemotes(
  git: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<{ remotes: string[], truncated: boolean }> {
  const remotes = await readSafeRemotes(git, root, signal, { errorCode: 'tag-failed' })
  const truncated = remotes.length > REMOTE_MAX
  return { remotes: truncated ? remotes.slice(0, REMOTE_MAX) : remotes, truncated }
}

/**
 * Configured remote names, longest first so `origin/feature` wins over an
 * `origin` remote when a remote-tracking ref is split.
 * @param git - command runner.
 * @param root - repository root.
 * @param signal - cancellation.
 * @returns safe remote names.
 */
export async function remoteNames(git: GitRunner, root: string, signal?: AbortSignal): Promise<string[]> {
  const remotes = await readSafeRemotes(git, root, signal)
  return remotes.sort((first, second) => second.length - first.length)
}

/**
 * Read one git config value.
 * @param git - command runner.
 * @param root - repository root.
 * @param key - config key.
 * @param signal - cancellation.
 * @returns the value, or null when unset.
 */
export async function configValue(
  git: GitRunner,
  root: string,
  key: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await git.run(['config', '--get', key], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

/**
 * Read and validate one local branch's configured upstream remote and merge ref.
 * @param git - command runner.
 * @param root - repository root.
 * @param branch - local branch name.
 * @param signal - cancellation.
 * @param options - validation options.
 * @returns the validated upstream config.
 */
export async function readBranchUpstream(
  git: GitRunner,
  root: string,
  branch: string,
  signal?: AbortSignal,
  {
    allowLocal = false,
    missingMessage = 'This branch has no upstream to sync with.',
    invalidMessage = missingMessage,
  }: BranchUpstreamOptions = {},
): Promise<{ remote: string, merge: string }> {
  const [remote, merge] = await Promise.all([
    configValue(git, root, `branch.${branch}.remote`, signal),
    configValue(git, root, `branch.${branch}.merge`, signal),
  ])
  if (remote === null || merge === null || (!allowLocal && remote === '.')) {
    throw new VcsError('no-upstream', missingMessage)
  }
  if (UNSAFE_NAME.test(remote) || !MERGE_REF.test(merge)) {
    throw new VcsError('no-upstream', invalidMessage)
  }
  return { remote, merge }
}

/**
 * Run `git push --porcelain` with a remote timeout and structured error/result parsing.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - push destination and refspecs.
 * @param signal - cancellation.
 * @returns whether any ref changed on the remote.
 */
export async function runPorcelainPush(
  git: GitRunner,
  root: string,
  {
    remote,
    args,
    errorCode = 'remote-failed',
    errorMessage = 'The remote did not accept the push.',
  }: PorcelainPushTarget,
  signal?: AbortSignal,
): Promise<{ pushed: boolean }> {
  const result = await git.run(
    ['push', '--porcelain', remote, ...args],
    { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    // `--porcelain` marks the refused ref with `!` and its reason.
    const refused = result.stdout.split('\n').find(line => line.startsWith('!')) ?? ''
    throw new VcsError(errorCode, errorMessage, redactDetail(`${result.stderr}\n${refused}`))
  }
  // Porcelain starts with a `To <remote>` header and ends with `Done`; the
  // ref lines between them start with a flag, '=' meaning already up to date.
  const output = result.stdout.split('\n')
    .filter(line => line !== '' && line !== 'Done' && !line.startsWith('To '))
  return { pushed: output.some(line => !line.startsWith('=')) }
}
