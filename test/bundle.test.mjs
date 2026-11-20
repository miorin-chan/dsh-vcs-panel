import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Load the generated bundle with a stub module loader and React. */
function loadBundle({ onEffect, reactOverrides } = {}) {
  let registered
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))({
    __ModuleLoader__: {
      load(value) { registered = value },
    },
  })
  const react = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useCallback: fn => fn,
    useEffect: fn => onEffect?.(fn),
    useLayoutEffect: fn => fn(),
    useMemo: fn => fn(),
    memo: component => component,
    useRef: value => ({ current: value }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
    ...reactOverrides,
  }
  const jsxRuntime = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props: props ?? {}, children: [] }),
    jsxs: (type, props) => ({ type, props: props ?? {}, children: [] }),
  }
  const plugin = registered.factory(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  })
  return { plugin, registered }
}

/** A locale service stub that reports one active language. */
function localeStub(active = 'zh', calls = []) {
  return {
    register(ns, dicts) {
      calls.push({ ns, dicts })
      return () => undefined
    },
    bind(ns) { return key => `${ns}:${key}` },
    getLocale() { return { active, locales: [], revision: 0 } },
    subscribe() { return () => undefined },
  }
}

test('client.js registers the expected module id and exports apply/inject', () => {
  const { plugin, registered } = loadBundle()
  assert.equal(registered.id, 'dsh-vcs-panel')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the dictionaries, stylesheet, Sidebar page, Turn fold, and Turn-tail entry', async () => {
  const pendingEffects = []
  let capturingEffects = false
  const { plugin } = loadBundle({
    onEffect: fn => {
      if (capturingEffects) pendingEffects.push(fn)
    },
  })
  const effects = []
  const localeCalls = []
  const optionalInjections = []
  const commands = []
  const registrations = []
  const definitions = []
  const styles = []
  const fetchCalls = []
  const sidebarOpened = []
  const tabDefinitions = []
  let sessionSnapshot = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const document = {
    visibilityState: 'visible',
    head: {
      appendChild(element) { styles.push(element) },
    },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        remove() { this.removed = true },
      }
    },
  }
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = document
  globalThis.fetch = async url => {
    fetchCalls.push(url)
    const params = new URL(url, 'http://127.0.0.1').searchParams
    const turnNumber = Number(params.get('turn'))
    const payloads = {
      1: { turn: 1, head: { kind: 'branch', name: 'feat/turn-1' }, changed: 2, added: 1234, deleted: 0 },
      2: { turn: 2, head: { kind: 'workingCopy', changeId: 'qpvuntsm9999' }, changed: 1, added: 5, deleted: 2 },
      3: { turn: 3, head: { kind: 'branch', name: 'main' }, changed: null, added: null, deleted: null },
      4: { turn: 4, head: { kind: 'branch', name: 'main' }, changed: 0, added: 0, deleted: 0 },
    }
    return {
      ok: true,
      status: 200,
      async json() { return payloads[turnNumber] },
    }
  }
  try {
    const ctx = {
      inject(deps, callback) {
        optionalInjections.push(deps)
        callback({
          effect: fn => fn(),
          shortcuts: { register(command) { commands.push(command); return () => undefined } },
          sessions: { list: { getSnapshot: () => sessionSnapshot } },
        })
        return () => undefined
      },
      effect(fn, label) {
        const disposer = fn()
        effects.push({ label, disposer })
        return disposer
      },
      locale: localeStub('zh', localeCalls),
      uiConversation: {
        events: {
          register(definition) {
            definitions.push(definition)
            return () => undefined
          },
        },
      },
      sidebarRight: {
        mounted: { getSnapshot: () => 's1' },
        isExpanded: () => false,
        active: () => undefined,
        openTab(kind) { sidebarOpened.push(kind) },
      },
      sidebarRightTabs: {
        register(definition) {
          tabDefinitions.push(definition)
          return () => undefined
        },
      },
      slots: {
        inject(key, callback) {
          return callback()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }
    plugin.apply(ctx)

    assert.deepEqual(localeCalls.map(call => call.ns), ['vcs'])
    const dictionary = localeCalls[0].dicts
    assert.deepEqual(Object.keys(dictionary).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const entries of Object.values(dictionary)) {
      assert.equal(typeof entries['view.label'], 'string')
      assert.equal(typeof entries['diff.loading'], 'string')
      assert.equal(typeof entries['turn.openHint'], 'string')
      assert.equal(typeof entries['turn.openSummary'], 'string')
      assert.equal(typeof entries['turn.filesChanged.other'], 'string')
      assert.equal(typeof entries['sidebar.guide'], 'string')
      assert.equal('surface.openSidebar' in entries, false)
      assert.equal('surface.unavailable' in entries, false)
    }
    assert.equal(typeof dictionary.en['turn.filesChanged.one'], 'string')
    assert.equal(typeof dictionary.ru['turn.filesChanged.few'], 'string')
    assert.equal(typeof dictionary.ru['turn.filesChanged.many'], 'string')
    assert.deepEqual(optionalInjections, [['shortcuts', 'sessions']])
    assert.equal(commands.length, 1)
    assert.equal(commands[0].id, 'vcs.view.toggle')

    assert.equal(styles.length, 1)
    assert.match(styles[0].textContent, /\.vcs-root/)
    assert.match(styles[0].textContent, /\.vcs-diff-body/)
    assert.match(styles[0].textContent, /\.vcs-graph/)
    assert.match(styles[0].textContent, /\.vcs-turn-banner/)
    assert.match(styles[0].textContent, /\.vcs-turn-stat/)
    assert.match(styles[0].textContent, /\.vcs-turn-popout/)
    assert.doesNotMatch(styles[0].textContent, /data-surface/u)

    // The fold that publishes "this Turn changed files" has no view target.
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].kind, 'vcs-changes')
    assert.equal(definitions[0].target, undefined)

    // The page type carries one guide card, and the card draws the Turn
    // banner's branch glyph at the host's icon size.
    assert.equal(tabDefinitions.length, 1)
    const definition = tabDefinitions[0]
    assert.equal(definition.id, 'dsh-vcs-panel')
    assert.equal(definition.kind, 'vcs')
    assert.equal(definition.title(), 'vcs:view.label')
    assert.equal(definition.guide.length, 1)
    const guide = definition.guide[0]
    assert.equal(guide.id, 'vcs')
    assert.equal(guide.order, 15, 'the card sits right after Files (10) and before Terminal (20)')
    assert.equal(guide.commandId, 'vcs.view.toggle')
    assert.equal(guide.title(), 'vcs:view.label')
    assert.equal(guide.description(), 'vcs:sidebar.guide')
    assert.equal(typeof guide.icon, 'function')
    const drawnGuideIcon = guide.icon({ size: 22 })
    assert.equal(drawnGuideIcon.props.width, 22)
    assert.equal(drawnGuideIcon.props.height, 22)
    assert.equal(drawnGuideIcon.props.className, undefined)

    assert.deepEqual(
      registrations.map(entry => entry.options.name),
      ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.chat.turnTail'],
    )
    const body = registrations[0]
    assert.equal(body.options.key, 'dsh-vcs-panel')
    assert.equal(body.options.locale, 'vcs')
    assert.equal(typeof body.component, 'function')
    const title = registrations[1]
    assert.equal(title.options.key, 'dsh-vcs-panel')
    assert.equal(title.options.locale, 'vcs')
    assert.equal(title.component(), 'vcs:view.label')
    // The body follows the active language and passes the one-shot focus
    // request through to the panel.
    const bodyTree = body.component({
      sessionId: 'session-1',
      useTabInfo: () => ({ tab: { visible: false, navigation: { revision: 0 } } }),
    })
    assert.equal(bodyTree.props.children.props.locale, 'zh')
    assert.equal(bodyTree.props.children.props.focusRequest, 0)
    const tail = registrations[2]
    assert.equal(tail.options.id, 'dsh-vcs-panel')
    assert.equal(tail.options.order, -10)
    assert.equal(tail.options.locale, 'vcs')
    assert.equal('store' in tail.options, false)

    const makeTurn = (turnNumber, seq) => ({
      turn: turnNumber,
      data: {
        get: key => (key === 'vcs-changes'
          ? (seq === undefined ? { changed: true } : { changed: true, seq })
          : undefined),
      },
    })
    const renderBanner = bannerProps => {
      const active = tail.component(bannerProps)
      assert.equal(typeof active.type, 'function')
      const banner = active.type(active.props)
      assert.equal(typeof banner.type, 'function')
      return banner.type(banner.props)
    }
    const flushEffects = async () => {
      const disposers = []
      while (pendingEffects.length > 0) {
        const dispose = pendingEffects.shift()()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
      return () => { for (const dispose of disposers) dispose() }
    }

    const props = {
      turn: makeTurn(1, 12),
      sessionId: 'session-1',
      t: (key, vars) => {
        if (vars === undefined) return `vcs:${key}`
        if ('count' in vars) return `vcs:${key}:${vars.count}`
        return `vcs:${key}:${vars.added}:${vars.deleted}`
      },
    }
    capturingEffects = true
    const rendered = renderBanner(props)
    assert.equal(rendered.props.className, 'vcs-turn-tail')
    const button = rendered.props.children
    assert.equal(button.type, 'button')
    assert.equal(button.props.className, 'vcs-turn-banner')
    assert.equal(button.props['aria-label'], 'vcs:turn.openHint')
    assert.equal(button.props.title, 'vcs:turn.openHint')
    const [initialLeft, initialRight] = button.props.children
    assert.equal(initialLeft.props.className, 'vcs-turn-left')
    assert.equal(initialLeft.props.children[0].type, guide.icon, 'the guide reuses the banner branch glyph')
    assert.equal(initialLeft.props.children[2].props.children, 'vcs:turn.openHint')
    assert.equal(initialRight.props.className, 'vcs-turn-right')
    assert.equal(initialRight.props.children[0], null, 'no line counts before turn summary resolves')
    const initialPopout = initialRight.props.children[1].type()
    assert.equal(initialPopout.props.className, 'vcs-turn-popout')
    button.props.onClick()
    assert.deepEqual(sidebarOpened, ['vcs'], 'the banner opens the Sidebar page')

    // Flush the turn-1 effect and mount turn 2 in the same Session: each turn
    // keeps its own recorded branch / `@` and line-diff counts.
    const cleanupTurn1 = await flushEffects()
    renderBanner({ ...props, turn: makeTurn(2, 24) })
    const cleanupTurn2 = await flushEffects()
    assert.deepEqual(fetchCalls, [
      '/api/vcs.turn?sessionId=session-1&turn=1&seq=12',
      '/api/vcs.turn?sessionId=session-1&turn=2&seq=24',
    ])

    const withCounts = renderBanner(props).props.children
    assert.equal(withCounts.props.title, 'vcs:turn.openHint')
    assert.equal(withCounts.props['aria-label'], 'feat/turn-1 · vcs:turn.filesChanged.other:2 · vcs:turn.openSummary:1,234:0')
    const [, right] = withCounts.props.children
    const [stat, popout] = right.props.children
    assert.equal(stat.props.className, 'vcs-turn-stat')
    const [addedSpan, deletedSpan] = stat.props.children
    assert.equal(addedSpan.props.className, 'vcs-add')
    assert.deepEqual(addedSpan.props.children, ['+', '1,234'])
    assert.equal(deletedSpan.props.className, 'vcs-del')
    assert.deepEqual(deletedSpan.props.children, ['−', '0'])
    assert.equal(popout.type().props.className, 'vcs-turn-popout')

    const jjBanner = renderBanner({ ...props, turn: makeTurn(2, 24) }).props.children
    assert.equal(jjBanner.props['aria-label'], '@ qpvuntsm · vcs:turn.filesChanged.other:1 · vcs:turn.openSummary:5:2')

    // A turn with recorded branch but no line counts shows branch + Open VCS.
    renderBanner({ ...props, turn: makeTurn(3) })
    const cleanupTurn3 = await flushEffects()
    const headOnly = renderBanner({ ...props, turn: makeTurn(3) }).props.children
    assert.equal(headOnly.props['aria-label'], 'main · vcs:turn.openHint')
    assert.equal(headOnly.props.children[1].props.children[0], null)

    // A superseded turn whose net changed-file count is 0 hides the banner.
    renderBanner({ ...props, turn: makeTurn(4, 48) })
    const cleanupTurn4 = await flushEffects()
    assert.equal(renderBanner({ ...props, turn: makeTurn(4, 48) }), null)

    cleanupTurn1()
    cleanupTurn2()
    cleanupTurn3()
    cleanupTurn4()
    capturingEffects = false

    // A Turn without mutation evidence contributes nothing and mounts no hooks.
    const unchanged = tail.component({ ...props, turn: { data: { get: () => undefined } } })
    assert.equal(unchanged, null)

    // Every registration is owned by an effect, so unload removes it.
    for (const effect of effects) assert.equal(typeof effect.label, 'string')
    const style = styles[0]
    const localeDisposer = effects.find(effect => effect.label.includes('locale'))?.disposer
    const styleDisposer = effects.find(effect => effect.label.includes('styles'))?.disposer
    const turnDisposer = effects.find(effect => effect.label.includes('turn changes'))?.disposer
    const summariesDisposer = effects.find(effect => effect.label.includes('turn summaries'))?.disposer
    assert.equal(typeof localeDisposer, 'function')
    assert.equal(typeof styleDisposer, 'function')
    assert.equal(typeof turnDisposer, 'function')
    assert.equal(typeof summariesDisposer, 'function')
    styleDisposer()
    summariesDisposer()
    assert.equal(style.removed, true)
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
})

test('the panel shortcut opens the page, collapses the Sidebar, and reveals it again', () => {
  const { plugin } = loadBundle()
  const commands = []
  const opened = []
  const hidden = []
  let expanded = false
  let active
  let snapshot = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
  const sidebar = {
    mounted: { getSnapshot: () => 's1' },
    isExpanded: () => expanded,
    active: () => active,
    openTab(kind) {
      opened.push(kind)
      expanded = true
      active = { id: 'tab-vcs', kind }
    },
    hide(id) {
      hidden.push(id)
      expanded = false
    },
  }
  const document = {
    head: { appendChild() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} } },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    plugin.apply({
      inject(deps, callback) {
        assert.deepEqual(deps, ['shortcuts', 'sessions'])
        callback({
          effect(fn) {
            const disposer = fn()
            assert.equal(typeof disposer, 'function')
            return disposer
          },
          shortcuts: { register(command) { commands.push(command); return () => undefined } },
          sessions: { list: { getSnapshot: () => snapshot } },
        })
        return () => undefined
      },
      effect(fn) { return fn() },
      locale: localeStub('en'),
      uiConversation: { events: { register() { return () => undefined } } },
      sidebarRight: sidebar,
      sidebarRightTabs: { register() { return () => undefined } },
      slots: {
        inject(key, callback) { return callback() },
        register() { return () => undefined },
      },
    })

    assert.equal(commands.length, 1)
    const command = commands[0]
    assert.equal(command.id, 'vcs.view.toggle')
    assert.equal(command.label(), 'vcs:shortcut.toggle')
    assert.deepEqual(command.regions, ['page', 'editable', 'terminal'])
    assert.deepEqual(command.modals, [])
    assert.deepEqual(command.defaults['desktop:macos'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.deepEqual(command.defaults['desktop:windows'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.deepEqual(command.defaults['web:windows'], { code: 'KeyG', modifiers: ['primary', 'shift'] })
    assert.equal(command.defaults['web:linux'], undefined)

    // No current Session and a modal both decline without consuming the key.
    snapshot = { byId: {} }
    assert.equal(command.resolve({ modal: null, region: 'page', target: null }).status, 'pass')
    snapshot = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }
    assert.equal(command.resolve({ modal: 'settings', region: 'page', target: null }).status, 'pass')

    // The first press opens the page; the next press collapses the Sidebar and
    // keeps the tab mounted so the slide-out shows the panel itself.
    const open = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(open.status, 'handled')
    open.run()
    assert.deepEqual(opened, ['vcs'])
    assert.equal(expanded, true)
    const collapse = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(collapse.status, 'handled')
    collapse.run()
    assert.deepEqual(hidden, ['tab-vcs'])
    assert.equal(expanded, false)
    assert.equal(active?.kind, 'vcs', 'collapsing keeps the VCS tab')

    // While collapsed, the next press reveals the kept page again.
    const reopen = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(reopen.status, 'handled')
    reopen.run()
    assert.deepEqual(opened, ['vcs', 'vcs'])

    // Another tab on screen is revealed rather than hiding the Sidebar.
    expanded = true
    active = { id: 'tab-files', kind: 'files' }
    const reveal = command.resolve({ modal: null, region: 'page', target: null })
    assert.equal(reveal.status, 'handled')
    reveal.run()
    assert.deepEqual(opened, ['vcs', 'vcs', 'vcs'])

    // A retained background Session is not the controller's target.
    sidebar.mounted = { getSnapshot: () => 's2' }
    assert.equal(command.resolve({ modal: null, region: 'page', target: null }).status, 'pass')
  } finally {
    globalThis.document = previousDocument
  }
})

test('the stylesheet hides the shipped changed-files card without touching the recorder', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\[data-turn-tail\] \[data-changed-files\] \{\s*display: none !important;/u)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /workspace-changes/u)
})

test('no component receives the reserved ref prop (React 18 drops it)', () => {
  // DSH ships React 18: a function component receives no "ref" prop there, so
  // <Badge ref={value}> would render the badge with undefined and crash.
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|jsx)$/u.test(entry.name)) files.push(path)
    }
  }
  walk(new URL('../src/client', import.meta.url).pathname)
  const offenders = []
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_]*)\b[^>]*?\sref=\{/gsu)) {
      offenders.push(`${path}: <${match[1]} ref={...}>`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('selection styles target the classes and attributes the components set', () => {
  const read = path => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const css = read('styles.css')
  const timeline = read('history/Timeline.jsx')
  const tree = read('detail/ChangeTree.jsx')

  // Timeline rows mark the selected node with aria-current, and so does the style.
  assert.match(timeline, /'aria-current': index === selectedRow \? 'true'/u)
  assert.match(css, /\.vcs-timeline-row\[aria-current='true'\]/u)

  // The change tree marks the row being read with aria-current="location";
  // the style matches any aria-current value.
  assert.match(tree, /aria-current=\{readingKey === row\.key \? 'location' : undefined\}/u)
  assert.match(css, /\.vcs-tree-row\[aria-current\]/u)
  assert.doesNotMatch(css, /aria-selected/u)
})

test('focus marks use the host focus color and leave sticky rows opaque', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map(([, selector, body]) => ({ parts: selector.split(',').map(part => part.trim()), body }))

  // Every ring names the host focus color and falls back to the host's own
  // default, which the host clears for pointer input.
  const rings = css.match(/var\(--dsw-focus-ring-color[^;]*/gu) ?? []
  assert.ok(rings.length >= 4)
  for (const ring of rings) {
    assert.match(ring, /^var\(--dsw-focus-ring-color, var\(--dsw-alias-state-business-primary\)\)/u)
  }

  // brand-primary is near black or white in the host themes; it never marks
  // focus, the cursor, or the current row.
  const offenders = rules
    .filter(rule => rule.parts.some(part => /focus|aria-current/u.test(part)) && /brand-primary/u.test(rule.body))
    .flatMap(rule => rule.parts)
  assert.deepEqual(offenders, [])

  // Row states paint a pill under the content, never the row's own
  // background, so a stuck group or file head stays opaque while it is
  // hovered, current, or focused.
  const rowStates = rules.filter(rule => /(^|;|\s)background:/u.test(rule.body)
    && rule.parts.some(part => /\.vcs-(tree|timeline)-row/u.test(part) && /:hover|:focus|\[aria-current/u.test(part)))
  assert.ok(rowStates.length >= 3)
  for (const rule of rowStates) {
    for (const part of rule.parts.filter(candidate => /\.vcs-(tree|timeline)-row/u.test(candidate))) {
      assert.match(part, /::before$/u, part)
    }
  }
})

test('the change tree exposes disclosure semantics and one tab stop', () => {
  const read = path => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const css = read('styles.css')
  const tree = read('detail/ChangeTree.jsx')

  // Every expandable row announces its state and controls its content.
  assert.match(tree, /aria-expanded=\{row\.expanded\}/u)
  assert.match(tree, /aria-expanded=\{expanded\}/u)
  assert.match(tree, /aria-controls=\{bodyId\}/u)
  // Roving tabindex: the whole tree is one Tab stop.
  assert.match(tree, /tabIndex: row\.key === cursorKey \? 0 : -1/u)
  // Hunk jumps locate the markers the diff renderer already writes.
  assert.match(tree, /data-diff-hunk-header/u)
  // The file head sticks below the group head, so at most two rows hold the top.
  assert.match(css, /\.vcs-tree\[data-grouped\] \.vcs-tree-file-head-wrap \{\s*top: var\(--vcs-row-height\);/u)
})

test('SidebarVcsView passes visible and bumps focusRequest on visibility transitions even at revision 0', () => {
  const createRunner = () => {
    const hooks = []
    let hookIndex = 0
    const pendingEffects = []
    const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length
      && a.every((v, i) => Object.is(v, b[i]))
    const reactOverrides = {
      useState(initial) {
        const idx = hookIndex++
        if (idx >= hooks.length) hooks.push({ value: typeof initial === 'function' ? initial() : initial })
        const slot = hooks[idx]
        return [slot.value, action => {
          slot.value = typeof action === 'function' ? action(slot.value) : action
        }]
      },
      useRef(initial) {
        const idx = hookIndex++
        if (idx >= hooks.length) hooks.push({ current: initial })
        return hooks[idx]
      },
      useEffect(create, deps) {
        const idx = hookIndex++
        const prev = hooks[idx]
        if (prev === undefined || !sameDeps(prev.deps, deps)) {
          const entry = { create, deps }
          hooks[idx] = entry
          pendingEffects.push(entry)
        }
      },
    }
    const { plugin } = loadBundle({ reactOverrides })
    const registrations = []
    const previousDocument = globalThis.document
    globalThis.document = {
      head: { appendChild() {} },
      createElement() { return { dataset: {}, textContent: '', remove() {} } },
    }
    try {
      plugin.apply({
        inject() { return () => undefined },
        effect(fn) { return fn() },
        locale: localeStub('en'),
        uiConversation: { events: { register() { return () => undefined } } },
        sidebarRight: { mounted: { getSnapshot: () => 's1' }, isExpanded: () => false, active: () => undefined, openTab() {} },
        sidebarRightTabs: { register() { return () => undefined } },
        slots: {
          inject(_key, callback) { return callback() },
          register(options, component) { registrations.push({ options, component }); return () => undefined },
        },
      })
    } finally {
      globalThis.document = previousDocument
    }
    const SidebarVcsView = registrations.find(entry => entry.options.name === 'sidebar.right.pane.tab').component
    return {
      render(tab) {
        hookIndex = 0
        const tree = SidebarVcsView({ sessionId: 's1', useTabInfo: () => ({ tab }) })
        while (pendingEffects.length > 0) {
          pendingEffects.shift().create()
        }
        hookIndex = 0
        return SidebarVcsView({ sessionId: 's1', useTabInfo: () => ({ tab }) }).props.children.props
      },
    }
  }

  // Case 1: starts hidden at revision 0, then becomes visible via tab-chip click (revision stays 0).
  {
    const runner = createRunner()
    const hidden = runner.render({ visible: false, navigation: { revision: 0 } })
    assert.equal(hidden.visible, false)
    assert.equal(hidden.focusRequest, 0)

    const revealed = runner.render({ visible: true, navigation: { revision: 0 } })
    assert.equal(revealed.visible, true)
    assert.equal(revealed.focusRequest, 1, 'revealing a tab bumps focusRequest even at revision 0')

    const hiddenAgain = runner.render({ visible: false, navigation: { revision: 0 } })
    assert.equal(hiddenAgain.visible, false)
    assert.equal(hiddenAgain.focusRequest, 1)
  }

  // Case 2: restored visible at revision 0 keeps focusRequest at 0, then increments on navigation.
  {
    const runner = createRunner()
    const restored = runner.render({ visible: true, navigation: { revision: 0 } })
    assert.equal(restored.visible, true)
    assert.equal(restored.focusRequest, 0, 'reload restoration keeps focusRequest at 0')

    const navigated = runner.render({ visible: true, navigation: { revision: 1 } })
    assert.equal(navigated.visible, true)
    assert.equal(navigated.focusRequest, 1)
  }
})
