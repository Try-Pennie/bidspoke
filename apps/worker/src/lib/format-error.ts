import { summarizeHtmlErrorBody } from './html-error-summary'
import { truncateKeepingTail } from './truncate-text'

// Single source of truth for rendering an unknown thrown/returned value as
// human-readable alert text.
//
// Supabase/PostgREST errors are plain objects ({ message, code, details, hint }),
// not Error instances, so a bare `String(e)` renders them as the useless
// "[object Object]" that names no failure. Every alert path that reports a cause
// must go through here. Three call sites independently grew their own copy or
// workaround before this existed (#512).

// Postgres splits a failure across two fields: `message` carries the generic rule
// ("violates foreign key constraint") and `details` carries the offending value
// ("Key (person_id)=(abc-123) is not present"). Reporting only `message` names the
// constraint but never the cause, so fold `details` in (or `hint` when there are
// no details). Returns `message: details (code)`.
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

// Truncate an alert error to `max` characters WITHOUT dropping the tail.
// formatErr renders `message: details (code)`, so the SQLSTATE / PostgREST code
// sits at the very end -- the single most searchable token in the alert. Slicing
// only the head (the old behavior) cut it off once #602 folded `details` in and
// pushed long constraint errors past the limit (#605). Keep both ends: the head
// preserves reading order, the tail preserves the code.
const ALERT_TAIL_CHARS = 96

export function truncateErrorForAlert(text: string, max = 300): string {
  return truncateKeepingTail(text, max, ALERT_TAIL_CHARS)
}

// A `Response` thrown to signal a non-2xx (the integration/webhook executor does
// this so the engine can classify the HTTP error) has no `.message`, and its
// status and body live on PROTOTYPE GETTERS rather than own properties. So
// JSON.stringify sees neither: a bare 502 rendered as the string "{}", and one
// with an attached payload rendered as a wall of resolved input naming no cause
// (#708). The body text is carried on `bodyText` because a Response body can only
// be read once, and the executor already consumed it.
//
// On 2026-07-28 thirteen Main Flow executions failed this way and the status is
// now unrecoverable, so the incident could not be attributed with certainty.
function formatResponse(res: Response): string {
  const body = nonEmptyString((res as Response & { bodyText?: string }).bodyText)
  const status = nonEmptyString(res.statusText)
    ? `HTTP ${res.status} ${res.statusText}`
    : `HTTP ${res.status}`
  // Status leads so it survives alert truncation, which keeps the head and tail.
  return summarizeHtmlErrorBody(body ? `${status}: ${body}` : status)
}

export function formatErr(e: unknown): string {
  if (e instanceof Error) return summarizeHtmlErrorBody(e.message)
  // Before the generic object branch: a Response IS an object, and falling
  // through to JSON.stringify is exactly the bug.
  if (typeof Response !== 'undefined' && e instanceof Response) return formatResponse(e)
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown }
    const message = nonEmptyString(obj.message)
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? String(obj.code) : undefined

    if (message) {
      const extra = nonEmptyString(obj.details) ?? nonEmptyString(obj.hint)
      const text = extra && extra !== message ? `${message}: ${extra}` : message
      const summarized = summarizeHtmlErrorBody(text)
      return code ? `${summarized} (${code})` : summarized
    }

    try {
      return JSON.stringify(e)
    } catch {
      return '[unserializable error]'
    }
  }
  return String(e)
}
