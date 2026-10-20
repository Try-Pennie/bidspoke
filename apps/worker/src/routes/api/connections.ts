// The Connections routes (#2338, build PR 4 of the plan approved 2026-10-20;
// R1, R3, R5, R22, R23).
//
// GET  /api/connections                  every connection of the organization,
//      with who it acts as, its person bound owner, its status and how many
//      workflows use it
// POST /api/connections/:id/lookup/:key  one lookup through OpsConnections.lookup
// POST /api/connections                  refused: connections_moving, 410 (#2331),
//      until the create route (build PR 5)
//
// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's rows, scoped by organization_id from
// the verified token in every query, and every ops call names that
// organization alone, which ops scopes again (ops-connections-contract.ts).
// Neither route writes a row, so neither writes an audit row.
//
// Retired here: DELETE /:service_type and POST /:service_type/sync-schema,
// which acted on a legacy row (a Cloudflare secret login) found by service type
// alone. None existed (measured 2026-10-17), POST could no longer make one
// (#2331), and DELETE /:service_type had the same path shape as the DELETE /:id
// of build PR 6, so whichever registered first would have taken the other's
// requests. The canvas schema browser that called sync-schema went with them.

import { Hono, type Context } from 'hono'
import { CONNECTION_STATUS_WORDS, type ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { formatErr } from '../../lib/format-error'
import { mapWithConcurrency } from '../../lib/timeout-audit'
import { callOpsConnections, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
import { OpsConnectionsContractError, parseLookupRequest, type HealthRow, type OpsConnectionsRefusalCode } from '../../lib/ops-connections-contract'
import { pageStatusOf, readConnectionStatuses, rememberConnectionStatuses } from '../../lib/connection-statuses'

type Variables = AuthVariables

const connections = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * The most connections GET /api/connections lists (#1437). Measured 2026-10-19
 * production holds one row (the Slack alert row), and the fixture the design
 * was settled on draws 14. 100 leaves room while staying far under PostgREST's
 * 1,000 row cap, and bounds the reference counts below at 100 calls. The read
 * asks for one more, so a cut answer is seen and refused rather than shown as
 * the whole list.
 */
export const CONNECTIONS_LIST_MAX = 100

/**
 * How many connection_references calls run at once. Each scans the
 * organization's workflow definitions, so a page of connections must not start
 * them all in the same instant against the database bids also read
 * (timeout-audit.ts measured that on 2026-10-08).
 */
export const CONNECTION_REFERENCES_CONCURRENCY = 4

/** The columns the list reads: never credential_enc, config (the Slack row's token) or cf_secret_key. */
const LIST_COLUMNS = 'id, name, service_type, acts_as, person_bound, user_id, target, created_at, updated_at'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The list could not be read: the page's could not load card (D23), never an empty list (L10). */
function listUnavailable(c: Context, what: string, err: unknown) {
  console.error(JSON.stringify({ event: 'connections_list_unavailable', what, error: formatErr(err) }))
  return c.json({ error: 'connections_unavailable', message: `The connections could not be read: ${what} failed.` }, 503)
}

interface ListedRow {
  id: string
  name: string
  service_type: string
  acts_as: string | null
  person_bound: boolean
  user_id: string | null
  target: unknown
  created_at: string
  updated_at: string
}

/** What one connection's health says on the page, or null when ops gives none. */
function healthOf(row: HealthRow | undefined) {
  if (!row) return { status: null, health: null }
  const status: ConnectionPageStatus | null = pageStatusOf(row.status)
  return {
    status,
    health: {
      ops_status: row.status,
      last_check_ok_at: row.last_check_ok_at,
      last_check_failed_at: row.last_check_failed_at,
      last_check_cause: row.last_check_cause,
      needs_reauth_at: row.needs_reauth_at,
      needs_reauth_cause: row.needs_reauth_cause,
    },
  }
}

// GET /api/connections
//   200 { connections, statuses: { as_of, stale, unavailable } }
//       statuses.stale: health did not answer, so each status is the last known
//       one, as of statuses.as_of (null when none is known), and
//       statuses.unavailable names why (the stale strip, D22)
//   503 connections_unavailable  the list, the owners or the use counts could
//       not be read (the could not load card, D23)
//   500 connections_list_too_long  more than CONNECTIONS_LIST_MAX connections
connections.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('service_connections')
    .select(LIST_COLUMNS)
    .eq('organization_id', orgId)
    .order('service_type')
    .order('name')
    .limit(CONNECTIONS_LIST_MAX + 1)
  if (error) return listUnavailable(c, 'the connections read', error)
  const listed = (data ?? []) as ListedRow[]
  if (listed.length > CONNECTIONS_LIST_MAX) {
    console.error(`[connections] org ${orgId} has more than ${CONNECTIONS_LIST_MAX} connections; the list read is bounded at ${CONNECTIONS_LIST_MAX} and was refused rather than cut`)
    return c.json({ error: 'connections_list_too_long', message: `More than ${CONNECTIONS_LIST_MAX} connections: the list cannot be shown whole.` }, 500)
  }

  // Health is asked while the database reads run: it can take up to its
  // deadline, and nothing it answers changes what they read.
  const health = callOpsConnections(c.env, 'health', { organization_id: orgId })

  const ownerIds = [...new Set(listed.filter((r) => r.person_bound && r.user_id).map((r) => r.user_id as string))]
  const owners = new Map<string, { name: string | null; email: string | null }>()
  if (ownerIds.length > 0) {
    // paginate-ok .in(id): the owners of at most CONNECTIONS_LIST_MAX (100) connections, by primary key, one row each.
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, display_name, email')
      .eq('organization_id', orgId)
      .in('id', ownerIds)
    if (usersError) return listUnavailable(c, 'the owners read', usersError)
    for (const u of (users ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>) {
      owners.set(u.id, { name: u.display_name, email: u.email })
    }
  }

  // Used by (R5): connection_references, the one predicate the Remove refusal
  // reads too, soft deleted workflows included and never by name. A connection
  // removed since the read above answers connection_not_found and is dropped.
  let counts: Array<number | 'gone'>
  try {
    counts = await mapWithConcurrency(listed, CONNECTION_REFERENCES_CONCURRENCY, async (row) => {
      const { data: refs, error: refsError } = await supabase.rpc('connection_references', { p_organization_id: orgId, p_connection_id: row.id })
      if (refsError) {
        if (refsError.code === 'P0002' && /connection_not_found/.test(refsError.message)) return 'gone' as const
        throw refsError
      }
      return Array.isArray(refs) ? refs.length : 0
    })
  } catch (err) {
    return listUnavailable(c, 'the use counts read', err)
  }

  const answer = await health
  const nowMs = Date.now()
  let statusRows: HealthRow[] = []
  let asOf: string | null = null
  let stale = false
  let unavailable: { cause: string; detail: string } | null = null
  const ids = new Set(listed.map((r) => r.id))
  if (answer.ok) {
    if (answer.reached_limit) console.warn(JSON.stringify({ event: 'connection_health_reached_limit', organization_id: orgId }))
    statusRows = answer.connections.filter((r) => ids.has(r.connection_id))
    asOf = new Date(nowMs).toISOString()
    await rememberConnectionStatuses(c.env.WORKFLOW_CACHE, orgId, statusRows, nowMs)
  } else {
    stale = true
    unavailable = isOpsConnectionsUnavailable(answer)
      ? { cause: answer.cause, detail: answer.detail }
      : { cause: answer.refused, detail: answer.detail }
    const copy = await readConnectionStatuses(c.env.WORKFLOW_CACHE, orgId)
    if (copy.kind === 'read') {
      statusRows = copy.rows.filter((r) => ids.has(r.connection_id))
      asOf = copy.as_of
    }
    console.warn(JSON.stringify({ event: 'connection_statuses_stale', organization_id: orgId, cause: unavailable.cause, copy: copy.kind, as_of: asOf }))
  }
  const byId = new Map(statusRows.map((r) => [r.connection_id, r]))

  const rows = listed.flatMap((row, i) => {
    const count = counts[i]
    if (count === 'gone') return []
    const owner = row.person_bound && row.user_id ? { user_id: row.user_id, ...(owners.get(row.user_id) ?? { name: null, email: null }) } : null
    const { status, health: h } = healthOf(byId.get(row.id))
    return [{
      id: row.id,
      name: row.name,
      service: row.service_type,
      acts_as: row.acts_as,
      person_bound: row.person_bound,
      owner,
      target: row.target ?? null,
      status,
      status_word: status ? CONNECTION_STATUS_WORDS[status] : null,
      health: h,
      used_by: count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }]
  })

  return c.json({ connections: rows, statuses: { as_of: asOf, stale, unavailable } })
})

// POST /api/connections: refused (#2331, phase 1a). It stored the credentials
// as a CONN_ secret on the bidding Worker, and every secret put creates and
// deploys a new version of that Worker. The sealed create of build PR 5
// replaces it. Refused before the body or the table is read.
const CONNECTIONS_MOVING_MESSAGE =
  'Salesforce, Supabase and Snowflake connections can no longer be saved here while they move to sealed connections.'

connections.post('/', (c) =>
  c.json({ error: 'connections_moving', message: CONNECTIONS_MOVING_MESSAGE }, 410),
)

/** The HTTP status a lookup refusal answers with; any other is the service's or ops's refusal, a 502. */
const LOOKUP_REFUSAL_STATUS: Partial<Record<OpsConnectionsRefusalCode, 400 | 422 | 429 | 504>> = {
  ops_connections_request_invalid: 400,
  lookup_not_supported: 422,
  lookup_rate_limited: 429,
  ops_connections_timeout: 504,
}

// POST /api/connections/:id/lookup/:key   body { parents?: string[] }
//   200 { answer }  what the lookup found (SchemaLookupAnswer)
//   404 connection_not_found  no such connection in the caller's organization
//   422 lookup_not_supported  a connection ops does not serve (the Slack alert login)
//   400 lookup_request_invalid  a key or parents the contract does not read
//   503 ops_connections_unavailable  ops did not answer; 503 connections_unavailable  the row could not be read
//   otherwise ops's refusal by its code: { error, message, retry_at }
connections.post('/:id/lookup/:key', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  if (!UUID.test(id)) return c.json({ error: 'connection_not_found', message: 'There is no such connection.' }, 404)

  let body: unknown = {}
  const text = await c.req.text()
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      return c.json({ error: 'lookup_request_invalid', message: 'The request body is not JSON.' }, 400)
    }
  }
  let request
  try {
    const parents = body !== null && typeof body === 'object' ? (body as { parents?: unknown }).parents : undefined
    request = parseLookupRequest({ organization_id: orgId, connection_id: id, key: c.req.param('key'), parents })
  } catch (err) {
    if (err instanceof OpsConnectionsContractError) return c.json({ error: 'lookup_request_invalid', message: err.message }, 400)
    throw err
  }

  const supabase = createSupabaseClient(c.env)
  const { data: row, error } = await supabase
    .from('service_connections')
    .select('id, sealed_for')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (error) {
    console.error(JSON.stringify({ event: 'connection_lookup_read_failed', error: formatErr(error) }))
    return c.json({ error: 'connections_unavailable', message: 'The connection could not be read.' }, 503)
  }
  if (!row) return c.json({ error: 'connection_not_found', message: 'There is no such connection.' }, 404)
  if (row.sealed_for !== 'ops_key') {
    return c.json({ error: 'lookup_not_supported', message: 'This connection is not one the lookups run through.' }, 422)
  }

  const answer = await callOpsConnections(c.env, 'lookup', request)
  if (answer.ok) return c.json({ answer: answer.answer })
  if (isOpsConnectionsUnavailable(answer)) {
    return c.json({ error: answer.refused, cause: answer.cause, message: answer.detail }, OPS_CONNECTIONS_UNAVAILABLE_STATUS)
  }
  return c.json({ error: answer.refused, message: answer.detail, retry_at: answer.retry_at }, LOOKUP_REFUSAL_STATUS[answer.refused] ?? 502)
})

export default connections
