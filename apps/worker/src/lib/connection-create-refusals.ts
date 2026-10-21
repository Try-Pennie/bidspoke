/**
 * What the Add connection form says when a save is refused (#2338, build PR 5;
 * R14, D14): one plain sentence per refusal code, in this one place, which the
 * create route answers as the refusal's message and the page shows as it is
 * (build PR 10). Each says what failed, that nothing was saved, and what to do,
 * as the settled design does: "Salesforce refused the client secret. Nothing
 * was saved. Check the secret and save again."
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
  // Dan's words, design round 33 (2026-10-21): what is missing and what happens next, in the person's terms.
  sf_cap_unset: (c) => `Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to ${c.org ?? 'the org this connection names'}, so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.`,
  sf_purpose_cap_unset: (c) => `Bidspoke has no approved share for checking logins on the Salesforce org ${orgOf(c)}. Nothing was saved. Dan must approve one for this org before a connection to it can be saved.`,
  sf_budget_floor: (c) => `The Salesforce org ${orgOf(c)} has nearly used up today's API calls. Nothing was saved. Save again tomorrow, or ask Dan.`,
  sf_budget_unmeasured: () => 'Bidspoke has no recent reading of how many Salesforce API calls are left today. Nothing was saved. Save again in a few minutes.',
  sf_lease_unavailable: () => 'The workflows server could not reserve a Salesforce call for the check. Nothing was saved. Save again in a minute.',
  connection_record_failed: () => 'The workflows server could not record the check before sending it. Nothing was saved. Save again.',
  // The design's sentence (D14): the secret is named once, then "the secret" (L605); a service with no secret says its login.
  connection_needs_reauth: (c) => `${c.service} refused the ${c.secret}. Nothing was saved. Check the ${c.secret === 'login' ? 'login' : 'secret'} and save again.`,
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

// ── the Reconnect, Remove and Google list routes (#2338, build PR 6) ──────────

/**
 * The refusals, and the one notice, of POST /:id/reconnect, DELETE /:id and the
 * Google mailboxes and drives list routes (R9, R10, R19, R21), in this same
 * module so every sentence the Connections page shows has one home. A
 * Reconnect that sends a new login is checked by verify exactly as a save is,
 * so its verify refusals are the create's and read through
 * createRefusalSentence; these are the codes only these routes answer, and the
 * ops refusals they pass on that verify never answers (NOT_VERIFY_REFUSALS but
 * health's, the lookups' and revoke's, whose failure is the notice below).
 */
export const CONNECTION_ROUTE_REFUSAL_CODES = [
  /** No connection of that id in the caller's organization: another organization's reads the same. */
  'connection_not_found',
  /** The Slack alert login (not an ops connection), which the Integrations page reconnects and removes. */
  'connection_not_reconnectable',
  'connection_not_removable',
  /** A Reconnect sent a value for what the connection names (an org, a client id, an account). */
  'reconnect_target_changed',
  /** What the stored row names cannot be read back into the form's fields. */
  'reconnect_target_unreadable',
  /** The stored login could not be read, so a Reconnect without a new one has nothing to check. */
  'reconnect_login_unreadable',
  /** The compare and set lost: the row moved on while the new login was checked (F116). */
  'reconnect_stale',
  /** The compare and set did not answer, so whether it wrote is unknown. */
  'reconnect_unconfirmed',
  /** The new login is committed, and clearReauth then failed. */
  'reconnect_saved_check_not_cleared',
  /** A Reconnect without a new login passed its check, and ops could not record the clearing. */
  'reauth_clear_unrecorded',
  /** A workflow references the connection (connection_references, deleted ones included). */
  'connection_in_use',
  /** The removal did not answer, so whether it wrote is unknown. */
  'connection_remove_unconfirmed',
  /** Not a refusal: the removal stands, and revoke did not reach ops. */
  'connection_removed_ops_not_told',
  'delegation_subject_invalid',
  'delegation_display_name_invalid',
  'delegation_subject_listed_elsewhere',
  'delegation_subject_not_listed',
  /** A saved connection of the organization names the entry, so it stays on the list (Dan, 2026-10-20). */
  'delegation_subject_in_use',
  /** The connections could not be read, so whether one names the entry is unknown: nothing is removed. */
  'delegation_use_unreadable',
  'delegation_change_failed',
  'delegation_list_unavailable',
  /** Ops refused the change for a reason that is a fault in Bidspoke (its lane, its settings, the request's shape). */
  'delegation_change_refused',
] as const
export type ConnectionRouteRefusalCode = (typeof CONNECTION_ROUTE_REFUSAL_CODES)[number]

export interface RouteRefusalContext {
  /** The service's name, as the catalogue gives it, or "the service". */
  service: string
  /** Its secret field's label in lower case, or "login". */
  secret: string
  /** The workflows, field labels or list entries the sentence is about. */
  names: readonly string[]
  /** Whether a workflow named is soft deleted (connection_in_use). */
  deleted: boolean
  /** The list entry the sentence is about (delegation_subject_in_use). */
  subject?: string
}

const one = (c: RouteRefusalContext, fallback: string) => c.names[0] ?? fallback

const ROUTE_SENTENCES: { readonly [C in ConnectionRouteRefusalCode]: (ctx: RouteRefusalContext) => string } = {
  connection_not_found: () => 'There is no such connection in your organization. Nothing was changed. Reload the page.',
  connection_not_reconnectable: () => 'This is Bidspoke\'s own Slack alert login, which is reconnected on the Integrations page, not here. Nothing was changed.',
  connection_not_removable: () => 'This is Bidspoke\'s own Slack alert login, which is disconnected on the Integrations page, not here. Nothing was removed.',
  reconnect_target_changed: (c) => `A Reconnect keeps what the connection names, so ${listed(c.names)} cannot change here. Nothing was saved. To use another, add a new connection.`,
  reconnect_target_unreadable: () => 'Bidspoke cannot read back what this connection names, so it cannot be reconnected. Nothing was saved. Tell Dan.',
  reconnect_login_unreadable: (c) => `Bidspoke cannot read this connection's stored login, so there is nothing to check. Nothing was changed. Reconnect with a new ${c.secret}.`,
  reconnect_stale: () => 'Someone else changed this connection\'s login while yours was being checked. Nothing was saved. Reload the page, and reconnect again if it still needs it.',
  reconnect_unconfirmed: (c) => `Bidspoke could not confirm whether the new ${c.secret} was saved. Reload the page to see, and reconnect again if it still needs it.`,
  reconnect_saved_check_not_cleared: (c) =>
    `The new ${c.secret} is saved, and workflows use it within a minute, but the workflows server could not record that its check passed, so a Needs reconnecting status stays until it does. Reconnect again to clear it.`,
  reauth_clear_unrecorded: () => 'The login check passed, but the workflows server could not record it, so the connection keeps its status. Nothing was changed. Reconnect again in a minute.',
  connection_in_use: (c) => {
    const many = c.names.length > 1
    return `${listed(c.names)} ${many ? 'use' : 'uses'} this connection, so it cannot be removed. Nothing was removed. Take it out of ${many ? 'each of them' : 'that workflow'} first${c.deleted ? ', and ask Dan about a deleted one' : ''}.`
  },
  connection_remove_unconfirmed: () => 'Bidspoke could not confirm whether the connection was removed. Reload the page to see, and remove it again if it is still there.',
  connection_removed_ops_not_told: () =>
    'The connection is removed. The workflows server could not be told straight away, so it stops using the login at its next minute check, and within 6 hours at the latest if it cannot reach Bidspoke.',
  delegation_subject_invalid: (c) => `${one(c, 'That entry')} is not one mailbox address or one shared drive id. Nothing was added. Check it and add it again.`,
  delegation_display_name_invalid: () => 'A shared drive\'s name must be 1 to 200 characters, and a mailbox takes none. Nothing was added. Check the name and add it again.',
  delegation_subject_listed_elsewhere: (c) => `${one(c, 'That entry')} is on another organization's list. Nothing was added. Tell Dan if this organization should use it.`,
  delegation_subject_not_listed: (c) => `${one(c, 'That entry')} is not on the list. Nothing was removed. Reload the list.`,
  delegation_subject_in_use: (c) => {
    const many = c.names.length > 1
    return `${listed(c.names)} ${many ? 'act' : 'acts'} as ${c.subject ?? 'it'}, so it cannot be taken off the list. Nothing was removed. Remove ${many ? 'those connections' : 'that connection'} first.`
  },
  delegation_use_unreadable: () => 'Bidspoke could not read which connections act as it, so it stays on the list. Nothing was removed. Try again in a minute.',
  delegation_change_failed: () => 'Bidspoke could not confirm the change to the list. Reload the list to see whether it was made.',
  delegation_list_unavailable: () => 'The company list of mailboxes and drives could not be read. Nothing was changed. Try again in a minute.',
  delegation_change_refused: () => 'The workflows server would not make the change to the list. Nothing was changed. Tell Dan, since this is a fault in Bidspoke.',
}

/** The page's sentence for one of the Reconnect, Remove or Google list routes' own refusals. */
export function connectionRouteSentence(code: ConnectionRouteRefusalCode, ctx: RouteRefusalContext): string {
  return ROUTE_SENTENCES[code](ctx)
}
