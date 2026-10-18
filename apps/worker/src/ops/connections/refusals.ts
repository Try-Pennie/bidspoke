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
  /** A candidate is verify's and Reconnect's alone. */
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
  /** The login was refused, or the request was refused again after one renewal. */
  'connection_needs_reauth',
  /** The token endpoint timed out or answered 5xx. Not needs_reauth (Dan's decision 2). */
  'connection_auth_unavailable',
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
] as const
export type ConnectionRefusalCode = (typeof CONNECTION_REFUSAL_CODES)[number]

export class ConnectionRefusal extends Error {
  readonly code: ConnectionRefusalCode
  /** When the answer can change, where the refusal knows it (a pool's soonest lapse). */
  readonly retryAt: Date | null

  constructor(code: ConnectionRefusalCode, detail: string, retryAt: Date | null = null) {
    super(`${code}: ${detail}`)
    this.name = 'ConnectionRefusal'
    this.code = code
    this.retryAt = retryAt
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
 * What a minter throws (the minters arrive in a later PR of phase 5). kind is
 * the whole of what connectionFetch reads; the message is never forwarded.
 *   refused       the provider refused the login (invalid_grant, invalid_client): needs_reauth at once
 *   unavailable   the token endpoint timed out or answered 5xx: not needs_reauth
 *   rate_limited  the token endpoint answered 429: a RequeueAt at retryAt
 */
export class LoginMintError extends Error {
  constructor(readonly kind: 'refused' | 'unavailable' | 'rate_limited', message: string, readonly retryAt: Date | null = null) {
    super(message)
    this.name = 'LoginMintError'
  }
}
