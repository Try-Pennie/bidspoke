// The Connections routes (#2338, build PR 4 of the plan approved 2026-10-20;
// R1, R3, R5, R22, R23).
//
// GET  /api/connections                  every connection of the organization,
//      with who it acts as, its person bound owner, its status and how many
//      workflows use it
// POST /api/connections/:id/lookup/:key  one lookup through OpsConnections.lookup
// POST /api/connections                  adds a connection: seal, verify, then
//      insert (build PR 5; R13, R14, #2556), described above its handler
//
// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's rows, scoped by organization_id from
// the verified token in every query, and every ops call names that
// organization alone, which ops scopes again (ops-connections-contract.ts).
// The list and the lookup write no row, so neither writes an audit row.
//
// Retired here: DELETE /:service_type and POST /:service_type/sync-schema,
// which acted on a legacy row (a Cloudflare secret login) found by service type
// alone. None existed (measured 2026-10-17), POST could no longer make one
// (#2331), and DELETE /:service_type had the same path shape as the DELETE /:id
// of build PR 6, so whichever registered first would have taken the other's
// requests. The canvas schema browser that called sync-schema went with them.

import { Hono, type Context } from 'hono'
import { CURRENT_OPS_KID, OPS_CONNECTION_PUBLIC_KEYS, seal, SealError, type SealedEnvelope } from '@bidspoke/connection-seal'
import { CATALOGUE, CONNECTION_STATUS_WORDS, connectionParts, type ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { formatErr } from '../../lib/format-error'
import { mapWithConcurrency } from '../../lib/timeout-audit'
import { resolveSalesforceCredsFor } from '../../lib/salesforce-creds'
import { moneyTargetIn, readMoneyTargets } from '../../lib/connection-money-targets'
import {
  createRefusalSentence, isCreateRefusalCode, type CreateRefusalCode, type CreateRouteRefusalCode, type RefusalContext, type VerifyRefusalCode,
} from '../../lib/connection-create-refusals'
import {
  actsAsOf, AUTH_TYPE_OF, connectionNameOf, CREATE_BODY_MAX_BYTES, declaredBodyTooLarge, declaredService, isReservedName, orgHostOf, readCreateBody,
  secretLabelOf, unlistedGoogleSubjects,
} from '../../lib/connection-create'
import { callOpsConnections, callOpsDelegation, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
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

/** How each of the route's own refusals is answered. Every verify refusal is a 422 unless VERIFY_STATUS says otherwise. */
const CREATE_STATUS: Readonly<Record<CreateRouteRefusalCode, 400 | 409 | 422 | 500 | 502 | 503 | 504>> = {
  connection_request_invalid: 400,
  connection_service_undeclared: 422,
  connection_name_missing: 422,
  connection_name_invalid: 422,
  connection_fields_missing: 422,
  connection_fields_undeclared: 422,
  connection_name_reserved: 409,
  connection_name_taken: 409,
  connection_money_identity: 422,
  connection_money_targets_unreadable: 503,
  google_subject_not_listed: 422,
  google_list_unavailable: 503,
  connection_seal_failed: 500,
  connections_unavailable: 503,
  connection_store_failed: 503,
  verify_timed_out: 504,
  verify_refused_unknown: 502,
}

const VERIFY_STATUS: Partial<Record<VerifyRefusalCode, 503 | 504>> = {
  ops_connections_unavailable: 503,
  ops_connections_timeout: 504,
}

/** The columns the create answers with: never credential_enc or config. */
const CREATED_COLUMNS = 'id, name, service_type, acts_as, target, created_at'

// POST /api/connections   body { service, name, fields: { <field key>: <value> } }
//   201 { connection: { id, name, service, acts_as, target, created_at } }
//   otherwise { error, message, ... }: the code, and the sentence the page
//   shows (lib/connection-create-refusals.ts), with the names it is about
//
// In order, each refusal at the first step that can answer it (L667):
//   1. the body, and a service the catalogue declares: the database accepts
//      any well formed key (20261020200000), so this is where a service must
//      be declared
//   2. the name, and the login and target built by the catalogue's
//      connectionParts, the one builder the ops minters are tested against
//   3. a reserved name, then a name taken in the organization (a read that
//      answers early; the table's unique decides, at step 7)
//   4. a money identity in the target (lib/connection-money-targets.ts)
//   5. for a Google delegation login, a mailbox or drive not on the
//      organization's list
//   6. the login sealed to the ops key under a fresh uuid, and verify asked
//      with that envelope, generation 1 and the target (ciphertext and the
//      public half only)
//   7. only when verify passes, ONE plain INSERT, never an upsert, carrying who
//      verify measured the login acts as. A concurrent save of the same name
//      that verified too loses on the unique and is refused as taken, which is
//      then true. A failed verify wrote nothing, so a retry under the same name
//      is not refused as taken.
//
// Who may call it: any signed in user of the organization (jwtAuth). Whose
// data: the caller's organization only, from the verified token; the body may
// not name one. Every read and the insert are scoped to it, verify and the
// Google list are asked for it alone, and the sealed envelope's AAD binds it,
// so the login opens for no other.
//
// Audit: the store's trigger writes the insert's audit row under updated_by,
// the caller (20261018191000), and connection_history reads it for the History
// tab. The route writes none of its own, so a creation is recorded once. Its
// changes hold no login: credential_enc is excluded by the trigger, and the
// target and acts_as hold none.
//
// Not money facing: nothing here is reached from the engine, and the ops calls
// go through lib/ops-connections-client.ts, which the money path never imports.
connections.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const catalogue = CATALOGUE

  const refuse = (code: CreateRefusalCode, ctx: Partial<RefusalContext> & { service: string }, extra: Record<string, unknown> = {}) => {
    const context: RefusalContext = { secret: 'login', org: null, names: [], money: null, ...ctx }
    console.warn(JSON.stringify({ event: 'connection_create_refused', code, organization_id: orgId, service: ctx.service }))
    const status = (CREATE_STATUS as Partial<Record<CreateRefusalCode, number>>)[code] ?? (VERIFY_STATUS as Partial<Record<CreateRefusalCode, number>>)[code] ?? 422
    return c.json({ error: code, message: createRefusalSentence(code, context), ...extra }, status as 400)
  }

  // 1. The body and the service.
  if (declaredBodyTooLarge(c.req.header('content-length'))) {
    return refuse('connection_request_invalid', { service: 'the service' }, { detail: `the body is over ${CREATE_BODY_MAX_BYTES} bytes` })
  }
  const body = readCreateBody(await c.req.text())
  if (!body.ok) return refuse('connection_request_invalid', { service: 'the service' }, { detail: body.problem })
  const service = declaredService(catalogue, body.service)
  if (!service) return refuse('connection_service_undeclared', { service: /^[a-z][a-z0-9_]{0,63}$/.test(body.service) ? body.service : 'that service' })
  const words: Pick<RefusalContext, 'service' | 'secret'> = { service: service.name, secret: secretLabelOf(service) }

  // 2. The name, the login and the target.
  const named = connectionNameOf(body.name)
  if (!named.ok) return refuse(named.code, words)
  const parts = connectionParts(service.connection, body.fields)
  if (!parts.ok) {
    const labelOf = (key: string) => service.connection.fields.find((f) => f.key === key)?.label ?? key
    if (parts.unknown.length > 0) return refuse('connection_fields_undeclared', { ...words, names: parts.unknown }, { fields: parts.unknown })
    return refuse('connection_fields_missing', { ...words, names: parts.missing.map(labelOf) }, { fields: parts.missing })
  }
  const { login, target } = parts
  const org = orgHostOf(target)

  // 3. Reserved, then taken (read early; the unique decides at the insert).
  if (isReservedName(service.key, named.name)) return refuse('connection_name_reserved', words)
  const supabase = createSupabaseClient(c.env)
  const { data: existing, error: existingError } = await supabase
    .from('service_connections')
    .select('id')
    .eq('organization_id', orgId)
    .eq('service_type', service.key)
    .eq('name', named.name)
    .maybeSingle()
  if (existingError) {
    console.error(JSON.stringify({ event: 'connection_create_name_read_failed', organization_id: orgId, error: formatErr(existingError) }))
    return refuse('connections_unavailable', words)
  }
  if (existing) return refuse('connection_name_taken', words)

  // 4. Money identities, read by name now, never printed.
  const money = await readMoneyTargets(c.env as unknown as Record<string, unknown>, orgId, (organizationId) => resolveSalesforceCredsFor(c.env, supabase, organizationId))
  if (!money.ok) {
    console.error(JSON.stringify({ event: 'connection_money_targets_unreadable', organization_id: orgId, detail: money.detail }))
    return refuse('connection_money_targets_unreadable', words)
  }
  const found = moneyTargetIn(target, money.targets)
  if (found) return refuse('connection_money_identity', { ...words, money: found.kind }, { money: found.kind, matched: found.source })

  // 5. A Google delegation login names only mailboxes and drives on the organization's list (F129).
  if (service.connection.auth === 'service_account_delegation') {
    const list = await callOpsDelegation(c.env, 'listDelegationSubjects', { organization_id: orgId })
    if (!list.ok) {
      console.error(JSON.stringify({ event: 'connection_google_list_unavailable', organization_id: orgId, refused: list.refused }))
      return refuse('google_list_unavailable', words)
    }
    const unlisted = unlistedGoogleSubjects(target, list.subjects)
    if (unlisted.length > 0) return refuse('google_subject_not_listed', { ...words, names: unlisted }, { subjects: unlisted })
  }

  // 6. Seal under a fresh uuid, and verify.
  const connectionId = crypto.randomUUID()
  const generation = 1
  const kid = CURRENT_OPS_KID
  let envelope: SealedEnvelope
  try {
    if (kid === null) throw new Error('no current ops kid is committed')
    envelope = await seal(OPS_CONNECTION_PUBLIC_KEYS, JSON.stringify(login), {
      organization_id: orgId, connection_id: connectionId, service: service.key, generation, kid,
    })
  } catch (err) {
    // A SealError's code names the cause; its message names no key material. Nothing of the login.
    console.error(JSON.stringify({ event: 'connection_seal_failed', organization_id: orgId, error: err instanceof SealError ? err.code : err instanceof Error ? err.name : 'error' }))
    return refuse('connection_seal_failed', words)
  }

  const answer = await callOpsConnections(c.env, 'verify', {
    organization_id: orgId,
    connection_id: connectionId,
    candidate: { service: service.key, generation, envelope, target, public_config: {} },
  })
  if (!answer.ok) {
    if (isOpsConnectionsUnavailable(answer)) {
      if (answer.cause === 'deadline') return refuse('verify_timed_out', { ...words, org })
      return refuse('ops_connections_unavailable', { ...words, org }, { detail: answer.detail })
    }
    const code: CreateRefusalCode = isCreateRefusalCode(answer.refused) ? answer.refused : 'verify_refused_unknown'
    // The detail is built from names on ops (finding F120).
    return refuse(code, { ...words, org }, { detail: answer.detail, retry_at: answer.retry_at })
  }

  // 7. The one insert.
  const { data: created, error: insertError } = await supabase
    .from('service_connections')
    .insert({
      id: connectionId,
      organization_id: orgId,
      service_type: service.key,
      name: named.name,
      auth_type: AUTH_TYPE_OF[service.connection.auth],
      sealed_for: 'ops_key',
      credential_enc: JSON.stringify(envelope),
      credential_generation: generation,
      target,
      acts_as: actsAsOf(answer.identity),
      person_bound: false,
      user_id: null,
      cf_secret_key: null,
      updated_by: userId,
      updated_by_email: email,
    })
    .select(CREATED_COLUMNS)
    .single()
  if (insertError) {
    if (insertError.code === '23505') return refuse('connection_name_taken', words)
    if (insertError.code === '23514' && /alert_name_reserved/.test(insertError.message)) return refuse('connection_name_reserved', words)
    console.error(JSON.stringify({ event: 'connection_create_insert_failed', organization_id: orgId, connection_id: connectionId, error: formatErr(insertError) }))
    return refuse('connection_store_failed', words)
  }
  const row = created as { id: string; name: string; service_type: string; acts_as: string | null; target: unknown; created_at: string }
  console.log(JSON.stringify({ event: 'connection_created', organization_id: orgId, connection_id: row.id, service: row.service_type }))
  return c.json({
    connection: { id: row.id, name: row.name, service: row.service_type, acts_as: row.acts_as, target: row.target ?? null, created_at: row.created_at },
  }, 201)
})

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
