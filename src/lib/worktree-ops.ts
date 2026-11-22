import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

import { VcsError } from './errors.js'
import { sameRepoPath, validateRelPath } from './paths.js'

export type WorktreeAction = 'create' | 'remove' | 'forget'
export interface WorktreeCreate {
  path: string
  mode?: 'new' | 'existing' | 'detach'
  name?: string
  revision?: string
}

export type WorktreeChange = () => void
export type RecheckTarget = () => Promise<void>

const METADATA = /^\.(?:git|jj|dsh)(?:[. ]*)$/iu

/** A new checkout may go inside the session or immediately beside its authorized repository. */
export async function newWorktreePath(ctx: Context, cwd: string, root: string, raw: string, signal: AbortSignal): Promise<string> {
  const absolute = isAbsolute(raw)
  const local = absolute ? raw.slice(parse(raw).root.length).replaceAll('\\', '/') : raw
  const sibling = !absolute && local.startsWith('../') && !local.slice(3).includes('/')
  const relative = sibling ? local.slice(3) : local
  if (raw.length > 4096 || validateRelPath(relative) === undefined || relative.split('/').some(part => METADATA.test(part))) {
    throw new VcsError('worktree-path-invalid', 'Choose a new directory inside the session or an immediate sibling of the repository.')
  }
  const path = resolve(root, raw)
  const parent = dirname(path)
  const [scope, parentTarget] = await Promise.all([ctx.fs.resolve(cwd, { signal }), ctx.fs.resolve(parent, { signal })])
  const canonicalParent = ctx.fs.processPath(parentTarget)
  if (!sameRepoPath(parent, canonicalParent) || (await ctx.fs.lstat(parent, undefined, signal))?.type !== 'directory') {
    throw new VcsError('worktree-path-invalid', 'The destination needs an existing parent directory without symbolic links.')
  }
  if ((!ctx.fs.contains(scope, parentTarget) && !sameRepoPath(parent, dirname(root)))
    || (sibling && !sameRepoPath(parent, dirname(root)))) {
    throw new VcsError('worktree-path-invalid', 'Choose a new directory inside the session or an immediate sibling of the repository.')
  }
  const destination = resolve(canonicalParent, basename(path))
  await requireAbsentDestination(ctx, destination, signal)
  return destination
}

/** Recheck an absent destination before handing it to a native command that accepts empty directories. */
export async function requireAbsentDestination(ctx: Context, path: string, signal: AbortSignal): Promise<void> {
  const parent = dirname(path)
  const target = await ctx.fs.resolve(parent, { signal })
  if (!sameRepoPath(parent, ctx.fs.processPath(target)) || (await ctx.fs.lstat(parent, undefined, signal))?.type !== 'directory') {
    throw new VcsError('worktree-path-invalid', 'The destination parent has changed.')
  }
  if (await ctx.fs.lstat(path, undefined, signal) !== undefined) {
    throw new VcsError('worktree-exists', 'The destination already exists.')
  }
}

// Optional service contracts inspected on the installed Host. Keep the plugin's original required services.
interface OptionalSessionServices {
  workingDirectory?: { get(session: Session): string }
}

/** Project roots and current directories of all live Sessions. */
export async function worktreeSessionDirectories(ctx: Context, signal: AbortSignal): Promise<FsTarget[]> {
  const host = ctx as Context & OptionalSessionServices
  const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') as OptionalSessionServices['workingDirectory'] : host.workingDirectory
  const paths = new Set(ctx.sessions.list().flatMap(session => [session.header.cwd, workingDirectory?.get(session)]))
  const directories: FsTarget[] = []
  for (const path of paths) {
    if (path !== undefined) directories.push(await ctx.fs.resolve(path, { signal }))
  }
  return directories
}

export async function worktreeInUse(ctx: Context, path: string, directories: readonly FsTarget[], signal: AbortSignal): Promise<boolean> {
  if (directories.length === 0) return false
  const target = await ctx.fs.resolve(path, { signal })
  return directories.some(directory => ctx.fs.contains(target, directory))
}

/** Check disk entries without following checkout symlinks into another directory. */
export async function checkWorktreeFiles(
  ctx: Context, path: string, metadata: ReadonlySet<string>, checkFile: (path: string) => void, signal: AbortSignal,
): Promise<void> {
  const root = await ctx.fs.resolve(path, { signal })
  const pending = [{ target: root, prefix: '' }]
  let count = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    const item = pending.pop()!
    const entries = await ctx.fs.listDir(item.target, signal)
    for (const entry of entries) {
      if (++count > 100_000) throw new VcsError('worktree-unsupported', 'This checkout has too many files to verify for safe removal.')
      const name = entry.name.toLowerCase()
      if (item.prefix === '' && metadata.has(entry.name)) continue
      if (name === '.git' || name === '.jj') {
        throw new VcsError('worktree-protected', 'This checkout contains another repository or submodule.')
      }
      const rel = `${item.prefix}${entry.name}`
      const entryPath = join(path, rel)
      const info = await ctx.fs.lstat(entryPath, undefined, signal)
      if (info?.type === 'directory' && ctx.fs.contains(root, entry.target) && sameRepoPath(entryPath, ctx.fs.processPath(entry.target))) {
        pending.push({ target: entry.target, prefix: `${rel}/` })
      } else if (info?.type === 'file' || info?.type === 'symlink') {
        checkFile(rel)
      } else {
        throw new VcsError('worktree-dirty', 'This checkout has filesystem entries that could not be verified for removal.')
      }
    }
  }
}
