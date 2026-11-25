/**
 * `git log` and ref-decoration parsing.
 *
 * The format separates fields with NUL bytes, so an author or subject may hold
 * any character git allows without the record becoming ambiguous.
 */

const NUL = String.fromCharCode(0)

/** Largest page the log route returns. */
export const LOG_PAGE_MAX = 300

/** Deepest offset the history view walks before saying it is capped. */
export const LOG_SKIP_MAX = 10_000

/** Fields: commit, parents, author, author epoch seconds, subject, full decoration. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%s%x00%D'

/** One ref a commit row or ref list shows, shared by the backends and client. */
export interface VcsRef {
  name: string
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'bookmark'
  current?: boolean
  /** Configured remote name, on a split remote-tracking ref. */
  remote?: string
  /** Branch part below the remote name, on a split remote-tracking ref. */
  branch?: string
  conflict?: boolean
}

/** The commit row both history reads return. Times on the node are in milliseconds. */
export interface CommitNode {
  sha: string
  parents: string[]
  refs: VcsRef[]
  author: string
  authorTime: number
  subject: string
  changeId?: string
  committer?: string
  committerTime?: number
  message?: string
  workingCopy?: boolean
  empty?: boolean
  conflict?: boolean
}

/** One Git ref decoration. */
export interface Ref extends VcsRef {
  kind: 'head' | 'branch' | 'remote' | 'tag'
  current?: true
}

/** One formatted `git log` record. */
export interface LogCommit extends CommitNode {
  refs: Ref[]
}

/**
 * Classify one fully-qualified decorated ref name.
 * @param name - a ref name such as `refs/heads/main`.
 * @returns the short ref, or undefined for a ref this view does not show.
 */
export function classifyRefName(name: string): Ref | undefined {
  if (name.startsWith('refs/heads/')) {
    return { name: name.slice('refs/heads/'.length), kind: 'branch' }
  }
  if (name.startsWith('refs/remotes/')) {
    return { name: name.slice('refs/remotes/'.length), kind: 'remote' }
  }
  if (name.startsWith('refs/tags/')) {
    return { name: name.slice('refs/tags/'.length), kind: 'tag' }
  }
  return undefined
}

/**
 * Parse a `%D` decoration into the refs a commit row shows.
 *
 * `--decorate=full` yields forms such as `HEAD -> refs/heads/main`,
 * `tag: refs/tags/v1` and `refs/remotes/origin/main`. A HEAD that points to a
 * branch becomes that branch marked `current`; a bare `HEAD` (detached) stays
 * its own `head` ref, so a detached HEAD at a branch tip is not mistaken for
 * being on that branch.
 *
 * @param value - the decoration text, possibly empty.
 * @returns the refs.
 */
export function parseDecoration(value: string): Ref[] {
  const refs: Ref[] = []
  if (value === '') return refs
  for (const raw of value.split(', ')) {
    const token = raw.trim()
    if (token === '') continue
    if (token === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (token.startsWith('HEAD -> ')) {
      const target = classifyRefName(token.slice('HEAD -> '.length))
      if (target?.kind === 'branch') refs.push({ ...target, current: true })
      else refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (token.startsWith('tag: ')) {
      const target = classifyRefName(token.slice('tag: '.length))
      if (target !== undefined) refs.push(target)
      continue
    }
    const target = classifyRefName(token)
    if (target !== undefined) refs.push(target)
  }
  return refs
}

/**
 * Attach the configured remote and branch to remote-tracking refs.
 *
 * A remote-tracking ref's short name is `remote/branch`, but a remote name may
 * itself contain slashes. Matching configured remote names longest-first keeps
 * `origin/feature/topic` split as `origin` + `feature/topic` when only
 * `origin` exists, and as the longer remote when one is configured.
 *
 * @param commits - parsed commits with `refs`.
 * @param remotes - configured remote names.
 * @returns the commits, with split metadata on resolved remote refs.
 */
export function annotateRemoteRefs<T extends { refs: Ref[] }>(commits: T[], remotes: string[]): T[] {
  const ordered = [...remotes].sort((first, second) => second.length - first.length)
  return commits.map(commit => {
    if (!commit.refs.some(ref => ref.kind === 'remote')) return commit
    return {
      ...commit,
      refs: commit.refs.map(ref => {
        if (ref.kind !== 'remote') return ref
        for (const remote of ordered) {
          if (!ref.name.startsWith(`${remote}/`)) continue
          const branch = ref.name.slice(remote.length + 1)
          // `refs/remotes/<remote>/HEAD` is a symbolic convenience ref, not
          // a deletable branch, so it stays a plain display ref. An empty
          // branch means the ref is exactly a remote name; try a shorter one.
          if (branch === '' || branch === 'HEAD') continue
          return { ...ref, remote, branch }
        }
        return ref
      }),
    }
  })
}

/**
 * Parse one `git for-each-ref --format=%(refname)` or `%(refname)%00%(HEAD)` line list.
 * @param text - newline-separated ref records.
 * @returns the refs.
 */
export function parseRefNames(text: string): Ref[] {
  const refs: Ref[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const [name, marker] = line.split(NUL)
    const ref = classifyRefName(name)
    if (ref === undefined) continue
    if (ref.kind === 'branch' && marker === '*') refs.push({ ...ref, current: true })
    else refs.push(ref)
  }
  return refs
}

/**
 * Parse formatted `git log` output into commit rows.
 * @param text - one record per line, fields NUL-separated.
 * @returns the commits, newest first as git printed them.
 */
export function parseLog(text: string): LogCommit[] {
  const commits: LogCommit[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const fields = line.split(NUL)
    if (fields.length < 6) continue
    const [sha, parents, author, seconds, subject, decoration, committerSeconds] = fields
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) continue
    commits.push({
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      refs: parseDecoration(decoration ?? ''),
      author,
      authorTime: Number(seconds) * 1000,
      subject,
      ...committerSeconds !== undefined && { committerTime: Number(committerSeconds) * 1000 },
    })
  }
  return commits
}
