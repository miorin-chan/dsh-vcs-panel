/**
 * The overview's view model: one state per pointer from its distance to its
 * base, the repository ranking built on it, the vertical skeleton of a tiled
 * column, and the order state traversal walks (DESIGN.md, 指针的状态由相对基线的距离决定).
 *
 * The Host reports raw quantities; every rule that turns them into a color,
 * an order, or a filter lives here, free of React and DOM so it stays testable.
 */

import type { OverviewCheckout, OverviewPointer, OverviewPointerKind, OverviewRepository } from '../../lib/overview.js'
import { BOOKMARK_CONFLICT_KEY, OPERATION_KEYS } from './labels.js'
import { stashNode, stashSha } from '../stash.js'
import type { StashTarget } from '../stash.js'
import { worktreePath } from '../state.js'

export type { OverviewCheckout, OverviewPointer, OverviewRepository } from '../../lib/overview.js'

/** One state, heaviest first by "can it be recovered if lost". */
export type PointerState =
  | 'op' | 'unsaved' | 'unique' | 'diverged' | 'stash' | 'behind' | 'merged' | 'foreign' | 'synced' | 'shadow'

/** Sort weight of each state; equal weights share a place. */
export const STATE_RANK: Readonly<Record<PointerState, number>> = Object.freeze({
  op: 0, unsaved: 1, unique: 2, diverged: 2, stash: 3, behind: 4, merged: 5, foreign: 7, synced: 8, shadow: 9,
})

/** States drawn with a solid accent. */
export const LOUD_STATES: ReadonlySet<PointerState> = new Set(['op', 'unsaved', 'unique', 'diverged', 'stash', 'behind'])

/** The seven filters, in the order of the state buttons and their number keys. */
export const FILTERS = ['unsaved', 'unique', 'diverged', 'behind', 'merged', 'stash', 'op'] as const
export type FilterId = typeof FILTERS[number]

/** One pointer with what the view derives from it. */
export interface PointerView extends OverviewPointer {
  /** Stable identity across reloads, with a commit suffix for divergent anonymous heads. */
  id: string
  repo: string
  state: PointerState
  /** The checkout holding it, when one does. */
  occupant: OverviewCheckout | null
  /** Whether the occupant sits inside another linked checkout. */
  nested: boolean
  /** Remote branch drawn as its local branch's shadow (`≡ origin`). */
  shadowed: boolean
  /** Remote on the same commit as its local counterpart, folded into it in the skeleton. */
  foldedRemote: boolean
  /** Remotes whose pointers share this local pointer's commit. */
  levelRemotes: string[]
  /** The base line is the branch's own upstream. */
  baseIsUpstream: boolean
  /** A detached checkout shows its path; an anonymous head keeps its change id. */
  display: string
}

/** One repository with its ranked pointers. */
export interface RepositoryView extends Omit<OverviewRepository, 'pointers'> {
  /** Path relative to the session directory, `.` for the directory itself. */
  relativePath: string
  /** Parent of the relative path with a trailing slash, or empty. */
  directory: string
  pointers: PointerView[]
  /** The pointers a row lists: branches, detached heads, stashes, and foreign remote branches. */
  list: PointerView[]
  rank: number
  unique: number
  dirty: number
  dirtyTrees: number
  /** Everything matches its upstream or base: drawn as a summary row or a spine. */
  quiet: boolean
  /** Candidate trunks that drifted from the first one (a fork's two mains). */
  drift: Array<{ name: string, ahead: number, behind: number }>
}

/** Whether `path` lies inside `parent`. */
function inside(path: string, parent: string): boolean {
  return path !== parent && path.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/**
 * A path relative to the session directory.
 * @param path - absolute path.
 * @param cwd - absolute session directory.
 * @returns the relative path, `.` for the directory itself, or the path unchanged outside it.
 */
export function relativeTo(path: string, cwd: string | null | undefined): string {
  if (cwd === null || cwd === undefined || cwd === '') return path
  if (path === cwd) return '.'
  return inside(path, cwd) ? path.slice(cwd.length + (cwd.endsWith('/') ? 0 : 1)) : path
}

/**
 * A checkout path as its repository's rows print it.
 * @param path - absolute checkout path.
 * @param repo - absolute repository root.
 * @param cwd - absolute session directory.
 * @returns the path relative to the repository when inside it, else to the session.
 */
export function checkoutLabel(path: string, repo: string, cwd: string | null | undefined): string {
  if (path === repo) return '.'
  return inside(path, repo) ? path.slice(repo.length + 1) : relativeTo(path, cwd)
}

/** The state of one pointer; the heaviest condition wins. */
export function pointerState(pointer: PointerView): PointerState {
  if (pointer.bookmarkConflict === true || pointer.occupant?.operation != null) return 'op'
  if (pointer.kind === 'remote') return pointer.shadowed ? 'shadow' : 'foreign'
  if ((pointer.occupant?.dirty ?? 0) > 0) return 'unsaved'
  if (pointer.kind === 'stash') return 'stash'
  const unique = pointer.unique
  const ahead = pointer.ahead ?? 0
  const behind = pointer.behind ?? 0
  if (unique > 0) return behind > 0 ? 'diverged' : 'unique'
  if (pointer.isBase && !pointer.baseIsUpstream) return 'synced'
  if (behind > 0 && ahead === 0) return pointer.kind === 'detached' || pointer.occupant === null ? 'merged' : 'behind'
  if (behind > 0) return 'behind'
  return 'synced'
}

/** Whether a pointer passes one filter. */
export function matchesFilter(pointer: PointerView, filter: FilterId): boolean {
  switch (filter) {
    case 'unique': return pointer.state === 'unique' || pointer.state === 'diverged'
    case 'stash': return pointer.kind === 'stash'
    default: return pointer.state === filter
  }
}

/** Sort by state, then most unique commits, then name. */
export function byRank(first: PointerView, second: PointerView): number {
  return STATE_RANK[first.state] - STATE_RANK[second.state]
    || second.unique - first.unique
    || first.display.localeCompare(second.display)
}

/** Sort repositories by their heaviest state, then unique and changed work. */
export function byAttention(first: RepositoryView, second: RepositoryView): number {
  return first.rank - second.rank || second.unique - first.unique || second.dirty - first.dirty
    || first.relativePath.localeCompare(second.relativePath)
}

/**
 * The element under `root` whose `data-*` attribute equals `value`. Pointer ids
 * hold control characters a CSS selector cannot carry, so this compares values.
 * @param root - where to look.
 * @param attribute - the full attribute name.
 * @param value - the value to match.
 * @returns the element, or null.
 */
export function elementWithData(root: ParentNode | null | undefined, attribute: string, value: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []) {
    if (element.getAttribute(attribute) === value) return element
  }
  return null
}

/** The stable id of one pointer. */
export function pointerId(repo: string, kind: OverviewPointerKind, name: string): string {
  return `${repo}\u0000${kind}\u0000${name}`
}

/**
 * Derive one repository's view.
 * @param repository - the Host's overview of it.
 * @param cwd - absolute session directory.
 * @returns the view with its ranked pointers.
 */
export function repositoryView(repository: OverviewRepository, cwd: string | null | undefined): RepositoryView {
  const relativePath = relativeTo(repository.path, cwd)
  const bookmarks = repository.vcs === 'jujutsu'
  const locals = repository.pointers.filter(pointer => pointer.kind === 'branch')
  const localsByName = new Map(locals.map(local => [local.name, local]))
  const localsByUpstream = new Map(locals.map(local => [local.upstream, local]))
  const remotes = repository.pointers.filter(pointer => pointer.kind === 'remote')
  const remoteNames = new Set(remotes.map(remote => remote.name))
  const localForRemote = new Map<OverviewPointer, OverviewPointer>()
  const foldedRemotes = new Set<OverviewPointer>()
  const levelRemotes = new Map<OverviewPointer, string[]>()
  for (const remote of remotes) {
    const local = localsByUpstream.get(remote.name) ?? (bookmarks && remote.branch !== undefined ? localsByName.get(remote.branch) : undefined)
    if (local === undefined) continue
    localForRemote.set(remote, local)
    if (local.sha === remote.sha && !local.bookmarkConflict && !remote.bookmarkConflict) {
      foldedRemotes.add(remote)
      const name = remote.remote ?? remote.name.split('/')[0]
      levelRemotes.set(local, [...levelRemotes.get(local) ?? [], name])
    }
  }
  const baseNames = new Set(repository.baselines.map(line => line.name))
  const anonymousNames = new Set<string>()
  const divergentNames = new Set<string>()
  for (const pointer of repository.pointers) {
    if (pointer.kind !== 'detached' || pointer.checkout != null) continue
    if (anonymousNames.has(pointer.name)) divergentNames.add(pointer.name)
    else anonymousNames.add(pointer.name)
  }
  const primary = repository.checkouts.find(tree => tree.primary) ?? repository.checkouts[0]
  const pointers = repository.pointers.map((pointer): PointerView => {
    const path = pointer.checkout
    const occupant = typeof path === 'string' ? repository.checkouts.find(tree => tree.path === path) ?? null : null
    const level = levelRemotes.get(pointer) ?? []
    // Git's tracking atom can still describe a level upstream beyond the ref cap.
    if (!bookmarks && pointer.upstream != null && !remoteNames.has(pointer.upstream)
      && pointer.track?.ahead === 0 && pointer.track.behind === 0 && pointer.track.gone !== true) {
      level.push(pointer.upstream.split('/')[0])
    }
    const id = pointerId(repository.path, pointer.kind, pointer.kind === 'stash' ? pointer.sha : pointer.name)
    const view: PointerView = {
      ...pointer,
      id: pointer.kind === 'detached' && path == null && divergentNames.has(pointer.name) ? `${id}\u0000${pointer.sha}` : id,
      repo: repository.path,
      state: 'synced',
      occupant,
      nested: occupant !== null && repository.checkouts.some(tree => tree !== primary && tree !== occupant && inside(occupant.path, tree.path)),
      shadowed: pointer.kind === 'remote' && (localForRemote.has(pointer) || (!bookmarks && baseNames.has(pointer.name))),
      foldedRemote: foldedRemotes.has(pointer),
      levelRemotes: level,
      baseIsUpstream: false,
      display: pointer.kind === 'detached' && typeof path === 'string' ? checkoutLabel(path, repository.path, cwd) : pointer.name,
    }
    // The trunk itself counts against its own upstream.
    if (!bookmarks && pointer.kind === 'branch' && pointer.isBase && typeof pointer.upstream === 'string' && pointer.track != null) {
      view.ahead = pointer.track.ahead
      view.behind = pointer.track.behind
      view.base = pointer.upstream
      view.baseIsUpstream = true
    }
    view.state = pointerState(view)
    return view
  })
  const list = pointers.filter(pointer => pointer.state !== 'shadow').sort(byRank)
  const rank = Math.min(9, ...list.map(pointer => STATE_RANK[pointer.state]))
  const parts = relativePath === '.' ? [] : relativePath.split('/')
  return {
    ...repository,
    relativePath,
    directory: parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '',
    pointers,
    list,
    rank,
    unique: list.filter(pointer => pointer.kind !== 'stash').reduce((total, pointer) => total + pointer.unique, 0),
    dirty: repository.checkouts.reduce((total, tree) => total + (tree.dirty ?? 0), 0),
    dirtyTrees: repository.checkouts.filter(tree => (tree.dirty ?? 0) > 0).length,
    quiet: rank >= STATE_RANK.foreign,
    drift: repository.baselines.slice(1).filter(line => line.ahead > 0 || line.behind > 0),
  }
}

/**
 * Count the listed pointers of each filter across repositories.
 * @param repositories - the views to count.
 * @returns the count for every filter.
 */
export function filterCounts(repositories: readonly RepositoryView[]): Record<FilterId, number> {
  return Object.fromEntries(FILTERS.map(filter => [
    filter,
    repositories.reduce((total, repository) => total + repository.list.filter(pointer => matchesFilter(pointer, filter)).length, 0),
  ])) as Record<FilterId, number>
}

/** Whether a pointer matches the search text. */
export function matchesSearch(pointer: PointerView, query: string, cwd: string | null | undefined): boolean {
  if (query === '') return true
  const needle = query.toLocaleLowerCase()
  const occupant = pointer.occupant === null ? null : relativeTo(pointer.occupant.path, cwd)
  return [pointer.display, pointer.subject, occupant, pointer.upstream]
    .some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(needle))
}

/** The number a row leads with, or null for the plain "level" wording. */
export interface Headline {
  key: string
  count?: number
  behind?: number
}

/**
 * The headline of one pointer row: what matters most about it.
 * @param pointer - the pointer.
 * @returns a locale key and its counts.
 */
export function headline(pointer: PointerView): Headline {
  switch (pointer.state) {
    case 'unsaved': return { key: 'overview.metric.unsaved', count: pointer.occupant?.dirty ?? 0 }
    case 'unique': return { key: 'overview.metric.unique', count: pointer.unique }
    case 'diverged': return { key: 'overview.metric.diverged', count: pointer.unique, behind: pointer.behind ?? 0 }
    case 'behind': return { key: 'overview.metric.behind', count: pointer.behind ?? 0 }
    case 'merged': return { key: 'overview.state.merged' }
    case 'stash': return { key: 'overview.state.stash' }
    case 'op': return { key: pointer.bookmarkConflict === true ? BOOKMARK_CONFLICT_KEY
      : pointer.occupant?.operation == null ? 'overview.state.op' : OPERATION_KEYS[pointer.occupant.operation] }
    default: return (pointer.ahead ?? 0) > 0 ? { key: 'overview.metric.ahead', count: pointer.ahead ?? 0 } : { key: 'overview.state.synced' }
  }
}

/**
 * The gauge around a pointer's base: behind to the left, ahead to the right,
 * with the part only this machine has drawn in the unique color. Widths are
 * logarithmic so 1 and 66 both read.
 * @param pointer - the pointer.
 * @param half - pixels on each side of the base.
 * @returns the three segment widths.
 */
export function gauge(pointer: PointerView, half = 29): { behind: number, published: number, unique: number } {
  const width = (count: number) => (Math.log10(1 + count) / Math.log10(301)) * half
  const ahead = pointer.kind === 'stash' ? 1 : pointer.ahead ?? 0
  const unique = pointer.kind === 'stash' ? 1 : Math.min(pointer.unique, ahead || pointer.unique)
  const reach = Math.max(ahead, unique)
  return {
    behind: Math.min(half, width(pointer.behind ?? 0)),
    published: Math.min(half, width(reach - unique)),
    unique: unique > 0 ? Math.max(3, Math.min(half, width(reach)) - Math.min(half, width(reach - unique))) : 0,
  }
}

/** One commit as the skeleton reads it. */
export interface SkeletonCommit {
  sha: string
  parents: readonly string[]
  subject?: string
}

/** One tag as the skeleton places it. */
export interface SkeletonTag {
  name: string
  sha: string
}

/** One kept row of a tiled column. */
export interface SkeletonRow {
  sha: string
  subject: string
  /** The next kept row along the first parent, or null at the end of the loaded history. */
  parent: string | null
  /** Commits folded between this row and its parent row. */
  between: number
  /** The loaded history ends below this row. */
  end: boolean
  /** The end is the root commit, not a page boundary. */
  root: boolean
  pointers: PointerView[]
  tags: string[]
}

/** One lane step: the column of the row and the lanes around it. */
export interface LaneStep {
  column: number
  before: Array<string | null>
  after: Array<string | null>
  merging: number[]
  forks: number[]
}

/** A tiled column's skeleton. */
export interface Skeleton {
  rows: SkeletonRow[]
  lanes: LaneStep[]
  width: number
  /** Pointers whose commit is outside the loaded history. */
  unplaced: PointerView[]
}

/**
 * Lay out lanes for commits listed newest first; the first parent keeps the lane.
 * @param commits - rows with their parents among the rows.
 * @returns one step per row.
 */
export function layoutLanes(commits: readonly SkeletonCommit[]): LaneStep[] {
  const active: Array<string | null> = []
  return commits.map(commit => {
    let column = active.indexOf(commit.sha)
    if (column === -1) {
      column = active.indexOf(null)
      if (column === -1) column = active.length
      active[column] = commit.sha
    }
    const before = active.slice()
    const merging: number[] = []
    active.forEach((sha, index) => {
      if (index !== column && sha === commit.sha) {
        merging.push(index)
        active[index] = null
      }
    })
    active[column] = commit.parents[0] ?? null
    const forks: number[] = []
    for (const parent of commit.parents.slice(1)) {
      let lane = active.indexOf(parent)
      if (lane === -1) {
        lane = active.indexOf(null)
        if (lane === -1) lane = active.length
        active[lane] = parent
      }
      forks.push(lane)
    }
    while (active.length > 0 && active.at(-1) === null) active.pop()
    return { column, before, after: active.slice(), merging, forks }
  })
}

/**
 * Fold a repository's loaded history to the commits its pointers name and the
 * fork points between them: a commit stays when two or more first-parent lines
 * through it lead to pointers. Runs of commits between kept rows become a count,
 * and consecutive rows holding only tags fold into one.
 * @param commits - loaded history, newest first, as the timeline reads it.
 * @param pointers - the repository's pointers; remote branches level with their local branch are drawn as its shadow.
 * @param tags - tags with the commit each names.
 * @returns the skeleton.
 */
export function buildSkeleton(
  commits: readonly SkeletonCommit[],
  pointers: readonly PointerView[],
  tags: readonly SkeletonTag[] = [],
): Skeleton {
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const drawn = pointers.filter(pointer => !pointer.foldedRemote)
  const labels = new Map<string, { pointers: PointerView[], tags: string[] }>()
  const label = (sha: string) => {
    let entry = labels.get(sha)
    if (entry === undefined) {
      entry = { pointers: [], tags: [] }
      labels.set(sha, entry)
    }
    return entry
  }
  const unplaced: PointerView[] = []
  for (const pointer of drawn) {
    const sha = pointer.kind === 'stash' ? pointer.onto ?? null : pointer.sha
    if (sha === null || !bySha.has(sha)) unplaced.push(pointer)
    else label(sha).pointers.push(pointer)
  }
  for (const tag of tags) if (bySha.has(tag.sha)) label(tag.sha).tags.push(tag.name)

  const parents = new Map(commits.map(commit => [commit.sha, commit.parents.filter(parent => bySha.has(parent))]))
  const children = new Map<string, string[]>()
  for (const [sha, list] of parents) {
    const first = list[0]
    if (first !== undefined) children.set(first, [...children.get(first) ?? [], sha])
  }
  // Newest first, so a commit's children are decided before it.
  const leads = new Set<string>()
  for (const commit of commits) {
    if (labels.has(commit.sha) || (children.get(commit.sha) ?? []).some(child => leads.has(child))) leads.add(commit.sha)
  }
  const kept = commits.filter(commit => labels.has(commit.sha)
    || (children.get(commit.sha) ?? []).filter(child => leads.has(child)).length >= 2)
  const keptSet = new Set(kept.map(commit => commit.sha))
  const rows: SkeletonRow[] = kept.map(commit => {
    let next = parents.get(commit.sha)?.[0]
    let last = commit.sha
    let between = 0
    while (next !== undefined && !keptSet.has(next)) {
      between += 1
      last = next
      next = parents.get(next)?.[0]
    }
    const entry = labels.get(commit.sha)
    return {
      sha: commit.sha,
      subject: commit.subject ?? '',
      parent: next ?? null,
      between,
      end: next === undefined,
      root: next === undefined && (bySha.get(last)?.parents.length ?? 0) === 0,
      pointers: [...entry?.pointers ?? []].sort(byRank),
      tags: entry?.tags ?? [],
    }
  })
  const keptChildren = new Map<string, number>()
  for (const row of rows) if (row.parent !== null) keptChildren.set(row.parent, (keptChildren.get(row.parent) ?? 0) + 1)
  const tagOnly = (row: SkeletonRow) => row.pointers.length === 0 && row.tags.length > 0
  const folded: SkeletonRow[] = []
  for (const row of rows) {
    const previous = folded.at(-1)
    if (previous !== undefined && tagOnly(previous) && tagOnly(row) && previous.parent === row.sha && keptChildren.get(row.sha) === 1) {
      previous.tags = [...previous.tags, ...row.tags]
      previous.parent = row.parent
      previous.between += row.between + 1
      previous.end = row.end
      previous.root = row.root
    } else {
      folded.push({ ...row })
    }
  }
  const lanes = layoutLanes(folded.map(row => ({ sha: row.sha, parents: row.parent === null ? [] : [row.parent] })))
  const width = Math.max(1, ...lanes.map(step => Math.max(step.before.length, step.after.length)))
  return { rows: folded, lanes, width, unplaced: [...unplaced].sort(byRank) }
}

/** One column in traversal order: its pointers top to bottom. */
export interface TraversalColumn {
  repo: string
  pointers: readonly PointerView[]
}

/**
 * The pointers state traversal visits for one filter: columns left to right,
 * each column top to bottom.
 * @param columns - the columns in display order.
 * @param filter - the state button.
 * @returns the matching pointers in order.
 */
export function traversal(columns: readonly TraversalColumn[], filter: FilterId): PointerView[] {
  return columns.flatMap(column => column.pointers.filter(pointer => matchesFilter(pointer, filter)))
}

/**
 * The next position of a traversal.
 * @param length - hits in the traversal.
 * @param index - current position, or -1 before the first step.
 * @param direction - 1 forward, -1 backward.
 * @returns the next position, wrapping at both ends.
 */
export function stepIndex(length: number, index: number, direction: 1 | -1): number {
  if (length === 0) return -1
  if (index < 0) return direction > 0 ? 0 : length - 1
  return (index + direction + length) % length
}

/** The pointers of one column in the order its skeleton draws them. */
export function columnOrder(skeleton: Skeleton | null, repository: RepositoryView): PointerView[] {
  if (skeleton === null) return repository.list
  const listed = new Set(repository.list.map(pointer => pointer.id))
  return [...skeleton.rows.flatMap(row => row.pointers), ...skeleton.unplaced].filter(pointer => listed.has(pointer.id))
}

/**
 * The node the timeline selects for a pointer: its checkout's working tree when
 * it has unsaved changes, the stash node, or the commit it names.
 * @param pointer - the pointer.
 * @returns the commit id or the checkout to select.
 */
export function pointerTarget(pointer: PointerView): { commit: string } | { worktree: string } | { stash: string } {
  if (pointer.kind === 'stash') return { stash: stashNode(pointer.sha) }
  const workingCopy = pointer.occupant?.workingCopy
  if (workingCopy !== undefined && (pointer.state === 'unsaved' || pointer.occupant?.operation === 'conflict' || /^0+$/u.test(pointer.sha))) {
    return { commit: workingCopy }
  }
  if (pointer.state === 'unsaved' && pointer.occupant !== null) return { worktree: pointer.occupant.path }
  return { commit: pointer.sha }
}

export function stashPointerTarget(pointer: PointerView): StashTarget | null {
  return pointer.kind === 'stash' && pointer.onto != null
    ? { repo: pointer.repo, sha: pointer.sha, selector: pointer.name, message: pointer.subject, base: pointer.onto }
    : null
}

/** Match the timeline selection to the pointer itself, not a stash's base. */
export function selectedPointerId(view: RepositoryView | undefined, node: string | null): string | null {
  if (view === undefined || node === null) return null
  const tree = worktreePath(node)
  const stash = stashSha(node)
  return view.list.find(pointer => tree !== null ? pointer.occupant?.path === tree
    : stash !== null ? pointer.kind === 'stash' && pointer.sha === stash
      : pointer.kind !== 'stash' && (pointer.sha === node || pointer.occupant?.workingCopy === node))?.id ?? null
}

/** Tiled columns in discovery order, or ranked by attention with quiet columns last. */
export function tileOrder<T extends { path: string }>(
  entries: readonly T[],
  views: ReadonlyMap<string, RepositoryView>,
  order: 'directory' | 'attention',
): T[] {
  if (order === 'directory') return [...entries]
  const loud = entries.filter(entry => views.get(entry.path)?.quiet !== true)
  const quiet = entries.filter(entry => views.get(entry.path)?.quiet === true)
  const rank = (entry: T) => views.get(entry.path)
  return [
    ...loud.sort((first, second) => {
      const a = rank(first)
      const b = rank(second)
      if (a === undefined) return b === undefined ? 0 : 1
      if (b === undefined) return -1
      return byAttention(a, b)
    }),
    ...quiet,
  ]
}
