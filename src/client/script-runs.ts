/**
 * Split user-supplied text into script runs, so plugin headers can balance alphabetic names
 * against CJK interface labels.
 * Copied from default-workspace tools/script-runs/script-runs.mts (scriptRuns); the rule lives in
 * tools/new-dsh-plugin/README.md (跨文字标题平衡).
 */

/**
 * `cjk` glyphs fill the em box; `alphabetic` lowercase letters sit on a small x-height.
 * `other` covers the remaining scripts and text made only of digits, spaces, or punctuation.
 */
export type ScriptClass = 'cjk' | 'alphabetic' | 'other'

export type ScriptRun = { readonly text: string, readonly script: ScriptClass }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u
const ALPHABETIC = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u

/** Digits, spaces, punctuation, and combining marks return undefined and join a neighboring run. */
function classify(char: string): ScriptClass | undefined {
  if (CJK.test(char)) return 'cjk'
  if (ALPHABETIC.test(char)) return 'alphabetic'
  return NEUTRAL.test(char) ? undefined : 'other'
}

type Draft = { readonly text: string, readonly script: ScriptClass | undefined }

/**
 * Neutral characters extend the preceding run; leading ones join the first classified run.
 * `my-app 前端` yields `my-app ` (alphabetic) and `前端` (cjk).
 */
export function scriptRuns(text: string): readonly ScriptRun[] {
  const drafts = Array.from(text).reduce<readonly Draft[]>((runs, char) => {
    const script = classify(char)
    const last = runs.at(-1)
    if (last === undefined) return [{ text: char, script }]
    if (script === undefined || script === last.script || last.script === undefined) {
      return [...runs.slice(0, -1), { text: last.text + char, script: last.script ?? script }]
    }
    return [...runs, { text: char, script }]
  }, [])
  return drafts.map(({ text, script }) => ({ text, script: script ?? 'other' }))
}
