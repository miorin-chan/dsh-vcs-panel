/**
 * The panel header, left to right: repository and worktree menus, working-state
 * facts with sync and branch switching, the panel's message, then the column
 * layout toggle, the read-only marker, and refresh.
 *
 * A backend with a separate working tree shows its branch; when it can sync,
 * the ahead/behind counts sit on the sync button beside the branch, so the
 * numbers and the action that settles them are one control. When it can
 * switch, the branch name itself opens the local-branch menu, and a right-click
 * hands the branch to the panel's shared actions menu. The message (a sync,
 * switch, or branch-action outcome, or a failure) follows them, so it reads
 * next to what it reports on. A backend whose working copy is a commit shows
 * `@`, its change id, and the refs pointing at it. The worktree menu also
 * offers the history ranges declared by the backend.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Arrow, BranchIcon, CheckIcon, Chevron, FilterIcon, IconButton, LockIcon, RefreshIcon, RefBadge, SyncIcon,
  TimelineBesideIcon, Turning, WorkingCopyBadge,
} from './ui.jsx'
import { errorMessage, formatCount, formatPlural, shortChangeId } from './format.js'
import { BRANCH_BUSY_KEYS } from './branch.js'
import { TAG_BUSY_KEYS } from './tag.js'
import { COMMIT_BUSY_KEYS } from './commit.js'
import { useFloatingMenu } from './useFloatingMenu.js'
import { workingCopyLabel, worktreeRefLabel } from './worktrees.js'

/** Ref badges shown in the header before the rest are left to the timeline. */
const HEADER_REFS = 3

/** Width of a header picker menu in CSS pixels, and its viewport inset. */
const MENU_WIDTH = 260
const MENU_MARGIN = 8
const MENU_GAP = 6

/** A fixed position lets the menu hang below the clipped header. */
function pickerPosition(trigger) {
  const rect = trigger?.getBoundingClientRect()
  if (rect === undefined) return null
  const viewport = typeof window === 'undefined' ? rect.left + MENU_WIDTH + MENU_MARGIN : window.innerWidth
  return {
    left: Math.max(MENU_MARGIN, Math.min(rect.left, viewport - MENU_WIDTH - MENU_MARGIN)),
    top: rect.bottom + MENU_GAP,
  }
}

/** Ahead/behind counts as two small arrows; zero sides are left out. */
function AheadBehind({ ahead, behind }) {
  return (
    <>
      {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
      {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
    </>
  )
}

/** Compact top-bar segmented switch shared by the worktree and branch pickers. */
function RangeHeader({ options, refMode, onRefMode, t }) {
  const moveSegment = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const radios = Array.from(event.currentTarget.parentElement?.querySelectorAll?.('[role="menuitemradio"]') ?? [])
    const index = radios.indexOf(event.currentTarget)
    if (index < 0 || radios.length < 2) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'ArrowRight'
      ? (index + 1) % radios.length
      : (index - 1 + radios.length) % radios.length
    radios[next]?.focus()
  }
  return (
    <div className="vcs-picker-header">
      <span className="vcs-picker-menu-title vcs-picker-range-label" aria-hidden="true">
        {t('history.commitsLabel')}
      </span>
      <div className="vcs-picker-range" role="group" aria-label={t('history.refLabel')}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            className="vcs-range-option"
            tabIndex={-1}
            aria-checked={option.value === refMode}
            title={t(option.title)}
            onClick={() => { if (option.value !== refMode) onRefMode(option.value) }}
            onKeyDown={moveSegment}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The branch control: a button that opens the repository's local branches,
 * with a compact header range toggle and a right-click actions menu on the
 * current branch and on each listed branch. The actions menu itself lives at
 * the panel root so the timeline's branch ref badges can open the same menu.
 *
 * The header clips its children, so the branch menu is positioned `fixed`
 * rather than inside its flow. It closes on Escape, an outside press, a
 * resize, or a scroll, and gives focus back to the button. Arrow keys, Home,
 * and End move between the header range switch and branch items, and the
 * checked-out branch is marked. Right-click and Shift+F10 hand the branch to
 * `onOpenActions`.
 *
 * @param {{ branch: object, branchText: string, branches: object[], branchesStatus: string, branchesError: object | null, branchesTruncated: boolean, ranges: object[], refMode: string, filtered: boolean, onRefMode: Function, onOpen: Function, onSwitch: Function, onOpenActions: Function, switching: boolean, busy: boolean, canOps: boolean, syncable: boolean, t: Function, locale?: string }} props - branch facts and menu state.
 */
function BranchSwitcher({
  branch, branchText, branches, branchesStatus, branchesError, branchesTruncated,
  ranges = [], refMode, filtered = false, onRefMode = () => {},
  onOpen, onSwitch, onOpenActions, onRestoreFocus = () => {}, switching, busy, canOps, syncable, t, locale,
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const openedByKeyboardRef = useRef(false)
  // The checked-out branch's name, or null on a detached HEAD.
  const currentName = branch?.detached === true || typeof branch?.name !== 'string' ? null : branch.name
  const branchRanges = ranges.map(range => (
    range.value === 'HEAD'
      ? { ...range, label: 'history.head', title: 'history.headTitle' }
      : range
  ))
  const currentRange = branchRanges.find(range => range.value === refMode)
  const baseLabel = t('top.switchBranchLabel', { branch: branchText })
  const buttonLabel = filtered && currentRange !== undefined
    ? `${baseLabel} · ${t(currentRange.label)}`
    : baseLabel
  const buttonTitle = filtered && currentRange !== undefined
    ? `${t(currentRange.title)}\n${t('top.switchBranchHint')}`
    : t('top.switchBranchHint')

  const close = useCallback((returnFocus, toNav = false) => {
    setOpen(false)
    setPosition(null)
    if (!returnFocus) return
    if (toNav || !openedByKeyboardRef.current) {
      onRestoreFocus()
      return
    }
    requestAnimationFrame(() => { triggerRef.current?.focus() })
  }, [onRestoreFocus])

  const { onKeyDown: onMenuKeyDown, onBlur: onWrapBlur } = useFloatingMenu({
    open,
    menuRef,
    triggerRef,
    itemSelector: '[role="menuitemradio"]',
    onClose: close,
  })

  const toggle = (event, keyboard = false) => {
    if (open) {
      close(true, !openedByKeyboardRef.current || (event !== undefined && event.detail > 0))
      return
    }
    openedByKeyboardRef.current = keyboard || (event !== undefined && event.detail === 0)
    setPosition(pickerPosition(triggerRef.current))
    setOpen(true)
    onOpen()
  }

  const openActions = (entry, point, returnElement) => {
    if (!canOps) return
    close(false)
    onOpenActions(entry, { clientX: point.clientX, clientY: point.clientY }, returnElement)
  }

  // Move focus into the menu once it has rows (or itself when it has none).
  useEffect(() => {
    if (!open || branchesStatus === 'loading') return undefined
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current
      if (menu === null) return
      if (typeof document !== 'undefined' && menu.contains(document.activeElement) && document.activeElement !== menu) {
        return
      }
      const current = menu.querySelector('[data-branch-current="true"]')
      const first = menu.querySelector('[data-branch-item]')
      const activeRange = menu.querySelector('.vcs-range-option[aria-checked="true"]')
      const target = current ?? first ?? activeRange ?? menu
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [branchesStatus, open])

  return (
    <div className="vcs-picker-wrap" onBlur={onWrapBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="vcs-picker-button vcs-branch-button"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : undefined}
        aria-label={buttonLabel}
        title={buttonTitle}
        data-filtered={filtered ? '' : undefined}
        aria-busy={switching || busy ? 'true' : undefined}
        onClick={event => { toggle(event, false) }}
        onContextMenu={event => {
          if (!canOps || currentName === null) return
          event.preventDefault()
          openActions({ name: currentName, current: true }, event, null)
        }}
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            if (currentName !== null) {
              const rect = triggerRef.current?.getBoundingClientRect()
              if (rect !== undefined) {
                const bottom = rect.bottom ?? (rect.top + rect.height)
                openActions(
                  { name: currentName, current: true },
                  { clientX: rect.left + 12, clientY: bottom },
                  triggerRef.current,
                )
              }
            }
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          if (!open) toggle(undefined, true)
        }}
      >
        <Turning turning={switching || busy}><BranchIcon /></Turning>
        <span className="vcs-branch-name">{branchText}</span>
        {syncable ? null : <AheadBehind ahead={branch?.ahead ?? 0} behind={branch?.behind ?? 0} />}
        {filtered ? <FilterIcon /> : null}
        <Chevron open={open} />
      </button>
      {open && position !== null ? (
        <div
          ref={menuRef}
          className="vcs-picker-menu vcs-branch-menu"
          role="menu"
          aria-label={t('top.switchBranch')}
          tabIndex={-1}
          style={position}
          onKeyDown={onMenuKeyDown}
        >
          {branchRanges.length > 0 ? (
            <RangeHeader options={branchRanges} refMode={refMode} onRefMode={onRefMode} t={t} />
          ) : (
            <p className="vcs-picker-menu-title">{t('top.switchBranch')}</p>
          )}
          <div className="vcs-picker-choices">
            {branchesStatus === 'loading' ? (
              <p className="vcs-picker-menu-note">{t('switch.loading')}</p>
            ) : null}
            {branchesStatus === 'error' ? (
              <p className="vcs-picker-menu-note" role="alert">{errorMessage(t, branchesError)}</p>
            ) : null}
            {branchesStatus === 'ready' && branches.length === 0 ? (
              <p className="vcs-picker-menu-note">{t('switch.empty')}</p>
            ) : null}
            {branches.map(entry => (
              <button
                key={entry.name}
                type="button"
                role="menuitemradio"
                aria-checked={entry.current ? 'true' : 'false'}
                className="vcs-menu-item"
                data-branch-item=""
                data-branch-current={entry.current ? 'true' : undefined}
                title={entry.name}
                onClick={event => {
                  const switched = !entry.current
                  if (switched) onSwitch(entry.name)
                  close(true, switched || !openedByKeyboardRef.current || (event !== undefined && event.detail > 0))
                }}
                onContextMenu={event => {
                  if (!canOps) return
                  event.preventDefault()
                  event.stopPropagation()
                  openActions(entry, event, null)
                }}
                onKeyDown={event => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault()
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const bottom = rect.bottom ?? (rect.top + rect.height)
                  openActions(
                    entry,
                    { clientX: rect.left + 12, clientY: bottom },
                    openedByKeyboardRef.current ? triggerRef.current : null,
                  )
                }}
              >
                <span className="vcs-menu-item-name">{entry.name}</span>
                {entry.current ? <CheckIcon /> : null}
              </button>
            ))}
          </div>
          {branchesTruncated ? (
            <p className="vcs-picker-menu-note">
              {formatPlural(t, 'switch.truncated', branches.length, locale)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** An anchored menu for choices already loaded. Its rows decide when to close. */
function HeaderPicker({
  kind, label, summary, buttonLabel, title, disabled = false,
  dismissOnScroll, showTitle = true, indicator = null, filtered = false, itemSelector = '[aria-checked]', children,
}) {
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const open = position !== null && !disabled
  const close = useCallback(restore => {
    if (restore) triggerRef.current?.focus({ preventScroll: true })
    setPosition(null)
  }, [])
  const { onKeyDown, onBlur } = useFloatingMenu({
    open,
    triggerRef,
    menuRef,
    itemSelector,
    onClose: close,
    dismissOnScroll,
  })
  const showMenu = () => { if (!disabled) setPosition(pickerPosition(triggerRef.current)) }
  useEffect(() => {
    if (disabled) close(false)
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current
      const target = menu?.querySelector('[aria-checked="true"]') ?? menu?.querySelector(itemSelector) ?? menu
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [close, disabled, itemSelector, open])

  return (
    <div className="vcs-picker-wrap" onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={`vcs-picker-button vcs-${kind}-button`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        title={title}
        data-filtered={filtered ? '' : undefined}
        disabled={disabled}
        onClick={() => { if (open) close(true); else showMenu() }}
        onKeyDown={event => {
          if (disabled || open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          showMenu()
        }}
      >
        <span className="vcs-picker-label">{summary}</span>
        {indicator}
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`vcs-picker-menu vcs-${kind}-menu`}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          style={position}
          onKeyDown={event => {
            // Backward Tab lands on the trigger, inside the same blur boundary.
            if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault()
              close(true)
              return
            }
            onKeyDown(event)
          }}
        >
          {showTitle ? <p className="vcs-picker-menu-title">{label}</p> : null}
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

/** One item in a single-selection menu group. */
function PickerRadioItem({ checked, title, onClick, className, children }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      className={className ? `vcs-menu-item ${className}` : 'vcs-menu-item'}
      tabIndex={-1}
      aria-checked={checked}
      title={title}
      onClick={onClick}
    >
      <span className="vcs-menu-item-name">{children}</span>
      {checked ? <CheckIcon /> : null}
    </button>
  )
}

/** The repository choice is exclusive; activating a row closes the menu. */
function RepositoryPicker({ repositories, current, onRepoChange, onManageRepositories, t }) {
  const summary = current?.name ?? t('top.noRepository')
  return (
    <HeaderPicker
      kind="repo"
      label={t('top.repositories')}
      summary={summary}
      buttonLabel={current === undefined ? undefined : t('top.repositoryLabel', { name: summary })}
      title={current?.path}
      disabled={repositories.length === 0 && onManageRepositories === undefined}
      itemSelector=".vcs-menu-item"
    >
      {close => (
        <>
          <div className="vcs-picker-choices" role="group">
            {repositories.map(entry => {
              const selected = entry === current
              return (
                <PickerRadioItem
                  key={entry.path}
                  className="vcs-repo-item"
                  checked={selected}
                  title={entry.path}
                  onClick={event => {
                    const fromPointer = event.detail > 0
                    if (!selected) onRepoChange(entry.path, fromPointer)
                    close(selected || !fromPointer)
                  }}
                >
                  {entry.name}
                  {entry.enclosing ? null : <small>{entry.path}</small>}
                </PickerRadioItem>
              )
            })}
          </div>
          {onManageRepositories === undefined ? null : (
            <button
              type="button"
              className="vcs-menu-item"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false)
                onManageRepositories(() => close(true))
              }}
            >
              <span className="vcs-menu-item-name">{t('repositoryConfig.manage')}</span>
            </button>
          )}
        </>
      )}
    </HeaderPicker>
  )
}

/** The choices affect what is displayed; keep the menu open for successive changes. */
function WorktreePicker({
  worktrees, checkedPaths, sessionPath, commitBased, onToggle, ranges, refMode, filtered = false, onRefMode, t, locale,
}) {
  const currentRange = ranges.find(range => range.value === refMode)
  const summary = t('top.worktreeSelection', { count: formatCount(checkedPaths.length, locale) })
  function renderOptions() {
    return (
      <>
        {ranges.length > 0 ? (
          <RangeHeader options={ranges} refMode={refMode} onRefMode={onRefMode} t={t} />
        ) : null}
        <div className="vcs-picker-choices">
          {worktrees.map(tree => {
            const { path, name } = tree
            const refLabel = worktreeRefLabel(tree, t, commitBased)
            const checked = checkedPaths.includes(path)
            const last = checked && checkedPaths.length === 1
            return (
              <button
                key={path}
                type="button"
                role="menuitemcheckbox"
                className="vcs-menu-item vcs-worktree-item"
                tabIndex={-1}
                aria-checked={checked}
                aria-disabled={last ? 'true' : undefined}
                title={path}
                onClick={() => { if (!last) onToggle(path) }}
              >
                <span className="vcs-worktree-check" aria-hidden="true">{checked ? <CheckIcon /> : null}</span>
                <span className="vcs-menu-item-name">
                  {name}
                  {refLabel === null || refLabel === name ? null : <small>{refLabel}</small>}
                </span>
                {path === sessionPath ? <span className="vcs-worktree-current">{t('top.sessionWorktree')}</span> : null}
              </button>
            )
          })}
        </div>
        {worktrees.length > 1 ? <p className="vcs-picker-menu-note">{t('top.keepWorktree')}</p> : null}
      </>
    )
  }

  return (
    <HeaderPicker
      kind="worktree"
      label={t('top.worktrees')}
      summary={summary}
      buttonLabel={filtered && currentRange !== undefined ? `${summary} · ${t(currentRange.label)}` : undefined}
      title={currentRange === undefined ? undefined : t(currentRange.title)}
      dismissOnScroll={false}
      showTitle={ranges.length === 0}
      filtered={filtered}
      indicator={filtered ? <FilterIcon /> : null}
    >
      {renderOptions}
    </HeaderPicker>
  )
}

/**
 * The sync control: icon plus the counts it would settle.
 *
 * It stays focusable while unavailable or running (`aria-disabled` rather
 * than `disabled`), so keyboard focus is not dropped mid-sync and the reason
 * it is unavailable remains readable.
 * @param {{ branch: object, syncing: boolean, onSync: Function, t: Function, locale?: string }} props - branch facts and sync state.
 */
function SyncButton({ branch, syncing, onSync, t, locale }) {
  const upstream = branch.upstream
  const ahead = branch.ahead ?? 0
  const behind = branch.behind ?? 0
  const available = upstream !== null && upstream !== undefined
  const label = available
    ? t('top.syncLabel', { upstream, ahead: formatCount(ahead, locale), behind: formatCount(behind, locale) })
    : t('top.syncNoUpstream')
  const inert = syncing || !available
  return (
    <button
      type="button"
      className="vcs-sync"
      aria-label={label}
      aria-disabled={inert ? 'true' : undefined}
      aria-busy={syncing ? 'true' : undefined}
      title={syncing ? t('top.syncing') : available ? `${label}\n${t('top.syncHint')}` : label}
      onClick={() => { if (!inert) onSync() }}
    >
      {/* The icon itself turns while the sync runs; the bar under the header announces it. */}
      <Turning turning={syncing} restEvery={180}><SyncIcon /></Turning>
      <AheadBehind ahead={ahead} behind={behind} />
    </button>
  )
}

/**
 * Render the header bar. `refreshing` is a refresh the refresh button
 * started; `syncing` covers a sync and the refresh it starts afterwards, so
 * one icon turns from the click until the counts it settles are back;
 * `switching` is a branch switch, `branchBusy` one of the other branch
 * actions in flight, `tagBusy` one of the tag actions, and `commitBusy` one
 * of the commit actions. `twoColumns` is the user's layout preference and
 * `twoColumnsFit` whether the panel is wide enough to honor it; the toggle
 * keeps showing the preference and its tooltip says when the width overrides it.
 * @param {{ repositories: object[], repo: string | null, onRepoChange: Function, status: object | null, capabilities: object | null, refMode: string, onRefMode: (ref: string) => void, onRefresh: Function, refreshing: boolean, revalidating?: boolean, onSync: Function, syncing: boolean, branches?: object[], branchesStatus?: string, branchesError?: object | null, branchesTruncated?: boolean, onLoadBranches?: Function, onSwitchBranch?: Function, onBranchActions?: Function, switching?: boolean, branchBusy?: string | null, tagBusy?: string | null, commitBusy?: string | null, notice?: { tone: 'error' | 'info', text: string } | null, twoColumns?: boolean, twoColumnsFit?: boolean, onTwoColumns?: (next: boolean) => void, t: Function, locale?: string }} props - panel header state.
 */
export function TopBar({
  repositories, repo, onRepoChange, onManageRepositories, status, capabilities, refMode, onRefMode, onRefresh, refreshing,
  worktrees = [], checkedPaths = [], onToggleWorktree, sessionPath,
  revalidating = false, onSync, syncing, staging = false, branches = [], branchesStatus = 'idle', branchesError = null,
  branchesTruncated = false, onLoadBranches = () => {}, onSwitchBranch = () => {}, onBranchActions = () => {},
  onRestoreFocus = () => {}, switching = false, branchBusy = null, tagBusy = null, commitBusy = null, notice,
  twoColumns = true, twoColumnsFit = true, onTwoColumns = () => {}, t, locale,
}) {
  // Work on data already on screen shows as one thin bar under the header,
  // whether the user asked for it (refresh, sync, switch, a branch, tag, or
  // commit action) or the panel did (a refresh on becoming visible); the
  // content stays put.
  const busy = refreshing || syncing || switching || branchBusy !== null || tagBusy !== null
    || commitBusy !== null || staging || revalidating
  const columnsAction = t(twoColumnsFit
    ? (twoColumns ? 'top.twoColumnsOff' : 'top.twoColumnsOn')
    : (twoColumns ? 'top.twoColumnsNarrowOff' : 'top.twoColumnsNarrowOn'))
  const constrainedColumnsTitle = twoColumnsFit ? undefined : `${columnsAction} ${t('top.twoColumnsNarrow')}`
  const branch = status?.branch
  const workingCopy = status?.workingCopy
  const showsWorkingCopy = capabilities?.workingCopy === 'commit'
  const currentRepository = repositories.find(entry => entry.path === repo)
  const activeWorkspace = showsWorkingCopy ? worktrees.find(tree => tree.path === checkedPaths[0]) : undefined
  let branchText = ''
  if (branch !== undefined && branch !== null) {
    if (branch.unborn) branchText = t('top.unborn')
    else if (branch.detached) branchText = t('top.detached')
    else branchText = branch.name ?? t('top.detached')
  }
  // Sync needs a named branch with commits; the button then owns the counts.
  const syncable = capabilities?.sync === true
    && branch !== undefined && branch !== null
    && !branch.unborn && !branch.detached && typeof branch.name === 'string'
  // Switching needs a repository with commits; a detached HEAD is the most
  // useful case, so it stays switchable even though it has no branch name.
  const branchSwitchable = capabilities?.branchSwitch === true
    && branch !== undefined && branch !== null
    && branch.unborn !== true
  const ranges = capabilities?.ranges ?? []
  const currentRange = ranges.find(range => range.value === refMode)
  const baselineRange = capabilities?.defaultRange ?? ranges[0]?.value
  const rangeFiltered = ranges.length > 1 && currentRange !== undefined && currentRange.value !== baselineRange
  // Show the header funnel icon on the control closest to the active scope:
  // on the branch trigger when single-worktree Git is filtering to HEAD,
  // and on the worktree trigger for multi-worktree, sibling preview, or Jujutsu.
  const branchOwnsFilterIndicator = !showsWorkingCopy && branchText !== '' && branchSwitchable
  const capacity = capabilities
  const branchOps = capacity?.branchOps === true
  let readonlyLabel = t('top.readonly')
  let readonlyHint = t('top.readonlyHint')
  if (capacity?.sync === true) {
    if (branchOps) {
      if (capacity.commitOps === true && capacity.tagOps === true) {
        readonlyLabel = t('top.readonlySyncRefs')
        readonlyHint = t('top.readonlyHintSyncRefs')
      } else if (capacity.tagOps === true) {
        readonlyLabel = t('top.readonlySyncBranchTag')
        readonlyHint = t('top.readonlyHintSyncBranchTag')
      } else {
        readonlyLabel = t('top.readonlySyncBranch')
        readonlyHint = t('top.readonlyHintSyncBranch')
      }
    } else if (capacity.branchSwitch === true) {
      readonlyLabel = t('top.readonlySyncSwitch')
      readonlyHint = t('top.readonlyHintSyncSwitch')
    } else {
      readonlyLabel = t('top.readonlySync')
      readonlyHint = t('top.readonlyHintSync')
    }
  } else if (capacity?.snapshots === true) {
    readonlyHint = t('top.readonlyHintSnapshots')
  } else if (checkedPaths.length > 1) {
    readonlyHint = t('top.readonlyHintWorktrees')
  }
  if (capacity?.stageOps === true) {
    readonlyLabel = t('stage.writeLabel')
    readonlyHint = `${readonlyHint} ${t('stage.indexHint')}`
  }
  return (
    <div className="vcs-topbar">
      <RepositoryPicker
        repositories={repositories}
        current={currentRepository}
        onRepoChange={onRepoChange}
        onManageRepositories={onManageRepositories}
        t={t}
      />
      {worktrees.length > 0 ? (
        <WorktreePicker
          key={repo}
          worktrees={worktrees}
          checkedPaths={checkedPaths}
          sessionPath={sessionPath}
          commitBased={showsWorkingCopy}
          onToggle={onToggleWorktree}
          ranges={ranges}
          refMode={refMode}
          filtered={rangeFiltered && !branchOwnsFilterIndicator}
          onRefMode={onRefMode}
          t={t}
          locale={locale}
        />
      ) : null}
      {showsWorkingCopy ? (
        workingCopy === null || workingCopy === undefined ? null : (
          <span className="vcs-working-copy" title={t('top.workingCopyTitle')}>
            <WorkingCopyBadge labels={[activeWorkspace === undefined ? '@' : workingCopyLabel(activeWorkspace, worktrees.length > 1)]}
              title={t('top.workingCopyTitle')} />
            {typeof workingCopy.changeId === 'string' && workingCopy.changeId !== ''
              ? <code className="vcs-working-change">{shortChangeId(workingCopy.changeId)}</code>
              : null}
            {workingCopy.refs.slice(0, HEADER_REFS).map(reference => (
              <RefBadge key={`${reference.kind}:${reference.name}`} reference={reference} />
            ))}
            {workingCopy.conflict === true ? <span className="vcs-conflict-badge">{t('status.conflict')}</span> : null}
          </span>
        )
      ) : branchText === '' ? null : branchSwitchable ? (
        <BranchSwitcher
          branch={branch}
          branchText={branchText}
          branches={branches}
          branchesStatus={branchesStatus}
          branchesError={branchesError}
          branchesTruncated={branchesTruncated}
          ranges={ranges}
          refMode={refMode}
          filtered={rangeFiltered}
          onRefMode={onRefMode}
          onOpen={onLoadBranches}
          onSwitch={onSwitchBranch}
          onOpenActions={onBranchActions}
          onRestoreFocus={onRestoreFocus}
          switching={switching}
          busy={branchBusy !== null}
          canOps={branchOps}
          syncable={syncable}
          t={t}
          locale={locale}
        />
      ) : (
        <span className="vcs-branch" title={branch?.upstream ?? undefined}>
          <BranchIcon />
          <span className="vcs-branch-name">{branchText}</span>
          {syncable ? null : <AheadBehind ahead={branch?.ahead ?? 0} behind={branch?.behind ?? 0} />}
        </span>
      )}
      {syncable ? <SyncButton branch={branch} syncing={syncing} onSync={onSync} t={t} locale={locale} /> : null}
      <span className="vcs-sr-only" role="status">{notice?.tone === 'info' ? notice.text : ''}</span>
      {notice === null || notice === undefined ? null : (
        <p
          className={notice.tone === 'info' ? 'vcs-notice vcs-notice-info' : 'vcs-notice'}
          aria-hidden={notice.tone === 'info' ? true : undefined}
          role={notice.tone === 'error' ? 'alert' : undefined}
          title={notice.text}
        >
          {notice.text}
        </p>
      )}
      <span className="vcs-topbar-spacer" />
      <IconButton
        label={t('top.twoColumns')}
        pressed={twoColumns}
        title={constrainedColumnsTitle ?? columnsAction}
        description={constrainedColumnsTitle}
        onClick={() => { onTwoColumns(!twoColumns) }}
        className="vcs-columns-toggle"
      >
        <TimelineBesideIcon beside={twoColumns && twoColumnsFit} />
      </IconButton>
      <span
        className="vcs-readonly"
        role="img"
        aria-label={readonlyLabel}
        title={readonlyHint}
      >
        <LockIcon />
      </span>
      <IconButton label={t('top.refresh')} title={refreshing ? t('top.refreshing') : undefined} onClick={() => { onRefresh() }} busy={refreshing}>
        <Turning turning={refreshing}><RefreshIcon /></Turning>
      </IconButton>
      <ProgressLine
        busy={busy}
        label={syncing
          ? t('top.syncing')
          : switching
            ? t('top.switching')
            : branchBusy !== null && BRANCH_BUSY_KEYS[branchBusy] !== undefined
              ? t(BRANCH_BUSY_KEYS[branchBusy])
              : tagBusy !== null && TAG_BUSY_KEYS[tagBusy] !== undefined
                ? t(TAG_BUSY_KEYS[tagBusy])
                : commitBusy !== null && COMMIT_BUSY_KEYS[commitBusy] !== undefined
                  ? t(COMMIT_BUSY_KEYS[commitBusy])
                  : staging ? t('stage.updatingIndex') : t('top.refreshing')}
      />
    </div>
  )
}

/** Milliseconds the progress line takes to fade out; matches `.vcs-progress` in `styles.css`. */
const PROGRESS_FADE = 240

/**
 * The thin sweep along the header's bottom edge. It stays mounted, so it
 * fades out from wherever its fade-in had got to instead of vanishing
 * mid-sweep; the sweep itself only runs while busy and during the fade.
 * @param {{ busy: boolean, label: string }} props - whether work is running and what to announce.
 */
function ProgressLine({ busy, label }) {
  // Set once work starts; cleared when the fade-out after it has finished.
  const [sweeping, setSweeping] = useState(busy)
  useEffect(() => {
    if (busy) {
      setSweeping(true)
      return undefined
    }
    const timer = setTimeout(() => { setSweeping(false) }, PROGRESS_FADE)
    return () => { clearTimeout(timer) }
  }, [busy])
  return (
    <span
      className="vcs-progress"
      role="status"
      data-busy={busy ? 'true' : undefined}
      data-sweeping={busy || sweeping ? 'true' : undefined}
    >
      {busy ? <span className="vcs-sr-only">{label}</span> : null}
    </span>
  )
}
