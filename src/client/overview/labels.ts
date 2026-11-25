/** Locale keys of the overview's states and filters, spelled out so every key stays a literal. */

import type { FilterId, PointerState } from './model.js'
import type { OverviewOperation } from '../../lib/overview.js'

export const BOOKMARK_CONFLICT_KEY = 'overview.operation.bookmarkConflict'

/** The label of each unfinished checkout operation. */
export const OPERATION_KEYS: Readonly<Record<OverviewOperation, string>> = Object.freeze({
  rebase: 'overview.operation.rebase',
  merge: 'overview.operation.merge',
  'cherry-pick': 'overview.operation.cherryPick',
  revert: 'overview.operation.revert',
  bisect: 'overview.operation.bisect',
  conflict: 'overview.operation.conflict',
})

/** The label of each pointer state. */
export const STATE_KEYS: Readonly<Record<PointerState, string>> = Object.freeze({
  op: 'overview.state.op',
  unsaved: 'overview.state.unsaved',
  unique: 'overview.state.unique',
  diverged: 'overview.state.diverged',
  stash: 'overview.state.stash',
  behind: 'overview.state.behind',
  merged: 'overview.state.merged',
  foreign: 'overview.state.foreign',
  synced: 'overview.state.synced',
  shadow: 'overview.state.shadow',
})

/** The label of each filter chip and state button. */
export const FILTER_KEYS: Readonly<Record<FilterId, string>> = Object.freeze({
  unsaved: 'overview.state.unsaved',
  unique: 'overview.state.unique',
  diverged: 'overview.state.diverged',
  behind: 'overview.state.behind',
  merged: 'overview.state.merged',
  stash: 'overview.state.stash',
  op: 'overview.state.op',
})
