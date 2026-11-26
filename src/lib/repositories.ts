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

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

import { VcsError } from './errors.js'
import { repositoryName, sameRepoPath, validateRelPath } from './paths.js'
import type { BackendPreference, DiscoveryConfig, DiscoveryRules } from './repository-config.js'
import { loadDiscoveryConfig, readDiscoveryRules, writeDiscoveryConfig } from './repository-config.js'
import { VCS_MARKERS } from './vcs/index.js'

/** Most repositories one session is offered. */
export const REPOSITORY_MAX = 50

/** Directories that are never worth one lstat each during discovery. */
const REPOSITORY_SCAN_IGNORED = new Set(['.git', '.jj', 'node_modules'])
const CANDIDATE_MAX = 1000

/** How far the upward marker walk may go before giving up. */
const ENCLOSING_MAX_DEPTH = 64

/** Where one discovered repository was found. */
export interface RepositorySource {
  kind: 'default' | 'repository' | 'directory'
  path?: string
}

/** One repository the session may open. */
export interface DiscoveredRepository {
  path: string
  name: string
  /** Whether this is the nearest repository enclosing the session directory. */
  enclosing: boolean
  /** The backend that reads this repository; undefined when no marker resolved one. */
  vcs: string | undefined
  /** Every backend whose marker is present, in precedence order. */
  availableVcs: string[]
  sources: RepositorySource[]
}

/** The nearest repository enclosing a working directory. */
export interface EnclosingRepository {
  path: string
  vcs: string | undefined
  availableVcs: string[]
}

/** One repository discovery accepted for a request. */
export interface SessionRepository {
  path: string
  vcs: string | undefined
  availableVcs?: string[]
}

/** The repositories one session may open, plus what truncated the list. */
export interface RepositoryListing {
  repositories: DiscoveredRepository[]
  truncated: boolean
  cwd: string
  configError?: string
}

/** One configured path and whether it is currently available. */
export interface ConfigPathEntry {
  path: string
  available: boolean
}

/** One configured backend preference and whether its marker is currently present. */
export interface ConfigBackendEntry {
  path: string
  vcs: string
  available: boolean
}

/** The discovery configuration as the panel shows and edits it. */
export interface RepositoryConfigDescription {
  scanDirectories: ConfigPathEntry[]
  repositories: ConfigPathEntry[]
  backends: ConfigBackendEntry[]
  revision: string
  error?: string
}

/** One repository a preview would offer, named relative to the session directory. */
export interface PreviewRepository {
  path: string
  name: string
  vcs: string | undefined
  availableVcs: string[]
}

/** What previewing one configured directory or repository would add. */
export interface RepositoryPreview {
  repositories: PreviewRepository[]
  truncated: boolean
}

/** The save request body; each field is validated here rather than by the caller. */
export interface SaveRepositoryConfigBody {
  revision: unknown
  scanDirectories: unknown
  repositories: unknown
  backends: unknown
}

/** The counters one discovery pass keeps while it scans. */
interface RepositoryScan {
  add(path: string, available: string[], source: RepositorySource, enclosing?: boolean): void
  inspect(path: string, source: RepositorySource): Promise<boolean>
  scan(target: FsTarget, source: RepositorySource): Promise<void>
  result(): { repositories: DiscoveredRepository[]; truncated: boolean }
}

/** The path lists a save validates before it writes them. */
const CONFIG_PATH_KEYS = ['scanDirectories', 'repositories'] as const

/**
 * Canonicalize a path through the filesystem capability.
 * @param ctx - plugin context.
 * @param path - absolute path.
 * @param signal - cancellation.
 * @returns the real path, or undefined.
 */
async function canonicalPath(ctx: Context, path: string, signal: AbortSignal): Promise<string | undefined> {
  const target = await resolveTarget(ctx.fs, path, signal)
  return target === undefined ? undefined : ctx.fs.processPath(target)
}

/**
 * The preference key for one repository: `"."` at the session root, otherwise
 * the session-relative path with `/` separators.
 * @param canonicalCwd - canonical session working directory.
 * @param path - canonical repository root.
 * @returns the key the configuration uses.
 */
function backendKey(canonicalCwd: string, path: string): string {
  const name = relative(canonicalCwd, path)
  return name === '' ? '.' : name.split(sep).join('/')
}

/**
 * Look up the backend configured for a repository path.
 * @param backends - configured choices.
 * @param canonicalCwd - canonical session working directory.
 * @returns the lookup.
 */
function backendPreferences(
  backends: readonly BackendPreference[],
  canonicalCwd: string,
): (path: string) => string | undefined {
  const choices = new Map(backends.map(entry => [entry.path, entry.vcs]))
  return path => choices.get(backendKey(canonicalCwd, path))
}

/**
 * Which registered backend marks this directory as a repository root.
 * @param ctx - plugin context.
 * @param directory - absolute directory.
 * @param signal - cancellation.
 * @returns every present backend, in precedence order.
 */
export async function markersAt(ctx: Context, directory: string, signal: AbortSignal): Promise<string[]> {
  const available: string[] = []
  for (const marker of VCS_MARKERS) {
    try {
      // lstat does not follow the final component, so a `.git` symlink or a
      // gitfile (worktree, submodule) is found without being read through.
      const found = await ctx.fs.lstat(join(directory, marker.marker), {}, signal)
      if (found !== undefined && found !== null) available.push(marker.vcs)
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
    }
  }
  return available
}

/** Whether a caught failure is a cancelled read. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/**
 * The configured backend when its marker is present, else marker precedence.
 * @param available - present backends, most specific first.
 * @param preferred - configured backend, if any.
 * @returns the effective backend.
 */
function effectiveBackend(available: readonly string[], preferred: string | undefined): string | undefined {
  if (available.length === 0) return undefined
  return preferred !== undefined && available.includes(preferred) ? preferred : available[0]
}

/**
 * The nearest enclosing repository root, walking up from the working directory.
 * @param ctx - plugin context.
 * @param canonicalCwd - canonical working directory.
 * @param signal - cancellation.
 * @param prefer - backend preference lookup.
 * @returns the root and backends.
 */
async function enclosingRepository(
  ctx: Context,
  canonicalCwd: string,
  signal: AbortSignal,
  prefer: (path: string) => string | undefined = () => undefined,
): Promise<EnclosingRepository | undefined> {
  let directory = canonicalCwd
  for (let depth = 0; depth < ENCLOSING_MAX_DEPTH; depth += 1) {
    const available = await markersAt(ctx, directory, signal)
    if (available.length > 0) {
      const path = await canonicalPath(ctx, directory, signal)
      return path === undefined
        ? undefined
        : { path, vcs: effectiveBackend(available, prefer(path)), availableVcs: available }
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
 * @param ctx - plugin context with the filesystem capability.
 * @param cwd - absolute session working directory.
 * @param signal - cancellation.
 * @returns the enclosing root and backends, or null.
 */
export async function findEnclosingRepository(ctx: Context, cwd: string, signal: AbortSignal): Promise<EnclosingRepository | null> {
  const cwdTarget = await resolveTarget(ctx.fs, cwd, signal)
  if (cwdTarget === undefined) return null
  const canonicalCwd = ctx.fs.processPath(cwdTarget)
  const { rules } = await loadDiscoveryConfig(ctx.fs, cwdTarget, signal)
  const prefer = backendPreferences(rules.backends, canonicalCwd)
  return (await enclosingRepository(ctx, canonicalCwd, signal, prefer)) ?? null
}

/** Resolve one absolute path, reporting an absent target as undefined. */
async function resolveTarget(fs: FileSystem, path: string, signal: AbortSignal): Promise<FsTarget | undefined> {
  try {
    return await fs.resolve(path, { signal })
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    return undefined
  }
}

/** Resolve the session working directory, failing when it is unavailable. */
async function requireCwdTarget(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<FsTarget> {
  const target = await resolveTarget(fs, cwd, signal)
  if (target === undefined) throw new VcsError('no-cwd', 'The session working directory is not available.')
  return target
}

/** Resolve one configured directory, requiring a contained live directory. */
async function resolveDirectory(fs: FileSystem, cwd: FsTarget, path: string, signal: AbortSignal): Promise<FsTarget | undefined> {
  const target = await resolveTarget(fs, join(fs.processPath(cwd), path), signal)
  if (target === undefined || !fs.contains(cwd, target)) return undefined
  try {
    return (await fs.stat(target, signal))?.type === 'directory' ? target : undefined
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    return undefined
  }
}

/** Whether `path` is a directly named child directory of `parent`. */
function directChild(parent: string, path: string): boolean {
  return !sameRepoPath(parent, path) && sameRepoPath(parent, dirname(path))
    && !REPOSITORY_SCAN_IGNORED.has(repositoryName(path))
}

/** Enumerate the child directories of one scanned directory. */
async function* childDirectories(fs: FileSystem, parent: FsTarget, signal: AbortSignal): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.listDir(parent, signal)
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
    return
  }
  for (const entry of entries) {
    const path = fs.processPath(entry.target)
    if (entry.type === 'directory' && !REPOSITORY_SCAN_IGNORED.has(entry.name)
      && fs.contains(parent, entry.target) && directChild(fs.processPath(parent), path)) yield path
  }
}

/** Count marker checks across all scan directories and bound the visible list. */
function collectRepositories(
  ctx: Context,
  signal: AbortSignal,
  prefer: (path: string) => string | undefined,
): RepositoryScan {
  const entries = new Map<string, DiscoveredRepository>()
  let checked = 0
  let truncated = false

  function add(path: string, available: string[], source: RepositorySource, enclosing = false) {
    const previous = entries.get(path)
    if (previous !== undefined) {
      if (!previous.sources.some(item => item.kind === source.kind && item.path === source.path)) previous.sources.push(source)
    } else if (entries.size < REPOSITORY_MAX) {
      entries.set(path, {
        path,
        name: repositoryName(path),
        enclosing,
        vcs: effectiveBackend(available, prefer(path)),
        availableVcs: available,
        sources: [source],
      })
    } else {
      truncated = true
    }
  }

  async function inspect(path: string, source: RepositorySource): Promise<boolean> {
    if (checked === CANDIDATE_MAX) {
      truncated = true
      return false
    }
    checked += 1
    const available = await markersAt(ctx, path, signal)
    if (available.length > 0) add(path, available, source)
    return true
  }

  async function scan(target: FsTarget, source: RepositorySource) {
    for await (const path of childDirectories(ctx.fs, target, signal)) {
      if (!await inspect(path, source)) break
    }
  }

  return { add, inspect, scan, result: () => ({ repositories: [...entries.values()], truncated }) }
}

/** Enumerate candidates for the picker. */
export async function discoverRepositories(ctx: Context, cwd: string, signal: AbortSignal): Promise<RepositoryListing> {
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const canonicalCwd = fs.processPath(cwdTarget)
  const { rules, error } = await loadDiscoveryConfig(fs, cwdTarget, signal)
  const prefer = backendPreferences(rules.backends, canonicalCwd)
  const list = collectRepositories(ctx, signal, prefer)
  const enclosing = await enclosingRepository(ctx, canonicalCwd, signal, prefer)
  if (enclosing !== undefined) list.add(enclosing.path, enclosing.availableVcs, { kind: 'default' }, true)

  // Explicit entries retain their slots when a broad scan exceeds its budget.
  for (const path of rules.repositories) {
    const target = await resolveDirectory(fs, cwdTarget, path, signal)
    if (target !== undefined) await list.inspect(fs.processPath(target), { kind: 'repository', path })
  }
  await list.scan(cwdTarget, { kind: 'default' })
  for (const path of rules.scanDirectories) {
    const target = await resolveDirectory(fs, cwdTarget, path, signal)
    if (target === undefined) continue
    const source: RepositorySource = { kind: 'directory', path }
    if (!await list.inspect(fs.processPath(target), source)) break
    await list.scan(target, source)
  }
  return { ...list.result(), cwd: canonicalCwd, ...error && { configError: error } }
}

/** Check repository eligibility without listing candidates or trusting the browser. */
export async function resolveSessionRepository(
  ctx: Context,
  cwd: string,
  query: string,
  signal: AbortSignal,
): Promise<SessionRepository | undefined> {
  if (!isAbsolute(query)) return undefined
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const canonicalCwd = fs.processPath(cwdTarget)
  const { rules } = await loadDiscoveryConfig(fs, cwdTarget, signal)
  const prefer = backendPreferences(rules.backends, canonicalCwd)
  const enclosing = await enclosingRepository(ctx, canonicalCwd, signal, prefer)
  if (enclosing !== undefined && sameRepoPath(enclosing.path, query)) return enclosing

  const local = relative(canonicalCwd, query)
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return undefined
  const target = await resolveDirectory(fs, cwdTarget, local, signal)
  if (target === undefined) return undefined
  const path = fs.processPath(target)
  if (!sameRepoPath(path, query)) return undefined
  if (!directChild(canonicalCwd, path) && !await matchesConfiguredPath(fs, cwdTarget, path, rules, signal)) return undefined
  const vcs = effectiveBackend(await markersAt(ctx, path, signal), prefer(path))
  return vcs === undefined ? undefined : { path, vcs }
}

/** Whether a repository sits directly under or at one configured discovery path. */
async function matchesConfiguredPath(
  fs: FileSystem,
  cwdTarget: FsTarget,
  path: string,
  rules: DiscoveryRules,
  signal: AbortSignal,
): Promise<boolean> {
  for (const [paths, scan] of [[rules.repositories, false], [rules.scanDirectories, true]] as const) {
    for (const configured of paths) {
      const candidate = await resolveDirectory(fs, cwdTarget, configured, signal)
      if (candidate === undefined) continue
      const parent = fs.processPath(candidate)
      if (sameRepoPath(parent, path) || (scan && directChild(parent, path))) return true
    }
  }
  return false
}

/** Describe one discovery configuration with each entry's current availability. */
async function describeConfig(
  ctx: Context,
  cwdTarget: FsTarget,
  { rules, revision, error }: DiscoveryConfig,
  signal: AbortSignal,
): Promise<RepositoryConfigDescription> {
  const describe = async (paths: readonly string[], checkMarker: boolean) => {
    const entries: ConfigPathEntry[] = []
    for (const path of paths) {
      const target = await resolveDirectory(ctx.fs, cwdTarget, path, signal)
      if (!checkMarker) {
        entries.push({ path, available: target !== undefined })
        continue
      }
      const found = target === undefined ? [] : await markersAt(ctx, ctx.fs.processPath(target), signal)
      entries.push({ path, available: target !== undefined && found.length > 0 })
    }
    return entries
  }
  const describeBackends = async () => {
    const entries: ConfigBackendEntry[] = []
    for (const entry of rules.backends) {
      const target = await resolveDirectory(ctx.fs, cwdTarget, entry.path, signal)
      const available = target !== undefined
        && (await markersAt(ctx, ctx.fs.processPath(target), signal)).includes(entry.vcs)
      entries.push({ path: entry.path, vcs: entry.vcs, available })
    }
    return entries
  }
  return {
    scanDirectories: await describe(rules.scanDirectories, false),
    repositories: await describe(rules.repositories, true),
    backends: await describeBackends(),
    revision,
    ...error && { error },
  }
}

/** Read the discovery configuration for the panel's editor. */
export async function repositoryConfig(ctx: Context, cwd: string, signal: AbortSignal): Promise<RepositoryConfigDescription> {
  const target = await requireCwdTarget(ctx.fs, cwd, signal)
  return describeConfig(ctx, target, await loadDiscoveryConfig(ctx.fs, target, signal), signal)
}

/** The failure for a path the configuration cannot name. */
function unavailablePath(): VcsError {
  return new VcsError('repository-path-unavailable', 'Choose an available directory or repository within this session directory.')
}

/** Preview what one configured directory or repository would add. */
export async function previewRepositoryConfig(
  ctx: Context,
  cwd: string,
  kind: string | null,
  path: string | null,
  signal: AbortSignal,
): Promise<RepositoryPreview> {
  const rel = validateRelPath(path)
  if (rel === undefined || (kind !== 'directory' && kind !== 'repository')) throw unavailablePath()
  const fs = ctx.fs
  const cwdTarget = await requireCwdTarget(fs, cwd, signal)
  const target = await resolveDirectory(fs, cwdTarget, rel, signal)
  if (target === undefined) throw unavailablePath()
  const base = fs.processPath(cwdTarget)
  const { rules } = await loadDiscoveryConfig(fs, cwdTarget, signal)
  const list = collectRepositories(ctx, signal, backendPreferences(rules.backends, base))
  const source: RepositorySource = { kind, path: rel }
  await list.inspect(fs.processPath(target), source)
  if (kind === 'directory') await list.scan(target, source)
  const { repositories, truncated } = list.result()
  if (kind === 'repository' && repositories.length === 0) throw unavailablePath()
  return {
    repositories: repositories.map(({ path: repoPath, name, vcs, availableVcs }) => ({
      path: relative(base, repoPath).split(sep).join('/'), name, vcs, availableVcs,
    })),
    truncated,
  }
}

/** Save the discovery configuration the panel edited. */
export async function saveRepositoryConfig(
  ctx: Context,
  cwd: string,
  sessionId: string | null,
  { revision, scanDirectories, repositories, backends }: SaveRepositoryConfigBody,
  signal: AbortSignal,
): Promise<RepositoryConfigDescription> {
  if (typeof revision !== 'string' || !Array.isArray(scanDirectories) || !Array.isArray(repositories)) {
    throw new VcsError('repository-config-invalid', 'The repository configuration requires a revision and both path lists.')
  }
  const rules = readDiscoveryRules({ scanDirectories, repositories, backends })
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
  for (const key of CONFIG_PATH_KEYS) {
    if (draft[key].some(entry => !entry.available && !current.rules[key].includes(entry.path))) throw unavailablePath()
  }
  const previous = new Map(current.rules.backends.map(entry => [entry.path, entry.vcs]))
  for (const entry of rules.backends) {
    // An existing choice stays configured when its repository or marker is
    // temporarily unavailable; the panel falls back to marker precedence.
    if (previous.get(entry.path) === entry.vcs) continue
    const directory = await resolveDirectory(fs, target, entry.path, signal)
    if (directory === undefined) throw unavailablePath()
    const available = await markersAt(ctx, fs.processPath(directory), signal)
    if (!available.includes(entry.vcs)) throw unavailablePath()
  }
  await writeDiscoveryConfig(fs, target, current, rules, sessionId, signal)
  return describeConfig(ctx, target, await loadDiscoveryConfig(fs, target, signal), signal)
}
