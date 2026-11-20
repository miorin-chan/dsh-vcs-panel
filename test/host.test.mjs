import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, join, basename, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, createHandlers, createTurnTracker, normalizeConfig } from '../index.js'
import { parseGitWorktrees } from '../lib/worktrees.js'

// Keep the fixtures independent of the user's global git configuration.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

const GIT_ENV = { ...process.env }

/** Whether this host can build and read a Jujutsu fixture. */
const HAS_JJ = (() => {
  try {
    execFileSync('jj', ['--version'], { encoding: 'utf8', env: { ...process.env, JJ_CONFIG: '/dev/null' } })
    return true
  } catch {
    return false
  }
})()

// Keep Jujutsu fixtures and the Host's jj commands independent of the user's
// config, and create a fixed identity so signed-commit settings do not apply.
process.env.JJ_CONFIG = '/dev/null'
process.env.JJ_USER = 'Test User'
process.env.JJ_EMAIL = 'test@example.com'

const JJ_ENV = { ...process.env }

/**
 * Run jj during fixture setup and for read-only assertions.
 * @param {string} cwd - working directory.
 * @param {string[]} args - jj arguments.
 * @returns {string} trimmed stdout.
 */
function jj(cwd, args) {
  return execFileSync('jj', args, { cwd, env: JJ_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Run git during fixture setup and for read-only assertions.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

/**
 * Run git and keep raw bytes (needed for `-z` output).
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @returns {string} raw stdout.
 */
function gitRaw(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

/**
 * Create one throwaway repository with a fixed identity.
 * @param {string} path - directory to create.
 * @returns {void}
 */
function initRepo(path) {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'test@example.com'])
  git(path, ['config', 'user.name', 'Test User'])
  git(path, ['config', 'commit.gpgsign', 'false'])
}

/**
 * Build the shared fixture: one repository with two commits and a rich working
 * tree, one nested repository, one repository under node_modules, one unborn
 * repository, and one plain directory.
 * @returns {object} the fixture paths and commit ids.
 */
function buildFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'vcs-panel-'))
  const main = join(scratch, 'main')
  initRepo(main)

  writeFileSync(join(main, '.gitignore'), 'nested/\nnode_modules/\n*.ignored\n')
  writeFileSync(join(main, 'tracked.txt'), 'one\ntwo\n')
  writeFileSync(join(main, 'to-rename.txt'), 'r\n')
  writeFileSync(join(main, 'to-delete.txt'), 'd\n')
  writeFileSync(join(main, 'image.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(main, 'untouched.txt'), 'u\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-qm', 'initial commit'])
  const rootSha = git(main, ['rev-parse', 'HEAD'])

  writeFileSync(join(main, 'tracked.txt'), 'one\ntwo\nthree\n')
  git(main, ['mv', 'to-rename.txt', 'renamed.txt'])
  git(main, ['rm', '-q', 'to-delete.txt'])
  writeFileSync(join(main, 'added.txt'), 'added\n')
  writeFileSync(join(main, 'both.txt'), 'both\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-qm', 'second commit'])
  const headSha = git(main, ['rev-parse', 'HEAD'])

  const nested = join(main, 'nested')
  initRepo(nested)
  writeFileSync(join(nested, 'nested.txt'), 'nested\n')
  git(nested, ['add', '-A'])
  git(nested, ['commit', '-qm', 'nested commit'])

  const inner = join(main, 'node_modules', 'inner')
  initRepo(inner)
  writeFileSync(join(inner, 'inner.txt'), 'inner\n')
  git(inner, ['add', '-A'])
  git(inner, ['commit', '-qm', 'inner commit'])

  const secret = join(scratch, 'secret')
  mkdirSync(secret)
  writeFileSync(join(secret, 'secret.txt'), 'top secret\n')
  symlinkSync('../secret', join(main, 'leak'))

  writeFileSync(join(main, 'tracked.txt'), 'one\nTWO\nthree\n')
  writeFileSync(join(main, 'both.txt'), 'both\nstaged\n')
  git(main, ['add', 'both.txt'])
  writeFileSync(join(main, 'both.txt'), 'both\nstaged\nworktree\n')
  writeFileSync(join(main, 'staged.txt'), 'staged\n')
  git(main, ['add', 'staged.txt'])
  git(main, ['mv', 'untouched.txt', 'moved.txt'])
  writeFileSync(join(main, 'image.bin'), Buffer.from([9, 9, 0, 9]))

  const untracked = join(main, 'scratch')
  mkdirSync(join(untracked, 'deep'), { recursive: true })
  writeFileSync(join(untracked, 'notes.md'), '# notes\n')
  writeFileSync(join(untracked, 'deep', 'file.txt'), 'deep\n')
  writeFileSync(join(untracked, 'skip.ignored'), 'skip\n')
  writeFileSync(join(untracked, 'blob.bin'), Buffer.from([1, 2, 0]))
  writeFileSync(
    join(untracked, 'large.txt'),
    Array.from({ length: 5001 }, (_, index) => `line ${index}`).join('\n') + '\n',
  )
  writeFileSync(join(untracked, 'huge.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))

  const unborn = join(scratch, 'unborn')
  initRepo(unborn)
  writeFileSync(join(unborn, 'first.txt'), 'first\n')

  const plain = join(scratch, 'plain')
  mkdirSync(plain)

  // A separate repository whose HEAD is a real merge, so commit detail can be
  // checked against the first parent rather than an empty file list.
  const merge = join(scratch, 'merge')
  initRepo(merge)
  writeFileSync(join(merge, 'base.txt'), 'base\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'base'])
  git(merge, ['checkout', '-qb', 'side'])
  writeFileSync(join(merge, 'side.txt'), 'side\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'side'])
  git(merge, ['checkout', '-q', 'main'])
  writeFileSync(join(merge, 'main.txt'), 'main\n')
  git(merge, ['add', '-A'])
  git(merge, ['commit', '-qm', 'main'])
  git(merge, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])
  const mergeSha = git(merge, ['rev-parse', 'HEAD'])
  const mergeFirstParent = git(merge, ['rev-parse', 'HEAD^1'])
  const mergeSecondParent = git(merge, ['rev-parse', 'HEAD^2'])

  // A colocated Jujutsu repository: @ is a working-copy commit with changes,
  // its parent is an ordinary commit with `main`, and @ carries `feature`.
  let jjRepo = null
  let jjParentSha = null
  let jjHeadSha = null
  if (HAS_JJ) {
    jjRepo = join(scratch, 'jj')
    mkdirSync(jjRepo)
    jj(jjRepo, ['git', 'init'])
    writeFileSync(join(jjRepo, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(jjRepo, 'to-rename.txt'), 'r\n')
    writeFileSync(join(jjRepo, 'to-delete.txt'), 'd\n')
    writeFileSync(join(jjRepo, 'image.bin'), Buffer.from([0, 1, 2]))
    jj(jjRepo, ['describe', '-m', 'initial commit'])
    jj(jjRepo, ['bookmark', 'create', 'main', '-r', '@'])
    jjParentSha = jj(jjRepo, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])

    jj(jjRepo, ['new', '-m', 'second commit'])
    writeFileSync(join(jjRepo, 'tracked.txt'), 'one\ntwo\nthree\n')
    renameSync(join(jjRepo, 'to-rename.txt'), join(jjRepo, 'renamed.txt'))
    rmSync(join(jjRepo, 'to-delete.txt'))
    writeFileSync(join(jjRepo, 'added.txt'), 'added\n')
    writeFileSync(join(jjRepo, 'image.bin'), Buffer.from([9, 9, 0, 9]))
    jj(jjRepo, ['bookmark', 'create', 'feature', '-r', '@'])
    jj(jjRepo, ['status'])
    jjHeadSha = jj(jjRepo, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  }

  return {
    scratch,
    main,
    nested,
    unborn,
    plain,
    merge,
    jj: jjRepo,
    rootSha,
    headSha,
    mergeSha,
    mergeFirstParent,
    mergeSecondParent,
    jjParentSha,
    jjHeadSha,
  }
}

const fixture = buildFixture()
const mainPath = realpathSync(fixture.main)
const nestedPath = realpathSync(fixture.nested)
const unbornPath = realpathSync(fixture.unborn)
const plainPath = realpathSync(fixture.plain)
const mergePath = realpathSync(fixture.merge)
const jjPath = fixture.jj === null ? null : realpathSync(fixture.jj)
const HAS_JJ_WORKSPACE_ROOTS = HAS_JJ && (() => {
  try {
    return jj(jjPath, ['--ignore-working-copy', 'workspace', 'list', '-T', 'if(current_workspace, root)']) === jjPath
  } catch {
    return false
  }
})()

after(() => {
  rmSync(fixture.scratch, { recursive: true, force: true })
})

/** Canonicalize a path the way the local filesystem backend does. */
async function canonicalize(path) {
  const absolute = resolvePath(path)
  let current = absolute
  const tail = []
  for (;;) {
    try {
      const base = await realpath(current)
      return tail.length === 0 ? base : join(base, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * A filesystem adapter matching the `ctx.fs` contract the handlers use:
 * resolve/processPath/contains/stat/lstat/readBytes/listDir.
 * @returns {object} the adapter.
 */
function createFakeFs() {
  const target = async path => {
    const canonical = await canonicalize(path)
    return { targetKey: canonical, displayPath: canonical }
  }

  return {
    resolve: path => target(path),
    processPath: resolved => resolved.displayPath,
    contains: (parent, child) =>
      child.targetKey === parent.targetKey
      || child.targetKey.startsWith(parent.targetKey.endsWith(sep) ? parent.targetKey : `${parent.targetKey}${sep}`),
    stat: async resolved => {
      try {
        const info = await stat(resolved.targetKey)
        return {
          version: 'fixture',
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    lstat: async (path, _options, _signal) => {
      try {
        const info = await lstat(path)
        return {
          version: 'fixture',
          type: info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : info.isSymbolicLink()
                ? 'symlink'
                : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    readBytes: async (resolved, _signal, maxBytes) => {
      const bytes = await readFile(resolved.targetKey)
      if (bytes.byteLength > maxBytes) {
        const error = new Error('File too large')
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      return new Uint8Array(bytes)
    },
    listDir: async resolved => {
      const dirents = await readdir(resolved.targetKey, { withFileTypes: true })
      const entries = []
      for (const dirent of dirents) {
        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? 'directory' : 'file',
          target: await target(join(resolved.targetKey, dirent.name)),
        })
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return entries
    },
  }
}

/** Find an executable on PATH, as the subprocess provider does. */
function resolveOnPath(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next directory.
    }
  }
  throw new Error(`${command} is not on PATH`)
}

/** A collector that keeps at most `maxBytes` and reports whether it cut. */
function createCollector(maxBytes) {
  const chunks = []
  let size = 0
  let lossy = false
  return {
    push(chunk) {
      if (size >= maxBytes) {
        lossy = true
        return
      }
      const room = maxBytes - size
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
      chunks.push(take)
      size += take.length
      if (take.length < chunk.length) lossy = true
    },
    readFrom(offset) {
      const buffer = Buffer.concat(chunks)
      const start = Math.min(Math.max(offset, 0), buffer.length)
      return { text: buffer.subarray(start).toString('utf8'), nextOffset: buffer.length, lossy }
    },
  }
}

/**
 * A subprocess adapter matching the `ctx.subprocess` contract: fixed argv,
 * collected streams, a deadline signal, and a terminating grace period.
 * @returns {object} the adapter.
 */
function createFakeSubprocess() {
  return {
    resolveExecutable: async command => resolveOnPath(command),
    spawn(spec) {
      const [command, ...args] = spec.argv
      const child = spawnProcess(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout = createCollector(spec.stdio.stdout.maxBytes)
      const stderr = createCollector(spec.stdio.stderr.maxBytes)
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.on('error', () => {})
      if (typeof spec.stdio.stdin === 'object' && spec.stdio.stdin !== null) {
        child.stdin.end(spec.stdio.stdin.data)
      } else {
        child.stdin.end()
      }

      let grace
      const terminate = () => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
        grace = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }, spec.graceMs)
        grace.unref?.()
      }
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate()
        else spec.signal.addEventListener('abort', terminate, { once: true })
      }

      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => {
          if (grace !== undefined) clearTimeout(grace)
          resolve({ exitCode, signal })
        })
      })

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout, stderr },
        done,
        terminate,
        waitForExit: () => done.then(() => true, () => false),
      }
    },
  }
}

const fakeFs = createFakeFs()
const fakeSubprocess = createFakeSubprocess()

const sessions = new Map([
  ['s-main', { header: { cwd: fixture.main } }],
  ['s-unborn', { header: { cwd: fixture.unborn } }],
  ['s-plain', { header: { cwd: fixture.plain } }],
  ['s-merge', { header: { cwd: fixture.merge } }],
  ['s-nocwd', { header: {} }],
])
if (fixture.jj !== null) sessions.set('s-jj', { header: { cwd: fixture.jj } })

/** A host context the handlers accept. */
function createHost(overrides = {}) {
  return {
    sessions: { get: id => sessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    ...overrides,
  }
}

const handlers = createHandlers(createHost())

/** Build one route URL with encoded query parameters. */
function route(path, params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item)
    else query.set(key, value)
  }
  return `${path}?${query}`
}

/** Call one handler and decode its JSON answer. */
async function call(handler, url) {
  const response = await handler(new Request(`http://127.0.0.1${url}`))
  return { status: response.status, body: await response.json(), headers: response.headers }
}

test('repositories lists the enclosing repository and one-level children only', async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-main' }),
  )
  assert.equal(status, 200)
  assert.equal(body.cwd, mainPath)
  assert.equal(body.truncated, false)
  assert.deepEqual(
    body.repositories.map(repo => [basename(repo.path), repo.enclosing]),
    [['main', true], ['nested', false]],
  )
  assert.equal(body.repositories[0].path, mainPath)
  assert.equal(body.repositories[1].path, nestedPath)
  assert.equal(body.repositories[0].vcs, 'git')
  assert.equal(body.repositories[0].capabilities.workingCopy, 'row')
  assert.equal(body.repositories[0].capabilities.branchOps, true)
  assert.equal(body.repositories[0].capabilities.tagOps, true)
  assert.equal(body.repositories[0].capabilities.commitOps, true)
  assert.deepEqual(body.repositories[0].capabilities.ranges.map(range => range.value), ['all', 'HEAD'])
  assert.equal(body.repositories[0].capabilities.defaultRange, 'all')
})

test('repositories is empty rather than an error when the cwd is not in a repository', async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-plain' }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.repositories, [])
  assert.equal(body.cwd, plainPath)
  assert.equal(body.truncated, false)
})

test('repositories distinguishes unknown sessions from sessions without a cwd', async () => {
  const missing = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-missing' }),
  )
  assert.equal(missing.status, 409)
  assert.equal(missing.body.error.code, 'no-session')

  const noCwd = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-nocwd' }),
  )
  assert.equal(noCwd.status, 409)
  assert.equal(noCwd.body.error.code, 'no-cwd')

  const noSessionId = await call(handlers.repositories, '/api/vcs.repositories')
  assert.equal(noSessionId.status, 400)
  assert.equal(noSessionId.body.error.code, 'bad-request')
})

function linkedWorktreeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vcs-worktrees-')))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'source')
  const linked = join(root, 'branch checkout')
  initRepo(source)
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  git(source, ['add', '-A'])
  git(source, ['commit', '-qm', 'base'])
  git(source, ['worktree', 'add', '-qb', 'topic/preview', linked])
  const worktreeSessions = new Map([
    ['source', { header: { cwd: source } }],
    ['linked', { header: { cwd: linked } }],
  ])
  const host = createHost({ sessions: { get: id => worktreeSessions.get(id) } })
  return { root, source, linked, repo: { sessionId: 'source', repo: source }, handlers: createHandlers(host) }
}

test('Git worktree porcelain keeps spaces and newlines, with detached, locked, and skipped records', () => {
  const branchPath = join(tmpdir(), 'repo with spaces')
  const detachedPath = join(tmpdir(), 'repo\nwith newline')
  const head = 'b'.repeat(40)
  const records = [
    [`worktree ${branchPath}`, `HEAD ${head}`, 'branch refs/heads/topic/slash', 'locked reason with prunable in it'],
    [`worktree ${detachedPath}`, `HEAD ${head}`, 'detached'],
    [`worktree ${join(tmpdir(), 'unborn')}`, `HEAD ${'0'.repeat(40)}`, 'branch refs/heads/unborn'],
    [`worktree ${join(tmpdir(), 'gone')}`, 'prunable gitdir file points to non-existent location'],
    [`worktree ${join(tmpdir(), 'bare')}`, 'bare'],
    ['worktree relative', 'branch refs/heads/main'],
  ]
  const stdout = `${records.map(record => record.join('\0')).join('\0\0')}\0\0`
  assert.deepEqual([...parseGitWorktrees(stdout)], [
    { path: branchPath, branch: 'topic/slash', head },
    { path: detachedPath, branch: null, head },
    { path: join(tmpdir(), 'unborn'), branch: 'unborn', head: null },
  ])
})

test('registered Git worktrees outside the session show their own read-only status and diffs', async t => {
  const { root, source, linked, repo, handlers } = linkedWorktreeFixture(t)
  const detached = join(root, 'detached')
  git(source, ['worktree', 'add', '-q', '--detach', detached])
  git(source, ['worktree', 'lock', detached])
  const directlyDiscovered = join(source, 'direct')
  git(source, ['worktree', 'add', '-qb', 'direct', directlyDiscovered])

  writeFileSync(join(linked, 'linked.txt'), 'linked commit\n')
  git(linked, ['add', 'linked.txt'])
  git(linked, ['commit', '-qm', 'linked head'])
  const linkedHead = git(linked, ['rev-parse', 'HEAD'])
  writeFileSync(join(linked, 'tracked.txt'), 'base\npreview index\n')
  git(linked, ['add', 'tracked.txt'])
  writeFileSync(join(linked, 'tracked.txt'), 'base\npreview index\npreview worktree\n')
  mkdirSync(join(linked, 'drafts'))
  writeFileSync(join(linked, 'drafts', 'note.txt'), 'preview note\n')
  writeFileSync(join(source, 'tracked.txt'), 'base\nsource only\n')

  const snapshot = cwd => [
    gitRaw(cwd, ['status', '--porcelain=v2', '-z', '--branch']),
    git(cwd, ['ls-files', '-s']),
    git(cwd, ['rev-parse', 'HEAD']),
  ]
  const before = [snapshot(source), snapshot(linked)]
  const listing = await call(handlers.repositories, route('/api/vcs.repositories', { sessionId: 'source' }))
  assert.equal(listing.status, 200)
  assert.equal(listing.body.cwd, source)
  assert.deepEqual(listing.body.repositories.map(entry => entry.path), [source], 'one option for checkouts sharing a common directory')
  assert.equal(listing.body.worktreesTruncated, false)
  const offered = listing.body.repositories[0].worktrees
  assert.deepEqual(new Set(offered.map(tree => tree.path)), new Set([source, directlyDiscovered, linked, detached]))
  assert.equal(offered[0].path, source, 'the session checkout is first')
  assert.deepEqual(offered.find(entry => entry.path === linked), { path: linked, name: 'branch checkout', branch: 'topic/preview', head: linkedHead })
  assert.equal(offered.find(entry => entry.path === detached)?.branch, null)

  const reverse = await call(handlers.repositories, route('/api/vcs.repositories', { sessionId: 'linked' }))
  const reverseWorktrees = reverse.body.repositories[0].worktrees
  assert.equal(reverseWorktrees[0].path, linked, 'a session may start on a linked checkout')
  assert.equal(reverseWorktrees.find(entry => entry.path === source)?.branch, 'main')
  const base = await call(handlers.status, route('/api/vcs.status', repo))
  assert.equal(base.body.branch.name, 'main')
  assert.deepEqual(base.body.groups.staged, [])
  const clean = await call(handlers.status, route('/api/vcs.status', { ...repo, worktree: detached }))
  assert.equal(clean.status, 200)
  assert.equal(clean.body.branch.detached, true)
  assert.equal(clean.body.defaultNode, 'worktree', 'a clean preview still opens its working changes')

  const target = { ...repo, worktree: linked }
  const status = await call(handlers.status, route('/api/vcs.status', target))
  assert.equal(status.status, 200)
  assert.deepEqual(status.body.repo, { path: linked, name: 'branch checkout' })
  assert.equal(status.body.branch.name, 'topic/preview')
  for (const capability of ['sync', 'branchSwitch', 'branchOps', 'tagOps', 'commitOps']) {
    assert.equal(status.body.capabilities[capability], false, capability)
    assert.equal(listing.body.repositories[0].capabilities[capability], true, capability)
  }
  assert.equal(status.body.capabilities.untracked, true)
  assert.deepEqual(Object.fromEntries(Object.entries(status.body.groups).map(([group, files]) => [group, files.map(file => file.path)])), {
    staged: ['tracked.txt'], unstaged: ['tracked.txt'], untracked: ['drafts/'],
  })
  const drafts = await call(handlers.untracked, route('/api/vcs.untracked', { ...target, path: 'drafts/' }))
  assert.deepEqual(drafts.body.entries, [{ name: 'note.txt', path: 'drafts/note.txt', type: 'file' }])
  for (const [scope, path, line] of [
    ['staged', 'tracked.txt', '+preview index'],
    ['unstaged', 'tracked.txt', '+preview worktree'],
    ['untracked', 'drafts/note.txt', '+preview note'],
  ]) {
    const diff = await call(handlers.diff, route('/api/vcs.diff', { ...target, scope, path }))
    assert.equal(diff.status, 200)
    assert.equal(diff.body.path, path)
    assert.deepEqual(diff.body.hunks.flatMap(hunk => hunk.lines.filter(line => line.startsWith('+'))), [line])
  }
  const { body: log } = await call(handlers.log, route('/api/vcs.log', target))
  assert.equal(log.commits[0].sha, linkedHead, 'HEAD is the sibling tree’s HEAD')
  const { body: commit } = await call(handlers.commit, route('/api/vcs.commit', { ...target, sha: linkedHead }))
  assert.equal(commit.commit.subject, 'linked head')
  assert.deepEqual([snapshot(source), snapshot(linked)], before)
})

test('worktree selection refuses stale and foreign roots, escapes, and every write route', async t => {
  const { root, source, linked, repo, handlers } = linkedWorktreeFixture(t)
  const unrelated = join(root, 'unrelated')
  const missing = join(root, 'missing')
  const replaced = join(root, 'replaced')
  initRepo(unrelated)
  git(source, ['worktree', 'add', '-qb', 'missing', missing])
  rmSync(missing, { recursive: true })
  git(source, ['worktree', 'add', '-qb', 'replaced', replaced])
  renameSync(replaced, join(root, 'moved'))
  initRepo(replaced)
  writeFileSync(join(unrelated, 'outside.txt'), 'outside\n')
  symlinkSync(join(unrelated, 'outside.txt'), join(linked, 'escape.txt'))

  const listed = await call(handlers.repositories, route('/api/vcs.repositories', { sessionId: 'source' }))
  assert.deepEqual(listed.body.repositories[0].worktrees.map(entry => entry.path), [source, linked])
  for (const query of [
    { ...repo, worktree: unrelated }, { ...repo, worktree: missing }, { ...repo, worktree: replaced },
    { ...repo, worktree: source }, { ...repo, worktree: 'relative' }, { ...repo, worktree: '' },
    { ...repo, repo: unrelated, worktree: linked }, { ...repo, repo: linked },
  ]) {
    const denied = await call(handlers.status, route('/api/vcs.status', query))
    assert.equal(denied.status, 400, JSON.stringify(query))
    assert.equal(denied.body.error.code, 'not-a-repo')
  }
  const escaped = await call(handlers.diff, route('/api/vcs.diff', { ...repo, worktree: linked, scope: 'untracked', path: 'escape.txt' }))
  assert.equal(escaped.status, 400)
  assert.equal(escaped.body.error.code, 'bad-request')

  const before = [git(source, ['symbolic-ref', 'HEAD']), git(linked, ['symbolic-ref', 'HEAD'])]
  for (const [handler, path, body] of [
    [handlers.sync, '/api/vcs.sync', {}],
    [handlers.switchBranch, '/api/vcs.switch', { branch: 'topic/preview' }],
    [handlers.branchOp, '/api/vcs.branch', { action: 'rename', branch: 'main', name: 'renamed' }],
    [handlers.tagOp, '/api/vcs.tag', { action: 'delete', tag: 'v1' }],
    [handlers.commitOp, '/api/vcs.commit-op', { action: 'checkout', sha: git(source, ['rev-parse', 'HEAD']) }],
  ]) {
    for (const [url, target, expected] of [
      [path, { ...repo, worktree: linked }, 'forbidden'],
      [route(path, { worktree: linked }), repo, 'forbidden'],
      [path, { ...repo, repo: linked }, 'not-a-repo'],
    ]) {
      const answer = await handler(new Request(`http://127.0.0.1${url}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, ...body }),
      }))
      assert.equal(answer.status, expected === 'forbidden' ? 403 : 400, path)
      assert.equal((await answer.json()).error.code, expected, path)
    }
  }
  assert.deepEqual([git(source, ['symbolic-ref', 'HEAD']), git(linked, ['symbolic-ref', 'HEAD'])], before)
  assert.equal(git(source, ['branch', '--list', 'renamed']), '')
})

test('selected history walks divergent HEADs once and all history includes unselected refs', async t => {
  const { root, source, linked, repo, handlers } = linkedWorktreeFixture(t)
  const common = git(source, ['rev-parse', 'HEAD'])
  const commit = (cwd, name) => {
    git(cwd, ['commit', '--allow-empty', '-qm', name])
    return git(cwd, ['rev-parse', 'HEAD'])
  }
  const mainHead = commit(source, 'main-only')
  const linkedHead = commit(linked, 'linked-only')
  const duplicate = join(root, 'same linked HEAD')
  const detached = join(root, 'unselected')
  const unrelated = join(root, 'foreign')
  git(source, ['worktree', 'add', '-q', '--detach', duplicate, linkedHead])
  git(source, ['worktree', 'add', '-q', '--detach', detached, common])
  const unselectedHead = commit(detached, 'unselected-only')
  initRepo(unrelated)
  const read = (params = {}) => call(handlers.log, route('/api/vcs.log', { ...repo, ...params }))
  const selection = { ref: 'HEAD', worktree: [source, linked, duplicate] }
  const selected = await read(selection)
  assert.equal(selected.status, 200)
  assert.equal(selected.body.commits.length, 3)
  assert.deepEqual(new Set(selected.body.commits.map(entry => entry.sha)), new Set([mainHead, linkedHead, common]))
  assert.deepEqual(Object.fromEntries(selected.body.worktreeHeads.map(tree => [tree.path, tree.head])), {
    [source]: mainHead, [linked]: linkedHead, [duplicate]: linkedHead,
  })
  assert.equal(selected.body.commits.at(-1).sha, common)
  const page = await read({ ...selection, limit: 2, skip: 1 })
  assert.deepEqual(page.body.commits.map(entry => entry.sha), selected.body.commits.slice(1).map(entry => entry.sha))
  const single = await read({ ref: 'HEAD', worktree: [linked] })
  assert.deepEqual(single.body.commits.map(entry => entry.sha), [linkedHead, common])
  const all = await read()
  assert.deepEqual(new Set(all.body.commits.map(entry => entry.sha)), new Set([mainHead, linkedHead, common, unselectedHead]))

  const denied = await read({ worktree: [source, unrelated] })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'not-a-repo')
  for (const paths of [[source, `${source}/`], [source, '--all'], Array(52).fill(source)]) {
    const invalid = await read({ worktree: paths })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'bad-request')
  }
  const multipleStatus = await call(handlers.status, route('/api/vcs.status', { ...repo, ...selection }))
  assert.equal(multipleStatus.body.error.code, 'bad-request')
  assert.deepEqual([git(source, ['rev-parse', 'HEAD']), git(linked, ['rev-parse', 'HEAD'])], [mainHead, linkedHead])
})

test('status reports branch facts and all three groups with counts', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.repo, { path: mainPath, name: 'main' })
  assert.deepEqual(body.branch, {
    name: 'main',
    oid: fixture.headSha,
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  })
  assert.deepEqual(body.groups.staged, [
    { path: 'both.txt', status: 'M', added: 1, deleted: 0, partiallyStaged: true },
    { path: 'moved.txt', status: 'R', origPath: 'untouched.txt', added: 0, deleted: 0 },
    { path: 'staged.txt', status: 'A', added: 1, deleted: 0 },
  ])
  assert.deepEqual(body.groups.unstaged, [
    { path: 'both.txt', status: 'M', added: 1, deleted: 0, partiallyStaged: true },
    { path: 'image.bin', status: 'M', added: 0, deleted: 0, binary: true },
    { path: 'tracked.txt', status: 'M', added: 1, deleted: 1 },
  ])
  assert.deepEqual(body.groups.untracked, [
    { path: 'leak', status: 'U', untracked: true, added: 0, deleted: 0 },
    { path: 'scratch/', status: 'U', untracked: true, added: 0, deleted: 0, directory: true },
  ])
  assert.equal(body.truncated, false)
  assert.equal(body.total, 7)
})

test('status reports an unborn branch and stays an empty history', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-unborn', repo: unbornPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.branch, {
    name: 'main',
    oid: null,
    detached: false,
    unborn: true,
    upstream: null,
    ahead: 0,
    behind: 0,
  })
  assert.deepEqual(body.groups.staged, [])
  assert.deepEqual(body.groups.unstaged, [])
  assert.deepEqual(body.groups.untracked, [
    { path: 'first.txt', status: 'U', untracked: true, added: 0, deleted: 0 },
  ])
  assert.equal(body.total, 1)
})

test('status accepts a trailing-slash repository path echoed by the client', async () => {
  const { status } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: `${mainPath}/` }),
  )
  assert.equal(status, 200)
})

test('status refuses a repo query discovery did not offer', async () => {
  const fromPlain = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-plain', repo: mainPath }),
  )
  assert.equal(fromPlain.status, 400)
  assert.equal(fromPlain.body.error.code, 'not-a-repo')

  const arbitrary = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: '/etc' }),
  )
  assert.equal(arbitrary.status, 400)
  assert.equal(arbitrary.body.error.code, 'not-a-repo')

  const missing = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-main' }),
  )
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'bad-request')
})

test('status refuses an unknown session', async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-missing', repo: mainPath }),
  )
  assert.equal(status, 409)
  assert.equal(body.error.code, 'no-session')
})

test('untracked lists direct children, filters ignored paths, and sorts', async () => {
  const { status, body } = await call(
    handlers.untracked,
    route('/api/vcs.untracked', { sessionId: 's-main', repo: mainPath, path: 'scratch/' }),
  )
  assert.equal(status, 200)
  assert.equal(body.path, 'scratch/')
  assert.equal(body.truncated, false)
  assert.deepEqual(body.entries, [
    { name: 'blob.bin', path: 'scratch/blob.bin', type: 'file' },
    { name: 'deep', path: 'scratch/deep', type: 'directory' },
    { name: 'huge.txt', path: 'scratch/huge.txt', type: 'file' },
    { name: 'large.txt', path: 'scratch/large.txt', type: 'file' },
    { name: 'notes.md', path: 'scratch/notes.md', type: 'file' },
  ])
})

test('untracked refuses paths that are not contained directories', async () => {
  const cases = [
    { path: 'scratch' },
    { path: '../outside/' },
    { path: '/etc/' },
    { path: 'leak/' },
    { path: 'scratch/notes.md/' },
    { path: 'scratch//' },
  ]
  for (const params of cases) {
    const { status, body } = await call(
      handlers.untracked,
      route('/api/vcs.untracked', { sessionId: 's-main', repo: mainPath, ...params }),
    )
    assert.ok(status === 400 || status === 404, `expected refusal for ${params.path}, got ${status}`)
    assert.equal(typeof body.error.code, 'string')
  }

  const missing = await call(
    handlers.untracked,
    route('/api/vcs.untracked', {
      sessionId: 's-main',
      repo: mainPath,
      path: 'nope/',
    }),
  )
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not-found')
})

test('diff reports an unstaged text change', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'tracked.txt',
    }),
  )
  assert.equal(status, 200)
  const { fingerprint, indexOid, ...comparison } = body
  assert.match(indexOid, /^[\da-f]{40}$/u)
  assert.match(fingerprint, /^[\da-f]{64}$/u)
  assert.deepEqual(comparison, {
    kind: 'text',
    lineStaging: true,
    path: 'tracked.txt',
    before: true,
    after: true,
    hunks: [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' one', '-two', '+TWO', ' three'],
    }],
  })
})

test('diff with oldPath keeps a staged rename instead of reading it as a new file', async () => {
  const renamed = await call(handlers.diff, route('/api/vcs.diff', {
    sessionId: 's-main',
    repo: mainPath,
    scope: 'staged',
    path: 'renamed.txt',
    oldPath: 'to-rename.txt',
  }))
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.kind, 'text')
  assert.equal(renamed.body.path, 'renamed.txt')
  assert.equal(renamed.body.before, true)
  assert.equal(renamed.body.after, true)
  assert.equal(renamed.body.hunks.length, 0)

  const escaped = await call(handlers.diff, route('/api/vcs.diff', {
    sessionId: 's-main',
    repo: mainPath,
    scope: 'staged',
    path: 'renamed.txt',
    oldPath: '../secret/secret.txt',
  }))
  assert.equal(escaped.status, 400)
})

test('diff reports a staged new file', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'staged',
      path: 'staged.txt',
    }),
  )
  assert.equal(status, 200)
  const { fingerprint, indexOid, ...comparison } = body
  assert.match(indexOid, /^[\da-f]{40}$/u)
  assert.match(fingerprint, /^[\da-f]{64}$/u)
  assert.deepEqual(comparison, {
    kind: 'text',
    lineStaging: true,
    path: 'staged.txt',
    before: false,
    after: true,
    hunks: [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+staged'],
    }],
  })
})

test('diff shows both sides of the same file without mixing them', async () => {
  const staged = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'staged',
      path: 'both.txt',
    }),
  )
  assert.equal(staged.status, 200)
  assert.equal(staged.body.before, true)
  assert.equal(staged.body.after, true)
  assert.deepEqual(staged.body.hunks, [{
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    lines: [' both', '+staged'],
  }])

  const unstaged = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'both.txt',
    }),
  )
  assert.equal(unstaged.status, 200)
  assert.match(staged.body.indexOid, /^[\da-f]{40}$/u)
  assert.equal(unstaged.body.indexOid, staged.body.indexOid)
  assert.deepEqual(unstaged.body.hunks, [{
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    lines: [' both', ' staged', '+worktree'],
  }])
})

test('staged diff preserves a deletion when the worktree replaces the file with a directory', async t => {
  const { source, repo, handlers } = linkedWorktreeFixture(t)
  git(source, ['rm', '-q', '--', 'tracked.txt'])
  mkdirSync(join(source, 'tracked.txt'))
  writeFileSync(join(source, 'tracked.txt', 'new'), 'replacement\n')
  const { status, body } = await call(handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'staged', path: 'tracked.txt' }))
  assert.equal(status, 200)
  assert.equal(body.before, true)
  assert.equal(body.after, false)
  assert.equal(body.indexOid, '0'.repeat(40))
  assert.deepEqual(body.hunks[0].lines, ['-base'])
})

test('diff reports an untracked text file as one all-additions hunk', async () => {
  const { status, body } = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/notes.md',
    }),
  )
  assert.equal(status, 200)
  const { fingerprint, ...comparison } = body
  assert.match(fingerprint, /^[\da-f]{64}$/u)
  assert.deepEqual(comparison, {
    kind: 'text',
    lineStaging: true,
    path: 'scratch/notes.md',
    before: false,
    after: true,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+# notes'],
    }],
  })
})

test('diff reports binaries and oversized files instead of text', async () => {
  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/blob.bin',
    }),
  )
  assert.equal(binary.status, 200)
  assert.deepEqual(binary.body, { kind: 'binary', path: 'scratch/blob.bin' })

  const unstagedBinary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'image.bin',
    }),
  )
  assert.deepEqual(unstagedBinary.body, { kind: 'binary', path: 'image.bin' })

  const lineCapped = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/large.txt',
    }),
  )
  assert.deepEqual(lineCapped.body, { kind: 'oversized', path: 'scratch/large.txt' })

  const byteCapped = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'untracked',
      path: 'scratch/huge.txt',
    }),
  )
  assert.deepEqual(byteCapped.body, { kind: 'oversized', path: 'scratch/huge.txt' })
})

test('diff compares a commit with its first parent and a root commit with the empty tree', async () => {
  const normal = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'tracked.txt',
      rev: fixture.headSha,
    }),
  )
  assert.equal(normal.status, 200)
  assert.equal(normal.body.before, true)
  assert.equal(normal.body.after, true)
  assert.deepEqual(normal.body.hunks[0].lines, [' one', ' two', '+three'])

  const root = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'tracked.txt',
      rev: fixture.rootSha,
    }),
  )
  assert.equal(root.body.before, false)
  assert.equal(root.body.after, true)
  assert.deepEqual(root.body.hunks[0].lines, ['+one', '+two'])

  const deleted = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'to-delete.txt',
      rev: fixture.headSha,
    }),
  )
  assert.equal(deleted.body.before, true)
  assert.equal(deleted.body.after, false)
  assert.deepEqual(deleted.body.hunks[0].lines, ['-d'])

  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'commit',
      path: 'image.bin',
      rev: fixture.rootSha,
    }),
  )
  assert.deepEqual(binary.body, { kind: 'binary', path: 'image.bin' })
})

test('diff rejects escapes, invalid scopes, bad revisions, and missing files', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  const cases = [
    [{ ...base, scope: 'worktree', path: 'tracked.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: '../secret/secret.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: '/etc/passwd' }, 400],
    [{ ...base, scope: 'unstaged', path: '-rf.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: 'leak/secret.txt' }, 400],
    [{ ...base, scope: 'unstaged', path: 'scratch' }, 400],
    [{ ...base, scope: 'untracked', path: 'scratch/deep' }, 400],
    [{ ...base, scope: 'unstaged', path: 'nope.txt' }, 404],
    [{ ...base, scope: 'staged', path: 'nope.txt' }, 404],
    [{ ...base, scope: 'commit', path: 'tracked.txt' }, 400],
    [{ ...base, scope: 'commit', path: 'tracked.txt', rev: 'zzzzzzz' }, 400],
    [{ ...base, scope: 'commit', path: 'tracked.txt', rev: 'f'.repeat(40) }, 404],
    [{ ...base, scope: 'commit', path: 'nope.txt', rev: fixture.headSha }, 404],
  ]
  for (const [params, expected] of cases) {
    const { status } = await call(handlers.diff, route('/api/vcs.diff', params))
    assert.equal(status, expected, `expected ${expected} for ${JSON.stringify(params)}`)
  }

  // A path that looks like pathspec magic must not widen the comparison; the
  // literal pathspec makes it a nonexistent file instead of a repository-wide diff.
  const magic = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, scope: 'unstaged', path: ':(glob)*' }),
  )
  assert.equal(magic.status, 404)
})

test('log pages HEAD and all history with parsed refs and times', async () => {
  const head = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, ref: 'HEAD', limit: 1 }),
  )
  assert.equal(head.status, 200)
  assert.equal(head.body.commits.length, 1)
  assert.equal(head.body.commits[0].sha, fixture.headSha)
  assert.deepEqual(head.body.commits[0].parents, [fixture.rootSha])
  assert.deepEqual(head.body.commits[0].refs, [
    { name: 'main', kind: 'branch', current: true },
  ])
  assert.equal(head.body.commits[0].author, 'Test User')
  assert.equal(typeof head.body.commits[0].authorTime, 'number')
  assert.equal(head.body.commits[0].subject, 'second commit')
  assert.equal(head.body.truncated, false)
  assert.equal(head.body.nextSkip, 1)

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, ref: 'all', limit: 10 }),
  )
  assert.equal(all.body.commits.length, 2)
  assert.equal(all.body.nextSkip, 2)

  const secondPage = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, skip: 1, limit: 10 }),
  )
  assert.equal(secondPage.body.commits.length, 1)
  assert.equal(secondPage.body.commits[0].sha, fixture.rootSha)

  const clamped = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath, limit: 0 }),
  )
  assert.equal(clamped.body.commits.length, 1)
})

test('log answers an unborn branch with an empty page', async () => {
  const { status, body } = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-unborn', repo: unbornPath }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, { commits: [], truncated: false, nextSkip: null })

  const head = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-unborn', repo: unbornPath, ref: 'HEAD' }),
  )
  assert.equal(head.status, 200)
  assert.deepEqual(head.body, { commits: [], truncated: false, nextSkip: null })

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-unborn', repo: unbornPath, ref: 'all' }),
  )
  assert.deepEqual(all.body, { commits: [], truncated: false, nextSkip: null })
})

test('log rejects unknown refs and malformed paging values', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  for (const params of [
    { ...base, ref: 'main' },
    { ...base, limit: 'seven' },
    { ...base, skip: 'later' },
  ]) {
    const { status, body } = await call(handlers.log, route('/api/vcs.log', params))
    assert.equal(status, 400)
    assert.equal(body.error.code, 'bad-request')
  }
})

test('commit returns metadata, refs, and a stat-ed file list', async () => {
  const { status, body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.headSha }),
  )
  assert.equal(status, 200)
  assert.equal(body.truncated, false)
  assert.equal(body.commit.sha, fixture.headSha)
  assert.deepEqual(body.commit.parents, [fixture.rootSha])
  assert.deepEqual(body.commit.refs, [{ name: 'main', kind: 'branch', current: true }])
  assert.equal(body.commit.author, 'Test User')
  assert.equal(typeof body.commit.authorTime, 'number')
  assert.equal(body.commit.committer, 'Test User')
  assert.equal(typeof body.commit.committerTime, 'number')
  assert.equal(body.commit.subject, 'second commit')
  assert.equal(body.commit.message, 'second commit')

  const files = new Map(body.commit.files.map(file => [file.path, file]))
  assert.deepEqual(files.get('added.txt'), { path: 'added.txt', status: 'A', added: 1, deleted: 0, binary: false })
  assert.deepEqual(files.get('both.txt'), { path: 'both.txt', status: 'A', added: 1, deleted: 0, binary: false })
  assert.deepEqual(files.get('renamed.txt'), {
    path: 'renamed.txt',
    status: 'R',
    origPath: 'to-rename.txt',
    added: 0,
    deleted: 0,
    binary: false,
  })
  assert.deepEqual(files.get('to-delete.txt'), {
    path: 'to-delete.txt',
    status: 'D',
    added: 0,
    deleted: 1,
    binary: false,
  })
  assert.deepEqual(files.get('tracked.txt'), {
    path: 'tracked.txt',
    status: 'M',
    added: 1,
    deleted: 0,
    binary: false,
  })
  assert.equal(body.commit.files.length, 5)

  const shortSha = await call(
    handlers.commit,
    route('/api/vcs.commit', {
      sessionId: 's-main',
      repo: mainPath,
      sha: fixture.headSha.slice(0, 7),
    }),
  )
  assert.equal(shortSha.body.commit.sha, fixture.headSha)
})

test('commit reads a root commit and its binary file', async () => {
  const { body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.rootSha }),
  )
  assert.deepEqual(body.commit.parents, [])
  const files = new Map(body.commit.files.map(file => [file.path, file]))
  assert.equal(files.get('.gitignore').status, 'A')
  assert.deepEqual(files.get('image.bin'), {
    path: 'image.bin',
    status: 'A',
    added: 0,
    deleted: 0,
    binary: true,
  })
})

test('commit compares a merge commit against its first parent', async () => {
  const { status, body } = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-merge', repo: mergePath, sha: fixture.mergeSha }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body.commit.parents, [fixture.mergeFirstParent, fixture.mergeSecondParent])
  assert.equal(body.commit.subject, 'merge side')
  assert.deepEqual(body.commit.refs, [{ name: 'main', kind: 'branch', current: true }])
  // Without an explicit two-tree diff, `git diff-tree <merge>` prints nothing;
  // the first-parent comparison is what makes the changed file appear.
  assert.deepEqual(body.commit.files, [
    { path: 'side.txt', status: 'A', added: 1, deleted: 0, binary: false },
  ])
  assert.equal(body.truncated, false)

  const single = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      sessionId: 's-merge',
      repo: mergePath,
      scope: 'commit',
      path: 'side.txt',
      rev: fixture.mergeSha,
    }),
  )
  assert.equal(single.status, 200)
  assert.equal(single.body.before, false)
  assert.equal(single.body.after, true)
  assert.deepEqual(single.body.hunks[0].lines, ['+side'])
})

test('diff and commit detail run git comparisons with --no-ext-diff', async () => {
  const argvSeen = []
  const recording = createHandlers(createHost({
    subprocess: {
      resolveExecutable: command => fakeSubprocess.resolveExecutable(command),
      spawn(spec) {
        argvSeen.push(spec.argv)
        return fakeSubprocess.spawn(spec)
      },
    },
  }))

  await call(
    recording.commit,
    route('/api/vcs.commit', { sessionId: 's-main', repo: mainPath, sha: fixture.headSha }),
  )
  const diffTree = argvSeen.filter(argv => argv.includes('diff-tree'))
  assert.equal(diffTree.length, 2)
  for (const argv of diffTree) {
    assert.ok(argv.includes('--no-ext-diff'), `diff-tree without --no-ext-diff: ${argv.join(' ')}`)
  }

  argvSeen.length = 0
  await call(
    recording.diff,
    route('/api/vcs.diff', {
      sessionId: 's-main',
      repo: mainPath,
      scope: 'unstaged',
      path: 'tracked.txt',
    }),
  )
  const diff = argvSeen.find(argv => argv.includes('diff'))
  assert.notEqual(diff, undefined)
  assert.ok(diff.includes('--no-ext-diff'), `diff without --no-ext-diff: ${diff.join(' ')}`)
})

test('commit rejects malformed and unknown ids', async () => {
  const base = { sessionId: 's-main', repo: mainPath }
  const malformed = await call(
    handlers.commit,
    route('/api/vcs.commit', { ...base, sha: 'not-a-sha' }),
  )
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'bad-request')

  const unknown = await call(
    handlers.commit,
    route('/api/vcs.commit', { ...base, sha: 'f'.repeat(40) }),
  )
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not-found')
})

test('a host without git still lists the repository and answers vcs-missing', async () => {
  const missing = createHandlers(createHost({
    subprocess: {
      resolveExecutable: async () => {
        throw new Error('git is not installed')
      },
    },
  }))
  const repositories = await call(
    missing.repositories,
    route('/api/vcs.repositories', { sessionId: 's-main' }),
  )
  assert.equal(repositories.status, 200)
  assert.equal(repositories.body.repositories[0].vcs, 'git')

  const status = await call(
    missing.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status.status, 503)
  assert.equal(status.body.error.code, 'vcs-missing')

  const log = await call(
    missing.log,
    route('/api/vcs.log', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(log.status, 503)
  assert.equal(log.body.error.code, 'vcs-missing')
})

test('a capped git stdout becomes output-too-large', async () => {
  const lossyHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: true }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  }
  const capped = createHandlers(createHost({
    subprocess: {
      resolveExecutable: command => fakeSubprocess.resolveExecutable(command),
      spawn(spec) {
        if (spec.argv.includes('status')) return lossyHandle
        return fakeSubprocess.spawn(spec)
      },
    },
  }))
  const { status, body } = await call(
    capped.status,
    route('/api/vcs.status', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(status, 413)
  assert.equal(body.error.code, 'output-too-large')
})


test('repositories identifies a Jujutsu workspace and exposes its capabilities', { skip: !HAS_JJ }, async () => {
  const { status, body } = await call(
    handlers.repositories,
    route('/api/vcs.repositories', { sessionId: 's-jj' }),
  )
  assert.equal(status, 200)
  const repo = body.repositories.find(candidate => candidate.path === jjPath)
  assert.ok(repo)
  assert.equal(repo.vcs, 'jujutsu')
  assert.equal(repo.capabilities.workingCopy, 'commit')
  assert.equal(repo.capabilities.branchSwitch, false)
  assert.equal(repo.capabilities.branchOps, false)
  assert.equal(repo.capabilities.tagOps, false)
  assert.equal(repo.capabilities.commitOps, false)
  assert.deepEqual(repo.capabilities.ranges.map(range => range.value), ['all', '@'])
  assert.equal(repo.capabilities.defaultRange, 'all')
})

test('Jujutsu status reports the working-copy commit and its summary', { skip: !HAS_JJ }, async () => {
  const { status, body } = await call(
    handlers.status,
    route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(status, 200)
  assert.equal(body.vcs, 'jujutsu')
  assert.equal(body.capabilities.workingCopy, 'commit')
  assert.equal(body.branch, null)
  assert.equal(body.defaultNode, '@')
  assert.deepEqual(body.groups, {})
  assert.equal(body.workingCopy.node, '@')
  assert.equal(body.workingCopy.commitId, fixture.jjHeadSha)
  assert.ok(body.workingCopy.changeId.length > 0)
  assert.equal(body.workingCopy.subject, 'second commit')
  assert.deepEqual(body.workingCopy.parents, [fixture.jjParentSha])
  assert.ok(body.workingCopy.refs.some(reference => reference.kind === 'bookmark' && reference.name === 'feature'))
  assert.equal(body.workingCopy.summary.changed, 5)
  assert.ok(body.workingCopy.summary.added > 0)
  assert.ok(body.workingCopy.summary.deleted > 0)
})

test('Jujutsu log pages the working copy and all visible history', { skip: !HAS_JJ }, async () => {
  const first = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(first.status, 200)
  assert.equal(first.body.commits.length, 2)
  assert.equal(first.body.commits[0].sha, fixture.jjHeadSha)
  assert.equal(first.body.commits[0].workingCopy, true)
  assert.equal(first.body.commits[0].subject, 'second commit')
  assert.ok(first.body.commits[0].changeId.length > 0)
  assert.ok(first.body.commits[0].refs.some(reference => reference.kind === 'bookmark' && reference.name === 'feature'))
  assert.equal(first.body.commits[1].sha, fixture.jjParentSha)
  assert.equal(first.body.commits[1].workingCopy, false)
  assert.ok(first.body.commits[1].refs.some(reference => reference.kind === 'bookmark' && reference.name === 'main'))
  assert.deepEqual(first.body.commits[1].parents, [])
  assert.equal(first.body.nextSkip, 2)

  const secondPage = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, skip: 1, limit: 1 }),
  )
  assert.equal(secondPage.body.commits.length, 1)
  assert.equal(secondPage.body.commits[0].sha, fixture.jjParentSha)

  const all = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, ref: 'all' }),
  )
  assert.equal(all.body.commits.length, 2)

  const wrongRange = await call(
    handlers.log,
    route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath, ref: 'HEAD' }),
  )
  assert.equal(wrongRange.status, 400)
  assert.equal(wrongRange.body.error.code, 'bad-request')
})

function jjWorkspaceFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vcs-jj-workspaces-')))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'source')
  const linked = join(root, 'preview dir')
  mkdirSync(source)
  jj(source, ['--config', 'git.colocate=false', 'git', 'init'])
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  jj(source, ['describe', '-m', 'parent'])
  jj(source, ['new', '-m', 'source work'])
  const add = (path, name) => jj(source, ['workspace', 'add', '--name', name, '-m', name, path])
  add(linked, 'review preview')
  const worktreeSessions = new Map([
    ['source', { header: { cwd: source } }],
    ['linked', { header: { cwd: linked } }],
  ])
  const host = createHost({ sessions: { get: id => worktreeSessions.get(id) } })
  return { root, source, linked, add, repo: { sessionId: 'source', repo: source }, handlers: createHandlers(host) }
}

const recordedJjHead = cwd => jj(cwd, ['--ignore-working-copy', 'log', '-r', '@', '--no-graph', '-T', 'commit_id'])

test('registered Jujutsu workspaces share one history and keep their own snapshots and diffs', { skip: !HAS_JJ_WORKSPACE_ROOTS }, async t => {
  const { source, linked, add, repo, handlers } = jjWorkspaceFixture(t)
  const direct = join(source, 'nested')
  add(direct, 'nested')
  const oldSource = recordedJjHead(source)
  const oldLinked = recordedJjHead(linked)
  const nested = recordedJjHead(direct)
  writeFileSync(join(source, 'tracked.txt'), 'base\nsource only\n')
  writeFileSync(join(linked, 'tracked.txt'), 'base\npreview only\n')

  const list = sessionId => call(handlers.repositories, route('/api/vcs.repositories', { sessionId }))
  const listing = await list('source')
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body.repositories.map(entry => entry.path), [source], 'same store collapses the directly discovered workspace')
  const worktrees = listing.body.repositories[0].worktrees
  assert.equal(worktrees[0].path, source)
  assert.deepEqual(worktrees.find(tree => tree.path === linked), { path: linked, name: 'review preview', head: oldLinked })
  assert.ok(worktrees.some(tree => tree.path === direct && tree.head === nested))
  const reverse = await list('linked')
  assert.equal(reverse.body.repositories[0].path, linked)
  assert.equal(reverse.body.repositories[0].worktrees[0].path, linked)
  assert.ok(reverse.body.repositories[0].worktrees.some(tree => tree.path === source))
  assert.deepEqual([recordedJjHead(source), recordedJjHead(linked)], [oldSource, oldLinked], 'discovery never snapshots')

  const status = options => call(handlers.status, route('/api/vcs.status', { ...repo, ...options }))
  const log = options => call(handlers.log, route('/api/vcs.log', { ...repo, ...options }))
  const preview = await status({ worktree: linked })
  assert.equal(preview.status, 200)
  assert.deepEqual(preview.body.repo, { name: 'review preview', path: linked })
  assert.equal(preview.body.defaultNode, '@')
  assert.equal(preview.body.workingCopy.summary.changed, 1)
  const linkedHead = preview.body.workingCopy.commitId
  assert.notEqual(linkedHead, oldLinked)
  const siblingOnly = await log({ ref: '@', worktree: [linked] })
  assert.equal(siblingOnly.status, 200)
  assert.deepEqual(siblingOnly.body.worktreeHeads, [{ path: linked, head: linkedHead }])
  assert.deepEqual(siblingOnly.body.commits.map(commit => commit.subject), ['review preview', 'parent'])
  const allWhilePreviewing = await log({ worktree: [linked] })
  assert.equal(allWhilePreviewing.status, 200)
  assert.ok(allWhilePreviewing.body.commits.some(commit => commit.sha === nested))
  const detail = await call(handlers.commit, route('/api/vcs.commit', { ...repo, sha: linkedHead }))
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body.commit.files.map(file => file.path), ['tracked.txt'])
  const compare = (rev, options = {}) => call(handlers.diff, route('/api/vcs.diff', {
    ...repo, scope: 'commit', rev, path: 'tracked.txt', ...options,
  }))
  const previewDiff = await compare(linkedHead)
  assert.equal(previewDiff.status, 200)
  assert.deepEqual(previewDiff.body.hunks.flatMap(hunk => hunk.lines), [' base', '+preview only'])
  assert.equal(recordedJjHead(source), oldSource, 'selected history and SHA-based reads do not snapshot an unchecked anchor')

  const base = await status()
  assert.equal(base.status, 200)
  const sourceHead = base.body.workingCopy.commitId
  const selection = { ref: '@', worktree: [source, linked] }
  const both = await log(selection)
  assert.equal(both.status, 200)
  assert.equal(both.body.commits.length, 3, 'the shared parent is not duplicated')
  assert.deepEqual(new Set(both.body.commits.map(commit => commit.subject)), new Set(['source work', 'review preview', 'parent']))
  assert.deepEqual(Object.fromEntries(both.body.worktreeHeads.map(tree => [tree.path, tree.head])), {
    [source]: sourceHead, [linked]: linkedHead,
  })
  const page = await log({ ...selection, limit: 2, skip: 1 })
  assert.deepEqual(page.body.commits, both.body.commits.slice(1))
  assert.deepEqual(page.body.worktreeHeads, both.body.worktreeHeads)
  assert.deepEqual((await compare(sourceHead)).body.hunks.flatMap(hunk => hunk.lines), [' base', '+source only'])
  assert.deepEqual((await compare('@', { worktree: linked })).body.hunks, previewDiff.body.hunks)
})

test('Jujutsu previews refuse missing and unrelated workspace roots, and stay read-only', { skip: !HAS_JJ_WORKSPACE_ROOTS }, async t => {
  const { root, source, linked, add, repo, handlers } = jjWorkspaceFixture(t)
  const missing = join(root, 'missing')
  const replaced = join(root, 'replaced')
  const wrongWorkspace = join(root, 'wrong-workspace')
  const moved = join(root, 'moved')
  add(missing, 'missing')
  add(replaced, 'replaced')
  add(wrongWorkspace, 'stay-registered')
  add(moved, 'move-me')
  rmSync(missing, { recursive: true })
  rmSync(replaced, { recursive: true })
  mkdirSync(replaced)
  jj(replaced, ['--config', 'git.colocate=false', 'git', 'init'])
  rmSync(wrongWorkspace, { recursive: true })
  // The replacement even shares the store, but it names a different workspace.
  renameSync(moved, wrongWorkspace)

  const listing = await call(handlers.repositories, route('/api/vcs.repositories', { sessionId: repo.sessionId }))
  assert.deepEqual(listing.body.repositories[0].worktrees.map(tree => tree.path), [source, linked])
  for (const path of [missing, replaced, wrongWorkspace, moved, source, 'relative']) {
    const denied = await call(handlers.status, route('/api/vcs.status', { ...repo, worktree: path }))
    assert.equal(denied.status, 400)
    assert.equal(denied.body.error.code, 'not-a-repo')
  }
  const invalid = await call(handlers.log, route('/api/vcs.log', { ...repo, worktree: [source, replaced] }))
  assert.equal(invalid.body.error.code, 'not-a-repo')
  const duplicate = await call(handlers.log, route('/api/vcs.log', { ...repo, worktree: [linked, `${linked}/`] }))
  assert.equal(duplicate.body.error.code, 'bad-request')
  const deniedWrite = await handlers.sync(new Request('http://127.0.0.1/api/vcs.sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...repo, worktree: linked }),
  }))
  assert.equal(deniedWrite.status, 403)
  assert.equal((await deniedWrite.json()).error.code, 'forbidden')
})

test('without the Jujutsu workspace template, the session still sees independently discovered roots', { skip: !HAS_JJ_WORKSPACE_ROOTS }, async t => {
  const { source, add, repo } = jjWorkspaceFixture(t)
  const direct = join(source, 'nested')
  add(direct, 'nested')
  const older = createHandlers(createHost({
    sessions: { get: id => id === repo.sessionId ? { header: { cwd: source } } : undefined },
    subprocess: {
      ...fakeSubprocess,
      spawn(spec) {
        if (spec.argv.includes('workspace') && spec.argv.includes('list')) {
          return { done: Promise.resolve({ exitCode: 1 }), collected: {} }
        }
        return fakeSubprocess.spawn(spec)
      },
    },
  }))
  const listing = await call(older.repositories, route('/api/vcs.repositories', { sessionId: repo.sessionId }))
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body.repositories.map(entry => [entry.path, entry.worktrees.map(tree => tree.path)]), [
    [source, [source]], [direct, [direct]],
  ])
  const history = await call(older.log, route('/api/vcs.log', repo))
  assert.equal(history.status, 200)
  assert.ok(history.body.commits.some(commit => commit.subject === 'source work' && commit.workingCopy === true))
  const selected = await call(older.log, route('/api/vcs.log', { ...repo, ref: '@' }))
  assert.equal(selected.status, 200)
  assert.equal(selected.body.commits[0].subject, 'source work')
  assert.equal(selected.body.commits[0].workingCopy, true)
})

test('Jujutsu commit detail carries change id, refs, and file stats', { skip: !HAS_JJ }, async () => {
  const workingCopy = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-jj', repo: jjPath, sha: '@' }),
  )
  assert.equal(workingCopy.status, 200)
  assert.equal(workingCopy.body.commit.sha, fixture.jjHeadSha)
  assert.equal(workingCopy.body.commit.workingCopy, true)
  assert.ok(workingCopy.body.commit.changeId.length > 0)
  assert.equal(workingCopy.body.commit.subject, 'second commit')
  assert.equal(workingCopy.body.commit.message, 'second commit')
  assert.deepEqual(workingCopy.body.commit.parents, [fixture.jjParentSha])

  const files = new Map(workingCopy.body.commit.files.map(file => [file.path, file]))
  assert.deepEqual(files.get('tracked.txt'), {
    path: 'tracked.txt', status: 'M', added: 1, deleted: 0, binary: false,
  })
  assert.deepEqual(files.get('renamed.txt'), {
    path: 'renamed.txt', status: 'R', origPath: 'to-rename.txt', added: 0, deleted: 0, binary: false,
  })
  assert.deepEqual(files.get('to-delete.txt'), {
    path: 'to-delete.txt', status: 'D', added: 0, deleted: 1, binary: false,
  })
  assert.deepEqual(files.get('added.txt'), {
    path: 'added.txt', status: 'A', added: 1, deleted: 0, binary: false,
  })
  assert.equal(files.get('image.bin').status, 'M')

  const parent = await call(
    handlers.commit,
    route('/api/vcs.commit', { sessionId: 's-jj', repo: jjPath, sha: fixture.jjParentSha }),
  )
  assert.equal(parent.body.commit.workingCopy, false)
  assert.equal(parent.body.commit.subject, 'initial commit')
  assert.ok(parent.body.commit.refs.some(reference => reference.kind === 'bookmark' && reference.name === 'main'))
  assert.ok(parent.body.commit.files.some(file => file.path === 'tracked.txt' && file.status === 'A'))
})

test('Jujutsu diff reads text, renames, binaries, and missing files', { skip: !HAS_JJ }, async () => {
  const base = { sessionId: 's-jj', repo: jjPath, scope: 'commit', rev: '@' }
  const text = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'tracked.txt' }),
  )
  assert.equal(text.status, 200)
  assert.equal(text.body.kind, 'text')
  assert.deepEqual(text.body.hunks[0].lines, [' one', ' two', '+three'])

  const renamed = await call(
    handlers.diff,
    route('/api/vcs.diff', {
      ...base, path: 'renamed.txt', oldPath: 'to-rename.txt',
    }),
  )
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.kind, 'text')
  assert.deepEqual(renamed.body.hunks, [])

  const binary = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'image.bin' }),
  )
  assert.equal(binary.status, 200)
  assert.deepEqual(binary.body, { kind: 'binary', path: 'image.bin' })

  const missing = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: 'not-here.txt' }),
  )
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'not-found')

  const wrongScope = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, scope: 'unstaged', path: 'tracked.txt' }),
  )
  assert.equal(wrongScope.status, 400)

  const wrongRev = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, rev: 'main', path: 'tracked.txt' }),
  )
  assert.equal(wrongRev.status, 400)

  const escaped = await call(
    handlers.diff,
    route('/api/vcs.diff', { ...base, path: '../secret/secret.txt' }),
  )
  assert.equal(escaped.status, 400)

  const untracked = await call(
    handlers.untracked,
    route('/api/vcs.untracked', { sessionId: 's-jj', repo: jjPath, path: 'dir/' }),
  )
  assert.equal(untracked.status, 400)
  assert.equal(untracked.body.error.code, 'bad-request')
})

test('a host without jj answers vcs-missing only when reading', { skip: !HAS_JJ }, async () => {
  const missing = createHandlers(createHost({
    subprocess: {
      resolveExecutable: async (command, _options, _signal) => {
        if (command === 'jj') throw new Error('jj is not installed')
        return fakeSubprocess.resolveExecutable(command)
      },
    },
  }))
  const repositories = await call(
    missing.repositories,
    route('/api/vcs.repositories', { sessionId: 's-jj' }),
  )
  assert.equal(repositories.status, 200)
  assert.ok(repositories.body.repositories.some(repository => repository.vcs === 'jujutsu'))

  const status = await call(
    missing.status,
    route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
  )
  assert.equal(status.status, 503)
  assert.equal(status.body.error.code, 'vcs-missing')
})

test('Jujutsu reads keep the working-copy commit unchanged', { skip: !HAS_JJ }, async () => {
  jj(jjPath, ['status'])
  const before = jj(jjPath, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  const beforeFile = (await readFile(join(jjPath, 'tracked.txt'), 'utf8'))
  const repository = { sessionId: 's-jj', repo: jjPath }
  await call(handlers.status, route('/api/vcs.status', repository))
  await call(handlers.log, route('/api/vcs.log', repository))
  await call(handlers.commit, route('/api/vcs.commit', { ...repository, sha: '@' }))
  await call(handlers.diff, route('/api/vcs.diff', { ...repository, scope: 'commit', rev: '@', path: 'tracked.txt' }))
  const after = jj(jjPath, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
  const afterFile = (await readFile(join(jjPath, 'tracked.txt'), 'utf8'))
  assert.equal(after, before)
  assert.equal(afterFile, beforeFile)
})

test('Jujutsu status snapshots a new working-copy change on refresh', { skip: !HAS_JJ }, async () => {
  writeFileSync(join(jjPath, 'late.txt'), 'late\n')
  try {
    const { status, body } = await call(
      handlers.status,
      route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
    )
    assert.equal(status, 200)
    assert.equal(body.workingCopy.summary.changed, 6)
    const first = body.workingCopy.commitId
    const again = await call(
      handlers.status,
      route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath }),
    )
    assert.equal(again.body.workingCopy.summary.changed, 6)
    assert.equal(again.body.workingCopy.commitId, first)
  } finally {
    rmSync(join(jjPath, 'late.txt'), { force: true })
    jj(jjPath, ['status'])
  }
})

test('Jujutsu shared snapshot survives one caller aborting and cancels when all callers abort', { skip: !HAS_JJ }, async () => {
  let snapshots = 0
  let snapshotAborted = 0
  let releaseSnapshot = null
  const delayedHandlers = createHandlers(createHost({
    subprocess: {
      resolveExecutable: fakeSubprocess.resolveExecutable,
      spawn(spec) {
        const isSnapshot = spec.argv.includes('commit_id') && !spec.argv.includes('--ignore-working-copy')
        const handle = fakeSubprocess.spawn(spec)
        if (!isSnapshot) return handle
        snapshots += 1
        spec.signal?.addEventListener('abort', () => { snapshotAborted += 1 }, { once: true })
        const gate = new Promise(resolve => { releaseSnapshot = resolve })
        return {
          ...handle,
          done: Promise.all([handle.done, gate]).then(([outcome]) => outcome),
        }
      },
    },
  }))

  // Caller 1 (e.g. TurnTail status) starts snapshotting; Caller 2 (VcsView log)
  // joins while the snapshot is still running; Caller 1 aborts on view switch.
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const firstPromise = delayedHandlers.status(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: firstAbort.signal },
  ))
  while (releaseSnapshot === null) await new Promise(resolve => { setTimeout(resolve, 5) })
  const secondPromise = delayedHandlers.log(new Request(
    `http://127.0.0.1${route('/api/vcs.log', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: secondAbort.signal },
  ))
  await new Promise(resolve => { setTimeout(resolve, 15) })

  firstAbort.abort()
  await assert.rejects(firstPromise, error => error?.name === 'AbortError')
  assert.equal(snapshotAborted, 0, 'the shared snapshot continues for the remaining caller')

  releaseSnapshot()
  const secondResponse = await secondPromise
  assert.equal(secondResponse.status, 200)
  const secondBody = await secondResponse.json()
  assert.equal(Array.isArray(secondBody.commits), true)
  assert.equal(snapshots, 1)

  // When the only waiting caller aborts, the snapshot subprocess is aborted and evicted.
  releaseSnapshot = null
  const loneAbort = new AbortController()
  const lonePromise = delayedHandlers.status(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-jj', repo: jjPath })}`,
    { signal: loneAbort.signal },
  ))
  while (releaseSnapshot === null) await new Promise(resolve => { setTimeout(resolve, 5) })
  loneAbort.abort()
  releaseSnapshot()
  await assert.rejects(lonePromise, error => error?.name === 'AbortError')
  assert.equal(snapshotAborted, 1)
})

test('apply registers nine GET routes and every write route inside the fence and honors enabled: false', async () => {
  const routes = []
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    effect(fn) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
      return dispose
    },
    connection: {
      fetch: {
        register(r) {
          routes.push(r)
          return async () => {}
        },
      },
    },
  }

  apply(ctx, undefined)
  assert.deepEqual(routes.map(r => r.path), [
    '/api/vcs.repositories',
    '/api/vcs.status',
    '/api/vcs.branches',
    '/api/vcs.remotes',
    '/api/vcs.untracked',
    '/api/vcs.diff',
    '/api/vcs.log',
    '/api/vcs.commit',
    '/api/vcs.turn',
    '/api/vcs.sync',
    '/api/vcs.switch',
    '/api/vcs.branch',
    '/api/vcs.tag',
    '/api/vcs.commit-op',
    '/api/vcs.stage',
    '/api/vcs.stage-history',
  ])
  const writePaths = new Set(['/api/vcs.sync', '/api/vcs.switch', '/api/vcs.branch', '/api/vcs.tag', '/api/vcs.commit-op', '/api/vcs.stage', '/api/vcs.stage-history'])
  for (const registered of routes) {
    assert.deepEqual(registered.methods, writePaths.has(registered.path) ? ['POST'] : ['GET'])
    assert.equal(registered.requestBody, 'buffered')
  }

  const statusRoute = routes.find(r => r.path === '/api/vcs.status')
  const response = await statusRoute.fetch(new Request(
    `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-main', repo: mainPath })}`,
  ))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')

  // A read stops with the browser; the write keeps going once it has started.
  const left = new AbortController()
  left.abort()
  await assert.rejects(
    statusRoute.fetch(new Request(
      `http://127.0.0.1${route('/api/vcs.status', { sessionId: 's-main', repo: mainPath })}`,
      { signal: left.signal },
    )),
    error => error.name === 'AbortError',
  )
  const syncRoute = routes.find(r => r.path === '/api/vcs.sync')
  const syncResponse = await syncRoute.fetch(new Request('http://127.0.0.1/api/vcs.sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-main', repo: mainPath }),
    signal: left.signal,
  }))
  assert.equal(syncResponse.status, 409)
  assert.equal((await syncResponse.json()).error.code, 'no-upstream')

  // A switch to the checked-out branch is a no-op, and the write ignores the
  // browser's abort like sync does.
  const switchRoute = routes.find(r => r.path === '/api/vcs.switch')
  const switchResponse = await switchRoute.fetch(new Request('http://127.0.0.1/api/vcs.switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-main', repo: mainPath, branch: 'main' }),
    signal: left.signal,
  }))
  assert.equal(switchResponse.status, 200)
  assert.deepEqual(await switchResponse.json(), { branch: 'main' })

  const disabled = []
  apply({
    ...ctx,
    connection: { fetch: { register: r => { disabled.push(r); return async () => {} } } },
  }, { enabled: false })
  assert.deepEqual(disabled, [])
})

test('normalizeConfig turns the feature off only for a literal enabled: false', () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true })
  assert.deepEqual(normalizeConfig(null), { enabled: true })
  assert.deepEqual(normalizeConfig({}), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: true }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: 'false' }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: 0 }), { enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false })
})

test('vcs.turn records each turn\'s active branch across switches, validates inputs, and cleans up', async () => {
  const repoDir = join(fixture.scratch, 'turn-branches')
  initRepo(repoDir)
  writeFileSync(join(repoDir, 'file.txt'), 'v1\n')
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-qm', 'base'])

  const listeners = new Map()
  const turnSessions = new Map([
    ['s-turns', { id: 's-turns', header: { cwd: repoDir } }],
    ['s-unborn', { id: 's-unborn', header: { cwd: fixture.unborn } }],
    ['s-plain', { id: 's-plain', header: { cwd: fixture.plain } }],
    ['s-nocwd', { id: 's-nocwd', header: {} }],
  ])
  const summaries = new Map([
    ['s-turns:11', { turn: 1, cwd: repoDir, files: [{ path: 'file.txt', display: 'file.txt', added: 4, deleted: 1 }], total: 1, added: 4, deleted: 1, snapshot: { before: 'a', after: 'b' } }],
    ['s-turns:22', { turn: 2, cwd: repoDir, files: [], total: 3, added: 18, deleted: 5 }],
    ['s-turns:33', { turn: 3, cwd: repoDir, files: [], total: 2, added: 9, deleted: 0 }],
    ['s-plain:44', { turn: 1, cwd: fixture.plain, files: [], total: 1, added: 7, deleted: 0 }],
  ])

  const emit = (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) fn(...args)
  }
  const emitStopping = async (session, turn) => {
    for (const fn of listeners.get('agent/turn-stopping') ?? []) {
      const bail = await fn({ agent: { session }, turn })
      assert.equal(bail, undefined, 'agent/turn-stopping listener must not return a Cordis bail value')
    }
  }

  const host = {
    sessions: { get: id => turnSessions.get(id) },
    fs: fakeFs,
    subprocess: fakeSubprocess,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    // Cordis exposes optional services via ctx.get() while direct property read throws without inject.
    get(name) {
      if (name === 'workspaceChanges') {
        return {
          summary: (sessionId, seq) => summaries.get(`${sessionId}:${seq}`),
        }
      }
      return undefined
    },
    get workspaceChanges() {
      throw new Error('handlers must resolve workspaceChanges via ctx.get when present')
    },
  }

  const tracker = createTurnTracker(host)
  const detach = tracker.attach()
  const turnHandlers = createHandlers(host, { turnTracker: tracker })
  const session = turnSessions.get('s-turns')

  try {
    // Turn 1 runs on `main`.
    emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', session, { type: 'tool/result', seq: 10, data: { turn: 1, message: { isError: false } } })
    await emitStopping(session, 1)
    emit('session/event', session, { type: 'turn/end', seq: 12, data: { turn: 1 } })

    // Turn 2 checks out `feat/round-2` before stopping.
    git(repoDir, ['checkout', '-qb', 'feat/round-2'])
    emit('session/event', session, { type: 'turn/start', seq: 13, data: { turn: 2 } })
    emit('session/event', session, { type: 'tool/result', seq: 21, data: { turn: 2, message: { isError: false } } })
    await emitStopping(session, 2)
    emit('session/event', session, { type: 'turn/end', seq: 23, data: { turn: 2 } })

    // Turn 3 detaches HEAD and ends abruptly without `agent/turn-stopping`.
    git(repoDir, ['checkout', '-q', '--detach', 'HEAD'])
    emit('session/event', session, { type: 'turn/start', seq: 24, data: { turn: 3 } })
    emit('session/event', session, { type: 'tool/result', seq: 32, data: { turn: 3, message: { isError: false } } })
    emit('session/event', session, { type: 'turn/end', seq: 34, data: { turn: 3 } })

    // Turn 4 has a recorded head (`detached`) without a workspaceChanges summary.
    emit('session/event', session, { type: 'turn/start', seq: 35, data: { turn: 4 } })
    emit('session/event', session, { type: 'tool/result', seq: 36, data: { turn: 4, message: { isError: false } } })
    await emitStopping(session, 4)
    emit('session/event', session, { type: 'turn/end', seq: 37, data: { turn: 4 } })

    // Each turn keeps the branch on which that turn ran, and never leaks cwd/snapshot/files.
    const t1 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1, seq: 11 }))
    assert.equal(t1.status, 200)
    assert.deepEqual(t1.body, {
      turn: 1,
      head: { kind: 'branch', name: 'main' },
      changed: 1,
      added: 4,
      deleted: 1,
    })

    const t2 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 2, seq: 22 }))
    assert.equal(t2.status, 200)
    assert.deepEqual(t2.body, {
      turn: 2,
      head: { kind: 'branch', name: 'feat/round-2' },
      changed: 3,
      added: 18,
      deleted: 5,
    })

    const t3 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 3, seq: 33 }))
    assert.equal(t3.status, 200)
    assert.deepEqual(t3.body, {
      turn: 3,
      head: { kind: 'detached' },
      changed: 2,
      added: 9,
      deleted: 0,
    })

    const t4 = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 4 }))
    assert.equal(t4.status, 200)
    assert.deepEqual(t4.body, {
      turn: 4,
      head: { kind: 'detached' },
      changed: null,
      added: null,
      deleted: null,
    })

    // Unborn repository records `unborn`; plain directory records `head: null`.
    const unbornSession = turnSessions.get('s-unborn')
    emit('session/event', unbornSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', unbornSession, { type: 'tool/result', seq: 2, data: { turn: 1, message: { isError: false } } })
    await emitStopping(unbornSession, 1)
    const unborn = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-unborn', turn: 1 }))
    assert.equal(unborn.status, 200)
    assert.deepEqual(unborn.body.head, { kind: 'unborn' })

    const plainSession = turnSessions.get('s-plain')
    emit('session/event', plainSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit('session/event', plainSession, { type: 'tool/result', seq: 2, data: { turn: 1, message: { isError: false } } })
    await emitStopping(plainSession, 1)
    const plain = await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-plain', turn: 1, seq: 44 }))
    assert.equal(plain.status, 200)
    assert.deepEqual(plain.body, { turn: 1, head: null, changed: 1, added: 7, deleted: 0 })

    // Validation & missing-turn refusals.
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { turn: 1 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 'missing', turn: 1 }))).status, 409)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-nocwd', turn: 1 }))).status, 409)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 0 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1, seq: -1 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 2, seq: 11 }))).status, 400)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 99, seq: 999 }))).status, 404)

    // Session disposal clears recorded heads.
    summaries.clear()
    emit('session/disposed', session)
    assert.equal((await call(turnHandlers.turn, route('/api/vcs.turn', { sessionId: 's-turns', turn: 1 }))).status, 404)
  } finally {
    detach()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('vcs.turn records Jujutsu working-copy change ids without snapshotting', { skip: !HAS_JJ }, async () => {
  const opBefore = jj(fixture.jj, ['op', 'log', '--no-graph', '--ignore-working-copy', '-n', '1', '-T', 'id.short(12)'])
  const expectedChangeId = jj(fixture.jj, ['log', '--no-graph', '--ignore-working-copy', '-r', '@', '-T', 'change_id'])
  const listeners = new Map()
  const jjSession = { id: 's-jj', header: { cwd: fixture.jj } }
  const host = createHost({
    on(name, fn) {
      listeners.set(name, fn)
      return () => { listeners.delete(name) }
    },
    workspaceChanges: {
      summary: (_id, seq) => (seq === 7 ? { turn: 1, cwd: fixture.jj, files: [], total: 2, added: 11, deleted: 3 } : undefined),
    },
  })
  const tracker = createTurnTracker(host)
  const detach = tracker.attach()
  const jjHandlers = createHandlers(host, { turnTracker: tracker })
  try {
    listeners.get('session/event')(jjSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    listeners.get('session/event')(jjSession, { type: 'tool/result', seq: 6, data: { turn: 1, message: { isError: false } } })
    await listeners.get('agent/turn-stopping')({ agent: { session: jjSession }, turn: 1 })
    const answer = await call(jjHandlers.turn, route('/api/vcs.turn', { sessionId: 's-jj', turn: 1, seq: 7 }))
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, {
      turn: 1,
      head: { kind: 'workingCopy', changeId: expectedChangeId },
      changed: 2,
      added: 11,
      deleted: 3,
    })
    const opAfter = jj(fixture.jj, ['op', 'log', '--no-graph', '--ignore-working-copy', '-n', '1', '-T', 'id.short(12)'])
    assert.equal(opAfter, opBefore, 'turn head capture must not write a jj working-copy snapshot')
  } finally {
    detach()
  }
})

test('every route is read-only: repository state is identical after all requests', async () => {
  const before = gitRaw(fixture.main, ['status', '--porcelain=v2', '-z', '--branch'])
  const headBefore = git(fixture.main, ['rev-parse', 'HEAD'])
  const indexBefore = git(fixture.main, ['ls-files', '-s'])

  const repo = { sessionId: 's-main', repo: mainPath }
  for (const [handler, url] of [
    [handlers.repositories, route('/api/vcs.repositories', { sessionId: 's-main' })],
    [handlers.status, route('/api/vcs.status', repo)],
    [handlers.branches, route('/api/vcs.branches', repo)],
    [handlers.remotes, route('/api/vcs.remotes', repo)],
    [handlers.untracked, route('/api/vcs.untracked', { ...repo, path: 'scratch/' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'unstaged', path: 'tracked.txt' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'staged', path: 'staged.txt' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'untracked', path: 'scratch/notes.md' })],
    [handlers.diff, route('/api/vcs.diff', { ...repo, scope: 'commit', path: 'tracked.txt', rev: fixture.headSha })],
    [handlers.log, route('/api/vcs.log', repo)],
    [handlers.commit, route('/api/vcs.commit', { ...repo, sha: fixture.headSha })],
  ]) {
    const { status } = await call(handler, url)
    assert.equal(status, 200)
  }

  const after = gitRaw(fixture.main, ['status', '--porcelain=v2', '-z', '--branch'])
  assert.equal(after, before)
  assert.equal(git(fixture.main, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(fixture.main, ['ls-files', '-s']), indexBefore)
  assert.equal(
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: fixture.main,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim(),
    headBefore,
  )

  // No lock is left behind by a read.
  let lockExists = true
  try {
    await stat(join(fixture.main, '.git', 'index.lock'))
  } catch (error) {
    if (error.code === 'ENOENT') lockExists = false
    else throw error
  }
  assert.equal(lockExists, false)
})

// Branch switching ----------------------------------------------------------

/**
 * Build one repository with two local branches that change the same file, so
 * switching between them can be refused by local changes.
 * @param {string} name - scratch subdirectory.
 * @returns {object} the fixture paths, the session, and its handlers.
 */
function buildSwitchFixture(name) {
  const base = join(fixture.scratch, name)
  const repo = join(base, 'repo')
  mkdirSync(base, { recursive: true })
  initRepo(repo)
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])

  git(repo, ['checkout', '-qb', 'topic'])
  writeFileSync(join(repo, 'shared.txt'), 'topic\n')
  writeFileSync(join(repo, 'topic.txt'), 'topic only\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'topic change'])
  const topicSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'shared.txt'), 'main\n')
  writeFileSync(join(repo, 'main.txt'), 'main only\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'main change'])

  const sessionId = `s-switch-${name}`
  const switchSessions = new Map([[sessionId, { header: { cwd: repo } }]])
  const switchHandlers = createHandlers(createHost({ sessions: { get: id => switchSessions.get(id) } }))
  return { repo, sessionId, handlers: switchHandlers, topicSha }
}

/**
 * POST one switch request.
 * @param {Function} handler - the switch handler.
 * @param {unknown} body - JSON body, or a raw string.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{ status: number, body: object }>} the decoded answer.
 */
async function postSwitch(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.switch', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

test('branches lists local branches with the checked-out one marked', async () => {
  const fixtureSwitch = buildSwitchFixture('branches')
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }

  const listed = await call(fixtureSwitch.handlers.branches, route('/api/vcs.branches', body))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.truncated, false)
  assert.deepEqual(
    listed.body.branches.map(entry => [entry.name, entry.current]),
    [['main', true], ['topic', false]],
  )

  // A remote-tracking ref is not a local branch and cannot be checked out.
  git(fixtureSwitch.repo, ['update-ref', 'refs/remotes/origin/topic', fixtureSwitch.topicSha])
  const localOnly = await call(fixtureSwitch.handlers.branches, route('/api/vcs.branches', body))
  assert.deepEqual(
    localOnly.body.branches.map(entry => entry.name),
    ['main', 'topic'],
  )
})

test('switch checks out a local branch and leaves a clean tree in place', async () => {
  const fixtureSwitch = buildSwitchFixture('switch-flow')
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }

  const switched = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' })
  assert.equal(switched.status, 200)
  assert.deepEqual(switched.body, { branch: 'topic' })
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'topic')
  assert.equal(await readFile(join(fixtureSwitch.repo, 'shared.txt'), 'utf8'), 'topic\n')
  assert.equal(await readFile(join(fixtureSwitch.repo, 'topic.txt'), 'utf8'), 'topic only\n')

  const status = await call(fixtureSwitch.handlers.status, route('/api/vcs.status', body))
  assert.equal(status.body.branch.name, 'topic')

  const back = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'main' })
  assert.equal(back.status, 200)
  assert.deepEqual(back.body, { branch: 'main' })
  assert.equal(await readFile(join(fixtureSwitch.repo, 'shared.txt'), 'utf8'), 'main\n')
  assert.equal(await readFile(join(fixtureSwitch.repo, 'main.txt'), 'utf8'), 'main only\n')

  // Switching to the checked-out branch is an answer, not a command.
  const again = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'main' })
  assert.equal(again.status, 200)
  assert.deepEqual(again.body, { branch: 'main' })
})

test('switch refuses a dirty tree and an untracked collision without changing anything', async () => {
  const fixtureSwitch = buildSwitchFixture('switch-dirty')
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }

  // A tracked edit that the target branch would overwrite.
  writeFileSync(join(fixtureSwitch.repo, 'shared.txt'), 'mine\n')
  const blocked = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'switch-blocked')
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(await readFile(join(fixtureSwitch.repo, 'shared.txt'), 'utf8'), 'mine\n')

  // An untracked file that the target branch would overwrite.
  git(fixtureSwitch.repo, ['checkout', '-q', '--', 'shared.txt'])
  writeFileSync(join(fixtureSwitch.repo, 'topic.txt'), 'local untracked\n')
  const untracked = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' })
  assert.equal(untracked.status, 409)
  assert.equal(untracked.body.error.code, 'switch-blocked')
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(await readFile(join(fixtureSwitch.repo, 'topic.txt'), 'utf8'), 'local untracked\n')

  // With the path clear, the same switch succeeds.
  rmSync(join(fixtureSwitch.repo, 'topic.txt'))
  const switched = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' })
  assert.equal(switched.status, 200)
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'topic')
})

test('switch accepts only an existing local branch and nothing that reads as an option', async () => {
  const fixtureSwitch = buildSwitchFixture('switch-target')
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }
  const head = git(fixtureSwitch.repo, ['rev-parse', 'HEAD'])

  for (const branch of [undefined, null, '', 42, 'topic\n', 'two words', '-f', '--force', '@{upstream}', 'origin/topic', 'nope']) {
    const answer = await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch })
    assert.equal(answer.status, 400, String(branch))
    assert.equal(answer.body.error.code, 'bad-request', String(branch))
  }
  assert.equal(git(fixtureSwitch.repo, ['rev-parse', 'HEAD']), head)
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(git(fixtureSwitch.repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']), 'refs/heads/main\nrefs/heads/topic')
})

test('switch accepts only same-origin JSON POSTs for a switchable repository', async () => {
  const fixtureSwitch = buildSwitchFixture('switch-request')
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }
  const head = git(fixtureSwitch.repo, ['rev-parse', 'HEAD'])

  const cases = [
    [await postSwitch(fixtureSwitch.handlers.switchBranch, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' }, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' }, { 'content-type': 'application/x-www-form-urlencoded' }), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic' }, { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }), 403, 'forbidden'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, '{not json'), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, [body]), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { sessionId: fixtureSwitch.sessionId, branch: 'topic' }), 400, 'bad-request'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic', sessionId: 's-missing' }), 409, 'no-session'],
    [await postSwitch(fixtureSwitch.handlers.switchBranch, { ...body, branch: 'topic', repo: plainPath }), 400, 'not-a-repo'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(fixtureSwitch.repo, ['rev-parse', 'HEAD']), head)
  assert.equal(git(fixtureSwitch.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
})

test('switch is refused for Jujutsu, which has no branch to check out', { skip: !HAS_JJ }, async () => {
  const before = jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1'])
  const branches = await call(handlers.branches, route('/api/vcs.branches', { sessionId: 's-jj', repo: jjPath }))
  assert.equal(branches.status, 400)
  assert.equal(branches.body.error.code, 'bad-request')
  const answer = await postSwitch(handlers.switchBranch, { sessionId: 's-jj', repo: jjPath, branch: 'main' })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error.code, 'bad-request')
  const op = await postBranchOp(handlers.branchOp, { sessionId: 's-jj', repo: jjPath, action: 'push', branch: 'main' })
  assert.equal(op.status, 400)
  assert.equal(op.body.error.code, 'bad-request')
  const remotes = await call(handlers.remotes, route('/api/vcs.remotes', { sessionId: 's-jj', repo: jjPath }))
  assert.equal(remotes.status, 400)
  assert.equal(remotes.body.error.code, 'bad-request')
  const tag = await postTagOp(handlers.tagOp, { sessionId: 's-jj', repo: jjPath, action: 'delete', tag: 'v1' })
  assert.equal(tag.status, 400)
  assert.equal(tag.body.error.code, 'bad-request')
  const commit = await postCommitOp(handlers.commitOp, { sessionId: 's-jj', repo: jjPath, action: 'tag', sha: fixture.jjHeadSha, name: 'v1' })
  assert.equal(commit.status, 400)
  assert.equal(commit.body.error.code, 'bad-request')
  assert.equal(jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1']), before)
})

test('a write in flight blocks both a second switch and a sync', async () => {
  const { createBackends } = await import('../lib/vcs/index.js')
  const fixtureSwitch = buildSwitchFixture('switch-lock')
  const host = createHost({
    sessions: {
      get: id => (id === fixtureSwitch.sessionId ? { header: { cwd: fixtureSwitch.repo } } : undefined),
    },
  })
  const real = createBackends(host)
  let release
  let started = 0
  const gate = new Promise(resolve => { release = resolve })
  const gated = Object.create(real.get('git'))
  gated.switchBranch = async () => {
    started += 1
    await gate
    return { branch: 'topic' }
  }
  const gatedHandlers = createHandlers(host, {
    backends: { get: id => (id === 'git' ? gated : real.get(id)), list: () => real.list() },
  })
  const body = { sessionId: fixtureSwitch.sessionId, repo: realpathSync(fixtureSwitch.repo) }

  const first = postSwitch(gatedHandlers.switchBranch, { ...body, branch: 'topic' })
  const deadline = Date.now() + 5_000
  while (started === 0 && Date.now() < deadline) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.equal(started, 1, 'the first switch reached the backend')
  const second = await postSwitch(gatedHandlers.switchBranch, { ...body, branch: 'main' })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'busy')
  const sync = await postSync(gatedHandlers.sync, body)
  assert.equal(sync.status, 409)
  assert.equal(sync.body.error.code, 'busy')
  const branch = await postBranchOp(gatedHandlers.branchOp, { ...body, action: 'rename', branch: 'topic', name: 'renamed' })
  assert.equal(branch.status, 409)
  assert.equal(branch.body.error.code, 'busy')
  release()
  assert.equal((await first).status, 200)

  // The lock is released with the answer, so the next write can run.
  const next = await postSwitch(gatedHandlers.switchBranch, { ...body, branch: 'main' })
  assert.equal(next.status, 200)
  assert.equal(started, 2)
})

// Branch actions -------------------------------------------------------------

/**
 * Build one repository with the branches the actions menu can address: a
 * checked-out `main`, a merged branch, an unmerged branch, a conflicting
 * branch, and a branch tracking a bare remote.
 * @param {string} name - scratch subdirectory.
 * @returns {object} the fixture paths, commits, repository, session, and handlers.
 */
function buildActionFixture(name) {
  const base = join(fixture.scratch, name)
  const repo = join(base, 'repo')
  const bare = join(base, 'remote.git')
  mkdirSync(base, { recursive: true })
  initRepo(repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])
  const baseSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['branch', 'merged'])

  git(repo, ['checkout', '-qb', 'unmerged'])
  writeFileSync(join(repo, 'unmerged.txt'), 'unmerged\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'unmerged work'])
  const unmergedSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-qb', 'topic', baseSha])
  writeFileSync(join(repo, 'topic.txt'), 'topic\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'topic work'])
  const topicSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'main\n')
  writeFileSync(join(repo, 'main.txt'), 'main\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'main work'])
  const mainSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-qb', 'conflict', baseSha])
  writeFileSync(join(repo, 'base.txt'), 'conflict\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'conflicting work'])
  git(repo, ['checkout', '-q', 'main'])

  git(base, ['init', '-q', '--bare', '-b', 'main', bare])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['config', 'branch.main.remote', 'origin'])
  git(repo, ['config', 'branch.main.merge', 'refs/heads/main'])

  git(repo, ['branch', 'tracking', 'main'])
  git(repo, ['config', 'branch.tracking.remote', 'origin'])
  git(repo, ['config', 'branch.tracking.merge', 'refs/heads/tracking'])
  git(repo, ['push', '-q', 'origin', 'tracking'])
  git(repo, ['checkout', '-q', 'tracking'])
  writeFileSync(join(repo, 'tracking.txt'), 'tracking\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'tracking work'])
  const trackingSha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '-q', 'main'])

  git(repo, ['branch', 'plain', 'main'])

  // Remote-only branches for the remote-branch actions: a fast-forwardable
  // source, a conflicting source, and the remote's symbolic HEAD.
  git(repo, ['push', '-q', 'origin', 'topic:remote-topic', 'conflict:remote-conflict', 'tracking:remote-tracking'])
  git(repo, ['fetch', '-q', 'origin'])
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  // A lightweight tag on the base commit and an annotated tag on main, so
  // delete and push cover both tag object shapes.
  git(repo, ['tag', 'v1', baseSha])
  git(repo, ['tag', '-a', 'v2', '-m', 'release 2', mainSha])

  const sessionId = `s-branch-${name}`
  const branchSessions = new Map([[sessionId, { header: { cwd: repo } }]])
  return {
    repo,
    bare,
    baseSha,
    unmergedSha,
    topicSha,
    mainSha,
    trackingSha,
    sessionId,
    handlers: createHandlers(createHost({ sessions: { get: id => branchSessions.get(id) } })),
  }
}

/**
 * POST one branch action.
 * @param {Function} handler - the branchOp handler.
 * @param {object} body - JSON body.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{ status: number, body: object }>} the decoded answer.
 */
async function postBranchOp(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.branch', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

/**
 * POST one tag action.
 * @param {Function} handler - the tagOp handler.
 * @param {object} body - JSON body.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{ status: number, body: object }>} the decoded answer.
 */
async function postTagOp(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.tag', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

/**
 * POST one commit action.
 * @param {Function} handler - the commitOp handler.
 * @param {object} body - JSON body.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{ status: number, body: object }>} the decoded answer.
 */
async function postCommitOp(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.commit-op', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

test('branch actions rename a branch and refuse invalid or existing names', async () => {
  const action = buildActionFixture('branch-rename')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const renamed = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'topic', name: 'renamed' })
  assert.equal(renamed.status, 200)
  assert.deepEqual(renamed.body, { from: 'topic', branch: 'renamed' })
  assert.equal(
    git(action.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    ['main', 'merged', 'renamed', 'plain', 'conflict', 'tracking', 'unmerged'].sort().join('\n'),
  )

  const exists = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'renamed', name: 'main' })
  assert.equal(exists.status, 409)
  assert.equal(exists.body.error.code, 'branch-exists')

  const invalid = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'renamed', name: 'bad..name' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'branch-invalid')

  const missing = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'nope', name: 'other' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'bad-request')

  // Renaming the checked-out branch moves HEAD with it.
  const current = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'main', name: 'trunk' })
  assert.equal(current.status, 200)
  assert.deepEqual(current.body, { from: 'main', branch: 'trunk' })
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'trunk')
  assert.equal(git(action.repo, ['config', '--get', 'branch.trunk.remote']), 'origin')
  assert.equal(git(action.repo, ['config', '--get', 'branch.trunk.merge']), 'refs/heads/main')
  let oldRemote = null
  try {
    oldRemote = git(action.repo, ['config', '--get', 'branch.main.remote'])
  } catch {
    // The old section is gone, which is the point.
  }
  assert.equal(oldRemote, null)
  const status = await call(action.handlers.status, route('/api/vcs.status', body))
  assert.equal(status.body.branch.name, 'trunk')
})

test('branch actions delete merged branches, force unmerged ones, and protect the checked-out branch', async () => {
  const action = buildActionFixture('branch-delete')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const merged = await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete', branch: 'merged' })
  assert.equal(merged.status, 200)
  assert.deepEqual(merged.body, { branch: 'merged' })
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/merged']), '')

  const unmerged = await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete', branch: 'unmerged' })
  assert.equal(unmerged.status, 409)
  assert.equal(unmerged.body.error.code, 'branch-unmerged')
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/unmerged']), action.unmergedSha)

  const forced = await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete', branch: 'unmerged', force: true })
  assert.equal(forced.status, 200)
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/unmerged']), '')

  const current = await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete', branch: 'main' })
  assert.equal(current.status, 409)
  assert.equal(current.body.error.code, 'branch-in-use')
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
})

test('branch actions merge into the current branch and abort a conflict', async () => {
  const action = buildActionFixture('branch-merge')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  git(action.repo, ['checkout', '-qb', 'ff', 'main'])
  writeFileSync(join(action.repo, 'ff.txt'), 'ff\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'ff work'])
  const ffSha = git(action.repo, ['rev-parse', 'HEAD'])
  git(action.repo, ['checkout', '-q', 'main'])

  const fastForward = await postBranchOp(action.handlers.branchOp, { ...body, action: 'merge', branch: 'ff' })
  assert.equal(fastForward.status, 200)
  assert.deepEqual(fastForward.body, { branch: 'ff', current: 'main', result: 'fast-forward' })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), ffSha)
  assert.equal(await readFile(join(action.repo, 'ff.txt'), 'utf8'), 'ff\n')

  git(action.repo, ['checkout', '-qb', 'side', 'main'])
  writeFileSync(join(action.repo, 'side.txt'), 'side\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'side work'])
  git(action.repo, ['checkout', '-q', 'main'])
  writeFileSync(join(action.repo, 'main-side.txt'), 'main\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'main moves on'])

  const merged = await postBranchOp(action.handlers.branchOp, { ...body, action: 'merge', branch: 'side' })
  assert.equal(merged.status, 200)
  assert.deepEqual(merged.body, { branch: 'side', current: 'main', result: 'merged' })
  assert.equal(
    git(action.repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length,
    3,
    'the merge has two parents',
  )

  const level = await postBranchOp(action.handlers.branchOp, { ...body, action: 'merge', branch: 'side' })
  assert.equal(level.status, 200)
  assert.equal(level.body.result, 'up-to-date')

  const headBefore = git(action.repo, ['rev-parse', 'HEAD'])
  const reached = await postBranchOp(action.handlers.branchOp, { ...body, action: 'merge', branch: 'conflict' })
  assert.equal(reached.status, 409)
  assert.equal(reached.body.error.code, 'merge-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), headBefore)
  let mergeHead = ''
  try {
    mergeHead = git(action.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  } catch {
    // No merge in progress: the abort restored the pre-merge state.
  }
  assert.equal(mergeHead, '')
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
  assert.equal(await readFile(join(action.repo, 'base.txt'), 'utf8'), 'main\n')
})

test('branch actions rebase onto another branch and abort a conflict', async () => {
  const action = buildActionFixture('branch-rebase')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const topicBefore = git(action.repo, ['rev-parse', 'refs/heads/topic'])

  const rebased = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rebase', branch: 'topic' })
  assert.equal(rebased.status, 200)
  assert.deepEqual(rebased.body, { branch: 'topic', current: 'main' })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD^']), topicBefore)
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/topic']), topicBefore)

  const conflicted = buildActionFixture('branch-rebase-conflict')
  const conflictBody = { sessionId: conflicted.sessionId, repo: realpathSync(conflicted.repo) }
  const mainBefore = git(conflicted.repo, ['rev-parse', 'HEAD'])
  const conflict = await postBranchOp(conflicted.handlers.branchOp, { ...conflictBody, action: 'rebase', branch: 'conflict' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'rebase-blocked')
  assert.equal(git(conflicted.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(git(conflicted.repo, ['rev-parse', 'HEAD']), mainBefore)
  assert.equal(git(conflicted.repo, ['status', '--porcelain']), '')
})

test('branch actions push to the configured upstream and report a refusal', async () => {
  const action = buildActionFixture('branch-push')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const pushed = await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking' })
  assert.equal(pushed.status, 200)
  assert.deepEqual(pushed.body, { branch: 'tracking', upstream: 'origin/tracking', pushed: true })
  assert.equal(git(action.bare, ['rev-parse', 'refs/heads/tracking']), action.trackingSha)

  const level = await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking' })
  assert.equal(level.status, 200)
  assert.deepEqual(level.body, { branch: 'tracking', upstream: 'origin/tracking', pushed: false })

  const plain = await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'plain' })
  assert.equal(plain.status, 409)
  assert.equal(plain.body.error.code, 'no-upstream')

  // Move the remote to a commit the local branch does not contain: the push is
  // refused and the local ref stays where it was.
  git(action.repo, ['checkout', '-qb', 'remote-ahead', action.baseSha])
  writeFileSync(join(action.repo, 'remote.txt'), 'remote\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'remote work'])
  git(action.repo, ['checkout', '-q', 'main'])
  git(action.bare, ['fetch', '--force', '-q', action.repo, 'remote-ahead:refs/heads/tracking'])
  const rejected = await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking' })
  assert.equal(rejected.status, 502)
  assert.equal(rejected.body.error.code, 'remote-failed')
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/tracking']), action.trackingSha)
})

test('branch actions accept only valid actions and trusted same-origin JSON POSTs', async () => {
  const action = buildActionFixture('branch-request')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const headsBefore = git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])
  const remotesBefore = git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'])

  const cases = [
    [await postBranchOp(action.handlers.branchOp, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking' }, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postBranchOp(action.handlers.branchOp, '{not json'), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, [body]), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'checkout', branch: 'topic' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'topic' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'rename', branch: 'topic', name: '-bad' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete', branch: 'merged', force: 'yes' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: null }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { sessionId: action.sessionId, action: 'push', branch: 'tracking' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking', sessionId: 's-missing' }), 409, 'no-session'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'push', branch: 'tracking', repo: plainPath }), 400, 'not-a-repo'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'checkout-remote', branch: 'origin/remote-topic' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'checkout-remote', branch: 'origin/remote-topic', local: '-bad' }), 400, 'bad-request'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'checkout-remote', branch: 'origin/remote-topic', local: 'bad..name' }), 400, 'branch-invalid'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'delete-remote', branch: 'main' }), 409, 'remote-branch-missing'],
    [await postBranchOp(action.handlers.branchOp, { ...body, action: 'pull-remote', branch: 'origin/HEAD' }), 409, 'remote-branch-missing'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']), headsBefore)
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']), remotesBefore)
})

test('branch actions leave an in-progress merge or rebase untouched', async () => {
  const action = buildActionFixture('branch-in-progress')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  // A user's conflicted merge is already in progress. Our merge must refuse
  // without aborting it.
  try {
    git(action.repo, ['merge', 'conflict'])
  } catch {
    // The conflict is the setup.
  }
  const mergeHead = git(action.repo, ['rev-parse', 'MERGE_HEAD'])
  const headBefore = git(action.repo, ['rev-parse', 'HEAD'])
  const inProgress = await postBranchOp(action.handlers.branchOp, { ...body, action: 'merge', branch: 'topic' })
  assert.equal(inProgress.status, 409)
  assert.equal(inProgress.body.error.code, 'merge-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'MERGE_HEAD']), mergeHead)
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), headBefore)
  assert.match(git(action.repo, ['status', '--porcelain']), /^UU /mu)

  git(action.repo, ['merge', '--abort'])

  // The same for a rebase left by the user.
  try {
    git(action.repo, ['rebase', 'conflict'])
  } catch {
    // The conflict is the setup.
  }
  const rebaseHead = git(action.repo, ['rev-parse', 'REBASE_HEAD'])
  const rebasing = await postBranchOp(action.handlers.branchOp, { ...body, action: 'rebase', branch: 'topic' })
  assert.equal(rebasing.status, 409)
  assert.equal(rebasing.body.error.code, 'rebase-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'REBASE_HEAD']), rebaseHead)
  assert.match(git(action.repo, ['status', '--porcelain']), /^UU /mu)
})

// Commit actions --------------------------------------------------------------

/**
 * Build one repository with a base commit, a side commit off it, a main commit
 * on top of it, a chain of two commits for dropping, and a conflicting side
 * commit for pick/merge/rebase refusals.
 * @param {string} name - scratch subdirectory.
 * @returns {object} the fixture paths, commits, repository, session, and handlers.
 */
function buildCommitFixture(name) {
  const base = join(fixture.scratch, name)
  const repo = join(base, 'repo')
  mkdirSync(base, { recursive: true })
  initRepo(repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'base'])
  const baseSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['branch', 'side'])
  git(repo, ['checkout', '-q', 'side'])
  writeFileSync(join(repo, 'side.txt'), 'side\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'side work'])
  const sideSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'main\n')
  writeFileSync(join(repo, 'main.txt'), 'main\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'main work'])
  const mainSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['branch', 'chain', 'main'])
  git(repo, ['checkout', '-q', 'chain'])
  writeFileSync(join(repo, 'chain-a.txt'), 'a\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'chain a'])
  const chainASha = git(repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'chain-b.txt'), 'b\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'chain b'])
  const chainBSha = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-qb', 'conflict', baseSha])
  writeFileSync(join(repo, 'base.txt'), 'conflict\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'conflict work'])
  const conflictSha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '-q', 'main'])

  const sessionId = `s-commit-${name}`
  const commitSessions = new Map([[sessionId, { header: { cwd: repo } }]])
  return {
    repo,
    baseSha,
    sideSha,
    mainSha,
    chainASha,
    chainBSha,
    conflictSha,
    sessionId,
    handlers: createHandlers(createHost({ sessions: { get: id => commitSessions.get(id) } })),
  }
}

// Remote branch actions ------------------------------------------------------

test('remote branch checkout creates a tracking branch and refuses bad targets', async () => {
  const action = buildActionFixture('remote-checkout')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const checked = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'checkout-remote',
    branch: 'origin/remote-topic',
    local: 'remote-topic-local',
  })
  assert.equal(checked.status, 200)
  assert.deepEqual(checked.body, { branch: 'origin/remote-topic', local: 'remote-topic-local' })
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'remote-topic-local')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.topicSha)
  assert.equal(git(action.repo, ['config', '--get', 'branch.remote-topic-local.remote']), 'origin')
  assert.equal(git(action.repo, ['config', '--get', 'branch.remote-topic-local.merge']), 'refs/heads/remote-topic')

  const existing = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'checkout-remote',
    branch: 'origin/remote-topic',
    local: 'main',
  })
  assert.equal(existing.status, 409)
  assert.equal(existing.body.error.code, 'branch-exists')

  const invalid = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'checkout-remote',
    branch: 'origin/remote-topic',
    local: 'bad..name',
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'branch-invalid')

  const missing = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'checkout-remote',
    branch: 'origin/nope',
    local: 'nope-local',
  })
  assert.equal(missing.status, 409)
  assert.equal(missing.body.error.code, 'remote-branch-missing')

  const remoteHead = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'checkout-remote',
    branch: 'origin/HEAD',
    local: 'head-local',
  })
  assert.equal(remoteHead.status, 409)
  assert.equal(remoteHead.body.error.code, 'remote-branch-missing')
})

test('the log attaches remote and branch names to remote-tracking refs', async () => {
  const action = buildActionFixture('remote-log')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const page = await call(action.handlers.log, route('/api/vcs.log', { ...body, ref: 'all' }))
  assert.equal(page.status, 200)
  const topic = page.body.commits.find(commit => commit.sha === action.topicSha)
  assert.notEqual(topic, undefined)
  const remote = topic.refs.find(ref => ref.name === 'origin/remote-topic')
  assert.deepEqual(remote, {
    name: 'origin/remote-topic',
    kind: 'remote',
    remote: 'origin',
    branch: 'remote-topic',
  })
  const branch = topic.refs.find(ref => ref.name === 'topic')
  assert.equal(branch.remote, undefined)

  const commitDetail = await call(action.handlers.commit, route('/api/vcs.commit', { ...body, sha: action.topicSha }))
  assert.equal(commitDetail.status, 200)
  assert.deepEqual(
    commitDetail.body.commit.refs.find(ref => ref.name === 'origin/remote-topic'),
    { name: 'origin/remote-topic', kind: 'remote', remote: 'origin', branch: 'remote-topic' },
  )
  const mainDetail = await call(action.handlers.commit, route('/api/vcs.commit', { ...body, sha: action.mainSha }))
  assert.equal(mainDetail.status, 200)
  assert.deepEqual(
    mainDetail.body.commit.refs.find(ref => ref.name === 'main'),
    { name: 'main', kind: 'branch', current: true },
  )
})

test('remote branch merge fast-forwards or stops without touching the branch', async () => {
  const action = buildActionFixture('remote-merge')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const fastForward = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'merge-remote',
    branch: 'origin/remote-tracking',
  })
  assert.equal(fastForward.status, 200)
  assert.deepEqual(fastForward.body, {
    branch: 'origin/remote-tracking',
    current: 'main',
    result: 'fast-forward',
  })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.trackingSha)

  const headBefore = git(action.repo, ['rev-parse', 'HEAD'])
  const conflict = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'merge-remote',
    branch: 'origin/remote-conflict',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'merge-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
  let mergeHead = ''
  try {
    mergeHead = git(action.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  } catch {
    // The conflict was aborted.
  }
  assert.equal(mergeHead, '')
})

test('remote branch pull fetches the tracking ref and merges it', async () => {
  const action = buildActionFixture('remote-pull')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  // Make the tracking ref stale relative to the remote, then pull.
  git(action.repo, ['update-ref', 'refs/remotes/origin/remote-tracking', action.mainSha])
  const pulled = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'pull-remote',
    branch: 'origin/remote-tracking',
  })
  assert.equal(pulled.status, 200)
  assert.deepEqual(pulled.body, {
    branch: 'origin/remote-tracking',
    current: 'main',
    result: 'fast-forward',
  })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.trackingSha)
  assert.equal(git(action.repo, ['rev-parse', 'refs/remotes/origin/remote-tracking']), action.trackingSha)

  const headBefore = git(action.repo, ['rev-parse', 'HEAD'])
  const conflict = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'pull-remote',
    branch: 'origin/remote-conflict',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'merge-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
})

test('remote branch delete removes the remote branch and its tracking ref', async () => {
  const action = buildActionFixture('remote-delete')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const deleted = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'delete-remote',
    branch: 'origin/remote-topic',
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.body, { branch: 'origin/remote-topic' })
  assert.equal(
    git(action.bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/remote-topic']),
    '',
  )
  assert.equal(
    git(action.repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/remote-topic']),
    '',
  )
  // The local branch of the same name is untouched.
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/topic']), action.topicSha)

  const missing = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'delete-remote',
    branch: 'origin/nope',
  })
  assert.equal(missing.status, 409)
  assert.equal(missing.body.error.code, 'remote-branch-missing')

  const remoteHead = await postBranchOp(action.handlers.branchOp, {
    ...body,
    action: 'delete-remote',
    branch: 'origin/HEAD',
  })
  assert.equal(remoteHead.status, 409)
  assert.equal(remoteHead.body.error.code, 'remote-branch-missing')
})

// Tag actions ----------------------------------------------------------------

test('remotes lists the destinations tag push can use', async () => {
  const action = buildActionFixture('tag-remotes')
  const listed = await call(
    action.handlers.remotes,
    route('/api/vcs.remotes', { sessionId: action.sessionId, repo: realpathSync(action.repo) }),
  )
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body, { remotes: ['origin'], truncated: false })

  // A repository with no remote still answers; the push dialog reports it.
  const empty = await call(
    handlers.remotes,
    route('/api/vcs.remotes', { sessionId: 's-main', repo: mainPath }),
  )
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { remotes: [], truncated: false })
})

test('tag actions delete a local tag without touching the branch of the same name', async () => {
  const action = buildActionFixture('tag-delete')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  // A tag may share a branch's short name; the delete must remove only the tag.
  git(action.repo, ['tag', 'merged', action.baseSha])

  const deleted = await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v1' })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.body, { tag: 'v1' })
  assert.equal(git(action.repo, ['tag', '--list']), ['merged', 'v2'].join('\n'))

  // The tag shares its name with a branch; only the tag is gone.
  const sameName = await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'merged' })
  assert.equal(sameName.status, 200)
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/merged']), action.baseSha)
  assert.equal(git(action.repo, ['tag', '--list']), 'v2')

  const missing = await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v1' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'tag-missing')

  // An annotated tag deletes by its short name too.
  const annotated = await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v2' })
  assert.equal(annotated.status, 200)
  assert.equal(git(action.repo, ['tag', '--list']), '')
})

test('tag actions push one tag without force and report a refusal', async () => {
  const action = buildActionFixture('tag-push')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const tagObject = git(action.repo, ['rev-parse', 'refs/tags/v2'])

  const pushed = await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v2', remote: 'origin' })
  assert.equal(pushed.status, 200)
  assert.deepEqual(pushed.body, { tag: 'v2', remote: 'origin', pushed: true })
  // Annotated tags push their own tag object, not the commit they point at.
  assert.equal(git(action.bare, ['rev-parse', 'refs/tags/v2']), tagObject)

  const level = await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v2', remote: 'origin' })
  assert.equal(level.status, 200)
  assert.deepEqual(level.body, { tag: 'v2', remote: 'origin', pushed: false })

  // The remote already has a different object at the same tag. A push without
  // force is refused and neither side moves.
  git(action.bare, ['update-ref', 'refs/tags/v2', action.baseSha])
  const rejected = await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v2', remote: 'origin' })
  assert.equal(rejected.status, 502)
  assert.equal(rejected.body.error.code, 'tag-push-failed')
  assert.equal(git(action.repo, ['rev-parse', 'refs/tags/v2']), tagObject)
  assert.equal(git(action.bare, ['rev-parse', 'refs/tags/v2']), action.baseSha)

  const unknownTag = await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v9', remote: 'origin' })
  assert.equal(unknownTag.status, 404)
  assert.equal(unknownTag.body.error.code, 'tag-missing')

  const unknownRemote = await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v1', remote: 'nope' })
  assert.equal(unknownRemote.status, 409)
  assert.equal(unknownRemote.body.error.code, 'remote-missing')
})

test('tag actions accept only valid actions and trusted same-origin JSON POSTs', async () => {
  const action = buildActionFixture('tag-request')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const tagsBefore = git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags'])

  const cases = [
    [await postTagOp(action.handlers.tagOp, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v1', remote: 'origin' }, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v1' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postTagOp(action.handlers.tagOp, '{not json'), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, [body]), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'checkout', tag: 'v1' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: '-v1' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'bad..name' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v1' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'push', tag: 'v1', remote: '-bad' }), 400, 'bad-request'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v1', sessionId: 's-missing' }), 409, 'no-session'],
    [await postTagOp(action.handlers.tagOp, { ...body, action: 'delete', tag: 'v1', repo: plainPath }), 400, 'not-a-repo'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags']), tagsBefore)
})

test('a tag write blocks other writes and releases the lock with its answer', async () => {
  const { createBackends } = await import('../lib/vcs/index.js')
  const action = buildActionFixture('tag-lock')
  const host = createHost({
    sessions: {
      get: id => (id === action.sessionId ? { header: { cwd: action.repo } } : undefined),
    },
  })
  const real = createBackends(host)
  let release
  let started = 0
  const gate = new Promise(resolve => { release = resolve })
  const gated = Object.create(real.get('git'))
  gated.tagOp = async () => {
    started += 1
    await gate
    return { tag: 'v1' }
  }
  const gatedHandlers = createHandlers(host, {
    backends: { get: id => (id === 'git' ? gated : real.get(id)), list: () => real.list() },
  })
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const first = postTagOp(gatedHandlers.tagOp, { ...body, action: 'delete', tag: 'v1' })
  const deadline = Date.now() + 5_000
  while (started === 0 && Date.now() < deadline) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.equal(started, 1, 'the first tag action reached the backend')
  const second = await postTagOp(gatedHandlers.tagOp, { ...body, action: 'delete', tag: 'v2' })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'busy')
  const branch = await postBranchOp(gatedHandlers.branchOp, { ...body, action: 'rename', branch: 'topic', name: 'renamed' })
  assert.equal(branch.status, 409)
  assert.equal(branch.body.error.code, 'busy')
  const commit = await postCommitOp(gatedHandlers.commitOp, { ...body, action: 'tag', sha: action.baseSha, name: 'v9' })
  assert.equal(commit.status, 409)
  assert.equal(commit.body.error.code, 'busy')
  release()
  assert.equal((await first).status, 200)

  // The lock is released with the answer, so the next write can run.
  const next = await postTagOp(gatedHandlers.tagOp, { ...body, action: 'delete', tag: 'v2' })
  assert.equal(next.status, 200)
  assert.equal(started, 2)
})

// Commit actions --------------------------------------------------------------

test('commit actions add lightweight and annotated tags and create branches without checking them out', async () => {
  const action = buildCommitFixture('commit-refs')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const annotated = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'tag', sha: action.mainSha, name: 'v9', message: 'release',
  })
  assert.equal(annotated.status, 200)
  assert.deepEqual(annotated.body, { tag: 'v9', sha: action.mainSha })
  assert.equal(git(action.repo, ['cat-file', '-t', 'refs/tags/v9']), 'tag')
  assert.match(git(action.repo, ['tag', '--list', '--format=%(contents)', 'v9']), /release/u)

  const light = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'tag', sha: action.baseSha, name: 'light',
  })
  assert.equal(light.status, 200)
  assert.equal(git(action.repo, ['cat-file', '-t', 'refs/tags/light']), 'commit')

  // Even when the user enables tag.gpgSign globally, a lightweight tag (no message)
  // passes --no-sign instead of letting Git invoke an editor or GPG signer.
  git(action.repo, ['config', 'tag.gpgSign', 'true'])
  git(action.repo, ['config', 'gpg.program', 'false'])
  const lightWithGpgSign = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'tag', sha: action.baseSha, name: 'light-unsigned',
  })
  assert.equal(lightWithGpgSign.status, 200)
  assert.equal(git(action.repo, ['cat-file', '-t', 'refs/tags/light-unsigned']), 'commit')
  git(action.repo, ['config', '--unset', 'tag.gpgSign'])
  git(action.repo, ['config', '--unset', 'gpg.program'])

  const exists = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'tag', sha: action.mainSha, name: 'v9',
  })
  assert.equal(exists.status, 409)
  assert.equal(exists.body.error.code, 'tag-exists')

  const invalid = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'tag', sha: action.mainSha, name: 'bad..name',
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'tag-invalid')

  const branch = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'release',
  })
  assert.equal(branch.status, 200)
  assert.deepEqual(branch.body, { branch: 'release', sha: action.baseSha })
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/release']), action.baseSha)
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'main', 'the new branch is not checked out')

  const branchExists = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'release',
  })
  assert.equal(branchExists.status, 409)
  assert.equal(branchExists.body.error.code, 'branch-exists')

  const branchInvalid = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'bad..name',
  })
  assert.equal(branchInvalid.status, 400)
  assert.equal(branchInvalid.body.error.code, 'branch-invalid')

  const badCheckout = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'bad-flag', checkout: 'yes',
  })
  assert.equal(badCheckout.status, 400)
  assert.equal(badCheckout.body.error.code, 'bad-request')

  writeFileSync(join(action.repo, 'base.txt'), 'dirty\n')
  const blockedCheckout = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'blocked-co', checkout: true,
  })
  assert.equal(blockedCheckout.status, 409)
  assert.equal(blockedCheckout.body.error.code, 'checkout-blocked')
  assert.equal(git(action.repo, ['branch', '--list', 'blocked-co']), '')
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'main')
  git(action.repo, ['checkout', '-q', '--', 'base.txt'])

  const checkedBranch = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'branch', sha: action.baseSha, name: 'hotfix', checkout: true,
  })
  assert.equal(checkedBranch.status, 200)
  assert.deepEqual(checkedBranch.body, { branch: 'hotfix', sha: action.baseSha, checkedOut: true })
  assert.equal(git(action.repo, ['symbolic-ref', '--short', 'HEAD']), 'hotfix')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.baseSha)
})

test('commit checkout detaches HEAD and refuses a dirty-tree collision', async () => {
  const action = buildCommitFixture('commit-checkout')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const checked = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'checkout', sha: action.sideSha,
  })
  assert.equal(checked.status, 200)
  assert.deepEqual(checked.body, { sha: action.sideSha })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.sideSha)
  let branch = ''
  try {
    branch = git(action.repo, ['symbolic-ref', '-q', '--short', 'HEAD'])
  } catch {
    // A detached HEAD has no symbolic ref.
  }
  assert.equal(branch, '')

  git(action.repo, ['checkout', '-q', 'main'])
  writeFileSync(join(action.repo, 'base.txt'), 'dirty\n')
  const blocked = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'checkout', sha: action.baseSha,
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'checkout-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.mainSha)
  assert.equal(await readFile(join(action.repo, 'base.txt'), 'utf8'), 'dirty\n')
})

test('commit actions cherry-pick a commit and abort a conflicting pick', async () => {
  const action = buildCommitFixture('commit-cherry-pick')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const picked = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'cherry-pick', sha: action.sideSha,
  })
  assert.equal(picked.status, 200)
  assert.deepEqual(picked.body, { sha: action.sideSha, current: 'main' })
  assert.equal(await readFile(join(action.repo, 'side.txt'), 'utf8'), 'side\n')
  const head = git(action.repo, ['rev-parse', 'HEAD'])

  const conflict = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'cherry-pick', sha: action.conflictSha,
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'commit-conflict')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), head)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
  let pickHead = ''
  try {
    pickHead = git(action.repo, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'])
  } catch {
    // The abort removed the in-progress pick.
  }
  assert.equal(pickHead, '')
})

test('commit actions revert one commit and drop one from a chain', async () => {
  const action = buildCommitFixture('commit-revert-drop')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const reverted = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'revert', sha: action.mainSha,
  })
  assert.equal(reverted.status, 200)
  assert.deepEqual(reverted.body, { sha: action.mainSha, current: 'main' })
  assert.match(git(action.repo, ['log', '-1', '--format=%s']), /^Revert /u)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')

  const dropped = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'drop', sha: action.chainASha,
  })
  assert.equal(dropped.status, 409, 'the branch is not checked out yet')
  assert.equal(dropped.body.error.code, 'commit-not-on-branch')
})

test('commit drop rewrites descendants onto the parent and aborts a conflict', async () => {
  const action = buildCommitFixture('commit-drop')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  git(action.repo, ['checkout', '-q', 'chain'])

  const dropped = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'drop', sha: action.chainASha,
  })
  assert.equal(dropped.status, 200)
  assert.deepEqual(dropped.body, { sha: action.chainASha, current: 'chain' })
  assert.equal(git(action.repo, ['rev-parse', 'refs/heads/chain^']), action.mainSha)
  assert.notEqual(git(action.repo, ['rev-parse', 'refs/heads/chain']), action.chainBSha)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
  assert.equal(await readFile(join(action.repo, 'chain-b.txt'), 'utf8'), 'b\n')
  await assert.rejects(readFile(join(action.repo, 'chain-a.txt'), 'utf8'))

  const chainHead = git(action.repo, ['rev-parse', 'HEAD'])
  const chainParent = git(action.repo, ['rev-parse', 'HEAD^'])
  const headDrop = await postCommitOp(action.handlers.commitOp, { ...body, action: 'drop', sha: chainHead })
  assert.equal(headDrop.status, 200)
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), chainParent)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')

  git(action.repo, ['checkout', '-qb', 'drop-conflict', action.baseSha])
  writeFileSync(join(action.repo, 'base.txt'), 'd1\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'd1'])
  const d1 = git(action.repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(action.repo, 'base.txt'), 'd2\n')
  git(action.repo, ['add', '-A'])
  git(action.repo, ['commit', '-qm', 'd2'])
  const d2 = git(action.repo, ['rev-parse', 'HEAD'])
  const conflict = await postCommitOp(action.handlers.commitOp, { ...body, action: 'drop', sha: d1 })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'commit-conflict')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), d2)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
  let rebaseHead = ''
  try {
    rebaseHead = git(action.repo, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'])
  } catch {
    // The abort removed the in-progress rebase.
  }
  assert.equal(rebaseHead, '')
})

test('commit actions merge and rebase onto one commit', async () => {
  const merged = buildCommitFixture('commit-merge')
  const mergedBody = { sessionId: merged.sessionId, repo: realpathSync(merged.repo) }
  const merge = await postCommitOp(merged.handlers.commitOp, {
    ...mergedBody, action: 'merge', sha: merged.sideSha,
  })
  assert.equal(merge.status, 200)
  assert.deepEqual(merge.body, { sha: merged.sideSha, current: 'main', result: 'merged' })
  assert.equal(git(merged.repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3)

  const rebased = buildCommitFixture('commit-rebase')
  const rebasedBody = { sessionId: rebased.sessionId, repo: realpathSync(rebased.repo) }
  const rebase = await postCommitOp(rebased.handlers.commitOp, {
    ...rebasedBody, action: 'rebase', sha: rebased.sideSha,
  })
  assert.equal(rebase.status, 200)
  assert.deepEqual(rebase.body, { sha: rebased.sideSha, current: 'main' })
  assert.equal(git(rebased.repo, ['rev-parse', 'HEAD^']), rebased.sideSha)
  assert.equal(git(rebased.repo, ['status', '--porcelain']), '')
})

test('commit actions merge and rebase abort a conflict', async () => {
  const action = buildCommitFixture('commit-merge-conflict')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const before = git(action.repo, ['rev-parse', 'HEAD'])

  const merge = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'merge', sha: action.conflictSha,
  })
  assert.equal(merge.status, 409)
  assert.equal(merge.body.error.code, 'merge-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), before)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')

  const rebase = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'rebase', sha: action.conflictSha,
  })
  assert.equal(rebase.status, 409)
  assert.equal(rebase.body.error.code, 'rebase-blocked')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), before)
  assert.equal(git(action.repo, ['status', '--porcelain']), '')
})

test('commit reset moves the branch and resets the index and tree by mode', async () => {
  const action = buildCommitFixture('commit-reset')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }

  const soft = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'reset', sha: action.baseSha, mode: 'soft',
  })
  assert.equal(soft.status, 200)
  assert.deepEqual(soft.body, { sha: action.baseSha, current: 'main', mode: 'soft' })
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.baseSha)
  assert.match(git(action.repo, ['status', '--porcelain']), /^A  main\.txt$/mu)

  const mixed = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'reset', sha: action.baseSha, mode: 'mixed',
  })
  assert.equal(mixed.status, 200)
  assert.equal(git(action.repo, ['diff', '--cached', '--name-only']), '')
  assert.match(git(action.repo, ['status', '--porcelain']), /^M base\.txt$/mu)
  assert.match(git(action.repo, ['status', '--porcelain']), /^\?\? main\.txt$/mu)

  const hard = await postCommitOp(action.handlers.commitOp, {
    ...body, action: 'reset', sha: action.baseSha, mode: 'hard',
  })
  assert.equal(hard.status, 200)
  assert.equal(git(action.repo, ['status', '--porcelain']), '?? main.txt')
  assert.equal(git(action.repo, ['rev-parse', 'HEAD']), action.baseSha)
  assert.equal(await readFile(join(action.repo, 'main.txt'), 'utf8'), 'main\n')
  assert.equal(await readFile(join(action.repo, 'base.txt'), 'utf8'), 'base\n')
})

test('commit actions accept only valid actions, commits, names, and modes', async () => {
  const action = buildCommitFixture('commit-request')
  const body = { sessionId: action.sessionId, repo: realpathSync(action.repo) }
  const refsBefore = git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)'])

  const cases = [
    [await postCommitOp(action.handlers.commitOp, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: 'x' }, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: 'x' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postCommitOp(action.handlers.commitOp, '{not json'), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, [body]), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, body), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'unknown', sha: action.mainSha }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', name: 'x' }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: 'not-hex', name: 'x' }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: '-x' }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: 'x', message: 3 }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'branch', sha: action.mainSha }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'reset', sha: action.mainSha }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'reset', sha: action.mainSha, mode: 'keep' }), 400, 'bad-request'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: 'x', sessionId: 's-missing' }), 409, 'no-session'],
    [await postCommitOp(action.handlers.commitOp, { ...body, action: 'tag', sha: action.mainSha, name: 'x', repo: plainPath }), 400, 'not-a-repo'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(action.repo, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore)
})

// Sync ----------------------------------------------------------------------

/**
 * Build one bare remote with two clones of `main`: `local` is the repository
 * the panel syncs, `peer` stands for everyone else pushing to the remote.
 * @param {string} name - scratch subdirectory.
 * @returns {{ remote: string, local: string, peer: string, sessionId: string, handlers: object }} the fixture.
 */
function buildSyncFixture(name) {
  const base = join(fixture.scratch, name)
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  mkdirSync(base, { recursive: true })
  git(base, ['init', '-q', '--bare', '-b', 'main', remote])
  initRepo(seed)
  writeFileSync(join(seed, 'file.txt'), 'base\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-qm', 'base'])
  git(seed, ['push', '-q', remote, 'main'])

  const clone = target => {
    git(base, ['clone', '-q', remote, target])
    git(target, ['config', 'user.email', 'test@example.com'])
    git(target, ['config', 'user.name', 'Test User'])
    git(target, ['config', 'commit.gpgsign', 'false'])
    return target
  }
  const local = clone(join(base, 'local'))
  const peer = clone(join(base, 'peer'))
  const sessionId = `s-sync-${name}`
  const syncSessions = new Map([[sessionId, { header: { cwd: local } }]])
  const syncHandlers = createHandlers(createHost({ sessions: { get: id => syncSessions.get(id) } }))
  return { remote, local, peer, sessionId, handlers: syncHandlers }
}

/** Commit one line to `file` in a clone. */
function commitLine(repo, file, text) {
  writeFileSync(join(repo, file), text)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', `edit ${file}`])
}

/**
 * POST one sync request.
 * @param {Function} handler - the sync handler.
 * @param {unknown} body - JSON body, or a raw string.
 * @param {Record<string, string>} [headers] - request headers.
 * @param {string} [method] - HTTP method.
 */
async function postSync(handler, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const response = await handler(new Request('http://127.0.0.1/api/vcs.sync', {
    method,
    headers,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  return { status: response.status, body: await response.json() }
}

test('sync pushes commits the upstream lacks, then fast-forwards commits it gained, then reports level', async () => {
  const sync = buildSyncFixture('sync-flow')
  const repoPath = realpathSync(sync.local)
  const body = { sessionId: sync.sessionId, repo: repoPath }

  commitLine(sync.local, 'file.txt', 'base\nlocal\n')
  const localHead = git(sync.local, ['rev-parse', 'HEAD'])
  const pushed = await postSync(sync.handlers.sync, body)
  assert.equal(pushed.status, 200)
  assert.deepEqual(pushed.body, { upstream: 'origin/main', pulled: 0, pushed: 1 })
  assert.equal(git(sync.remote, ['rev-parse', 'main']), localHead)

  git(sync.peer, ['pull', '-q', '--ff-only'])
  commitLine(sync.peer, 'other.txt', 'peer\n')
  commitLine(sync.peer, 'other.txt', 'peer\nagain\n')
  git(sync.peer, ['push', '-q', 'origin', 'main'])
  const peerHead = git(sync.peer, ['rev-parse', 'HEAD'])
  // An unrelated working-tree edit rides along a fast-forward untouched.
  writeFileSync(join(sync.local, 'file.txt'), 'base\nlocal\nuncommitted\n')
  const pulled = await postSync(sync.handlers.sync, body)
  assert.equal(pulled.status, 200)
  assert.deepEqual(pulled.body, { upstream: 'origin/main', pulled: 2, pushed: 0 })
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), peerHead)
  assert.equal(await readFile(join(sync.local, 'file.txt'), 'utf8'), 'base\nlocal\nuncommitted\n')

  const level = await postSync(sync.handlers.sync, body)
  assert.equal(level.status, 200)
  assert.deepEqual(level.body, { upstream: 'origin/main', pulled: 0, pushed: 0 })
  assert.equal(git(sync.remote, ['rev-parse', 'main']), peerHead)
})

test('sync leaves a diverged branch and a blocked fast-forward exactly as they were', async () => {
  const sync = buildSyncFixture('sync-refuse')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }

  commitLine(sync.peer, 'file.txt', 'base\npeer\n')
  git(sync.peer, ['push', '-q', 'origin', 'main'])
  const remoteHead = git(sync.remote, ['rev-parse', 'main'])

  // Behind only, but the incoming change touches a file edited locally.
  writeFileSync(join(sync.local, 'file.txt'), 'base\nmine\n')
  const localHead = git(sync.local, ['rev-parse', 'HEAD'])
  const blocked = await postSync(sync.handlers.sync, body)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'pull-blocked')
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), localHead)
  assert.equal(await readFile(join(sync.local, 'file.txt'), 'utf8'), 'base\nmine\n')

  // Ahead and behind: nothing merges, rebases, or pushes.
  git(sync.local, ['checkout', '-q', '--', 'file.txt'])
  commitLine(sync.local, 'local.txt', 'local\n')
  const divergedHead = git(sync.local, ['rev-parse', 'HEAD'])
  const diverged = await postSync(sync.handlers.sync, body)
  assert.equal(diverged.status, 409)
  assert.equal(diverged.body.error.code, 'diverged')
  assert.equal(git(sync.local, ['rev-parse', 'HEAD']), divergedHead)
  assert.equal(git(sync.remote, ['rev-parse', 'main']), remoteHead)
})

test('sync reports a push or fetch the remote refused without moving either side', async () => {
  // A remote hook declining the update.
  const declined = buildSyncFixture('sync-declined')
  writeFileSync(join(declined.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected" >&2\nexit 1\n', { mode: 0o755 })
  commitLine(declined.local, 'local.txt', 'local\n')
  const before = git(declined.remote, ['rev-parse', 'main'])
  const refused = await postSync(declined.handlers.sync, { sessionId: declined.sessionId, repo: realpathSync(declined.local) })
  assert.equal(refused.status, 502)
  assert.equal(refused.body.error.code, 'remote-failed')
  assert.equal(git(declined.remote, ['rev-parse', 'main']), before)

  // A remote that cannot be reached fails the fetch the same way.
  git(declined.local, ['remote', 'set-url', 'origin', join(fixture.scratch, 'missing-remote.git')])
  const unreachable = await postSync(declined.handlers.sync, { sessionId: declined.sessionId, repo: realpathSync(declined.local) })
  assert.equal(unreachable.status, 502)
  assert.equal(unreachable.body.error.code, 'remote-failed')
  assert.equal(JSON.stringify(unreachable.body).includes(fixture.scratch), false)
})

test('sync needs a checked-out branch with an upstream', async () => {
  const sync = buildSyncFixture('sync-upstream')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }

  git(sync.local, ['checkout', '-qb', 'topic'])
  commitLine(sync.local, 'topic.txt', 'topic\n')
  const untracked = await postSync(sync.handlers.sync, body)
  assert.equal(untracked.status, 409)
  assert.equal(untracked.body.error.code, 'no-upstream')
  assert.equal(git(sync.remote, ['branch', '--list', 'topic']), '')

  git(sync.local, ['checkout', '-q', '--detach'])
  const detached = await postSync(sync.handlers.sync, body)
  assert.equal(detached.status, 409)
  assert.equal(detached.body.error.code, 'no-upstream')
})

test('sync accepts only same-origin JSON POSTs for a discovered repository it can sync', async () => {
  const sync = buildSyncFixture('sync-request')
  const body = { sessionId: sync.sessionId, repo: realpathSync(sync.local) }
  commitLine(sync.local, 'local.txt', 'local\n')
  const remoteHead = git(sync.remote, ['rev-parse', 'main'])

  const cases = [
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json' }, 'GET'), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'text/plain' }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/x-www-form-urlencoded' }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
    [await postSync(sync.handlers.sync, body, { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }), 403, 'forbidden'],
    [await postSync(sync.handlers.sync, '{not json'), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, [body]), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, { sessionId: sync.sessionId }), 400, 'bad-request'],
    [await postSync(sync.handlers.sync, { ...body, sessionId: 's-missing' }), 409, 'no-session'],
    [await postSync(sync.handlers.sync, { ...body, repo: plainPath }), 400, 'not-a-repo'],
  ]
  for (const [answer, status, code] of cases) {
    assert.equal(answer.status, status, code)
    assert.equal(answer.body.error.code, code)
  }
  assert.equal(git(sync.remote, ['rev-parse', 'main']), remoteHead)

  const accepted = await postSync(sync.handlers.sync, body, {
    'content-type': 'application/json; charset=utf-8',
    'sec-fetch-site': 'same-origin',
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.pushed, 1)
})

test('sync is refused for a backend without the capability', { skip: !HAS_JJ }, async () => {
  const before = jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1'])
  const answer = await postSync(handlers.sync, { sessionId: 's-jj', repo: jjPath })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error.code, 'bad-request')
  assert.equal(jj(fixture.jj, ['op', 'log', '--no-graph', '-T', 'id', '--limit', '1']), before)
})

test('a second sync of the same repository is refused while the first runs', async () => {
  const { createBackends } = await import('../lib/vcs/index.js')
  const host = createHost()
  const real = createBackends(host)
  let release
  let started = 0
  const gate = new Promise(resolve => { release = resolve })
  const gated = Object.create(real.get('git'))
  gated.sync = async () => {
    started += 1
    await gate
    return { upstream: 'origin/main', pulled: 0, pushed: 0 }
  }
  const gatedHandlers = createHandlers(host, {
    backends: { get: id => (id === 'git' ? gated : real.get(id)), list: () => real.list() },
  })
  const body = { sessionId: 's-main', repo: mainPath }

  const first = postSync(gatedHandlers.sync, body)
  while (started === 0) await new Promise(resolve => { setTimeout(resolve, 5) })
  const second = await postSync(gatedHandlers.sync, body)
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'busy')
  release()
  assert.equal((await first).status, 200)

  // The lock is released with the answer, so the next sync runs.
  const third = await postSync(gatedHandlers.sync, body)
  assert.equal(third.status, 200)
  assert.equal(started, 2)
})

test('sync diagnostics keep the last stderr lines and drop URL credentials', async () => {
  const { redactDetail } = await import('../lib/git-utils.js')
  assert.equal(
    redactDetail('hint: one\n\nfatal: unable to access \'https://user:token@example.com/repo.git/\'\nfatal: two\nfatal: three\n'),
    "fatal: unable to access 'https://***@example.com/repo.git/' | fatal: two | fatal: three",
  )
  assert.equal(redactDetail(''), '')
})
