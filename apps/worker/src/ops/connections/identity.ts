/**
 * What verify measures a credential as (#2335, PR 8 of phase 5 of #1689; plan:
 * discussion #2329, part 2, "the cross lane rule is an allowlist plus a
 * measured identity", L217).
 *
 * A connection's target DECLARES who it is; verify asks the service, through
 * connectionFetch with the connection's own credential, who it really is, and
 * refuses a credential whose measured identity is money's. Salesforce's
 * measurement is here (salesforce-service.ts: /services/oauth2/userinfo, the org
 * id and username). The others the plan names (Snowflake's CURRENT_USER() and
 * account, a Supabase key's project ref, Google's token for the declared
 * mailbox, Slack's auth.test) arrive with each service's rules (Phase 7), each
 * as another kind here; until a service has one, verify refuses it by name
 * (verify_identity_unmeasurable), never passes it unmeasured.
 */

/** What a credential authenticates as, measured. */
export type MeasuredIdentity = { readonly kind: 'salesforce'; readonly sfOrgId: string; readonly username: string }

/** connectionFetch bound to one verify call: a response, or a ConnectionRefusal thrown by name. */
export type BoundFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface IdentityProbe {
  readonly kind: MeasuredIdentity['kind']
  /**
   * Asks the service what the credential authenticates as. Every request goes
   * through `fetch` (connectionFetch). Throws IdentityUnreadable by name when
   * the answer cannot be read; a ConnectionRefusal from `fetch` passes through.
   */
  measure(fetch: BoundFetch, target: unknown, publicConfig: unknown): Promise<MeasuredIdentity>
}

/** The service answered, and what it said is not an identity this code reads. The message names a status or a field, never a value. */
export class IdentityUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityUnreadable'
  }
}

/**
 * Whether a measured Salesforce identity is money's run as user: the same org
 * (compared on the 15 character id, which the 18 character form extends with a
 * checksum of its case) AND the same username (Salesforce usernames are not case
 * sensitive). Another user of money's own org is not money's identity: the ops
 * connection deliberately targets money's org with its own integration user
 * (Dan's decision 5).
 */
export function isMoneySalesforceIdentity(measured: { sfOrgId: string; username: string }, money: { sf_org_id: string; username: string }): boolean {
  return measured.sfOrgId.slice(0, 15) === money.sf_org_id.slice(0, 15)
    && measured.username.trim().toLowerCase() === money.username.trim().toLowerCase()
}
