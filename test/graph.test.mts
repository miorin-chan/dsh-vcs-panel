import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLOR_PALETTE,
  LANE_UNIT,
  buildGraph,
  buildPathD,
  graphWidth,
  resolveColor,
} from '../lib/client/history/layout.js'

/**
 * Build a minimal `CommitNode` for layout tests.
 *
 * @param {string} sha
 * @param {string[]} [parents]
 * @param {Array<{ name: string, kind: 'head'|'branch'|'remote'|'tag' }>} [refs]
 */
function node(sha, parents = [], refs = []) {
  return {
    sha,
    parents,
    refs,
    author: 'Test Author',
    authorTime: 1700000000,
    subject: `subject ${sha}`,
  }
}

/** Recursively assert every number in the layout is finite (no NaN/Infinity). */
function assertAllFinite(value, path = 'layout') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAllFinite(item, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertAllFinite(child, `${path}.${key}`)
    }
  }
}

/** Every visible lane of a fixture must produce a valid SVG `d` attribute. */
function assertPathsDrawable(layout) {
  for (const path of layout.paths) {
    const d = buildPathD(path.points)
    if (path.points.length < 2) {
      assert.equal(d, '')
      continue
    }
    assert.match(d, /^M /)
    assert.ok(!d.includes('NaN'), `path d contains NaN: ${d}`)
    assert.ok(!d.includes('undefined'), `path d contains undefined: ${d}`)
  }
}

const LINEAR = [
  node('c0', ['c1'], [{ name: 'main', kind: 'head' }]),
  node('c1', ['c2']),
  node('c2', ['c3']),
  node('c3', ['c4']),
  node('c4'),
]

const BRANCH = [
  node('A', ['M'], [{ name: 'main', kind: 'head' }]),
  node('B', ['M'], [{ name: 'feature', kind: 'branch' }]),
  node('M'),
]

// `B` (a head) traces P2 first, so the merge `M` finds an active lane for its
// second parent P2 and emits a merge link.
const MERGE = [
  node('B', ['P2'], [{ name: 'HEAD', kind: 'head' }]),
  node('M', ['P1', 'P2'], [{ name: 'main', kind: 'branch' }]),
  node('P1', ['R']),
  node('P2', ['R']),
  node('R'),
]

const OCTOPUS = [
  node('T', ['P2']),
  node('M', ['P1', 'P2', 'P3'], [{ name: 'main', kind: 'branch' }]),
  node('P1', ['R']),
  node('P2', ['R']),
  node('P3', ['R']),
  node('R'),
]

test('linear history keeps one stable lane', () => {
  const layout = buildGraph(LINEAR)

  assert.equal(layout.dots.length, LINEAR.length)
  assert.equal(layout.commitLeftMargin.length, LINEAR.length)
  assert.equal(layout.links.length, 0)
  assert.ok(layout.paths.length >= 1, 'a linear run must emit a path')

  const xs = layout.dots.map((dot) => dot.center.x)
  assert.ok(xs.every((x) => x === xs[0]), 'linear dots share one x position')
  assert.deepEqual(
    layout.dots.map((dot) => dot.center.y),
    [0.5, 1.5, 2.5, 3.5, 4.5],
  )
  assert.deepEqual(
    layout.dots.map((dot) => dot.type),
    ['head', 'default', 'default', 'default', 'default'],
  )
  for (const margin of layout.commitLeftMargin) {
    assert.ok(Number.isFinite(margin))
    assert.ok(margin > 0)
  }
  assert.equal(layout.commitLeftMargin[0], 18)
  assert.ok(layout.paths[0].points.length >= 2)
  assert.equal(layout.paths[0].points[0].x, xs[0])

  assertAllFinite(layout)
  assertPathsDrawable(layout)
  assert.equal(graphWidth(layout), 24)
})

test('branch history opens a side lane and separates dot columns', () => {
  const layout = buildGraph(BRANCH)

  assert.equal(layout.dots.length, 3)
  assert.equal(layout.paths.length, 2, 'one path per branch tip')

  const [tipA, tipB, shared] = layout.dots
  assert.notEqual(tipA.center.x, tipB.center.x, 'tips sit on different lanes')
  assert.equal(tipB.center.x, tipA.center.x + LANE_UNIT, 'side lane is one unit right')
  assert.equal(shared.center.x, tipA.center.x, 'shared ancestor returns to the first lane')
  assert.equal(tipA.type, 'head')
  assert.equal(tipB.type, 'default')

  assert.notEqual(layout.paths[0].color, layout.paths[1].color, 'lanes use distinct colors')

  assertAllFinite(layout)
  assertPathsDrawable(layout)
})

test('merge commit links to an already tracked parent', () => {
  const layout = buildGraph(MERGE)

  assert.equal(layout.dots.length, 5)
  assert.equal(layout.dots[0].type, 'head')
  assert.equal(layout.dots[1].type, 'merge', 'two-parent commit is a merge dot')
  assert.equal(layout.links.length, 1, 'second parent already has an active lane')

  const [link] = layout.links
  assert.deepEqual(link.start, layout.dots[1].center)
  assert.equal(link.control.x, link.end.x, 'merge edge is vertical at the target lane')
  assert.equal(link.end.y, link.start.y + 0.5)
  assert.ok(layout.paths.length >= 2, 'the merge starts a side lane for its second parent')

  assertAllFinite(layout)
  assertPathsDrawable(layout)
  assert.equal(graphWidth(layout), 30)
})

test('octopus merge starts a lane for every additional parent', () => {
  const layout = buildGraph(OCTOPUS)

  assert.equal(layout.dots.length, 6)
  assert.equal(layout.dots[1].type, 'merge')
  assert.equal(layout.links.length, 1, 'P2 was already tracked, P3 is new')
  assert.equal(layout.paths.length, 3, 'main line + merge side lane + new P3 lane')
  assert.equal(layout.dots[4].center.x, layout.dots[1].center.x + LANE_UNIT)
  assertAllFinite(layout)
  assertPathsDrawable(layout)
})

test('a head ref keeps the head dot type on a merge commit', () => {
  const layout = buildGraph([
    node('X', ['A', 'B'], [{ name: 'HEAD', kind: 'head' }]),
    node('A'),
    node('B'),
  ])
  assert.equal(layout.dots[0].type, 'head')
})

test('the current branch takes the head dot type, a plain branch does not', () => {
  const layout = buildGraph([
    node('X', ['A'], [{ name: 'main', kind: 'branch', current: true }]),
    node('A', [], [{ name: 'side', kind: 'branch' }]),
  ])
  assert.equal(layout.dots[0].type, 'head')
  assert.equal(layout.dots[1].type, 'default')
})

test('root commit and parents missing from the page do not throw', () => {
  const rootOnly = buildGraph([node('R')])
  assert.equal(rootOnly.dots.length, 1)
  assert.equal(rootOnly.dots[0].type, 'default')
  assert.equal(rootOnly.dots[0].center.x, 10)
  assert.equal(rootOnly.paths.length, 0, 'no parent means no path')
  assert.equal(rootOnly.links.length, 0)
  assert.deepEqual(rootOnly.commitLeftMargin, [18])
  assertAllFinite(rootOnly)

  // A parent that is not part of the loaded page: the lane ends at the bottom.
  const missingParent = buildGraph([node('A', ['GHOST']), node('B')])
  assert.equal(missingParent.dots.length, 2)
  assert.equal(missingParent.paths.length, 1)
  const points = missingParent.paths[0].points
  assert.deepEqual(points[0], { x: 10, y: 0.5 })
  assert.deepEqual(points[points.length - 1], { x: 10, y: 2 })
  assertAllFinite(missingParent)
  assertPathsDrawable(missingParent)
})

test('repeated and unknown shas do not throw', () => {
  assert.doesNotThrow(() => buildGraph([node('S', ['R']), node('S', ['R']), node('R')]))
  const layout = buildGraph([node('S', ['R']), node('S', ['R']), node('R')])
  assert.equal(layout.dots.length, 3)
  assertAllFinite(layout)
  assertPathsDrawable(layout)

  // Unknown first parent on an otherwise valid list.
  assert.doesNotThrow(() => buildGraph([node('A', ['NOPE', 'ALSO-NOPE']), node('B')]))
})

test('layout is deterministic for the same input', () => {
  const fixture = [
    node('H', ['M', 'F'], [{ name: 'HEAD', kind: 'head' }]),
    node('F', ['P']),
    node('M', ['P', 'Q'], [{ name: 'main', kind: 'branch' }]),
    node('P', ['R']),
    node('Q', ['R']),
    node('R'),
  ]
  assert.deepEqual(buildGraph(fixture), buildGraph(fixture))
})

test('colors recycle only after the palette is exhausted', () => {
  const tips = Array.from({ length: COLOR_PALETTE.length + 1 }, (_, index) =>
    node(`T${index}`, ['R']),
  )
  const layout = buildGraph([...tips, node('R')])

  const tipColors = layout.dots.slice(0, tips.length).map((dot) => dot.color)
  assert.equal(new Set(tipColors.slice(0, COLOR_PALETTE.length)).size, COLOR_PALETTE.length)
  assert.equal(tipColors[COLOR_PALETTE.length], tipColors[0], 'overflow lane recycles the palette')

  assert.equal(resolveColor(0), COLOR_PALETTE[0])
  assert.equal(resolveColor(COLOR_PALETTE.length), COLOR_PALETTE[0])
  assert.equal(resolveColor(-1), COLOR_PALETTE[COLOR_PALETTE.length - 1])
  assert.equal(resolveColor(Number.NaN), COLOR_PALETTE[0])
})

test('buildPathD renders straight and bent polylines', () => {
  // Expected strings use SourceGit's 30px rows.
  assert.equal(
    buildPathD([
      { x: 10, y: 0.5 },
      { x: 10, y: 2 },
    ], 30),
    'M 10 15 L 10 60',
  )

  // Bend to the right: quadratic with the control at the previous y.
  assert.equal(
    buildPathD([
      { x: 10, y: 0.5 },
      { x: 22, y: 1.5 },
    ], 30),
    'M 10 15 Q 22 15, 22 45',
  )

  // Bend to the left on the final point: quadratic with the control at the
  // previous x.
  assert.equal(
    buildPathD([
      { x: 22, y: 1.5 },
      { x: 10, y: 2.5 },
    ], 30),
    'M 22 45 Q 22 75, 10 75',
  )

  // Middle bend to the left: cubic S-curve.
  const bent = buildPathD([
    { x: 22, y: 1.5 },
    { x: 10, y: 2.5 },
    { x: 10, y: 3 },
  ], 30)
  assert.match(bent, /^M 22 45 C /)
  assert.ok(bent.includes(' L 10 90'))

  assert.equal(buildPathD([]), '')
  assert.equal(buildPathD([{ x: 10, y: 0.5 }]), '')
  assert.equal(
    buildPathD(
      [
        { x: 10, y: 1 },
        { x: 10, y: 2 },
      ],
      10,
    ),
    'M 10 10 L 10 20',
  )
})

test('graphWidth clamps the reserved gutter', () => {
  assert.equal(graphWidth({ commitLeftMargin: [] }), 24)
  assert.equal(graphWidth({}), 24)
  assert.equal(graphWidth(null), 24)
  assert.equal(graphWidth({ commitLeftMargin: [10] }), 24, 'never narrower than the minimum')
  assert.equal(graphWidth({ commitLeftMargin: [78] }), 78)
  assert.equal(graphWidth({ commitLeftMargin: [18, 30, 12] }), 30)
  assert.equal(graphWidth({ commitLeftMargin: [500] }), 120, 'never wider than the maximum')
  assert.equal(graphWidth({ commitLeftMargin: [500] }, { min: 10, max: 60 }), 60)
  assert.equal(graphWidth({ commitLeftMargin: [50] }, { min: 60, max: 120 }), 60)
  assert.equal(graphWidth({ commitLeftMargin: [Number.NaN, Infinity, 42] }), 42)
})

test('empty commit list yields an empty layout', () => {
  const layout = buildGraph([])
  assert.deepEqual(layout, { paths: [], links: [], dots: [], commitLeftMargin: [] })
  assert.equal(graphWidth(layout), 24)
  assert.doesNotThrow(() => buildGraph(undefined))
})

/** The working-tree node the timeline prepends, waiting for HEAD. */
function worktree(head, id = 'worktree') {
  return { sha: id, parents: head === null ? [] : [head], refs: [], worktree: true }
}

test('the working-tree lane is dashed and ends on HEAD, which continues solid in its color', () => {
  const layout = buildGraph([worktree('c0'), ...LINEAR])
  assertAllFinite(layout)
  assertPathsDrawable(layout)
  assert.equal(layout.dots.length, LINEAR.length + 1)
  assert.equal(layout.dots[0].type, 'worktree')
  assert.equal(layout.dots[1].type, 'head')
  assert.equal(layout.dots[0].center.x, layout.dots[1].center.x, 'the working tree sits on HEAD’s lane')

  const dashed = layout.paths.filter(path => path.dashed === true)
  assert.equal(dashed.length, 1)
  assert.deepEqual(dashed[0].points.at(0), layout.dots[0].center)
  assert.deepEqual(dashed[0].points.at(-1), layout.dots[1].center)

  const solid = layout.paths.find(path => path.dashed !== true && path.points[0].y === layout.dots[1].center.y)
  assert.ok(solid, 'HEAD starts a solid lane')
  assert.equal(solid.color, dashed[0].color)
  assert.deepEqual(solid.points[0], layout.dots[1].center)
})

test('with every branch loaded the dashed lane reaches a HEAD further down', () => {
  // `feature` sorts above HEAD (`main`); both come from M.
  const commits = [
    node('F', ['M'], [{ name: 'feature', kind: 'branch' }]),
    node('H', ['M'], [{ name: 'main', kind: 'branch', current: true }]),
    node('M'),
  ]
  const layout = buildGraph([worktree('H'), ...commits])
  assertAllFinite(layout)
  assertPathsDrawable(layout)
  const dashed = layout.paths.filter(path => path.dashed === true)
  assert.equal(dashed.length, 1)
  assert.deepEqual(dashed[0].points.at(-1), layout.dots[2].center, 'the lane ends on H, two rows down')
  assert.equal(layout.dots[2].type, 'head')
  assert.notEqual(layout.dots[1].center.x, layout.dots[0].center.x, 'the feature tip takes another lane')
})

test('a working tree on a root HEAD ends there, and one without commits has no lane', () => {
  const root = buildGraph([worktree('R'), node('R', [], [{ name: 'main', kind: 'branch', current: true }])])
  assertAllFinite(root)
  assert.equal(root.paths.length, 1)
  assert.equal(root.paths[0].dashed, true)
  assert.deepEqual(root.paths[0].points.at(-1), root.dots[1].center)

  const unborn = buildGraph([worktree(null)])
  assert.equal(unborn.paths.length, 0)
  assert.equal(unborn.dots.length, 1)
  assert.equal(unborn.dots[0].type, 'worktree')
})

test('multiple dashed worktree lanes can share a HEAD without turning merge ancestry dashed', () => {
  const layout = buildGraph([
    worktree('M', 'merge-checkout'), worktree('R', 'right-one'), worktree('R', 'right-two'),
    worktree(null, 'unborn'), node('M', ['L', 'R']), node('L', ['B']), node('R', ['B']), node('B'),
  ])
  assertAllFinite(layout)
  assertPathsDrawable(layout)
  assert.deepEqual(layout.dots.map(dot => dot.type), ['worktree', 'worktree', 'worktree', 'worktree', 'merge', 'default', 'default', 'default'])
  const dashed = layout.paths.filter(path => path.dashed === true)
  assert.equal(dashed.length, 3)
  assert.deepEqual(dashed.map(path => path.points[0]), layout.dots.slice(0, 3).map(dot => dot.center))
  assert.deepEqual(dashed.map(path => path.points.at(-1)), [layout.dots[4].center, layout.dots[6].center, layout.dots[6].center])
  assert.ok(layout.paths.some(path => path.dashed !== true
    && path.points[0].y === layout.dots[4].center.y
    && path.points.at(-1).y === layout.dots[6].center.y), 'the real second-parent edge reaches R on a solid lane')
})
