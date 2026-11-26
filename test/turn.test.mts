import test from 'node:test'
import assert from 'node:assert/strict'

import { pickRepository } from '../lib/client/history/timeline-model.js'
import {
  createTurnChangesDefinition, isMutationCall, TURN_CHANGES_KIND, turnChangedFiles, turnChanges,
} from '../lib/client/turn.js'
import {
  createTurnSummaryStore, normalizeTurnHead, normalizeTurnSummary,
} from '../lib/client/turn-summary.js'

/** One tool/call event in turn 3. */
function call(callId, name, args) {
  return { type: 'tool/call', data: { turn: 3, callId, name, arguments: JSON.stringify(args) } }
}

/** One successful tool/result in turn 3. */
function result(callId, { isError = false, surfaceOp = 'append' } = {}) {
  return {
    type: 'tool/result',
    surfaceOp,
    data: { turn: 3, message: { isError, source: { callId } } },
  }
}

/** Start the definition's Turn-3 context. */
function startContext(definition) {
  const match = {
    event: { type: 'turn/start', data: { turn: 3 } },
    role: 'start',
  }
  return { state: definition.start({ key: 'vcs-changes:3' }, match) }
}

/** Apply one event as an update. */
function apply(definition, context, event) {
  return definition.update(context, { event, role: 'update' })
}

test('mutation calls follow each tool\'s execution preconditions', () => {
  assert.equal(isMutationCall('write', JSON.stringify({ file_path: '/r/a.js', content: 'x' })), true)
  assert.equal(isMutationCall('write', JSON.stringify({ file_path: '/r/a.js' })), false)
  assert.equal(isMutationCall('write', 'not json'), false)

  const edit = { file_path: '/r/a.js', old_string: 'a', new_string: 'b' }
  assert.equal(isMutationCall('edit', JSON.stringify(edit)), true)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, old_string: '' })), false)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, new_string: 'a' })), false)
  assert.equal(isMutationCall('edit', JSON.stringify({ ...edit, replace_all: 'yes' })), false)

  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'create', path: '/r/a.js', file_text: 'x',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'str_replace', path: '/r/a.js', old_str: 'a', new_str: 'b',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'insert', path: '/r/a.js', insert_line: 2, new_str: 'b',
  })), true)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'view', path: '/r/a.js',
  })), false)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'insert', path: '/r/a.js', insert_line: -1, new_str: 'b',
  })), false)
  assert.equal(isMutationCall('str_replace_editor', JSON.stringify({
    command: 'create', path: '', file_text: 'x',
  })), false)

  assert.equal(isMutationCall('apply_patch', JSON.stringify({ patchText: '*** Begin Patch' })), true)
  assert.equal(isMutationCall('read', JSON.stringify({ file_path: '/r/a.js' })), false)
  assert.equal(isMutationCall('present', JSON.stringify({ files: [{ path: '/r/a.js' }] })), false)
})

test('the definition matches the Turn, its record, its calls, and appended results only', () => {
  const definition = createTurnChangesDefinition()
  const start = { type: 'turn/start', data: { turn: 3 } }
  assert.deepEqual(definition.match(start), { id: '3', role: 'start' })
  assert.deepEqual(definition.match({ type: 'workspace/changes', data: { turn: 3 } }), { id: '3', role: 'update' })
  assert.equal(definition.match({ type: 'workspace/changes', data: { turn: 0 } }), null)
  assert.equal(definition.match({ type: 'workspace/changes', data: { turn: 3.5 } }), null)
  assert.equal(definition.match({ type: 'workspace/changes', data: {} }), null)
  assert.deepEqual(definition.match(call('c1', 'write', { content: '' })), { id: '3', role: 'update' })
  assert.deepEqual(definition.match(result('c1')), { id: '3', role: 'update' })
  assert.equal(definition.match(result('c1', { surfaceOp: { op: 'replace' } })), null)
  assert.equal(definition.match({ type: 'tool/call', data: { turn: 3 } }).id, '3')
  assert.equal(definition.match({ type: 'assistant/message', data: { turn: 3 } }), null)
})

test('the recorder record marks the Turn and replaces earlier sequences in the same Turn', () => {
  const definition = createTurnChangesDefinition()
  const context = startContext(definition)
  assert.equal(definition.buildLocationData(context, 'turn', null), null)

  const first = apply(definition, context, { type: 'workspace/changes', seq: 14, data: { turn: 3 } })
  assert.equal(first.changed, true)
  assert.equal(first.seq, 14)
  assert.equal(apply(definition, { state: first }, { type: 'workspace/changes', seq: 14, data: { turn: 3 } }), first)

  const superseded = apply(definition, { state: first }, { type: 'workspace/changes', seq: 19, data: { turn: 3 } })
  assert.equal(superseded.seq, 19)
})

test('a successful mutation marks the Turn; failures and non-mutations do not', () => {
  const definition = createTurnChangesDefinition()
  const context = startContext(definition)

  // A mutation call alone changes nothing.
  let state = apply(definition, context, call('c1', 'edit', { file_path: '/r/a.js', old_string: 'a', new_string: 'b' }))
  assert.equal(state.changed, false)

  // Its successful result does.
  state = apply(definition, { state }, result('c1'))
  assert.equal(state.changed, true)
  assert.equal(state.seq, null)

  // Failed results, unmatched results, and read calls stay unchanged.
  const clean = startContext(definition)
  let next = apply(definition, clean, call('c2', 'read', { file_path: '/r/a.js' }))
  next = apply(definition, { state: next }, result('c2'))
  assert.equal(next.changed, false)
  next = apply(definition, { state: next }, call('c3', 'write', { file_path: '/r/a.js', content: 'x' }))
  next = apply(definition, { state: next }, result('c3', { isError: true }))
  assert.equal(next.changed, false)
  next = apply(definition, { state: next }, result('missing'))
  assert.equal(next.changed, false)

  // Later successful mutations keep the first `changed` reference stable.
  let marked = startContext(definition)
  marked = { state: apply(definition, marked, call('c4', 'apply_patch', { patchText: 'x' })) }
  marked = { state: apply(definition, marked, result('c4')) }
  assert.equal(apply(definition, marked, result('c4')), marked.state)
})

test('location data publishes changed Turns with their latest sequence and keeps identity', () => {
  const definition = createTurnChangesDefinition()
  let context = startContext(definition)
  assert.equal(definition.buildLocationData(context, 'step', null), null)
  assert.equal(definition.buildLocationData(context, 'turn', null), null)

  context = { state: apply(definition, context, call('c1', 'write', { file_path: '/r/a.js', content: 'x' })) }
  assert.equal(definition.buildLocationData(context, 'turn', null), null)
  context = { state: apply(definition, context, result('c1')) }

  const first = definition.buildLocationData(context, 'turn', null)
  assert.equal(definition.kind, TURN_CHANGES_KIND)
  assert.deepEqual(first, { kind: 'turn', turn: 3, key: definition.kind, value: { changed: true } })
  assert.equal(definition.buildLocationData(context, 'turn', first), first)
  assert.equal(definition.buildLocationData(context, 'step', first), null)

  // A subsequent `workspace/changes` event attaches `seq` and replaces the published value.
  context = { state: apply(definition, context, { type: 'workspace/changes', seq: 28, data: { turn: 3 } }) }
  const withSeq = definition.buildLocationData(context, 'turn', first)
  assert.deepEqual(withSeq, { kind: 'turn', turn: 3, key: definition.kind, value: { changed: true, seq: 28 } })
  assert.equal(definition.buildLocationData(context, 'turn', withSeq), withSeq)
})

test('turnChanges and turnChangedFiles read published Turn coordinates defensively', () => {
  const withSeq = new Map([[TURN_CHANGES_KIND, { changed: true, seq: 9 }]])
  assert.deepEqual(turnChanges({ turn: 3, data: withSeq }), { turn: 3, seq: 9 })
  assert.equal(turnChangedFiles({ turn: 3, data: withSeq }), true)

  const withoutSeq = new Map([[TURN_CHANGES_KIND, { changed: true }]])
  assert.deepEqual(turnChanges({ data: withoutSeq }), { turn: null, seq: null })
  assert.equal(turnChangedFiles({ data: withoutSeq }), true)

  assert.equal(turnChanges({ turn: 3, data: new Map([[TURN_CHANGES_KIND, { changed: false }]]) }), null)
  assert.equal(turnChangedFiles({ turn: 3, data: new Map([[TURN_CHANGES_KIND, { changed: false }]]) }), false)
  assert.equal(turnChangedFiles({ data: new Map() }), false)
  assert.equal(turnChangedFiles(undefined), false)
  assert.equal(turnChangedFiles({}), false)
})

test('pickRepository prefers the persisted path, then the enclosing repository, then the first', () => {
  const list = [
    { path: '/w/sub', enclosing: false },
    { path: '/w', enclosing: true },
  ]
  assert.deepEqual(pickRepository(list, '/w/sub'), { path: '/w/sub', enclosing: false })
  assert.deepEqual(pickRepository(list, '/gone'), { path: '/w', enclosing: true })
  assert.deepEqual(pickRepository([{ path: '/w/sub', enclosing: false }], null), { path: '/w/sub', enclosing: false })
  assert.equal(pickRepository([], '/w'), null)
  assert.equal(pickRepository(null, '/w'), null)
})

test('normalizeTurnHead and normalizeTurnSummary validate per-turn payloads', () => {
  assert.deepEqual(normalizeTurnHead({ kind: 'branch', name: 'main' }), { kind: 'branch', name: 'main' })
  assert.equal(normalizeTurnHead({ kind: 'branch', name: '' }), null)
  assert.deepEqual(normalizeTurnHead({ kind: 'detached' }), { kind: 'detached' })
  assert.deepEqual(normalizeTurnHead({ kind: 'unborn' }), { kind: 'unborn' })
  assert.deepEqual(normalizeTurnHead({ kind: 'workingCopy', changeId: 'qpvuntsm' }), {
    kind: 'workingCopy',
    changeId: 'qpvuntsm',
  })
  assert.deepEqual(normalizeTurnHead({ kind: 'workingCopy', changeId: '' }), {
    kind: 'workingCopy',
    changeId: null,
  })
  assert.equal(normalizeTurnHead({ kind: 'unknown' }), null)
  assert.equal(normalizeTurnHead(null), null)

  assert.deepEqual(normalizeTurnSummary({
    turn: 3,
    head: { kind: 'branch', name: 'feat/a' },
    changed: 2,
    added: 14,
    deleted: 3,
  }), {
    head: { kind: 'branch', name: 'feat/a' },
    changed: 2,
    added: 14,
    deleted: 3,
  })

  // Non-repo workspace turn: counts without a repository head.
  assert.deepEqual(normalizeTurnSummary({
    turn: 1,
    head: null,
    changed: 1,
    added: 8,
    deleted: 0,
  }), {
    head: null,
    changed: 1,
    added: 8,
    deleted: 0,
  })

  // Head-only fallback when change counts were not recorded.
  assert.deepEqual(normalizeTurnSummary({
    turn: 2,
    head: { kind: 'workingCopy', changeId: 'abcd1234' },
    changed: null,
    added: null,
    deleted: null,
  }), {
    head: { kind: 'workingCopy', changeId: 'abcd1234' },
    changed: null,
    added: null,
    deleted: null,
  })

  assert.equal(normalizeTurnSummary({ head: null, changed: null, added: null, deleted: null }), null)
  assert.equal(normalizeTurnSummary({ head: null, changed: -1, added: 0, deleted: 0 }), null)
  assert.equal(normalizeTurnSummary({ head: null, changed: 1, added: 2 }), null)
  assert.equal(normalizeTurnSummary(null), null)

  const graph = { path: '/fixture/alpha', name: 'alpha', files: 1 }
  const summary = { head: null, changed: 2, added: 0, deleted: 0 }
  assert.deepEqual(normalizeTurnSummary({ ...summary, graphs: [null, graph, graph, { ...graph, path: '/bad', files: -1 }] }), {
    ...summary, graphs: [graph],
  })
  assert.deepEqual(normalizeTurnSummary({ ...summary, graphs: [{ ...graph, files: 3 }] }), summary)
})

/** Drain pending microtasks of an async store read. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

test('the turn-summary store caches resolved turns, remembers missing ones, and retries transient failures', async () => {
  const calls = []
  let failNetworkOnce = true
  const store = createTurnSummaryStore({
    maxIdle: 2,
    createApiImpl: sessionId => ({
      async turn(turn, seq) {
        calls.push([sessionId, turn, seq])
        if (turn === 1) {
          return {
            turn: 1,
            head: { kind: 'branch', name: 'main' },
            changed: 2,
            added: 15,
            deleted: 4,
          }
        }
        if (turn === 2) {
          const err = new Error('gone')
          err.code = 'not-found'
          err.status = 404
          throw err
        }
        if (turn === 3 && failNetworkOnce) {
          failNetworkOnce = false
          const err = new Error('offline')
          err.code = 'network'
          err.status = 0
          throw err
        }
        return {
          turn,
          head: { kind: 'branch', name: `branch-${turn}` },
          changed: 1,
          added: turn,
          deleted: 0,
        }
      },
    }),
  })

  let notified = 0
  const off1 = store.subscribe('s1', 1, 10, () => { notified += 1 })
  store.observe('s1', 1, 10)
  store.observe('s1', 1, 10)
  await settle()

  assert.deepEqual(calls, [['s1', 1, 10]])
  assert.equal(notified, 1)
  assert.deepEqual(store.get('s1', 1, 10), {
    head: { kind: 'branch', name: 'main' },
    changed: 2,
    added: 15,
    deleted: 4,
  })
  off1()

  // Re-observing a cached turn makes no network request.
  store.observe('s1', 1, 10)
  await settle()
  assert.equal(calls.length, 1)

  // A 404 from a pre-restart turn marks the record missing and does not poll again.
  store.observe('s1', 2, 20)
  await settle()
  assert.equal(store.get('s1', 2, 20), null)
  store.observe('s1', 2, 20)
  await settle()
  assert.equal(calls.length, 2)

  // A transient network failure retries on a later observe or connection reset.
  const off3 = store.subscribe('s1', 3, 30, () => { notified += 1 })
  store.observe('s1', 3, 30)
  await settle()
  assert.equal(store.get('s1', 3, 30), null)
  store.reset()
  await settle()
  assert.deepEqual(store.get('s1', 3, 30), {
    head: { kind: 'branch', name: 'branch-3' },
    changed: 1,
    added: 3,
    deleted: 0,
  })
  // Settled turn 1 survived `reset()`.
  assert.equal(store.get('s1', 1, 10)?.head?.name, 'main')
  off3()

  // Unsubscribed entries past `maxIdle` evict in LRU order.
  store.observe('s1', 4, 40)
  await settle()
  assert.equal(store.get('s1', 1, 10), null, 'oldest idle turn evicted past maxIdle=2')
  assert.equal(store.get('s1', 3, 30)?.head?.name, 'branch-3')
  assert.equal(store.get('s1', 4, 40)?.head?.name, 'branch-4')

  store.dispose()
})

test('the turn-summary store aborts an in-flight read when its last banner unmounts', async () => {
  let aborted = false
  let requests = 0
  const store = createTurnSummaryStore({
    createApiImpl: () => ({
      turn(_turn, _seq, signal) {
        requests += 1
        if (requests === 1) {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
        }
        return Promise.resolve({
          turn: 5,
          head: { kind: 'workingCopy', changeId: 'zyxw9876' },
          changed: 1,
          added: 6,
          deleted: 2,
        })
      },
    }),
  })

  const off = store.subscribe('s2', 5, 50, () => {})
  store.observe('s2', 5, 50)
  await Promise.resolve()
  off()
  await settle()
  assert.equal(aborted, true)

  // Mounting again starts a clean request and resolves.
  const offAgain = store.subscribe('s2', 5, 50, () => {})
  store.observe('s2', 5, 50)
  await settle()
  assert.deepEqual(store.get('s2', 5, 50), {
    head: { kind: 'workingCopy', changeId: 'zyxw9876' },
    changed: 1,
    added: 6,
    deleted: 2,
  })
  offAgain()
  store.dispose()
})
