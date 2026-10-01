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

/** The most sensitive personal fields, scrambled like credentials (Dan, 2026-10-01). */
const SENSITIVE_PERSONAL_EXACT = new Set([
  'ssn', 'socialsecuritynumber', 'socialsecurity', 'dob', 'dateofbirth', 'birthdate', 'birthday',
])
const SENSITIVE_PERSONAL_SUFFIXES = ['accountnumber', 'routingnumber', 'ssn', 'dateofbirth']

/** A formatted SSN anywhere in text. */
const SSN_FORMATTED = /\b\d{3}-\d{2}-\d{4}\b/g
/**
 * A sensitive personal field keyed by name inside serialised text: a JSON body
 * held as a string (escaped quotes included, so doubly encoded JSON is caught),
 * or a form or query string. The key and its separator are kept; the value, up
 * to the next quote, backslash, ampersand, comma, brace or space, is replaced.
 */
const SENSITIVE_KEYED =
  /((?:ssn|social_?security_?number|social_?security|dob|date_?of_?birth|birth_?date|birthday|(?:bank_?)?account_?number|routing_?number)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^"'\\&,}\s]+)/gi

/** Names that are sometimes credentials and sometimes not: judged by value. */
const AMBIGUOUS = new Set(['token', 'key', 'auth', 'signature', 'sig', 'credential', 'credentials'])

/**
 * Credential shapes found anywhere in a string. Each has a capturing prefix
 * that is kept. Ordered so the more specific pattern wins.
 */
const SHAPES: RegExp[] = [
  /(eyJ)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
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

const isSensitivePersonalName = (n: string) =>
  SENSITIVE_PERSONAL_EXACT.has(n) || SENSITIVE_PERSONAL_SUFFIXES.some((suffix) => n.endsWith(suffix))

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

async function replaceShapes(key: CryptoKey, s: string): Promise<string | null> {
  let changed = false
  let out = s
  for (const shape of SHAPES) {
    const matches = [...out.matchAll(shape)]
    for (const m of matches) {
      changed = true
      out = out.replace(m[0], await replaceValue(key, m[0], m[1]))
    }
  }
  for (const m of [...out.matchAll(SENSITIVE_KEYED)]) {
    changed = true
    out = out.replace(m[0], m[1] + (await replaceValue(key, m[2], '')))
  }
  for (const m of [...out.matchAll(SSN_FORMATTED)]) {
    changed = true
    out = out.replace(m[0], await replaceValue(key, m[0], ''))
  }
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

    if (n !== null && (isCredentialName(n) || isSensitivePersonalName(n)) && value !== null && value !== undefined && value !== '') {
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
