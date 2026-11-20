/**
 * The branch actions menu: which actions apply to which branch or remote
 * branch, visual grouping, destructiveness, and localized busy labels.
 *
 * A local branch that is not checked out can be checked out, renamed, deleted,
 * merged into the current branch, used as the new base of the current branch,
 * or pushed. A remote branch can be checked out as a tracking local branch,
 * deleted on its remote, merged into the current branch, or pulled into it.
 * Merge, rebase, and pull only appear while a named branch is checked out; a
 * detached HEAD has no "current branch" to move. The checked-out branch itself
 * is renamed or pushed: checking it out would be a no-op, deleting it is
 * refused by Git, and merging it into itself or rebasing it onto itself changes
 * nothing.
 */

/** One action the local branch menu offers. */
export type BranchAction = 'checkout' | 'rename' | 'delete' | 'merge' | 'rebase' | 'push'

/** One action the remote-branch menu offers. */
export type RemoteBranchAction = 'checkout-remote' | 'delete-remote' | 'merge-remote' | 'pull-remote'

/** One action of either branch menu. */
export type BranchMenuAction = BranchAction | RemoteBranchAction

/** One action the branch route runs; checking out has its own route. */
export type BranchOpAction = Exclude<BranchMenuAction, 'checkout'>

/** Visual group, destructiveness, and menu label key for one action. */
export interface BranchActionMeta {
  /** Menu group; actions of one group sit together. */
  readonly group: number
  /** Whether the action removes or rewrites a ref. */
  readonly destructive: boolean
  /** Locale key of the menu label. */
  readonly labelKey: string
}

/** Visual group, destructiveness, and menu label key for each branch action. */
export const BRANCH_ACTION_META: Readonly<Record<BranchMenuAction, BranchActionMeta>> = Object.freeze({
  checkout: { group: 0, destructive: false, labelKey: 'branch.checkout' },
  rename: { group: 1, destructive: false, labelKey: 'branch.rename' },
  delete: { group: 1, destructive: true, labelKey: 'branch.delete' },
  merge: { group: 2, destructive: false, labelKey: 'branch.merge' },
  rebase: { group: 2, destructive: false, labelKey: 'branch.rebase' },
  push: { group: 3, destructive: false, labelKey: 'branch.push' },
  'checkout-remote': { group: 0, destructive: false, labelKey: 'branch.checkoutRemote' },
  'delete-remote': { group: 1, destructive: true, labelKey: 'branch.deleteRemote' },
  'merge-remote': { group: 2, destructive: false, labelKey: 'branch.mergeRemote' },
  'pull-remote': { group: 3, destructive: false, labelKey: 'branch.pullRemote' },
})

/** Busy labels for the actions that report through the branch icon. */
export const BRANCH_BUSY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  rename: 'branch.renaming',
  delete: 'branch.deleting',
  merge: 'branch.merging',
  rebase: 'branch.rebasing',
  push: 'branch.pushing',
  'checkout-remote': 'top.switching',
  'delete-remote': 'branch.deleting',
  'merge-remote': 'branch.merging',
  'pull-remote': 'branch.pulling',
})

/**
 * Look up one branch action's metadata by action id.
 * @param action - branch, remote-branch, or tag action id.
 * @returns its metadata, or undefined for an unknown id.
 */
export function branchActionMeta(action: string): BranchActionMeta | undefined {
  // Callers hold an action id from one of the lists above; the lookup keeps
  // the unknown string they pass instead of widening the table to an index map.
  return BRANCH_ACTION_META[action as BranchMenuAction]
}

/**
 * Actions the menu offers for one branch, in display order.
 * @param target - the branch and the checked-out branch.
 * @returns action ids.
 */
export function branchActions({ current, currentBranch }: { current: boolean; currentBranch: string | null }): BranchAction[] {
  if (current) return ['rename', 'push']
  const actions: BranchAction[] = ['checkout', 'rename', 'delete']
  if (currentBranch !== null) actions.push('merge', 'rebase')
  actions.push('push')
  return actions
}

/**
 * Actions the remote-branch menu offers, in display order.
 *
 * Checkout and deleting the remote branch always apply. Merge and pull move
 * the checked-out branch, so they only appear while a named branch is checked
 * out; a detached HEAD has no "current branch" to receive them.
 *
 * @param target - the checked-out branch.
 * @returns action ids.
 */
export function remoteBranchActions({ currentBranch }: { currentBranch: string | null }): RemoteBranchAction[] {
  const actions: RemoteBranchAction[] = ['checkout-remote', 'delete-remote']
  if (currentBranch !== null) actions.push('merge-remote', 'pull-remote')
  return actions
}

/**
 * Whether an action removes a ref and is styled as destructive.
 * @param action - branch, remote-branch, or tag action id.
 * @returns whether it is destructive.
 */
export function isDestructiveAction(action: string): boolean {
  return branchActionMeta(action)?.destructive === true
}
