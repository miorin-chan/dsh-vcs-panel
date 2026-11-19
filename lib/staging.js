import { createHash } from 'node:crypto'

import { DIFF_MAX_BYTES, parseUnifiedDiff } from './diff.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import { redactDetail } from './git-utils.js'
import { isFullSha, validateRelPath } from './paths.js'
import { parsePorcelainV2, STATUS_GROUP_MAX } from './status.js'

export const STAGING_SCOPES = new Set(['staged', 'unstaged', 'untracked'])

/** Directions a request naming several files may take. */
export const STAGING_FILES_SCOPES = new Set(['staged', 'unstaged'])

/** Most files one request may name: both working-tree status groups at their cap. */
export const STAGING_FILES_MAX = 2 * STATUS_GROUP_MAX

export function staleDiff() {
  return new VcsError('stale-diff', 'This file changed. Refresh its comparison and try again.')
}

export function stagingUnsupported() {
  return new VcsError('staging-unsupported', 'This change cannot be staged or unstaged with the selected operation.')
}

/** Restrict patch construction to one regular file with no metadata changes. */
export function readStagingPatch(raw, { scope, path }) {
  const firstHunk = raw.indexOf('\n@@ ')
  if (firstHunk < 0) return undefined
  const header = raw.slice(0, firstHunk).split('\n')
  if (header.length < 4 || header.length > 5 || !header[0].startsWith('diff --git ')
    || !header.at(-2).startsWith('--- ') || !header.at(-1).startsWith('+++ ')
    || raw.includes('\uFFFD') || raw.includes('\0')) return undefined

  const mode = /^index [\da-f]+\.\.[\da-f]+ (100644|100755)$/u.exec(header[1])?.[1]
  const existence = /^(new|deleted) file mode (100644|100755)$/u.exec(header[1])
  const before = header.at(-2) !== '--- /dev/null'
  const after = header.at(-1) !== '+++ /dev/null'
  if (before && after) {
    if (header.length !== 4 || mode === undefined) return undefined
  } else if (header.length !== 5 || existence?.[1] !== (before ? 'deleted' : 'new')
    || before === after || !/^index [\da-f]+\.\.[\da-f]+$/u.test(header[2])) {
    return undefined
  }

  const noNewline = new Set()
  const { hunks } = parseUnifiedDiff(raw, (hunk, line) => noNewline.add(`${hunk}:${line}`))
  if (hunks.length === 0 || hunks.some(hunk => (
    hunk.lines.filter(line => line[0] !== '+').length !== hunk.oldLines
    || hunk.lines.filter(line => line[0] !== '-').length !== hunk.newLines
  ))) return undefined
  const [, oldOid, newOid] = /^index ([\da-f]+)\.\.([\da-f]+)/u.exec(header[existence ? 2 : 1])
  const sourceOid = scope === 'staged' ? (after ? newOid : null) : (before ? oldOid : null)
  if (sourceOid !== null && !isFullSha(sourceOid)) return undefined
  return {
    mode: mode ?? existence[2], before, after, hunks, noNewline, sourceOid,
    fingerprint: createHash('sha256').update(`${scope}\0${path}\0${raw}`).digest('hex'),
  }
}

/** Anchor the patch at both ends so Git checks the full preimage under its index lock. */
export async function selectedIndexPatch(git, root, { path, scope, lines }, patch, signal) {
  const selected = new Set()
  for (const { hunk, line } of lines) {
    const prefix = patch.hunks[hunk]?.lines[line]?.[0]
    const key = `${hunk}:${line}`
    if ((prefix !== '+' && prefix !== '-') || selected.has(key)) {
      throw badRequest('Each selected line must identify a distinct changed line in the comparison.')
    }
    selected.add(key)
  }

  const reverse = scope === 'staged'
  const sourcePrefix = reverse ? '+' : '-'
  const source = await readIndexSource(git, root, patch.sourceOid, signal)
  const destination = []
  let nextSource = 0
  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    const start = reverse ? hunk.newStart : hunk.oldStart
    const length = reverse ? hunk.newLines : hunk.oldLines
    const offset = start - (length === 0 ? 0 : 1)
    while (nextSource < offset) destination.push(source[nextSource++])
    for (const [lineIndex, line] of hunk.lines.entries()) {
      const key = `${hunkIndex}:${lineIndex}`
      const changedLine = selected.has(key)
      if (line[0] === ' ' || line[0] === sourcePrefix) {
        const original = source[nextSource++]
        if (original?.text !== line.slice(1)) throw staleDiff()
        if (!changedLine) destination.push(original)
      } else if (changedLine) {
        destination.push({ text: line.slice(1), newline: !patch.noNewline.has(key) })
      }
    }
  }
  while (nextSource < source.length) destination.push(source[nextSource++])

  const create = patch.sourceOid === null
  const destinationExists = reverse ? patch.before : patch.after
  const remove = !create && !destinationExists && destination.length === 0
  const sourcePath = JSON.stringify(`a/${path}`)
  const destinationPath = JSON.stringify(`b/${path}`)
  const body = [`diff --git ${sourcePath} ${destinationPath}`]
  if (create) body.push(`new file mode ${patch.mode}`)
  if (remove) body.push(`deleted file mode ${patch.mode}`)
  body.push(`--- ${create ? '/dev/null' : sourcePath}`, `+++ ${remove ? '/dev/null' : destinationPath}`)
  body.push(`@@ -${source.length === 0 ? 0 : 1},${source.length} +${destination.length === 0 ? 0 : 1},${destination.length} @@`)
  appendPatchLines(body, '-', source)
  appendPatchLines(body, '+', destination)
  body.push('')
  return body.join('\n')
}

function appendPatchLines(body, prefix, lines) {
  for (const [index, line] of lines.entries()) {
    body.push(`${prefix}${line.text}`)
    if (!line.newline && index === lines.length - 1) body.push('\\ No newline at end of file')
  }
}

export async function stagingSourceFits(git, root, patch, signal) {
  if (patch.sourceOid === null) return true
  const size = await git.run(['cat-file', '-s', patch.sourceOid], { cwd: root, signal })
  return size.exitCode === 0 && /^\d+\n?$/u.test(size.stdout) && Number(size.stdout) <= DIFF_MAX_BYTES
}

async function readIndexSource(git, root, oid, signal) {
  if (oid === null) return []
  const result = await git.run(['cat-file', 'blob', oid], { cwd: root, signal, maxBytes: DIFF_MAX_BYTES + 1 })
  if (result.exitCode !== 0) throw staleDiff()
  const bytes = Buffer.from(result.stdout, 'utf8')
  if (result.lossy || bytes.length > DIFF_MAX_BYTES || bytes.includes(0)) throw stagingUnsupported()
  const hash = createHash(oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes)
  if (hash.digest('hex') !== oid) throw stagingUnsupported()
  if (result.stdout === '') return []
  const lines = result.stdout.split('\n')
  const finalNewline = lines.at(-1) === ''
  if (finalNewline) lines.pop()
  return lines.map((text, index) => ({ text, newline: finalNewline || index < lines.length - 1 }))
}

/** Resolve a write target against status, using both legs of a real rename. */
export async function requireStagingTarget(git, root, { scope, path, oldPath }, signal) {
  const args = ['status', '--porcelain=v2', '-z', '--branch']
  if (scope === 'untracked') args.push('--untracked-files=all', '--', `:(literal)${path}`)
  else args.push('--untracked-files=no')
  const result = await git.run(args, { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('staging-failed', 'The file status could not be verified.')
  const { branch, entries } = parsePorcelainV2(result.stdout)
  const side = scope === 'staged' ? 'index' : 'worktree'
  const entry = entries.find(item => item.path === path && (scope === 'untracked' ? item.untracked : item[side] !== null))
  if (entry === undefined) throw staleDiff()
  if (entry.conflict) throw stagingUnsupported()
  const change = entry[side]
  const renamed = change === 'R' || change === 'C'
  const original = renamed ? validateRelPath(entry.origPath) : undefined
  if (renamed && original === undefined) throw stagingUnsupported()
  if (oldPath !== undefined && oldPath !== original) throw staleDiff()
  // A copy keeps its source in the index. A rename changes both paths.
  const paths = change === 'R' ? [original, path] : [path]
  return { branch, paths, renamed }
}

/**
 * Resolve the files of one group or folder against a single status read, so
 * they change in one index transaction. Staging accepts tracked working-tree
 * changes, untracked files, and untracked directories, whose files Git lists;
 * unstaging accepts index changes. A rename contributes both of its paths and
 * counts as one file.
 * @returns {Promise<{ branch: object, paths: string[], files: string[] }>} the index paths and the files they belong to.
 */
export async function requireStagingFiles(git, root, { scope, files }, signal) {
  const result = await git.run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('staging-failed', 'The file status could not be verified.')
  const { branch, entries } = parsePorcelainV2(result.stdout)
  const side = scope === 'staged' ? 'index' : 'worktree'
  const changed = new Map(entries.filter(entry => entry[side] !== null).map(entry => [entry.path, entry]))
  const paths = new Set()
  const resolved = new Set()
  const untracked = []
  for (const file of files) {
    const entry = file.directory ? undefined : changed.get(file.path)
    if (entry === undefined) {
      if (scope === 'staged' || file.oldPath !== undefined) throw staleDiff()
      untracked.push(file)
      continue
    }
    if (entry.conflict) throw stagingUnsupported()
    const change = entry[side]
    const renamed = change === 'R' || change === 'C'
    const original = renamed ? validateRelPath(entry.origPath) : undefined
    if (renamed && original === undefined) throw stagingUnsupported()
    if (file.oldPath !== undefined && file.oldPath !== original) throw staleDiff()
    if (change === 'R') paths.add(original)
    paths.add(entry.path)
    resolved.add(entry.path)
  }
  if (untracked.length > 0) {
    const listed = await git.run(['ls-files', '--others', '--exclude-standard', '-z', '--',
      ...untracked.map(file => `:(literal)${file.path}${file.directory ? '/' : ''}`)], { cwd: root, signal })
    if (listed.lossy) throw outputTooLarge()
    if (listed.exitCode !== 0) throw new VcsError('staging-failed', 'The untracked files could not be listed.')
    const found = listed.stdout.split('\0').filter(path => path !== '')
    // Git lists an untracked nested repository as a directory and would add it as a gitlink.
    if (found.some(path => path.endsWith('/'))) throw stagingUnsupported()
    for (const file of untracked) {
      const matches = file.directory
        ? found.filter(path => path.startsWith(`${file.path}/`))
        : found.filter(path => path === file.path)
      if (matches.length === 0) throw staleDiff()
      for (const path of matches) {
        paths.add(path)
        resolved.add(path)
      }
    }
  }
  return { branch, paths: [...paths], files: [...resolved] }
}

/**
 * The deepest directory containing every path, with a trailing slash, or the
 * empty string at the repository root.
 * @param {string[]} paths - repository-relative file paths.
 * @returns {string} the common directory.
 */
export function commonDirectory(paths) {
  const [first, ...rest] = paths.map(path => path.split('/').slice(0, -1))
  let length = first?.length ?? 0
  for (const parts of rest) {
    let shared = 0
    while (shared < length && parts[shared] === first[shared]) shared += 1
    length = shared
  }
  return length === 0 ? '' : `${first.slice(0, length).join('/')}/`
}

/** Stage exact paths or restore their entries from HEAD, including unborn branches. */
export async function updateIndexFiles(git, root, scope, { branch, paths }, signal) {
  if (scope !== 'staged') {
    // Paths go through stdin, so an untracked directory's files never meet the argument limit.
    return writeIndex(git, root, ['update-index', '--add', '--remove', '-z', '--stdin'], signal,
      paths.map(path => `${path}\0`).join(''))
  }
  const originalIndex = await indexSelection(git, root, paths, signal)
  const entries = new Map()
  if (!branch.unborn) {
    if (!isFullSha(branch.oid)) throw staleDiff()
    const result = await git.run(['ls-tree', '-z', branch.oid, '--', ...paths.map(path => `:(literal)${path}`)], {
      cwd: root, signal,
    })
    if (result.lossy) throw outputTooLarge()
    if (result.exitCode !== 0) throw new VcsError('staging-failed', 'The committed file could not be read.')
    for (const record of result.stdout.split('\0')) {
      if (record === '') continue
      const match = /^(100644|100755|120000|160000) (?:blob|commit) ([\da-f]+)\t(.*)$/u.exec(record)
      if (match === null || !isFullSha(match[2]) || !paths.includes(match[3])) throw stagingUnsupported()
      entries.set(match[3], `${match[1]} ${match[2]}`)
    }
  }
  let hashLength = branch.oid?.length
  if (hashLength === undefined) {
    const result = await git.run(['rev-parse', '--show-object-format'], { cwd: root, signal })
    const format = result.stdout.trim()
    if (result.exitCode !== 0 || (format !== 'sha1' && format !== 'sha256')) {
      throw new VcsError('staging-failed', 'The repository object format could not be read.')
    }
    hashLength = format === 'sha256' ? 64 : 40
  }
  const zero = '0'.repeat(hashLength)
  // Remove the target entries first, so a rename restores both legs atomically.
  const records = paths.map(path => `0 ${zero}\t${path}\0`)
  for (const [path, info] of entries) records.push(`${info}\t${path}\0`)
  const [currentIndex, head] = await Promise.all([
    indexSelection(git, root, paths, signal),
    git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, signal }),
  ])
  const currentHead = head.exitCode === 0 ? head.stdout.trim() : null
  if (head.lossy || currentIndex !== originalIndex || currentHead !== branch.oid) throw staleDiff()
  return writeIndex(git, root, ['update-index', '-z', '--index-info'], signal, records.join(''))
}

async function indexSelection(git, root, paths, signal) {
  const result = await git.run(['ls-files', '--stage', '-z', '--', ...paths.map(path => `:(literal)${path}`)], {
    cwd: root, signal,
  })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('staging-failed', 'The current index could not be read.')
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab < 0 || record[tab - 1] !== '0' || !paths.includes(record.slice(tab + 1))) throw stagingUnsupported()
  }
  return result.stdout
}

export function applyIndexPatch(git, root, patch, signal) {
  return writeIndex(git, root, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--cached', '--whitespace=nowarn', '-'], signal, patch)
}

async function writeIndex(git, root, args, signal, stdin) {
  const result = await git.run(['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, signal, stdin })
  if (result.exitCode !== 0) {
    if (/patch does not apply|already exists in index|does not exist in index/iu.test(result.stderr)) throw staleDiff()
    throw new VcsError('staging-failed', 'Git could not update the index for this change.', redactDetail(result.stderr))
  }
}
