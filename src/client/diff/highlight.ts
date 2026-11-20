/**
 * Synchronous line tokenizer for the vendored `FileDiff` renderer.
 *
 * DSH highlights diffs with the primitives `useCodeHighlighter`/`languageForPath`,
 * which wrap Shiki inside the Desktop bundle. External plugins cannot import that
 * package, so this module provides a small approximation instead: every input
 * line becomes an array of `{ text, kind }` tokens whose concatenation is exactly
 * the original line. The host theme maps the kinds to its Shiki color variables.
 *
 * The scanner carries per-file state for constructs that span lines: block
 * comments, template/raw strings, Python triple-quoted strings, HTML comments,
 * Lua long brackets, and Markdown fences. It is intentionally approximate:
 * classification may be coarse, but token text is always preserved verbatim and
 * no scan depends on a backtracking regular expression.
 */

/** Every kind this tokenizer can emit; `link` appears in Markdown/MDX URLs. */
export type TokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'parameter'
  | 'constant'
  | 'punctuation'
  | 'link'

/** One token: a plain run (text without syntax meaning) carries no kind. */
export interface CodeToken {
  text: string
  kind: TokenKind | undefined
}

/** Every kind this tokenizer can emit. */
export const TOKEN_KINDS: readonly TokenKind[] = Object.freeze([
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'parameter',
  'constant',
  'punctuation',
  'link',
])

/** Extension to canonical language id. A missing or unknown extension is unsupported. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string | undefined>> = Object.freeze({
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  m: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  mm: 'cpp',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  phtml: 'php',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  lua: 'lua',
})

/**
 * Resolve a file path to a supported language id.
 * @param path - repository path, slash or backslash separated.
 * @returns canonical language id, or `undefined` when unsupported.
 */
export function languageForPath(path: string): string | undefined {
  if (typeof path !== 'string') return undefined
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = slash === -1 ? path : path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return undefined
  return EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()]
}

// ---------------------------------------------------------------------------
// Character helpers. Checks by char code keep the hot loop allocation-free.
// ---------------------------------------------------------------------------

function isLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function isIdentStartCode(code: number): boolean {
  return isLetterCode(code) || code === 95 || code === 36
}

function isIdentPartCode(code: number): boolean {
  return isIdentStartCode(code) || isDigitCode(code)
}

function isSpaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

function isHexCode(code: number): boolean {
  return isDigitCode(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}

/** Scan an identifier-like word starting at `start`; returns the exclusive end. */
function scanWordEnd(line: string, start: number): number {
  let i = start
  while (i < line.length && isIdentPartCode(line.charCodeAt(i))) i += 1
  return i
}

/** Scan a numeric literal starting at a digit; returns the exclusive end. */
function scanNumberEnd(line: string, start: number): number {
  let i = start + 1
  while (i < line.length) {
    const code = line.charCodeAt(i)
    if (isDigitCode(code) || isLetterCode(code) || code === 46 || code === 95) {
      i += 1
      continue
    }
    // `e+10` / `E-10` exponent signs belong to the literal.
    if ((code === 43 || code === 45) && i > start) {
      const previous = line.charCodeAt(i - 1)
      if (previous === 101 || previous === 69) {
        i += 1
        continue
      }
    }
    break
  }
  return i
}

/** Find a closing quote on this line, honoring backslash escapes; -1 when absent. */
function findQuoteEnd(line: string, from: number, quote: string): number {
  let i = from
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i
    i += 1
  }
  return -1
}

/**
 * A small emitter that turns sequential pieces into `{ text, kind }` tokens.
 * Plain characters are buffered so runs without syntax are one token.
 */
interface LineEmitter {
  text(value: string): void
  push(value: string, kind: TokenKind | undefined): void
  finish(): CodeToken[]
}

function lineEmitter(): LineEmitter {
  const tokens: CodeToken[] = []
  let plain = ''
  const flush = () => {
    if (plain !== '') {
      tokens.push({ text: plain, kind: undefined })
      plain = ''
    }
  }
  return {
    text(value) {
      plain += value
    },
    push(value, kind) {
      if (value === '') return
      flush()
      tokens.push({ text: value, kind })
    },
    finish() {
      flush()
      return coalesce(tokens)
    },
  }
}

/** Merge adjacent tokens that carry the same kind so the element tree stays small. */
function coalesce(tokens: CodeToken[]): CodeToken[] {
  if (tokens.length < 2) return tokens
  const merged = [tokens[0]]
  for (let i = 1; i < tokens.length; i += 1) {
    const previous = merged[merged.length - 1]
    const token = tokens[i]
    if (previous.kind === token.kind) previous.text += token.text
    else merged.push(token)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Keyword tables.
// ---------------------------------------------------------------------------

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Build a set from a whitespace-separated word list. */
function words(source: string): Set<string> {
  return new Set(source.trim().split(/\s+/).filter(Boolean))
}

const JS_KEYWORDS = words(`
  break case catch class const continue debugger default delete do else export extends
  finally for function if import in instanceof let new return super switch this throw
  try typeof var void while with yield async await static of from as get set
`)

const TS_KEYWORDS = words(`
  break case catch class const continue debugger default delete do else export extends
  finally for function if import in instanceof let new return super switch this throw
  try typeof var void while with yield async await static of from as get set
  interface type enum namespace declare abstract readonly implements private protected
  public keyof infer is asserts satisfies override module global
`)

const JS_CONSTANTS = words('true false null undefined NaN Infinity')
const TS_TYPES = words('any unknown never string number boolean bigint symbol object void')

const JSON_CONSTANTS = words('true false null')

const CSS_KEYWORDS = words(`
  important inherit initial unset revert auto none block inline flex grid absolute relative
  fixed sticky static hidden visible bold italic normal center left right top bottom
  border-box content-box transparent currentColor
`)

const CSS_AT_RULES = words(`
  media import supports keyframes font-face page charset namespace layer container property
  use mixin include extend function return if else each for while debug warn error at-root
`)

const PYTHON_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for from
  global if import in is lambda nonlocal not or pass raise return try while with yield match
  case
`)
const PYTHON_CONSTANTS = words('True False None')

const SHELL_KEYWORDS = words(`
  if then else elif fi for while until do done case esac in function select time coproc
  local export readonly declare typeset return exit break continue shift source alias unset
  set trap eval exec
`)
const SHELL_CONSTANTS = words('true false')

const GO_KEYWORDS = words(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var
`)
const GO_CONSTANTS = words('true false nil iota')
const GO_TYPES = words(`
  bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
  string uint uint8 uint16 uint32 uint64 uintptr
`)

const RUST_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop
  match mod move mut pub ref return self Self static struct super trait type unsafe use where
  while
`)
const RUST_CONSTANTS = words('true false None Some Ok Err')
const RUST_TYPES = words(`
  i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec
  Option Result Box
`)

const JAVA_KEYWORDS = words(`
  abstract assert boolean break byte case catch char class const continue default do double
  else enum extends final finally float for goto if implements import instanceof int
  interface long native new package private protected public return short static strictfp
  super switch synchronized this throw throws transient try void volatile while var record
  sealed permits yield
`)
const JAVA_CONSTANTS = words('true false null')
const JAVA_TYPES = words(`
  boolean byte char double float int long short void String Object Integer Long Double Float
  Boolean Character Byte Short List Map Set ArrayList HashMap
`)

const KOTLIN_KEYWORDS = words(`
  as break class continue do else for fun if in interface is object package return super this
  throw try typealias typeof val var when while by catch constructor delegate dynamic field
  file finally get import init param property receiver set setparam where actual abstract
  annotation companion const crossinline data enum expect external final infix inline inner
  internal lateinit noinline open operator out override private protected public reified
  sealed suspend tailrec vararg
`)
const KOTLIN_CONSTANTS = words('true false null')
const KOTLIN_TYPES = words(`
  Int Long Short Byte Float Double Boolean Char String Any Unit Nothing List Map Set Array
`)

const C_KEYWORDS = words(`
  auto break case char const continue default do double else enum extern float for goto if
  inline int long register restrict return short signed sizeof static struct switch typedef
  union unsigned void volatile while _Bool _Complex
`)
const C_CONSTANTS = words('NULL true false')
const C_TYPES = words(`
  char double float int long short signed unsigned void size_t ssize_t int8_t int16_t
  int32_t int64_t uint8_t uint16_t uint32_t uint64_t bool
`)

const CPP_KEYWORDS = words(`
  auto break case char class const constexpr continue decltype default delete do double else
  enum explicit extern final float for friend goto if inline int long mutable namespace new
  noexcept operator override private protected public register reinterpret_cast return short
  signed sizeof static static_cast struct switch template this throw try typedef typename
  union unsigned using virtual void volatile while
`)
const CPP_CONSTANTS = words('true false nullptr NULL')
const CPP_TYPES = words(`
  int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t bool
  string vector map set wstring
`)

const RUBY_KEYWORDS = words(`
  alias and begin break case class def defined do else elsif end ensure for if in module next
  not or redo rescue retry return self super then undef unless until when while yield require
  require_relative attr_accessor attr_reader attr_writer private protected public include
  extend
`)
const RUBY_CONSTANTS = words('true false nil')

const PHP_KEYWORDS = words(`
  abstract and array as break callable case catch class clone const continue declare default
  die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit
  extends final finally fn for foreach function global goto if implements include include_once
  instanceof insteadof interface isset list match namespace new or print private protected
  public readonly require require_once return static switch throw trait try unset use var
  while xor yield
`)
const PHP_CONSTANTS = words('true false null')
const PHP_TYPES = words('int float string bool array callable iterable object mixed void never')

const LUA_KEYWORDS = words(`
  and break do else elseif end for function goto if in local nil not or repeat return then
  until while
`)
const LUA_CONSTANTS = words('true false')

const SQL_KEYWORDS = words(`
  SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX JOIN
  INNER LEFT RIGHT FULL OUTER ON AS AND OR NOT NULL IS IN BETWEEN LIKE ORDER BY GROUP HAVING
  LIMIT OFFSET UNION ALL DISTINCT CASE WHEN THEN ELSE END EXISTS PRIMARY KEY FOREIGN
  REFERENCES DEFAULT CONSTRAINT UNIQUE CHECK VIEW BEGIN COMMIT ROLLBACK TRANSACTION WITH
  RECURSIVE DESC ASC CROSS NATURAL USING RETURNING
`)
const SQL_CONSTANTS = words('NULL TRUE FALSE')

// ---------------------------------------------------------------------------
// C-style family scanner: comments, quoted strings, identifiers, numbers.
// ---------------------------------------------------------------------------

/** Per-file scan state for constructs that span lines. */
interface ScanState {
  blockComment?: boolean
  template?: boolean
  triple?: string
  rubyComment?: boolean
  luaLong?: boolean
  luaLongKind?: TokenKind | undefined
  htmlComment?: boolean
  markdownComment?: boolean
  markdownFence?: string
}

/** Normalized options for one language's C-style scanner. */
interface LanguageSpec {
  lineComments: readonly string[]
  blockComment: boolean
  quotes: readonly string[]
  backtickString: boolean
  hashComment: boolean
  rubyBlockComment: boolean
  luaLongBracket: boolean
  hashColor: boolean
  uppercase: boolean
  tripleQuotes: readonly string[] | null
  variablePrefixes: readonly string[] | null
  atWords: ReadonlySet<string> | null
  keywords: ReadonlySet<string>
  constants: ReadonlySet<string>
  types: ReadonlySet<string>
  declKeywords: ReadonlySet<string>
}

/** One line scanner bound to its language spec. */
type LineScanner = (line: string, state: ScanState) => CodeToken[]

/**
 * Scan one line with the shared lexer used by most languages.
 * The per-language `spec` decides comments, quotes, keywords, and classification.
 * @param line - source line.
 * @param state - carried state for this file.
 * @param spec - normalized language spec.
 * @returns tokens.
 */
function scanCStyle(line: string, state: ScanState, spec: LanguageSpec): CodeToken[] {
  const out = lineEmitter()
  const quotes = spec.quotes
  const lineComments = spec.lineComments
  const tripleQuotes = spec.tripleQuotes
  const variablePrefixes = spec.variablePrefixes
  const atWords = spec.atWords
  const uppercase = spec.uppercase
  let i = 0
  let depth = 0
  let paramsAt = -1
  let pendingName = false
  let pendingParams = false

  while (i < line.length) {
    if (state.blockComment) {
      const close = line.indexOf('*/', i)
      if (close === -1) {
        out.push(line.slice(i), 'comment')
        return out.finish()
      }
      out.push(line.slice(i, close + 2), 'comment')
      i = close + 2
      state.blockComment = false
      continue
    }
    if (state.template) {
      const close = findQuoteEnd(line, i, '`')
      if (close === -1) {
        out.push(line.slice(i), 'string')
        return out.finish()
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      state.template = false
      continue
    }
    if (state.triple) {
      const close = line.indexOf(state.triple, i)
      if (close === -1) {
        out.push(line.slice(i), 'string')
        return out.finish()
      }
      out.push(line.slice(i, close + state.triple.length), 'string')
      i = close + state.triple.length
      state.triple = undefined
      continue
    }
    if (state.rubyComment) {
      out.push(line.slice(i), 'comment')
      if (line.startsWith('=end', i)) state.rubyComment = false
      return out.finish()
    }
    if (state.luaLong) {
      const close = line.indexOf(']]', i)
      if (close === -1) {
        out.push(line.slice(i), state.luaLongKind)
        return out.finish()
      }
      out.push(line.slice(i, close + 2), state.luaLongKind)
      i = close + 2
      state.luaLong = false
      continue
    }

    const ch = line[i]

    if (spec.rubyBlockComment && i === 0 && line.startsWith('=begin')) {
      state.rubyComment = true
      out.push(line, 'comment')
      return out.finish()
    }
    if (spec.luaLongBracket) {
      if (line.startsWith('--[[', i)) {
        state.luaLong = true
        state.luaLongKind = 'comment'
        continue
      }
      if (line.startsWith('[[', i)) {
        state.luaLong = true
        state.luaLongKind = 'string'
        continue
      }
    }

    let lineComment = false
    for (const prefix of lineComments) {
      if (line.startsWith(prefix, i)) {
        lineComment = true
        break
      }
    }
    if (lineComment) {
      out.push(line.slice(i), 'comment')
      return out.finish()
    }
    if (spec.hashComment && ch === '#' && (i === 0 || isSpaceCode(line.charCodeAt(i - 1)))) {
      out.push(line.slice(i), 'comment')
      return out.finish()
    }
    if (spec.blockComment && ch === '/' && line[i + 1] === '*') {
      state.blockComment = true
      continue
    }
    if (spec.hashColor && ch === '#' && isHexCode(line.charCodeAt(i + 1))) {
      let end = i + 1
      while (end < line.length && isHexCode(line.charCodeAt(end))) end += 1
      out.push(line.slice(i, end), 'constant')
      i = end
      continue
    }
    if (variablePrefixes !== null && variablePrefixes.includes(ch)) {
      let end = i + 1
      if (ch === '@' && line[end] === '@') end += 1
      if (line[end] === '@' || line[end] === '$') end += 1
      if (line[end] === '{') {
        const close = line.indexOf('}', end + 1)
        end = close === -1 ? line.length : close + 1
      } else if (end < line.length && isIdentPartCode(line.charCodeAt(end))) {
        end = scanWordEnd(line, end)
      }
      out.push(line.slice(i, end), 'parameter')
      i = end
      continue
    }
    if (atWords !== null && ch === '@' && isIdentStartCode(line.charCodeAt(i + 1))) {
      const end = scanWordEnd(line, i + 1)
      const word = line.slice(i + 1, end)
      out.push(line.slice(i, end), atWords.has(word) ? 'keyword' : 'parameter')
      i = end
      continue
    }
    if (spec.backtickString && ch === '`') {
      const close = findQuoteEnd(line, i + 1, '`')
      if (close === -1) {
        out.push(line.slice(i), 'string')
        state.template = true
        return out.finish()
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      continue
    }
    if (tripleQuotes !== null) {
      let triple: string | null = null
      for (const quote of tripleQuotes) {
        if (line.startsWith(quote, i)) {
          triple = quote
          break
        }
      }
      if (triple !== null) {
        const close = line.indexOf(triple, i + triple.length)
        if (close === -1) {
          out.push(line.slice(i), 'string')
          state.triple = triple
          return out.finish()
        }
        out.push(line.slice(i, close + triple.length), 'string')
        i = close + triple.length
        continue
      }
    }
    if (quotes.includes(ch)) {
      const close = findQuoteEnd(line, i + 1, ch)
      if (close === -1) {
        out.push(line.slice(i), 'string')
        return out.finish()
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      continue
    }
    if (isDigitCode(line.charCodeAt(i))) {
      const end = scanNumberEnd(line, i)
      out.push(line.slice(i, end), 'number')
      i = end
      continue
    }
    if (isIdentStartCode(line.charCodeAt(i))) {
      const end = scanWordEnd(line, i)
      const word = line.slice(i, end)
      const key = uppercase ? word.toUpperCase() : word
      let kind: TokenKind | undefined
      if (spec.constants.has(key)) kind = 'constant'
      else if (spec.keywords.has(key)) kind = 'keyword'
      else if (spec.types.has(key)) kind = 'keyword'
      else if (paramsAt !== -1 && depth === paramsAt) kind = 'parameter'
      else if (pendingName) kind = 'function'
      else {
        let next = end
        while (next < line.length && isSpaceCode(line.charCodeAt(next))) next += 1
        if (next < line.length && line[next] === '(') kind = 'function'
      }
      if (kind === 'keyword' && spec.declKeywords.has(key)) {
        pendingName = true
        pendingParams = true
      }
      if (kind === 'function') pendingName = false
      out.push(word, kind)
      i = end
      continue
    }
    const code = line.charCodeAt(i)
    if (code === 40) {
      if (pendingParams) {
        paramsAt = depth + 1
        pendingParams = false
        pendingName = false
      }
      depth += 1
      out.push('(', 'punctuation')
      i += 1
      continue
    }
    if (code === 41) {
      if (paramsAt === depth) paramsAt = -1
      if (depth > 0) depth -= 1
      out.push(')', 'punctuation')
      i += 1
      continue
    }
    if (isSpaceCode(code)) out.text(ch)
    else out.push(ch, 'punctuation')
    i += 1
  }
  return out.finish()
}

// ---------------------------------------------------------------------------
// HTML/XML-family scanner: comments, tags, attributes, entities.
// ---------------------------------------------------------------------------

/** Scan one tag (from `<` to its `>` or line end) with attributes. */
function scanHtmlTag(line: string, start: number, out: LineEmitter): number {
  let i = start + 1
  out.push('<', 'punctuation')
  if (line[i] === '/') {
    out.push('/', 'punctuation')
    i += 1
  }
  if (line[i] === '!' || line[i] === '?') {
    const begin = i
    let end = i + 1
    while (end < line.length && isLetterCode(line.charCodeAt(end))) end += 1
    out.push(line.slice(begin, end), 'keyword')
    i = end
    const close = line.indexOf('>', i)
    if (close === -1) {
      out.push(line.slice(i), undefined)
      return line.length
    }
    out.push(line.slice(i, close), undefined)
    out.push('>', 'punctuation')
    return close + 1
  }
  let nameEnd = i
  while (nameEnd < line.length) {
    const code = line.charCodeAt(nameEnd)
    if (isIdentPartCode(code) || code === 45 || code === 58 || code === 46) nameEnd += 1
    else break
  }
  if (nameEnd > i) {
    out.push(line.slice(i, nameEnd), 'keyword')
    i = nameEnd
  }
  while (i < line.length) {
    const ch = line[i]
    const code = line.charCodeAt(i)
    if (ch === '>') {
      out.push('>', 'punctuation')
      return i + 1
    }
    if (ch === '/' && line[i + 1] === '>') {
      out.push('/>', 'punctuation')
      return i + 2
    }
    if (isSpaceCode(code)) {
      out.text(ch)
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const close = findQuoteEnd(line, i + 1, ch)
      if (close === -1) {
        out.push(line.slice(i), 'string')
        return line.length
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      continue
    }
    if (ch === '=') {
      out.push('=', 'punctuation')
      i += 1
      continue
    }
    if (ch === '{' && line[i + 1] === '{') {
      const close = line.indexOf('}}', i + 2)
      if (close === -1) {
        out.push(line.slice(i), 'parameter')
        return line.length
      }
      out.push(line.slice(i, close + 2), 'parameter')
      i = close + 2
      continue
    }
    if (ch === ':' || ch === '@' || ch === '#' || isIdentStartCode(code)) {
      let end = i
      while (end < line.length) {
        const inner = line.charCodeAt(end)
        if (isIdentPartCode(inner) || line[end] === '-' || line[end] === ':' || line[end] === '@'
          || line[end] === '.' || line[end] === '[' || line[end] === ']' || line[end] === '#') end += 1
        else break
      }
      if (end > i) {
        out.push(line.slice(i, end), 'parameter')
        i = end
        continue
      }
    }
    out.push(ch, 'punctuation')
    i += 1
  }
  return i
}

/** HTML / XML / SVG / Vue / Svelte template scanner. */
function scanHtml(line: string, state: ScanState): CodeToken[] {
  const out = lineEmitter()
  let i = 0
  while (i < line.length) {
    if (state.htmlComment) {
      const close = line.indexOf('-->', i)
      if (close === -1) {
        out.push(line.slice(i), 'comment')
        return out.finish()
      }
      out.push(line.slice(i, close + 3), 'comment')
      i = close + 3
      state.htmlComment = false
      continue
    }
    if (line.startsWith('<!--', i)) {
      const close = line.indexOf('-->', i + 4)
      if (close === -1) {
        state.htmlComment = true
        out.push(line.slice(i), 'comment')
        return out.finish()
      }
      out.push(line.slice(i, close + 3), 'comment')
      i = close + 3
      continue
    }
    const ch = line[i]
    if (ch === '<' && (isLetterCode(line.charCodeAt(i + 1)) || line[i + 1] === '/' || line[i + 1] === '!' || line[i + 1] === '?')) {
      i = scanHtmlTag(line, i, out)
      continue
    }
    if (ch === '&') {
      const close = line.indexOf(';', i + 1)
      if (close !== -1 && close - i <= 32) {
        out.push(line.slice(i, close + 1), 'constant')
        i = close + 1
        continue
      }
    }
    out.text(ch)
    i += 1
  }
  return out.finish()
}

// ---------------------------------------------------------------------------
// Markdown / MDX scanner.
// ---------------------------------------------------------------------------

/** Markdown/MDX scanner: fences, inline code, links, comments, emphasis markers. */
function scanMarkdown(line: string, state: ScanState): CodeToken[] {
  const out = lineEmitter()
  const trimmed = line.trimStart()
  const leading = line.length - trimmed.length
  const first = trimmed[0]

  if (state.markdownFence !== undefined) {
    if (trimmed.startsWith(state.markdownFence)) {
      let run = 0
      while (trimmed[run] === first) run += 1
      out.push(line.slice(0, leading), undefined)
      out.push(trimmed.slice(0, run), 'punctuation')
      out.push(trimmed.slice(run), 'string')
      state.markdownFence = undefined
    } else {
      out.push(line, undefined)
    }
    return out.finish()
  }
  if (first === '`' || first === '~') {
    let run = 0
    while (trimmed[run] === first) run += 1
    if (run >= 3) {
      out.push(line.slice(0, leading), undefined)
      out.push(trimmed.slice(0, run), 'punctuation')
      out.push(trimmed.slice(run), 'string')
      state.markdownFence = first.repeat(3)
      return out.finish()
    }
  }

  let i = 0
  while (i < line.length) {
    if (state.markdownComment) {
      const close = line.indexOf('-->', i)
      if (close === -1) {
        out.push(line.slice(i), 'comment')
        return out.finish()
      }
      out.push(line.slice(i, close + 3), 'comment')
      i = close + 3
      state.markdownComment = false
      continue
    }
    if (line.startsWith('<!--', i)) {
      const close = line.indexOf('-->', i + 4)
      if (close === -1) {
        state.markdownComment = true
        out.push(line.slice(i), 'comment')
        return out.finish()
      }
      out.push(line.slice(i, close + 3), 'comment')
      i = close + 3
      continue
    }
    const ch = line[i]
    if (ch === '`') {
      const close = line.indexOf('`', i + 1)
      if (close === -1) {
        out.push(line.slice(i), 'string')
        return out.finish()
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      continue
    }
    if (ch === '[') {
      const close = line.indexOf(']', i + 1)
      if (close !== -1 && line[close + 1] === '(') {
        const end = line.indexOf(')', close + 2)
        if (end !== -1) {
          out.push('[', 'punctuation')
          out.push(line.slice(i + 1, close), undefined)
          out.push('](', 'punctuation')
          out.push(line.slice(close + 2, end), 'link')
          out.push(')', 'punctuation')
          i = end + 1
          continue
        }
      }
      out.push('[', 'punctuation')
      i += 1
      continue
    }
    if (ch === 'h' || ch === 'w') {
      const rest = line.slice(i)
      if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.')) {
        let end = i
        while (end < line.length && !isSpaceCode(line.charCodeAt(end)) && line[end] !== ')' && line[end] !== ']' && line[end] !== '>') end += 1
        out.push(line.slice(i, end), 'link')
        i = end
        continue
      }
    }
    if (ch === '#' || ch === '>' || ch === '-' || ch === '+' || ch === '*' || ch === '_' || ch === '~' || ch === '|') {
      out.push(ch, 'punctuation')
      i += 1
      continue
    }
    out.text(ch)
    i += 1
  }
  return out.finish()
}

// ---------------------------------------------------------------------------
// YAML / TOML scanners: `key: value` and `key = value` line structure.
// ---------------------------------------------------------------------------

/** Find a structural separator outside quotes; -1 when the line has none. */
function findSeparator(line: string, from: number, to: number, separator: string): number {
  let quote: string | null = null
  for (let i = from; i < to; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === separator) {
      const next = i + 1
      if (next >= to || isSpaceCode(line.charCodeAt(next)) || separator === '=') return i
    }
  }
  return -1
}

/** Find a `#` comment start outside quotes. */
function findHashComment(line: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || isSpaceCode(line.charCodeAt(i - 1)))) return i
  }
  return -1
}

/** Scan a plain YAML/TOML value (strings, numbers, constants, punctuation). */
function scanScalar(line: string, from: number, to: number, out: LineEmitter, constants: ReadonlySet<string>): void {
  let i = from
  while (i < to) {
    const ch = line[i]
    const code = line.charCodeAt(i)
    if (isSpaceCode(code)) {
      out.text(ch)
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const close = findQuoteEnd(line, i + 1, ch)
      if (close === -1 || close >= to) {
        out.push(line.slice(i, to), 'string')
        return
      }
      out.push(line.slice(i, close + 1), 'string')
      i = close + 1
      continue
    }
    if (isDigitCode(code) || (ch === '-' && isDigitCode(line.charCodeAt(i + 1)))) {
      const end = Math.min(scanNumberEnd(line, isDigitCode(code) ? i : i + 1), to)
      out.push(line.slice(i, end), 'number')
      i = end
      continue
    }
    if (ch === '&' || ch === '*') {
      let end = i + 1
      while (end < to && isIdentPartCode(line.charCodeAt(end))) end += 1
      out.push(line.slice(i, end), 'constant')
      i = end
      continue
    }
    if (isIdentStartCode(code)) {
      let end = scanWordEnd(line, i)
      if (end > to) end = to
      const word = line.slice(i, end)
      if (constants.has(word.toLowerCase())) out.push(word, 'constant')
      else out.text(word)
      i = end
      continue
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ',' || ch === ':' || ch === '-' || ch === '?' || ch === '|' || ch === '>') {
      out.push(ch, 'punctuation')
      i += 1
      continue
    }
    out.text(ch)
    i += 1
  }
}

const YAML_CONSTANTS = words('true false null yes no on off')

/** YAML/yml scanner. */
function scanYaml(line: string, state: ScanState): CodeToken[] {
  const out = lineEmitter()
  const commentAt = findHashComment(line, 0)
  const end = commentAt === -1 ? line.length : commentAt
  let i = 0
  while (i < end && isSpaceCode(line.charCodeAt(i))) i += 1
  out.push(line.slice(0, i), undefined)
  if (i < end && line[i] === '-' && (i + 1 >= end || isSpaceCode(line.charCodeAt(i + 1)))) {
    out.push('-', 'punctuation')
    i += 1
    const spaces = i
    while (i < end && isSpaceCode(line.charCodeAt(i))) i += 1
    out.push(line.slice(spaces, i), undefined)
  }
  if (i < end && line[i] === '[') {
    scanScalar(line, i, end, out, YAML_CONSTANTS)
  } else {
    const colon = findSeparator(line, i, end, ':')
    if (colon === -1) {
      scanScalar(line, i, end, out, YAML_CONSTANTS)
    } else {
      const rawKey = line.slice(i, colon)
      const key = rawKey.trimEnd()
      if (key !== '') {
        const quoted = (key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))
        out.push(key, quoted ? 'string' : 'parameter')
        out.push(rawKey.slice(key.length), undefined)
      }
      out.push(':', 'punctuation')
      scanScalar(line, colon + 1, end, out, YAML_CONSTANTS)
    }
  }
  if (commentAt !== -1) out.push(line.slice(commentAt), 'comment')
  return out.finish()
}

const TOML_CONSTANTS = words('true false')

/** TOML scanner. */
function scanToml(line: string, state: ScanState): CodeToken[] {
  const out = lineEmitter()
  const commentAt = findHashComment(line, 0)
  const end = commentAt === -1 ? line.length : commentAt
  let i = 0
  while (i < end && isSpaceCode(line.charCodeAt(i))) i += 1
  out.push(line.slice(0, i), undefined)
  if (i < end && line[i] === '[') {
    const close = line.indexOf(']', i + 1)
    if (close !== -1 && close < end) {
      out.push('[', 'punctuation')
      out.push(line.slice(i + 1, close), 'keyword')
      out.push(']', 'punctuation')
      i = close + 1
      scanScalar(line, i, end, out, TOML_CONSTANTS)
    } else {
      scanScalar(line, i, end, out, TOML_CONSTANTS)
    }
  } else {
    const equals = findSeparator(line, i, end, '=')
    if (equals === -1) {
      scanScalar(line, i, end, out, TOML_CONSTANTS)
    } else {
      const rawKey = line.slice(i, equals)
      const key = rawKey.trimEnd()
      if (key !== '') {
        const quoted = (key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))
        out.push(key, quoted ? 'string' : 'parameter')
        out.push(rawKey.slice(key.length), undefined)
      }
      out.push('=', 'punctuation')
      scanScalar(line, equals + 1, end, out, TOML_CONSTANTS)
    }
  }
  if (commentAt !== -1) out.push(line.slice(commentAt), 'comment')
  return out.finish()
}

// ---------------------------------------------------------------------------
// Scanner registry.
// ---------------------------------------------------------------------------

const C_STYLE_DEFAULTS: LanguageSpec = Object.freeze({
  lineComments: [],
  blockComment: false,
  quotes: ['"', "'"],
  backtickString: false,
  hashComment: false,
  rubyBlockComment: false,
  luaLongBracket: false,
  hashColor: false,
  uppercase: false,
  tripleQuotes: null,
  variablePrefixes: null,
  atWords: null,
  keywords: EMPTY_SET,
  constants: EMPTY_SET,
  types: EMPTY_SET,
  declKeywords: EMPTY_SET,
})

/** Bind a language spec to a line scanner, filling unset options from the defaults. */
function cStyleScanner(overrides: Partial<LanguageSpec>): LineScanner {
  const spec = { ...C_STYLE_DEFAULTS, ...overrides }
  return (line, state) => scanCStyle(line, state, spec)
}

const SCANNERS: ReadonlyMap<string, LineScanner> = new Map<string, LineScanner>([
  ['javascript', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    backtickString: true,
    keywords: JS_KEYWORDS,
    constants: JS_CONSTANTS,
    declKeywords: words('function class interface enum'),
  })],
  ['typescript', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    backtickString: true,
    keywords: TS_KEYWORDS,
    constants: JS_CONSTANTS,
    types: TS_TYPES,
    declKeywords: words('function class interface enum namespace type'),
  })],
  ['json', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    constants: JSON_CONSTANTS,
  })],
  ['css', cStyleScanner({
    blockComment: true,
    hashColor: true,
    atWords: CSS_AT_RULES,
    keywords: CSS_KEYWORDS,
  })],
  ['python', cStyleScanner({
    hashComment: true,
    tripleQuotes: ['"""', "'''"],
    keywords: PYTHON_KEYWORDS,
    constants: PYTHON_CONSTANTS,
    declKeywords: words('def class'),
  })],
  ['shell', cStyleScanner({
    backtickString: true,
    hashComment: true,
    variablePrefixes: ['$'],
    keywords: SHELL_KEYWORDS,
    constants: SHELL_CONSTANTS,
    declKeywords: words('function'),
  })],
  ['go', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    backtickString: true,
    keywords: GO_KEYWORDS,
    constants: GO_CONSTANTS,
    types: GO_TYPES,
    declKeywords: words('func type'),
  })],
  ['rust', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    keywords: RUST_KEYWORDS,
    constants: RUST_CONSTANTS,
    types: RUST_TYPES,
    declKeywords: words('fn struct enum trait impl'),
  })],
  ['java', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    keywords: JAVA_KEYWORDS,
    constants: JAVA_CONSTANTS,
    types: JAVA_TYPES,
    declKeywords: words('class interface enum record'),
  })],
  ['kotlin', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    tripleQuotes: ['"""'],
    keywords: KOTLIN_KEYWORDS,
    constants: KOTLIN_CONSTANTS,
    types: KOTLIN_TYPES,
    declKeywords: words('fun class interface object enum'),
  })],
  ['c', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    keywords: C_KEYWORDS,
    constants: C_CONSTANTS,
    types: C_TYPES,
    declKeywords: words('struct enum union'),
  })],
  ['cpp', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    keywords: CPP_KEYWORDS,
    constants: CPP_CONSTANTS,
    types: CPP_TYPES,
    declKeywords: words('class struct enum union namespace'),
  })],
  ['ruby', cStyleScanner({
    backtickString: true,
    hashComment: true,
    rubyBlockComment: true,
    variablePrefixes: ['$', '@'],
    keywords: RUBY_KEYWORDS,
    constants: RUBY_CONSTANTS,
    declKeywords: words('def class module'),
  })],
  ['php', cStyleScanner({
    lineComments: ['//'],
    blockComment: true,
    backtickString: true,
    hashComment: true,
    variablePrefixes: ['$'],
    keywords: PHP_KEYWORDS,
    constants: PHP_CONSTANTS,
    types: PHP_TYPES,
    declKeywords: words('function class interface trait enum'),
  })],
  ['sql', cStyleScanner({
    lineComments: ['--'],
    blockComment: true,
    quotes: ["'", '"', '`'],
    uppercase: true,
    keywords: SQL_KEYWORDS,
    constants: SQL_CONSTANTS,
  })],
  ['lua', cStyleScanner({
    lineComments: ['--'],
    luaLongBracket: true,
    keywords: LUA_KEYWORDS,
    constants: LUA_CONSTANTS,
    declKeywords: words('function'),
  })],
  ['html', scanHtml],
  ['markdown', scanMarkdown],
  ['yaml', scanYaml],
  ['toml', scanToml],
])


/** Languages this module can tokenize. */
export const SUPPORTED_LANGUAGES: readonly string[] = Object.freeze([...SCANNERS.keys()])

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Tokenize `lines` as `language` with a fresh per-file state.
 * Pure function: calling it twice with the same input yields equal output.
 * @param language - canonical language id, as returned by `languageForPath`.
 * @param lines - source lines, without trailing newlines.
 * @returns one token array per line, or `undefined` when unsupported.
 */
export function tokenizeLines(language: string, lines: readonly string[]): CodeToken[][] | undefined {
  const scan = SCANNERS.get(language)
  if (scan === undefined) return undefined
  const state: ScanState = {}
  const result: CodeToken[][] = []
  for (const line of lines) {
    const text = typeof line === 'string' ? line : String(line ?? '')
    result.push(text === '' ? [] : scan(text, state))
  }
  return result
}

/**
 * Highlight one file's lines.
 * @param path - file path used to pick the language.
 * @param lines - source lines, without trailing newlines.
 * @returns one token array per line, or `undefined` when the language is unsupported.
 */
export function highlightLines(path: string, lines: readonly string[]): CodeToken[][] | undefined {
  const language = languageForPath(path)
  if (language === undefined) return undefined
  return tokenizeLines(language, lines)
}
