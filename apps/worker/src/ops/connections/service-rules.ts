/**
 * What connectionFetch needs from each service (#2335, phase 5 of #1689). The
 * catalogue's runtime entries fill these per service as each service arrives
 * (Phase 7); the minters behind `authorize` are a later PR of this phase. Until
 * then nothing supplies rules, so connectionFetch refuses every service by name
 * (connection_service_unknown).
 */
import type { OrganizationId } from '../ops-db'

/** A login once opened. Held only for the one request, and never recorded or thrown. */
export interface OpenedLogin {
  readonly plaintext: string
}

/** What the auth puts on a request. */
export interface Authorization {
  readonly headers: Readonly<Record<string, string>>
  /** Every secret value this put on the request: scrubbed from anything recorded or thrown. */
  readonly secrets: readonly string[]
}

export interface AuthorizeInput {
  readonly organizationId: OrganizationId
  readonly connectionId: string
  readonly service: string
  readonly generation: number
  readonly target: unknown
  readonly publicConfig: unknown
  readonly login: OpenedLogin
  /**
   * A credential bidding has not committed (verify or Reconnect, findings F116
   * and F126). The auth must not keep what it mints under the committed
   * generation, and must not write anything about the connection's health.
   */
  readonly candidate: boolean
  /**
   * Set on the one renewal after the service's expiry signal: mint afresh
   * rather than reuse, and drop a memo entry only if it is still `rejected`
   * itself (compared by identity), so a renewal never evicts a token another
   * caller has just minted.
   */
  readonly renew: { readonly rejected: Authorization } | null
}

export interface ServiceRules {
  /** The catalogue service key: the copy's `service`. */
  readonly service: string
  /**
   * The hosts this connection may reach, from its declared target. Throws when
   * the target lacks a field the service requires; connectionFetch refuses
   * that as connection_target_invalid. Exact hostnames, lower case.
   */
  declaredHosts(target: unknown, publicConfig: unknown): readonly string[]
  /** Present for a Salesforce service: every request then takes a lease from the ops pool. */
  readonly salesforce?: {
    /** The declared instance_url host, which verify's bootstrap slot is keyed on. */
    instanceHost(target: unknown): string
  }
  /**
   * Whether a response is the service's declared expiry signal (a plain 401,
   * or Salesforce's INVALID_SESSION_ID). Given a clone, so it may read the body.
   */
  expired(response: Response): boolean | Promise<boolean>
  /** The beforeRequest auth: mints or reuses a token. Throws LoginMintError by kind. */
  authorize(input: AuthorizeInput): Promise<Authorization>
}
