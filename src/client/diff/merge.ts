/**
 * Combine a staged and an unstaged comparison into one merged text comparison.
 *
 * Each hunk is re-expressed in index coordinates (a shared line has the same
 * index position in both comparisons), then overlapping index spans are
 * clustered and rebuilt so the two comparisons share one row per line. Every
 * changed row keeps the origin that says which comparison stages it.
 */

import type { DiffSide, LineOrigin, VcsHunk, VcsTextDiff } from './FileDiff.js'

/** One hunk line with its index-relative position. */
interface IndexedRow {
  at: number
  text: string
  origin: LineOrigin | null
}

/** One hunk annotated with index coordinates. */
interface IndexedHunk {
  hunk: VcsHunk
  side: DiffSide
  rows: IndexedRow[]
  start: number
  end: number
}

/** A run of indexed hunks whose index spans touch. */
interface IndexedCluster {
  start: number
  end: number
  hunks: IndexedHunk[]
}

/**
 * Annotate one hunk in index coordinates. Odd positions are gaps before an index line.
 * @param hunk - the served hunk.
 * @param side - the comparison the hunk came from.
 * @param position - the hunk's position within its comparison.
 * @returns the hunk with its rows in index coordinates.
 */
function indexHunk(hunk: VcsHunk, side: DiffSide, position: number): IndexedHunk {
  const staged = side === 'staged'
  const start = staged ? hunk.newStart : hunk.oldStart
  const count = staged ? hunk.newLines : hunk.oldLines
  let indexLine = start + (count === 0 ? 1 : 0)
  const rows = hunk.lines.map((text, line) => {
    const marker = text[0]
    const gap = marker === (staged ? '-' : '+')
    const at = indexLine * 2 - Number(gap)
    if (!gap) indexLine += 1
    return { at, text, origin: marker === ' ' ? null : { side, hunk: position, line } }
  })
  return { hunk, side, rows, start: rows[0].at, end: rows.at(-1)!.at }
}

/** Combine the two index-relative patches while retaining every changed row's origin. */
export function mergeDiffs(staged: VcsTextDiff, unstaged: VcsTextDiff): VcsTextDiff {
  const sources: Record<DiffSide, VcsTextDiff> = { staged, unstaged }
  const ordered = (['staged', 'unstaged'] as const).flatMap(side =>
    sources[side].hunks.flatMap((hunk, position) =>
      hunk.lines.length === 0 ? [] : [indexHunk(hunk, side, position)]))
    .sort((a, b) => a.start - b.start)
  const clusters: IndexedCluster[] = []
  for (const hunk of ordered) {
    const current = clusters.at(-1)
    if (current === undefined || hunk.start > current.end + 1) {
      clusters.push({ start: hunk.start, end: hunk.end, hunks: [hunk] })
    } else {
      current.hunks.push(hunk)
      current.end = Math.max(current.end, hunk.end)
    }
  }

  // Differences in line counts shift the outer coordinates of all later hunks.
  let headOffset = 0
  let worktreeOffset = 0
  const hunks = clusters.flatMap(cluster => {
    const indexStart = Math.ceil(cluster.start / 2)
    const oldStart = indexStart + headOffset
    const newStart = indexStart + worktreeOffset
    const positions = new Map<number, IndexedRow[]>()
    for (const source of cluster.hunks) {
      const { oldLines, newLines } = source.hunk
      if (source.side === 'staged') headOffset += oldLines - newLines
      else worktreeOffset += newLines - oldLines
      for (const row of source.rows) {
        const at = positions.get(row.at) ?? []
        at.push(row)
        positions.set(row.at, at)
      }
    }

    const rows: IndexedRow[] = []
    for (const [at, candidates] of [...positions].sort(([a], [b]) => a - b)) {
      const changes = candidates.filter(row => row.origin !== null)
      if (at % 2 === 0 && (changes.length > 1 || candidates.some(row => row.text.slice(1) !== candidates[0].text.slice(1)))) {
        // The index contains an intermediate edit, or the two snapshots disagree.
        // Preserve each original comparison and its coordinates for this region.
        return [...cluster.hunks].sort((a, b) => Number(a.side !== 'staged') - Number(b.side !== 'staged'))
          .map(({ hunk, side, rows: originalRows }) => ({ ...hunk, side, origins: originalRows.map(row => row.origin) }))
      }
      if (changes.length === 0) rows.push(candidates[0])
      else rows.push(...changes.sort((a, b) => Number(a.text[0] === '+') - Number(b.text[0] === '+')))
    }
    const lines = rows.map(row => row.text)
    const oldLines = lines.filter(line => line[0] !== '+').length
    const newLines = lines.filter(line => line[0] !== '-').length
    return [{
      oldStart: oldStart - Number(oldLines === 0), oldLines,
      newStart: newStart - Number(newLines === 0), newLines,
      lines, origins: rows.map(row => row.origin),
    }]
  })
  return { kind: 'text', path: unstaged.path, before: staged.before, after: unstaged.after, hunks }
}
