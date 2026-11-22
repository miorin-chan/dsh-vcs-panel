/**
 * What the client may assume about one version control model.
 *
 * Capabilities are data, not a backend id: the panel reads `workingCopy`,
 * `staging`, `changeId`, `snapshots`, `sync`, `branchSwitch`, `branchOps`,
 * `tagOps`, `commitOps`, and `ranges` to choose between the working-tree row and a
 * working-copy commit, between staged/unstaged groups and one changes group,
 * whether to offer branch sync, branch actions, tag actions, and commit
 * actions, and between history ranges. A future backend only has to state the same answers; the
 * client needs no new branch on its name.
 */

/** One history range the client offers. */
export interface VcsRange {
  /** Range value sent back to the log route. */
  value: string
  /** Localization key for the range's label. */
  label: string
  /** Localization key for the range's tooltip. */
  title: string
}

/** What the client may assume about one version control model. */
export interface VcsCapabilities {
  /** Backend id, also the repository marker's name. */
  id: string
  /** Display name. */
  name: string
  /** Whether the working copy is a virtual row or an ordinary commit. */
  workingCopy: 'row' | 'commit'
  /** The stable node token for the working copy, when it is a commit. */
  workingCopyNode: string | null
  /** Whether status has staged, unstaged, and untracked groups. */
  staging: boolean
  /** Whether files and selected lines can be moved into and out of the index. */
  stageOps: boolean
  /** Whether untracked directories can be expanded on demand. */
  untracked: boolean
  /** Whether commits carry a stable change id beside their commit id. */
  changeId: boolean
  /** Whether the branch reports ahead/behind counts. */
  aheadBehind: boolean
  /** Whether reading may write backend bookkeeping. */
  snapshots: boolean
  /** Whether the branch can sync with its upstream. */
  sync: boolean
  /** Whether local branches can be listed and checked out from the header. */
  branchSwitch: boolean
  /** Whether the branch menus can act on local and remote branches. */
  branchOps: boolean
  /** Whether tag badges can delete and push tags. */
  tagOps: boolean
  /** Whether commit rows can act on commits. */
  commitOps: boolean
  worktreeCreate: boolean
  worktreeRemove: boolean
  worktreeForget: boolean
  /** The history ranges offered. */
  ranges: readonly VcsRange[]
  /** The range the log route defaults to. */
  defaultRange: string
}

/** Git: a working tree beside HEAD, an index, and refs. */
export const GIT_CAPABILITIES: VcsCapabilities = Object.freeze({
  id: 'git',
  name: 'Git',
  /** The working tree is a virtual row above the commits. */
  workingCopy: 'row',
  /** No commit stands for the working copy. */
  workingCopyNode: null,
  /** The status has staged, unstaged, and untracked groups. */
  staging: true,
  /** Files and selected lines can be moved into and out of the index. */
  stageOps: true,
  /** Untracked directories can be expanded on demand. */
  untracked: true,
  /** Commits have a stable change id beside their commit id. */
  changeId: false,
  /** The branch reports ahead/behind counts. */
  aheadBehind: true,
  /** Reading may write backend bookkeeping; git reads do not. */
  snapshots: false,
  /** The branch can sync with its upstream: fetch, then fast-forward or push. */
  sync: true,
  /** Local branches can be listed and checked out from the header. */
  branchSwitch: true,
  /** Branch menus can check out, rename, delete, merge, rebase, push, and act on remote branches. */
  branchOps: true,
  /** Tag badges can delete a local tag and push it to a remote. */
  tagOps: true,
  /** Commit rows can tag, branch, check out, pick, revert, drop, merge, rebase, and reset. */
  commitOps: true,
  worktreeCreate: true,
  worktreeRemove: true,
  worktreeForget: false,
  ranges: Object.freeze([
    { value: 'all', label: 'history.all', title: 'history.allTitle' },
    { value: 'HEAD', label: 'history.selectedWorktrees', title: 'history.selectedWorktreesTitle' },
  ]),
  defaultRange: 'all',
})

/** A sibling working tree keeps Git's read views but exposes no write actions. */
export const GIT_WORKTREE_CAPABILITIES: VcsCapabilities = Object.freeze({
  ...GIT_CAPABILITIES,
  stageOps: false,
  sync: false,
  branchSwitch: false,
  branchOps: false,
  tagOps: false,
  commitOps: false,
  worktreeCreate: false,
  worktreeRemove: false,
})

/** Jujutsu: the working copy is a commit, and history is a revset. */
export const JUJUTSU_CAPABILITIES: VcsCapabilities = Object.freeze({
  id: 'jujutsu',
  name: 'Jujutsu',
  /** The working-copy commit (`@`) is an ordinary timeline row. */
  workingCopy: 'commit',
  /** The stable node token for the working-copy commit. */
  workingCopyNode: '@',
  /** Every working-copy change belongs to one changes group, not an index. */
  staging: false,
  stageOps: false,
  untracked: false,
  changeId: true,
  aheadBehind: false,
  /** Jujutsu snapshots the working copy as part of reading its state. */
  snapshots: true,
  /** Bookmark sync is not offered; `jj git push` stays in the terminal. */
  sync: false,
  /** A bookmark is not a branch: switching would move the working-copy commit. */
  branchSwitch: false,
  /** Bookmark operations have no branch ref to act on. */
  branchOps: false,
  /** Tags are read-only here; `jj git tag` is left to the terminal. */
  tagOps: false,
  /** Commit actions rewrite Git history or the index; Jujutsu stays read-only. */
  commitOps: false,
  worktreeCreate: true,
  worktreeRemove: false,
  worktreeForget: true,
  ranges: Object.freeze([
    { value: 'all', label: 'history.all', title: 'history.allTitle' },
    { value: '@', label: 'history.selectedWorktrees', title: 'history.selectedWorktreesTitle' },
  ]),
  defaultRange: 'all',
})
