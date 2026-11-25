/** The tiled pointer's usual next steps (DESIGN.md, 操作条的直接按钮). */

import type { RepositoryCapabilities, WorktreeInfo } from '../api.js'
import { BRANCH_BUSY_KEYS, branchActions, remoteBranchActions } from '../branch.js'
import type { BranchMenuAction } from '../branch.js'
import { COMMIT_BUSY_KEYS } from '../commit.js'
import { TAG_BUSY_KEYS } from '../tag.js'
import type { RepoAction, RepoWrite } from '../useRepoActions.js'
import { worktreeActionReason } from '../worktrees.js'
import type { PointerView, RepositoryView } from './model.js'

export interface TileDirectAction {
  action: Exclude<RepoAction, { domain: 'tag' }>
  /** Locale key explaining why a visible action is unavailable. */
  disabledReason?: string
}

export interface CheckoutCatalog {
  readonly worktrees?: readonly WorktreeInfo[]
  /** Whether the repository entry is the session's checkout. */
  readonly enclosing?: boolean
}

/** The step currently holding one repository's client write lock. */
function writeReason(write: RepoWrite): string {
  switch (write.domain) {
    case 'sync': return 'top.syncing'
    case 'switch': return 'top.switching'
    case 'branch': return BRANCH_BUSY_KEYS[write.action] ?? 'branch.working'
    case 'tag': return TAG_BUSY_KEYS[write.action] ?? 'tag.working'
    case 'commit': return COMMIT_BUSY_KEYS[write.action] ?? 'commit.working'
    case 'stage': return 'stage.updatingIndex'
    case 'worktree': return write.action === 'remove' ? 'worktree.removing' : 'worktree.working'
  }
}

/** Select actions from the repository's own capabilities, not the timeline's checked-worktree scope. */
export function tileDirectActions(
  pointer: PointerView,
  repository: RepositoryView,
  capabilities: RepositoryCapabilities | null | undefined,
  busy: RepoWrite | undefined,
  catalog?: CheckoutCatalog,
): TileDirectAction[] {
  if (pointer.repo !== repository.path || capabilities === null || capabilities === undefined
    || pointer.state === 'unsaved' || pointer.state === 'op' || pointer.kind === 'stash') return []

  const candidates = applicableActions(pointer, repository, capabilities, catalog)
  return busy === undefined ? candidates : candidates.map(item => ({ ...item, disabledReason: writeReason(busy) }))
}

function applicableActions(
  pointer: PointerView, repository: RepositoryView, capabilities: RepositoryCapabilities, catalog: CheckoutCatalog | undefined,
): TileDirectAction[] {
  const { occupant, state } = pointer
  const hasUniqueCommits = state === 'unique' || state === 'diverged'
  const primary = repository.checkouts.find(tree => tree.primary)
  const currentBranch = primary?.branch ?? null
  const needsUpstream = pointer.upstream == null ? 'top.syncNoUpstream' : undefined
  // Existing HEAD-relative writes act on the registered entry, not on a sibling preview.
  const primaryIsEntry = primary?.path === repository.path
  const trunk = currentBranch === null ? undefined
    : repository.pointers.find(item => item.kind === 'branch' && item.name === currentBranch)
  const receiver = primaryIsEntry && primary.operation === null && trunk?.isBase === true && pointer.base !== null
    && (trunk.name === pointer.base || trunk.upstream === pointer.base) ? trunk.name : undefined

  const removeWorktree = (): TileDirectAction[] => {
    // A commit-based working copy ends either by forgetting or by removing it;
    // that choice stays in the menu.
    if (capabilities.worktreeRemove !== true || capabilities.workingCopy === 'commit' || occupant === null) return []
    const row = catalog?.worktrees?.find(tree => tree.path === occupant.path)
    // Use the overview's checkout identity and the catalog's removal eligibility.
    const tree: WorktreeInfo = {
      ...row, name: row?.name ?? pointer.display, path: occupant.path, branch: occupant.branch, head: occupant.head,
      primary: occupant.primary || row?.primary, locked: occupant.locked || row?.locked,
    }
    const sessionPath = catalog?.enclosing === true ? repository.path : null
    return [{ action: { domain: 'worktree', kind: 'remove', tree }, disabledReason: worktreeActionReason('remove', tree, sessionPath, capabilities) }]
  }
  const branchButtons = (
    requested: readonly BranchMenuAction[], offered: readonly BranchMenuAction[], ref?: { remote: string, local: string },
  ): TileDirectAction[] => requested.filter(kind => offered.includes(kind)).map(kind => ({
    action: { domain: 'branch', kind, branch: pointer.name, ...ref, receiver: kind === 'merge' || kind === 'merge-remote' ? receiver : undefined },
    disabledReason: kind === 'push' ? needsUpstream : undefined,
  }))

  if (pointer.kind === 'detached') {
    if (occupant === null) return []
    if (hasUniqueCommits && capabilities.commitOps === true) {
      return [{ action: { domain: 'commit', kind: 'create-branch', sha: pointer.sha, subject: pointer.subject } }]
    }
    return state === 'synced' || state === 'behind' || state === 'merged' ? removeWorktree() : []
  }

  if (pointer.kind === 'remote') {
    const { remote, branch } = pointer
    if (capabilities.branchOps !== true || !remote || !branch
      || repository.pointers.some(item => item.kind === 'branch' && item.upstream === pointer.name)) return []
    const offered = remoteBranchActions({ currentBranch })
    return branchButtons(receiver === undefined ? ['checkout-remote'] : ['checkout-remote', 'merge-remote'], offered, { remote, local: branch })
  }

  if (occupant?.primary === true) {
    const differs = (pointer.track?.ahead ?? 0) > 0 || (pointer.track?.behind ?? 0) > 0
    return primaryIsEntry && currentBranch === pointer.name && primary.head !== null && capabilities.sync === true && (differs || needsUpstream !== undefined)
      ? [{ action: { domain: 'sync', kind: 'sync', branch: pointer.name }, disabledReason: needsUpstream }]
      : []
  }
  if (occupant !== null && (state === 'synced' || state === 'behind')) return removeWorktree()
  if (capabilities.branchOps !== true) return []

  const offered = branchActions({ current: currentBranch === pointer.name, currentBranch })
    .filter(kind => kind !== 'checkout' || capabilities.branchSwitch === true)
  if (hasUniqueCommits) return branchButtons(occupant === null && receiver !== undefined ? ['push', 'merge'] : ['push'], offered)
  if (occupant !== null) return []
  if (state === 'behind') return branchButtons(['checkout', 'delete'], offered)
  if (state === 'merged') return branchButtons(['delete'], offered)
  return state === 'synced' ? branchButtons(['checkout'], offered) : []
}
