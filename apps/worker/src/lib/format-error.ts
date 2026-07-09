// Single source of truth for rendering an unknown thrown/returned value as
// human-readable alert text.
//
// Supabase/PostgREST errors are plain objects ({ message, code, details, hint }),
// not Error instances, so a bare `String(e)` renders them as the useless
// "[object Object]" that names no failure. Every alert path that reports a cause
// must go through here. Three call sites independently grew their own copy or
// workaround before this existed (#512).

export function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; code?: unknown }
    const message = typeof obj.message === 'string' ? obj.message : undefined
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? String(obj.code) : undefined
    if (message) return code ? `${message} (${code})` : message
    try {
      return JSON.stringify(e)
    } catch {
      return '[unserializable error]'
    }
  }
  return String(e)
}
