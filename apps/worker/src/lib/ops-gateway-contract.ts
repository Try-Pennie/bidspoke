/**
 * What crosses the service binding between the two Workers for the ops minute
 * cron (#1949), in one place both sides import: the bidding Worker's OpsGateway
 * entrypoint (lib/ops-gateway-entrypoint.ts) and the ops tick (ops/tick.ts).
 *
 * Two things cross it:
 *  - the ops workflows' state, served by the bidding Worker (Dan's decision 4,
 *    2026-10-16, on #1949: the bidding Worker serves definitions to the ops
 *    Worker over the service binding, and the ops Worker keeps the last good
 *    copy). Only what a tick needs: each ops workflow's on or off state, its
 *    soft delete, its updated_at (the order key), its latest version and its
 *    trigger. A run's full definition at its version is #1950's to fetch;
 *  - the tick's report, which the bidding Worker stamps as the heartbeat and
 *    judges every minute, so the watchdog never depends on the Worker it
 *    watches (L71).
 *
 * Each side parses what it receives (L50): an RPC argument or answer is
 * whatever the other Worker's code put there, possibly an older release's.
 *
 * A third crosses it since #2335: a person bound connection's rotated login,
 * handed back by the ops ConnectionTokenObject to its one home by compare and
 * set (storeRotatedEnvelope, below).
 *
 * And two more since PR 6 of #2335 (plan: discussion #2329, part 2):
 *  - the ops connections, served by the bidding Worker (opsConnections), which
 *    the tick keeps as last good copies: each one's sealed envelope (ciphertext
 *    only), public config, declared target and serve_until, and the removals of
 *    the last 7 hours. Never a plaintext login: the bidding Worker cannot open an
 *    envelope, and a public config or target naming a login field is refused;
 *  - money's measured Salesforce run as identity for one organization
 *    (moneyIdentities), a non secret value ops verify compares a credential's
 *    measured identity against.
 */
import { KID_PATTERN } from '@bidspoke/connection-seal'

/** One ops workflow's state, as the bidding database holds it. */
export interface ServedOpsWorkflow {
  id: string
  organization_id: string
  is_active: boolean
  deleted_at: string | null
  /** workflows.updated_at: a trigger moves it on every update, so it orders copies. */
  updated_at: string
  /** The latest workflow_versions.version_number, or null for a workflow with none. */
  version_number: number | null
  /** definition.trigger, unvalidated. */
  trigger: unknown
}

export interface ServedOpsWorkflows {
  /** The bidding Worker's clock when it read the list. */
  served_at: string
  /** The list names every ops workflow, so one it omits is no longer an ops workflow. */
  complete: boolean
  workflows: ServedOpsWorkflow[]
}

/** The ops Worker's binding to the bidding Worker's OpsGateway entrypoint. */
export interface OpsGatewayBinding {
  opsWorkflows(): Promise<unknown>
  opsTickStarted(): Promise<unknown>
  opsTickCompleted(report: unknown): Promise<unknown>
  /** A StoreRotatedEnvelopeRequest in; a StoreRotatedEnvelopeAnswer out (#2335). */
  storeRotatedEnvelope(request: unknown): Promise<unknown>
  /** A ServedOpsConnections, for parseServedOpsConnections (#2335). */
  opsConnections(): Promise<unknown>
  /** One organization's ServedMoneyIdentities, for parseServedMoneyIdentities (#2335). */
  moneyIdentities(organizationId: string): Promise<unknown>
}

/**
 * How long a served connection copy may be used: Dan's decision 3 (2026-10-17,
 * discussion #2329). serve_until is served_at plus this, so a removal reaches
 * ops within 6 hours even while the bidding Worker is down (L625). The ops copy's
 * CHECK holds the same bound (connection_copies_serve_window).
 */
export const CONNECTION_SERVE_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * How long a removal is served: the life of an ops tombstone (expires_at is at
 * least removed_at plus 7 hours, connection_tombstones_ops_outlives_copies), the
 * serve window plus an hour, after which every copy served before the removal is
 * past its serve_until anyway.
 */
export const TOMBSTONE_SERVE_WINDOW_MS = 7 * 60 * 60 * 1000

/** The seal's envelope (packages/connection-seal): ciphertext and its key id, nothing else. */
export interface SealedEnvelopeShape {
  v: 1
  kid: string
  wrapped_key: string
  iv: string
  ct: string
}

/** One ops connection as the bidding Worker serves it: ciphertext and public config only. */
export interface ServedOpsConnection {
  /** service_connections.id. */
  id: string
  organization_id: string
  /** service_connections.service_type. */
  service: string
  /** credential_generation, which the envelope's AAD binds. */
  generation: number
  envelope: SealedEnvelopeShape
  public_config: Record<string, unknown>
  /** The declared host and account identity, or null for none. */
  target: Record<string, unknown> | null
  /** served_at plus CONNECTION_SERVE_WINDOW_MS. */
  serve_until: string
}

/** A removal of the last TOMBSTONE_SERVE_WINDOW_MS, at its highest generation. */
export interface ServedConnectionTombstone {
  connection_id: string
  organization_id: string
  generation: number
  removed_at: string
}

export interface ServedOpsConnections {
  /** The bidding Worker's clock when it read the list. */
  served_at: string
  /** The list names every ops connection, so one it omits is withdrawn on ops. */
  complete: boolean
  connections: ServedOpsConnection[]
  tombstones: ServedConnectionTombstone[]
}

/**
 * Money's Salesforce run as identity for one organization, as the bidding
 * Worker last measured it from money's own token (/services/oauth2/userinfo):
 * the Salesforce org id and the username. Non secret identifiers, never a login.
 */
export interface MoneySalesforceIdentity {
  sf_org_id: string
  username: string
  measured_at: string
}

export interface ServedMoneyIdentities {
  /** The organization asked about, and the only one answered. */
  organization_id: string
  served_at: string
  /** Null when there is no reading for that organization: unmeasured, never a pass. */
  salesforce: MoneySalesforceIdentity | null
}

/**
 * A person bound connection's rotated login, handed back to its one home by
 * the ops ConnectionTokenObject (#2335, PR 5 of phase 5 of #1689): a compare
 * and set of service_connections.credential_enc on the generation the object
 * last knew. The envelope is the seal's (packages/connection-seal), ciphertext
 * only; the bidding Worker cannot open it and does not try. `generation` is the
 * one its AAD binds, which the bidding Worker cannot read from it.
 */
export interface StoreRotatedEnvelopeRequest {
  organization_id: string
  connection_id: string
  expected_generation: number
  generation: number
  envelope: { v: 1; kid: string; wrapped_key: string; iv: string; ct: string }
}

/**
 * What store_rotated_envelope answered:
 *   stored          written now
 *   already_stored  the row already held this generation and envelope (a repeat
 *                   after a lost answer)
 *   moved           the row holds another generation, named with its envelope's
 *                   iv (null when it has none readable), so the object can tell
 *                   its own earlier write from a Reconnect: each seal draws a
 *                   fresh random iv
 *   not_found       no person bound ops row of that organization: removed
 */
export const STORE_ROTATED_ENVELOPE_OUTCOMES = ['stored', 'already_stored', 'moved', 'not_found'] as const
export type StoreRotatedEnvelopeOutcome = (typeof STORE_ROTATED_ENVELOPE_OUTCOMES)[number]

export interface StoreRotatedEnvelopeAnswer {
  outcome: StoreRotatedEnvelopeOutcome
  current_generation: number | null
  current_iv: string | null
}

/** The tick's own mode. Observe only (#1949): live claiming and dispatch come with run invocation (#1950). */
export const OPS_TICK_MODES = ['observe'] as const
export type OpsTickMode = (typeof OPS_TICK_MODES)[number]

export const OPS_TICK_OUTCOMES = ['ok', 'problems', 'not_configured'] as const
export type OpsTickOutcome = (typeof OPS_TICK_OUTCOMES)[number]

/** A secret's name, as Cloudflare and secret-lists.ts write it. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_NOT_CONFIGURED_SECRETS = 10

/** A report carries at most this many problems, each at most this long, so one bad tick cannot fill KV or a Slack post. */
export const MAX_REPORT_PROBLEMS = 20
export const MAX_PROBLEM_LENGTH = 400

export interface OpsTickReport {
  tick_id: string
  mode: OpsTickMode
  /** The cron's scheduledTime, which lands at :48 within a minute, never aligned (spike, #1946). */
  scheduled_time: string | null
  started_at: string
  finished_at: string
  /** The database clock the tick planned against, or null when it could not read it. */
  db_now: string | null
  outcome: OpsTickOutcome
  /** Each a sentence a person can act on. Empty when the outcome is ok. */
  problems: string[]
  /** What the tick did, as counts, for the logs. */
  counts: Record<string, number>
  /**
   * The secrets a not_configured tick found unset or unusable, by name (#2333),
   * so the page names each one's remedy. Empty on any other outcome. Null on a
   * report from an ops release before #2333, which named none: the only cause
   * such a release could report was the ops database.
   */
  not_configured_secrets: string[] | null
  /**
   * Whether the tick's started stamp through the gateway failed (#2410), so the
   * bidding Worker can hold a lone miss for one tick without reading the
   * sentence. True only with a problem reported. Null on a report from an ops
   * release before #2410, which pages on a missed stamp at once, as it did.
   */
  start_stamp_failed: boolean | null
}

export class OpsGatewayContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsGatewayContractError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Caps a problem list, saying how many were left out rather than dropping them silently. */
export function capProblems(problems: readonly string[]): string[] {
  const clipped = problems.map((p) => (p.length > MAX_PROBLEM_LENGTH ? `${p.slice(0, MAX_PROBLEM_LENGTH - 3)}...` : p))
  if (clipped.length <= MAX_REPORT_PROBLEMS) return clipped
  const shown = clipped.slice(0, MAX_REPORT_PROBLEMS - 1)
  return [...shown, `${clipped.length - shown.length} more problems were left out of this report; the ops Worker's logs have every one.`]
}

/**
 * The served list, with each row that is not a well formed ops workflow refused
 * by name rather than saved. Throws when the list itself is malformed.
 */
export function parseServedOpsWorkflows(raw: unknown): { list: ServedOpsWorkflows; refused: string[] } {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the workflow list with something other than an object')
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no served_at time')
  if (typeof raw.complete !== 'boolean') throw new OpsGatewayContractError('the bidding Worker\'s workflow list does not say whether it is complete')
  if (!Array.isArray(raw.workflows)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no workflows array')
  const workflows: ServedOpsWorkflow[] = []
  const refused: string[] = []
  raw.workflows.forEach((row: unknown, i: number) => {
    const id = isRecord(row) && typeof row.id === 'string' ? row.id : `row ${i}`
    if (
      !isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.organization_id !== 'string' || !UUID.test(row.organization_id) ||
      typeof row.is_active !== 'boolean' ||
      !(row.deleted_at === null || isTime(row.deleted_at)) ||
      !isTime(row.updated_at) ||
      !(row.version_number === null || (typeof row.version_number === 'number' && Number.isInteger(row.version_number) && row.version_number >= 1))
    ) {
      refused.push(`The bidding Worker served workflow ${id} in a shape the ops Worker does not read, so it was not saved.`)
      return
    }
    workflows.push({
      id: row.id,
      organization_id: row.organization_id,
      is_active: row.is_active,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      version_number: row.version_number,
      trigger: row.trigger ?? null,
    })
  })
  // A list with refused rows does not name every ops workflow it could read, so
  // it must not withdraw the ones it failed to describe.
  return { list: { served_at: raw.served_at, complete: raw.complete && refused.length === 0, workflows }, refused }
}

/** The tick's report as the bidding Worker received it. Throws on one it cannot read. */
export function parseOpsTickReport(raw: unknown): OpsTickReport {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the ops tick sent a report that is not an object')
  const { tick_id, mode, scheduled_time, started_at, finished_at, db_now, outcome, problems, counts, not_configured_secrets, start_stamp_failed } = raw
  if (typeof tick_id !== 'string' || tick_id === '' || tick_id.length > 200) throw new OpsGatewayContractError('the ops tick report has no tick id')
  if (!(OPS_TICK_MODES as readonly unknown[]).includes(mode)) throw new OpsGatewayContractError(`the ops tick report names a mode this Worker does not know: ${String(mode)}`)
  if (!(scheduled_time === null || isTime(scheduled_time))) throw new OpsGatewayContractError('the ops tick report has an unreadable scheduled time')
  if (!isTime(started_at) || !isTime(finished_at)) throw new OpsGatewayContractError('the ops tick report has an unreadable start or finish')
  if (!(db_now === null || isTime(db_now))) throw new OpsGatewayContractError('the ops tick report has an unreadable database clock')
  if (!(OPS_TICK_OUTCOMES as readonly unknown[]).includes(outcome)) throw new OpsGatewayContractError(`the ops tick report names an outcome this Worker does not know: ${String(outcome)}`)
  if (!Array.isArray(problems) || problems.some((p) => typeof p !== 'string')) throw new OpsGatewayContractError('the ops tick report\'s problems are not a list of sentences')
  if (outcome === 'ok' ? problems.length > 0 : problems.length === 0) throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} with ${problems.length} problems`)
  if (!isRecord(counts) || Object.values(counts).some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new OpsGatewayContractError('the ops tick report\'s counts are not numbers')
  // Absent on a report from a release before #2333, and null once the bidding
  // Worker has kept such a report and reads it back (recordOpsTickCompleted
  // stores what this returns): both mean no secret was named.
  let secrets: string[] | null = null
  if (not_configured_secrets !== undefined && not_configured_secrets !== null) {
    if (
      !Array.isArray(not_configured_secrets) || not_configured_secrets.length > MAX_NOT_CONFIGURED_SECRETS ||
      not_configured_secrets.some((n) => typeof n !== 'string' || !SECRET_NAME.test(n))
    ) throw new OpsGatewayContractError('the ops tick report\'s not configured secrets are not a list of secret names')
    // The names pick the page's remedy, so they must agree with the outcome.
    if (outcome === 'not_configured' ? not_configured_secrets.length === 0 : not_configured_secrets.length > 0) {
      throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} naming ${not_configured_secrets.length} unconfigured secrets`)
    }
    secrets = [...(not_configured_secrets as string[])]
  }
  // Absent before #2410, null once such a report is kept and read back.
  let stampFailed: boolean | null = null
  if (start_stamp_failed !== undefined && start_stamp_failed !== null) {
    if (typeof start_stamp_failed !== 'boolean') throw new OpsGatewayContractError('the ops tick report says neither that its start stamp failed nor that it did not')
    // A failed stamp is reported as a problem, so one with no problem is not a report to trust.
    if (start_stamp_failed && outcome === 'ok') throw new OpsGatewayContractError('the ops tick report says its start stamp failed and reports no problem')
    stampFailed = start_stamp_failed
  }
  return {
    tick_id,
    mode: mode as OpsTickMode,
    scheduled_time: scheduled_time,
    started_at,
    finished_at,
    db_now: db_now,
    outcome: outcome as OpsTickOutcome,
    problems: capProblems(problems as string[]),
    counts: counts as Record<string, number>,
    not_configured_secrets: secrets,
    start_stamp_failed: stampFailed,
  }
}

/** What the ops copy's CHECK holds an envelope to (connection_copies_envelope_shape). */
const MAX_ENVELOPE_BYTES = 65_536
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const ENVELOPE_FIELDS = ['ct', 'iv', 'kid', 'v', 'wrapped_key']
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/**
 * A storeRotatedEnvelope request as the bidding Worker receives it, refused by
 * name before anything reaches the database when it is not one. The envelope is
 * checked for the seal's shape only: this Worker holds no key that opens it.
 */
export function parseStoreRotatedEnvelopeRequest(raw: unknown): StoreRotatedEnvelopeRequest {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the rotated envelope request is not an object')
  const { organization_id, connection_id, expected_generation, generation, envelope } = raw
  if (typeof organization_id !== 'string' || !UUID.test(organization_id)) throw new OpsGatewayContractError('the rotated envelope request names no organization uuid')
  if (typeof connection_id !== 'string' || !UUID.test(connection_id)) throw new OpsGatewayContractError('the rotated envelope request names no connection uuid')
  if (!isWhole(expected_generation) || expected_generation < 1) throw new OpsGatewayContractError('the rotated envelope request\'s expected generation is not a whole number of at least 1')
  if (!isWhole(generation) || generation <= expected_generation) throw new OpsGatewayContractError('the rotated envelope request\'s generation is not above the expected one')
  return { organization_id, connection_id, expected_generation, generation, envelope: parseSealedEnvelope(envelope, 'the rotated envelope') }
}

/**
 * The seal's envelope and nothing else, as the ops copy's CHECK holds it
 * (connection_copies_envelope_shape), refused by name (`what`) otherwise. One
 * rule for every envelope that crosses the binding, either way. Each message
 * names a field, never a value.
 */
export function parseSealedEnvelope(envelope: unknown, what: string): SealedEnvelopeShape {
  if (!isRecord(envelope)) throw new OpsGatewayContractError(`${what} is not an object`)
  if (Object.keys(envelope).sort().join(',') !== ENVELOPE_FIELDS.join(',')) throw new OpsGatewayContractError(`${what} must have exactly the fields ${ENVELOPE_FIELDS.join(', ')}`)
  const { v, kid, wrapped_key, iv, ct } = envelope
  if (v !== 1) throw new OpsGatewayContractError(`${what} is not version 1`)
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) throw new OpsGatewayContractError(`${what}'s kid is not a kid`)
  for (const [name, value] of [['wrapped_key', wrapped_key], ['iv', iv], ['ct', ct]] as const) {
    if (typeof value !== 'string' || !BASE64.test(value)) throw new OpsGatewayContractError(`${what}'s ${name} is not base64`)
  }
  const shaped = { v: 1 as const, kid, wrapped_key: wrapped_key as string, iv: iv as string, ct: ct as string }
  // Measured as the database measures it: jsonb renders a space after each colon and each comma.
  const jsonbBytes = new TextEncoder().encode(JSON.stringify(shaped)).length + ENVELOPE_FIELDS.length * 2 - 1
  if (jsonbBytes > MAX_ENVELOPE_BYTES) throw new OpsGatewayContractError(`${what} is over ${MAX_ENVELOPE_BYTES} bytes`)
  return shaped
}

/** store_rotated_envelope's answer as the ops Worker receives it. Throws on one it cannot read. */
export function parseStoreRotatedEnvelopeAnswer(raw: unknown): StoreRotatedEnvelopeAnswer {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with something other than an object')
  const { outcome, current_generation, current_iv } = raw
  if (!(STORE_ROTATED_ENVELOPE_OUTCOMES as readonly unknown[]).includes(outcome)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the rotated envelope with an outcome this Worker does not know: ${String(outcome)}`)
  }
  if (!(current_generation === null || (isWhole(current_generation) && current_generation >= 1))) {
    throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with an unreadable generation')
  }
  if (!(current_iv === null || typeof current_iv === 'string')) throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with an unreadable iv')
  // A row was found exactly when a generation is named.
  if ((outcome === 'not_found') !== (current_generation === null)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the rotated envelope ${String(outcome)} with${current_generation === null ? ' no' : ''} generation`)
  }
  return { outcome: outcome as StoreRotatedEnvelopeOutcome, current_generation, current_iv }
}

/** What the ops copy's CHECKs hold public config and a target to (connection_copies_public_config_shape, _target_shape). */
const MAX_CONFIG_BYTES = 16_384
const SERVICE_KEY = /^[a-z][a-z0-9_]{0,63}$/
/**
 * A field name that holds a login rather than describing one. Public config and
 * a target are served in the clear, so a row naming one of these is refused
 * rather than carried to ops: the login belongs only inside the sealed envelope.
 */
const LOGIN_FIELD = /secret|passw|private_?key|api_?key|access_?token|refresh_?token|bot_?token|^token$|bearer/i
const MAX_DEPTH = 10

/** A safe name for a row in a sentence: its id when it is a plain id, otherwise its position. */
function rowName(value: unknown, index: number): string {
  return typeof value === 'string' && value.length <= 64 && /^[\w-]+$/.test(value) ? value : `row ${index}`
}

/**
 * At least as many bytes as jsonb renders the value in: jsonb puts a space after
 * each colon and each comma, so every one in the JSON is counted twice, those
 * inside strings too. An overcount only refuses earlier than the CHECK would.
 */
function jsonbBytesAtMost(value: unknown): number {
  const json = JSON.stringify(value)
  let extra = 0
  for (const ch of json) if (ch === ':' || ch === ',') extra++
  return new TextEncoder().encode(json).length + extra
}

/** The first field naming a login, by its name (never its value). */
function loginField(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return 'a field nested too deep to check'
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = loginField(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, inner] of Object.entries(value)) {
    if (LOGIN_FIELD.test(key)) return /^[\w.-]{1,64}$/.test(key) ? key : 'a field'
    const found = loginField(inner, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Why public config or a target cannot be served in the clear, or null when it
 * can. Also holds a candidate passed to OpsConnections (ops-connections-contract.ts)
 * to the same rule, so both ways in carry one.
 */
export function clearFieldProblem(value: unknown, what: 'public config' | 'a target'): string | null {
  const found = loginField(value)
  if (found) return `${what} naming the login field ${found}`
  if (jsonbBytesAtMost(value) > MAX_CONFIG_BYTES) return `${what} over ${MAX_CONFIG_BYTES} bytes`
  return null
}

/**
 * Why one served connection cannot be saved on ops, or null when it can. Each
 * reason names a field, never a value. The bidding Worker runs every row it
 * serves through this too (lib/ops-gateway.ts), so the two sides hold one rule.
 */
export function servedConnectionProblem(row: unknown, servedAt: string): string | null {
  if (!isRecord(row)) return 'a row that is not an object'
  if (typeof row.id !== 'string' || !UUID.test(row.id)) return 'an id that is not a uuid'
  if (typeof row.organization_id !== 'string' || !UUID.test(row.organization_id)) return 'an organization that is not a uuid'
  if (typeof row.service !== 'string' || !SERVICE_KEY.test(row.service)) return 'a service that is not a service key'
  if (!isWhole(row.generation) || row.generation < 1) return 'a generation that is not a whole number of at least 1'
  try {
    parseSealedEnvelope(row.envelope, 'the envelope')
  } catch (err) {
    return `an envelope that is not the seal's (${(err as Error).message})`
  }
  if (!isRecord(row.public_config)) return 'public config that is not an object'
  const config = clearFieldProblem(row.public_config, 'public config')
  if (config) return config
  if (row.target !== null) {
    if (!isRecord(row.target)) return 'a target that is neither an object nor null'
    const target = clearFieldProblem(row.target, 'a target')
    if (target) return target
  }
  if (!isTime(row.serve_until)) return 'a serve_until that is not a time'
  const until = Date.parse(row.serve_until)
  const served = Date.parse(servedAt)
  if (until <= served || until - served > CONNECTION_SERVE_WINDOW_MS) return 'a serve_until more than 6 hours after it was served, or not after it'
  return null
}

function servedTombstoneProblem(row: unknown): string | null {
  if (!isRecord(row)) return 'a row that is not an object'
  if (typeof row.connection_id !== 'string' || !UUID.test(row.connection_id)) return 'a connection that is not a uuid'
  if (typeof row.organization_id !== 'string' || !UUID.test(row.organization_id)) return 'an organization that is not a uuid'
  if (!isWhole(row.generation) || row.generation < 1) return 'a generation that is not a whole number of at least 1'
  if (!isTime(row.removed_at)) return 'a removal time that is not a time'
  return null
}

/**
 * The served connections, with each row that cannot be saved on ops refused by
 * name rather than saved. Throws when the list itself is malformed. A list with
 * a refused connection is not complete, so it withdraws nothing on ops. A
 * refused removal leaves the list complete: the removed connection is not in the
 * list either, so the complete list still withdraws its copy.
 */
export function parseServedOpsConnections(raw: unknown): { list: ServedOpsConnections; refused: string[] } {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the connection list with something other than an object')
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no served_at time')
  if (typeof raw.complete !== 'boolean') throw new OpsGatewayContractError('the bidding Worker\'s connection list does not say whether it is complete')
  if (!Array.isArray(raw.connections)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no connections array')
  if (!Array.isArray(raw.tombstones)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no removals array')
  const servedAt = raw.served_at
  const refused: string[] = []
  const connections: ServedOpsConnection[] = []
  raw.connections.forEach((row: unknown, i: number) => {
    const problem = servedConnectionProblem(row, servedAt)
    if (problem !== null) {
      refused.push(`The bidding Worker served connection ${rowName(isRecord(row) ? row.id : null, i)} with ${problem}, so it was not saved.`)
      return
    }
    const r = row as Record<string, unknown>
    connections.push({
      id: r.id as string,
      organization_id: r.organization_id as string,
      service: r.service as string,
      generation: r.generation as number,
      envelope: parseSealedEnvelope(r.envelope, 'the envelope'),
      public_config: r.public_config as Record<string, unknown>,
      target: r.target as Record<string, unknown> | null,
      serve_until: r.serve_until as string,
    })
  })
  const refusedConnections = refused.length
  const tombstones: ServedConnectionTombstone[] = []
  raw.tombstones.forEach((row: unknown, i: number) => {
    const problem = servedTombstoneProblem(row)
    if (problem !== null) {
      refused.push(`The bidding Worker served the removal of ${rowName(isRecord(row) ? row.connection_id : null, i)} with ${problem}, so it was not recorded.`)
      return
    }
    const r = row as Record<string, unknown>
    tombstones.push({ connection_id: r.connection_id as string, organization_id: r.organization_id as string, generation: r.generation as number, removed_at: r.removed_at as string })
  })
  return { list: { served_at: servedAt, complete: raw.complete && refusedConnections === 0, connections, tombstones }, refused }
}

/** A Salesforce org id: 00D and 12 more, or 15 more in its 18 character form. */
const SF_ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/
const MAX_USERNAME = 320

/** One stored or served reading, refused by name when it is not one. */
export function parseMoneySalesforceIdentity(raw: unknown, what: string): MoneySalesforceIdentity {
  if (!isRecord(raw)) throw new OpsGatewayContractError(`${what} is not an object`)
  const { sf_org_id, username, measured_at } = raw
  if (typeof sf_org_id !== 'string' || !SF_ORG_ID.test(sf_org_id)) throw new OpsGatewayContractError(`${what} has no Salesforce org id`)
  if (typeof username !== 'string' || username.trim() === '' || username.length > MAX_USERNAME) throw new OpsGatewayContractError(`${what} has no username`)
  if (!isTime(measured_at)) throw new OpsGatewayContractError(`${what} has no measurement time`)
  return { sf_org_id, username, measured_at }
}

/**
 * The money identities the bidding Worker answered for one organization, as
 * the ops Worker receives them. Refuses an answer for any organization but the
 * one asked about, so another organization's reading can never be read as this
 * one's. A null salesforce is unmeasured, which verify refuses by name
 * (money_identity_unmeasured), never a pass.
 */
export function parseServedMoneyIdentities(raw: unknown, organizationId: string): ServedMoneyIdentities {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the money identities with something other than an object')
  if (typeof raw.organization_id !== 'string' || raw.organization_id.toLowerCase() !== organizationId.toLowerCase()) {
    throw new OpsGatewayContractError('the bidding Worker answered the money identities for another organization than the one asked about')
  }
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s money identities have no served_at time')
  const salesforce = raw.salesforce === null ? null : parseMoneySalesforceIdentity(raw.salesforce, 'the money Salesforce identity')
  return { organization_id: raw.organization_id, served_at: raw.served_at, salesforce }
}
