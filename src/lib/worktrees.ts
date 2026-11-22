/** Git's registered working trees, with stale or foreign directories excluded. */

import { isAbsolute } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { canonicalDirectory } from './contain.js'
import { outputTooLarge } from './errors.js'
import type { GitRunner } from './git.js'
import { isFullSha, sameRepoPath } from './paths.js'

const BRANCH_PREFIX = 'branch refs/heads/'

/** One registered Git working tree. */
export interface GitWorktree {
  /** Absolute directory path. */
  path: string
  /** Checked-out branch name, or null when detached. */
  branch: string | null
  /** Head commit id, or null when unreadable or the null oid. */
  head: string | null
  primary: boolean
  locked: boolean
  prunable: boolean
}

/** One browsable tree, from either backend's discovery. */
export interface Worktree {
  /** Absolute directory path. */
  path: string
  /** Workspace name, for a backend that has one. */
  name?: string
  /** Checked-out branch, for a backend that has one. */
  branch?: string | null
  /** Head commit id, or null when the backend cannot report one. */
  head: string | null
  primary?: boolean
  locked?: boolean
  canRemove?: boolean
  canForget?: boolean
  inUse?: boolean
}

/** Which trees one discovery may offer. */
export interface WorktreeOptions {
  /** Client-requested directories; null means every live sibling. */
  paths?: string[] | null
  /** The repository's common directory, when the caller already resolved it. */
  commonDir?: string | null
}

/**
 * Read complete NUL-delimited records without unquoting paths or reasons.
 * @param stdout - `git worktree list --porcelain -z` output.
 * @returns the registered trees.
 */
export function* parseGitWorktrees(stdout: string): Generator<GitWorktree> {
  const records = stdout.split('\0\0')
  records.pop() // The last split is outside a complete record.
  for (const [index, record] of records.entries()) {
    const [first, ...fields] = record.split('\0')
    if (!first.startsWith('worktree ')) continue
    const path = first.slice('worktree '.length)
    if (!isAbsolute(path) || fields.includes('bare')) continue
    const branch = fields.find(field => field.startsWith(BRANCH_PREFIX))?.slice(BRANCH_PREFIX.length) || null
    const oid = fields.find(field => field.startsWith('HEAD '))?.slice(5)
    const head = isFullSha(oid) && !/^0+$/u.test(oid) ? oid : null
    const locked = fields.some(field => field === 'locked' || field.startsWith('locked '))
    const prunable = fields.some(field => field === 'prunable' || field.startsWith('prunable '))
    yield { path, branch, head, primary: index === 0, locked, prunable }
  }
}

/** Git must see this exact directory as a working tree, not a containing repo. */
export async function gitCommonDirAt(
  git: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await git.run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: root, signal })
  if (result.lossy || result.exitCode !== 0 || !result.stdout.endsWith('\n')) return null
  // Both paths may contain newlines. The known root tells us how many lines
  // its value occupies; everything after that separator is the common dir.
  const rootLines = root.split('\n').length
  const lines = result.stdout.slice(0, -1).split('\n')
  const topLevel = lines.slice(0, rootLines).join('\n')
  const commonDir = lines.slice(rootLines).join('\n')
  return isAbsolute(topLevel) && isAbsolute(commonDir) && sameRepoPath(topLevel, root) ? commonDir : null
}

/**
 * Yield the anchor first, then its live siblings. A listed path alone is not proof:
 * Git can keep listing a stale registration after another repo takes its place.
 * Resolve candidates from Git's list, never from the browser's requested path.
 */
export async function* discoverGitWorktrees(
  ctx: Context,
  git: GitRunner,
  root: string,
  signal: AbortSignal | undefined,
  { paths = null, commonDir = null }: WorktreeOptions = {},
): AsyncGenerator<Worktree> {
  const result = await git.run(['worktree', 'list', '--porcelain', '-z'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) return

  const entries = [...parseGitWorktrees(result.stdout)].filter(entry => !entry.prunable)
    .map(({ path, branch, head, primary, locked }) => ({ path, branch, head, primary, locked }))
  const anchor = entries.find(entry => sameRepoPath(entry.path, root))
  const matches = (path: string): boolean => paths === null || paths.some(requested => sameRepoPath(path, requested))
  if (anchor !== undefined && matches(root)) yield { ...anchor, path: root }
  for (const entry of entries) {
    if (sameRepoPath(entry.path, root)) continue
    const path = await canonicalDirectory(ctx, entry.path, signal)
    if (path === null || !matches(path)) continue
    if (sameRepoPath(path, root)) {
      if (anchor === undefined) yield { ...entry, path: root }
      continue
    }

    commonDir ??= await gitCommonDirAt(git, root, signal)
    if (commonDir === null) return
    const candidateCommonDir = await gitCommonDirAt(git, path, signal)
    if (candidateCommonDir !== null && sameRepoPath(candidateCommonDir, commonDir)) yield { ...entry, path }
  }
}
