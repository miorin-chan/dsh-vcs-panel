/**
 * Host half of `dsh-vcs-panel`.
 *
 * Authenticated routes under `/api/vcs.*` expose one repository's
 * working changes, a single file's hunks, its history, each turn's recorded
 * head and change totals, its local branches, and its remotes, plus an
 * overview of every discovered repository's pointers. Repository
 * management reads and writes discovery rules and Git/Jujutsu backend choices
 * owned by the session directory.
 * Version control write routes settle what the panel shows: `POST /api/vcs.sync` brings a Git branch
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
 * rewritten. The backend is chosen by the repository's configured preference
 * when its marker exists, else by marker precedence (Jujutsu before Git), and
 * runs through the injected subprocess service with fixed argv.
 */

import type { ConnectionFetchMethod } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'

import { createHandlers } from '../lib/handlers.js'
import type { RouteHandler, VcsRouteHandlers } from '../lib/handlers.js'
import { createTurnTracker } from '../lib/turns.js'
import { createBackends } from '../lib/vcs/index.js'
import { createWatchHub } from '../lib/watch.js'

export { createHandlers } from '../lib/handlers.js'
export { createTurnTracker } from '../lib/turns.js'

/**
 * Services required: authenticated routes, session working directories,
 * backend execution, and filesystem containment.
 */
export const inject = ['connection', 'sessions', 'subprocess', 'fs']

/** The methods a route can own. */
type RouteMethod = Extract<ConnectionFetchMethod, 'GET' | 'POST'>

/** One route: a single method-to-handler pair, or a method map for several. */
interface RouteEntry {
  readonly path: string
  readonly key?: keyof VcsRouteHandlers
  readonly method?: RouteMethod
  readonly handlers?: Readonly<Partial<Record<RouteMethod, keyof VcsRouteHandlers>>>
}

/**
 * Connection registers each exact path once, with all methods for that path.
 * A read follows the browser request and stops when the browser leaves; a
 * write runs to completion once started, bounded only by the plugin lifetime,
 * so a closed tab never cuts a push, fast-forward, or switch short.
 */
const ROUTES: readonly RouteEntry[] = [
  { path: '/api/vcs.repositories', key: 'repositories', method: 'GET' },
  { path: '/api/vcs.repository-config', handlers: { GET: 'repositoryConfig', POST: 'saveRepositoryConfig' } },
  { path: '/api/vcs.repository-preview', key: 'repositoryPreview', method: 'GET' },
  { path: '/api/vcs.overview', key: 'overview', method: 'GET' },
  { path: '/api/vcs.watch', key: 'watch', method: 'GET' },
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
  { path: '/api/vcs.worktree', key: 'worktreeOp', method: 'POST' },
  { path: '/api/vcs.stage', key: 'stage', method: 'POST' },
  { path: '/api/vcs.stage-history', key: 'stageHistory', method: 'POST' },
]

/** The normalized row config. */
export interface VcsPanelConfig {
  readonly enabled: boolean
}

/**
 * Normalize the row config. Only a literal `enabled: false` turns the feature
 * off; a missing or unreadable config leaves the routes registered.
 * @param raw - the config as Cordis supplied it.
 * @returns the normalized config.
 */
export function normalizeConfig(raw: unknown): VcsPanelConfig {
  const enabled = !(raw !== null && typeof raw === 'object' && 'enabled' in raw && raw.enabled === false)
  return { enabled }
}

/** The handler key a route maps one method to; every registered method has one. */
function handlerFor(
  handlers: VcsRouteHandlers,
  byMethod: Readonly<Partial<Record<RouteMethod, keyof VcsRouteHandlers>>>,
  method: string,
): RouteHandler {
  const key = byMethod[method as RouteMethod]
  if (key === undefined) throw new Error(`dsh-vcs-panel: no handler for ${method}`)
  return handlers[key]
}

/**
 * Register the routes and per-turn head observer inside Connection's
 * authentication fence.
 * @param ctx - Host context carrying every injected service.
 * @param config - the row config.
 * @returns nothing; the registrations live as long as the plugin.
 */
export function apply(ctx: Context, config: unknown): void {
  if (!normalizeConfig(config).enabled) return

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-vcs-panel: lifetime')

  const backends = createBackends(ctx)
  const turnTracker = createTurnTracker(ctx, { backends, signal: lifetime.signal })
  ctx.effect(() => turnTracker.attach(), 'dsh-vcs-panel: turn heads')

  const watchHub = createWatchHub(ctx, { signal: lifetime.signal })
  ctx.effect(() => watchHub.attach(), 'dsh-vcs-panel: refresh signals')

  const handlers = createHandlers(ctx, { backends, turnTracker, watchHub })

  for (const route of ROUTES) {
    const byMethod = route.handlers
      ?? (route.method !== undefined && route.key !== undefined ? { [route.method]: route.key } : {})
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: route.path,
        methods: Object.keys(byMethod) as RouteMethod[],
        requestBody: 'buffered',
        fetch: async (request: Request): Promise<Response> => handlerFor(handlers, byMethod, request.method)(
          new Request(request, {
            signal: request.method === 'GET'
              ? AbortSignal.any([request.signal, lifetime.signal])
              : lifetime.signal,
          }),
        ),
      }),
      `dsh-vcs-panel: ${route.path}`,
    )
  }
}
