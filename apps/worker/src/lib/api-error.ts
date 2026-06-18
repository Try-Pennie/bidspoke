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
