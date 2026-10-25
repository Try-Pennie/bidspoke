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
import { DELEGATION_KINDS, type DelegationKind } from '../ops/run-vocabulary'
import type { SchemaLookupCode } from './schema-sync/errors'
import type { SchemaLookupAnswer } from './schema-sync/lookup'
import { clearFieldProblem, OpsGatewayContractError, parseSealedEnvelope, type SealedEnvelopeShape } from './ops-gateway-contract'

/**
 * Every method the bidding Worker calls through OPS_CONNECTIONS, and so every
 * method CI's deployed ops check (.github/scripts/ops-exports-entrypoint.mjs)
 * requires the LIVE ops Worker to export.
 *
 * After the first six come the Google mailboxes and drives list's three
 * (#2338, R10, finding F129): add, remove and list an organization's
 * google_delegation_subjects, each change written on ops with who made it and
 * when. They shipped on ops first, in build PR 2, kept out of this list so that
 * pull request did not require them of the deploy it preceded; build PR 6 moved
 * them here once the ops deploy carried them (Deploy Ops Worker, 2026-10-20),
 * with the bidding routes that call them. signInClient, last, followed the same
 * order: shipped on ops in build PR 13a (#2739), moved here in build PR 13b
 * with the Sign in with Google routes.
 */
export const OPS_CONNECTIONS_METHODS = [
  'verify', 'clearReauth', 'revoke', 'health', 'lookup', 'exchangeOAuthCode', 'addDelegationSubject', 'removeDelegationSubject', 'listDelegationSubjects',
  'signInClient',
] as const
export type OpsConnectionsMethod = (typeof OPS_CONNECTIONS_METHODS)[number]

/**
 * The Google list's methods among them. The entrypoint runs these with the ops
 * database alone (connections/delegation-list.ts), never the connections'
 * dependencies, so it never needs the ops private key or the gateway for them.
 */
export const OPS_DELEGATION_METHODS = ['addDelegationSubject', 'removeDelegationSubject', 'listDelegationSubjects'] as const satisfies readonly OpsConnectionsMethod[]
export type OpsDelegationMethod = (typeof OPS_DELEGATION_METHODS)[number]
/** The methods the entrypoint runs with the connections' dependencies (connections/ops-connections.ts). */
export type OpsConnectionsCoreMethod = Exclude<OpsConnectionsMethod, OpsDelegationMethod | OpsSignInMethod>

/** At most this many entries are answered by listDelegationSubjects; reached_limit says so. */
export const DELEGATION_LIST_LIMIT = 1000

/**
 * The sign in method (#2338, build PR 13; R17): the client id of the sign in
 * app the ops Worker holds for a service (connections/oauth-apps.ts), which the
 * bidding Worker's Sign in with Google link names. The app's secret never
 * leaves ops (Dan's decision of 2026-10-22), and the id is read from the same
 * secret the exchange sends with it, so the two cannot disagree.
 *
 * It shipped on ops first (build PR 13a), kept out of OPS_CONNECTIONS_METHODS
 * as the Google list's methods were in build PR 2, since CI's deployed ops
 * check requires the LIVE ops Worker to export every method on that list; the
 * bidding sign in routes that call it moved it onto the list once the ops
 * deploy carried it. The entrypoint runs it with one secret of the ops
 * Worker's own as its only dependency.
 */
export const OPS_SIGN_IN_METHODS = ['signInClient'] as const satisfies readonly OpsConnectionsMethod[]
export type OpsSignInMethod = (typeof OPS_SIGN_IN_METHODS)[number]

/**
 * How long the entrypoint lets each method run before it answers
 * ops_connections_timeout and aborts the request it was making. The bidding
 * Worker's own per method deadline (PR 9) must be longer than these, so ops
 * answers by name before bidding gives up:
 *   verify, clearReauth  Salesforce: the money identity read (15 s at most), one
 *                        connectionFetch (a 2 s pool wait, a mint, a request),
 *                        and the measured identity write (9 s at most).
 *                        Snowflake: one statement, polled 2 s apart while it
 *                        runs and writing nothing; its 60 poll budget is longer
 *                        than this ceiling, so a statement still running at
 *                        45 s is answered ops_connections_timeout by name
 *   exchangeOAuthCode    one token request in the token object (10 s) and its write
 *   lookup               the allowance, the copy read and one to three requests
 *   revoke, health       one ops database call (9 s at most)
 *   the Google list's    one ops database call each, which stops at the 8 s
 *                        statement timeout
 */
export const OPS_CONNECTIONS_CEILINGS_MS: Readonly<Record<OpsConnectionsMethod, number>> = {
  verify: 45_000,
  clearReauth: 45_000,
  exchangeOAuthCode: 30_000,
  lookup: 25_000,
  revoke: 10_000,
  health: 10_000,
  addDelegationSubject: 10_000,
  removeDelegationSubject: 10_000,
  listDelegationSubjects: 10_000,
  // Reading one secret of the ops Worker's own: no database, no network.
  signInClient: 5_000,
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
  /** The service measured another identity than the connection's target declares (#2337). */
  'verify_identity_mismatch',
  /** A Slack token that acts as a person (auth.test named no bot): an ops Slack connection is a bot (#2337). */
  'verify_slack_not_a_bot',
  /** A Slack bot in another workspace than the target's team_id (#2337). */
  'verify_slack_workspace_mismatch',
  /** An OpenAI key OpenAI answered for another project than the target's project_id (#2337). */
  'verify_openai_project_mismatch',
  /** An Anthropic key Anthropic ran in another workspace than the target's workspace_id (#2337). */
  'verify_anthropic_workspace_mismatch',
  /** A Google connection whose delegated token Gmail answered as another mailbox than the target's subject (#2337). */
  'verify_google_mailbox_mismatch',
  /** An HTTP connection's check path answered a 3xx or a 4xx with the key, so the key is not proven on its host (#2337). */
  'verify_http_check_refused',
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
  /** The Google list (#2338): the address is not one mailbox, or the id not a shared drive's. Nothing was written. */
  'delegation_subject_invalid',
  /** A drive's name is longer than 200 characters or holds a control character, or a name was given for a mailbox. Nothing was written. */
  'delegation_display_name_invalid',
  /** Another organization's list holds this mailbox or drive. Nothing was written. */
  'delegation_subject_listed_elsewhere',
  /** The organization's list holds no such entry, so nothing was removed. */
  'delegation_subject_not_listed',
  /** The ops database did not confirm the change: read the list to see whether it was made. */
  'delegation_change_failed',
  /** The list could not be read. */
  'delegation_list_unavailable',
  /** The ops Worker holds no sign in app for the service (its secret, named in the detail, is unset): nobody can sign in yet (#2338). */
  'sign_in_app_unset',
  /** The ops Worker's sign in app is not a web client's JSON it can read (the secret is named in the detail, never what it holds). */
  'sign_in_app_malformed',
  /** The service has no person bound sign in on this Worker. */
  'sign_in_not_offered',
  /** A person signed in as another account than the one the exchange named (their own Bidspoke address, Dan 2026-10-23). Nothing was stored. */
  'exchange_account_mismatch',
  /** A step test of an action that changes something in the service, asked without confirming the real send (#2339). Nothing was sent. */
  'step_test_send_unconfirmed',
  /** The step's stored test result could not be read (#2339). */
  'step_test_unavailable',
  // A step test from a past run (#2339, #2703). Each refuses before anything is sent or kept.
  /** The organization's workflow has no such run on ops: never one, another workflow's, or deleted with its run. */
  'step_test_run_not_found',
  /** The run is more than 7 days old, so its step records are gone. */
  'step_test_run_records_gone',
  /** A step the tested step reads has no record in that run before it (the detail names each). */
  'step_test_run_steps_missing',
  /** A step the tested step reads was recorded by its size alone, over the cap, or the run's outputs are more than a test takes. */
  'step_test_run_output_not_kept',
  /** The run's payload is held by reference elsewhere, which ops cannot read yet. */
  'step_test_run_payload_not_held',
  /** The run's records could not be read. */
  'step_test_run_unavailable',
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
  /**
   * The account the person must sign in as, lower case: their own Bidspoke
   * address (#2338, Dan's decision of 2026-10-23). A consent as anyone else is
   * refused (exchange_account_mismatch) and nothing is stored.
   */
  expected_account: string
}

/** What verify measured the credential as. Each service adds its own kind with its measurement (Phase 7). */
export type MeasuredIdentityAnswer =
  | { kind: 'salesforce'; sf_org_id: string; username: string }
  | { kind: 'snowflake'; account_locator: string; organization_name: string | null; account_name: string | null; user: string }
  | { kind: 'slack'; team_id: string; team: string | null; user_id: string; user: string | null; bot_id: string }
  | { kind: 'openai'; project_id: string; organization: string | null }
  | { kind: 'anthropic'; workspace_id: string; organization_id: string | null }
  | { kind: 'google'; mailbox: string }
  | { kind: 'http'; host: string }

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
/**
 * The generation the consent's login is sealed under, whom the person signed in
 * as where the provider said (#2338), else null, and whether needs_reauth was
 * cleared: a consent is a person bound login's Reconnect, and false means the
 * login is stored and the clearing could not be written.
 */
export type ExchangeOAuthCodeAnswer = { ok: true; generation: number; account: string | null; reauth_cleared: boolean } | OpsConnectionsRefused

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
function uuidField(raw: Record<string, unknown>, name: 'organization_id' | 'connection_id' | 'workflow_id' | 'tested_by' | 'execution_id'): string {
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

// ── the Google mailboxes and drives list (#2338) ────────────────────────────

/**
 * The signed in person changing the list, from the bidding Worker's verified
 * JWT: who the change record names. At least one of a name or an email, since
 * the entry shows who added it ("Added by <who>", D10).
 */
export interface DelegationActorShape {
  user_id: string
  email: string | null
  name: string | null
}

export interface AddDelegationSubjectRequest {
  organization_id: string
  actor: DelegationActorShape
  kind: DelegationKind
  /** A mailbox's address or a shared drive's id, as typed: ops trims it, lower cases a mailbox, and judges its shape. */
  subject: string
  /** A shared drive's name, shown in place of its id; null for a mailbox. */
  display_name: string | null
}

export interface RemoveDelegationSubjectRequest {
  organization_id: string
  actor: DelegationActorShape
  kind: DelegationKind
  subject: string
}

export interface ListDelegationSubjectsRequest {
  organization_id: string
}

/** One entry of the list, as the page shows it. */
export interface DelegationSubjectRow {
  kind: DelegationKind
  subject: string
  display_name: string | null
  added_by: string
  added_at: string
}

export type AddDelegationSubjectAnswer = { ok: true; outcome: 'added' | 'already_listed'; entry: DelegationSubjectRow } | OpsConnectionsRefused
export type RemoveDelegationSubjectAnswer = { ok: true; outcome: 'removed' } | OpsConnectionsRefused
export type ListDelegationSubjectsAnswer = { ok: true; subjects: DelegationSubjectRow[]; reached_limit: boolean } | OpsConnectionsRefused

/**
 * Size bounds only, so nothing unbounded crosses: the shape of an address, a
 * drive id and a drive's name is the table's to judge, its one home (L83), and
 * ops answers each by name (delegation_subject_invalid, delegation_display_name_invalid).
 */
export const DELEGATION_SUBJECT_MAX = 320
const MAX_ACTOR_FIELD = 200
const MAX_ACTOR_EMAIL = 320
export const DELEGATION_DISPLAY_NAME_MAX = 400

function actorField(raw: unknown): DelegationActorShape {
  if (!isRecord(raw)) throw new OpsConnectionsContractError('the request\'s actor is not an object')
  const { user_id, email, name } = raw
  if (typeof user_id !== 'string' || !UUID.test(user_id)) throw new OpsConnectionsContractError('the actor\'s user_id is not a uuid')
  if (email !== null && email !== undefined && (typeof email !== 'string' || email.length > MAX_ACTOR_EMAIL)) {
    throw new OpsConnectionsContractError(`the actor's email is neither text of at most ${MAX_ACTOR_EMAIL} characters nor null`)
  }
  if (name !== null && name !== undefined && (typeof name !== 'string' || name.length > MAX_ACTOR_FIELD)) {
    throw new OpsConnectionsContractError(`the actor's name is neither text of at most ${MAX_ACTOR_FIELD} characters nor null`)
  }
  const shown = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  if (shown(email) === null && shown(name) === null) throw new OpsConnectionsContractError('the actor has neither a name nor an email to say who made the change')
  return { user_id: user_id.toLowerCase(), email: typeof email === 'string' ? email : null, name: typeof name === 'string' ? name : null }
}

function entryFields(r: Record<string, unknown>): { kind: DelegationKind; subject: string } {
  if (typeof r.kind !== 'string' || !(DELEGATION_KINDS as readonly string[]).includes(r.kind)) throw new OpsConnectionsContractError('the entry\'s kind is not mailbox or drive')
  if (typeof r.subject !== 'string' || r.subject.length > DELEGATION_SUBJECT_MAX) throw new OpsConnectionsContractError(`the entry's subject is not text of at most ${DELEGATION_SUBJECT_MAX} characters`)
  return { kind: r.kind as DelegationKind, subject: r.subject }
}

export function parseAddDelegationSubjectRequest(raw: unknown): AddDelegationSubjectRequest {
  const r = record(raw)
  const organization_id = uuidField(r, 'organization_id')
  const actor = actorField(r.actor)
  const entry = entryFields(r)
  const displayName = r.display_name ?? null
  if (displayName !== null && (typeof displayName !== 'string' || displayName.length > DELEGATION_DISPLAY_NAME_MAX)) {
    throw new OpsConnectionsContractError(`the entry's display_name is neither text of at most ${DELEGATION_DISPLAY_NAME_MAX} characters nor null`)
  }
  return { organization_id, actor, ...entry, display_name: displayName }
}

export function parseRemoveDelegationSubjectRequest(raw: unknown): RemoveDelegationSubjectRequest {
  const r = record(raw)
  return { organization_id: uuidField(r, 'organization_id'), actor: actorField(r.actor), ...entryFields(r) }
}

export function parseListDelegationSubjectsRequest(raw: unknown): ListDelegationSubjectsRequest {
  return { organization_id: uuidField(record(raw), 'organization_id') }
}

// ── the sign in app (#2338, build PR 13) ────────────────────────────────────

export interface SignInClientRequest {
  organization_id: string
  /** The service the person signs in to, by its catalogue key. */
  service: string
}

/** The app's client id: public, the id the authorize link names. Never its secret. */
export type SignInClientAnswer = { ok: true; service: string; client_id: string } | OpsConnectionsRefused

export function parseSignInClientRequest(raw: unknown): SignInClientRequest {
  const r = record(raw)
  const organization_id = uuidField(r, 'organization_id')
  if (typeof r.service !== 'string' || !SERVICE_KEY.test(r.service)) throw new OpsConnectionsContractError('the request\'s service is not a service key')
  return { organization_id, service: r.service }
}

export function parseExchangeOAuthCodeRequest(raw: unknown): ExchangeOAuthCodeRequest {
  const r = record(raw)
  if (r.candidate === null || r.candidate === undefined) throw new OpsConnectionsContractError('an exchange names its candidate: the row\'s sealed app login')
  if (typeof r.code !== 'string' || r.code === '' || r.code.length > 4096) throw new OpsConnectionsContractError('the exchange\'s code is missing')
  if (typeof r.verifier !== 'string' || r.verifier.length < 43 || r.verifier.length > 128) throw new OpsConnectionsContractError('the exchange\'s PKCE verifier is not 43 to 128 characters')
  if (typeof r.redirect_uri !== 'string' || r.redirect_uri === '' || r.redirect_uri.length > 2048) throw new OpsConnectionsContractError('the exchange\'s redirect_uri is missing')
  if (typeof r.expected_account !== 'string' || r.expected_account.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(r.expected_account.trim())) {
    throw new OpsConnectionsContractError('the exchange\'s expected_account is not one address')
  }
  return {
    organization_id: uuidField(r, 'organization_id'),
    connection_id: uuidField(r, 'connection_id'),
    candidate: candidateField(r.candidate),
    code: r.code,
    verifier: r.verifier,
    redirect_uri: r.redirect_uri,
    expected_account: r.expected_account.trim().toLowerCase(),
  }
}

// ── the step test (#2339) ───────────────────────────────────────────────────

/**
 * The step test methods (#2339, phase 9 of #1689): testStep runs one app_action
 * step of an ops workflow for real, through the executor and connectionFetch,
 * and keeps its result on the ops database (Dan's decision of 2026-10-23: the
 * ops database only, the latest result per step, for 7 days); stepTestResult
 * reads that result back for the data picker.
 *
 * Kept apart from OPS_CONNECTIONS_METHODS on purpose, as the sign in method is:
 * CI's deployed ops check requires the LIVE ops Worker to export every method
 * on that list, so the pull request adding these cannot also require them of
 * the deploy it precedes. Until the ops deploy carries them, the bidding route
 * that calls them answers ops_connections_unavailable, and they move onto that
 * list in a later change.
 */
export const OPS_STEP_TEST_METHODS = ['testStep', 'stepTestResult'] as const
export type OpsStepTestMethod = (typeof OPS_STEP_TEST_METHODS)[number]

/**
 *   testStep        the connection's copy, then the action's own sends, each
 *                   under connectionFetch's deadline (an action may poll or
 *                   send several times), then the one write of its result
 *   stepTestResult  one ops database read (8 s statement timeout)
 */
export const OPS_STEP_TEST_CEILINGS_MS: Readonly<Record<OpsStepTestMethod, number>> = {
  testStep: 90_000,
  stepTestResult: 10_000,
}

/** The trigger payload and the earlier steps' outputs a test is given, together, at most this many bytes of JSON. */
export const STEP_TEST_CONTEXT_MAX_BYTES = 512 * 1024

const NODE_ID_MAX = 200
const STEP_NAMESPACE = /^[a-zA-Z_][a-zA-Z0-9_]{0,199}$/

export interface StepTestNode {
  /** The canvas node id: the key the result is kept under. */
  id: string
  /** The step id, the root of the picker's paths (steps.<namespace>.output...). */
  namespace: string
  /** The app_action settings, boundBy stamped by the bidding Worker with tested_by. */
  config: Record<string, unknown>
}

export interface TestStepRequest {
  organization_id: string
  workflow_id: string
  /** The users.id of the person testing, from the verified JWT. */
  tested_by: string
  node: StepTestNode
  /**
   * A past run attempt of this workflow on ops (its workflow_executions id) to
   * build the step's context from (#2339, #2703): that run's payload and the
   * outputs its earlier steps recorded. Null for a test with the context given here.
   */
  execution_id: string | null
  /** With execution_id, undefined means the run's own payload; a payload given here replaces it. */
  trigger_payload: unknown
  /** With execution_id, each step given here replaces that run's record of it. */
  steps: Record<string, { output: unknown; status: string }>
  /** The person confirmed that a step changing something in the service may send for real. */
  confirm_send: boolean
}

/**
 * What the bidding Worker sends for testStep, which parseTestStepRequest reads
 * into a TestStepRequest: from a past run, a payload or steps left out are the
 * run's own (#2703).
 */
export type TestStepCall = Omit<TestStepRequest, 'execution_id' | 'trigger_payload' | 'steps'> & {
  execution_id?: string
  trigger_payload?: unknown
  steps?: TestStepRequest['steps']
}

export interface StepTestResultRequest {
  organization_id: string
  workflow_id: string
  node_id: string
}

/** One kept test result as it crosses the binding. */
export interface StepTestView {
  node_id: string
  namespace: string
  tested_by: string
  tested_at: string
  status: 'completed' | 'failed'
  /** Null for a failure, or an answer over the kept size (output_bytes then says how big it was). */
  output: unknown
  output_bytes: number | null
  error: string | null
  /** Each request the step made, sanitised before its login was applied. */
  requests: unknown[]
  duration_ms: number
}

/** recorded is false when the result could not be kept: the test still ran, and the picker will not see it. */
export type TestStepAnswer = { ok: true; result: StepTestView; recorded: boolean } | OpsConnectionsRefused
/** result is null when the step has no test result under 7 days old. */
export type StepTestResultAnswer = { ok: true; result: StepTestView | null } | OpsConnectionsRefused

function nodeIdOf(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== 'string' || raw === '' || raw.length > NODE_ID_MAX || /[\u0000-\u001f]/.test(raw)) {
    throw new OpsConnectionsContractError('the request\'s node\'s id is not 1 to 200 printable characters')
  }
  return raw
}

export function parseTestStepRequest(raw: unknown): TestStepRequest {
  const r = record(raw)
  const organization_id = uuidField(r, 'organization_id')
  const workflow_id = uuidField(r, 'workflow_id')
  const tested_by = uuidField(r, 'tested_by')
  if (!isRecord(r.node)) throw new OpsConnectionsContractError('the request\'s node is not an object')
  const id = nodeIdOf(r.node.id)
  if (typeof r.node.namespace !== 'string' || !STEP_NAMESPACE.test(r.node.namespace)) {
    throw new OpsConnectionsContractError('the request\'s node\'s step id is not a step id')
  }
  if (!isRecord(r.node.config)) throw new OpsConnectionsContractError('the request\'s node\'s settings are not an object')
  const steps: TestStepRequest['steps'] = {}
  if (r.steps !== undefined && r.steps !== null) {
    if (!isRecord(r.steps)) throw new OpsConnectionsContractError('the request\'s steps are not an object')
    for (const [namespace, step] of Object.entries(r.steps)) {
      if (!STEP_NAMESPACE.test(namespace) || !isRecord(step) || typeof step.status !== 'string') {
        throw new OpsConnectionsContractError('the request\'s steps are not each a step id holding an output and a status')
      }
      steps[namespace] = { output: step.output ?? null, status: step.status }
    }
  }
  if (r.confirm_send !== undefined && typeof r.confirm_send !== 'boolean') throw new OpsConnectionsContractError('the request\'s confirm_send is not true or false')
  const execution_id = r.execution_id === undefined || r.execution_id === null ? null : uuidField(r, 'execution_id')
  // From a past run, no payload given is the run's own; otherwise none is an empty one.
  const trigger_payload = r.trigger_payload ?? (execution_id === null ? {} : undefined)
  if (new TextEncoder().encode(JSON.stringify({ trigger_payload, steps })).length > STEP_TEST_CONTEXT_MAX_BYTES) {
    throw new OpsConnectionsContractError(`the request's context (its trigger payload and steps) is over ${STEP_TEST_CONTEXT_MAX_BYTES} bytes`)
  }
  return {
    organization_id, workflow_id, tested_by,
    node: { id, namespace: r.node.namespace, config: r.node.config },
    execution_id, trigger_payload, steps, confirm_send: r.confirm_send === true,
  }
}

export function parseStepTestResultRequest(raw: unknown): StepTestResultRequest {
  const r = record(raw)
  return { organization_id: uuidField(r, 'organization_id'), workflow_id: uuidField(r, 'workflow_id'), node_id: nodeIdOf(r.node_id) }
}
