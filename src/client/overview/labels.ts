/** Locale keys of the overview's states and filters, spelled out so every key stays a literal. */

import type { FilterId, PointerState } from './model.js'

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
