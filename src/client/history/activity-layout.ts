/** Two lanes show the order of activities and which entries belong together. */

import type { ActivityRow } from './activity-model.js'
import { HALF_LANE_UNIT, HALF_ROW_UNIT, LANE_INSET, LANE_PADDING, LANE_UNIT } from './layout.js'
import type { GraphLayout } from './layout.js'

const MAIN = LANE_INSET + HALF_LANE_UNIT
const SIDE = MAIN + LANE_UNIT
export const ACTIVITY_GUTTER = SIDE + LANE_PADDING

export function activityLayout(rows: readonly ActivityRow[], repositories: readonly string[]): GraphLayout {
  const colors = new Map(repositories.map((repo, index) => [repo, index]))
  const layout: GraphLayout = { paths: [], links: [], dots: [], commitLeftMargin: rows.map(() => ACTIVITY_GUTTER) }
  const center = (index: number) => index + HALF_ROW_UNIT
  let start = 0
  function finishDay(end: number) {
    if (end < start) return
    layout.paths.push({ color: 0, neutral: true, points: [{ x: MAIN, y: center(start) }, { x: MAIN, y: center(end) }] })
  }
  // Append the branches after the neutral spines so the activity color stays
  // visible at their junctions.
  const branches: GraphLayout['paths'] = []
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'day') {
      finishDay(index - 1)
      start = index + 1
      layout.dots.push(null)
      continue
    }
    const side = row.kind === 'child' || row.kind === 'member'
    const color = colors.get(row.entry.repo) ?? 0
    const y = center(index)
    const type = row.kind === 'burst' || row.kind === 'batch' ? row.kind
      : row.entry.kind === 'stash' ? 'stash' : row.entry.commit.parents.length > 1 ? 'merge' : 'default'
    layout.dots.push({ center: { x: side ? SIDE : MAIN, y }, color, type, ...(type === 'batch' && { neutral: true }) })
    if ((row.kind === 'burst' || row.kind === 'batch') && row.expanded) {
      const last = center(index + (row.kind === 'burst' ? row.earlier : row.count))
      branches.push({ color, ...(row.kind === 'batch' && { neutral: true }), points: [
        { x: MAIN, y }, { x: SIDE, y: y + HALF_ROW_UNIT }, { x: SIDE, y: last + 0.12 }, { x: MAIN, y: last + 0.44 },
      ] })
    }
  }
  finishDay(rows.length - 1)
  layout.paths.push(...branches)
  return layout
}
