/**
 * The incident record for the dashboard (#2101, under #818).
 *
 *  - GET /api/incidents/ongoing: every open incident, for the line under the
 *    page header.
 *  - GET /api/incidents: one page of the incidents that have closed and started
 *    or ended in the page's window, for the Incidents card. Query `days` (7, 14
 *    or 30, default 7), `limit` (default 50, at most 100) and `offset` (default
 *    0). The response says whether more exist and the offset that reads them.
 *
 * Who may call them: any signed in, allowlisted user (jwtAuth on every /api
 * route). Whose data they touch: the caller's organization's incidents and the
 * platform's, never another organization's. alert_incidents has no RLS policy,
 * so the scoping is done in incidents-read.ts, which also refuses any row
 * outside it. A failed read is a 500 with a message, never an empty list.
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { formatErr } from '../../lib/format-error'
import {
  INCIDENTS_DEFAULT_LIMIT,
  INCIDENTS_MAX_LIMIT,
  isIncidentWindowDays,
  readClosedIncidents,
  readOngoingIncidents,
} from '../../lib/incidents-read'

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>

const incidents = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** A whole number from the query, its default when absent, or null when it is not one. */
function wholeNumber(raw: string | undefined, fallback: number, min: number): number | null {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min ? n : null
}

/** The detail goes to the log only (it can carry database text, #107); the caller is told plainly. */
function readFailed(c: Ctx, err: unknown, what: string) {
  console.error(JSON.stringify({ event: 'api_error', method: c.req.method, path: c.req.path, message: formatErr(err) }))
  return c.json({ error: `${what} could not be read. Try again in a minute.` }, 500)
}

incidents.get('/ongoing', async (c) => {
  const { orgId } = c.get('user')
  try {
    return c.json(await readOngoingIncidents(createSupabaseClient(c.env), orgId, { now: Date.now() }))
  } catch (err) {
    return readFailed(c, err, 'Ongoing incidents')
  }
})

incidents.get('/', async (c) => {
  const { orgId } = c.get('user')
  const days = wholeNumber(c.req.query('days'), 7, 1)
  const limit = wholeNumber(c.req.query('limit'), INCIDENTS_DEFAULT_LIMIT, 1)
  const offset = wholeNumber(c.req.query('offset'), 0, 0)
  if (days === null || !isIncidentWindowDays(days)) return c.json({ error: 'days must be 7, 14 or 30' }, 400)
  if (limit === null) return c.json({ error: 'limit must be a whole number of at least 1' }, 400)
  if (offset === null) return c.json({ error: 'offset must be a whole number of at least 0' }, 400)

  try {
    return c.json(
      await readClosedIncidents(createSupabaseClient(c.env), orgId, {
        days,
        limit: Math.min(limit, INCIDENTS_MAX_LIMIT),
        offset,
        now: Date.now(),
      }),
    )
  } catch (err) {
    return readFailed(c, err, 'The incident record')
  }
})

export default incidents
