/**
 * `git status --porcelain=v2 -z` and `git diff --numstat -z` parsing.
 *
 * Porcelain keeps paths NUL-terminated so spaces, tabs and non-ASCII bytes need
 * no quoting; rename records carry the original path as an extra NUL field.
 */

const NUL = String.fromCharCode(0)

/** Most files one status group lists. */
export const STATUS_GROUP_MAX = 500

/** Branch facts parsed from the porcelain v2 `# branch.*` headers. */
export interface StatusBranch {
  /** Checked-out branch name, or null when detached or unborn. */
  name: string | null
  /** Head commit id, or null for an unborn branch. */
  oid: string | null
  /** True when HEAD is detached. */
  detached: boolean
  /** True when the branch has no commits yet. */
  unborn: boolean
  /** Configured upstream ref, or null. */
  upstream: string | null
  /** Commits ahead of the upstream. */
  ahead: number
  /** Commits behind the upstream. */
  behind: number
}

/** One raw entry from the porcelain v2 record body. */
export interface StatusEntry {
  /** Repository-relative path. */
  path: string
  /** `?` record: the path is untracked. */
  untracked?: true
  /** `1`/`2` record: the index-side letter, or null when unchanged. */
  index?: string | null
  /** `1`/`2` record: the working-tree-side letter, or null when unchanged. */
  worktree?: string | null
  /** `2` record: the rename or copy source. */
  origPath?: string
  /** `u` record: both sides conflict. */
  conflict?: true
}

/** Branch facts and raw entries from one porcelain v2 run. */
export interface PorcelainStatus {
  /** The branch facts. */
  branch: StatusBranch
  /** The raw entries, before grouping. */
  entries: StatusEntry[]
}

/** Line counts from one `git diff --numstat` record. */
export interface Numstat {
  /** Lines added, or 0 for a binary file. */
  added: number
  /** Lines deleted, or 0 for a binary file. */
  deleted: number
  /** True when numstat reported `-` counts. */
  binary: boolean
}

/** The three groups the change tree renders. */
export interface StatusGroups {
  /** Files changed between HEAD and the index. */
  staged: FileEntry[]
  /** Files changed between the index and the working tree. */
  unstaged: FileEntry[]
  /** Untracked files and directories. */
  untracked: FileEntry[]
}

/** One row the change tree renders. */
export interface FileEntry {
  /** Repository-relative path. */
  path: string
  /** The letter this row shows. */
  status: string
  /** Rename or copy source, on the side that reports R or C. */
  origPath?: string
  /** Lines added. */
  added: number
  /** Lines deleted. */
  deleted: number
  /** True when the backend cannot render a textual diff. */
  binary?: boolean
  /** True for an untracked file. */
  untracked?: boolean
  /** True for an untracked directory row. */
  directory?: boolean
  /** True for a conflicted path. */
  conflict?: boolean
  /** True when the other side also lists this path. */
  partiallyStaged?: boolean
}

/**
 * Read the first `count` space-separated fields of a record.
 * The remainder is the path, which may itself contain spaces or tabs.
 * @param line - the record without its kind prefix.
 * @param count - fixed fields before the path.
 * @returns the split record, or undefined when a field is missing.
 */
function takeFields(line: string, count: number): { fields: string[], rest: string } | undefined {
  const fields: string[] = new Array(count)
  let index = 0
  for (let position = 0; position < count; position += 1) {
    const space = line.indexOf(' ', index)
    if (space < 0) return undefined
    fields[position] = line.slice(index, space)
    index = space + 1
  }
  return { fields, rest: line.slice(index) }
}

/**
 * One side of an XY status pair: `.` means "no change on this side".
 * @param value - the letter.
 * @returns the letter, or null.
 */
function sideLetter(value: string | undefined): string | null {
  return value === undefined || value === '.' ? null : value
}

/**
 * Branch facts and raw entries from one porcelain v2 run.
 *
 * Entries keep both sides so the caller can put a file that changed in the
 * index and again in the working tree into both groups.
 *
 * @param text - NUL-separated porcelain v2 output.
 * @returns the branch facts and the raw entries.
 */
export function parsePorcelainV2(text: string): PorcelainStatus {
  const fields = text.split(NUL)
  const branch: StatusBranch = {
    name: null,
    oid: null,
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  }
  const entries: StatusEntry[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') continue

    if (field.startsWith('# ')) {
      const space = field.indexOf(' ', 2)
      if (space < 0) continue
      const key = field.slice(2, space)
      const value = field.slice(space + 1)
      if (key === 'branch.oid') {
        // A repository with no commits reports the literal `(initial)`, which
        // is not an object id; naming that an oid would render a broken commit.
        if (value === '(initial)') branch.unborn = true
        else branch.oid = value
      } else if (key === 'branch.head') {
        if (value === '(detached)') branch.detached = true
        else branch.name = value
      } else if (key === 'branch.upstream') {
        branch.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/u.exec(value)
        if (match !== null) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }

    const kind = field[0]

    if (kind === '?') {
      const path = field.slice(2)
      if (path !== '') entries.push({ path, untracked: true })
      continue
    }
    if (kind === '!') continue

    if (kind === '1' || kind === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
      const parsed = takeFields(field.slice(2), kind === '1' ? 7 : 8)
      if (parsed === undefined) continue
      const xy = parsed.fields[0]
      let origPath
      if (kind === '2') {
        // With -z the rename source follows the record as its own NUL field.
        origPath = fields[index + 1]
        index += 1
      }
      if (parsed.rest === '') continue
      entries.push({
        path: parsed.rest,
        index: sideLetter(xy[0]),
        worktree: sideLetter(xy[1]),
        ...(origPath === undefined || origPath === '' ? {} : { origPath }),
      })
      continue
    }

    if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parsed = takeFields(field.slice(2), 9)
      if (parsed === undefined || parsed.rest === '') continue
      entries.push({ path: parsed.rest, index: 'U', worktree: 'U', conflict: true })
    }
  }

  return { branch, entries }
}

/**
 * Line counts per path from one `git diff --numstat -z` run.
 *
 * A rename prints an empty path field followed by two NUL-separated paths; the
 * new path is the one rows are keyed by.
 *
 * @param text - NUL-separated numstat output.
 * @returns counts by path.
 */
export function parseNumstat(text: string): Map<string, Numstat> {
  const counts = new Map<string, Numstat>()
  const fields = text.split(NUL)
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') continue
    const first = field.indexOf('\t')
    if (first < 0) continue
    const second = field.indexOf('\t', first + 1)
    if (second < 0) continue
    const added = field.slice(0, first)
    const deleted = field.slice(first + 1, second)
    let path = field.slice(second + 1)
    if (path === '') {
      path = fields[index + 2] ?? ''
      index += 2
    }
    if (path === '') continue
    const binary = added === '-' || deleted === '-'
    counts.set(path, {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return counts
}

/**
 * Build one status file row.
 * @param entry - parsed status entry.
 * @param status - the letter for this group.
 * @param counts - numstat for this side.
 * @returns the row.
 */
function fileEntry(entry: StatusEntry, status: string, counts: Map<string, Numstat>): FileEntry {
  const measured = counts.get(entry.path)
  return {
    path: entry.path,
    status,
    // The rename source belongs to the side that reports R or C; the other
    // side's letter describes that same file without a rename.
    ...(entry.origPath !== undefined && (status === 'R' || status === 'C') ? { origPath: entry.origPath } : {}),
    added: measured?.added ?? 0,
    deleted: measured?.deleted ?? 0,
    ...(measured?.binary === true ? { binary: true } : {}),
  }
}

/**
 * Put parsed entries into the three groups the view renders.
 *
 * A file changed on both sides appears in both groups. Conflicts, which have no
 * group of their own in this contract, are `U` on both sides. Untracked files
 * are `U` against the index and carry `untracked: true`; untracked directories
 * keep their trailing slash and gain `directory: true`. Their contents are read
 * by the untracked route only when the row is opened.
 *
 * @param entries - parsed status entries.
 * @param stagedCounts - numstat of the index side.
 * @param unstagedCounts - numstat of the working-tree side.
 * @returns the three groups, whether any was capped, and the raw entry count.
 */
export function buildStatusGroups(
  entries: StatusEntry[],
  stagedCounts: Map<string, Numstat>,
  unstagedCounts: Map<string, Numstat>,
): {
  groups: { staged: FileEntry[], unstaged: FileEntry[], untracked: FileEntry[] }
  truncated: boolean
  total: number
  untrackedTotal: number
} {
  const staged: FileEntry[] = []
  const unstaged: FileEntry[] = []
  const untracked: FileEntry[] = []

  for (const entry of entries) {
    if (entry.untracked === true) {
      const directory = entry.path.endsWith('/')
      untracked.push({
        path: entry.path,
        status: 'U',
        untracked: true,
        added: 0,
        deleted: 0,
        ...(directory ? { directory: true } : {}),
      })
      continue
    }
    if (entry.conflict === true) {
      staged.push({ path: entry.path, status: 'U', added: 0, deleted: 0 })
      unstaged.push({ path: entry.path, status: 'U', added: 0, deleted: 0 })
      continue
    }
    if (entry.index !== null && entry.index !== undefined) staged.push(fileEntry(entry, entry.index, stagedCounts))
    if (entry.worktree !== null && entry.worktree !== undefined) unstaged.push(fileEntry(entry, entry.worktree, unstagedCounts))
  }

  // Mark paths before truncating the groups so a visible row knows about the other side.
  const stagedByPath = new Map<string, FileEntry>(staged.map(entry => [entry.path, entry]))
  for (const entry of [...unstaged, ...untracked]) {
    const stagedEntry = stagedByPath.get(entry.path)
    if (stagedEntry === undefined || stagedEntry.status === 'U') continue
    stagedEntry.partiallyStaged = true
    entry.partiallyStaged = true
  }

  const cap = (list: FileEntry[]): FileEntry[] => {
    if (list.length <= STATUS_GROUP_MAX) return list
    return list.slice(0, STATUS_GROUP_MAX)
  }
  const truncated = [staged, unstaged, untracked].some(list => list.length > STATUS_GROUP_MAX)

  return {
    groups: { staged: cap(staged), unstaged: cap(unstaged), untracked: cap(untracked) },
    truncated,
    // The raw record count, so a cut group is distinguishable from a small one.
    total: entries.length,
    untrackedTotal: untracked.length,
  }
}
