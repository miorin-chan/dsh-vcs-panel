import type { TreeRow } from './tree.js'

/** Compare JSON values from the Host, including line staging fingerprints and index identity. */
function samePayload(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  const rightRecord = right as Record<string, unknown>
  const leftRecord = left as Record<string, unknown>
  return keys.length === Object.keys(rightRecord).length
    && keys.every(key => Object.hasOwn(rightRecord, key) && samePayload(leftRecord[key], rightRecord[key]))
}

/** One result a comparison request answered with, before it is adopted. */
export interface ComparisonResult {
  target: string
  status: string
  diff: unknown
}

/** The identity fields one comparison keeps across refreshes. */
export interface ComparisonRequestIdentity {
  load: unknown
  revision: number
}

/** One complete comparison answer and the request identity that produced it. */
export interface ComparisonAnswer<Request extends ComparisonRequestIdentity, Result extends ComparisonResult> {
  request: Request
  results: Result[]
}

/** Adopt one complete answer while keeping the identity of any unchanged sources. */
export function adoptComparison<Request extends ComparisonRequestIdentity, Result extends ComparisonResult>(
  shown: ComparisonAnswer<Request, Result> | null,
  loaded: ComparisonAnswer<Request, Result> | null,
  request: Request,
  defer: boolean,
): ComparisonAnswer<Request, Result> | null {
  if (loaded?.request !== request || loaded === shown) return shown
  if (shown === null || shown.request.load !== request.load || shown.request.revision !== request.revision) return loaded
  const existing = new Map(shown.results.map(result => [result.target, result]))
  const results = loaded.results.map(result => {
    const previous = existing.get(result.target)
    return previous?.status === result.status && samePayload(previous.diff, result.diff) ? previous : result
  })
  const unchanged = results.length === shown.results.length && results.every((result, index) => result === shown.results[index])
  if (unchanged) {
    return shown.request === request ? shown : { ...loaded, results: shown.results }
  }
  return defer ? shown : { ...loaded, results }
}

/** The render ancestry for each file, including compressed directories and group wrappers. */
function fileParents(rows: readonly TreeRow[]): Map<string, string> {
  const parents = new Map<string, string>()
  const dirs: string[] = []
  let group: string | null = null
  for (const row of rows) {
    if (row.kind === 'group') {
      group = row.key
      dirs.length = 0
      continue
    }
    dirs.length = row.depth
    if (row.kind === 'dir') dirs.push(row.key)
    if (row.kind === 'file') parents.set(row.key, JSON.stringify([group, ...dirs]))
  }
  return parents
}

/** Whether changing tree structure would unmount an interacting file. */
export function keepsActiveFiles(previous: readonly TreeRow[], next: readonly TreeRow[], activeFiles: ReadonlySet<string>): boolean {
  if (previous === next || activeFiles.size === 0) return true
  const before = fileParents(previous)
  const after = fileParents(next)
  for (const key of activeFiles) {
    if (before.has(key) && before.get(key) !== after.get(key)) return false
  }
  return true
}
