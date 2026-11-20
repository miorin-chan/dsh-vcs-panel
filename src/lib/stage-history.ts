import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { GitRunner } from './git.js'
import { withIndexTransaction, historyState, sameHead, stageHistoryError } from './index-transaction.js'
import type {
  IndexEntry,
  IndexHead,
  IndexState,
  IndexTransactionRunner,
} from './index-transaction.js'
import { commonDirectory } from './staging.js'
import type { StagedLineAddress, StagingScope } from './staging.js'

const MAX_PER_TREE = 32
const MAX_HISTORY_BYTES = 1024 * 1024
const RESTORABLE_MODES = new Set(['100644', '100755', '120000'])

/** One staging write, as the undo and redo controls name it. */
export interface StageSummary {
  /** The history entry's identifier. */
  id: string
  /** The scope the write changed. */
  scope: StagingScope
  /** The file, or the common folder of several files. */
  path: string
  /** How many files the write changed, for a several-file write. */
  fileCount?: number
  /** How many lines the write changed, for a selected-line write. */
  lineCount?: number
}

/** The undo and redo entries currently available for one repository. */
export interface StageHistoryTips {
  undo: StageSummary | null
  redo: StageSummary | null
}

/** The answer a staging write returns to the route. */
export interface StageResult {
  scope: StagingScope
  path: string
  fileCount?: number
}

/** The answer a staging history replay returns to the route. */
export interface StageReplayResult {
  action: 'undo' | 'redo'
  stageHistory: StageHistoryTips
}

/** The route's validated staging target, as the history names it. */
export interface StagingWriteTarget {
  scope: StagingScope
  /** The one file a single-file write names. */
  path?: string
  /** The selected lines a single-file write names. */
  lines?: StagedLineAddress[]
}

/** One entry's before and after state across a staged change. */
interface EntryChange {
  path: string
  before: IndexEntry | null
  after: IndexEntry | null
}

/** One recorded staging write. */
interface HistoryRecord {
  summary: StageSummary
  changes: EntryChange[]
  bytes: number
  order: number
}

/** The in-memory history of one repository. */
interface TreeHistory {
  identity: string
  head: IndexHead
  records: HistoryRecord[]
  cursor: number
}

/** No history exists for a repository the panel has not staged in. */
export const EMPTY_STAGE_HISTORY: StageHistoryTips = Object.freeze({ undo: null, redo: null })

/**
 * Whether two index entries are the same semantic entry.
 * @param a - one entry, or null for an absent path.
 * @param b - another entry, or null.
 * @returns true when both name the same object, mode, stage, and flags.
 */
function entryEquals(a: IndexEntry | null, b: IndexEntry | null): boolean {
  return a === b || (a != null && b != null && a.oid === b.oid && a.mode === b.mode
    && a.stage === b.stage && a.flags === b.flags)
}

/**
 * Whether one path still holds the expected entry.
 * @param entries - the index entries to check.
 * @param path - the path to check.
 * @param expected - the expected entry, or null for absent.
 * @returns true when the path matches.
 */
function entryMatches(entries: Map<string, IndexEntry>, path: string, expected: IndexEntry | null): boolean {
  return entryEquals(entries.get(path) ?? null, expected)
}

/**
 * Whether two index reads share every entry.
 * @param before - one read.
 * @param after - another read.
 * @returns true when both have the same paths and entries.
 */
function sameEntries(before: Map<string, IndexEntry>, after: Map<string, IndexEntry>): boolean {
  if (before.size !== after.size) return false
  for (const [path, entry] of before) {
    if (!entryMatches(after, path, entry)) return false
  }
  return true
}

/**
 * Whether a recorded history still describes the current repository state.
 * @param history - the recorded history.
 * @param state - the current index and HEAD state.
 * @returns true when the history can be replayed.
 */
function stillMatches(history: TreeHistory, state: IndexState): boolean {
  if (history.identity !== state.identity || !sameHead(history.head, state.head)) return false
  const expected = new Map<string, IndexEntry | null>()
  for (const [index, record] of history.records.entries()) {
    for (const { path, before, after } of record.changes) {
      if (index < history.cursor || !expected.has(path)) {
        expected.set(path, index < history.cursor ? after : before)
      }
    }
  }
  return [...expected].every(([path, entry]) => entryMatches(state.entries, path, entry))
}

/**
 * Whether one entry can be recreated by `--index-info` without losing flags.
 * @param entry - the entry, or null for an absent path.
 * @returns true when the history may record it.
 */
function supported(entry: IndexEntry | null): boolean {
  // Only plain blobs can be recreated by --index-info without losing flags.
  // Gitlinks identify objects that can legitimately be absent from this repo.
  return entry === null || (entry.stage === 0 && entry.flags === 0 && RESTORABLE_MODES.has(entry.mode))
}

/**
 * What one staging write did, as the undo and redo controls name it: a file
 * with its selected line count, or the common folder of several files.
 * @param target - the write's target.
 * @param files - the resolved files of a several-file write.
 * @returns the description the history records.
 */
function describe(target: StagingWriteTarget, files?: string[]): Omit<StageSummary, 'id'> {
  if (files === undefined) {
    // Only a single-file target reaches this branch, and the route always
    // supplies its path.
    return {
      scope: target.scope,
      path: target.path ?? '',
      ...(target.lines && { lineCount: target.lines.length }),
    }
  }
  if (files.length === 1) return { scope: target.scope, path: files[0] }
  return { scope: target.scope, path: commonDirectory(files), fileCount: files.length }
}

/**
 * The entries that changed under the write's paths.
 * @param before - the index before the write.
 * @param after - the index after the write.
 * @param paths - the paths the write touched.
 * @returns every changed entry.
 */
function changesAt(
  before: Map<string, IndexEntry>,
  after: Map<string, IndexEntry>,
  paths: string[],
): EntryChange[] {
  const changes: EntryChange[] = []
  for (const path of paths) {
    const oldEntry = before.get(path) ?? null
    const newEntry = after.get(path) ?? null
    if (!entryEquals(oldEntry, newEntry)) changes.push({ path, before: oldEntry, after: newEntry })
  }
  return changes
}

/**
 * Refuse to record a write that changed an entry outside its paths.
 * @param before - the index before the write.
 * @param after - the index after the write.
 * @param paths - the paths the write was allowed to touch.
 */
function assertOnlyPathsChanged(before: Map<string, IndexEntry>, after: Map<string, IndexEntry>, paths: string[]): void {
  for (const [current, other] of [[before, after], [after, before]]) {
    for (const [path, entry] of current) {
      if (!paths.includes(path) && !entryMatches(other, path, entry)) throw stageHistoryError('stale')
    }
  }
}

/**
 * Write the wanted entries back into the scratch index.
 * @param git - the transaction's Git runner.
 * @param root - repository root.
 * @param changes - the entries to restore.
 * @param direction - which side to restore.
 * @param head - the HEAD state the history was recorded against.
 * @param signal - cancellation.
 */
async function restoreEntries(
  git: IndexTransactionRunner,
  root: string,
  changes: EntryChange[],
  direction: 'before' | 'after',
  head: IndexHead,
  signal: AbortSignal,
): Promise<void> {
  const wanted: [string, 'blob' | 'commit'][] = []
  for (const change of changes) {
    const entry = change[direction]
    if (entry !== null) wanted.push([entry.oid, 'blob'])
  }
  if (head.oid !== null) wanted.push([head.oid, 'commit'])
  if (wanted.length > 0) {
    const result = await git.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      cwd: root, signal, stdin: `${wanted.map(([oid]) => oid).join('\n')}\n`,
    })
    if (result.lossy || result.exitCode !== 0 || result.stdout !== wanted.map(([oid, type]) => `${oid} ${type}\n`).join('')) {
      throw stageHistoryError('unavailable')
    }
  }
  // A recorded change never has both sides absent, so its oid fixes the hash width.
  const first = changes[0].before ?? changes[0].after
  const zero = '0'.repeat(first === null ? 0 : first.oid.length)
  const records = changes.map(({ path }) => `0 ${zero}\t${path}\0`)
  for (const change of changes) {
    const entry = change[direction]
    if (entry !== null) records.push(`${entry.mode} ${entry.oid}\t${change.path}\0`)
  }
  const result = await git.run(['update-index', '-z', '--index-info'], { cwd: root, signal, stdin: records.join('') })
  if (result.exitCode !== 0) throw stageHistoryError('unavailable')
}

/** In-memory history for the lifetime of one Git backend. A record stores only changed entries. */
export class StageHistory {
  readonly ctx: import('@deepseek-ai/cordis').Context
  readonly git: import('./git.js').GitRunner
  #trees = new Map<string, TreeHistory>()
  #bytes = 0
  #sequence = 0
  #replaying = new Set<string>()

  constructor(ctx: import('@deepseek-ai/cordis').Context, git: import('./git.js').GitRunner) {
    this.ctx = ctx
    this.git = git
  }

  /**
   * The undo and redo entries available for one repository.
   * @param root - repository root.
   * @returns the two tips.
   */
  tips(root: string): StageHistoryTips {
    const history = this.#trees.get(root)
    if (history === undefined) return EMPTY_STAGE_HISTORY
    return {
      undo: history.records[history.cursor - 1]?.summary ?? null,
      redo: history.records[history.cursor]?.summary ?? null,
    }
  }

  /**
   * Drop one repository's history.
   * @param root - repository root.
   */
  #clear(root: string): void {
    const history = this.#trees.get(root)
    if (history === undefined) return
    for (const record of history.records) this.#bytes -= record.bytes
    this.#trees.delete(root)
  }

  /**
   * Drop the oldest record of one history.
   * @param root - repository root.
   * @param history - the history to trim.
   */
  #dropOldest(root: string, history: TreeHistory): void {
    const [oldest] = history.records.splice(0, 1)
    this.#bytes -= oldest.bytes
    history.cursor = Math.max(0, history.cursor - 1)
    if (history.records.length === 0) this.#trees.delete(root)
  }

  /**
   * Record one write, dropping the redo tail and trimming the oldest entries.
   * @param root - repository root.
   * @param state - the index and HEAD state the write saw.
   * @param description - what the write did.
   * @param changes - the entries it changed.
   */
  #add(root: string, state: IndexState, description: Omit<StageSummary, 'id'>, changes: EntryChange[]): void {
    let history = this.#trees.get(root)
    if (history !== undefined && !stillMatches(history, state)) {
      this.#clear(root)
      history = undefined
    }
    if (history === undefined) {
      history = { identity: state.identity, head: state.head, records: [], cursor: 0 }
      this.#trees.set(root, history)
    }
    for (const obsolete of history.records.splice(history.cursor)) this.#bytes -= obsolete.bytes
    const summary: StageSummary = { id: randomUUID(), ...description }
    // Charge for per-record overhead, identifiers, and UTF-16 strings.
    const bytes = 512 + (description.path.length + state.identity.length + JSON.stringify(changes).length
      + (state.head.ref?.length ?? 0)) * 2
    history.records.push({ summary, changes, bytes, order: ++this.#sequence })
    history.cursor += 1
    this.#bytes += bytes
    if (history.records.length > MAX_PER_TREE) this.#dropOldest(root, history)
    while (this.#bytes > MAX_HISTORY_BYTES) {
      // #add never runs during a replay, so a tree that can be trimmed exists.
      const trimmable = [...this.#trees].filter(([treeRoot]) => !this.#replaying.has(treeRoot))
      const oldest = trimmable.reduce((best, pair) => (
        pair[1].records[0].order < best[1].records[0].order ? pair : best
      ))
      // If the oldest entry is undone, the rest of its redo chain depends on it.
      if (oldest[1].cursor === 0) this.#clear(oldest[0])
      else this.#dropOldest(...oldest)
    }
  }

  /**
   * Run one staging write inside a transaction and record it.
   * @param root - repository root.
   * @param target - the validated target.
   * @param signal - cancellation.
   * @param apply - performs the index write and reports the resolved paths.
   * @returns the answer the route sends.
   */
  async stage(
    root: string,
    target: StagingWriteTarget,
    signal: AbortSignal,
    apply: (git: IndexTransactionRunner, head: IndexHead) => Promise<{ paths: string[]; files?: string[] }>,
  ): Promise<StageResult> {
    return withIndexTransaction(this.ctx, this.git, root, signal, async transaction => {
      const { paths, files } = await apply(transaction.git, transaction.state.head)
      const description = describe(target, files)
      const after = await transaction.readIndex()
      assertOnlyPathsChanged(transaction.state.entries, after, paths)
      const changes = changesAt(transaction.state.entries, after, paths)
      if (changes.length > 0) {
        await transaction.publish()
        if (transaction.canRecord && changes.every(({ before, after }) => supported(before) && supported(after))) {
          this.#add(root, transaction.state, description, changes)
        } else {
          this.#clear(root)
        }
      }
      const { lineCount, ...result } = description
      return result
    }, { staging: true })
  }

  /**
   * Replay one undo or redo entry inside a transaction.
   * @param root - repository root.
   * @param request - the entry to replay and the direction.
   * @param signal - cancellation.
   * @returns the action and the new tips.
   */
  async replay(
    root: string,
    { action, id }: { action: 'undo' | 'redo'; id: string },
    signal: AbortSignal,
  ): Promise<StageReplayResult> {
    const history = this.#trees.get(root)
    if (history === undefined) throw stageHistoryError('unavailable')
    const record = history.records[action === 'undo' ? history.cursor - 1 : history.cursor]
    if (record === undefined) throw stageHistoryError('unavailable')
    if (record.summary.id !== id) throw stageHistoryError('stale')
    const expected = action === 'undo' ? 'after' : 'before'
    const wanted = action === 'undo' ? 'before' : 'after'
    this.#replaying.add(root)
    try {
      await withIndexTransaction(this.ctx, this.git, root, signal, async transaction => {
        const { state, git } = transaction
        if (history.identity !== state.identity || !sameHead(history.head, state.head)
          || record.changes.some(change => !entryMatches(state.entries, change.path, change[expected]))) {
          throw stageHistoryError('stale')
        }
        await restoreEntries(git, root, record.changes, wanted, state.head, signal)
        const after = await transaction.readIndex()
        const paths = record.changes.map(change => change.path)
        assertOnlyPathsChanged(state.entries, after, paths)
        if (record.changes.some(change => !entryMatches(after, change.path, change[wanted]))) {
          throw stageHistoryError('stale')
        }
        await transaction.publish()
        history.cursor += action === 'undo' ? -1 : 1
      })
    } finally {
      this.#replaying.delete(root)
    }
    return { action, stageHistory: this.tips(root) }
  }

  /**
   * Keep the history honest around one panel write: only a successful write
   * that changed the index or HEAD breaks the chain.
   * @param root - repository root.
   * @param signal - cancellation.
   * @param write - the write to run.
   * @returns whatever the write returns.
   */
  async aroundWrite<T>(root: string, signal: AbortSignal, write: () => Promise<T>): Promise<T> {
    if (!this.#trees.has(root)) return write()
    const snapshot = (): Promise<IndexState | null> => historyState(this.ctx, this.git, root, signal).catch(() => null)
    const before = await snapshot()
    const result = await write()
    const after = await snapshot()
    if (before === null || after === null || before.identity !== after.identity
      || !sameHead(before.head, after.head) || !sameEntries(before.entries, after.entries)) this.#clear(root)
    return result
  }
}
