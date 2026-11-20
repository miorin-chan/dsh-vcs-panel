/**
 * Small controls owned by the version control panel.
 *
 * The Host policy forbids external plugins from loading Harness Client
 * packages, so this file keeps the few controls the panel needs (buttons,
 * ref badges, icons) local, styled with theme tokens.
 */

import { useEffect, useRef } from 'react'
import { formatCount } from './format.js'
import { motionAt, PERIOD, REDUCED_PERIOD, segmentEasing, startTurning, stopTurning } from './turning.js'

/** A separate, muted count for the untracked entries in a diff summary. */
export function UntrackedStat({ count, label, locale }) {
  if (count <= 0) return null
  const formatted = formatCount(count, locale)
  return (
    <span className="vcs-dim vcs-untracked-stat" title={label}>
      <span aria-hidden="true">U +{formatted}</span>
      <span className="vcs-sr-only">{label} {formatted}</span>
    </span>
  )
}

/** A text button with an optional leading icon. */
export function Button({ children, onClick, disabled = false, title, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`vcs-button ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * A square icon-only button; `label` is its accessible name. A toggle passes
 * `pressed` so assistive technology hears the choice that is on. A `busy`
 * button ignores clicks while its work runs but keeps focus and full contrast
 * (`aria-disabled` rather than `disabled`).
 */
export function IconButton({ label, children, onClick, disabled = false, busy = false, title, pressed, description, className = '' }) {
  return (
    <button
      type="button"
      className={`vcs-icon-button ${className}`.trim()}
      aria-label={label}
      aria-pressed={pressed}
      aria-description={description}
      aria-busy={busy ? 'true' : undefined}
      aria-disabled={busy ? 'true' : undefined}
      title={title ?? label}
      onClick={busy ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

/** Milliseconds per turn, slower when the system asks for reduced motion. */
function turnPeriod() {
  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reduced ? REDUCED_PERIOD : PERIOD
}

/** One rotation keyframe. */
function rotation(angle) {
  return { transform: `rotate(${angle}deg)` }
}

/**
 * Play a motion from `start` on the element's timeline.
 * @param {Element} element - the turning wrapper.
 * @param {import('./turning.js').Motion} motion - the stretches to play.
 * @param {number} start - timeline time the motion starts at.
 * @returns {Animation[]} the running animations.
 */
function playMotion(element, motion, start) {
  const animations = []
  if (motion.kind === 'gliding') {
    const { glide } = motion
    animations.push(element.animate([rotation(glide.from), rotation(glide.to)], {
      duration: glide.duration,
      easing: segmentEasing(glide),
    }))
  } else {
    const { spinUp, period } = motion
    animations.push(element.animate([rotation(spinUp.from), rotation(spinUp.to)], {
      duration: spinUp.duration,
      easing: segmentEasing(spinUp),
      fill: 'forwards',
    }))
    // Starts where the spin-up ends; created later, so it wins from then on.
    animations.push(element.animate([rotation(spinUp.to), rotation(spinUp.to + 360)], {
      duration: period,
      delay: spinUp.duration,
      iterations: Infinity,
    }))
  }
  // Both clocks read the same timeline, so the motion picks up exactly where
  // the previous one was in the last painted frame.
  for (const animation of animations) animation.startTime = start
  return animations
}

/**
 * Wrap an icon that turns while `turning` is true. It speeds up from rest
 * and, when the work ends, glides on to the next angle where it looks as it
 * does at rest; `restEvery` is that angle's spacing, 180 for a symmetric pair
 * of arrows. See `turning.js`.
 * @param {{ turning: boolean, restEvery?: number, children: unknown }} props - turning state and the icon.
 */
export function Turning({ turning, restEvery = 360, children }) {
  const elementRef = useRef(null)
  // `{ motion, start, animations }` for the motion on screen, or null at rest.
  const playingRef = useRef(null)

  useEffect(() => {
    const element = elementRef.current
    if (element === null || typeof element.animate !== 'function') return
    const timeline = element.ownerDocument?.timeline
    const now = typeof timeline?.currentTime === 'number' ? timeline.currentTime : performance.now()
    const playing = playingRef.current
    const state = playing === null ? { angle: 0, speed: 0 } : motionAt(playing.motion, now - playing.start)
    const motion = turning ? startTurning(state, turnPeriod()) : stopTurning(state, restEvery)
    if (playing !== null) for (const animation of playing.animations) animation.cancel()
    playingRef.current = motion === null ? null : { motion, start: now, animations: playMotion(element, motion, now) }
  }, [turning, restEvery])

  useEffect(() => () => {
    const playing = playingRef.current
    if (playing !== null) for (const animation of playing.animations) animation.cancel()
    playingRef.current = null
  }, [])

  return <span ref={elementRef} className="vcs-turning">{children}</span>
}

/**
 * One ref badge; kind decides its color. The branch HEAD points to takes the
 * HEAD color and reads as git's `HEAD -> name`, so one badge carries both.
 * A branch, remote-branch, or tag badge that receives `onRefContextMenu` is
 * an actions target: it opens the shared menu instead of the browser's context
 * menu. A remote badge is only actionable when the log attached its split
 * remote and branch names.
 * The prop is `reference`, not `ref`: this client runs on React 18, where
 * `ref` is reserved and never reaches a function component's props.
 */
export function RefBadge({ reference, onRefContextMenu, onRefActivate }) {
  const current = reference.current === true
  const remote = reference.kind === 'remote'
    && typeof reference.remote === 'string' && typeof reference.branch === 'string'
  const actionableKind = reference.kind === 'branch' || reference.kind === 'tag' || remote
  const interactive = actionableKind && typeof onRefActivate === 'function'
  const contextOnly = actionableKind && !interactive && typeof onRefContextMenu === 'function'
  const title = current ? `HEAD -> ${reference.name}` : reference.name
  const tone = current ? 'head' : reference.kind

  if (interactive) {
    const openFrom = (target, event) => {
      const rect = target.getBoundingClientRect()
      onRefActivate(reference, {
        clientX: rect.left + 12,
        clientY: rect.bottom ?? (rect.top + rect.height),
        preventDefault() { event?.preventDefault?.() },
        stopPropagation() { event?.stopPropagation?.() },
      }, target)
    }
    return (
      <button
        type="button"
        className={`vcs-ref vcs-ref-button vcs-ref-${tone}`}
        title={title}
        aria-haspopup="menu"
        data-ref-actions="true"
        onClick={event => { openFrom(event.currentTarget, event) }}
        onContextMenu={event => { onRefActivate(reference, event, event.currentTarget) }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          openFrom(event.currentTarget, event)
        }}
      >
        {reference.name}
      </button>
    )
  }

  return (
    <span
      className={`vcs-ref vcs-ref-${tone}`}
      title={title}
      data-ref-actions={contextOnly ? 'true' : undefined}
      onContextMenu={contextOnly
        ? event => { onRefContextMenu(reference, event) }
        : undefined}
    >
      {reference.name}
    </span>
  )
}

/** A working-copy commit may be shared by more than one checked workspace. */
export function WorkingCopyBadge({ labels, title }) {
  if (labels.length === 0) return null
  return (
    <span className="vcs-working-badge" title={`${title}: ${labels.join(', ')}`}>
      <span className="vcs-working-badge-label">{labels[0]}</span>
      {labels.length > 1 ? <span>+{labels.length - 1}</span> : null}
    </span>
  )
}

/** Padlock glyph for the read-only marker. */
export function LockIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Git branch glyph. */
export function BranchIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="4" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.8v4.4M11.5 7.8c0 2-2 2.4-4.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Refresh arrow. */
export function RefreshIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6v2.8h-2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Two arrows chasing each other: the branch and its upstream trading commits. */
export function SyncIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8a5 5 0 0 1 9.33-2.5M12.6 2.7v2.9H9.7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 8a5 5 0 0 1-9.33 2.5M3.4 13.3v-2.9h2.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Chevron pointing right (collapsed) or down (expanded). */
export function Chevron({ open }) {
  return (
    <svg className="vcs-chevron" viewBox="0 0 12 12" aria-hidden="true" data-open={open ? 'true' : undefined}>
      <path d="M4 2.5 8 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Outward chevrons for expanded diffs, inward chevrons for the folded list. */
export function FoldIcon({ expanded }) {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {!expanded ? (
        <>
          <path d="M4.5 2.5 8 6l3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 13.5 8 10l3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M4.5 6 8 2.5 11.5 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 10 8 13.5 11.5 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}

/** Back arrow used by the narrow single-column layout. */
export function BackIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Copy glyph. */
export function CopyIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="6" y="6" width="7" height="8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 6V4.4A1.4 1.4 0 0 0 8.6 3H4.4A1.4 1.4 0 0 0 3 4.4v6.2A1.4 1.4 0 0 0 4.4 12H6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Two columns: the layout toggle of the diff stream, from DSH's
 * `compare-split-outline` icon.
 */
export function CompareSplitIcon({ split }) {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-unified={split ? undefined : ''}>
      <path
        d="M6 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H6C6.55228 14.5 7 14.0523 7 13.5V2.5C7 1.94772 6.55228 1.5 6 1.5Z"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M13.5 1.5H10C9.44772 1.5 9 1.94772 9 2.5V13.5C9 14.0523 9.44772 14.5 10 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

/** A list shown in one block or in two blocks by index state. */
export function StagingLayoutIcon({ merged }) {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.1">
      {merged ? <rect x="2" y="2" width="12" height="12" rx="1.5" /> : <>
        <rect x="2" y="1.5" width="12" height="5.25" rx="1.25" />
        <rect x="2" y="9.25" width="12" height="5.25" rx="1.25" />
      </>}
      <path d={merged ? 'M5 5h6M5 8h6M5 11h6' : 'M5 4.1h6M5 11.9h6'} strokeLinecap="round" />
    </svg>
  )
}

/**
 * The left column is filled while the timeline stands beside the changes.
 */
export function TimelineBesideIcon({ beside }) {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {beside ? <rect x="2" y="3" width="4" height="10" rx="0.6" fill="currentColor" opacity="0.4" /> : null}
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1" />
      <path d="M6.5 2.5v11" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** Wrapped line from DSH's `wrap-fill` icon. */
export function WrapIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z"
        fill="currentColor"
      />
      <path d="M2 15H1V1H2V15Z" fill="currentColor" />
      <path d="M15 15H14V1H15V15Z" fill="currentColor" />
    </svg>
  )
}

/** Unwrapped line from DSH's `nowrap-fill` icon. */
export function NowrapIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 15H1V1H2V15Z" fill="currentColor" />
      <path
        d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z"
        fill="currentColor"
      />
      <path d="M15 15H14V1H15V15Z" fill="currentColor" />
    </svg>
  )
}

/** Check glyph. */
export function CheckIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Compact funnel glyph marking a narrowed history range on the worktree trigger. */
export function FilterIcon() {
  return (
    <svg className="vcs-icon vcs-filter-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 3.5h11l-4.2 5v4l-2.6-1.3V8.5l-4.2-5Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Arrow used for ahead/behind counts. */
export function Arrow({ up = false }) {
  return (
    <svg className="vcs-arrow" viewBox="0 0 8 8" aria-hidden="true" data-up={up ? 'true' : undefined}>
      <path d="M4 1.5v5M1.8 4.4 4 6.6l2.2-2.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
