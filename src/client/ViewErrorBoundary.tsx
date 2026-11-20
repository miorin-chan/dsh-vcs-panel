/**
 * Contain a VCS view failure inside the panel.
 *
 * DSH renders each Conversation View through a slot entry with its own error
 * boundary. When that boundary catches a render or lifecycle error it removes
 * the entry for the rest of the page, so the view goes blank with no visible
 * recovery. This boundary sits inside the entry: it records the failure and
 * renders a retry surface, keeping the slot entry registered.
 */

import { Component } from 'react'
import type { ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { recordCrash } from './crash.js'
import { Button } from './ui.jsx'

/** The panel translator and the view this boundary guards. */
export interface ViewErrorBoundaryProps {
  t: Translate
  children: ReactNode
}

/** Whether the fallback is showing, and the caught failure's one-line message. */
interface ViewErrorBoundaryState {
  failed: boolean
  message: string
}

/** Read the `message` of a thrown value, or an empty string when it has none. */
function thrownMessage(error: unknown): string {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return ''
  // A thrown value read as a failure record; internal shape shared with `crash.ts`.
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/**
 * Render `children`, or a retry surface when they fail.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  constructor(props: ViewErrorBoundaryProps) {
    super(props)
    this.state = { failed: false, message: '' }
  }

  /**
   * Switch to the fallback for the next render.
   * @param error - the thrown value.
   * @returns the next state.
   */
  static getDerivedStateFromError(error: unknown): ViewErrorBoundaryState {
    // The one-line message is shown in the fallback; the full record is
    // written by componentDidCatch.
    return { failed: true, message: thrownMessage(error) }
  }

  /**
   * Persist the failure for a later look at the session.
   * @param error - the thrown value.
   * @param info - React's error info.
   * @returns void
   */
  componentDidCatch(error: unknown, info: { componentStack?: string }): void {
    recordCrash(globalThis.sessionStorage, error, info)
  }

  /** Return to a fresh view attempt. */
  retry(): void {
    this.setState({ failed: false, message: '' })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const t = this.props.t
    return (
      <div className="vcs-root" data-vcs-crash="" tabIndex={-1}>
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('view.crashed')}</p>
          <p className="vcs-note">{t('view.crashedHint')}</p>
          {this.state.message === '' ? null : (
            <details className="vcs-note">
              <summary>{t('view.crashDetails')}</summary>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' }}>{this.state.message}</pre>
            </details>
          )}
          <Button onClick={() => { this.retry() }}>{t('error.retry')}</Button>
        </div>
      </div>
    )
  }
}
