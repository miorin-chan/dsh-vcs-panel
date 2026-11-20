import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { FileSystem, FsInfo, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { VcsError } from './errors.js'
import { sameRepoPath, validateRelPath, validateRepoPath } from './paths.js'

const MAX_BYTES = 64 * 1024
const MAX_PATHS = 50
/** Backends a repository preference may name. */
const BACKENDS = new Set(['git', 'jujutsu'])

/** The discovery rules and backend preferences stored in `.dsh/vcs-panel.json`. */
export interface DiscoveryRules {
  scanDirectories: readonly string[]
  repositories: readonly string[]
  backends: readonly BackendPreference[]
}

/** One repository preference: the session-relative path and the backend that reads it. */
export interface BackendPreference {
  path: string
  vcs: string
}

/** One config read: rules, the revision a write must still match, and why they are unusable. */
export interface DiscoveryConfig {
  rules: DiscoveryRules
  revision: string
  version?: FsVersion
  error?: string
}

const EMPTY_RULES: DiscoveryRules = Object.freeze({
  scanDirectories: Object.freeze([]), repositories: Object.freeze([]), backends: Object.freeze([]),
})
const CONFIG_INVALID = 'repository-config-invalid'

/** Whether a parsed JSON value is an object this module can read fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether every listed value is a session-relative path. */
function isRelativePaths(items: readonly unknown[]): items is readonly string[] {
  return items.every(item => validateRelPath(item) !== undefined)
}

/** The identity fields a caught failure is tested by; DSH services throw typed errors. */
interface FailureIdentity {
  name?: string
  code?: string
}

/** Read a thrown value's `name` and `code` without assuming it is an `Error`. */
function failureIdentity(error: unknown): FailureIdentity {
  if (typeof error !== 'object' || error === null) return {}
  return {
    ...('name' in error && typeof error.name === 'string' ? { name: error.name } : {}),
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
  }
}

/**
 * The route carries the session id as request text; the Host sandbox policy
 * brands it as a `SessionId`. A request that named no session writes without a
 * session override.
 * @param sessionId - the request's session id.
 * @returns the branded session id, or undefined.
 */
function policySessionId(sessionId: string | null): SessionId | undefined {
  return sessionId === null ? undefined : sessionId as SessionId
}

/**
 * Read the per-repository backend choices.
 *
 * An absent list means every repository follows its marker; an entry names the
 * repository by session-relative path and the backend that should read it.
 * `"."` addresses the session root. Duplicate paths are rejected so one
 * repository never has two answers.
 *
 * @param value - the raw `backends` value.
 * @returns the accepted preferences.
 */
function readBackends(value: unknown): BackendPreference[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PATHS) {
    throw new VcsError(CONFIG_INVALID, 'Backend preferences must be a list of path and backend pairs.')
  }
  const entries: readonly unknown[] = value
  const seen = new Set<string>()
  return entries.map(entry => {
    if (!isRecord(entry) || Object.keys(entry).some(key => key !== 'path' && key !== 'vcs')) {
      throw new VcsError(CONFIG_INVALID, 'Each backend preference names a path and a backend.')
    }
    const path = validateRepoPath(entry.path)
    const vcs = entry.vcs
    if (path === undefined || typeof vcs !== 'string' || !BACKENDS.has(vcs) || seen.has(path)) {
      throw new VcsError(CONFIG_INVALID, 'Each backend preference names one relative path and a known backend.')
    }
    seen.add(path)
    return { path, vcs }
  })
}

/** Read one configured path list, rejecting absolute and escaping paths. */
function readPathList(value: Record<string, unknown>, key: 'scanDirectories' | 'repositories'): readonly string[] {
  const raw = value[key]
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new VcsError(CONFIG_INVALID, 'Repository configuration paths must be relative to this session directory.')
  }
  const items: readonly unknown[] = raw === undefined ? [] : raw
  if (items.length > MAX_PATHS || !isRelativePaths(items)) {
    throw new VcsError(CONFIG_INVALID, 'Repository configuration paths must be relative to this session directory.')
  }
  return [...new Set(items)]
}

/** Parse the discovery rules object of `.dsh/vcs-panel.json`. */
export function readDiscoveryRules(value: unknown): DiscoveryRules {
  if (!isRecord(value) || Object.keys(value).some(key => !Object.hasOwn(EMPTY_RULES, key))) {
    throw new VcsError(CONFIG_INVALID, 'The repository configuration may only contain discovery rules and backend preferences.')
  }
  return {
    scanDirectories: readPathList(value, 'scanDirectories'),
    repositories: readPathList(value, 'repositories'),
    backends: readBackends(value.backends),
  }
}

/** Resolve the configuration file's target, refusing links and escapes. */
async function configTarget(fs: FileSystem, cwd: FsTarget, signal?: AbortSignal): Promise<FsTarget> {
  const directory = join(fs.processPath(cwd), '.dsh')
  const path = join(directory, 'vcs-panel.json')
  const info = await fs.lstat(directory, {}, signal)
  const file = info?.type === 'directory' ? await fs.lstat(path, {}, signal) : undefined
  // Test the lexical path too: resolving a dangling link may report an absent target.
  if ((info !== undefined && info.type !== 'directory') || file?.type === 'symlink') {
    throw new VcsError('repository-path-unavailable', 'The repository configuration path is unavailable.')
  }
  const target = await fs.resolve(path, { signal })
  if (!fs.contains(cwd, target) || !sameRepoPath(path, fs.processPath(target))) {
    throw new VcsError('repository-path-unavailable', 'The repository configuration path is unavailable.')
  }
  return target
}

/** Read the discovery configuration for one session working directory. */
export async function loadDiscoveryConfig(
  fs: FileSystem,
  cwd: FsTarget,
  signal?: AbortSignal,
): Promise<DiscoveryConfig> {
  let bytes: Uint8Array
  let info: FsInfo | undefined
  try {
    const target = await configTarget(fs, cwd, signal)
    info = await fs.stat(target, signal)
    if (info === undefined) return { rules: EMPTY_RULES, revision: 'absent' }
    if (info.type !== 'file') return { rules: EMPTY_RULES, revision: 'invalid', error: CONFIG_INVALID }
    bytes = await fs.readBytes(target, signal, MAX_BYTES)
    if ((await fs.stat(target, signal))?.version !== info.version) {
      return { rules: EMPTY_RULES, revision: 'invalid', error: 'repository-config-conflict' }
    }
    const revision = createHash('sha256').update(info.version).update('\0').update(bytes).digest('hex')
    const rules = readDiscoveryRules(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    return { rules, revision, version: info.version }
  } catch (error) {
    const failure = failureIdentity(error)
    if (signal?.aborted || failure.name === 'AbortError') throw error
    return {
      rules: EMPTY_RULES,
      revision: 'invalid',
      error: failure.code === 'repository-path-unavailable' ? failure.code : CONFIG_INVALID,
    }
  }
}

/** Write the discovery configuration, guarded by the revision the caller read. */
export async function writeDiscoveryConfig(
  fs: FileSystem,
  cwd: FsTarget,
  current: DiscoveryConfig,
  rules: DiscoveryRules,
  sessionId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const text = `${JSON.stringify({
    scanDirectories: rules.scanDirectories,
    repositories: rules.repositories,
    ...(rules.backends.length === 0 ? {} : { backends: rules.backends }),
  }, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw new VcsError(CONFIG_INVALID, 'The repository configuration exceeds the size limit.')
  }
  const target = await configTarget(fs, cwd, signal)
  const expected: FsWriteIntent = current.version === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: current.version }
  try {
    await fs.writeText(target, text, expected, signal, {
      mode: 'workspace-write', workspaceRoot: fs.processPath(cwd), sessionId: policySessionId(sessionId),
    })
  } catch (error) {
    const failure = failureIdentity(error)
    if (signal?.aborted || failure.name === 'AbortError') throw error
    const code = failure.code
    if (code !== undefined && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_ALREADY_EXISTS'].includes(code)) {
      throw new VcsError('repository-config-conflict', 'The repository configuration changed. Reload it before saving.')
    }
    throw new VcsError('repository-config-write-failed', 'The repository configuration could not be saved.')
  }
}
