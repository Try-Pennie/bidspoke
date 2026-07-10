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
const ALERT_ELLIPSIS = ' … '

export function truncateErrorForAlert(text: string, max = 300): string {
  if (text.length <= max) return text
  const headLen = Math.max(0, max - ALERT_TAIL_CHARS - ALERT_ELLIPSIS.length)
  return text.slice(0, headLen) + ALERT_ELLIPSIS + text.slice(text.length - ALERT_TAIL_CHARS)
}

export function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown }
    const message = nonEmptyString(obj.message)
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? String(obj.code) : undefined

    if (message) {
      const extra = nonEmptyString(obj.details) ?? nonEmptyString(obj.hint)
      const text = extra && extra !== message ? `${message}: ${extra}` : message
      return code ? `${text} (${code})` : text
    }

    try {
      return JSON.stringify(e)
    } catch {
      return '[unserializable error]'
    }
  }
  return String(e)
}
