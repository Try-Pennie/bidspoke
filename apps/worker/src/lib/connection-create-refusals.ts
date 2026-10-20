/**
 * What the Add connection form says when a save is refused (#2338, build PR 5;
 * R14, D14): one plain sentence per refusal code, in this one place, which the
 * create route answers as the refusal's message and the page shows as it is
 * (build PR 10). Each says what failed, that nothing was saved, and what to do,
 * as the settled design does: "Salesforce refused the client secret. Nothing
 * was saved. Check the client secret and save again."
 *
 * The codes are the route's own (CREATE_ROUTE_REFUSAL_CODES) and every code
 * OpsConnections.verify can answer: its own refusals but the ones only another
 * method answers (NOT_VERIFY_REFUSALS), connectionFetch's, and
 * ops_connections_unavailable from the binding. The sentences are a Record over
 * that union, so a code added to either list without a sentence fails to
 * compile, and connection-create-refusals.test.ts holds every one to the
 * pattern and to being its own (L11).
 *
 * A sentence is built from names alone: the service's name, its secret field's
 * label, the Salesforce org's address, the field labels or list entries the
 * refusal is about. Never a value of the login.
 */
import type { ConnectionRefusalCode } from '../ops/connections/refusals'
import { CONNECTION_REFUSAL_CODES } from '../ops/connections/refusals'
import type { MoneyTargetKind } from './connection-money-targets'
import { OPS_CONNECTIONS_REFUSAL_CODES, type OpsConnectionsOwnRefusal } from './ops-connections-contract'

/** The longest name a connection may have. */
export const CONNECTION_NAME_MAX = 100

export const CREATE_ROUTE_REFUSAL_CODES = [
  /** The body is not the form's: not JSON, a key the route does not read, a value that is not text. */
  'connection_request_invalid',
  /** The catalogue declares no such service: the route is where a service must be declared (L667). */
  'connection_service_undeclared',
  'connection_name_missing',
  'connection_name_invalid',
  /** A required field is blank: names each by its label. */
  'connection_fields_missing',
  /** A field the service does not declare: names each. */
  'connection_fields_undeclared',
  /** The name is the Slack alert login's. */
  'connection_name_reserved',
  /** Another connection of this service in the organization has the name. */
  'connection_name_taken',
  /** The target declares a money identity (connection-money-targets.ts). */
  'connection_money_identity',
  /** The money identities could not be read, so the save is refused rather than passed. */
  'connection_money_targets_unreadable',
  /** A mailbox or drive not on the organization's Google list. */
  'google_subject_not_listed',
  /** The Google list could not be read. */
  'google_list_unavailable',
  /** The login could not be sealed. */
  'connection_seal_failed',
  /** The name check could not read the database. */
  'connections_unavailable',
  /** Verify passed and the row could not be written. */
  'connection_store_failed',
  /** Verify did not answer within the bidding Worker's deadline. */
  'verify_timed_out',
  /** Verify answered a refusal code this Worker does not know. */
  'verify_refused_unknown',
] as const
export type CreateRouteRefusalCode = (typeof CREATE_ROUTE_REFUSAL_CODES)[number]

/** OpsConnections refusals only another method answers: the Google list's, the lookups', health's, revoke's and the Reconnect's clearing. */
export const NOT_VERIFY_REFUSALS = [
  'reauth_clear_unrecorded',
  'revoke_unrecorded',
  'health_unavailable',
  'lookup_rate_limited',
  'lookup_allowance_unavailable',
  'lookup_not_supported',
  'delegation_subject_invalid',
  'delegation_display_name_invalid',
  'delegation_subject_listed_elsewhere',
  'delegation_subject_not_listed',
  'delegation_change_failed',
  'delegation_list_unavailable',
] as const satisfies readonly OpsConnectionsOwnRefusal[]

export type VerifyRefusalCode =
  | Exclude<OpsConnectionsOwnRefusal, (typeof NOT_VERIFY_REFUSALS)[number]>
  | ConnectionRefusalCode
  | 'ops_connections_unavailable'

export type CreateRefusalCode = CreateRouteRefusalCode | VerifyRefusalCode

const NOT_VERIFY: ReadonlySet<string> = new Set(NOT_VERIFY_REFUSALS)

export const VERIFY_REFUSAL_CODES: readonly VerifyRefusalCode[] = [
  ...(OPS_CONNECTIONS_REFUSAL_CODES.filter((c) => !NOT_VERIFY.has(c)) as VerifyRefusalCode[]),
  ...CONNECTION_REFUSAL_CODES,
  'ops_connections_unavailable',
]

export const CREATE_REFUSAL_CODES: readonly CreateRefusalCode[] = [...CREATE_ROUTE_REFUSAL_CODES, ...VERIFY_REFUSAL_CODES]

const KNOWN: ReadonlySet<string> = new Set(CREATE_REFUSAL_CODES)

/** Whether a code verify answered is one this Worker has a sentence for. */
export function isCreateRefusalCode(code: string): code is CreateRefusalCode {
  return KNOWN.has(code)
}

export interface RefusalContext {
  /** The service's name, as the catalogue gives it (Salesforce), or the key that was sent when none declares it. */
  service: string
  /** Its secret field's label in lower case (client secret, private key), or "login". */
  secret: string
  /** The Salesforce org's address the connection declares, when it is a Salesforce one. */
  org: string | null
  /** The field labels or list entries the refusal is about. */
  names: readonly string[]
  /** The money identity found, for connection_money_identity. */
  money: MoneyTargetKind | null
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'A field'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const isAre = (names: readonly string[]) => (names.length === 1 ? 'is' : 'are')
const itThem = (names: readonly string[]) => (names.length === 1 ? 'it' : 'them')
const orgOf = (ctx: RefusalContext) => ctx.org ?? 'this connection names'

const MONEY_WORDS: Readonly<Record<MoneyTargetKind, string>> = {
  supabase_project: 'Bidspoke\'s own Supabase project',
  salesforce_client_id: 'the Salesforce connected app Bidspoke bids through',
  snowflake_user: 'a Snowflake user Bidspoke\'s bidding signs in as',
}

/** "Tell Dan" closes a sentence about a fault only Dan can fix: the person in the ops team who runs the Workers. */
const SENTENCES: { readonly [C in CreateRefusalCode]: (ctx: RefusalContext) => string } = {
  // ── the route's own ────────────────────────────────────────────────────────
  connection_request_invalid: () => 'The form sent something Bidspoke cannot read. Nothing was saved. Reload the page and try again.',
  connection_service_undeclared: (c) => `Bidspoke cannot connect to ${c.service} yet. Nothing was saved. Choose one of the services the form offers.`,
  connection_name_missing: () => 'The connection has no name. Nothing was saved. Give it a name and save again.',
  connection_name_invalid: () => `The name is longer than ${CONNECTION_NAME_MAX} characters or holds a character a name cannot. Nothing was saved. Shorten the name and save again.`,
  connection_fields_missing: (c) => `${listed(c.names)} ${isAre(c.names)} empty. Nothing was saved. Fill ${itThem(c.names)} in and save again.`,
  connection_fields_undeclared: (c) => `The form sent ${listed(c.names)}, which a ${c.service} connection does not have. Nothing was saved. Reload the page and fill the form in again.`,
  connection_name_reserved: (c) => `That name belongs to Bidspoke's own ${c.service} alert login. Nothing was saved. Choose another name and save again.`,
  connection_name_taken: (c) => `Another ${c.service} connection already has that name. Nothing was saved. Choose another name and save again.`,
  connection_money_identity: (c) => `This is ${c.money ? MONEY_WORDS[c.money] : 'a login Bidspoke\'s bidding uses'}, which a workflow connection may never use. Nothing was saved. Use a login made for workflows.`,
  connection_money_targets_unreadable: () => 'Bidspoke could not check whether this is one of its own bidding logins. Nothing was saved. Save again in a minute.',
  google_subject_not_listed: (c) => `${listed(c.names)} ${isAre(c.names)} not on the company list of mailboxes and drives. Nothing was saved. Add ${itThem(c.names)} to the list on this page, then save again.`,
  google_list_unavailable: () => 'The company list of mailboxes and drives could not be read. Nothing was saved. Save again in a minute.',
  connection_seal_failed: () => 'Bidspoke could not lock the login away for safe keeping. Nothing was saved. Save again, and tell Dan if it keeps happening.',
  connections_unavailable: () => 'Bidspoke\'s database did not answer. Nothing was saved. Save again in a minute.',
  connection_store_failed: () => 'The login worked, but Bidspoke could not store the connection. Nothing was saved. Save again.',
  verify_timed_out: (c) => `The login check with ${c.service} did not finish in time. Nothing was saved. Save again.`,
  verify_refused_unknown: (c) => `The login check with ${c.service} failed for a reason Bidspoke does not know. Nothing was saved. Save again, and tell Dan if it keeps happening.`,

  // ── verify: OpsConnections' own ────────────────────────────────────────────
  ops_connections_request_invalid: () => 'The workflows server could not read the login check Bidspoke sent. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
  lane_unset: () => 'The workflows server is not set up to say which lane it serves. Nothing was saved. Tell Dan.',
  lane_not_ops: () => 'The login check reached a server that is not the workflows server. Nothing was saved. Tell Dan.',
  ops_connections_not_configured: () => 'The workflows server is missing a setting it needs to check logins. Nothing was saved. Tell Dan.',
  ops_connections_timeout: (c) => `The workflows server stopped the check with ${c.service} because it took too long. Nothing was saved. Save again.`,
  ops_connections_failed: (c) => `The login check with ${c.service} failed unexpectedly. Nothing was saved. Save again, and tell Dan if it keeps happening.`,
  money_identity_unavailable: () => 'Bidspoke could not read which Salesforce user it bids as, so it cannot rule this login out. Nothing was saved. Save again in a minute.',
  money_identity_unmeasured: () => 'Bidspoke has no recent reading of which Salesforce user it bids as, so it cannot rule this login out. Nothing was saved. Tell Dan.',
  money_identity_match: () => 'This login signs in as the Salesforce user Bidspoke bids as, which a workflow connection may never use. Nothing was saved. Use a login made for workflows.',
  verify_client_id_mismatch: () => 'The client secret belongs to another connected app than the client id. Nothing was saved. Check both and save again.',
  candidate_not_refreshable: (c) => `A personal ${c.service} login is added by signing in, not with this form. Nothing was saved. Use the sign in button instead.`,
  verify_identity_unmeasurable: (c) => `Bidspoke cannot yet check who a ${c.service} login acts as. Nothing was saved. Tell Dan.`,
  verify_identity_unreadable: (c) => `${c.service} did not say who this login acts as. Nothing was saved. Save again, and tell Dan if it keeps happening.`,
  verify_identity_mismatch: (c) => `${c.service} says this login belongs to another account than the one entered. Nothing was saved. Check the account and save again.`,
  identity_changed: (c) => `${c.service} names another user for this login than it did before. Nothing was saved. Tell Dan before it is used.`,
  measured_identity_unrecorded: () => 'The login worked, but the workflows server could not record who it acts as. Nothing was saved. Save again.',

  // ── verify: connectionFetch's ──────────────────────────────────────────────
  connection_call_invalid: () => 'The workflows server refused the shape of the login check. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
  connection_removed: () => 'This connection was removed while it was being checked. Nothing was saved. Save it again.',
  connection_withdrawn: () => 'The workflows server withdrew this connection while it was being checked. Nothing was saved. Save it again.',
  connection_copy_expired: () => 'The workflows server holds an expired copy under this connection. Nothing was saved. Save again.',
  connection_not_found: () => 'The workflows server found no connection to check. Nothing was saved. Save again.',
  connection_copy_unreadable: () => 'The workflows server\'s database did not answer. Nothing was saved. Save again in a minute.',
  connection_service_unknown: (c) => `The workflows server cannot connect to ${c.service} yet. Nothing was saved. Tell Dan.`,
  connection_service_mismatch: () => 'The workflows server holds another service under this connection. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
  connection_generation_older: () => 'The workflows server holds a newer login under this connection. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
  connection_candidate_not_allowed: () => 'The workflows server would not check a new login in this way. Nothing was saved. Tell Dan, since this is a fault in Bidspoke.',
  connection_seal_refused: () => 'The workflows server could not unlock the login Bidspoke locked. Nothing was saved. Tell Dan, since the two servers\' keys may not match.',
  connection_target_invalid: (c) => `The ${c.service} address entered is not one Bidspoke can use. Nothing was saved. Check the address and save again.`,
  connection_url_invalid: (c) => `The check was sent to an address that is not a secure ${c.service} one. Nothing was saved. Check the address and save again.`,
  connection_host_not_declared: (c) => `${c.service} sent the check to an address this connection does not name. Nothing was saved. Check the address and save again.`,
  sf_pool_busy: () => 'Salesforce is busy with other Bidspoke work. Nothing was saved. Save again in a minute.',
  sf_org_unmeasured: (c) => `Bidspoke has not yet measured the Salesforce org ${orgOf(c)}. Nothing was saved. Save again in a minute.`,
  sf_cap_unset: (c) => `Bidspoke has no approved cap for the Salesforce org ${orgOf(c)}. Nothing was saved. Dan must approve a cap for this org before a connection to it can be saved.`,
  sf_purpose_cap_unset: (c) => `Bidspoke has no approved share for checking logins on the Salesforce org ${orgOf(c)}. Nothing was saved. Dan must approve one for this org before a connection to it can be saved.`,
  sf_budget_floor: (c) => `The Salesforce org ${orgOf(c)} has nearly used up today's API calls. Nothing was saved. Save again tomorrow, or ask Dan.`,
  sf_budget_unmeasured: () => 'Bidspoke has no recent reading of how many Salesforce API calls are left today. Nothing was saved. Save again in a few minutes.',
  sf_lease_unavailable: () => 'The workflows server could not reserve a Salesforce call for the check. Nothing was saved. Save again in a minute.',
  connection_record_failed: () => 'The workflows server could not record the check before sending it. Nothing was saved. Save again.',
  connection_needs_reauth: (c) => `${c.service} refused the ${c.secret}. Nothing was saved. Check the ${c.secret} and save again.`,
  connection_auth_unavailable: (c) => `${c.service} did not answer the sign in. Nothing was saved. Save again in a minute.`,
  connection_not_allowed: (c) => `A Bidspoke rule refused this ${c.service} login before it was tried. Nothing was saved. Check what the connection names and save again.`,
  connection_auth_check_unavailable: () => 'The workflows server could not read the list it checks this login against. Nothing was saved. Save again in a minute.',
  connection_token_object_unavailable: () => 'The workflows server could not reach where it keeps sign ins. Nothing was saved. Save again in a minute.',
  connection_auth_failed: (c) => `The sign in to ${c.service} failed for a reason it did not give. Nothing was saved. Check the login and save again.`,
  connection_network_error: (c) => `Bidspoke could not reach ${c.service}. Nothing was saved. Save again in a minute.`,
  connection_aborted: () => 'The check was stopped before it finished. Nothing was saved. Save again.',
  connection_timeout: (c) => `${c.service} took too long to answer. Nothing was saved. Save again.`,
  connection_body_not_resendable: (c) => `${c.service} needed the check sent twice, which Bidspoke will not do. Nothing was saved. Save again.`,
  connection_rate_limited: (c) => `${c.service} asked Bidspoke to wait. Nothing was saved. Save again in a few minutes.`,

  // ── the binding ────────────────────────────────────────────────────────────
  ops_connections_unavailable: () => 'The workflows server did not answer. Nothing was saved. Save again in a minute.',
}

/** The page's sentence for one refusal. */
export function createRefusalSentence(code: CreateRefusalCode, ctx: RefusalContext): string {
  return SENTENCES[code](ctx)
}
