/**
 * The repository overview: every branch, remote branch, detached checkout, and
 * stash of one Git repository, with the four quantities the overview column
 * and the tiled layout draw from (DESIGN.md, 指针的状态由相对基线的距离决定):
 *
 * - base: the candidate trunk `%(is-base:<pointer>)` picks among each remote's
 *   `HEAD` target and the local default branch;
 * - ahead / behind against that base, from `%(ahead-behind:<base>)`;
 * - unique: commits no remote-tracking ref reaches (`--not --remotes`), or for
 *   a repository without remotes the commits off its base;
 * - occupancy: the checkout holding the pointer, its changed-entry count, and
 *   any unfinished rebase, merge, cherry-pick, revert, or bisect.
 *
 * Git older than 2.47 has no `%(is-base:)` and older than 2.41 no
 * `%(ahead-behind:)`; both fall back to `rev-list --left-right --count`.
 * Every command is read-only and runs through the shared `GitRunner`.
 */

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { outputTooLarge, VcsError } from './errors.js'
import type { GitRunner } from './git.js'
import { remoteNames } from './git-utils.js'
import { isFullSha, repositoryName, sameRepoPath } from './paths.js'
import { discoverGitWorktrees, gitCommonDirAt } from './worktrees.js'

/** Most checkouts one repository's overview reads. */
export const OVERVIEW_CHECKOUT_MAX = 51
/** Most branches and remote branches one repository's overview lists. */
export const OVERVIEW_REF_MAX = 2000
/** Most stash entries one repository's overview lists. */
export const OVERVIEW_STASH_MAX = 200
/** Unpublished commits above this count fall back to one count per branch. */
const UNPUBLISHED_GRAPH_MAX = 50_000
/** Pointers per `%(is-base:)` listing, keeping argv short. */
const IS_BASE_BATCH = 64
/** Concurrent fallback counts per repository. */
const FALLBACK_CONCURRENCY = 4

/** Git releases that added the two for-each-ref atoms. */
const AHEAD_BEHIND_VERSION: GitVersion = [2, 41, 0]
const IS_BASE_VERSION: GitVersion = [2, 47, 0]

/** Files whose presence in a checkout's Git directory marks an unfinished operation. */
const OPERATION_FILES: ReadonlyArray<readonly [string, OverviewOperation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

/** Local default branches that count as a trunk when present. */
const DEFAULT_BRANCHES = ['refs/heads/main', 'refs/heads/master']

/** One Git release as `[major, minor, patch]`. */
export type GitVersion = readonly [number, number, number]

/** An unfinished operation in one checkout. */
export type OverviewOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'

/** What kind of pointer a row is. */
export type OverviewPointerKind = 'branch' | 'remote' | 'detached' | 'stash'

/** One checkout of the repository and what occupies it. */
export interface OverviewCheckout {
  path: string
  branch: string | null
  head: string | null
  primary: boolean
  locked: boolean
  /** Changed entries `git status` lists, untracked included; null when unreadable. */
  dirty: number | null
  operation: OverviewOperation | null
}

/** One pointer and its distance from its base. */
export interface OverviewPointer {
  kind: OverviewPointerKind
  /** Branch or `remote/branch` name, stash selector, or the checkout path of a detached head. */
  name: string
  /** Full commit id the pointer names. */
  sha: string
  /** Committer time in seconds, when known. */
  time: number | null
  subject: string
  /** Short name of the trunk this pointer is counted against. */
  base: string | null
  /** Whether the pointer is that trunk itself. */
  isBase: boolean
  ahead: number | null
  behind: number | null
  /** Commits that only this machine has. */
  unique: number
  /** Branch: the configured upstream's short name. */
  upstream?: string | null
  /** Branch with an upstream: its own distance, or `gone` when the upstream ref vanished. */
  track?: { ahead: number, behind: number, gone?: true } | null
  /** Branch or detached head: the checkout holding it. */
  checkout?: string | null
  /** Remote branch: the remote and the branch on it. */
  remote?: string
  branch?: string
  /** Stash: the commit it was made on. */
  onto?: string | null
}

/** One candidate trunk and its distance from the first. */
export interface OverviewBaseline {
  name: string
  ahead: number
  behind: number
}

/** One repository's overview. */
export interface OverviewRepository {
  path: string
  name: string
  vcs: string
  /** Whether the session's discovery rules list the repository. */
  registered: boolean
  /** False for a backend whose pointers the overview does not read yet. */
  supported: boolean
  remotes: string[]
  /** `FETCH_HEAD` modification time in seconds, or null when nothing was fetched. */
  fetchedAt: number | null
  baselines: OverviewBaseline[]
  checkouts: OverviewCheckout[]
  pointers: OverviewPointer[]
  /** Tags are counted, not ranked. */
  tags: number
  /** Whether a list hit its cap. */
  truncated: boolean
}

/** One for-each-ref record of a branch or remote branch. */
export interface RefRecord {
  refname: string
  oid: string
  symref: string
  upstream: string
  upstreamShort: string
  track: string
  time: number | null
  subject: string
}

/** One stash entry. */
export interface StashRecord {
  name: string
  sha: string
  onto: string | null
  time: number | null
  subject: string
}

/** Bounded concurrency shared by the reads of one request. */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>
}

/**
 * A limiter that runs at most `size` tasks at once.
 * @param size - concurrent tasks.
 * @returns the limiter.
 */
export function createLimiter(size: number): Limiter {
  let active = 0
  const waiting: Array<() => void> = []
  return {
    async run(task) {
      if (active >= size) await new Promise<void>(resolve => { waiting.push(resolve) })
      active += 1
      try {
        return await task()
      } finally {
        active -= 1
        waiting.shift()?.()
      }
    },
  }
}

/** Map with bounded concurrency, keeping input order. */
async function mapLimited<TItem, TResult>(
  items: readonly TItem[],
  size: number,
  map: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const limiter = createLimiter(size)
  return Promise.all(items.map(item => limiter.run(() => map(item))))
}

/**
 * Parse `git version` output.
 * @param stdout - for example `git version 2.54.0 (Apple Git-157)`.
 * @returns the release, or null when the text names none.
 */
export function parseGitVersion(stdout: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(stdout.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** Whether `version` is at least `minimum`. */
export function versionAtLeast(version: GitVersion | null, minimum: GitVersion): boolean {
  if (version === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index]
  }
  return true
}

/** for-each-ref fields for the main listing, NUL-separated, one record per line. */
export const REF_FORMAT = [
  '%(refname)', '%(objectname)', '%(symref)', '%(upstream)', '%(upstream:short)',
  '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)',
].join('%00')

/** Parse a unix-seconds field. */
function seconds(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/u.test(text)) return null
  return Number(text)
}

/**
 * Parse the main listing.
 * @param stdout - for-each-ref output in {@link REF_FORMAT}.
 * @returns one record per complete line.
 */
export function parseRefRecords(stdout: string): RefRecord[] {
  return stdout.split('\n').flatMap(line => {
    const fields = line.split('\0')
    if (fields.length < 8) return []
    const [refname, oid, symref, upstream, upstreamShort, track, time, ...subject] = fields
    if (!refname.startsWith('refs/') || !isFullSha(oid)) return []
    return [{ refname, oid, symref, upstream, upstreamShort, track, time: seconds(time), subject: subject.join('\0') }]
  })
}

/**
 * Parse `%(upstream:track,nobracket)`.
 * @param text - `ahead 1, behind 2`, `gone`, or empty when level.
 * @returns the counts, with `gone` when the upstream ref is missing.
 */
export function parseTrack(text: string): { ahead: number, behind: number, gone?: true } {
  if (text.trim() === 'gone') return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/u.exec(text)
  const behind = /behind (\d+)/u.exec(text)
  return { ahead: ahead === null ? 0 : Number(ahead[1]), behind: behind === null ? 0 : Number(behind[1]) }
}

/** stash list fields, NUL-separated, one entry per line. */
export const STASH_FORMAT = '%gd%x00%H%x00%P%x00%ct%x00%gs'

/**
 * Parse `git stash list` in {@link STASH_FORMAT}.
 * @param stdout - command output.
 * @returns the entries, newest first.
 */
export function parseStashList(stdout: string): StashRecord[] {
  return stdout.split('\n').flatMap(line => {
    const [name, sha, parents, time, ...subject] = line.split('\0')
    if (name === undefined || !/^stash@\{\d+\}$/u.test(name) || !isFullSha(sha)) return []
    const onto = parents?.split(' ')[0]
    return [{ name, sha, onto: isFullSha(onto) ? onto : null, time: seconds(time), subject: subject.join('\0') }]
  })
}

/**
 * Count the entries of `git status --porcelain=v2 -z`. A rename or copy record
 * carries its original path as one more NUL-separated field.
 * @param stdout - command output.
 * @returns changed, unmerged, and untracked entries.
 */
export function countStatusEntries(stdout: string): number {
  const fields = stdout.split('\0')
  let count = 0
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.startsWith('1 ') || field.startsWith('u ') || field.startsWith('? ')) count += 1
    else if (field.startsWith('2 ')) {
      count += 1
      index += 1
    }
  }
  return count
}

/**
 * Count, for each tip, the commits it reaches inside the unpublished subgraph.
 * Every commit a branch reaches that no remote reaches is joined to the tip by a
 * path of such commits: a published commit on the way would publish its
 * ancestors too. One graph read therefore answers every branch.
 * @param stdout - `rev-list --parents --branches --not --remotes` output.
 * @param tips - full ids to count from.
 * @returns the count for each tip.
 */
export function unpublishedCounts(stdout: string, tips: readonly string[]): Map<string, number> {
  const parents = new Map<string, string[]>()
  for (const line of stdout.split('\n')) {
    const [sha, ...rest] = line.split(' ')
    if (isFullSha(sha)) parents.set(sha, rest.filter(isFullSha))
  }
  const counts = new Map<string, number>()
  for (const tip of tips) {
    if (counts.has(tip)) continue
    if (!parents.has(tip)) {
      counts.set(tip, 0)
      continue
    }
    const seen = new Set<string>([tip])
    const stack = [tip]
    while (stack.length > 0) {
      for (const parent of parents.get(stack.pop() as string) ?? []) {
        if (parents.has(parent) && !seen.has(parent)) {
          seen.add(parent)
          stack.push(parent)
        }
      }
    }
    counts.set(tip, seen.size)
  }
  return counts
}

/** Short display name of a full ref. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//u, '')
}

/** Parse `rev-list --left-right --count A...B` into `[left, right]`. */
function leftRight(stdout: string): [number, number] | null {
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(stdout)
  return match === null ? null : [Number(match[1]), Number(match[2])]
}

/** What one Git overview read needs from its caller. */
export interface GitOverviewOptions {
  ctx: Context
  git: GitRunner
  root: string
  registered: boolean
  signal: AbortSignal
  /** Shared bound for the per-checkout status reads of one request. */
  statusLimiter?: Limiter
  /** The installed Git release; read once per request. */
  version: GitVersion | null
}

/** Run one read that must succeed, failing with `output-too-large` on a capped stdout. */
async function read(git: GitRunner, root: string, args: string[], signal: AbortSignal): Promise<string | null> {
  const result = await git.run(args, { cwd: root, signal })
  if (result.lossy) throw outputTooLarge()
  return result.exitCode === 0 ? result.stdout : null
}

/**
 * Read the installed Git release.
 * @param git - command runner.
 * @param cwd - any directory to run in.
 * @param signal - cancellation.
 * @returns the release, or null when unreadable.
 */
export async function readGitVersion(git: GitRunner, cwd: string, signal: AbortSignal): Promise<GitVersion | null> {
  const stdout = await read(git, cwd, ['version'], signal)
  return stdout === null ? null : parseGitVersion(stdout)
}

/** Count changed entries and find an unfinished operation in one checkout. */
async function occupancy(
  ctx: Context,
  git: GitRunner,
  path: string,
  signal: AbortSignal,
): Promise<{ dirty: number | null, operation: OverviewOperation | null }> {
  const status = await git.run(['status', '--porcelain=v2', '-z', '--untracked-files=normal'], { cwd: path, signal })
  const dirty = status.exitCode === 0 && !status.lossy ? countStatusEntries(status.stdout) : null
  const gitDir = await read(git, path, ['rev-parse', '--absolute-git-dir'], signal).catch(error => {
    if (signal.aborted) throw error
    return null
  })
  let operation: OverviewOperation | null = null
  const directory = gitDir?.endsWith('\n') === true ? gitDir.slice(0, -1) : null
  if (directory !== null && directory !== '') {
    for (const [file, kind] of OPERATION_FILES) {
      try {
        if (await ctx.fs.lstat(join(directory, file), {}, signal) !== undefined) {
          operation = kind
          break
        }
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
  }
  return { dirty, operation }
}

/** `FETCH_HEAD` modification time of one common directory, in seconds. */
async function fetchedAt(common: string | null): Promise<number | null> {
  if (common === null) return null
  try {
    // The DSH file service reports no modification times; the Host reads this
    // one metadata field directly, as the refresh watcher does for its files.
    const info = await lstat(join(common, 'FETCH_HEAD'))
    return info.isFile() ? Math.round(info.mtimeMs / 1000) : null
  } catch {
    return null
  }
}

/**
 * Pick each pointer's base among the candidates with `%(is-base:)`, one listing
 * per batch of pointers. A pointer no candidate claims counts against the last
 * candidate, the local default branch when there is one.
 */
async function isBaseChoices(
  git: GitRunner,
  root: string,
  candidates: readonly string[],
  revisions: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const choices = new Map<string, string>()
  for (let start = 0; start < revisions.length; start += IS_BASE_BATCH) {
    const batch = revisions.slice(start, start + IS_BASE_BATCH)
    const format = ['%(refname)', ...batch.map(revision => `%(is-base:${revision})`)].join('%00')
    const stdout = await read(git, root, ['for-each-ref', `--format=${format}`, ...candidates], signal)
    for (const line of (stdout ?? '').split('\n')) {
      const [refname, ...marks] = line.split('\0')
      marks.forEach((mark, index) => {
        const revision = batch[index]
        if (mark !== '' && revision !== undefined && !choices.has(revision)) choices.set(revision, refname)
      })
    }
  }
  return choices
}

/**
 * Git before 2.47: count each pointer against every candidate and pick the
 * one it is fewest commits ahead of, then fewest behind. A tie goes to the
 * candidate listed first in ref order, as `%(is-base:)` resolves one.
 */
async function nearestCandidates(
  git: GitRunner,
  root: string,
  candidates: readonly string[],
  revisions: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const choices = new Map<string, string>()
  const ordered = [...candidates].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0))
  await mapLimited(revisions, FALLBACK_CONCURRENCY, async revision => {
    let best: { ref: string, ahead: number, behind: number } | null = null
    for (const ref of ordered) {
      const counts = leftRight(await read(git, root, ['rev-list', '--left-right', '--count', `${revision}...${ref}`], signal) ?? '')
      if (counts === null) continue
      const [ahead, behind] = counts
      if (best === null || ahead < best.ahead || (ahead === best.ahead && behind < best.behind)) best = { ref, ahead, behind }
    }
    if (best !== null) choices.set(revision, best.ref)
  })
  return choices
}

/**
 * Ahead and behind counts of every listed ref against one base, from
 * `%(ahead-behind:)`, or from one `rev-list` per revision on older Git.
 */
async function aheadBehind(
  git: GitRunner,
  root: string,
  base: string,
  revisions: readonly string[],
  modern: boolean,
  signal: AbortSignal,
): Promise<Map<string, [number, number]>> {
  const counts = new Map<string, [number, number]>()
  if (modern) {
    // One listing answers every ref; a detached head no ref names is counted below.
    const stdout = await read(git, root, ['for-each-ref', `--format=%(objectname)%00%(ahead-behind:${base})`, 'refs/heads', 'refs/remotes'], signal)
    const wanted = new Set(revisions)
    for (const line of (stdout ?? '').split('\n')) {
      const [oid, value] = line.split('\0')
      const pair = leftRight(value ?? '')
      if (oid !== undefined && pair !== null && wanted.has(oid)) counts.set(oid, pair)
    }
  }
  const rest = revisions.filter(revision => !counts.has(revision))
  await mapLimited(rest, FALLBACK_CONCURRENCY, async revision => {
    const pair = leftRight(await read(git, root, ['rev-list', '--left-right', '--count', `${revision}...${base}`], signal) ?? '')
    if (pair !== null) counts.set(revision, pair)
  })
  return counts
}

/** Count the commits a revision reaches that the excluded refs do not. */
async function countExcluding(git: GitRunner, root: string, revision: string, exclude: string[], signal: AbortSignal): Promise<number> {
  const stdout = await read(git, root, ['rev-list', '--count', revision, '--not', ...exclude], signal)
  return stdout === null ? 0 : Number(stdout.trim()) || 0
}

/** Unique counts for the local branches of a repository with remotes. */
async function branchUniques(git: GitRunner, root: string, tips: readonly string[], signal: AbortSignal): Promise<Map<string, number>> {
  if (tips.length === 0) return new Map()
  const result = await git.run(['rev-list', '--parents', `--max-count=${UNPUBLISHED_GRAPH_MAX + 1}`, '--branches', '--not', '--remotes'], { cwd: root, signal })
  const lines = result.exitCode === 0 && !result.lossy ? result.stdout.split('\n').filter(line => line !== '').length : Infinity
  if (lines <= UNPUBLISHED_GRAPH_MAX) return unpublishedCounts(result.stdout, tips)
  const counts = new Map<string, number>()
  await mapLimited([...new Set(tips)], FALLBACK_CONCURRENCY, async tip => {
    counts.set(tip, await countExcluding(git, root, tip, ['--remotes'], signal))
  })
  return counts
}

/** Commit time and subject of one detached head. */
async function commitSummary(git: GitRunner, root: string, sha: string, signal: AbortSignal): Promise<{ time: number | null, subject: string }> {
  const stdout = await read(git, root, ['log', '-1', '--format=%ct%x00%s', sha, '--'], signal)
  const [time, ...subject] = (stdout ?? '').replace(/\n$/u, '').split('\0')
  return { time: seconds(time), subject: subject.join('\0') }
}

/**
 * Read one Git repository's overview.
 * @param options - the repository, runner, and shared limits.
 * @returns the overview.
 */
export async function readGitOverview(options: GitOverviewOptions): Promise<OverviewRepository> {
  const { ctx, git, root, registered, signal, version } = options
  const statusLimiter = options.statusLimiter ?? createLimiter(4)
  let truncated = false

  const checkouts: OverviewCheckout[] = []
  for await (const tree of discoverGitWorktrees(ctx, git, root, signal)) {
    if (checkouts.length === OVERVIEW_CHECKOUT_MAX) {
      truncated = true
      break
    }
    checkouts.push({
      path: tree.path, branch: tree.branch ?? null, head: tree.head, primary: tree.primary === true,
      locked: tree.locked === true, dirty: null, operation: null,
    })
  }
  if (checkouts.length === 0) throw new VcsError('not-a-repo', 'The repository could not be read.')
  const [common, remoteList, refsOut, tagsOut, stashOut] = await Promise.all([
    gitCommonDirAt(git, root, signal),
    remoteNames(git, root, signal),
    git.run(['for-each-ref', `--count=${OVERVIEW_REF_MAX + 1}`, `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes'], { cwd: root, signal }),
    git.run(['for-each-ref', '--format=x', 'refs/tags'], { cwd: root, signal }),
    git.run(['stash', 'list', `--max-count=${OVERVIEW_STASH_MAX + 1}`, `--format=${STASH_FORMAT}`], { cwd: root, signal }),
    Promise.all(checkouts.map(tree => statusLimiter.run(async () => {
      Object.assign(tree, await occupancy(ctx, git, tree.path, signal))
    }))),
  ])
  const remotes = [...remoteList].sort()
  if (refsOut.lossy) throw outputTooLarge()
  let records = refsOut.exitCode === 0 ? parseRefRecords(refsOut.stdout) : []
  if (records.length > OVERVIEW_REF_MAX) {
    truncated = true
    records = records.slice(0, OVERVIEW_REF_MAX)
  }
  const tags = tagsOut.exitCode === 0 && !tagsOut.lossy ? tagsOut.stdout.split('\n').filter(line => line !== '').length : 0
  let stashes = stashOut.exitCode === 0 && !stashOut.lossy ? parseStashList(stashOut.stdout) : []
  if (stashes.length > OVERVIEW_STASH_MAX) {
    truncated = true
    stashes = stashes.slice(0, OVERVIEW_STASH_MAX)
  }

  // Counts are keyed by commit id: a ref name may hold characters a format atom
  // cannot quote, and two pointers on one commit share every count.
  const oidOf = new Map(records.filter(record => record.symref === '').map(record => [record.refname, record.oid]))
  // Base candidates: each remote's HEAD target, then the local default branch;
  // without either, the primary checkout's branch is the line everything left.
  const candidates = [...new Set([
    ...records.filter(record => record.refname.startsWith('refs/remotes/') && record.refname.endsWith('/HEAD') && record.symref !== '')
      .map(record => record.symref),
    ...DEFAULT_BRANCHES,
  ])].filter(ref => oidOf.has(ref))
  const primaryBranch = checkouts.find(tree => tree.primary)?.branch ?? checkouts[0].branch
  if (candidates.length === 0 && primaryBranch !== null && oidOf.has(`refs/heads/${primaryBranch}`)) {
    candidates.push(`refs/heads/${primaryBranch}`)
  }

  const refs = records.filter(record => record.symref === '' && !record.refname.endsWith('/HEAD')
    && (record.refname.startsWith('refs/heads/') || record.refname.startsWith('refs/remotes/')))
  const detached = checkouts.filter(tree => tree.branch === null && tree.head !== null)
  const commits = [...new Set([...refs.map(record => record.oid), ...detached.map(tree => tree.head as string)])]

  const bases = candidates.length === 0 ? new Map<string, string>()
    : versionAtLeast(version, IS_BASE_VERSION)
      ? await isBaseChoices(git, root, candidates, commits, signal)
      : await nearestCandidates(git, root, candidates, commits, signal)
  const baseOf = (commit: string): string | null => bases.get(commit) ?? candidates.at(-1) ?? null

  const modern = versionAtLeast(version, AHEAD_BEHIND_VERSION)
  const byBase = new Map<string, string[]>()
  for (const commit of commits) {
    const base = baseOf(commit)
    if (base !== null) byBase.set(base, [...byBase.get(base) ?? [], commit])
  }
  if (candidates.length > 1) {
    const extra = candidates.slice(1).map(ref => oidOf.get(ref) as string)
    byBase.set(candidates[0], [...new Set([...byBase.get(candidates[0]) ?? [], ...extra])])
  }
  const distances = new Map<string, Map<string, [number, number]>>()
  for (const [base, listed] of byBase) {
    distances.set(base, await aheadBehind(git, root, oidOf.get(base) as string, listed, modern, signal))
  }
  const distance = (commit: string): [number, number] | null => {
    const base = baseOf(commit)
    return base === null ? null : distances.get(base)?.get(commit) ?? null
  }

  const noRemote = remotes.length === 0
  const branchTips = refs.filter(record => record.refname.startsWith('refs/heads/')).map(record => record.oid)
  const uniques = noRemote ? new Map<string, number>() : await branchUniques(git, root, branchTips, signal)

  const pointers: OverviewPointer[] = refs.map(record => {
    const base = baseOf(record.oid)
    const pair = distance(record.oid)
    const branchPointer = record.refname.startsWith('refs/heads/')
    const name = shortRef(record.refname)
    const pointer: OverviewPointer = {
      kind: branchPointer ? 'branch' : 'remote',
      name,
      sha: record.oid,
      time: record.time,
      subject: record.subject,
      base: base === null ? null : shortRef(base),
      isBase: base === record.refname,
      ahead: pair?.[0] ?? null,
      behind: pair?.[1] ?? null,
      unique: 0,
    }
    if (branchPointer) {
      pointer.unique = noRemote ? pair?.[0] ?? 0 : uniques.get(record.oid) ?? 0
      pointer.upstream = record.upstreamShort === '' ? null : record.upstreamShort
      pointer.track = record.upstream === '' ? null : parseTrack(record.track)
      pointer.checkout = checkouts.find(tree => tree.branch === name)?.path ?? null
    } else {
      const remote = remoteList.find(candidate => name.startsWith(`${candidate}/`))
      if (remote !== undefined) {
        pointer.remote = remote
        pointer.branch = name.slice(remote.length + 1)
      }
    }
    return pointer
  })
  for (const tree of detached) {
    const head = tree.head as string
    const base = baseOf(head)
    const pair = distance(head)
    const summary = await commitSummary(git, root, head, signal)
    pointers.push({
      kind: 'detached', name: tree.path, sha: head, time: summary.time, subject: summary.subject,
      base: base === null ? null : shortRef(base), isBase: false, ahead: pair?.[0] ?? null, behind: pair?.[1] ?? null,
      unique: await countExcluding(git, root, head, noRemote ? ['--branches'] : ['--branches', '--remotes'], signal),
      checkout: tree.path,
    })
  }
  for (const stash of stashes) {
    pointers.push({
      kind: 'stash', name: stash.name, sha: stash.sha, time: stash.time, subject: stash.subject,
      base: null, isBase: false, ahead: null, behind: null, unique: 1, onto: stash.onto,
    })
  }

  const firstBase = candidates[0]
  const baselines = candidates.map(ref => {
    const pair = ref === firstBase ? [0, 0] : distances.get(firstBase)?.get(oidOf.get(ref) as string) ?? [0, 0]
    return { name: shortRef(ref), ahead: pair[0], behind: pair[1] }
  })
  return {
    path: root,
    name: repositoryName(root),
    vcs: 'git',
    registered,
    supported: true,
    remotes,
    fetchedAt: await fetchedAt(common),
    baselines,
    checkouts,
    pointers,
    tags,
    truncated,
  }
}

/** A repository the overview lists without reading its pointers. */
export function unsupportedOverview(path: string, vcs: string, registered: boolean): OverviewRepository {
  return {
    path, name: repositoryName(path), vcs, registered, supported: false, remotes: [], fetchedAt: null,
    baselines: [], checkouts: [], pointers: [], tags: 0, truncated: false,
  }
}

/** Directories never worth listing while looking for repositories. */
const WALK_IGNORED = new Set(['.git', '.jj', 'node_modules'])
/** How deep and how wide the walk for unlisted repositories goes. */
export const UNLISTED_DEPTH = 6
export const UNLISTED_DIRECTORY_MAX = 20_000
export const UNLISTED_REPOSITORY_MAX = 50

/** One repository root the walk found outside the discovery rules. */
export interface UnlistedRoot {
  path: string
  vcs: string
}

/** What the walk for unlisted repositories found. */
export interface UnlistedRoots {
  roots: UnlistedRoot[]
  truncated: boolean
}

/**
 * Find repositories under the session directory that discovery does not list.
 * The walk lists contained directories only, follows no symlink, and stops at
 * {@link UNLISTED_DEPTH} levels or {@link UNLISTED_DIRECTORY_MAX} listings.
 * Checkouts are grouped by their Git common directory; a group whose primary
 * checkout lies outside the session directory, or that shares a common
 * directory with a listed repository, is left out.
 * @param ctx - Host context.
 * @param git - command runner.
 * @param cwd - canonical session directory.
 * @param listed - canonical common directories and roots already listed.
 * @param signal - cancellation.
 * @returns the unlisted roots, primary checkout first per group.
 */
export async function findUnlistedRepositories(
  ctx: Context,
  git: GitRunner,
  cwd: string,
  listed: { commons: readonly string[], roots: readonly string[] },
  signal: AbortSignal,
): Promise<UnlistedRoots> {
  const fs = ctx.fs
  const top = await fs.resolve(cwd, { signal })
  const found: UnlistedRoot[] = []
  let listings = 0
  let truncated = false
  let level = [{ target: top, depth: 0 }]
  while (level.length > 0) {
    const next: typeof level = []
    for (const { target, depth } of level) {
      if (listings === UNLISTED_DIRECTORY_MAX) {
        truncated = true
        break
      }
      listings += 1
      let entries
      try {
        entries = await fs.listDir(target, signal)
      } catch (error) {
        if (signal.aborted) throw error
        continue
      }
      const names = new Set(entries.map(entry => entry.name))
      const path = fs.processPath(target)
      if (names.has('.git')) found.push({ path, vcs: 'git' })
      else if (names.has('.jj')) found.push({ path, vcs: 'jujutsu' })
      if (depth === UNLISTED_DEPTH) continue
      for (const entry of entries) {
        if (entry.type !== 'directory' || WALK_IGNORED.has(entry.name) || !fs.contains(top, entry.target)) continue
        next.push({ target: entry.target, depth: depth + 1 })
      }
    }
    if (truncated) break
    level = next
  }

  const commons = [...listed.commons]
  const roots: UnlistedRoot[] = []
  for (const candidate of found) {
    if (roots.length === UNLISTED_REPOSITORY_MAX) {
      truncated = true
      break
    }
    if (listed.roots.some(root => sameRepoPath(root, candidate.path))) continue
    if (candidate.vcs !== 'git') {
      roots.push(candidate)
      continue
    }
    const common = await gitCommonDirAt(git, candidate.path, signal)
    if (common === null || commons.some(known => sameRepoPath(known, common))) continue
    commons.push(common)
    // The group's primary checkout names the repository, as `worktree list` does.
    let primary: string | null = null
    for await (const tree of discoverGitWorktrees(ctx, git, candidate.path, signal)) {
      if (tree.primary === true) {
        primary = tree.path
        break
      }
    }
    if (primary === null) continue
    const target = await fs.resolve(primary, { signal }).catch(() => undefined)
    if (target === undefined || !fs.contains(top, target)) continue
    roots.push({ path: fs.processPath(target), vcs: 'git' })
  }
  return { roots, truncated }
}
