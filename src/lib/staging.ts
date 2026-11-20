import { createHash } from 'node:crypto'

import { DIFF_MAX_BYTES, parseUnifiedDiff } from './diff.js'
import type { DiffHunk } from './diff.js'
import { badRequest, outputTooLarge, VcsError } from './errors.js'
import type { IndexTransactionRunner } from './index-transaction.js'
import { redactDetail } from './git-utils.js'
import { isFullSha, validateRelPath } from './paths.js'
import { parsePorcelainV2, STATUS_GROUP_MAX } from './status.js'
import type { StatusBranch, StatusEntry } from './status.js'

/** The scopes one staging request may name. */
export type StagingScope = 'staged' | 'unstaged' | 'untracked'

/** The scopes a request naming several files may take. */
export type StagingFilesScope = 'staged' | 'unstaged'

/** The scopes one staging request may name; see {@link StagingScope}. */
export const STAGING_SCOPES = new Set(['staged', 'unstaged', 'untracked'])

/** Directions a request naming several files may take. */
export const STAGING_FILES_SCOPES = new Set(['staged', 'unstaged'])

/** Most files one request may name: both working-tree status groups at their cap. */
export const STAGING_FILES_MAX = 2 * STATUS_GROUP_MAX

/** One file named in a several-file staging request. */
export interface StagingFileRequest {
  /** The repository-relative path; a directory keeps its trailing slash. */
  path: string
  /** The rename source the working-tree side reported. */
  oldPath?: string
  /** Whether the path names an untracked directory. */
  directory?: true
}

/** One changed line addressed inside a parsed staging patch. */
export interface StagedLineAddress {
  /** The hunk index. */
  hunk: number
  /** The line index inside that hunk. */
  line: number
}

/** One line of a blob as a staging patch indexes it. */
interface IndexedLine {
  /** The line text without its newline. */
  text: string
  /** Whether the line ends with a newline. */
  newline: boolean
}

/** The restricted patch one staged file's comparison produces. */
export interface StagingPatch {
  /** The file mode the patch states. */
  mode: string
  /** Whether the preimage exists. */
  before: boolean
  /** Whether the postimage exists. */
  after: boolean
  /** The parsed hunks. */
  hunks: DiffHunk[]
  /** Line addresses whose line has no final newline. */
  noNewline: Set<string>
  /** The index blob the patch starts from; null when the file is created. */
  sourceOid: string | null
  /** Hash of the comparison this patch was built from. */
  fingerprint: string
}

/** One file's write target, resolved against status. */
export interface StagingTargetRequest {
  scope: StagingScope
  /** The repository-relative path. */
  path: string
  /** The rename source the client echoed, if any. */
  oldPath?: string
}

/** One several-file write target. */
export interface StagingFilesRequest {
  scope: StagingFilesScope
  files: StagingFileRequest[]
}

/** One file's selected lines to stage or unstage. */
export interface StagingSelectionRequest {
  scope: StagingScope
  /** The repository-relative path. */
  path: string
  lines: StagedLineAddress[]
}

/** The branch and index paths one staging write resolved. */
export interface StagingTargetResolution {
  branch: StatusBranch
  paths: string[]
  renamed: boolean
}

/** The branch and index paths one several-file write resolved. */
export interface StagingFilesResolution {
  branch: StatusBranch
  /** Index paths the write updates. */
  paths: string[]
  /** The files those paths belong to. */
  files: string[]
}

/** A stale-comparison failure. */
export function staleDiff(): VcsError {
  return new VcsError('stale-diff', 'This file changed. Refresh its comparison and try again.')
}

/** A refusal for a change this view cannot stage or unstage. */
export function stagingUnsupported(): VcsError {
  return new VcsError('staging-unsupported', 'This change cannot be staged or unstaged with the selected operation.')
}

/**
 * Restrict patch construction to one regular file with no metadata changes.
 * @param raw - one `git diff` output.
 * @param target - the comparison the patch was requested for.
 * @returns the restricted patch, or undefined when the diff is not one regular file.
 */
export function readStagingPatch(
  raw: string,
  { scope, path }: { scope: StagingScope; path: string },
): StagingPatch | undefined {
  const firstHunk = raw.indexOf('\n@@ ')
  if (firstHunk < 0) return undefined
  const header = raw.slice(0, firstHunk).split('\n')
  const beforeHeader = header.at(-2)
  const afterHeader = header.at(-1)
  if (header.length < 4 || header.length > 5 || !header[0].startsWith('diff --git ')
    || beforeHeader === undefined || !beforeHeader.startsWith('--- ')
    || afterHeader === undefined || !afterHeader.startsWith('+++ ')
    || raw.includes('\uFFFD') || raw.includes('\0')) return undefined

  let mode = /^index [\da-f]+\.\.[\da-f]+ (100644|100755)$/u.exec(header[1])?.[1]
  const existence = /^(new|deleted) file mode (100644|100755)$/u.exec(header[1])
  const before = beforeHeader !== '--- /dev/null'
  const after = afterHeader !== '+++ /dev/null'
  if (before && after) {
    if (header.length !== 4 || mode === undefined) return undefined
  } else {
    if (header.length !== 5 || existence === null || existence[1] !== (before ? 'deleted' : 'new')
      || before === after || !/^index [\da-f]+\.\.[\da-f]+$/u.test(header[2])) {
      return undefined
    }
    mode = existence[2]
  }

  const noNewline = new Set<string>()
  const { hunks } = parseUnifiedDiff(raw, (hunk, line) => noNewline.add(`${hunk}:${line}`))
  if (hunks.length === 0 || hunks.some(hunk => (
    hunk.lines.filter(line => line[0] !== '+').length !== hunk.oldLines
    || hunk.lines.filter(line => line[0] !== '-').length !== hunk.newLines
  ))) return undefined
  const indexMatch = /^index ([\da-f]+)\.\.([\da-f]+)/u.exec(header[existence ? 2 : 1])
  if (indexMatch === null) return undefined
  const [, oldOid, newOid] = indexMatch
  const sourceOid = scope === 'staged' ? (after ? newOid : null) : (before ? oldOid : null)
  if (sourceOid !== null && !isFullSha(sourceOid)) return undefined
  return {
    mode, before, after, hunks, noNewline, sourceOid,
    fingerprint: createHash('sha256').update(`${scope}\0${path}\0${raw}`).digest('hex'),
  }
}

/**
 * Anchor the patch at both ends so Git checks the full preimage under its index lock.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - the file and its selected lines.
 * @param patch - the comparison patch.
 * @param signal - cancellation.
 * @returns the patch text to hand Git.
 */
export async function selectedIndexPatch(
  git: IndexTransactionRunner,
  root: string,
  { path, scope, lines }: StagingSelectionRequest,
  patch: StagingPatch,
  signal: AbortSignal,
): Promise<string> {
  const selected = new Set<string>()
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
  const destination: IndexedLine[] = []
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

/**
 * Append one side of the patch, marking a final line without a newline.
 * @param body - the patch lines built so far.
 * @param prefix - the side's `+` or `-`.
 * @param lines - the side's lines.
 */
function appendPatchLines(body: string[], prefix: string, lines: IndexedLine[]): void {
  for (const [index, line] of lines.entries()) {
    body.push(`${prefix}${line.text}`)
    if (!line.newline && index === lines.length - 1) body.push('\\ No newline at end of file')
  }
}

/**
 * Whether the index blob a patch starts from is small enough to reproduce.
 * @param git - command runner.
 * @param root - repository root.
 * @param patch - the comparison patch.
 * @param signal - cancellation.
 * @returns true when the source fits the comparison limit.
 */
export async function stagingSourceFits(
  git: IndexTransactionRunner,
  root: string,
  patch: StagingPatch,
  signal: AbortSignal,
): Promise<boolean> {
  if (patch.sourceOid === null) return true
  const size = await git.run(['cat-file', '-s', patch.sourceOid], { cwd: root, signal })
  return size.exitCode === 0 && /^\d+\n?$/u.test(size.stdout) && Number(size.stdout) <= DIFF_MAX_BYTES
}

/**
 * Read the blob one patch starts from, line by line.
 * @param git - command runner.
 * @param root - repository root.
 * @param oid - the blob id, or null when the file is created.
 * @param signal - cancellation.
 * @returns the blob's lines.
 */
async function readIndexSource(
  git: IndexTransactionRunner,
  root: string,
  oid: string | null,
  signal: AbortSignal,
): Promise<IndexedLine[]> {
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

/**
 * Resolve a write target against status, using both legs of a real rename.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - the requested file.
 * @param signal - cancellation.
 * @returns the branch and the index paths to update.
 */
export async function requireStagingTarget(
  git: IndexTransactionRunner,
  root: string,
  { scope, path, oldPath }: StagingTargetRequest,
  signal: AbortSignal,
): Promise<StagingTargetResolution> {
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
  if (renamed) {
    if (original === undefined) throw stagingUnsupported()
    if (oldPath !== undefined && oldPath !== original) throw staleDiff()
    // A copy keeps its source in the index. A rename changes both paths.
    return { branch, paths: change === 'R' ? [original, path] : [path], renamed }
  }
  if (oldPath !== undefined && oldPath !== original) throw staleDiff()
  return { branch, paths: [path], renamed }
}

/**
 * Resolve the files of one group or folder against a single status read, so
 * they change in one index transaction. Staging accepts tracked working-tree
 * changes, untracked files, and untracked directories, whose files Git lists;
 * unstaging accepts index changes. A rename contributes both of its paths and
 * counts as one file.
 * @param git - command runner.
 * @param root - repository root.
 * @param target - the requested files.
 * @param signal - cancellation.
 * @returns the index paths and the files they belong to.
 */
export async function requireStagingFiles(
  git: IndexTransactionRunner,
  root: string,
  { scope, files }: StagingFilesRequest,
  signal: AbortSignal,
): Promise<StagingFilesResolution> {
  const result = await git.run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'], { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  if (result.exitCode !== 0) throw new VcsError('staging-failed', 'The file status could not be verified.')
  const { branch, entries } = parsePorcelainV2(result.stdout)
  const side = scope === 'staged' ? 'index' : 'worktree'
  const changed = new Map<string, StatusEntry>()
  for (const entry of entries) {
    if (entry[side] !== null) changed.set(entry.path, entry)
  }
  const paths = new Set<string>()
  const resolved = new Set<string>()
  const untracked: StagingFileRequest[] = []
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
    if (change === 'R' && original !== undefined) paths.add(original)
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
 * @param paths - repository-relative file paths.
 * @returns the common directory.
 */
export function commonDirectory(paths: string[]): string {
  const [first, ...rest] = paths.map(path => path.split('/').slice(0, -1))
  if (first === undefined) return ''
  let length = first.length
  for (const parts of rest) {
    let shared = 0
    while (shared < length && parts[shared] === first[shared]) shared += 1
    length = shared
  }
  return length === 0 ? '' : `${first.slice(0, length).join('/')}/`
}

/**
 * Stage exact paths or restore their entries from HEAD, including unborn branches.
 * @param git - command runner.
 * @param root - repository root.
 * @param scope - which side the write targets.
 * @param target - the resolved branch and paths.
 * @param signal - cancellation.
 */
export async function updateIndexFiles(
  git: IndexTransactionRunner,
  root: string,
  scope: StagingScope,
  { branch, paths }: { branch: StatusBranch; paths: string[] },
  signal: AbortSignal,
): Promise<void> {
  if (scope !== 'staged') {
    // Paths go through stdin, so an untracked directory's files never meet the argument limit.
    return writeIndex(git, root, ['update-index', '--add', '--remove', '-z', '--stdin'], signal,
      paths.map(path => `${path}\0`).join(''))
  }
  const originalIndex = await indexSelection(git, root, paths, signal)
  const entries = new Map<string, string>()
  if (!branch.unborn) {
    const oid = branch.oid
    if (oid === null || !isFullSha(oid)) throw staleDiff()
    const result = await git.run(['ls-tree', '-z', oid, '--', ...paths.map(path => `:(literal)${path}`)], {
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

/**
 * Read the current index records for one selection of paths.
 * @param git - command runner.
 * @param root - repository root.
 * @param paths - the repository-relative paths.
 * @param signal - cancellation.
 * @returns the raw `ls-files --stage` output.
 */
async function indexSelection(
  git: IndexTransactionRunner,
  root: string,
  paths: string[],
  signal: AbortSignal,
): Promise<string> {
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

/**
 * Apply one patch to the index only.
 * @param git - command runner.
 * @param root - repository root.
 * @param patch - the patch text.
 * @param signal - cancellation.
 */
export function applyIndexPatch(git: IndexTransactionRunner, root: string, patch: string, signal: AbortSignal): Promise<void> {
  return writeIndex(git, root, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--cached', '--whitespace=nowarn', '-'], signal, patch)
}

/**
 * Run one index write under the transaction's fixed safety flags.
 * @param git - command runner.
 * @param root - repository root.
 * @param args - command argv.
 * @param signal - cancellation.
 * @param stdin - the complete standard input.
 */
async function writeIndex(
  git: IndexTransactionRunner,
  root: string,
  args: string[],
  signal: AbortSignal,
  stdin: string,
): Promise<void> {
  const result = await git.run(['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, signal, stdin })
  if (result.exitCode !== 0) {
    if (/patch does not apply|already exists in index|does not exist in index/iu.test(result.stderr)) throw staleDiff()
    throw new VcsError('staging-failed', 'Git could not update the index for this change.', redactDetail(result.stderr))
  }
}
