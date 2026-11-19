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

/**
 * Parse `git diff` output into renderable hunks.
 *
 * Lines outside a hunk (index, mode, rename and file headers) are skipped, as
 * are `\ No newline at end of file` markers. `before` and `after` come from the
 * `/dev/null` headers, so a created or deleted file is recognisable even when
 * the file is empty and produces no hunk.
 *
 * @param {string} text - unified diff output.
 * @param {(hunk: number, line: number) => void} [markNoNewline] - receives the location of an EOF marker's line.
 * @returns {{ hunks: { oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }[], before: boolean, after: boolean }}
 */
export function parseUnifiedDiff(text, markNoNewline) {
  const hunks = []
  let current = null
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
 * @param {string} text - diff output.
 * @returns {number} the number of `diff --git` headers.
 */
export function fileHeaderCount(text) {
  const matched = text.match(/^diff --git /gmu)
  return matched === null ? 0 : matched.length
}

/**
 * Whether git reported a binary comparison in its human diff.
 * @param {string} text - diff output.
 * @returns {boolean} true for a "Binary files ... differ" record.
 */
export function isBinaryDiff(text) {
  return /^Binary files .* differ$/mu.test(text)
}

/**
 * Present a whole file as one all-additions hunk.
 * @param {string} text - the file's decoded text.
 * @returns {{ hunks: object[], before: boolean, after: boolean }} the comparison.
 */
export function syntheticNewFile(text) {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const hunks = lines.length === 0
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
 * @param {{ lines: string[] }[]} hunks - the hunks.
 * @returns {number} the line count.
 */
export function countRenderedLines(hunks) {
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
 * @param {Uint8Array} bytes - raw file bytes.
 * @returns {{ binary: true } | { binary: false, text: string }} the decode result.
 */
export function decodeFileContent(bytes) {
  const buffer = Buffer.from(bytes)
  if (buffer.includes(0)) return { binary: true }
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) return { binary: true }
  return { binary: false, text }
}
