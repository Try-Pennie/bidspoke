/**
 * The ops Google service as OpsConnections uses it (#2337, phase 7 of #1689):
 * a company mailbox on the organization's list (google_delegation_subjects),
 * acted as by the ops service account through domain wide delegation (Dan's
 * decision 11). Registered in services.ts, built per request with the ops
 * database's delegation check and the ops Worker's key (opsServiceRegistry).
 *
 * The minter is minters/google.ts: before any token is minted or reused, the
 * mailbox and drives the target declares are checked against the
 * organization's list (F129); the scopes asked for are the union of what the
 * catalogue's Google actions declare; the key is the ops Worker's
 * GOOGLE_DELEGATION_KEY, never the connection's login, which is empty. The
 * target is `{ subject: "<mailbox>", drives?: [...] }`.
 *
 * THE HOSTS. The token grant goes through connectionFetch's own fetch, so the
 * entry declares Google's token host beside every API host the catalogue's
 * Google actions call: Sheets, Gmail, and www.googleapis.com for Drive and
 * Calendar.
 *
 * WHAT VERIFY MEASURES, AND WHY NOTHING IS RECORDED. Gmail's profile
 * (users/me/profile), asked as the mailbox: a 200 proves the delegation grant
 * lets the account act as it with the catalogue's scopes, and its emailAddress
 * must be the declared mailbox, or verify refuses it as
 * verify_google_mailbox_mismatch (an alias resolves to its owner, whom the list
 * does not name). Another mailbox needs a new target, which is a new
 * generation, so nothing is kept about it.
 *
 * MONEY. The bidding Worker holds no Google login, so there is no money
 * identity to refuse.
 *
 * A PERSON'S OWN ACCOUNT (#2338, build PR 13; R17, "My own Google account,
 * Signed in as you"). The same service, so the same tile, list group and
 * actions, signed in another way: the person's own consent through Sign in
 * with Google, an OAuth user login (minters/oauth-user.ts) kept by the
 * connection's ConnectionTokenObject. Its target is `{ own_account: true }`
 * (GOOGLE_OWN_ACCOUNT_TARGET), which the bidding Worker writes only when it
 * saves a sign in, and the entry chooses the minter by it: an own account goes
 * to its token object, never through the company list or the delegation key,
 * and a company mailbox never reaches a token object. Its sealed login is the
 * sign in app's client id and the person's refresh token; the app's secret is
 * the ops Worker's own (oauth-apps.ts). It is proven by its code exchange, so a
 * candidate of it is never verified (verify refuses candidate_not_refreshable),
 * while verify and the connection check of its committed copy read the Gmail
 * profile as for a mailbox, naming whom it acts as with no list to compare
 * against: a refresh token is bound to the one account that consented. Its
 * token request goes to Google's token endpoint, oauth2.googleapis.com, a host
 * the entry declares (#2337).
 */
import { GOOGLE_OWN_ACCOUNT_TARGET, isOwnAccountTarget } from '@bidspoke/service-catalogue/schema'
import { GOOGLE_TOKEN_URI, googleDelegationAuth, type GoogleDelegationDeps } from './minters/google'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import { oauthUserAuth, type OAuthUserCache, type OAuthUserService, type TokenObjects } from './minters/oauth-user'
import type { OpsServiceEntry } from './ops-connections'

/** Every host an ops Google connection reaches: the token endpoint, then the APIs the catalogue's actions call. */
export const GOOGLE_HOSTS: readonly string[] = ['oauth2.googleapis.com', 'sheets.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com']

/** What verify asks: the mailbox's Gmail profile, which every delegated mailbox may read under gmail.modify. */
export const GOOGLE_VERIFY_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'

// The target of a connection signed in with a person's own Google account (#2338), in the catalogue, the one home both Workers read.
export { GOOGLE_OWN_ACCOUNT_TARGET, isOwnAccountTarget }

/** A person's own Google account as a person bound service: Google's token endpoint, the 401 Google answers an expired token with. */
export const googleOwnAccount: OAuthUserService = {
  tokenUrl: () => GOOGLE_TOKEN_URI,
  expired: (response) => response.status === 401,
  covers: isOwnAccountTarget,
}

export const googleIdentity: IdentityProbe = {
  kind: 'google',
  async measure(fetch, target) {
    // A person's own account names no mailbox to compare against: its refresh token is bound to the account that consented.
    const declared = isOwnAccountTarget(target) ? null : targetString(targetFields(target), 'subject').trim().toLowerCase()
    const response = await fetch(GOOGLE_VERIFY_URL, { method: 'GET', headers: { accept: 'application/json' } })
    // Its status only: never Google's body.
    if (!response.ok) throw new IdentityUnreadable(`the Gmail profile answered HTTP ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new IdentityUnreadable('the Gmail profile answered a body that is not JSON')
    }
    const address = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).emailAddress : undefined
    if (typeof address !== 'string' || address.trim() === '') throw new IdentityUnreadable('the Gmail profile named no address')
    const measured = address.trim().toLowerCase()
    if (declared !== null && measured !== declared) {
      throw new IdentityMismatch('Google acted as another mailbox than the target declares', 'verify_google_mailbox_mismatch')
    }
    return { kind: 'google', mailbox: measured }
  },
}

export interface GoogleServiceDeps extends GoogleDelegationDeps {
  /** The ops Worker's CONNECTION_TOKENS: a person's own account's token objects. */
  tokens: TokenObjects
  /** The person bound memo and token ids, kept for the isolate's life by the registry (services.ts). */
  ownAccountCache?: OAuthUserCache
}

export function googleServiceEntry(deps: GoogleServiceDeps): OpsServiceEntry {
  const delegation = googleDelegationAuth(deps)
  const ownAccount = oauthUserAuth({ tokens: deps.tokens, now: deps.now, cache: deps.ownAccountCache }, googleOwnAccount)
  return {
    rules: {
      service: 'google',
      declaredHosts: () => GOOGLE_HOSTS,
      // Both answer an expired token with 401.
      expired: (response) => response.status === 401,
      // The target chooses the minter: a person's own account never meets the company list or the delegation key.
      authorize: (input) => (isOwnAccountTarget(input.target) ? ownAccount.authorize(input) : delegation.authorize(input)),
    },
    identity: googleIdentity,
    oauthUser: googleOwnAccount,
  }
}
