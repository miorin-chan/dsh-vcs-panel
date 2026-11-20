/**
 * The commit actions menu: which actions apply to one commit, visual grouping,
 * destructiveness, dialog mapping, and the busy labels reported while working.
 *
 * Tagging and creating a branch only add a ref. Checkout is offered unless
 * the commit is already HEAD. Picking, reverting, dropping, merging,
 * rebasing, and resetting move or rewrite the checked-out branch, so they
 * need a named branch. Drop is omitted for multi-parent/root commits or when
 * the loaded graph shows the commit is off the current branch; cherry-pick,
 * merge, and rebase are omitted for commits already reachable from HEAD.
 */

/** One action a commit row's menu offers. */
export type CommitAction =
  | 'add-tag'
  | 'create-branch'
  | 'checkout'
  | 'cherry-pick'
  | 'revert'
  | 'drop'
  | 'merge'
  | 'rebase'
  | 'reset'

/** The confirmation one history action needs. */
export type CommitDialogKind =
  | 'tag'
  | 'branch'
  | 'checkout'
  | 'cherry-pick'
  | 'revert'
  | 'drop'
  | 'merge'
  | 'rebase'
  | 'reset'

/** How one commit relates to the checked-out history. */
export type CommitRelation = 'on-branch' | 'off-branch' | 'unknown'

/** Visual group, destructiveness, label key, and dialog kind for one action. */
export interface CommitActionMeta {
  /** Menu group; actions of one group sit together. */
  readonly group: number
  /** Whether the action rewrites history or can discard changes. */
  readonly destructive: boolean
  /** Locale key of the menu label. */
  readonly labelKey: string
  /** The confirmation dialog the action opens. */
  readonly dialogKind: CommitDialogKind
}

/** Visual group, destructiveness, label key, and dialog kind per commit action. */
export const COMMIT_ACTION_META: Readonly<Record<CommitAction, CommitActionMeta>> = Object.freeze({
  'add-tag': { group: 0, destructive: false, labelKey: 'commit.addTag', dialogKind: 'tag' },
  'create-branch': { group: 0, destructive: false, labelKey: 'commit.createBranch', dialogKind: 'branch' },
  checkout: { group: 1, destructive: false, labelKey: 'commit.checkout', dialogKind: 'checkout' },
  'cherry-pick': { group: 1, destructive: false, labelKey: 'commit.cherryPick', dialogKind: 'cherry-pick' },
  revert: { group: 1, destructive: false, labelKey: 'commit.revert', dialogKind: 'revert' },
  drop: { group: 1, destructive: true, labelKey: 'commit.drop', dialogKind: 'drop' },
  merge: { group: 2, destructive: false, labelKey: 'commit.merge', dialogKind: 'merge' },
  rebase: { group: 2, destructive: false, labelKey: 'commit.rebase', dialogKind: 'rebase' },
  reset: { group: 2, destructive: true, labelKey: 'commit.reset', dialogKind: 'reset' },
})

/** Busy labels for the commit actions. */
export const COMMIT_BUSY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  tag: 'commit.tagging',
  branch: 'commit.creatingBranch',
  checkout: 'commit.checkingOut',
  'cherry-pick': 'commit.cherryPicking',
  revert: 'commit.reverting',
  drop: 'commit.dropping',
  merge: 'commit.merging',
  rebase: 'commit.rebasing',
  reset: 'commit.resetting',
})

/**
 * Look up one commit action's metadata by action id.
 * @param action - commit action id.
 * @returns its metadata, or undefined for an unknown id.
 */
export function commitActionMeta(action: string): CommitActionMeta | undefined {
  // Callers hold an action id from the list above; the lookup keeps the
  // unknown string they pass instead of widening the table to an index map.
  return COMMIT_ACTION_META[action as CommitAction]
}

/** The commit row the menu classifies. */
export interface CommitActionTarget {
  /** The commit, whose id and parents pick the applicable actions. */
  commit: {
    sha: string
    parents?: readonly unknown[]
  }
  /** The checked-out branch, or null when HEAD is detached or unborn. */
  currentBranch: string | null
  /** The checked-out commit id, or null. */
  head: string | null
  /** The commit's relation to the loaded history, when known. */
  relation?: string
}

/**
 * Actions the menu offers for one commit, in display order.
 * @param target - the commit, branch state, and reachability relation.
 * @returns action ids.
 */
export function commitActions({ commit, currentBranch, head, relation = 'unknown' }: CommitActionTarget): CommitAction[] {
  const actions: CommitAction[] = ['add-tag', 'create-branch']
  const atHead = typeof head === 'string' && head !== '' && commit.sha === head
  if (!atHead) actions.push('checkout')
  if (currentBranch !== null) {
    if (!atHead && relation !== 'on-branch') actions.push('cherry-pick')
    actions.push('revert')
  }
  if (
    currentBranch !== null
    && relation !== 'off-branch'
    && Array.isArray(commit.parents)
    && commit.parents.length === 1
  ) {
    actions.push('drop')
  }
  if (currentBranch !== null && !atHead) {
    if (relation !== 'on-branch') actions.push('merge', 'rebase')
    actions.push('reset')
  }
  return actions
}

/**
 * Whether an action rewrites history or can discard changes.
 * @param action - commit action id.
 * @returns whether it is destructive.
 */
export function isDestructiveCommitAction(action: string): boolean {
  return commitActionMeta(action)?.destructive === true
}
