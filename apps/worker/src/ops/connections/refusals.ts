/**
 * What connectionFetch answers other than a response (#2335, phase 5 of #1689).
 *
 * A refusal is thrown as a ConnectionRefusal carrying one code per cause (L11),
 * so a caller decides what to do, and what to tell a person, from the code
 * alone. Its message is built here from the code and a detail made only of
 * names: a host, an HTTP method or status, a lease outcome, a seal code. Never
 * a provider's response text, a thrown error's message, a URL's query or a
 * login (finding F120): Workers Logs and the tail trace record an uncaught
 * exception's name and message whatever the console does, so the message is
 * the one thing that must be safe by construction. A refusal carries no
 * `cause` for the same reason.
 *
 * A wait is answered, not thrown: RequeueAt says when to try again (a 429, a
 * Retry-After, a step's lease refusal), and connectionFetch never sleeps on one.
 */
import type { ResourceWaitCause } from '../run-vocabulary'

export const CONNECTION_REFUSAL_CODES = [
  /** The call itself is malformed: an organization that is not a uuid, a step with no workflow, a workflow on a non step. */
  'connection_call_invalid',
  /** The copy's state, as connection_copy judged it on the database's clock. */
  'connection_removed',
  'connection_withdrawn',
  'connection_copy_expired',
  'connection_not_found',
  /** The ops database did not answer the copy read. */
  'connection_copy_unreadable',
  /** No rules for the copy's service on this Worker. */
  'connection_service_unknown',
  /** A candidate names another service than the copy it would replace. */
  'connection_service_mismatch',
  /** A candidate older than the copy ops holds. */
  'connection_generation_older',
  /** A candidate is verify's alone (Reconnect's call is a verify). */
  'connection_candidate_not_allowed',
  /** The envelope did not open: another organization, connection, service, generation or key. */
  'connection_seal_refused',
  /** The service could not read its declared hosts from the connection's target. */
  'connection_target_invalid',
  /** Not an https URL. */
  'connection_url_invalid',
  /** A host outside the connection's declared hosts. */
  'connection_host_not_declared',
  /** The Salesforce pool, refused for an interactive or scheduled call (a step is answered a RequeueAt). */
  'sf_pool_busy',
  'sf_org_unmeasured',
  'sf_cap_unset',
  'sf_purpose_cap_unset',
  'sf_budget_floor',
  'sf_budget_unmeasured',
  /** acquire_sf_lease itself failed. */
  'sf_lease_unavailable',
  /** The sanitised request could not be recorded, so nothing was sent. */
  'connection_record_failed',
  /**
   * The login was refused, the request was refused again after one renewal, or
   * a failing token endpoint held past decision 2's bound.
   */
  'connection_needs_reauth',
  /** The token endpoint timed out or answered 5xx: refresh_failing, not yet needs_reauth (Dan's decision 2). */
  'connection_auth_unavailable',
  /**
   * A rule of ours refused the mint before any token was asked for: a mailbox
   * or drive outside the organization's delegation allowlist (finding F129),
   * no delegation scope declared, a target that does not name what the rule
   * needs. Neither needs_reauth nor a refresh failure: the login is not at fault.
   */
  'connection_not_allowed',
  /** A rule the mint must check first (the delegation allowlist) could not be read. Not a refresh failure. */
  'connection_auth_check_unavailable',
  /**
   * A person bound login's ConnectionTokenObject could not be reached or failed
   * inside (#2335). Our own infrastructure, so neither needs_reauth nor a
   * refresh failure: the login is not at fault.
   */
  'connection_token_object_unavailable',
  /** The auth failed in a way that names no cause it declared. */
  'connection_auth_failed',
  /** The send failed below HTTP. */
  'connection_network_error',
  /** The caller's own signal gave up. */
  'connection_aborted',
  /** connectionFetch's deadline passed. */
  'connection_timeout',
  /** The token expired on a request whose body cannot be sent twice. */
  'connection_body_not_resendable',
  /**
   * The service asked to wait (a 429, or a 503 with Retry-After), answered to a
   * caller that cannot wait (verify, a lookup) rather than a step's RequeueAt;
   * retryAt is the time it named (#2335, PR 8).
   */
  'connection_rate_limited',
] as const
export type ConnectionRefusalCode = (typeof CONNECTION_REFUSAL_CODES)[number]

export class ConnectionRefusal extends Error {
  readonly code: ConnectionRefusalCode
  /** When the answer can change, where the refusal knows it (a pool's soonest lapse). */
  readonly retryAt: Date | null
  /**
   * For a refusal a minter caused, its reason from MINT_FAILURE_REASONS (a name
   * from a closed set, never a provider's text), so verify can tell a sealed
   * client id that is not the declared one, or a person bound candidate, from
   * any other refused login (#2335, PR 8). Null otherwise.
   */
  readonly mintReason: MintFailureReason | null

  constructor(code: ConnectionRefusalCode, detail: string, retryAt: Date | null = null, mintReason: MintFailureReason | null = null) {
    super(`${code}: ${detail}`)
    this.name = 'ConnectionRefusal'
    this.code = code
    this.retryAt = retryAt
    this.mintReason = mintReason
  }
}

/**
 * Why a request is to be tried again later: a rate limit, or a step's lease
 * refusal under the pool's own name, which is exactly a resource_wait cause.
 */
export type RequeueCause = 'rate_limited' | ResourceWaitCause

/** Try again at notBefore. Answered, never thrown, and never slept on. */
export class RequeueAt {
  readonly kind = 'requeue_at' as const

  constructor(readonly notBefore: Date, readonly cause: RequeueCause) {}
}

/**
 * How a mint failed, and so what connectionFetch does (Dan's decision 2, F129):
 *   refused            the provider refused the login (invalid_grant,
 *                      invalid_client), or the login cannot be used as stored:
 *                      needs_reauth at once
 *   unavailable        the token endpoint timed out, could not be reached,
 *                      answered 5xx or an edge page: refresh_failing, and
 *                      needs_reauth only past the bound record_connection_refresh
 *                      holds
 *   rate_limited       the token endpoint answered 429: a RequeueAt at retryAt
 *   not_allowed        a rule of ours refused the mint (F129): refused by name,
 *                      nothing recorded about the login
 *   check_unavailable  a rule the mint must check could not be read: refused by
 *                      name, nothing recorded about the login
 *   token_object_unavailable  a person bound login's ConnectionTokenObject could
 *                      not be reached, or failed inside (#2335): refused by name,
 *                      nothing recorded about the login
 */
export const LOGIN_MINT_KINDS = ['refused', 'unavailable', 'rate_limited', 'not_allowed', 'check_unavailable', 'token_object_unavailable'] as const
export type LoginMintKind = (typeof LOGIN_MINT_KINDS)[number]

/**
 * Why, one closed set of names. A provider's own error code is mapped onto one
 * of these, never carried as text, so nothing a provider says rides out on a
 * LoginMintError (F120).
 */
export const MINT_FAILURE_REASONS = {
  refused: [
    'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope', 'access_denied', 'login_refused',
    /** The stored login lacks a field the minter needs, or a key does not import. */
    'login_malformed',
    /** A Salesforce login whose client id is not the one the target declares. */
    'client_id_mismatch',
    /** A Google service account key whose token_uri is not Google's. */
    'token_uri_unexpected',
    /** The token endpoint answered a redirect: the connection names the wrong address. */
    'token_endpoint_redirected',
    /** A person bound code exchange answered no refresh token, so the login would die within the hour (#2335). */
    'refresh_token_missing',
  ],
  unavailable: ['token_endpoint_timeout', 'token_endpoint_unreachable', 'token_endpoint_5xx', 'token_endpoint_edge_page', 'token_response_malformed'],
  rate_limited: ['token_endpoint_rate_limited'],
  not_allowed: [
    'mailbox_not_allowed', 'drive_not_allowed', 'no_delegation_scopes', 'target_invalid',
    /**
     * A person bound login offered as a candidate (verify, Reconnect): refreshing
     * it for one call and dropping the answer would spend a rotating refresh
     * token (L5), so a person bound credential is proven by its code exchange.
     */
    'candidate_not_refreshable',
    /**
     * A minter's token request named a URL connectionFetch would not send a
     * request to: not https, a host the connection does not declare, a port or
     * credentials in the URL (#2337). Nothing was sent.
     */
    'token_host_not_declared',
  ],
  check_unavailable: ['delegation_allowlist_unreadable'],
  token_object_unavailable: [
    /** The object could not be reached, or answered in a shape this code does not read. */
    'token_object_unavailable',
    /** The object answered that its request was malformed or named another connection. */
    'token_object_refused',
    /** The object failed inside, after the token endpoint answered or before it was asked. */
    'token_object_failed',
  ],
} as const satisfies Record<LoginMintKind, readonly string[]>
export type MintFailureReason<K extends LoginMintKind = LoginMintKind> = (typeof MINT_FAILURE_REASONS)[K][number]

/**
 * What a minter throws. kind is what connectionFetch acts on and reason is the
 * name it records; the message is made of those two alone, so it is safe by
 * construction (F120), and connectionFetch still never forwards it.
 */
export class LoginMintError<K extends LoginMintKind = LoginMintKind> extends Error {
  readonly kind: K
  readonly reason: MintFailureReason<K>
  /** For rate_limited: when the token endpoint said to come back, if it did. */
  readonly retryAt: Date | null

  constructor(kind: K, reason: MintFailureReason<K>, retryAt: Date | null = null) {
    super(`${kind}: ${reason}`)
    this.name = 'LoginMintError'
    this.kind = kind
    this.reason = reason
    this.retryAt = retryAt
  }
}
