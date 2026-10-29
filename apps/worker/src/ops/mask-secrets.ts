/**
 * Secret variable values masked out of what ops keeps (#2982, Dan's decision
 * of 2026-10-29: ops reads secrets, and "Secret values are masked in the step
 * results ops keeps"). The one masking implementation for ops: the step test
 * uses it (step-test.ts, #3002), a run uses it for its step records and its
 * error (run-walk.ts, #2998), and a run's checkpoints are written through its
 * refillable form (checkpoint.ts, #3024), rather than a second copy.
 *
 * Given a value and the secrets a step was given (variable name to value), it
 * answers a copy with every occurrence of each value, inside any string at any
 * depth, an object's keys included, replaced by the variable's name. So a kept
 * result still says which secret was there, never what it was. Each string is
 * read once from the left (secretSegments): at each point the longest value
 * found there is masked, so no part of a longer value is left by a shorter
 * one inside it. An empty value masks nothing. The value given is never changed.
 *
 * A step carries a secret escaped as often as raw: inside a JSON body (a
 * newline as \n, a quote as \"), in a URL (percent encoded) or in a form body
 * (a space as +). Each of those forms is masked too, or a multi line secret
 * such as a private key would survive in the kept request body.
 *
 * REFILLABLE (#3024). A checkpoint must come back exactly as the walk had it,
 * so maskSecretsForRefill writes each string holding a secret as a mask that
 * records which variable stood where, in which form, and refillSecrets puts
 * back the values served to the slice that reads it. A mask is a string that
 * starts with MASK_MARK and then 'm', followed by the JSON of its parts. A real
 * string that starts with MASK_MARK is written with MASK_MARK and 'l' before
 * it, so no real string, whatever it holds, can be read as a mask: every
 * stored string starting with the mark says by its next character which it is,
 * and every other stored string is exactly the real one.
 */

/** The forms a secret is masked in, by name, so a refill writes the served value in the same one. */
export const SECRET_FORMS = ['raw', 'json', 'uri', 'form'] as const
export type SecretForm = (typeof SECRET_FORMS)[number]

/** A secret in a given form, as text. */
function formOf(form: SecretForm, secret: string): string {
  switch (form) {
    case 'raw': return secret
    case 'json': return JSON.stringify(secret).slice(1, -1)
    case 'uri': return encodeURIComponent(secret)
    case 'form': return new URLSearchParams({ v: secret }).toString().slice(2)
  }
}

/** A secret as it is written raw, inside a JSON string, percent encoded in a URL, and in a form body, each text once. None for an empty one. */
function secretForms(secret: string): Array<{ form: SecretForm; text: string }> {
  if (secret === '') return []
  const forms: Array<{ form: SecretForm; text: string }> = []
  for (const form of SECRET_FORMS) {
    const text = formOf(form, secret)
    if (!forms.some((f) => f.text === text)) forms.push({ form, text })
  }
  return forms
}

interface SecretPair {
  name: string
  form: SecretForm
  text: string
}

/** Every secret in every form, longest first, so a longer value wins where two start at one place. */
function pairsOf(secrets: Readonly<Record<string, string>>): SecretPair[] {
  return Object.entries(secrets)
    .flatMap(([name, secret]) => secretForms(secret).map(({ form, text }) => ({ name, form, text })))
    .sort((a, b) => b.text.length - a.text.length)
}

/** One piece of a string: text kept as it is, or a secret masked. */
type Segment = string | { secret: string; form: SecretForm }

/**
 * The string read once from the left into kept text and masked secrets: at
 * each point the earliest secret found, the longest where two start together.
 * Null when it holds no secret, the common case.
 */
function secretSegments(text: string, pairs: readonly SecretPair[]): Segment[] | null {
  const next = pairs.map((p) => text.indexOf(p.text))
  if (next.every((i) => i === -1)) return null
  const out: Segment[] = []
  let pos = 0
  for (;;) {
    let best = -1
    for (let i = 0; i < pairs.length; i++) {
      if (next[i] !== -1 && next[i] < pos) next[i] = text.indexOf(pairs[i].text, pos)
      // Pairs are longest first, so a later pair starting at the same place never wins.
      if (next[i] !== -1 && (best === -1 || next[i] < next[best])) best = i
    }
    if (best === -1) break
    if (next[best] > pos) out.push(text.slice(pos, next[best]))
    out.push({ secret: pairs[best].name, form: pairs[best].form })
    pos = next[best] + pairs[best].text.length
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

/** The value with every string, an object's keys included, passed through mapText. */
function mapStrings(value: unknown, mapText: (text: string) => string): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mapText(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, inner]) => [mapText(k), walk(inner)]))
    return v
  }
  return walk(value)
}

/** The value with every secret, in every form, replaced by its variable's name: what a step record, a run's error and a step test keep. */
export function maskSecrets(value: unknown, secrets: Readonly<Record<string, string>>): unknown {
  const pairs = pairsOf(secrets)
  if (pairs.length === 0) return value
  return mapStrings(value, (text) => secretSegments(text, pairs)?.map((s) => (typeof s === 'string' ? s : s.secret)).join('') ?? text)
}

/**
 * Whether any secret, in any of the forms maskSecrets masks, is anywhere in
 * the value: in a string at any depth or an object's key (#2998). A run's
 * checkpoint, which is written to R2 and must never hold a secret, is asked
 * this once masked (checkpoint.ts encodeCheckpoint, #3024): a mask that would
 * still show a value (one equal to its own variable's name, say) is never
 * written.
 */
export function holdsSecret(value: unknown, secrets: Readonly<Record<string, string>>): boolean {
  const forms = Object.values(secrets).flatMap((s) => secretForms(s).map((f) => f.text))
  if (forms.length === 0) return false
  const holds = (v: unknown): boolean => {
    if (typeof v === 'string') return forms.some((form) => v.includes(form))
    if (Array.isArray(v)) return v.some(holds)
    if (v !== null && typeof v === 'object') return Object.entries(v).some(([k, inner]) => holds(k) || holds(inner))
    return false
  }
  return holds(value)
}

/** The character a stored string starts with when it is a mask ('m' next) or a real string that began with it ('l' next). */
export const MASK_MARK = '\u0000'
const MASKED = `${MASK_MARK}m`
const LITERAL = `${MASK_MARK}l`

/**
 * The value with every secret masked so that refillSecrets can put it back
 * (#3024): each string holding one becomes a mask naming its variables and
 * forms, each real string starting with MASK_MARK is escaped, and every other
 * string, number, boolean and null is kept as it is.
 */
export function maskSecretsForRefill(value: unknown, secrets: Readonly<Record<string, string>>): unknown {
  const pairs = pairsOf(secrets)
  return mapStrings(value, (text) => {
    const segments = pairs.length === 0 ? null : secretSegments(text, pairs)
    if (segments !== null) return MASKED + JSON.stringify(segments)
    return text.startsWith(MASK_MARK) ? LITERAL + text : text
  })
}

/** What a refill answers: the value with every mask refilled, the variables it was not served, or why a mask could not be read. */
export type Refilled =
  | { kind: 'refilled'; value: unknown }
  | { kind: 'unserved'; names: string[] }
  | { kind: 'malformed'; detail: string }

const isSegment = (v: unknown): v is Segment =>
  typeof v === 'string'
  || (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2
    && typeof (v as Record<string, unknown>).secret === 'string' && (SECRET_FORMS as readonly unknown[]).includes((v as Record<string, unknown>).form))

/**
 * The value maskSecretsForRefill wrote, with each mask refilled from secrets,
 * the values served to this slice, each in the form it was masked in. A
 * masked variable not served, or served empty, is named and nothing is
 * refilled: a mask is never left standing in for a value.
 */
export function refillSecrets(value: unknown, secrets: Readonly<Record<string, string>>): Refilled {
  const unserved = new Set<string>()
  let malformed: string | null = null
  const refilled = mapStrings(value, (text) => {
    if (!text.startsWith(MASK_MARK)) return text
    if (text.startsWith(LITERAL)) return text.slice(LITERAL.length)
    if (!text.startsWith(MASKED)) {
      malformed ??= 'a stored string starts with the mask mark and is neither a mask nor an escaped string'
      return text
    }
    let segments: unknown
    try {
      segments = JSON.parse(text.slice(MASKED.length))
    } catch {
      malformed ??= 'a mask is not JSON'
      return text
    }
    if (!Array.isArray(segments) || !segments.every(isSegment)) {
      malformed ??= 'a mask is not a list of kept text and masked secrets'
      return text
    }
    return segments.map((s) => {
      if (typeof s === 'string') return s
      const served = Object.hasOwn(secrets, s.secret) ? secrets[s.secret] : ''
      if (served === '') unserved.add(s.secret)
      return formOf(s.form, served)
    }).join('')
  })
  if (malformed !== null) return { kind: 'malformed', detail: malformed }
  if (unserved.size > 0) return { kind: 'unserved', names: [...unserved].sort() }
  return { kind: 'refilled', value: refilled }
}
