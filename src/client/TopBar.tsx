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
import type { ComponentPropsWithoutRef, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type {
  BranchesAnswer, HistoryRange, RepositoryCapabilities, RepositoryInfo, StatusBranch, StatusData, WorktreeInfo,
} from './api.js'
import type { ApiFailure } from './api.js'
import type { MenuPoint, Notice, RefEntry } from './useRepoActions.js'
import {
  Arrow, BranchIcon, CheckIcon, Chevron, FilterIcon, IconButton, LockIcon, RefreshIcon, RefBadge, SyncIcon,
  TimelineBesideIcon, Turning, WorkingCopyBadge,
} from './ui.jsx'
import { errorMessage, formatCount, formatPlural, sessionRelativePath, shortChangeId } from './format.js'
import { BRANCH_BUSY_KEYS } from './branch.js'
import { TAG_BUSY_KEYS } from './tag.js'
import { COMMIT_BUSY_KEYS } from './commit.js'
import { useFloatingMenu } from './useFloatingMenu.js'
import { workingCopyLabel, worktreeRefLabel } from './worktrees.js'
import type { RepositoryScope } from './state.js'

/** Ref badges shown in the header before the rest are left to the timeline. */
const HEADER_REFS = 3

/** Width of a header picker menu in CSS pixels, and its viewport inset. */
const MENU_WIDTH = 260
const MENU_MARGIN = 8
const MENU_GAP = 6

/** A fixed position lets the menu hang below the clipped header. */
interface MenuPosition {
  left: number
  top: number
}

/** Where one discovered repository was found. */
export interface RepositorySource {
  kind: 'default' | 'repository' | 'directory'
  path?: string
}

/**
 * One discovered repository as the header lists it.
 *
 * The Host's discovery answer also carries `enclosing`, `availableVcs`, and
 * `sources`; `api.ts`'s `RepositoryInfo` does not declare them, so the header
 * and the repository-configuration dialog state them here.
 */
export interface RepositoryRow extends RepositoryInfo {
  enclosing?: boolean
  availableVcs?: string[]
  sources?: RepositorySource[]
}

/** One local branch as the header menu lists it. */
type BranchChoice = BranchesAnswer['branches'][number]

/** Open the shared ref-actions menu for one branch. */
type BranchActionHandler = (entry: RefEntry, point: MenuPoint, returnElement?: HTMLElement | null) => void

/**
 * Place one picker menu under its trigger, inside the viewport.
 * @param trigger - the trigger element, when mounted.
 * @returns the fixed position, or null without a trigger.
 */
function pickerPosition(trigger: HTMLElement | null | undefined): MenuPosition | null {
  const rect = trigger?.getBoundingClientRect()
  if (rect === undefined) return null
  const viewport = typeof window === 'undefined' ? rect.left + MENU_WIDTH + MENU_MARGIN : window.innerWidth
  return {
    left: Math.max(MENU_MARGIN, Math.min(rect.left, viewport - MENU_WIDTH - MENU_MARGIN)),
    top: rect.bottom + MENU_GAP,
  }
}

/** Ahead/behind counts as two small arrows; zero sides are left out. */
function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <>
      {ahead > 0 ? <span className="vcs-ahead"><Arrow up />{ahead}</span> : null}
      {behind > 0 ? <span className="vcs-behind"><Arrow />{behind}</span> : null}
    </>
  )
}

interface RangeHeaderProps<Value extends string> {
  options: readonly (Omit<HistoryRange, 'value'> & { value: Value })[]
  refMode: Value
  onRefMode: (value: Value) => void
  label?: string
  groupLabel?: string
  action?: ReactNode
  t: Translate
}

/** Compact segmented switch shared by the header pickers. */
function RangeHeader<Value extends string>({
  options, refMode, onRefMode, label = 'history.commitsLabel', groupLabel = 'history.refLabel', action, t,
}: RangeHeaderProps<Value>) {
  const moveSegment = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const radios = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
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
        {t(label)}
      </span>
      <div className="vcs-picker-range" role="group" aria-label={t(groupLabel)}>
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
      {action}
    </div>
  )
}

/** Branch facts and menu state of the header's branch control. */
interface BranchSwitcherProps {
  branch: StatusBranch | null | undefined
  branchText: string
  branches: readonly BranchChoice[]
  branchesStatus: string
  branchesError: ApiFailure | null | undefined
  branchesTruncated: boolean
  ranges?: readonly HistoryRange[]
  refMode: string
  filtered?: boolean
  onRefMode?: (ref: string) => void
  onOpen: () => void
  onSwitch: (branch: string) => void
  onOpenActions: BranchActionHandler
  onRestoreFocus?: () => void
  switching: boolean
  busy: boolean
  canOps: boolean
  syncable: boolean
  t: Translate
  locale?: string
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
 * @param props - branch facts and menu state.
 */
function BranchSwitcher({
  branch, branchText, branches, branchesStatus, branchesError, branchesTruncated,
  ranges = [], refMode, filtered = false, onRefMode = () => {},
  onOpen, onSwitch, onOpenActions, onRestoreFocus = () => {}, switching, busy, canOps, syncable, t, locale,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
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

  const close = useCallback((returnFocus: boolean, toNav = false) => {
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

  const toggle = (event: MouseEvent<HTMLButtonElement> | undefined, keyboard = false) => {
    if (open) {
      close(true, !openedByKeyboardRef.current || (event !== undefined && event.detail > 0))
      return
    }
    openedByKeyboardRef.current = keyboard || (event !== undefined && event.detail === 0)
    setPosition(pickerPosition(triggerRef.current))
    setOpen(true)
    onOpen()
  }

  const openActions = (entry: RefEntry, point: MenuPoint, returnElement: HTMLElement | null) => {
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
      const current = menu.querySelector<HTMLElement>('[data-branch-current="true"]')
      const first = menu.querySelector<HTMLElement>('[data-branch-item]')
      const activeRange = menu.querySelector<HTMLElement>('.vcs-range-option[aria-checked="true"]')
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
          openActions({ kind: 'branch', name: currentName, current: true }, event, null)
        }}
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            if (currentName !== null) {
              const rect = triggerRef.current?.getBoundingClientRect()
              if (rect !== undefined) {
                const bottom = rect.bottom ?? (rect.top + rect.height)
                openActions(
                  { kind: 'branch', name: currentName, current: true },
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
              <PickerItem
                key={entry.name}
                checked={entry.current}
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
                  openActions({ ...entry, kind: 'branch' }, event, null)
                }}
                onKeyDown={event => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault()
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const bottom = rect.bottom ?? (rect.top + rect.height)
                  openActions(
                    { ...entry, kind: 'branch' },
                    { clientX: rect.left + 12, clientY: bottom },
                    openedByKeyboardRef.current ? triggerRef.current : null,
                  )
                }}
              >
                {entry.name}
              </PickerItem>
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

/** Trigger copy, state, and rows of one anchored header menu. */
interface HeaderPickerProps {
  kind: string
  label: string
  summary: ReactNode
  buttonLabel?: string
  title?: string
  disabled?: boolean
  dismissOnScroll?: boolean
  showTitle?: boolean
  indicator?: ReactNode
  filtered?: boolean
  itemSelector?: string
  initialFocusSelector?: string
  onMenuKeyDown?: (event: KeyboardEvent<HTMLDivElement>, close: (restore: boolean) => void) => void
  children: (close: (restore: boolean) => void) => ReactNode
}

/** An anchored menu for choices already loaded. Its rows decide when to close. */
function HeaderPicker({
  kind, label, summary, buttonLabel, title, disabled = false,
  dismissOnScroll, showTitle = true, indicator = null, filtered = false,
  itemSelector = '[aria-checked]', initialFocusSelector = '[aria-checked="true"]', onMenuKeyDown, children,
}: HeaderPickerProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const open = position !== null && !disabled
  const close = useCallback((restore: boolean) => {
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
      if (menu?.contains(document.activeElement)) return
      const target = menu?.querySelector<HTMLElement>(initialFocusSelector)
        ?? menu?.querySelector<HTMLElement>(itemSelector)
        ?? menu
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [close, disabled, initialFocusSelector, itemSelector, open])

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
            onMenuKeyDown?.(event, close)
            if (!event.defaultPrevented) onKeyDown(event)
          }}
        >
          {showTitle ? <p className="vcs-picker-menu-title">{label}</p> : null}
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

interface PickerItemProps extends ComponentPropsWithoutRef<'button'> {
  checked: boolean
  detail?: string | null
  badge?: string
}

/** Compact selectable row shared by the branch, repository, and worktree menus. */
function PickerItem({ checked, detail, badge, className, children, role = 'menuitemradio', ...buttonProps }: PickerItemProps) {
  return (
    <button
      {...buttonProps}
      type="button"
      role={role}
      className={className ? `vcs-menu-item ${className}` : 'vcs-menu-item'}
      tabIndex={-1}
      aria-checked={checked}
    >
      <span className="vcs-menu-item-name">{children}</span>
      {detail ? <span className="vcs-picker-item-detail">{detail}</span> : null}
      {badge ? <span className="vcs-picker-item-badge">{badge}</span> : null}
      {checked ? <CheckIcon /> : null}
    </button>
  )
}

/** State and callbacks of the repository picker. */
interface RepositoryPickerProps {
  repositories: readonly RepositoryRow[]
  cwd: string | null | undefined
  current: RepositoryRow | undefined
  scope: RepositoryScope
  checked: readonly string[]
  onScopeChange: (scope: RepositoryScope) => void
  onToggle: (path: string) => void
  onManageRepositories?: (restoreFocus: () => void) => void
  t: Translate
}

const REPOSITORY_RANGES = [
  { value: 'all', label: 'repositories.all', title: 'repositories.allTitle' },
  { value: 'selected', label: 'repositories.selected', title: 'repositories.selectedTitle' },
] as const

function RepositoryPicker({
  repositories, cwd, current, scope, checked, onScopeChange, onToggle, onManageRepositories, t,
}: RepositoryPickerProps) {
  const summary = current?.name ?? t('top.noRepository')
  const showScope = repositories.length > 1
  const filtered = showScope && scope === 'selected'
  const currentLabel = current === undefined ? t('top.noRepository') : t('top.repositoryLabel', { name: summary })
  return (
    <HeaderPicker
      kind="repo"
      label={t('top.repositories')}
      summary={summary}
      buttonLabel={filtered ? `${currentLabel} · ${t('repositories.selected')}` : currentLabel}
      title={filtered ? `${current?.path ?? summary}\n${t('repositories.selectedTitle')}` : current?.path}
      disabled={repositories.length === 0 && onManageRepositories === undefined}
      dismissOnScroll={false}
      showTitle={!showScope}
      filtered={filtered}
      indicator={filtered ? <FilterIcon /> : null}
      itemSelector=".vcs-menu-item, .vcs-range-option"
      initialFocusSelector='.vcs-repo-item[aria-checked="true"]'
    >
      {close => (
        <>
          {showScope ? (
            <RangeHeader
              options={REPOSITORY_RANGES}
              refMode={scope}
              onRefMode={onScopeChange}
              label="top.repositories"
              groupLabel="repositories.scope"
              t={t}
            />
          ) : null}
          <div className="vcs-picker-choices" role="group">
            {repositories.map(entry => {
              const included = !showScope || checked.includes(entry.path)
              const last = included && (!showScope || checked.length === 1)
              const pathLabel = sessionRelativePath(cwd, entry.path)
              const detail = pathLabel === entry.name ? null : pathLabel
              const keepOne = last ? t('repositories.keepOne') : undefined
              return (
                <PickerItem
                  key={entry.path}
                  className="vcs-repo-item"
                  role="menuitemcheckbox"
                  checked={included}
                  detail={detail}
                  aria-disabled={last || undefined}
                  aria-description={keepOne}
                  aria-label={showScope ? t('repositories.include', { name: detail ? `${entry.name} · ${detail}` : entry.name }) : undefined}
                  title={keepOne ? `${entry.path}\n${keepOne}` : entry.path}
                  onClick={() => { if (!last) onToggle(entry.path) }}
                >
                  {entry.name}
                </PickerItem>
              )
            })}
          </div>
          {showScope && (!filtered || checked.length === 1) ? (
            <p className="vcs-picker-menu-note">{t(filtered ? 'repositories.keepOne' : 'repositories.selectionHint')}</p>
          ) : null}
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

/** State and callbacks of the worktree picker. */
interface WorktreePickerProps {
  worktrees: readonly WorktreeInfo[]
  checkedPaths: readonly string[]
  sessionPath: string | null | undefined
  commitBased: boolean
  onToggle: (path: string) => void
  canCreate: boolean
  busy: boolean
  onCreate: (restore: () => void) => void
  onActions: (tree: WorktreeInfo, sessionPath: string | null | undefined, point: MenuPoint, restore: () => void) => void
  ranges: readonly HistoryRange[]
  refMode: string
  filtered?: boolean
  onRefMode: (ref: string) => void
  t: Translate
  locale?: string
}

/** The choices affect what is displayed; keep the menu open for successive changes. */
function WorktreePicker({
  worktrees, checkedPaths, sessionPath, commitBased, onToggle, canCreate, busy, onCreate, onActions,
  ranges, refMode, filtered = false, onRefMode, t, locale,
}: WorktreePickerProps) {
  const currentRange = ranges.find(range => range.value === refMode)
  const label = t(commitBased ? 'worktree.workspaces' : 'top.worktrees')
  const summary = t(commitBased ? 'worktree.workspaceSelection' : 'top.worktreeSelection', {
    count: formatCount(checkedPaths.length, locale),
  })
  const createLabel = t(commitBased ? 'worktree.createWorkspace' : 'worktree.createWorktree')
  const keepOne = t(commitBased ? 'worktree.keepWorkspace' : 'top.keepWorktree')
  const disabledCreate = busy ? t('error.busy') : !canCreate ? t('error.worktreeUnsupported') : undefined
  const createRef = useRef<HTMLButtonElement | null>(null)
  function startCreate(close: (restore: boolean) => void) {
    if (disabledCreate !== undefined) return
    close(false)
    onCreate(() => close(true))
  }
  function renderOptions(close: (restore: boolean) => void) {
    const restore = () => close(true)
    const create = (
      <button
        ref={createRef}
        type="button"
        role="menuitem"
        className="vcs-menu-item vcs-worktree-icon-action vcs-worktree-create"
        tabIndex={-1}
        aria-label={createLabel}
        aria-keyshortcuts="+"
        aria-disabled={disabledCreate !== undefined || undefined}
        aria-description={disabledCreate}
        title={disabledCreate === undefined ? createLabel : `${createLabel} · ${disabledCreate}`}
        onClick={() => { startCreate(close) }}
      >
        <span aria-hidden="true">+</span>
        <span className="vcs-worktree-create-label" aria-hidden="true">{t('worktree.new')}</span>
      </button>
    )
    return (
      <>
        {ranges.length > 0 ? (
          <RangeHeader options={ranges} refMode={refMode} onRefMode={onRefMode} action={create} t={t} />
        ) : (
          <div className="vcs-picker-header">
            <span className="vcs-picker-menu-title vcs-picker-range-label">{label}</span>
            {create}
          </div>
        )}
        <div className="vcs-picker-choices">
          {worktrees.map(tree => {
            const { path, name } = tree
            const refLabel = worktreeRefLabel(tree, t, commitBased)
            const checked = checkedPaths.includes(path)
            const last = checked && checkedPaths.length === 1
            const duplicate = worktrees.some(other => other.path !== path && other.name === name)
            const detail = duplicate ? path : refLabel === name ? null : refLabel
            const openActions = (anchor: HTMLElement) => {
              const rect = anchor.getBoundingClientRect()
              close(false)
              onActions(tree, sessionPath, { clientX: rect.left, clientY: rect.bottom }, restore)
            }
            const identifyingName = duplicate ? path : name
            const actionsLabel = t('worktree.actions', { name: identifyingName })
            return (
              <div key={path} className="vcs-worktree-choice" role="group" data-duplicate={duplicate || undefined}>
                <PickerItem
                  role="menuitemcheckbox"
                  checked={checked}
                  detail={detail}
                  aria-label={duplicate ? `${name} · ${path}` : undefined}
                  badge={path === sessionPath ? t('top.sessionWorktree') : undefined}
                  aria-disabled={last || undefined}
                  aria-description={last ? keepOne : undefined}
                  title={refLabel === null || refLabel === name ? path : `${path}\n${refLabel}`}
                  onClick={() => { if (!last) onToggle(path) }}
                  onContextMenu={event => {
                    event.preventDefault()
                    openActions(event.currentTarget)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault()
                      event.stopPropagation()
                      const action = event.key === 'ArrowLeft' ? createRef.current
                        : event.currentTarget.parentElement?.querySelector<HTMLElement>('.vcs-worktree-icon-action')
                      action?.focus()
                      return
                    }
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    event.stopPropagation()
                    openActions(event.currentTarget)
                  }}
                >
                  {name}
                </PickerItem>
                <button
                  type="button"
                  role="menuitem"
                  className="vcs-menu-item vcs-worktree-icon-action"
                  tabIndex={-1}
                  aria-haspopup="menu"
                  aria-label={actionsLabel}
                  aria-keyshortcuts="Shift+F10 ArrowRight"
                  onKeyDown={event => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                    event.currentTarget.parentElement?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus()
                    if (event.key === 'ArrowLeft') event.preventDefault()
                  }}
                  title={actionsLabel}
                  onClick={event => { openActions(event.currentTarget) }}
                >
                  <span aria-hidden="true">…</span>
                </button>
              </div>
            )
          })}
        </div>
        {worktrees.length > 1 ? (
          <p className="vcs-picker-menu-note">{keepOne}</p>
        ) : null}
      </>
    )
  }

  return (
    <HeaderPicker
      kind="worktree"
      label={label}
      summary={summary}
      buttonLabel={filtered && currentRange !== undefined ? `${summary} · ${t(currentRange.label)}` : undefined}
      title={currentRange === undefined ? undefined : t(currentRange.title)}
      dismissOnScroll={false}
      showTitle={false}
      onMenuKeyDown={(event, close) => {
        if (event.key !== '+') return
        event.preventDefault()
        event.stopPropagation()
        startCreate(close)
      }}
      filtered={filtered}
      indicator={filtered ? <FilterIcon /> : null}
    >
      {renderOptions}
    </HeaderPicker>
  )
}

/** Branch facts and sync state of the header's sync control. */
interface SyncButtonProps {
  branch: StatusBranch | null | undefined
  syncing: boolean
  onSync: () => void
  t: Translate
  locale?: string
}

/**
 * The sync control: icon plus the counts it would settle.
 *
 * It stays focusable while unavailable or running (`aria-disabled` rather
 * than `disabled`), so keyboard focus is not dropped mid-sync and the reason
 * it is unavailable remains readable.
 * @param props - branch facts and sync state.
 */
function SyncButton({ branch, syncing, onSync, t, locale }: SyncButtonProps) {
  const upstream = branch?.upstream ?? null
  const ahead = branch?.ahead ?? 0
  const behind = branch?.behind ?? 0
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
 * @param props - panel header state.
 */
export interface TopBarProps {
  repositories: readonly RepositoryRow[]
  cwd: string | null | undefined
  repo: string | null
  repositoryScope?: RepositoryScope
  checkedRepositories?: readonly string[]
  onRepositoryScope: (scope: RepositoryScope) => void
  onToggleRepository: (path: string) => void
  onManageRepositories?: (restoreFocus: () => void) => void
  status: StatusData | null
  capabilities: RepositoryCapabilities | null
  refMode: string
  onRefMode: (ref: string) => void
  onRefresh: () => void
  refreshing: boolean
  worktrees?: readonly WorktreeInfo[]
  checkedPaths?: readonly string[]
  onToggleWorktree: (path: string) => void
  onCreateWorktree: WorktreePickerProps['onCreate']
  onWorktreeActions: WorktreePickerProps['onActions']
  repoBusy: boolean
  worktreeBusy: boolean
  sessionPath?: string | null
  revalidating?: boolean
  onSync: () => void
  syncing: boolean
  staging?: boolean
  branches?: readonly BranchChoice[]
  branchesStatus?: string
  branchesError?: ApiFailure | null
  branchesTruncated?: boolean
  onLoadBranches?: () => void
  onSwitchBranch?: (branch: string) => void
  onBranchActions?: BranchActionHandler
  onRestoreFocus?: () => void
  switching?: boolean
  branchBusy?: string | null
  tagBusy?: string | null
  commitBusy?: string | null
  notice?: Notice | null
  twoColumns?: boolean
  twoColumnsFit?: boolean
  onTwoColumns?: (next: boolean) => void
  t: Translate
  locale?: string
}

/** Render the panel header. */
export function TopBar({
  repositories, cwd, repo, repositoryScope = 'all', checkedRepositories = [], onRepositoryScope, onToggleRepository,
  onManageRepositories, status, capabilities, refMode, onRefMode, onRefresh, refreshing,
  worktrees = [], checkedPaths = [], onToggleWorktree, onCreateWorktree, onWorktreeActions, repoBusy, worktreeBusy, sessionPath,
  revalidating = false, onSync, syncing, staging = false, branches = [], branchesStatus = 'idle', branchesError = null,
  branchesTruncated = false, onLoadBranches = () => {}, onSwitchBranch = () => {}, onBranchActions = () => {},
  onRestoreFocus = () => {}, switching = false, branchBusy = null, tagBusy = null, commitBusy = null, notice,
  twoColumns = true, twoColumnsFit = true, onTwoColumns = () => {}, t, locale,
}: TopBarProps) {
  // Work on data already on screen shows as one thin bar under the header,
  // whether the user asked for it (refresh, sync, switch, a branch, tag, or
  // commit action) or the panel did (a refresh on becoming visible); the
  // content stays put.
  const busy = refreshing || syncing || switching || branchBusy !== null || tagBusy !== null
    || commitBusy !== null || staging || revalidating || worktreeBusy
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
  if (capacity?.worktreeCreate === true || capacity?.worktreeRemove === true || capacity?.worktreeForget === true) {
    readonlyLabel = t('worktree.writes')
    readonlyHint = readonlyHint === t('top.readonlyHint')
      ? t('worktree.writesHint')
      : `${t('worktree.writesHint')} ${readonlyHint}`
  }
  return (
    <div className="vcs-topbar">
      <RepositoryPicker
        repositories={repositories}
        cwd={cwd}
        current={currentRepository}
        scope={repositoryScope}
        checked={checkedRepositories}
        onScopeChange={onRepositoryScope}
        onToggle={onToggleRepository}
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
          canCreate={capacity?.worktreeCreate === true}
          busy={repoBusy}
          onCreate={onCreateWorktree}
          onActions={onWorktreeActions}
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
      <IconButton
        label={t(capabilities?.snapshots === true ? 'top.refreshSnapshots' : 'top.refresh')}
        title={refreshing ? t('top.refreshing') : undefined}
        onClick={() => { onRefresh() }}
        busy={refreshing}
      >
        <Turning turning={refreshing}><RefreshIcon /></Turning>
      </IconButton>
      <ProgressLine
        busy={busy}
        label={worktreeBusy
          ? t('worktree.working')
          : syncing
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

/** Whether work is running and what to announce for it. */
interface ProgressLineProps {
  busy: boolean
  label: string
}

/**
 * The thin sweep along the header's bottom edge. It stays mounted, so it
 * fades out from wherever its fade-in had got to instead of vanishing
 * mid-sweep; the sweep itself only runs while busy and during the fade.
 * @param props - whether work is running and what to announce.
 */
function ProgressLine({ busy, label }: ProgressLineProps) {
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
