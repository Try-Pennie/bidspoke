/**
 * What connectionFetch needs from each service (#2335, phase 5 of #1689). The
 * catalogue's runtime entries fill these per service as each service arrives
 * (Phase 7), each taking its `authorize` and `expired` from one of the minters
 * in ./minters (MinterRules) and adding its declared hosts. Until then nothing
 * supplies rules, so connectionFetch refuses every service by name
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
  /**
   * The sealed envelope connectionFetch opened into `login`: ciphertext only. A
   * person bound login hands it to its ConnectionTokenObject (#2335), which
   * opens it itself, so no plaintext crosses into the object.
   */
  readonly envelope: unknown
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
  /**
   * Called by the auth when it asked a token endpoint and was answered a token
   * (not when it reused one, signed one locally or read a static key), so
   * connectionFetch can end a refresh streak (Dan's decision 2). The minters'
   * shared memo helper calls it, so no minter has to remember to.
   */
  readonly noteMint: () => void
  /**
   * The one fetch a minter may ask its token endpoint with (#2337): connectionFetch's
   * own, which sends only to an https URL on one of the connection's declared
   * hosts, on port 443 with no credentials in the URL, and never follows a
   * redirect. Anything else is refused before it is sent, as a LoginMintError
   * (not_allowed, token_host_not_declared). So the platform's fetch is reached
   * by connectionFetch alone, the token request included (the guard
   * ops-connection-requests-through-fetch.test.ts), and no minter holds a fetch
   * of its own.
   */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
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

/** What a minter supplies: the auth, the expiry signal it answers, and for Salesforce the instance host. */
export type MinterRules = Pick<ServiceRules, 'authorize' | 'expired' | 'salesforce'>
