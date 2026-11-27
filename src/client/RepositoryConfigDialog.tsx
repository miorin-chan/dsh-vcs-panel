/**
 * The repository discovery dialog: the configured scan directories and
 * repository paths, the discovered repositories with their backend choices,
 * and one preview before a path is added.
 *
 * The Host owns validation, revision checks, and persistence; this component
 * only edits a draft and reports the save outcome.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import { REPOSITORY_CONFIG_PATH_MAX } from '../lib/repository-config-limits.js'
import { failureOf } from './api.js'
import type {
  Api, ApiFailure, RepositoryConfigAnswer, RepositoryConfigPath, RepositoryInfo, RepositoryPreviewAnswer, RepositoryScanAnswer, RepositorySource,
} from './api.js'
import { Dialog } from './Dialog.jsx'
import { errorMessage } from './format.js'
import { Chevron } from './ui.jsx'

/** The kind of discovery rule the dialog adds. */
type RuleKind = 'directory' | 'repository'

/** The two configured path lists the draft edits. */
type PathField = 'scanDirectories' | 'repositories'

/** One backend preference as the dialog writes it back. */
interface BackendPreference {
  path: string
  vcs: string
}

/** The editable configuration the dialog writes back. */
interface ConfigDraft {
  scanDirectories: RepositoryConfigPath[]
  repositories: RepositoryConfigPath[]
  backends: BackendPreference[]
}

/**
 * React's synthetic keyboard event carries `isComposing` at runtime although
 * its declaration does not expose it.
 */
type ComposingKeyboardEvent = KeyboardEvent<HTMLInputElement> & { isComposing?: boolean }

/** Whether two path lists name the same paths in the same order. */
function sameEntries(a: readonly RepositoryConfigPath[], b: readonly RepositoryConfigPath[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index].path)
}

/** The session-relative path a backend preference stores, `"."` at the root. */
function repositoryKey(cwd: string | null | undefined, path: string): string {
  const root = cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  const normalized = path.replaceAll('\\', '/')
  if (root === undefined || root === '') return normalized
  if (normalized === root) return '.'
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}

/** Whether two backend lists name the same preference for every path. */
function sameBackends(a: readonly BackendPreference[], b: readonly BackendPreference[]): boolean {
  if (a.length !== b.length) return false
  const byPath = new Map(b.map(entry => [entry.path, entry.vcs]))
  return a.every(entry => byPath.get(entry.path) === entry.vcs)
}

/** State and callbacks of one repository's backend choice. */
interface BackendChoiceProps {
  cwd: string | null | undefined
  repository: RepositoryInfo
  backends: readonly BackendPreference[]
  disabled: boolean
  onChange: (path: string, vcs: string) => void
  t: Translate
}

/** The backend choices a repository offers beside its discovery sources. */
function BackendChoice({ cwd, repository, backends, disabled, onChange, t }: BackendChoiceProps) {
  const available = Array.isArray(repository.availableVcs) ? repository.availableVcs : []
  if (typeof cwd !== 'string' || available.length < 2) return null
  const path = repositoryKey(cwd, repository.path)
  const stored = backends.find(entry => entry.path === path)?.vcs ?? null
  const value = stored !== null && available.includes(stored) ? stored : 'auto'
  const labels: Readonly<Record<string, string>> = {
    git: t('repositoryConfig.vcsGit'),
    jujutsu: t('repositoryConfig.vcsJujutsu'),
  }
  return (
    <label className="vcs-repository-backend">
      <span className="vcs-sr-only">{t('repositoryConfig.backend')}</span>
      <select className="vcs-repository-backend-select" disabled={disabled} value={value}
        aria-label={t('repositoryConfig.backendLabel', { path })} onChange={event => { onChange(path, event.target.value) }}>
        <option value="auto">{t('repositoryConfig.vcsAuto')}</option>
        {available.map(id => <option key={id} value={id}>{labels[id] ?? id}</option>)}
      </select>
    </label>
  )
}

/** The rows of one configured path list and the control that removes them. */
interface ConfigEntriesProps {
  title: string
  entries: readonly RepositoryConfigPath[]
  disabled: boolean
  onRemove: (path: string) => void
  t: Translate
}

/** One configured path list with a remove control per row. */
function ConfigEntries({ title, entries, disabled, onRemove, t }: ConfigEntriesProps) {
  if (entries.length === 0) return null
  return (
    <section className="vcs-repository-section">
      <h4>{title}</h4>
      <ul>
        {entries.map(entry => (
          <li key={entry.path}>
            <div><code>{entry.path}</code>{entry.available ? null : <small className="vcs-repository-unavailable">{t('repositoryConfig.unavailable')}</small>}</div>
            <button type="button" className="vcs-button vcs-repository-remove" disabled={disabled}
              aria-label={t('repositoryConfig.removePath', { path: entry.path })} onClick={() => onRemove(entry.path)}>
              {t('repositoryConfig.remove')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The discovered repositories, their sources, and their backend choices. */
interface RepositorySourcesProps {
  cwd: string | null | undefined
  repositories: readonly RepositoryInfo[]
  backends: readonly BackendPreference[]
  disabled: boolean
  onChange: (path: string, vcs: string) => void
  t: Translate
}

/** The discovered-repository list with its backend choices. */
function RepositorySources({ cwd, repositories, backends, disabled, onChange, t }: RepositorySourcesProps) {
  const [expanded, setExpanded] = useState(false)
  if (repositories.length === 0) return null
  const root = cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  return (
    <section className="vcs-repository-section vcs-repository-discovered">
      <button type="button" className="vcs-button vcs-repository-disclosure" aria-expanded={expanded}
        aria-controls="vcs-repository-sources" onClick={() => setExpanded(value => !value)}>
        <span>{t('repositoryConfig.discovered')} <span className="vcs-repository-count">({repositories.length})</span></span>
        <Chevron open={expanded} />
      </button>
      <ul id="vcs-repository-sources" hidden={!expanded}>
        {repositories.map(repository => {
          const path = repository.path.replaceAll('\\', '/')
          const relativePath = root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : repository.path
          // A repository discovered by the enclosing walk declares no source;
          // the dialog names it the default one.
          const sources: readonly RepositorySource[] = repository.sources ?? [{ kind: 'default' }]
          return (
            <li key={repository.path} title={repository.path}>
              <div>
                <code>{repository.name}</code>
                {relativePath === repository.name ? null : <small>{relativePath}</small>}
                {sources.map(source => (
                  <small key={`${source.kind}:${source.path ?? ''}`}>
                    {source.kind === 'directory' ? t('repositoryConfig.sourceDirectory', { path: source.path })
                      : source.kind === 'repository' ? t('repositoryConfig.sourceRepository', { path: source.path })
                        : t('repositoryConfig.sourceDefault')}
                  </small>
                ))}
              </div>
              <BackendChoice cwd={cwd} repository={repository} backends={backends} disabled={disabled}
                onChange={onChange} t={t} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Props of the repository-configuration dialog. */
export interface RepositoryConfigDialogProps {
  api: Api
  cwd: string | null | undefined
  repositories: readonly RepositoryInfo[]
  onCancel: () => void
  onSaved: () => void
  t: Translate
}

/** Edit the rules for this session root. The Host owns validation and revision checks. */
export function RepositoryConfigDialog({ api, cwd, repositories, onCancel, onSaved, t }: RepositoryConfigDialogProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const pathRef = useRef<HTMLInputElement | null>(null)
  const scanButtonRef = useRef<HTMLButtonElement | null>(null)
  const scanAddAllRef = useRef<HTMLButtonElement | null>(null)
  const scanAddButtons = useRef(new Map<string, HTMLButtonElement>())
  const scanRequest = useRef<AbortController | null>(null)
  const previewRef = useRef<AbortController | null>(null)
  const savingRef = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [config, setConfig] = useState<RepositoryConfigAnswer | null>(null)
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [loadError, setLoadError] = useState<ApiFailure | null>(null)
  const [saveError, setSaveError] = useState<ApiFailure | null>(null)
  const [saving, setSaving] = useState(false)
  const [kind, setKind] = useState<RuleKind>('directory')
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<RepositoryPreviewAnswer | null>(null)
  const [previewError, setPreviewError] = useState<ApiFailure | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [addedPath, setAddedPath] = useState<string | null>(null)
  const [scanAddedPath, setScanAddedPath] = useState<string | null>(null)
  const [scan, setScan] = useState<
    { status: 'idle' | 'scanning' } | { status: 'ready', result: RepositoryScanAnswer } | { status: 'error', error: ApiFailure }
  >({ status: 'idle' })
  const relativePath = path.startsWith('/') ? path : path.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    api.repositoryConfig(controller.signal).then(result => {
      if (controller.signal.aborted) return
      setConfig(result)
      setDraft({
        scanDirectories: result.scanDirectories,
        repositories: result.repositories,
        // The Host reports availability beside each choice; the write carries
        // only the preference itself.
        backends: Array.isArray(result.backends) ? result.backends.map(({ path, vcs }) => ({ path, vcs })) : [],
      })
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(failureOf(error))
    })
    return () => {
      controller.abort()
      previewRef.current?.abort()
      scanRequest.current?.abort()
      scanRequest.current = null
    }
  }, [api, loadAttempt])

  const conflict = saveError?.code === 'repository-config-conflict'
  const configError = config?.error ? { code: config.error } : null
  const editable = draft !== null && configError === null && !conflict
  const editing = editable && !saving
  const changed = config !== null && draft !== null && (
    !sameEntries(draft.scanDirectories, config.scanDirectories)
    || !sameEntries(draft.repositories, config.repositories)
    || !sameBackends(draft.backends, config.backends ?? [])
  )
  const property = kind === 'directory' ? 'scanDirectories' : 'repositories'
  const duplicate = draft?.[property]?.some(entry => entry.path === relativePath)
  const canPreview = editing && relativePath !== '' && !duplicate && !previewing
  const ruleLimitReached = (draft?.[property].length ?? 0) >= REPOSITORY_CONFIG_PATH_MAX
  const canAdd = editing && !duplicate && !ruleLimitReached && preview !== null && (kind === 'directory' || preview.repositories.length === 1)
  const canSave = editing && changed
  const scanCapacity = REPOSITORY_CONFIG_PATH_MAX - (draft?.repositories.length ?? 0)
  const scanMatches = scan.status === 'ready'
    ? scan.result.roots.filter(root => !draft?.repositories.some(entry => entry.path === root.path))
    : []
  const firstScanPath = scanMatches[0]?.path
  const canAddAllScanned = editing && scanMatches.length > 1 && scanMatches.length <= scanCapacity

  useEffect(() => {
    const button = scanButtonRef.current
    if (button === null || button.ownerDocument.activeElement !== button || !editing || scanCapacity < 1 || firstScanPath === undefined) return
    // Results sit above the footer in tab order. Enter them only if the user is still on Scan.
    const firstAction = canAddAllScanned ? scanAddAllRef.current : scanAddButtons.current.get(firstScanPath)
    firstAction?.focus()
  }, [scan, editing, scanCapacity, firstScanPath, canAddAllScanned])

  const findUnlisted = async () => {
    if (!editing || scanRequest.current !== null) return
    const controller = new AbortController()
    scanRequest.current = controller
    setScanAddedPath(null)
    setScan({ status: 'scanning' })
    try {
      const result = await api.repositoryScan(controller.signal)
      if (!controller.signal.aborted) setScan({ status: 'ready', result })
    } catch (error) {
      if (!controller.signal.aborted) setScan({ status: 'error', error: failureOf(error) })
    } finally {
      if (scanRequest.current === controller) scanRequest.current = null
    }
  }

  const addScanned = (paths: readonly string[]) => {
    if (!editing || paths.length > scanCapacity) return
    setDraft(previous => {
      if (previous === null) return previous
      const entries = paths.filter(path => !previous.repositories.some(entry => entry.path === path))
      if (entries.length + previous.repositories.length > REPOSITORY_CONFIG_PATH_MAX) return previous
      return { ...previous, repositories: [...previous.repositories, ...entries.map(path => ({ path, available: true }))] }
    })
    const one = paths.length === 1 ? paths[0] : undefined
    setScanAddedPath(one ?? null)
    const index = scanMatches.findIndex(root => root.path === one)
    const remaining = index === -1 || scanCapacity === 1 ? undefined : scanMatches[index + 1] ?? scanMatches[index - 1]
    const nextButton = remaining === undefined ? undefined : scanAddButtons.current.get(remaining.path)
    ;(nextButton ?? scanButtonRef.current)?.focus()
  }

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
    setAddedPath(null)
    setConfig(null)
    setDraft(null)
    setLoadError(null)
    setSaveError(null)
    setScanAddedPath(null)
    setScan({ status: 'idle' })
    setLoadAttempt(value => value + 1)
  }

  const checkPath = async () => {
    if (!canPreview) return
    setAddedPath(null)
    clearPreview()
    const controller = new AbortController()
    previewRef.current = controller
    setPreviewing(true)
    try {
      const result = await api.repositoryPreview(relativePath, kind, controller.signal)
      if (!controller.signal.aborted) setPreview(result)
    } catch (error) {
      if (!controller.signal.aborted) setPreviewError(failureOf(error))
    } finally {
      if (previewRef.current === controller) {
        previewRef.current = null
        setPreviewing(false)
      }
    }
  }

  const add = () => {
    if (!canAdd) return
    setDraft(previous => (
      previous === null ? previous : {
        ...previous,
        [property]: [...previous[property], { path: relativePath, available: true }],
      }
    ))
    clearPreview()
    setAddedPath(relativePath)
    setPath('')
    pathRef.current?.focus()
  }

  const remove = (field: PathField, removedPath: string) => {
    if (addedPath === removedPath) setAddedPath(null)
    if (scanAddedPath === removedPath) setScanAddedPath(null)
    setDraft(previous => (
      previous === null ? previous : { ...previous, [field]: previous[field].filter(entry => entry.path !== removedPath) }
    ))
    pathRef.current?.focus()
  }

  const setBackend = (backendPath: string, vcs: string) => {
    setDraft(previous => (
      previous === null ? previous : {
        ...previous,
        backends: vcs === 'auto'
          ? previous.backends.filter(entry => entry.path !== backendPath)
          : previous.backends.some(entry => entry.path === backendPath)
            ? previous.backends.map(entry => (entry.path === backendPath ? { path: backendPath, vcs } : entry))
            : [...previous.backends, { path: backendPath, vcs }],
      }
    ))
  }

  const save = async () => {
    if (!canSave || savingRef.current) return
    const controller = lifetime.current
    if (config === null || draft === null || controller === null) return
    savingRef.current = true
    headingRef.current?.focus()
    setAddedPath(null)
    clearPreview()
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.saveRepositoryConfig(
        config.revision,
        draft.scanDirectories.map(entry => entry.path),
        draft.repositories.map(entry => entry.path),
        draft.backends.map(({ path, vcs }) => ({ path, vcs })),
      )
      if (!controller.signal.aborted) {
        if (result.error) setSaveError({ code: result.error })
        else onSaved()
      }
    } catch (error) {
      if (!controller.signal.aborted) setSaveError(failureOf(error))
    } finally {
      savingRef.current = false
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return (
    <Dialog className="vcs-repository-dialog" titleId="vcs-repository-config-title" busy={saving} onCancel={onCancel} onSubmit={save}>
      <h3 ref={headingRef} className="vcs-dialog-title" id="vcs-repository-config-title" tabIndex={-1} data-autofocus="">
        {t('repositoryConfig.manage')}
      </h3>
      {cwd ? <p className="vcs-dialog-text vcs-repository-scope" title={cwd}>{t('repositoryConfig.scope', { path: cwd })}</p> : null}
      <div className="vcs-repository-body">
        {config === null && loadError === null ? <p className="vcs-dialog-busy" role="status">{t('repositoryConfig.loading')}</p> : null}
        {editable ? (
          <section className="vcs-repository-editor">
            <label className="vcs-dialog-label" htmlFor="vcs-repository-config-kind">{t('repositoryConfig.addRule')}</label>
            <select id="vcs-repository-config-kind" className="vcs-dialog-input vcs-repository-kind" disabled={!editing} value={kind} onChange={event => {
              clearPreview()
              setAddedPath(null)
              setKind(event.target.value as RuleKind)
            }}>
              <option value="directory">{t('repositoryConfig.directory')}</option>
              <option value="repository">{t('repositoryConfig.repository')}</option>
            </select>
            <label className="vcs-dialog-label" htmlFor="vcs-repository-config-path">{t('repositoryConfig.path')}</label>
            <input ref={pathRef} id="vcs-repository-config-path" className="vcs-dialog-input" disabled={!editing} value={path}
              aria-describedby={kind === 'directory' ? 'vcs-repository-config-hint' : undefined}
              onChange={event => {
                clearPreview()
                setAddedPath(null)
                setPath(event.target.value)
              }}
              onKeyDown={event => {
                const composing = (event as ComposingKeyboardEvent).isComposing
                if (event.key !== 'Enter' || event.nativeEvent?.isComposing || composing) return
                event.preventDefault()
                void checkPath()
              }} />
            {kind === 'directory' ? <p id="vcs-repository-config-hint" className="vcs-repository-hint">{t('repositoryConfig.directoryHint')}</p> : null}
            <div role="status" className="vcs-repository-feedback">
              {previewing ? t('repositoryConfig.previewing') : null}
              {preview !== null && (preview.repositories.length === 0 ? t('repositoryConfig.noMatches') : (
                <>{t('repositoryConfig.previewResult')} ({preview.repositories.length})</>
              ))}
              {preview?.truncated ? <> {t('repositoryConfig.previewTruncated')}</> : null}
              {addedPath !== null ? t('repositoryConfig.addedDraft', { path: addedPath }) : null}
            </div>
            <div className="vcs-dialog-actions vcs-repository-add-actions">
              <button type="button" className="vcs-button" aria-disabled={!canPreview} onClick={checkPath}>
                {t('repositoryConfig.preview')}
              </button>
              <button type="button" className="vcs-button" disabled={!canAdd} onClick={add}>
                {t('repositoryConfig.add')}
              </button>
            </div>
            {ruleLimitReached ? <p className="vcs-dialog-text">{t('repositoryConfig.ruleLimit', { limit: REPOSITORY_CONFIG_PATH_MAX })}</p> : null}
            {duplicate ? <p className="vcs-dialog-text">{t('repositoryConfig.duplicate')}</p> : null}
            {previewError === null ? null : <p className="vcs-dialog-error" role="alert">{errorMessage(t, previewError)}</p>}
            {preview?.repositories.length ? (
              <section className="vcs-repository-section vcs-repository-preview">
                <ul tabIndex={0} aria-label={t('repositoryConfig.previewResult')}>
                  {preview.repositories.map(entry => <li key={entry.path}><code>{entry.path}</code></li>)}
                </ul>
              </section>
            ) : null}
          </section>
        ) : null}
        {draft === null || configError ? null : (
          <>
            {draft.scanDirectories.length === 0 && draft.repositories.length === 0 ? (
              <p className="vcs-repository-empty">{t('repositoryConfig.none')}</p>
            ) : null}
            <ConfigEntries title={t('repositoryConfig.directories')} entries={draft.scanDirectories} disabled={!editing}
              onRemove={removedPath => remove('scanDirectories', removedPath)} t={t} />
            <ConfigEntries title={t('repositoryConfig.repositories')} entries={draft.repositories} disabled={!editing}
              onRemove={removedPath => remove('repositories', removedPath)} t={t} />
          </>
        )}
        <RepositorySources cwd={cwd} repositories={repositories} backends={draft?.backends ?? []}
          disabled={!editing} onChange={setBackend} t={t} />
      </div>
      {editable ? (
        <section id="vcs-repository-scan-results" className="vcs-repository-section vcs-repository-scan-results"
          data-idle={scan.status === 'idle' || undefined}>
          {scanMatches.length > 1 ? (
            <div className="vcs-dialog-actions vcs-repository-add-actions vcs-repository-scan-actions">
              <button ref={scanAddAllRef} type="button" className="vcs-button" disabled={!canAddAllScanned}
                onClick={() => { addScanned(scanMatches.map(root => root.path)) }}>{t('repositoryConfig.addScannedAll')}</button>
            </div>
          ) : null}
          <div role="status" className="vcs-repository-feedback">
            {scan.status === 'scanning' ? t('repositoryConfig.scanningUnlisted') : null}
            {scan.status === 'ready' ? (
              <>
                {scan.result.roots.length === 0 ? t('repositoryConfig.noUnlisted')
                  : scanMatches.length === 0 ? t('repositoryConfig.unlistedInDraft')
                    : `${t('repositoryConfig.unlistedFound')} (${scanMatches.length})`}
                {scanAddedPath !== null ? <> {t('repositoryConfig.addedDraft', { path: scanAddedPath })}</> : null}
                {scanMatches.length > scanCapacity ? <> {t('repositoryConfig.scanCapacity', { available: scanCapacity })}</> : null}
                {scan.result.truncated ? <> {t('repositoryConfig.scanTruncated')}</> : null}
              </>
            ) : null}
          </div>
          {scan.status === 'error' ? <p className="vcs-dialog-error" role="alert">{errorMessage(t, scan.error)}</p> : null}
          {scanMatches.length > 0 ? (
            <ul aria-label={t('repositoryConfig.unlistedFound')}>
              {scanMatches.map(root => (
                <li key={root.path}>
                  <code>{root.path}</code>
                  <button type="button" className="vcs-button" disabled={!editing || scanCapacity < 1}
                    ref={button => {
                      if (button === null) scanAddButtons.current.delete(root.path)
                      else scanAddButtons.current.set(root.path, button)
                    }}
                    aria-label={t('repositoryConfig.addScannedPath', { path: root.path })}
                    onClick={() => { addScanned([root.path]) }}>{t('repositoryConfig.add')}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {saving ? <p className="vcs-dialog-busy" role="status">{t('repositoryConfig.saving')}</p> : null}
      {loadError ?? configError ?? saveError ? (
        <p className="vcs-dialog-error" role="alert">{errorMessage(t, loadError ?? configError ?? saveError)}</p>
      ) : null}
      <div className="vcs-dialog-actions vcs-repository-footer">
        {editable ? (
          <button ref={scanButtonRef} type="button" className="vcs-button vcs-repository-scan"
            aria-controls="vcs-repository-scan-results"
            aria-disabled={!editing || scan.status === 'scanning'} onClick={findUnlisted}>
            {t('repositoryConfig.scanUnlisted')}
          </button>
        ) : null}
        {conflict || configError || loadError ? (
          <button type="button" className="vcs-button" onClick={reload}>
            {conflict ? t('repositoryConfig.discardReload') : t('error.retry')}
          </button>
        ) : null}
        <button type="button" className="vcs-button" aria-disabled={saving} onClick={() => { if (!saving) onCancel() }}>
          {t('branch.cancel')}
        </button>
        <button type="submit" className="vcs-button vcs-repository-save" disabled={!canSave}>{t('repositoryConfig.save')}</button>
      </div>
    </Dialog>
  )
}
