/**
 * SVG lane-graph overlay for the timeline (working tree + commit history).
 *
 * The overlay is pinned to the history viewport (a sibling of the scrolling
 * list, not part of the scrolled content): it receives `scrollTop` and draws in
 * viewport coordinates, so lanes stay locked to the rows scrolling underneath.
 * Only rows around the viewport are rendered; the rest of the graph never
 * reaches the DOM.
 *
 * Lane geometry comes from `layout.js` in upstream pixel space: x is already in
 * pixels (lane centers 10, 22, 34, ...) and y is in rows (commit i at row
 * center i + 0.5), so the only mapping needed here is `y * rowHeight`.
 */

import { useMemo } from 'react'
import {
  COLOR_PALETTE,
  DEFAULT_ROW_HEIGHT,
  LANE_UNIT,
  buildPathD,
  graphWidth,
  resolveColor,
} from './layout.js'
import type { GraphLayout, GraphLink } from './layout.js'

// `graphWidth`, `buildPathD` and the lane constants are re-exported so the
// history view can take its whole graph API from this module.
export { buildPathD, COLOR_PALETTE, DEFAULT_ROW_HEIGHT, LANE_UNIT, graphWidth }

// The lane geometry types live with the layout that produces them; re-export
// them here so the history view imports its whole graph API from one module.
export type { GraphDot, GraphDotType, GraphLayout, GraphLink, GraphPath, GraphPoint } from './layout.js'

/** Rows rendered above and below the visible window to smooth fast scrolling. */
export const RENDER_BUFFER_ROWS = 10

/** Radius of a regular commit dot, in pixels. */
export const DOT_RADIUS = 3.5

/** Radius of the HEAD ring, in pixels. */
export const HEAD_DOT_RADIUS = 4

/** Radius of the subtle ring drawn around the selected commit dot. */
export const SELECTED_RING_RADIUS = 6.5

/** The timeline lane graph's props. */
export interface GraphProps {
  rowCount: number
  layout: GraphLayout
  rowHeight?: number
  scrollTop?: number
  viewportHeight?: number
  width?: number
  selectedIndex?: number
}

/**
 * Timeline lane graph.
 * @param props - graph state and viewport geometry.
 * @returns Overlay SVG, or null when hidden.
 */
export function Graph({
  rowCount,
  layout,
  rowHeight = DEFAULT_ROW_HEIGHT,
  scrollTop = 0,
  viewportHeight = 0,
  width = 120,
  selectedIndex = -1,
}: GraphProps) {
  const totalRows = Number.isFinite(rowCount) ? rowCount : 0
  const paths = layout?.paths ?? []
  const links = layout?.links ?? []
  const dots = layout?.dots ?? []

  // Geometry in content coordinates, recomputed only when the layout or row
  // height changes: scrolling must not rebuild SVG `d` strings.
  const { pathDs, pathBounds } = useMemo(() => {
    const ds = new Array<string>(paths.length)
    const bounds = new Array<{ minY: number; maxY: number }>(paths.length)
    for (let i = 0; i < paths.length; i++) {
      const points = paths[i].points
      ds[i] = buildPathD(points, rowHeight)
      let minY = Infinity
      let maxY = -Infinity
      for (let j = 0; j < points.length; j++) {
        const y = points[j].y
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      bounds[i] = { minY, maxY }
    }
    return { pathDs: ds, pathBounds: bounds }
  }, [paths, rowHeight])

  const visibleStartRow = Math.max(0, Math.floor(scrollTop / rowHeight) - RENDER_BUFFER_ROWS)
  const visibleEndRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + RENDER_BUFFER_ROWS,
  )

  // A path or link can enter the drawn window from either side, so keep
  // everything whose row span touches the buffered window.
  const visiblePaths = useMemo(() => {
    const visible: { key: number; d: string; color: string; dashed: boolean }[] = []
    for (let i = 0; i < pathDs.length; i++) {
      if (!pathDs[i]) continue
      const bounds = pathBounds[i]
      if (bounds.maxY < visibleStartRow - 1 || bounds.minY > visibleEndRow + 1) continue
      visible.push({ key: i, d: pathDs[i], color: resolveColor(paths[i].color), dashed: paths[i].dashed === true })
    }
    return visible
  }, [pathDs, pathBounds, paths, visibleStartRow, visibleEndRow])

  const visibleLinks = useMemo(() => {
    const visible: {
      key: number
      start: GraphLink['start']
      control: GraphLink['control']
      end: GraphLink['end']
      color: string
    }[] = []
    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const lowY = Math.min(link.start.y, link.end.y)
      const highY = Math.max(link.start.y, link.end.y)
      if (highY < visibleStartRow - 1 || lowY > visibleEndRow + 1) continue
      visible.push({
        key: i,
        start: link.start,
        control: link.control,
        end: link.end,
        color: resolveColor(link.color),
      })
    }
    return visible
  }, [links, visibleStartRow, visibleEndRow])

  const visibleDots = useMemo(() => {
    const start = Math.max(0, Math.min(visibleStartRow, totalRows))
    const end = Math.max(start, Math.min(visibleEndRow, totalRows, dots.length))
    if (end <= start) return []
    return dots.slice(start, end).map((dot, offset) => ({
      index: start + offset,
      center: dot.center,
      color: resolveColor(dot.color),
      type: dot.type,
      selected: start + offset === selectedIndex,
    }))
  }, [dots, visibleStartRow, visibleEndRow, totalRows, selectedIndex])

  if (totalRows === 0 || viewportHeight <= 0 || width <= 0) return null

  const translateY = -scrollTop

  return (
    <svg
      className="vcs-graph"
      aria-hidden="true"
      width={width}
      height={Math.max(0, viewportHeight)}
    >
      <g transform={`translate(0 ${translateY})`}>
        {visiblePaths.map((path) => (path.dashed ? (
          <path key={`path-${path.key}`} className="vcs-graph-path vcs-graph-path-dashed" d={path.d} stroke={path.color} />
        ) : (
          <g key={`path-${path.key}`}>
            <path className="vcs-graph-path-halo" d={path.d} stroke={path.color} />
            <path className="vcs-graph-path" d={path.d} stroke={path.color} />
          </g>
        )))}

        {visibleLinks.map((link) => {
          const d = linkPathD(link, rowHeight)
          return (
            <g key={`link-${link.key}`}>
              <path className="vcs-graph-link-halo" d={d} stroke={link.color} />
              <path className="vcs-graph-link" d={d} stroke={link.color} />
            </g>
          )
        })}

        {visibleDots.map((dot) => {
          const cx = dot.center.x
          const cy = dot.center.y * rowHeight
          if (dot.type === 'stash') {
            return <rect key={`dot-${dot.index}`} className="vcs-graph-dot vcs-graph-dot-stash"
              x={-4} y={-4} width={8} height={8} rx={1} transform={`translate(${cx} ${cy}) rotate(45)`} />
          }
          if (dot.type === 'worktree' || dot.type === 'working') {
            return (
              <g key={`dot-${dot.index}`}>
                {dot.selected ? (
                  <circle
                    className="vcs-graph-dot-selected"
                    cx={cx}
                    cy={cy}
                    r={SELECTED_RING_RADIUS}
                    stroke={dot.color}
                  />
                ) : null}
                <circle
                  className={`vcs-graph-dot ${dot.type === 'worktree' ? 'vcs-graph-dot-worktree' : 'vcs-graph-dot-working'}`}
                  cx={cx}
                  cy={cy}
                  r={HEAD_DOT_RADIUS}
                  fill="var(--dsw-alias-bg-base)"
                  stroke={dot.color}
                />
              </g>
            )
          }
          if (dot.type === 'head') {
            return (
              <g key={`dot-${dot.index}`}>
                {dot.selected ? (
                  <circle
                    className="vcs-graph-dot-selected"
                    cx={cx}
                    cy={cy}
                    r={SELECTED_RING_RADIUS}
                    stroke={dot.color}
                  />
                ) : null}
                <circle
                  className="vcs-graph-dot vcs-graph-dot-head"
                  cx={cx}
                  cy={cy}
                  r={HEAD_DOT_RADIUS}
                  fill="var(--dsw-alias-bg-base)"
                  stroke={dot.color}
                />
              </g>
            )
          }
          if (dot.type === 'merge') {
            return (
              <g key={`dot-${dot.index}`}>
                {dot.selected ? (
                  <circle
                    className="vcs-graph-dot-selected"
                    cx={cx}
                    cy={cy}
                    r={SELECTED_RING_RADIUS}
                    stroke={dot.color}
                  />
                ) : null}
                <circle
                  className="vcs-graph-dot vcs-graph-dot-merge"
                  cx={cx}
                  cy={cy}
                  r={DOT_RADIUS}
                  fill="var(--dsw-alias-bg-base)"
                  stroke={dot.color}
                />
              </g>
            )
          }
          return (
            <g key={`dot-${dot.index}`}>
              {dot.selected ? (
                <circle
                  className="vcs-graph-dot-selected"
                  cx={cx}
                  cy={cy}
                  r={SELECTED_RING_RADIUS}
                  stroke={dot.color}
                />
              ) : null}
              <circle className="vcs-graph-dot" cx={cx} cy={cy} r={DOT_RADIUS} fill={dot.color} />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/**
 * Build the quadratic merge-edge `d` attribute: start → control → end.
 *
 * @param link The merge edge.
 * @param rowHeight Pixel height of one row unit.
 * @returns `d` attribute.
 */
function linkPathD(link: Pick<GraphLink, 'start' | 'control' | 'end'>, rowHeight: number): string {
  const startX = link.start.x
  const startY = link.start.y * rowHeight
  const controlX = link.control.x
  const controlY = link.control.y * rowHeight
  const endX = link.end.x
  const endY = link.end.y * rowHeight
  return `M ${startX} ${startY} Q ${controlX} ${controlY}, ${endX} ${endY}`
}
