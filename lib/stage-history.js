import { randomUUID } from 'node:crypto'

import { withIndexTransaction, historyState, sameHead, stageHistoryError } from './index-transaction.js'

const MAX_PER_TREE = 32
const MAX_HISTORY_BYTES = 1024 * 1024
const RESTORABLE_MODES = new Set(['100644', '100755', '120000'])
export const EMPTY_STAGE_HISTORY = Object.freeze({ undo: null, redo: null })

function entryEquals(a, b) {
  return a === b || (a != null && b != null && a.oid === b.oid && a.mode === b.mode
    && a.stage === b.stage && a.flags === b.flags)
}

function entryMatches(entries, path, expected) {
  return entryEquals(entries.get(path) ?? null, expected)
}

function sameEntries(before, after) {
  if (before.size !== after.size) return false
  for (const [path, entry] of before) {
    if (!entryMatches(after, path, entry)) return false
  }
  return true
}

function stillMatches(history, state) {
  if (history.identity !== state.identity || !sameHead(history.head, state.head)) return false
  const expected = new Map()
  for (const [index, record] of history.records.entries()) {
    for (const { path, before, after } of record.changes) {
      if (index < history.cursor || !expected.has(path)) {
        expected.set(path, index < history.cursor ? after : before)
      }
    }
  }
  return [...expected].every(([path, entry]) => entryMatches(state.entries, path, entry))
}

function supported(entry) {
  // Only plain blobs can be recreated by --index-info without losing flags.
  // Gitlinks identify objects that can legitimately be absent from this repo.
  return entry === null || (entry.stage === 0 && entry.flags === 0 && RESTORABLE_MODES.has(entry.mode))
}

function changesAt(before, after, paths) {
  const changes = []
  for (const path of paths) {
    const oldEntry = before.get(path) ?? null
    const newEntry = after.get(path) ?? null
    if (!entryEquals(oldEntry, newEntry)) changes.push({ path, before: oldEntry, after: newEntry })
  }
  return changes
}

function assertOnlyPathsChanged(before, after, paths) {
  for (const [current, other] of [[before, after], [after, before]]) {
    for (const [path, entry] of current) {
      if (!paths.includes(path) && !entryMatches(other, path, entry)) throw stageHistoryError('stale')
    }
  }
}

async function restoreEntries(git, root, changes, direction, head, signal) {
  const wanted = changes.flatMap(change => change[direction] === null ? [] : [[change[direction].oid, 'blob']])
  if (head.oid !== null) wanted.push([head.oid, 'commit'])
  if (wanted.length > 0) {
    const result = await git.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      cwd: root, signal, stdin: `${wanted.map(([oid]) => oid).join('\n')}\n`,
    })
    if (result.lossy || result.exitCode !== 0 || result.stdout !== wanted.map(([oid, type]) => `${oid} ${type}\n`).join('')) {
      throw stageHistoryError('unavailable')
    }
  }
  const first = changes[0].before ?? changes[0].after
  const zero = '0'.repeat(first.oid.length)
  const records = changes.map(({ path }) => `0 ${zero}\t${path}\0`)
  for (const { path, [direction]: entry } of changes) {
    if (entry !== null) records.push(`${entry.mode} ${entry.oid}\t${path}\0`)
  }
  const result = await git.run(['update-index', '-z', '--index-info'], { cwd: root, signal, stdin: records.join('') })
  if (result.exitCode !== 0) throw stageHistoryError('unavailable')
}

/** In-memory history for the lifetime of one Git backend. A record stores only changed entries. */
export class StageHistory {
  #trees = new Map()
  #bytes = 0
  #sequence = 0
  #replaying = new Set()

  constructor(ctx, git) {
    this.ctx = ctx
    this.git = git
  }

  tips(root) {
    const history = this.#trees.get(root)
    if (history === undefined) return EMPTY_STAGE_HISTORY
    return {
      undo: history.records[history.cursor - 1]?.summary ?? null,
      redo: history.records[history.cursor]?.summary ?? null,
    }
  }

  #clear(root) {
    const history = this.#trees.get(root)
    if (history === undefined) return
    for (const record of history.records) this.#bytes -= record.bytes
    this.#trees.delete(root)
  }

  #dropOldest(root, history) {
    const [oldest] = history.records.splice(0, 1)
    this.#bytes -= oldest.bytes
    history.cursor = Math.max(0, history.cursor - 1)
    if (history.records.length === 0) this.#trees.delete(root)
  }

  #add(root, state, target, changes) {
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
    const { scope, path, lines } = target
    const summary = { id: randomUUID(), scope, path, ...(lines && { lineCount: lines.length }) }
    // Charge for per-record overhead, identifiers, and UTF-16 strings.
    const bytes = 512 + (path.length + state.identity.length + JSON.stringify(changes).length
      + (state.head.ref?.length ?? 0)) * 2
    history.records.push({ summary, changes, bytes, order: ++this.#sequence })
    history.cursor += 1
    this.#bytes += bytes
    if (history.records.length > MAX_PER_TREE) this.#dropOldest(root, history)
    while (this.#bytes > MAX_HISTORY_BYTES) {
      let oldest
      for (const pair of this.#trees) {
        if (this.#replaying.has(pair[0])) continue
        if (oldest === undefined || pair[1].records[0].order < oldest[1].records[0].order) oldest = pair
      }
      // If the oldest entry is undone, the rest of its redo chain depends on it.
      if (oldest[1].cursor === 0) this.#clear(oldest[0])
      else this.#dropOldest(...oldest)
    }
  }

  async stage(root, target, signal, apply) {
    await withIndexTransaction(this.ctx, this.git, root, signal, async transaction => {
      const paths = await apply(transaction.git, transaction.state.head)
      const after = await transaction.readIndex()
      assertOnlyPathsChanged(transaction.state.entries, after, paths)
      const changes = changesAt(transaction.state.entries, after, paths)
      if (changes.length === 0) return
      await transaction.publish()
      if (transaction.canRecord && changes.every(({ before, after }) => supported(before) && supported(after))) {
        this.#add(root, transaction.state, target, changes)
      } else {
        this.#clear(root)
      }
    }, { staging: true })
    return { scope: target.scope, path: target.path }
  }

  async replay(root, { action, id }, signal) {
    const history = this.#trees.get(root)
    const record = history?.records[action === 'undo' ? history.cursor - 1 : history.cursor]
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

  /** Only successful panel writes that changed the index or HEAD break the chain. */
  async aroundWrite(root, signal, write) {
    if (!this.#trees.has(root)) return write()
    const snapshot = () => historyState(this.ctx, this.git, root, signal).catch(() => null)
    const before = await snapshot()
    const result = await write()
    const after = await snapshot()
    if (before === null || after === null || before.identity !== after.identity
      || !sameHead(before.head, after.head) || !sameEntries(before.entries, after.entries)) this.#clear(root)
    return result
  }
}
