/**
 * Unified-diff parsing and the file content checks the diff route needs.
 *
 * Git computes the comparison; this module only turns it into the hunk shape
 * the client's FileDiff renders, keeping every line's leading ` `, `+` or `-`.
 */

/** Largest diff this route renders, in output bytes. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024

/** Largest diff this route renders, in hunk lines. */
export const DIFF_MAX_LINES = 5000

/** One renderable hunk, keeping every line's leading ` `, `+` or `-`. */
export interface DiffHunk {
  /** First line number on the old side. */
  oldStart: number
  /** Old-side line count. */
  oldLines: number
  /** First line number on the new side. */
  newStart: number
  /** New-side line count. */
  newLines: number
  /** The hunk's lines, each with its prefix. */
  lines: string[]
}

/** One parsed comparison: its hunks and whether each side exists. */
export interface DiffComparison {
  /** The hunks to render. */
  hunks: DiffHunk[]
  /** False when the old side is `/dev/null` (a created file). */
  before: boolean
  /** False when the new side is `/dev/null` (a deleted file). */
  after: boolean
}

/**
 * Parse `git diff` output into renderable hunks.
 *
 * Lines outside a hunk (index, mode, rename and file headers) are skipped, as
 * are `\ No newline at end of file` markers. `before` and `after` come from the
 * `/dev/null` headers, so a created or deleted file is recognisable even when
 * the file is empty and produces no hunk.
 *
 * @param text - unified diff output.
 * @param markNoNewline - receives the location of an EOF marker's line.
 * @returns the parsed comparison.
 */
export function parseUnifiedDiff(
  text: string,
  markNoNewline?: (hunk: number, line: number) => void,
): DiffComparison {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === null) continue
    if (line === '\\ No newline at end of file' && current.lines.length > 0) {
      markNoNewline?.(hunks.length - 1, current.lines.length - 1)
    }
    if (line === '' || line.startsWith('\\')) continue
    const prefix = line[0]
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') continue
    current.lines.push(line)
  }
  return {
    hunks,
    before: !/^--- \/dev\/null$/mu.test(text),
    after: !/^\+\+\+ \/dev\/null$/mu.test(text),
  }
}

/**
 * How many files one diff output describes.
 * More than one means the requested path matched a directory or a broad
 * pathspec, which this view never renders as a single file.
 * @param text - diff output.
 * @returns the number of `diff --git` headers.
 */
export function fileHeaderCount(text: string): number {
  const matched = text.match(/^diff --git /gmu)
  return matched === null ? 0 : matched.length
}

/**
 * Whether git reported a binary comparison in its human diff.
 * @param text - diff output.
 * @returns true for a "Binary files ... differ" record.
 */
export function isBinaryDiff(text: string): boolean {
  return /^Binary files .* differ$/mu.test(text)
}

/**
 * Present a whole file as one all-additions hunk.
 * @param text - the file's decoded text.
 * @returns the comparison.
 */
export function syntheticNewFile(text: string): DiffComparison {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const hunks: DiffHunk[] = lines.length === 0
    ? []
    : [{
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map(line => `+${line}`),
      }]
  return { hunks, before: false, after: true }
}

/**
 * Total number of rendered hunk lines.
 * @param hunks - the hunks.
 * @returns the line count.
 */
export function countRenderedLines(hunks: { lines: string[] }[]): number {
  let total = 0
  for (const hunk of hunks) total += hunk.lines.length
  return total
}

/**
 * Decode a file's bytes as text, or report it as binary.
 *
 * A file is binary when it contains NUL or when decoding and re-encoding does
 * not reproduce the bytes; replacement characters must never be shown as if
 * they were the file.
 *
 * @param bytes - raw file bytes.
 * @returns the decode result.
 */
export function decodeFileContent(bytes: Uint8Array): { binary: true } | { binary: false, text: string } {
  const buffer = Buffer.from(bytes)
  if (buffer.includes(0)) return { binary: true }
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) return { binary: true }
  return { binary: false, text }
}
