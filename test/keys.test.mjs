import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BACK, canClaimFocusFrom, DOWN, FORWARD, isDiscreteActionButton, isEditableTarget,
  isNavigationStop, isOverlayOrMenuTarget, isOverlayTarget, movement, rowStep, unmodified, UP, zoneOf,
} from '../lib/client/keys.js'

test('movement maps arrows and vim keys to one direction', () => {
  assert.equal(movement({ key: 'ArrowUp' }), UP)
  assert.equal(movement({ key: 'k' }), UP)
  assert.equal(movement({ key: 'ArrowDown' }), DOWN)
  assert.equal(movement({ key: 'j' }), DOWN)
  assert.equal(movement({ key: 'ArrowLeft' }), BACK)
  assert.equal(movement({ key: 'h' }), BACK)
  assert.equal(movement({ key: 'ArrowRight' }), FORWARD)
  assert.equal(movement({ key: 'l' }), FORWARD)
})

test('movement ignores command modifiers and keys outside the vocabulary', () => {
  assert.equal(movement({ key: 'j', ctrlKey: true }), null)
  assert.equal(movement({ key: 'ArrowDown', altKey: true }), null)
  assert.equal(movement({ key: 'h', metaKey: true }), null)
  assert.equal(movement({ key: 'Enter' }), null)
  assert.equal(movement({ key: 'Escape' }), null)
  assert.equal(movement({ key: 'J' }), null)
})

test('unmodified reports the command modifiers', () => {
  assert.equal(unmodified({ key: 'x' }), true)
  assert.equal(unmodified({ key: 'x', ctrlKey: true }), false)
  assert.equal(unmodified({ key: 'x', altKey: true }), false)
  assert.equal(unmodified({ key: 'x', metaKey: true }), false)
})

test('rowStep maps the bracket keys to a row step', () => {
  assert.equal(rowStep({ key: ']' }), 1)
  assert.equal(rowStep({ key: '[' }), -1)
  // On a US layout `]` is typed with Shift; Shift is not a command modifier.
  assert.equal(rowStep({ key: ']', shiftKey: true }), 1)
  assert.equal(rowStep({ key: ']', ctrlKey: true }), 0)
  assert.equal(rowStep({ key: 'j' }), 0)
})

test('AltGr is a character modifier, not a command modifier', () => {
  const altGraph = { altKey: true, getModifierState: key => key === 'AltGraph' }
  assert.equal(unmodified(altGraph), true)
  assert.equal(movement({ ...altGraph, key: 'j' }), DOWN)
  assert.equal(rowStep({ ...altGraph, key: ']' }), 1, 'German and French layouts type brackets with AltGr')
  assert.equal(unmodified({ altKey: true, getModifierState: () => false }), false)
  assert.equal(unmodified({ altKey: true }), false, 'an event without modifier state keeps Alt as a command key')
})

test('isEditableTarget recognizes form controls and editable elements without HTMLElement', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true)
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'BUTTON', isContentEditable: false }), false)
  assert.equal(isEditableTarget({ tagName: 'svg' }), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget(undefined), false)
})

function stubNode(tagName, { classes = [], attrs = {}, dataset = {}, children = [] } = {}) {
  const classSet = new Set(classes)
  const attrMap = new Map(Object.entries(attrs))
  const node = {
    tagName: tagName.toUpperCase(),
    dataset: { ...dataset },
    attributes: attrMap,
    parentElement: null,
    ownerDocument: null,
    classList: { contains: token => classSet.has(token) },
    contains(target) {
      let current = target
      while (current !== null && current !== undefined) {
        if (current === node) return true
        current = current.parentElement ?? null
      }
      return false
    },
  }
  for (const child of children) {
    child.parentElement = node
  }
  return node
}

test('zoneOf, isNavigationStop, isOverlayOrMenuTarget, and isDiscreteActionButton classify panel controls', () => {
  const timelineIcon = stubNode('span')
  const timelineRow = stubNode('button', {
    classes: ['vcs-timeline-row'],
    dataset: { timelineIndex: '1' },
    children: [timelineIcon],
  })
  const timelineScroll = stubNode('div', { dataset: { zone: 'timeline' }, children: [timelineRow] })

  const treeRow = stubNode('button', { classes: ['vcs-tree-row'], dataset: { rowKey: 'commit|a.js' } })
  const hunkHeader = stubNode('div', {
    classes: ['vcs-diff-hunk-header'],
    attrs: { 'data-diff-hunk-header': '' },
  })
  const diffLine = stubNode('div', { classes: ['vcs-diff-line'] })
  const treeScroll = stubNode('div', {
    dataset: { zone: 'tree' },
    children: [treeRow, hunkHeader, diffLine],
  })

  const syncGlyph = stubNode('svg')
  const syncButton = stubNode('button', { classes: ['vcs-sync'], children: [syncGlyph] })
  const branchButton = stubNode('button', { attrs: { 'aria-haspopup': 'menu' } })
  const refButton = stubNode('button', { attrs: { 'aria-haspopup': 'menu' } })
  const menuItem = stubNode('button', { classes: ['vcs-menu-item'] })
  const repoMenu = stubNode('div', { attrs: { role: 'menu' }, children: [menuItem] })
  const dialogCancel = stubNode('button', { classes: ['vcs-button'] })
  const dialogLayer = stubNode('div', { classes: ['vcs-dialog-layer'], children: [dialogCancel] })
  const repoChevron = stubNode('svg')
  const repoButton = stubNode('button', { attrs: { 'aria-haspopup': 'menu' }, children: [repoChevron] })

  const root = stubNode('div', {
    classes: ['vcs-root'],
    children: [timelineScroll, treeScroll, syncButton, branchButton, refButton, repoMenu, dialogLayer, repoButton],
  })

  assert.equal(zoneOf(timelineIcon, root), 'timeline')
  assert.equal(zoneOf(treeRow, root), 'tree')
  assert.equal(zoneOf(hunkHeader, root), 'tree')
  assert.equal(zoneOf(diffLine, root), 'tree')
  assert.equal(zoneOf(syncButton, root), null)
  assert.equal(zoneOf(root, root), null)

  assert.equal(isNavigationStop(timelineIcon, root), true)
  assert.equal(isNavigationStop(treeRow, root), true)
  assert.equal(isNavigationStop(hunkHeader, root), true)
  assert.equal(isNavigationStop(diffLine, root), false)
  assert.equal(isNavigationStop(syncButton, root), false)

  assert.equal(isOverlayOrMenuTarget(branchButton, root), true)
  assert.equal(isOverlayOrMenuTarget(refButton, root), true)
  assert.equal(isOverlayOrMenuTarget(repoChevron, root), true)
  assert.equal(isOverlayOrMenuTarget(menuItem, root), true)
  assert.equal(isOverlayOrMenuTarget(dialogCancel, root), true)
  assert.equal(isOverlayOrMenuTarget(syncButton, root), false)

  assert.equal(isOverlayTarget(menuItem, root), true)
  assert.equal(isOverlayTarget(dialogCancel, root), true)
  assert.equal(isOverlayTarget(repoChevron, root), false)

  assert.equal(isDiscreteActionButton(syncButton, root), true)
  assert.equal(isDiscreteActionButton(syncGlyph, root), true)
  assert.equal(isDiscreteActionButton(timelineRow, root), false)
  assert.equal(isDiscreteActionButton(treeRow, root), false)
  assert.equal(isDiscreteActionButton(branchButton, root), false)
  assert.equal(isDiscreteActionButton(refButton, root), false)
  assert.equal(isDiscreteActionButton(menuItem, root), false)
  assert.equal(isDiscreteActionButton(dialogCancel, root), false)
  assert.equal(isDiscreteActionButton(repoChevron, root), false)
})

test('canClaimFocusFrom accepts idle/pane/VCS targets and refuses external inputs, other panes, and modals', () => {
  const modalNodes = []
  const doc = {
    documentElement: stubNode('html'),
    body: stubNode('body'),
  }
  doc.body.querySelectorAll = selector => (selector === '[aria-modal="true"]' ? modalNodes : [])

  const syncButton = stubNode('button', { classes: ['vcs-sync'] })
  const repoButton = stubNode('button', { attrs: { 'aria-haspopup': 'menu' } })
  const menuItem = stubNode('button', { classes: ['vcs-menu-item'] })
  const repoMenu = stubNode('div', { attrs: { role: 'menu' }, children: [menuItem] })
  const root = stubNode('div', { classes: ['vcs-root'], children: [syncButton, repoButton, repoMenu] })
  const tabChip = stubNode('button', { attrs: { role: 'tab' } })
  const vcsPane = stubNode('div', { attrs: { 'data-dockkit-pane': 'right' }, children: [tabChip, root] })

  const chatTextarea = stubNode('textarea')
  const chatButton = stubNode('button')
  const chatPane = stubNode('div', { attrs: { 'data-dockkit-pane': 'main' }, children: [chatTextarea, chatButton] })
  const turnBanner = stubNode('button', { classes: ['vcs-turn-banner'] })
  const externalDialogBtn = stubNode('button')
  const externalDialog = stubNode('div', { attrs: { role: 'dialog' }, children: [externalDialogBtn] })
  const externalModal = stubNode('div', { attrs: { 'aria-modal': 'true' } })

  for (const node of [doc.body, doc.documentElement, vcsPane, tabChip, root, syncButton, repoButton, repoMenu, menuItem, chatPane, chatTextarea, chatButton, turnBanner, externalDialog, externalDialogBtn, externalModal]) {
    node.ownerDocument = doc
  }

  assert.equal(canClaimFocusFrom(doc.body, null), false)
  assert.equal(canClaimFocusFrom(null, root), true)
  assert.equal(canClaimFocusFrom(doc.body, root), true)
  assert.equal(canClaimFocusFrom(doc.documentElement, root), true)
  assert.equal(canClaimFocusFrom(root, root), true)
  assert.equal(canClaimFocusFrom(syncButton, root), true)
  assert.equal(canClaimFocusFrom(vcsPane, root), true)
  assert.equal(canClaimFocusFrom(tabChip, root), true)
  assert.equal(canClaimFocusFrom(turnBanner, root), true)

  // Refuses menu triggers, open menus, other panes, and modals.
  assert.equal(canClaimFocusFrom(repoButton, root), false)
  assert.equal(canClaimFocusFrom(menuItem, root), false)
  assert.equal(canClaimFocusFrom(chatTextarea, root), false)
  assert.equal(canClaimFocusFrom(chatButton, root), false)
  assert.equal(canClaimFocusFrom(externalDialogBtn, root), false)

  modalNodes.push(externalModal)
  assert.equal(canClaimFocusFrom(doc.body, root), false)
})
