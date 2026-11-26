/** Attribute recorded turn changes to the graphs that this session can open. */
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isPathWithin } from './paths.js'
import { markersAt } from './repositories.js'

interface GraphRepository {
  path: string
  name: string
  worktrees?: readonly { path: string }[]
}

/** Only repository identities already available in the panel leave the Host. */
export interface TurnRepository {
  path: string
  name: string
  files: number
}

/** Bound lookup work even when the recorder's configurable listing cap is raised. */
const MAX_FILES = 500
const MAX_DEPTH = 64

export async function recommendTurnRepositories(
  ctx: Context, cwd: string, files: readonly { path?: string }[], repositories: readonly GraphRepository[], signal: AbortSignal,
): Promise<TurnRepository[]> {
  const roots = new Map<string, GraphRepository>()
  for (const repo of repositories) {
    roots.set(repo.path, repo)
    for (const tree of repo.worktrees ?? []) if (!roots.has(tree.path)) roots.set(tree.path, repo)
  }
  const admitted = [...roots.keys()]
  const memo = new Map<string, GraphRepository | null>(roots)
  const seen = new Set<string>()
  const counts = new Map<GraphRepository, number>()
  for (const file of files.slice(0, MAX_FILES)) {
    signal.throwIfAborted()
    const path = file?.path
    if (typeof path !== 'string' || path === '' || path.includes('\0')) continue
    const absolute = resolve(cwd, path)
    if (!isAbsolute(path) && !isPathWithin(cwd, absolute)) continue
    if (seen.has(absolute) || (!roots.has(absolute) && !admitted.some(root => isPathWithin(root, absolute)))) continue
    // The recorder already canonicalizes captured paths. Keep the recorded path
    // for deleted files and symlink entries instead of resolving today's target.
    seen.add(absolute)
    const visited: string[] = []
    let owner: GraphRepository | null = null
    let directory = roots.has(absolute) ? absolute : dirname(absolute)
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const known = memo.get(directory)
      if (known !== undefined) {
        owner = known
        break
      }
      visited.push(directory)
      const name = directory.split(sep).at(-1)
      // An unlisted nested repository must not be attributed to its parent.
      if (name === '.git' || name === '.jj' || (await markersAt(ctx, directory, signal)).length > 0) break
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    // A depth-budget miss is not a result for nearer descendants of a root.
    if (visited.length < MAX_DEPTH) for (const path of visited) memo.set(path, owner)
    if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  // Stable sort keeps the panel's discovery order for ties, without inspecting
  // unrelated pre-existing changes merely to rank this turn's recommendations.
  return repositories.flatMap(repo => {
    const count = counts.get(repo)
    return count === undefined ? [] : [{ path: repo.path, name: repo.name, files: count }]
  }).sort((a, b) => b.files - a.files)
}
