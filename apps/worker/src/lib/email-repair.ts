/**
 * Email repair (#723)
 *
 * A lead email carrying a stray typographic character (a curly apostrophe, a
 * full-width character, a zero-width space) makes Salesforce answer
 * INVALID_EMAIL_ADDRESS with a 400. The engine classifies 400 as permanent, so
 * there is no retry and the bidding run dies before a single bid is attempted,
 * losing a lead whose phone number was perfectly good.
 *
 * Two rules shape everything here.
 *
 * REPAIR ONLY WHAT IS UNAMBIGUOUS. A curly apostrophe has exactly one ASCII
 * counterpart, so rewriting it is safe. An accent does not: folding
 * "fernan549@" out of "fernan-with-an-accent549@" produces a DIFFERENT REAL
 * PERSON's mailbox, which is worse than having no address. Anything we cannot
 * repair with certainty is left exactly as it arrived, for the caller to drop.
 *
 * ONLY TOUCH WHAT IS PLAINLY A LONE ADDRESS. We do not know which Salesforce
 * fields are email fields without reading the synced schema on every write, so
 * the gate is the value's own shape: exactly one at-sign, and a valid ASCII
 * address once repaired (which forbids whitespace, so prose cannot qualify).
 * Without that gate a note field reading "call me @gmail.com now" would be
 * silently rewritten into an address. A value that does not clear the gate is
 * returned byte-identical, never half-repaired.
 *
 * Characters are identified by NUMERIC CODE POINT rather than by literal or by
 * escape sequence. A literal zero-width or control character in source is
 * invisible to every reviewer, and this file must stay readable.
 */

/** Zero-width joiners, zero-width space, and the byte-order mark. */
const ZERO_WIDTH_CODES = new Set([0x200b, 0x200c, 0x200d, 0xfeff])

/**
 * Typographic stand-ins for the ASCII apostrophe, which IS legal in an email
 * local part. NFKC does not fold these, so they are listed explicitly. The
 * ASCII grave accent is deliberately absent: it is already legal, so rewriting
 * it would be a change with no justification.
 */
const APOSTROPHE_LIKE_CODES = new Set([
  0x2018, // left single quotation mark
  0x2019, // right single quotation mark (the 2026-07-30 lost lead)
  0x201a, // single low-9 quotation mark
  0x201b, // single high-reversed-9 quotation mark
  0x2032, // prime
  0x02b9, // modifier letter prime
  0x02bc, // modifier letter apostrophe
  0x00b4, // acute accent
])

/** True for a C0 or C1 control character. */
function isControl(cp: number): boolean {
  return cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
}

/**
 * Deliberately ASCII-only, to match what Salesforce actually accepts. An
 * accented local part fails here, which is the point: it routes to the caller's
 * drop path rather than to a guessed substitution.
 */
const ASCII_EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/

/** RFC 5321 caps a path at 254 characters. */
const MAX_EMAIL_LENGTH = 254

/** Is this a valid address by Salesforce's reckoning (ASCII, real domain)? */
export function isValidAsciiEmail(value: string): boolean {
  if (!value || value.length > MAX_EMAIL_LENGTH) return false
  return ASCII_EMAIL.test(value)
}

/** Drop invisibles, and map apostrophe lookalikes to the ASCII apostrophe. */
function foldTypography(value: string): string {
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (isControl(cp) || ZERO_WIDTH_CODES.has(cp)) continue
    out += APOSTROPHE_LIKE_CODES.has(cp) ? "'" : ch
  }
  return out
}

/**
 * Repair unambiguous typographic damage in what looks like a lone email
 * address. Returns the input unchanged when the value is not an address
 * candidate, or when the repair would not produce a valid address.
 */
export function repairEmailValue(value: string): string {
  if (typeof value !== 'string' || value === '') return value

  // NFKC folds full-width forms to ASCII. It does NOT strip accents, which is
  // exactly the behavior we want.
  const normalized = foldTypography(value.trim()).normalize('NFKC')

  // ASCII_EMAIL is the only gate, and it is a strict one: it enforces the single
  // at-sign (the local-part character class excludes it), forbids whitespace,
  // and rejects any non-ASCII character. Nothing that fails it is ever returned,
  // so a value either comes back fully repaired or byte-identical.
  return isValidAsciiEmail(normalized) ? normalized : value
}

export interface EmailRepair {
  /** Dot path to the repaired field, e.g. "Email__c" or "contacts[0].email". */
  path: string
  from: string
  to: string
}

/**
 * Walk a request body and repair every address-shaped string in it. Returns the
 * original body reference untouched when nothing needed repair, so an unchanged
 * body is provably identical rather than a lookalike copy.
 */
export function repairEmailFieldsInBody(body: unknown): { body: unknown; repairs: EmailRepair[] } {
  const repairs: EmailRepair[] = []
  const walked = walk(body, '', repairs)
  return { body: repairs.length > 0 ? walked : body, repairs }
}

function walk(value: unknown, path: string, repairs: EmailRepair[]): unknown {
  if (typeof value === 'string') {
    const repaired = repairEmailValue(value)
    if (repaired !== value) {
      repairs.push({ path, from: value, to: repaired })
      return repaired
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, `${path}[${i}]`, repairs))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, path ? `${path}.${k}` : k, repairs)
    }
    return out
  }
  return value
}
