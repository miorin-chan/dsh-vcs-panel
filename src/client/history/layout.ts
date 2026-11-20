/**
 * Commit-history lane layout.
 *
 * Ported from git-graph-plus (https://github.com/the0807/git-graph-plus),
 * commit c6c2a9a, `src/git/git-graph-builder.ts`, Apache-2.0.
 * That builder is itself ported from SourceGit
 * (https://github.com/sourcegit-scm/sourcegit), Copyright (c) SourceGit
 * contributors, MIT License.
 *
 * Trimmed for this plugin: the upstream remote-only/local-only reachability
 * passes, the branch color resolver and the dot color overrides are removed.
 * Our `CommitNode`s carry no upstream tracking information and the panel has no
 * branch color configuration. Lane allocation, first-parent continuation, side
 * lanes for extra parents, lane ending and color recycling are kept.
 *
 * Coordinate system (same as upstream): x is pixel space with one lane every
 * `LANE_UNIT` (12) px and `HALF_LANE_UNIT` (6) px half-width; y is in rows with
 * one unit per row and `HALF_ROW_UNIT` (0.5) half-height, so a commit dot sits
 * at y = index + 0.5. `commitLeftMargin` is in the same x pixel space and can
 * be used directly as the content offset after the graph column.
 */

/** One point in lane space: x in pixels, y in rows. */
export interface GraphPoint {
  x: number
  y: number
}

/** One lane polyline. */
export interface GraphPath {
  points: GraphPoint[]
  color: number
  dashed?: boolean
}

/** One quadratic merge edge from a commit to a lane already waiting for a parent. */
export interface GraphLink {
  start: GraphPoint
  control: GraphPoint
  end: GraphPoint
  color: number
}

/** The dot styles the timeline draws. */
export type GraphDotType = 'default' | 'head' | 'merge' | 'worktree' | 'working'

/** One commit dot. */
export interface GraphDot {
  center: GraphPoint
  color: number
  type: GraphDotType
}

/** The lane graph for one loaded history page. */
export interface GraphLayout {
  paths: GraphPath[]
  links: GraphLink[]
  dots: GraphDot[]
  commitLeftMargin: number[]
}

/** One decoration the lane layout reads from a commit. */
export interface GraphRef {
  name: string
  kind: string
  current?: boolean
}

/** One node the lane layout draws: a commit row or a virtual worktree row. */
export interface GraphCommit {
  sha: string
  parents: readonly string[]
  refs: readonly GraphRef[]
  worktree?: boolean
  workingCopy?: boolean
}

export const COLOR_PALETTE = [
  '#63b0f4',
  '#73d13d',
  '#ff7a45',
  '#b37feb',
  '#f759ab',
  '#36cfc9',
  '#ffc53d',
  '#ff4d4f',
  '#597ef7',
  '#9254de',
  '#43e8d8',
  '#faad14',
]

/** Distance between two adjacent lane centers, in pixels. */
export const LANE_UNIT = 12

/** Half of {@link LANE_UNIT}: the dot center offset and rounding radius. */
export const HALF_LANE_UNIT = 6

/** Reserved content offset after the rightmost lane, in pixels. */
export const LANE_PADDING = 8

/** Rows per lane coordinate unit: y is measured in rows. */
export const ROW_UNIT = 1

/** Half of {@link ROW_UNIT}: the vertical dot radius in row units. */
export const HALF_ROW_UNIT = 0.5

/** Row height used by the timeline (two lines of text), in pixels. */
export const DEFAULT_ROW_HEIGHT = 44

/**
 * Map a lane-space color index onto the palette, recycling when the index is
 * out of range. Negative and non-finite indexes fall back to the first color.
 *
 * @param color Palette index produced by {@link buildGraph}.
 * @returns Palette hex color.
 */
export function resolveColor(color: number): string {
  if (!Number.isFinite(color)) return COLOR_PALETTE[0]
  const index = ((Math.trunc(color) % COLOR_PALETTE.length) + COLOR_PALETTE.length) % COLOR_PALETTE.length
  return COLOR_PALETTE[index]
}

/**
 * Pick the first palette color not used by an active lane, cycling through the
 * palette when every color is already taken.
 *
 * @param unsolved Active lanes.
 * @param overflow Rotating fallback index for the overflow case.
 * @returns Palette index.
 */
function pickColor(unsolved: readonly PathHelper[], overflow: { n: number }): number {
  let mask = 0
  for (let i = 0; i < unsolved.length; i++) {
    const color = unsolved[i].path.color
    if (color >= 0 && color < 32) mask |= 1 << color
  }
  for (let i = 0; i < COLOR_PALETTE.length; i++) {
    if ((mask & (1 << i)) === 0) return i
  }
  // More simultaneously active lanes than palette colors: keep cycling so
  // overflow lanes stay visually distinct instead of all reusing color 0.
  return overflow.n++ % COLOR_PALETTE.length
}

/**
 * One lane being traced through the history rows: SourceGit's `PathHelper`.
 * Points are appended only when the lane changes x, so a straight run is a
 * single segment from the current point to the next bend.
 */
class PathHelper {
  /** Sha of the commit this lane is waiting for. */
  next: string
  /** The lane polyline being built. */
  path: GraphPath
  /** x of the lane's last point, in pixels. */
  lastX: number
  /** y of the lane's last point, in rows. */
  lastY: number
  /** Greatest y appended so far, in rows. */
  endY: number

  /**
   * @param next Sha of the commit this lane is waiting for.
   * @param color Palette index.
   * @param start First point.
   * @param [to] Optional second point (new side lane).
   */
  constructor(next: string, color: number, start: GraphPoint, to?: GraphPoint) {
    this.next = next
    this.path = { points: [], color }
    if (to) {
      this.lastX = to.x
      this.lastY = to.y
      this.path.points.push(start, to)
    } else {
      this.lastX = start.x
      this.lastY = start.y
      this.path.points.push(start)
    }
    this.endY = 0
  }

  /** Lane passes through this row without a commit. */
  pass(x: number, y: number, halfH: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH)
      y += halfH
      this.add(x, y)
    }
    this.lastX = x
    this.lastY = y
  }

  /** Lane has its commit on this row and continues to its first parent. */
  goto(x: number, y: number, halfH: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      let minY = y - halfH
      if (minY > this.lastY) minY -= halfH
      this.add(this.lastX, minY)
      this.add(x, y)
    }
    this.lastX = x
    this.lastY = y
  }

  /** Lane ends on this row. */
  end(x: number, y: number, halfH: number): void {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH)
    }
    this.add(x, y)
    this.lastX = x
    this.lastY = y
  }

  /** Append a point only while the lane keeps moving down (upstream `add`). */
  add(x: number, y: number): void {
    if (this.endY < y) {
      this.path.points.push({ x, y })
      this.endY = y
    }
  }
}

/**
 * Build the lane graph for commits already sorted by `git log --topo-order`.
 *
 * The timeline prepends virtual worktree nodes whose only parent is their
 * HEAD (if born). Dashed lanes end on those commits, and are not reused for
 * real commit edges. Several worktrees can end on the same commit dot.
 *
 * @param commits Ordered nodes: selected worktrees, then commits from `vcs.log`.
 * @returns Layout with one dot per commit (in commit order) and the content offset for
 *   each row in x pixel space (directly usable as a padding-left).
 */
export function buildGraph(commits: readonly GraphCommit[]): GraphLayout {
  const list: readonly GraphCommit[] = Array.isArray(commits) ? commits : []
  const result: GraphLayout = {
    paths: [],
    links: [],
    dots: [],
    commitLeftMargin: [],
  }
  if (list.length === 0) return result

  const unsolved: PathHelper[] = []
  const ended: PathHelper[] = []
  // Rotating fallback index for pickColor, advancing each time all palette
  // colors are in use so overflow lanes cycle instead of all reusing color 0.
  const colorOverflow = { n: 0 }
  let offsetY = -HALF_ROW_UNIT

  // Index solid lanes for merge-parent lookup. A dashed worktree lane
  // represents a checkout, never ancestry, even when both target one SHA.
  const nextMap = new Map<string, PathHelper>()
  const trackNext = (line: PathHelper): void => {
    if (!line.path.dashed && !nextMap.has(line.next)) nextMap.set(line.next, line)
  }
  const untrackNext = (line: PathHelper): void => {
    if (nextMap.get(line.next) === line) nextMap.delete(line.next)
  }

  for (const commit of list) {
    const sha = commit && commit.sha
    const parents: readonly string[] = Array.isArray(commit?.parents) ? commit.parents : []
    const refs: readonly GraphRef[] = Array.isArray(commit?.refs) ? commit.refs : []
    let major: PathHelper | null = null

    offsetY += ROW_UNIT
    let offsetX = 4 - HALF_LANE_UNIT
    const maxOffsetOld = unsolved.length > 0 ? unsolved[unsolved.length - 1].lastX : offsetX + LANE_UNIT

    // Pass / Goto / End every active lane for this row.
    for (let index = 0; index < unsolved.length; index++) {
      const line = unsolved[index]
      if (line.next === sha) {
        if (major === null && line.path.dashed) {
          // The dashed working-tree lane ends on HEAD; HEAD's own history
          // continues as a solid lane in the same slot and color.
          offsetX += LANE_UNIT
          line.end(offsetX, offsetY, HALF_ROW_UNIT)
          untrackNext(line)
          if (parents.length > 0) {
            major = new PathHelper(parents[0], line.path.color, { x: offsetX, y: offsetY })
            unsolved[index] = major
            trackNext(major)
            result.paths.push(major.path)
          } else {
            major = line
            ended.push(line)
          }
        } else if (major === null) {
          offsetX += LANE_UNIT
          major = line
          if (parents.length > 0) {
            untrackNext(major)
            major.next = parents[0]
            trackNext(major)
            major.goto(offsetX, offsetY, HALF_ROW_UNIT)
          } else {
            major.end(offsetX, offsetY, HALF_ROW_UNIT)
            ended.push(line)
          }
        } else {
          // A second lane also waits for this commit: end it on the major lane.
          line.end(major.lastX, offsetY, HALF_ROW_UNIT)
          ended.push(line)
        }
      } else {
        offsetX += LANE_UNIT
        line.pass(offsetX, offsetY, HALF_ROW_UNIT)
      }
    }

    if (ended.length > 0) {
      const toRemove = new Set(ended)
      let write = 0
      for (let read = 0; read < unsolved.length; read++) {
        if (!toRemove.has(unsolved[read])) unsolved[write++] = unsolved[read]
      }
      unsolved.length = write
      for (const line of ended) untrackNext(line)
      ended.length = 0
    }

    // New branch head: no active lane was waiting for this commit.
    if (major === null) {
      offsetX += LANE_UNIT
      if (parents.length > 0) {
        major = new PathHelper(parents[0], pickColor(unsolved, colorOverflow), {
          x: offsetX,
          y: offsetY,
        })
        if (commit.worktree === true) major.path.dashed = true
        unsolved.push(major)
        trackNext(major)
        result.paths.push(major.path)
      }
    }

    const center = { x: major ? major.lastX : offsetX, y: offsetY }
    const color = major ? major.path.color : 0
    let type: GraphDotType = 'default'
    if (commit?.worktree === true) type = 'worktree'
    else if (commit?.workingCopy === true) type = 'working'
    else if (refs.some((ref) => ref && (ref.kind === 'head' || ref.current === true))) type = 'head'
    else if (parents.length > 1) type = 'merge'
    result.dots.push({ center, color, type })

    // Additional parents get a new side lane, or a link when a lane already
    // waits for that parent.
    for (let parentIndex = 1; parentIndex < parents.length; parentIndex++) {
      const parentSha = parents[parentIndex]
      const parent = nextMap.get(parentSha)
      if (parent) {
        result.links.push({
          start: center,
          control: { x: parent.lastX, y: center.y },
          end: { x: parent.lastX, y: offsetY + HALF_ROW_UNIT },
          color: parent.path.color,
        })
      } else {
        offsetX += LANE_UNIT
        const line = new PathHelper(
          parentSha,
          pickColor(unsolved, colorOverflow),
          center,
          { x: offsetX, y: center.y + HALF_ROW_UNIT },
        )
        unsolved.push(line)
        trackNext(line)
        result.paths.push(line.path)
      }
    }

    result.commitLeftMargin.push(Math.max(offsetX, maxOffsetOld) + HALF_LANE_UNIT + 2)
  }

  // Lanes whose next commit is past the loaded page (or missing from it) end at
  // the bottom edge of the last row instead of dangling.
  const endY = list.length
  for (const line of unsolved) {
    if (line.path.points.length === 1 && Math.abs(line.path.points[0].y - endY) < 0.0001) continue
    line.end(line.lastX, endY, HALF_ROW_UNIT)
  }

  return result
}

/**
 * Build the SVG `d` attribute for one lane: a line through the points with
 * quadratic smoothing at direction changes (SourceGit's `DrawCurves`, as
 * ported by git-graph-plus).
 *
 * @param points Lane polyline in layout units.
 * @param [rowHeight] Pixel height of one row unit.
 * @returns `d` attribute, or an empty string for fewer than two points.
 */
export function buildPathD(points: readonly GraphPoint[], rowHeight = DEFAULT_ROW_HEIGHT): string {
  if (!Array.isArray(points) || points.length < 2) return ''
  const scaleY = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : DEFAULT_ROW_HEIGHT

  const parts: string[] = []
  let lastX = points[0].x
  let lastY = points[0].y * scaleY
  parts.push(`M ${lastX} ${lastY}`)

  for (let i = 1; i < points.length; i++) {
    const x = points[i].x
    const y = points[i].y * scaleY

    if (x > lastX) {
      // Going right: control at the previous y.
      parts.push(`Q ${x} ${lastY}, ${x} ${y}`)
    } else if (x < lastX) {
      if (i < points.length - 1) {
        // Middle: S-curve with a short vertical tangent.
        const midY = (lastY + y) / 2
        parts.push(`C ${lastX} ${midY + 4}, ${x} ${midY - 4}, ${x} ${y}`)
      } else {
        // Last: control at the previous x.
        parts.push(`Q ${lastX} ${y}, ${x} ${y}`)
      }
    } else {
      parts.push(`L ${x} ${y}`)
    }

    lastX = x
    lastY = y
  }

  return parts.join(' ')
}

/**
 * Width the history row should reserve for the graph column, in pixels.
 *
 * @param layout Layout returned by {@link buildGraph}.
 * @param [bounds] Clamp range in pixels.
 * @returns Pixel width for the graph column / SVG.
 */
export function graphWidth(
  layout: { readonly commitLeftMargin?: readonly number[] } | null | undefined,
  { min = 24, max = 120 }: { min?: number; max?: number } = {},
): number {
  const margins: readonly number[] = layout !== null && layout !== undefined && Array.isArray(layout.commitLeftMargin)
    ? layout.commitLeftMargin
    : []
  let widest = 0
  for (const margin of margins) {
    if (Number.isFinite(margin) && margin > widest) widest = margin
  }
  if (widest <= 0) return min
  return Math.max(min, Math.min(max, Math.ceil(widest)))
}
