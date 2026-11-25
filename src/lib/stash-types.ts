/** The stash protocol shared by the Host and the panel. */

import type { CommitFile } from './commit.js'

export const STASH_MESSAGE_MAX = 1_000
export const STASH_PATH_MAX = 50

export interface StashEntry {
  sha: string
  selector: string
  base: string
  index: string
  untracked: string | null
  /** Committer time in seconds. */
  time: number
  branch: string | null
  message: string
}

export interface StashDetail extends StashEntry {
  files: Array<CommitFile & { untracked?: true }>
  staged: number
}

export type StashBlock = 'operation' | 'conflict' | 'overwrite' | 'untracked-exists' | 'index-conflict' | 'dirty'
export type StashMode = 'apply' | 'branch'

export interface StashPaths {
  paths: string[]
  pathsTruncated: boolean
}

export interface StashBlockInfo extends StashPaths {
  reason: StashBlock
}

export interface StashCheck {
  head: string | null
  baseIsHead: boolean
  block: StashBlockInfo | null
}

export interface StashDetailAnswer {
  stash: StashDetail
  truncated: boolean
}

export type StashRequest =
  | { action: 'push'; message?: string; untracked: boolean }
  | { action: 'apply'; sha: string; index: boolean; drop: boolean }
  | { action: 'branch'; sha: string; name: string }
  | { action: 'drop'; sha: string }

export interface StashIdentity {
  sha: string
  selector: string
}

export type StashResult<T extends StashRequest = StashRequest> = T extends { action: 'apply' }
  ? StashIdentity & { dropped: boolean }
  : T extends { action: 'branch' } ? StashIdentity & { branch: string } : StashIdentity
