/** Git stash entries and the two tree comparisons that make up their detail. */

import { COMMIT_FILE_MAX, readCommitFiles } from './commit.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import type { GitRunner } from './git.js'
import { redactDetail } from './git-utils.js'
import { isFullSha, validateSha } from './paths.js'
import type { StashDetailAnswer, StashEntry } from './stash-types.js'

export const OVERVIEW_STASH_MAX = 200
/** Stash list fields, NUL-separated, one reflog entry per line. */
export const STASH_FORMAT = '%gd%x00%H%x00%P%x00%ct%x00%gs'

/** Read newest first; a stash must have W, base, I and optionally U. */
export function parseStashList(stdout: string): StashEntry[] {
  return stdout.split('\n').flatMap(line => {
    const [selector, sha, parents, seconds, subject] = line.split('\0')
    if (!/^stash@\{\d+\}$/u.test(selector) || !isFullSha(sha) || parents === undefined) return []
    const [base, index, untracked, ...extra] = parents.split(' ')
    if (!isFullSha(base) || !isFullSha(index) || (untracked !== undefined && !isFullSha(untracked))
      || extra.length !== 0 || !/^\d+$/u.test(seconds ?? '') || subject === undefined) return []
    const prefix = /^(?:WIP on|On) (.+?):(?: |$)/u.exec(subject)
    const branch = prefix === null || prefix[1] === '(no branch)' ? null : prefix[1]
    return [{
      sha, selector, base, index, untracked: untracked ?? null, time: Number(seconds), branch,
      message: prefix === null ? subject : subject.slice(prefix[0].length),
    }]
  })
}

export async function readStashEntries(git: GitRunner, root: string, signal: AbortSignal, limit?: number): Promise<StashEntry[]> {
  const result = await git.run([
    'stash', 'list', '--no-color', '--no-show-signature', `--format=${STASH_FORMAT}`,
    ...(limit === undefined ? [] : [`--max-count=${limit}`]),
  ], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('internal', 'The stash list could not be read.', redactDetail(result.stderr))
  return parseStashList(result.stdout)
}

export async function listStashes(git: GitRunner, root: string, signal: AbortSignal) {
  const entries = await readStashEntries(git, root, signal, OVERVIEW_STASH_MAX + 1)
  return { stashes: entries.slice(0, OVERVIEW_STASH_MAX), stashesTruncated: entries.length > OVERVIEW_STASH_MAX }
}

export function requireStashSha(value: unknown): string {
  const sha = validateSha(value)
  if (!isFullSha(sha)) throw badRequest('A stash requires a full hexadecimal commit id.')
  return sha
}

/** Look up the live reflog, not a client-supplied selector or an arbitrary commit. */
export async function requireStash(git: GitRunner, root: string, value: unknown, signal: AbortSignal): Promise<StashEntry> {
  const sha = requireStashSha(value)
  const stash = (await readStashEntries(git, root, signal)).find(entry => entry.sha === sha)
  if (stash === undefined) throw new VcsError('stash-missing', 'The stash list has changed and that stash is no longer available.')
  return stash
}

export async function readStashDetail(git: GitRunner, root: string, value: unknown, signal: AbortSignal): Promise<StashDetailAnswer> {
  const stash = await requireStash(git, root, value, signal)
  const [tracked, untracked, staged] = await Promise.all([
    readCommitFiles(git, root, [stash.base, stash.sha], signal),
    stash.untracked === null ? [] : readCommitFiles(git, root, ['--root', stash.untracked], signal),
    git.run(['diff-tree', '--no-commit-id', '--name-only', '-r', '-M', '-z', stash.base, stash.index], { cwd: root, signal }),
  ])
  if (staged.lossy) throw outputTooLarge()
  if (staged.exitCode !== 0) throw new VcsError('internal', 'The staged files in the stash could not be read.')
  const files = [...tracked, ...untracked.map(file => ({ ...file, status: 'U', untracked: true as const }))]
    .sort((a, b) => a.path.localeCompare(b.path))
  return {
    stash: { ...stash, files: files.slice(0, COMMIT_FILE_MAX), staged: staged.stdout.split('\0').filter(Boolean).length },
    truncated: files.length > COMMIT_FILE_MAX,
  }
}
