/**
 * Repository discovery for one session working directory.
 *
 * Listing and direct target checks share the same discovery rules. Only the
 * listing enumerates directories; requests for a single root recheck that root.
 *
 * A repository is a directory carrying one of the registered markers. The
 * marker is checked with `lstat`, so a `.git` file (a linked worktree or a
 * submodule) and a `.jj` workspace are found without being read through.
 */

import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { VcsError } from './errors.js'
import { repositoryName, sameRepoPath, validateRelPath } from './paths.js'
import { loadDiscoveryConfig, readDiscoveryRules, writeDiscoveryConfig } from './repository-config.js'
import { VCS_MARKERS } from './vcs/index.js'

/** Most repositories one session is offered. */
export const REPOSITORY_MAX = 50

/** Directories that are never worth one lstat each during discovery. */
const REPOSITORY_SCAN_IGNORED = new Set(['.git', '.jj', 'node_modules'])
const CANDIDATE_MAX = 1000

/** How far the upward marker walk may go before giving up. */
const ENCLOSING_MAX_DEPTH = 64

/**
 * Canonicalize a path through the filesystem capability.
 * @param {object} ctx - plugin context.
 * @param {string} path - absolute path.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | undefined>} the real path, or undefined.
 */
async function canonicalPath(ctx, path, signal) {
  const target = await resolveTarget(ctx.fs, path, signal)
  return target === undefined ? undefined : ctx.fs.processPath(target)
}

/**
 * Which registered backend marks this directory as a repository root.
 * @param {object} ctx - plugin context.
 * @param {string} directory - absolute directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string | undefined>} the backend id, if any.
 */
async function markerAt(ctx, directory, signal) {
  for (const marker of VCS_MARKERS) {
    try {
      // lstat does not follow the final component, so a `.git` symlink or a
      // gitfile (worktree, submodule) is found without being read through.
      const found = await ctx.fs.lstat(join(directory, marker.marker), {}, signal)
      if (found !== undefined && found !== null) return marker.vcs
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
    }
  }
  return undefined
}

/**
 * The nearest enclosing repository root, walking up from the working directory.
 * @param {object} ctx - plugin context.
 * @param {string} canonicalCwd - canonical working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ path: string, vcs: string } | undefined>} the root and backend.
 */
async function enclosingRepository(ctx, canonicalCwd, signal) {
  let directory = canonicalCwd
  for (let depth = 0; depth < ENCLOSING_MAX_DEPTH; depth += 1) {
    const vcs = await markerAt(ctx, directory, signal)
    if (vcs !== undefined) {
      const path = await canonicalPath(ctx, directory, signal)
      return path === undefined ? undefined : { path, vcs }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Locate the nearest repository enclosing a working directory, without scanning
 * child directories. Returns `null` when the directory is outside any
 * repository or cannot be resolved.
 *
 * @param {object} ctx - plugin context with the filesystem capability.
 * @param {string} cwd - absolute session working directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ path: string, vcs: string } | null>} the enclosing root and backend, or null.
 */
export async function findEnclosingRepository(ctx, cwd, signal) {
  const cwdTarget = await resolveTarget(ctx.fs, cwd, signal)
  if (cwdTarget === undefined) return null
  const canonicalCwd = ctx.fs.processPath(cwdTarget)
  return (await enclosingRepository(ctx, canonicalCwd, signal)) ?? null
}

async function resolveTarget(fs, path, signal) {
  try {
    return await fs.resolve(path, { signal })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return undefined
  }
}

async function requireCwdTarget(fs, cwd, signal) {
  const target = await resolveTarget(fs, cwd, signal)
  if (target === undefined) throw new VcsError('no-cwd', 'The session working directory is not available.')
  return target
}

async function resolveDirectory(fs, cwd, path, signal) {
  const target = await resolveTarget(fs, join(fs.processPath(cwd), path), signal)
  if (target === undefined || !fs.contains(cwd, target)) return undefined
  try {
    return (await fs.stat(target, signal))?.type === 'directory' ? target : undefined
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return undefined
  }
}

function directChild(parent, path) {
  return !sameRepoPath(parent, path) && sameRepoPath(parent, dirname(path))
    && !REPOSITORY_SCAN_IGNORED.has(repositoryName(path))
}

async function* childDirectories(fs, parent, signal) {
  let entries
  try {
    entries = await fs.listDir(parent, signal)
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return
  }
  for (const entry of entries) {
    const path = fs.processPath(entry.target)
    if (entry.type === 'directory' && !REPOSITORY_SCAN_IGNORED.has(entry.name)
      && fs.contains(parent, entry.target) && directChild(fs.processPath(parent), path)) yield path
  }
}

/** Count marker checks across all scan directories and bound the visible list. */
function collectRepositories(ctx, signal) {
  const entries = new Map()
  let checked = 0
  let truncated = false

  function add(path, vcs, source, enclosing = false) {
    const previous = entries.get(path)
    if (previous !== undefined) {
      if (!previous.sources.some(item => item.kind === source.kind && item.path === source.path)) previous.sources.push(source)
    } else if (entries.size < REPOSITORY_MAX) {
      entries.set(path, { path, name: repositoryName(path), enclosing, vcs, sources: [source] })
    } else {
      truncated = true
    }
  }

  async function inspect(path, source) {
    if (checked === CANDIDATE_MAX) {
      truncated = true
      return false
    }
    checked += 1
    const vcs = await markerAt(ctx, path, signal)
    if (vcs !== undefined) add(path, vcs, source)
    return true
  }

  async function scan(target, source) {
    for await (const path of childDirectories(ctx.fs, target, signal)) {
      if (!await inspect(path, source)) break
    }
  }

  return { add, inspect, scan, result: () => ({ repositories: [...entries.values()], truncated }) }
}

/** Enumerate candidates for the picker. */
export async function discoverRepositories(ctx, cwd, signal) {
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const canonicalCwd = fs.processPath(cwdTarget)
  const { rules, error } = await loadDiscoveryConfig(fs, cwdTarget, signal)
  const list = collectRepositories(ctx, signal)
  const enclosing = await enclosingRepository(ctx, canonicalCwd, signal)
  if (enclosing !== undefined) list.add(enclosing.path, enclosing.vcs, { kind: 'default' }, true)

  // Explicit entries retain their slots when a broad scan exceeds its budget.
  for (const path of rules.repositories) {
    const target = await resolveDirectory(fs, cwdTarget, path, signal)
    if (target !== undefined) await list.inspect(fs.processPath(target), { kind: 'repository', path })
  }
  await list.scan(cwdTarget, { kind: 'default' })
  for (const path of rules.scanDirectories) {
    const target = await resolveDirectory(fs, cwdTarget, path, signal)
    if (target === undefined) continue
    const source = { kind: 'directory', path }
    if (!await list.inspect(fs.processPath(target), source)) break
    await list.scan(target, source)
  }
  return { ...list.result(), cwd: canonicalCwd, ...(error && { configError: error }) }
}

/** Check repository eligibility without listing candidates or trusting the browser. */
export async function resolveSessionRepository(ctx, cwd, query, signal) {
  if (!isAbsolute(query)) return undefined
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const canonicalCwd = fs.processPath(cwdTarget)
  const enclosing = await enclosingRepository(ctx, canonicalCwd, signal)
  if (enclosing !== undefined && sameRepoPath(enclosing.path, query)) return enclosing

  const local = relative(canonicalCwd, query)
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return undefined
  const target = await resolveDirectory(fs, cwdTarget, local, signal)
  if (target === undefined) return undefined
  const path = fs.processPath(target)
  if (!sameRepoPath(path, query)) return undefined
  if (!directChild(canonicalCwd, path) && !await matchesConfiguredPath(fs, cwdTarget, path, signal)) return undefined
  const vcs = await markerAt(ctx, path, signal)
  return vcs === undefined ? undefined : { path, vcs }
}

async function matchesConfiguredPath(fs, cwdTarget, path, signal) {
  const { rules } = await loadDiscoveryConfig(fs, cwdTarget, signal)
  for (const [paths, scan] of [[rules.repositories, false], [rules.scanDirectories, true]]) {
    for (const configured of paths) {
      const candidate = await resolveDirectory(fs, cwdTarget, configured, signal)
      if (candidate === undefined) continue
      const parent = fs.processPath(candidate)
      if (sameRepoPath(parent, path) || (scan && directChild(parent, path))) return true
    }
  }
  return false
}

async function describeConfig(ctx, cwdTarget, { rules, revision, error }, signal) {
  const describe = async (paths, checkMarker) => {
    const entries = []
    for (const path of paths) {
      const target = await resolveDirectory(ctx.fs, cwdTarget, path, signal)
      const available = target !== undefined
        && (!checkMarker || await markerAt(ctx, ctx.fs.processPath(target), signal) !== undefined)
      entries.push({ path, available })
    }
    return entries
  }
  return {
    scanDirectories: await describe(rules.scanDirectories, false),
    repositories: await describe(rules.repositories, true),
    revision,
    ...(error && { error }),
  }
}

export async function repositoryConfig(ctx, cwd, signal) {
  const target = await requireCwdTarget(ctx.fs, cwd, signal)
  return describeConfig(ctx, target, await loadDiscoveryConfig(ctx.fs, target, signal), signal)
}

function unavailablePath() {
  return new VcsError('repository-path-unavailable', 'Choose an available directory or repository within this session directory.')
}

export async function previewRepositoryConfig(ctx, cwd, kind, path, signal) {
  if (validateRelPath(path) === undefined || (kind !== 'directory' && kind !== 'repository')) throw unavailablePath()
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const target = await resolveDirectory(fs, cwdTarget, path, signal)
  if (target === undefined) throw unavailablePath()
  const base = fs.processPath(cwdTarget)
  const list = collectRepositories(ctx, signal)
  const source = { kind, path }
  await list.inspect(fs.processPath(target), source)
  if (kind === 'directory') await list.scan(target, source)
  const { repositories, truncated } = list.result()
  if (kind === 'repository' && repositories.length === 0) throw unavailablePath()
  return {
    repositories: repositories.map(({ path, name, vcs }) => ({ path: relative(base, path).split(sep).join('/'), name, vcs })),
    truncated,
  }
}

export async function saveRepositoryConfig(ctx, cwd, sessionId, { revision, scanDirectories, repositories }, signal) {
  if (typeof revision !== 'string' || !Array.isArray(scanDirectories) || !Array.isArray(repositories)) {
    throw new VcsError('repository-config-invalid', 'The repository configuration requires a revision and both path lists.')
  }
  const rules = readDiscoveryRules({ scanDirectories, repositories })
  const fs = ctx.fs
  const target = await requireCwdTarget(fs, cwd, signal)
  const current = await loadDiscoveryConfig(fs, target, signal)
  if (current.error === 'repository-path-unavailable') throw unavailablePath()
  if (revision !== current.revision || current.error === 'repository-config-conflict') {
    throw new VcsError('repository-config-conflict', 'The repository configuration changed. Reload it before saving.')
  }
  if (current.error !== undefined) {
    throw new VcsError('repository-config-invalid', 'Correct the repository configuration file before saving.')
  }
  const draft = await describeConfig(ctx, target, { rules, revision }, signal)
  for (const key of ['scanDirectories', 'repositories']) {
    if (draft[key].some(entry => !entry.available && !current.rules[key].includes(entry.path))) throw unavailablePath()
  }
  await writeDiscoveryConfig(fs, target, current, rules, sessionId, signal)
  return describeConfig(ctx, target, await loadDiscoveryConfig(fs, target, signal), signal)
}
