/** Compare JSON values from the Host, including line staging fingerprints and index identity. */
function samePayload(left, right) {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && samePayload(left[key], right[key]))
}

/** Adopt one complete answer while keeping the identity of any unchanged sources. */
export function adoptComparison(shown, loaded, request, defer) {
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
function fileParents(rows) {
  const parents = new Map()
  const dirs = []
  let group = null
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
export function keepsActiveFiles(previous, next, activeFiles) {
  if (previous === next || activeFiles.size === 0) return true
  const before = fileParents(previous)
  const after = fileParents(next)
  for (const key of activeFiles) {
    if (before.has(key) && before.get(key) !== after.get(key)) return false
  }
  return true
}
