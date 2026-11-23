import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMIT_FORMAT,
  mergeCommitFiles,
  parseCommitMetadata,
  parseNameStatusZ,
} from '../lib/commit.js'
import {
  countRenderedLines,
  decodeFileContent,
  fileHeaderCount,
  isBinaryDiff,
  parseUnifiedDiff,
  syntheticNewFile,
} from '../lib/diff.js'
import {
  annotateRemoteRefs,
  classifyRefName,
  parseDecoration,
  parseLog,
  parseRefNames,
} from '../lib/log.js'
import {
  isFullSha,
  repositoryName,
  sameRepoPath,
  validateRelPath,
  validateSha,
} from '../lib/paths.js'
import { buildStatusGroups, parseNumstat, parsePorcelainV2, STATUS_GROUP_MAX } from '../lib/status.js'
import {
  isJjBinaryDiff,
  jjFilePattern,
  mergeJjFiles,
  parseJjCommit,
  parseJjEntry,
  parseJjRefs,
  parseJjStats,
} from '../lib/jujutsu.js'

const NUL = '\u0000'
const SHA = 'a'.repeat(40)

/** Join records the way git does, with a trailing terminator. */
function z(parts) {
  return `${parts.join(NUL)}${NUL}`
}

test('parsePorcelainV2 reads branch headers and every entry kind', () => {
  const text = z([
    '# branch.oid ' + SHA,
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 1111111 2222222 staged.txt',
    '1 .M N... 100644 100644 100644 1111111 2222222 unstaged.txt',
    '1 MM N... 100644 100644 100644 1111111 2222222 both.txt',
    '2 RM N... 100644 100644 100644 1111111 2222222 R100 renamed.txt',
    'old-name.txt',
    'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt',
    '? untracked.txt',
    '? untracked-dir/',
    '! ignored.txt',
  ])

  const { branch, entries } = parsePorcelainV2(text)

  assert.deepEqual(branch, {
    name: 'main',
    oid: SHA,
    detached: false,
    unborn: false,
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  })
  assert.equal(entries.length, 7)
  assert.deepEqual(entries[0], { path: 'staged.txt', index: 'M', worktree: null })
  assert.deepEqual(entries[1], { path: 'unstaged.txt', index: null, worktree: 'M' })
  assert.deepEqual(entries[2], { path: 'both.txt', index: 'M', worktree: 'M' })
  assert.deepEqual(entries[3], {
    path: 'renamed.txt',
    index: 'R',
    worktree: 'M',
    origPath: 'old-name.txt',
  })
  assert.deepEqual(entries[4], { path: 'conflict.txt', index: 'U', worktree: 'U', conflict: true })
  assert.deepEqual(entries[5], { path: 'untracked.txt', untracked: true })
  assert.deepEqual(entries[6], { path: 'untracked-dir/', untracked: true })
})

test('parsePorcelainV2 recognises detached and unborn heads', () => {
  const detached = parsePorcelainV2(z(['# branch.oid ' + SHA, '# branch.head (detached)']))
  assert.equal(detached.branch.detached, true)
  assert.equal(detached.branch.name, null)
  assert.equal(detached.branch.oid, SHA)

  const unborn = parsePorcelainV2(z(['# branch.oid (initial)', '# branch.head main']))
  assert.equal(unborn.branch.unborn, true)
  assert.equal(unborn.branch.oid, null)
  assert.equal(unborn.branch.name, 'main')
})

test('parsePorcelainV2 keeps the path after fixed fields when it contains spaces', () => {
  const { entries } = parsePorcelainV2(
    z(['1 .M N... 100644 100644 100644 1111111 2222222 dir with space/file name.txt']),
  )
  assert.equal(entries[0].path, 'dir with space/file name.txt')
})

test('buildStatusGroups splits sides, marks conflict and untracked directories, and caps at 500', () => {
  const { entries } = parsePorcelainV2(
    z([
      '1 M. N... 100644 100644 100644 1111111 2222222 staged.txt',
      '1 .M N... 100644 100644 100644 1111111 2222222 unstaged.txt',
      '1 MM N... 100644 100644 100644 1111111 2222222 both.txt',
      '2 RM N... 100644 100644 100644 1111111 2222222 R100 renamed.txt',
      'old-name.txt',
      'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt',
      '? untracked.txt',
      '? untracked-dir/',
    ]),
  )
  const stagedCounts = new Map([
    ['staged.txt', { added: 3, deleted: 1, binary: false }],
    ['both.txt', { added: 5, deleted: 0, binary: false }],
    ['renamed.txt', { added: 0, deleted: 0, binary: false }],
  ])
  const unstagedCounts = new Map([
    ['both.txt', { added: 2, deleted: 2, binary: false }],
    ['unstaged.txt', { added: 0, deleted: 0, binary: true }],
    ['renamed.txt', { added: 1, deleted: 1, binary: false }],
  ])

  const grouped = buildStatusGroups(entries, stagedCounts, unstagedCounts)
  assert.deepEqual(grouped.groups.staged, [
    { path: 'staged.txt', status: 'M', added: 3, deleted: 1 },
    { path: 'both.txt', status: 'M', added: 5, deleted: 0, partiallyStaged: true },
    { path: 'renamed.txt', status: 'R', origPath: 'old-name.txt', added: 0, deleted: 0, partiallyStaged: true },
    { path: 'conflict.txt', status: 'U', added: 0, deleted: 0 },
  ])
  assert.deepEqual(grouped.groups.unstaged, [
    { path: 'unstaged.txt', status: 'M', added: 0, deleted: 0, binary: true },
    { path: 'both.txt', status: 'M', added: 2, deleted: 2, partiallyStaged: true },
    { path: 'renamed.txt', status: 'M', added: 1, deleted: 1, partiallyStaged: true },
    { path: 'conflict.txt', status: 'U', added: 0, deleted: 0 },
  ])
  assert.deepEqual(grouped.groups.untracked, [
    { path: 'untracked.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
    { path: 'untracked-dir/', status: 'U', untracked: true, added: 0, deleted: 0, directory: true },
  ])
  assert.equal(grouped.truncated, false)
  assert.equal(grouped.total, entries.length)
  assert.equal(grouped.untrackedTotal, 2)

  const many = Array.from({ length: STATUS_GROUP_MAX + 1 }, (_, index) => ({
    path: `file-${index}.txt`,
    index: 'M',
    worktree: index === STATUS_GROUP_MAX ? 'M' : null,
  }))
  const capped = buildStatusGroups(many, new Map(), new Map())
  assert.equal(capped.groups.staged.length, STATUS_GROUP_MAX)
  assert.equal(capped.groups.unstaged[0].partiallyStaged, true)
  assert.equal(capped.truncated, true)
  assert.equal(capped.total, STATUS_GROUP_MAX + 1)
  assert.equal(capped.untrackedTotal, 0)

  const cappedUntracked = buildStatusGroups(many.map(({ path }) => ({ path, untracked: true })), new Map(), new Map())
  assert.equal(cappedUntracked.groups.untracked.length, STATUS_GROUP_MAX)
  assert.equal(cappedUntracked.untrackedTotal, STATUS_GROUP_MAX + 1)
})

test('parseNumstat reads counts, binaries, and renames keyed by the new path', () => {
  const counts = parseNumstat(z(['1\t2\ta.txt', '-\t-\tbin.dat', '0\t0\t', 'old.txt', 'new.txt']))
  assert.deepEqual(counts.get('a.txt'), { added: 1, deleted: 2, binary: false })
  assert.deepEqual(counts.get('bin.dat'), { added: 0, deleted: 0, binary: true })
  assert.deepEqual(counts.get('new.txt'), { added: 0, deleted: 0, binary: false })
  assert.equal(counts.has('old.txt'), false)
})

test('parseUnifiedDiff keeps line prefixes and hunk coordinates', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ -10 +10,2 @@',
    '-old',
    '+new',
    '+more',
    '\\ No newline at end of file',
    '',
  ].join('\n')

  const parsed = parseUnifiedDiff(text)
  assert.equal(parsed.before, true)
  assert.equal(parsed.after, true)
  assert.equal(parsed.hunks.length, 2)
  assert.deepEqual(parsed.hunks[0], {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [' one', '-two', '+TWO', ' three'],
  })
  assert.deepEqual(parsed.hunks[1], {
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 2,
    lines: ['-old', '+new', '+more'],
  })
  assert.equal(countRenderedLines(parsed.hunks), 7)
  assert.equal(fileHeaderCount(text), 1)
})

test('parseUnifiedDiff reports created and deleted files from /dev/null headers', () => {
  const created = parseUnifiedDiff([
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
  ].join('\n'))
  assert.equal(created.before, false)
  assert.equal(created.after, true)
  assert.deepEqual(created.hunks[0].lines, ['+a', '+b'])

  const deleted = parseUnifiedDiff([
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-a',
  ].join('\n'))
  assert.equal(deleted.before, true)
  assert.equal(deleted.after, false)

  const unchanged = parseUnifiedDiff('diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n')
  assert.deepEqual(unchanged.hunks, [])
  assert.equal(unchanged.before, true)
  assert.equal(unchanged.after, true)
})

test('fileHeaderCount and isBinaryDiff separate multi-file and binary output', () => {
  const two = 'diff --git a/a b/a\ndiff --git a/b b/b\n'
  assert.equal(fileHeaderCount(two), 2)
  assert.equal(isBinaryDiff('Binary files a/x.bin and b/x.bin differ\n'), true)
  assert.equal(isBinaryDiff('diff --git a/x b/x\n'), false)
})

test('syntheticNewFile presents a whole file as additions', () => {
  const normal = syntheticNewFile('a\nb\n')
  assert.deepEqual(normal, {
    before: false,
    after: true,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
  })

  const trailingBlank = syntheticNewFile('a\n\n')
  assert.deepEqual(trailingBlank.hunks[0].lines, ['+a', '+'])
  assert.equal(trailingBlank.hunks[0].newLines, 2)

  assert.deepEqual(syntheticNewFile(''), { before: false, after: true, hunks: [] })
})

test('decodeFileContent distinguishes text, NUL, and invalid UTF-8', () => {
  assert.deepEqual(decodeFileContent(Buffer.from('hello\n')), { binary: false, text: 'hello\n' })
  assert.deepEqual(decodeFileContent(Buffer.from([0x00, 0x01])), { binary: true })
  assert.deepEqual(decodeFileContent(Buffer.from([0xff, 0xfe])), { binary: true })
})

test('annotateRemoteRefs splits remote refs with the longest configured remote', () => {
  const commits = [{
    sha: SHA,
    refs: [
      { name: 'main', kind: 'branch', current: true },
      { name: 'origin/main', kind: 'remote' },
      { name: 'upstream/feature/x', kind: 'remote' },
      { name: 'origin/HEAD', kind: 'remote' },
      { name: 'v1', kind: 'tag' },
    ],
  }]
  const annotated = annotateRemoteRefs(commits, ['origin', 'upstream'])
  assert.deepEqual(annotated[0].refs, [
    { name: 'main', kind: 'branch', current: true },
    { name: 'origin/main', kind: 'remote', remote: 'origin', branch: 'main' },
    { name: 'upstream/feature/x', kind: 'remote', remote: 'upstream', branch: 'feature/x' },
    { name: 'origin/HEAD', kind: 'remote' },
    { name: 'v1', kind: 'tag' },
  ])
  assert.equal(commits[0].refs[1].remote, undefined, 'the parsed commits are not mutated')

  const nested = annotateRemoteRefs(
    [{ refs: [{ name: 'foo/bar/topic', kind: 'remote' }] }],
    ['foo', 'foo/bar'],
  )
  assert.deepEqual(nested[0].refs[0], {
    name: 'foo/bar/topic',
    kind: 'remote',
    remote: 'foo/bar',
    branch: 'topic',
  })

  const unknown = annotateRemoteRefs([{ refs: [{ name: 'other/topic', kind: 'remote' }] }], ['origin'])
  assert.deepEqual(unknown[0].refs[0], { name: 'other/topic', kind: 'remote' })
})

test('parseDecoration reads full HEAD, branch, remote, and annotated tag refs', () => {
  assert.deepEqual(
    parseDecoration('HEAD -> refs/heads/main, tag: refs/tags/v3, refs/remotes/origin/main'),
    [
      { name: 'main', kind: 'branch', current: true },
      { name: 'v3', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' },
    ],
  )
  assert.deepEqual(parseDecoration('HEAD'), [{ name: 'HEAD', kind: 'head' }])
  // Detached at a branch tip: HEAD is not on the branch, so neither is marked current.
  assert.deepEqual(parseDecoration('HEAD, refs/heads/main'), [
    { name: 'HEAD', kind: 'head' },
    { name: 'main', kind: 'branch' },
  ])
  // A symbolic HEAD that names no branch keeps the plain HEAD ref.
  assert.deepEqual(parseDecoration('HEAD -> refs/stash'), [{ name: 'HEAD', kind: 'head' }])
  assert.deepEqual(parseDecoration('refs/heads/side'), [{ name: 'side', kind: 'branch' }])
  assert.deepEqual(parseDecoration(''), [])
})

test('classifyRefName and parseRefNames keep only the refs the view renders', () => {
  assert.deepEqual(classifyRefName('refs/tags/v1'), { name: 'v1', kind: 'tag' })
  assert.equal(classifyRefName('refs/stash'), undefined)
  assert.deepEqual(
    parseRefNames('refs/heads/main\nrefs/remotes/origin/main\nrefs/tags/v1\nrefs/stash\n'),
    [
      { name: 'main', kind: 'branch' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1', kind: 'tag' },
    ],
  )
})

test('parseLog reads merges, parents, decorations, and millisecond times', () => {
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  const shaC = 'c'.repeat(40)
  const text = [
    [shaA, `${shaB} ${shaC}`, 'Ada', '1700000000', 'merge side', 'HEAD -> refs/heads/main, refs/remotes/origin/main'].join(NUL),
    [shaB, shaC, 'Bob', '1700000100', 'base', 'HEAD'].join(NUL),
    [shaC, '', 'Cid', '1700000200', 'root', ''].join(NUL),
  ].join('\n') + '\n'

  const commits = parseLog(text)
  assert.equal(commits.length, 3)
  assert.deepEqual(commits[0], {
    sha: shaA,
    parents: [shaB, shaC],
    refs: [
      { name: 'main', kind: 'branch', current: true },
      { name: 'origin/main', kind: 'remote' },
    ],
    author: 'Ada',
    authorTime: 1_700_000_000_000,
    subject: 'merge side',
  })
  assert.deepEqual(commits[1].refs, [{ name: 'HEAD', kind: 'head' }])
  assert.deepEqual(commits[1].parents, [shaC])
  assert.deepEqual(commits[2].parents, [])
  assert.deepEqual(commits[2].refs, [])
})

test('parseNameStatusZ reads additions, renames, copies, and deletions', () => {
  const changes = parseNameStatusZ(
    z([
      'A',
      'added.txt',
      'M',
      'modified.txt',
      'R075',
      'old.txt',
      'new.txt',
      'C100',
      'src.txt',
      'copy.txt',
      'D',
      'gone.txt',
      'T',
      'typechange.txt',
    ]),
  )
  assert.deepEqual(changes, [
    { path: 'added.txt', status: 'A' },
    { path: 'modified.txt', status: 'M' },
    { path: 'new.txt', status: 'R', origPath: 'old.txt' },
    { path: 'copy.txt', status: 'C', origPath: 'src.txt' },
    { path: 'gone.txt', status: 'D' },
    { path: 'typechange.txt', status: 'M' },
  ])
})

test('mergeCommitFiles pairs stats with name-status rows', () => {
  const changes = parseNameStatusZ(z(['M', 'a.txt', 'R100', 'old.bin', 'new.bin']))
  const counts = parseNumstat(z(['3\t4\ta.txt', '-\t-\t', 'old.bin', 'new.bin']))
  assert.deepEqual(mergeCommitFiles(changes, counts), [
    { path: 'a.txt', status: 'M', added: 3, deleted: 4, binary: false },
    { path: 'new.bin', status: 'R', origPath: 'old.bin', added: 0, deleted: 0, binary: true },
  ])
})

test('parseCommitMetadata keeps the full message and both identities', () => {
  const parent = 'b'.repeat(40)
  const text = [
    SHA,
    parent,
    'Ada',
    '1700000000',
    'Ada Committer',
    '1700000060',
    'subject line',
    'subject line\n\nbody line\n',
  ].join(NUL)
  assert.deepEqual(parseCommitMetadata(text), {
    sha: SHA,
    parents: [parent],
    author: 'Ada',
    authorTime: 1_700_000_000_000,
    committer: 'Ada Committer',
    committerTime: 1_700_000_060_000,
    subject: 'subject line',
    message: 'subject line\n\nbody line',
  })
  assert.equal(COMMIT_FORMAT.includes('%B'), true)
  assert.equal(parseCommitMetadata('garbage'), undefined)
})

test('validateRelPath refuses escapes and accepts ordinary repository paths', () => {
  assert.equal(validateRelPath('src/app.js'), 'src/app.js')
  assert.equal(validateRelPath('dir with space/file name.txt'), 'dir with space/file name.txt')
  assert.equal(validateRelPath('中文/文件.txt'), '中文/文件.txt')
  for (const rejected of [
    '../outside.txt',
    'a/../../b',
    '/etc/passwd',
    'C:/Windows/system.ini',
    '-pwn.txt',
    'a\\b.txt',
    'a//b',
    'a/./b',
    'a/\u0000b',
    'a/\u001bb',
    '',
    undefined,
    null,
    42,
  ]) {
    assert.equal(validateRelPath(rejected), undefined, `rejected: ${String(rejected)}`)
  }
})

test('validateSha and isFullSha constrain commit ids', () => {
  assert.equal(validateSha('ABC1234'), 'abc1234')
  assert.equal(validateSha('0'.repeat(64)), '0'.repeat(64))
  for (const rejected of ['abc123', 'xyz1234', 'a'.repeat(65), 'dead beef', '', null]) {
    assert.equal(validateSha(rejected), undefined)
  }
  assert.equal(isFullSha(SHA), true)
  assert.equal(isFullSha('a'.repeat(64)), true)
  assert.equal(isFullSha('a'.repeat(39)), false)
})

test('sameRepoPath folds a trailing separator and repositoryName names the leaf', () => {
  assert.equal(sameRepoPath('/work/repo/', '/work/repo'), true)
  assert.equal(sameRepoPath('/work/repo', '/work/other'), false)
  assert.equal(repositoryName('/work/repo/'), 'repo')
  assert.equal(repositoryName('/'), '/')
})


test('parseJjCommit reads parents, refs, times, and descriptions', () => {
  const record = {
    sha: 'a'.repeat(40),
    changeId: 'abcdefghijkl',
    parents: ['b'.repeat(40), '0'.repeat(40)],
    author: 'Ada',
    authorTime: '1700000000',
    committer: 'Grace',
    committerTime: '1700000001',
    subject: 'subject',
    description: 'subject\n\nbody\n',
    workingCopy: true,
    empty: false,
    conflict: true,
    localBookmarks: [JSON.stringify({ name: 'main', conflict: false })],
    remoteBookmarks: [JSON.stringify({ name: 'main', remote: 'origin', tracked: true })],
    tags: [JSON.stringify({ name: 'v1', remote: null })],
  }
  const commit = parseJjCommit(record)
  assert.equal(commit.sha, record.sha)
  assert.equal(commit.changeId, 'abcdefghijkl')
  assert.deepEqual(commit.parents, ['b'.repeat(40)])
  assert.equal(commit.author, 'Ada')
  assert.equal(commit.authorTime, 1_700_000_000_000)
  assert.equal(commit.committer, 'Grace')
  assert.equal(commit.committerTime, 1_700_000_001_000)
  assert.equal(commit.subject, 'subject')
  assert.equal(commit.message, 'subject\n\nbody')
  assert.equal(commit.workingCopy, true)
  assert.equal(commit.conflict, true)
  assert.deepEqual(commit.refs, [
    { name: 'main', kind: 'bookmark' },
    { name: 'main@origin', kind: 'remote' },
    { name: 'v1', kind: 'tag' },
  ])
})

test('parseJjRefs skips malformed records and keeps the three kinds apart', () => {
  const refs = parseJjRefs({
    localBookmarks: [JSON.stringify({ name: 'main' }), 'not json', JSON.stringify({ name: '' })],
    remoteBookmarks: [JSON.stringify({ name: 'main', remote: 'origin' })],
    tags: [JSON.stringify({ name: 'v1' })],
  })
  assert.deepEqual(refs, [
    { name: 'main', kind: 'bookmark' },
    { name: 'main@origin', kind: 'remote' },
    { name: 'v1', kind: 'tag' },
  ])
  assert.deepEqual(parseJjRefs({}), [])
})

test('mergeJjFiles pairs counts and keeps rename sources only for renames and copies', () => {
  const stats = parseJjStats([
    JSON.stringify({ path: 'a.txt', added: 2, removed: 1, status: 'M' }),
    JSON.stringify({ path: 'renamed.txt', added: 0, removed: 0, status: 'R' }),
  ])
  const files = mergeJjFiles([
    parseJjEntry({ path: 'a.txt', source: 'a.txt', status: 'M', fileType: 'file' }),
    parseJjEntry({ path: 'renamed.txt', source: 'old.txt', status: 'R', fileType: 'file' }),
    parseJjEntry({ path: 'conflict.txt', source: 'conflict.txt', status: 'M', fileType: 'conflict', conflict: true }),
  ], stats)
  assert.deepEqual(files[0], { path: 'a.txt', status: 'M', added: 2, deleted: 1, binary: false })
  assert.deepEqual(files[1], {
    path: 'renamed.txt', status: 'R', origPath: 'old.txt', added: 0, deleted: 0, binary: false,
  })
  assert.deepEqual(files[2], {
    path: 'conflict.txt', status: 'U', added: 0, deleted: 0, binary: false, conflict: true,
  })
})

test('jjFilePattern quotes only the fileset string, and binary patches are recognised', () => {
  assert.equal(jjFilePattern('dir/a "b".txt'), 'file:"dir/a \\"b\\".txt"')
  assert.equal(jjFilePattern('plain.txt'), 'file:"plain.txt"')
  assert.equal(isJjBinaryDiff('diff --git a/x b/x\n'), false)
  assert.equal(isJjBinaryDiff('diff --git a/x b/x\n\uFFFD\u0001'), true)
  assert.equal(isJjBinaryDiff('\u0000'), true)
  assert.equal(isJjBinaryDiff('Binary files a/x and b/x differ'), true)
})
