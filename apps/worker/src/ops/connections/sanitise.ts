/**
 * The request sanitiser (#2335, finding F120): what a connection bound request
 * looks like once it is safe to record, and the scrub every text leaving
 * connectionFetch passes through.
 *
 * A request is recorded BEFORE its auth is applied (plan Phase 5), so the
 * connection's own credential is never on it. What the sanitiser removes is
 * what the CALLER put there: a credential header, a token query parameter, a
 * token body field. Then every known secret (the opened login's values and the
 * token the auth applied) is scrubbed from whatever is left, wherever it sits,
 * the path included, because some services put a token in the path.
 *
 * A token name is matched broadly (L648): a field that only looks like a token
 * (a page token) loses its value in the record, which costs a little detail;
 * a real token kept costs a credential.
 */

export const REDACTED = '[redacted]'

/** Shorter than this is a word, not a secret: scrubbing it would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8

const CREDENTIAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token',
  'x-goog-api-key', 'x-amz-security-token', 'x-csrf-token',
])

const TOKEN_EXACT = new Set(['key', 'code', 'sig', 'auth', 'pass', 'pwd', 'jwt', 'otp'])
const TOKEN_PART = /token|secret|passw|assertion|signature|authoriz|credential|verifier|api[-_]?key|private[-_]?key|client[-_]?key|session/i

/**
 * A header that carries a credential. Narrower than isTokenName on purpose: this
 * decides what is SENT (the connection's auth is the only credential a request
 * carries), so it must not drop an ordinary header that merely looks like one.
 */
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase())
}

/** Whether a header, query parameter or body field name carries a credential, judged broadly for what is RECORDED. */
export function isTokenName(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase()) || TOKEN_EXACT.has(name.toLowerCase()) || TOKEN_PART.test(name)
}

/** Every known secret, its URL encoded form included, replaced by REDACTED; the longest first so an overlap goes whole. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>()
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_SECRET_LENGTH) continue
    forms.add(s)
    forms.add(encodeURIComponent(s))
  }
  let out = text
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(REDACTED)
  return out
}

/** The opened login whole, and every string of at least MIN_SECRET_LENGTH inside it when it is JSON. */
export function secretsOfLogin(plaintext: string): string[] {
  const found = new Set<string>([plaintext])
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.length >= MIN_SECRET_LENGTH) found.add(value)
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk)
    }
  }
  try {
    walk(JSON.parse(plaintext))
  } catch {
    // A login that is not JSON is one secret, already taken whole.
  }
  return [...found]
}

export interface RecordedRequest {
  method: string
  /** Token query parameters redacted, known secrets scrubbed from the rest. */
  url: string
  /** Credential headers removed. */
  headers: Record<string, string>
  /** Token fields redacted; a stream, form data or binary body named rather than read. */
  body: string | null
  /** 1, or 2 for the one retry after a renewal. */
  attempt: number
}

function redactQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const at = pair.indexOf('=')
      const rawName = at < 0 ? pair : pair.slice(0, at)
      let name = rawName
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '))
      } catch {
        // A malformed escape: judge the raw name.
      }
      return at >= 0 && isTokenName(name) ? `${rawName}=${REDACTED}` : pair
    })
    .join('&')
}

function sanitiseUrl(url: string): string {
  const hashAt = url.indexOf('#')
  const withoutHash = hashAt < 0 ? url : url.slice(0, hashAt)
  const queryAt = withoutHash.indexOf('?')
  if (queryAt < 0) return withoutHash
  return `${withoutHash.slice(0, queryAt)}?${redactQuery(withoutHash.slice(queryAt + 1))}`
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isTokenName(k) ? REDACTED : redactJson(v)]))
  }
  return value
}

function looksLikeForm(text: string, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes('application/x-www-form-urlencoded')) return true
  return /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(text)
}

function sanitiseText(text: string, contentType: string | null): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text)))
    } catch {
      // Not JSON after all: fall through.
    }
  }
  if (looksLikeForm(text, contentType)) return redactQuery(text)
  return text
}

function bodyText(body: unknown, contentType: string | null): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return sanitiseText(body, contentType)
  if (body instanceof URLSearchParams) return redactQuery(body.toString())
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[stream]'
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '[form data]'
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[blob ${body.size} bytes]`
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    try {
      return sanitiseText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), contentType)
    } catch {
      return `[binary ${bytes.byteLength} bytes]`
    }
  }
  return '[body]'
}

/**
 * The request as it may be recorded. `secrets` are scrubbed from the url, the
 * remaining header values and the body after the names are redacted.
 */
export function sanitiseRequest(
  request: { method: string; url: string; headers: Headers; body: unknown },
  secrets: readonly string[],
  attempt: number,
): RecordedRequest {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    if (!isTokenName(name)) headers[name.toLowerCase()] = scrubSecrets(value, secrets)
  })
  const body = bodyText(request.body, request.headers.get('content-type'))
  return {
    method: request.method.toUpperCase(),
    url: scrubSecrets(sanitiseUrl(request.url), secrets),
    headers,
    body: body === null ? null : scrubSecrets(body, secrets),
    attempt,
  }
}
