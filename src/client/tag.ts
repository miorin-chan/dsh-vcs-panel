/**
 * The tag actions menu: which actions apply to a tag, visual grouping,
 * destructiveness, and which localized labels describe them while they run.
 *
 * A tag names one commit for good, so the menu offers the two writes that
 * maintain it: delete the local tag, or send it to a remote. Deleting leaves a
 * remote copy alone; pushing never forces and never moves the local tag.
 */

/** One action the tag menu offers. */
export type TagAction = 'delete' | 'push'

/** Visual group, destructiveness, and menu label key for one action. */
export interface TagActionMeta {
  /** Menu group; actions of one group sit together. */
  readonly group: number
  /** Whether the action removes the local ref. */
  readonly destructive: boolean
  /** Locale key of the menu label. */
  readonly labelKey: string
}

/** Visual group, destructiveness, and menu label key for each tag action. */
export const TAG_ACTION_META: Readonly<Record<TagAction, TagActionMeta>> = Object.freeze({
  delete: { group: 0, destructive: true, labelKey: 'tag.delete' },
  push: { group: 1, destructive: false, labelKey: 'tag.push' },
})

/** Busy labels for the actions that report through the tag dialog. */
export const TAG_BUSY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  delete: 'tag.deleting',
  push: 'tag.pushing',
})

/**
 * Look up one tag action's metadata by action id.
 * @param action - tag action id.
 * @returns its metadata, or undefined for an unknown id.
 */
export function tagActionMeta(action: string): TagActionMeta | undefined {
  // Callers hold an action id from the list above; the lookup keeps the
  // unknown string they pass instead of widening the table to an index map.
  return TAG_ACTION_META[action as TagAction]
}

/**
 * Actions the menu offers for one tag, in display order.
 * @returns action ids.
 */
export function tagActions(): TagAction[] {
  return ['delete', 'push']
}
