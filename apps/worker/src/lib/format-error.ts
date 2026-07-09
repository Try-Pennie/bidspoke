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
