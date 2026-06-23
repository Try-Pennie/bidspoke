import type { Context } from 'hono'

/**
 * Database/internal error responder for authenticated API routes.
 *
 * Logs the real error server-side (captured in Worker logs / Logpush) and
 * returns a generic message to the caller, instead of echoing the raw Supabase
 * error — which would surface schema names, constraint text, and connection
 * detail. The audience is the authenticated single-org ops team, so the leak
 * risk is low today, but this is the same pattern fixed for external webhooks
 * in #192/#107 and matters the day a less-trusted role or leaked session exists.
 */
/**
 * A PostgREST `.single()`/`.maybeSingle()` lookup returns this code with
 * `data: null` when zero rows match — a genuine "not found", NOT a failure.
 * Centralizing the magic string here keeps every 404-vs-500 gate consistent.
 */
const NOT_FOUND_CODE = 'PGRST116'

/** True only for the PostgREST zero-rows result (a genuine not-found). */
export function isNotFoundError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === NOT_FOUND_CODE
}

/**
 * The correct guard for an existence/ownership lookup (#303, #317).
 *
 * Returns a generic 500 `Response` when `err` is a REAL database error, or
 * `null` when there is no error or the error is just PGRST116 (zero rows) — so
 * the caller falls through to its own `if (!data) return 404`. This prevents the
 * lead-loss bug where a transient DB failure is conflated as a 404
 * (`if (err || !data) return 404`): a 404 makes a lead source treat the
 * endpoint as gone and stop retrying, dropping the lead.
 *
 *   const { data, error } = await supabase.from('x').select().eq('id', id).single()
 *   const blocked = dbErrorUnlessNotFound(c, error)
 *   if (blocked) return blocked
 *   if (!data) return c.json({ error: 'Not found' }, 404)
 */
export function dbErrorUnlessNotFound(c: Context, err: unknown): Response | null {
  if (err && !isNotFoundError(err)) return dbError(c, err)
  return null
}

export function dbError(c: Context, err: unknown) {
  const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null
  console.error(
    JSON.stringify({
      event: 'api_error',
      method: c.req.method,
      path: c.req.path,
      message: e?.message ?? String(err),
      code: e?.code,
      details: e?.details,
      hint: e?.hint,
    })
  )
  return c.json({ error: 'Internal error' }, 500)
}
