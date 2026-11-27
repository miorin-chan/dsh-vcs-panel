import type { SyncAnswer } from '../api.js'
import type { RepoWriteResult } from '../useRepoActions.js'

export interface BatchSyncResult {
  succeeded: number
  failed: string[]
  skipped: number
  pushed: number
  pulled: number
}

/** Sync repositories in order, keeping remote operations bounded and independent. */
export async function runBatchSync(
  repositories: readonly string[],
  total: number,
  sync: (repo: string) => Promise<RepoWriteResult<SyncAnswer>>,
): Promise<BatchSyncResult> {
  const targets = new Set(repositories)
  const result: BatchSyncResult = { succeeded: 0, failed: [], skipped: total - targets.size, pushed: 0, pulled: 0 }
  for (const repo of targets) {
    const write = await sync(repo)
    if (!write.started) result.skipped++
    else if (!write.ok) result.failed.push(repo)
    else {
      result.succeeded++
      result.pushed += write.value.pushed
      result.pulled += write.value.pulled
    }
  }
  return result
}
