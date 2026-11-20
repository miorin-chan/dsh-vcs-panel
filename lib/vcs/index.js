/**
 * The version control backends this plugin knows how to read.
 *
 * Discovery is marker-driven: each entry names the directory that marks a
 * repository root. When several markers are present, a configured preference
 * wins if its marker exists; otherwise the first marker found while walking up
 * (and the first marker on a candidate child) wins, so a colocated Jujutsu
 * repository defaults to Jujutsu rather than to its Git side.
 *
 * A backend implements `require`, `status`, `log`, `commit`, `diff`, and
 * optionally `untracked` and `worktrees`, and exposes `capabilities`.
 * The routes and the client never branch on an id.
 */

import { GitBackend } from './git.js'
import { JujutsuBackend } from './jujutsu.js'

/** Backends in precedence order; the marker is enough to identify one. */
export const VCS_BACKENDS = Object.freeze([
  Object.freeze({ id: 'jujutsu', marker: '.jj', create: ctx => new JujutsuBackend(ctx) }),
  Object.freeze({ id: 'git', marker: '.git', create: ctx => new GitBackend(ctx) }),
])

/** Markers discovery tests, in the same precedence order. */
export const VCS_MARKERS = Object.freeze(
  VCS_BACKENDS.map(backend => Object.freeze({ vcs: backend.id, marker: backend.marker })),
)

/**
 * Instantiate every backend once for one Host context.
 * @param {object} ctx - Host context carrying `fs` and `subprocess`.
 * @returns {{ get: (id: string) => object | undefined, list: () => object[] }} the registry.
 */
export function createBackends(ctx) {
  const instances = new Map(VCS_BACKENDS.map(backend => [backend.id, backend.create(ctx)]))
  return {
    get: id => instances.get(id),
    list: () => [...instances.values()],
  }
}
