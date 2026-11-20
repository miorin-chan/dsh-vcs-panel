/**
 * The two tag actions that need a decision: delete and push.
 *
 * Deleting names the tag and states that only the local ref goes away.
 * Pushing names the tag and asks for one of the repository's remotes; the
 * remote list is loaded when the dialog opens, and a push is refused rather
 * than forced when the remote already has a different tag. Escape cancels
 * unless the write is already running; focus stays inside the dialog.
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { ApiFailure } from './api.js'
import type { DialogConfirmValues, TagDialogRequest, TagRemotesState } from './useRepoActions.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage, formatPlural } from './format.js'
import { Chevron } from './ui.jsx'

/** Dialog, remote-list, and action state for one tag action. */
export interface TagDialogProps {
  request: TagDialogRequest | null
  error: ApiFailure | null
  busy: boolean
  blocked?: boolean
  remotes: TagRemotesState
  onCancel: () => void
  onConfirm: (values: DialogConfirmValues) => void
  t: Translate
  locale?: string
}

/**
 * Render the open tag dialog.
 * @param props - dialog, remote-list, and action state.
 */
export function TagDialog({ request, error, busy, blocked = false, remotes, onCancel, onConfirm, t, locale }: TagDialogProps) {
  const [remote, setRemote] = useState('')
  const remoteRef = useRef<HTMLSelectElement | null>(null)

  // Keep a valid choice as the remote list arrives or changes.
  useEffect(() => {
    if (request?.kind !== 'push' || remotes.status !== 'ready') return
    if (remotes.list.includes(remote)) return
    setRemote(remotes.list.includes('origin') ? 'origin' : remotes.list[0] ?? '')
  }, [remote, remotes.list, remotes.status, request?.kind])

  // The dialog opens while the remotes are still loading, so the shell first
  // lands on Cancel. Once the list is ready, the remote choice takes focus.
  useEffect(() => {
    if (request?.kind !== 'push' || remotes.status !== 'ready' || remotes.list.length === 0) return
    remoteRef.current?.focus()
  }, [remotes.list.length, remotes.status, request?.kind])

  if (request === null) return null

  const pushing = request.kind === 'push'
  const loading = pushing && remotes.status !== 'ready' && remotes.status !== 'error'
  const failed = pushing && remotes.status === 'error'
  const empty = pushing && remotes.status === 'ready' && remotes.list.length === 0
  const canSubmit = !busy && !blocked && (!pushing || (remotes.status === 'ready' && remote !== ''))
  const title = pushing ? t('tag.pushTitle') : t('tag.deleteTitle')

  const submit = () => {
    if (!canSubmit) return
    onConfirm(pushing ? { remote } : {})
  }

  return (
    <Dialog
      titleId="vcs-tag-dialog-title"
      busy={busy}
      onCancel={onCancel}
      onSubmit={submit}
    >
      <h2 className="vcs-dialog-title" id="vcs-tag-dialog-title">{title}</h2>
      <p className="vcs-dialog-text">
        {pushing
          ? t('tag.pushText', { tag: request.tag })
          : t('tag.deleteText', { tag: request.tag })}
      </p>
      {pushing ? (
        <>
          <label className="vcs-dialog-label" htmlFor="vcs-tag-remote">{t('tag.remote')}</label>
          <span className="vcs-dialog-select">
            <select
              ref={remoteRef}
              id="vcs-tag-remote"
              className="vcs-dialog-input"
              value={remote}
              title={remote || undefined}
              disabled={busy || loading || failed || empty}
              data-autofocus={remotes.status === 'ready' && remotes.list.length > 0 ? '' : undefined}
              onChange={event => { setRemote(event.currentTarget.value) }}
            >
              {remotes.list.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <span className="vcs-dialog-select-caret" aria-hidden="true"><Chevron open /></span>
          </span>
          {loading ? <p className="vcs-dialog-busy" role="status">{t('tag.remotesLoading')}</p> : null}
          {failed ? <p className="vcs-dialog-error" role="alert">{errorMessage(t, remotes.error)}</p> : null}
          {empty ? <p className="vcs-dialog-warning" role="alert">{t('tag.noRemotes')}</p> : null}
          {remotes.truncated ? <p className="vcs-dialog-busy">{formatPlural(t, 'tag.remotesTruncated', remotes.list.length, locale)}</p> : null}
        </>
      ) : null}
      {error !== null ? <p className="vcs-dialog-error" role="alert">{errorMessage(t, error)}</p> : null}
      {busy ? <p className="vcs-dialog-busy" role="status">{t('tag.working')}</p> : null}
      {!busy && blocked ? <p className="vcs-dialog-busy" role="status">{t('error.busy')}</p> : null}
      <div className="vcs-dialog-actions">
        <button type="button" className="vcs-button" data-autofocus={pushing && remotes.status === 'ready' && remotes.list.length > 0 ? undefined : ''} disabled={busy} onClick={onCancel}>
          {t('branch.cancel')}
        </button>
        <button
          type="submit"
          className={`vcs-button${pushing ? '' : ' vcs-button-danger'}`}
          aria-disabled={!canSubmit ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
        >
          {pushing ? t('tag.pushAction') : t('tag.deleteAction')}
        </button>
      </div>
    </Dialog>
  )
}
