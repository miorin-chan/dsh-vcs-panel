/**
 * The commit actions that need a decision: tag, branch, checkout, pick,
 * revert, drop, merge, rebase, and reset.
 *
 * Every dialog names the commit it acts on and states what the action does.
 * Tag and branch ask for the new name; reset chooses how much of the index
 * and working tree to keep. Drop, reset, rebase, and the other history
 * writes say that a conflict or dirty tree leaves the branch unchanged.
 * Escape cancels unless the write is already running.
 */

import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { ApiFailure } from './api.js'
import type { DialogConfirmValues, CommitDialogRequest } from './useRepoActions.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage } from './format.js'
import { COMMIT_BUSY_KEYS } from './commit.js'
import { validNewBranchName } from './branch.js'
import { Chevron } from './ui.jsx'

/** Copy for each commit dialog kind. */
const DIALOG_COPY = {
  tag: { title: 'commit.addTagTitle', text: 'commit.addTagText', action: 'commit.addTagAction' },
  branch: { title: 'commit.createBranchTitle', text: 'commit.createBranchText', action: 'commit.createBranchAction' },
  checkout: { title: 'commit.checkoutTitle', text: 'commit.checkoutText', action: 'commit.checkoutAction' },
  'cherry-pick': { title: 'commit.cherryPickTitle', text: 'commit.cherryPickText', action: 'commit.cherryPickAction' },
  revert: { title: 'commit.revertTitle', text: 'commit.revertText', action: 'commit.revertAction' },
  drop: { title: 'commit.dropTitle', text: 'commit.dropText', action: 'commit.dropAction' },
  merge: { title: 'commit.mergeTitle', text: 'commit.mergeText', action: 'commit.mergeAction' },
  rebase: { title: 'commit.rebaseTitle', text: 'commit.rebaseText', action: 'commit.rebaseAction' },
  reset: { title: 'commit.resetTitle', text: 'commit.resetText', action: 'commit.resetAction' },
}

/** One reset mode as the dialog's select lists it. */
interface ResetModeRow {
  value: string
  label: string
}

/** Reset modes in the order the dialog lists them. */
const RESET_MODES: readonly ResetModeRow[] = [
  { value: 'soft', label: 'commit.resetSoft' },
  { value: 'mixed', label: 'commit.resetMixed' },
  { value: 'hard', label: 'commit.resetHard' },
]

/** Explicit hint key lookup per reset mode so i18n checks see literal keys. */
const RESET_HINT_KEYS: Readonly<Record<string, string>> = {
  soft: 'commit.resetSoftHint',
  mixed: 'commit.resetMixedHint',
  hard: 'commit.resetHardHint',
}

/** Dialog state and action callbacks for one commit action. */
export interface CommitDialogProps {
  request: CommitDialogRequest | null
  error: ApiFailure | null
  busy: boolean
  blocked?: boolean
  onCancel: () => void
  onConfirm: (values: DialogConfirmValues) => void
  t: Translate
}

/**
 * Render the open commit dialog.
 * @param props - dialog state and callbacks.
 */
export function CommitDialog({ request, error, busy, blocked = false, onCancel, onConfirm, t }: CommitDialogProps) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [checkout, setCheckout] = useState(false)
  const [mode, setMode] = useState('soft')

  if (request === null) return null

  const copy = DIALOG_COPY[request.kind]
  const needsName = request.kind === 'tag' || request.kind === 'branch'
  const destructive = request.kind === 'drop' || (request.kind === 'reset' && mode === 'hard')
  const trimmed = name.trim()
  const canSubmit = !busy && !blocked && (!needsName || trimmed !== '')
    && (request.kind !== 'branch' || validNewBranchName(trimmed)) && (request.kind !== 'reset' || mode !== '')

  const submit = () => {
    if (!canSubmit) return
    if (request.kind === 'tag') onConfirm({ name: trimmed, message: message.trim() })
    else if (request.kind === 'branch') onConfirm({ name: trimmed, checkout })
    else if (request.kind === 'reset') onConfirm({ mode })
    else onConfirm({})
  }

  return (
    <Dialog
      titleId="vcs-commit-dialog-title"
      busy={busy}
      onCancel={onCancel}
      onSubmit={submit}
    >
      <h2 className="vcs-dialog-title" id="vcs-commit-dialog-title">{t(copy.title)}</h2>
      {typeof request.subject === 'string' && request.subject !== '' ? (
        <p className="vcs-dialog-commit" title={request.subject}>
          <code>{request.shortSha}</code>
          <span>{request.subject}</span>
        </p>
      ) : null}
      <p className="vcs-dialog-text">
        {t(copy.text, { sha: request.shortSha, current: request.current ?? '' })}
      </p>
      {request.kind === 'tag' ? (
        <>
          <label className="vcs-dialog-label" htmlFor="vcs-tag-name">{t('commit.tagName')}</label>
          <input
            id="vcs-tag-name"
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
          <label className="vcs-dialog-label" htmlFor="vcs-tag-message">{t('commit.tagMessage')}</label>
          <input
            id="vcs-tag-message"
            className="vcs-dialog-input"
            type="text"
            value={message}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={busy}
            onChange={event => { setMessage(event.currentTarget.value) }}
          />
        </>
      ) : null}
      {request.kind === 'branch' ? (
        <>
          <label className="vcs-dialog-label" htmlFor="vcs-new-branch-name">{t('commit.branchName')}</label>
          <input
            id="vcs-new-branch-name"
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
          <label className="vcs-dialog-check" htmlFor="vcs-new-branch-checkout">
            <input
              id="vcs-new-branch-checkout"
              type="checkbox"
              checked={checkout}
              disabled={busy}
              onChange={event => { setCheckout(event.currentTarget.checked) }}
            />
            <span>{t('commit.checkoutNewBranch')}</span>
          </label>
        </>
      ) : null}
      {request.kind === 'reset' ? (
        <>
          <label className="vcs-dialog-label" htmlFor="vcs-reset-mode">{t('commit.resetMode')}</label>
          <span className="vcs-dialog-select">
            <select
              id="vcs-reset-mode"
              className="vcs-dialog-input"
              value={mode}
              disabled={busy}
              data-autofocus=""
              onChange={event => { setMode(event.currentTarget.value) }}
            >
              {RESET_MODES.map(entry => <option key={entry.value} value={entry.value}>{t(entry.label)}</option>)}
            </select>
            <span className="vcs-dialog-select-caret" aria-hidden="true"><Chevron open /></span>
          </span>
          <p className={mode === 'hard' ? 'vcs-dialog-warning' : 'vcs-dialog-busy'} role={mode === 'hard' ? 'alert' : undefined}>
            {t(RESET_HINT_KEYS[mode] ?? 'commit.resetSoftHint')}
          </p>
        </>
      ) : null}
      {error !== null ? <p className="vcs-dialog-error" role="alert">{errorMessage(t, error)}</p> : null}
      {busy ? <p className="vcs-dialog-busy" role="status">{t(COMMIT_BUSY_KEYS[request.kind] ?? 'commit.working')}</p> : null}
      {!busy && blocked ? <p className="vcs-dialog-busy" role="status">{t('error.busy')}</p> : null}
      <div className="vcs-dialog-actions">
        <button
          type="button"
          className="vcs-button"
          data-autofocus={needsName || request.kind === 'reset' ? undefined : ''}
          disabled={busy}
          onClick={onCancel}
        >
          {t('branch.cancel')}
        </button>
        <button
          type="submit"
          className={`vcs-button${destructive ? ' vcs-button-danger' : ''}`}
          aria-disabled={!canSubmit ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
        >
          {t(copy.action)}
        </button>
      </div>
    </Dialog>
  )
}
