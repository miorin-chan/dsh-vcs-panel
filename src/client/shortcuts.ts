/**
 * Application-wide shortcut state for the VCS panel.
 *
 * DSH's shortcut registry handles key delivery, per-device defaults, conflict
 * checks, and the Settings > Shortcuts editor; this module owns the command
 * identity and the Session the command acts on. It is deliberately free of
 * React and DSH imports so the rules stay unit-testable.
 */

import type { ShortcutBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutProfile } from '@deepseek-ai/dsh-client-shortcuts/protocol'

/** Command identity shown in Settings > Shortcuts. */
export const SHORTCUT_ID = 'vcs.view.toggle'

/** Commands for the overview column and the tiled layout; they start unbound. */
export const OVERVIEW_SHORTCUT_ID = 'vcs.view.overview'
export const TILE_SHORTCUT_ID = 'vcs.view.tile'

/**
 * Per-profile defaults: Command+Shift+G on macOS and Control+Shift+G
 * elsewhere. Linux Web is omitted because DSH's Web binding policy rejects
 * this combination; there the command starts unbound and the user can pick a
 * key in Settings > Shortcuts.
 */
export const SHORTCUT_DEFAULTS: Readonly<Partial<Record<ShortcutProfile, ShortcutBinding>>> = Object.freeze({
  'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'desktop:linux': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'web:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
  'web:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
})

/** One row of DSH's runtime Session list, as this command reads it. */
export interface SessionListRow {
  id?: string
  /** The views that keep the Session resident; a resident main view is the open panel. */
  retainedBy?: {
    mainView?: number
  }
}

/**
 * DSH's runtime Session list snapshot, as this command reads it.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the sidebar and the
 * Workspace shortcuts read the same retention counters.
 */
export interface SessionListSnapshot {
  byId?: Record<string, SessionListRow | undefined> | null
}

/**
 * Pick the Session whose main view is resident. DSH's runtime Session list
 * records view retention; the same rule is used by the Workspace shortcuts to
 * resolve "the current Session".
 * @param snapshot - Session list state.
 * @returns the retained Session id, or null when no main view is resident.
 */
export function mainSessionId(snapshot: SessionListSnapshot | undefined): string | null {
  const rows = snapshot?.byId
  if (rows === null || rows === undefined || typeof rows !== 'object') return null
  for (const row of Object.values(rows)) {
    if (row === undefined) continue
    if ((row.retainedBy?.mainView ?? 0) > 0 && typeof row.id === 'string' && row.id !== '') return row.id
  }
  return null
}
