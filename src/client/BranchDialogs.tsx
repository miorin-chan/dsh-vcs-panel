/**
 * The branch actions that need a decision: local rename, delete, merge, and
 * rebase; remote checkout, delete, merge, and pull.
 *
 * The dialog sits over the panel, names the branch it acts on, and states what
 * the action does before it runs. A local delete that Git reports as not fully
 * merged keeps the dialog open and turns its confirmation into an explicit
 * "delete anyway", so removing unmerged commits is always a second, informed
 * click. Remote checkout asks for the local branch name; remote delete removes
 * the branch for every fetcher. Escape cancels unless the write is already running; focus stays
 * inside the dialog while it is open.
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { ApiFailure } from './api.js'
import type { BranchOpAction } from './branch.js'
import type { BranchDialogRequest, DialogConfirmValues } from './useRepoActions.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage } from './format.js'

/** The copy and confirmation label for one dialog kind. */
interface DialogCopy {
  title: string
  action: string
}

/** Branch operations that confirm through this dialog; `push` runs from the menu. */
type BranchDialogKind = Exclude<BranchOpAction, 'push'>

/** The copy and confirmation label for each branch dialog kind. */
const DIALOG_COPY: Readonly<Record<BranchDialogKind, DialogCopy>> = {
  rename: { title: 'branch.renameTitle', action: 'branch.renameAction' },
  delete: { title: 'branch.deleteTitle', action: 'branch.deleteAction' },
  merge: { title: 'branch.mergeTitle', action: 'branch.mergeAction' },
  rebase: { title: 'branch.rebaseTitle', action: 'branch.rebaseAction' },
  'checkout-remote': { title: 'branch.checkoutRemoteTitle', action: 'branch.checkoutRemoteAction' },
  'delete-remote': { title: 'branch.deleteRemoteTitle', action: 'branch.deleteAction' },
  'merge-remote': { title: 'branch.mergeTitle', action: 'branch.mergeAction' },
  'pull-remote': { title: 'branch.pullTitle', action: 'branch.pullAction' },
}

/** Dialog state and action callbacks for one branch action. */
export interface BranchDialogProps {
  request: BranchDialogRequest | null
  error: ApiFailure | null
  busy: boolean
  blocked?: boolean
  onCancel: () => void
  onConfirm: (values: DialogConfirmValues) => void
  t: Translate
}

/**
 * Render the open branch dialog.
 * The request action id is one of the operations the menu confirms here; `push`
 * runs directly from the menu and never reaches this dialog.
 * @param props - dialog state and callbacks.
 */
export function BranchDialog({ request, error, busy, blocked = false, onCancel, onConfirm, t }: BranchDialogProps) {
  const [name, setName] = useState(
    request?.kind === 'checkout-remote' ? request.local ?? '' : request?.branch ?? '',
  )
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const unmerged = request?.kind === 'delete' && error?.code === 'branch-unmerged'

  // When a local delete bounces as unmerged, move focus back to Cancel so
  // repeating Enter cannot force-delete without a deliberate choice.
  useEffect(() => {
    if (unmerged) cancelRef.current?.focus({ preventScroll: true })
  }, [unmerged])

  if (request === null) return null

  const copy = DIALOG_COPY[request.kind as BranchDialogKind]
  const naming = request.kind === 'rename' || request.kind === 'checkout-remote'
  const destructive = request.kind === 'delete' || request.kind === 'delete-remote'
  const trimmed = name.trim()
  const canSubmit = !busy && !blocked && (
    !naming
    || (trimmed !== '' && (request.kind !== 'rename' || trimmed !== request.branch))
  )
  const confirmLabel = request.kind === 'delete' && unmerged
    ? t('branch.deleteAnyway')
    : t(copy.action)

  const submit = () => {
    if (!canSubmit) return
    if (request.kind === 'rename') onConfirm({ name: trimmed })
    else if (request.kind === 'checkout-remote') onConfirm({ local: trimmed })
    else onConfirm(request.kind === 'delete' ? { force: unmerged } : {})
  }

  return (
    <Dialog
      titleId="vcs-branch-dialog-title"
      busy={busy}
      onCancel={onCancel}
      onSubmit={submit}
    >
      <h2 className="vcs-dialog-title" id="vcs-branch-dialog-title">{t(copy.title)}</h2>
      {request.kind === 'rename' ? (
        <>
          <p className="vcs-dialog-text">{t('branch.renameText', { branch: request.branch })}</p>
          <label className="vcs-dialog-label" htmlFor="vcs-branch-name">{t('branch.newName')}</label>
          <input
            id="vcs-branch-name"
            className="vcs-dialog-input"
            type="text"
            value={name}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={busy}
            data-autofocus=""
            onChange={event => { setName(event.currentTarget.value) }}
          />
        </>
      ) : null}
      {request.kind === 'checkout-remote' ? (
        <>
          <p className="vcs-dialog-text">{t('branch.checkoutRemoteText', { branch: request.branch, remote: request.remote })}</p>
          <label className="vcs-dialog-label" htmlFor="vcs-branch-name">{t('branch.localName')}</label>
          <input
            id="vcs-branch-name"
            className="vcs-dialog-input"
            type="text"
            value={name}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={busy}
            data-autofocus=""
            onChange={event => { setName(event.currentTarget.value) }}
          />
        </>
      ) : null}
      {request.kind === 'delete' ? (
        <>
          <p className="vcs-dialog-text">{t('branch.deleteText', { branch: request.branch })}</p>
          {unmerged ? (
            <p className="vcs-dialog-warning" role="alert">{errorMessage(t, error)}</p>
          ) : null}
        </>
      ) : null}
      {request.kind === 'delete-remote' ? (
        <p className="vcs-dialog-text">{t('branch.deleteRemoteText', { branch: request.branch })}</p>
      ) : null}
      {request.kind === 'merge' || request.kind === 'merge-remote' ? (
        <p className="vcs-dialog-text">{t('branch.mergeText', { branch: request.branch, current: request.current ?? '' })}</p>
      ) : null}
      {request.kind === 'rebase' ? (
        <p className="vcs-dialog-text">{t('branch.rebaseText', { branch: request.branch, current: request.current ?? '' })}</p>
      ) : null}
      {request.kind === 'pull-remote' ? (
        <p className="vcs-dialog-text">{t('branch.pullText', { branch: request.branch, current: request.current ?? '' })}</p>
      ) : null}
      {error !== null && !unmerged ? (
        <p className="vcs-dialog-error" role="alert">{errorMessage(t, error)}</p>
      ) : null}
      {busy ? <p className="vcs-dialog-busy" role="status">{t('branch.working')}</p> : null}
      {!busy && blocked ? <p className="vcs-dialog-busy" role="status">{t('error.busy')}</p> : null}
      <div className="vcs-dialog-actions">
        <button ref={cancelRef} type="button" className="vcs-button" data-autofocus={naming ? undefined : ''} disabled={busy} onClick={onCancel}>
          {t('branch.cancel')}
        </button>
        <button
          type="submit"
          className={`vcs-button${destructive ? ' vcs-button-danger' : ''}`}
          aria-disabled={!canSubmit ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
