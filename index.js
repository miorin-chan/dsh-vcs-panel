/**
 * Host half of `dsh-vcs-panel`.
 *
 * Nine authenticated read routes under `/api/vcs.*` expose one repository's
 * working changes, a single file's hunks, its history, each turn's recorded
 * head and change totals, its local branches, and its remotes. Seven write
 * routes settle what the panel shows: `POST /api/vcs.sync` brings a Git branch
 * level with its upstream by fetching and then either fast-forwarding or
 * pushing, `POST /api/vcs.switch` checks out an existing local branch,
 * `POST /api/vcs.branch` runs one local or remote-branch action (rename,
 * delete, merge, rebase, push, checkout-remote, delete-remote, merge-remote,
 * pull-remote), `POST /api/vcs.tag` deletes or pushes a tag, and
 * `POST /api/vcs.commit-op` tags, branches, checks out, cherry-picks, reverts,
 * drops, merges, rebases, or resets at one commit. `POST /api/vcs.stage`
 * stages or unstages a file or selected lines. `POST /api/vcs.stage-history`
 * undoes or redoes those index changes. Reset and drop
 * only follow an explicit dialog. Jujutsu bookmarks and tags are never
 * rewritten. The backend is chosen by the repository's marker (Jujutsu or
 * Git) and runs through the injected subprocess service with fixed argv.
 */

import { createHandlers } from './lib/handlers.js'
import { createTurnTracker } from './lib/turns.js'
import { createBackends } from './lib/vcs/index.js'

export { createHandlers } from './lib/handlers.js'
export { createTurnTracker } from './lib/turns.js'

/**
 * Services required: authenticated routes, session working directories,
 * backend execution, and filesystem containment.
 */
export const inject = ['connection', 'sessions', 'subprocess', 'fs']

/**
 * One entry per registered route, in the order the client asks for them.
 * A read follows the browser request and stops when the browser leaves; a
 * write runs to completion once started, bounded only by the plugin lifetime,
 * so a closed tab never cuts a push, fast-forward, or switch short.
 */
const ROUTES = [
  { path: '/api/vcs.repositories', key: 'repositories', method: 'GET' },
  { path: '/api/vcs.status', key: 'status', method: 'GET' },
  { path: '/api/vcs.branches', key: 'branches', method: 'GET' },
  { path: '/api/vcs.remotes', key: 'remotes', method: 'GET' },
  { path: '/api/vcs.untracked', key: 'untracked', method: 'GET' },
  { path: '/api/vcs.diff', key: 'diff', method: 'GET' },
  { path: '/api/vcs.log', key: 'log', method: 'GET' },
  { path: '/api/vcs.commit', key: 'commit', method: 'GET' },
  { path: '/api/vcs.turn', key: 'turn', method: 'GET' },
  { path: '/api/vcs.sync', key: 'sync', method: 'POST' },
  { path: '/api/vcs.switch', key: 'switchBranch', method: 'POST' },
  { path: '/api/vcs.branch', key: 'branchOp', method: 'POST' },
  { path: '/api/vcs.tag', key: 'tagOp', method: 'POST' },
  { path: '/api/vcs.commit-op', key: 'commitOp', method: 'POST' },
  { path: '/api/vcs.stage', key: 'stage', method: 'POST' },
  { path: '/api/vcs.stage-history', key: 'stageHistory', method: 'POST' },
]

/**
 * Normalize the row config. Only a literal `enabled: false` turns the feature
 * off; a missing or unreadable config leaves the routes registered.
 * @param {unknown} raw - the config as Cordis supplied it.
 * @returns {{ enabled: boolean }} the normalized config.
 */
export function normalizeConfig(raw) {
  return { enabled: !(raw !== null && typeof raw === 'object' && raw.enabled === false) }
}

/**
 * Register the routes and per-turn head observer inside Connection's
 * authentication fence.
 * @param {object} ctx - Host context carrying every injected service.
 * @param {unknown} config - the row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (!normalizeConfig(config).enabled) return

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-vcs-panel: lifetime')

  const backends = createBackends(ctx)
  const turnTracker = createTurnTracker(ctx, { backends, signal: lifetime.signal })
  ctx.effect(() => turnTracker.attach(), 'dsh-vcs-panel: turn heads')

  const handlers = createHandlers(ctx, { backends, turnTracker })

  for (const { path, key, method } of ROUTES) {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: [method],
        requestBody: 'buffered',
        fetch: async request => handlers[key](
          new Request(request, {
            signal: method === 'GET'
              ? AbortSignal.any([request.signal, lifetime.signal])
              : lifetime.signal,
          }),
        ),
      }),
      `dsh-vcs-panel: ${path}`,
    )
  }
}
