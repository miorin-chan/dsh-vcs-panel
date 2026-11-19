/**
 * Tests for the vendored FileDiff renderer and its local highlighter.
 *
 * `node --test` cannot parse JSX and the plugin has no installed React, so the
 * test registers a tiny loader that (a) loads `.jsx` modules as ESM and
 * (b) resolves `react` to a minimal element/hook stub. The component is written
 * without JSX syntax for the same reason; its element tree is inspected here
 * without a DOM.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { register } from 'node:module'

const REACT_STUB = `
export function createElement(type, props, ...children) {
  const source = props ?? {}
  const next = { ...source }
  delete next.key
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  return { type, key: source.key, props: next }
}
export const Fragment = Symbol('Fragment')
export function useEffect() {}
export function useMemo(factory) { return factory() }
export function useRef(value) { return { current: value } }
export function useState(value) { return [value, () => {}] }
`

const reactUrl = 'data:text/javascript;base64,' + Buffer.from(REACT_STUB).toString('base64')
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'react') return { url: ${JSON.stringify(reactUrl)}, shortCircuit: true }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) return nextLoad(url, { ...context, format: 'module' })
  return nextLoad(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(loaderSource))

const diffModule = await import(new URL('../src/client/diff/FileDiff.jsx', import.meta.url))
const highlightModule = await import(new URL('../src/client/diff/highlight.js', import.meta.url))

const {
  FileDiff,
  default: FileDiffDefault,
  hunkRows,
  splitRows,
  renderedHunks,
  isOneSided,
  isValidDiff,
  MAX_RENDERED_LINES,
} = diffModule

const {
  TOKEN_KINDS,
  SUPPORTED_LANGUAGES,
  languageForPath,
  highlightLines,
  tokenizeLines,
} = highlightModule

// ---------------------------------------------------------------------------
// Small element-tree helpers (no DOM).
// ---------------------------------------------------------------------------

/** Render function components with the stubbed hooks until only host nodes remain. */
function renderTree(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(renderTree)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderTree(node.type(node.props))
  const children = node.props?.children
  if (children === undefined) return node
  return { ...node, props: { ...node.props, children: renderTree(children) } }
}

/** Every element in a tree, depth first. */
function elements(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  elements(node.props?.children, out)
  return out
}

/** The text content of a node, including nested token spans. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function hasClass(element, className) {
  const value = element?.props?.className
  return typeof value === 'string' && value.split(' ').includes(className)
}

function findByClass(tree, className) {
  return elements(tree).find(element => hasClass(element, className))
}

function findByAttribute(tree, attribute) {
  return elements(tree).find(element => Object.hasOwn(element.props ?? {}, attribute))
}

function renderFileDiff(props) {
  return renderTree(FileDiff(props))
}

function tFor(calls) {
  return (key, vars) => {
    calls.push({ key, vars })
    return vars === undefined ? key : `${key}:${vars.count}`
  }
}

/** Compare a highlighted line to the exact source line. */
function assertTokensRoundTrip(lines, highlighted) {
  assert.ok(Array.isArray(highlighted), 'expected token runs')
  assert.equal(highlighted.length, lines.length)
  lines.forEach((line, index) => {
    const run = highlighted[index]
    assert.ok(Array.isArray(run), `line ${index} should be a token array`)
    assert.equal(run.map(token => token.text).join(''), line, `line ${index} text must be preserved`)
    for (const token of run) {
      assert.equal(typeof token.text, 'string')
      assert.ok(token.text.length > 0, 'tokenizer must not emit empty tokens')
      assert.ok(token.kind === undefined || TOKEN_KINDS.includes(token.kind), `unknown kind ${token.kind}`)
    }
  })
}

const HUNK = { oldStart: 10, oldLines: 3, newStart: 20, newLines: 3, lines: [' ctx', '-old', '+new'] }

function textDiff(overrides = {}) {
  return {
    kind: 'text',
    path: 'src/view.jsx',
    before: true,
    after: true,
    hunks: [HUNK],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Row numbering.
// ---------------------------------------------------------------------------

test('MAX_RENDERED_LINES is 5000 and the module exposes named and default FileDiff', () => {
  assert.equal(MAX_RENDERED_LINES, 5000)
  assert.equal(typeof FileDiff, 'function')
  assert.equal(FileDiffDefault, FileDiff)
})

test('hunkRows numbers context, deletion, and addition lines', () => {
  const rows = hunkRows(HUNK)
  assert.deepEqual(rows, [
    { kind: 'context', old: 10, new: 20, text: 'ctx' },
    { kind: 'del', old: 11, new: undefined, text: 'old' },
    { kind: 'add', old: undefined, new: 21, text: 'new' },
  ])
})

test('hunkRows keeps numbering independent per hunk', () => {
  const first = hunkRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two'] })
  const second = hunkRows({ oldStart: 100, oldLines: 2, newStart: 200, newLines: 2, lines: ['+x', ' y'] })
  assert.deepEqual(first.map(row => [row.old, row.new]), [[1, 1], [2, undefined]])
  assert.deepEqual(second.map(row => [row.old, row.new]), [[undefined, 200], [100, 201]])
})

test('hunkRows treats an empty payload line as context and strips the prefix', () => {
  const rows = hunkRows({ oldStart: 5, oldLines: 2, newStart: 5, newLines: 2, lines: [' ', '-'] })
  assert.deepEqual(rows, [
    { kind: 'context', old: 5, new: 5, text: '' },
    { kind: 'del', old: 6, new: undefined, text: '' },
  ])
})

// ---------------------------------------------------------------------------
// Side-by-side pairing.
// ---------------------------------------------------------------------------

test('splitRows pairs a deletion run with the following addition run row by row', () => {
  const rows = splitRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: ['-a', '-b', '+x', '+y', '+z'] })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { left: { no: 1, text: 'a', kind: 'del' }, right: { no: 1, text: 'x', kind: 'add' } })
  assert.deepEqual(rows[1], { left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: 'y', kind: 'add' } })
  assert.deepEqual(rows[2], { right: { no: 3, text: 'z', kind: 'add' } })
  assert.equal(Object.hasOwn(rows[2], 'left'), false)
})

test('splitRows puts context on both sides and flushes runs in order', () => {
  const rows = splitRows({ oldStart: 3, oldLines: 5, newStart: 7, newLines: 5, lines: ['-a', '+b', ' c', '-d', '+e', '+f'] })
  assert.deepEqual(rows, [
    { left: { no: 3, text: 'a', kind: 'del' }, right: { no: 7, text: 'b', kind: 'add' } },
    {
      left: { no: 4, text: 'c', kind: 'context' },
      right: { no: 8, text: 'c', kind: 'context' },
    },
    { left: { no: 5, text: 'd', kind: 'del' }, right: { no: 9, text: 'e', kind: 'add' } },
    { right: { no: 10, text: 'f', kind: 'add' } },
  ])
})

test('splitRows handles addition-only and deletion-only runs', () => {
  const additions = splitRows({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] })
  assert.deepEqual(additions, [
    { right: { no: 1, text: 'a', kind: 'add' } },
    { right: { no: 2, text: 'b', kind: 'add' } },
  ])
  const deletions = splitRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-a', '-b'] })
  assert.deepEqual(deletions, [
    { left: { no: 1, text: 'a', kind: 'del' } },
    { left: { no: 2, text: 'b', kind: 'del' } },
  ])
})

// ---------------------------------------------------------------------------
// Truncation.
// ---------------------------------------------------------------------------

const makeHunk = count => ({ oldStart: 1, oldLines: count, newStart: 1, newLines: count, lines: Array.from({ length: count }, () => '+x') })

test('renderedHunks keeps hunks under the line budget unchanged', () => {
  const hunks = [makeHunk(3000), makeHunk(2000)]
  const result = renderedHunks(hunks)
  assert.equal(result.truncated, false)
  assert.equal(result.hunks.length, 2)
  assert.equal(result.hunks[0], hunks[0])
  assert.equal(result.hunks[1], hunks[1])
})

test('renderedHunks shortens the straddling hunk and reports truncation', () => {
  const first = makeHunk(3000)
  const second = makeHunk(3000)
  const result = renderedHunks([first, second])
  assert.equal(result.truncated, true)
  assert.equal(result.hunks.length, 2)
  assert.equal(result.hunks[0], first)
  assert.equal(result.hunks[1].lines.length, 2000)
  assert.equal(first.lines.length, 3000)
  assert.equal(second.lines.length, 3000)
})

test('renderedHunks stops after the budget and reports truncation', () => {
  const hunks = [makeHunk(5000), makeHunk(1)]
  const result = renderedHunks(hunks)
  assert.equal(result.truncated, true)
  assert.equal(result.hunks.length, 1)
  assert.equal(result.hunks[0], hunks[0])
})

test('renderedHunks accepts empty hunks and an empty list without truncation', () => {
  const emptyHunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }
  const result = renderedHunks([emptyHunk])
  assert.deepEqual(result, { hunks: [emptyHunk], truncated: false })
  assert.deepEqual(renderedHunks([]), { hunks: [], truncated: false })
})

// ---------------------------------------------------------------------------
// One-sided detection.
// ---------------------------------------------------------------------------

test('isOneSided is true only for addition-only or deletion-only comparisons', () => {
  assert.equal(isOneSided({ hunks: [{ lines: ['+a'] }] }), true)
  assert.equal(isOneSided({ hunks: [{ lines: ['-a'] }] }), true)
  assert.equal(isOneSided({ hunks: [{ lines: ['+a', '-b'] }] }), false)
  assert.equal(isOneSided({ hunks: [{ lines: [' ctx'] }] }), false)
  assert.equal(isOneSided({ hunks: [] }), false)
  assert.equal(isOneSided({ hunks: [{ lines: ['+a'] }, { lines: ['-b'] }] }), false)
})

// ---------------------------------------------------------------------------
// FileDiff states.
// ---------------------------------------------------------------------------

test('FileDiff renders loading and missing states through t', () => {
  const calls = []
  const loading = renderFileDiff({ state: 'loading', split: false, wrap: false, retry() {}, t: tFor(calls) })
  assert.equal(hasClass(loading, 'vcs-diff-root'), true)
  // Loading draws the outline of a comparison; only its label reaches the text.
  const shape = findByClass(loading, 'vcs-diff-skeleton')
  assert.equal(shape.props.role, 'status')
  assert.equal(shape.props['aria-busy'], 'true')
  assert.equal(hasClass(shape, 'vcs-skeleton'), true, 'it shares the delayed fade-in')
  assert.equal(findByClass(loading, 'vcs-diff-status'), undefined, 'no status sentence is shown')
  assert.equal(textOf(loading), 'diff.loading')

  const undefinedState = renderFileDiff({ state: undefined, split: false, wrap: false, retry() {}, t: tFor(calls) })
  assert.equal(textOf(undefinedState), 'diff.loading')

  const missing = renderFileDiff({ state: 'missing', split: false, wrap: false, retry() {}, t: tFor(calls) })
  assert.equal(textOf(missing), 'diff.missing')
  assert.deepEqual(calls.map(call => call.key), ['diff.loading', 'diff.loading', 'diff.missing'])
})

test('FileDiff error state renders a plain retry button and calls retry', () => {
  const calls = []
  let retried = 0
  const tree = renderFileDiff({
    state: 'error',
    split: false,
    wrap: false,
    retry() { retried += 1 },
    t: tFor(calls),
  })
  const button = elements(tree).find(element => element.type === 'button')
  assert.ok(button, 'expected a retry button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.className, 'vcs-diff-retry')
  assert.equal(textOf(button), 'diff.retry')
  assert.equal(textOf(tree).includes('diff.error'), true)
  button.props.onClick()
  assert.equal(retried, 1)

  // Null or malformed payloads degrade to the retryable error state instead of throwing.
  assert.equal(isValidDiff(null), false)
  assert.equal(isValidDiff({ kind: 'text' }), false)
  assert.equal(isValidDiff({ kind: 'binary', path: 'a.bin' }), true)
  assert.equal(isValidDiff(textDiff()), true)
  for (const invalid of [null, 42, {}, { kind: 'text' }, { kind: 'unknown' }]) {
    const fallback = renderFileDiff({ state: invalid, split: false, wrap: false, retry() { retried += 1 }, t: tFor([]) })
    assert.equal(textOf(fallback).includes('diff.error'), true)
  }
})

test('FileDiff renders binary and oversized notices through t', () => {
  const calls = []
  const t = tFor(calls)
  assert.equal(textOf(renderFileDiff({ state: { kind: 'binary', path: 'img.png' }, split: false, wrap: false, retry() {}, t })), 'diff.binary')
  assert.equal(textOf(renderFileDiff({ state: { kind: 'oversized', path: 'big.txt' }, split: false, wrap: false, retry() {}, t })), 'diff.oversized')
  assert.deepEqual(calls.map(call => call.key), ['diff.binary', 'diff.oversized'])
})

// ---------------------------------------------------------------------------
// Text comparison rendering.
// ---------------------------------------------------------------------------

test('FileDiff unified view renders hunk header, numbers, signs, and token spans', () => {
  const tree = renderFileDiff({ state: textDiff(), split: false, wrap: false, retry() {}, t: tFor([]) })
  const body = findByAttribute(tree, 'data-review-view')
  assert.equal(body.props['data-review-view'], 'unified')
  assert.equal(body.props['data-review-wrap'], undefined)

  const header = findByAttribute(tree, 'data-diff-hunk-header')
  assert.equal(textOf(header), '@@ -10,3 +20,3 @@')
  assert.equal(header.props.tabIndex, -1, 'a hunk header is focusable as a navigation stop')

  const rows = elements(tree).filter(element => Object.hasOwn(element.props ?? {}, 'data-diff-line'))
  assert.deepEqual(rows.map(row => row.props['data-diff-line']), ['context', 'del', 'add'])
  assert.equal(hasClass(rows[0], 'vcs-diff-line'), true)
  assert.equal(hasClass(rows[0], 'vcs-diff-context'), true)
  assert.equal(hasClass(rows[1], 'vcs-diff-del'), true)
  assert.equal(hasClass(rows[2], 'vcs-diff-add'), true)
  assert.deepEqual(rows.map(row => textOf(row)), ['1020 ctx', '11-old', '21+new'])
})

test('FileDiff highlights file text without innerHTML and preserves tokens', () => {
  const state = textDiff({ path: 'a.js', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+const answer = "yes"'] }] })
  const tree = renderFileDiff({ state, split: false, wrap: false, retry() {}, t: tFor([]) })
  for (const element of elements(tree)) {
    assert.equal(Object.hasOwn(element.props ?? {}, 'dangerouslySetInnerHTML'), false)
  }
  const text = findByClass(tree, 'vcs-diff-text')
  assert.equal(textOf(text), 'const answer = "yes"')
  const highlighted = elements(text).filter(element => hasClass(element, 'vcs-hl-keyword'))
  assert.equal(highlighted.length, 1)
  assert.equal(textOf(highlighted[0]), 'const')
})

test('FileDiff states created, deleted, and unchanged comparisons', () => {
  const cases = [
    { diff: textDiff({ before: false }), key: 'diff.created' },
    { diff: textDiff({ after: false }), key: 'diff.deleted' },
    { diff: textDiff({ hunks: [] }), key: 'diff.unchanged' },
  ]
  for (const entry of cases) {
    const calls = []
    const tree = renderFileDiff({ state: entry.diff, split: false, wrap: false, retry() {}, t: tFor(calls) })
    assert.equal(textOf(findByAttribute(tree, 'data-diff-note')), entry.key)
    assert.equal(calls.some(call => call.key === entry.key), true)
  }
})

test('FileDiff renders coarse and truncation notes with the count', () => {
  const calls = []
  const state = textDiff({
    coarse: true,
    hunks: [makeHunk(3000), makeHunk(3000)],
  })
  const tree = renderFileDiff({ state, split: false, wrap: false, retry() {}, t: tFor(calls), locale: 'en-US' })
  assert.equal(textOf(findByAttribute(tree, 'data-diff-coarse')), 'diff.coarse')
  assert.equal(textOf(findByAttribute(tree, 'data-diff-truncated')), 'diff.truncated:5,000')
  assert.deepEqual(calls.find(call => call.key === 'diff.truncated').vars, { count: '5,000' })
  assert.equal(elements(tree).filter(element => Object.hasOwn(element.props ?? {}, 'data-diff-line')).length, 5000)
})

test('FileDiff split view renders two synced columns', () => {
  const tree = renderFileDiff({ state: textDiff(), split: true, wrap: false, retry() {}, t: tFor([]) })
  const body = findByAttribute(tree, 'data-review-view')
  assert.equal(body.props['data-review-view'], 'split')
  const columns = elements(tree).filter(element => hasClass(element, 'vcs-diff-column'))
  assert.deepEqual(columns.map(column => column.props['data-diff-side']), ['left', 'right'])
  assert.equal(typeof columns[0].props.onScroll, 'function')
  const sideRows = elements(tree).filter(element => hasClass(element, 'vcs-diff-side-line'))
  assert.equal(sideRows.length, 4)
})

test('FileDiff split with wrap renders split rows in one column', () => {
  const tree = renderFileDiff({ state: textDiff(), split: true, wrap: true, retry() {}, t: tFor([]) })
  const body = findByAttribute(tree, 'data-review-view')
  assert.equal(body.props['data-review-view'], 'split')
  assert.equal(body.props['data-review-wrap'], true)
  assert.equal(elements(tree).some(element => hasClass(element, 'vcs-diff-column')), false)
  assert.equal(elements(tree).filter(element => hasClass(element, 'vcs-diff-split-line')).length, 2)
})

test('FileDiff falls back to one column for one-sided comparisons', () => {
  const tree = renderFileDiff({
    state: textDiff({ hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+only'] }] }),
    split: true,
    wrap: false,
    retry() {},
    t: tFor([]),
  })
  assert.equal(findByAttribute(tree, 'data-review-view').props['data-review-view'], 'unified')
  assert.equal(elements(tree).some(element => hasClass(element, 'vcs-diff-column')), false)
})

// ---------------------------------------------------------------------------
// Language resolution.
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  m: 'c',
  mm: 'cpp',
  rb: 'ruby',
  php: 'php',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  lua: 'lua',
}

test('languageForPath resolves every supported extension', () => {
  for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
    assert.equal(languageForPath(`src/file.${extension}`), language, `extension ${extension}`)
    assert.equal(languageForPath(`src/FILE.${extension.toUpperCase()}`), language, `uppercase extension ${extension}`)
    assert.equal(languageForPath(`C:\\repo\\src\\file.${extension}`), language, `windows path ${extension}`)
  }
  for (const language of new Set(Object.values(LANGUAGE_BY_EXTENSION))) {
    assert.ok(SUPPORTED_LANGUAGES.includes(language), `scanner registered for ${language}`)
  }
})

test('languageForPath returns undefined for unsupported or extensionless paths', () => {
  for (const path of ['README', 'src/data.txt', 'archive.tar.gz', 'src/file.', '.gitignore', 'src/.eslintrc', 42, null, undefined]) {
    assert.equal(languageForPath(path), undefined, String(path))
  }
})

test('highlightLines returns undefined for unsupported languages', () => {
  assert.equal(highlightLines('README', ['text']), undefined)
  assert.equal(highlightLines('notes.txt', ['text']), undefined)
  assert.equal(tokenizeLines('plaintext', ['text']), undefined)
  assert.deepEqual(tokenizeLines('javascript', []), [])
})

// ---------------------------------------------------------------------------
// Highlighter invariants.
// ---------------------------------------------------------------------------

const SAMPLES = [
  ['src/a.js', ['const answer = "yes"', '// note', 'function run(a, b) {', '  return `x${a}`', '}', '/* open', 'still', '*/']],
  ['src/a.jsx', ['export function App() {', '  return <div className="x">hi</div>', '}']],
  ['src/a.mjs', ['import x from "y"', 'export const n = 1']],
  ['src/a.cjs', ['module.exports = { n: null }']],
  ['src/a.ts', ['interface Point { x: number; y: number }', 'const p: Point = { x: 1, y: 2 }']],
  ['src/a.tsx', ['const App = () => <div className="x" />']],
  ['data/a.json', ['{"a": 1, "b": [true, null]}']],
  ['data/a.jsonc', ['// comment', '{ "a": 1 }']],
  ['styles/a.css', ['.a { color: #fff; margin: 0; }', '@media screen { .b { top: 10px; } }']],
  ['styles/a.scss', ['$color: #123; // note', '.a { color: $color; }']],
  ['styles/a.less', ['@color: #456;', '.a { color: @color; }']],
  ['page/a.html', ['<!-- start', 'still', '--> <div class="x" data-id=\'1\'>hi &amp; bye</div>']],
  ['page/a.xml', ['<?xml version="1.0"?>', '<root><item id="1">text</item></root>']],
  ['page/a.svg', ['<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" /></svg>']],
  ['page/a.vue', ['<template><div :class="x">{{ label }}</div></template>', '<script setup>const label = "x"</script>']],
  ['page/a.svelte', ['<script>let n = 0</script>', '<button on:click={() => n += 1}>{n}</button>']],
  ['docs/a.md', ['# Title', '[site](https://example.com)', '`inline`', '<!-- md', 'x -->', '```js', 'const x = 1', '```', '**bold** and _em_']],
  ['docs/a.mdx', ['import X from "./x"', '<X title="hi" />']],
  ['py/a.py', ['def greet(name):', '    # hi', '    s = """start', 'body', '"""', '    return True']],
  ['bin/a.sh', ['#!/usr/bin/env bash', '# comment', 'echo $HOME', 'if [ -f x ]; then echo "ok"; fi', 'for f in *.txt; do echo "$f"; done']],
  ['bin/a.bash', ['set -euo pipefail', 'echo ${HOME}']],
  ['bin/a.zsh', ['local -a items', 'print $items[1]']],
  ['go/a.go', ['package main', 'func main() {', '  x := 1', '  var s string = "hi"', '}']],
  ['rust/a.rs', ['fn main() {', '  let x: i32 = 1;', '  // note', '}']],
  ['jvm/A.java', ['public class A {', '  public static void main(String[] args) {', '    int x = 1;', '  }', '}']],
  ['jvm/A.kt', ['fun greet(name: String) {', '  val x = 1', '}']],
  ['native/a.c', ['#include <stdio.h>', 'int main(void) {', '  char *s = "hi";', '  /* comment */', '  return 0;', '}']],
  ['native/a.cpp', ['namespace app {', 'class A { public: void f(); };', 'template <typename T> T id(T value) { return value; }', '}']],
  ['native/a.m', ['#import <Foundation/Foundation.h>', 'int main() { @autoreleasepool {} return 0; }']],
  ['ruby/a.rb', ['def greet(name)', '  # hi', '  puts "x #{name}"', 'end']],
  ['web/a.php', ['<?php', 'function f($x) { return $x; }', '// note']],
  ['conf/a.yaml', ['key: value # comment', 'list:', '  - true', '  - 42', 'quoted: "a # b"']],
  ['conf/a.yml', ['name: demo', 'enabled: false']],
  ['conf/a.toml', ['[table]', 'key = "value" # note', 'flag = true', 'num = 42']],
  ['db/a.sql', ['SELECT * FROM users WHERE id = 1;', '-- comment', "UPDATE t SET name = 'x' WHERE id = ?;"]],
  ['lua/a.lua', ['local function f(x)', '  --[[ long', '  comment ]]', '  return x', 'end']],
]

test('highlightLines supports every required language and preserves exact line text', () => {
  for (const [path, lines] of SAMPLES) {
    const highlighted = highlightLines(path, lines)
    assert.notEqual(highlighted, undefined, `expected highlighting for ${path}`)
    assertTokensRoundTrip(lines, highlighted)
  }
})

test('highlightLines is deterministic and state is fresh per file', () => {
  const lines = ['/* open', 'still', '*/ const x = 1']
  assert.deepEqual(highlightLines('a.js', lines), highlightLines('a.js', lines))
  const first = highlightLines('a.js', lines)
  const second = highlightLines('a.js', ['const y = 2'])
  assert.equal(first[1][0].text, 'still')
  assert.deepEqual(second[0][0], { text: 'const', kind: 'keyword' })
})

test('highlightLines carries block comments, template strings, and HTML comments across lines', () => {
  const js = highlightLines('a.js', ['/* start', 'still a comment', '*/ const x = 1'])
  assert.deepEqual(js[1], [{ text: 'still a comment', kind: 'comment' }])
  assert.deepEqual(js[2][0], { text: '*/', kind: 'comment' })
  assert.equal(js[2].find(token => token.text === 'const').kind, 'keyword')

  const template = highlightLines('a.js', ['const a = `hello', 'world`', 'const b = 1'])
  assert.equal(template[1][0].kind, 'string')
  assert.equal(template[1][0].text, 'world`')
  assert.equal(template[2][0].kind, 'keyword')

  const python = highlightLines('a.py', ['s = """hello', 'world', '"""', 'x = 1'])
  assert.deepEqual(python[1], [{ text: 'world', kind: 'string' }])
  assert.deepEqual(python[2], [{ text: '"""', kind: 'string' }])
  assert.equal(python[3][0].kind, undefined)

  const html = highlightLines('a.html', ['<!-- start', 'still a comment', '--> <b>x</b>'])
  assert.deepEqual(html[1], [{ text: 'still a comment', kind: 'comment' }])
  assert.equal(html[2][0].kind, 'comment')

  const css = highlightLines('a.css', ['/* open', 'still', '*/ .x {}'])
  assert.deepEqual(css[1], [{ text: 'still', kind: 'comment' }])
  assert.equal(css[2][0].kind, 'comment')

  const lua = highlightLines('a.lua', ['--[[ open', 'still', ']] local x = 1'])
  assert.deepEqual(lua[1], [{ text: 'still', kind: 'comment' }])
  assert.equal(lua[2][0].kind, 'comment')
})

test('highlightLines never throws on empty lines, CRLF, or unterminated constructs', () => {
  const weird = ['', '\r', '   ', 'const x = 1\r', '`', '"unterminated', '/*', '*/', '[[', ']]', '<!--', '=begin', '=end', '\\', "'", '"""']
  for (const language of SUPPORTED_LANGUAGES) {
    const highlighted = tokenizeLines(language, weird)
    assert.notEqual(highlighted, undefined, language)
    assertTokensRoundTrip(weird, highlighted)
  }
})

test('highlightLines classifies representative keywords, strings, comments, numbers, and links', () => {
  const tokenOf = (path, line, predicate) => {
    const highlighted = highlightLines(path, [line])
    assert.notEqual(highlighted, undefined)
    return highlighted[0].find(predicate)
  }

  assert.deepEqual(tokenOf('a.js', 'const answer = "yes"', token => token.text === 'const'), { text: 'const', kind: 'keyword' })
  assert.deepEqual(tokenOf('a.js', 'const answer = "yes"', token => token.text === '"yes"'), { text: '"yes"', kind: 'string' })
  assert.deepEqual(tokenOf('a.js', '// note', token => true), { text: '// note', kind: 'comment' })
  assert.deepEqual(tokenOf('a.js', 'function run(a, b) {', token => token.text === 'run'), { text: 'run', kind: 'function' })
  assert.equal(tokenOf('a.js', 'function run(a, b) {', token => token.text === 'a').kind, 'parameter')
  assert.equal(tokenOf('a.js', 'function run(a, b) {', token => token.text === 'b').kind, 'parameter')
  assert.equal(tokenOf('a.js', 'const n = 42', token => token.text === '42').kind, 'number')
  assert.equal(tokenOf('a.js', 'const b = true', token => token.text === 'true').kind, 'constant')

  assert.equal(tokenOf('a.py', 'def greet(name):', token => token.text === 'def').kind, 'keyword')
  assert.equal(tokenOf('a.py', 'def greet(name):', token => token.text === 'greet').kind, 'function')
  assert.equal(tokenOf('a.py', 'def greet(name):', token => token.text === 'name').kind, 'parameter')
  assert.equal(tokenOf('a.py', 'x = True', token => token.text === 'True').kind, 'constant')
  assert.equal(tokenOf('a.py', '# note', token => true).kind, 'comment')

  assert.equal(tokenOf('a.json', 'true', token => token.text === 'true').kind, 'constant')
  assert.equal(tokenOf('a.json', '{"a": 1}', token => token.text === '"a"').kind, 'string')
  assert.equal(tokenOf('a.json', '{"a": 1}', token => token.text === '1').kind, 'number')

  assert.deepEqual(tokenOf('a.css', '.a { color: #fff; }', token => token.text === '#fff'), { text: '#fff', kind: 'constant' })
  assert.equal(tokenOf('a.css', '@media screen {', token => token.text === '@media').kind, 'keyword')
  assert.equal(tokenOf('a.css', '.a { color: red; }', token => token.text === 'red'), undefined)

  assert.equal(tokenOf('a.sh', '# comment', token => true).kind, 'comment')
  assert.deepEqual(tokenOf('a.sh', 'echo $HOME', token => token.text === '$HOME'), { text: '$HOME', kind: 'parameter' })

  assert.deepEqual(tokenOf('a.md', '[site](https://example.com)', token => token.kind === 'link'), { text: 'https://example.com', kind: 'link' })
  assert.equal(tokenOf('a.md', '`code`', token => token.kind === 'string').text, '`code`')

  assert.equal(tokenOf('a.html', '<div class="x">', token => token.text === 'div').kind, 'keyword')
  assert.equal(tokenOf('a.html', '<div class="x">', token => token.text === 'class').kind, 'parameter')
  assert.equal(tokenOf('a.html', '<div class="x">', token => token.text === '"x"').kind, 'string')

  assert.equal(tokenOf('a.go', 'func main() {', token => token.text === 'func').kind, 'keyword')
  assert.equal(tokenOf('a.rs', 'fn main() {', token => token.text === 'fn').kind, 'keyword')
  assert.equal(tokenOf('a.java', 'public class A {', token => token.text === 'public').kind, 'keyword')
  assert.equal(tokenOf('a.kt', 'fun greet(name: String) {', token => token.text === 'fun').kind, 'keyword')
  assert.equal(tokenOf('a.c', 'int main(void) {', token => token.text === 'int').kind, 'keyword')
  assert.equal(tokenOf('a.cpp', 'class A {', token => token.text === 'class').kind, 'keyword')
  assert.equal(tokenOf('a.rb', 'def greet', token => token.text === 'def').kind, 'keyword')
  assert.equal(tokenOf('a.php', 'function f($x) {', token => token.text === '$x').kind, 'parameter')
  assert.equal(tokenOf('a.sql', 'SELECT * FROM t', token => token.text === 'SELECT').kind, 'keyword')
  assert.equal(tokenOf('a.lua', 'local x = 1', token => token.text === 'local').kind, 'keyword')
  assert.equal(tokenOf('a.toml', 'flag = true', token => token.text === 'true').kind, 'constant')
  assert.equal(tokenOf('a.yaml', 'key: value', token => token.text === 'key').kind, 'parameter')
})
