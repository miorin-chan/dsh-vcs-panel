/** Read an overview from Jujutsu's recorded view, without snapshotting or merging operations. */

import { isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { canonicalDirectory } from './contain.js'
import { VcsError } from './errors.js'
import { GitRunner } from './git.js'
import type { JujutsuRunner } from './jujutsu.js'
import { parseJjRecords } from './jujutsu.js'
import { discoverJjWorkspaces } from './jujutsu-worktrees.js'
import type { Limiter, OverviewCheckout, OverviewPointer, OverviewRepository } from './overview.js'
import {
  createLimiter, fetchHeadTime, mapLimited, OVERVIEW_CHECKOUT_MAX, OVERVIEW_GRAPH_MAX, OVERVIEW_REF_MAX,
} from './overview.js'
import { isFullSha, repositoryName, sameRepoPath } from './paths.js'
import { gitCommonDirAt } from './worktrees.js'
import type { Worktree } from './worktrees.js'

const FALLBACK_BOOKMARKS = ['main', 'master', 'trunk']
const PLACEHOLDERS = '((empty() & description(exact:"")) ~ merges())'
const ANONYMOUS_HEADS = 'heads(mutable()) ~ ::(bookmarks() | remote_bookmarks() | working_copies())'
const BATCH_SIZE = 64
const COUNT_CONCURRENCY = 4
/** Most operations scanned for the current head and the latest fetch. */
const OPERATION_LOG_MAX = 2000

const BOOKMARK_TEMPLATE = [
  'if(remote != "git", json({',
  '"name" => name, "remote" => remote, "tracked" => tracked, "conflict" => conflict,',
  '"targets" => added_targets.filter(|c| c).map(|c| c.commit_id())',
  '}) ++ "\\n")',
].join(' ')

const SUMMARY_FIELDS = [
  '"sha" => commit_id',
  '"changeId" => change_id.short()',
  '"time" => committer.timestamp().format("%s")',
  '"subject" => description.first_line()',
].join(', ')
const SUMMARY_TEMPLATE = `json({${SUMMARY_FIELDS}}) ++ "\\n"`
const UNSAVED = 'description == "" && parents.len() == 1'
const WORKSPACE_TEMPLATE = [
  `json({${SUMMARY_FIELDS},`,
  `"parents" => parents.map(|p| p.commit_id()), "unsaved" => ${UNSAVED},`,
  `"dirty" => if(${UNSAVED}, diff.files().len(), 0), "conflict" => conflict`,
  '}) ++ "\\n"',
].join(' ')

// Only the current operation id and fetch times need to cross the subprocess boundary.
const OPERATION_TEMPLATE = [
  'if(current_operation, json({"head" => id}) ++ "\\n")',
  '++ if(description.starts_with("fetch from git remote"), json({"fetchTime" => time.end().format("%s")}) ++ "\\n")',
].join(' ')

type Read = (args: string[], maxBytes?: number) => Promise<string>

interface JjBookmark {
  name: string
  remote: string | null
  target: string | null
  tracked: boolean
  conflict: boolean
}

type PresentBookmark = JjBookmark & { target: string }

interface CommitSummary {
  sha: string
  changeId: string
  time: number | null
  subject: string
}

interface WorkspaceCommit extends CommitSummary {
  position: string
  dirty: number
  conflict: boolean
}

interface JjBase {
  sha: string
  name: string
  bookmark?: PresentBookmark
}

interface PointerSeed {
  kind: 'branch' | 'remote' | 'detached'
  name: string
  sha: string
  bookmark?: PresentBookmark
  workspace?: OverviewCheckout
}

function namedBookmark(bookmark: JjBookmark): string {
  return bookmark.remote === null ? bookmark.name : `${bookmark.name}@${bookmark.remote}`
}

function parseBookmarks(stdout: string): JjBookmark[] {
  return parseJjRecords(stdout).flatMap(({ name, remote, targets, tracked, conflict }) => {
    if (typeof name !== 'string' || name === '' || name.includes('\0')
      || (remote !== null && (typeof remote !== 'string' || remote === '' || remote.includes('\0') || remote === 'git'))
      || !Array.isArray(targets) || !targets.every(isFullSha)
      || typeof tracked !== 'boolean' || typeof conflict !== 'boolean') return []
    return [{ name, remote, target: targets[0] ?? null, tracked, conflict }]
  })
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return null
  const time = Number(value)
  return Number.isSafeInteger(time) ? time : null
}

function parseSummaries(stdout: string): CommitSummary[] {
  return parseJjRecords(stdout).flatMap(record => {
    const summary = commitSummary(record)
    return summary === null ? [] : [summary]
  })
}

function commitSummary({ sha, changeId, time, subject }: Record<string, unknown>): CommitSummary | null {
  if (!isFullSha(sha) || typeof changeId !== 'string' || !/^[k-z]+$/u.test(changeId) || typeof subject !== 'string') return null
  return { sha, changeId, time: seconds(time), subject }
}

function parseWorkspaceCommits(stdout: string): WorkspaceCommit[] {
  return parseJjRecords(stdout).flatMap(record => {
    const summary = commitSummary(record)
    const { parents, unsaved, dirty, conflict } = record
    if (summary === null || !Array.isArray(parents) || !parents.every(isFullSha)
      || typeof unsaved !== 'boolean' || typeof conflict !== 'boolean'
      || typeof dirty !== 'number' || !Number.isSafeInteger(dirty) || dirty < 0) return []
    return [{ ...summary, position: unsaved && parents.length === 1 ? parents[0] : summary.sha, dirty, conflict }]
  })
}

function parseRemotes(stdout: string): string[] {
  // No template is available; only take the leading name. A separate push
  // URL, when configured, produces a second row with that same name.
  const names = stdout.split('\n').flatMap(line => {
    const remote = /^([^\s\0]+)[ \t]/u.exec(line)?.[1]
    return remote === undefined || remote === 'git' ? [] : [remote]
  })
  return [...new Set(names)].sort()
}

function resolveBase(trunk: string | null, bookmarks: readonly PresentBookmark[]): JjBase | null {
  if (trunk === null) return null
  if (/^0+$/u.test(trunk)) {
    for (const name of FALLBACK_BOOKMARKS) {
      const bookmark = bookmarks.find(ref => ref.remote === null && ref.name === name)
      if (bookmark !== undefined) return { sha: bookmark.target, name, bookmark }
    }
    return null
  }
  const named = bookmarks.filter(ref => ref.target === trunk)
  const bookmark = named.find(ref => ref.remote !== null) ?? named[0]
  return { sha: trunk, name: bookmark === undefined ? 'trunk()' : namedBookmark(bookmark), bookmark }
}

/** Even a bookmark spelled exactly like a hash cannot change which commit we count. */
function revision(sha: string): string {
  if (!isFullSha(sha)) throw new VcsError('internal', 'Jujutsu did not report a full commit id.')
  return `commit_id(${sha})`
}

function log(read: Read, revset: string, template: string, limit?: number, maxBytes?: number): Promise<string> {
  return read(['log', '--no-graph', '-r', revset, ...(limit === undefined ? [] : ['-n', String(limit)]), '-T', template], maxBytes)
}

function countDots(stdout: string): number {
  if (!/^\.*$/u.test(stdout)) throw new VcsError('internal', 'Jujutsu did not report an overview count.')
  return stdout.length
}

async function readWorkspaces(
  ctx: Context, runner: JujutsuRunner, root: string, operation: string, signal: AbortSignal, read: Read,
): Promise<{ workspaces: Worktree[], commits: WorkspaceCommit[], truncated: boolean }> {
  const workspaces: Worktree[] = []
  let truncated = false
  for await (const tree of discoverJjWorkspaces(ctx, runner, root, signal, { operation })) {
    if (workspaces.length === OVERVIEW_CHECKOUT_MAX) {
      truncated = true
      break
    }
    workspaces.push(tree)
  }
  const heads = [...new Set(workspaces.flatMap(tree => tree.head === null ? [] : [tree.head]))]
  // Versions without recorded paths can still read the anchor's own @.
  const commits = parseWorkspaceCommits(await log(read, heads.length === 0 ? 'present(@)' : heads.map(revision).join(' | '), WORKSPACE_TEMPLATE))
  if (workspaces.length === 0 && commits.length === 1) {
    const primary = (await ctx.fs.lstat(join(root, '.jj', 'repo'), undefined, signal))?.type === 'directory'
    workspaces.push({ path: root, head: commits[0].sha, primary })
  }
  return { workspaces, commits, truncated }
}

/** Only a Git directory actually shared with a workspace contributes FETCH_HEAD. */
async function readColocatedFetch(
  ctx: Context, workspaces: readonly Worktree[], read: Read, signal: AbortSignal,
): Promise<number | null> {
  let gitDir: string | null = null
  for (const { path } of workspaces) {
    const marker = join(path, '.git')
    const info = await ctx.fs.lstat(marker, undefined, signal)
    if (info === undefined) continue
    if (gitDir === null) {
      const stdout = await read(['git', 'root'])
      const raw = stdout.endsWith('\n') ? stdout.slice(0, -1) : ''
      if (!isAbsolute(raw) || raw.includes('\0')) return null
      gitDir = await canonicalDirectory(ctx, raw, signal)
      if (gitDir === null) return null
    }
    const git = info.type === 'directory' ? null : new GitRunner(ctx)
    const common = git === null ? marker : await git.resolve(signal) === null ? null : await gitCommonDirAt(git, path, signal)
    const canonical = common === null ? null : await canonicalDirectory(ctx, common, signal)
    if (canonical !== null && sameRepoPath(canonical, gitDir)) return fetchHeadTime(gitDir)
  }
  return null
}

export interface JjOverviewOptions {
  ctx: Context
  runner: JujutsuRunner
  root: string
  registered: boolean
  signal: AbortSignal
  statusLimiter?: Limiter
}

/** A repository-wide view at one operation, with counts shared by pointers at the same commit. */
export async function readJjOverview(options: JjOverviewOptions): Promise<OverviewRepository> {
  const { ctx, runner, root, registered, signal } = options
  const runOptions = { cwd: root, signal }
  const operations = parseJjRecords((await runner.ok(
    ['--ignore-working-copy', '--at-op=@', 'op', 'log', '--no-graph', '-n', String(OPERATION_LOG_MAX), '-T', OPERATION_TEMPLATE], runOptions,
  )).stdout)
  const heads = operations.flatMap(({ head }) => typeof head === 'string' && /^[0-9a-f]{128}$/u.test(head) ? [head] : [])
  if (heads.length !== 1) throw new VcsError('internal', 'Jujutsu did not report one current operation.')
  // A plain --ignore-working-copy may still reconcile divergent operation
  // heads. Pin every read to the same recorded operation instead.
  const operation = heads[0]
  const argsAtOperation = ['--ignore-working-copy', `--at-op=${operation}`]
  const read: Read = async (args, maxBytes) => (await runner.ok([...argsAtOperation, ...args], { ...runOptions, maxBytes })).stdout

  const [bookmarkOut, workspaceFacts, remotesOut, tagOut, trunkOut, anonymousOut] = await Promise.all([
    read(['bookmark', 'list', '--all-remotes', '--sort', 'name', '-T', BOOKMARK_TEMPLATE]),
    readWorkspaces(ctx, runner, root, operation, signal, read),
    read(['git', 'remote', 'list']),
    runner.run([...argsAtOperation, 'tag', 'list', '-T', '"."'], { ...runOptions, maxBytes: OVERVIEW_GRAPH_MAX + 1 }),
    log(read, 'present(trunk())', 'commit_id ++ "\\n"', 2),
    log(read, `${ANONYMOUS_HEADS} ~ ${PLACEHOLDERS}`, SUMMARY_TEMPLATE, OVERVIEW_REF_MAX + 1),
  ])
  const bookmarks = parseBookmarks(bookmarkOut)
  const present = bookmarks.filter((bookmark): bookmark is PresentBookmark => bookmark.target !== null)
  const listed = present.slice(0, OVERVIEW_REF_MAX)
  const anonymous = parseSummaries(anonymousOut)
  const remotes = parseRemotes(remotesOut)
  if (tagOut.exitCode !== 0) throw new VcsError('internal', 'The Jujutsu tags could not be read.')
  const tags = countDots(tagOut.stdout)
  let truncated = present.length > listed.length || anonymous.length > OVERVIEW_REF_MAX
    || workspaceFacts.truncated || tagOut.lossy || tags > OVERVIEW_GRAPH_MAX
  const trunk = trunkOut.trim() || null
  if (trunk !== null && !isFullSha(trunk)) throw new VcsError('internal', 'Jujutsu did not report one trunk commit.')
  const base = resolveBase(trunk, present)

  const commits = new Map(workspaceFacts.commits.map(commit => [commit.sha, commit]))
  const checkouts: OverviewCheckout[] = workspaceFacts.workspaces.map(tree => {
    const commit = tree.head === null ? undefined : commits.get(tree.head)
    if (commit === undefined) throw new VcsError('internal', 'A Jujutsu workspace commit could not be read.')
    return {
      path: tree.path, head: commit.position, workingCopy: commit.sha,
      branch: listed.find(ref => ref.remote === null && ref.target === commit.position)?.name ?? null,
      primary: tree.primary === true, locked: false, dirty: commit.dirty,
      operation: commit.conflict ? 'conflict' : null,
    }
  })
  // The shared pointer shape has one occupant. When several workspaces share
  // a position, prefer a conflict or unsaved changes over a clean checkout.
  const occupants = [...checkouts].sort((a, b) => Number(b.operation !== null) - Number(a.operation !== null)
    || (b.dirty ?? 0) - (a.dirty ?? 0) || Number(b.primary) - Number(a.primary))
  const seeds: PointerSeed[] = [
    ...listed.map((bookmark): PointerSeed => ({
      kind: bookmark.remote === null ? 'branch' : 'remote',
      name: namedBookmark(bookmark), sha: bookmark.target, bookmark,
      workspace: bookmark.remote === null ? occupants.find(tree => tree.head === bookmark.target) : undefined,
    })),
    ...checkouts.flatMap((workspace): PointerSeed[] => workspace.branch === null && workspace.head !== null
      ? [{ kind: 'detached', name: workspace.path, sha: workspace.head, workspace }] : []),
    ...anonymous.slice(0, OVERVIEW_REF_MAX).map((head): PointerSeed => ({ kind: 'detached', name: head.changeId, sha: head.sha })),
  ]

  const summaries = new Map([...commits.values(), ...anonymous].map(commit => [commit.sha, commit]))
  const remaining = [...new Set(seeds.map(seed => seed.sha))].filter(sha => !summaries.has(sha))
  const fetchHead = readColocatedFetch(ctx, workspaceFacts.workspaces, read, signal)
  const batches = Array.from({ length: Math.ceil(remaining.length / BATCH_SIZE) }, (_, index) => remaining.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE))
  const [fetched, details] = await Promise.all([fetchHead, mapLimited(batches, COUNT_CONCURRENCY, batch =>
    log(read, batch.map(revision).join(' | '), SUMMARY_TEMPLATE, batch.length).then(parseSummaries))])
  for (const summary of details.flat()) summaries.set(summary.sha, summary)
  const fetchedAt = operations.reduce<number | null>((latest, record) => {
    const time = seconds(record.fetchTime)
    return time === null ? latest : Math.max(latest ?? time, time)
  }, fetched)

  const upstreams = new Map<string, JjBookmark>()
  for (const bookmark of bookmarks) {
    if (bookmark.remote === null || !bookmark.tracked) continue
    const current = upstreams.get(bookmark.name)
    if (current === undefined || (current.target === null && bookmark.target !== null)) upstreams.set(bookmark.name, bookmark)
  }
  const limiter = options.statusLimiter ?? createLimiter(COUNT_CONCURRENCY)
  const counts = new Map<string, Promise<number>>()
  function count(revset: string): Promise<number> {
    let pending = counts.get(revset)
    if (pending === undefined) {
      pending = limiter.run(async () => {
        const n = countDots(await log(read, `(${revset}) ~ ${PLACEHOLDERS}`, '"."', OVERVIEW_GRAPH_MAX + 1, OVERVIEW_GRAPH_MAX + 1))
        if (n > OVERVIEW_GRAPH_MAX) truncated = true
        return Math.min(n, OVERVIEW_GRAPH_MAX)
      })
      counts.set(revset, pending)
    }
    return pending
  }
  function distance(from: string, to: string): Promise<number> {
    return from === to ? Promise.resolve(0) : count(`${revision(from)}..${revision(to)}`)
  }

  const pointers = await mapLimited(seeds, COUNT_CONCURRENCY, async (seed): Promise<OverviewPointer> => {
    const { kind, name, sha, bookmark, workspace } = seed
    const summary = summaries.get(sha)
    if (summary === undefined) throw new VcsError('internal', 'A Jujutsu pointer commit could not be read.')
    const upstream = kind === 'branch' ? upstreams.get(name) : undefined
    const [ahead, behind, track] = await Promise.all([
      base === null ? null : distance(base.sha, sha),
      base === null ? null : distance(sha, base.sha),
      upstream === undefined ? null : upstream.target === null ? { ahead: 0, behind: 0, gone: true as const }
        : Promise.all([distance(upstream.target, sha), distance(sha, upstream.target)])
          .then(([ahead, behind]) => ({ ahead, behind })),
    ])
    // Unique work does not depend on a base: without one, a repository with
    // remotes still counts what no remote bookmark reaches.
    const unique = kind === 'remote' || ahead === 0 ? 0
      : remotes.length === 0 ? ahead ?? 0 : await count(`::${revision(sha)} ~ ::remote_bookmarks()`)
    return {
      kind, name, sha, subject: summary.subject, time: summary.time,
      base: base?.name ?? null, isBase: bookmark !== undefined && bookmark === base?.bookmark,
      ahead, behind, unique,
      ...(kind === 'branch' ? { upstream: upstream === undefined ? null : namedBookmark(upstream), track } : {}),
      ...(workspace === undefined ? {} : { checkout: workspace.path }),
      ...(bookmark?.remote != null ? { remote: bookmark.remote, branch: bookmark.name } : {}),
      ...(bookmark?.conflict === true ? { bookmarkConflict: true } : {}),
    }
  })
  return {
    path: root, name: repositoryName(root), vcs: 'jujutsu', registered, supported: true,
    remotes, fetchedAt, baselines: base === null ? [] : [{ name: base.name, ahead: 0, behind: 0 }],
    checkouts, pointers, tags: Math.min(tags, OVERVIEW_GRAPH_MAX), truncated,
  }
}
