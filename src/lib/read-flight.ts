import { abortError } from './errors.js'

/** One in-flight read for one root, shared by its waiters. */
interface Flight<T> {
  /** Aborts the read when every waiter has gone away. */
  controller: AbortController
  /** How many requests currently await this read. */
  waiters: number
  /** True once a write invalidated this read; the next request starts fresh. */
  stale: boolean
  /** The read's own result. */
  result: Promise<T>
}

/** Coalesced reads keyed by a working-directory or repository root. */
export interface ReadFlight<T> {
  /**
   * Read one root's status, sharing an in-flight read.
   * @param root - repository root.
   * @param run - the read itself.
   * @param signal - request cancellation.
   * @returns the read's result.
   */
  read(root: string, run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>
  /** Mark the root's in-flight read stale so the next request replaces it. */
  invalidate(root: string): void
}

/** One inner read per root, with independently cancellable callers. */
export function createReadFlight<T>(): ReadFlight<T> {
  const byRoot = new Map<string, Flight<T>>()

  function wait(flight: Flight<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      flight.waiters += 1
      const onAbort = () => settle(reject, abortError())
      function settle<R>(callback: (value: R) => void, value: R): void {
        signal.removeEventListener('abort', onAbort)
        flight.waiters -= 1
        if (flight.waiters === 0) flight.controller.abort()
        callback(value)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      flight.result.then(
        value => { if (!signal.aborted) settle(resolve, value) },
        error => { if (!signal.aborted) settle(reject, error) },
      )
    })
  }

  async function read(root: string, run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let flight = byRoot.get(root)
    if (flight?.stale || flight?.controller.signal.aborted) {
      try {
        await wait(flight, signal)
      } catch {
        // A superseded read can fail or abort while the next read is waiting.
      }
      return read(root, run, signal)
    }
    if (flight === undefined) {
      const controller = new AbortController()
      flight = {
        controller,
        waiters: 0,
        stale: false,
        result: Promise.resolve().then(() => run(controller.signal)).finally(() => byRoot.delete(root)),
      }
      byRoot.set(root, flight)
    }
    return wait(flight, signal)
  }

  return {
    read,
    invalidate(root: string): void {
      const flight = byRoot.get(root)
      if (flight !== undefined) flight.stale = true
    },
  }
}
