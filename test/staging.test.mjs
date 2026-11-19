import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { createHandlers } from '../index.js'

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }

function canonical(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error.code !== 'ENOENT' && error.code !== 'ENOTDIR') || dirname(path) === path) throw error
    return join(canonical(dirname(path)), basename(path))
  }
}

function fixture(t, { unborn = false, objectFormat = 'sha1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vcs-staging-')))
  t.after(() => rmSync(root, { recursive: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main', `--object-format=${objectFormat}`)
  git('config', 'user.name', 'Staging Test')
  git('config', 'user.email', 'test@example.com')
  const path = 'test file "quoted".txt'
  const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`)
  const write = (name, text) => writeFileSync(join(root, name), text)
  const read = name => readFileSync(join(root, name), 'utf8')
  if (!unborn) {
    write(path, original.join(''))
    git('add', '--', path)
    git('commit', '-qm', 'Base')
  }

  let beforeSpawn
  const ctx = {
    sessions: { get: id => id === 'session' ? { header: { cwd: root } } : undefined },
    fs: {
      resolve: async path => ({ path: canonical(path) }),
      processPath: target => target.path,
      contains: (parent, child) => child.path === parent.path || child.path.startsWith(`${parent.path}${sep}`),
      listDir: async () => [],
      lstat: async path => lstatSync(path),
      stat: async ({ path }) => {
        const stat = lstatSync(path)
        return { type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size }
      },
      readBytes: async ({ path }) => readFileSync(path),
    },
    subprocess: {
      resolveExecutable: async command => command,
      spawn(spec) {
        let stdout = ''
        let stderr = ''
        const done = Promise.resolve(beforeSpawn?.(spec)).then(() => new Promise(resolve => {
          const [command, ...args] = spec.argv
          const child = execFile(command, args, {
            cwd: spec.cwd, env: { ...env, ...spec.env }, signal: spec.signal,
          }, (error, out, err) => {
            stdout = out
            stderr = err
            resolve({ exitCode: error === null ? 0 : error.code })
          })
          child.stdin.on('error', () => {})
          child.stdin.end(spec.stdio.stdin?.data)
        }))
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: stderr }) },
          },
        }
      },
    },
  }
  const handlers = createHandlers(ctx)
  const identify = { sessionId: 'session', repo: root, path }
  const diff = async (scope, target = {}) => {
    const query = new URLSearchParams({ ...identify, scope, ...target })
    const response = await handlers.diff(new Request(`http://localhost/api/vcs.diff?${query}`))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }
  const post = async (handler, route, payload, { headers = {}, expected = 200, query = '' } = {}) => {
    const response = await handler(new Request(`http://localhost/api/vcs.${route}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...identify, ...payload }),
    }))
    const body = await response.json()
    assert.equal(response.status, expected, JSON.stringify(body))
    return body
  }
  const status = async (target = {}) => {
    const query = new URLSearchParams({ ...identify, ...target })
    const response = await handlers.status(new Request(`http://localhost/api/vcs.status?${query}`))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }
  return {
    git, root, path, original, write, read, diff, status, ctx,
    stage: (scope, target, options) => post(handlers.stage, 'stage', { scope, ...target }, options),
    history: (action, id, target, options) => post(handlers.stageHistory, 'stage-history', { action, id, ...target }, options),
    switchBranch: branch => post(handlers.switchBranch, 'switch', { branch }),
    commitOp: (target, options) => post(handlers.commitOp, 'commit-op', target, options),
    beforeSpawn: hook => { beforeSpawn = hook },
    index: (name = path) => git('show', `:${name}`),
    indexNames: () => git('ls-files', '-z').split('\0').filter(Boolean),
  }
}

function select(diff, ...texts) {
  return texts.map(text => {
    const hunk = diff.hunks.findIndex(item => item.lines.includes(text))
    assert.notEqual(hunk, -1, text)
    return { hunk, line: diff.hunks[hunk].lines.indexOf(text) }
  })
}

test('stages arbitrary lines across hunks and unstages an independent selection', async t => {
  const f = fixture(t)
  const working = [...f.original]
  working.splice(16, 1, 'replaced 17\n')
  working.splice(1, 1, 'replaced 2\n', 'new extra\n')
  const content = working.join('')
  f.write(f.path, content)
  const unstaged = await f.diff('unstaged')
  assert.equal(unstaged.lineStaging, true)
  assert.equal(unstaged.hunks.length, 2)
  assert.deepEqual(await f.stage('unstaged', {
    fingerprint: unstaged.fingerprint, lines: select(unstaged, '+new extra', '-line 17', '+replaced 17'),
  }), { scope: 'unstaged', path: f.path })
  const indexed = [...f.original]
  indexed.splice(16, 1, 'replaced 17\n')
  indexed.splice(2, 0, 'new extra\n')
  assert.equal(f.index(), indexed.join(''))
  assert.equal(f.read(f.path), content)

  const staged = await f.diff('staged')
  await f.stage('staged', { fingerprint: staged.fingerprint, lines: select(staged, '+new extra', '-line 17') })
  const remaining = [...f.original]
  remaining.splice(17, 0, 'replaced 17\n')
  assert.equal(f.index(), remaining.join(''))
  assert.equal(f.read(f.path), content)
  assert.equal(f.git('show', `HEAD:${f.path}`), f.original.join(''))
})

test('line staging supports untracked executable text and preserves the selected end-of-file state', async t => {
  const f = fixture(t)
  const path = ':odd café.sh'
  f.write(path, 'first\nsecond\nlast')
  chmodSync(join(f.root, path), 0o755)
  const diff = await f.diff('untracked', { path })
  assert.equal(diff.lineStaging, true)
  await f.stage('untracked', { path, fingerprint: diff.fingerprint, lines: select(diff, '+first', '+last') })
  assert.equal(f.index(path), 'first\nlast')
  assert.match(f.git('ls-files', '-s', '--', `:(literal)${path}`), /^100755 /u)
  assert.equal(f.read(path), 'first\nsecond\nlast')

  let staged = await f.diff('staged', { path })
  await f.stage('staged', { path, fingerprint: staged.fingerprint, lines: select(staged, '+first') })
  assert.equal(f.index(path), 'last')
  staged = await f.diff('staged', { path })
  await f.stage('staged', { path, fingerprint: staged.fingerprint, lines: select(staged, '+last') })
  assert(!f.indexNames().includes(path))
  assert.equal(f.read(path), 'first\nsecond\nlast')
})

test('partial staging respects core.fileMode for untracked executables', async t => {
  const f = fixture(t)
  const path = 'program.sh'
  f.git('config', 'core.fileMode', 'false')
  f.write(path, 'first\nsecond\n')
  chmodSync(join(f.root, path), 0o755)
  const diff = await f.diff('untracked', { path })
  await f.stage('untracked', { path, fingerprint: diff.fingerprint, lines: select(diff, '+second') })
  assert.equal(f.index(path), 'second\n')
  assert.match(f.git('ls-files', '-s', '--', path), /^100644 /u)
})

test('partial and complete deletion operate on the index, and selected lines can restore a staged deletion', async t => {
  const f = fixture(t)
  rmSync(join(f.root, f.path))
  let diff = await f.diff('unstaged')
  await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: select(diff, '-line 2') })
  const remaining = f.original.filter(line => line !== 'line 2\n')
  assert.equal(f.index(), remaining.join(''))
  diff = await f.diff('unstaged')
  await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: select(diff, ...remaining.map(line => `-${line.trimEnd()}`)) })
  assert(!f.indexNames().includes(f.path))
  diff = await f.diff('staged')
  await f.stage('staged', { fingerprint: diff.fingerprint, lines: select(diff, '-line 7', '-line 16') })
  assert.equal(f.index(), 'line 7\nline 16\n')
  assert.throws(() => f.read(f.path), { code: 'ENOENT' })
})

test('whole-file staging follows both paths of a worktree rename reported by Git', async t => {
  const f = fixture(t)
  const path = 'renamed.txt'
  f.write(path, f.original.join(''))
  rmSync(join(f.root, f.path))
  f.git('add', '-N', '--', path)
  assert.match(f.git('status', '--porcelain=v2'), /^2 \.R /mu)
  await f.stage('unstaged', { path, oldPath: f.path })
  assert.deepEqual(f.indexNames(), [path])
  assert.equal(f.index(path), f.original.join(''))
  assert.equal(f.read(path), f.original.join(''))
})

test('staging does not execute a post-index-change hook', async t => {
  const f = fixture(t)
  const hook = join(f.root, '.git', 'hooks', 'post-index-change')
  writeFileSync(hook, '#!/bin/sh\nprintf "hook ran" > hook-output\n', { mode: 0o755 })
  f.write(f.path, 'new\n')
  const diff = await f.diff('unstaged')
  await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: select(diff, '+new') })
  assert.throws(() => f.read('hook-output'), { code: 'ENOENT' })
  await f.stage('staged')
  assert.throws(() => f.read('hook-output'), { code: 'ENOENT' })
})

test('whole-file writes follow literal paths, stage binaries and deletions, and unstage Git renames', async t => {
  const f = fixture(t)
  const old = f.path
  const path = 'renamed.txt'
  f.git('mv', '--', old, path)
  f.write(path, `working change\n${f.original.join('')}`)
  const rename = await f.diff('staged', { path, oldPath: old })
  assert.equal(rename.lineStaging, undefined)
  const forged = await f.stage('staged', { path, oldPath: 'unrelated' }, { expected: 409 })
  assert.equal(forged.error.code, 'stale-diff')
  await f.stage('staged', { path, oldPath: old })
  assert.deepEqual(f.indexNames(), [old])
  assert.equal(f.index(old), f.original.join(''))
  assert.equal(f.read(path), `working change\n${f.original.join('')}`)

  const binary = ':bin*.dat'
  f.write(binary, Buffer.from([0, 1, 2]))
  f.write(':bin123.dat', 'other')
  assert.equal((await f.diff('untracked', { path: binary })).kind, 'binary')
  await f.stage('untracked', { path: binary })
  await f.stage('unstaged', { path: old })
  assert.deepEqual(f.indexNames(), [binary])
  assert.deepEqual(readFileSync(join(f.root, binary)), Buffer.from([0, 1, 2]))
})

for (const objectFormat of ['sha1', 'sha256']) {
  test(`whole-file unstage works on unborn ${objectFormat} branches`, async t => {
    const f = fixture(t, { unborn: true, objectFormat })
    f.write(f.path, 'new\n')
    await f.stage('untracked')
    assert.equal(f.index(), 'new\n')
    await f.stage('staged')
    assert.deepEqual(f.indexNames(), [])
    assert.equal(f.read(f.path), 'new\n')
  })
}

test('rejects stale, malformed, unsupported, and out-of-scope staging requests without changing the index', async t => {
  const f = fixture(t)
  f.write(f.path, `new\n${f.original.join('')}`)
  const diff = await f.diff('unstaged')
  const lines = select(diff, '+new')
  assert.equal((await f.stage('unstaged', { lines }, { expected: 400 })).error.code, 'bad-request')
  for (const selection of [[lines[0], lines[0]], [{ hunk: 0, line: 1 }], [{ hunk: 12, line: 0 }]]) {
    assert.equal((await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: selection }, { expected: 400 })).error.code, 'bad-request')
  }
  f.write(f.path, `different\n${f.original.join('')}`)
  assert.equal((await f.stage('unstaged', { fingerprint: diff.fingerprint, lines }, { expected: 409 })).error.code, 'stale-diff')
  assert.equal((await f.stage('unstaged', { worktree: f.root }, { expected: 403 })).error.code, 'forbidden')
  assert.equal((await f.stage('unstaged', {}, { expected: 403, headers: { 'sec-fetch-site': 'cross-site' } })).error.code, 'forbidden')
  assert.equal((await f.stage('unstaged', { repo: dirname(f.root) }, { expected: 400 })).error.code, 'not-a-repo')
  mkdirSync(join(f.root, 'dir'))
  f.write('dir/child.txt', 'other')
  assert.equal((await f.stage('untracked', { path: 'dir' }, { expected: 409 })).error.code, 'stale-diff')
  assert.equal(f.index(), f.original.join(''))
  assert.deepEqual(f.indexNames(), [f.path])
})

test('metadata and conflicts are excluded from line staging, while symlinks can be staged whole', async t => {
  const f = fixture(t)
  symlinkSync(f.path, join(f.root, 'link'))
  assert.equal((await f.diff('untracked', { path: 'link' })).lineStaging, undefined)
  await f.stage('untracked', { path: 'link' })
  assert.match(f.git('ls-files', '-s', '--', 'link'), /^120000 /u)
  assert.equal((await f.diff('staged', { path: 'link' })).lineStaging, undefined)
  await f.stage('staged', { path: 'link' })
  chmodSync(join(f.root, f.path), 0o755)
  f.write(f.path, 'changed\n')
  const modeChange = await f.diff('unstaged')
  assert.equal(modeChange.lineStaging, undefined)
  await f.stage('unstaged')
  assert.match(f.git('ls-files', '-s', '--', f.path), /^100755 /u)

  f.git('commit', '-qm', 'Current')
  f.git('branch', 'other', 'HEAD^')
  f.git('checkout', '-q', 'other')
  f.write(f.path, 'other\n')
  f.git('commit', '-qam', 'Other')
  f.git('checkout', '-q', 'main')
  assert.throws(() => f.git('merge', 'other'))
  const conflictIndex = f.git('ls-files', '-s')
  assert.equal((await f.stage('unstaged', {}, { expected: 409 })).error.code, 'staging-unsupported')
  assert.equal((await f.stage('staged', {}, { expected: 409 })).error.code, 'staging-unsupported')
  assert.equal(f.git('ls-files', '-s'), conflictIndex)
})

test('line staging holds the real index lock through scratch patch application', async t => {
  const f = fixture(t)
  const working = `selected\n${f.original.join('')}`
  f.write(f.path, working)
  const diff = await f.diff('unstaged')
  let attempts = 0
  f.beforeSpawn(({ argv, env }) => {
    if (!argv.includes('apply')) return
    attempts += 1
    assert.notEqual(env.GIT_INDEX_FILE, join(f.root, '.git', 'index'))
    assert.throws(() => f.git('add', '--', f.path), /index\.lock/u)
    assert.equal(f.index(), f.original.join(''))
  })
  await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: select(diff, '+selected') })
  assert.equal(attempts, 1)
  assert.equal(f.index(), working)
  assert.equal(f.read(f.path), working)
  assertIndexClean(f)
})

test('whole-file unstage keeps external Git writers out while reading HEAD', async t => {
  const f = fixture(t)
  f.write(f.path, 'indexed\n')
  f.git('add', '--', f.path)
  f.write(f.path, 'worktree\n')
  let attempts = 0
  f.beforeSpawn(({ argv }) => {
    if (!argv.includes('ls-tree')) return
    attempts += 1
    assert.throws(() => f.git('add', '--', f.path), /index\.lock/u)
    assert.equal(f.index(), 'indexed\n')
  })
  await f.stage('staged')
  assert.equal(attempts, 1)
  assert.equal(f.index(), f.original.join(''))
  assert.equal(f.read(f.path), 'worktree\n')
  assertIndexClean(f)
})

test('a staged rename permits line staging its separate worktree modification', async t => {
  const f = fixture(t)
  const path = 'renamed.txt'
  f.git('mv', '--', f.path, path)
  f.write(path, `new worktree line\n${f.original.join('')}`)
  const diff = await f.diff('unstaged', { path })
  assert.equal(diff.lineStaging, true)
  await f.stage('unstaged', { path, fingerprint: diff.fingerprint, lines: select(diff, '+new worktree line') })
  assert.deepEqual(f.indexNames(), [path])
  assert.equal(f.index(path), `new worktree line\n${f.original.join('')}`)
})

test('staging shares the repository write lock with other mutations', async t => {
  const f = fixture(t)
  f.write(f.path, 'first\n')
  let entered
  let release
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.beforeSpawn(async ({ argv }) => {
    if (argv.includes('update-index')) {
      entered()
      await gate
    }
  })
  const pending = f.stage('unstaged')
  await waiting
  try {
    assert.equal((await f.stage('unstaged', {}, { expected: 409 })).error.code, 'busy')
  } finally {
    release()
  }
  await pending
  assert.equal(f.index(), 'first\n')
})


function assertIndexClean(f, dir = join(f.root, '.git')) {
  assert(!readdirSync(dir).some(name => name === 'index.lock' || name.startsWith('dsh-vcs-index-')))
}

const EMPTY_HISTORY = { undo: null, redo: null }

test('undo and redo only restore changed entries and use a new branch after staging', async t => {
  const f = fixture(t)
  const head = f.git('rev-parse', 'HEAD')
  const work = `staged line\n${f.original.join('')}worktree line\n`
  f.write(f.path, work)
  const diff = await f.diff('unstaged')
  await f.stage('unstaged', { fingerprint: diff.fingerprint, lines: select(diff, '+staged line') })
  const { undo: first, redo } = (await f.status()).stageHistory
  assert.equal(redo, null)
  assert.deepEqual(first, { id: first.id, scope: 'unstaged', path: f.path, lineCount: 1 })
  f.write('unrelated', 'external stage\n')
  f.git('add', '--', 'unrelated')
  f.git('update-index', '--assume-unchanged', '--', 'unrelated')
  const unrelated = f.git('ls-files', '-v', '--stage', '--', 'unrelated')
  let lockAttempts = 0
  f.beforeSpawn(({ argv }) => {
    if (!argv.includes('--index-info')) return
    lockAttempts += 1
    assert.throws(() => f.git('add', '--', f.path), /index\.lock/u)
  })
  assert.deepEqual(await f.history('undo', first.id), { action: 'undo', stageHistory: { undo: null, redo: first } })
  assert.equal(f.index(), f.original.join(''))
  assert.equal(f.read(f.path), work)
  assert.equal(f.git('ls-files', '-v', '--stage', '--', 'unrelated'), unrelated)
  assert.deepEqual(await f.history('redo', first.id), { action: 'redo', stageHistory: { undo: first, redo: null } })
  assert.equal(f.index(), `staged line\n${f.original.join('')}`)
  await f.history('undo', first.id)
  assert.equal(lockAttempts, 3)
  f.beforeSpawn(undefined)
  assert.equal((await f.stage('staged', {}, { expected: 409 })).error.code, 'stale-diff')
  assert.equal((await f.status()).stageHistory.redo.id, first.id)
  await f.stage('unstaged')
  const branch = (await f.status()).stageHistory
  assert.notEqual(branch.undo.id, first.id)
  assert.equal(branch.redo, null)
  assert.equal((await f.history('redo', first.id, {}, { expected: 409 })).error.code, 'stage-history-unavailable')
  assert.equal(f.index(), work)
  assert.equal(f.read(f.path), work)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.git('ls-files', '-v', '--stage', '--', 'unrelated'), unrelated)
  assertIndexClean(f)
})

test('stale affected paths keep the cursor and a successful stage starts a new chain', async t => {
  const f = fixture(t)
  f.write(f.path, 'panel\n')
  await f.stage('unstaged')
  const old = (await f.status()).stageHistory.undo
  f.write(f.path, 'external staging\n')
  f.git('add', '--', f.path)
  const bytes = readFileSync(join(f.root, '.git', 'index'))
  assert.equal((await f.history('undo', old.id, {}, { expected: 409 })).error.code, 'stage-history-stale')
  assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), bytes)
  assert.equal((await f.status()).stageHistory.undo.id, old.id)
  f.write('new', 'new panel change\n')
  await f.stage('untracked', { path: 'new' })
  const fresh = (await f.status()).stageHistory.undo
  assert.deepEqual((await f.history('undo', fresh.id)).stageHistory, { undo: null, redo: fresh })
  assert.equal(f.index(), 'external staging\n')
  assert.equal(f.read('new'), 'new panel change\n')
  assertIndexClean(f)
})

test('undo and redo restore both legs of a staged rename', async t => {
  const f = fixture(t)
  const path = 'renamed.txt'
  f.git('mv', '--', f.path, path)
  await f.stage('staged', { path, oldPath: f.path })
  const entry = (await f.status()).stageHistory.undo
  assert.deepEqual(f.indexNames(), [f.path])
  await f.history('undo', entry.id)
  assert.deepEqual(f.indexNames(), [path])
  assert.equal(f.index(path), f.original.join(''))
  assert.equal(f.read(path), f.original.join(''))
  assert.throws(() => f.read(f.path), { code: 'ENOENT' })
  await f.history('redo', entry.id)
  assert.deepEqual(f.indexNames(), [f.path])
  assertIndexClean(f)
})

test('a folder or group write stages tracked, deleted, and untracked files in one undoable step', async t => {
  const f = fixture(t)
  const files = (...paths) => ({ path: undefined, files: paths.map(path => ({ path })) })
  mkdirSync(join(f.root, 'src'))
  f.write('src/a.txt', 'a\n')
  f.write('src/b.txt', 'b\n')
  f.write('.gitignore', '*.log\n')
  f.git('add', '--', 'src', '.gitignore')
  f.git('commit', '-qm', 'Folder')
  const head = f.git('ls-files', '--stage')
  f.write(f.path, 'outside the folder\n')
  f.write('src/a.txt', 'a changed\n')
  rmSync(join(f.root, 'src/b.txt'))
  f.write('src/new.txt', 'new\n')
  mkdirSync(join(f.root, 'notes/deep'), { recursive: true })
  f.write('notes/x.txt', 'x\n')
  f.write('notes/deep/y.txt', 'y\n')
  f.write('notes/skip.log', 'ignored\n')

  assert.deepEqual(await f.stage('unstaged', files('src/a.txt', 'src/b.txt', 'src/new.txt')),
    { scope: 'unstaged', path: 'src/', fileCount: 3 })
  assert.equal(f.index('src/a.txt'), 'a changed\n')
  assert.equal(f.index('src/new.txt'), 'new\n')
  assert.ok(!f.indexNames().includes('src/b.txt'))
  assert.equal(f.index(), f.original.join(''), 'files outside the request keep their index entries')
  assert.deepEqual(await f.stage('unstaged', files('notes/')), { scope: 'unstaged', path: 'notes/', fileCount: 2 })
  assert.deepEqual(f.indexNames().filter(name => name.startsWith('notes/')), ['notes/deep/y.txt', 'notes/x.txt'])
  assert.equal(f.read('notes/skip.log'), 'ignored\n')

  const { undo: folder } = (await f.status()).stageHistory
  assert.deepEqual(folder, { id: folder.id, scope: 'unstaged', path: 'notes/', fileCount: 2 })
  await f.history('undo', folder.id)
  assert.ok(!f.indexNames().some(name => name.startsWith('notes/')), 'one undo removes every file of the folder')
  const { undo: group } = (await f.status()).stageHistory
  await f.history('undo', group.id)
  assert.equal(f.git('ls-files', '--stage'), head)
  await f.history('redo', group.id)
  await f.history('redo', folder.id)

  assert.deepEqual(await f.stage('staged', files('notes/deep/y.txt', 'notes/x.txt', 'src/a.txt', 'src/b.txt', 'src/new.txt')),
    { scope: 'staged', path: '', fileCount: 5 })
  assert.equal(f.git('ls-files', '--stage'), head)
  assert.equal(f.read('src/a.txt'), 'a changed\n')
  assert.equal(f.read('notes/deep/y.txt'), 'y\n')
  assert.deepEqual(await f.stage('unstaged', files('src/new.txt')), { scope: 'unstaged', path: 'src/new.txt' })
  assertIndexClean(f)
})

test('folder and group writes reject malformed, stale, and unsupported files without changing the index', async t => {
  const f = fixture(t)
  const write = (scope, list, options) => f.stage(scope, { path: undefined, files: list }, options)
  const renamed = 'renamed.txt'
  f.git('mv', '--', f.path, renamed)
  f.write('other.txt', 'other\n')
  const index = f.git('ls-files', '--stage')
  const rejected = async (scope, list, code, status, extra = {}) => {
    const body = await f.stage(scope, { path: undefined, files: list, ...extra }, { expected: status })
    assert.equal(body.error.code, code, JSON.stringify({ scope, list, extra }))
    assert.equal(f.git('ls-files', '--stage'), index)
  }
  for (const [scope, list, extra] of [
    ['untracked', [{ path: 'other.txt' }]],
    ['unstaged', []],
    ['unstaged', 'other.txt'],
    ['unstaged', [{ path: 'other.txt' }], { path: 'other.txt' }],
    ['unstaged', [{ path: 'other.txt' }], { lines: [{ hunk: 0, line: 0 }] }],
    ['unstaged', [{ path: 'other.txt' }, { path: 'other.txt' }]],
    ['unstaged', [{ path: '../other.txt' }]],
    ['unstaged', [{ path: '/' }]],
    ['staged', [{ path: 'notes/' }]],
    ['staged', [{ path: renamed, oldPath: renamed }]],
    ['unstaged', [{ path: 'notes/', oldPath: 'other.txt' }]],
    ['unstaged', Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}` }))],
  ]) await rejected(scope, list, 'bad-request', 400, extra)

  await rejected('unstaged', [{ path: 'other.txt' }, { path: 'missing.txt' }], 'stale-diff', 409)
  await rejected('staged', [{ path: 'other.txt' }], 'stale-diff', 409)
  await rejected('staged', [{ path: renamed, oldPath: 'other.txt' }], 'stale-diff', 409)
  mkdirSync(join(f.root, 'empty'))
  f.write('empty/.keep.log', '')
  f.write('.gitignore', '*.log\n')
  await rejected('unstaged', [{ path: 'empty/' }], 'stale-diff', 409)
  mkdirSync(join(f.root, 'nested'))
  execFileSync('git', ['init', '-q'], { cwd: join(f.root, 'nested'), env })
  f.write('nested/inner.txt', 'inner\n')
  await rejected('unstaged', [{ path: 'nested/' }], 'staging-unsupported', 409)

  await write('staged', [{ path: renamed, oldPath: f.path }])
  assert.deepEqual(f.indexNames(), [f.path], 'unstaging a rename restores both of its paths')
  assertIndexClean(f)
})

test('replay in an unborn SHA-256 branch checks missing objects before publication', async t => {
  const f = fixture(t, { unborn: true, objectFormat: 'sha256' })
  f.write(f.path, 'new\n')
  await f.stage('untracked')
  const { undo } = (await f.status()).stageHistory
  const oid = f.git('rev-parse', `:${f.path}`).trim()
  const object = join(f.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
  await f.history('undo', undo.id)
  assert.deepEqual(f.indexNames(), [])
  const data = readFileSync(object)
  rmSync(object)
  assert.equal((await f.history('redo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-unavailable')
  assert.equal((await f.status()).stageHistory.redo.id, undo.id)
  assert.deepEqual(f.indexNames(), [])
  assert.equal(f.read(f.path), 'new\n')
  writeFileSync(object, data)
  await f.history('redo', undo.id)
  assert.equal(f.index(), 'new\n')
  assertIndexClean(f)
})

test('setup and write authorization, native lock contention, and operation state', async t => {
  const f = fixture(t)
  f.write(f.path, 'staged\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  assert.equal((await f.history('undo', undo.id, { worktree: f.root }, { expected: 403 })).error.code, 'forbidden')
  assert.equal((await f.history('undo', undo.id, {}, { expected: 403, query: '?worktree=other' })).error.code, 'forbidden')
  assert.equal((await f.history('undo', undo.id, {}, { headers: { 'sec-fetch-site': 'cross-site' }, expected: 403 })).error.code, 'forbidden')
  assert.equal((await f.history('undo', undo.id, { repo: dirname(f.root) }, { expected: 400 })).error.code, 'not-a-repo')
  assert.equal((await f.history('undo', undo.id, { sessionId: 'missing' }, { expected: 409 })).error.code, 'no-session')
  assert.equal((await f.history('anything', undo.id, {}, { expected: 400 })).error.code, 'bad-request')
  assert.equal((await f.history('undo', 'invalid', {}, { expected: 400 })).error.code, 'bad-request')
  const lock = join(f.root, '.git', 'index.lock')
  writeFileSync(lock, 'external writer')
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-busy')
  assert.equal(readFileSync(lock, 'utf8'), 'external writer')
  rmSync(lock)
  const head = join(f.root, '.git', 'MERGE_HEAD')
  writeFileSync(head, f.git('rev-parse', 'HEAD'))
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-unavailable')
  rmSync(head)
  assert.equal(f.index(), 'staged\n')
  assert.equal((await f.status()).stageHistory.undo.id, undo.id)
  await f.history('undo', undo.id)
  assertIndexClean(f)
})

test('same-commit symbolic HEAD changes are stale and actual panel writes clear history', async t => {
  const f = fixture(t)
  const head = f.git('rev-parse', 'HEAD').trim()
  f.git('branch', 'other')
  f.write(f.path, 'staged\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  await f.switchBranch('main')
  await f.commitOp({ action: 'tag', sha: head, name: 'only-a-tag' })
  await f.commitOp({ action: 'branch', sha: head, name: 'only-a-branch' })
  assert.equal((await f.status()).stageHistory.undo.id, undo.id)
  f.git('symbolic-ref', 'HEAD', 'refs/heads/other')
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-stale')
  assert.equal(f.index(), 'staged\n')
  f.git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await f.switchBranch('other')
  assert.deepEqual((await f.status()).stageHistory, EMPTY_HISTORY)
  const unrelated = 'new'
  f.write(unrelated, 'new\n')
  await f.stage('untracked', { path: unrelated })
  await f.commitOp({ action: 'reset', sha: head, mode: 'soft' })
  assert((await f.status()).stageHistory.undo)
  await f.commitOp({ action: 'reset', sha: head, mode: 'mixed' })
  assert.deepEqual((await f.status()).stageHistory, EMPTY_HISTORY)
  assert.equal(f.read(unrelated), 'new\n')
})

test('HEAD is rechecked after the scratch index is written and failures leave history retryable', async t => {
  const f = fixture(t)
  f.git('branch', 'other')
  f.write(f.path, 'staged\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  const index = join(f.root, '.git', 'index')
  const bytes = readFileSync(index)
  f.beforeSpawn(({ argv }) => {
    if (argv.includes('--index-info')) f.git('symbolic-ref', 'HEAD', 'refs/heads/other')
  })
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-stale')
  assert.deepEqual(readFileSync(index), bytes)
  assert.equal((await f.status()).stageHistory.undo.id, undo.id)
  f.beforeSpawn(undefined)
  f.git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await f.history('undo', undo.id)
  assertIndexClean(f)
})

test('a linked worktree uses its own reciprocal metadata and history is hidden in previews', async t => {
  const f = fixture(t)
  const linked = join(f.root, 'linked-checkout')
  f.git('worktree', 'add', '-qb', 'linked', linked)
  const originalSession = f.ctx.sessions.get
  f.ctx.sessions.get = id => id === 'linked' ? { header: { cwd: linked } } : originalSession(id)
  const target = { repo: linked, sessionId: 'linked' }
  writeFileSync(join(linked, f.path), 'linked staged\n')
  const mainIndex = readFileSync(join(f.root, '.git', 'index'))
  await f.stage('unstaged', target)
  const { undo } = (await f.status(target)).stageHistory
  assert.deepEqual((await f.status()).stageHistory, EMPTY_HISTORY)
  assert.deepEqual((await f.status({ worktree: linked })).stageHistory, EMPTY_HISTORY)
  assert.equal((await f.history('undo', undo.id, { repo: linked }, { expected: 400 })).error.code, 'not-a-repo')
  assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), mainIndex)
  await f.history('undo', undo.id, target)
  assert.equal(f.git('-C', linked, 'show', `:${f.path}`), f.original.join(''))
  assert.equal(readFileSync(join(linked, f.path), 'utf8'), 'linked staged\n')
  assertIndexClean(f, join(f.root, '.git', 'worktrees', 'linked-checkout'))
})


test('redo rejects an externally staged replacement for its affected path', async t => {
  const f = fixture(t)
  f.write(f.path, 'panel\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  await f.history('undo', undo.id)
  f.write(f.path, 'external index\n')
  f.git('add', '--', f.path)
  f.write(f.path, 'external worktree\n')
  const index = join(f.root, '.git', 'index')
  const bytes = readFileSync(index)
  assert.equal((await f.history('redo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-stale')
  assert.deepEqual(readFileSync(index), bytes)
  assert.deepEqual((await f.status()).stageHistory, { undo: null, redo: undo })
  assert.equal(f.index(), 'external index\n')
  assert.equal(f.read(f.path), 'external worktree\n')
  assertIndexClean(f)
})

test('intent-to-add staging creates a history boundary and preserves unrelated flags', async t => {
  const f = fixture(t)
  f.write(f.path, 'first\n')
  await f.stage('unstaged')
  assert((await f.status()).stageHistory.undo)
  f.write('intent', 'intent-to-add\n')
  f.write('untouched', 'unrelated intent-to-add\n')
  f.git('add', '-N', '--', 'intent', 'untouched')
  const flags = f.git('ls-files', '--debug', '--', 'untouched')
  await f.stage('unstaged', { path: 'intent' })
  assert.deepEqual((await f.status()).stageHistory, EMPTY_HISTORY)
  assert.equal(f.git('ls-files', '--debug', '--', 'untouched'), flags)
  assert.equal(f.index('intent'), 'intent-to-add\n')
  assertIndexClean(f)
})

test('unrelated merge conflicts allow ordinary staging and block history replay', async t => {
  const f = fixture(t)
  f.git('branch', 'other')
  f.write(f.path, 'main\n')
  f.git('commit', '-am', 'main change')
  f.git('switch', 'other')
  f.write(f.path, 'other\n')
  f.git('commit', '-am', 'other change')
  f.git('switch', 'main')
  f.write('first', 'first staged\n')
  await f.stage('untracked', { path: 'first' })
  const { undo } = (await f.status()).stageHistory
  f.git('reset', '--', 'first')
  assert.throws(() => f.git('merge', 'other'))
  const conflicts = f.git('ls-files', '-u')
  assert(conflicts)
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-unavailable')
  f.write('second', 'second staged\n')
  f.write('third', 'third\n')
  const batch = { path: undefined, files: [{ path: 'third' }, { path: f.path }] }
  assert.equal((await f.stage('unstaged', batch, { expected: 409 })).error.code, 'staging-unsupported')
  assert.equal(f.git('ls-files', '-u'), conflicts, 'a conflicted file blocks the whole folder write')
  await f.stage('untracked', { path: 'second' })
  assert.equal(f.git('ls-files', '-u'), conflicts)
  assert.deepEqual((await f.status()).stageHistory, EMPTY_HISTORY)
  assert.equal(f.index('second'), 'second staged\n')
  assertIndexClean(f)
})

test('staging and replay preserve the semantic entries of a split index', async t => {
  const f = fixture(t)
  f.git('config', 'core.splitIndex', 'true')
  f.write('other', 'staged before split\n')
  f.git('add', '--', 'other')
  f.git('update-index', '--split-index', '--assume-unchanged', '--', 'other')
  const other = f.git('ls-files', '-v', '--stage', '--', 'other')
  f.write(f.path, 'panel\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  await f.history('undo', undo.id)
  assert.equal(f.index(), f.original.join(''))
  assert.equal(f.git('ls-files', '-v', '--stage', '--', 'other'), other)
  assertIndexClean(f)
})

test('a gitfile cannot redirect a staging write into another checkout', async t => {
  const f = fixture(t)
  const nested = join(f.root, 'fake-checkout')
  mkdirSync(nested)
  writeFileSync(join(nested, '.git'), `gitdir: ${join(f.root, '.git')}\n`)
  writeFileSync(join(nested, f.path), 'foreign staged\n')
  const previousGet = f.ctx.sessions.get
  f.ctx.sessions.get = id => id === 'other-session' ? { header: { cwd: nested } } : previousGet(id)
  assert.equal((await f.stage('unstaged', { sessionId: 'other-session', repo: nested }, { expected: 409 })).error.code, 'stage-history-unavailable')
  assert.equal(f.index(), f.original.join(''))
  assertIndexClean(f)
})


test('publication refuses a direct index replacement made despite Git’s native lock', async t => {
  const f = fixture(t)
  f.write(f.path, 'panel\n')
  await f.stage('unstaged')
  const { undo } = (await f.status()).stageHistory
  const index = join(f.root, '.git', 'index')
  const alternate = join(f.root, '.git', 'alternate-index')
  writeFileSync(alternate, readFileSync(index))
  f.write(f.path, 'direct replacement\n')
  execFileSync('git', ['add', '--', f.path], { cwd: f.root, env: { ...env, GIT_INDEX_FILE: alternate } })
  const replacement = readFileSync(alternate)
  f.beforeSpawn(({ argv }) => {
    if (argv.includes('--index-info')) renameSync(alternate, index)
  })
  assert.equal((await f.history('undo', undo.id, {}, { expected: 409 })).error.code, 'stage-history-stale')
  assert.deepEqual(readFileSync(index), replacement)
  assert.equal((await f.status()).stageHistory.undo.id, undo.id)
  assert.equal(f.index(), 'direct replacement\n')
  assert.equal(f.read(f.path), 'direct replacement\n')
  assertIndexClean(f)
})
