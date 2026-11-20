import test from 'node:test'
import assert from 'node:assert/strict'

import {
  motionAt, PERIOD, REDUCED_PERIOD, sampleSegment, segmentEasing, startTurning, stopTurning,
} from '../lib/client/turning.js'

const CRUISE = 360 / PERIOD

/** Evaluate a CSS cubic-bezier at time fraction `x` by bisection, as a browser would. */
function bezierAt(easing, x) {
  const [x1, y1, x2, y2] = easing.match(/-?[\d.]+/gu).map(Number)
  const at = (a, b, u) => 3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3
  let low = 0
  let high = 1
  for (let step = 0; step < 60; step += 1) {
    const mid = (low + high) / 2
    if (at(x1, x2, mid) < x) low = mid
    else high = mid
  }
  return at(y1, y2, (low + high) / 2)
}

/** Assert a motion's angle never moves backwards and its speed stays finite over `span` ms. */
function assertForward(motion, span) {
  let previous = motionAt(motion, 0).angle
  for (let elapsed = 1; elapsed <= span; elapsed += 1) {
    const { angle, speed } = motionAt(motion, elapsed)
    assert.ok(angle >= previous - 1e-9, `angle goes back at ${elapsed} ms`)
    assert.ok(Number.isFinite(speed) && speed >= -1e-9, `speed ${speed} at ${elapsed} ms`)
    previous = angle
  }
}

test('turning speeds up from rest over a quarter turn and then cruises', () => {
  const motion = startTurning({ angle: 0, speed: 0 }, PERIOD)
  assert.equal(motion.kind, 'turning')
  assert.deepEqual(motionAt(motion, 0), { angle: 0, speed: 0 }, 'starts at rest, so the first frame does not jump')
  const { spinUp } = motion
  assert.equal(spinUp.to, 90)
  assert.ok(Math.abs(spinUp.duration - 2 * 90 / CRUISE) < 1e-9, 'even acceleration: twice the cruising time')
  const handover = motionAt(motion, spinUp.duration)
  assert.equal(handover.angle, 90)
  assert.ok(Math.abs(handover.speed - CRUISE) < 1e-12, 'reaches cruising speed exactly where the cruise starts')
  const later = motionAt(motion, spinUp.duration + PERIOD)
  assert.ok(Math.abs(later.angle - 450) < 1e-9, 'one turn per period')
  assertForward(motion, 3 * PERIOD)
})

test('turning from rest starts from the rest pose, without accumulated turns', () => {
  const motion = startTurning({ angle: 540, speed: 0 }, PERIOD)
  assert.equal(motion.spinUp.from, 180)
})

test('turning again mid-glide keeps the angle and speed it had', () => {
  const turning = startTurning({ angle: 0, speed: 0 }, PERIOD)
  const glide = stopTurning(motionAt(turning, 2000), 180)
  const state = motionAt(glide, 120)
  const again = startTurning(state, PERIOD)
  assert.equal(again.spinUp.from, state.angle)
  const start = motionAt(again, 0)
  assert.ok(Math.abs(start.speed - state.speed) < 1e-12, 'no jolt when the work starts again')
  assertForward(again, 2 * PERIOD)
})

test('stopping glides to the next rest angle ahead, ending at zero speed', () => {
  for (const restEvery of [180, 360]) {
    for (let at = 0; at < 4000; at += 37) {
      const turning = startTurning({ angle: 0, speed: 0 }, PERIOD)
      const state = motionAt(turning, at)
      const glide = stopTurning(state, restEvery)
      if (glide === null) {
        assert.equal(at, 0, 'only an icon that never moved is already at rest')
        continue
      }
      const { from, to, duration, startSpeed } = glide.glide
      assert.equal(from, state.angle)
      assert.equal(startSpeed, state.speed, 'the glide picks up at the current speed')
      assert.equal(to % restEvery, 0, `rests on a multiple of ${restEvery}°`)
      assert.ok(to - from >= state.speed * 100 - 1e-9, 'leaves room to slow down')
      assert.ok(duration >= 250 - 1e-9 && duration <= 1000 + 1e-9, `duration ${duration} within bounds`)
      const end = motionAt(glide, duration)
      assert.equal(end.angle, to)
      assert.equal(end.speed, 0)
      assertForward(glide, Math.ceil(duration))
      // Never past the rest angle: the Hermite curve stays monotone.
      for (let elapsed = 0; elapsed <= duration; elapsed += 5) {
        assert.ok(motionAt(glide, elapsed).angle <= to + 1e-9)
      }
    }
  }
})

test('the CSS easing plays the same curve the model samples', () => {
  const segments = [
    startTurning({ angle: 0, speed: 0 }, PERIOD).spinUp,
    startTurning({ angle: 30, speed: CRUISE * 1.3 }, PERIOD).spinUp,
    stopTurning({ angle: 200, speed: CRUISE }, 180).glide,
    stopTurning({ angle: 10, speed: CRUISE }, 360).glide,
    stopTurning({ angle: 359, speed: CRUISE }, 360).glide,
  ]
  for (const segment of segments) {
    const easing = segmentEasing(segment)
    for (let fraction = 0; fraction <= 1; fraction += 0.05) {
      const modelled = sampleSegment(segment, fraction * segment.duration).angle
      const played = segment.from + (segment.to - segment.from) * bezierAt(easing, fraction)
      assert.ok(Math.abs(modelled - played) < 0.05, `${easing} at ${fraction.toFixed(2)}: ${modelled} vs ${played}`)
    }
  }
})

test('reduced motion turns slower with the same shape', () => {
  const motion = startTurning({ angle: 0, speed: 0 }, REDUCED_PERIOD)
  const cruise = motionAt(motion, motion.spinUp.duration + 10)
  assert.ok(Math.abs(cruise.speed - 360 / REDUCED_PERIOD) < 1e-12)
  const glide = stopTurning(cruise, 180)
  assert.equal(glide.glide.to % 180, 0)
  assert.ok(glide.glide.duration <= 1000 + 1e-9)
})
