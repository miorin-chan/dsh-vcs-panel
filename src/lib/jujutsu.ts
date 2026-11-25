/**
 * Jujutsu command output: one template language, one JSON record per line.
 *
 * Jujutsu has no porcelain mode designed for machine consumption, but its
 * template language serializes values as JSON. Each command therefore emits
 * one self-contained JSON object per line, and this module is the only place
 * that knows the field names.
 */

import type { Context } from '@deepseek-ai/cordis'

import { CommandRunner } from './command.js'
import type { CommitNode, VcsRef } from './log.js'
import { isFullSha } from './paths.js'
import type { FileEntry } from './status.js'

/** One decoded template record: its fields are the template's own names. */
export type JjRecord = Record<string, unknown>

/** One ref a commit record carries. */
export interface JjRef extends VcsRef {
  /** Which list the ref came from. */
  kind: 'bookmark' | 'remote' | 'tag'
  /** A conflicted bookmark, marked rather than hidden. */
  conflict?: true
}

/** One parsed commit record, from the log or detail template. */
export interface JjCommit extends CommitNode {
  /** Local, remote, and tag refs pointing at this commit. */
  refs: JjRef[]
  /** True for the working-copy commit. */
  workingCopy: boolean
  /** True when the commit changes nothing. */
  empty: boolean
  /** True when the commit has unresolved conflicts. */
  conflict: boolean
}

/** Per-file line counts the detail template reports. */
export interface JjStats {
  /** Lines added. */
  added: number
  /** Lines removed. */
  removed: number
  /** Jujutsu's status letter. */
  status: string
}

/** One changed-file entry the diff template reports. */
export interface JjEntry {
  /** Target path. */
  path: string
  /** Source path for a rename or copy. */
  source?: string
  /** Jujutsu's status letter. */
  status: string
  /** The target's file type, when the template reported one. */
  fileType: string
  /** True when the entry has unresolved conflicts. */
  conflict: boolean
}

/** Whether a decoded value has the record shape templates produce. */
function isRecord(value: unknown): value is JjRecord {
  return value !== null && typeof value === 'object'
}

/** Root commit id: every Jujutsu repository has the same empty root. */
const ZERO_SHA = '0'.repeat(40)

/** A Jujutsu template fragment that emits one JSON object followed by a newline. */
const NEWLINE = '\\n'

/**
 * Ref fields shared by every commit record.
 *
 * Local bookmarks, tracked/untracked remote bookmarks, and tags stay separate
 * here because they mean different things to the reader; the client decides
 * how many badges a row can hold.
 */
const REF_FIELDS = [
  '"localBookmarks" => local_bookmarks.map(|b| json({"name" => b.name(), "conflict" => b.conflict()}))',
  '"remoteBookmarks" => remote_bookmarks.map(|b| json({"name" => b.name(), "remote" => b.remote(), "tracked" => b.tracked()}))',
  '"tags" => tags.map(|b| json({"name" => b.name(), "remote" => b.remote()}))',
].join(', ')

/** Fields every timeline row needs. */
const COMMIT_FIELDS = [
  '"sha" => commit_id',
  '"changeId" => change_id.short()',
  '"parents" => parents.map(|p| p.commit_id())',
  '"author" => author.name()',
  '"authorTime" => author.timestamp().format("%s")',
  '"subject" => description.first_line()',
  '"workingCopy" => current_working_copy',
  '"empty" => empty',
  '"conflict" => conflict',
].join(', ')

/** Fields only the selected node's detail needs. */
const COMMITTER_TIME = '"committerTime" => committer.timestamp().format("%s")'
const DETAIL_FIELDS = [
  '"description" => description',
  '"committer" => committer.name()',
  COMMITTER_TIME,
].join(', ')

/** Per-file line counts and the node totals. */
const STAT_FIELDS = [
  '"changed" => diff.stat().files().len()',
  '"added" => diff.stat().total_added()',
  '"deleted" => diff.stat().total_removed()',
  '"stats" => diff.stat().files().map(|f| json({"path" => f.path(), "added" => f.lines_added(), "removed" => f.lines_removed(), "status" => f.status_char()}))',
].join(', ')

/** One commit row per line; no patch, no per-file stats. */
export const JJ_LOG_TEMPLATE = `json({${COMMIT_FIELDS}, ${REF_FIELDS}}) ++ "${NEWLINE}"`

/** The same history row, with its activity ordering time. */
export const JJ_ACTIVITY_TEMPLATE = `json({${COMMIT_FIELDS}, ${REF_FIELDS}, ${COMMITTER_TIME}}) ++ "${NEWLINE}"`

/** One commit with its description and per-file stats; used by status and detail. */
export const JJ_DETAIL_TEMPLATE = `json({${COMMIT_FIELDS}, ${DETAIL_FIELDS}, ${STAT_FIELDS}, ${REF_FIELDS}}) ++ "${NEWLINE}"`

/** One changed file per line, with its source path for renames and copies. */
export const JJ_DIFF_ENTRY_TEMPLATE = [
  'json({',
  '"path" => self.target().path(),',
  '"source" => self.source().path(),',
  '"status" => self.status_char(),',
  '"fileType" => self.target().file_type(),',
  '"conflict" => self.target().conflict()',
  `}) ++ "${NEWLINE}"`,
].join(' ')

/** Resolve the working-copy commit id; running this also snapshots the working copy. */
export const JJ_SNAPSHOT_TEMPLATE = 'commit_id'

/**
 * The runner for `jj`.
 *
 * `--color=never` and `--no-pager` are fixed argv; reads add
 * `--ignore-working-copy` themselves so only the explicit snapshot command
 * writes the working-copy commit.
 */
export class JujutsuRunner extends CommandRunner {
  /**
   * @param ctx - Host context carrying the subprocess capability.
   */
  constructor(ctx: Context) {
    super(ctx, {
      command: 'jj',
      args: ['--color=never', '--no-pager'],
      env: {
        // No terminal prompt or pager can be triggered from a query string.
        JJ_EDITOR: 'true',
      },
    })
  }
}

/**
 * Parse a timestamp Jujutsu formatted as epoch seconds.
 * @param value - the formatted value.
 * @returns epoch milliseconds, or NaN.
 */
function seconds(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return Number.NaN
  return Number(value) * 1000
}

/**
 * Parse the JSON strings Jujutsu's template language produces for a list.
 * @param values - the list of JSON strings.
 * @returns the decoded records, skipping any this version cannot read.
 */
function parseJsonList(values: unknown): JjRecord[] {
  if (!Array.isArray(values)) return []
  const parsed: JjRecord[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    try {
      const record: unknown = JSON.parse(value)
      if (isRecord(record)) parsed.push(record)
    } catch {
      // A record this version cannot read is skipped, not fatal.
    }
  }
  return parsed
}

/**
 * Turn the three Jujutsu ref lists into the panel's ref shape.
 *
 * Local bookmarks and tags keep their names. Remote refs are written
 * `name@remote`, matching Jujutsu's own display, because two remotes may point
 * at the same commit.
 * @param record - one decoded commit record.
 * @returns the refs.
 */
export function parseJjRefs(record: JjRecord): JjRef[] {
  const refs: JjRef[] = []
  for (const bookmark of parseJsonList(record.localBookmarks)) {
    if (typeof bookmark.name !== 'string' || bookmark.name === '') continue
    refs.push({
      name: bookmark.name,
      kind: 'bookmark',
      ...(bookmark.conflict === true ? { conflict: true } : {}),
    })
  }
  for (const bookmark of parseJsonList(record.remoteBookmarks)) {
    if (typeof bookmark.name !== 'string' || bookmark.name === '') continue
    const name = typeof bookmark.remote === 'string' && bookmark.remote !== ''
      ? `${bookmark.name}@${bookmark.remote}`
      : bookmark.name
    refs.push({
      name,
      kind: 'remote',
      ...(bookmark.conflict === true ? { conflict: true } : {}),
    })
  }
  for (const tag of parseJsonList(record.tags)) {
    if (typeof tag.name !== 'string' || tag.name === '') continue
    const name = typeof tag.remote === 'string' && tag.remote !== ''
      ? `${tag.name}@${tag.remote}`
      : tag.name
    refs.push({ name, kind: 'tag' })
  }
  return refs
}

/**
 * Parse one decoded commit record into a timeline node.
 * @param record - one decoded JSON object.
 * @returns the commit, or undefined for a malformed record.
 */
export function parseJjCommit(record: unknown): JjCommit | undefined {
  if (!isRecord(record)) return undefined
  if (!isFullSha(record.sha)) return undefined
  const parents = Array.isArray(record.parents)
    ? record.parents.filter((parent): parent is string => isFullSha(parent) && parent !== ZERO_SHA)
    : []
  const commit: JjCommit = {
    sha: record.sha,
    changeId: typeof record.changeId === 'string' ? record.changeId : undefined,
    parents,
    refs: parseJjRefs(record),
    author: typeof record.author === 'string' ? record.author : '',
    authorTime: seconds(record.authorTime),
    subject: typeof record.subject === 'string' ? record.subject : '',
    workingCopy: record.workingCopy === true,
    empty: record.empty === true,
    conflict: record.conflict === true,
  }
  if (typeof record.committer === 'string') commit.committer = record.committer
  if (record.committerTime !== undefined) commit.committerTime = seconds(record.committerTime)
  if (typeof record.description === 'string') commit.message = record.description.replace(/\n+$/u, '')
  return commit
}

/**
 * Parse the per-file stats list a detail template emits.
 * @param values - the list of JSON strings.
 * @returns stats by target path.
 */
export function parseJjStats(values: unknown): Map<string, JjStats> {
  const stats = new Map<string, JjStats>()
  for (const entry of parseJsonList(values)) {
    if (typeof entry.path !== 'string' || entry.path === '') continue
    stats.set(entry.path, {
      added: typeof entry.added === 'number' && Number.isInteger(entry.added) ? entry.added : 0,
      removed: typeof entry.removed === 'number' && Number.isInteger(entry.removed) ? entry.removed : 0,
      status: typeof entry.status === 'string' ? entry.status : 'M',
    })
  }
  return stats
}

/**
 * Parse one changed-file record.
 * @param record - one decoded JSON object.
 * @returns the entry, or undefined when malformed.
 */
export function parseJjEntry(record: unknown): JjEntry | undefined {
  if (!isRecord(record)) return undefined
  if (typeof record.path !== 'string' || record.path === '') return undefined
  const status = typeof record.status === 'string' && record.status !== '' ? record.status : 'M'
  return {
    path: record.path,
    source: typeof record.source === 'string' && record.source !== '' ? record.source : undefined,
    status,
    fileType: typeof record.fileType === 'string' ? record.fileType : '',
    conflict: record.conflict === true,
  }
}

/**
 * Pair changed-file entries with their line counts.
 * @param entries - parsed entries.
 * @param stats - counts by target path.
 * @returns the view's FileEntry rows.
 */
export function mergeJjFiles(entries: JjEntry[], stats: Map<string, JjStats>): FileEntry[] {
  return entries.map(entry => {
    const measured = stats.get(entry.path)
    const status = entry.conflict ? 'U' : entry.status
    const renamed = (status === 'R' || status === 'C') && entry.source !== undefined && entry.source !== entry.path
    return {
      path: entry.path,
      status,
      ...(renamed ? { origPath: entry.source } : {}),
      added: measured?.added ?? 0,
      deleted: measured?.removed ?? 0,
      binary: false,
      ...(entry.conflict ? { conflict: true } : {}),
    }
  })
}

/**
 * Escape one repository-relative path as a Jujutsu `file:` fileset.
 *
 * The path is passed as its own argv element (no shell), so only the fileset's
 * string literal needs escaping. Backslashes and control characters were
 * already rejected by `validateRelPath`.
 * @param path - validated repository-relative path.
 * @returns the exact-path fileset.
 */
export function jjFilePattern(path: string): string {
  return `file:"${path.replace(/"/gu, '\\"')}"`
}

/**
 * Whether a Jujutsu `--git` patch carries binary content.
 *
 * Jujutsu prints binary files as a textual patch with the raw bytes rather
 * than a "Binary files differ" marker like git. Undecodable bytes arrive as
 * U+FFFD and a NUL byte survives decoding, so either means this is not text
 * the view can render.
 * @param text - the diff output.
 * @returns true when the comparison is binary.
 */
export function isJjBinaryDiff(text: string): boolean {
  return text.includes('\u0000') || text.includes('\uFFFD') || /^Binary files .* differ$/mu.test(text)
}

/**
 * Split template output into decoded JSON records.
 * @param text - newline-separated JSON objects.
 * @returns the records.
 */
export function parseJjRecords(text: string): JjRecord[] {
  const records: JjRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) records.push(value)
    } catch {
      // Skip a record this version cannot read.
    }
  }
  return records
}
