import { useEffect, useRef, useState } from 'react'

import { Dialog } from './Dialog.jsx'
import { errorMessage } from './format.js'

function sameEntries(a, b) {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index].path)
}

function ConfigEntries({ title, entries, disabled, onRemove, t }) {
  return (
    <section className="vcs-repository-section">
      <h4>{title}</h4>
      {entries.length === 0 ? <p>{t('repositoryConfig.none')}</p> : (
        <ul>
          {entries.map(entry => (
            <li key={entry.path}>
              <div><code>{entry.path}</code>{entry.available ? null : <small>{t('repositoryConfig.unavailable')}</small>}</div>
              <button type="button" className="vcs-button" disabled={disabled}
                aria-label={t('repositoryConfig.removePath', { path: entry.path })} onClick={() => onRemove(entry.path)}>
                {t('repositoryConfig.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RepositorySources({ cwd, repositories, t }) {
  if (repositories.length === 0) return null
  const root = cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  return (
    <section className="vcs-repository-section">
      <h4>{t('repositoryConfig.discovered')}</h4>
      <ul className="vcs-repository-sources" tabIndex={0} aria-label={t('repositoryConfig.discovered')}>
        {repositories.map(repository => {
          const path = repository.path.replaceAll('\\', '/')
          const relativePath = root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : repository.path
          return (
            <li key={repository.path} title={repository.path}>
              <div>
                <code>{repository.name}</code>
                {relativePath === repository.name ? null : <small>{relativePath}</small>}
                {(repository.sources ?? [{ kind: 'default' }]).map(source => (
                  <small key={`${source.kind}:${source.path ?? ''}`}>
                    {source.kind === 'directory' ? t('repositoryConfig.sourceDirectory', { path: source.path })
                      : source.kind === 'repository' ? t('repositoryConfig.sourceRepository', { path: source.path })
                        : t('repositoryConfig.sourceDefault')}
                  </small>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Edit the rules for this session root. The Host owns validation and revision checks. */
export function RepositoryConfigDialog({ api, cwd, repositories, onCancel, onSaved, t }) {
  const headingRef = useRef(null)
  const pathRef = useRef(null)
  const previewRef = useRef(null)
  const savingRef = useRef(false)
  const lifetime = useRef(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [config, setConfig] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [kind, setKind] = useState('directory')
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    api.repositoryConfig(controller.signal).then(result => {
      if (controller.signal.aborted) return
      setConfig(result)
      setDraft({ scanDirectories: result.scanDirectories, repositories: result.repositories })
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error)
    })
    return () => {
      controller.abort()
      previewRef.current?.abort()
    }
  }, [api, loadAttempt])

  const conflict = saveError?.code === 'repository-config-conflict'
  const configError = config?.error ? { code: config.error } : null
  const editable = draft !== null && configError === null && !conflict
  const editing = editable && !saving
  const changed = config !== null && draft !== null && (
    !sameEntries(draft.scanDirectories, config.scanDirectories) || !sameEntries(draft.repositories, config.repositories)
  )
  const property = kind === 'directory' ? 'scanDirectories' : 'repositories'
  const duplicate = draft?.[property].some(entry => entry.path === path)
  const canPreview = editing && path !== '' && !duplicate && !previewing
  const canAdd = editing && preview !== null && (kind === 'directory' || preview.repositories.length === 1)
  const canSave = editing && changed

  const clearPreview = () => {
    previewRef.current?.abort()
    previewRef.current = null
    setPreview(null)
    setPreviewError(null)
    setPreviewing(false)
  }

  const reload = () => {
    headingRef.current?.focus()
    clearPreview()
    setPath('')
    setConfig(null)
    setDraft(null)
    setLoadError(null)
    setSaveError(null)
    setLoadAttempt(value => value + 1)
  }

  const checkPath = async () => {
    if (!canPreview) return
    clearPreview()
    const controller = new AbortController()
    previewRef.current = controller
    setPreviewing(true)
    try {
      const result = await api.repositoryPreview(path, kind, controller.signal)
      if (!controller.signal.aborted) setPreview(result)
    } catch (error) {
      if (!controller.signal.aborted) setPreviewError(error)
    } finally {
      if (previewRef.current === controller) {
        previewRef.current = null
        setPreviewing(false)
      }
    }
  }

  const add = () => {
    if (!canAdd) return
    setDraft(previous => ({
      ...previous,
      [property]: [...previous[property], { path, available: true }],
    }))
    clearPreview()
    setPath('')
    pathRef.current?.focus()
  }

  const remove = (field, removedPath) => {
    setDraft(previous => ({ ...previous, [field]: previous[field].filter(entry => entry.path !== removedPath) }))
    pathRef.current?.focus()
  }

  const save = async () => {
    if (!canSave || savingRef.current) return
    const controller = lifetime.current
    savingRef.current = true
    headingRef.current?.focus()
    clearPreview()
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.saveRepositoryConfig(
        config.revision,
        draft.scanDirectories.map(entry => entry.path),
        draft.repositories.map(entry => entry.path),
      )
      if (!controller.signal.aborted) {
        if (result.error) setSaveError({ code: result.error })
        else onSaved()
      }
    } catch (error) {
      if (!controller.signal.aborted) setSaveError(error)
    } finally {
      savingRef.current = false
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return (
    <Dialog titleId="vcs-repository-config-title" busy={saving} onCancel={onCancel} onSubmit={save}>
      <h3 ref={headingRef} className="vcs-dialog-title" id="vcs-repository-config-title" tabIndex={-1} data-autofocus="">
        {t('repositoryConfig.manage')}
      </h3>
      {cwd ? <p className="vcs-dialog-text vcs-repository-scope" title={cwd}>{t('repositoryConfig.scope', { path: cwd })}</p> : null}
      <div className="vcs-repository-body">
        {config === null && loadError === null ? <p className="vcs-dialog-busy" role="status">{t('repositoryConfig.loading')}</p> : null}
        {draft === null ? null : (
          <>
            <ConfigEntries title={t('repositoryConfig.directories')} entries={draft.scanDirectories} disabled={!editing}
              onRemove={removedPath => remove('scanDirectories', removedPath)} t={t} />
            <ConfigEntries title={t('repositoryConfig.repositories')} entries={draft.repositories} disabled={!editing}
              onRemove={removedPath => remove('repositories', removedPath)} t={t} />
          </>
        )}
        {editable ? (
          <>
            <label className="vcs-dialog-label" htmlFor="vcs-repository-config-kind">{t('repositoryConfig.addRule')}</label>
            <select id="vcs-repository-config-kind" className="vcs-dialog-input vcs-repository-kind" disabled={!editing} value={kind} onChange={event => {
              clearPreview()
              setKind(event.target.value)
            }}>
              <option value="directory">{t('repositoryConfig.directory')}</option>
              <option value="repository">{t('repositoryConfig.repository')}</option>
            </select>
            <label className="vcs-dialog-label" htmlFor="vcs-repository-config-path">{t('repositoryConfig.path')}</label>
            <input ref={pathRef} id="vcs-repository-config-path" className="vcs-dialog-input" disabled={!editing} value={path}
              onChange={event => {
                clearPreview()
                setPath(event.target.value)
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent?.isComposing || event.isComposing) return
                event.preventDefault()
                void checkPath()
              }} />
            <div className="vcs-dialog-actions vcs-repository-add-actions">
              <button type="button" className="vcs-button" disabled={!canPreview} onClick={checkPath}>
                {t('repositoryConfig.preview')}
              </button>
              <button type="button" className="vcs-button" disabled={!canAdd} onClick={add}>
                {t('repositoryConfig.add')}
              </button>
            </div>
            {duplicate ? <p className="vcs-dialog-text">{t('repositoryConfig.duplicate')}</p> : null}
            {previewing ? <p className="vcs-dialog-busy" role="status">{t('repositoryConfig.previewing')}</p> : null}
            {previewError === null ? null : <p className="vcs-dialog-error" role="alert">{errorMessage(t, previewError)}</p>}
            {preview === null ? null : (
              <section className="vcs-repository-section" aria-live="polite">
                <h4>{t('repositoryConfig.previewResult')}</h4>
                {preview.repositories.length === 0 ? <p>{t('repositoryConfig.noMatches')}</p> : (
                  <ul>{preview.repositories.map(entry => <li key={entry.path}><code>{entry.path}</code></li>)}</ul>
                )}
                {preview.truncated ? <p>{t('repositoryConfig.previewTruncated')}</p> : null}
              </section>
            )}
          </>
        ) : null}
        <RepositorySources repositories={repositories} t={t} />
      </div>
      {saving ? <p className="vcs-dialog-busy" role="status">{t('repositoryConfig.saving')}</p> : null}
      {loadError ?? configError ?? saveError ? (
        <p className="vcs-dialog-error" role="alert">{errorMessage(t, loadError ?? configError ?? saveError)}</p>
      ) : null}
      <div className="vcs-dialog-actions">
        {conflict || configError || loadError ? (
          <button type="button" className="vcs-button" onClick={reload}>
            {conflict ? t('repositoryConfig.discardReload') : t('error.retry')}
          </button>
        ) : null}
        <button type="button" className="vcs-button" aria-disabled={saving} onClick={() => { if (!saving) onCancel() }}>
          {t('branch.cancel')}
        </button>
        <button type="submit" className="vcs-button" disabled={!canSave}>{t('repositoryConfig.save')}</button>
      </div>
    </Dialog>
  )
}
