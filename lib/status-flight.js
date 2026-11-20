import { abortError } from './errors.js'

/** One Git status read may run per root. Requests and writes have separate lifetimes. */
export function createStatusReader() {
  const byRoot = new Map()

  function wait(flight, signal) {
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      flight.waiters += 1
      const onAbort = () => settle(reject, abortError())
      function settle(callback, value) {
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

  async function read(root, run, signal) {
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
      flight = { controller, waiters: 0, stale: false }
      flight.result = Promise.resolve().then(() => run(controller.signal)).finally(() => byRoot.delete(root))
      byRoot.set(root, flight)
    }
    return wait(flight, signal)
  }

  return {
    read,
    invalidate(root) {
      const flight = byRoot.get(root)
      if (flight !== undefined) flight.stale = true
    },
  }
}
