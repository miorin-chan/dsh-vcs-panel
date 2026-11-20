/**
 * Per-turn file-change evidence for the turn-tail entry.
 *
 * DSH's changed-files card is fed by the `workspace/changes` recorder, which
 * this bundle asks to carry no file list so the card has nothing to show. The
 * recorder still announces every turn that changed files, and that
 * announcement is this entry's primary evidence: it covers shell commands and
 * subagent work, which the Session log alone cannot attribute to a mutation.
 * Successful file-tool calls are the fallback for a turn whose record the
 * recorder could not finish (for example when git failed).
 *
 * The fold is a state-only Conversation definition: it publishes one Turn
 * Location value and owns no Chat node.
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Definition kind; the Engine requires the Location-data key to equal it, so
 * this one constant serves both purposes.
 */
export const TURN_CHANGES_KIND = 'vcs-changes'

/**
 * The event fields this definition reads.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the Engine hands over its
 * `SessionEventLike`, whose durable and transient fields are read here.
 */
interface TurnChangesEvent {
  readonly type: string
  /** Log sequence the event appended at, on `workspace/changes`. */
  readonly seq?: number
  /** Set on tool results that appended at their own log position. */
  readonly surfaceOp?: string
  readonly data: {
    readonly turn?: number
    readonly callId?: string
    readonly name?: string
    readonly arguments?: string
    readonly message?: {
      readonly isError?: boolean
      readonly source?: {
        readonly callId?: string
      }
    }
  }
}

/** Fold state of one Turn; `calls` remembers which calls may mutate. */
interface TurnChangesState {
  turn: number
  calls: Map<string, boolean>
  changed: boolean
  seq: number | null
}

/** The change coordinates one Turn Location publishes. */
export interface TurnChanges {
  turn: number | null
  seq: number | null
}

/**
 * The Turn Location fields this definition's reader inspects.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the Engine's TurnLocation
 * stores business values by key outside its declaration-merged data map.
 */
export interface TrackedTurn {
  readonly turn?: number
  readonly data?: {
    get(key: string): unknown
  }
}

/** Whether a decoded value is an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Read one Engine event through the local shape this definition declares. */
function eventOf(match: { readonly event: unknown }): TurnChangesEvent {
  return match.event as TurnChangesEvent
}

/**
 * Whether an event data value names a top-level turn.
 * @param value - decoded event data.
 * @returns true for a positive safe integer `turn`.
 */
function isTurnRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const turn = (value as { turn?: unknown }).turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1
}

/**
 * Parse a tool call's raw argument JSON into an object.
 * @param raw - arguments exactly as the model produced them.
 * @returns the argument object, or null when it is not one.
 */
function argumentObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return isRecord(value) && !Array.isArray(value) ? value : null
}

/**
 * Whether one tool call can change files in the working tree.
 *
 * Only tools whose successful result implies a content change count; reads,
 * `present`, shell commands, and workflow control carry no such claim. The
 * argument checks mirror the execution preconditions of each tool, so a call
 * that the tool will refuse does not mark the turn.
 *
 * @param name - wire tool name.
 * @param raw - raw argument JSON.
 * @returns true when the call is a mutation.
 */
export function isMutationCall(name: string | undefined, raw: unknown): boolean {
  switch (name) {
    case 'apply_patch':
      // A patch either applies or fails; the failure path checks the result.
      return true
    case 'write': {
      const args = argumentObject(raw)
      return args !== null && typeof args.content === 'string'
    }
    case 'edit': {
      const args = argumentObject(raw)
      return args !== null
        && typeof args.old_string === 'string'
        && args.old_string !== ''
        && typeof args.new_string === 'string'
        && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
    }
    case 'str_replace_editor': {
      const args = argumentObject(raw)
      if (args === null || typeof args.path !== 'string' || args.path === '') return false
      switch (args.command) {
        case 'create':
          return typeof args.file_text === 'string'
        case 'str_replace':
          return typeof args.old_str === 'string' && args.old_str !== ''
            && (args.new_str === undefined || typeof args.new_str === 'string')
        case 'insert':
          return typeof args.new_str === 'string'
            && typeof args.insert_line === 'number'
            && Number.isInteger(args.insert_line)
            && args.insert_line >= 0
        default:
          return false
      }
    }
    default:
      return false
  }
}

/** Fold state of one Turn; `calls` remembers which calls may mutate. */
function initialState(turn: number): TurnChangesState {
  return { turn, calls: new Map(), changed: false, seq: null }
}

/** Normalize an event sequence number, or null when absent. */
function eventSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Build the state-only definition that publishes whether a Turn changed files
 * and the sequence of its latest `workspace/changes` announcement.
 * @returns a Conversation node definition without a target.
 */
export function createTurnChangesDefinition(): ConversationNodeDefinition<TurnChangesState> {
  return {
    kind: TURN_CHANGES_KIND,
    match(event) {
      const decoded = eventOf({ event })
      if (decoded.type === 'turn/start') return { id: String(decoded.data.turn), role: 'start' }
      if (decoded.type === 'workspace/changes' && isTurnRecord(decoded.data)) {
        return { id: String(decoded.data.turn), role: 'update' }
      }
      if (decoded.type === 'tool/call') return { id: String(decoded.data.turn), role: 'update' }
      // Replacement copies shadow the model surface; the human transcript only
      // sees events that appended at their own log position.
      if (decoded.type === 'tool/result' && decoded.surfaceOp === 'append') {
        return { id: String(decoded.data.turn), role: 'update' }
      }
      return null
    },
    start(_context, match) {
      const event = eventOf(match)
      if (event.type !== 'turn/start') throw new Error('vcs turn changes require turn/start')
      return initialState(event.data.turn as number)
    },
    update(context, match) {
      const state = context.state
      const event = eventOf(match)
      if (event.type === 'workspace/changes') {
        const seq = eventSeq(event.seq) ?? state.seq
        return state.changed && seq === state.seq ? state : { ...state, changed: true, seq }
      }
      if (event.type === 'tool/call') {
        const { callId, name, arguments: raw } = event.data
        if (callId === undefined || !isMutationCall(name, raw)) return state
        const calls = new Map(state.calls)
        calls.set(String(callId), true)
        return { ...state, calls }
      }
      if (event.type !== 'tool/result' || state.changed) return state
      if (event.data.message?.isError === true) return state
      const callId = event.data.message?.source?.callId
      if (callId === undefined || !state.calls.has(String(callId))) return state
      return { ...state, changed: true }
    },
    buildLocationData(context, scope, previous) {
      if (scope !== 'turn' || context.state === undefined || !context.state.changed) return null
      const seq = context.state.seq
      if (previous !== null
        && previous.kind === 'turn'
        && previous.turn === context.state.turn
        && previous.key === TURN_CHANGES_KIND
        && isRecord(previous.value)
        && previous.value.changed === true
        && (previous.value.seq ?? null) === seq) return previous
      return {
        kind: 'turn',
        turn: context.state.turn,
        key: TURN_CHANGES_KIND,
        value: seq === null ? { changed: true } : { changed: true, seq },
      }
    },
  }
}

/**
 * Read the published change coordinates of a Turn Location.
 * @param turn - turn location.
 * @returns the coordinates, or null when unchanged.
 */
export function turnChanges(turn: TrackedTurn | null | undefined): TurnChanges | null {
  if (turn === null || turn === undefined || typeof turn.data?.get !== 'function') return null
  const value = turn.data.get(TURN_CHANGES_KIND)
  if (!isRecord(value)) return null
  if (value.changed !== true) return null
  const turnNumber = typeof turn.turn === 'number' && Number.isSafeInteger(turn.turn) && turn.turn >= 1 ? turn.turn : null
  return { turn: turnNumber, seq: eventSeq(value.seq) }
}

/**
 * Whether a Turn Location says this Turn changed files.
 * @param turn - turn location.
 * @returns true when the definition published a change.
 */
export function turnChangedFiles(turn: TrackedTurn | null | undefined): boolean {
  return turnChanges(turn) !== null
}
