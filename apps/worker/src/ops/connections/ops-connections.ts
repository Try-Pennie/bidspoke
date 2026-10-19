/**
 * What the OpsConnections entrypoint does (#2335, PR 8 of phase 5 of #1689;
 * plan: discussion #2329, part 2; findings F116 and F126). The entrypoint
 * (../ops-connections-entrypoint.ts) parses each request (lib/ops-connections-contract.ts),
 * holds it to the method's ceiling, and calls one of these with the live
 * dependencies (../ops-connections-live.ts); tests call them with doubles.
 *
 * WHO CALLS THEM. Only the entrypoint, so only a Worker holding a service binding
 * to it: the bidding Worker, through OPS_CONNECTIONS (PR 9). WHOSE DATA. Each
 * call names one OrganizationId and touches only that organization's
 * connections: copies through connection_copy (which refuses another
 * organization's row), envelopes that open only under that organization (the
 * AAD), and organization scoped ops functions for every write.
 *
 * THE METHODS.
 *  verify       measures what the credential authenticates as through
 *               connectionFetch (never only the declaration), refuses money's
 *               Salesforce run as user, and records the measurement under the
 *               generation the request carried (record_measured_identity). With a
 *               candidate (a credential bidding has not committed) it uses that
 *               envelope for this one call and WRITES NO COPY (F116, F126): the
 *               committed copy arrives only by a serve of the committed row.
 *  clearReauth  Reconnect: verify of the candidate, and only when it passes,
 *               record_connection_reauth_cleared, the one writer of that column.
 *               It writes no copy either. The bidding Worker calls it AFTER its
 *               compare and set on the row has committed the candidate's
 *               generation (F116's fix (a)): verify the candidate, commit, then
 *               clearReauth. A clearing whose commit is then lost clears the flag
 *               of a connection whose committed copy, if still bad, is flagged
 *               again by its next refused use; it never makes ops use the
 *               uncommitted credential.
 *  revoke       record_connection_tombstone at once.
 *  health       connection_status for the organization.
 *  lookup       one level of a connection's schema (lib/schema-sync/lookup.ts),
 *               behind the per organization cap (take_lookup_allowance), every
 *               request through connectionFetch.
 *  exchangeOAuthCode  a person bound login's consent, handed to the connection's
 *               ConnectionTokenObject (minters/oauth-user.ts).
 *
 * Every answer is a value; a refusal's detail is built from names only (F120),
 * and nothing here writes to the console (the connection-seal-open-callers guard).
 */
import { parseServedMoneyIdentities, type MoneySalesforceIdentity } from '../../lib/ops-gateway-contract'
import {
  HEALTH_LIMIT, LOOKUP_RATE_PER_MINUTE, type ClearReauthAnswer, type ClearReauthRequest, type ExchangeOAuthCodeAnswer, type ExchangeOAuthCodeRequest,
  type HealthAnswer, type HealthRequest, type LookupAnswer, type LookupRequest, type MeasuredIdentityAnswer, type OpsConnectionsRefusalCode,
  type OpsConnectionsRefused, type RevokeAnswer, type RevokeRequest, type SealedCandidate, type VerifyAnswer, type VerifyRequest,
} from '../../lib/ops-connections-contract'
import { SchemaLookupError } from '../../lib/schema-sync/errors'
import { lookupSchema } from '../../lib/schema-sync/lookup'
import type { SalesforceSource, SnowflakeSource, SupabaseSource } from '../../lib/schema-sync/types'
import { organizationIdFrom, type OrganizationId } from '../ops-db'
import type { ConnectionCopy, ConnectionHealthStatus, LookupAllowance, MeasuredIdentityOutcome } from '../ops-writes'
import { connectionFetch, type CandidateConnection, type ConnectionCall, type ConnectionFetchDeps, type ConnectionSource } from './connection-fetch'
import { IdentityUnreadable, isMoneySalesforceIdentity, type BoundFetch, type IdentityProbe, type MeasuredIdentity } from './identity'
import { exchangeOAuthCode, type OAuthUserService, type TokenObjects } from './minters/oauth-user'
import { ConnectionRefusal, RequeueAt } from './refusals'
import type { ServiceRules } from './service-rules'

/**
 * How old money's Salesforce identity reading may be before verify treats it as
 * unmeasured (money_identity_unmeasured) rather than as a measurement. The
 * reading is taken once a day in the 13:00 UTC batch (money-identity in
 * CRON_JOBS, lib/money-identity.ts), so a healthy one is under 24 hours old.
 * The bound allows one missed run (48 hours) and two hours for a late batch:
 * a reading older than that means the daily job has failed at least twice, which
 * pages (export alerter), and verify then refuses until it is measured again.
 */
export const MONEY_IDENTITY_MAX_AGE_MS = 50 * 60 * 60 * 1000
/** A reading this far in the future is no measurement: some clock is wrong. */
export const MONEY_IDENTITY_FUTURE_SKEW_MS = 5 * 60 * 1000

type WithoutRequest<T> = T extends unknown ? Omit<T, 'fetch' | 'auth'> : never
/** Where a schema lookup sends, from the connection's declared target: the lookup source without its fetch and auth. */
export type SchemaTarget = WithoutRequest<SalesforceSource> | WithoutRequest<SupabaseSource> | WithoutRequest<SnowflakeSource>

/** One service as OpsConnections uses it. The registry (services.ts) holds one per service the ops Worker serves. */
export interface OpsServiceEntry {
  /** What connectionFetch needs: hosts, expiry, auth, and for Salesforce the pool. */
  readonly rules: ServiceRules
  /** What verify measures the credential as. Absent: verify refuses by name. */
  readonly identity?: IdentityProbe
  /** Where a lookup sends. Absent: the service answers no lookups. */
  readonly schema?: (target: unknown, publicConfig: unknown) => SchemaTarget
  /** A person bound (OAuth user) service: its token endpoint. A candidate of one is proven by its code exchange, never verify. */
  readonly oauthUser?: OAuthUserService
}

export interface OpsConnectionsDeps {
  /** connectionFetch's dependencies but its rules, which come from `services`, so there is one registry. */
  connection: Omit<ConnectionFetchDeps, 'rulesFor'>
  services(service: string): OpsServiceEntry | undefined
  /** The bidding Worker's OpsGateway.moneyIdentities, raw: parsed here. */
  moneyIdentities(organizationId: OrganizationId): Promise<unknown>
  recordMeasuredIdentity(organizationId: OrganizationId, connectionId: string, generation: number, identity: { sfOrgId: string; username: string }): Promise<MeasuredIdentityOutcome>
  recordReauthCleared(organizationId: OrganizationId, connectionId: string): Promise<'recorded' | 'connection_removed'>
  recordTombstone(organizationId: OrganizationId, connectionId: string, generation: number, removedAt: Date): Promise<{ outcome: 'recorded' | 'already_recorded'; copiesRemoved: number }>
  readStatus(organizationId: OrganizationId, limit: number): Promise<{ connections: ConnectionHealthStatus[]; reachedLimit: boolean }>
  takeLookupAllowance(organizationId: OrganizationId, perMinute: number): Promise<LookupAllowance>
  tokens: TokenObjects
  now(): number
}

const COPY_STATE_REFUSALS: Readonly<Record<Exclude<ConnectionCopy['state'], 'usable'>, OpsConnectionsRefusalCode>> = {
  connection_removed: 'connection_removed',
  connection_withdrawn: 'connection_withdrawn',
  connection_copy_expired: 'connection_copy_expired',
  not_found: 'connection_not_found',
}

function refuse(code: OpsConnectionsRefusalCode, detail: string, retryAt: Date | string | null = null): OpsConnectionsRefused {
  return { ok: false, refused: code, detail, retry_at: retryAt === null ? null : typeof retryAt === 'string' ? retryAt : retryAt.toISOString() }
}

/** A connectionFetch refusal, by its own code; for verify, a minter's reason that names what verify checks becomes verify's own. */
function fromRefusal(err: ConnectionRefusal, verifying: boolean): OpsConnectionsRefused {
  if (verifying && err.mintReason === 'client_id_mismatch') {
    return refuse('verify_client_id_mismatch', 'the sealed Salesforce client id is not the one the target declares', err.retryAt)
  }
  if (err.mintReason === 'candidate_not_refreshable') {
    return refuse('candidate_not_refreshable', 'a person bound login is proven by its code exchange, not by verify', err.retryAt)
  }
  // The refusal's message is built from names and scrubbed of every known secret (connection-fetch.ts, F120).
  return refuse(err.code, err.message, err.retryAt)
}

/** An error this code did not expect, by its kind only: its message could carry anything. */
function unexpected(err: unknown, what: string): OpsConnectionsRefused {
  return refuse('ops_connections_failed', `${what} failed with an unexpected ${err instanceof Error ? err.name : 'error'}`)
}

function organizationOf(organizationId: string): OrganizationId | OpsConnectionsRefused {
  try {
    return organizationIdFrom(organizationId)
  } catch {
    return refuse('ops_connections_request_invalid', 'the organization is not a uuid')
  }
}

const isRefused = (v: unknown): v is OpsConnectionsRefused => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false

function fetchDepsOf(deps: OpsConnectionsDeps): ConnectionFetchDeps {
  return { ...deps.connection, rulesFor: (service) => deps.services(service)?.rules }
}

function candidateOf(c: SealedCandidate): CandidateConnection {
  return { service: c.service, generation: c.generation, envelope: c.envelope, target: c.target, publicConfig: c.public_config }
}

/**
 * connectionFetch for a caller that cannot wait: a response, or a
 * ConnectionRefusal thrown by name. A RequeueAt (a 429, a Retry-After) becomes
 * connection_rate_limited at its time. Every OpsConnections request to a service
 * goes through this, and so through connectionFetch (the guard
 * ops-connection-requests-through-fetch.test.ts).
 */
export function boundFetch(deps: ConnectionFetchDeps, call: ConnectionCall, seen?: { refusal: ConnectionRefusal | null }): BoundFetch {
  return async (url, init) => {
    try {
      const answer = await connectionFetch(deps, call, url, init)
      if (answer instanceof RequeueAt) {
        throw new ConnectionRefusal('connection_rate_limited', `the service asked to wait until ${answer.notBefore.toISOString()}`, answer.notBefore)
      }
      return answer
    } catch (err) {
      if (seen && err instanceof ConnectionRefusal) seen.refusal = err
      throw err
    }
  }
}

/** The connection as verify or a lookup sees it before its call: the candidate, or the copy ops holds. */
async function subjectOf(
  deps: OpsConnectionsDeps, organizationId: OrganizationId, connectionId: string, candidate: SealedCandidate | null,
): Promise<{ service: string; target: unknown; publicConfig: unknown; source: ConnectionSource } | OpsConnectionsRefused> {
  if (candidate !== null) return { service: candidate.service, target: candidate.target, publicConfig: candidate.public_config, source: { kind: 'candidate', candidate: candidateOf(candidate) } }
  let copy: ConnectionCopy
  try {
    copy = await deps.connection.readCopy(organizationId, connectionId)
  } catch {
    return refuse('connection_copy_unreadable', 'the ops database did not answer the copy read')
  }
  if (copy.state !== 'usable') return refuse(COPY_STATE_REFUSALS[copy.state], `the copy is ${copy.state}`)
  if (copy.service === null) return refuse('connection_copy_unreadable', 'a usable copy came back without its service')
  return { service: copy.service, target: copy.target, publicConfig: copy.publicConfig, source: { kind: 'copy' } }
}

/** Money's Salesforce identity for this organization, as a measurement verify may rely on, or a refusal by name. */
async function moneySalesforceIdentity(deps: OpsConnectionsDeps, organizationId: OrganizationId): Promise<MoneySalesforceIdentity | OpsConnectionsRefused> {
  let salesforce: MoneySalesforceIdentity | null
  try {
    salesforce = parseServedMoneyIdentities(await deps.moneyIdentities(organizationId), organizationId).salesforce
  } catch {
    // A binding's error names no cause, and a parse error names a field: neither is forwarded.
    return refuse('money_identity_unavailable', 'the bidding Worker did not answer money\'s Salesforce identity readably, so no Salesforce connection is verified')
  }
  if (salesforce === null) return refuse('money_identity_unmeasured', 'money\'s Salesforce identity has not been measured, so no Salesforce connection is verified')
  const age = deps.now() - Date.parse(salesforce.measured_at)
  if (age > MONEY_IDENTITY_MAX_AGE_MS) {
    return refuse('money_identity_unmeasured', `money's Salesforce identity was last measured more than ${MONEY_IDENTITY_MAX_AGE_MS / 3_600_000} hours ago, so it is not relied on`)
  }
  if (age < -MONEY_IDENTITY_FUTURE_SKEW_MS) return refuse('money_identity_unmeasured', 'money\'s Salesforce identity reading is dated in the future, so it is not relied on')
  return salesforce
}

function identityAnswer(identity: MeasuredIdentity): MeasuredIdentityAnswer {
  return { kind: identity.kind, sf_org_id: identity.sfOrgId, username: identity.username }
}

type Verified = { ok: true; service: string; generation: number; identity: MeasuredIdentityAnswer }

async function verifyIdentity(
  deps: OpsConnectionsDeps, organizationId: OrganizationId, connectionId: string, candidate: SealedCandidate | null, signal: AbortSignal | undefined,
): Promise<Verified | OpsConnectionsRefused> {
  const subject = await subjectOf(deps, organizationId, connectionId, candidate)
  if (isRefused(subject)) return subject
  const entry = deps.services(subject.service)
  if (entry === undefined) return refuse('connection_service_unknown', `no rules for the ${subject.service} service on this Worker`)
  if (candidate !== null && entry.oauthUser !== undefined) {
    return refuse('candidate_not_refreshable', 'a person bound login is proven by its code exchange, not by verify')
  }
  const probe = entry.identity
  if (probe === undefined) return refuse('verify_identity_unmeasurable', `the ${subject.service} service has no identity measurement yet, so it is not verified`)

  // Money's identity first: with none to compare against, nothing is asked of Salesforce.
  const money = probe.kind === 'salesforce' ? await moneySalesforceIdentity(deps, organizationId) : null
  if (isRefused(money)) return money

  let used: { service: string; generation: number } | null = null
  const call: ConnectionCall = {
    organizationId, connectionId, source: subject.source, purpose: 'verify', signal,
    record: { recordsNothing: 'verify reads what the credential authenticates as; it is no step, so there is no send ledger to record it in' },
    onResolved: (resolved) => { used = resolved },
  }
  let identity: MeasuredIdentity
  try {
    identity = await probe.measure(boundFetch(fetchDepsOf(deps), call), subject.target, subject.publicConfig)
  } catch (err) {
    if (err instanceof ConnectionRefusal) return fromRefusal(err, true)
    if (err instanceof IdentityUnreadable) return refuse('verify_identity_unreadable', err.message)
    return unexpected(err, 'the identity measurement')
  }
  // connectionFetch resolved the subject before any request, so a measured identity always has one.
  const resolved = used as { service: string; generation: number } | null
  if (resolved === null) return refuse('ops_connections_failed', 'the identity was measured without a request through connectionFetch')

  if (money !== null && isMoneySalesforceIdentity(identity, money)) {
    return refuse('money_identity_match', 'the credential authenticates as money\'s Salesforce run as user, which an ops connection may never act as')
  }
  let outcome: MeasuredIdentityOutcome
  try {
    outcome = await deps.recordMeasuredIdentity(organizationId, connectionId, resolved.generation, { sfOrgId: identity.sfOrgId, username: identity.username })
  } catch {
    return refuse('measured_identity_unrecorded', 'the measured identity could not be written, so the connection is not verified')
  }
  if (outcome === 'identity_changed') {
    return refuse('identity_changed', `generation ${resolved.generation}, which ops holds, measured another identity than before; a person must look before it is used`)
  }
  if (outcome === 'connection_removed') return refuse('connection_removed', 'the connection is removed')
  return { ok: true, service: resolved.service, generation: resolved.generation, identity: identityAnswer(identity) }
}

export async function verifyConnection(deps: OpsConnectionsDeps, request: VerifyRequest, signal?: AbortSignal): Promise<VerifyAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  try {
    return await verifyIdentity(deps, organizationId, request.connection_id, request.candidate, signal)
  } catch (err) {
    return unexpected(err, 'verify')
  }
}

export async function clearReauth(deps: OpsConnectionsDeps, request: ClearReauthRequest, signal?: AbortSignal): Promise<ClearReauthAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  try {
    const verified = await verifyIdentity(deps, organizationId, request.connection_id, request.candidate, signal)
    if (!verified.ok) return verified
    // A caller that gave up is answered by name, and nothing is cleared it will never hear of.
    if (signal?.aborted) return refuse('connection_aborted', 'the caller gave up before the clearing was written')
    let outcome: 'recorded' | 'connection_removed'
    try {
      outcome = await deps.recordReauthCleared(organizationId, request.connection_id)
    } catch {
      return refuse('reauth_clear_unrecorded', 'the Reconnect passed verify and its clearing could not be written')
    }
    if (outcome === 'connection_removed') return refuse('connection_removed', 'the connection is removed')
    return { ...verified, cleared: true }
  } catch (err) {
    return unexpected(err, 'clearReauth')
  }
}

export async function revokeConnection(deps: OpsConnectionsDeps, request: RevokeRequest): Promise<RevokeAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  try {
    const r = await deps.recordTombstone(organizationId, request.connection_id, request.generation, new Date(request.removed_at))
    return { ok: true, outcome: r.outcome, copies_removed: r.copiesRemoved }
  } catch {
    return refuse('revoke_unrecorded', 'the ops tombstone could not be written; the next serve carries the removal')
  }
}

export async function connectionHealth(deps: OpsConnectionsDeps, request: HealthRequest): Promise<HealthAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  let read: { connections: ConnectionHealthStatus[]; reachedLimit: boolean }
  try {
    read = await deps.readStatus(organizationId, HEALTH_LIMIT)
  } catch {
    return refuse('health_unavailable', 'the ops database did not answer the connection statuses')
  }
  return {
    ok: true,
    reached_limit: read.reachedLimit,
    connections: read.connections.map((c) => ({
      connection_id: c.connectionId,
      service: c.service,
      generation: c.generation,
      status: c.status,
      last_check_ok_at: c.lastCheckOkAt,
      last_check_failed_at: c.lastCheckFailedAt,
      last_check_cause: c.lastCheckCause,
      needs_reauth_at: c.needsReauthAt,
      needs_reauth_cause: c.needsReauthCause,
      reauth_cleared_at: c.reauthClearedAt,
    })),
  }
}

export async function lookupConnection(deps: OpsConnectionsDeps, request: LookupRequest, signal?: AbortSignal): Promise<LookupAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  try {
    let allowance: LookupAllowance
    try {
      allowance = await deps.takeLookupAllowance(organizationId, LOOKUP_RATE_PER_MINUTE)
    } catch {
      return refuse('lookup_allowance_unavailable', 'the lookup allowance could not be read, so nothing was sent')
    }
    if (allowance.outcome === 'rate_limited') {
      return refuse('lookup_rate_limited', `the organization has taken its ${LOOKUP_RATE_PER_MINUTE} lookups a minute`, allowance.retryAt)
    }

    const subject = await subjectOf(deps, organizationId, request.connection_id, null)
    if (isRefused(subject)) return subject
    const entry = deps.services(subject.service)
    if (entry === undefined) return refuse('connection_service_unknown', `no rules for the ${subject.service} service on this Worker`)
    if (entry.schema === undefined) return refuse('lookup_not_supported', `the ${subject.service} service answers no lookups`)
    let target: SchemaTarget
    try {
      target = entry.schema(subject.target, subject.publicConfig)
    } catch {
      return refuse('connection_target_invalid', `the ${subject.service} connection's target does not say where its lookups go`)
    }

    const seen: { refusal: ConnectionRefusal | null } = { refusal: null }
    const call: ConnectionCall = {
      organizationId, connectionId: request.connection_id, source: { kind: 'copy' }, purpose: 'lookup', signal,
      record: { recordsNothing: 'a lookup reads the service\'s own schema to fill a dropdown; it is no step, so there is no send ledger to record it in' },
    }
    try {
      return { ok: true, answer: await lookupSchema({ ...target, fetch: boundFetch(fetchDepsOf(deps), call, seen), auth: {} }, request.key, request.parents) }
    } catch (err) {
      // A refusal connectionFetch made keeps its own code and time; the lookup's own error names the step.
      if (seen.refusal !== null) return fromRefusal(seen.refusal, false)
      if (err instanceof SchemaLookupError) return refuse(err.code, err.message)
      return unexpected(err, 'the lookup')
    }
  } catch (err) {
    return unexpected(err, 'lookup')
  }
}

export async function exchangeConnectionCode(deps: OpsConnectionsDeps, request: ExchangeOAuthCodeRequest): Promise<ExchangeOAuthCodeAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  const oauthUser = deps.services(request.candidate.service)?.oauthUser
  if (oauthUser === undefined) return refuse('connection_service_unknown', `the ${request.candidate.service} service has no person bound login on this Worker`)
  try {
    const { generation } = await exchangeOAuthCode({ tokens: deps.tokens, readCopy: deps.connection.readCopy }, oauthUser, {
      organizationId, connectionId: request.connection_id, candidate: candidateOf(request.candidate), code: request.code, verifier: request.verifier, redirectUri: request.redirect_uri,
    })
    return { ok: true, generation }
  } catch (err) {
    if (err instanceof ConnectionRefusal) return fromRefusal(err, false)
    return unexpected(err, 'the code exchange')
  }
}
