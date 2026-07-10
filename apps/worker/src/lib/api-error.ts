import type { Context } from 'hono'
import { isNoRowMatchedError, requireRowsAffected, type DbError } from './db-retry'
import { formatErr } from './format-error'

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

/**
 * The correct guard for an UPDATE or DELETE that assumes its target row exists
 * (#588), and the write-side twin of `dbErrorUnlessNotFound`.
 *
 * PostgREST reports a well-formed write that matched zero rows as
 * `{ data: [], error: null }`, so `if (error) return dbError(c, error)` returns
 * 200 for a write that changed nothing. The row may never have existed, or may
 * belong to another organization, and the caller cannot tell either from a
 * success. Any audit-log line written afterwards then records an action that
 * never happened.
 *
 * `op` MUST end its chain in `.select(...)` or PostgREST returns no rows to
 * count. Returns `null` when at least one row was touched; a 404 carrying
 * `notFoundMessage` when none was; and a generic 500 when the database itself
 * failed. That last split is the point: a transient failure must never surface
 * as a 404, the conflation behind #303.
 *
 *   const blocked = await requireRowOr404(c, 'Workflow not found', () =>
 *     supabase.from('workflows').update(patch).eq('id', id).eq('organization_id', orgId).select('id')
 *   )
 *   if (blocked) return blocked
 *
 * `op` returns a PromiseLike, not a Promise, so a supabase query builder can be
 * handed over directly. The builder is a thenable without `.catch`/`.finally`,
 * and requiring a real Promise would force every call site to wrap it in an
 * `async () => { ... }` block.
 */
export async function requireRowOr404(
  c: Context,
  notFoundMessage: string,
  op: () => PromiseLike<{ data: unknown[] | null; error: DbError | null }>
): Promise<Response | null> {
  const { error } = await requireRowsAffected(notFoundMessage, op)
  if (!error) return null
  if (isNoRowMatchedError(error)) return c.json({ error: notFoundMessage }, 404)
  return dbError(c, error)
}

/**
 * The write-side guard for an endpoint where a zero-row match is EXPECTED (#590).
 *
 * Clearing a setting that was never set, or disconnecting a Slack that was never
 * connected, is a no-op rather than an error, so those routes answer 200 either
 * way. What they must not do is record an audit row for an action that never
 * happened. `rows` is what gates that side effect.
 *
 * `blocked` is a generic 500 when the database itself failed, and null
 * otherwise. A missing row is normal here; a broken database is not.
 *
 *   const { rows, blocked } = await rowsTouched(c, 'app_settings.key', () =>
 *     supabase.from('app_settings').delete().eq('key', k).select('key')
 *   )
 *   if (blocked) return blocked
 *   if (rows.length > 0) await writeAuditLog(...)
 */
export async function rowsTouched<T = unknown>(
  c: Context,
  target: string,
  op: () => PromiseLike<{ data: T[] | null; error: DbError | null }>
): Promise<{ rows: T[]; blocked: Response | null }> {
  const { rows, error } = await requireRowsAffected(target, op)
  if (error && !isNoRowMatchedError(error)) return { rows: [], blocked: dbError(c, error) }
  return { rows, blocked: null }
}

export function dbError(c: Context, err: unknown) {
  const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null
  console.error(
    JSON.stringify({
      event: 'api_error',
      method: c.req.method,
      path: c.req.path,
      message: e?.message ?? formatErr(err),
      code: e?.code,
      details: e?.details,
      hint: e?.hint,
    })
  )
  return c.json({ error: 'Internal error' }, 500)
}
