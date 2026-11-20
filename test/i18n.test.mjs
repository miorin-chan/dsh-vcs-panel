import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sep, join } from 'node:path'

import { DICTIONARIES } from '../lib/client/locales.js'
import {
  errorMessage, formatPlural, PLURAL_CATEGORIES, pluralCategory, pluralKey, statusKey,
} from '../lib/client/format.js'
import { ERROR_STATUS } from '../lib/errors.js'

/** Languages DSH supports and this panel must ship. */
const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

/** CLDR plural category suffixes recognized on dictionary keys. */
const PLURAL_SUFFIX = /^(.*)\.(one|few|many|other)$/u

/** Count-bearing keys whose wording is label/parenthetical and plural-invariant in all 8 languages. */
const INVARIANT_COUNT_KEYS = new Set([
  'top.worktreeSelection',
  'history.count',
  'stage.stageSelected',
  'stage.unstageSelected',
])

/** Placeholders a dictionary value interpolates. */
function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
}

/** Split one dictionary's keys into plain keys and plural base -> category sets. */
function splitKeys(dict) {
  const plain = new Set()
  const plural = new Map()
  for (const key of Object.keys(dict)) {
    const match = PLURAL_SUFFIX.exec(key)
    if (match === null) {
      plain.add(key)
      continue
    }
    const [, base, category] = match
    let categories = plural.get(base)
    if (categories === undefined) {
      categories = new Set()
      plural.set(base, categories)
    }
    categories.add(category)
  }
  return { plain, plural }
}

/** Mirror DSH's LocaleRuntime.translate lookup (active locale -> en fallback, flat `{name}` interpolation). */
function translatorFor(locale) {
  const chain = locale === 'en' || DICTIONARIES[locale] === undefined ? ['en'] : [locale, 'en']
  return (key, params) => {
    let template
    for (const loc of chain) {
      if (DICTIONARIES[loc]?.[key] !== undefined) {
        template = DICTIONARIES[loc][key]
        break
      }
    }
    if (template === undefined) return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
  }
}

/** Approximate display width, counting CJK/fullwidth glyphs as two columns. */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1
  }
  return width
}

/** Every source file below a directory. */
function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

test('all eight dictionaries carry the same plain keys and complete plural forms', () => {
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), [...LOCALES].sort())
  assert.deepEqual(Object.keys(PLURAL_CATEGORIES).sort(), [...LOCALES].sort())

  const english = splitKeys(DICTIONARIES.en)
  const expectedPlain = [...english.plain].sort()
  const expectedPlural = [...english.plural.keys()].sort()
  assert.ok(expectedPlural.length > 0, 'dictionaries should declare pluralized keys')

  for (const locale of LOCALES) {
    const { plain, plural } = splitKeys(DICTIONARIES[locale])
    assert.deepEqual([...plain].sort(), expectedPlain, `${locale} plain keys`)
    assert.deepEqual([...plural.keys()].sort(), expectedPlural, `${locale} plural base keys`)

    for (const base of expectedPlural) {
      assert.equal(plain.has(base), false, `${locale} ${base} must not collide with a plain key`)
      assert.deepEqual(
        [...plural.get(base)].sort(),
        [...PLURAL_CATEGORIES[locale]].sort(),
        `${locale} ${base} plural categories`,
      )
    }
    for (const [key, text] of Object.entries(DICTIONARIES[locale])) {
      assert.equal(typeof text, 'string', `${locale} ${key}`)
      assert.notEqual(text.trim(), '', `${locale} ${key}`)
    }
  }
})

test('translations keep every placeholder the English text declares, and counted keys are pluralized', () => {
  const { plain, plural } = splitKeys(DICTIONARIES.en)
  for (const key of plain) {
    const expected = placeholders(DICTIONARIES.en[key])
    if (expected.includes('count')) {
      assert.equal(
        INVARIANT_COUNT_KEYS.has(key),
        true,
        `${key} interpolates {count} without plural forms; pluralize it or document it as invariant`,
      )
    }
    for (const locale of LOCALES) {
      assert.deepEqual(placeholders(DICTIONARIES[locale][key]), expected, `${locale} ${key}`)
    }
  }
  for (const base of plural.keys()) {
    const expected = placeholders(DICTIONARIES.en[`${base}.other`])
    assert.ok(expected.includes('count'), `${base} must interpolate {count}`)
    for (const locale of LOCALES) {
      for (const category of PLURAL_CATEGORIES[locale]) {
        const leaf = `${base}.${category}`
        assert.deepEqual(placeholders(DICTIONARIES[locale][leaf]), expected, `${locale} ${leaf}`)
      }
    }
  }
})

test('every literal t(key), formatPlural(baseKey), and dynamic key resolves in every dictionary', () => {
  const directory = fileURLToPath(new URL('../src/client', import.meta.url))
  const { plain, plural } = splitKeys(DICTIONARIES.en)
  const usedPlain = new Set()
  const usedPlural = new Set()
  const withPlaceholders = new Set(
    [...plain].filter(key => placeholders(DICTIONARIES.en[key]).length > 0),
  )

  for (const file of sourceFiles(directory)) {
    if (file.endsWith('locales.ts') || file.includes(`${sep}locales${sep}`)) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bt\('([^']+)'/gu)) usedPlain.add(match[1])
    for (const match of source.matchAll(/\bt\('([^']+)'\)/gu)) {
      assert.equal(withPlaceholders.has(match[1]), false, `${match[1]} is called without placeholders`)
    }
    for (const match of source.matchAll(/\b(?:formatPlural|pluralKey)\(([^)]+)\)/gu)) {
      const expr = match[1].split(',')[match[0].startsWith('formatPlural') ? 1 : 0] ?? ''
      for (const literal of expr.matchAll(/'([^']+)'/gu)) usedPlural.add(literal[1])
    }
    for (const match of source.matchAll(/['"]([a-z][a-zA-Z0-9_.-]*\.(?:one|few|many|other))['"]/gu)) {
      assert.fail(`plural leaf key ${match[1]} must be selected via formatPlural/pluralKey, not referenced directly`)
    }
  }

  // Keys assembled at render time and through shared helpers.
  usedPlain.add('changes.staged')
  usedPlain.add('changes.unstaged')
  for (const key of ['diff.created', 'diff.deleted', 'diff.unchanged']) usedPlain.add(key)
  for (const letter of ['M', 'A', 'D', 'R', 'C', 'U']) usedPlain.add(statusKey(letter))
  for (const code of Object.keys(ERROR_STATUS)) {
    let key = null
    errorMessage(next => { key = next; return next }, { code })
    assert.notEqual(key, null, code)
    usedPlain.add(key)
  }
  usedPlain.add('error.network')

  const missingPlain = [...usedPlain].filter(key => !plain.has(key)).sort()
  assert.deepEqual(missingPlain, [])
  const missingPlural = [...usedPlural].filter(base => !plural.has(base)).sort()
  assert.deepEqual(missingPlural, [])
})

test('all eight locales select the right plural form for 0, 1, 2, 5, and 21', () => {
  const expectedCategories = {
    zh: { 0: 'other', 1: 'other', 2: 'other', 5: 'other', 21: 'other' },
    ja: { 0: 'other', 1: 'other', 2: 'other', 5: 'other', 21: 'other' },
    en: { 0: 'other', 1: 'one', 2: 'other', 5: 'other', 21: 'other' },
    de: { 0: 'other', 1: 'one', 2: 'other', 5: 'other', 21: 'other' },
    es: { 0: 'other', 1: 'one', 2: 'other', 5: 'other', 21: 'other' },
    fr: { 0: 'one', 1: 'one', 2: 'other', 5: 'other', 21: 'other' },
    pt: { 0: 'one', 1: 'one', 2: 'other', 5: 'other', 21: 'other' },
    ru: { 0: 'many', 1: 'one', 2: 'few', 5: 'many', 21: 'one' },
  }
  for (const locale of LOCALES) {
    for (const [raw, expected] of Object.entries(expectedCategories[locale])) {
      const n = Number(raw)
      assert.equal(pluralCategory(n, locale), expected, `${locale} ${n}`)
      assert.equal(pluralKey('detail.fileCount', n, locale), `detail.fileCount.${expected}`, `${locale} ${n}`)
    }
    // Large round counts (CLDR compact `many` in es/fr/pt) must always stay within shipped categories.
    const millionCategory = pluralCategory(1_000_000, locale)
    assert.ok(PLURAL_CATEGORIES[locale].includes(millionCategory), `${locale} 1000000 -> ${millionCategory}`)
  }

  // Concrete rendered examples across all 8 languages at 0, 1, 2, 5, 21.
  const expectedFileCount = {
    zh: { 0: '0 个文件', 1: '1 个文件', 2: '2 个文件', 5: '5 个文件', 21: '21 个文件' },
    ja: { 0: '0 ファイル', 1: '1 ファイル', 2: '2 ファイル', 5: '5 ファイル', 21: '21 ファイル' },
    en: { 0: '0 files', 1: '1 file', 2: '2 files', 5: '5 files', 21: '21 files' },
    de: { 0: '0 Dateien', 1: '1 Datei', 2: '2 Dateien', 5: '5 Dateien', 21: '21 Dateien' },
    es: { 0: '0 archivos', 1: '1 archivo', 2: '2 archivos', 5: '5 archivos', 21: '21 archivos' },
    fr: { 0: '0 fichier', 1: '1 fichier', 2: '2 fichiers', 5: '5 fichiers', 21: '21 fichiers' },
    pt: { 0: '0 arquivo', 1: '1 arquivo', 2: '2 arquivos', 5: '5 arquivos', 21: '21 arquivos' },
    ru: { 0: '0 файлов', 1: '1 файл', 2: '2 файла', 5: '5 файлов', 21: '21 файл' },
  }
  for (const locale of LOCALES) {
    const t = translatorFor(locale)
    for (const [raw, expected] of Object.entries(expectedFileCount[locale])) {
      assert.equal(formatPlural(t, 'detail.fileCount', Number(raw), locale), expected, `${locale} ${raw}`)
    }
  }

  // Russian distinguishes all three integer forms across other plural keys as well.
  const tRu = translatorFor('ru')
  assert.equal(formatPlural(tRu, 'sync.pushed', 1, 'ru', { upstream: 'origin/main' }), 'В origin/main отправлен 1 коммит.')
  assert.equal(formatPlural(tRu, 'sync.pushed', 2, 'ru', { upstream: 'origin/main' }), 'В origin/main отправлено 2 коммита.')
  assert.equal(formatPlural(tRu, 'sync.pushed', 5, 'ru', { upstream: 'origin/main' }), 'В origin/main отправлено 5 коммитов.')
  assert.equal(formatPlural(tRu, 'sync.pushed', 21, 'ru', { upstream: 'origin/main' }), 'В origin/main отправлен 21 коммит.')
  assert.equal(formatPlural(tRu, 'turn.filesChanged', 1, 'ru'), 'Изменён 1 файл')
  assert.equal(formatPlural(tRu, 'turn.filesChanged', 2, 'ru'), 'Изменено 2 файла')
  assert.equal(formatPlural(tRu, 'turn.filesChanged', 5, 'ru'), 'Изменено 5 файлов')
  assert.equal(formatPlural(tRu, 'turn.filesChanged', 21, 'ru'), 'Изменён 21 файл')

  // Every plural base key resolves cleanly for all 8 locales across all test counts.
  const { plural } = splitKeys(DICTIONARIES.en)
  for (const locale of LOCALES) {
    const t = translatorFor(locale)
    for (const base of plural.keys()) {
      for (const n of [0, 1, 2, 5, 21, 1_000_000]) {
        const rendered = formatPlural(t, base, n, locale, { upstream: 'origin/main' })
        assert.notEqual(rendered, `${base}.${pluralCategory(n, locale)}`, `${locale} ${base} ${n} fell through to key`)
        assert.equal(rendered.includes('{count}'), false, `${locale} ${base} ${n} left {count} uninterpolated`)
      }
    }
  }

  // Regional tags, underscores, unknown locales (falling back to English), omitted locale, and non-finite counts.
  assert.equal(pluralCategory(0, 'pt-PT'), 'other')
  assert.equal(pluralCategory(0, 'pt-BR'), 'one')
  assert.equal(pluralCategory(2, 'ru_RU'), 'few')
  assert.equal(pluralCategory(21, 'ru-RU'), 'one')
  assert.equal(pluralCategory(2, 'pl'), 'other', 'unknown external locale uses English fallback rules')
  assert.equal(pluralCategory(1, 'pl'), 'one')
  assert.equal(pluralCategory(1, undefined), 'one')
  assert.equal(pluralCategory(2, undefined), 'other')
  assert.equal(pluralCategory(1, 'en-!!!'), 'one')
  assert.equal(pluralCategory(Number.NaN, 'ru'), 'other')
  assert.equal(pluralCategory(Number.POSITIVE_INFINITY, 'en'), 'other')
})

test('view labels stay short enough for the Sidebar chip', () => {
  for (const locale of LOCALES) {
    const label = DICTIONARIES[locale]['view.label']
    assert.ok(displayWidth(label) <= 12, `${locale} view.label is ${displayWidth(label)} columns: ${label}`)
  }
})

test('every locale module defines each key at most once', () => {
  const dir = fileURLToPath(new URL('../src/client/locales', import.meta.url))
  for (const locale of LOCALES) {
    const source = readFileSync(join(dir, `${locale}.ts`), 'utf8')
    const seen = new Set()
    const duplicates = []
    for (const line of source.split('\n')) {
      const match = /^\s*['"]([^'"]+)['"]\s*:/u.exec(line)
      if (match === null) continue
      if (seen.has(match[1])) duplicates.push(match[1])
      seen.add(match[1])
    }
    assert.deepEqual(duplicates, [], `${locale} has duplicate keys`)
  }
})

test('every dictionary key is referenced in client or capability sources', () => {
  const clientDir = fileURLToPath(new URL('../src/client', import.meta.url))
  const capabilitiesFile = fileURLToPath(new URL('../lib/vcs/capabilities.js', import.meta.url))
  const referenced = new Set()
  const scan = source => {
    for (const match of source.matchAll(/['"]([a-z][a-zA-Z0-9_.-]*\.[a-zA-Z0-9_.-]+)['"]/gu)) {
      referenced.add(match[1])
    }
  }
  for (const file of sourceFiles(clientDir)) {
    if (file.endsWith('locales.ts') || file.includes(`${sep}locales${sep}`)) continue
    scan(readFileSync(file, 'utf8'))
  }
  scan(readFileSync(capabilitiesFile, 'utf8'))

  // Keys assembled dynamically through shared status/error/change helpers.
  referenced.add('changes.staged')
  referenced.add('changes.unstaged')
  for (const key of ['diff.created', 'diff.deleted', 'diff.unchanged']) referenced.add(key)
  for (const letter of ['M', 'A', 'D', 'R', 'C', 'U']) referenced.add(statusKey(letter))
  for (const code of Object.keys(ERROR_STATUS)) {
    let key = null
    errorMessage(next => { key = next; return next }, { code })
    referenced.add(key)
  }
  referenced.add('error.network')

  const { plain, plural } = splitKeys(DICTIONARIES.en)
  const unusedPlain = [...plain].filter(key => !referenced.has(key)).sort()
  const unusedPlural = [...plural.keys()].filter(base => !referenced.has(base)).sort()
  assert.deepEqual(unusedPlain, [])
  assert.deepEqual(unusedPlural, [])
})

test('every dictionary language has plugin metadata', () => {
  for (const locale of LOCALES) {
    const file = fileURLToPath(new URL(`../locale/${locale}.json`, import.meta.url))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string', `${locale} title`)
    assert.notEqual(parsed.meta.title.trim(), '', `${locale} title`)
    assert.equal(typeof parsed.meta?.description, 'string', `${locale} description`)
    assert.notEqual(parsed.meta.description.trim(), '', `${locale} description`)
  }
})
