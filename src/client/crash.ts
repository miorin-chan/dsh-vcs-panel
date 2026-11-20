/**
 * Diagnostic record for an unexpected VCS view failure.
 *
 * The Conversation view is a DSH slot entry: when its render or lifecycle
 * throws, DSH's slot boundary removes ("abdicates") the entry for the rest of
 * the page, which looks like a blank view. The panel's own boundary catches the
 * failure first, shows a retry surface, and keeps the details here so the next
 * occurrence can be inspected without the browser console.
 */

/** `sessionStorage` key of the most recent recorded failure. */
export const CRASH_STORAGE_KEY = 'vcs:last-error'

/** Longest stack or component stack kept in the record, in characters. */
const STACK_LIMIT = 12_000

/** One recorded failure, as the retry surface reads it back. */
export interface CrashRecord {
  /** Epoch milliseconds. */
  time: number
  /** `Name: message`, or a stringified value. */
  message: string
  /** The trimmed error stack. */
  stack: string
  /** The trimmed React component stack. */
  componentStack: string
}

/** The parts of a thrown failure the diagnostic reads. */
interface CrashFailure {
  readonly name?: string
  readonly message?: string
  readonly stack?: string
}

/** Read a caught value as a failure, when it can carry failure fields. */
function failureOf(error: unknown): CrashFailure | null {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? error as CrashFailure
    : null
}

/**
 * The one-line description of a caught error.
 * @param error - the caught value.
 * @returns `Name: message`, or a stringified value.
 */
export function describeCrash(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error'
  if (typeof error === 'string') return error
  const failure = failureOf(error)
  const name = failure !== null && typeof failure.name === 'string' && failure.name !== '' ? failure.name : 'Error'
  const message = failure !== null && typeof failure.message === 'string' ? failure.message : String(error)
  return `${name}: ${message}`
}

/** Trim one potentially long stack. */
function limit(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length <= STACK_LIMIT ? value : `${value.slice(0, STACK_LIMIT)}\n…`
}

/**
 * Record a caught failure.
 *
 * Writing is best-effort: an unavailable or full `sessionStorage` costs only
 * the diagnostic, never the fallback surface.
 *
 * @param storage - a `sessionStorage`-compatible store.
 * @param error - the caught error.
 * @param info - React's error info.
 * @param now - epoch milliseconds, for tests.
 * @returns the record.
 */
export function recordCrash(
  storage: Storage | undefined,
  error: unknown,
  info: { componentStack?: string } | undefined,
  now = Date.now(),
): CrashRecord {
  const failure = failureOf(error)
  const record: CrashRecord = {
    time: now,
    message: describeCrash(error),
    stack: limit(failure?.stack),
    componentStack: limit(info?.componentStack),
  }
  try {
    storage?.setItem(CRASH_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // A diagnostic is optional; the fallback still renders.
  }
  return record
}
