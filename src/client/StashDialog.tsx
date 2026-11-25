/** One modal for saving, applying, recovering, or discarding a Git stash. */

import { useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { StashCheck, StashDetail, StashRequest } from '../lib/stash-types.js'
import { STASH_MESSAGE_MAX } from '../lib/stash-types.js'
import type { Api, ApiFailure } from './api.js'
import { failureOf } from './api.js'
import { validNewBranchName } from './branch.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage, formatCount, formatPlural, shortSha } from './format.js'
import { STASH_BLOCK_COPY, stashCheckView } from './stash.js'
import { CheckIcon, RefBadge } from './ui.jsx'
import type { StashDialogRequest } from './useRepoActions.js'

const COPY = {
  push: { title: 'stash.saveTitle', confirm: 'stash.saveConfirm' },
  apply: { title: 'stash.applyTitle', confirm: 'stash.applyConfirm' },
  branch: { title: 'stash.branchTitle', confirm: 'stash.branchConfirm' },
  drop: { title: 'stash.dropTitle', confirm: 'stash.dropConfirm' },
} as const

const VISIBLE_PATHS = 5

function CheckResult({ view, t, locale }: { view: ReturnType<typeof stashCheckView>; t: Translate; locale?: string }) {
  const { block, state } = view
  return (
    <div className="vcs-stash-check" data-state={state} role="status" aria-busy={state === 'checking' || undefined}>
      <div className="vcs-stash-check-message">
        {state === 'ok' ? <CheckIcon /> : block !== null ? <span className="vcs-stash-check-diamond" aria-hidden="true" /> : null}
        <span>{t(block !== null ? STASH_BLOCK_COPY[block.reason] : state === 'ok' ? 'stash.checkOk' : 'stash.checking')}</span>
      </div>
      {block !== null && block.paths.length > 0 ? (
        <ul className="vcs-stash-paths">
          {block.paths.slice(0, VISIBLE_PATHS).map(path => <li key={path} title={path}>{path}</li>)}
          {block.paths.length > VISIBLE_PATHS ? (
            <li className="vcs-stash-more-paths">
              {formatPlural(t, 'stash.morePaths', block.paths.length - VISIBLE_PATHS, locale)}
              {block.pathsTruncated ? '…' : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

interface StashDialogProps {
  api: Api
  request: StashDialogRequest
  error: ApiFailure | null
  busy: boolean
  blocked: boolean
  onCancel: () => void
  onConfirm: (request: StashRequest) => void
  onBranch: () => void
  onClearError: () => void
  onMissing: (repo: string) => void
  t: Translate
  locale?: string
}

/** The caller keys the dialog by action and stash id so a branch shortcut gets a fresh input. */
export function StashDialog({
  api, request, error, busy, blocked, onCancel, onConfirm, onBranch, onClearError, onMissing, t, locale,
}: StashDialogProps) {
  const { kind, repo, current } = request
  const target = kind === 'push' ? null : request.stash
  const cachedDetail = kind === 'push' ? undefined : request.detail
  const [detail, setDetail] = useState<StashDetail | undefined>(cachedDetail)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const [restoreIndex, setRestoreIndex] = useState(true)
  const [dropAfter, setDropAfter] = useState(true)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<StashCheck | null>(null)
  const [previewError, setPreviewError] = useState<ApiFailure | null>(null)
  const sha = target?.sha
  const canRestoreIndex = kind === 'apply' && (detail?.staged ?? 0) > 0
  const index = canRestoreIndex && restoreIndex
  const mode = kind === 'branch' || (kind === 'apply' && detail !== undefined) ? kind : null

  useEffect(() => {
    if (kind !== 'apply' || sha === undefined || cachedDetail !== undefined) return undefined
    const controller = new AbortController()
    api.stash(repo, sha, controller.signal).then(({ stash }) => {
      if (!controller.signal.aborted) setDetail(stash)
    }).catch(error => {
      if (controller.signal.aborted) return
      const failure = failureOf(error)
      setPreviewError(failure)
      if (failure.code === 'stash-missing') onMissing(repo)
    })
    return () => { controller.abort() }
  }, [api, cachedDetail, kind, onMissing, repo, sha])

  useEffect(() => {
    if (mode === null || sha === undefined) return undefined
    const controller = new AbortController()
    setPreview(null)
    setPreviewError(null)
    api.stashCheck(repo, sha, mode, index, controller.signal).then(result => {
      if (!controller.signal.aborted) setPreview(result)
    }).catch(error => {
      if (controller.signal.aborted) return
      const failure = failureOf(error)
      setPreviewError(failure)
      if (failure.code === 'stash-missing') onMissing(repo)
    })
    return () => { controller.abort() }
  }, [api, index, mode, onMissing, repo, sha])

  const view = stashCheckView(preview, error?.stashBlock)
  const failure = previewError ?? (error?.stashBlock === undefined ? error : null)
  const toSave = kind === 'push' ? request.summary.changed - (includeUntracked ? 0 : request.summary.untracked) : 0
  const added = kind === 'push' ? request.summary.added + (includeUntracked ? request.summary.untrackedAdded ?? 0 : 0) : 0
  const detached = current ?? t('top.detached')
  const validName = validNewBranchName(name.trim())
  const canConfirm = !busy && !blocked && (kind === 'drop'
    || (kind === 'push' && toSave > 0)
    || ((kind === 'apply' || kind === 'branch') && previewError === null && view.canConfirm && (kind !== 'branch' || validName)))
  const submit = () => {
    if (!canConfirm) return
    if (kind === 'push') onConfirm({ action: 'push', message: message.trim() || undefined, untracked: includeUntracked })
    else if (kind === 'apply') onConfirm({ action: 'apply', sha: request.stash.sha, index, drop: dropAfter })
    else if (kind === 'branch') onConfirm({ action: 'branch', sha: request.stash.sha, name: name.trim() })
    else onConfirm({ action: 'drop', sha: request.stash.sha })
  }

  return (
    <Dialog titleId="vcs-stash-dialog-title" busy={busy} onCancel={onCancel} onSubmit={submit} className="vcs-stash-dialog">
      <h2 className="vcs-dialog-title" id="vcs-stash-dialog-title">{t(COPY[kind].title)}</h2>
      {kind === 'push' ? (
        <>
          <p className="vcs-dialog-commit">
            <span title={detached}>{detached}</span>
            <span>{formatPlural(t, 'detail.fileCount', toSave, locale)}</span>
            {added > 0 ? <span className="vcs-add">+{formatCount(added, locale)}</span> : null}
            {request.summary.deleted > 0 ? <span className="vcs-del">−{formatCount(request.summary.deleted, locale)}</span> : null}
          </p>
          <label className="vcs-dialog-label" htmlFor="vcs-stash-message">{t('stash.message')}</label>
          <input id="vcs-stash-message" className="vcs-dialog-input" type="text" value={message} maxLength={STASH_MESSAGE_MAX}
            placeholder={t('stash.messagePlaceholder')} autoComplete="off" data-autofocus="" disabled={busy}
            onChange={event => { setMessage(event.currentTarget.value) }} />
          {request.summary.untracked > 0 ? (
            <label className="vcs-dialog-check">
              <input type="checkbox" checked={includeUntracked} disabled={busy} onChange={event => { setIncludeUntracked(event.currentTarget.checked) }} />
              <span>{formatPlural(t, 'stash.includeUntracked', request.summary.untracked, locale)}</span>
            </label>
          ) : null}
          <p className="vcs-dialog-text">{t('stash.saveBody')}</p>
          {error?.stashBlock === undefined ? null : <CheckResult view={view} t={t} locale={locale} />}
        </>
      ) : (
        <>
          <p className="vcs-dialog-commit" title={request.stash.message}>
            <RefBadge reference={{ kind: 'stash', name: request.stash.selector }} />
            <span>{request.stash.message || t('stash.untitled')}</span>
            {kind === 'drop' && detail !== undefined
              ? <span>{formatPlural(t, 'detail.fileCount', detail.files.length, locale)}</span> : null}
          </p>
          {kind === 'apply' ? (
            <>
              <p className="vcs-dialog-text">{t('stash.applyTarget', { branch: detached })}</p>
              {preview !== null && !preview.baseIsHead ? (
                <p className="vcs-dialog-text">{t('stash.applyMerge', {
                  base: shortSha(request.stash.base), head: preview.head === null ? t('top.unborn') : shortSha(preview.head),
                })}</p>
              ) : null}
            </>
          ) : null}
          {kind === 'branch' ? (
            <>
              <label className="vcs-dialog-label" htmlFor="vcs-stash-branch">{t('stash.branchName')}</label>
              <input id="vcs-stash-branch" className="vcs-dialog-input" type="text" value={name}
                autoComplete="off" spellCheck={false} autoCapitalize="off" data-autofocus="" disabled={busy}
                aria-invalid={name.trim() !== '' && !validName || undefined}
                onChange={event => { setName(event.currentTarget.value) }} />
              <p className="vcs-dialog-text">{t('stash.branchBody', { base: shortSha(request.stash.base) })}</p>
            </>
          ) : null}
          {kind === 'drop' ? <p className="vcs-dialog-text">{t('stash.dropBody')}</p> : null}
          {(kind === 'apply' || kind === 'branch') && previewError === null ? <CheckResult view={view} t={t} locale={locale} /> : null}
          {kind === 'apply' ? (
            <>
              {canRestoreIndex ? (
                <label className="vcs-dialog-check">
                  <input type="checkbox" checked={restoreIndex} disabled={busy}
                    onChange={event => {
                      onClearError()
                      setPreview(null)
                      setRestoreIndex(event.currentTarget.checked)
                    }} />
                  <span>{t('stash.restoreIndex')}</span>
                </label>
              ) : null}
              <label className="vcs-dialog-check">
                <input type="checkbox" checked={dropAfter} disabled={busy} onChange={event => { setDropAfter(event.currentTarget.checked) }} />
                <span>{t('stash.dropAfter')}</span>
              </label>
            </>
          ) : null}
        </>
      )}
      {failure === null ? null : <p className="vcs-dialog-error" role="alert">{errorMessage(t, failure)}</p>}
      {busy || blocked ? <p className="vcs-dialog-busy" role="status">{t(busy ? 'stash.working' : 'error.busy')}</p> : null}
      <div className="vcs-dialog-actions">
        {kind === 'apply' && view.offerBranch ? <button type="button" className="vcs-button" disabled={busy} onClick={onBranch}>{t('stash.branch')}</button> : null}
        <button type="button" className="vcs-button" data-autofocus={kind === 'apply' || kind === 'drop' ? '' : undefined}
          disabled={busy} onClick={onCancel}>{t('branch.cancel')}</button>
        <button type="submit" className={kind === 'drop' ? 'vcs-button vcs-button-danger' : 'vcs-button'}
          aria-disabled={!canConfirm || undefined} aria-busy={busy || undefined}>{t(COPY[kind].confirm)}</button>
      </div>
    </Dialog>
  )
}
