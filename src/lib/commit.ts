/**
 * Commit metadata and the changed-file list of one commit.
 *
 * Metadata comes from one `git show -s` with NUL-separated fields so the full
 * message survives verbatim; the file list is a name-status run paired with a
 * numstat run keyed by the same paths.
 */

const NUL = String.fromCharCode(0)

/** Most files one commit detail lists. */
export const COMMIT_FILE_MAX = 500

/** Fields: commit, parents, author, author seconds, committer, committer seconds, subject, message. */
export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%at%x00%cn%x00%ct%x00%s%x00%B'

/** One commit's metadata, as one `git show -s` run reports it. */
export interface CommitMetadata {
  /** The full object id of the commit. */
  sha: string
  /** The full object ids of its parents; empty for a root commit. */
  parents: string[]
  /** The author's name. */
  author: string
  /** The author timestamp in milliseconds. */
  authorTime: number
  /** The committer's name. */
  committer: string
  /** The commit timestamp in milliseconds. */
  committerTime: number
  /** The subject line. */
  subject: string
  /** The full message, with trailing newlines trimmed. */
  message: string
}

/** One changed file as `--name-status -z` reports it. */
export interface CommitFileChange {
  /** The new path. */
  path: string
  /** One letter the view understands. */
  status: string
  /** The source path of a rename or copy. */
  origPath?: string
}

/** One changed file with its line counts. */
export interface CommitFile extends CommitFileChange {
  /** Added lines; 0 for a binary file. */
  added: number
  /** Deleted lines; 0 for a binary file. */
  deleted: number
  /** Whether the file is binary, which has no line counts. */
  binary: boolean
}

/** Line counts one path reports from `--numstat -z`. */
export interface NumstatCounts {
  added: number
  deleted: number
  binary: boolean
}

/**
 * Parse `git show -s` output produced with {@link COMMIT_FORMAT}.
 * @param text - the formatted metadata.
 * @returns the commit fields, or undefined when malformed.
 */
export function parseCommitMetadata(text: string): CommitMetadata | undefined {
  const fields = text.split(NUL)
  if (fields.length < 8) return undefined
  const [sha, parents, author, authorSeconds, committer, committerSeconds, subject] = fields
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) return undefined
  // The message is the remainder; it may contain newlines but never NUL.
  const message = fields.slice(7).join(NUL).replace(/\n+$/u, '')
  return {
    sha,
    parents: parents === '' ? [] : parents.split(' '),
    author,
    authorTime: Number(authorSeconds) * 1000,
    committer,
    committerTime: Number(committerSeconds) * 1000,
    subject,
    message,
  }
}

/**
 * The status letter and path of one changed file from `--name-status -z`.
 * @param code - the status code git printed.
 * @returns one letter the view understands.
 */
function statusLetter(code: string): string {
  const letter = code.slice(0, 1)
  // A type change (file to symlink and back) is a modification to the viewer.
  if (letter === 'T') return 'M'
  return 'ABCDMRU'.includes(letter) ? letter : 'M'
}

/**
 * Parse `git diff-tree --name-status -z` output.
 * @param text - NUL-separated records.
 * @returns the changed files.
 */
export function parseNameStatusZ(text: string): CommitFileChange[] {
  const fields = text.split(NUL)
  const changes: CommitFileChange[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]
    if (code === '') continue
    const letter = statusLetter(code)
    if (letter === 'R' || letter === 'C') {
      // A rename or copy carries its source before the destination.
      const origPath = fields[index + 1]
      const path = fields[index + 2]
      index += 2
      if (origPath === undefined || path === undefined || path === '') continue
      changes.push({ path, status: letter, origPath })
      continue
    }
    const path = fields[index + 1]
    index += 1
    if (path === undefined || path === '') continue
    changes.push({ path, status: letter })
  }
  return changes
}

/**
 * Pair name-status rows with numstat counts.
 * @param changes - name-status rows.
 * @param counts - numstat by new path.
 * @returns the changed files with their line counts.
 */
export function mergeCommitFiles(
  changes: CommitFileChange[],
  counts: Map<string, NumstatCounts>,
): CommitFile[] {
  return changes.map(change => {
    const measured = counts.get(change.path)
    return {
      path: change.path,
      status: change.status,
      ...(change.origPath === undefined ? {} : { origPath: change.origPath }),
      added: measured?.added ?? 0,
      deleted: measured?.deleted ?? 0,
      binary: measured?.binary === true,
    }
  })
}
