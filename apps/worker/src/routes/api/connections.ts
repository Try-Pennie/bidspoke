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
// POST /api/connections/:id/replace      gives each ticked workflow a new
//      version naming another connection in its place (build PR 12; R20)
// GET  /api/connections/:id/history  the History tab (build PR 9; R5)
// POST /api/connections/google/sign-in, POST /api/connections/google/sign-in/finish
//      Sign in with your own Google account (build PR 13; R17)
// GET, POST /api/connections/google/subjects, and
// DELETE /api/connections/google/subjects/:kind/:subject  the Google
//      mailboxes and drives list (build PR 6; R10)
// Each is described above its handler.
//
// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's rows, scoped by organization_id from
// the verified token in every query, and every ops call names that
// organization alone, which ops scopes again (ops-connections-contract.ts).
// The list, the history and the lookup write no row, so none writes an audit
// row. The list also asks Slack about the Slack alert login's stored token
// (lib/slack-alert-login-check.ts), which goes to auth.test and nowhere else.
//
// Retired here: DELETE /:service_type and POST /:service_type/sync-schema,
// which acted on a legacy row (a Cloudflare secret login) found by service type
// alone. None existed (measured 2026-10-17), POST could no longer make one
// (#2331), and DELETE /:service_type had the same path shape as the DELETE /:id
// of build PR 6, so whichever registered first would have taken the other's
// requests. The canvas schema browser that called sync-schema went with them.

import { Hono, type Context } from 'hono'
import { CURRENT_OPS_KID, OPS_CONNECTION_PUBLIC_KEYS, seal, SealError, type SealedEnvelope } from '@bidspoke/connection-seal'
import {
  CATALOGUE, CONNECTION_STATUS_WORDS, connectionParts, GOOGLE_OWN_ACCOUNT_TARGET, HTTP_SERVICE_KEY, httpHostOf, isOwnAccountTarget, SLACK_ALERT_LOGIN_NAME,
  type ConnectionPageStatus,
} from '@bidspoke/service-catalogue/schema'
import {
  googleAuthorizeUrl, googleRedirectUri, pkceChallenge, pkceVerifier, readSignInFinishBody, readSignInStartBody, SIGN_IN_REFUSAL_CODES, signInRefusalSentence,
  type SignInRefusalCode,
} from '../../lib/google-sign-in'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { formatErr } from '../../lib/format-error'
import { mapWithConcurrency } from '../../lib/timeout-audit'
import { resolveSalesforceCredsFor } from '../../lib/salesforce-creds'
import { moneyHostOf, moneyTargetIn, readMoneyHosts, readMoneyTargets, type MoneyHostReads } from '../../lib/connection-money-targets'
import { readOrgWorkflows } from '../../lib/org-workflows'
import {
  connectionRouteSentence, createRefusalSentence, isCreateRefusalCode, replaceIncompleteSentence, type ConnectionRouteRefusalCode, type CreateRefusalCode, type CreateRouteRefusalCode,
  type RefusalContext, type RouteRefusalContext, type VerifyRefusalCode,
} from '../../lib/connection-create-refusals'
import {
  readReplaceBody, replaceClock, replaceComplete, replaceConnectionId, replaceHasTimeFor, REPLACE_OUTCOMES, REPLACE_SAVE_ATTEMPTS, type ReplacedWorkflow, type ReplaceRefusal,
} from '../../lib/connection-replace'
import { checkDefinitionConnections, type ConnectionCheckRefusal } from '../../lib/workflow-connection-check'
import { copiedDefinitionStamp, writtenDefinitionStamp } from '../../lib/definition-stamp'
import { reportDefinition } from '../../lib/definition-report'
import { writeWorkflow, type WorkflowRow } from '../../lib/write-workflow'
import { refreshWorkflowCaches } from '../../engine/definition-loader'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { assertNever } from '@bidspoke/node-types'
import { readDelegationEntryBody, readReconnectBody, reconnectLogin, reconnectValues } from '../../lib/connection-reconnect'
import { writeAuditLog } from '../../lib/audit'
import { requireRowsAffected } from '../../lib/db-retry'
import { DELEGATION_KINDS, type DelegationKind } from '../../ops/run-vocabulary'
import { readGoogleTarget } from '../../ops/connections/minters/google-target'
import {
  actsAsOf, AUTH_TYPE_OF, connectionNameOf, connectionsNamingSubject, CREATE_BODY_MAX_BYTES, declaredBodyTooLarge, declaredService, isReservedName, orgHostOf, readCreateBody,
  keyScopeOf, listedDriveNamedAsMailbox, secretLabelOf, unlistedGoogleSubjects,
} from '../../lib/connection-create'
import { callOpsConnections, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
import {
  DELEGATION_DISPLAY_NAME_MAX, DELEGATION_SUBJECT_MAX, OpsConnectionsContractError, parseLookupRequest, type HealthRow, type OpsConnectionsRefusalCode,
} from '../../lib/ops-connections-contract'
import { pageStatusOf, readConnectionStatuses, readSlackAlertStatus, rememberConnectionStatuses, rememberSlackAlertStatus } from '../../lib/connection-statuses'
import { checkSlackAlertLogin, isSlackAlertRow } from '../../lib/slack-alert-login-check'
import { onlySlackAlertRow, resolveSlackConnection, SLACK_ALERT_READ_LIMIT, SLACK_ROW_COLUMNS } from '../../lib/slack-connection'
import { slackActsAs, verifySlackToken } from '../../lib/slack-token-check'
import { compareWithSlackAlertBot } from '../../lib/slack-alert-bot'
import type { MeasuredIdentityAnswer } from '../../lib/ops-connections-contract'
import { secretKeys } from '../../lib/secret-crypto'
import { saveSlackAlertConnection } from './integrations'
import { OPS_CONNECTIONS_DEADLINES_MS } from '../../lib/ops-connections-client'

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
const LIST_COLUMNS = 'id, name, service_type, sealed_for, acts_as, person_bound, user_id, target, created_at, updated_at'

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
  sealed_for: string | null
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

/** A service's name as the page shows it: the catalogue's (Slack's, the alert login's too, since #2337), or its key for a row the catalogue does not declare. */
function serviceNameOf(key: string): string {
  return declaredService(CATALOGUE, key)?.name ?? key
}

/** The latest of the times given, or null when none is. */
function latest(times: Array<string | null>): string | null {
  const known = times.filter((t): t is string => t !== null)
  if (known.length === 0) return null
  return known.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
}

/** The earliest of the times given, or null when none is. */
function earliest(times: Array<string | null>): string | null {
  const known = times.filter((t): t is string => t !== null)
  if (known.length === 0) return null
  return known.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
}

/** What a refusal of the alerts bot names as its match: the login, never a value. */
const SLACK_ALERT_MATCH = 'the Slack alert login'

/**
 * Whether a verified Slack bot is the organization's alerts bot (#2337, Dan's
 * decision 6), read through the one alert row filter; null for a login of any
 * other service. Ops measured the bot, and only bidding holds the alerts
 * login, so the comparison is made here (lib/slack-alert-bot.ts).
 */
async function slackAlertBotOf(
  supabase: ReturnType<typeof createSupabaseClient>, env: Env, orgId: string, identity: MeasuredIdentityAnswer,
): Promise<'alert_bot' | 'other' | 'unreadable' | null> {
  if (identity.kind !== 'slack') return null
  const check = await compareWithSlackAlertBot(
    () => onlySlackAlertRow(supabase.from('service_connections').select(SLACK_ROW_COLUMNS).eq('organization_id', orgId)).limit(SLACK_ALERT_READ_LIMIT),
    env, orgId, identity.bot_id,
  )
  if (check.kind === 'unreadable') console.error(JSON.stringify({ event: 'slack_alert_bot_unreadable', organization_id: orgId, detail: check.detail }))
  return check.kind
}

// GET /api/connections
//   200 { connections, statuses: { as_of, stale, unavailable } }
//       each connection: id, name, service (the catalogue key), service_name,
//       alert_login, acts_as, person_bound, owner, target, org (a Salesforce
//       target's host), status, status_word, health, checked_at, used_by, workflows (each
//       using it: id, name, deleted), created_at, updated_at
//       statuses.stale: a login check did not answer, so its statuses are the
//       last known ones, as of statuses.as_of (the earliest such time, null
//       when none is known), and statuses.unavailable names why (the stale
//       strip, D22): ops's refusal or cause, or slack_unanswered
//
// The Slack alert login (build PR 9) is listed as SLACK_ALERT_LOGIN_NAME under
// Slack, and its status is Slack's own answer about its stored token, asked
// inside the same deadline as ops health (lib/slack-alert-login-check.ts): ops
// never holds that login, so health cannot give it one.
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
  const alertRow = listed.find(isSlackAlertRow)
  const slack = alertRow
    ? checkSlackAlertLogin(
      () => onlySlackAlertRow(supabase.from('service_connections').select(SLACK_ROW_COLUMNS).eq('organization_id', orgId)).limit(SLACK_ALERT_READ_LIMIT),
      c.env, orgId, OPS_CONNECTIONS_DEADLINES_MS.health,
    )
    : null

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
  type Using = { id: string; name: string; deleted: boolean }
  let counts: Array<Using[] | 'gone'>
  try {
    counts = await mapWithConcurrency(listed, CONNECTION_REFERENCES_CONCURRENCY, async (row) => {
      const { data: refs, error: refsError } = await supabase.rpc('connection_references', { p_organization_id: orgId, p_connection_id: row.id })
      if (refsError) {
        if (refsError.code === 'P0002' && /connection_not_found/.test(refsError.message)) return 'gone' as const
        throw refsError
      }
      return (Array.isArray(refs) ? refs : []).map((r: { workflow_id: string; name: string; deleted: boolean }) => ({ id: r.workflow_id, name: r.name, deleted: r.deleted === true }))
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

  // The alert login: Slack's answer, or its last known one when Slack did not answer.
  let alertStatus: { status: ConnectionPageStatus | null; acts_as: string | null; checked_at: string | null } | null = null
  if (slack) {
    const checked = await slack
    if (checked.kind === 'answered') {
      const at = Date.now()
      alertStatus = { status: checked.status, acts_as: checked.acts_as, checked_at: new Date(at).toISOString() }
      await rememberSlackAlertStatus(c.env.WORKFLOW_CACHE, orgId, { status: checked.status, acts_as: checked.acts_as }, at)
    } else {
      const copy = await readSlackAlertStatus(c.env.WORKFLOW_CACHE, orgId)
      alertStatus = copy.kind === 'read' ? { ...copy.value, checked_at: copy.as_of } : { status: null, acts_as: null, checked_at: null }
      const slackAsOf = copy.kind === 'read' ? copy.as_of : null
      // The earliest time any shown status is from: a fresh ops answer's, or the copies'.
      asOf = earliest([asOf, slackAsOf])
      if (!stale) unavailable = { cause: 'slack_unanswered', detail: checked.detail }
      stale = true
      console.warn(JSON.stringify({ event: 'slack_alert_status_stale', organization_id: orgId, copy: copy.kind, as_of: slackAsOf }))
    }
  }

  const rows = listed.flatMap((row, i) => {
    const using = counts[i]
    if (using === 'gone') return []
    const owner = row.person_bound && row.user_id ? { user_id: row.user_id, ...(owners.get(row.user_id) ?? { name: null, email: null }) } : null
    const alert = row === alertRow
    const fromHealth = healthOf(byId.get(row.id))
    const status = alert ? (alertStatus?.status ?? null) : fromHealth.status
    const h = alert ? null : fromHealth.health
    const target = row.target !== null && typeof row.target === 'object' && !Array.isArray(row.target) ? (row.target as Record<string, unknown>) : null
    return [{
      id: row.id,
      name: alert ? SLACK_ALERT_LOGIN_NAME : row.name,
      service: row.service_type,
      service_name: serviceNameOf(row.service_type),
      alert_login: alert,
      acts_as: alert ? (alertStatus?.acts_as ?? null) : row.acts_as,
      person_bound: row.person_bound,
      owner,
      target: row.target ?? null,
      org: target ? orgHostOf(target) : null,
      status,
      status_word: status ? CONNECTION_STATUS_WORDS[status] : null,
      health: h,
      // When its login was last checked, either way: ops's latest check, or when Slack last answered.
      checked_at: alert ? (alertStatus?.checked_at ?? null) : latest([h?.last_check_ok_at ?? null, h?.last_check_failed_at ?? null]),
      used_by: using.length,
      workflows: using,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }]
  })

  return c.json({ connections: rows, statuses: { as_of: asOf, stale, unavailable } })
})

/** The most audit rows the History tab shows of one connection. */
export const CONNECTION_HISTORY_LIMIT = 50

// GET /api/connections/:id/history   (build PR 9; R5, the History tab)
//   200 { entries: [{ id, action, at, by, credential_changed, changes }] }
//       newest first, as connection_history answers them: by is who made the
//       change (their name, else their email, else null), and changes never
//       holds a login (the function drops credential_enc and bot_token and
//       says credential_changed instead)
//   404 connection_not_found   503 connection_history_unavailable
//
// Who may call it: any signed in user of the organization. Whose data: the
// one connection named, of the caller's organization only, which the function
// refuses for any other as connection_not_found. Read only, so no audit row.
const noSuchConnection = (c: Context) => c.json({ error: 'connection_not_found', message: 'There is no such connection.' }, 404)

connections.get('/:id/history', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  if (!UUID.test(id)) return noSuchConnection(c)
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase.rpc('connection_history', { p_organization_id: orgId, p_connection_id: id, p_limit: CONNECTION_HISTORY_LIMIT })
  if (error) {
    // Only the function's own refusal by name is a missing connection; any other error is the read failing.
    if (error.code === 'P0002' && /connection_not_found/.test(error.message)) return noSuchConnection(c)
    console.error(JSON.stringify({ event: 'connection_history_unavailable', organization_id: orgId, connection_id: id, error: formatErr(error) }))
    return c.json({ error: 'connection_history_unavailable', message: "The connection's history could not be read." }, 503)
  }
  const rows = (Array.isArray(data) ? data : []) as Array<{
    audit_id: string; action: string; changed_at: string; changed_by_name: string | null; changed_by_email: string | null; changes: unknown; credential_changed: boolean
  }>
  return c.json({
    entries: rows.map((r) => ({
      id: r.audit_id,
      action: r.action,
      at: r.changed_at,
      by: r.changed_by_name ?? r.changed_by_email ?? null,
      credential_changed: r.credential_changed === true,
      changes: r.changes ?? null,
    })),
  })
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
  connection_host_owned: 422,
  connection_money_host: 422,
  google_subject_not_listed: 422,
  google_subject_is_drive: 422,
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

/** At most this many partner rows are read; a read that reaches it is not known to be whole, so it refuses. */
const MONEY_HOST_READ_LIMIT = 1000

/**
 * The organization's money hosts sources (lib/connection-money-targets.ts,
 * readMoneyHosts), read only for an HTTP save. Each read is scoped to the
 * organization; one that comes back at its limit throws, so the save is
 * refused rather than checked against part of a list. Measured 2026-10-23: 10
 * money workflows (440 KB of definitions) and a handful of partner rows.
 */
function moneyHostReads(supabase: ReturnType<typeof createSupabaseClient>, env: Env): MoneyHostReads {
  return {
    salesforce: (organizationId) => resolveSalesforceCredsFor(env, supabase, organizationId),
    partnerUrls: async (organizationId) => {
      const { data, error } = await supabase
        .from('partner_configs')
        .select('api_endpoint, dedup_endpoint, click_url')
        .eq('organization_id', organizationId)
        .order('id')
        .limit(MONEY_HOST_READ_LIMIT)
      if (error) throw new Error('partner_configs read failed')
      if (data.length >= MONEY_HOST_READ_LIMIT) throw new Error('partner_configs read reached its limit')
      return data.flatMap((r) => [r.api_endpoint, r.dedup_endpoint, r.click_url].filter((v): v is string => typeof v === 'string'))
    },
    // The one organization workflows read (lib/org-workflows.ts): scoped, not soft deleted, paged; it throws rather than truncating.
    moneyDefinitions: async (organizationId) => (await readOrgWorkflows(supabase, organizationId, { lane: 'money' })).map((w) => JSON.stringify(w.definition)),
  }
}

/**
 * What a create that could not withdraw its verified id leaves on ops, and what
 * removes it (#2573): for an id bidding never stored, the ops tick's first
 * complete serve over an hour after the verify (ops/connection-serve.ts).
 */
const LEFT_ON_OPS = "if bidding did not store the id, a Salesforce login's measured identity left on ops is removed by the first complete serve over an hour later; no other service's verify leaves anything"

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
//   4. a money identity in the target (lib/connection-money-targets.ts), and
//      for an HTTP connection its host: refused when another catalogue
//      service owns it, or when bidding sends to it (moneyHostOf, #2337)
//   5. for a Google delegation login, a listed shared drive named as the
//      mailbox it acts as (#2572), then a mailbox or drive not on the
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
//      What verify records for a candidate is a Salesforce login's measured
//      identity and nothing else (ops-connections.ts), which nothing reads for
//      an id ops never holds a copy of. The ops tick removes it once a
//      complete serve more than an hour later does not name the id (#2573,
//      ops/connection-serve.ts), and logs its removal by the same id.
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

  const refuse = (code: CreateRefusalCode, ctx: Partial<Omit<RefusalContext, 'targetFrom'>> & { service: string }, extra: Record<string, unknown> = {}) => {
    // Add: the target is typed in this form, so a sentence may send the person to it (#2910).
    const context: RefusalContext = { secret: 'login', org: null, names: [], money: null, ...ctx, targetFrom: 'form' }
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
  const words: Pick<RefusalContext, 'service' | 'secret' | 'keyScope'> = { service: service.name, secret: secretLabelOf(service), keyScope: keyScopeOf(service) }

  // 2. The name, the login and the target.
  const named = connectionNameOf(body.name)
  if (!named.ok) return refuse(named.code, words)
  const parts = connectionParts(service.connection, body.fields)
  if (!parts.ok) {
    const labelOf = (key: string) => service.connection.fields.find((f) => f.key === key)?.label ?? key
    if (parts.unknown.length > 0) return refuse('connection_fields_undeclared', { ...words, names: parts.unknown }, { fields: parts.unknown })
    // A list sent for a text field or text for a list field (#2572): never the form's own shape.
    if (parts.malformed.length > 0) {
      return refuse('connection_request_invalid', words, { detail: `${parts.malformed.join(', ')} ${parts.malformed.length === 1 ? 'is' : 'are'} not in the shape ${parts.malformed.length === 1 ? 'its field takes' : 'their fields take'}` })
    }
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

  // 4b. An HTTP connection's one host: never one another catalogue service owns, and never one bidding sends to (#2337).
  if (service.key === HTTP_SERVICE_KEY) {
    const declared = httpHostOf(target.host)
    if (!declared.ok) {
      if (declared.problem === 'service_owned') return refuse('connection_host_owned', { ...words, names: [declared.host, declared.service] }, { owned_by: declared.service })
      return refuse('connection_target_invalid', words, { detail: declared.problem })
    }
    const hosts = await readMoneyHosts(c.env as unknown as Record<string, unknown>, orgId, moneyHostReads(supabase, c.env))
    if (!hosts.ok) {
      console.error(JSON.stringify({ event: 'connection_money_targets_unreadable', organization_id: orgId, detail: hosts.detail }))
      return refuse('connection_money_targets_unreadable', words)
    }
    const money = moneyHostOf(declared.host, hosts.hosts)
    if (money) return refuse('connection_money_host', { ...words, names: [money.host] }, { matched: money.source })
  }

  // 5. A Google delegation login names only mailboxes and drives on the organization's list (F129).
  if (service.connection.auth === 'service_account_delegation') {
    const list = await callOpsConnections(c.env, 'listDelegationSubjects', { organization_id: orgId })
    if (!list.ok) {
      console.error(JSON.stringify({ event: 'connection_google_list_unavailable', organization_id: orgId, refused: list.refused }))
      return refuse('google_list_unavailable', words)
    }
    const drive = listedDriveNamedAsMailbox(target, list.subjects)
    if (drive !== null) return refuse('google_subject_is_drive', { ...words, names: [drive] })
    // The minter's own reading (#2819): a target it would refuse at every mint is refused here.
    const subjects = readGoogleTarget(target)
    if (!subjects.ok) return refuse('connection_request_invalid', words, { detail: 'the mailbox or drives are not in the shape a Google login reads' })
    const unlisted = unlistedGoogleSubjects(subjects, list.subjects)
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
  // A Slack bot is never the alerts bot (Dan's decision 6). Verify wrote nothing for a candidate, so nothing is withdrawn.
  const alertBot = await slackAlertBotOf(supabase, c.env, orgId, answer.identity)
  if (alertBot === 'alert_bot') return refuse('connection_money_identity', { ...words, money: 'slack_alert_bot' }, { money: 'slack_alert_bot', matched: SLACK_ALERT_MATCH })
  if (alertBot === 'unreadable') return refuse('connection_money_targets_unreadable', words)

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
        console.error(JSON.stringify({ event: 'connection_create_left_on_ops', organization_id: orgId, connection_id: connectionId, why: 'the insert failed and could not be read back, so whether it landed is unknown', left: LEFT_ON_OPS }))
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
        console.error(JSON.stringify({ event: 'connection_create_left_on_ops', organization_id: orgId, connection_id: connectionId, refused: revoked.refused, why: 'verify passed, the insert failed, and the revoke of the verified id failed', left: LEFT_ON_OPS }))
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
  slack_token_refused: 422,
  slack_stored_token_refused: 422,
  slack_unanswered: 503,
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
  replace_body_invalid: 400,
  replace_too_many: 400,
  connection_not_replaceable: 422,
  replace_with_not_found: 404,
  replace_with_same: 422,
  replace_with_other_service: 422,
  replace_with_unusable: 422,
  replace_with_not_yours: 422,
  replace_uses_unreadable: 503,
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

// ── Reconnect on the Slack alerts login (build PR 14; Dan's decision 4, 2026-10-21) ──

/** The Slack alerts login's one field: its bot token, the key POST /api/integrations/slack has always taken. */
const SLACK_ALERT_TOKEN_FIELD = { key: 'bot_token', label: 'Bot token' } as const

interface SlackAlertRow { id: string; config: unknown; credential_enc: string | null }

/** The caller's organization's Slack alert row with this id (lib/slack-connection.ts defines which row that is), or none. */
async function readSlackAlertRow(supabase: ReturnType<typeof createSupabaseClient>, orgId: string, id: string): Promise<{ kind: 'row'; row: SlackAlertRow } | { kind: 'none' } | { kind: 'unreadable' }> {
  const { data, error } = await onlySlackAlertRow(supabase.from('service_connections').select(`id, ${SLACK_ROW_COLUMNS}`).eq('organization_id', orgId).eq('id', id)).limit(SLACK_ALERT_READ_LIMIT)
  if (error) {
    console.error(JSON.stringify({ event: 'connection_reconnect_read_failed', organization_id: orgId, error: formatErr(error) }))
    return { kind: 'unreadable' }
  }
  const row = (data as unknown as SlackAlertRow[] | null)?.find((r) => r.id === id)
  return row ? { kind: 'row', row } : { kind: 'none' }
}

type OwnRefusal = (code: ConnectionRouteRefusalCode, ctx?: Partial<RouteRefusalContext>, extra?: Record<string, unknown>) => Response
/** The Reconnect's sentences: the target is the stored row's on every one, so no caller can say otherwise (#2910). */
type CreateRefusalAnswer = (code: CreateRefusalCode, ctx?: Partial<Omit<RefusalContext, 'targetFrom'>>, extra?: Record<string, unknown>) => Response

/**
 * Reconnect on the Slack alerts login. Ops never holds this login, so Slack is
 * what checks it, with auth.test (verifySlackToken), and nothing is asked of
 * ops. With a new bot token: checked first, then saved by the one function
 * that saves that token (saveSlackAlertConnection, which POST
 * /api/integrations/slack calls too), which merges only the workspace name
 * into the row's config, so the channel and the four alert switches are kept as
 * the row holds them, even when a settings save lands at the same moment
 * (#2643). With none: the stored token is checked
 * again and nothing is written, as for every other login. A row that was never
 * sealed is unreadable here (its plaintext is never read, #2331's contract
 * release), and a Reconnect with a new token seals it. A token Slack could not
 * be asked about is never called refused (L11).
 *
 * Who: the caller's organization's alert row, read by id and organization
 * (readSlackAlertRow). The save's updated_by names the user, so the table's
 * trigger audits a new token; a check without one writes its audit row here.
 */
async function reconnectSlackAlertLogin(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  row: SlackAlertRow,
  fields: Record<string, string> | null,
  refuse: { ownRefusal: OwnRefusal; createRefusal: CreateRefusalAnswer },
): Promise<Response> {
  const { orgId, userId, email } = c.get('user')
  const words = { service: serviceNameOf('slack'), secret: 'token' }
  const own = (code: ConnectionRouteRefusalCode, names: string[] = []) => refuse.ownRefusal(code, { ...words, names })
  const asked = async (token: string): Promise<{ kind: 'ok'; actsAs: string | null; team: string | null } | { kind: 'refused'; slackError: string | null } | { kind: 'unanswered' }> => {
    try {
      const check = await verifySlackToken(token)
      return check.kind === 'ok' ? { kind: 'ok', actsAs: slackActsAs(check), team: check.team } : check
    } catch (err) {
      console.warn(JSON.stringify({ event: 'slack_alert_reconnect_unanswered', organization_id: orgId, error: formatErr(err) }))
      return { kind: 'unanswered' }
    }
  }

  if (fields === null) {
    // A missing key ring is the resolver's own named state (slack_key_ring_missing), never an unhandled 500.
    let keys: ReturnType<typeof secretKeys> | undefined
    try {
      keys = secretKeys(c.env)
    } catch (err) {
      console.error(JSON.stringify({ event: 'slack_alert_recheck_no_key_ring', organization_id: orgId, error: formatErr(err) }))
    }
    const resolved = await resolveSlackConnection(row, keys)
    if (resolved.kind !== 'connection') return own('reconnect_login_unreadable')
    const check = await asked(resolved.connection.bot_token)
    if (check.kind === 'unanswered') return own('slack_unanswered')
    if (check.kind === 'refused') return own('slack_stored_token_refused', check.slackError ? [check.slackError] : [])
    await writeAuditLog(supabase, orgId, 'service_connection', row.id, 'connection_rechecked', userId, {})
    console.log(JSON.stringify({ event: 'connection_rechecked', organization_id: orgId, connection_id: row.id, service: 'slack' }))
    return c.json({ outcome: 'checked', connection: { id: row.id, acts_as: check.actsAs } })
  }

  const unknown = Object.keys(fields).filter((k) => k !== SLACK_ALERT_TOKEN_FIELD.key)
  if (unknown.length > 0) return refuse.createRefusal('connection_fields_undeclared', { ...words, names: unknown }, { fields: unknown })
  const token = (fields[SLACK_ALERT_TOKEN_FIELD.key] ?? '').trim()
  if (token === '') return refuse.createRefusal('connection_fields_missing', { ...words, names: [SLACK_ALERT_TOKEN_FIELD.label] }, { fields: [SLACK_ALERT_TOKEN_FIELD.key] })

  const check = await asked(token)
  if (check.kind === 'unanswered') return own('slack_unanswered')
  if (check.kind === 'refused') return own('slack_token_refused', check.slackError ? [check.slackError] : [])

  // Only the token and the workspace Slack named (#2643): the channel and the
  // switches are left as the row holds them when the save writes, never put
  // back as this request read them, which turned a switch someone had just
  // turned off back on.
  const saved = await saveSlackAlertConnection(c.env, supabase, { orgId, userId, email }, {
    bot_token: token,
    config: check.team ? { workspace_name: check.team } : {},
  })
  if (saved.kind === 'seal_failed') return refuse.createRefusal('connection_seal_failed', words)
  if (saved.kind === 'store_failed') {
    console.error(JSON.stringify({ event: 'slack_alert_reconnect_store_failed', organization_id: orgId, connection_id: row.id, error: formatErr(saved.error) }))
    return refuse.createRefusal('connection_store_failed', words)
  }
  console.log(JSON.stringify({ event: 'connection_reconnected', organization_id: orgId, connection_id: row.id, service: 'slack' }))
  return c.json({ outcome: 'reconnected', connection: { id: row.id, acts_as: check.actsAs }, ...saved.copyWarning })
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
  // A Reconnect keeps what the connection names (reconnect_target_changed), so every sentence built here, by
  // either path, reads the target as stored and never sends the person to change it (L111, #2910).
  const words: Pick<RefusalContext, 'service' | 'secret' | 'keyScope' | 'targetFrom'> = { service: 'the service', secret: 'login', keyScope: null, targetFrom: 'stored' }
  const ownRefusal = (code: ConnectionRouteRefusalCode, ctx: Partial<RouteRefusalContext> = {}, extra: Record<string, unknown> = {}) => {
    console.warn(JSON.stringify({ event: 'connection_reconnect_refused', code, organization_id: orgId, connection_id: UUID.test(id) ? id : null }))
    return c.json({ error: code, message: connectionRouteSentence(code, { ...words, names: [], deleted: false, ...ctx }), ...extra }, ROUTE_STATUS[code])
  }
  const createRefusal: CreateRefusalAnswer = (code, ctx = {}, extra = {}) => {
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
    // The Slack alerts login is reconnected here too (build PR 14, Dan's decision 4): Slack checks its token, not ops.
    const alert = await readSlackAlertRow(supabase, orgId, id)
    if (alert.kind === 'unreadable') return createRefusal('connections_unavailable')
    if (alert.kind === 'row') return reconnectSlackAlertLogin(c, supabase, alert.row, body.fields, { ownRefusal, createRefusal })
    const missing = await rowMissing(supabase, orgId, id)
    if (missing === 'unreadable') return createRefusal('connections_unavailable')
    return ownRefusal(missing === 'not_ops' ? 'connection_not_reconnectable' : 'connection_not_found')
  }
  const row = data as ReconnectRow
  const service = declaredService(CATALOGUE, row.service_type)
  if (!service) return createRefusal('connection_service_undeclared', { service: row.service_type })
  Object.assign(words, { service: service.name, secret: secretLabelOf(service), keyScope: keyScopeOf(service) })
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
  const parts = connectionParts(reconnectLogin(service.connection), values.values)
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
  // A new Slack token is never the alerts bot's either (Dan's decision 6).
  const alertBot = await slackAlertBotOf(supabase, c.env, orgId, verified.identity)
  if (alertBot === 'alert_bot') return createRefusal('connection_money_identity', { money: 'slack_alert_bot' }, { money: 'slack_alert_bot', matched: SLACK_ALERT_MATCH })
  if (alertBot === 'unreadable') return createRefusal('connection_money_targets_unreadable')
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

/** The columns Replace reads of the two connections: never credential_enc, config (the Slack row's token) or target. */
const REPLACE_COLUMNS = 'id, name, service_type, sealed_for, person_bound, user_id'

/** The columns Replace reads of a workflow it gives a new version. */
const REPLACE_WORKFLOW_COLUMNS = 'id, name, definition, version, lane, is_active, definition_schema_version'

interface ReplaceConnectionRow { id: string; name: string; service_type: string; sealed_for: string | null; person_bound: boolean; user_id: string | null }
type ReplaceWorkflowRow = Pick<WorkflowRow, 'id' | 'name' | 'definition' | 'version' | 'lane' | 'is_active' | 'definition_schema_version'>

/** Why the connection check refused a new version: the replacement itself gone, another removed connection the workflow names, or no answer. */
function replaceRefusalOf(refusal: ConnectionCheckRefusal, replacement: string): ReplaceRefusal {
  if (refusal.body.code !== 'workflow_connection_missing') return 'check_failed'
  const missing = refusal.body.missing_connections ?? []
  return missing.length === 0 || missing.some((m) => m.id.toLowerCase() === replacement) ? 'replacement_removed' : 'names_removed_connection'
}

// POST /api/connections/:id/replace (build PR 12; R20, D20)
//   body { with: <connection id>, workflows: [<workflow id>, ...] }, the ticked ones
//   200 { outcome: 'replaced' | 'incomplete', connection: { id }, with: { id, name },
//         workflows: [{ id, name, outcome, version?, why? }], message?, stored_copy_warning? }
//       replaced: every ticked workflow names the replacement now, newly or
//       already (so a Replace run twice writes nothing the second time);
//       incomplete: some do not, and message names each, why, and what to do
//       (lib/connection-replace.ts has each workflow's outcomes)
//   otherwise { error, message }, and nothing was written
//
// Each ticked workflow that names the connection (connection_references, the
// one predicate the Remove refusal reads) gets a new version through
// writeWorkflow's save, from the version read, with every string naming the
// connection replaced by the replacement's id (replaceConnectionId, the same
// predicate's rule). Before each write it asks the connection check, as every
// definition writer does; the store's trigger refuses a replacement removed
// after that check. A save that loses to someone else's (stale_version) is read
// again and made on top of theirs, so their change is kept, up to
// REPLACE_SAVE_ATTEMPTS times. A soft deleted workflow cannot get a new version
// (write_workflow writes none), so it is named and left. The version keeps the
// rules stamp it had, since only one id changed; an unstamped one takes this
// build's, which a save must carry. Each written workflow's stored copy is
// refreshed and its write audited as a workflow update under the person, and
// its new version pushed to the GitHub backup by writeWorkflow, as the canvas
// save is (#2868).
//
// It keeps a deadline, the page's wait less the request's own trip
// (REPLACE_DEADLINE_MS, #2903): before it starts each workflow it asks whether
// that workflow's slowest measured run still finishes by then, and when it
// cannot, the workflow is left as refused, not_reached, read and written not at
// all, so the page names it and keeps it ticked. A workflow once started is
// always finished, never stopped part way through its write.
//
// Who may call it: any signed in user of the organization (jwtAuth). Whose
// data: both connections and every workflow are read by the caller's
// organization from the verified token, the body may name no organization,
// and a ticked workflow that does not name the connection in this organization
// is never read. The replacement must be an ops connection of the same service,
// and not someone else's own Google account, which only its owner may use in a
// workflow (Dan, 2026-10-23); the executor refuses a step bound by anyone else.
connections.post('/:id/replace', async (c) => {
  const startedAt = replaceClock.now()
  const { orgId, userId, email, name } = c.get('user')
  const id = c.req.param('id').toLowerCase()
  const refuse = (code: ConnectionRouteRefusalCode, ctx: Partial<RouteRefusalContext> = {}) => {
    console.warn(JSON.stringify({ event: 'connection_replace_refused', code, organization_id: orgId, connection_id: UUID.test(id) ? id : null }))
    return c.json({ error: code, message: connectionRouteSentence(code, { service: 'the service', secret: 'login', names: [], deleted: false, ...ctx }) }, ROUTE_STATUS[code])
  }
  if (!UUID.test(id)) return refuse('connection_not_found')
  const body = readReplaceBody(await c.req.json().catch(() => null))
  if (!body.ok) return refuse(body.code)
  if (body.with === id) return refuse('replace_with_same')

  const supabase = createSupabaseClient(c.env)
  const { data: pair, error: pairError } = await supabase
    .from('service_connections')
    .select(REPLACE_COLUMNS)
    .eq('organization_id', orgId)
    .in('id', [id, body.with])
    .limit(2)
  if (pairError) {
    console.error(JSON.stringify({ event: 'connection_replace_unreadable', organization_id: orgId, connection_id: id, what: 'connections', error: formatErr(pairError) }))
    return refuse('replace_uses_unreadable')
  }
  const rows = (pair ?? []) as ReplaceConnectionRow[]
  const source = rows.find((r) => r.id === id)
  const replacement = rows.find((r) => r.id === body.with)
  if (!source) return refuse('connection_not_found')
  if (source.sealed_for !== 'ops_key') return refuse('connection_not_replaceable')
  if (!replacement) return refuse('replace_with_not_found')
  if (replacement.sealed_for !== 'ops_key') return refuse('replace_with_unusable', { names: [SLACK_ALERT_LOGIN_NAME] })
  if (replacement.service_type !== source.service_type) return refuse('replace_with_other_service', { names: [replacement.name], service: serviceNameOf(source.service_type) })
  if (replacement.person_bound && replacement.user_id !== userId) return refuse('replace_with_not_yours', { names: [replacement.name] })

  const { data: refs, error: refsError } = await supabase.rpc('connection_references', { p_organization_id: orgId, p_connection_id: id })
  if (refsError) {
    if (refsError.code === 'P0002' && /connection_not_found/.test(refsError.message)) return refuse('connection_not_found')
    console.error(JSON.stringify({ event: 'connection_replace_unreadable', organization_id: orgId, connection_id: id, what: 'connection_references', error: formatErr(refsError) }))
    return refuse('replace_uses_unreadable')
  }
  const using = new Map((Array.isArray(refs) ? refs as Array<{ workflow_id: string; name: string; deleted: boolean }> : []).map((r) => [r.workflow_id.toLowerCase(), r]))

  const actor = { id: userId, email, name }
  const message = `Replaced ${source.name} with ${replacement.name}`
  const results: ReplacedWorkflow[] = []
  let copiesRefreshed = true
  for (const workflowId of body.workflows) {
    const ref = using.get(workflowId)
    if (!ref) { results.push({ id: workflowId, name: null, outcome: 'not_using' }); continue }
    if (ref.deleted) { results.push({ id: workflowId, name: ref.name, outcome: 'deleted' }); continue }
    const named = { id: workflowId, name: ref.name }
    // Started only when its slowest run still answers inside the page's wait (#2903), never stopped once started.
    if (!replaceHasTimeFor(startedAt, replaceClock.now())) { results.push({ ...named, outcome: 'refused', why: 'not_reached' }); continue }
    let result: ReplacedWorkflow | null = null
    for (let attempt = 1; attempt <= REPLACE_SAVE_ATTEMPTS && result === null; attempt += 1) {
      const { data: read, error: readError } = await supabase
        .from('workflows')
        .select(REPLACE_WORKFLOW_COLUMNS)
        .eq('id', workflowId)
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .maybeSingle()
      if (readError) {
        console.error(JSON.stringify({ event: 'connection_replace_unreadable', organization_id: orgId, workflow_id: workflowId, what: 'workflow', error: formatErr(readError) }))
        result = { ...named, outcome: 'refused', why: 'unreadable' }
        break
      }
      const row: ReplaceWorkflowRow | null = read
      if (!row) { result = { ...named, outcome: 'deleted' }; break }
      const rewrite = replaceConnectionId(row.definition, id, body.with)
      if (rewrite.replaced === 0) { result = { ...named, outcome: 'not_using' }; break }

      const refusal = await checkDefinitionConnections(supabase, orgId, rewrite.definition)
      if (refusal) { result = { ...named, outcome: 'refused', why: replaceRefusalOf(refusal, body.with) }; break }

      const replacedStamp = copiedDefinitionStamp(row) ?? writtenDefinitionStamp()
      const report = reportDefinition(rewrite.definition, { writer: 'replace_connection', workflowId, lane: row.lane, live: row.is_active === true, schemaVersion: replacedStamp })
      const written = await writeWorkflow(supabase, {
        op: 'save',
        orgId,
        workflowId,
        expectedVersion: row.version,
        fields: { definition: rewrite.definition, definition_schema_version: replacedStamp, definition_report: report, message },
        saveId: null,
        actor,
        storedDefinition: row.definition,
        backup: { env: c.env, waitUntil: (promise) => c.executionCtx.waitUntil(promise) },
      })
      switch (written.kind) {
        case 'written': {
          const version = written.workflow.version
          copiesRefreshed = (await copyCleared(async () => { await refreshWorkflowCaches(workflowId, c.env.WORKFLOW_CACHE, supabase) }, `workflow ${workflowId} caches`)) && copiesRefreshed
          await writeAuditLog(supabase, orgId, 'workflow', workflowId, 'updated', userId, { replaced_connection: id, with_connection: body.with, version })
          result = { ...named, outcome: 'replaced', version }
          break
        }
        case 'stale':
          // Someone else saved it after the read: read it again and make the change on top of theirs.
          break
        case 'not_found':
          result = { ...named, outcome: 'deleted' }
          break
        case 'connection_refused':
          result = { ...named, outcome: 'refused', why: replaceRefusalOf(written.refusal, body.with) }
          break
        case 'refused':
          console.error(JSON.stringify({ event: 'connection_replace_write_refused', organization_id: orgId, workflow_id: workflowId, reason: written.reason, detail: written.detail }))
          result = { ...named, outcome: 'refused', why: 'write_refused' }
          break
        case 'failed':
          // A timeout or a dropped connection may have committed, so it is not claimed either way.
          console.error(JSON.stringify({ event: 'connection_replace_unconfirmed', organization_id: orgId, workflow_id: workflowId, error: formatErr(written.error) }))
          result = { ...named, outcome: 'failed' }
          break
        default:
          return assertNever(written, 'write_workflow answer')
      }
    }
    results.push(result ?? { ...named, outcome: 'changed' })
  }

  const notReached = results.filter((r) => r.why === 'not_reached').length
  if (notReached > 0) {
    console.warn(JSON.stringify({ event: 'connection_replace_out_of_time', organization_id: orgId, connection_id: id, not_reached: notReached, elapsed_ms: replaceClock.now() - startedAt }))
  }
  const complete = replaceComplete(results)
  console.log(JSON.stringify({
    event: 'connection_replaced', organization_id: orgId, connection_id: id, with_connection: body.with,
    outcomes: Object.fromEntries(REPLACE_OUTCOMES.map((o) => [o, results.filter((r) => r.outcome === o).length])),
  }))
  const sentence = replaceIncompleteSentence(results, source.name, replacement.name)
  return c.json({
    outcome: complete ? 'replaced' : 'incomplete',
    connection: { id },
    with: { id: replacement.id, name: replacement.name },
    workflows: results,
    ...(sentence ? { message: sentence } : {}),
    ...copyWarning(copiesRefreshed),
  })
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
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: 'form' }) }, 400)
  }
  const body = readDelegationEntryBody(await c.req.text())
  if (!body.ok) {
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: 'form' }), detail: body.problem }, 400)
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
    return c.json({ error: 'connection_request_invalid', message: createRefusalSentence('connection_request_invalid', { service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: 'form' }), detail: 'kind is not mailbox or drive' }, 400)
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

// ── Sign in with your own Google account (build PR 13; R17) ─────────────────

/** How each sign in refusal is answered. */
const SIGN_IN_STATUS: Readonly<Record<SignInRefusalCode, 400 | 403 | 404 | 409 | 410 | 422 | 502 | 503>> = {
  sign_in_request_invalid: 400,
  google_sign_in_unset: 503,
  google_sign_in_misconfigured: 503,
  google_sign_in_no_return: 503,
  google_sign_in_unavailable: 503,
  google_sign_in_denied: 422,
  google_sign_in_failed: 502,
  google_sign_in_expired: 410,
  google_sign_in_used: 409,
  google_sign_in_unknown: 404,
  google_code_refused: 422,
  google_sign_in_not_person: 422,
  google_sign_in_not_owner: 403,
  google_sign_in_wrong_account: 422,
  google_sign_in_no_email: 422,
}

/** The address a person signs in to Google as: their own Bidspoke email, lower case, or null when they have none. */
function ownAccountOf(email: string | null | undefined): string | null {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 320 ? e : null
}

/** The columns a sign in Reconnect reads: never config. */
const SIGN_IN_ROW_COLUMNS = 'id, name, service_type, sealed_for, person_bound, user_id, credential_generation, credential_enc, target, acts_as'

interface SignInRow {
  id: string
  name: string
  service_type: string
  sealed_for: string | null
  person_bound: boolean
  user_id: string | null
  credential_generation: number
  credential_enc: string | null
  target: unknown
  acts_as: string | null
}

/** The connection a sign in Reconnect signs in again: the caller's organization's own Google account row, and only its owner's. */
async function signInRowFor(
  supabase: ReturnType<typeof createSupabaseClient>, orgId: string, userId: string, id: string,
): Promise<{ kind: 'row'; row: SignInRow } | { kind: 'refused'; code: SignInRefusalCode | 'connection_not_found' | 'connections_unavailable' }> {
  const { data, error } = await supabase.from('service_connections').select(SIGN_IN_ROW_COLUMNS).eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (error) {
    console.error(JSON.stringify({ event: 'google_sign_in_row_read_failed', organization_id: orgId, error: formatErr(error) }))
    return { kind: 'refused', code: 'connections_unavailable' }
  }
  if (!data) return { kind: 'refused', code: 'connection_not_found' }
  const row = data as unknown as SignInRow
  if (row.service_type !== 'google' || row.sealed_for !== 'ops_key' || !row.person_bound || !isOwnAccountTarget(row.target)) {
    return { kind: 'refused', code: 'google_sign_in_not_person' }
  }
  // A person bound login is one person's: only they sign it in again, as themselves.
  if (row.user_id !== userId) return { kind: 'refused', code: 'google_sign_in_not_owner' }
  return { kind: 'row', row }
}

function signInRefuse(c: Context, orgId: string, code: SignInRefusalCode | CreateRefusalCode, extra: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ event: 'google_sign_in_refused', code, organization_id: orgId }))
  if ((SIGN_IN_REFUSAL_CODES as readonly string[]).includes(code)) {
    const own = code as SignInRefusalCode
    return c.json({ error: own, message: signInRefusalSentence(own), ...extra }, SIGN_IN_STATUS[own])
  }
  const shared = code as CreateRefusalCode
  const status = (CREATE_STATUS as Partial<Record<CreateRefusalCode, number>>)[shared] ?? (VERIFY_STATUS as Partial<Record<CreateRefusalCode, number>>)[shared] ?? 422
  // A sign in, new or a Reconnect, is for the person's own account, which nobody types: its sentences send the
  // person to signing in again, or to Dan, never to an address (#2910).
  return c.json({ error: shared, message: createRefusalSentence(shared, { service: 'Google', secret: 'login', org: null, names: [], money: null, targetFrom: 'sign_in' }), ...extra }, status as 400)
}

// POST /api/connections/google/sign-in   body { name } | { connection_id }
//   200 { url }  the Google link the browser is sent to
//   otherwise { error, message }: the sentence the add form or the Reconnect shows
//
// Starts Sign in with Google for a new connection named `name`, or for the
// caller's own Google account connection `connection_id` (a Reconnect). In
// order: the body; for a new one its name (as a save reads it, taken or not,
// read early: the insert's unique decides), for a Reconnect the row, which must
// be the caller's organization's own account connection AND the caller's own;
// the sign in app's client id from ops (signInClient: the app's secret never
// leaves ops); the redirect URI from APP_URL; then one single use state
// (create_oauth_state) holding the PKCE verifier, the connection id (a fresh
// uuid for a new one) and that client id, expiring in 10 minutes.
//
// Who may call it: any signed in user of the organization (jwtAuth). Whose
// data: the caller's organization and the caller's own state; a Reconnect
// touches only a connection the caller signs in as. Nothing of any login is
// read or answered. Audit: the state is no connection change; the connection
// is audited when the finish writes it.
connections.post('/google/sign-in', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const body = readSignInStartBody(await c.req.text())
  if (!body.ok) return signInRefuse(c, orgId, 'sign_in_request_invalid', { detail: body.problem })
  // The person signs in to Google as their own Bidspoke address and no one else (Dan, 2026-10-23).
  const account = ownAccountOf(email)
  if (account === null) return signInRefuse(c, orgId, 'google_sign_in_no_email')
  const supabase = createSupabaseClient(c.env)

  let connectionId: string
  let name: string | null = null
  const loginHint = account
  if (body.kind === 'new') {
    const named = connectionNameOf(body.name)
    if (!named.ok) return signInRefuse(c, orgId, named.code)
    const { data: existing, error } = await supabase
      .from('service_connections').select('id').eq('organization_id', orgId).eq('service_type', 'google').eq('name', named.name).maybeSingle()
    if (error) {
      console.error(JSON.stringify({ event: 'google_sign_in_name_read_failed', organization_id: orgId, error: formatErr(error) }))
      return signInRefuse(c, orgId, 'connections_unavailable')
    }
    if (existing) return signInRefuse(c, orgId, 'connection_name_taken')
    name = named.name
    connectionId = crypto.randomUUID()
  } else {
    const found = await signInRowFor(supabase, orgId, userId, body.connectionId)
    if (found.kind === 'refused') return found.code === 'connection_not_found' ? noSuchConnection(c) : signInRefuse(c, orgId, found.code)
    // Its account is its owner's, the caller's: the same one is offered, and the finish accepts no other.
    connectionId = found.row.id
  }

  const app = await callOpsConnections(c.env, 'signInClient', { organization_id: orgId, service: 'google' })
  if (!app.ok) {
    if (isOpsConnectionsUnavailable(app)) return signInRefuse(c, orgId, 'ops_connections_unavailable', { detail: app.detail })
    console.error(JSON.stringify({ event: 'google_sign_in_app_refused', organization_id: orgId, refused: app.refused }))
    return signInRefuse(c, orgId, app.refused === 'sign_in_app_unset' ? 'google_sign_in_unset' : 'google_sign_in_misconfigured')
  }
  const redirectUri = googleRedirectUri(c.env.APP_URL)
  if (redirectUri === null) return signInRefuse(c, orgId, 'google_sign_in_no_return')

  const verifier = pkceVerifier()
  const { data: created, error: stateError } = await supabase.rpc('create_oauth_state', {
    p_organization_id: orgId,
    p_user_id: userId,
    p_service_type: 'google',
    p_connection_id: connectionId,
    // The generated types call every argument text; a Reconnect's null name is passed as SQL NULL.
    p_name: name as string,
    p_reconnect: body.kind === 'reconnect',
    p_client_id: app.client_id,
    p_verifier: verifier,
    p_redirect_uri: redirectUri,
  })
  const state = Array.isArray(created) ? (created[0] as { state_id?: unknown } | undefined)?.state_id : undefined
  if (stateError || typeof state !== 'string') {
    console.error(JSON.stringify({ event: 'google_sign_in_state_unwritten', organization_id: orgId, error: stateError ? formatErr(stateError) : 'no state answered' }))
    return signInRefuse(c, orgId, 'google_sign_in_unavailable')
  }
  console.log(JSON.stringify({ event: 'google_sign_in_started', organization_id: orgId, connection_id: connectionId, reconnect: body.kind === 'reconnect' }))
  return c.json({ url: googleAuthorizeUrl({ clientId: app.client_id, redirectUri, state, challenge: await pkceChallenge(verifier), loginHint }) })
})

/** How the finish answers a failed exchange: Google refusing the code is the person's to retry; the rest are the create's own sentences. */
function exchangeRefusal(answer: { ok: false; refused: string } & Partial<{ cause: string; detail: string }>): SignInRefusalCode | CreateRefusalCode {
  if (isOpsConnectionsUnavailable(answer)) return answer.cause === 'deadline' ? 'verify_timed_out' : 'ops_connections_unavailable'
  if (answer.refused === 'connection_needs_reauth') return 'google_code_refused'
  return isCreateRefusalCode(answer.refused) ? answer.refused : 'verify_refused_unknown'
}

// POST /api/connections/google/sign-in/finish   body { state, code } | { state, error }
//   201 { outcome: 'created', connection: { id, name, service, acts_as } }   a new connection
//   200 { outcome: 'reconnected', connection: { id, acts_as }, cleared }      a Reconnect
//   otherwise { error, message }
//
// The Connections page's callback posts what Google put on its address. In order:
//   1. the state, claimed once by claim_oauth_state for the caller's own user
//      and organization: never started, another person's or another
//      organization's (unknown), used, or older than 10 minutes (expired), each
//      by name. A claimed state is spent whatever follows.
//   2. Google's error: access_denied (the person said no) is denied; any other
//      is failed. Nothing is written.
//   3. A new connection: the name re-checked, then the row inserted FIRST, as
//      the person's own Google account (person_bound, owned by the caller,
//      target { own_account: true }) with a login holding only the sign in
//      app's client id, sealed to the ops key at generation 1; then ops'
//      exchangeOAuthCode. The row comes first because the token object hands
//      the new login back to the row by its alarm the moment it stores it, and
//      a row not yet there would make it give the login up. A failed exchange
//      then removes the row (remove_ops_connection, then revoke), so nothing is
//      left that has no login; a removal that fails is logged by the id.
//   4. A Reconnect: the row read again (the caller's own account connection),
//      and the exchange with the row's own sealed login as the candidate; the
//      token object seals the new refresh token above it and writes it back by
//      compare and set on that generation. Ops clears needs_reauth.
//   5. Whom it signed in as (the exchange's account, from Google's id_token) is
//      written as acts_as, audited under the caller.
//
// Who may call it: any signed in user of the organization, holding a state
// they started. Whose data: the caller's organization, and only a connection
// the caller owns. Audit: the insert and the acts_as update by the store's
// trigger under updated_by; a Reconnect also writes its own row here, naming
// nothing of the login.
connections.post('/google/sign-in/finish', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const body = readSignInFinishBody(await c.req.text())
  if (!body.ok) return signInRefuse(c, orgId, 'sign_in_request_invalid', { detail: body.problem })
  const ownAccount = ownAccountOf(email)
  const supabase = createSupabaseClient(c.env)

  // 1. The state.
  const { data: claimedRows, error: claimError } = await supabase.rpc('claim_oauth_state', { p_state_id: body.state, p_organization_id: orgId, p_user_id: userId })
  const claim = Array.isArray(claimedRows) ? (claimedRows[0] as Record<string, unknown> | undefined) : undefined
  if (claimError || !claim) {
    console.error(JSON.stringify({ event: 'google_sign_in_claim_failed', organization_id: orgId, error: claimError ? formatErr(claimError) : 'no outcome answered' }))
    return signInRefuse(c, orgId, 'google_sign_in_unavailable')
  }
  if (claim.outcome === 'expired') return signInRefuse(c, orgId, 'google_sign_in_expired')
  if (claim.outcome === 'used') return signInRefuse(c, orgId, 'google_sign_in_used')
  if (claim.outcome !== 'claimed') return signInRefuse(c, orgId, 'google_sign_in_unknown')
  const state = {
    connectionId: String(claim.connection_id), name: typeof claim.name === 'string' ? claim.name : null, reconnect: claim.reconnect === true,
    clientId: String(claim.client_id), verifier: String(claim.verifier), redirectUri: String(claim.redirect_uri),
  }

  // 2. Google's own answer.
  if (body.error !== null) return signInRefuse(c, orgId, body.error === 'access_denied' ? 'google_sign_in_denied' : 'google_sign_in_failed', { google_error: body.error })
  if (ownAccount === null) return signInRefuse(c, orgId, 'google_sign_in_no_email')

  const exchange = (generation: number, envelope: SealedEnvelope) => callOpsConnections(c.env, 'exchangeOAuthCode', {
    organization_id: orgId,
    connection_id: state.connectionId,
    candidate: { service: 'google', generation, envelope, target: { ...GOOGLE_OWN_ACCOUNT_TARGET }, public_config: {} },
    code: body.code as string,
    verifier: state.verifier,
    redirect_uri: state.redirectUri,
    // Ops stores nothing signed in as anyone else (Dan, 2026-10-23).
    expected_account: ownAccount,
  })
  // A consent as another account, said by ops, or by an ops deploy older than that rule naming another or none: refused alike.
  const wrongAccount = (answer: Awaited<ReturnType<typeof exchange>>) =>
    answer.ok ? answer.account !== ownAccount : answer.refused === 'exchange_account_mismatch'
  const recordAccount = async (account: string | null): Promise<string | null> => {
    if (account === null) return null
    const { error } = await requireRowsAffected(`service_connections ${state.connectionId} acts_as`, () => supabase
      .from('service_connections')
      .update({ acts_as: account, updated_by: userId, updated_by_email: email, updated_at: new Date().toISOString() })
      .eq('id', state.connectionId).eq('organization_id', orgId).eq('person_bound', true).eq('sealed_for', 'ops_key')
      .select('id'))
    if (error) {
      // The login is stored either way; only whom it names is not (or the row went meanwhile), and the next sign in records it.
      console.error(JSON.stringify({ event: 'google_sign_in_account_unrecorded', organization_id: orgId, connection_id: state.connectionId, error: formatErr(error) }))
      return null
    }
    return account
  }

  // 4. A Reconnect.
  if (state.reconnect) {
    const found = await signInRowFor(supabase, orgId, userId, state.connectionId)
    if (found.kind === 'refused') return found.code === 'connection_not_found' ? noSuchConnection(c) : signInRefuse(c, orgId, found.code)
    let envelope: unknown
    try {
      envelope = JSON.parse(found.row.credential_enc ?? '')
    } catch {
      envelope = null
    }
    if (!isRecordValue(envelope)) return signInRefuse(c, orgId, 'connection_store_failed')
    const answer = await exchange(found.row.credential_generation, envelope as unknown as SealedEnvelope)
    if (wrongAccount(answer)) {
      // An ops that already stored another account's login is a defect in it: named, so it is found.
      if (answer.ok) console.error(JSON.stringify({ event: 'google_sign_in_reconnect_other_account_stored', organization_id: orgId, connection_id: found.row.id }))
      return signInRefuse(c, orgId, 'google_sign_in_wrong_account')
    }
    if (!answer.ok) return signInRefuse(c, orgId, exchangeRefusal(answer), { detail: answer.detail })
    const actsAs = (await recordAccount(answer.account)) ?? found.row.acts_as
    await writeAuditLog(supabase, orgId, 'service_connection', found.row.id, 'connection_signed_in_again', userId, { generation: answer.generation })
    console.log(JSON.stringify({ event: 'google_sign_in_reconnected', organization_id: orgId, connection_id: found.row.id, cleared: answer.reauth_cleared }))
    return c.json({ outcome: 'reconnected', connection: { id: found.row.id, acts_as: actsAs }, cleared: answer.reauth_cleared })
  }

  // 3. A new connection: the row first, holding the app's client id alone.
  const named = connectionNameOf(state.name ?? '')
  if (!named.ok) return signInRefuse(c, orgId, named.code)
  const kid = CURRENT_OPS_KID
  let envelope: SealedEnvelope
  try {
    if (kid === null) throw new Error('no current ops kid is committed')
    envelope = await seal(OPS_CONNECTION_PUBLIC_KEYS, JSON.stringify({ client_id: state.clientId }), {
      organization_id: orgId, connection_id: state.connectionId, service: 'google', generation: 1, kid,
    })
  } catch (err) {
    console.error(JSON.stringify({ event: 'connection_seal_failed', organization_id: orgId, error: err instanceof SealError ? err.code : err instanceof Error ? err.name : 'error' }))
    return signInRefuse(c, orgId, 'connection_seal_failed')
  }
  const { error: insertError } = await supabase.from('service_connections').insert({
    id: state.connectionId,
    organization_id: orgId,
    service_type: 'google',
    name: named.name,
    auth_type: AUTH_TYPE_OF.oauth_user,
    sealed_for: 'ops_key',
    credential_enc: JSON.stringify(envelope),
    credential_generation: 1,
    target: { ...GOOGLE_OWN_ACCOUNT_TARGET },
    acts_as: null,
    person_bound: true,
    user_id: userId,
    cf_secret_key: null,
    updated_by: userId,
    updated_by_email: email,
  })
  if (insertError) {
    if (insertError.code === '23505') return signInRefuse(c, orgId, 'connection_name_taken')
    console.error(JSON.stringify({ event: 'google_sign_in_insert_failed', organization_id: orgId, connection_id: state.connectionId, error: formatErr(insertError) }))
    return signInRefuse(c, orgId, 'connection_store_failed')
  }

  const answer = await exchange(1, envelope)
  const wrong = wrongAccount(answer)
  if (!answer.ok || wrong) {
    // Nothing usable was stored, so the row that holds no login goes, on bidding and on ops.
    const { error: removeError } = await supabase.rpc('remove_ops_connection', { p_organization_id: orgId, p_connection_id: state.connectionId, p_actor: userId })
    if (removeError) {
      console.error(JSON.stringify({ event: 'google_sign_in_row_left', organization_id: orgId, connection_id: state.connectionId, error: formatErr(removeError), why: 'the exchange failed and the row it was for could not be removed' }))
    } else {
      // Every generation the exchange may have made: the one it answered, or the 2 a consent from generation 1 seals, whose answer may have been lost.
      const revoked = await callOpsConnections(c.env, 'revoke', { organization_id: orgId, connection_id: state.connectionId, generation: answer.ok ? answer.generation : 2, removed_at: new Date().toISOString() })
      if (!revoked.ok) console.error(JSON.stringify({ event: 'google_sign_in_revoke_failed', organization_id: orgId, connection_id: state.connectionId, refused: revoked.refused }))
    }
    if (wrong) return signInRefuse(c, orgId, 'google_sign_in_wrong_account')
    return signInRefuse(c, orgId, exchangeRefusal(answer as Exclude<typeof answer, { ok: true }>), { detail: (answer as { detail?: string }).detail })
  }
  const actsAs = await recordAccount(answer.account)
  console.log(JSON.stringify({ event: 'connection_created', organization_id: orgId, connection_id: state.connectionId, service: 'google', person_bound: true }))
  return c.json({ outcome: 'created', connection: { id: state.connectionId, name: named.name, service: 'google', acts_as: actsAs } }, 201)
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
