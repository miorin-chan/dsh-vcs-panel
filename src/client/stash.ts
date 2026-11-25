/** Stable stash targets, menu items, and the dialog's preflight states. */

import type { StashBlock, StashBlockInfo, StashCheck, StashPaths, StashRequest } from '../lib/stash-types.js'
import type { StatusData } from './api.js'

export interface StashTarget {
  repo: string
  sha: string
  selector: string
  message: string
  base: string
}

export type StashMenuAction = Exclude<StashRequest['action'], 'push'>

export const STASH_ACTION_META = {
  apply: { labelKey: 'stash.apply', group: 'recover', destructive: false },
  branch: { labelKey: 'stash.branch', group: 'recover', destructive: false },
  drop: { labelKey: 'stash.drop', group: 'discard', destructive: true },
} as const

export function stashActions(capable: boolean): StashMenuAction[] {
  return capable ? ['apply', 'branch', 'drop'] : []
}

export function stashActionMeta(action: string) {
  return Object.hasOwn(STASH_ACTION_META, action) ? STASH_ACTION_META[action as StashMenuAction] : undefined
}

export function stashNode(sha: string): string {
  return `stash:${sha}`
}

export function stashSha(node: unknown): string | null {
  if (typeof node !== 'string') return null
  return /^stash:([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(node)?.[1] ?? null
}

export const STASH_BLOCK_COPY: Readonly<Record<StashBlock, string>> = {
  operation: 'stash.blockOperation',
  conflict: 'stash.blockConflict',
  overwrite: 'stash.blockOverwrite',
  'untracked-exists': 'stash.blockUntracked',
  'index-conflict': 'stash.blockIndex',
  dirty: 'stash.blockDirty',
}

/** Read typed fields from a Host failure; unknown or incomplete payloads stay generic. */
export function stashFailureFields(error: Record<string, unknown> | undefined): { stashBlock?: StashBlockInfo; stashPaths?: StashPaths } {
  if (error === undefined) return {}
  const { code, reason, paths, pathsTruncated } = error
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string') || typeof pathsTruncated !== 'boolean') return {}
  if (code === 'stash-blocked' && typeof reason === 'string' && Object.hasOwn(STASH_BLOCK_COPY, reason)) {
    return { stashBlock: { reason: reason as StashBlock, paths, pathsTruncated } }
  }
  return code === 'stash-conflict' ? { stashPaths: { paths, pathsTruncated } } : {}
}

/** The check also covers the wait for detail, which supplies the index option. */
export function stashCheckView(check: StashCheck | null, blocked?: StashBlockInfo) {
  const block = blocked ?? check?.block ?? null
  return {
    state: block !== null ? 'blocked' : check === null ? 'checking' : 'ok',
    block,
    canConfirm: check !== null && block === null,
    offerBranch: block?.reason === 'conflict',
  } as const
}

/** Keep the save control focusable even when the working tree cannot be stashed. */
export function stashSaveReason(status: StatusData | null, busy: boolean): string | undefined {
  if (status !== null && status.total === 0) return 'stash.saveEmpty'
  const groups = status?.groups
  if ([groups?.staged, groups?.unstaged].some(files => files?.some(file => file.conflict === true))) return 'stash.saveConflict'
  return busy || status === null ? 'error.busy' : undefined
}
