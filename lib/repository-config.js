import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { VcsError } from './errors.js'
import { sameRepoPath, validateRelPath } from './paths.js'

const MAX_BYTES = 64 * 1024
const MAX_PATHS = 50
const EMPTY_RULES = Object.freeze({ scanDirectories: Object.freeze([]), repositories: Object.freeze([]) })
const CONFIG_INVALID = 'repository-config-invalid'

export function readDiscoveryRules(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(EMPTY_RULES, key))) {
    throw new VcsError(CONFIG_INVALID, 'The repository configuration must contain scanDirectories and repositories arrays.')
  }
  const paths = key => {
    const items = value[key] === undefined ? [] : value[key]
    if (!Array.isArray(items) || items.length > MAX_PATHS || items.some(path => validateRelPath(path) === undefined)) {
      throw new VcsError(CONFIG_INVALID, 'Repository configuration paths must be relative to this session directory.')
    }
    return [...new Set(items)]
  }
  return { scanDirectories: paths('scanDirectories'), repositories: paths('repositories') }
}

async function configTarget(fs, cwd, signal) {
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

export async function loadDiscoveryConfig(fs, cwd, signal) {
  let bytes
  let info
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
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return {
      rules: EMPTY_RULES,
      revision: 'invalid',
      error: error?.code === 'repository-path-unavailable' ? error.code : CONFIG_INVALID,
    }
  }
}

export async function writeDiscoveryConfig(fs, cwd, current, rules, sessionId, signal) {
  const text = `${JSON.stringify(rules, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw new VcsError(CONFIG_INVALID, 'The repository configuration exceeds the size limit.')
  }
  const target = await configTarget(fs, cwd, signal)
  const expected = current.version === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: current.version }
  try {
    await fs.writeText(target, text, expected, signal, {
      mode: 'workspace-write', workspaceRoot: fs.processPath(cwd), sessionId,
    })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    if (['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_ALREADY_EXISTS'].includes(error?.code)) {
      throw new VcsError('repository-config-conflict', 'The repository configuration changed. Reload it before saving.')
    }
    throw new VcsError('repository-config-write-failed', 'The repository configuration could not be saved.')
  }
}
