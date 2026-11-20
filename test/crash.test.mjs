import test from 'node:test'
import assert from 'node:assert/strict'

import { CRASH_STORAGE_KEY, describeCrash, recordCrash } from '../lib/client/crash.js'

/** A storage stand-in that records writes. */
function fakeStorage() {
  const values = new Map()
  return {
    values,
    setItem(key, value) { values.set(key, value) },
  }
}

test('describeCrash names the error and keeps its message', () => {
  const error = new TypeError('cannot read the panel')
  assert.equal(describeCrash(error), 'TypeError: cannot read the panel')
  assert.equal(describeCrash('plain failure'), 'plain failure')
  assert.equal(describeCrash(null), 'Unknown error')
})

test('recordCrash writes the record under the session diagnostic key', () => {
  const storage = fakeStorage()
  const error = new RangeError('bad range')
  error.stack = 'RangeError: bad range\n    at panel'
  const record = recordCrash(storage, error, { componentStack: '\n    at VcsView' }, 1234)
  assert.deepEqual(record, {
    time: 1234,
    message: 'RangeError: bad range',
    stack: 'RangeError: bad range\n    at panel',
    componentStack: '\n    at VcsView',
  })
  assert.equal(CRASH_STORAGE_KEY, 'vcs:last-error')
  assert.deepEqual(JSON.parse(storage.values.get(CRASH_STORAGE_KEY)), record)
})

test('recordCrash keeps a diagnostic even when the store rejects a write', () => {
  const storage = { setItem() { throw new Error('quota exceeded') } }
  const record = recordCrash(storage, new Error('view failed'))
  assert.equal(record.message, 'Error: view failed')
  assert.equal(typeof record.stack, 'string')
  assert.equal(record.componentStack, '')
})

test('recordCrash truncates very long stacks', () => {
  const storage = fakeStorage()
  const error = new Error('large')
  error.stack = 'x'.repeat(20_000)
  const record = recordCrash(storage, error)
  assert.ok(record.stack.length < 20_000)
  assert.ok(record.stack.endsWith('…'))
})
