/**
 * What verify measures a credential as (#2335, PR 8 of phase 5 of #1689; plan:
 * discussion #2329, part 2, "the cross lane rule is an allowlist plus a
 * measured identity", L217).
 *
 * A connection's target DECLARES who it is; verify asks the service, through
 * connectionFetch with the connection's own credential, who it really is, and
 * refuses a credential whose measured identity is money's. Salesforce's
 * measurement is here (salesforce-service.ts: /services/oauth2/userinfo, the org
 * id and username), and Snowflake's (snowflake-service.ts: CURRENT_USER() and
 * the account, which must be the ones the target declares, #2337). The others
 * the plan names (a Supabase key's project ref, Google's token for the declared
 * mailbox, Slack's auth.test) arrive with each service's rules (Phase 7), each
 * as another kind here; until a service has one, verify refuses it by name
 * (verify_identity_unmeasurable), never passes it unmeasured.
 */

/** What a credential authenticates as, measured. */
export type MeasuredIdentity =
  | { readonly kind: 'salesforce'; readonly sfOrgId: string; readonly username: string }
  | {
      readonly kind: 'snowflake'
      /** CURRENT_ACCOUNT(): the account locator. */
      readonly accountLocator: string
      /** CURRENT_ORGANIZATION_NAME() and CURRENT_ACCOUNT_NAME(), null where Snowflake answers none. */
      readonly organizationName: string | null
      readonly accountName: string | null
      /** CURRENT_USER(). */
      readonly user: string
    }

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
 * The service answered with an identity, and it is not the one the connection's
 * target declares: the credential is somebody else's. The message names fields,
 * never their values.
 */
export class IdentityMismatch extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityMismatch'
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
