/**
 * Panel commands the application shortcuts send to a mounted panel: toggle the
 * overview column, toggle the tiled layout. A command sent before its Session's
 * panel mounts waits for it, so a shortcut that opens the tab still applies.
 */

/** One panel command. */
export type PanelCommand = 'overview' | 'tile'

type Listener = (command: PanelCommand) => void

const listeners = new Map<string, Set<Listener>>()
const pending = new Map<string, PanelCommand>()

/**
 * Send a command to the Session's panel, or keep it until the panel listens.
 * @param sessionId - the Session whose panel acts.
 * @param command - what to do.
 */
export function sendPanelCommand(sessionId: string, command: PanelCommand): void {
  const set = listeners.get(sessionId)
  if (set === undefined || set.size === 0) {
    pending.set(sessionId, command)
    return
  }
  for (const listener of set) listener(command)
}

/**
 * Receive the commands of one Session's panel.
 * @param sessionId - the panel's Session.
 * @param listener - called with each command.
 * @returns the unsubscribe function.
 */
export function onPanelCommand(sessionId: string, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(sessionId, set)
  const waiting = pending.get(sessionId)
  if (waiting !== undefined) {
    pending.delete(sessionId)
    listener(waiting)
  }
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}
