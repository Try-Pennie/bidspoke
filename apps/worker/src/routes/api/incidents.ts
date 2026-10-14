/**
 * GET /api/incidents (#2101, under #818): one page of the incident record for
 * the dashboard.
 *
 * Who may call it: any signed in, allowlisted user (jwtAuth on every /api route).
 * Whose data it touches: the caller's organization's incidents and the
 * platform's, never another organization's. alert_incidents has no RLS policy,
 * so the scoping is done by readIncidents, which also refuses any row outside it.
 *
 * Query: `limit` (default 50, at most 100) and `offset` (default 0), both whole
 * numbers. The response says whether more exist and the offset that reads them.
 * A failed read is a 500 with a message, never an empty list.
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { formatErr } from '../../lib/format-error'
import { INCIDENTS_DEFAULT_LIMIT, INCIDENTS_MAX_LIMIT, readIncidents } from '../../lib/incidents-read'

const incidents = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** A whole number from the query, its default when absent, or null when it is not one. */
function wholeNumber(raw: string | undefined, fallback: number, min: number): number | null {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min ? n : null
}

incidents.get('/', async (c) => {
  const { orgId } = c.get('user')
  const limit = wholeNumber(c.req.query('limit'), INCIDENTS_DEFAULT_LIMIT, 1)
  const offset = wholeNumber(c.req.query('offset'), 0, 0)
  if (limit === null) return c.json({ error: 'limit must be a whole number of at least 1' }, 400)
  if (offset === null) return c.json({ error: 'offset must be a whole number of at least 0' }, 400)

  try {
    const page = await readIncidents(createSupabaseClient(c.env), orgId, {
      limit: Math.min(limit, INCIDENTS_MAX_LIMIT),
      offset,
      now: Date.now(),
    })
    return c.json(page)
  } catch (err) {
    // The detail goes to the log only (it can carry database text, #107); the
    // caller is told plainly that the record could not be read.
    console.error(JSON.stringify({ event: 'api_error', method: c.req.method, path: c.req.path, message: formatErr(err) }))
    return c.json({ error: 'The incident record could not be read. Try again in a minute.' }, 500)
  }
})

export default incidents
