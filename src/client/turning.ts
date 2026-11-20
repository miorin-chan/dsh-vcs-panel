/**
 * The motion of an icon that turns while its control works.
 *
 * A CSS spin starts at full speed and, when its class goes away, snaps back
 * to its rest pose from wherever it was. Here the icon instead speeds up from
 * rest over its first quarter turn, cruises at one turn per period, and when
 * the work ends glides on to the next angle where it looks the same as at
 * rest. Each stretch is one cubic Hermite segment that starts and ends at the
 * speeds of its neighbours, so the angle and the speed are both continuous:
 * the icon never jumps and never jolts. A change of mind mid-stretch starts
 * the next stretch from the current angle and speed.
 *
 * This module holds the arithmetic; `Turning` in `ui.jsx` plays the
 * stretches with the Web Animations API, which keeps a transform animation on
 * the compositor, so the icon turns evenly while the panel renders the answer
 * it was waiting for.
 */

/** Milliseconds per turn at cruising speed. */
export const PERIOD = 900

/** Milliseconds per turn when the system asks for reduced motion. */
export const REDUCED_PERIOD = 2400

/** Degrees over which an icon reaches cruising speed. */
const SPIN_UP_ANGLE = 90

/** A glide covers at least the distance its starting speed travels in this many milliseconds. */
const GLIDE_LEAD = 100

/** Glide duration bounds, in milliseconds. */
const GLIDE_MIN = 250
const GLIDE_MAX = 1000

/** A glide aims for this many times the time its distance takes at its starting speed: an even slow-down. */
const GLIDE_STRETCH = 1.6

/** Below this many degrees the icon is already at rest. */
const AT_REST = 0.01

/** One stretch of the motion: a cubic Hermite segment. */
export interface Segment {
  /** Starting angle in degrees. */
  from: number
  /** Ending angle in degrees. */
  to: number
  /** Milliseconds. */
  duration: number
  /** Degrees per millisecond at the start. */
  startSpeed: number
  /** Degrees per millisecond at the end. */
  endSpeed: number
}

/**
 * A turning motion cruises from `spinUp.to` once the spin-up is over, one
 * turn per `period`; a gliding motion rests at `glide.to` once it is over.
 */
export type Motion =
  | { kind: 'turning'; spinUp: Segment; period: number }
  | { kind: 'gliding'; glide: Segment }

/** Angle and speed of the icon at one instant. */
export interface MotionSample {
  /** Degrees. */
  angle: number
  /** Degrees per millisecond. */
  speed: number
}

/**
 * The segment's end speeds in units of its average speed: the Hermite
 * tangents of the unit curve.
 * @param segment - one stretch.
 * @returns start and end tangent.
 */
function tangents(segment: Segment): [number, number] {
  const distance = segment.to - segment.from
  if (distance === 0) return [0, 0]
  const scale = segment.duration / distance
  return [segment.startSpeed * scale, segment.endSpeed * scale]
}

/**
 * The CSS easing that plays a segment. A cubic-bezier with its x controls at
 * one and two thirds keeps time linear, so its y controls are exactly the
 * Hermite curve with the segment's end tangents.
 * @param segment - one stretch.
 * @returns a `cubic-bezier()` timing function.
 */
export function segmentEasing(segment: Segment): string {
  const [start, end] = tangents(segment)
  const round = (value: number): number => Math.round(value * 10000) / 10000
  return `cubic-bezier(0.3333, ${round(start / 3)}, 0.6667, ${round(1 - end / 3)})`
}

/**
 * Angle and speed partway through a segment.
 * @param segment - one stretch.
 * @param elapsed - milliseconds since it started.
 * @returns degrees and degrees per millisecond.
 */
export function sampleSegment(segment: Segment, elapsed: number): MotionSample {
  if (elapsed <= 0) return { angle: segment.from, speed: segment.startSpeed }
  if (elapsed >= segment.duration) return { angle: segment.to, speed: segment.endSpeed }
  const [start, end] = tangents(segment)
  const p = elapsed / segment.duration
  const position = start * (p ** 3 - 2 * p ** 2 + p) + (3 * p ** 2 - 2 * p ** 3) + end * (p ** 3 - p ** 2)
  const slope = start * (3 * p ** 2 - 4 * p + 1) + (6 * p - 6 * p ** 2) + end * (3 * p ** 2 - 2 * p)
  const distance = segment.to - segment.from
  return { angle: segment.from + distance * position, speed: slope * distance / segment.duration }
}

/**
 * Angle and speed of a motion some time after it started.
 * @param motion - the motion being played.
 * @param elapsed - milliseconds since it started.
 * @returns degrees and degrees per millisecond.
 */
export function motionAt(motion: Motion, elapsed: number): MotionSample {
  if (motion.kind === 'gliding') return sampleSegment(motion.glide, elapsed)
  const { spinUp, period } = motion
  if (elapsed < spinUp.duration) return sampleSegment(spinUp, elapsed)
  const speed = 360 / period
  return { angle: spinUp.to + speed * (elapsed - spinUp.duration), speed }
}

/**
 * Start turning from the given angle and speed: speed up to cruising over a
 * quarter turn, then cruise.
 * @param state - where the icon is now.
 * @param period - milliseconds per turn at cruising speed.
 * @returns a turning motion.
 */
export function startTurning(state: MotionSample, period: number): Motion {
  const { angle, speed } = state
  const cruise = 360 / period
  const from = speed > 0 ? angle : angle % 360
  const startSpeed = Math.max(speed, 0)
  // Even acceleration covers the distance at the mean of the two speeds; a
  // glide that was coasting faster than cruising eases down to it instead.
  const duration = 2 * SPIN_UP_ANGLE / (startSpeed + cruise)
  return {
    kind: 'turning',
    spinUp: { from, to: from + SPIN_UP_ANGLE, duration, startSpeed, endSpeed: cruise },
    period,
  }
}

/**
 * Stop turning: glide from the given angle and speed to the next rest angle
 * far enough ahead to slow down evenly.
 * @param state - where the icon is now.
 * @param restEvery - degrees between angles where the icon looks as it does at rest.
 * @returns a gliding motion, or null when the icon is already at rest.
 */
export function stopTurning(state: MotionSample, restEvery: number): Motion | null {
  const { angle, speed } = state
  const moving = Math.max(speed, 0)
  const target = Math.ceil((angle + moving * GLIDE_LEAD - AT_REST) / restEvery) * restEvery
  const distance = target - angle
  if (distance <= AT_REST) return null
  // A Hermite curve stays monotone while its start tangent is at most 3.
  const longest = moving > 0 ? Math.min(GLIDE_MAX, 3 * distance / moving) : GLIDE_MAX
  const aimed = moving > 0 ? GLIDE_STRETCH * distance / moving : GLIDE_MAX
  const duration = Math.min(Math.max(aimed, GLIDE_MIN), longest)
  return {
    kind: 'gliding',
    glide: { from: angle, to: target, duration, startSpeed: moving, endSpeed: 0 },
  }
}
