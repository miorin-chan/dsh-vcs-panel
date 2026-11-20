/**
 * Turn-tail banner for a completed Turn that changed files.
 *
 * Replaces DSH's per-turn changed-files card with one full-width banner whose
 * target is the version control panel in the right Sidebar: the branch glyph,
 * the branch or `@` on which that turn ran, and that turn's changed-file count
 * on the left; that turn's `+added` / `−deleted` pair and a popout icon on the
 * right. The definition in `turn.js` decides whether the banner appears, and
 * `turn-summary.js` reads the recorded per-turn summary once.
 */

import type { ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import { formatCount, formatPlural, shortChangeId } from './format.js'
import { turnChangedFiles } from './turn.js'
import type { TrackedTurn } from './turn.js'
import type { TurnHead, TurnSummary } from './turn-summary.js'

/** Drawn size and class of the branch glyph. */
export interface GitBranchIconProps {
  size?: number
  className?: string
}

/**
 * The git-branch glyph, drawn inline so the bundle needs no icon package. The
 * Sidebar guide entry draws the same glyph; `size` and `className` let each
 * surface supply its own box.
 * @param props - drawn size and class.
 * @returns the glyph.
 */
export function GitBranchIcon({ size = 16, className }: GitBranchIconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.55" />
      <circle cx="4.5" cy="12.5" r="1.55" />
      <circle cx="11.5" cy="5.5" r="1.55" />
      <path d="M4.5 5.05v5.9" />
      <path d="M11.5 7.05c0 2.2-2.3 2.55-4.45 3.1" />
    </svg>
  )
}

/** Popout glyph indicating that activating the banner opens the Sidebar panel. */
function PopoutIcon() {
  return (
    <svg className="vcs-turn-popout" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V9" />
      <path d="M9.5 3H13v3.5" />
      <path d="M13 3 7.5 8.5" />
    </svg>
  )
}

/** The change totals a recorded summary may carry. */
interface TurnCounts {
  readonly changed: number
  readonly added: number
  readonly deleted: number
}

/** Read a summary's change totals, or null while they are unknown. */
function countsOf(summary: TurnSummary | null): TurnCounts | null {
  if (
    summary === null
    || typeof summary.changed !== 'number'
    || typeof summary.added !== 'number'
    || typeof summary.deleted !== 'number'
  ) return null
  return { changed: summary.changed, added: summary.added, deleted: summary.deleted }
}

/** The rendered and textual head pointer, or an empty pair when there is none. */
interface RenderedHead {
  node: ReactNode
  text: string
}

/** Describe the head pointer for assistive text and render its inline tokens. */
function renderHead(head: TurnHead | null | undefined, t: Translate): RenderedHead {
  if (head === null || head === undefined) return { node: null, text: '' }
  if (head.kind === 'workingCopy') {
    const shortId = typeof head.changeId === 'string' && head.changeId !== ''
      ? shortChangeId(head.changeId)
      : null
    return {
      text: shortId === null ? '@' : `@ ${shortId}`,
      node: (
        <span className="vcs-turn-working">
          <span className="vcs-working-badge">@</span>
          {shortId === null ? null : <code className="vcs-turn-change">{shortId}</code>}
        </span>
      ),
    }
  }
  const text = head.kind === 'unborn'
    ? t('top.unborn')
    : head.kind === 'detached'
      ? t('top.detached')
      : head.name
  return {
    text,
    node: <span className="vcs-turn-head">{text}</span>,
  }
}

/** Turn Location, per-turn summary, localized copy, and the view opener. */
export interface TurnTailChangesProps {
  /** Turn Location with this definition's data. */
  turn: TrackedTurn
  /** The recorded turn state, or null while it is unknown. */
  summary?: TurnSummary | null
  /** Active BCP 47 locale for number grouping and plural rules. */
  locale?: string
  /** This plugin's translator. */
  t: Translate
  /** Opens the version control panel in the Sidebar. */
  onOpen: () => void
}

/**
 * Render the VCS banner at the end of a Turn.
 * @param props - Turn Location, per-turn summary, localized copy, and the view opener.
 * @returns the banner, or null when the Turn made no net changes.
 */
export function TurnTailChanges({ turn, summary = null, locale, t, onOpen }: TurnTailChangesProps) {
  if (!turnChangedFiles(turn)) return null
  const counts = countsOf(summary)
  if (counts !== null && counts.changed <= 0) return null

  const hint = t('turn.openHint')
  const head = summary === null ? { node: null, text: '' } : renderHead(summary.head, t)
  const leftText = counts === null ? hint : formatPlural(t, 'turn.filesChanged', counts.changed, locale)
  const added = counts === null ? null : formatCount(counts.added, locale)
  const deleted = counts === null ? null : formatCount(counts.deleted, locale)
  const openLabel = counts === null ? hint : t('turn.openSummary', { added, deleted })
  const label = counts === null
    ? [head.text, hint].filter(part => part !== '').join(' · ')
    : [head.text, leftText, openLabel].filter(part => part !== '').join(' · ')
  return (
    <div className="vcs-turn-tail">
      <button type="button" className="vcs-turn-banner" title={hint} aria-label={label} onClick={onOpen}>
        <span className="vcs-turn-left" aria-hidden="true">
          <GitBranchIcon className="vcs-turn-glyph" />
          {head.node === null ? null : (
            <>
              {head.node}
              <span className="vcs-turn-sep">·</span>
            </>
          )}
          <span className="vcs-turn-files">{leftText}</span>
        </span>
        <span className="vcs-turn-right" aria-hidden="true">
          {counts === null ? null : (
            <span className="vcs-turn-stat">
              <span className="vcs-add">+{added}</span>
              <span className="vcs-del">−{deleted}</span>
            </span>
          )}
          <PopoutIcon />
        </span>
      </button>
    </div>
  )
}
