/**
 * Input shapes the routes accept: repository-relative file paths, repository
 * queries, and commit ids.
 *
 * Every value here becomes an argument to git or to the filesystem, so each
 * check is deliberately narrower than "it parses": a path must be provably
 * inside the repository, and a commit id must be hexadecimal before git is
 * asked to resolve it.
 */

import { resolve as resolvePath } from 'node:path'

/** The empty tree every SHA-1 repository shares; a root commit diffs against it. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Control characters (including NUL) never belong in a path we hand to git. */
const CONTROL = /[\u0000-\u001f\u007f]/u

/** A Windows drive prefix would escape a POSIX-relative path. */
const DRIVE_PREFIX = /^[A-Za-z]:/u

/** A full object id: 40 hex characters for SHA-1, 64 for SHA-256. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** What the client may send as an abbreviated commit id. */
const INPUT_SHA = /^[0-9a-fA-F]{7,64}$/u

/**
 * Accept one repository-relative file path.
 *
 * Rejects absolute paths, backslashes, empty segments, `.` and `..` segments,
 * a leading `-`, and control characters or NUL. The result is POSIX-shaped:
 * git always reports repository paths with `/`, whatever the host separator is.
 *
 * @param {unknown} value - the requested path.
 * @returns {string | undefined} the accepted path, or undefined.
 */
export function validateRelPath(value) {
  if (typeof value !== 'string' || value === '') return undefined
  if (value.includes('\\')) return undefined
  if (value.startsWith('-')) return undefined
  if (value.startsWith('/') || DRIVE_PREFIX.test(value)) return undefined
  if (CONTROL.test(value)) return undefined
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  return parts.join('/')
}

/**
 * Accept one session-relative repository path.
 *
 * `"."` names the session root itself, which is how a preference can address
 * the repository the Session opens in. Every other value is a resource path
 * below that root.
 *
 * @param {unknown} value - the requested repository path.
 * @returns {string | undefined} the accepted path, or undefined.
 */
export function validateRepoPath(value) {
  return value === '.' ? '.' : validateRelPath(value)
}

/**
 * Accept one abbreviated or full commit id.
 * @param {unknown} value - the requested id.
 * @returns {string | undefined} the lower-cased id, or undefined.
 */
export function validateSha(value) {
  if (typeof value !== 'string' || !INPUT_SHA.test(value)) return undefined
  return value.toLowerCase()
}

/**
 * Whether a string is a full object id, as git prints one.
 * @param {unknown} value - the value to check.
 * @returns {boolean} true for 40 or 64 hex characters.
 */
export function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA.test(value)
}

/**
 * Compare a repository path the client echoed with one discovery offered.
 *
 * Both sides name absolute directories; the comparison folds separators and a
 * trailing separator, and folds case only where the platform does.
 *
 * @param {string} a - one absolute path.
 * @param {string} b - another absolute path.
 * @returns {boolean} true when both name the same directory.
 */
export function sameRepoPath(a, b) {
  const fold = value => resolvePath(value, '.').replace(/[\\/]+$/, '')
  if (process.platform === 'win32') return fold(a).toLowerCase() === fold(b).toLowerCase()
  return fold(a) === fold(b)
}

/**
 * The last segment of an absolute directory path, for the repository selector.
 * @param {string} path - absolute repository root.
 * @returns {string} its directory name.
 */
export function repositoryName(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const name = trimmed.split(/[\\/]/).pop()
  return name === undefined || name === '' ? path : name
}
