/**
 * A small first-in, first-out request queue with a concurrency limit.
 *
 * The diff stream asks for one comparison per section as sections approach
 * the viewport. The queue keeps at most `limit` requests in flight, and a
 * section that scrolls away before its turn leaves the queue without ever
 * reaching the Host.
 */

/** One queued task and whether the queue already started it. */
interface QueueJob {
  task: () => Promise<unknown>
  started: boolean
}

/** A queue of cancellable tasks running at most `limit` at once. */
export interface RequestQueue {
  enqueue(task: () => Promise<unknown>): () => void
  readonly running: number
  readonly waiting: number
}

/**
 * Create a queue.
 * @param limit - tasks running at once.
 * @returns the queue.
 */
export function createQueue(limit: number): RequestQueue {
  let running = 0
  const waiting: QueueJob[] = []

  const pump = () => {
    while (running < limit && waiting.length > 0) {
      const job = waiting.shift()
      if (job === undefined) return
      job.started = true
      running += 1
      Promise.resolve()
        .then(job.task)
        .catch(() => {
          // The task reports its own failure; the queue only frees the slot.
        })
        .finally(() => {
          running -= 1
          pump()
        })
    }
  }

  return {
    /**
     * Add a task.
     * @param task - starts the request when called.
     * @returns removes the task if it has not started.
     */
    enqueue(task: () => Promise<unknown>): () => void {
      const job = { task, started: false }
      waiting.push(job)
      pump()
      return () => {
        if (job.started) return
        const index = waiting.indexOf(job)
        if (index >= 0) waiting.splice(index, 1)
      }
    },
    get running() {
      return running
    },
    get waiting() {
      return waiting.length
    },
  }
}
