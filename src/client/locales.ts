/**
 * UI dictionaries for the version control panel.
 *
 * Keys live in one flat frozen module per language under `locales/`; missing
 * locales fall back to English through the Host locale service. Display
 * metadata lives in `locale/*.json`.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'
// The locale client entry augments `Context` with the locale service; the
// plugin's `src/dsh.d.ts` imports the package's host half only.
import en from './locales/en.js'
import zh from './locales/zh.js'
import ja from './locales/ja.js'
import es from './locales/es.js'
import fr from './locales/fr.js'
import de from './locales/de.js'
import ru from './locales/ru.js'
import pt from './locales/pt.js'

/** One UI dictionary: flat locale keys to localized copy. */
export type LocaleDict = Record<string, string>

/**
 * The panel's locale namespace.
 *
 * Its key domain is the open string: pluralized copy selects one of a base
 * key's CLDR categories at runtime (`format.ts`), so the eight dictionaries
 * legitimately differ in which category keys they carry.
 */
export const LOCALE_NAMESPACE = 'vcs'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    vcs: string
  }
}

/** The dictionary one namespace declares, checked against {@link LocaleDict}. */
export type PanelLocaleDict = LocaleDictOf<typeof LOCALE_NAMESPACE>

/**
 * Dictionary set keyed by locale id.
 *
 * The frozen literal keeps its own keys so the Host's typed registration can
 * check the baseline locales, while every value must satisfy {@link LocaleDict}.
 */
export const DICTIONARIES = (
  Object.freeze({ en, zh, ja, es, fr, de, ru, pt }) satisfies Readonly<Record<string, LocaleDict>>
)
