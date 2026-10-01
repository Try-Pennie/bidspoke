/**
 * The one redaction function for porting captures (#1705, decision D5).
 *
 * Redaction happens ONLY on the Bidspoke side. The Pipedream capture step holds
 * no rules, so there is no pasted copy that can drift from this one (#1687 must
 * fix, LESSONS L423), and both halves of a comparison are redacted by this same
 * code under the same key.
 *
 * What it does:
 * - drops request credentials outright: Authorization, X-API-Key, cookies;
 * - replaces the value of a field whose NAME says it is a credential
 *   (password, client_secret, api_key, access_token, ...) with a keyed hash;
 * - replaces any string whose SHAPE is a credential (a JWT, a bearer value, a
 *   Stripe, Slack, GitHub or AWS key), whatever the field is called;
 * - replaces SSN, date of birth and account or routing numbers the same way,
 *   by field name, plus any formatted SSN in free text and any of them keyed
 *   inside serialised text (JSON held as a string, doubly encoded JSON, form
 *   bodies) (Dan, 2026-10-01: those three are scrambled; name, address,
 *   phone and email stay readable for debugging);
 * - treats the ambiguous name `token` (and `key`, `auth`, `signature`) by its
 *   value: a credential shaped value is replaced, a real non credential field
 *   such as a campaign token is kept.
 *
 * A replacement is HMAC(key, value), hex, stretched or cut to the original
 * length, behind the original's known prefix (`at_`, `sk_live_`, `eyJ`,
 * `Bearer `), so a reviewer can still see what kind of value sat there, two
 * captures of one value still compare equal, and nobody without the key can
 * recompute it. The count of replaced fields is returned so the receiver can
 * record how much it removed.
 *
 * The input is never mutated. An unusable key throws by name: a caller must
 * refuse the write rather than store a document it could not redact.
 */

export interface RedactionResult {
  value: unknown
  redactedCount: number
}

const DROPPED = new Set(['authorization', 'xapikey', 'cookie', 'setcookie', 'proxyauthorization'])

const CREDENTIAL_EXACT = new Set([
  'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'apikey', 'apisecret', 'secretkey',
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'bearertoken',
  'privatekey', 'consumersecret', 'signingsecret', 'webhooksecret', 'passphrase',
])
const CREDENTIAL_SUFFIXES = ['password', 'secret', 'apikey', 'accesstoken', 'refreshtoken', 'privatekey']

/**
 * The most sensitive personal fields, scrambled like credentials (Dan,
 * 2026-10-01). Matched on the name's TOKENS, because the real workflows wrap
 * them (`formattedSSN`, `ssnRaw`, `Applicant_SSN__c`, `SocialSecurityNumber__c`,
 * `formattedDOB`, `BirthDate__c`, measured in the 2026-09-30 export), while a
 * match on any substring of the name scrambled ordinary fields whose letters
 * merely contain one (`business_name` holds "ssn" once its underscore is gone,
 * `adobe_id` holds "dob"). A name is sensitive when some run of its adjacent
 * tokens spells one of these words, so `birthdate`, `birth_date` and
 * `BirthDate` all match and `address_number` does not.
 */
const SENSITIVE_PERSONAL_WORDS = new Set([
  'ssn', 'dob', 'socialsecurity', 'socialsecuritynumber', 'socialnum', 'dateofbirth', 'birthdate', 'birthday',
  'accountnumber', 'routingnumber',
])
/** The longest word above, in tokens (social security number). */
const MAX_WORD_TOKENS = 3

/**
 * Splits a field name into lower case tokens: on underscores, hyphens, spaces
 * and dots, at camelCase and letter to digit boundaries, after removing a
 * trailing Salesforce `__c` or `_SO__c`.
 */
export function nameTokens(name: string): string[] {
  return name
    .replace(/(?:_SO)?__c$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter((t) => t.length > 0)
}

/** True when the name's tokens contain a sensitive personal word. */
export function isSensitivePersonalName(name: string): boolean {
  const tokens = nameTokens(name)
  for (let i = 0; i < tokens.length; i++) {
    let joined = ''
    for (let j = i; j < tokens.length && j < i + MAX_WORD_TOKENS; j++) {
      joined += tokens[j]
      if (SENSITIVE_PERSONAL_WORDS.has(joined)) return true
    }
  }
  return false
}

/** A formatted SSN anywhere in text. */
const SSN_FORMATTED = /\b\d{3}-\d{2}-\d{4}\b/g
/**
 * The serialised text pass: a field keyed by name inside a JSON body held as a
 * string (doubly encoded JSON included), a form or query string, or prose.
 *
 * It walks the text once, stopping at each `:` or `=`. From each it reads the
 * key BACK (a quoted key, escaped quotes allowed, or a bare run of key
 * characters) and judges it with the same token rule the object path uses, so
 * `date-of-birth=`, `X-SSN=` and `"account number":` are caught. Only for a
 * sensitive key does it read the value FORWARD:
 * - a quoted value is taken whole, to its closing quote at the same escaping
 *   depth, spaces, commas and escaped quotes included;
 * - `null`, `true`, `false` and `undefined` are left alone, so a JSON body
 *   stays valid and a literal is not mistaken for data;
 * - a JSON number becomes a keyed number of the same length, so the body still
 *   parses;
 * - an unquoted form value runs to the next `&` (or the end, or a quote,
 *   backslash or line break, which close the string that holds it);
 * - prose (`ssn: 123456789`, a bare key and a colon) runs to the next comma or
 *   semicolon and is replaced only when it holds a digit, so `dob: unknown`
 *   stays readable.
 *
 * Built to run in time linear in the text (a review of #1711 found the earlier
 * regex, which opened with an unbounded letter run, quadratic: a 1 MiB body of
 * letters did not finish in 200 seconds). Reading a key back is bounded, and
 * after a value is replaced the walk resumes past it.
 */
const MAX_KEY_CHARS = 128
const MAX_PADDING = 16
const BACKSLASH = 92
const COLON = 58
const EQUALS = 61
const isKeyCode = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46
const isQuoteCode = (c: number) => c === 34 || c === 39
const isPadding = (c: number) => c === 32 || c === 9
const LITERALS = ['null', 'true', 'false', 'undefined']
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/** Names that are sometimes credentials and sometimes not: judged by value. */
const AMBIGUOUS = new Set(['token', 'key', 'auth', 'signature', 'sig', 'credential', 'credentials'])

/**
 * Credential shapes found anywhere in a string. Each has a capturing prefix
 * that is kept. Ordered so the more specific pattern wins.
 */
const SHAPES: RegExp[] = [
  /(?<![A-Za-z0-9_-])(eyJ)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /(Bearer )[A-Za-z0-9._~+/=-]{8,}/g,
  /(sk_live_|sk_test_|rk_live_|pk_live_)[A-Za-z0-9]{8,}/g,
  /(xox[abprs]-)[A-Za-z0-9-]{10,}/g,
  /(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/g,
  /\b(AKIA)[0-9A-Z]{16}\b/g,
  /(sk-ant-)[A-Za-z0-9_-]{20,}/g,
]

/** A long opaque string: how an access token looks when it carries no prefix. */
const OPAQUE = /^[A-Za-z0-9._~+/=-]{20,}$/
const looksOpaque = (s: string) => OPAQUE.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s)

const KNOWN_PREFIX = /^(Bearer |sk_live_|sk_test_|rk_live_|pk_live_|xox[abprs]-|ghp_|gho_|ghs_|github_pat_|AKIA|sk-ant-|eyJ|[A-Za-z]{1,6}_)/

const normalise = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '')

const isCredentialName = (n: string) =>
  CREDENTIAL_EXACT.has(n) || CREDENTIAL_SUFFIXES.some((suffix) => n.endsWith(suffix))

const encoder = new TextEncoder()

async function importKey(keyHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('porting redaction key is not 32 bytes of hex')
  const raw = new Uint8Array(32)
  for (let i = 0; i < 32; i++) raw[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function keyedFill(key: CryptoKey, value: string, length: number): Promise<string> {
  let out = ''
  for (let block = 0; out.length < length; block++) {
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${block}:${value}`))
    out += [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return out.slice(0, length)
}

/** Same length, same known prefix, keyed hash for the rest. */
async function replaceValue(key: CryptoKey, value: string, prefix: string): Promise<string> {
  const keep = prefix.length < value.length ? prefix : ''
  return keep + (await keyedFill(key, value, value.length - keep.length))
}

type Replacer = (value: string, prefix: string) => Promise<string>

/** One span of text to replace: [start, end) becomes the replacement. */
interface Splice { start: number; end: number; text: string }

/**
 * Rewrites every span in one pass. Building the output once keeps the cost
 * linear in the text however many spans there are; replacing each match with
 * String.replace rescanned the whole text per match.
 */
function applySplices(s: string, splices: Splice[]): string {
  let out = ''
  let at = 0
  for (const sp of splices) {
    out += s.slice(at, sp.start) + sp.text
    at = sp.end
  }
  return out + s.slice(at)
}

async function replaceMatches(s: string, pattern: RegExp, replace: Replacer): Promise<Splice[]> {
  const splices: Splice[] = []
  for (const m of s.matchAll(pattern)) {
    splices.push({ start: m.index, end: m.index + m[0].length, text: await replace(m[0], m[1] ?? '') })
  }
  return splices
}

interface KeyBefore { name: string; quoted: boolean }

/** The key ending just before the separator at `sep`, read backwards, or null. */
function keyBefore(s: string, sep: number): KeyBefore | null {
  let i = sep - 1
  const floor = Math.max(0, sep - MAX_PADDING)
  while (i >= floor && isPadding(s.charCodeAt(i))) i--
  if (i < 0) return null
  const quote = s.charCodeAt(i)
  if (isQuoteCode(quote)) {
    // `"key"` or, in doubly encoded JSON, `\"key\"`: drop the escaping
    // backslashes before the closing quote, then find the opening one.
    let end = i
    while (end > 0 && s.charCodeAt(end - 1) === BACKSLASH) end--
    const limit = Math.max(0, end - MAX_KEY_CHARS)
    for (let j = end - 1; j >= limit; j--) {
      const c = s.charCodeAt(j)
      if (c === quote) {
        // The opening quote's own escape, if any, sits before it and belongs
        // to the text around the key.
        const start = j + 1
        return start < end ? { name: s.slice(start, end), quoted: true } : null
      }
      if (c === 10 || c === 13) return null
    }
    return null
  }
  const limit = Math.max(0, i + 1 - MAX_KEY_CHARS)
  let j = i
  while (j >= limit && isKeyCode(s.charCodeAt(j))) j--
  return j === i ? null : { name: s.slice(j + 1, i + 1), quoted: false }
}

interface ValueSpan { start: number; end: number; kind: 'text' | 'number' }

/** True when `s` holds `word` at `at`, not followed by another key character. */
const wordAt = (s: string, at: number, word: string) =>
  s.startsWith(word, at) && !isKeyCode(s.charCodeAt(at + word.length))

/**
 * The value after the separator at `sep` for a sensitive key, or null when
 * there is nothing to replace. A quoted value with no closing quote runs to the
 * end of the text: everything after its opening quote belongs to it.
 */
function valueAfter(s: string, sep: number, key: KeyBefore): ValueSpan | null {
  let i = sep + 1
  const ceiling = Math.min(s.length, sep + 1 + MAX_PADDING)
  while (i < ceiling && isPadding(s.charCodeAt(i))) i++
  if (i >= s.length) return null

  // A quoted value, at any escaping depth: `"v"`, `\"v\"`, `\\\"v\\\"`.
  let open = i
  while (open < s.length && s.charCodeAt(open) === BACKSLASH) open++
  if (open < s.length && isQuoteCode(s.charCodeAt(open))) {
    const quote = s.charCodeAt(open)
    const depth = open - i
    // At depth d (d = 2^L - 1 for L levels of encoding) a quote closes the
    // value when the backslashes before it number d modulo 2(d + 1); any other
    // count escapes a quote or a backslash inside the value.
    const period = 2 * (depth + 1)
    let run = 0
    for (let j = open + 1; j < s.length; j++) {
      const c = s.charCodeAt(j)
      if (c === BACKSLASH) {
        run++
        continue
      }
      if (c === quote && run % period === depth) {
        const end = j - depth
        return end > open + 1 ? { start: open + 1, end, kind: 'text' } : null
      }
      run = 0
    }
    return open + 1 < s.length ? { start: open + 1, end: s.length, kind: 'text' } : null
  }

  if (LITERALS.some((word) => wordAt(s, i, word))) return null

  if (key.quoted) {
    JSON_NUMBER.lastIndex = i
    const m = JSON_NUMBER.exec(s)
    if (m && !isKeyCode(s.charCodeAt(i + m[0].length))) return { start: i, end: i + m[0].length, kind: 'number' }
  }

  const prose = !key.quoted && s.charCodeAt(sep) === COLON
  let end = i
  let digit = false
  for (; end < s.length; end++) {
    const c = s.charCodeAt(end)
    if (c === 38 || isQuoteCode(c) || c === BACKSLASH || c === 10 || c === 13) break
    if (key.quoted && (c === 44 || c === 125 || c === 93 || isPadding(c))) break
    if (prose && (c === 44 || c === 59)) break
    if (c >= 48 && c <= 57) digit = true
  }
  while (end > i && isPadding(s.charCodeAt(end - 1))) end--
  if (end === i || (prose && !digit)) return null
  return { start: i, end, kind: 'text' }
}

/** Values of keyed fields whose key tokens name a sensitive personal field. */
async function replaceKeyed(s: string, replaceText: Replacer, replaceNumber: (value: string) => Promise<string>): Promise<Splice[]> {
  const splices: Splice[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c !== COLON && c !== EQUALS) continue
    const key = keyBefore(s, i)
    if (key === null || !isSensitivePersonalName(key.name)) continue
    const value = valueAfter(s, i, key)
    if (value === null) continue
    const raw = s.slice(value.start, value.end)
    splices.push({ start: value.start, end: value.end, text: value.kind === 'number' ? await replaceNumber(raw) : await replaceText(raw, '') })
    i = value.end - 1
  }
  return splices
}

/**
 * A keyed number of the same length and shape: each digit replaced by a keyed
 * digit, the sign, point and exponent kept, and a leading zero avoided where it
 * would make the JSON invalid.
 */
async function keyedNumber(key: CryptoKey, value: string): Promise<string> {
  const fill = await keyedFill(key, value, value.length)
  let out = ''
  const integerStart = value.startsWith('-') ? 1 : 0
  let integerLength = 0
  while (integerStart + integerLength < value.length && /\d/.test(value[integerStart + integerLength])) integerLength++
  for (let i = 0; i < value.length; i++) {
    if (!/\d/.test(value[i])) {
      out += value[i]
      continue
    }
    let d = parseInt(fill[i], 16) % 10
    if (i === integerStart && integerLength > 1 && d === 0) d = 1 + (parseInt(fill[i], 16) % 9)
    out += String(d)
  }
  return out
}

async function replaceShapes(key: CryptoKey, s: string): Promise<string | null> {
  // One keyed hash per distinct value within a call: a body repeating a value
  // pays for it once.
  const memo = new Map<string, string>()
  const replace: Replacer = async (value, prefix) => {
    const id = JSON.stringify([prefix, value])
    let out = memo.get(id)
    if (out === undefined) {
      out = await replaceValue(key, value, prefix)
      memo.set(id, out)
    }
    return out
  }

  let changed = false
  let out = s
  const pass = (splices: Splice[]) => {
    if (splices.length === 0) return
    changed = true
    out = applySplices(out, splices)
  }
  for (const shape of SHAPES) pass(await replaceMatches(out, shape, replace))
  pass(await replaceKeyed(out, replace, async (value) => {
    const id = JSON.stringify(['number', value])
    let num = memo.get(id)
    if (num === undefined) {
      num = await keyedNumber(key, value)
      memo.set(id, num)
    }
    return num
  }))
  pass(await replaceMatches(out, SSN_FORMATTED, (value) => replace(value, '')))
  return changed ? out : null
}

async function replaceWhole(key: CryptoKey, value: unknown): Promise<string> {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return replaceValue(key, s, typeof value === 'string' ? (KNOWN_PREFIX.exec(s)?.[0] ?? '') : '')
}

export async function redactCapture(input: unknown, keyHex: string): Promise<RedactionResult> {
  const key = await importKey(keyHex)
  let redactedCount = 0

  const walk = async (value: unknown, name: string | null): Promise<unknown> => {
    const n = name === null ? null : normalise(name)

    if (n !== null && (isCredentialName(n) || isSensitivePersonalName(name as string)) && value !== null && value !== undefined && value !== '') {
      redactedCount++
      return replaceWhole(key, value)
    }
    if (n !== null && AMBIGUOUS.has(n) && typeof value === 'string' && looksOpaque(value)) {
      redactedCount++
      return replaceWhole(key, value)
    }
    if (typeof value === 'string') {
      const replaced = await replaceShapes(key, value)
      if (replaced !== null) {
        redactedCount++
        return replaced
      }
      return value
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (const item of value) out.push(await walk(item, null))
      return out
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (DROPPED.has(normalise(k))) {
          redactedCount++
          continue
        }
        out[k] = await walk(v, k)
      }
      return out
    }
    return value
  }

  const value = await walk(input, null)
  return { value, redactedCount }
}
