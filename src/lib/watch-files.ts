import { lstatSync, watch as fsWatch } from 'node:fs'
import type { FSWatcher, WatchEventType } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

const WATCH_MAX = 1_024
const PRIORITY_WATCH_MAX = 1_536
const TREE_WATCH_MAX = 128
const TREE_SCAN_MAX = 8_192
const NATIVE_RECURSION = process.platform === 'darwin' || process.platform === 'win32'

/** One filesystem notification: the OS event and the affected relative path. */
export type FileListener = (event: WatchEventType, path: string | null) => void

/** How one directory tree subscription is bounded. */
export interface TreeOptions {
  /** Whether a relative path belongs in this subscription. */
  include?: (path: string) => boolean
  /** How many levels below the root the subscription follows. */
  depth?: number
  /** Keep only these directories, so backend-ignored folders are never watched. */
  filterDirectories?: (paths: string[]) => Promise<string[]>
}

/** The injected watcher implementation; tests replace the OS watcher. */
export interface FileWatchOptions {
  /** The `fs.watch` in use. */
  watch?: typeof fsWatch
  /** Whether the host supports one native recursive watch per tree. */
  nativeRecursion?: boolean
}

/** The directory and tree subscriptions one Host context shares. */
export interface FileWatches {
  /** Watch one directory; the returned stop is null when the watch was refused. */
  directory(path: string, listener: FileListener, recursive?: boolean, priority?: boolean): (() => void) | null
  /** Watch one tree, arming child directories as they appear. */
  tree(root: string, listener: FileListener, signal: AbortSignal, options?: TreeOptions): Promise<() => void>
}

/** One native watch and the listeners currently using it. */
interface WatchEntry {
  watcher: FSWatcher
  listeners: Set<FileListener>
}

/** Normalize one OS-reported filename into a relative slash path. */
function eventPath(filename: string | Buffer | null): string | null {
  if (typeof filename !== 'string' || filename === '') return null
  if (process.platform === 'win32') filename = filename.split(sep).join('/')
  if (isAbsolute(filename) || filename.split('/').some(part => part === '..' || part === '')) return null
  return filename
}

/** Share native handles, and bound directory enumeration on hosts without native recursion. */
export function createFileWatches(
  { watch = fsWatch, nativeRecursion = NATIVE_RECURSION }: FileWatchOptions = {},
): FileWatches {
  const handles = new Map<string, WatchEntry>()

  function directory(path: string, listener: FileListener, recursive = false, priority = false): (() => void) | null {
    const key = `${recursive ? 'r' : 'd'}:${path}`
    let entry = handles.get(key)
    if (entry === undefined) {
      if (handles.size >= (priority ? PRIORITY_WATCH_MAX : WATCH_MAX)) return null
      const listeners = new Set<FileListener>()
      let watcher: FSWatcher
      try {
        if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return null
        watcher = watch(path, { persistent: false, recursive }, (event, filename) => {
          for (const receive of listeners) receive(event, eventPath(filename))
        })
      } catch {
        return null
      }
      entry = { watcher, listeners }
      handles.set(key, entry)
      watcher.on('error', () => {
        if (handles.get(key) !== entry) return
        handles.delete(key)
        watcher.close()
        for (const receive of listeners) receive('change', null)
        listeners.clear()
      })
    }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0 && handles.get(key) === entry) {
        handles.delete(key)
        entry.watcher.close()
      }
    }
  }

  async function tree(
    root: string,
    listener: FileListener,
    signal: AbortSignal,
    { include = () => true, depth = Infinity, filterDirectories }: TreeOptions = {},
  ): Promise<() => void> {
    if (signal.aborted) return () => {}
    if (nativeRecursion && depth === Infinity) {
      const stop = directory(root, listener, true)
      if (stop !== null) return stop
    }

    const stops = new Map<string, () => void>()
    const childUpdates = new Map<string, number>()
    let stopped = false
    let childUpdateQueued = false
    let chain: Promise<void> = Promise.resolve()
    const stop = () => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      for (const unwatch of stops.values()) unwatch()
      stops.clear()
      childUpdates.clear()
    }
    signal.addEventListener('abort', stop, { once: true })

    function closeSubtree(relative: string) {
      for (const [path, unwatch] of stops) {
        if (path !== relative && !path.startsWith(`${relative}/`)) continue
        unwatch()
        stops.delete(path)
      }
    }

    function scheduleChild(relative: string, level: number) {
      if (childUpdates.size >= TREE_WATCH_MAX) return
      childUpdates.set(relative, level)
      if (childUpdateQueued) return
      childUpdateQueued = true
      chain = chain.then(async () => {
        const pending = [...childUpdates]
        childUpdates.clear()
        childUpdateQueued = false
        for (const [path, childLevel] of pending) {
          if (stopped) return
          closeSubtree(path)
          if (filterDirectories === undefined || (await filterDirectories([path])).length > 0) {
            await scan(path, childLevel)
          }
        }
      }).catch(() => {})
    }

    async function scan(start: string, startLevel: number) {
      const queue: Array<[string, number]> = [[start, startLevel]]
      let visited = 0
      for (const [relative, level] of queue) {
        if (stopped || stops.size >= TREE_WATCH_MAX || visited >= TREE_SCAN_MAX) return
        const path = join(root, relative)
        if (relative !== '' && !(await lstat(path).catch(() => null))?.isDirectory()) continue
        if (stopped) return
        const unwatch = directory(path, (event, name) => {
          if (stopped) return
          const child = relative === '' || name === null ? name : `${relative}/${name}`
          if (child !== null && !include(child)) return
          listener(event, child)
          if (event === 'rename' && child !== null && level < depth) scheduleChild(child, level + 1)
        })
        if (unwatch === null) continue
        stops.set(relative, unwatch)
        if (level === depth) continue
        const children: string[] = []
        try {
          const entries = await opendir(path)
          for await (const entry of entries) {
            if (stopped || ++visited > TREE_SCAN_MAX || children.length >= TREE_WATCH_MAX) break
            if (!entry.isDirectory()) continue
            const child = relative === '' ? entry.name : `${relative}/${entry.name}`
            if (include(child)) children.push(child)
          }
        } catch {
          // Directory gone or unreadable between watch and enumeration.
        }
        const accepted = children.length === 0 || filterDirectories === undefined ? children : await filterDirectories(children)
        for (const child of accepted) {
          if (queue.length >= TREE_WATCH_MAX) break
          queue.push([child, level + 1])
        }
      }
    }

    chain = scan('', 0).catch(() => {})
    await chain
    return stop
  }

  return { directory, tree }
}

/** Watch a child directory that may be created or replaced after subscription. */
export async function watchChildTree(
  files: FileWatches,
  parent: string,
  name: string,
  listener: FileListener,
  signal: AbortSignal,
  options?: TreeOptions,
): Promise<() => void> {
  let stopTree: (() => void) | undefined
  let generation = 0
  const replace = async () => {
    const current = ++generation
    stopTree?.()
    stopTree = undefined
    const path = join(parent, name)
    if (!(await lstat(path).catch(() => null))?.isDirectory() || signal.aborted) return
    const stop = await files.tree(path, listener, signal, options)
    if (current !== generation || signal.aborted) stop()
    else stopTree = stop
  }
  const stopParent = files.directory(parent, (event, path) => {
    if (event !== 'rename' || (path !== name && path !== null)) return
    listener(event, null)
    void replace()
  })
  await replace()
  return () => {
    generation += 1
    stopParent?.()
    stopTree?.()
  }
}
