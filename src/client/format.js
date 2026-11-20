/**
 * Pure display helpers shared by the Changes and History panes.
 *
 * Git data arrives normalized (epoch milliseconds, repository-relative POSIX
 * paths, single-letter statuses); this module turns it into strings and tree
 * shapes without touching the DOM.
 */

/** Status letters the panel renders, in the order they are listed. */
const STATUS_KEYS = {
  M: 'status.modified',
  A: 'status.added',
  D: 'status.deleted',
  R: 'status.renamed',
  C: 'status.copied',
  U: 'status.conflict',
}

/**
 * Translation key for one Git status letter. An untracked row shows the same
 * `U` as a conflict but says "untracked", so the two read differently.
 * @param {string} status - single-letter status.
 * @param {boolean} [untracked] - whether the entry is untracked.
 * @returns {string} locale key.
 */
export function statusKey(status, untracked = false) {
  if (untracked) return 'status.untracked'
  return STATUS_KEYS[status] ?? 'status.changed'
}

/**
 * Split a path into its directory and base name.
 * @param {string} path - repository-relative path.
 * @returns {{ dir: string, base: string }} the two halves.
 */
export function splitPath(path) {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { dir: '', base: path }
  return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) }
}

/**
 * Shorten a commit id to Git's usual seven characters.
 * @param {string} sha - a commit id.
 * @returns {string} the short id.
 */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : ''
}

/**
 * Shorten a change id for a dense row; the detail shows the full short id.
 * @param {string} changeId - a change id.
 * @returns {string} the prefix.
 */
export function shortChangeId(changeId) {
  return typeof changeId === 'string' ? changeId.slice(0, 8) : ''
}

/**
 * Format a count with the active locale's digit grouping.
 * @param {number} value - the count.
 * @param {string} [locale] - BCP 47 locale; browser default when omitted.
 * @returns {string} the formatted number.
 */
export function formatCount(value, locale) {
  try {
    return new Intl.NumberFormat(locale).format(value)
  } catch {
    return String(value)
  }
}

/**
 * CLDR plural categories each shipped dictionary supplies for a pluralized key.
 *
 * DSH's locale service does flat `{name}` interpolation with no plural rules.
 * `es`, `fr`, and `pt` omit CLDR's `many` category because it only applies to
 * compact words ("1 million de ..."), not digit-formatted counts; any category
 * outside the resolved dictionary's set falls back to `other`.
 */
export const PLURAL_CATEGORIES = Object.freeze({
  zh: Object.freeze(['other']),
  ja: Object.freeze(['other']),
  en: Object.freeze(['one', 'other']),
  de: Object.freeze(['one', 'other']),
  es: Object.freeze(['one', 'other']),
  fr: Object.freeze(['one', 'other']),
  pt: Object.freeze(['one', 'other']),
  ru: Object.freeze(['one', 'few', 'many', 'other']),
})

const pluralRulesCache = new Map()

/**
 * Resolve the shipped dictionary and BCP 47 tag used to select a plural form.
 *
 * Unknown locales (including an external language pack whose fallback ends at
 * English, or an omitted locale in tests) fall back to English so the selected
 * plural key always matches the dictionary DSH will read. Regional variants of
 * a shipped language keep their full tag for `Intl.PluralRules` while clamping
 * to the primary dictionary's shipped categories.
 * @param {string | undefined} locale - active BCP 47 locale tag.
 * @returns {{ dict: string, tag: string }} dictionary id and PluralRules tag.
 */
function resolvePluralLocale(locale) {
  if (typeof locale !== 'string') return { dict: 'en', tag: 'en' }
  const trimmed = locale.trim().replaceAll('_', '-')
  const normalized = trimmed.toLowerCase()
  if (normalized === '') return { dict: 'en', tag: 'en' }
  if (Object.hasOwn(PLURAL_CATEGORIES, normalized)) return { dict: normalized, tag: normalized }
  const primary = normalized.split('-')[0]
  if (Object.hasOwn(PLURAL_CATEGORIES, primary)) return { dict: primary, tag: trimmed }
  return { dict: 'en', tag: 'en' }
}

/** Cached `Intl.PluralRules` instance for a validated BCP 47 tag. */
function pluralRulesFor(tag) {
  let rules = pluralRulesCache.get(tag)
  if (rules === undefined) {
    rules = new Intl.PluralRules(tag)
    if (pluralRulesCache.size >= 32) pluralRulesCache.clear()
    pluralRulesCache.set(tag, rules)
  }
  return rules
}

/**
 * Pick the CLDR plural category for a count within the categories shipped by
 * the resolved dictionary.
 * @param {number} count - the numeric count.
 * @param {string} [locale] - active BCP 47 locale tag; defaults to `'en'`.
 * @returns {'one' | 'few' | 'many' | 'other'} plural category present in the dictionary.
 */
export function pluralCategory(count, locale) {
  const { dict, tag } = resolvePluralLocale(locale)
  const allowed = PLURAL_CATEGORIES[dict]
  if (allowed.length === 1) return allowed[0]
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'other'
  let category = 'other'
  try {
    category = pluralRulesFor(tag).select(count)
  } catch {
    try {
      category = pluralRulesFor(dict).select(count)
    } catch {
      category = count === 1 ? 'one' : 'other'
    }
  }
  return allowed.includes(category) ? category : 'other'
}

/**
 * Resolve the pluralized dictionary key for a base key and numeric count.
 * @param {string} baseKey - plural base key, e.g. `'detail.fileCount'`.
 * @param {number} count - the numeric count.
 * @param {string} [locale] - active BCP 47 locale tag.
 * @returns {string} full dictionary key ending in a CLDR plural category.
 */
export function pluralKey(baseKey, count, locale) {
  return `${baseKey}.${pluralCategory(count, locale)}`
}

/**
 * Translate a pluralized count phrase, selecting the locale's plural form and
 * formatting `{count}` with the active locale's digit grouping.
 * @param {Function} t - the panel's translate function.
 * @param {string} baseKey - plural base key, e.g. `'detail.fileCount'`.
 * @param {number} count - the numeric count.
 * @param {string} [locale] - active BCP 47 locale tag.
 * @param {Record<string, string>} [vars] - additional template variables.
 * @returns {string} localized, pluralized copy.
 */
export function formatPlural(t, baseKey, count, locale, vars) {
  const formatted = formatCount(count, locale)
  const params = vars === undefined ? { count: formatted } : { ...vars, count: formatted }
  return t(pluralKey(baseKey, count, locale), params)
}

/**
 * Format an instant as a date and a time.
 * @param {number} ms - epoch milliseconds.
 * @param {string} [locale] - BCP 47 locale; browser default when omitted.
 * @returns {string} the localized instant.
 */
export function formatDateTime(ms, locale) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    try {
      return new Date(ms).toISOString()
    } catch {
      return ''
    }
  }
}

/** Pick a relative-time unit from an elapsed second count. */
function relativeUnit(seconds) {
  if (seconds < 60) return ['second', Math.max(1, Math.round(seconds))]
  if (seconds < 3600) return ['minute', Math.round(seconds / 60)]
  if (seconds < 86400) return ['hour', Math.round(seconds / 3600)]
  return ['day', Math.round(seconds / 86400)]
}

/**
 * Format a commit time the way a history list reads it: relative while recent,
 * absolute once it leaves the last week.
 * @param {number} ms - epoch milliseconds.
 * @param {number} [now] - current time, for tests.
 * @param {string} [locale] - BCP 47 locale.
 * @returns {string} the short, stable time text.
 */
export function formatCommitTime(ms, now = Date.now(), locale) {
  if (!Number.isFinite(ms)) return ''
  const seconds = Math.max(0, (now - ms) / 1000)
  if (seconds < 7 * 86400) {
    const [unit, value] = relativeUnit(seconds)
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(-value, unit)
    } catch {
      // Fall through to an absolute format when RelativeTimeFormat is unavailable.
    }
  }
  return formatDateTime(ms, locale)
}

/**
 * The number of changed lines a file row states, or nulls when unknown.
 * @param {{ added?: number, deleted?: number } | null} entry - one file entry.
 * @returns {{ added: number | null, deleted: number | null }} the counts.
 */
export function lineCounts(entry) {
  if (entry === null || entry === undefined) return { added: null, deleted: null }
  return {
    added: typeof entry.added === 'number' ? entry.added : null,
    deleted: typeof entry.deleted === 'number' ? entry.deleted : null,
  }
}

/** Stable Host error codes mapped to localized copy. */
const ERROR_KEYS = {
  'no-session': 'error.noSession',
  'no-cwd': 'error.noCwd',
  'not-a-repo': 'error.notARepo',
  'not-found': 'error.notFound',
  timeout: 'error.timeout',
  'output-too-large': 'error.outputTooLarge',
  network: 'error.network',
  'bad-request': 'error.badRequest',
  internal: 'error.internal',
  forbidden: 'error.forbidden',
  busy: 'error.busy',
  'stale-diff': 'error.staleDiff',
  'staging-unsupported': 'error.stagingUnsupported',
  'staging-failed': 'error.stagingFailed',
  'stage-history-stale': 'error.stageHistoryStale',
  'stage-history-unavailable': 'error.stageHistoryUnavailable',
  'stage-history-busy': 'error.stageHistoryBusy',
  'no-upstream': 'error.noUpstream',
  diverged: 'error.diverged',
  'pull-blocked': 'error.pullBlocked',
  'remote-failed': 'error.remoteFailed',
  'switch-blocked': 'error.switchBlocked',
  'switch-failed': 'error.switchFailed',
  'branch-invalid': 'error.branchInvalid',
  'branch-exists': 'error.branchExists',
  'branch-unmerged': 'error.branchUnmerged',
  'branch-in-use': 'error.branchInUse',
  'merge-blocked': 'error.mergeBlocked',
  'rebase-blocked': 'error.rebaseBlocked',
  'branch-failed': 'error.branchFailed',
  'tag-invalid': 'error.tagInvalid',
  'tag-exists': 'error.tagExists',
  'tag-missing': 'error.tagMissing',
  'remote-missing': 'error.remoteMissing',
  'remote-branch-missing': 'error.remoteBranchMissing',
  'tag-push-failed': 'error.tagPushFailed',
  'tag-failed': 'error.tagFailed',
  'checkout-blocked': 'error.checkoutBlocked',
  'commit-not-on-branch': 'error.commitNotOnBranch',
  'commit-conflict': 'error.commitConflict',
  'commit-blocked': 'error.commitBlocked',
  'commit-failed': 'error.commitFailed',
  'repository-config-invalid': 'error.repositoryConfigInvalid',
  'repository-config-conflict': 'error.repositoryConfigConflict',
  'repository-config-write-failed': 'error.repositoryConfigWriteFailed',
  'repository-path-unavailable': 'error.repositoryPathUnavailable',
}

/**
 * Localized text for one API failure, falling back to the Host message.
 * @param {Function} t - the panel's translate function.
 * @param {{ code?: string, message?: string } | null} error - the failure.
 * @returns {string} browser-facing copy.
 */
export function errorMessage(t, error) {
  const key = ERROR_KEYS[error?.code]
  if (key !== undefined) return t(key)
  return error?.message ?? t('error.internal')
}

/**
 * Localized outcome of one sync: what moved, and to or from which upstream.
 * @param {Function} t - the panel's translate function.
 * @param {{ upstream?: string, pulled?: number, pushed?: number }} result - the sync answer.
 * @param {string} [locale] - BCP 47 locale for the count.
 * @returns {string} browser-facing copy.
 */
export function syncMessage(t, result, locale) {
  const upstream = typeof result?.upstream === 'string' ? result.upstream : ''
  const pushed = Number.isSafeInteger(result?.pushed) ? result.pushed : 0
  const pulled = Number.isSafeInteger(result?.pulled) ? result.pulled : 0
  if (pushed > 0) return formatPlural(t, 'sync.pushed', pushed, locale, { upstream })
  if (pulled > 0) return formatPlural(t, 'sync.pulled', pulled, locale, { upstream })
  return t('sync.level', { upstream })
}

/**
 * Localized outcome of one branch switch: the branch now checked out.
 * @param {Function} t - the panel's translate function.
 * @param {{ branch?: unknown } | null} result - the switch answer.
 * @param {string} requested - the branch the user picked, for a malformed answer.
 * @returns {string} browser-facing copy.
 */
export function switchMessage(t, result, requested) {
  const branch = typeof result?.branch === 'string' && result.branch !== '' ? result.branch : requested
  return t('switch.done', { branch })
}

/**
 * Localized outcome of one branch action: what changed and where.
 * @param {Function} t - the panel's translate function.
 * @param {'rename'|'delete'|'merge'|'rebase'|'push'} action - the action that ran.
 * @param {string} branch - the branch the user chose.
 * @param {object | null} result - the Host answer.
 * @returns {string} browser-facing copy.
 */
export function branchOpMessage(t, action, branch, result) {
  const current = typeof result?.current === 'string' && result.current !== '' ? result.current : branch
  if (action === 'rename') {
    const from = typeof result?.from === 'string' && result.from !== '' ? result.from : branch
    const to = typeof result?.branch === 'string' && result.branch !== '' ? result.branch : branch
    return t('branch.renamed', { from, branch: to })
  }
  if (action === 'delete') return t('branch.deleted', { branch })
  if (action === 'checkout-remote') {
    const local = typeof result?.local === 'string' && result.local !== '' ? result.local : branch
    return t('branch.checkedOutRemote', { branch, local })
  }
  if (action === 'delete-remote') return t('branch.deletedRemote', { branch })
  if (action === 'merge' || action === 'merge-remote') {
    if (result?.result === 'fast-forward') return t('branch.fastForwarded', { current, branch })
    if (result?.result === 'up-to-date') return t('branch.upToDate', { current, branch })
    return t('branch.merged', { current, branch })
  }
  if (action === 'pull-remote') {
    return result?.result === 'up-to-date'
      ? t('branch.pulledLevel', { current, branch })
      : t('branch.pulled', { current, branch })
  }
  if (action === 'rebase') return t('branch.rebased', { current, branch })
  const upstream = typeof result?.upstream === 'string' && result.upstream !== '' ? result.upstream : branch
  return result?.pushed === false
    ? t('branch.pushLevel', { branch, upstream })
    : t('branch.pushed', { branch, upstream })
}

/**
 * Localized outcome of one tag action: what changed and where.
 * @param {Function} t - the panel's translate function.
 * @param {'delete'|'push'} action - the action that ran.
 * @param {string} tag - the tag the user chose.
 * @param {object | null} result - the Host answer.
 * @returns {string} browser-facing copy.
 */
export function tagOpMessage(t, action, tag, result) {
  if (action === 'delete') return t('tag.deleted', { tag })
  const remote = typeof result?.remote === 'string' && result.remote !== '' ? result.remote : tag
  return result?.pushed === false
    ? t('tag.pushLevel', { tag, remote })
    : t('tag.pushed', { tag, remote })
}

/** Explicit reset mode label keys for commitOpMessage. */
const RESET_LABEL_KEYS = {
  soft: 'commit.resetSoft',
  mixed: 'commit.resetMixed',
  hard: 'commit.resetHard',
}

/**
 * Localized outcome of one commit action: what changed and where.
 * @param {Function} t - the panel's translate function.
 * @param {'tag'|'branch'|'checkout'|'cherry-pick'|'revert'|'drop'|'merge'|'rebase'|'reset'} action - the action that ran.
 * @param {{ sha: string, name?: string }} target - the selected commit and optional new ref.
 * @param {object | null} result - the Host answer.
 * @returns {string} browser-facing copy.
 */
export function commitOpMessage(t, action, target, result) {
  const sha = shortSha(typeof result?.sha === 'string' && result.sha !== '' ? result.sha : target.sha)
  if (action === 'tag') {
    const tag = typeof result?.tag === 'string' && result.tag !== '' ? result.tag : target.name
    return t('commit.tagAdded', { tag, sha })
  }
  if (action === 'branch') {
    const branch = typeof result?.branch === 'string' && result.branch !== '' ? result.branch : target.name
    return t(result?.checkedOut === true ? 'commit.branchCreatedCheckedOut' : 'commit.branchCreated', { branch, sha })
  }
  if (action === 'checkout') return t('commit.checkedOut', { sha })
  const current = typeof result?.current === 'string' && result.current !== '' ? result.current : ''
  if (action === 'cherry-pick') return t('commit.cherryPicked', { sha, current })
  if (action === 'revert') return t('commit.reverted', { sha, current })
  if (action === 'drop') return t('commit.dropped', { sha, current })
  if (action === 'merge') {
    if (result?.result === 'fast-forward') return t('commit.fastForwarded', { sha, current })
    if (result?.result === 'up-to-date') return t('commit.upToDate', { sha, current })
    return t('commit.merged', { sha, current })
  }
  if (action === 'rebase') return t('commit.rebased', { sha, current })
  const mode = typeof result?.mode === 'string' ? result.mode : 'mixed'
  const modeLabel = t(RESET_LABEL_KEYS[mode] ?? 'commit.resetMixed')
  return t('commit.resetDone', { sha, current, mode: modeLabel })
}
