#!/usr/bin/env node
/**
 * Create the Git repository used to check the panel in a running DSH Web.
 *
 *   node scripts/fixture.mjs <dir>
 *
 * The history has a merge, a tag, and a side branch. The working tree has a
 * staged addition and deletion, a partly staged file, unstaged changes, an
 * untracked file, and an untracked directory, so every staging control and
 * both staging layouts have something to act on. Running it again recreates
 * the repository; a non-empty directory it did not create is refused.
 * Git runs without the user's global configuration, so no hook or signing
 * key takes part.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MARKER = join('.git', 'dsh-vcs-panel-fixture')

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/fixture.mjs <dir>')
  process.exit(1)
}
const root = resolve(target)
if (existsSync(root) && readdirSync(root).length > 0 && !existsSync(join(root, MARKER))) {
  console.error(`fixture: refusing ${root}: it is not empty and was not created by this script`)
  process.exit(1)
}
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const env = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}
function write(path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
function edit(path, pairs) {
  let text = readFileSync(join(root, path), 'utf8')
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${path} lacks ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  writeFileSync(join(root, path), text)
}

git('init', '-q', '-b', 'main')
writeFileSync(join(root, MARKER), '')
write('src/client/detail/ChangeTree.jsx', `import { useState } from "react";

export function ChangeTree({ rows, onToggle }) {
  const [focused, setFocused] = useState(0);
  return (
    <div className="tree">
      {rows.map((row, index) => (
        <Row key={row.id} row={row} focused={index === focused} onToggle={onToggle} />
      ))}
    </div>
  );
}

function Row({ row, focused, onToggle }) {
  return (
    <button className={focused ? "row focused" : "row"} onClick={() => onToggle(row.id)}>
      {row.name}
    </button>
  );
}
`)
write('src/client/state.js', `export const initialState = {
  selected: null,
  expanded: new Set(),
  layout: "unified",
};

export function reduce(state, action) {
  switch (action.type) {
    case "select":
      return { ...state, selected: action.id };
    default:
      return state;
  }
}
`)
write('src/server/routes.js', `export function routes(app) {
  app.get("/status", status);
  app.get("/diff", diff);
}

function status(req, res) {
  res.json({ ok: true });
}

function diff(req, res) {
  res.json({ hunks: [] });
}
`)
write('README.md', '# Demo\n\nA small fixture repository.\n')
write('docs/guide.md', 'Old intro paragraph.\n')
git('add', '-A')
git('commit', '-qm', 'feat: scaffold change tree and routes')
write('src/client/version.js', 'export const VERSION = 1;\n')
git('add', '-A')
git('commit', '-qm', 'incr: add version constant')
git('switch', '-qc', 'topic')
edit('src/server/routes.js', [['function diff(', '// topic\nfunction diff(']])
git('commit', '-qam', 'vibe: explore topic routes')
git('switch', '-q', 'main')
edit('src/client/version.js', [['VERSION = 1;\n', "VERSION = 1;\nexport const NAME = 'demo';\n"]])
git('commit', '-qam', 'incr: name the demo')
git('merge', '-q', '--no-ff', 'topic', '-m', 'merge topic')
git('tag', 'v0.1.0')

// Staged: one modification, one addition, one deletion.
edit('src/client/state.js', [['layout: "unified",', 'layout: "split",\n  wrap: false,']])
write('docs/getting-started.md', 'New guide.\n')
git('rm', '-q', 'docs/guide.md')
// Partly staged: the first change is in the index, the rest only in the working tree.
edit('src/client/detail/ChangeTree.jsx', [['useState(0);', 'useState(0);\n  const [hovered, setHovered] = useState(null);']])
git('add', 'src/client/state.js', 'docs/getting-started.md', 'src/client/detail/ChangeTree.jsx')
edit('src/client/detail/ChangeTree.jsx', [
  ['      {row.name}', '      <span className="name">{row.name}</span>\n      {row.count ? <span className="count">{row.count}</span> : null}'],
  ['onClick={() => onToggle(row.id)}>', 'onClick={() => onToggle(row.id)}\n      onMouseEnter={() => setHovered(row.id)}>'],
])
// Unstaged and untracked.
edit('src/server/routes.js', [
  ['  res.json({ ok: true });', '  const branch = req.query.branch ?? "main";\n  res.json({ ok: true, branch });'],
  ['  res.json({ hunks: [] });', '  const file = req.query.file;\n  if (!file) return res.status(400).json({ error: "missing file" });\n  res.json({ file, hunks: [] });'],
])
write('README.md', '# Demo\n\nA small fixture repository for the VCS panel.\n\n## Usage\n\nRun the server.\n')
write('src/client/theme.js', 'export const theme = "dark";\n')
write('notes/todo.txt', 'scratch\n')
write('notes/deep/idea.txt', 'later\n')

const status = spawnSync('git', ['status', '--short'], { cwd: root, env, encoding: 'utf8' }).stdout
console.log(`fixture ${root}\n${status}`)
