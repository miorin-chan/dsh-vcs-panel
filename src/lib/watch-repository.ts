import { opendir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sameRepoPath } from './paths.js'
import type { VcsBackend } from './vcs/index.js'
import type { FileListener, FileWatches } from './watch-files.js'
import { watchChildTree } from './watch-files.js'

export const WORKING = 'working'
export const HISTORY = 'history'
export const REPOSITORIES = 'repositories'
export const REFS = [WORKING, HISTORY]

const METADATA_NOISE = /(?:^|\/)(?:\.fswatch[^/]*|\.cookie[^/]*|\.git-cookie[^/]*|\.watchman-cookie-[^/]*|[^/]*\.lock|tmp_[^/]*)($|\/)/u
const INDEX_STATE = new Set(['index', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer'])
const SHARED_REFS = new Set(['packed-refs', 'shallow', 'config', 'reftable'])
const MAX_PENDING_PATHS = 128
const PATH_BATCH_MS = 45
const OP_HEADS_MAX = 512
const OP_ID = /^[a-f0-9]{128}$/u

/** One repository the refresh hub watches. */
export interface WatchedRepository {
  /** Canonical repository root. */
  root: string
  /** Backend id. */
  vcs: string
  /** The backend that reads this repository. */
  backend: VcsBackend
}

/** One watcher notification: which view domains changed. */
export type WatchReceive = (changes: readonly string[]) => void

/** Register a stop function that runs when the subscription ends. */
export type WatchKeep = (stop: (() => void) | null) => void

/** What one repository watch arms. */
export interface RepositoryWatchTarget {
  /** The selected repository. */
  repo: WatchedRepository
  /** Selected checkout roots, anchor first. */
  roots: string[]
  /** The repository's common directory, when it has one. */
  common: string | null
  /** Receive changed view domains. */
  receive: WatchReceive
  /** Cancellation for the subscription. */
  signal: AbortSignal
  /** Register a stop function with the owning stream. */
  keep: WatchKeep
}

/** One checkout's root and its own metadata directory. */
interface GitTarget {
  root: string
  gitDir: string | null
}

/** Whether a repository-relative path belongs in the working-tree view. */
function worktreePath(path: string): boolean {
  return path !== '.' && !path.split('/').some(part => part === '.git' || part === '.jj' || part.startsWith('.watchman-cookie-'))
}

/** Whether a metadata-relative path carries state the panel shows. */
function metadataPath(path: string): boolean {
  return path !== '.' && !METADATA_NOISE.test(path)
}

/** Watch one checkout's working tree, batching backend-ignored paths out. */
function gitWorktree(
  files: FileWatches,
  root: string,
  backend: VcsBackend,
  receive: WatchReceive,
  signal: AbortSignal,
  keep: WatchKeep,
): Promise<() => void> {
  let pending = new Set<string>()
  let overflow = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  async function visible(paths: string[]): Promise<string[]> {
    if (typeof backend.ignoredPaths !== 'function') return paths
    try {
      const ignored = await backend.ignoredPaths(root, paths, signal)
      return paths.filter(path => !ignored.has(path))
    } catch {
      // A rename or submodule boundary can make check-ignore reject a batch.
      return paths
    }
  }

  function schedule() {
    if (timer !== undefined || running || signal.aborted || (!overflow && pending.size === 0)) return
    timer = setTimeout(async () => {
      timer = undefined
      running = true
      const paths = pending
      const unknown = overflow
      pending = new Set()
      overflow = false
      if (unknown || (await visible([...paths])).length > 0) {
        if (!signal.aborted) receive([WORKING])
      }
      running = false
      schedule()
    }, PATH_BATCH_MS)
    timer.unref?.()
  }

  keep(() => clearTimeout(timer))
  return files.tree(root, (event, path) => {
    if (path !== null && !worktreePath(path)) return
    if (path === null || pending.size >= MAX_PENDING_PATHS) overflow = true
    else pending.add(path)
    schedule()
  }, signal, { include: worktreePath, filterDirectories: visible })
}

/** Watch one ref's directory chain, re-arming when a parent is replaced. */
function watchRef(
  files: FileWatches,
  common: string,
  ref: string,
  receive: WatchReceive,
  signal: AbortSignal,
  domains: readonly string[] = REFS,
): () => void {
  const parts = ref.split('/')
  if (parts.length > 32 || parts.some(part => part === '.' || part === '..' || part === '' || part.includes('\\'))) return () => {}
  const stops: Array<() => void> = []
  let stopped = false
  const rebuild = () => {
    for (const off of stops.splice(0)) off()
    if (stopped || signal.aborted) return
    let path = common
    for (const [index, name] of parts.entries()) {
      const off = files.directory(path, (event, changed) => {
        if (changed !== null && changed !== name) return
        receive(domains)
        if (event === 'rename' && index < parts.length - 1) queueMicrotask(rebuild)
      }, false, true)
      if (off === null) break
      stops.push(off)
      path = join(path, name)
    }
  }
  rebuild()
  return () => {
    stopped = true
    for (const off of stops.splice(0)) off()
  }
}

/** Watch Git's shared metadata and each checkout's private refs. */
async function gitMetadata(
  files: FileWatches,
  common: string,
  targets: GitTarget[],
  backend: VcsBackend,
  receive: WatchReceive,
  signal: AbortSignal,
  keep: WatchKeep,
): Promise<void[]> {
  const setups: Array<Promise<void>> = []
  const exact = new Map<string, () => void>()
  let refRefresh: ReturnType<typeof setTimeout> | undefined
  let refGeneration = 0
  async function refreshRefs(): Promise<void> {
    if (backend.watchedRefs === undefined || signal.aborted) return
    const generation = ++refGeneration
    const reads: Array<Promise<string[]>> = []
    for (const { root } of targets) reads.push(backend.watchedRefs(root, signal))
    const refs = new Set((await Promise.all(reads)).flat())
    if (generation !== refGeneration || signal.aborted) return
    for (const [ref, off] of exact) {
      if (refs.has(ref)) continue
      off()
      exact.delete(ref)
    }
    for (const ref of refs) {
      if (!exact.has(ref)) exact.set(ref, watchRef(files, common, ref, receive, signal))
    }
  }
  function scheduleRefs() {
    if (refRefresh !== undefined) return
    refRefresh = setTimeout(() => {
      refRefresh = undefined
      void refreshRefs().catch(() => {})
    }, PATH_BATCH_MS)
    refRefresh.unref?.()
  }
  keep(() => {
    clearTimeout(refRefresh)
    for (const off of exact.values()) off()
    exact.clear()
  })
  const onRef: FileListener = (_event, path) => {
    if (path === null) receive(REFS)
    else if (metadataPath(path)) receive([HISTORY])
  }
  const onDiscovery: FileListener = (_event, path) => {
    if (path === null || (metadataPath(path) && (/^[^/]+$/u.test(path) || /\/(?:gitdir|commondir|locked)$/u.test(path)))) {
      receive([REPOSITORIES])
    }
  }
  const seen = new Set<string>()
  for (const { gitDir } of targets) {
    if (gitDir === null || seen.has(gitDir)) continue
    seen.add(gitDir)
    keep(files.directory(gitDir, (_event, path) => {
      if (path === null || path === 'HEAD' || path === 'config.worktree') {
        receive(REFS)
        scheduleRefs()
      } else if (metadataPath(path) && INDEX_STATE.has(path)) receive([WORKING])
    }, false, true))
    // Private per-worktree refs (e.g. bisect and worktree namespace).
    if (!sameRepoPath(gitDir, common)) {
      setups.push(watchChildTree(files, gitDir, 'refs', onRef, signal, { include: metadataPath }).then(keep))
    }
  }
  keep(files.directory(common, (_event, path) => {
    if (path === null || (metadataPath(path) && SHARED_REFS.has(path))) receive(REFS)
    if (path === null || path === 'config' || path === 'packed-refs') scheduleRefs()
  }, false, true))
  await refreshRefs().catch(() => {})
  if (signal.aborted) return await Promise.all(setups)
  setups.push(watchChildTree(files, common, 'refs', onRef, signal, { include: metadataPath }).then(keep))
  // refs/stash is covered by the refs tree. Dropping an older entry can change
  // only its reflog; watch that path even before the first stash creates it.
  keep(watchRef(files, common, 'logs/refs/stash', receive, signal, [HISTORY]))
  setups.push(watchChildTree(files, common, 'reftable', (_event, path) => {
    if (path === null || metadataPath(path)) receive(REFS)
  }, signal, { include: metadataPath }).then(keep))
  setups.push(watchChildTree(files, common, 'info', (_event, path) => {
    if (path === null || path === 'exclude') receive([WORKING])
    if (path === 'grafts') receive(REFS)
  }, signal, { depth: 0 }).then(keep))
  setups.push(watchChildTree(files, common, 'worktrees', onDiscovery, signal, { depth: 1, include: metadataPath }).then(keep))
  return Promise.all(setups)
}

/** Read a bounded operation-head signature only when arming or signalled. */
async function operationHeads(common: string, signal: AbortSignal): Promise<string | null> {
  let visited = 0
  const heads: string[] = []
  try {
    const dir = await opendir(join(common, 'op_heads', 'heads'))
    for await (const entry of dir) {
      if (signal.aborted || visited++ >= OP_HEADS_MAX) return null
      if (entry.isFile() && OP_ID.test(entry.name)) heads.push(entry.name)
    }
  } catch {
    return null
  }
  return heads.sort().join(':')
}

/** Watch Jujutsu's operation store and report a changed head signature. */
async function watchJujutsu(
  files: FileWatches,
  common: string,
  receive: WatchReceive,
  signal: AbortSignal,
  keep: WatchKeep,
): Promise<() => Promise<void>> {
  let signature = await operationHeads(common, signal)
  let pending: Promise<void> | undefined
  async function check(): Promise<void> {
    if (pending !== undefined) await pending
    if (signal.aborted) return
    if (pending !== undefined) return pending
    pending = operationHeads(common, signal).then(next => {
      if (!signal.aborted && (next === null || signature !== next)) receive([WORKING, HISTORY, REPOSITORIES])
      signature = next
    }).finally(() => { pending = undefined })
    return pending
  }
  // Jujutsu changes heads through directory entries. The parent watch re-arms
  // notifications if the store is replaced atomically. Compare head IDs so
  // delayed OS notifications for the same operation do not trigger rereads.
  await watchChildTree(files, common, 'op_heads', (_event, path) => {
    if (path === null || OP_ID.test(path.slice(path.lastIndexOf('/') + 1))) void check()
  }, signal).then(keep)
  return check
}

/** Arm the selected checkout paths and their shared metadata. */
export async function watchRepository(
  files: FileWatches,
  { repo, roots, common, receive, signal, keep }: RepositoryWatchTarget,
): Promise<(() => Promise<void>) | undefined> {
  if (repo.vcs === 'git') {
    const targets = await Promise.all(roots.map(async root => ({ root, gitDir: await repo.backend.gitDir?.(root, signal) ?? null })))
    if (signal.aborted) return
    const metadata = common === null ? null : gitMetadata(files, common, targets, repo.backend, receive, signal, keep)
    await Promise.all([metadata, ...targets.map(({ root }) => gitWorktree(files, root, repo.backend, receive, signal, keep).then(keep))])
  } else if (repo.vcs === 'jujutsu' && common !== null) {
    return await watchJujutsu(files, common, receive, signal, keep)
  }
}

/** Watch session-level discovery inputs, including initial repository creation. */
export async function watchDiscovery(
  files: FileWatches,
  cwd: string,
  empty: boolean,
  receive: WatchReceive,
  signal: AbortSignal,
  keep: WatchKeep,
): Promise<void> {
  const onConfig: FileListener = (_event, path) => {
    if (path === null || path === 'vcs-panel.json') receive([REPOSITORIES])
  }
  await watchChildTree(files, cwd, '.dsh', onConfig, signal, { depth: 0 }).then(keep)
  if (!empty || signal.aborted) return
  const parent = dirname(cwd)
  keep(files.directory(parent, (event, path) => {
    if (event === 'rename' && path !== null && sameRepoPath(join(parent, path), cwd)) receive([REPOSITORIES])
  }))
  await files.tree(cwd, (event, path) => {
    if (event === 'rename' && (path === null || !path.includes('/') || /\/(?:\.git|\.jj)$/u.test(path))) receive([REPOSITORIES])
  }, signal, { depth: 1, include: path => !path.split('/').includes('node_modules') }).then(keep)
}
