/**
 * Strips credentials from a recorded outbound request (#1704).
 *
 * The gate compares requests "minus credentials": a header, query parameter or
 * body field whose NAME says it carries a secret keeps its presence and loses its
 * value. Dropping a credential is still a difference (present against absent);
 * only the value is hidden, so a transcript never holds one even if a placeholder
 * is ever replaced by something real.
 */

export const CREDENTIAL_NAME = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|signature|credential|client[-_]?id|private[-_]?key|x-api-key)/i

export const REDACTED = '[redacted]'

/**
 * Headers the local runtime adds on a subrequest that no script sets: cf-worker names
 * the hosting script, so it would report the harness's naming, not the code's.
 */
const PLATFORM_HEADERS = new Set(['cf-worker'])

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(headers).sort()) {
    if (PLATFORM_HEADERS.has(k.toLowerCase())) continue
    out[k.toLowerCase()] = CREDENTIAL_NAME.test(k) ? REDACTED : headers[k]
  }
  return out
}

export function redactBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactBody)
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) out[k] = CREDENTIAL_NAME.test(k) && (typeof v === 'string' || typeof v === 'number') ? REDACTED : redactBody(v)
    return out
  }
  return body
}

/** Path plus a query string whose credential named parameters are redacted. */
export function redactPathAndQuery(url: URL): string {
  const params = [...url.searchParams.entries()].map(([k, v]) => `${k}=${CREDENTIAL_NAME.test(k) ? REDACTED : v}`)
  return params.length ? `${url.pathname}?${params.join('&')}` : url.pathname
}

/** Parses a body as JSON or form data where it can, so a difference names a field. */
export function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries())
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
