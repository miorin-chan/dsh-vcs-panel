import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  const stage = async (scope, target = {}, { headers = {}, expected = 200, query = '' } = {}) => {
    const response = await handlers.stage(new Request(`http://localhost/api/vcs.stage${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...identify, scope, ...target }),
    }))
    const body = await response.json()
    assert.equal(response.status, expected, JSON.stringify(body))
    return body
  }
  return {
    git, root, path, original, write, read, diff, stage,
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

test('line staging refuses an external index edit after fingerprint validation', async t => {
  const f = fixture(t)
  const working = `selected\n${f.original.join('')}`
  const external = `${f.original.join('')}externally staged\n`
  f.write(f.path, working)
  const diff = await f.diff('unstaged')
  f.beforeSpawn(({ argv }) => {
    if (!argv.includes('apply')) return
    f.write(f.path, external)
    f.git('add', '--', f.path)
    f.write(f.path, working)
  })
  const response = await f.stage('unstaged', {
    fingerprint: diff.fingerprint, lines: select(diff, '+selected'),
  }, { expected: 409 })
  assert.equal(response.error.code, 'stale-diff')
  assert.equal(f.index(), external)
  assert.equal(f.read(f.path), working)
})

test('whole-file unstage checks its index entry again after reading the HEAD tree', async t => {
  const f = fixture(t)
  f.write(f.path, 'indexed\n')
  f.git('add', '--', f.path)
  f.beforeSpawn(({ argv }) => {
    if (!argv.includes('ls-tree')) return
    f.write(f.path, 'externally staged\n')
    f.git('add', '--', f.path)
    f.write(f.path, 'worktree\n')
  })
  assert.equal((await f.stage('staged', {}, { expected: 409 })).error.code, 'stale-diff')
  assert.equal(f.index(), 'externally staged\n')
  assert.equal(f.read(f.path), 'worktree\n')
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
