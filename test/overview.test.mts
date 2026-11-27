import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { createHandlers } from '../index.js'
import {
  countStatusEntries, parseGitVersion, parseRefRecords, parseTrack, UNLISTED_REPOSITORY_MAX, unpublishedCounts, versionAtLeast,
} from '../lib/overview.js'
import { parseStashList } from '../lib/stash.js'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

/** Run git during fixture setup. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' }).trim()
}

/** One repository with a fixed identity. */
function initRepo(path: string, bare = false): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', ...(bare ? ['--bare'] : []), '-b', 'main'])
  if (bare) return
  git(path, ['config', 'user.email', 'test@example.com'])
  git(path, ['config', 'user.name', 'Test User'])
  git(path, ['config', 'commit.gpgsign', 'false'])
}

/** Commit one file change. */
function commit(path: string, file: string, text: string, message: string): string {
  writeFileSync(join(path, file), text)
  git(path, ['add', file])
  git(path, ['commit', '-qm', message])
  return git(path, ['rev-parse', 'HEAD'])
}

/**
 * The session directory: a fork with `origin` and `upstream`, a repository
 * without remotes, an unlisted repository below the discovery depth, and a
 * symlink to a repository outside the session.
 */
function buildFixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vcs-overview-')))
  const session = join(scratch, 'session')
  mkdirSync(session)
  const upstreamBare = join(scratch, 'upstream.git')
  const originBare = join(scratch, 'origin.git')
  initRepo(upstreamBare, true)
  initRepo(originBare, true)

  // Upstream history: the trunk moves 3 commits past the fork's own main.
  const seed = join(scratch, 'seed')
  initRepo(seed)
  commit(seed, 'a.txt', 'a\n', 'base')
  git(seed, ['remote', 'add', 'upstream', upstreamBare])
  git(seed, ['remote', 'add', 'origin', originBare])
  git(seed, ['push', '-q', 'upstream', 'main'])
  git(seed, ['push', '-q', 'origin', 'main'])
  for (let index = 0; index < 3; index += 1) commit(seed, 'up.txt', `up ${index}\n`, `upstream ${index}`)
  git(seed, ['push', '-q', 'upstream', 'main'])

  const fork = join(session, 'fork')
  git(scratch, ['clone', '-q', '-o', 'origin', originBare, fork])
  git(fork, ['config', 'user.email', 'test@example.com'])
  git(fork, ['config', 'user.name', 'Test User'])
  git(fork, ['config', 'commit.gpgsign', 'false'])
  git(fork, ['remote', 'add', 'upstream', upstreamBare])
  git(fork, ['fetch', '-q', 'upstream'])
  git(fork, ['remote', 'set-head', 'upstream', 'main'])
  // A PR branch grown from upstream/main: one pushed commit, then two only here.
  git(fork, ['switch', '-q', '-c', 'pr', 'upstream/main'])
  commit(fork, 'pr.txt', 'pr 1\n', 'pr 1')
  git(fork, ['push', '-q', '-u', 'origin', 'pr'])
  commit(fork, 'pr.txt', 'pr 2\n', 'pr 2')
  const prTip = commit(fork, 'pr.txt', 'pr 3\n', 'pr 3')
  git(fork, ['switch', '-q', 'main'])
  // A merged branch: nothing of its own and no checkout.
  git(fork, ['branch', 'merged', 'main'])
  // A linked worktree with an unfinished merge and one changed file.
  const linked = join(session, 'fork-linked')
  git(fork, ['worktree', 'add', '-q', '-b', 'side', linked, 'main'])
  writeFileSync(join(linked, 'dirty.txt'), 'dirty\n')
  writeFileSync(join(git(linked, ['rev-parse', '--absolute-git-dir']), 'MERGE_HEAD'), `${prTip}\n`)
  // A detached checkout carrying one commit no branch or remote has.
  const loose = join(session, 'fork-loose')
  git(fork, ['worktree', 'add', '-q', '--detach', loose, 'main'])
  commit(loose, 'loose.txt', 'loose\n', 'loose')
  // One stash entry on main.
  writeFileSync(join(fork, 'a.txt'), 'stashed\n')
  git(fork, ['stash', 'push', '-q', '-m', 'keep this'])
  git(fork, ['tag', 'v1', 'main'])

  // Without remotes, unique counts the commits off the base.
  const local = join(session, 'local')
  initRepo(local)
  commit(local, 'x.txt', 'x\n', 'x')
  git(local, ['switch', '-q', '-c', 'topic'])
  commit(local, 'x.txt', 'x 1\n', 'x 1')
  commit(local, 'x.txt', 'x 2\n', 'x 2')
  git(local, ['switch', '-q', 'main'])

  // Discovery stops at direct children; this one is only found by the walk.
  const deep = join(session, 'deep', 'nested', 'repo')
  initRepo(deep)
  commit(deep, 'd.txt', 'd\n', 'd')

  // A symlink to a repository outside the session is never walked into.
  const outside = join(scratch, 'outside', 'escape')
  initRepo(outside)
  commit(outside, 'e.txt', 'e\n', 'e')
  symlinkSync(join(scratch, 'outside'), join(session, 'link'))

  return { scratch, session, fork, linked, loose, local, deep, outside, prTip }
}

const fixture = buildFixture()
after(() => { rmSync(fixture.scratch, { recursive: true, force: true }) })

const target = async (path: string) => {
  let canonical = path
  try {
    canonical = await realpath(path)
  } catch {
    // An absent path keeps its spelling.
  }
  return { targetKey: canonical, displayPath: canonical }
}

const fakeFs = {
  resolve: (path: string) => target(path),
  processPath: (resolved: { displayPath: string }) => resolved.displayPath,
  contains: (parent: { targetKey: string }, child: { targetKey: string }) => child.targetKey === parent.targetKey
    || child.targetKey.startsWith(parent.targetKey.endsWith(sep) ? parent.targetKey : `${parent.targetKey}${sep}`),
  stat: async (resolved: { targetKey: string }) => {
    try {
      const info = await stat(resolved.targetKey)
      return { version: 'fixture', type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
    } catch {
      return undefined
    }
  },
  lstat: async (path: string) => {
    try {
      const info = await lstat(path)
      return { version: 'fixture', type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other' }
    } catch {
      return undefined
    }
  },
  readBytes: async (resolved: { targetKey: string }) => new Uint8Array(await readFile(resolved.targetKey)),
  listDir: async (resolved: { targetKey: string }) => Promise.all((await readdir(resolved.targetKey, { withFileTypes: true }))
    .map(async entry => ({
      name: entry.name,
      // Like the Host file service, a symlink resolves to its target, which may lie outside.
      type: entry.isDirectory() || entry.isSymbolicLink() ? 'directory' : 'file',
      target: await target(join(resolved.targetKey, entry.name)),
    }))),
}

/** Find an executable on PATH. */
function onPath(command: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(directory, command), constants.X_OK)
      return join(directory, command)
    } catch {
      // Keep looking.
    }
  }
  throw new Error(`${command} is not installed`)
}

interface SpawnSpec {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  stdio: { stdin?: unknown, stdout: { maxBytes: number }, stderr: { maxBytes: number } }
}

/** A subprocess adapter; `rewrite` may replace one command's argv. */
function fakeSubprocess(rewrite: (argv: string[]) => string[] = argv => argv) {
  const collector = (max: number) => {
    const chunks: Buffer[] = []
    let size = 0
    let lossy = false
    return {
      push(chunk: Buffer) {
        const take = chunk.subarray(0, Math.max(0, max - size))
        chunks.push(take)
        size += take.length
        if (take.length < chunk.length) lossy = true
      },
      readFrom(offset: number) {
        const buffer = Buffer.concat(chunks)
        return { text: buffer.subarray(offset).toString('utf8'), nextOffset: buffer.length, lossy }
      },
    }
  }
  return {
    resolveExecutable: async (command: string) => onPath(command),
    spawn(spec: SpawnSpec) {
      const [command, ...args] = rewrite(spec.argv)
      const child = spawnProcess(command, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      const stdout = collector(spec.stdio.stdout.maxBytes)
      const stderr = collector(spec.stdio.stderr.maxBytes)
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.on('error', () => {})
      child.stdin.end()
      const terminate = () => { child.kill('SIGTERM') }
      spec.signal?.addEventListener('abort', terminate, { once: true })
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
      })
      return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, collected: { stdout, stderr },
        done, terminate, waitForExit: () => done.then(() => true, () => false),
      }
    },
  }
}

const sessions = new Map<string, { header: { cwd?: string } }>([
  ['s-overview', { header: { cwd: fixture.session } }],
  ['s-nocwd', { header: {} }],
])

function host(overrides: Record<string, unknown> = {}) {
  return {
    sessions: { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] },
    fs: fakeFs,
    subprocess: fakeSubprocess(),
    ...overrides,
  }
}

const handlers = createHandlers(host() as never)

type Line = Record<string, any>

/** Call the overview route; decode NDJSON lines or a JSON error. */
async function overview(params: Record<string, string | string[]>, route = handlers.overview) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item)
  }
  const response = await route(new Request(`http://127.0.0.1/api/vcs.overview?${query}`))
  const text = await response.text()
  const streamed = response.headers.get('content-type')?.startsWith('application/x-ndjson') === true
  return {
    status: response.status,
    streamed,
    lines: streamed ? text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Line) : [],
    body: streamed ? null : JSON.parse(text),
  }
}

const repositoryLines = (lines: Line[]) => lines.filter(line => line.type === 'repository').map(line => line.repository)
const pointer = (repository: Line, kind: string, name: string) => repository.pointers.find((entry: Line) => entry.kind === kind && entry.name === name)

test('overview streams every discovered repository with bases, distances, uniques, and occupancy', async () => {
  const { status, streamed, lines } = await overview({ sessionId: 's-overview' })
  assert.equal(status, 200)
  assert.equal(streamed, true)
  assert.equal(lines[0].type, 'scope')
  assert.equal(lines.at(-1)?.type, 'done')
  const repositories = repositoryLines(lines)
  const fork = repositories.find(entry => entry.path === fixture.fork)
  assert.ok(fork, 'the fork is listed')
  assert.equal(fork.registered, true)
  assert.deepEqual(fork.remotes, ['origin', 'upstream'])
  assert.equal(typeof fork.fetchedAt, 'number')
  assert.deepEqual(fork.baselines.map((entry: Line) => entry.name), ['origin/main', 'upstream/main', 'main'])
  assert.deepEqual(fork.baselines[1], { name: 'upstream/main', ahead: 3, behind: 0 })

  // The PR branch counts against upstream/main, not against the fork's main.
  const pr = pointer(fork, 'branch', 'pr')
  assert.equal(pr.base, 'upstream/main')
  assert.equal(pr.ahead, 3)
  assert.equal(pr.behind, 0)
  assert.equal(pr.unique, 2)
  assert.equal(pr.upstream, 'origin/pr')
  assert.deepEqual(pr.track, { ahead: 2, behind: 0 })
  assert.equal(pr.checkout, null)

  const merged = pointer(fork, 'branch', 'merged')
  assert.equal(merged.unique, 0)
  assert.equal(merged.ahead, 0)

  // The linked checkout holds `side`, with one change and an unfinished merge.
  const side = pointer(fork, 'branch', 'side')
  assert.equal(side.checkout, fixture.linked)
  const linked = fork.checkouts.find((tree: Line) => tree.path === fixture.linked)
  assert.equal(linked.dirty, 1)
  assert.equal(linked.operation, 'merge')
  assert.equal(fork.checkouts.find((tree: Line) => tree.primary).path, fixture.fork)

  const loose = pointer(fork, 'detached', fixture.loose)
  assert.equal(loose.unique, 1)
  assert.equal(loose.ahead, 1)
  assert.equal(loose.subject, 'loose')

  const stash = pointer(fork, 'stash', 'stash@{0}')
  assert.equal(stash.subject, 'keep this')
  assert.equal(stash.onto, git(fixture.fork, ['rev-parse', 'main']))
  assert.equal(stash.unique, 1)

  const remote = pointer(fork, 'remote', 'upstream/main')
  assert.equal(remote.remote, 'upstream')
  assert.equal(remote.branch, 'main')
  assert.equal(remote.isBase, true)
  assert.equal(fork.tags, 1)

  // Without remotes the unique count is the distance from the base.
  const local = repositories.find(entry => entry.path === fixture.local)
  assert.deepEqual(local.remotes, [])
  assert.equal(local.fetchedAt, null)
  const topic = pointer(local, 'branch', 'topic')
  assert.equal(topic.base, 'main')
  assert.equal(topic.unique, 2)
  assert.equal(pointer(local, 'branch', 'main').isBase, true)
})

test('overview does not walk nested directories or stream unlisted roots', async () => {
  const listings: string[] = []
  const traced = createHandlers(host({ fs: { ...fakeFs, listDir: (resolved: { targetKey: string }) => {
    listings.push(resolved.targetKey)
    return fakeFs.listDir(resolved)
  } } }) as never)
  const { lines } = await overview({ sessionId: 's-overview' }, traced.overview)
  const repositories = repositoryLines(lines)
  assert.deepEqual(repositories.map(entry => entry.path).sort(), [fixture.fork, fixture.local].sort())
  assert.ok(repositories.every(entry => entry.registered === true))
  assert.deepEqual(lines.at(-1), { type: 'done' })
  assert.ok(listings.includes(fixture.session))
  assert.ok(!listings.some(path => path === join(fixture.session, 'deep') || path.startsWith(`${join(fixture.session, 'deep')}${sep}`)))
})

function scanRequest(sessionId: string, signal?: AbortSignal): Request {
  return new Request(`http://127.0.0.1/api/vcs.repository-scan?${new URLSearchParams({ sessionId })}`, { signal })
}

test('manual scan returns rule-ready Git roots without summaries, linked duplicates or symlink escapes', async t => {
  const alias = join(fixture.scratch, 'session-alias')
  symlinkSync(fixture.session, alias)
  sessions.set('s-alias', { header: { cwd: alias } })
  t.after(() => { sessions.delete('s-alias') })
  const nestedLinked = join(fixture.session, 'deep', 'linked')
  git(fixture.fork, ['worktree', 'add', '-q', '--detach', nestedLinked, 'main'])
  t.after(() => { git(fixture.fork, ['worktree', 'remove', nestedLinked]) })
  const seen: string[][] = []
  const traced = createHandlers(host({ subprocess: fakeSubprocess(argv => { seen.push(argv); return argv }) }) as never)
  const response = await traced.repositoryScan(scanRequest('s-alias'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { roots: [{ path: 'deep/nested/repo', vcs: 'git' }], truncated: false })
  assert.ok(seen.some(argv => argv.includes('worktree') && argv.includes('list')))
  assert.ok(!seen.some(argv => ['status', 'for-each-ref', 'rev-list', 'stash'].some(cmd => argv.includes(cmd))))
})

test('manual scan caps the number of returned repository roots', async t => {
  const cwd = join(fixture.scratch, 'cap')
  sessions.set('s-cap', { header: { cwd } })
  t.after(() => { sessions.delete('s-cap') })
  for (let index = 0; index <= UNLISTED_REPOSITORY_MAX; index += 1) initRepo(join(cwd, 'nested', `repo-${index}`))
  const response = await handlers.repositoryScan(scanRequest('s-cap'))
  assert.equal(response.status, 200)
  const { roots, truncated } = await response.json()
  assert.equal(roots.length, UNLISTED_REPOSITORY_MAX)
  assert.equal(truncated, true)
})

test('manual scan stops when the request aborts during the directory walk', async () => {
  const cancellation = new AbortController()
  const reason = new DOMException('Scan cancelled', 'AbortError')
  const listings: string[] = []
  const traced = createHandlers(host({ fs: { ...fakeFs, listDir: async (resolved: { targetKey: string }, signal: AbortSignal) => {
    listings.push(resolved.targetKey)
    if (resolved.targetKey === join(fixture.session, 'deep')) cancellation.abort(reason)
    signal.throwIfAborted()
    return fakeFs.listDir(resolved)
  } } }) as never)
  await assert.rejects(traced.repositoryScan(scanRequest('s-overview', cancellation.signal)), error => error === reason)
  assert.equal(listings.at(-1), join(fixture.session, 'deep'))
})

test('overview reads one discovered repository and rejects other targets', async () => {
  const one = await overview({ sessionId: 's-overview', repo: fixture.local })
  assert.equal(one.status, 200)
  assert.deepEqual(repositoryLines(one.lines).map(entry => entry.path), [fixture.local])

  const rejections: Array<[Record<string, string | string[]>, number, string]> = [
    [{}, 400, 'bad-request'],
    [{ sessionId: 'missing' }, 409, 'no-session'],
    [{ sessionId: 's-nocwd' }, 409, 'no-cwd'],
    [{ sessionId: 's-overview', repo: [fixture.local, fixture.fork] }, 400, 'bad-request'],
    // Found by the walk, but discovery does not list it.
    [{ sessionId: 's-overview', repo: fixture.deep }, 400, 'not-a-repo'],
    // Escapes through `..` and through the symlink.
    [{ sessionId: 's-overview', repo: join(fixture.session, '..', 'outside', 'escape') }, 400, 'not-a-repo'],
    [{ sessionId: 's-overview', repo: join(fixture.session, 'link', 'escape') }, 400, 'not-a-repo'],
    [{ sessionId: 's-overview', repo: 'fork' }, 400, 'not-a-repo'],
  ]
  for (const [params, status, code] of rejections) {
    const answer = await overview(params)
    assert.equal(answer.status, status, JSON.stringify(params))
    assert.equal(answer.streamed, false)
    assert.equal(answer.body.error.code, code, JSON.stringify(params))
  }
})

test('overview without git answers vcs-missing for one repository and per line for all', async () => {
  const missing = createHandlers(host({
    subprocess: { resolveExecutable: async () => { throw new Error('git is not installed') } },
  }) as never)
  const one = await overview({ sessionId: 's-overview', repo: fixture.local }, missing.overview)
  assert.equal(one.status, 503)
  assert.equal(one.body.error.code, 'vcs-missing')

  const all = await overview({ sessionId: 's-overview' }, missing.overview)
  assert.equal(all.status, 200)
  const errors = all.lines.filter(line => line.type === 'error')
  assert.ok(errors.length >= 2)
  assert.ok(errors.every(line => line.error.code === 'vcs-missing'))
  assert.equal(repositoryLines(all.lines).length, 0)
  assert.equal(all.lines.at(-1)?.type, 'done')
})

test('overview falls back to rev-list on Git without ahead-behind and is-base', async () => {
  const modern = repositoryLines((await overview({ sessionId: 's-overview' })).lines)
  for (const version of ['2.46.2', '2.40.1']) {
    const seen: string[][] = []
    const old = createHandlers(host({
      subprocess: fakeSubprocess(argv => {
        seen.push(argv)
        return argv.at(-1) === 'version' ? ['/bin/echo', `git version ${version}`] : argv
      }),
    }) as never)
    const fallback = repositoryLines((await overview({ sessionId: 's-overview' }, old.overview)).lines)
    const formats = seen.flat().filter(arg => arg.startsWith('--format='))
    assert.equal(formats.some(arg => arg.includes('%(is-base:')), false, `${version} avoids is-base`)
    assert.equal(formats.some(arg => arg.includes('%(ahead-behind:')), version === '2.46.2', `${version} ahead-behind use`)
    for (const repository of modern) {
      const other = fallback.find(entry => entry.path === repository.path)
      assert.ok(other, repository.path)
      for (const entry of repository.pointers) {
        const match = pointer(other, entry.kind, entry.name)
        assert.deepEqual([match.base, match.ahead, match.behind, match.unique], [entry.base, entry.ahead, entry.behind, entry.unique],
          `${version} ${entry.kind} ${entry.name}`)
      }
    }
  }
})

test('overview parsers read git output and reject malformed records', () => {
  assert.deepEqual(parseGitVersion('git version 2.54.0 (Apple Git-157)\n'), [2, 54, 0])
  assert.deepEqual(parseGitVersion('git version 2.41.windows.1'), [2, 41, 0])
  assert.equal(parseGitVersion('jj 0.47.0'), null)
  assert.equal(versionAtLeast([2, 47, 0], [2, 47, 0]), true)
  assert.equal(versionAtLeast([2, 46, 9], [2, 47, 0]), false)
  assert.equal(versionAtLeast(null, [2, 41, 0]), false)

  assert.deepEqual(parseTrack('ahead 2, behind 1'), { ahead: 2, behind: 1 })
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0 })
  assert.deepEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true })

  const sha = 'a'.repeat(40)
  assert.deepEqual(parseRefRecords(['refs/heads/x', sha, '', '', '', '', '123', 'subject', 'with nul'].join('\x00') + '\nbroken\n' + ['refs/heads/y', 'nothex', '', '', '', '', '', 's'].join('\x00')), [
    { refname: 'refs/heads/x', oid: sha, symref: '', upstream: '', upstreamShort: '', track: '', time: 123, subject: 'subject\x00with nul' },
  ])
  const [base, index, untracked] = ['b', 'c', 'd'].map(digit => digit.repeat(40))
  assert.deepEqual(parseStashList([
    ['stash@{0}', sha, `${base} ${index}`, '100', 'On main: x: y'],
    ['stash@{1}', sha, `${base} ${index} ${untracked}`, '99', 'WIP on (no branch): 7d2b0bb HEAD'],
    ['stash@{2}', sha, base, '98', 'not a stash commit'],
    ['not a selector', sha, `${base} ${index}`, '97', 'not a stash reflog'],
  ].map(row => row.join('\0')).join('\n')), [
    { selector: 'stash@{0}', sha, base, index, untracked: null, time: 100, branch: 'main', message: 'x: y' },
    { selector: 'stash@{1}', sha, base, index, untracked, time: 99, branch: null, message: '7d2b0bb HEAD' },
  ])

  // A rename record carries its original path as a separate field.
  assert.equal(countStatusEntries('# branch.oid x\x001 .M N... 100644 100644 100644 a b f.txt\x002 R. N... 100644 100644 100644 a b R100 new.txt\x00old.txt\x00? u.txt\x00u UU N... 1 2 3 4 a b c m.txt\x00'), 4)
  assert.equal(countStatusEntries(''), 0)

  const [a, b, c, d] = ['1', '2', '3', '4'].map(digit => digit.repeat(40))
  // a → b → c, with d published; b reaches b and c only.
  const graph = `${a} ${b}\n${b} ${c} ${d}\n${c}\n`
  assert.deepEqual([...unpublishedCounts(graph, [a, b, d])], [[a, 3], [b, 2], [d, 0]])
})
