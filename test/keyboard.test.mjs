/**
 * End-to-end component tests for keyboard navigation while files and commits
 * are still loading or are cancelled mid-response.
 *
 * Compiles `VcsView` and `ChangeTree` with esbuild in memory (matching
 * `scripts/build.mjs`) and drives them through a minimal stateful React + DOM
 * harness so hook lifecycles, refs, observers, focus transitions, and keyboard
 * handlers run together without a browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../lib/client/api.js'
import { buildNodeRows } from '../lib/client/detail/tree.js'
import { budgetFolds, mergedWorktreeGroups, streamSections } from '../lib/client/detail/detail.js'
import { GIT_CAPABILITIES, GIT_WORKTREE_CAPABILITIES, JUJUTSU_CAPABILITIES } from '../lib/vcs/capabilities.js'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Convert a `data-foo-bar` attribute name to its `dataset.fooBar` key. */
function datasetKey(attr) {
  return attr.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
}

/** Minimal DOM element supporting focus, layout offsets, and attribute queries. */
class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.props = {}
    this.dataset = {}
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.offsetParent = null
    this.offsetTop = 0
    this.clientWidth = 1000
    this.clientHeight = 500
    this.scrollTop = 0
    this.listeners = new Map()
    this.classList = {
      contains: token => {
        const raw = this.props.className
        return typeof raw === 'string' && raw.split(/\s+/u).includes(token)
      },
    }
  }

  applyProps(nextProps) {
    this.props = nextProps
    this.dataset = {}
    this.attributes.clear()
    for (const [key, value] of Object.entries(nextProps)) {
      if (value === undefined || value === null) continue
      if (key.startsWith('data-')) {
        this.dataset[datasetKey(key)] = String(value)
        this.attributes.set(key, String(value))
      } else if (key.startsWith('aria-') || key === 'id' || key === 'role' || key === 'title' || key === 'type') {
        this.attributes.set(key, String(value))
      }
    }
  }

  setChildren(children) {
    for (const previous of this.children) {
      if (previous instanceof FakeElement && previous.parentElement === this) {
        previous.parentElement = null
      }
    }
    this.children = children
    for (const child of children) {
      if (child instanceof FakeElement) {
        child.parentElement = this
        if (child.offsetParent === null) child.offsetParent = this
      }
    }
  }

  focus() {
    this.ownerDocument.activeElement = this
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body
    }
  }

  select() {}

  get isConnected() {
    let cursor = this
    while (cursor.parentElement !== null && cursor.parentElement !== undefined) cursor = cursor.parentElement
    return cursor === this.ownerDocument.body || cursor === this.ownerDocument.documentElement
  }

  contains(target) {
    let cursor = target
    while (cursor !== null && cursor !== undefined) {
      if (cursor === this) return true
      cursor = cursor.parentElement
    }
    return false
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  getBoundingClientRect() {
    let top = 0
    let cursor = this
    while (cursor !== null) {
      top += cursor.offsetTop - (cursor.parentElement?.scrollTop ?? 0)
      cursor = cursor.parentElement
    }
    return { top, left: 0, width: this.clientWidth, height: 28, bottom: top + 28 }
  }

  matchesSelector(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matchesSelector(part.trim()))
    const compound = /^(\.[\w-]+)(\[.+\])$/u.exec(selector)
    if (compound !== null) return this.matchesSelector(compound[1]) && this.matchesSelector(compound[2])
    const exact = /^\[([a-z0-9-]+)="([^"]*)"\]$/iu.exec(selector)
    if (exact !== null) return this.attributes.get(exact[1]) === exact[2]
    const present = /^\[([a-z0-9-]+)\]$/iu.exec(selector)
    if (present !== null) return this.attributes.has(present[1])
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    return false
  }

  querySelectorAll(selector) {
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue
        if (child.matchesSelector(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** Compare hook dependency arrays with React's `Object.is` semantics. */
function sameDeps(prev, next) {
  if (prev === undefined || next === undefined || prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return false
  }
  return true
}

/** Shallow prop equality used by `React.memo`. */
function shallowEqual(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.is(left[key], right[key]))
}

/**
 * Create an isolated React + DOM test harness that supports stateful re-renders,
 * layout/passive effects, refs, IntersectionObserver, ResizeObserver, and rAF.
 */
function createHarness({ width = 1000 } = {}) {
  const Fragment = Symbol('Fragment')
  const MEMO = Symbol('memo')
  let activeInstance = null

  const docListeners = new Map()
  const winListeners = new Map()
  let selection = { isCollapsed: true, toString: () => '' }

  const addListener = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  const removeListener = (map, type, fn) => {
    map.get(type)?.delete(fn)
  }

  const document = {
    visibilityState: 'visible',
    documentElement: null,
    body: null,
    activeElement: null,
    addEventListener(type, fn) { addListener(docListeners, type, fn) },
    removeEventListener(type, fn) { removeListener(docListeners, type, fn) },
  }
  document.documentElement = new FakeElement('html', document)
  document.body = new FakeElement('body', document)
  document.body.parentElement = document.documentElement
  document.activeElement = document.body

  const win = {
    innerWidth: width,
    innerHeight: 800,
    addEventListener(type, fn) { addListener(winListeners, type, fn) },
    removeEventListener(type, fn) { removeListener(winListeners, type, fn) },
    getSelection() { return selection },
  }

  const frames = []
  const intersections = []
  const resizes = []

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = new Set()
      intersections.push(this)
    }
    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.observed.clear() }
    trigger(predicate) {
      const entries = []
      for (const target of this.observed) {
        entries.push({ target, isIntersecting: predicate(target) })
      }
      if (entries.length > 0) this.callback(entries)
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = new Set()
      resizes.push(this)
    }
    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.observed.clear() }
  }

  function createElement(type, rawProps, ...restChildren) {
    const source = rawProps ?? {}
    const props = { ...source }
    const key = props.key ?? null
    const ref = props.ref ?? null
    delete props.key
    delete props.ref
    if (restChildren.length === 1) props.children = restChildren[0]
    else if (restChildren.length > 1) props.children = restChildren
    return { type, key, ref, props }
  }

  const react = {
    Fragment,
    createElement,
    memo(component) {
      return { $$typeof: MEMO, type: component }
    },
    useState(initial) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      if (idx >= inst.hooks.length) {
        inst.hooks.push({ value: typeof initial === 'function' ? initial() : initial })
      }
      const slot = inst.hooks[idx]
      const setState = action => {
        const next = typeof action === 'function' ? action(slot.value) : action
        if (!Object.is(next, slot.value)) {
          slot.value = next
          inst.dirty = true
          scheduleRender()
        }
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      if (idx >= inst.hooks.length) inst.hooks.push({ current: initial })
      return inst.hooks[idx]
    },
    useMemo(factory, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value
      const value = factory()
      inst.hooks[idx] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps)
    },
    useLayoutEffect(create, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        const entry = { create, deps, cleanup: prev?.cleanup }
        inst.hooks[idx] = entry
        inst.localLayout.push(entry)
      }
    },
    useEffect(create, deps) {
      const inst = activeInstance
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (prev === undefined || !sameDeps(prev.deps, deps)) {
        const entry = { create, deps, cleanup: prev?.cleanup }
        inst.hooks[idx] = entry
        inst.localPassive.push(entry)
      }
    },
  }

  const jsxRuntime = {
    Fragment,
    jsx(type, rawProps, maybeKey) {
      const props = { ...(rawProps ?? {}) }
      if (maybeKey !== undefined) props.key = maybeKey
      return createElement(type, props)
    },
    jsxs(type, rawProps, maybeKey) {
      return jsxRuntime.jsx(type, rawProps, maybeKey)
    },
  }

  let rootElement = null
  let rootInstance = null
  let pendingLayout = []
  let pendingPassive = []
  let rendering = false
  let dirty = false

  function assignRef(ref, value) {
    if (ref === null || ref === undefined) return
    if (typeof ref === 'function') ref(value)
    else if (typeof ref === 'object') ref.current = value
  }

  function unmountNode(mounted) {
    if (mounted === null || mounted === undefined) return
    if (mounted.kind === 'component') {
      unmountNode(mounted.child)
      for (const hook of mounted.hooks) {
        if (typeof hook?.cleanup === 'function') {
          const clean = hook.cleanup
          hook.cleanup = undefined
          clean()
        }
      }
      return
    }
    if (mounted.kind === 'host') {
      for (const child of mounted.children) unmountNode(child)
      assignRef(mounted.ref, null)
      if (document.activeElement === mounted.dom) document.activeElement = document.body
      return
    }
    if (mounted.kind === 'list') {
      for (const child of mounted.items) unmountNode(child)
    }
  }

  function domNodesOf(mounted, out = []) {
    if (mounted === null || mounted === undefined) return out
    if (mounted.kind === 'text' || mounted.kind === 'host') out.push(mounted.dom)
    else if (mounted.kind === 'component') domNodesOf(mounted.child, out)
    else if (mounted.kind === 'list') {
      for (const item of mounted.items) domNodesOf(item, out)
    }
    return out
  }

  function hasDirty(mounted) {
    if (mounted === null || mounted === undefined) return false
    if (mounted.kind === 'component') return mounted.dirty === true || hasDirty(mounted.child)
    if (mounted.kind === 'host') return mounted.children.some(hasDirty)
    if (mounted.kind === 'list') return mounted.items.some(hasDirty)
    return false
  }

  function reconcile(prev, vnode) {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') {
      unmountNode(prev)
      return null
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      unmountNode(prev)
      return { kind: 'text', dom: String(vnode) }
    }
    if (Array.isArray(vnode)) {
      return reconcileList(prev?.kind === 'list' ? prev : (unmountNode(prev), null), vnode)
    }
    if (vnode.type === Fragment) {
      const items = Array.isArray(vnode.props.children)
        ? vnode.props.children
        : vnode.props.children === undefined ? [] : [vnode.props.children]
      return reconcileList(prev?.kind === 'list' ? prev : (unmountNode(prev), null), items)
    }
    const isMemo = typeof vnode.type === 'object' && vnode.type?.$$typeof === MEMO
    const fn = isMemo ? vnode.type.type : vnode.type
    if (typeof fn === 'function') {
      if (prev?.kind === 'component' && prev.fn === fn && prev.key === vnode.key) {
        if (isMemo && shallowEqual(prev.props, vnode.props) && !hasDirty(prev)) {
          return prev
        }
        prev.dirty = false
        prev.props = vnode.props
        prev.hookIndex = 0
        prev.localLayout = []
        prev.localPassive = []
        const saved = activeInstance
        activeInstance = prev
        let rendered
        try {
          rendered = fn(vnode.props)
        } finally {
          activeInstance = saved
        }
        const localLayout = prev.localLayout
        const localPassive = prev.localPassive
        prev.child = reconcile(prev.child, rendered)
        pendingLayout.push(...localLayout)
        pendingPassive.push(...localPassive)
        return prev
      }
      unmountNode(prev)
      const inst = {
        kind: 'component',
        fn,
        key: vnode.key,
        props: vnode.props,
        hooks: [],
        hookIndex: 0,
        child: null,
        localLayout: [],
        localPassive: [],
      }
      const saved = activeInstance
      activeInstance = inst
      let rendered
      try {
        rendered = fn(vnode.props)
      } finally {
        activeInstance = saved
      }
      const localLayout = inst.localLayout
      const localPassive = inst.localPassive
      inst.child = reconcile(null, rendered)
      pendingLayout.push(...localLayout)
      pendingPassive.push(...localPassive)
      return inst
    }

    // Host element.
    const sameHost = prev?.kind === 'host' && prev.tag === vnode.type && prev.key === vnode.key
    if (!sameHost) unmountNode(prev)
    const dom = sameHost ? prev.dom : new FakeElement(vnode.type, document)
    if (!sameHost) dom.clientWidth = width
    if (sameHost && prev.ref !== vnode.ref) assignRef(prev.ref, null)
    dom.applyProps(vnode.props)
    const rawChildren = vnode.props.children
    const childList = Array.isArray(rawChildren)
      ? rawChildren
      : rawChildren === undefined ? [] : [rawChildren]
    const prevChildren = sameHost ? prev.children : []
    const nextChildren = reconcileChildren(prevChildren, childList)
    dom.setChildren(nextChildren.flatMap(child => domNodesOf(child)))
    if (!sameHost || prev.ref !== vnode.ref) assignRef(vnode.ref, dom)
    return { kind: 'host', tag: vnode.type, key: vnode.key, ref: vnode.ref, dom, children: nextChildren }
  }

  function reconcileChildren(prevList, nextVNodes) {
    const keyedPrev = new Map()
    const unkeyedPrev = []
    for (const item of prevList) {
      if (item !== null && item !== undefined && item.key !== null && item.key !== undefined) {
        keyedPrev.set(item.key, item)
      } else {
        unkeyedPrev.push(item)
      }
    }
    let unkeyedAt = 0
    const next = nextVNodes.map(vnode => {
      const key = vnode !== null && typeof vnode === 'object' && !Array.isArray(vnode) ? vnode.key : null
      if (key !== null && key !== undefined) {
        const match = keyedPrev.get(key) ?? null
        if (match !== null) keyedPrev.delete(key)
        return reconcile(match, vnode)
      }
      const candidate = unkeyedPrev[unkeyedAt++] ?? null
      return reconcile(candidate, vnode)
    })
    for (const leftover of keyedPrev.values()) unmountNode(leftover)
    for (let i = unkeyedAt; i < unkeyedPrev.length; i += 1) unmountNode(unkeyedPrev[i])
    return next
  }

  function reconcileList(prev, items) {
    const prevItems = prev?.items ?? []
    return { kind: 'list', key: null, items: reconcileChildren(prevItems, items) }
  }

  function flushEffects(list) {
    const batch = list.splice(0, list.length)
    for (const effect of batch) {
      if (typeof effect.cleanup === 'function') {
        const clean = effect.cleanup
        effect.cleanup = undefined
        clean()
      }
      const cleanup = effect.create()
      effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  function renderNow() {
    if (rootElement === null || rendering) {
      if (rendering) dirty = true
      return
    }
    rendering = true
    try {
      do {
        dirty = false
        rootInstance = reconcile(rootInstance, rootElement)
        const nodes = domNodesOf(rootInstance)
        document.body.setChildren(nodes)
        flushEffects(pendingLayout)
        flushEffects(pendingPassive)
      } while (dirty || pendingLayout.length > 0 || pendingPassive.length > 0)
    } finally {
      rendering = false
    }
  }

  function scheduleRender() {
    if (rendering) {
      dirty = true
      return
    }
    renderNow()
  }

  let nextFrameId = 1
  const frameMap = new Map()
  const installGlobals = () => {
    const saved = {
      document: globalThis.document,
      window: globalThis.window,
      hasWindow: 'window' in globalThis,
      IntersectionObserver: globalThis.IntersectionObserver,
      ResizeObserver: globalThis.ResizeObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    }
    globalThis.document = document
    globalThis.window = win
    globalThis.IntersectionObserver = FakeIntersectionObserver
    globalThis.ResizeObserver = FakeResizeObserver
    globalThis.requestAnimationFrame = callback => {
      const id = nextFrameId++
      frameMap.set(id, callback)
      frames.push(id)
      return id
    }
    globalThis.cancelAnimationFrame = id => { frameMap.delete(id) }
    return () => {
      globalThis.document = saved.document
      if (saved.hasWindow) globalThis.window = saved.window
      else delete globalThis.window
      globalThis.IntersectionObserver = saved.IntersectionObserver
      globalThis.ResizeObserver = saved.ResizeObserver
      globalThis.requestAnimationFrame = saved.requestAnimationFrame
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame
    }
  }

  return {
    react,
    jsxRuntime,
    document,
    window: win,
    intersections,
    resizes,
    installGlobals,
    setSelection(text) {
      selection = text
        ? { isCollapsed: false, toString: () => text }
        : { isCollapsed: true, toString: () => '' }
    },
    dispatchWindow(type, event = {}) {
      for (const fn of [...(winListeners.get(type) ?? [])]) fn(event)
      renderNow()
    },
    dispatchDocument(type, event = {}) {
      for (const fn of [...(docListeners.get(type) ?? [])]) fn(event)
      renderNow()
    },
    mount(vnode) {
      rootElement = vnode
      renderNow()
    },
    unmount() {
      unmountNode(rootInstance)
      rootInstance = null
      rootElement = null
    },
    flushFrames() {
      while (frames.length > 0) {
        const batch = frames.splice(0, frames.length)
        for (const id of batch) {
          const callback = frameMap.get(id)
          frameMap.delete(id)
          callback?.(0)
        }
        renderNow()
      }
    },
    async settle() {
      for (let i = 0; i < 6; i += 1) {
        await new Promise(resolve => { setTimeout(resolve, 0) })
        renderNow()
        this.flushFrames()
      }
    },
    keyDown(target, key, extra = {}) {
      let prevented = false
      let stopped = false
      const event = {
        key,
        target,
        currentTarget: target,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        get defaultPrevented() { return prevented },
        preventDefault() { prevented = true },
        stopPropagation() { stopped = true },
        ...extra,
      }
      let cursor = target
      while (cursor !== null && cursor !== undefined && !stopped) {
        if (typeof cursor.props?.onKeyDown === 'function') {
          event.currentTarget = cursor
          cursor.props.onKeyDown(event)
        }
        cursor = cursor.parentElement
      }
      renderNow()
      return { prevented, stopped }
    },
    mouseClick(target, extra = {}) {
      for (const fn of [...(docListeners.get('pointerdown') ?? [])]) {
        fn({ target, button: 0, clientX: 20, clientY: 20 })
      }
      let downPrevented = false
      let downStopped = false
      const downEvent = {
        button: 0,
        target,
        currentTarget: target,
        clientX: 20,
        clientY: 20,
        get defaultPrevented() { return downPrevented },
        preventDefault() { downPrevented = true },
        stopPropagation() { downStopped = true },
      }
      let cursor = target
      while (cursor !== null && cursor !== undefined && !downStopped) {
        if (typeof cursor.props?.onMouseDown === 'function') {
          downEvent.currentTarget = cursor
          cursor.props.onMouseDown(downEvent)
        }
        cursor = cursor.parentElement
      }
      if (!downPrevented) {
        let focusable = target
        while (focusable !== null && focusable !== undefined) {
          if (focusable.tagName === 'BUTTON' || focusable.tagName === 'SELECT' || focusable.tagName === 'INPUT') {
            document.activeElement = focusable
            break
          }
          focusable = focusable.parentElement
        }
      }
      let prevented = false
      let stopped = false
      const clickEvent = {
        detail: 1,
        clientX: 20,
        clientY: 20,
        target,
        currentTarget: target,
        get defaultPrevented() { return prevented },
        preventDefault() { prevented = true },
        stopPropagation() { stopped = true },
        ...extra,
      }
      cursor = target
      while (cursor !== null && cursor !== undefined && !stopped) {
        if (typeof cursor.props?.onClick === 'function') {
          clickEvent.currentTarget = cursor
          cursor.props.onClick(clickEvent)
        }
        cursor = cursor.parentElement
      }
      renderNow()
      return { downPrevented, prevented, stopped }
    },
    keyClick(target, key = 'Enter') {
      const result = this.keyDown(target, key)
      if (!result.prevented) {
        let stopped = false
        let prevented = false
        const clickEvent = {
          detail: 0,
          target,
          currentTarget: target,
          get defaultPrevented() { return prevented },
          preventDefault() { prevented = true },
          stopPropagation() { stopped = true },
        }
        let cursor = target
        while (cursor !== null && cursor !== undefined && !stopped) {
          if (typeof cursor.props?.onClick === 'function') {
            clickEvent.currentTarget = cursor
            cursor.props.onClick(clickEvent)
          }
          cursor = cursor.parentElement
        }
        renderNow()
      }
      return result
    },
  }
}

/** Bundle a client module in memory and evaluate it against a harness's React. */
const compiledCache = new Map()
async function loadClientModule(entryRelPath, harness) {
  let code = compiledCache.get(entryRelPath)
  if (code === undefined) {
    const built = await build({
      entryPoints: [resolve(ROOT, entryRelPath)],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      loader: { '.css': 'text' },
    })
    code = built.outputFiles[0].text
    compiledCache.set(entryRelPath, code)
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    specifier => {
      if (specifier === 'react') return harness.react
      if (specifier === 'react/jsx-runtime') return harness.jsxRuntime
      throw new Error(`unexpected require(${specifier})`)
    },
    mod,
    mod.exports,
  )
  return mod.exports
}

const t = (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`)

test('keyboard navigation past in-flight diffs that abort mid-body never crashes or poisons the cache', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const entries = [
      { path: 'a.js', status: 'M', added: 4, deleted: 1 },
      { path: 'b.js', status: 'M', added: 3, deleted: 0 },
    ]
    const groups = [{ id: 'unstaged', entries, header: true }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const cache = new Map()
    const control = { current: null }

    // First attempt on `a.js`: 200 OK headers arrived, body stream is still
    // waiting when the user navigates away and IntersectionObserver aborts it.
    let aAttempts = 0
    let pendingBodyAbort = null
    const api = createApi('s-1', {
      fetchImpl: async (url, options) => {
        const parsed = new URL(url, 'http://127.0.0.1')
        const path = parsed.searchParams.get('path')
        if (path === 'a.js' && aAttempts++ === 0) {
          return {
            ok: true,
            status: 200,
            json: () => new Promise((_resolve, reject) => {
              pendingBodyAbort = () => reject(new DOMException('Aborted', 'AbortError'))
              options.signal.addEventListener('abort', () => { pendingBodyAbort() }, { once: true })
            }),
          }
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              kind: 'text',
              path,
              before: true,
              after: true,
              hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${path}`] }],
            }
          },
        }
      },
    })

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false, 'unstaged|b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache,
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))

    // Both files enter the observer window; a.js starts reading its JSON body,
    // b.js finishes.
    harness.intersections[0].trigger(() => true)
    await harness.settle()
    assert.notEqual(pendingBodyAbort, null, 'a.js is still streaming its body')

    // Focus the tree via keyboard and step down to b.js while a.js scrolls out
    // of the preload margin before its diff finishes loading.
    assert.equal(control.current.focusReading(), true)
    harness.keyDown(harness.document.activeElement, ']')
    harness.keyDown(harness.document.activeElement, ']')
    harness.intersections[0].trigger(el => el.dataset.fileKey !== 'unstaged|a.js')
    await harness.settle()

    assert.equal(
      [...cache.values()].some(({ diff }) => diff?.path === 'a.js'),
      false,
      'an aborted diff must not be cached as null',
    )

    // Stepping back onto a.js with `[` re-requests it cleanly and renders its hunk.
    harness.keyDown(harness.document.activeElement, '[')
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    assert.equal(aAttempts, 2)
    assert.equal([...cache.values()].some(({ diff }) => diff?.path === 'a.js'), true)
    const treeEl = harness.document.body.querySelector('.vcs-tree')
    assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 2)
  } finally {
    harness.unmount()
    restore()
  }
})

test('background Diff preserves an active gutter selection and sends its original fingerprint when staging', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{ id: 'unstaged', header: true, entries: [{ path: 'notes.txt', status: 'M', added: 2 }] }]
    const rows = buildNodeRows(groups)
    const cache = new Map()
    const changes = []
    const writes = []
    const mount = (backgroundDiffRevision, nextRows = rows, revision = 0) => {
      harness.mount(harness.react.createElement(ChangeTree, {
        api, repo: '/repo', rev: null, rows: nextRows, budget: new Map(),
        before: nextRows.length === 0 ? harness.react.createElement('p', { 'data-clean': '' }) : null,
        folds: { 'unstaged|notes.txt': false }, revision, backgroundDiffRevision, cache,
        initialAnchor: null, onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() {},
        onInteractionChange, onStage, control, t, locale: 'en-US',
      }))
    }
    const control = { current: null }
    const onInteractionChange = active => changes.push(active)
    let finishStage
    const onStage = target => {
      writes.push(target)
      return new Promise(resolve => { finishStage = resolve })
    }
    let fingerprint = 'before'
    const api = {
      async diff() {
        return {
          kind: 'text', path: 'notes.txt', before: true, after: true, lineStaging: true, fingerprint,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+first', '+second'] }],
        }
      },
    }
    mount(0)
    harness.intersections[0].trigger(() => true)
    await harness.settle()
    const tree = harness.document.body.querySelector('.vcs-tree')
    const line = tree.querySelector('[data-diff-line]')
    const gutter = tree.querySelectorAll('[data-line-stageable]')
    tree.scrollTop = 21
    gutter[0].props.onPointerDown({ button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} })
    gutter[1].props.onPointerEnter()
    assert.equal(changes.at(-1), true)

    mount(1)
    await harness.settle()
    assert.equal(tree.querySelector('[data-diff-line]') === line, true)
    assert.equal(tree.scrollTop, 21)
    assert.equal(tree.querySelectorAll('[data-line-selected]').length, 2)

    fingerprint = 'after'
    mount(2)
    await harness.settle()
    harness.dispatchWindow('pointerup', { type: 'pointerup', pointerId: 1 })
    await harness.settle()
    const stage = tree.querySelector('[data-stage-selection="stage"]')
    assert.ok(stage)
    harness.mouseClick(stage)
    assert.equal(writes[0].fingerprint, 'before')
    assert.deepEqual(writes[0].lines, [{ hunk: 0, line: 0 }, { hunk: 0, line: 1 }])

    mount(3, [])
    assert.equal(tree.querySelector('[data-diff-line]') === line, true, 'a clean status preserves the pending staging row')
    assert.equal(tree.querySelector('[data-clean]'), null)
    assert.equal(changes.at(-1), true)
    finishStage(false)
    await harness.settle()
    assert.equal(tree.querySelector('[data-diff-line]'), null)
    assert.ok(tree.querySelector('[data-clean]'))
    assert.equal(changes.at(-1), false)
  } finally {
    harness.unmount()
    restore()
  }
})

test('background Diff keeps native text selected and manual refresh discards the buffered comparison', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const rows = buildNodeRows([{ id: 'unstaged', entries: [{ path: 'notes.txt', status: 'M', added: 1 }] }])
    const cache = new Map()
    const control = { current: null }
    let requests = 0
    let content = '+before'
    let resolveDiff
    const api = {
      diff() {
        requests += 1
        return new Promise(resolve => {
          resolveDiff = () => resolve({
            kind: 'text', path: 'notes.txt', before: true, after: true,
            hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [content] }],
          })
        })
      },
    }
    const mount = (backgroundDiffRevision, revision) => harness.mount(harness.react.createElement(ChangeTree, {
      api, repo: '/repo', rev: null, rows, budget: new Map(), folds: { 'unstaged|notes.txt': false },
      revision, backgroundDiffRevision, cache, initialAnchor: null,
      onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() {}, control, t, locale: 'en-US',
    }))
    mount(0, 0)
    harness.intersections[0].trigger(() => true)
    await harness.settle()
    resolveDiff()
    await harness.settle()
    const body = harness.document.body.querySelector('.vcs-diff-body')
    const row = () => body.querySelector('[data-diff-line]')
    let removed = false
    harness.window.getSelection = () => ({
      isCollapsed: removed,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: element => element === body }),
      removeAllRanges() { removed = true },
    })
    harness.dispatchDocument('selectionchange')
    mount(1, 0)
    await harness.settle()
    content = '+buffered'
    resolveDiff()
    await harness.settle()
    assert.equal(requests, 2)
    assert.equal(textOf(row()).includes('before'), true)
    assert.equal(removed, false)

    mount(1, 1)
    await harness.settle()
    assert.equal(removed, true)
    assert.equal(textOf(row()).includes('before'), true, 'the manual read did not adopt the old buffered answer')
    content = '+manual'
    resolveDiff()
    await harness.settle()
    assert.equal(requests, 3)
    assert.equal(textOf(row()).includes('manual'), true)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree measures static row containers rather than sticky-displaced headers', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'src/a.js', status: 'M', added: 20, deleted: 0 },
        { path: 'src/b.js', status: 'M', added: 5, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const readings = []

    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+line'] }],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|src/a.js': false, 'unstaged|src/b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading: value => { readings.push(value) },
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const groupHead = treeEl.querySelector('.vcs-tree-group-head')
    const dirWrap = treeEl.querySelector('.vcs-tree-dir')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const [fileAHead] = treeEl.querySelectorAll('.vcs-tree-file-head')

    // Simulate scrolled layout (`scrollTop = 300`) where sticky headers report
    // stuck `offsetTop` values (300 and 328) while static containers hold true flow positions.
    treeEl.scrollTop = 300
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    groupHead.offsetTop = 300
    groupHead.offsetParent = treeEl

    dirWrap.offsetTop = 28
    dirWrap.offsetParent = treeEl

    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileAHead.parentElement.offsetTop = 328
    fileAHead.parentElement.offsetParent = treeEl

    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl

    // Simulate scrolled layout (`scrollTop = 300`): before the fix, stuck
    // headers reported `offsetTop = 300` / `328` so `report()` misread the
    // directory row (`top = 28`) instead of `src/a.js` (`top = 56`), and `[`
    // refused to scroll back to `src/a.js`.
    treeEl.scrollTop = 300
    treeEl.props.onScroll?.({ currentTarget: treeEl })
    harness.flushFrames()
    assert.deepEqual(readings.at(-1), { key: 'unstaged|src/a.js', offset: 244 })

    control.current.focusReading()
    harness.keyDown(harness.document.activeElement, ']')
    treeEl.scrollTop = 300
    harness.keyDown(harness.document.activeElement, '[')
    assert.equal(treeEl.scrollTop, 28)
  } finally {
    harness.unmount()
    restore()
  }
})

test('added and untracked rows carry distinct letters and labels', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [
      {
        id: 'staged',
        header: true,
        entries: [{ path: 'added.txt', status: 'A', added: 2, deleted: 0 }],
      },
      {
        id: 'unstaged',
        header: true,
        entries: [
          { path: 'new.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
          { path: 'notes/', status: 'U', untracked: true, directory: true, added: 0, deleted: 0 },
          { path: 'tracked.txt', status: 'M', added: 3, deleted: 1 },
        ],
      },
    ]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const api = {
      async diff() {
        throw new Error('a folded file requests no diff')
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: {},
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const [addedHead, newHead] = treeEl.querySelectorAll('.vcs-tree-file-head')
    const [stagedHead, unstagedHead] = treeEl.querySelectorAll('.vcs-tree-group-head')
    assert.equal(stagedHead.querySelector('[title="status.untracked"]'), null)
    const untrackedStat = unstagedHead.querySelector('[title="status.untracked"]')
    assert.equal(textOf(untrackedStat.querySelector('[aria-hidden="true"]')), '+2')
    assert.equal(textOf(untrackedStat.querySelector('.vcs-sr-only')), 'status.untracked 2')
    assert.deepEqual(
      [...untrackedStat.parentElement.children],
      [untrackedStat, unstagedHead.querySelector('.vcs-add'), unstagedHead.querySelector('.vcs-del')],
    )

    const [addedStatus] = addedHead.querySelectorAll('.vcs-status')
    assert.equal(textOf(addedStatus), 'A')
    assert.equal(addedStatus.classList.contains('vcs-status-A'), true, 'A carries the success color')
    assert.equal(addedHead.querySelector('.vcs-sr-only')?.props?.children, 'status.added')
    assert.match(textOf(addedHead), /\+2/u, 'A measured addition states its line counts')

    const [newStatus] = newHead.querySelectorAll('.vcs-status')
    assert.equal(textOf(newStatus), 'U')
    assert.equal(newStatus.classList.contains('vcs-status-untracked'), true, 'the untracked U is neutral')
    assert.equal(newStatus.classList.contains('vcs-status-U'), false, 'the untracked U is not a conflict')
    assert.equal(newHead.querySelector('.vcs-sr-only')?.props?.children, 'status.untracked')
    assert.equal(textOf(newHead), 'Ustatus.untrackednew.txt', 'the row states no line counts')

    const dirHead = treeEl.querySelector('.vcs-tree-dir-head')
    const [dirStatus] = dirHead.querySelectorAll('.vcs-status')
    assert.equal(textOf(dirStatus), 'U')
    assert.equal(dirStatus.classList.contains('vcs-status-untracked'), true)
    assert.equal(dirHead.querySelector('.vcs-sr-only')?.props?.children, 'status.untracked')
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree moves through rows and hunk headers as one vertical list', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 2, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const hunk = line => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line] })
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: target.path === 'a.js' ? [hunk('+a1'), hunk('+a2')] : [hunk('+b1')],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false, 'unstaged|b.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 3)

    // Lay out one group row, two file rows, and hunks at 100 / 300 inside a.js
    // and 644 inside b.js.
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44
    headers[1].offsetTop = 244
    headers[2].offsetTop = 44

    const fileHeads = treeEl.querySelectorAll('.vcs-tree-file-head')

    // `]` reaches the first file row. Vertical movement from here walks the
    // row, then its hunk headers, then the next row.
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 0)

    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement, headers[0])
    assert.equal(treeEl.scrollTop, 44)
    harness.keyDown(harness.document.activeElement, 'ArrowDown')
    assert.equal(harness.document.activeElement, headers[1])
    assert.equal(treeEl.scrollTop, 244)
    harness.keyDown(harness.document.activeElement, 'k')
    assert.equal(harness.document.activeElement, headers[0])
    assert.equal(treeEl.scrollTop, 44)

    // Brackets skip the hunk level and move one tree row.
    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)
    assert.equal(fileHeads[1].attributes.get('aria-current'), 'location')

    harness.keyDown(harness.document.activeElement, '[')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(treeEl.scrollTop, 28)

    // The same list crosses file boundaries: the last hunk's next stop is the
    // next file row, and its next stop is that file's first hunk.
    harness.keyDown(harness.document.activeElement, 'j')
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement, headers[1])
    assert.equal(treeEl.scrollTop, 244)
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)
    assert.equal(fileHeads[1].attributes.get('aria-current'), 'location')
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement, headers[2])
    assert.equal(treeEl.scrollTop, 588)

    // Clicking a hunk header adopts it as the same stop; the next key continues
    // from there rather than from the previous file.
    treeEl.props.onClick({ target: headers[0], currentTarget: treeEl })
    assert.equal(harness.document.activeElement, headers[0])
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(harness.document.activeElement, headers[1])
    assert.equal(treeEl.scrollTop, 244)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree focuses a closed next file at the end of a diff', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 1, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'] }],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 1)
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44

    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    harness.keyDown(harness.document.activeElement, 'j')
    assert.equal(treeEl.scrollTop, 44)
    harness.keyDown(harness.document.activeElement, 'j')

    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)
    assert.equal(treeEl.querySelectorAll('.vcs-tree-file-head')[1].attributes.get('aria-expanded'), 'false')
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree moves from a closed file row into the previous open diff', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [
        { path: 'a.js', status: 'M', added: 2, deleted: 0 },
        { path: 'b.js', status: 'M', added: 1, deleted: 0 },
      ],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const hunk = line => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line] })
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: target.path === 'a.js' ? [hunk('+a1'), hunk('+a2')] : [hunk('+b1')],
        }
      },
    }

    harness.mount(harness.react.createElement(ChangeTree, {
      api,
      repo: '/repo',
      rev: null,
      rows,
      budget,
      folds: { 'unstaged|a.js': false },
      split: false,
      wrap: false,
      revision: 0,
      cache: new Map(),
      initialAnchor: null,
      onReading() {},
      onToggleRow() {},
      onBulkFold() {},
      onLeave() {},
      control,
      t,
      locale: 'en-US',
    }))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const groupWrap = treeEl.querySelector('.vcs-tree-group')
    const [fileASection, fileBSection] = treeEl.querySelectorAll('.vcs-tree-file')
    const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(headers.length, 2)
    groupWrap.offsetTop = 0
    groupWrap.offsetParent = treeEl
    fileASection.offsetTop = 56
    fileASection.offsetParent = treeEl
    fileBSection.offsetTop = 600
    fileBSection.offsetParent = treeEl
    headers[0].offsetTop = 44
    headers[1].offsetTop = 244

    const fileHeads = treeEl.querySelectorAll('.vcs-tree-file-head')

    // Reach the closed b.js row, then move up through either key.
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    assert.equal(treeEl.scrollTop, 572)

    harness.keyDown(harness.document.activeElement, 'ArrowUp')
    assert.equal(harness.document.activeElement, headers[1])
    assert.equal(treeEl.scrollTop, 244)
    assert.equal(fileHeads[0].attributes.get('aria-current'), 'location')

    harness.keyDown(harness.document.activeElement, ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|b.js')
    harness.keyDown(harness.document.activeElement, 'k')
    assert.equal(harness.document.activeElement, headers[1])
    assert.equal(treeEl.scrollTop, 244)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree closes an open file on left before leaving the tree', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [{
      id: 'unstaged',
      header: true,
      entries: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }],
    }]
    const rows = buildNodeRows(groups)
    const budget = budgetFolds(streamSections(groups, {}, null))
    const control = { current: null }
    const toggles = []
    let leaves = 0
    const api = {
      async diff(_repo, target) {
        return {
          kind: 'text',
          path: target.path,
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'] }],
        }
      },
    }

    function Tree() {
      const [folds, setFolds] = harness.react.useState({ 'unstaged|a.js': false })
      return harness.react.createElement(ChangeTree, {
        api,
        repo: '/repo',
        rev: null,
        rows,
        budget,
        folds,
        split: false,
        wrap: false,
        revision: 0,
        cache: new Map(),
        initialAnchor: null,
        onReading() {},
        onToggleRow(row, expanded) {
          toggles.push([row.key, expanded])
          setFolds(previous => ({ ...previous, [row.key]: !expanded }))
        },
        onBulkFold() {},
        onLeave() { leaves += 1 },
        control,
        t,
        locale: 'en-US',
      })
    }

    harness.mount(harness.react.createElement(Tree))
    harness.intersections[0].trigger(() => true)
    await harness.settle()

    const treeEl = harness.document.body.querySelector('.vcs-tree')
    const fileHead = () => treeEl.querySelector('.vcs-tree-file-head')
    harness.keyDown(treeEl.querySelector('.vcs-tree-group-head'), ']')
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
    assert.equal(fileHead().attributes.get('aria-expanded'), 'true')

    // The first left closes the diff level instead of leaving the tree.
    harness.keyDown(harness.document.activeElement, 'ArrowLeft')
    assert.deepEqual(toggles, [['unstaged|a.js', false]])
    assert.equal(leaves, 0)
    assert.equal(fileHead().attributes.get('aria-expanded'), 'false')

    // With the file already closed, the same key leaves the tree.
    harness.keyDown(harness.document.activeElement, 'ArrowLeft')
    assert.equal(leaves, 1)
    assert.deepEqual(toggles, [['unstaged|a.js', false]])

    // Escape remains the immediate way out, even while a file is open.
    harness.keyDown(harness.document.activeElement, 'l')
    assert.equal(fileHead().attributes.get('aria-expanded'), 'true')
    harness.keyDown(harness.document.activeElement, 'Escape')
    assert.equal(leaves, 2)
    assert.deepEqual(toggles, [['unstaged|a.js', false], ['unstaged|a.js', true]])
  } finally {
    harness.unmount()
    restore()
  }
})

test('VcsView lands keyboard focus on the timeline and completes deferred detail entry when commit files finish loading', async () => {
  for (const width of [1000, 620]) {
    const harness = createHarness({ width })
    const restore = harness.installGlobals()
    try {
      const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
      const sha1 = 'a'.repeat(40)
      const sha2 = 'b'.repeat(40)
      let resolveCommit2 = null

      const fetchImpl = async url => {
        const parsed = new URL(url, 'http://127.0.0.1')
        if (parsed.pathname === '/api/vcs.repositories') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                cwd: '/repo',
                truncated: false,
                repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.status') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                repo: { path: '/repo', name: 'repo' },
                vcs: 'git',
                capabilities: GIT_CAPABILITIES,
                defaultNode: sha1,
                branch: { name: 'main', oid: sha1, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
                groups: { staged: [], unstaged: [], untracked: [] },
                total: 0,
                truncated: false,
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.log') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                truncated: false,
                nextSkip: null,
                commits: [
                  { sha: sha1, parents: [sha2], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'latest' },
                  { sha: sha2, parents: [], refs: [], author: 'Ada', authorTime: 1_699_000_000_000, subject: 'initial' },
                ],
              }
            },
          }
        }
        if (parsed.pathname === '/api/vcs.commit') {
          const sha = parsed.searchParams.get('sha')
          if (sha === sha2) {
            await new Promise(resolve => { resolveCommit2 = resolve })
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                truncated: false,
                commit: {
                  sha,
                  parents: sha === sha1 ? [sha2] : [],
                  refs: [],
                  author: 'Ada',
                  authorTime: 1_700_000_000_000,
                  committer: 'Ada',
                  committerTime: 1_700_000_000_000,
                  subject: sha === sha1 ? 'latest' : 'initial',
                  message: '',
                  files: [{ path: 'src/app.js', status: 'M', added: 2, deleted: 1 }],
                },
              }
            },
          }
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { kind: 'text', path: 'src/app.js', before: true, after: true, hunks: [] }
          },
        }
      }

      const savedFetch = globalThis.fetch
      globalThis.fetch = fetchImpl
      try {
        harness.mount(harness.react.createElement(VcsView, {
          sessionId: `session-kbd-${width}`,
          t,
          locale: 'en-US',
          focusRequest: 1,
        }))
        await harness.settle()

        // Clean working tree defaults to HEAD (timeline index 1), and focus followed it.
        assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

        // Step down (`j`) onto sha2 and immediately press `→` (`ArrowRight`)
        // before sha2's files arrive (in wide layout commit starts on `j`; in
        // narrow layout DetailPane mounts on `ArrowRight`).
        harness.keyDown(harness.document.activeElement, 'j')
        await harness.settle()
        harness.keyDown(harness.document.activeElement, 'ArrowRight')
        await harness.settle()
        assert.notEqual(resolveCommit2, null, 'sha2 commit request is still pending')
        // While the commit is on its way, the detail draws the outline of its
        // facts and files: one named status region, no spinner sentence.
        const facts = harness.document.body.querySelector('.vcs-meta-skeleton')
        assert.notEqual(facts, null, 'the commit facts draw their outline while loading')
        assert.equal(facts.attributes.get('role'), 'status')
        assert.equal(facts.attributes.get('aria-busy'), 'true')
        const files = harness.document.body.querySelector('.vcs-tree-skeleton')
        assert.notEqual(files, null, 'the commit files draw tree rows while loading')
        assert.equal(files.attributes.get('aria-hidden'), 'true', 'the file outline does not repeat the status')
        assert.equal(harness.document.body.querySelector('.vcs-spinner'), null)
        if (width < 760) {
          const root = harness.document.body.querySelector('.vcs-root')
          assert.equal(root.contains(harness.document.activeElement), true, 'narrow view keeps focus inside the panel while loading')
        }

        // Once sha2's commit detail finishes, focus lands inside ChangeTree.
        resolveCommit2()
        await harness.settle()
        assert.match(harness.document.activeElement?.dataset?.rowKey ?? '', /^commit\|src/u)
        assert.equal(harness.document.body.querySelector('.vcs-meta-skeleton'), null, 'the outline gives way to the facts')
        assert.equal(harness.document.body.querySelector('.vcs-tree-skeleton'), null)
      } finally {
        globalThis.fetch = savedFetch
      }
    } finally {
      harness.unmount()
      restore()
    }
  }
})

test('rapid keyboard commit switching while commit and diff bodies abort never triggers ViewErrorBoundary', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    const sha1 = '1'.repeat(40)
    const sha2 = '2'.repeat(40)
    const sha3 = '3'.repeat(40)

    const fetchImpl = async (url, options) => {
      const parsed = new URL(url, 'http://127.0.0.1')
      if (parsed.pathname === '/api/vcs.repositories') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              cwd: '/repo',
              truncated: false,
              repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.status') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              repo: { path: '/repo', name: 'repo' },
              vcs: 'git',
              capabilities: GIT_CAPABILITIES,
              defaultNode: sha1,
              branch: { name: 'main', oid: sha1, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
              groups: { staged: [], unstaged: [], untracked: [] },
              total: 0,
              truncated: false,
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.log') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              truncated: false,
              nextSkip: null,
              commits: [
                { sha: sha1, parents: [sha2], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 3000, subject: 'c1' },
                { sha: sha2, parents: [sha3], refs: [], author: 'Ada', authorTime: 2000, subject: 'c2' },
                { sha: sha3, parents: [], refs: [], author: 'Ada', authorTime: 1000, subject: 'c3' },
              ],
            }
          },
        }
      }
      if (parsed.pathname === '/api/vcs.commit') {
        const sha = parsed.searchParams.get('sha')
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              truncated: false,
              commit: {
                sha,
                parents: [],
                refs: [],
                author: 'Ada',
                authorTime: 2000,
                committer: 'Ada',
                committerTime: 2000,
                subject: sha.slice(0, 4),
                message: '',
                files: [
                  { path: 'slow.js', status: 'M', added: 5, deleted: 1 },
                  { path: 'fast.js', status: 'M', added: 1, deleted: 0 },
                ],
              },
            }
          },
        }
      }
      // `/api/vcs.diff`: `slow.js` stays in body decoding until aborted on the
      // first visit, then resolves normally when revisited.
      const path = parsed.searchParams.get('path')
      const rev = parsed.searchParams.get('rev')
      if (path === 'slow.js' && rev === sha2 && options?.signal !== undefined) {
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolveBody, rejectBody) => {
            const timer = setTimeout(() => {
              resolveBody({ kind: 'text', path, before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+ok'] }] })
            }, 25)
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              rejectBody(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { kind: 'text', path, before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+ok'] }] }
        },
      }
    }

    const savedFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      harness.mount(harness.react.createElement(VcsView, {
        sessionId: 'session-rapid',
        t,
        locale: 'en-US',
        focusRequest: 1,
      }))
      await harness.settle()

      // Step sha1 -> sha2, trigger observer so `slow.js` starts body read, then
      // immediately step sha2 -> sha3 (aborting `slow.js` mid-body), then step
      // back sha3 -> sha2 and read its diffs.
      harness.keyDown(harness.document.activeElement, 'j')
      await harness.settle()
      for (const observer of harness.intersections) observer.trigger(() => true)
      await new Promise(resolve => { setTimeout(resolve, 5) })

      harness.keyDown(harness.document.activeElement, 'j')
      await harness.settle()

      harness.keyDown(harness.document.activeElement, 'k')
      await harness.settle()

      // Files start collapsed; open both of sha2's files before loading them.
      const treeEl = harness.document.body.querySelector('.vcs-tree')
      assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 0)
      const fileHeads = treeEl.querySelectorAll('.vcs-tree-file-head')
      assert.equal(fileHeads.length, 2)
      for (const head of fileHeads) {
        head.props.onClick()
        await harness.settle()
      }
      for (const observer of harness.intersections) observer.trigger(() => true)
      await new Promise(resolve => { setTimeout(resolve, 40) })
      await harness.settle()

      assert.equal(treeEl.querySelectorAll('[data-diff-hunk-header]').length, 2)
    } finally {
      globalThis.fetch = savedFetch
    }
  } finally {
    harness.unmount()
    restore()
  }
})

test('VcsView keeps one icon turning from a sync click until its refresh returns, with both buttons focusable', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  // Record the rotations `Turning` plays; the fake DOM has no compositor.
  const played = []
  FakeElement.prototype.animate = function animate(keyframes, options) {
    const animation = { element: this, keyframes, options, startTime: null, cancelled: false, cancel() { this.cancelled = true } }
    played.push(animation)
    return animation
  }
  const playedOn = element => played.filter(animation => animation.element === element)
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    const sha = 'c'.repeat(40)
    let statusCalls = 0
    let releaseStatus = null
    let releaseSync = null
    const json = body => ({ ok: true, status: 200, async json() { return body } })
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url, 'http://127.0.0.1')
      if (parsed.pathname === '/api/vcs.repositories') {
        return json({
          cwd: '/repo',
          truncated: false,
          repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
        })
      }
      if (parsed.pathname === '/api/vcs.status') {
        statusCalls += 1
        const ahead = statusCalls === 1 ? 2 : 0
        if (statusCalls > 1) await new Promise(resolve => { releaseStatus = resolve })
        return json({
          repo: { path: '/repo', name: 'repo' },
          vcs: 'git',
          capabilities: GIT_CAPABILITIES,
          defaultNode: sha,
          branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: 'origin/main', ahead, behind: 0 },
          groups: { staged: [], unstaged: [], untracked: [] },
          total: 0,
          truncated: false,
        })
      }
      if (parsed.pathname === '/api/vcs.sync') {
        assert.equal(init.method, 'POST')
        await new Promise(resolve => { releaseSync = resolve })
        return json({ upstream: 'origin/main', pulled: 0, pushed: 2 })
      }
      if (parsed.pathname === '/api/vcs.log') {
        return json({
          truncated: false,
          nextSkip: null,
          commits: [{ sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'only' }],
        })
      }
      if (parsed.pathname === '/api/vcs.commit') {
        return json({
          truncated: false,
          commit: { sha, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'only', message: '', files: [] },
        })
      }
      return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
    }

    const savedFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-sync', t, locale: 'en-US' }))
      await harness.settle()

      const body = harness.document.body
      const syncButton = body.querySelector('.vcs-sync')
      const refreshButton = body.querySelector('[aria-label="top.refresh"]')
      const progress = body.querySelector('.vcs-progress')
      assert.notEqual(syncButton, null, 'a branch with an upstream shows the sync button')
      const [syncIcon] = syncButton.querySelectorAll('.vcs-turning')
      const [refreshIcon] = refreshButton.querySelectorAll('.vcs-turning')
      assert.equal(played.length, 0, 'icons at rest play nothing')
      assert.equal(progress.attributes.get('data-sweeping'), undefined)

      syncButton.props.onClick()
      await harness.settle()
      assert.notEqual(releaseSync, null, 'the sync request is on its way')
      assert.equal(syncButton.attributes.get('aria-busy'), 'true')
      assert.equal(syncButton.attributes.get('title'), 'top.syncing')
      assert.equal(syncButton.attributes.get('disabled'), undefined, 'a busy sync button keeps focus')
      assert.equal(progress.attributes.get('data-busy'), 'true')
      const turning = playedOn(syncIcon)
      assert.equal(turning.length, 2, 'the sync icon spins up, then cruises')
      assert.deepEqual(turning[0].keyframes.map(frame => frame.transform), ['rotate(0deg)', 'rotate(90deg)'])
      assert.equal(turning[1].options.iterations, Infinity)

      releaseSync()
      await harness.settle()
      assert.notEqual(releaseStatus, null, 'the sync refreshes afterwards')
      assert.equal(syncButton.attributes.get('aria-busy'), 'true', 'the sync icon keeps turning through its refresh')
      assert.equal(refreshButton.attributes.get('aria-busy'), undefined, 'the refresh button does not take over')
      assert.equal(refreshButton.attributes.get('disabled'), undefined)
      assert.equal(playedOn(refreshIcon).length, 0, 'the refresh icon stays at rest')
      assert.equal(playedOn(syncIcon).length, 2, 'the spin is not restarted between the sync and its refresh')
      assert.equal(turning.some(animation => animation.cancelled), false)
      assert.equal(progress.attributes.get('data-busy'), 'true')

      releaseStatus()
      await harness.settle()
      assert.equal(syncButton.attributes.get('aria-busy'), undefined)
      assert.equal(turning.every(animation => animation.cancelled), true, 'the spin hands over to a glide')
      const glide = playedOn(syncIcon)[2]
      assert.notEqual(glide, undefined, 'the sync icon glides to rest instead of snapping back')
      const target = Number.parseFloat(glide.keyframes[1].transform.slice('rotate('.length))
      assert.equal(target % 180, 0, 'the glide ends where the two arrows look as at rest')
      assert.equal(glide.options.iterations, undefined)
      assert.equal(progress.attributes.get('data-busy'), undefined)
      assert.equal(progress.attributes.get('data-sweeping'), 'true', 'the progress line fades out with its sweep running')
      assert.equal(body.querySelector('.vcs-progress'), progress, 'the progress line stays mounted while it fades')
      await new Promise(resolve => { setTimeout(resolve, 300) })
      await harness.settle()
      assert.equal(progress.attributes.get('data-sweeping'), undefined, 'the sweep stops once the fade is over')
      assert.match(body.querySelector('.vcs-notice')?.props?.children ?? '', /^sync\.pushed\.other/u)
    } finally {
      globalThis.fetch = savedFetch
    }
  } finally {
    delete FakeElement.prototype.animate
    harness.unmount()
    restore()
  }
})

test('VcsView layout toggle shows the timeline beside the changes or one column at a time', async () => {
  const sha = 'd'.repeat(40)
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const fetchImpl = async url => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: sha,
        branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'only' }],
      })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      return json({
        truncated: false,
        commit: { sha, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'only', message: '', files: [] },
      })
    }
    return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
  }
  // The panel remembers the layout per Session; keep it in a store the test can read.
  const stored = new Map()
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)) },
  }
  const savedFetch = globalThis.fetch
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  globalThis.fetch = fetchImpl
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true })
  /** The columns and controls the layout decides. */
  const columns = body => ({
    root: body.querySelector('.vcs-root'),
    toggle: body.querySelector('.vcs-columns-toggle'),
    timeline: body.querySelector('.vcs-sidebar'),
    detail: body.querySelector('.vcs-content'),
    resizer: body.querySelector('.vcs-resizer'),
    back: body.querySelector('[aria-label="detail.back"]'),
  })
  try {
    // A wide panel: two columns by default; the toggle puts the timeline away.
    {
      const harness = createHarness({ width: 1000 })
      const restore = harness.installGlobals()
      try {
        const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
        harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-columns', t, locale: 'en-US' }))
        await harness.settle()
        const body = harness.document.body

        let view = columns(body)
        assert.notEqual(view.toggle, null, 'the header carries the layout toggle')
        assert.equal(view.toggle.attributes.get('aria-label'), 'top.twoColumns')
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'true')
        assert.equal(view.toggle.attributes.get('title'), 'top.twoColumnsOff', 'the tooltip names what a click does')
        assert.equal(view.toggle.querySelector('.vcs-icon').children.length, 3, 'the wide icon shows both panes')
        assert.equal(view.root.attributes.get('data-single-column'), undefined)
        assert.notEqual(view.timeline, null)
        assert.notEqual(view.detail, null)
        assert.notEqual(view.resizer, null)
        assert.equal(view.back, null, 'two columns need no way back')

        // One column at a time: the selected node's changes stay in front.
        view.toggle.props.onClick()
        await harness.settle()
        view = columns(body)
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'false')
        assert.equal(view.toggle.attributes.get('title'), 'top.twoColumnsOn')
        assert.equal(view.root.attributes.get('data-single-column'), 'true')
        assert.equal(view.root.attributes.get('data-narrow'), undefined, 'a wide header keeps its single row')
        assert.equal(view.timeline, null)
        assert.notEqual(view.detail, null, 'the changes take the full width')
        assert.equal(view.resizer, null)
        assert.notEqual(view.back, null)
        assert.equal(JSON.parse(stored.get('vcs:session-columns')).twoColumns, false, 'the choice is kept for the Session')

        // Back opens the timeline at full width; opening a node returns to its changes.
        view.back.props.onClick()
        await harness.settle()
        view = columns(body)
        assert.notEqual(view.timeline, null)
        assert.equal(view.timeline.props.style, undefined, 'the single timeline is not held to the column width')
        assert.equal(view.detail, null)
        const row = body.querySelector('[data-timeline-index="0"]')
        assert.notEqual(row, null)
        harness.keyDown(row, 'ArrowRight')
        await harness.settle()
        view = columns(body)
        assert.equal(view.timeline, null)
        assert.notEqual(view.detail, null)
        harness.keyDown(view.detail, 'Escape')
        await harness.settle()
        view = columns(body)
        assert.notEqual(view.timeline, null, 'Escape returns to the timeline')
        assert.equal(view.detail, null)

        // Beside again: both columns and the divider come back.
        view.toggle.props.onClick()
        await harness.settle()
        view = columns(body)
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'true')
        assert.notEqual(view.timeline, null)
        assert.notEqual(view.detail, null)
        assert.notEqual(view.resizer, null)
        assert.equal(view.back, null)
        assert.equal(JSON.parse(stored.get('vcs:session-columns')).twoColumns, true)

        // A Session that put the timeline away opens one column at a time.
        view.toggle.props.onClick()
        await harness.settle()
      } finally {
        harness.unmount()
        restore()
      }
    }
    {
      const harness = createHarness({ width: 1000 })
      const restore = harness.installGlobals()
      try {
        const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
        harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-columns', t, locale: 'en-US' }))
        await harness.settle()
        const view = columns(harness.document.body)
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'false', 'the restored panel keeps one column')
        assert.notEqual(view.timeline, null, 'a restored single column starts on the timeline')
        assert.equal(view.detail, null)
      } finally {
        harness.unmount()
        restore()
      }
    }
    // A narrow panel is one column whatever the preference; the toggle says so.
    {
      const harness = createHarness({ width: 620 })
      const restore = harness.installGlobals()
      try {
        const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
        harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-columns-narrow', t, locale: 'en-US' }))
        await harness.settle()
        const body = harness.document.body
        let view = columns(body)
        assert.equal(view.root.attributes.get('data-narrow'), 'true')
        assert.equal(view.root.attributes.get('data-single-column'), 'true')
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'true', 'the toggle keeps showing the preference')
        assert.equal(view.toggle.attributes.get('title'), 'top.twoColumnsNarrowOff top.twoColumnsNarrow')
        const narrowIcon = view.toggle.querySelector('.vcs-icon')
        assert.equal(narrowIcon.children.length, 2, 'the narrow icon leaves the timeline pane unfilled despite the preference')
        assert.notEqual(view.timeline, null)
        assert.equal(view.detail, null)

        view.toggle.props.onClick()
        await harness.settle()
        view = columns(body)
        assert.equal(view.toggle.attributes.get('aria-pressed'), 'false')
        assert.equal(view.toggle.attributes.get('title'), 'top.twoColumnsNarrowOn top.twoColumnsNarrow')
        assert.equal(view.toggle.querySelector('.vcs-icon').children.length, 2)
        assert.notEqual(view.timeline, null, 'a narrow panel stays on the column it showed')
        assert.equal(view.detail, null)
        view.toggle.props.onClick()
        await harness.settle()
        view.root.clientWidth = 1000
        for (const observer of harness.resizes) observer.callback()
        await harness.settle()
        view = columns(body)
        assert.equal(view.root.attributes.get('data-single-column'), undefined)
        assert.equal(view.toggle.querySelector('.vcs-icon').children.length, 3, 'the icon follows the wider layout')
      } finally {
        harness.unmount()
        restore()
      }
    }
  } finally {
    globalThis.fetch = savedFetch
    if (savedStorage === undefined) delete globalThis.sessionStorage
    else Object.defineProperty(globalThis, 'sessionStorage', savedStorage)
  }
})

/** Extract concatenated visible text beneath one FakeElement subtree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/** Install a minimal fake `window` object with dispatchable resize/scroll listeners. */
function installFakeWindow(innerWidth = 1000, innerHeight = 800) {
  const saved = globalThis.window
  const listeners = new Map()
  const fakeWindow = {
    innerWidth,
    innerHeight,
    addEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key).add(fn)
    },
    removeEventListener(type, fn, capture = false) {
      listeners.get(`${type}:${Boolean(capture)}`)?.delete(fn)
    },
    dispatch(type, event = {}, capture = false) {
      for (const fn of [...(listeners.get(`${type}:${Boolean(capture)}`) ?? [])]) fn(event)
    },
  }
  globalThis.window = fakeWindow
  return {
    window: fakeWindow,
    restore() {
      if (saved === undefined) delete globalThis.window
      else globalThis.window = saved
    },
  }
}

test('floating menus survive internal scroll, close on outside scroll/blur, and disable push without upstream', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const sha = 'd'.repeat(40)
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const savedFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: sha,
        branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.branches') {
      return json({ truncated: false, branches: [{ name: 'main', current: true }, { name: 'topic', current: false }] })
    }
    if (parsed.pathname === '/api/vcs.log') {
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'init' }],
      })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      return json({
        truncated: false,
        commit: { sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'init', message: '', files: [] },
      })
    }
    return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-menu', t, locale: 'en-US' }))
    await harness.settle()
    const body = harness.document.body
    const repoBtn = body.querySelector('.vcs-repo-button')
    const timeline = body.querySelector('.vcs-timeline-scroll')
    assert.notEqual(timeline, null)
    harness.keyDown(repoBtn, 'ArrowDown')
    await harness.settle()
    const repoMenu = body.querySelector('.vcs-repo-menu')
    assert.notEqual(repoMenu, null)
    const repoItem = repoMenu.querySelector('[aria-checked="true"]')
    assert.ok(harness.document.activeElement === repoItem, 'opening the repository menu focuses the current repository')

    fakeWin.window.dispatch('scroll', { target: body }, true)
    await harness.settle()
    assert.ok(body.querySelector('.vcs-repo-menu') === repoMenu, 'page scroll keeps the repository menu open')
    fakeWin.window.dispatch('scroll', { target: timeline }, true)
    await harness.settle()
    assert.ok(body.querySelector('.vcs-repo-menu') === repoMenu, 'timeline scroll keeps the repository menu open')
    assert.ok(harness.document.activeElement === repoItem, 'scroll keeps focus on the current repository')

    harness.keyDown(repoItem, 'Escape')
    await harness.settle()
    assert.equal(body.querySelector('.vcs-repo-menu'), null, 'Escape closes the repository menu')
    assert.ok(harness.document.activeElement === repoBtn, 'Escape restores focus to the repository button')

    harness.keyDown(repoBtn, 'ArrowDown')
    await harness.settle()
    assert.notEqual(body.querySelector('.vcs-repo-menu'), null)
    harness.dispatchDocument('pointerdown', { target: body })
    await harness.settle()
    assert.equal(body.querySelector('.vcs-repo-menu'), null, 'outside click closes the repository menu')

    const branchBtn = body.querySelector('.vcs-branch-button')
    assert.notEqual(branchBtn, null)

    // Header branch switcher ignores internal scroll and closes on outside scroll.
    branchBtn.props.onClick()
    await harness.settle()
    let branchMenu = body.querySelector('.vcs-branch-menu')
    assert.notEqual(branchMenu, null)
    const branchItem = branchMenu.querySelector('[data-branch-item]')
    assert.notEqual(branchItem, null)
    fakeWin.window.dispatch('scroll', { target: branchItem }, true)
    await harness.settle()
    assert.notEqual(body.querySelector('.vcs-branch-menu'), null, 'internal scroll keeps branch menu open')
    fakeWin.window.dispatch('scroll', { target: body }, true)
    await harness.settle()
    assert.equal(body.querySelector('.vcs-branch-menu'), null, 'outside scroll closes branch menu')

    // RefActionsMenu for current branch without upstream disables Push with reason,
    // stays open on internal scroll, and closes on Tab/blur outside the menu.
    branchBtn.props.onContextMenu({ clientX: 40, clientY: 50, preventDefault() {}, stopPropagation() {} })
    await harness.settle()
    const opsMenu = body.querySelector('.vcs-ref-ops')
    assert.notEqual(opsMenu, null)
    const opsItems = opsMenu.querySelectorAll('[data-ops-item]')
    const pushItem = opsItems.find(item => textOf(item) === 'branch.push')
    assert.notEqual(pushItem, undefined)
    assert.equal(pushItem.attributes.get('aria-disabled'), 'true')
    assert.equal(pushItem.attributes.get('title'), 'top.syncNoUpstream')

    fakeWin.window.dispatch('scroll', { target: opsItems[0] }, true)
    await harness.settle()
    assert.notEqual(body.querySelector('.vcs-ref-ops'), null, 'internal scroll keeps ref ops menu open')

    opsMenu.props.onBlur({ currentTarget: opsMenu, relatedTarget: null })
    await harness.settle()
    assert.equal(body.querySelector('.vcs-ref-ops'), null, 'blur outside ref ops closes the menu')
  } finally {
    globalThis.fetch = savedFetch
    fakeWin.restore()
    harness.unmount()
    restore()
  }
})

test('Timeline +N overflow pill pairs with clickable/keyboard DetailPane ref badges and restores focus', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const sha = 'e'.repeat(40)
  const fourRefs = [
    { name: 'main', kind: 'branch', current: true },
    { name: 'origin/main', kind: 'remote', remote: 'origin', branch: 'main' },
    { name: 'v1.0', kind: 'tag' },
    { name: 'v2.0', kind: 'tag' },
  ]
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const savedFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: sha,
        branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: 'origin/main', ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha, parents: [], refs: fourRefs, author: 'Ada', authorTime: 1_700_000_000_000, subject: 'release' }],
      })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      return json({
        truncated: false,
        commit: { sha, parents: [], refs: fourRefs, author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'release', message: '', files: [] },
      })
    }
    return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-refs', t, locale: 'en-US' }))
    await harness.settle()

    const body = harness.document.body
    const timeline = body.querySelector('.vcs-timeline')
    const detail = body.querySelector('.vcs-detail')
    assert.notEqual(timeline, null)
    assert.notEqual(detail, null)

    // Timeline keeps row spans (no button tab stops) and summarizes 4th ref as +1.
    assert.equal(timeline.querySelectorAll('.vcs-ref-button').length, 0)
    const more = timeline.querySelector('.vcs-ref-more')
    assert.notEqual(more, null)
    assert.equal(textOf(more), '+1')
    assert.ok(more.attributes.get('title').includes('v2.0'))

    // DetailPane toolbar renders all 4 refs as interactive buttons; clicking v2.0 opens tag menu
    // and Escape restores focus back to that RefBadge button.
    const badges = detail.querySelectorAll('.vcs-ref-button')
    assert.equal(badges.length, 4)
    assert.equal(textOf(badges[3]), 'v2.0')
    badges[3].props.onClick({ currentTarget: badges[3], preventDefault() {}, stopPropagation() {} })
    await harness.settle()

    const menu = body.querySelector('.vcs-ref-ops')
    assert.notEqual(menu, null)
    assert.equal(menu.attributes.get('data-ref-kind'), 'tag')
    assert.equal(textOf(menu.querySelector('.vcs-ref-ops-name')), 'v2.0')

    harness.keyDown(harness.document.activeElement, 'Escape')
    await harness.settle()
    assert.equal(body.querySelector('.vcs-ref-ops'), null)
    assert.equal(harness.document.activeElement, badges[3])
  } finally {
    globalThis.fetch = savedFetch
    fakeWin.restore()
    harness.unmount()
    restore()
  }
})

test('TopBar repository rows filter in place and return keyboard focus to the trigger on Escape', async () => {
  const harness = createHarness({ width: 300 })
  const restore = harness.installGlobals()
  try {
    const { TopBar } = await loadClientModule('src/client/TopBar.tsx', harness)
    const repositories = [
      { path: '/project/frontend/shared', name: 'shared' },
      { path: '/project/backend/shared', name: 'shared' },
    ]
    const calls = []
    const render = list => harness.mount(harness.react.createElement(TopBar, {
      repositories: list,
      cwd: '/project',
      repo: repositories[1].path,
      checkedRepositories: [repositories[1].path],
      onRepositoryScope: () => {},
      onToggleRepository: path => { calls.push(path) },
      t,
    }))
    const body = harness.document.body
    const menu = () => body.querySelector('.vcs-repo-menu')
    render(repositories)
    const trigger = body.querySelector('.vcs-repo-button')
    assert.equal(textOf(trigger), 'shared')
    assert.equal(trigger.attributes.get('title'), '/project/backend/shared')
    assert.equal(trigger.attributes.get('aria-haspopup'), 'menu')
    assert.equal(trigger.attributes.get('aria-expanded'), 'false')

    trigger.focus()
    harness.keyDown(trigger, 'ArrowDown')
    await harness.settle()
    const [first, current] = menu().querySelectorAll('[role="menuitemcheckbox"]')
    assert.equal(trigger.attributes.get('aria-expanded'), 'true')
    assert.equal(menu().attributes.get('aria-label'), 'top.repositories')
    assert.equal(first.attributes.get('aria-checked'), 'false')
    assert.equal(current.attributes.get('aria-checked'), 'true')
    assert.match(textOf(current), /backend\/shared/u, 'the relative path distinguishes same-named repositories')
    assert.equal(harness.document.activeElement, current)

    harness.keyDown(current, 'Home')
    assert.equal(harness.document.activeElement, menu().querySelector('.vcs-range-option'))
    harness.keyDown(harness.document.activeElement, 'End')
    assert.equal(harness.document.activeElement, current)
    harness.keyDown(current, 'ArrowUp')
    assert.equal(harness.document.activeElement, first)
    harness.keyDown(first, 'Escape')
    assert.equal(harness.document.activeElement, trigger)
    assert.equal(menu(), null)
    assert.deepEqual(calls, [])

    harness.keyDown(trigger, 'ArrowDown')
    await harness.settle()
    harness.keyDown(harness.document.activeElement, 'Tab', { shiftKey: true })
    assert.equal(menu(), null, 'backward Tab closes the menu when returning to its trigger')
    assert.equal(harness.document.activeElement, trigger)

    harness.keyClick(trigger, ' ')
    await harness.settle()
    const [available, last] = menu().querySelectorAll('[role="menuitemcheckbox"]')
    harness.keyClick(last)
    assert.deepEqual(calls, [], 'the last checked repository stays included')
    assert.equal(last.attributes.get('aria-disabled'), 'true')
    harness.keyDown(last, 'ArrowUp')
    assert.equal(harness.document.activeElement, available)
    harness.keyClick(available)
    assert.deepEqual(calls, [repositories[0].path])
    assert.notEqual(menu(), null, 'toggling a filter leaves the menu open')
    assert.equal(harness.document.activeElement, available)

    harness.dispatchDocument('pointerdown', { target: body })
    assert.equal(menu(), null)

    // If discovery empties while the menu is open, it stays closed even when the list returns.
    harness.mouseClick(trigger)
    assert.notEqual(menu(), null)
    render([])
    assert.equal(menu(), null)
    assert.equal(trigger.props.disabled, true)
    assert.equal(textOf(trigger), 'top.noRepository')
    harness.keyDown(trigger, 'ArrowDown')
    assert.equal(menu(), null)
    render(repositories)
    assert.equal(trigger.props.disabled, false)
    assert.equal(menu(), null)
  } finally {
    harness.unmount()
    restore()
  }
})

test('TopBar menus open on one header row with icon actions and show notes only when they apply', async () => {
  const harness = createHarness({ width: 300 })
  const restore = harness.installGlobals()
  try {
    const { TopBar } = await loadClientModule('src/client/TopBar.tsx', harness)
    const repositories = [
      { path: '/project', name: 'project' },
      { path: '/project/packages/api', name: 'api' },
    ]
    const worktrees = [
      { path: '/project', name: 'project', branch: 'main' },
      { path: '/topic', name: 'topic', branch: 'topic' },
    ]
    const ranges = [
      { value: 'all', label: 'history.all', title: 'history.allTitle' },
      { value: 'HEAD', label: 'history.selectedWorktrees', title: 'history.selectedWorktreesTitle' },
    ]
    const managed = []
    const created = []
    const render = checkedPaths => harness.mount(harness.react.createElement(TopBar, {
      repositories,
      cwd: '/project',
      repo: '/project',
      checkedRepositories: ['/project'],
      onRepositoryScope: () => {},
      onToggleRepository: () => {},
      onManageRepositories: restoreFocus => { managed.push(restoreFocus) },
      capabilities: { ranges, worktreeCreate: true },
      refMode: 'all',
      onRefMode: () => {},
      worktrees,
      checkedPaths,
      sessionPath: '/project',
      onToggleWorktree: () => {},
      onCreateWorktree: restoreFocus => { created.push(restoreFocus) },
      onWorktreeActions: () => {},
      repoBusy: false,
      worktreeBusy: false,
      t,
    }))
    const body = harness.document.body
    render(['/project'])

    // Repository menu: name, scope switch, and the manage action share the header row.
    harness.mouseClick(body.querySelector('.vcs-repo-button'))
    const repoMenu = () => body.querySelector('.vcs-repo-menu')
    const repoHeader = repoMenu().querySelector('.vcs-picker-header')
    assert.equal(textOf(repoHeader.querySelector('.vcs-picker-header-title')), 'top.repositories')
    assert.deepEqual(repoHeader.querySelectorAll('.vcs-range-option').map(textOf), ['repositories.all', 'repositories.selected'])
    const manage = repoHeader.querySelector('.vcs-repo-manage')
    assert.equal(manage.attributes.get('role'), 'menuitem')
    assert.equal(manage.attributes.get('aria-label'), 'repositoryConfig.manage')
    assert.equal(manage.attributes.get('title'), 'repositoryConfig.manage')
    assert.equal(repoMenu().querySelectorAll('[role="menuitem"]').length, 1, 'no manage row is left under the list')
    const [root, nested] = repoMenu().querySelectorAll('.vcs-repo-item')
    assert.equal(root.querySelector('.vcs-picker-item-detail'), null, 'the session directory shows no "." path')
    assert.equal(textOf(nested.querySelector('.vcs-picker-item-detail')), 'packages/api')
    harness.keyClick(manage)
    assert.equal(managed.length, 1)
    assert.equal(repoMenu(), null, 'opening the manager closes the menu')

    // Worktree menu: the create action uses the same header action shape.
    harness.mouseClick(body.querySelector('.vcs-worktree-button'))
    const worktreeMenu = () => body.querySelector('.vcs-worktree-menu')
    const worktreeHeader = worktreeMenu().querySelector('.vcs-picker-header')
    assert.equal(textOf(worktreeHeader.querySelector('.vcs-picker-header-title')), 'history.commitsLabel')
    const create = worktreeHeader.querySelector('.vcs-worktree-create')
    assert.ok(create.classList.contains('vcs-picker-action'))
    assert.equal(create.attributes.get('aria-label'), 'worktree.createWorktree')
    assert.equal(create.attributes.get('aria-keyshortcuts'), '+')
    assert.equal(textOf(create), 'worktree.new')
    assert.equal(textOf(worktreeMenu().querySelector('.vcs-picker-item-badge')), 'top.sessionWorktree')
    const notes = () => worktreeMenu().querySelectorAll('.vcs-picker-menu-note').map(textOf)
    assert.deepEqual(notes(), ['top.keepWorktree'], 'the note explains the one locked row')

    render(['/project', '/topic'])
    assert.notEqual(worktreeMenu(), null)
    assert.deepEqual(notes(), [], 'with no row locked the note stays away')
    harness.keyClick(create)
    assert.equal(created.length, 1)
  } finally {
    harness.unmount()
    restore()
  }
})

test('VcsView scopes in-flight writes per repository without locking another repository', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  let releaseSyncA = null
  let failJujutsuHistory = false
  const syncTargets = []
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const savedFetch = globalThis.fetch
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  })
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    const repo = parsed.searchParams.get('repo') ?? (init?.body ? JSON.parse(init.body).repo : null)
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo-a',
        truncated: false,
        repositories: [
          { path: '/repo-a', name: 'repo-a', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES },
          { path: '/repo-b', name: 'repo-b', enclosing: false,
            vcs: failJujutsuHistory ? 'jujutsu' : 'git', capabilities: failJujutsuHistory ? JUJUTSU_CAPABILITIES : GIT_CAPABILITIES },
        ],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      const branch = repo === '/repo-b'
        ? { name: 'feat', oid: shaB, detached: false, unborn: false, upstream: 'origin/feat', ahead: 0, behind: 0 }
        : { name: 'main', oid: shaA, detached: false, unborn: false, upstream: 'origin/main', ahead: 1, behind: 0 }
      return json({
        repo: { path: repo, name: repo.slice(1) },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: branch.oid,
        branch,
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.sync') {
      syncTargets.push(repo)
      if (repo === '/repo-a') await new Promise(resolve => { releaseSyncA = resolve })
      return json({ upstream: 'origin/main', pulled: 0, pushed: 1 })
    }
    if (parsed.pathname === '/api/vcs.log') {
      if (failJujutsuHistory && repo === '/repo-b') throw new Error('Jujutsu history unavailable')
      const oid = repo === '/repo-b' ? shaB : shaA
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha: oid, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'c' }],
      })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      const oid = repo === '/repo-b' ? shaB : shaA
      return json({
        truncated: false,
        commit: { sha: oid, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'c', message: '', files: [] },
      })
    }
    return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-multirepo', t, locale: 'en-US' }))
    await harness.settle()
    const body = harness.document.body
    const picker = body.querySelector('.vcs-repo-button')
    const menu = () => body.querySelector('.vcs-repo-menu')
    const checks = () => menu().querySelectorAll('.vcs-repo-item[role="menuitemcheckbox"]')
    const ranges = () => menu().querySelectorAll('.vcs-range-option')
    const groups = () => body.querySelectorAll('.vcs-repository-group-header')
    const syncBtn = body.querySelector('.vcs-sync')

    assert.equal(groups().length, 2, 'all discovered repositories get a group')
    assert.equal(groups()[0].attributes.get('aria-expanded'), 'true')
    picker.focus()
    harness.keyDown(picker, 'ArrowDown')
    await harness.settle()
    harness.keyDown(harness.document.activeElement, 'Home')
    assert.equal(harness.document.activeElement, ranges()[0])
    harness.keyDown(ranges()[0], 'ArrowRight')
    assert.equal(harness.document.activeElement, ranges()[1])
    harness.keyClick(ranges()[1])
    await harness.settle()
    assert.equal(picker.attributes.has('data-filtered'), true)
    assert.equal(groups().length, 1, 'filtering keeps the remaining group independently collapsible')
    assert.equal(harness.document.activeElement, ranges()[1])
    assert.equal(checks()[0].attributes.get('aria-disabled'), 'true')
    harness.keyClick(checks()[0])
    assert.equal(checks()[0].attributes.get('aria-checked'), 'true', 'the last choice cannot be removed')
    checks()[1].focus()
    harness.keyClick(checks()[1])
    await harness.settle()
    assert.equal(harness.document.activeElement, checks()[1])
    assert.equal(groups().length, 2)
    assert.equal(groups()[0].attributes.get('aria-expanded'), 'true', 'checking B leaves A current')
    assert.equal(textOf(picker), 'repo-a')
    harness.keyDown(checks()[1], 'Escape')
    assert.equal(harness.document.activeElement, picker)

    // Start sync on repo-a.
    syncBtn.props.onClick()
    await harness.settle()
    assert.notEqual(releaseSyncA, null)
    assert.equal(body.querySelector('.vcs-sync').attributes.get('aria-busy'), 'true')

    // Open ref menu on repo-a while sync is running: actions are disabled due to repoBusy.
    const branchBtn = body.querySelector('.vcs-branch-button')
    branchBtn.props.onContextMenu({ clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {} })
    await harness.settle()
    assert.equal(body.querySelector('[data-ops-item]').attributes.get('aria-disabled'), 'true')
    harness.keyDown(harness.document.activeElement, 'Escape')
    await harness.settle()

    // Activate a timeline row in repo-b while repo-a is syncing.
    const groupList = () => body.querySelectorAll('.vcs-repository-group')
    harness.keyClick(groups()[1])
    await harness.settle()
    const rowB = groupList()[1].querySelector('[data-timeline-index="0"]')
    rowB.focus()
    harness.keyDown(rowB, 'Enter')
    await harness.settle()
    assert.equal(textOf(picker), 'repo-b')
    assert.equal(body.querySelector('.vcs-sync').attributes.get('aria-busy'), undefined)
    body.querySelector('.vcs-branch-button').props.onContextMenu({ clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {} })
    await harness.settle()
    assert.equal(body.querySelector('[data-ops-item]').attributes.get('aria-disabled'), undefined, 'repo-b stays unlocked while repo-a syncs')
    harness.keyDown(harness.document.activeElement, 'Escape')
    await harness.settle()

    // Returning to repo-a through the timeline restores its pending sync indicator.
    harness.mouseClick(groupList()[0].querySelector('[data-timeline-index="0"]'))
    await harness.settle()
    assert.equal(textOf(picker), 'repo-a')
    assert.equal(body.querySelector('.vcs-sync').attributes.get('aria-busy'), 'true')
    releaseSyncA()
    await harness.settle()
    groups()[0].focus()
    harness.keyDown(groups()[0], 'ArrowDown')
    assert.equal(harness.document.activeElement, groups()[1])
    harness.keyClick(groups()[1])
    assert.deepEqual(groups().map(header => header.attributes.get('aria-expanded')), ['true', 'false'])
    harness.keyClick(groups()[1])
    await harness.settle()
    assert.deepEqual(groups().map(header => header.attributes.get('aria-expanded')), ['true', 'true'])
    assert.equal(textOf(picker), 'repo-a', 'expanding B does not change the operation target')
    assert.equal(body.querySelectorAll('.vcs-timeline').length, 2)
    harness.keyClick(groups()[0])
    harness.keyClick(groups()[1])
    await harness.settle()
    assert.equal(body.querySelectorAll('.vcs-timeline').length, 0, 'both timelines can be collapsed')
    assert.equal(textOf(picker), 'repo-a')
    assert.equal(harness.document.activeElement, groups()[1])
    harness.keyClick(groups()[1])
    await harness.settle()
    const preview = body.querySelectorAll('.vcs-repository-group')[1]
    const first = preview.querySelector('[data-timeline-index="0"]')
    first.focus()
    harness.keyDown(first, 'ArrowDown')
    await harness.settle()
    const commit = preview.querySelector('[data-timeline-index="1"]')
    assert.equal(harness.document.activeElement, commit)
    assert.equal(textOf(picker), 'repo-a', 'moving within B leaves A current')
    harness.keyDown(commit, 'Enter')
    await harness.settle()
    assert.equal(textOf(picker), 'repo-b')
    assert.equal(preview.querySelector('[data-timeline-index="1"]').attributes.get('aria-current'), 'true')
    harness.mouseClick(body.querySelector('.vcs-sync'))
    await harness.settle()
    assert.deepEqual(syncTargets, ['/repo-a', '/repo-b'])

    harness.unmount()
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-multirepo', t, locale: 'en-US' }))
    await harness.settle()
    const restoredPicker = body.querySelector('.vcs-repo-button')
    assert.equal(textOf(restoredPicker), 'repo-b')
    assert.deepEqual(groups().map(header => header.attributes.get('aria-expanded')), ['false', 'true'])
    assert.equal(restoredPicker.attributes.has('data-filtered'), true)
    harness.mouseClick(restoredPicker)
    await harness.settle()
    assert.deepEqual(checks().map(item => item.attributes.get('aria-checked')), ['true', 'true'])
    checks()[1].focus()
    harness.keyClick(checks()[1])
    await harness.settle()
    assert.equal(harness.document.activeElement, checks()[1], 'filtering out the current repository keeps menu focus')
    assert.equal(textOf(restoredPicker), 'repo-a', 'a hidden current repository falls back to a visible one')
    assert.equal(groups().length, 1)
    assert.equal(groups()[0].attributes.get('aria-expanded'), 'false')
    harness.keyClick(ranges()[0])
    await harness.settle()
    assert.equal(groups().length, 2)
    assert.equal(restoredPicker.attributes.has('data-filtered'), false)
    assert.deepEqual(checks().map(item => item.attributes.get('aria-checked')), ['true', 'false'])

    // An unavailable Jujutsu history still offers a working-copy row for activation.
    harness.unmount()
    failJujutsuHistory = true
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-multirepo-unavailable', t, locale: 'en-US' }))
    await harness.settle()
    harness.keyClick(groups()[1])
    await harness.settle()
    const unavailable = groupList()[1]
    assert.match(textOf(unavailable.querySelector('.vcs-timeline-note')), /history\.error/u)
    const workingCopy = unavailable.querySelector('[data-timeline-index="0"]')
    workingCopy.focus()
    harness.keyDown(workingCopy, 'Enter')
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-repo-button')), 'repo-b')
  } finally {
    globalThis.fetch = savedFetch
    fakeWin.restore()
    harness.unmount()
    if (savedStorage === undefined) delete globalThis.sessionStorage
    else Object.defineProperty(globalThis, 'sessionStorage', savedStorage)
    restore()
  }
})

test('VcsView stages a line directly, displays mixed file state, and replays the index action', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const savedFetch = globalThis.fetch
  const repo = '/repo'
  const path = 'example.txt'
  const fingerprint = 'a'.repeat(64)
  const sha = 'b'.repeat(40)
  let staged = false
  let hasHistory = false
  let blockUndo = false
  const action = { id: 'action-1', scope: 'unstaged', path, lineCount: 1 }
  const history = () => ({ undo: hasHistory && staged ? action : null, redo: hasHistory && !staged ? action : null })
  const writes = []
  const entry = { path, status: 'M', added: 1, deleted: 1 }
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    switch (parsed.pathname) {
      case '/api/vcs.repositories':
        return json({ repositories: [{ path: repo, name: 'repo', enclosing: true, capabilities: GIT_CAPABILITIES }] })
      case '/api/vcs.status':
        return json({ capabilities: GIT_CAPABILITIES, defaultNode: 'worktree', branch: { name: 'main', oid: sha }, total: staged ? 2 : 1,
          groups: { staged: staged ? [entry] : [], unstaged: [entry], untracked: [] }, stageHistory: history() })
      case '/api/vcs.log':
        return json({ commits: [{ sha, parents: [], refs: [], author: 'Ada', subject: 'base' }] })
      case '/api/vcs.diff':
        return json({ kind: 'text', path, before: true, after: true, lineStaging: true, indexOid: sha,
          fingerprint: staged ? 'c'.repeat(64) : fingerprint,
          hunks: [{ oldStart: 1, newStart: 1,
            lines: !staged ? [' shared', '-before', '+after']
              : parsed.searchParams.get('scope') === 'staged' ? [' shared', ' before', '+after'] : [' shared', '-before', ' after'],
            oldLines: staged && parsed.searchParams.get('scope') !== 'staged' ? 3 : 2,
            newLines: staged && parsed.searchParams.get('scope') === 'staged' ? 3 : 2 }] })
      case '/api/vcs.stage': {
        const write = JSON.parse(init.body)
        assert.equal(init.method, 'POST')
        writes.push(write)
        staged = write.scope !== 'staged'
        hasHistory = true
        return json({ scope: write.scope, path })
      }
      case '/api/vcs.stage-history': {
        const write = JSON.parse(init.body)
        assert.equal(init.method, 'POST')
        writes.push(write)
        if (blockUndo) {
          return { ok: false, status: 409, async json() { return { error: { code: 'stage-history-stale' } } } }
        }
        staged = write.action === 'redo'
        return json({ action: write.action, stageHistory: history() })
      }
      default: throw new Error(`unexpected route: ${parsed.pathname}`)
    }
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'stage-session', t }))
    await harness.settle()
    const body = harness.document.body
    const layout = body.querySelector('.vcs-stage-layout')
    const merged = () => body.querySelector('[data-file-key="merged|example.txt"]')
    const unstaged = () => body.querySelector('[data-file-key="unstaged|example.txt"]')
    const undo = () => body.querySelector('[data-stage-history="undo"]')
    const redo = () => body.querySelector('[data-stage-history="redo"]')
    assert.equal(layout.attributes.get('aria-pressed'), 'true', 'working tree starts in the merged view by default')
    assert.ok(merged())
    assert.equal(unstaged(), null)
    assert.equal(undo().attributes.get('aria-disabled'), 'true')
    assert.equal(redo().attributes.get('aria-disabled'), 'true')
    harness.mouseClick(layout)
    await harness.settle()
    assert.equal(layout.attributes.get('aria-pressed'), 'false')
    unstaged().querySelector('.vcs-tree-file-head').props.onClick()
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    assert.equal(unstaged().attributes.get('data-open'), 'true', 'an expanded file renders as a card')
    assert.ok(unstaged().querySelector('.vcs-card-head'))
    assert.ok(unstaged().querySelector('.vcs-card-body'))
    assert.equal(unstaged().querySelector('.vcs-tree-file-head').props.style.paddingLeft, '8px', 'an expanded card leaves tree indentation')
    const stagingBox = () => unstaged().querySelector('.vcs-stage-file')
    assert.equal(stagingBox().attributes.get('role'), undefined, 'separate groups state the index side, so a file has a command')
    assert.equal(stagingBox().attributes.get('data-stage-direction'), 'stage')
    assert.equal(stagingBox().attributes.get('data-partial'), undefined)
    assert.equal(stagingBox().props.tabIndex, -1, 'the tree keeps one Tab stop; s and u reach the command')
    const lines = unstaged().querySelectorAll('[data-stage-line]')
    assert.equal(lines.length, 2, 'each changed line has a hover action and context has none')
    assert.equal(lines[1].attributes.get('role'), undefined, 'changed lines use hover commands instead of permanent checkboxes')
    assert.equal(lines[1].attributes.get('data-stage-direction'), 'stage')
    assert.equal(lines.every(line => line.props.tabIndex === -1), true, 'diff line buttons do not add Tab stops')
    harness.mouseClick(lines[1])
    await harness.settle()
    assert.deepEqual(writes, [{ sessionId: 'stage-session', repo, path, scope: 'unstaged', fingerprint, lines: [{ hunk: 0, line: 2 }] }])
    const remaining = unstaged().querySelectorAll('[data-stage-line]')
    assert.equal(remaining.length, 1)
    assert.equal(stagingBox().attributes.get('data-partial'), '')
    assert.match(stagingBox().attributes.get('title'), /stage\.stageRemainingFileChanges/u)
    assert.match(undo().attributes.get('title'), /stage\.stageLine.*example\.txt/u)
    blockUndo = true
    harness.keyClick(undo())
    await harness.settle()
    assert.match(textOf(body.querySelector('.vcs-notice')), /error\.stageHistoryStale/u)
    assert.ok(body.querySelector('[data-file-key="staged|example.txt"]'))
    assert.equal(harness.document.activeElement, undo())

    blockUndo = false
    harness.keyClick(undo())
    await harness.settle()
    assert.deepEqual(writes[2], { sessionId: 'stage-session', repo, action: 'undo', id: action.id })
    assert.equal(undo().attributes.get('aria-disabled'), 'true')
    assert.equal(body.querySelector('[data-file-key="staged|example.txt"]'), null)
    harness.keyClick(redo())
    await harness.settle()
    assert.deepEqual(writes[3], { sessionId: 'stage-session', repo, action: 'redo', id: action.id })
    assert.equal(redo().attributes.get('aria-disabled'), 'true')
    const stagedFile = body.querySelector('[data-file-key="staged|example.txt"]')
    const stagedBox = stagedFile.querySelector('.vcs-stage-file')
    assert.equal(stagedBox.attributes.get('data-stage-direction'), 'unstage')
    assert.equal(stagedBox.attributes.get('data-partial'), '')
    assert.match(stagedBox.attributes.get('title'), /stage\.unstageAllFileChanges/u)
    harness.mouseClick(stagedFile.querySelector('.vcs-tree-file-head'))
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    assert.equal(stagedFile.querySelector('[data-stage-line]').attributes.get('data-stage-direction'), 'unstage')
    harness.mouseClick(stagedBox)
    await harness.settle()
    assert.deepEqual(writes[4], { sessionId: 'stage-session', repo, path, scope: 'staged' })
    assert.equal(body.querySelector('[data-file-key="staged|example.txt"]'), null)

    assert.equal(layout.attributes.get('aria-pressed'), 'false')
    harness.mouseClick(layout)
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    const stageLine = () => merged().querySelector('[data-stage-line="0:2"]')
    assert.equal(layout.attributes.get('aria-pressed'), 'true')
    assert.equal(unstaged(), null)
    assert.equal(merged().querySelector('.vcs-tree-file-head').attributes.get('aria-expanded'), 'true')
    assert.equal(merged().querySelector('[data-stage-state="unstaged"]') !== null, true, 'merged unstaged lines carry dashed-bar state')
    harness.mouseClick(stageLine())
    await harness.settle()
    assert.deepEqual(writes[5], { sessionId: 'stage-session', repo, path, scope: 'unstaged', fingerprint, lines: [{ hunk: 0, line: 2 }] })
    assert.equal(merged().querySelector('.vcs-stage-file').attributes.get('aria-checked'), 'mixed')
    assert.equal(merged().querySelectorAll('[data-review-view]').length, 1)
    assert.equal(stageLine().attributes.get('data-stage-direction'), 'unstage')
    assert.equal(merged().querySelector('[data-stage-state="staged"]') !== null, true, 'merged staged lines carry solid-bar state')
    assert.equal(merged().querySelector('[data-stage-state="unstaged"]') !== null, true, 'remaining merged unstaged lines stay dashed')
    harness.mouseClick(stageLine())
    await harness.settle()
    assert.deepEqual(writes[6], { sessionId: 'stage-session', repo, path, scope: 'staged', fingerprint: 'c'.repeat(64), lines: [{ hunk: 0, line: 2 }] })
    harness.mouseClick(stageLine())
    await harness.settle()
    const menuTrigger = merged().querySelector('[aria-haspopup="menu"]')
    assert.ok(merged().querySelector('.vcs-card-head').querySelector('[aria-haspopup="menu"]'), 'file stage menu sits inside the card head')
    harness.keyClick(menuTrigger)
    await harness.settle()
    const unstageFile = merged().querySelector('[role="menuitem"]')
    assert.ok(unstageFile, 'the mixed file menu opens')
    assert.ok(harness.document.activeElement === unstageFile, `expected menu item focus, got ${harness.document.activeElement?.props.className}`)
    harness.keyClick(unstageFile)
    await harness.settle()
    assert.deepEqual(writes[8], { sessionId: 'stage-session', repo, path, scope: 'staged' })
    assert.equal(merged().querySelector('.vcs-stage-file').attributes.get('aria-checked'), 'false')
    harness.keyClick(layout)
    await harness.settle()
    assert.equal(layout.attributes.get('aria-pressed'), 'false')
    assert.equal(merged(), null)
    assert.equal(unstaged().querySelector('.vcs-tree-file-head').attributes.get('aria-expanded'), 'true')

    harness.keyClick(layout)
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    const hunkHeader = () => merged().querySelector('[data-diff-hunk-header]')
    const hunkBtn = direction => merged().querySelectorAll('[data-stage-hunk]')
      .find(el => el.attributes.get('data-stage-direction') === direction) ?? null
    const hunkStageBtn = () => hunkBtn('stage')
    const hunkUnstageBtn = () => hunkBtn('unstage')
    assert.equal(hunkHeader().attributes.get('aria-keyshortcuts'), 's')
    assert.equal(textOf(hunkStageBtn()), 'stage.stageHunkButton')
    assert.equal(hunkUnstageBtn(), null)
    // Focus the hunk header and press `s` to stage the hunk directly via keyboard.
    harness.mouseClick(hunkHeader())
    assert.equal(harness.document.activeElement, hunkHeader())
    harness.keyDown(hunkHeader(), 's')
    await harness.settle()
    assert.deepEqual(writes[9], { sessionId: 'stage-session', repo, path, scope: 'unstaged', fingerprint,
      lines: [{ hunk: 0, line: 1 }, { hunk: 0, line: 2 }] })
    assert.equal(merged().querySelector('.vcs-tree-file-head').attributes.get('aria-expanded'), 'true')
    // Partial staging in merged view shows both Stage remaining and Unstage hunk buttons and accepts both s and u.
    assert.equal(hunkHeader().attributes.get('aria-keyshortcuts'), 's u')
    assert.equal(textOf(hunkStageBtn()), 'stage.stageRemainingHunkButton')
    assert.equal(textOf(hunkUnstageBtn()), 'stage.unstageHunkButton')
    assert.equal(harness.document.activeElement, hunkHeader(), 'focus stays on the hunk header after refresh')
    harness.mouseClick(hunkStageBtn())
    await harness.settle()
    assert.deepEqual(writes[10], { sessionId: 'stage-session', repo, path, scope: 'unstaged', fingerprint: 'c'.repeat(64),
      lines: [{ hunk: 0, line: 1 }] })
  } finally {
    harness.unmount()
    globalThis.fetch = savedFetch
    fakeWin.restore()
    restore()
  }
})

test('ChangeTree stages a group, a folder, or a file from its gutter and with s and u', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const writes = []
    const onStage = async target => { writes.push(target); return true }
    const mount = (groups, { writable = true, stageDisabled = false } = {}) => {
      harness.mount(harness.react.createElement(ChangeTree, {
        api: { async diff(_repo, target) { return { kind: 'text', path: target.path, before: true, after: true, hunks: [] } } },
        repo: '/repo', rev: null, rows: buildNodeRows(groups), budget: new Map(), folds: {}, split: false, wrap: false,
        revision: 0, cache: new Map(), initialAnchor: null, onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() {},
        control: { current: null }, onStage: writable ? onStage : undefined, partiallyStaged: new Set(['src/a.js']),
        stageDisabled, t, locale: 'en-US',
      }))
      return harness.settle()
    }
    const separate = [
      { id: 'staged', header: true, entries: [{ path: 'src/a.js', status: 'R', origPath: 'src/old.js', added: 1, deleted: 0 }] },
      { id: 'unstaged', header: true, entries: [
        { path: 'src/a.js', status: 'M', added: 1, deleted: 0 },
        { path: 'src/conflict.js', status: 'U', conflict: true },
        { path: 'notes/', status: 'U', untracked: true, directory: true },
      ] },
    ]
    const tree = () => harness.document.body.querySelector('.vcs-tree')
    const head = key => tree().querySelector(`[data-row-key="${key}"]`)
    const control = key => {
      const button = head(key)
      const wrap = button.classList.contains('vcs-tree-file-head') ? button.parentElement.parentElement : button.parentElement
      return wrap.querySelector('[data-stage-direction]') ?? wrap.querySelector('[role="checkbox"]')
    }
    const press = async (key, letter) => {
      harness.mouseClick(head(key))
      const result = harness.keyDown(head(key), letter)
      await harness.settle()
      return result
    }

    await mount(separate)
    assert.equal(control('staged|').attributes.get('data-stage-direction'), 'unstage')
    assert.equal(control('staged|').attributes.get('title'), 'stage.unstageAll')
    assert.equal(control('unstaged|src').attributes.get('title'), 'stage.stageFolder · src/')
    assert.equal(head('staged|').attributes.get('aria-keyshortcuts'), 'u')
    assert.equal(head('unstaged|src').attributes.get('aria-keyshortcuts'), 's')
    assert.equal(control('unstaged|src/a.js').attributes.get('data-partial'), '')
    assert.equal(head('unstaged|src/a.js').querySelector('.vcs-chevron'), null, 'a file shows its status in the chevron slot')
    assert.ok(head('unstaged|src').querySelector('.vcs-chevron'))
    assert.equal(control('unstaged|src/conflict.js'), null, 'a conflict is resolved elsewhere')
    assert.equal(head('unstaged|src/conflict.js').attributes.get('aria-keyshortcuts'), undefined)

    harness.mouseClick(control('unstaged|'))
    await harness.settle()
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', files: [{ path: 'src/a.js' }, { path: 'notes/' }] })
    assert.equal(harness.document.activeElement, head('unstaged|'), 'a row command leaves focus on its row')
    assert.equal((await press('unstaged|src', 's')).prevented, true)
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', files: [{ path: 'src/a.js' }] })
    assert.equal((await press('staged|src', 'u')).prevented, true)
    assert.deepEqual(writes.at(-1), { scope: 'staged', files: [{ path: 'src/a.js', oldPath: 'src/old.js' }] })
    await press('unstaged|notes', 's')
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', files: [{ path: 'notes/' }] })
    await press('unstaged|src/a.js', 's')
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', path: 'src/a.js' })
    const count = writes.length
    assert.equal((await press('unstaged|src', 'u')).prevented, false, 'rows under Unstaged only stage')
    assert.equal((await press('staged|src/a.js', 's')).prevented, false, 'rows under Staged only unstage')
    assert.equal((await press('unstaged|src/conflict.js', 's')).prevented, false)
    assert.equal(writes.length, count)

    await mount(mergedWorktreeGroups(separate))
    assert.equal(control('merged-dir|src').attributes.get('aria-checked'), 'mixed', 'the conflict does not count')
    assert.equal(control('merged-dir|src').props.tabIndex, -1)
    assert.equal(control('unstaged|notes').attributes.get('aria-checked'), 'false')
    harness.mouseClick(control('merged-dir|src'))
    await harness.settle()
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', files: [{ path: 'src/a.js' }] })
    await press('merged-dir|src', 'u')
    assert.deepEqual(writes.at(-1), { scope: 'staged', files: [{ path: 'src/a.js', oldPath: 'src/old.js' }] })
    await press('merged|src/a.js', 'u')
    assert.deepEqual(writes.at(-1), { scope: 'staged', path: 'src/a.js', oldPath: 'src/old.js' })
    await press('merged|src/a.js', 's')
    assert.deepEqual(writes.at(-1), { scope: 'unstaged', path: 'src/a.js' })

    const before = writes.length
    await mount(separate, { stageDisabled: true })
    assert.equal((await press('unstaged|src', 's')).prevented, true, 'a busy index swallows the key')
    harness.mouseClick(control('unstaged|'))
    await harness.settle()
    assert.equal(writes.length, before)
    await mount([{ id: 'commit', header: false, entries: [{ path: 'src/a.js', status: 'M' }] }], { writable: false })
    assert.equal(tree().querySelector('.vcs-stage-gutter'), null, 'a commit has nothing to stage')
    assert.equal((await press('commit|src/a.js', 's')).prevented, false)
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree keeps the cursor on the focused row when a refresh restores the reading row', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const groups = [
      { id: 'staged', header: true, entries: [{ path: 'docs/a.md', status: 'A' }] },
      { id: 'unstaged', header: true, entries: [{ path: 'src/b.js', status: 'M' }, { path: 'src/c.js', status: 'M' }] },
    ]
    const mount = revision => {
      harness.mount(harness.react.createElement(ChangeTree, {
        api: { async diff(_repo, target) { return { kind: 'text', path: target.path, before: true, after: true, hunks: [] } } },
        repo: '/repo', rev: null, rows: buildNodeRows(groups), budget: new Map(), folds: {}, split: false, wrap: false,
        revision, cache: new Map(), initialAnchor: null, onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() {},
        control: { current: null }, onStage: async () => true, partiallyStaged: new Set(), stageDisabled: false, t, locale: 'en-US',
      }))
      return harness.settle()
    }
    await mount(0)
    const head = key => harness.document.body.querySelector(`[data-row-key="${key}"]`)
    harness.mouseClick(head('unstaged|src'))
    assert.equal(harness.document.activeElement, head('unstaged|src'))
    // An automatic refresh anchors on the reading row at the top of the tree.
    await mount(1)
    assert.equal(harness.document.activeElement, head('unstaged|src'))
    assert.equal(head('unstaged|src').props.tabIndex, 0, 'the focused row stays the cursor')
    assert.equal(head('staged|').props.tabIndex, -1)
  } finally {
    harness.unmount()
    restore()
  }
})

test('FileDiff split layouts stage the exact side and suppress disabled actions', async () => {
  for (const wrap of [false, true]) {
    const harness = createHarness({ width: 1000 })
    const restore = harness.installGlobals()
    try {
      const { FileDiff } = await loadClientModule('src/client/diff/FileDiff.ts', harness)
      const writes = []
      const state = {
        kind: 'text', path: 'example.txt', before: true, after: true, lineStaging: true,
        fingerprint: 'a'.repeat(64),
        hunks: [{ oldStart: 3, newStart: 8, oldLines: 3, newLines: 2,
          lines: [' shared', '-first', '-second', '+replacement'] }],
      }
      const render = stageDisabled => harness.mount(harness.react.createElement(FileDiff, {
        state, split: true, wrap, stageScope: 'staged', stageDisabled, t,
        onStageLines(fingerprint, lines) { writes.push({ fingerprint, lines }); return true },
      }))
      render(false)
      await harness.settle()
      const body = harness.document.body
      const deleted = body.querySelector('[data-stage-line="0:2"]')
      const added = body.querySelector('[data-stage-line="0:3"]')
      assert.equal(body.querySelectorAll('[data-stage-line]').length, 3)
      assert.equal(deleted.attributes.get('data-stage-direction'), 'unstage')
      assert.equal(added.attributes.get('data-stage-direction'), 'unstage')
      assert.equal(deleted.props.tabIndex, -1)
      harness.mouseClick(deleted)
      harness.mouseClick(added)
      assert.deepEqual(writes, [2, 3].map(line => ({ fingerprint: state.fingerprint, lines: [{ hunk: 0, line }] })))
      const hunks = body.querySelectorAll('[data-stage-hunk]')
      assert.equal(hunks.length, 1, 'both split columns share a single hunk action')
      assert.equal(hunks[0].attributes.get('data-stage-direction'), 'unstage')
      assert.equal(textOf(hunks[0]), 'stage.unstageHunkButton')
      assert.equal(hunks[0].props.tabIndex, -1)
      harness.mouseClick(hunks[0])
      assert.deepEqual(writes[2], { fingerprint: state.fingerprint, lines: [1, 2, 3].map(line => ({ hunk: 0, line })) })

      render(true)
      await harness.settle()
      const disabled = body.querySelector('[data-stage-line="0:3"]')
      assert.equal(disabled.attributes.get('aria-disabled'), 'true')
      harness.mouseClick(disabled)
      const disabledHunk = body.querySelector('[data-stage-hunk]')
      assert.equal(disabledHunk.attributes.get('aria-disabled'), 'true')
      harness.mouseClick(disabledHunk)
      assert.equal(writes.length, 3)
    } finally {
      harness.unmount()
      restore()
    }
  }
})

test('FileDiff multi-line selection bar handles Shift+Click ranges, merged mixed selections, and Escape dismissal', async () => {
  const harness = createHarness({ width: 900 })
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const writes = []
    let leftTree = 0
    const diff = {
      kind: 'text',
      path: 'example.txt',
      before: true,
      after: true,
      lineStaging: true,
      fingerprint: 'a'.repeat(64),
      hunks: [{
        oldStart: 1,
        newStart: 1,
        oldLines: 4,
        newLines: 5,
        lines: [' ctx', '-removed', '+stagedAdd', '+unstagedAdd1', '+unstagedAdd2'],
        origins: [
          null,
          { side: 'staged', hunk: 0, line: 1 },
          { side: 'staged', hunk: 0, line: 2 },
          { side: 'unstaged', hunk: 0, line: 1 },
          { side: 'unstaged', hunk: 0, line: 2 },
        ],
      }],
    }
    const groups = [{
      id: 'merged',
      header: false,
      entries: [{
        path: 'example.txt',
        status: 'M',
        partiallyStaged: true,
        added: 3,
        deleted: 1,
        sources: {
          staged: { path: 'example.txt', status: 'M', added: 1, deleted: 1 },
          unstaged: { path: 'example.txt', status: 'M', added: 2, deleted: 0 },
        },
      }],
    }]
    const stagedDiff = {
      kind: 'text', path: 'example.txt', before: true, after: true, indexOid: 'idx1', lineStaging: true, fingerprint: 's'.repeat(64),
      hunks: [{ oldStart: 1, newStart: 1, oldLines: 2, newLines: 2, lines: [' ctx', '-removed', '+stagedAdd'] }],
    }
    const unstagedDiff = {
      kind: 'text', path: 'example.txt', before: true, after: true, indexOid: 'idx1', lineStaging: true, fingerprint: 'u'.repeat(64),
      hunks: [{ oldStart: 1, newStart: 1, oldLines: 2, newLines: 4, lines: [' ctx', ' stagedAdd', '+unstagedAdd1', '+unstagedAdd2'] }],
    }
    harness.mount(harness.react.createElement(ChangeTree, {
      api: { async diff(_repo, target) { return target.scope === 'staged' ? stagedDiff : unstagedDiff } },
      repo: '/repo', rev: null, rows: buildNodeRows(groups), budget: new Map(), folds: { 'merged|example.txt': false },
      split: false, wrap: false, revision: 0, cache: new Map(), initialAnchor: null,
      onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() { leftTree += 1 },
      control: { current: null },
      onStage: async target => { writes.push(target); return true },
      partiallyStaged: new Set(['example.txt']), stageDisabled: false, t, locale: 'en-US',
    }))
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    const body = harness.document.body
    const file = body.querySelector('[data-file-key="merged|example.txt"]')
    assert.equal(file.attributes.get('data-open'), 'true')
    // Solid vs dashed state attributes on merged lines.
    assert.ok(file.querySelector('[data-stage-state="staged"]'))
    assert.ok(file.querySelector('[data-stage-state="unstaged"]'))

    // Single click sets anchor; Shift+Click on a later changed line selects the mixed range and opens the floating bar.
    const firstBtn = file.querySelector('[data-stage-line="0:1"]')
    const lastBtn = file.querySelector('[data-stage-line="0:4"]')
    harness.mouseClick(firstBtn)
    await harness.settle()
    assert.equal(writes.length, 1, 'plain click stages/unstages the single line')
    lastBtn.props.onClick({ shiftKey: true, stopPropagation() {} })
    await harness.settle()
    const bar = () => file.querySelector('.vcs-diff-selection-bar')
    assert.ok(bar(), 'Shift+Click range opens the floating selection bar')
    assert.ok(bar().querySelector('[data-stage-selection="stage"]'), 'mixed range offers stage selected button')
    assert.ok(bar().querySelector('[data-stage-selection="unstage"]'), 'mixed range offers unstage selected button')

    // First Escape clears the line selection without leaving the change tree; second Escape leaves the tree.
    const tree = body.querySelector('.vcs-tree')
    const head = file.querySelector('.vcs-tree-file-head')
    head.focus()
    harness.keyDown(head, 'Escape')
    await harness.settle()
    assert.equal(bar(), null, 'first Escape dismisses the floating selection bar')
    assert.equal(leftTree, 0, 'first Escape stays inside the change tree')
    harness.keyDown(head, 'Escape')
    assert.equal(leftTree, 1, 'second Escape leaves the change tree')

    // Re-select via Shift+Click and submit the unstaged subset from the floating bar.
    lastBtn.props.onClick({ shiftKey: true, stopPropagation() {} })
    await harness.settle()
    harness.mouseClick(bar().querySelector('[data-stage-selection="stage"]'))
    await harness.settle()
    assert.equal(bar(), null, 'submitting clears the selection bar')
    assert.deepEqual(writes.at(-1), {
      scope: 'unstaged',
      path: 'example.txt',
      fingerprint: 'u'.repeat(64),
      lines: [{ hunk: 0, line: 2 }, { hunk: 0, line: 3 }],
    })
  } finally {
    harness.unmount()
    restore()
  }
})

test('ChangeTree runs s and u on focused hunk headers and restores hunk focus after refresh', async () => {
  const harness = createHarness({ width: 900 })
  const restore = harness.installGlobals()
  try {
    const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
    const writes = []
    let stagedFirst = false
    const makeDiff = () => ({
      kind: 'text',
      path: 'src/multi.js',
      before: true,
      after: true,
      lineStaging: true,
      fingerprint: stagedFirst ? 'b'.repeat(64) : 'a'.repeat(64),
      hunks: stagedFirst
        ? [{ oldStart: 20, newStart: 20, oldLines: 2, newLines: 3, lines: [' b', '+hunkTwo'] }]
        : [
          { oldStart: 1, newStart: 1, oldLines: 2, newLines: 3, lines: [' a', '+hunkOne'] },
          { oldStart: 20, newStart: 21, oldLines: 2, newLines: 3, lines: [' b', '+hunkTwo'] },
        ],
    })
    const makeGroups = () => [{
      id: 'unstaged',
      header: true,
      entries: [{ path: 'src/multi.js', status: 'M', added: stagedFirst ? 1 : 2, deleted: 0 }],
    }]
    const renderTree = revision => harness.mount(harness.react.createElement(ChangeTree, {
      api: { async diff() { return makeDiff() } },
      repo: '/repo', rev: null, rows: buildNodeRows(makeGroups()), budget: new Map(),
      folds: { 'unstaged|src/multi.js': false }, split: false, wrap: false, revision,
      cache: new Map(), initialAnchor: null, onReading() {}, onToggleRow() {}, onBulkFold() {}, onLeave() {},
      control: { current: null },
      onStage: async target => {
        writes.push(target)
        stagedFirst = true
        return true
      },
      partiallyStaged: new Set(), stageDisabled: false, t, locale: 'en-US',
    }))
    renderTree(0)
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    const body = harness.document.body
    const hunks = () => body.querySelectorAll('[data-diff-hunk-header]')
    assert.equal(hunks().length, 2)
    harness.mouseClick(hunks()[0])
    assert.equal(harness.document.activeElement, hunks()[0])
    assert.equal(harness.keyDown(hunks()[0], 'u').prevented, false, 'u is a no-op on an unstaged hunk')
    assert.equal(harness.keyDown(hunks()[0], 's').prevented, true, 's stages the focused hunk')
    await harness.settle()
    assert.deepEqual(writes, [{
      scope: 'unstaged',
      path: 'src/multi.js',
      fingerprint: 'a'.repeat(64),
      lines: [{ hunk: 0, line: 1 }],
    }])
    // Refresh with remaining hunk only -> focus lands on the remaining hunk header for consecutive s presses.
    renderTree(1)
    await harness.settle()
    assert.equal(hunks().length, 1)
    assert.equal(harness.document.activeElement, hunks()[0], 'focus stays on the next remaining hunk header after refresh')
  } finally {
    harness.unmount()
    restore()
  }
})

test('Git worktree lifecycle keeps filters, picks the created checkout, and falls back after removal', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const savedFetch = globalThis.fetch
  const repo = '/repo'
  const sibling = '/topic'
  const head = 'a'.repeat(40)
  const capabilities = { ...GIT_CAPABILITIES, worktreeCreate: true, worktreeRemove: true }
  const writes = []
  let created = false
  let dirty = true
  function json(body, status = 200) {
    return { ok: status === 200, status, async json() { return body } }
  }
  globalThis.fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url, 'http://127.0.0.1')
    if (pathname === '/api/vcs.worktree') {
      assert.equal(init.method, 'POST')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.headers['content-type'], 'application/json')
      assert.ok(init.headers['X-VCS-Client'])
      const payload = JSON.parse(init.body)
      writes.push(payload)
      if (payload.action === 'create') {
        created = true
      } else {
        if (dirty) return json({ error: { code: 'worktree-dirty', message: 'Host refusal' } }, 409)
        created = false
      }
      return json({ path: sibling })
    }
    assert.equal(searchParams.get('sessionId'), 'lifecycle-session')
    if (pathname === '/api/vcs.repositories') {
      const worktrees = [{ path: repo, name: 'repo', branch: 'main', head, primary: true }]
      if (created) worktrees.push({ path: sibling, name: 'topic', branch: 'topic', head, canRemove: true })
      return json({ cwd: repo, repositories: [{ path: repo, name: 'repo', vcs: 'git', enclosing: true, capabilities, worktrees }] })
    }
    if (pathname === '/api/vcs.branches') return json({ branches: [
      { name: 'main', current: true, occupied: true },
      { name: 'occupied', current: false, occupied: true },
      { name: 'topic', current: false, occupied: false },
    ], truncated: false })
    if (pathname === '/api/vcs.status') {
      return json({ capabilities, defaultNode: 'worktree', branch: { name: 'main', oid: head }, total: 0, groups: {} })
    }
    if (pathname === '/api/vcs.log') return json({ commits: [] })
    throw new Error(`unexpected route: ${pathname}`)
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'lifecycle-session', t }))
    await harness.settle()
    const body = harness.document.body
    const q = selector => body.querySelector(selector)
    const trigger = q('.vcs-worktree-button')
    const menu = () => q('.vcs-worktree-menu')
    const rows = () => menu().querySelectorAll('[role="menuitemcheckbox"]')
    const ranges = () => menu().querySelectorAll('[role="menuitemradio"]')
    const field = name => q(`[id="vcs-worktree-${name}"]`)
    const change = (name, value) => field(name).props.onChange({ currentTarget: { value } })
    const submit = () => q('.vcs-dialog').props.onSubmit({ preventDefault() {} })
    const open = async () => {
      trigger.focus()
      harness.keyDown(trigger, 'ArrowDown')
      await harness.settle()
    }

    await open()
    harness.keyDown(ranges()[0], 'ArrowRight')
    harness.keyClick(ranges()[1])
    await harness.settle()
    assert.equal(rows()[0].attributes.get('aria-description'), 'top.keepWorktree')
    harness.keyDown(ranges()[1], 'ArrowDown')
    assert.ok(harness.document.activeElement === rows()[0], 'vertical navigation reaches the checkbox')
    harness.keyDown(rows()[0], 'ArrowRight')
    assert.ok(harness.document.activeElement.classList.contains('vcs-worktree-icon-action'), 'right moves focus to row actions')
    harness.keyClick(harness.document.activeElement)
    await harness.settle()
    const protectedRemove = q('[data-ops-item]')
    assert.equal(protectedRemove.attributes.get('aria-description'), 'worktree.sessionProtected')
    harness.keyClick(protectedRemove)
    await harness.settle()
    assert.equal(q('.vcs-dialog'), null)
    assert.deepEqual(writes, [])
    harness.keyDown(protectedRemove, 'Escape')
    await harness.settle()
    assert.ok(harness.document.activeElement === trigger, 'menu dismissal restores the worktree trigger')

    await open()
    harness.keyDown(ranges()[1], '+')
    await harness.settle()
    assert.ok(harness.document.activeElement === field('path'), 'keyboard creation focuses the destination')
    change('path', '../topic')
    change('mode', 'existing')
    await harness.settle()
    assert.deepEqual(field('branch').children.map(textOf), ['worktree.chooseBranch', 'topic'])
    submit()
    assert.equal(writes.length, 0, 'a branch must be chosen')
    change('branch', 'topic')
    await harness.settle()
    submit()
    await harness.settle()
    assert.deepEqual(writes, [{ sessionId: 'lifecycle-session', repo, action: 'create', path: '../topic', mode: 'existing', name: 'topic' }])
    assert.equal(q('.vcs-dialog'), null)
    assert.ok(harness.document.activeElement === trigger, 'successful creation restores the worktree trigger')
    assert.match(textOf(body), /worktree\.created/u)

    await open()
    assert.deepEqual(rows().map(row => row.attributes.get('aria-checked')), ['true', 'true'])
    assert.equal(ranges()[1].attributes.get('aria-checked'), 'true')
    harness.keyClick(rows()[0])
    await harness.settle()
    harness.keyDown(rows()[1], 'F10', { shiftKey: true })
    await harness.settle()
    harness.keyClick(q('[data-ops-item]'))
    await harness.settle()
    assert.match(textOf(q('.vcs-dialog')), /\/topic/u)
    assert.equal(textOf(harness.document.activeElement), 'branch.cancel')
    submit()
    await harness.settle()
    assert.equal(textOf(q('.vcs-dialog-error')), 'error.worktreeDirty')
    assert.equal(created, true)
    dirty = false
    submit()
    await harness.settle()
    assert.deepEqual(writes.slice(1), Array(2).fill({
      sessionId: 'lifecycle-session', repo, action: 'remove', worktree: sibling, expectedBranch: 'topic',
    }))
    await open()
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].attributes.get('title').split('\n')[0], repo)
    assert.equal(rows()[0].attributes.get('aria-checked'), 'true')
    assert.equal(ranges()[1].attributes.get('aria-checked'), 'true')
  } finally {
    harness.unmount()
    globalThis.fetch = savedFetch
    fakeWin.restore()
    restore()
  }
})

test('worktree dialog sends only the chosen backend fields and distinguishes Jujutsu deletion from forget', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  try {
    const { WorktreeDialog } = await loadClientModule('src/client/WorktreeDialog.tsx', harness)
    const body = harness.document.body
    const q = selector => body.querySelector(selector)
    const field = name => q(`[id="vcs-worktree-${name}"]`)
    const change = (name, value) => field(name).props.onChange({ currentTarget: { value } })
    const submit = () => q('.vcs-dialog').props.onSubmit({ preventDefault() {} })
    const writes = []
    const tree = { path: '/example/linked', name: 'custom-name', head: null, branch: null }
    const mount = async (kind, commitBased) => {
      harness.mount(harness.react.createElement(WorktreeDialog, {
        key: `${kind}-${commitBased}`,
        request: { domain: 'worktree', kind, repo: '/example/repo', commitBased, tree },
        busy: false, blocked: false, error: null, branches: [], branchesStatus: 'idle',
        branchesError: null, branchesTruncated: false, loadBranches() {}, onCancel() {},
        onConfirm: request => { writes.push(JSON.parse(JSON.stringify(request ?? {}))) }, t,
      }))
      await harness.settle()
    }
    await mount('create', false)
    assert.equal(field('revision').props.placeholder, 'HEAD')
    submit()
    assert.deepEqual(writes, [], 'empty destination cannot submit')
    change('path', '../new')
    await harness.settle()
    submit()
    change('mode', 'detach')
    await harness.settle()
    assert.equal(field('revision').props.placeholder, 'HEAD')
    change('revision', 'main^')
    await harness.settle()
    submit()
    await mount('create', true)
    assert.equal(field('mode'), null)
    assert.equal(field('name').props.placeholder, 'worktree.folderNameDefault')
    assert.equal(field('revision').props.placeholder, 'worktree.defaultParent')
    change('path', '../linked')
    await harness.settle()
    submit()
    change('name', tree.name)
    change('revision', '@-')
    await harness.settle()
    submit()
    assert.deepEqual(writes, [
      { action: 'create', path: '../new', mode: 'new' },
      { action: 'create', path: '../new', mode: 'detach', revision: 'main^' },
      { action: 'create', path: '../linked' },
      { action: 'create', path: '../linked', name: tree.name, revision: '@-' },
    ])
    await mount('forget', true)
    assert.match(textOf(q('.vcs-dialog')), /custom-name\/example\/linked.*worktree\.forgetText/u)
    assert.equal(q('.vcs-button-danger'), null)
    await mount('remove', true)
    assert.match(textOf(q('.vcs-dialog')), /custom-name\/example\/linked.*worktree\.removeWorkspaceText/u)
    assert.equal(textOf(q('.vcs-button-danger')), 'worktree.deleteDirectory')
    assert.equal(textOf(harness.document.activeElement), 'branch.cancel')
  } finally {
    harness.unmount()
    restore()
  }
})

test('VcsView combines Git worktree and range choices and isolates diffs by worktree', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const fakeWin = installFakeWindow()
  const savedFetch = globalThis.fetch
  const source = '/repo'
  const sibling = '/elsewhere/other tree'
  const base = { sha: 'a'.repeat(40), refs: [], parents: [], author: 'Ada', subject: 'common base' }
  const main = { ...base, sha: 'b'.repeat(40), refs: [{ kind: 'branch', name: 'main', current: true }], parents: [base.sha], subject: 'main-only commit' }
  const topic = { ...base, sha: 'c'.repeat(40), parents: [base.sha], subject: 'topic-only commit' }
  let offered = true
  let mainDirectorySignal
  let releaseMainDirectory
  let requestedDiff = null
  const historyReads = []
  const writes = []
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (init.method !== 'GET') writes.push(url)
    assert.equal(parsed.searchParams.get('sessionId'), 'worktree-session')
    const target = parsed.searchParams.get('worktree')
    if (parsed.pathname === '/api/vcs.repositories') {
      const worktrees = [{ path: source, name: 'repo', branch: 'main', head: main.sha }]
      if (offered) worktrees.push({ path: sibling, name: 'other tree', branch: 'topic/preview', head: topic.sha })
      return json({ repositories: [{ path: source, name: 'repo', enclosing: true, worktrees, capabilities: GIT_CAPABILITIES }] })
    }
    assert.equal(parsed.searchParams.get('repo'), source)
    const preview = target === sibling
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        capabilities: preview ? GIT_WORKTREE_CAPABILITIES : GIT_CAPABILITIES,
        defaultNode: 'worktree',
        branch: { name: preview ? 'topic/preview' : 'main', oid: preview ? topic.sha : main.sha, upstream: 'origin/main' },
        total: 1,
        groups: { staged: [], unstaged: [], untracked: [{ path: 'drafts/', directory: true }] },
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      const paths = parsed.searchParams.getAll('worktree')
      const ref = parsed.searchParams.get('ref')
      historyReads.push({ ref, paths })
      if (ref === 'all') return json({ commits: [topic, main, base] })
      if (paths.length === 0) return json({ commits: [main, base] })
      return json({
        commits: [...(paths.includes(sibling) ? [topic] : []), ...(paths.includes(source) ? [main] : []), base],
        worktreeHeads: paths.map(path => ({ path, head: path === sibling ? topic.sha : main.sha })),
      })
    }
    if (parsed.pathname === '/api/vcs.untracked') {
      assert.equal(parsed.searchParams.get('path'), 'drafts/')
      if (!preview) {
        mainDirectorySignal = init.signal
        await new Promise(resolve => { releaseMainDirectory = resolve })
      }
      const name = preview ? 'preview.txt' : 'source.txt'
      return json({ entries: [{ name, path: `drafts/${name}`, type: 'file' }] })
    }
    if (parsed.pathname === '/api/vcs.branches') {
      return json({ branches: [{ name: 'main', current: true }, { name: 'topic/preview', current: false }], truncated: false })
    }
    if (parsed.pathname === '/api/vcs.diff') {
      requestedDiff = Object.fromEntries(parsed.searchParams)
      return json({ kind: 'text', before: false, after: true, hunks: [] })
    }
    throw new Error(`unexpected route: ${parsed.pathname}`)
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'worktree-session', t }))
    await harness.settle()
    const body = harness.document.body
    const chooseRepo = body.querySelector('.vcs-repo-button')
    const button = body.querySelector('.vcs-worktree-button')
    const menu = () => body.querySelector('.vcs-worktree-menu')
    const items = () => menu().querySelectorAll('[role="menuitemcheckbox"]')
    const ranges = () => menu().querySelectorAll('[role="menuitemradio"]')
    const rows = () => body.querySelectorAll('.vcs-worktree-row')
    assert.equal(body.querySelector('[aria-label="history.refLabel"]'), null, 'the closed menu leaves no range control in the header')
    harness.mouseClick(chooseRepo)
    await harness.settle()
    const repoOptions = body.querySelector('.vcs-repo-menu').querySelectorAll('[role="menuitemcheckbox"]')
    assert.deepEqual(repoOptions.map(option => option.attributes.get('title').split('\n')[0]), [source])
    assert.equal(repoOptions[0].attributes.get('aria-disabled'), 'true')
    harness.keyDown(repoOptions[0], 'Escape')
    const branchButton = body.querySelector('.vcs-branch-button')
    assert.notEqual(branchButton, null)
    assert.equal(branchButton.attributes.get('data-filtered'), undefined)
    assert.equal(branchButton.querySelector('.vcs-filter-icon'), null)
    // The branch menu shares the same compact top header range switch (All | HEAD).
    branchButton.focus()
    harness.keyDown(branchButton, 'ArrowDown')
    await harness.settle()
    const branchMenu = () => body.querySelector('.vcs-branch-menu')
    const branchRanges = () => branchMenu().querySelectorAll('.vcs-range-option')
    const branchItems = () => branchMenu().querySelectorAll('[data-branch-item]')
    assert.equal(branchMenu().querySelector('.vcs-picker-header') !== null, true)
    assert.equal(textOf(branchMenu().querySelector('.vcs-picker-header-title')), 'history.commitsLabel')
    assert.deepEqual(branchRanges().map(textOf), ['history.all', 'history.head'])
    assert.deepEqual(branchRanges().map(item => item.attributes.get('aria-checked')), ['true', 'false'])
    assert.equal(harness.document.activeElement, branchItems()[0], 'branch menu focuses the checked-out branch first')
    harness.keyDown(branchItems()[0], 'ArrowUp')
    assert.equal(harness.document.activeElement, branchRanges()[1], 'ArrowUp from the first branch reaches the header filter')
    harness.keyDown(branchRanges()[1], 'ArrowLeft')
    assert.equal(harness.document.activeElement, branchRanges()[0])
    harness.keyDown(branchRanges()[0], 'ArrowRight')
    assert.equal(harness.document.activeElement, branchRanges()[1])
    harness.keyClick(branchRanges()[1])
    await harness.settle()
    assert.notEqual(branchMenu(), null, 'toggling range inside the branch menu keeps it open')
    assert.deepEqual(branchRanges().map(item => item.attributes.get('aria-checked')), ['false', 'true'])
    assert.deepEqual(historyReads.at(-1), { ref: 'HEAD', paths: [] })
    assert.equal(branchButton.attributes.get('data-filtered'), '', 'single-worktree Git places the funnel indicator on the branch trigger')
    assert.notEqual(branchButton.querySelector('.vcs-filter-icon'), null)
    assert.equal(button.attributes.get('data-filtered'), undefined, 'only one trigger shows the funnel indicator at a time')
    assert.equal(button.querySelector('.vcs-filter-icon'), null)
    harness.keyDown(branchRanges()[1], 'Escape')
    await harness.settle()
    assert.equal(branchMenu(), null)

    button.focus()
    harness.keyDown(button, 'ArrowDown')
    await harness.settle()
    assert.equal(menu().querySelector('.vcs-picker-header') !== null, true, 'range switch sits in the menu header')
    assert.equal(textOf(menu().querySelector('.vcs-picker-header-title')), 'history.commitsLabel')
    assert.deepEqual(ranges().map(item => textOf(item)), ['history.all', 'history.selectedWorktrees'])
    assert.deepEqual(ranges().map(item => item.attributes.get('aria-checked')), ['false', 'true'], 'worktree menu stays synced with the branch range toggle')
    assert.equal(harness.document.activeElement, ranges()[1], 'opening focuses the active range segment')
    harness.keyDown(ranges()[1], 'ArrowLeft')
    assert.equal(harness.document.activeElement, ranges()[0], 'ArrowLeft moves across the segmented range toggle')
    harness.keyClick(ranges()[0])
    await harness.settle()
    assert.deepEqual(ranges().map(item => item.attributes.get('aria-checked')), ['true', 'false'])
    assert.equal(button.attributes.get('title'), 'history.allTitle')
    assert.equal(branchButton.attributes.get('data-filtered'), undefined, 'returning to All clears the branch filter indicator')
    assert.equal(button.attributes.get('data-filtered'), undefined, 'default all range keeps the trigger quiet')
    assert.equal(button.querySelector('.vcs-filter-icon'), null)
    assert.deepEqual(historyReads.at(-1), { ref: 'all', paths: [] })
    harness.keyDown(ranges()[0], 'ArrowRight')
    assert.equal(harness.document.activeElement, ranges()[1], 'ArrowRight moves across the segmented range toggle')
    harness.keyDown(ranges()[1], 'ArrowLeft')
    assert.equal(harness.document.activeElement, ranges()[0], 'ArrowLeft returns across the segmented range toggle')
    harness.keyDown(ranges()[0], 'ArrowDown')
    assert.equal(harness.document.activeElement, ranges()[1])
    harness.keyDown(ranges()[1], 'ArrowDown')
    assert.equal(harness.document.activeElement, items()[0])
    assert.equal(items()[0].attributes.get('aria-checked'), 'true')
    assert.equal(items()[0].attributes.get('aria-disabled'), 'true')
    items()[0].props.onClick()
    await harness.settle()
    assert.equal(rows().length, 1, 'the last checked option stays checked')
    harness.keyDown(items()[0], 'ArrowDown')
    assert.equal(harness.document.activeElement, items()[1])
    items()[1].props.onClick()
    await harness.settle()
    assert.equal(items()[1].attributes.get('aria-checked'), 'true')
    assert.equal(harness.document.activeElement, items()[1], 'checking a box keeps the menu and its keyboard focus')
    harness.keyDown(items()[1], 'Home')
    assert.equal(harness.document.activeElement, ranges()[0])
    harness.keyDown(ranges()[0], 'ArrowRight')
    assert.equal(harness.document.activeElement, ranges()[1])
    harness.keyClick(ranges()[1])
    await harness.settle()
    assert.deepEqual(ranges().map(item => item.attributes.get('aria-checked')), ['false', 'true'])
    assert.equal(button.attributes.get('data-filtered'), '', 'multi-worktree Git moves the funnel indicator onto the worktree trigger')
    assert.notEqual(button.querySelector('.vcs-filter-icon'), null)
    assert.deepEqual(historyReads.at(-1), { ref: 'HEAD', paths: [source, sibling] })
    assert.deepEqual(rows().map(row => row.attributes.get('title')), [source, sibling])
    assert.match(textOf(body.querySelector('.vcs-timeline')), /topic-only commit/u)
    assert.equal(body.querySelector('.vcs-branch-button'), null)
    assert.equal(body.querySelector('.vcs-sync'), null)
    assert.equal(body.querySelector('.vcs-readonly').attributes.get('title'), 'worktree.writesHint top.readonlyHintWorktrees')
    harness.keyDown(ranges()[1], 'Escape')
    await harness.settle()
    assert.equal(harness.document.activeElement, button)
    assert.equal(menu(), null)

    rows()[0].props.onClick()
    await harness.settle()
    body.querySelector('.vcs-tree-dir-head').props.onClick()
    await harness.settle()
    assert.equal(mainDirectorySignal.aborted, false)
    rows()[1].props.onClick()
    await harness.settle()
    assert.equal(mainDirectorySignal.aborted, true)
    assert.match(textOf(body.querySelector('.vcs-detail-title')), /other tree/u)
    body.querySelector('.vcs-tree-dir-head').props.onClick()
    await harness.settle()
    releaseMainDirectory()
    await harness.settle()
    assert.match(textOf(body.querySelector('.vcs-tree-file-head')), /preview\.txt/u)
    const previewStage = body.querySelector('.vcs-stage-file')
    assert.equal(previewStage.attributes.get('aria-disabled'), 'true', 'a sibling preview keeps merged state read-only')
    assert.equal(body.querySelector('.vcs-tree-file-head').attributes.get('aria-keyshortcuts'), undefined)
    harness.mouseClick(previewStage)
    await harness.settle()
    assert.deepEqual(writes, [], 'a sibling preview has no staging action')
    assert.doesNotMatch(textOf(body.querySelector('.vcs-content')), /source\.txt/u)
    body.querySelector('.vcs-tree-file-head').props.onClick()
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    assert.deepEqual(requestedDiff, { sessionId: 'worktree-session', repo: source, worktree: sibling, scope: 'untracked', path: 'drafts/preview.txt' })

    harness.mouseClick(button)
    await harness.settle()
    harness.keyDown(harness.document.activeElement, 'Home')
    const all = ranges()[0]
    assert.equal(harness.document.activeElement, all)
    harness.keyClick(all)
    await harness.settle()
    assert.deepEqual(historyReads.at(-1), { ref: 'all', paths: [] })
    assert.deepEqual(ranges().map(item => item.attributes.get('aria-checked')), ['true', 'false'])
    assert.equal(button.attributes.get('data-filtered'), undefined)
    assert.equal(button.querySelector('.vcs-filter-icon'), null)
    assert.equal(harness.document.activeElement, all, 'switching range keeps focus in the menu')
    assert.equal(button.attributes.get('title'), 'history.allTitle')
    assert.equal(rows().length, 2)
    const requestCount = historyReads.length
    harness.keyClick(all)
    harness.keyDown(all, 'ArrowDown')
    harness.keyDown(harness.document.activeElement, 'ArrowDown')
    assert.equal(harness.document.activeElement, items()[0])
    harness.keyClick(items()[0], ' ')
    await harness.settle()
    assert.equal(historyReads.length, requestCount, 'checking changes only the worktree rows in all-history scope')
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].attributes.get('title'), sibling)
    assert.match(textOf(body.querySelector('.vcs-timeline')), /main-only commit/u)
    assert.equal(body.querySelector('.vcs-branch-button'), null, 'a single sibling stays read-only')
    harness.keyDown(items()[0], 'Escape')

    offered = false
    body.querySelector('[aria-label="top.refresh"]').props.onClick()
    await harness.settle()
    assert.equal(chooseRepo.attributes.get('title'), source)
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].attributes.get('title'), source, 'a removed selection falls back to the session worktree')
    assert.deepEqual(historyReads.at(-1), { ref: 'all', paths: [] }, 'refresh preserves the chosen history range')
    assert.notEqual(body.querySelector('.vcs-branch-button'), null)
    assert.deepEqual(writes, [])
  } finally {
    releaseMainDirectory?.()
    harness.unmount()
    fakeWin.restore()
    restore()
    globalThis.fetch = savedFetch
  }
})

test('VcsView reads checked Jujutsu workspaces as commits and follows a rewritten workspace', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  const savedFetch = globalThis.fetch
  const repo = '/jj-repo'
  const sibling = '/another checkout'
  const base = {
    sha: 'a'.repeat(40), parents: [], refs: [], author: 'Ada',
    authorTime: 1_700_000_000_000, subject: 'Common parent',
  }
  const primary = { ...base, sha: 'b'.repeat(40), changeId: 'main', parents: [base.sha], subject: 'Source work', workingCopy: true }
  let preview = { ...base, sha: 'c'.repeat(40), changeId: 'preview', parents: [base.sha], subject: 'Preview work' }
  const historyReads = []
  const statusReads = []
  let requestedDiff = null
  let offered = true
  let blockSnapshot = false
  let releaseSnapshot = null
  const snapshotReads = []
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  globalThis.fetch = async (url, init) => {
    const { pathname, searchParams: params } = new URL(url, 'http://127.0.0.1')
    assert.equal(init.method, 'GET')
    if (pathname === '/api/vcs.repositories') {
      const worktrees = [{ path: repo, name: 'default', head: primary.sha }]
      if (offered) worktrees.push({ path: sibling, name: 'review preview', head: preview.sha })
      return json({ repositories: [{ path: repo, name: 'jj-repo', enclosing: true, capabilities: JUJUTSU_CAPABILITIES, worktrees }] })
    }
    assert.equal(params.get('repo'), repo)
    if (pathname === '/api/vcs.status') {
      const selected = params.get('worktree')
      statusReads.push(selected)
      if (params.get('readOnly') !== '1') snapshotReads.push(selected)
      if (selected === sibling && !offered) {
        return { ok: false, status: 400, async json() { return { error: { code: 'not-a-repo' } } } }
      }
      if (selected === sibling && blockSnapshot) await new Promise(resolve => { releaseSnapshot = resolve })
      const { sha: commitId, changeId, refs } = selected === sibling ? preview : primary
      return json({
        defaultNode: '@', capabilities: JUJUTSU_CAPABILITIES,
        workingCopy: { node: '@', commitId, changeId, refs, summary: { changed: 1, added: 2, deleted: 1 } },
      })
    }
    if (pathname === '/api/vcs.log') {
      const ref = params.get('ref')
      const paths = params.getAll('worktree')
      historyReads.push({ ref, paths })
      const all = ref === 'all'
      const commits = []
      if (offered && (all || paths.includes(sibling))) commits.push(preview)
      if (all || paths.length === 0 || paths.includes(repo)) commits.push(primary)
      commits.push(base)
      return json({
        commits,
        worktreeHeads: paths.length === 0 ? undefined : paths.map(path => ({ path, head: path === sibling ? preview.sha : primary.sha })),
      })
    }
    // A working-copy diff is against exactly the commit whose files are shown,
    // not the base workspace's @ or a directory outside the shared store.
    assert.equal(params.has('worktree'), false)
    if (pathname === '/api/vcs.commit') {
      const copy = [primary, preview, base].find(commit => commit.sha === params.get('sha'))
      assert.notEqual(copy, undefined)
      return json({ commit: { ...copy, files: [{ path: 'same.txt', status: 'M', added: 2, deleted: 1 }] } })
    }
    if (pathname === '/api/vcs.diff') {
      requestedDiff = Object.fromEntries(params)
      return json({ kind: 'text', before: true, after: true, hunks: [] })
    }
    throw new Error(`unexpected route: ${pathname}`)
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'jj-range-menu', t }))
    await harness.settle()
    const body = harness.document.body
    const trigger = body.querySelector('.vcs-worktree-button')
    const menu = () => body.querySelector('.vcs-worktree-menu')
    const choices = () => menu().querySelectorAll('[role="menuitemcheckbox"]')
    const ranges = () => menu().querySelectorAll('[role="menuitemradio"]')
    const timeline = () => textOf(body.querySelector('.vcs-timeline'))
    const copies = () => body.querySelectorAll('.vcs-working-copy-row')
    assert.equal(textOf(trigger), t('worktree.workspaceSelection', { count: '1' }))
    assert.deepEqual(statusReads, [null])
    assert.deepEqual(historyReads, [{ ref: 'all', paths: [] }])
    assert.equal(body.querySelector('.vcs-worktree-row'), null, 'commits, not synthetic working-tree rows')
    assert.equal(body.querySelector('[aria-label="history.refLabel"]'), null)

    trigger.focus()
    harness.keyDown(trigger, 'ArrowDown')
    await harness.settle()
    const [current, other] = choices()
    assert.match(textOf(current), /default@/u)
    assert.match(textOf(other), /review preview@/u)
    assert.equal(current.attributes.get('aria-disabled'), 'true')
    harness.keyClick(current)
    assert.equal(current.attributes.get('aria-checked'), 'true')
    assert.deepEqual(ranges().map(textOf), ['history.all', 'history.selectedWorktrees'])
    assert.deepEqual(ranges().map(item => item.attributes.get('aria-checked')), ['true', 'false'])
    assert.equal(trigger.attributes.get('data-filtered'), undefined)
    assert.equal(harness.document.activeElement, ranges()[0])

    harness.keyDown(ranges()[0], 'ArrowRight')
    assert.equal(harness.document.activeElement, ranges()[1])
    harness.keyClick(ranges()[1])
    await harness.settle()
    assert.equal(trigger.attributes.get('data-filtered'), '')
    assert.notEqual(trigger.querySelector('.vcs-filter-icon'), null)
    assert.deepEqual(historyReads.at(-1), { ref: '@', paths: [] })
    const readsBeforeOther = historyReads.length
    blockSnapshot = true
    harness.keyDown(ranges()[1], 'ArrowDown')
    assert.equal(harness.document.activeElement, current)
    harness.keyDown(current, 'ArrowDown')
    harness.keyClick(other, ' ')
    await harness.settle()
    assert.deepEqual(statusReads, [null, null, sibling])
    assert.equal(historyReads.length, readsBeforeOther + 1, 'history can read while sibling status is pending')
    assert.deepEqual(snapshotReads, [], 'mount and selection only read existing snapshots')
    assert.equal(harness.document.activeElement, other)
    blockSnapshot = false
    releaseSnapshot()
    await harness.settle()
    assert.deepEqual(historyReads.at(-1), { ref: '@', paths: [repo, sibling] })
    assert.equal(copies().length, 2)
    assert.match(timeline(), /review preview@/u)
    harness.keyDown(other, 'Escape')
    assert.equal(harness.document.activeElement, trigger)

    harness.mouseClick(copies().find(row => textOf(row).includes('Preview work')))
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-node-title')), 'Preview work')
    body.querySelector('.vcs-tree-file-head').props.onClick()
    for (const observer of harness.intersections) observer.trigger(() => true)
    await harness.settle()
    assert.deepEqual(requestedDiff, {
      sessionId: 'jj-range-menu', repo, scope: 'commit', path: 'same.txt', rev: preview.sha,
    })

    harness.mouseClick(trigger)
    await harness.settle()
    harness.keyClick(choices()[0])
    await harness.settle()
    assert.deepEqual(historyReads.at(-1), { ref: '@', paths: [sibling] })
    assert.doesNotMatch(timeline(), /Source work/u)
    assert.equal(textOf(body.querySelector('.vcs-node-title')), 'Preview work')
    harness.keyDown(harness.document.activeElement, 'Home')
    harness.keyClick(ranges()[0])
    await harness.settle()
    assert.equal(trigger.attributes.get('data-filtered'), undefined)
    assert.deepEqual(historyReads.at(-1), { ref: 'all', paths: [sibling] })
    assert.match(timeline(), /Source work/u)
    assert.equal(copies().length, 1, 'unchecked @ is an ordinary commit in all history')
    harness.keyDown(ranges()[0], 'Escape')

    preview = { ...preview, sha: 'd'.repeat(40), subject: 'Preview after snapshot' }
    const refreshSnapshots = body.querySelector('[aria-label="top.refreshSnapshots"]')
    harness.mouseClick(refreshSnapshots)
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-node-title')), preview.subject)
    assert.equal(copies()[0].attributes.get('aria-current'), 'true')
    assert.equal(statusReads.at(-1), sibling)
    assert.deepEqual(snapshotReads, [sibling])
    offered = false
    harness.mouseClick(refreshSnapshots)
    await harness.settle()
    assert.deepEqual(snapshotReads, [sibling, null], 'discover removed workspaces before manual snapshotting')
    assert.deepEqual(historyReads.at(-1), { ref: 'all', paths: [] })
    assert.equal(textOf(body.querySelector('.vcs-node-title')), 'Source work')
    assert.equal(body.querySelector('.vcs-worktree-row'), null)
  } finally {
    releaseSnapshot?.()
    harness.unmount()
    restore()
    globalThis.fetch = savedFetch
  }
})

test('BranchDialog, TagDialog, and CommitDialog cover blocked state, unmerged focus, delete-remote danger, and branch checkout UX', async () => {
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  try {
    const { BranchDialog } = await loadClientModule('src/client/BranchDialogs.tsx', harness)
    const { TagDialog } = await loadClientModule('src/client/TagDialog.tsx', harness)
    const { CommitDialog } = await loadClientModule('src/client/CommitDialog.tsx', harness)
    const body = harness.document.body

    // BranchDialog delete-remote uses danger styling; blocked leaves Cancel active and closes on Escape.
    let cancelled = 0
    harness.mount(harness.react.createElement(BranchDialog, {
      request: { kind: 'delete-remote', branch: 'origin/old' },
      error: null,
      busy: false,
      blocked: true,
      onCancel: () => { cancelled += 1 },
      onConfirm: () => {},
      t,
    }))
    await harness.settle()
    const [cancelBtn, submitBtn] = body.querySelectorAll('.vcs-button')
    assert.equal(textOf(body.querySelector('.vcs-dialog-busy')), 'error.busy')
    assert.equal(cancelBtn.props.disabled, false, 'blocked keeps Cancel enabled')
    assert.equal(submitBtn.attributes.get('aria-disabled'), 'true')
    assert.equal(submitBtn.classList.contains('vcs-button-danger'), true, 'delete-remote has danger styling')
    harness.keyDown(body.querySelector('.vcs-dialog'), 'Escape')
    await harness.settle()
    assert.equal(cancelled, 1, 'Escape closes a blocked dialog')

    // Local delete bouncing as branch-unmerged moves focus back to Cancel.
    harness.mount(harness.react.createElement(BranchDialog, {
      key: 'unmerged-test',
      request: { kind: 'delete', branch: 'topic' },
      error: null,
      busy: false,
      onCancel: () => {},
      onConfirm: () => {},
      t,
    }))
    await harness.settle()
    const btns = body.querySelectorAll('.vcs-button')
    btns[1].focus()
    assert.equal(harness.document.activeElement, btns[1])
    harness.mount(harness.react.createElement(BranchDialog, {
      key: 'unmerged-test',
      request: { kind: 'delete', branch: 'topic' },
      error: { code: 'branch-unmerged', message: 'unmerged' },
      busy: false,
      onCancel: () => {},
      onConfirm: () => {},
      t,
    }))
    await harness.settle()
    assert.equal(harness.document.activeElement, body.querySelectorAll('.vcs-button')[0], 'unmerged bounce focuses Cancel')

    // TagDialog also respects blocked while keeping Cancel clickable.
    let tagCancelled = 0
    harness.mount(harness.react.createElement(TagDialog, {
      request: { kind: 'delete', tag: 'v1.0' },
      error: null,
      busy: false,
      blocked: true,
      remotes: { status: 'idle', list: [], truncated: false, error: null },
      onCancel: () => { tagCancelled += 1 },
      onConfirm: () => {},
      t,
    }))
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-dialog-busy')), 'error.busy')
    assert.equal(body.querySelectorAll('.vcs-button')[1].attributes.get('aria-disabled'), 'true')
    body.querySelectorAll('.vcs-button')[0].props.onClick()
    assert.equal(tagCancelled, 1)

    // TagDialog pluralizes and formats truncated remote counts for the active locale.
    harness.mount(harness.react.createElement(TagDialog, {
      request: { kind: 'push', tag: 'v1.0' },
      error: null,
      busy: false,
      blocked: false,
      remotes: { status: 'ready', list: ['origin', 'upstream'], truncated: true, error: null },
      onCancel: () => {},
      onConfirm: () => {},
      t,
      locale: 'ru',
    }))
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-dialog-busy')), 'tag.remotesTruncated.few:{"count":"2"}')

    // CommitDialog reset only marks Hard as danger and shows commit preview.
    const sha = 'f'.repeat(40)
    harness.mount(harness.react.createElement(CommitDialog, {
      key: 'reset-test',
      request: { kind: 'reset', sha, shortSha: sha.slice(0, 7), current: 'main', subject: 'fix edge case' },
      error: null,
      busy: false,
      onCancel: () => {},
      onConfirm: () => {},
      t,
    }))
    await harness.settle()
    assert.equal(textOf(body.querySelector('.vcs-dialog-commit')), `${sha.slice(0, 7)}fix edge case`)
    assert.equal(body.querySelectorAll('.vcs-button')[1].classList.contains('vcs-button-danger'), false, 'soft reset is not styled as danger')
    body.querySelector('[id="vcs-reset-mode"]').props.onChange({ currentTarget: { value: 'hard' } })
    await harness.settle()
    assert.equal(body.querySelectorAll('.vcs-button')[1].classList.contains('vcs-button-danger'), true, 'hard reset uses danger styling')

    // CommitDialog Create Branch submits { name, checkout: true } when checked.
    let submitted = null
    harness.mount(harness.react.createElement(CommitDialog, {
      key: 'branch-test',
      request: { kind: 'branch', sha, shortSha: sha.slice(0, 7), current: 'main', subject: 'fix edge case' },
      error: null,
      busy: false,
      onCancel: () => {},
      onConfirm: values => { submitted = values },
      t,
    }))
    await harness.settle()
    body.querySelector('[id="vcs-new-branch-name"]').props.onChange({ currentTarget: { value: 'topic' } })
    body.querySelector('[id="vcs-new-branch-checkout"]').props.onChange({ currentTarget: { checked: true } })
    await harness.settle()
    body.querySelector('.vcs-dialog').props.onSubmit({ preventDefault() {} })
    assert.deepEqual(submitted, { name: 'topic', checkout: true })
  } finally {
    harness.unmount()
    restore()
  }
})


test('VcsView resets reads when a repository switches to another backend', async () => {
  const sha = 'd'.repeat(40)
  const repo = '/repo'
  let backend = 'jujutsu'
  const reads = []
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const savedFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const { pathname } = new URL(url, 'http://127.0.0.1')
    if (pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/',
        truncated: false,
        repositories: [{
          path: repo,
          name: 'repo',
          enclosing: true,
          vcs: backend,
          availableVcs: ['jujutsu', 'git'],
          capabilities: backend === 'jujutsu' ? JUJUTSU_CAPABILITIES : GIT_CAPABILITIES,
          ...(backend === 'jujutsu' ? { worktrees: [{ path: repo, name: 'default', head: sha }] } : {}),
        }],
      })
    }
    if (pathname === '/api/vcs.status') {
      reads.push(`status:${backend}`)
      if (backend === 'jujutsu') {
        return json({
          vcs: 'jujutsu',
          capabilities: JUJUTSU_CAPABILITIES,
          defaultNode: '@',
          workingCopy: { node: '@', commitId: sha, changeId: 'vvvvvvvv', refs: [], summary: { changed: 0, added: 0, deleted: 0 } },
        })
      }
      return json({
        repo: { path: repo, name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: null,
        branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (pathname === '/api/vcs.log') {
      reads.push(`log:${backend}`)
      return json({
        truncated: false,
        nextSkip: null,
        commits: backend === 'git'
          ? [{ sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'git history' }]
          : [{
            sha, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000,
            subject: 'working copy', changeId: 'vvvvvvvv', workingCopy: true,
          }],
      })
    }
    throw new Error(`unexpected route: ${pathname}`)
  }
  const harness = createHarness({ width: 500 })
  const restore = harness.installGlobals()
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'backend-switch', t, locale: 'en-US' }))
    await harness.settle()
    const body = harness.document.body
    assert.ok(reads.includes('status:jujutsu'))
    assert.notEqual(body.querySelector('.vcs-working-copy-row'), null)
    assert.equal(body.querySelector('.vcs-branch-button'), null, 'Jujutsu offers no branch switch')

    // Read the working copy in the single-column detail, as a reader would.
    harness.keyClick(body.querySelector('.vcs-working-copy-row'))
    await harness.settle()
    assert.notEqual(body.querySelector('[aria-label="detail.back"]'), null)
    assert.equal(body.querySelector('.vcs-sidebar'), null)

    backend = 'git'
    body.querySelector('[aria-label="top.refreshSnapshots"]').props.onClick()
    await harness.settle()
    assert.ok(reads.filter(read => read === 'status:git').length > 0, 'status is reread through Git')
    assert.ok(reads.filter(read => read === 'log:git').length > 0, 'history is reread through Git')
    assert.equal(body.querySelector('.vcs-working-copy-row'), null, 'the old working-copy commit leaves the view')
    assert.notEqual(body.querySelector('.vcs-branch-button'), null)
    assert.equal(body.querySelector('[aria-label="detail.back"]'), null, 'the backend change returns to the timeline')
    assert.notEqual(body.querySelector('.vcs-sidebar'), null)
    assert.match(textOf(body.querySelector('.vcs-timeline')), /git history/u)
  } finally {
    harness.unmount()
    restore()
    globalThis.fetch = savedFetch
  }
})

test('VcsView keeps keyboard navigation flowing across button clicks and Tab activation', async () => {
  const commits = Array.from({ length: 300 }, (_, i) => {
    const sha = i.toString(16).padStart(40, '0')
    const parent = i + 1 < 300 ? [(i + 1).toString(16).padStart(40, '0')] : []
    return {
      sha,
      parents: parent,
      refs: i === 0 ? [{ name: 'main', kind: 'branch', current: true }] : [],
      author: 'Ada',
      authorTime: 1_700_000_000_000 - i * 1000,
      subject: `commit-${i}`,
    }
  })
  const extraSha = (300).toString(16).padStart(40, '0')
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const fetchImpl = async url => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: 'worktree',
        branch: { name: 'main', oid: commits[0].sha, detached: false, unborn: false, upstream: 'origin/main', ahead: 1, behind: 0 },
        groups: { staged: [], unstaged: [{ path: 'src/a.js', status: 'M', added: 2, deleted: 1 }], untracked: [] },
        total: 1,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      const skip = Number(parsed.searchParams.get('skip') ?? '0')
      if (skip === 0) return json({ truncated: false, nextSkip: 300, commits })
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha: extraSha, parents: [], refs: [], author: 'Ada', authorTime: 1_699_000_000_000, subject: 'extra' }],
      })
    }
    if (parsed.pathname === '/api/vcs.sync') {
      return json({ upstream: 'origin/main', pulled: 0, pushed: 1 })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      const sha = parsed.searchParams.get('sha')
      const entry = commits.find(c => c.sha === sha) ?? commits[0]
      return json({
        truncated: false,
        commit: {
          sha: entry.sha,
          parents: entry.parents,
          refs: [],
          author: 'Ada',
          authorTime: entry.authorTime,
          committer: 'Ada',
          committerTime: entry.authorTime,
          subject: entry.subject,
          message: '',
          files: [{ path: 'a.js', status: 'M', added: 2, deleted: 1 }],
        },
      })
    }
    return json({
      kind: 'text',
      path: parsed.searchParams.get('path') ?? 'a.js',
      before: true,
      after: true,
      hunks: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old1', '+new1'] },
        { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: ['-old2', '+new2'] },
      ],
    })
  }

  const savedFetch = globalThis.fetch
  const savedClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  globalThis.fetch = fetchImpl
  let copiedText = null
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { async writeText(text) { copiedText = text } },
    configurable: true,
  })
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-buttons', t, locale: 'en-US', focusRequest: 1 }))
    await harness.settle()
    const body = harness.document.body
    const triggerAllDiffs = () => {
      for (const observer of harness.intersections) observer.trigger(() => true)
    }
    triggerAllDiffs()
    await harness.settle()

    // Start in timeline and step down to commit-0 (row 1).
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '0')
    harness.keyDown(harness.document.activeElement, 'j')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    // Clicking Sync, Refresh, and Load More keeps focus on the timeline stop.
    harness.mouseClick(body.querySelector('.vcs-sync'))
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    harness.mouseClick(body.querySelector('[aria-label="top.refresh"]'))
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    // Range changes keep the menu focused without changing the selected commit.
    const worktreeButton = body.querySelector('.vcs-worktree-button')
    harness.mouseClick(worktreeButton)
    await harness.settle()
    const [selectedWorktrees, allCommits] = body.querySelector('.vcs-worktree-menu').querySelectorAll('[role="menuitemradio"]')
    harness.mouseClick(allCommits)
    await harness.settle()
    assert.equal(harness.document.activeElement, allCommits)
    assert.equal(body.querySelector('[data-timeline-index="1"]').attributes.get('aria-current'), 'true')
    harness.mouseClick(selectedWorktrees)
    await harness.settle()
    harness.keyDown(selectedWorktrees, 'Escape')
    assert.equal(harness.document.activeElement, worktreeButton)
    harness.keyDown(worktreeButton, 'Escape')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    const loadMore = body.querySelector('.vcs-load-more')
    assert.notEqual(loadMore, null)
    harness.mouseClick(loadMore)
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    // Keyboard flow in timeline still steps smoothly after button clicks.
    harness.keyDown(harness.document.activeElement, 'j')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '2')
    harness.keyDown(harness.document.activeElement, 'k')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    // Enter ChangeTree, unfold a.js, and step onto its hunk header.
    const assignHunkGeometry = () => {
      const tree = body.querySelector('.vcs-tree')
      const headers = tree.querySelectorAll('[data-diff-hunk-header]')
      headers.forEach((header, index) => {
        header.offsetTop = (index % 2) * 200 + 40
      })
      return { tree, headers }
    }

    harness.keyDown(harness.document.activeElement, 'ArrowRight')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'commit|a.js')
    harness.keyDown(harness.document.activeElement, 'ArrowRight')
    triggerAllDiffs()
    await harness.settle()
    assignHunkGeometry()
    harness.keyDown(harness.document.activeElement, 'ArrowDown')
    assert.notEqual(harness.document.activeElement?.attributes?.get('data-diff-hunk-header'), undefined)

    // Copy SHA keeps tree hunk focus.
    harness.mouseClick(body.querySelector('.vcs-sha-button'))
    await harness.settle()
    assert.equal(copiedText, commits[0].sha)
    assert.equal(body.querySelector('.vcs-sha-button').attributes.get('title'), 'status.copied')
    assert.notEqual(harness.document.activeElement?.attributes?.get('data-diff-hunk-header'), undefined)

    // The wrap icon shows the current line layout and the tooltip names the next one.
    const wrap = body.querySelector('[aria-label="diff.wrapAria"]')
    const wrapIcon = () => wrap.querySelector('.vcs-icon').children.map(child => child.props.d).join(' ')
    assert.equal(wrap.attributes.get('aria-pressed'), 'true')
    assert.match(wrapIcon(), /M10\.9999/u)
    assert.equal(wrap.attributes.get('title'), 'diff.unwrap')
    harness.mouseClick(wrap)
    await harness.settle()
    assert.notEqual(harness.document.activeElement?.attributes?.get('data-diff-hunk-header'), undefined)

    assert.equal(wrap.attributes.get('aria-pressed'), 'false')
    assert.match(wrapIcon(), /M12\.3535/u)
    assert.equal(wrap.attributes.get('title'), 'diff.wrap')
    const split = body.querySelector('.vcs-diff-split')
    const splitIcon = () => split.querySelector('.vcs-icon')
    assert.match(splitIcon().children[0].props.d, /^M6 1\.5H2\.5/u, 'the original comparison glyph is retained')
    assert.equal(split.attributes.get('title'), 'diff.split')
    assert.equal(splitIcon().attributes.get('data-unified'), '')
    harness.mouseClick(split)
    await harness.settle()
    assert.equal(split.attributes.get('title'), 'diff.unified')
    assert.equal(splitIcon().attributes.get('data-unified'), undefined)
    assert.notEqual(harness.document.activeElement?.attributes?.get('data-diff-hunk-header'), undefined)

    const details = body.querySelector('.vcs-detail')
    details.clientWidth = 500
    for (const observer of harness.resizes) observer.callback()
    await harness.settle()
    assert.equal(split.attributes.get('aria-pressed'), 'true')
    assert.equal(split.attributes.get('title'), 'diff.splitNarrowOff diff.splitNarrow')
    assert.equal(splitIcon().attributes.get('data-unified'), '')
    harness.mouseClick(split)
    await harness.settle()
    assert.equal(split.attributes.get('title'), 'diff.splitNarrowOn diff.splitNarrow')
    assert.equal(splitIcon().attributes.get('data-unified'), '')
    details.clientWidth = 1000
    for (const observer of harness.resizes) observer.callback()
    await harness.settle()

    // Collapse All while on a hunk falls back synchronously to the owning file row.
    const collapseAll = body.querySelector('[aria-label="tree.collapseAll"]')
    assert.equal(collapseAll.attributes.get('title'), 'tree.collapseAllHint')
    assert.match(collapseAll.querySelector('.vcs-icon').children[0].props.d, /M4\.5 6 8 2\.5/u)
    harness.mouseClick(collapseAll)
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'commit|a.js')

    // Expand All restores expansion without stealing focus to the button.
    const expandAll = body.querySelector('[aria-label="tree.expandAll"]')
    assert.equal(expandAll.attributes.get('title'), 'tree.expandAllHint')
    assert.match(expandAll.querySelector('.vcs-icon').children[0].props.d, /M4\.5 2\.5 8 6/u)
    harness.mouseClick(expandAll)
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.rowKey, 'commit|a.js')

    // Parent commit link jumps timeline selection and puts focus on that parent row.
    harness.mouseClick(body.querySelector('.vcs-parent-link'))
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '2')

    // Tab focus + Enter keeps focus on the button; subsequent movement keys route back to navigation.
    const refreshBtn = body.querySelector('[aria-label="top.refresh"]')
    refreshBtn.focus()
    harness.keyClick(refreshBtn, 'Enter')
    await harness.settle()
    assert.equal(harness.document.activeElement, refreshBtn, 'keyboard Enter keeps focus on Tab-focused button')
    harness.keyDown(refreshBtn, 'j')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '3', 'movement key routes back to navigation stop')
  } finally {
    harness.unmount()
    restore()
    globalThis.fetch = savedFetch
    if (savedClipboard === undefined) delete globalThis.navigator.clipboard
    else Object.defineProperty(globalThis.navigator, 'clipboard', savedClipboard)
  }
})

test('VcsView returns focus cleanly after branch switch, push, and Escape on branch menu', async () => {
  const sha1 = 'e'.repeat(40)
  const sha2 = 'f'.repeat(40)
  let currentBranch = 'main'
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: sha1,
        branch: { name: currentBranch, oid: sha1, detached: false, unborn: false, upstream: `origin/${currentBranch}`, ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      return json({
        truncated: false,
        nextSkip: null,
        commits: [
          { sha: sha1, parents: [sha2], refs: [{ name: currentBranch, kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'head' },
          { sha: sha2, parents: [], refs: [], author: 'Ada', authorTime: 1_699_000_000_000, subject: 'base' },
        ],
      })
    }
    if (parsed.pathname === '/api/vcs.branches') {
      return json({
        truncated: false,
        branches: [
          { name: 'main', current: currentBranch === 'main' },
          { name: 'feature', current: currentBranch === 'feature' },
        ],
      })
    }
    if (parsed.pathname === '/api/vcs.switch') {
      const payload = JSON.parse(init.body)
      currentBranch = payload.branch
      return json({ branch: payload.branch })
    }
    if (parsed.pathname === '/api/vcs.branch') {
      const payload = JSON.parse(init.body)
      return json({ branch: payload.branch, remote: 'origin' })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      const sha = parsed.searchParams.get('sha')
      return json({
        truncated: false,
        commit: { sha, parents: [], refs: [], author: 'Ada', authorTime: 1_700_000_000_000, committer: 'Ada', committerTime: 1_700_000_000_000, subject: 'head', message: '', files: [] },
      })
    }
    return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
  }

  const savedFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  const harness = createHarness({ width: 1000 })
  const restore = harness.installGlobals()
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-branch', t, locale: 'en-US', focusRequest: 1 }))
    await harness.settle()
    const body = harness.document.body
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')

    // Pointer-open branch switcher and switch to `feature`: focus returns to timeline stop, so `j` moves commits.
    const branchBtn = body.querySelector('.vcs-branch-button')
    harness.mouseClick(branchBtn)
    await harness.settle()
    const featureItem = body.querySelector('[title="feature"]')
    assert.notEqual(featureItem, null)
    harness.mouseClick(featureItem)
    await harness.settle()
    assert.equal(body.querySelector('.vcs-branch-name')?.props?.children, 'feature')
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')
    harness.keyDown(harness.document.activeElement, 'j')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '2', 'j steps commit instead of reopening menu')

    // Context-menu Push on branch button: focus returns to navigation stop after Push.
    body.querySelector('.vcs-branch-button').props.onContextMenu({
      clientX: 30,
      clientY: 30,
      preventDefault() {},
      stopPropagation() {},
    })
    await harness.settle()
    const pushItem = body.querySelector('[title="branch.push"]')
    assert.notEqual(pushItem, null)
    harness.mouseClick(pushItem)
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '2')

    // Keyboard-opened branch menu returns to .vcs-branch-button on Escape, and Escape there returns to navigation stop.
    const activeBranchBtn = body.querySelector('.vcs-branch-button')
    activeBranchBtn.focus()
    harness.keyDown(activeBranchBtn, 'ArrowDown')
    await harness.settle()
    const menu = body.querySelector('.vcs-branch-menu')
    assert.notEqual(menu, null)
    harness.keyDown(menu, 'Escape')
    await harness.settle()
    assert.equal(harness.document.activeElement, activeBranchBtn)
    harness.keyDown(activeBranchBtn, 'Escape')
    await harness.settle()
    assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '2')
  } finally {
    harness.unmount()
    restore()
    globalThis.fetch = savedFetch
  }
})

test('VcsView claims keyboard readiness on window focus and visibility without stealing active inputs or modals', async () => {
  const sha = 'b'.repeat(40)
  const json = body => ({ ok: true, status: 200, async json() { return body } })
  const fetchImpl = async url => {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname === '/api/vcs.repositories') {
      return json({
        cwd: '/repo',
        truncated: false,
        repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
      })
    }
    if (parsed.pathname === '/api/vcs.status') {
      return json({
        repo: { path: '/repo', name: 'repo' },
        vcs: 'git',
        capabilities: GIT_CAPABILITIES,
        defaultNode: sha,
        branch: { name: 'main', oid: sha, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        groups: { staged: [], unstaged: [], untracked: [] },
        total: 0,
        truncated: false,
      })
    }
    if (parsed.pathname === '/api/vcs.log') {
      return json({
        truncated: false,
        nextSkip: null,
        commits: [{ sha, parents: [], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'head' }],
      })
    }
    if (parsed.pathname === '/api/vcs.commit') {
      return json({
        truncated: false,
        commit: {
          sha,
          parents: [],
          refs: [],
          author: 'Ada',
          authorTime: 1_700_000_000_000,
          committer: 'Ada',
          committerTime: 1_700_000_000_000,
          subject: 'head',
          message: '',
          files: [{ path: 'a.js', status: 'M', added: 1, deleted: 1 }],
        },
      })
    }
    return json({
      kind: 'text',
      path: 'a.js',
      before: true,
      after: true,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a', '+b'] }],
    })
  }

  const savedFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    // Hidden tab never claims focus, even with focusRequest > 0 or window focus.
    {
      const harness = createHarness({ width: 1000 })
      const restore = harness.installGlobals()
      try {
        const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
        harness.mount(harness.react.createElement(VcsView, { sessionId: 'session-hidden', t, locale: 'en-US', visible: false, focusRequest: 1 }))
        await harness.settle()
        assert.equal(harness.document.activeElement, harness.document.body)
        harness.dispatchWindow('focus')
        assert.equal(harness.document.activeElement, harness.document.body)
      } finally {
        harness.unmount()
        restore()
      }
    }

    // Visible tab claims idle focus at focusRequest 0, and respects external textarea / modal + tree scrollTop.
    {
      const harness = createHarness({ width: 1000 })
      const restore = harness.installGlobals()
      try {
        const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
        const ModalShell = ({ showModal, visible = true }) => {
          const children = [
            harness.react.createElement('textarea', { key: 'composer', className: 'external-composer' }),
            harness.react.createElement(VcsView, { key: 'vcs', sessionId: 'session-ready', t, locale: 'en-US', visible, focusRequest: 0 }),
          ]
          if (showModal) {
            children.push(harness.react.createElement('div', { key: 'modal', 'aria-modal': 'true' }))
          }
          return harness.react.createElement('div', null, ...children)
        }

        harness.mount(harness.react.createElement(ModalShell, { showModal: false }))
        await harness.settle()
        assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1', 'visible panel claims idle body focus')

        // External composer textarea must never lose focus on window focus or visibilitychange.
        const composer = harness.document.body.querySelector('.external-composer')
        composer.focus()
        harness.dispatchWindow('focus')
        harness.dispatchDocument('visibilitychange')
        assert.equal(harness.document.activeElement, composer)

        // External modal dialog blocks background focus stealing even when body holds focus.
        harness.document.body.focus?.()
        harness.document.activeElement = harness.document.body
        harness.mount(harness.react.createElement(ModalShell, { showModal: true }))
        await harness.settle()
        harness.dispatchWindow('focus')
        assert.equal(harness.document.activeElement, harness.document.body)

        // With modal gone, enter ChangeTree, scroll, drop focus to body, and return to the window.
        harness.mount(harness.react.createElement(ModalShell, { showModal: false }))
        await harness.settle()
        harness.dispatchWindow('focus')
        assert.equal(harness.document.activeElement?.dataset?.timelineIndex, '1')
        harness.keyDown(harness.document.activeElement, 'ArrowRight')
        await harness.settle()
        for (const observer of harness.intersections) observer.trigger(() => true)
        await harness.settle()
        assert.equal(harness.document.activeElement?.dataset?.rowKey, 'commit|a.js')

        const treeEl = harness.document.body.querySelector('.vcs-tree')
        treeEl.scrollTop = 75
        harness.document.activeElement = harness.document.body
        harness.dispatchWindow('focus')
        harness.document.visibilityState = 'visible'
        harness.dispatchDocument('visibilitychange')
        assert.equal(harness.document.activeElement?.dataset?.rowKey, 'commit|a.js')
        assert.equal(treeEl.scrollTop, 75, 'restoring window focus does not reset scroll position')
      } finally {
        harness.unmount()
        restore()
      }
    }
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('VcsView manages repositories from an empty picker and refreshes after a successful save', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  const previousFetch = globalThis.fetch
  const requests = []
  const posts = []
  const sessionId = 'session-repository-config'
  const child = '/workspace/deep/path/repo'
  let config = {
    scanDirectories: [],
    repositories: [{ path: 'missing/repo', available: false }],
    backends: [{ path: '.', vcs: 'jujutsu', available: true }],
    revision: 'one',
  }
  let listed = []
  const pendingSave = Promise.withResolvers()
  const response = (data, status = 200) => ({ ok: status === 200, status, async json() { return data } })
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url, 'http://127.0.0.1')
    requests.push(parsed.pathname)
    if (parsed.pathname === '/api/vcs.repository-config' && options.method === 'POST') {
      const data = JSON.parse(options.body)
      posts.push(data)
      assert.equal(options.credentials, 'same-origin')
      assert.equal(options.headers['content-type'], 'application/json')
      if (data.revision === 'one') {
        await pendingSave.promise
        config = { scanDirectories: [], repositories: [], revision: 'two' }
        return response({ error: { code: 'repository-config-conflict', message: 'Changed on disk.' } }, 409)
      }
      config = {
        scanDirectories: data.scanDirectories.map(path => ({ path, available: true })),
        repositories: data.repositories.map(path => ({ path, available: true })),
        revision: 'three',
      }
      listed = [{ path: child, name: 'repo', vcs: 'git', capabilities: GIT_CAPABILITIES,
        availableVcs: ['jujutsu', 'git'],
        sources: [{ kind: 'repository', path: 'deep/path/repo' }, { kind: 'directory', path: 'deep/path' }] }]
      return response(config)
    }
    assert.equal(parsed.searchParams.get('sessionId'), sessionId)
    switch (parsed.pathname) {
      case '/api/vcs.repositories': return response({ repositories: listed, cwd: '/workspace' })
      case '/api/vcs.repository-config': return response(config)
      case '/api/vcs.repository-preview': {
        const path = parsed.searchParams.get('path')
        const kind = parsed.searchParams.get('kind')
        if (path === 'deep/path' && kind === 'repository') {
          return response({ error: { code: 'repository-path-unavailable' } }, 400)
        }
        assert.ok((path === 'deep/path' && kind === 'directory') || (path === 'deep/path/repo' && kind === 'repository'))
        return response({ repositories: [{ path: 'deep/path/repo', name: 'repo', vcs: 'git' }], truncated: kind === 'directory' })
      }
      case '/api/vcs.status': return response({ repo: listed[0], vcs: 'git', capabilities: GIT_CAPABILITIES,
        branch: { name: 'main', unborn: true }, groups: { staged: [], unstaged: [], untracked: [] }, total: 0 })
      case '/api/vcs.log': return response({ commits: [] })
      default: assert.fail(`Unexpected route ${parsed.pathname}`)
    }
  }

  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    const { document, react } = harness
    const body = document.body
    const q = selector => body.querySelector(selector)
    const dialog = () => q('[role="dialog"]')
    const button = key => {
      const control = dialog().querySelectorAll('[type="button"]').find(item => textOf(item) === key)
      assert.ok(control, key)
      return control
    }
    const submit = () => dialog().props.onSubmit({ preventDefault() {} })
    const change = (id, value) => q(`[id="vcs-repository-config-${id}"]`).props.onChange({ target: { value } })
    const open = async trigger => {
      trigger.focus()
      harness.keyDown(trigger, 'ArrowDown')
      await harness.settle()
      assert.ok(q('[role="menuitem"]') === document.activeElement, 'the empty picker focuses its only action')
      assert.match(textOf(q('.vcs-repo-menu')), /top\.noRepository/u, 'the empty list says so under the header')
      harness.keyClick(document.activeElement)
      await harness.settle()
      assert.equal(document.activeElement, q('[id="vcs-repository-config-title"]'))
    }
    harness.mount(react.createElement(VcsView, { sessionId, t }))
    await harness.settle()
    const trigger = q('.vcs-repo-button')
    assert.equal(trigger.props.disabled, false)
    await open(trigger)
    harness.keyDown(document.activeElement, 'Escape')
    assert.equal(dialog(), null)
    assert.equal(document.activeElement, trigger)
    await open(trigger)
    assert.match(textOf(dialog()), /repositoryConfig.scope.*\/workspace/u)
    assert.match(textOf(dialog()), /repositoryConfig.directoryHint/u)
    assert.match(textOf(dialog()), /missing\/repo.*repositoryConfig.unavailable/u)
    assert.ok(textOf(dialog()).indexOf('repositoryConfig.path') < textOf(dialog()).indexOf('missing/repo'))
    harness.keyClick(button('repositoryConfig.remove'))
    assert.doesNotMatch(textOf(dialog()), /missing\/repo/u)

    change('path', './deep/path/')
    await harness.settle()
    assert.equal(harness.keyDown(q('[id="vcs-repository-config-path"]'), 'Enter').prevented, true)
    await harness.settle()
    assert.match(textOf(dialog()), /deep\/path\/repo/u)
    assert.match(textOf(dialog()), /repositoryConfig.previewTruncated/u)
    assert.match(textOf(dialog().querySelector('[role="status"]')), /repositoryConfig.previewResult.*\(1\)/u)
    harness.keyClick(button('repositoryConfig.add'))
    await harness.settle()
    assert.match(textOf(dialog().querySelector('[role="status"]')), /repositoryConfig.addedDraft.*deep\/path/u)
    submit()
    await harness.settle()
    assert.equal(document.activeElement, q('[id="vcs-repository-config-title"]'))
    assert.ok(dialog().querySelectorAll('[role="status"]').some(status => textOf(status) === 'repositoryConfig.saving'))
    assert.equal(button('branch.cancel').attributes.get('aria-disabled'), 'true')
    harness.keyDown(document.activeElement, 'Escape')
    assert.ok(dialog(), 'the in-flight write cannot be dismissed')
    pendingSave.resolve()
    await harness.settle()
    assert.deepEqual(posts, [{
      sessionId, revision: 'one', scanDirectories: ['deep/path'], repositories: [],
      backends: [{ path: '.', vcs: 'jujutsu' }],
    }])
    assert.match(textOf(dialog()), /error.repositoryConfigConflict/u)
    assert.match(textOf(dialog()), /deep\/path/u, 'conflict preserves the draft until reload')
    assert.equal(requests.filter(path => path === '/api/vcs.repositories').length, 1)

    harness.keyClick(button('repositoryConfig.discardReload'))
    await harness.settle()
    assert.doesNotMatch(textOf(dialog()), /deep\/path/u)
    change('kind', 'repository')
    change('path', 'deep/path')
    await harness.settle()
    harness.keyClick(button('repositoryConfig.preview'))
    await harness.settle()
    assert.match(textOf(dialog()), /error.repositoryPathUnavailable/u)
    assert.equal(button('repositoryConfig.add').props.disabled, true)
    change('path', 'deep/path/repo')
    await harness.settle()
    harness.keyClick(button('repositoryConfig.preview'))
    await harness.settle()
    harness.keyClick(button('repositoryConfig.add'))
    submit()
    await harness.settle()
    assert.deepEqual(posts[1], {
      sessionId, revision: 'two', scanDirectories: [], repositories: ['deep/path/repo'], backends: [],
    })
    assert.equal(dialog(), null)
    assert.equal(textOf(trigger), 'repo')
    assert.equal(requests.filter(path => path === '/api/vcs.repositories').length, 2)

    trigger.focus()
    harness.keyDown(trigger, 'ArrowDown')
    await harness.settle()
    const manage = q('.vcs-repo-manage')
    assert.ok(q('.vcs-repo-menu').querySelector('.vcs-picker-header').querySelector('.vcs-repo-manage') === manage,
      'the manage action sits in the menu header row')
    assert.equal(q('.vcs-repo-menu').querySelectorAll('[role="menuitem"]').length, 1, 'the list keeps no second manage entry')
    assert.equal(manage.attributes.get('aria-label'), 'repositoryConfig.manage')
    harness.keyDown(document.activeElement, 'Home')
    assert.ok(document.activeElement === manage, 'Home reaches the header action first')
    harness.keyClick(manage)
    await harness.settle()
    const disclosure = dialog().querySelector('[aria-controls="vcs-repository-sources"]')
    const sources = dialog().querySelector('[id="vcs-repository-sources"]')
    assert.equal(disclosure.attributes.get('aria-expanded'), 'false')
    assert.equal(sources.props.hidden, true)
    disclosure.focus()
    harness.keyClick(disclosure)
    assert.equal(disclosure.attributes.get('aria-expanded'), 'true')
    assert.equal(sources.props.hidden, false)
    assert.equal(document.activeElement, disclosure)
    assert.match(textOf(sources), /repositoryConfig.sourceRepository/u)
    assert.match(textOf(sources), /repositoryConfig.sourceDirectory/u)
    const backend = sources.querySelector('.vcs-repository-backend-select')
    assert.ok(backend, 'a colocated repository offers its backends')
    assert.equal(backend.props.value, 'auto')
    backend.props.onChange({ target: { value: 'git' } })
    await harness.settle()
    submit()
    await harness.settle()
    assert.deepEqual(posts[2], {
      sessionId, revision: 'three', scanDirectories: [], repositories: ['deep/path/repo'],
      backends: [{ path: 'deep/path/repo', vcs: 'git' }],
    })
  } finally {
    harness.unmount()
    restore()
    globalThis.fetch = previousFetch
  }
})

test('VcsView leaves repository configuration read-only when the Host reports invalid JSON', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  const previousFetch = globalThis.fetch
  const code = 'repository-config-invalid'
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'GET')
    const path = new URL(url, 'http://127.0.0.1').pathname
    assert.ok(path === '/api/vcs.repositories' || path === '/api/vcs.repository-config')
    const data = path === '/api/vcs.repositories'
      ? { repositories: [], configError: code }
      : { scanDirectories: [], repositories: [], revision: 'invalid', error: code }
    return { ok: true, status: 200, async json() { return data } }
  }
  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    const { document, react } = harness
    const body = document.body
    harness.mount(react.createElement(VcsView, { sessionId: 'invalid-config', t }))
    await harness.settle()
    assert.equal(textOf(body.querySelector('[role="alert"]')), 'error.repositoryConfigInvalid')
    harness.keyClick(body.querySelector('.vcs-repo-button'))
    await harness.settle()
    harness.keyClick(body.querySelector('[role="menuitem"]'))
    await harness.settle()
    const dialog = body.querySelector('[role="dialog"]')
    assert.match(textOf(dialog), /error.repositoryConfigInvalid/u)
    assert.equal(dialog.querySelector('[id="vcs-repository-config-path"]'), null)
    assert.equal(dialog.querySelector('[type="submit"]').props.disabled, true)
  } finally {
    harness.unmount()
    restore()
    globalThis.fetch = previousFetch
  }
})

test('VcsView merges visible invalidations, keeps domains separate, and catches up after hiding', async () => {
  const harness = createHarness()
  const restore = harness.installGlobals()
  const previousFetch = globalThis.fetch
  const previousEventSource = globalThis.EventSource
  const sources = []
  globalThis.EventSource = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      this.closed = false
      sources.push(this)
    }
    close() { this.closed = true }
  }
  const reads = []
  const repo = { path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }
  let file = 'before.js'
  let nestedFile = 'old.txt'
  let pendingStatus = null
  globalThis.fetch = async url => {
    const { pathname: route, searchParams } = new URL(url, 'http://127.0.0.1')
    reads.push(route)
    let data
    if (route === '/api/vcs.repositories') {
      data = { repositories: [repo] }
    } else if (route === '/api/vcs.status') {
      if (pendingStatus !== null) await pendingStatus.promise
      data = {
        repo, vcs: 'git', capabilities: GIT_CAPABILITIES, total: 1,
        branch: { name: 'main', oid: null, unborn: true },
        groups: {
          staged: [], unstaged: [{ path: file, status: 'M', added: 1, deleted: 0 }],
          untracked: [{ path: 'outer/', directory: true }],
        },
      }
    } else if (route === '/api/vcs.untracked') {
      const path = searchParams.get('path')
      assert.ok(path === 'outer/' || path === 'outer/inner/')
      data = { entries: path === 'outer/' ? [{ name: 'inner/', path: 'outer/inner/', type: 'directory' }]
        : [{ name: nestedFile, path: `outer/inner/${nestedFile}`, type: 'file' }] }
    } else {
      assert.equal(route, '/api/vcs.log')
      data = { commits: [] }
    }
    return { ok: true, status: 200, async json() { return data } }
  }

  try {
    const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harness)
    const { document, react } = harness
    const mount = (visible, focusRequest) => harness.mount(react.createElement('div', null,
      react.createElement('textarea', { className: 'composer' }),
      react.createElement('section', { 'data-dockkit-pane': 'right' },
        react.createElement(VcsView, { sessionId: 'session-refresh', t, visible, focusRequest })),
    ))
    const settleWatch = async () => {
      await harness.settle()
      await new Promise(resolve => { setTimeout(resolve, 180) })
      await harness.settle()
    }
    const takeReads = () => reads.splice(0).sort()
    const all = ['/api/vcs.log', '/api/vcs.repositories', '/api/vcs.status']
    const row = path => document.body.querySelector(`[data-row-key="merged|${path}"]`)
    const emit = (source, ...domains) => source.dispatchEvent(new MessageEvent('invalidate', { data: JSON.stringify({ domains }) }))

    mount(true, 1)
    await harness.settle()
    assert.deepEqual(takeReads(), all)
    assert.ok(row(file))
    const watch = sources.at(-1)
    assert.match(watch.url, /repo=%2Frepo/u)
    document.body.querySelector('.composer').focus()
    pendingStatus = Promise.withResolvers()
    emit(watch, 'working')
    emit(watch, 'working')
    await settleWatch()
    assert.deepEqual(takeReads(), ['/api/vcs.status'])
    assert.ok(row('before.js'), 'the previous rows stay mounted during the read')
    emit(watch, 'history')
    emit(watch, 'working')
    await settleWatch()
    assert.deepEqual(takeReads(), ['/api/vcs.log'], 'history can update while one working read is in flight')
    const finishStatus = pendingStatus.resolve
    pendingStatus = null
    file = 'after-composer.js'
    finishStatus()
    await settleWatch()
    assert.deepEqual(takeReads(), ['/api/vcs.status'], 'the working read gets one trailing request')
    assert.ok(row(file))
    assert.equal(document.activeElement, document.body.querySelector('.composer'))

    mount(false, 1)
    await harness.settle()
    assert.equal(watch.closed, true)
    harness.dispatchWindow('focus')
    await settleWatch()
    assert.deepEqual(takeReads(), [])

    file = 'after-terminal.js'
    mount(true, 2)
    await harness.settle()
    const resumed = sources.at(-1)
    resumed.dispatchEvent(new Event('ready'))
    await settleWatch()
    assert.deepEqual(takeReads(), all)
    assert.ok(row(file))

    document.visibilityState = 'hidden'
    harness.dispatchDocument('visibilitychange')
    await harness.settle()
    assert.equal(resumed.closed, true)
    harness.dispatchWindow('focus')
    await settleWatch()
    assert.deepEqual(takeReads(), [])

    file = 'after-browser-tab.js'
    document.visibilityState = 'visible'
    harness.dispatchDocument('visibilitychange')
    await harness.settle()
    const currentWatch = sources.at(-1)
    currentWatch.dispatchEvent(new Event('ready'))
    await settleWatch()
    assert.deepEqual(takeReads(), all)
    assert.ok(row(file))

    const directory = key => document.body.querySelector(`[data-row-key="unstaged|${key}"]`)
    harness.mouseClick(directory('outer'))
    await harness.settle()
    harness.mouseClick(directory('outer/inner'))
    await harness.settle()
    assert.ok(row('outer/inner/old.txt'))
    takeReads()
    nestedFile = 'new.txt'
    emit(currentWatch, 'working')
    await settleWatch()
    assert.deepEqual(takeReads(), ['/api/vcs.status', '/api/vcs.untracked', '/api/vcs.untracked'])
    assert.ok(row('outer/inner/new.txt'))
    assert.equal(row('outer/inner/old.txt'), null)
    harness.mouseClick(directory('outer/inner'))
    await harness.settle()
    nestedFile = 'while-closed.txt'
    emit(currentWatch, 'working')
    await settleWatch()
    assert.deepEqual(takeReads(), ['/api/vcs.status', '/api/vcs.untracked'])
    harness.mouseClick(directory('outer/inner'))
    await harness.settle()
    assert.ok(row('outer/inner/while-closed.txt'))
  } finally {
    pendingStatus?.resolve()
    harness.unmount()
    restore()
    globalThis.fetch = previousFetch
    globalThis.EventSource = previousEventSource
  }
})

test('Timeline virtualization, paging, ChangeTree hunk entry, header scroll-back, diff clicks/selection, narrow empty commit, and commitCache', async () => {
  // Part A: Timeline keeps focusRow mounted across large scroll offsets and handles PageUp/PageDown/Home/End.
  {
    const harness = createHarness()
    const restore = harness.installGlobals()
    try {
      const { Timeline, ROW_HEIGHT } = await loadClientModule('src/client/history/Timeline.tsx', harness)
      const commits = Array.from({ length: 50 }, (_, i) => ({
        sha: i.toString(16).padStart(40, '1'),
        parents: [],
        refs: [],
        author: 'Ada',
        authorTime: 1_700_000_000_000 - i * 1000,
        subject: `c-${i}`,
      }))
      const layout = { width: 1, rows: commits.map((_, i) => ({ x: 0, color: 0, lines: [], up: [], down: [], row: i + 1 })) }
      let selected = 1
      const renderTimeline = () => {
        harness.mount(harness.react.createElement(Timeline, {
          commits,
          layout,
          status: null,
          worktrees: [{ id: 'worktree:/repo', path: '/repo', label: 'Working tree', status: null, statusState: 'ready', refLabel: null }],
          selectedRow: selected,
          onSelectRow(idx) { selected = idx; renderTimeline() },
          onMove(delta) {
            selected = Math.max(0, Math.min(commits.length, selected + delta))
            renderTimeline()
          },
          onOpen() {},
          t,
          locale: 'en-US',
          loading: false,
          loadingMore: false,
          error: null,
          hasMore: false,
          truncated: false,
          onLoadMore() {},
          onRetry() {},
        }))
      }
      renderTimeline()
      const scrollEl = harness.document.body.querySelector('.vcs-timeline-scroll')
      scrollEl.clientHeight = ROW_HEIGHT * 4
      for (const ro of harness.resizes) ro.callback()

      const row1 = scrollEl.querySelector('[data-timeline-index="1"]')
      row1.focus()
      scrollEl.scrollTop = 1800
      scrollEl.props.onScroll({ currentTarget: scrollEl })
      const mountedRow1 = scrollEl.querySelector('[data-timeline-index="1"]')
      assert.notEqual(mountedRow1, null, 'focused row stays mounted past overscan')
      assert.equal(harness.document.activeElement, mountedRow1)

      harness.keyDown(mountedRow1, 'j')
      assert.equal(selected, 2)
      assert.equal(scrollEl.scrollTop, 2 * ROW_HEIGHT, 'selectedRow scrolls back into view synchronously')
      scrollEl.querySelector('[data-timeline-index="2"]').focus()

      harness.keyDown(harness.document.activeElement, 'PageDown')
      assert.equal(selected, 5)
      harness.keyDown(harness.document.activeElement, 'End')
      assert.equal(selected, commits.length)
      scrollEl.querySelector(`[data-timeline-index="${selected}"]`).focus()
      harness.keyDown(harness.document.activeElement, 'PageUp')
      assert.equal(selected, commits.length - 3)
      harness.keyDown(harness.document.activeElement, 'Home')
      assert.equal(selected, 0)
    } finally {
      harness.unmount()
      restore()
    }
  }

  // Part B: ChangeTree `→` enters hunk 0, `↑`/`[` at top row scroll header to 0, PageUp/PageDown/Home/End, diff click vs selection.
  {
    const harness = createHarness()
    const restore = harness.installGlobals()
    try {
      const { ChangeTree } = await loadClientModule('src/client/detail/ChangeTree.tsx', harness)
      const groups = [{
        id: 'unstaged',
        header: true,
        entries: [
          { path: 'a.js', status: 'M', added: 2, deleted: 2 },
          { path: 'b.js', status: 'M', added: 1, deleted: 1 },
        ],
      }]
      const rows = buildNodeRows(groups)
      const budget = budgetFolds(streamSections(groups, {}, null))
      const control = { current: null }
      const api = {
        async diff(_repo, target) {
          return {
            kind: 'text',
            path: target.path,
            before: true,
            after: true,
            hunks: [
              { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a1', '+b1'] },
              { oldStart: 20, oldLines: 2, newStart: 20, newLines: 2, lines: ['-a2', '+b2'] },
            ],
          }
        },
      }
      harness.mount(harness.react.createElement(ChangeTree, {
        api,
        repo: '/repo',
        rev: null,
        rows,
        budget,
        folds: { 'unstaged|a.js': false, 'unstaged|b.js': false },
        split: false,
        wrap: false,
        revision: 0,
        cache: new Map(),
        initialAnchor: null,
        onReading() {},
        onToggleRow() {},
        onBulkFold() {},
        onLeave() {},
        control,
        t,
        locale: 'en-US',
      }))
      harness.intersections[0].trigger(() => true)
      await harness.settle()

      const treeEl = harness.document.body.querySelector('.vcs-tree')
      treeEl.scrollHeight = 1500
      const groupWrap = treeEl.querySelector('.vcs-tree-group')
      const [fileA, fileB] = treeEl.querySelectorAll('.vcs-tree-file')
      const headers = treeEl.querySelectorAll('[data-diff-hunk-header]')
      groupWrap.offsetTop = 80
      groupWrap.offsetParent = treeEl
      fileA.offsetTop = 120
      fileA.offsetParent = treeEl
      fileB.offsetTop = 700
      fileB.offsetParent = treeEl
      headers[0].offsetTop = 44
      headers[1].offsetTop = 260
      headers[2].offsetTop = 44
      headers[3].offsetTop = 260

      // Row 0 (`group`) scrolled down -> `[` / `ArrowUp` scrolls scrollTop back to 0 for the commit header.
      const groupBtn = treeEl.querySelector('.vcs-tree-group-head')
      groupBtn.focus()
      treeEl.scrollTop = 80
      harness.keyDown(groupBtn, 'ArrowUp')
      assert.equal(treeEl.scrollTop, 0, 'ArrowUp on top row scrolls header into view')

      // `]` onto open file a.js, then `ArrowRight` enters hunk 0 directly.
      harness.keyDown(groupBtn, ']')
      assert.equal(harness.document.activeElement?.dataset?.rowKey, 'unstaged|a.js')
      harness.keyDown(harness.document.activeElement, 'ArrowRight')
      assert.equal(harness.document.activeElement, headers[0], 'Right on open file steps into its first hunk')

      // PageDown, PageUp, End, Home.
      harness.keyDown(headers[0], 'PageDown')
      assert.equal(treeEl.scrollTop > 0, true)
      harness.keyDown(harness.document.activeElement, 'End')
      assert.equal(harness.document.activeElement, headers[3])
      harness.keyDown(harness.document.activeElement, 'PageUp')
      assert.equal(treeEl.scrollTop < 1000, true)
      harness.keyDown(harness.document.activeElement, 'Home')
      assert.equal(treeEl.scrollTop, 0)
      assert.equal(harness.document.activeElement, groupBtn)

      // Clicking a diff line focuses its hunk stop; a non-collapsed text selection keeps selection intact.
      const diffLineA1 = fileA.querySelector('[data-diff-line]')
      harness.mouseClick(diffLineA1)
      assert.equal(harness.document.activeElement, headers[0])

      harness.setSelection('copied diff text')
      const fileBLine = fileB.querySelector('[data-diff-line]')
      harness.mouseClick(fileBLine)
      assert.equal(harness.document.activeElement, headers[0], 'text selection preserves focus/selection instead of jumping')
      harness.setSelection('')
    } finally {
      harness.unmount()
      restore()
    }
  }

  // Part C: Narrow single-column 0-file commit row click -> detail (`←` returns to timeline) + DetailPane commitCache.
  {
    const c1 = '1'.repeat(40)
    const c2 = '2'.repeat(40)
    const commitCalls = new Map()
    const json = body => ({ ok: true, status: 200, async json() { return body } })
    const fetchImpl = async url => {
      const parsed = new URL(url, 'http://127.0.0.1')
      if (parsed.pathname === '/api/vcs.repositories') {
        return json({
          cwd: '/repo',
          truncated: false,
          repositories: [{ path: '/repo', name: 'repo', enclosing: true, vcs: 'git', capabilities: GIT_CAPABILITIES }],
        })
      }
      if (parsed.pathname === '/api/vcs.status') {
        return json({
          repo: { path: '/repo', name: 'repo' },
          vcs: 'git',
          capabilities: GIT_CAPABILITIES,
          defaultNode: c1,
          branch: { name: 'main', oid: c1, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
          groups: { staged: [], unstaged: [], untracked: [] },
          total: 0,
          truncated: false,
        })
      }
      if (parsed.pathname === '/api/vcs.log') {
        return json({
          truncated: false,
          nextSkip: null,
          commits: [
            { sha: c1, parents: [c2], refs: [{ name: 'main', kind: 'branch', current: true }], author: 'Ada', authorTime: 1_700_000_000_000, subject: 'first' },
            { sha: c2, parents: [], refs: [], author: 'Ada', authorTime: 1_699_000_000_000, subject: 'empty' },
          ],
        })
      }
      if (parsed.pathname === '/api/vcs.commit') {
        const sha = parsed.searchParams.get('sha')
        commitCalls.set(sha, (commitCalls.get(sha) ?? 0) + 1)
        return json({
          truncated: false,
          commit: {
            sha,
            parents: sha === c1 ? [c2] : [],
            refs: [],
            author: 'Ada',
            authorTime: 1_700_000_000_000,
            committer: 'Ada',
            committerTime: 1_700_000_000_000,
            subject: sha === c1 ? 'first' : 'empty',
            message: '',
            files: [],
          },
        })
      }
      return json({ kind: 'text', path: 'a.js', before: true, after: true, hunks: [] })
    }

    const savedFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    const harnessNarrow = createHarness({ width: 620 })
    const restoreNarrow = harnessNarrow.installGlobals()
    try {
      const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harnessNarrow)
      harnessNarrow.mount(harnessNarrow.react.createElement(VcsView, { sessionId: 'session-narrow-empty', t, locale: 'en-US', focusRequest: 1 }))
      await harnessNarrow.settle()
      const body = harnessNarrow.document.body
      harnessNarrow.mouseClick(body.querySelector('[data-timeline-index="2"]'))
      await harnessNarrow.settle()
      assert.equal(body.querySelector('.vcs-content') !== null, true)
      assert.equal(body.querySelector('.vcs-root').contains(harnessNarrow.document.activeElement), true)
      harnessNarrow.keyDown(harnessNarrow.document.activeElement, 'ArrowLeft')
      await harnessNarrow.settle()
      assert.equal(harnessNarrow.document.activeElement?.dataset?.timelineIndex, '2', 'Left on 0-file commit detail returns to timeline')
    } finally {
      harnessNarrow.unmount()
      restoreNarrow()
    }

    // Wide layout: commitCache prevents refetching visited commits on j/k until Refresh.
    commitCalls.clear()
    const harnessWide = createHarness({ width: 1000 })
    const restoreWide = harnessWide.installGlobals()
    try {
      const { VcsView } = await loadClientModule('src/client/VcsView.tsx', harnessWide)
      harnessWide.mount(harnessWide.react.createElement(VcsView, { sessionId: 'session-cache', t, locale: 'en-US', focusRequest: 1 }))
      await harnessWide.settle()
      assert.equal(commitCalls.get(c1), 1)
      harnessWide.keyDown(harnessWide.document.activeElement, 'j')
      await harnessWide.settle()
      assert.equal(commitCalls.get(c2), 1)
      harnessWide.keyDown(harnessWide.document.activeElement, 'k')
      await harnessWide.settle()
      harnessWide.keyDown(harnessWide.document.activeElement, 'j')
      await harnessWide.settle()
      assert.equal(commitCalls.get(c1), 1, 'revisiting c1 hits commitCache')
      assert.equal(commitCalls.get(c2), 1, 'revisiting c2 hits commitCache')

      harnessWide.mouseClick(harnessWide.document.body.querySelector('[aria-label="top.refresh"]'))
      await harnessWide.settle()
      assert.equal(commitCalls.get(c2), 2, 'Refresh clears commitCache and refetches selected commit')
    } finally {
      harnessWide.unmount()
      restoreWide()
      globalThis.fetch = savedFetch
    }
  }
})
