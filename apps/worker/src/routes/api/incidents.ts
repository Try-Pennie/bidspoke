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
 *  - GET /api/incidents/:id/failed-runs (#2102): one failure rate incident's
 *    failed runs, for the workflow page's run panel opened from the card's
 *    "12 failed runs" link (`/workflows/<id>?incident=<incident id>`). The runs
 *    are the ones failure rate's own rule matches, inside the incident's span,
 *    among the runs still kept; `count` is the length of `runs`. 404 for an
 *    incident the caller cannot see, 400 for one of another signal.
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
  readIncidentFailedRuns,
  readOngoingIncidents,
} from '../../lib/incidents-read'
import { isUuid } from '../../lib/query-validators'

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

incidents.get('/:id/failed-runs', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'The incident id must be a uuid' }, 400)
  try {
    const result = await readIncidentFailedRuns(createSupabaseClient(c.env), orgId, id, { now: Date.now() })
    if (result.kind === 'not_found') return c.json({ error: 'Incident not found' }, 404)
    if (result.kind === 'not_failure_rate') return c.json({ error: 'Only a failure rate incident has failed runs to list' }, 400)
    return c.json(result.body)
  } catch (err) {
    return readFailed(c, err, "The incident's failed runs")
  }
})

export default incidents
