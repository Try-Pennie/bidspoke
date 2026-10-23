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
 */
import { googleDelegationAuth, type GoogleDelegationDeps } from './minters/google'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import type { OpsServiceEntry } from './ops-connections'

/** Every host an ops Google connection reaches: the token endpoint, then the APIs the catalogue's actions call. */
export const GOOGLE_HOSTS: readonly string[] = ['oauth2.googleapis.com', 'sheets.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com']

/** What verify asks: the mailbox's Gmail profile, which every delegated mailbox may read under gmail.modify. */
export const GOOGLE_VERIFY_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'

export const googleIdentity: IdentityProbe = {
  kind: 'google',
  async measure(fetch, target) {
    const declared = targetString(targetFields(target), 'subject').trim().toLowerCase()
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
    if (address.trim().toLowerCase() !== declared) {
      throw new IdentityMismatch('Google acted as another mailbox than the target declares', 'verify_google_mailbox_mismatch')
    }
    return { kind: 'google', mailbox: declared }
  },
}

export function googleServiceEntry(deps: GoogleDelegationDeps): OpsServiceEntry {
  const minter = googleDelegationAuth(deps)
  return {
    rules: { service: 'google', declaredHosts: () => GOOGLE_HOSTS, ...minter },
    identity: googleIdentity,
  }
}
