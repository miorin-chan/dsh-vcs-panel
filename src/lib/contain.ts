/**
 * Filesystem containment for one repository-relative path.
 *
 * Every path that reaches the filesystem is resolved after symlinks and must
 * stay inside the canonical repository root. A backend that reads a path from
 * history (a deleted file, a commit's tree) does not call this: history paths
 * never touch the current working tree.
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

import { abortError, badRequest, VcsError } from './errors.js'

/** Resolve a live directory through the Host filesystem capability. */
export async function canonicalDirectory(
  ctx: Context,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const info = await ctx.fs.stat(target, signal)
    return info?.type === 'directory' ? ctx.fs.processPath(target) : null
  } catch {
    if (signal?.aborted) throw abortError()
    return null
  }
}

/**
 * Resolve one repository-relative path, requiring its canonical target to sit
 * inside the canonical repository root.
 * @param ctx - plugin context with the filesystem capability.
 * @param root - canonical repository root.
 * @param rel - validated repository-relative path.
 * @param signal - cancellation.
 * @returns the resolved target.
 */
export async function containPath(
  ctx: Context,
  root: string,
  rel: string,
  signal?: AbortSignal,
): Promise<FsTarget> {
  let repoTarget
  try {
    repoTarget = await ctx.fs.resolve(root, { signal })
  } catch {
    throw new VcsError('internal', 'The repository could not be opened.')
  }
  let target
  try {
    target = await ctx.fs.resolve(join(root, rel), { signal })
  } catch {
    throw badRequest('The path does not resolve inside the repository.')
  }
  if (!ctx.fs.contains(repoTarget, target)) {
    throw badRequest('The path is outside the repository.')
  }
  return target
}
