// The Connections routes (#2338, build PR 4 of the plan approved 2026-10-20;
// R1, R3, R5, R22, R23).
//
// GET  /api/connections                  every connection of the organization,
//      with who it acts as, its person bound owner, its status and how many
//      workflows use it
// POST /api/connections/:id/lookup/:key  one lookup through OpsConnections.lookup
// POST /api/connections                  adds a connection: seal, verify, then
//      insert (build PR 5; R13, R14, #2556), described above its handler
// POST /api/connections/:id/reconnect    a new login, or the stored one checked
//      again (build PR 6; R19, finding F116)
// DELETE /api/connections/:id            removes one no workflow uses, then
//      revokes it on ops (build PR 6; R9, R21)
// GET, POST /api/connections/google/subjects, and
// DELETE /api/connections/google/subjects/:kind/:subject  the Google
//      mailboxes and drives list (build PR 6; R10)
// Each is described above its handler.
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
  connectionRouteSentence, createRefusalSentence, isCreateRefusalCode, type ConnectionRouteRefusalCode, type CreateRefusalCode, type CreateRouteRefusalCode,
  type RefusalContext, type RouteRefusalContext, type VerifyRefusalCode,
} from '../../lib/connection-create-refusals'
import { readDelegationEntryBody, readReconnectBody, reconnectValues } from '../../lib/connection-reconnect'
import { writeAuditLog } from '../../lib/audit'
import { DELEGATION_KINDS, type DelegationKind } from '../../ops/run-vocabulary'
import {
  actsAsOf, AUTH_TYPE_OF, connectionNameOf, connectionsNamingSubject, CREATE_BODY_MAX_BYTES, declaredBodyTooLarge, declaredService, isReservedName, orgHostOf, readCreateBody,
  secretLabelOf, unlistedGoogleSubjects,
} from '../../lib/connection-create'
import { callOpsConnections, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
import {
  DELEGATION_DISPLAY_NAME_MAX, DELEGATION_SUBJECT_MAX, OpsConnectionsContractError, parseLookupRequest, type HealthRow, type OpsConnectionsRefusalCode,
} from '../../lib/ops-connections-contract'
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
//   8. an insert that fails after verify passed (build PR 6) leaves ops holding
//      what verify recorded under an id bidding never stored, so revoke is
//      called for that id before the error is answered; a failed revoke is
//      logged by the id (connection_create_left_on_ops) and the answer is the
//      save's error still. An error that is not the database's refusal may
//      have landed, so the id is read back first, and a row that landed is
//      answered as saved and never revoked.
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
    const list = await callOpsConnections(c.env, 'listDelegationSubjects', { organization_id: orgId })
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
  let stored = created
  if (insertError) {
    // A refusal by the database wrote nothing. Any other error may have landed
    // (a call that timed out or lost its answer), so the id is read back first:
    // revoking a row that did land would leave ops refusing it for 7 hours.
    const refused = insertError.code === '23505' || insertError.code === '23514'
    if (!refused) {
      console.error(JSON.stringify({ event: 'connection_create_insert_failed', organization_id: orgId, connection_id: connectionId, error: formatErr(insertError) }))
      const { data: landed, error: readBackError } = await supabase
        .from('service_connections')
        .select(CREATED_COLUMNS)
        .eq('id', connectionId)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (readBackError) {
        // Unknown either way: nothing is revoked, and the id is named so the leftover can be found.
        console.error(JSON.stringify({ event: 'connection_create_left_on_ops', organization_id: orgId, connection_id: connectionId, why: 'the insert failed and could not be read back, so whether it landed is unknown' }))
        return refuse('connection_store_failed', words)
      }
      if (landed) stored = landed
    }
    if (!stored) {
      // Verify passed, so ops holds a record (the measured identity) under an id
      // bidding never stored: withdraw it before answering, so nothing is left
      // behind. A failed revoke does not change the save's answer, and is named.
      const revoked = await callOpsConnections(c.env, 'revoke', { organization_id: orgId, connection_id: connectionId, generation, removed_at: new Date().toISOString() })
      if (!revoked.ok) {
        console.error(JSON.stringify({ event: 'connection_create_left_on_ops', organization_id: orgId, connection_id: connectionId, refused: revoked.refused, why: 'verify passed, the insert failed, and the revoke of the verified id failed' }))
      }
      if (insertError.code === '23505') return refuse('connection_name_taken', words)
      if (insertError.code === '23514' && /alert_name_reserved/.test(insertError.message)) return refuse('connection_name_reserved', words)
      if (refused) console.error(JSON.stringify({ event: 'connection_create_insert_failed', organization_id: orgId, connection_id: connectionId, error: formatErr(insertError) }))
      return refuse('connection_store_failed', words)
    }
  }
  const row = stored as { id: string; name: string; service_type: string; acts_as: string | null; target: unknown; created_at: string }
  console.log(JSON.stringify({ event: 'connection_created', organization_id: orgId, connection_id: row.id, service: row.service_type }))
  return c.json({
    connection: { id: row.id, name: row.name, service: row.service_type, acts_as: row.acts_as, target: row.target ?? null, created_at: row.created_at },
  }, 201)
})

// ── Reconnect, Remove and the Google list (build PR 6; R9, R10, R19, R21) ───

/** How each of these routes' own refusals is answered. */
const ROUTE_STATUS: Readonly<Record<ConnectionRouteRefusalCode, 200 | 400 | 404 | 409 | 422 | 502 | 503>> = {
  connection_not_found: 404,
  connection_not_reconnectable: 422,
  connection_not_removable: 422,
  reconnect_target_changed: 422,
  reconnect_target_unreadable: 422,
  reconnect_login_unreadable: 422,
  reconnect_stale: 409,
  reconnect_unconfirmed: 503,
  reconnect_saved_check_not_cleared: 502,
  reauth_clear_unrecorded: 502,
  connection_in_use: 409,
  connection_remove_unconfirmed: 503,
  connection_removed_ops_not_told: 200,
  delegation_subject_invalid: 422,
  delegation_display_name_invalid: 422,
  delegation_subject_listed_elsewhere: 409,
  delegation_subject_not_listed: 404,
  delegation_subject_in_use: 409,
  delegation_use_unreadable: 503,
  delegation_change_failed: 503,
  delegation_list_unavailable: 503,
  delegation_change_refused: 502,
}

/** The columns a Reconnect reads, of an ops_key row only: never the Slack alert row's config, which holds its token. */
const RECONNECT_COLUMNS = 'id, name, service_type, sealed_for, credential_generation, credential_enc, config, target, acts_as'

interface ReconnectRow {
  id: string
  name: string
  service_type: string
  sealed_for: string
  credential_generation: number
  credential_enc: string | null
  config: unknown
  target: unknown
  acts_as: string | null
}

const isRecordValue = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The connection is gone or another organization's, or it is not an ops connection at all: told apart without reading the alert row's columns. */
async function rowMissing(supabase: ReturnType<typeof createSupabaseClient>, orgId: string, id: string): Promise<'not_found' | 'not_ops' | 'unreadable'> {
  const { data, error } = await supabase.from('service_connections').select('id').eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (error) {
    console.error(JSON.stringify({ event: 'connection_reconnect_read_failed', organization_id: orgId, error: formatErr(error) }))
    return 'unreadable'
  }
  return data ? 'not_ops' : 'not_found'
}

/** A refusal from verify or clearReauth, answered as the save form answers it (the same check, the same sentence). */
function opsCheckRefusal(answer: { ok: false; refused: string; detail: string; retry_at: string | null } & Partial<{ cause: string }>): { code: CreateRefusalCode; extra: Record<string, unknown> } {
  if (isOpsConnectionsUnavailable(answer)) {
    return answer.cause === 'deadline' ? { code: 'verify_timed_out', extra: {} } : { code: 'ops_connections_unavailable', extra: { detail: answer.detail } }
  }
  const code: CreateRefusalCode = isCreateRefusalCode(answer.refused) ? answer.refused : 'verify_refused_unknown'
  return { code, extra: { detail: answer.detail, retry_at: answer.retry_at } }
}

// POST /api/connections/:id/reconnect   body {} | { fields: { <field key>: <value> } }
//   200 { outcome: 'reconnected' | 'checked', connection: { id, generation, acts_as } }
//   otherwise { error, message, ... }: the code and the sentence the Reconnect
//   dialog shows (lib/connection-create-refusals.ts)
//
// With a new login (finding F116; the ops half is in
// ops/connections/__tests__/reconnect-candidate.test.ts), in order:
//   1. the row, an ops_key row of the caller's organization, read with its
//      generation N
//   2. the login rebuilt from the row's target and the new fields
//      (lib/connection-reconnect.ts): what the connection names cannot change
//   3. sealed under the row's own id at generation N+1, and verify asked with
//      that envelope passed in the call, which ops uses for that call alone and
//      saves nowhere
//   4. only when verify passes, reconnect_ops_connection: the compare and set on
//      N. A row that moved on answers 409 reconnect_stale; a call that did not
//      answer is reconnect_unconfirmed. Neither calls clearReauth, so ops never
//      clears a flag for a generation the one home did not commit.
//   5. then clearReauth with the committed envelope. If that fails the login is
//      still saved (it is the one home, and the next minute's serve carries it to
//      ops), and the answer says so: reconnect_saved_check_not_cleared.
// Without a new login: clearReauth alone, with the row's own envelope and
// generation, which writes reauth_cleared_at on ops only when its check passes.
//
// Who may call it: any signed in user of the organization (jwtAuth). Whose
// data: the caller's organization only, from the verified token; every read
// and the compare and set are scoped to it, and the envelope's AAD binds it.
// Audit: a new login's commit is audited by the store's trigger under the actor
// (reconnect_ops_connection sets updated_by), with credential_enc kept out; a
// check without one changes no bidding row, so the route writes its audit row,
// naming the generation checked and nothing of the login.
connections.post('/:id/reconnect', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const words = { service: 'the service', secret: 'login' }
  const ownRefusal = (code: ConnectionRouteRefusalCode, ctx: Partial<RouteRefusalContext> = {}, extra: Record<string, unknown> = {}) => {
    console.warn(JSON.stringify({ event: 'connection_reconnect_refused', code, organization_id: orgId, connection_id: UUID.test(id) ? id : null }))
    return c.json({ error: code, message: connectionRouteSentence(code, { ...words, names: [], deleted: false, ...ctx }), ...extra }, ROUTE_STATUS[code])
  }
  const createRefusal = (code: CreateRefusalCode, ctx: Partial<RefusalContext> = {}, extra: Record<string, unknown> = {}) => {
    console.warn(JSON.stringify({ event: 'connection_reconnect_refused', code, organization_id: orgId, connection_id: UUID.test(id) ? id : null }))
    const status = (CREATE_STATUS as Partial<Record<CreateRefusalCode, number>>)[code] ?? (VERIFY_STATUS as Partial<Record<CreateRefusalCode, number>>)[code] ?? 422
    return c.json({ error: code, message: createRefusalSentence(code, { org: null, names: [], money: null, ...words, ...ctx }), ...extra }, status as 400)
  }

  if (!UUID.test(id)) return ownRefusal('connection_not_found')
  if (declaredBodyTooLarge(c.req.header('content-length'))) return createRefusal('connection_request_invalid', {}, { detail: `the body is over ${CREATE_BODY_MAX_BYTES} bytes` })
  const body = readReconnectBody(await c.req.text())
  if (!body.ok) return createRefusal('connection_request_invalid', {}, { detail: body.problem })

  // 1. The row.
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('service_connections')
    .select(RECONNECT_COLUMNS)
    .eq('id', id)
    .eq('organization_id', orgId)
    .eq('sealed_for', 'ops_key')
    .maybeSingle()
  if (error) {
    console.error(JSON.stringify({ event: 'connection_reconnect_read_failed', organization_id: orgId, error: formatErr(error) }))
    return createRefusal('connections_unavailable')
  }
  if (!data) {
    const missing = await rowMissing(supabase, orgId, id)
    if (missing === 'unreadable') return createRefusal('connections_unavailable')
    return ownRefusal(missing === 'not_ops' ? 'connection_not_reconnectable' : 'connection_not_found')
  }
  const row = data as ReconnectRow
  const service = declaredService(CATALOGUE, row.service_type)
  if (!service) return createRefusal('connection_service_undeclared', { service: row.service_type })
  Object.assign(words, { service: service.name, secret: secretLabelOf(service) })
  const target = isRecordValue(row.target) ? row.target : null
  const publicConfig = isRecordValue(row.config) ? row.config : {}

  // Without a new login: check the stored one again.
  if (body.fields === null) {
    let envelope: unknown
    try {
      envelope = JSON.parse(row.credential_enc ?? '')
    } catch {
      envelope = null
    }
    if (!isRecordValue(envelope)) return ownRefusal('reconnect_login_unreadable')
    const answer = await callOpsConnections(c.env, 'clearReauth', {
      organization_id: orgId,
      connection_id: row.id,
      candidate: { service: row.service_type, generation: row.credential_generation, envelope: envelope as unknown as SealedEnvelope, target, public_config: publicConfig },
    })
    if (!answer.ok) {
      if (answer.refused === 'reauth_clear_unrecorded') return ownRefusal('reauth_clear_unrecorded', {}, { detail: answer.detail })
      const { code, extra } = opsCheckRefusal(answer)
      return createRefusal(code, { org: target ? orgHostOf(target) : null }, extra)
    }
    await writeAuditLog(supabase, orgId, 'service_connection', row.id, 'connection_rechecked', userId, { generation: row.credential_generation })
    console.log(JSON.stringify({ event: 'connection_rechecked', organization_id: orgId, connection_id: row.id, generation: row.credential_generation }))
    return c.json({ outcome: 'checked', connection: { id: row.id, generation: row.credential_generation, acts_as: row.acts_as } })
  }

  // 2. The login, from the row's target and the new fields.
  const labelOf = (key: string) => service.connection.fields.find((f) => f.key === key)?.label ?? key
  const values = reconnectValues(service.connection, row.target, body.fields)
  if (!values.ok) {
    if (values.code === 'connection_fields_undeclared') return createRefusal(values.code, { names: values.fields }, { fields: values.fields })
    return ownRefusal(values.code, { names: values.fields.map(labelOf) }, { fields: values.fields })
  }
  const parts = connectionParts(service.connection, values.values)
  if (!parts.ok) {
    if (parts.unknown.length > 0) return createRefusal('connection_fields_undeclared', { names: parts.unknown }, { fields: parts.unknown })
    return createRefusal('connection_fields_missing', { names: parts.missing.map(labelOf) }, { fields: parts.missing })
  }
  const org = target ? orgHostOf(target) : null

  // 3. Sealed under the row's id at the next generation, and verified.
  const generation = row.credential_generation + 1
  const kid = CURRENT_OPS_KID
  let envelope: SealedEnvelope
  try {
    if (kid === null) throw new Error('no current ops kid is committed')
    envelope = await seal(OPS_CONNECTION_PUBLIC_KEYS, JSON.stringify(parts.login), {
      organization_id: orgId, connection_id: row.id, service: row.service_type, generation, kid,
    })
  } catch (err) {
    console.error(JSON.stringify({ event: 'connection_seal_failed', organization_id: orgId, error: err instanceof SealError ? err.code : err instanceof Error ? err.name : 'error' }))
    return createRefusal('connection_seal_failed')
  }
  const candidate = { service: row.service_type, generation, envelope, target, public_config: publicConfig }
  const verified = await callOpsConnections(c.env, 'verify', { organization_id: orgId, connection_id: row.id, candidate })
  if (!verified.ok) {
    const { code, extra } = opsCheckRefusal(verified)
    return createRefusal(code, { org }, extra)
  }
  const actsAs = actsAsOf(verified.identity)

  // 4. The compare and set on the generation read.
  const { data: committed, error: casError } = await supabase.rpc('reconnect_ops_connection', {
    p_organization_id: orgId,
    p_connection_id: row.id,
    p_expected_generation: row.credential_generation,
    p_new_generation: generation,
    p_envelope: envelope as unknown as Record<string, string | number>,
    // The generated types call every argument text; a null acts_as is passed as SQL NULL, which the nullable column takes.
    p_acts_as: actsAs as string,
    p_actor: userId,
    p_actor_email: email,
  })
  if (casError) {
    if (casError.code === 'P0002' && /connection_not_found/.test(casError.message)) return ownRefusal('connection_not_found')
    if (casError.code === 'BP422') return ownRefusal('connection_not_reconnectable')
    // A refusal by name wrote nothing; anything else (a timeout, a dropped connection) may have.
    if (casError.code === '22023') {
      console.error(JSON.stringify({ event: 'connection_reconnect_refused_by_database', organization_id: orgId, connection_id: row.id, error: formatErr(casError) }))
      return createRefusal('connection_store_failed')
    }
    console.error(JSON.stringify({ event: 'connection_reconnect_unconfirmed', organization_id: orgId, connection_id: row.id, generation, error: formatErr(casError) }))
    return ownRefusal('reconnect_unconfirmed')
  }
  const outcome = Array.isArray(committed) ? (committed[0] as { outcome?: unknown; current_generation?: unknown } | undefined) : undefined
  if (outcome?.outcome === 'stale_generation') {
    return ownRefusal('reconnect_stale', {}, { current_generation: outcome.current_generation ?? null })
  }
  if (outcome?.outcome !== 'reconnected') {
    console.error(JSON.stringify({ event: 'connection_reconnect_unconfirmed', organization_id: orgId, connection_id: row.id, generation, error: 'the compare and set answered no outcome this route reads' }))
    return ownRefusal('reconnect_unconfirmed')
  }

  // 5. Committed: only now is ops asked to clear the flag, for the committed generation.
  const cleared = await callOpsConnections(c.env, 'clearReauth', { organization_id: orgId, connection_id: row.id, candidate })
  if (!cleared.ok) {
    console.error(JSON.stringify({ event: 'connection_reconnect_not_cleared', organization_id: orgId, connection_id: row.id, generation, refused: cleared.refused }))
    return ownRefusal('reconnect_saved_check_not_cleared', {}, { saved: { generation }, cause: cleared.refused })
  }
  console.log(JSON.stringify({ event: 'connection_reconnected', organization_id: orgId, connection_id: row.id, generation }))
  return c.json({ outcome: 'reconnected', connection: { id: row.id, generation, acts_as: actsAs } })
})

interface UsingWorkflow { id: string; name: string; deleted: boolean }

// DELETE /api/connections/:id
//   200 { outcome: 'removed', connection: { id, generation }, ops: { told: true } }
//   200 { ..., ops: { told: false, cause, message } }  removed, and revoke did
//       not reach ops: the removal stands, and the message says when ops stops
//       using the login (its next minute check carries the bidding tombstone,
//       which the gateway serves for 7 hours, and a copy ops cannot refresh
//       expires at its serve_until, 6 hours after its last serve; ops-gateway.ts)
//   409 connection_in_use { workflows: [{ id, name, deleted }] }  every
//       workflow using it, soft deleted ones included and marked (D9)
//   otherwise { error, message }
//
// remove_ops_connection writes the tombstone and deletes the row in one
// transaction while nothing references it, audited by the store's trigger
// under the actor. revoke is called after it and never before, so ops is never
// told of a removal the one home did not make.
// Who may call it: any signed in user of the organization. Whose data: the
// function refuses a connection of any other organization as not found.
connections.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const refuse = (code: ConnectionRouteRefusalCode, ctx: Partial<RouteRefusalContext> = {}, extra: Record<string, unknown> = {}) => {
    console.warn(JSON.stringify({ event: 'connection_remove_refused', code, organization_id: orgId, connection_id: UUID.test(id) ? id : null }))
    return c.json({ error: code, message: connectionRouteSentence(code, { service: 'the service', secret: 'login', names: [], deleted: false, ...ctx }), ...extra }, ROUTE_STATUS[code])
  }
  if (!UUID.test(id)) return refuse('connection_not_found')

  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase.rpc('remove_ops_connection', { p_organization_id: orgId, p_connection_id: id, p_actor: userId })
  if (error) {
    if (error.code === 'P0002' && /connection_not_found/.test(error.message)) return refuse('connection_not_found')
    if (error.code === 'BP422') return refuse('connection_not_removable')
    console.error(JSON.stringify({ event: 'connection_remove_unconfirmed', organization_id: orgId, connection_id: id, error: formatErr(error) }))
    return refuse('connection_remove_unconfirmed')
  }
  const result = Array.isArray(data) ? (data[0] as { outcome?: unknown; removed_generation?: unknown; workflows?: unknown } | undefined) : undefined
  if (result?.outcome === 'connection_in_use') {
    const workflows = (Array.isArray(result.workflows) ? result.workflows : []) as UsingWorkflow[]
    const names = workflows.map((w) => (w.deleted ? `${w.name} (deleted)` : w.name))
    return refuse('connection_in_use', { names, deleted: workflows.some((w) => w.deleted) }, { workflows })
  }
  if (result?.outcome !== 'removed' || typeof result.removed_generation !== 'number') {
    console.error(JSON.stringify({ event: 'connection_remove_unconfirmed', organization_id: orgId, connection_id: id, error: 'the removal answered no outcome this route reads' }))
    return refuse('connection_remove_unconfirmed')
  }
  const generation = result.removed_generation
  console.log(JSON.stringify({ event: 'connection_removed', organization_id: orgId, connection_id: id, generation }))

  const revoked = await callOpsConnections(c.env, 'revoke', { organization_id: orgId, connection_id: id, generation, removed_at: new Date().toISOString() })
  const removed = { outcome: 'removed', connection: { id, generation } }
  if (!revoked.ok) {
    // The removal stands; the bidding tombstone reaches ops by the serve (above).
    console.error(JSON.stringify({ event: 'connection_revoke_failed', organization_id: orgId, connection_id: id, generation, refused: revoked.refused }))
    const notice = 'connection_removed_ops_not_told'
    return c.json({ ...removed, ops: { told: false, cause: revoked.refused, message: connectionRouteSentence(notice, { service: 'the service', secret: 'login', names: [], deleted: false }) } }, ROUTE_STATUS[notice])
  }
  return c.json({ ...removed, ops: { told: true } })
})

/** What a Google list refusal from ops is answered as: unconfirmed when the change may have been made, refused when it is Bidspoke's fault. */
const DELEGATION_UNCONFIRMED: ReadonlySet<string> = new Set(['ops_connections_unavailable', 'ops_connections_timeout', 'ops_connections_failed', 'delegation_change_failed'])
const DELEGATION_OWN: ReadonlySet<string> = new Set([
  'delegation_subject_invalid', 'delegation_display_name_invalid', 'delegation_subject_listed_elsewhere', 'delegation_subject_not_listed',
])

function delegationRefusalCode(refused: string): ConnectionRouteRefusalCode {
  if (DELEGATION_OWN.has(refused)) return refused as ConnectionRouteRefusalCode
  if (DELEGATION_UNCONFIRMED.has(refused)) return 'delegation_change_failed'
  return 'delegation_change_refused'
}

// The Google mailboxes and drives list (R10, D10; finding F129): the
// mailboxes and shared drives an ops Google connection may act as, held on ops
// (google_delegation_subjects) and changed only through these routes.
//   GET    /api/connections/google/subjects                 200 { subjects, reached_limit }
//   POST   /api/connections/google/subjects                 body { kind, subject, display_name? }
//          201 { outcome: 'added', entry }  200 { outcome: 'already_listed', entry }
//   DELETE /api/connections/google/subjects/:kind/:subject  200 { outcome: 'removed' }
//          409 delegation_subject_in_use { connections: [{ id, name, service }] }
//          while a saved connection names the entry
//
// Who may call them: any signed in user of the organization may read, add and
// remove (Dan, 2026-10-18). Whose data: the caller's organization's list only,
// from the verified token; the body may not name one. Audit: ops writes each
// change's record in the same transaction as the change, naming the signed in
// person passed as the actor and when (ops migration 20261020190000), so the
// route writes none of its own. Whether a text is one mailbox address or one
// drive id is the ops table's to judge (L83); ops answers it by name.
const delegationRefuse = (
  c: Context, orgId: string, code: ConnectionRouteRefusalCode, names: string[] = [], extra: Record<string, unknown> = {}, subject?: string,
) => {
  console.warn(JSON.stringify({ event: 'google_list_refused', code, organization_id: orgId }))
  return c.json({ error: code, message: connectionRouteSentence(code, { service: 'Google', secret: 'login', names, deleted: false, subject }), ...extra }, ROUTE_STATUS[code])
}

connections.get('/google/subjects', async (c) => {
  const { orgId } = c.get('user')
  const answer = await callOpsConnections(c.env, 'listDelegationSubjects', { organization_id: orgId })
  if (!answer.ok) {
    // Never an empty list (L10): the page shows that the list could not be read.
    console.error(JSON.stringify({ event: 'google_list_unavailable', organization_id: orgId, refused: answer.refused }))
    return delegationRefuse(c, orgId, 'delegation_list_unavailable', [], { cause: answer.refused })
  }
  return c.json({ subjects: answer.subjects, reached_limit: answer.reached_limit })
})

connections.post('/google/subjects', async (c) => {
  const { orgId, userId, email, name } = c.get('user')
  if (declaredBodyTooLarge(c.req.header('content-length'))) {
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null }) }, 400)
  }
  const body = readDelegationEntryBody(await c.req.text())
  if (!body.ok) {
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null }), detail: body.problem }, 400)
  }
  const shown = body.subject.trim() === '' ? 'An empty entry' : body.subject.trim()
  if (body.subject.trim() === '' || body.subject.length > DELEGATION_SUBJECT_MAX) return delegationRefuse(c, orgId, 'delegation_subject_invalid', [shown.slice(0, 80)])
  if (body.display_name !== null && body.display_name.length > DELEGATION_DISPLAY_NAME_MAX) return delegationRefuse(c, orgId, 'delegation_display_name_invalid')

  const answer = await callOpsConnections(c.env, 'addDelegationSubject', {
    organization_id: orgId,
    actor: { user_id: userId, email, name },
    kind: body.kind,
    subject: body.subject,
    display_name: body.display_name,
  })
  if (!answer.ok) return delegationRefuse(c, orgId, delegationRefusalCode(answer.refused), [shown], { cause: answer.refused })
  console.log(JSON.stringify({ event: 'google_list_added', organization_id: orgId, kind: answer.entry.kind, outcome: answer.outcome }))
  return c.json({ outcome: answer.outcome, entry: answer.entry }, answer.outcome === 'added' ? 201 : 200)
})

connections.delete('/google/subjects/:kind/:subject', async (c) => {
  const { orgId, userId, email, name } = c.get('user')
  const kind = c.req.param('kind')
  const subject = c.req.param('subject')
  if (!(DELEGATION_KINDS as readonly string[]).includes(kind)) {
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null }), detail: 'kind is not mailbox or drive' }, 400)
  }
  if (subject.trim() === '' || subject.length > DELEGATION_SUBJECT_MAX) return delegationRefuse(c, orgId, 'delegation_subject_not_listed', ['That entry'])

  // Refused while a saved connection of the organization names it (Dan,
  // 2026-10-20), as a connection is while a workflow uses it (D9): read from
  // each connection's target, whom the Google minter acts as. A read that
  // fails, or a list too long to read whole, removes nothing. A connection
  // saved in the instant between this read and the removal is still refused at
  // its every mint, since the minter checks the list (F129).
  const supabase = createSupabaseClient(c.env)
  const { data: rows, error } = await supabase
    .from('service_connections')
    .select('id, name, service_type, target')
    .eq('organization_id', orgId)
    .order('name')
    .limit(CONNECTIONS_LIST_MAX + 1)
  const listed = (rows ?? []) as Array<{ id: string; name: string; service_type: string; target: unknown }>
  if (error || listed.length > CONNECTIONS_LIST_MAX) {
    console.error(JSON.stringify({ event: 'google_list_use_unreadable', organization_id: orgId, error: error ? formatErr(error) : `more than ${CONNECTIONS_LIST_MAX} connections` }))
    return delegationRefuse(c, orgId, 'delegation_use_unreadable')
  }
  const naming = connectionsNamingSubject(listed, kind as DelegationKind, subject)
  if (naming.length > 0) {
    return delegationRefuse(c, orgId, 'delegation_subject_in_use', naming.map((r) => r.name), {
      connections: naming.map((r) => ({ id: r.id, name: r.name, service: r.service_type })),
    }, subject.trim())
  }

  const answer = await callOpsConnections(c.env, 'removeDelegationSubject', {
    organization_id: orgId,
    actor: { user_id: userId, email, name },
    kind: kind as DelegationKind,
    subject,
  })
  if (!answer.ok) return delegationRefuse(c, orgId, delegationRefusalCode(answer.refused), [subject], { cause: answer.refused })
  console.log(JSON.stringify({ event: 'google_list_removed', organization_id: orgId, kind }))
  return c.json({ outcome: answer.outcome })
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
