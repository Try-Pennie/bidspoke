/**
 * What crosses the service binding into the ops Worker's OpsConnections
 * entrypoint (#2335, PR 8 of phase 5 of #1689; plan: discussion #2329, part 2),
 * in one place both sides import: the entrypoint (ops/ops-connections-entrypoint.ts)
 * parses each request here before anything is read or opened (L50), and the
 * bidding Worker's OPS_CONNECTIONS binding (PR 9) builds them from the same
 * types and reads the answers.
 *
 * WHO MAY CALL. Only a Worker holding a service binding to the named
 * entrypoint OpsConnections of bidspoke-worker-ops: the bidding Worker, through
 * the OPS_CONNECTIONS binding PR 9 adds. Cloudflare routes a public request only
 * to a Worker's default export, so no public request reaches it.
 *
 * WHOSE DATA. Every request names one organization (the bidding Worker derives
 * it from the caller's JWT), and every method acts on that organization's
 * connections alone: a copy is read through connection_copy, which refuses
 * another organization's row; an envelope opens only under the organization its
 * AAD names; every write is an organization scoped ops function.
 *
 * Every answer is a value, a refusal included ({ ok: false, refused, detail,
 * retry_at }): a rejection crossing an RPC call surfaces in workerd as an
 * uncaught error on the callee's side too (internal.ts). A refusal's detail is
 * built from names alone, never a login, a token or what a provider said
 * (finding F120).
 *
 * A credential crosses only sealed: a candidate is the bidding row's envelope
 * (ciphertext), its generation, service, target and public config, held to the
 * same rule as the served copies (ops-gateway-contract.ts: the seal's envelope
 * shape, and no public field naming a login).
 */
import type { ConnectionRefusalCode } from '../ops/connections/refusals'
import type { SchemaLookupCode } from './schema-sync/errors'
import type { SchemaLookupAnswer } from './schema-sync/lookup'
import { clearFieldProblem, OpsGatewayContractError, parseSealedEnvelope, type SealedEnvelopeShape } from './ops-gateway-contract'

export const OPS_CONNECTIONS_METHODS = ['verify', 'clearReauth', 'revoke', 'health', 'lookup', 'exchangeOAuthCode'] as const
export type OpsConnectionsMethod = (typeof OPS_CONNECTIONS_METHODS)[number]

/**
 * How long the entrypoint lets each method run before it answers
 * ops_connections_timeout and aborts the request it was making. The bidding
 * Worker's own per method deadline (PR 9) must be longer than these, so ops
 * answers by name before bidding gives up:
 *   verify, clearReauth  the money identity read (15 s at most), one
 *                        connectionFetch (a 2 s pool wait, a mint, a request),
 *                        and the measured identity write (9 s at most)
 *   exchangeOAuthCode    one token request in the token object (10 s) and its write
 *   lookup               the allowance, the copy read and one to three requests
 *   revoke, health       one ops database call (9 s at most)
 */
export const OPS_CONNECTIONS_CEILINGS_MS: Readonly<Record<OpsConnectionsMethod, number>> = {
  verify: 45_000,
  clearReauth: 45_000,
  exchangeOAuthCode: 30_000,
  lookup: 25_000,
  revoke: 10_000,
  health: 10_000,
}

/**
 * The per organization cap on schema lookups (the plan: "Lookups sit behind a
 * per organization rate cap"), held by take_lookup_allowance in a one minute
 * window. 60 a minute is one a second, sustained, for a whole organization:
 * each dropdown of the step form is one lookup when it opens, and a person
 * opens a few a minute; the cap is there to stop a runaway client spending a
 * service's daily allocation, not to ration a person.
 */
export const LOOKUP_RATE_PER_MINUTE = 60

/** At most this many connections are answered by health; reached_limit says so. */
export const HEALTH_LIMIT = 1000

/**
 * OpsConnections' own refusals, beside connectionFetch's (refusals.ts) and the
 * schema lookups' (schema-sync/errors.ts), which it answers by their own codes.
 */
export const OPS_CONNECTIONS_REFUSAL_CODES = [
  /** The request is not one this contract reads. */
  'ops_connections_request_invalid',
  /** LANE is unset, or names another lane: this deploy must not answer as the ops Worker. */
  'lane_unset',
  'lane_not_ops',
  /** A secret the method needs is unset or unusable on bidspoke-worker-ops (named in the detail). */
  'ops_connections_not_configured',
  /** The method ran past its ceiling (OPS_CONNECTIONS_CEILINGS_MS). */
  'ops_connections_timeout',
  /** An error this code did not expect, named by its kind only. */
  'ops_connections_failed',
  /** The bidding Worker's moneyIdentities did not answer, or answered something unreadable. */
  'money_identity_unavailable',
  /** No reading of money's Salesforce identity, or one past MONEY_IDENTITY_MAX_AGE_MS: verify never passes on it. */
  'money_identity_unmeasured',
  /** The credential authenticates as money's Salesforce run as user. */
  'money_identity_match',
  /** The sealed Salesforce client id is not the one the target declares. */
  'verify_client_id_mismatch',
  /** A person bound login offered as a candidate: it is proven by its code exchange instead (#2425). */
  'candidate_not_refreshable',
  /** No identity measurement for this service yet (each arrives with its service, Phase 7): never a pass. */
  'verify_identity_unmeasurable',
  /** The service's identity answer could not be read. */
  'verify_identity_unreadable',
  /** A generation ops holds as its copy measured another identity than before. */
  'identity_changed',
  /** The measured identity could not be written, so the connection is not verified. */
  'measured_identity_unrecorded',
  /** The Reconnect passed verify, and its clearing could not be written. */
  'reauth_clear_unrecorded',
  /** The tombstone could not be written. */
  'revoke_unrecorded',
  /** The connection statuses could not be read. */
  'health_unavailable',
  /** The organization has taken LOOKUP_RATE_PER_MINUTE lookups this minute; retry_at says when the window ends. */
  'lookup_rate_limited',
  /** The allowance could not be read, so nothing was sent. */
  'lookup_allowance_unavailable',
  /** The connection's service answers no schema lookups. */
  'lookup_not_supported',
] as const
export type OpsConnectionsOwnRefusal = (typeof OPS_CONNECTIONS_REFUSAL_CODES)[number]
export type OpsConnectionsRefusalCode = OpsConnectionsOwnRefusal | ConnectionRefusalCode | SchemaLookupCode

export interface OpsConnectionsRefused {
  ok: false
  refused: OpsConnectionsRefusalCode
  /** Names only. */
  detail: string
  /** When the answer can change, where it is known. */
  retry_at: string | null
}

/** A credential bidding has not committed: the row's sealed envelope and its public half. */
export interface SealedCandidate {
  service: string
  generation: number
  envelope: SealedEnvelopeShape
  target: Record<string, unknown> | null
  public_config: Record<string, unknown>
}

export interface VerifyRequest {
  organization_id: string
  connection_id: string
  /** Null: verify the copy ops holds. */
  candidate: SealedCandidate | null
}

export interface ClearReauthRequest {
  organization_id: string
  connection_id: string
  candidate: SealedCandidate
}

export interface RevokeRequest {
  organization_id: string
  connection_id: string
  /** Every generation up to this one is removed. */
  generation: number
  /** The bidding Worker's clock when it removed the row. */
  removed_at: string
}

export interface HealthRequest {
  organization_id: string
}

export interface LookupRequest {
  organization_id: string
  connection_id: string
  key: string
  parents: string[]
}

export interface ExchangeOAuthCodeRequest {
  organization_id: string
  connection_id: string
  /** The row's sealed app login (#2425). */
  candidate: SealedCandidate
  code: string
  /** The PKCE verifier, 43 to 128 characters. */
  verifier: string
  redirect_uri: string
}

/** What verify measured the credential as. Salesforce's today; each service adds its own kind with its measurement (Phase 7). */
export type MeasuredIdentityAnswer = { kind: 'salesforce'; sf_org_id: string; username: string }

export type VerifyAnswer = { ok: true; service: string; generation: number; identity: MeasuredIdentityAnswer } | OpsConnectionsRefused
export type ClearReauthAnswer = { ok: true; service: string; generation: number; identity: MeasuredIdentityAnswer; cleared: true } | OpsConnectionsRefused
export type RevokeAnswer = { ok: true; outcome: 'recorded' | 'already_recorded'; copies_removed: number } | OpsConnectionsRefused

export interface HealthRow {
  connection_id: string
  service: string
  generation: number
  /** connection_status's derived status; one this Worker does not know is kept as text. */
  status: string
  last_check_ok_at: string | null
  last_check_failed_at: string | null
  last_check_cause: string | null
  needs_reauth_at: string | null
  needs_reauth_cause: string | null
  reauth_cleared_at: string | null
}
export type HealthAnswer = { ok: true; connections: HealthRow[]; reached_limit: boolean } | OpsConnectionsRefused
export type LookupAnswer = { ok: true; answer: SchemaLookupAnswer } | OpsConnectionsRefused
export type ExchangeOAuthCodeAnswer = { ok: true; generation: number } | OpsConnectionsRefused

/**
 * The bidding Worker's OPS_CONNECTIONS binding (wrangler.toml, PR 9) to this
 * entrypoint. Each method takes its request and answers unknown, which the
 * bidding side reads through lib/ops-connections-client.ts before trusting it.
 */
export type OpsConnectionsBinding = { readonly [M in OpsConnectionsMethod]: (request: unknown) => Promise<unknown> }

export class OpsConnectionsContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsConnectionsContractError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SERVICE_KEY = /^[a-z][a-z0-9_]{0,63}$/
const LOOKUP_KEY = /^[a-z][a-z_]{0,31}$/
const MAX_PARENT = 255

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

function record(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new OpsConnectionsContractError('the request is not an object')
  return raw
}

/** A uuid, read lower case: the database's spelling, and the one the seal's AAD binds. */
function uuidField(raw: Record<string, unknown>, name: 'organization_id' | 'connection_id'): string {
  const value = raw[name]
  if (typeof value !== 'string' || !UUID.test(value)) throw new OpsConnectionsContractError(`the request's ${name} is not a uuid`)
  return value.toLowerCase()
}

function candidateField(raw: unknown): SealedCandidate {
  if (!isRecord(raw)) throw new OpsConnectionsContractError('the request\'s candidate is not an object')
  const { service, generation, envelope, target, public_config } = raw
  if (typeof service !== 'string' || !SERVICE_KEY.test(service)) throw new OpsConnectionsContractError('the candidate\'s service is not a service key')
  if (!isWhole(generation) || generation < 1) throw new OpsConnectionsContractError('the candidate\'s generation is not a whole number of at least 1')
  let sealed: SealedEnvelopeShape
  try {
    sealed = parseSealedEnvelope(envelope, 'the candidate\'s envelope')
  } catch (err) {
    // parseSealedEnvelope's message names a field, never a value.
    throw new OpsConnectionsContractError(err instanceof OpsGatewayContractError ? err.message : 'the candidate\'s envelope is not the seal\'s')
  }
  if (!isRecord(public_config)) throw new OpsConnectionsContractError('the candidate\'s public config is not an object')
  const configProblem = clearFieldProblem(public_config, 'public config')
  if (configProblem) throw new OpsConnectionsContractError(`the candidate carries ${configProblem}`)
  if (target !== null && target !== undefined) {
    if (!isRecord(target)) throw new OpsConnectionsContractError('the candidate\'s target is neither an object nor null')
    const targetProblem = clearFieldProblem(target, 'a target')
    if (targetProblem) throw new OpsConnectionsContractError(`the candidate carries ${targetProblem}`)
  }
  return { service, generation, envelope: sealed, target: target ?? null, public_config }
}

export function parseVerifyRequest(raw: unknown): VerifyRequest {
  const r = record(raw)
  return {
    organization_id: uuidField(r, 'organization_id'),
    connection_id: uuidField(r, 'connection_id'),
    candidate: r.candidate === null || r.candidate === undefined ? null : candidateField(r.candidate),
  }
}

export function parseClearReauthRequest(raw: unknown): ClearReauthRequest {
  const r = record(raw)
  if (r.candidate === null || r.candidate === undefined) throw new OpsConnectionsContractError('a Reconnect names its candidate: the row\'s sealed envelope, generation and target')
  return { organization_id: uuidField(r, 'organization_id'), connection_id: uuidField(r, 'connection_id'), candidate: candidateField(r.candidate) }
}

export function parseRevokeRequest(raw: unknown): RevokeRequest {
  const r = record(raw)
  if (!isWhole(r.generation) || r.generation < 1) throw new OpsConnectionsContractError('the revoke\'s generation is not a whole number of at least 1')
  if (typeof r.removed_at !== 'string' || !Number.isFinite(Date.parse(r.removed_at))) throw new OpsConnectionsContractError('the revoke\'s removed_at is not a time')
  return { organization_id: uuidField(r, 'organization_id'), connection_id: uuidField(r, 'connection_id'), generation: r.generation, removed_at: r.removed_at }
}

export function parseHealthRequest(raw: unknown): HealthRequest {
  return { organization_id: uuidField(record(raw), 'organization_id') }
}

export function parseLookupRequest(raw: unknown): LookupRequest {
  const r = record(raw)
  if (typeof r.key !== 'string' || !LOOKUP_KEY.test(r.key)) throw new OpsConnectionsContractError('the lookup\'s key is not a lookup key')
  const parents = r.parents ?? []
  if (!Array.isArray(parents) || parents.length > 1 || parents.some((p) => typeof p !== 'string' || p === '' || p.length > MAX_PARENT)) {
    throw new OpsConnectionsContractError(`the lookup's parents are not a list of at most one name of 1 to ${MAX_PARENT} characters`)
  }
  return { organization_id: uuidField(r, 'organization_id'), connection_id: uuidField(r, 'connection_id'), key: r.key, parents: [...(parents as string[])] }
}

export function parseExchangeOAuthCodeRequest(raw: unknown): ExchangeOAuthCodeRequest {
  const r = record(raw)
  if (r.candidate === null || r.candidate === undefined) throw new OpsConnectionsContractError('an exchange names its candidate: the row\'s sealed app login')
  if (typeof r.code !== 'string' || r.code === '' || r.code.length > 4096) throw new OpsConnectionsContractError('the exchange\'s code is missing')
  if (typeof r.verifier !== 'string' || r.verifier.length < 43 || r.verifier.length > 128) throw new OpsConnectionsContractError('the exchange\'s PKCE verifier is not 43 to 128 characters')
  if (typeof r.redirect_uri !== 'string' || r.redirect_uri === '' || r.redirect_uri.length > 2048) throw new OpsConnectionsContractError('the exchange\'s redirect_uri is missing')
  return {
    organization_id: uuidField(r, 'organization_id'),
    connection_id: uuidField(r, 'connection_id'),
    candidate: candidateField(r.candidate),
    code: r.code,
    verifier: r.verifier,
    redirect_uri: r.redirect_uri,
  }
}
