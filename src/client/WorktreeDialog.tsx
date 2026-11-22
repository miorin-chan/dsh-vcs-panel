import { useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApiFailure, BranchesAnswer, WorktreeCreateMode, WorktreeCreateRequest } from './api.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage } from './format.js'
import { Chevron } from './ui.jsx'
import type { WorktreeDialogRequest } from './useRepoActions.js'
import { worktreeRefLabel } from './worktrees.js'

interface WorktreeDialogProps {
  request: WorktreeDialogRequest
  busy: boolean
  blocked: boolean
  error: ApiFailure | null
  branches: readonly BranchesAnswer['branches'][number][]
  branchesStatus: string
  branchesError: ApiFailure | null
  branchesTruncated: boolean
  loadBranches: () => void
  onCancel: () => void
  onConfirm: (request?: WorktreeCreateRequest) => void
  t: Translate
}

const GIT_MODES: ReadonlyArray<{ value: WorktreeCreateMode; label: string }> = [
  { value: 'new', label: 'worktree.newBranch' },
  { value: 'existing', label: 'worktree.existingBranch' },
  { value: 'detach', label: 'worktree.detach' },
]

const TITLE_ID = 'vcs-worktree-dialog-title'
const FIELD_PROPS = { spellCheck: false, autoComplete: 'off', autoCapitalize: 'off' }

export function WorktreeDialog({
  request, busy, blocked, error, branches, branchesStatus, branchesError, branchesTruncated, loadBranches,
  onCancel, onConfirm, t,
}: WorktreeDialogProps) {
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<WorktreeCreateMode>('new')
  const [name, setName] = useState('')
  const [localBranch, setLocalBranch] = useState('')
  const [typedBranch, setTypedBranch] = useState('')
  const [revision, setRevision] = useState('')
  const modeRef = useRef<HTMLSelectElement | null>(null)
  const { kind, commitBased } = request
  const creating = kind === 'create'
  const existing = creating && !commitBased && mode === 'existing'
  const localAvailable = branchesStatus === 'ready' && branches.some(branch => branch.name === localBranch)
  const existingName = branchesStatus === 'ready' && branchesTruncated && typedBranch.trim() !== ''
    ? typedBranch.trim()
    : localAvailable ? localBranch : ''
  const checkoutReady = !existing || existingName !== ''
  const canSubmit = !busy && !blocked && (!creating || (path.trim() !== '' && checkoutReady))

  useEffect(() => {
    if (existing) loadBranches()
  }, [existing, loadBranches])

  useEffect(() => {
    if (!existing || (error?.code !== 'branch-in-use' && error?.code !== 'branch-invalid')) return
    loadBranches()
  }, [error, existing, loadBranches])

  const titleKey = kind === 'forget' ? 'worktree.forgetWorkspace'
    : kind === 'remove' ? (commitBased ? 'worktree.removeWorkspace' : 'worktree.removeWorktree')
      : commitBased ? 'worktree.createWorkspace' : 'worktree.createWorktree'
  const warningKey = kind === 'forget' ? 'worktree.forgetText'
    : commitBased ? 'worktree.removeWorkspaceText' : 'worktree.removeWorktreeText'
  const actionKey = kind === 'forget' ? 'worktree.forget'
    : kind === 'remove' ? (commitBased ? 'worktree.deleteDirectory' : 'worktree.remove') : 'worktree.create'

  function submit() {
    if (!canSubmit) return
    if (!creating) {
      onConfirm()
      return
    }
    const destination = { action: 'create' as const, path: path.trim() }
    const base = revision.trim()
    if (commitBased) onConfirm({ ...destination, name: name.trim() || undefined, revision: base || undefined })
    else if (mode === 'existing') onConfirm({ ...destination, mode, name: existingName })
    else if (mode === 'detach') onConfirm({ ...destination, mode, revision: base || undefined })
    else onConfirm({ ...destination, mode, name: name.trim() || undefined, revision: base || undefined })
  }

  return (
    <Dialog titleId={TITLE_ID} busy={busy} onCancel={onCancel} onSubmit={submit} className="vcs-worktree-dialog">
      <h2 className="vcs-dialog-title" id={TITLE_ID}>{t(titleKey)}</h2>
      {creating ? (
        <>
          <label className="vcs-dialog-label" htmlFor="vcs-worktree-path">{t('worktree.path')}</label>
          <input
            {...FIELD_PROPS} id="vcs-worktree-path" className="vcs-dialog-input" type="text" data-autofocus=""
            aria-describedby="vcs-worktree-path-hint" placeholder="../topic" value={path} readOnly={busy}
            onChange={event => { setPath(event.currentTarget.value) }}
          />
          <p className="vcs-dialog-text vcs-worktree-path" id="vcs-worktree-path-hint">
            {t('worktree.pathHint', { path: request.repo })}
          </p>
          {!commitBased ? (
            <>
              <label className="vcs-dialog-label" htmlFor="vcs-worktree-mode">{t('worktree.checkout')}</label>
              <span className="vcs-dialog-select">
                <select ref={modeRef} id="vcs-worktree-mode" className="vcs-dialog-input" value={mode} disabled={busy}
                  onChange={event => { setMode(event.currentTarget.value as WorktreeCreateMode) }}>
                  {GIT_MODES.map(({ value, label }) => <option key={value} value={value}>{t(label)}</option>)}
                </select>
                <span className="vcs-dialog-select-caret" aria-hidden="true"><Chevron open /></span>
              </span>
            </>
          ) : null}
          {existing ? (
            <>
              <label className="vcs-dialog-label" htmlFor="vcs-worktree-branch">{t('commit.branchName')}</label>
              <span className="vcs-dialog-select">
                <select id="vcs-worktree-branch" className="vcs-dialog-input" value={localAvailable ? localBranch : ''}
                  disabled={busy || branchesStatus !== 'ready' || branches.length === 0}
                  onChange={event => { setLocalBranch(event.currentTarget.value); setTypedBranch('') }}>
                  <option value="" disabled>{t('worktree.chooseBranch')}</option>
                  {branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                </select>
                <span className="vcs-dialog-select-caret" aria-hidden="true"><Chevron open /></span>
              </span>
              {branchesStatus === 'loading' ? <p className="vcs-dialog-busy" role="status">{t('switch.loading')}</p> : null}
              {branchesError !== null ? (
                <div>
                  <p className="vcs-dialog-error" role="alert">{errorMessage(t, branchesError)}</p>
                  <button type="button" className="vcs-button" onClick={() => {
                    modeRef.current?.focus()
                    loadBranches()
                  }}>{t('error.retry')}</button>
                </div>
              ) : null}
              {branchesStatus === 'ready' && branches.length === 0 && !branchesTruncated
                ? <p className="vcs-dialog-text">{t('worktree.noFreeBranches')}</p> : null}
              {branchesTruncated && branchesStatus === 'ready' ? (
                <>
                  <p className="vcs-dialog-text">{t('worktree.branchesTruncated')}</p>
                  <label className="vcs-dialog-label" htmlFor="vcs-worktree-branch-exact">{t('worktree.exactBranch')}</label>
                  <input
                    {...FIELD_PROPS} id="vcs-worktree-branch-exact" className="vcs-dialog-input" type="text"
                    value={typedBranch} readOnly={busy}
                    onChange={event => { setTypedBranch(event.currentTarget.value); setLocalBranch('') }}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              {commitBased || mode === 'new' ? (
                <>
                  <label className="vcs-dialog-label" htmlFor="vcs-worktree-name">
                    {t(commitBased ? 'worktree.workspaceName' : 'commit.branchName')}
                  </label>
                  <input
                    {...FIELD_PROPS} id="vcs-worktree-name" className="vcs-dialog-input" type="text" value={name} readOnly={busy}
                    placeholder={t('worktree.folderNameDefault')}
                    onChange={event => { setName(event.currentTarget.value) }}
                  />
                </>
              ) : null}
              <label className="vcs-dialog-label" htmlFor="vcs-worktree-revision">
                {t(commitBased ? 'worktree.parent' : 'worktree.base')}
              </label>
              <input
                {...FIELD_PROPS} id="vcs-worktree-revision" className="vcs-dialog-input" type="text" value={revision} readOnly={busy}
                placeholder={commitBased ? t('worktree.defaultParent') : 'HEAD'}
                onChange={event => { setRevision(event.currentTarget.value) }}
              />
            </>
          )}
        </>
      ) : (
        <>
          <p className="vcs-dialog-text vcs-worktree-path">
            <strong>{request.tree.name}</strong><br />{request.tree.path}
            {!commitBased ? <><br />{worktreeRefLabel(request.tree, t)}</> : null}
          </p>
          <p className={kind === 'remove' ? 'vcs-dialog-warning' : 'vcs-dialog-text'}>{t(warningKey)}</p>
        </>
      )}
      {error !== null ? <p className="vcs-dialog-error" role="alert">{errorMessage(t, error)}</p> : null}
      {busy ? <p className="vcs-dialog-busy" role="status">{t('worktree.working')}</p> : null}
      {!busy && blocked ? <p className="vcs-dialog-busy" role="status">{t('error.busy')}</p> : null}
      <div className="vcs-dialog-actions">
        <button type="button" className="vcs-button" data-autofocus={creating ? undefined : ''}
          aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel() }}>
          {t('branch.cancel')}
        </button>
        <button type="submit" className={`vcs-button${kind === 'remove' ? ' vcs-button-danger' : ''}`}
          aria-disabled={!canSubmit || undefined} aria-busy={busy || undefined}>
          {t(actionKey)}
        </button>
      </div>
    </Dialog>
  )
}
