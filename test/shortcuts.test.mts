import test from 'node:test'
import assert from 'node:assert/strict'

import { SHORTCUT_DEFAULTS, SHORTCUT_ID, mainSessionId } from '../lib/client/shortcuts.js'

test('the shortcut has one identity and platform-primary defaults', () => {
  assert.equal(SHORTCUT_ID, 'vcs.view.toggle')
  assert.deepEqual(Object.keys(SHORTCUT_DEFAULTS).sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows',
  ])
  for (const binding of Object.values(SHORTCUT_DEFAULTS)) {
    assert.deepEqual(binding, { code: 'KeyG', modifiers: ['primary', 'shift'] })
  }
  // DSH's Web policy rejects Mod+Shift on Linux; the command starts unbound there.
  assert.equal(SHORTCUT_DEFAULTS['web:linux'], undefined)
})

test('mainSessionId selects the Session retained by the main view', () => {
  assert.equal(mainSessionId({
    byId: {
      a: { id: 'a', retainedBy: { mainView: 0 } },
      b: { id: 'b', retainedBy: { mainView: 1 } },
    },
  }), 'b')
  assert.equal(mainSessionId({ byId: { a: { id: 'a' } } }), null)
  assert.equal(mainSessionId({}), null)
  assert.equal(mainSessionId(undefined), null)
})
