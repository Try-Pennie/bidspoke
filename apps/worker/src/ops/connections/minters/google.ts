/**
 * The Google domain wide delegation minter (#2335, PR 4 of phase 5; finding
 * F129; Dan's decision 11).
 *
 * The ops service account may act as ANY mailbox in the Workspace for the
 * scopes the admin granted, and decision 11 granted broad ones. So on every
 * authorize, before a token is minted OR reused, the connection's mailbox and
 * shared drives are checked against the organization's own allowlist
 * (google_delegation_check on the ops database; entries are added by
 * signed-in users of the organization through the Connections page, #2338,
 * every change audited with who made it and when, and until that page exists
 * the table has no write path). A subject outside it is refused by name
 * (connection_not_allowed: mailbox_not_allowed or drive_not_allowed), and no
 * token is asked for. Checking before the memo means a subject taken off the
 * list stops at once, not when a held token runs out. An allowlist that cannot
 * be read refuses the call too (check_unavailable), never lets it through.
 *
 * The scopes asked for are derived from the catalogue (googleDelegationScopes:
 * the union of what its Google actions declare), never written here: since
 * #2337 shipped them, the four the grant names. A catalogue declaring none
 * would leave the list empty, and every mint refused (no_delegation_scopes).
 *
 * The mint: a JWT with iss the service account's client_email, sub the
 * mailbox, the space joined scope and aud Google's token URI, signed RS256 with
 * the account's key (lib/snowflake.ts signRs256Jwt, the shared signer), then a
 * jwt-bearer grant POSTed to that URI. A key naming any other token_uri is
 * refused, so the signed assertion is never sent elsewhere. The grant goes
 * through connectionFetch's own fetch (AuthorizeInput.fetch, #2337), which
 * sends only to the connection's declared hosts, so a Google service's entry
 * must declare oauth2.googleapis.com beside the API host it calls.
 *
 * THE KEY is the service account key JSON Google issues ({ client_email,
 * private_key, token_uri, ... }), held as the ops Worker's own secret
 * (GOOGLE_DELEGATION_KEY, read through deps.serviceAccountKey, #2337), never in
 * a connection's sealed login: the key can act as anyone in the Workspace, so
 * it is not handed to whoever adds a connection, and the settled Connections
 * form asks only for the mailbox (D16). A Google connection's sealed login is
 * empty and is never read. A key unset, unreadable, unable to sign or naming
 * another token_uri is refused by rule (connection_not_allowed:
 * delegation_key_unset or delegation_key_malformed), nothing sent and nothing
 * recorded against the connection, which is not at fault.
 *
 * The target is `{ subject: "<mailbox>", drives?: ["<shared drive id>", ...] }`. Memoised per connection, generation,
 * mailbox and scope list (two mailboxes never share a token), until Google's
 * expires_in less GOOGLE_REUSE_MARGIN_MS.
 */
import { CATALOGUE, googleDelegationScopes, type ServiceSchema } from '@bidspoke/service-catalogue/schema'
import { importPrivateKey, signRs256Jwt } from '../../../lib/snowflake'
import { TokenMemo } from '../../../lib/token-memo'
import type { OrganizationId } from '../../ops-db'
import type { DelegationCheckOutcome } from '../../run-vocabulary'
import { LoginMintError } from '../refusals'
import type { Authorization, AuthorizeInput, MinterRules } from '../service-rules'
import { authorizeThroughMemo } from './memo-authorize'
import { targetFields, targetString } from './login-fields'
import { readAccessToken, requestToken, type MinterClockDeps } from './token-endpoint'

export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
export const GOOGLE_ASSERTION_LIFETIME_SECONDS = 3600
export const GOOGLE_REUSE_MARGIN_MS = 5 * 60_000
/** google_delegation_check takes at most this many drives. */
export const MAX_DECLARED_DRIVES = 100

const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface GoogleDelegationDeps extends MinterClockDeps {
  /** google_delegation_check (ops-writes.ts googleDelegationCheck), bound to the ops client. */
  checkDelegation(organizationId: OrganizationId, mailbox: string, drives: readonly string[]): Promise<DelegationCheckOutcome>
  /** The catalogue the scopes are derived from. The shipped one unless a test passes its own. */
  catalogue?: readonly ServiceSchema[]
  /** The service account key JSON, the ops Worker's GOOGLE_DELEGATION_KEY; undefined when it is unset. */
  serviceAccountKey(): string | undefined
  /**
   * The isolate's token memo. The live registry passes one memo kept for the
   * isolate's life, since the entry is built per request; a test passes none
   * and gets its own.
   */
  memo?: TokenMemo<Authorization>
}

/** The ops Worker's key, read as Google issues it, or a refusal by rule. */
function keyOf(raw: string | undefined): { clientEmail: string; pem: string } {
  if (raw === undefined || raw.trim() === '') throw new LoginMintError('not_allowed', 'delegation_key_unset')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new LoginMintError('not_allowed', 'delegation_key_malformed')
  }
  const key = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  const tokenUri = Object.hasOwn(key, 'token_uri') ? key.token_uri : GOOGLE_TOKEN_URI
  if (typeof key.client_email !== 'string' || key.client_email === '' || typeof key.private_key !== 'string' || tokenUri !== GOOGLE_TOKEN_URI) {
    throw new LoginMintError('not_allowed', 'delegation_key_malformed')
  }
  return { clientEmail: key.client_email, pem: key.private_key }
}

/** The declared mailbox, lower case, and drives, or target_invalid. */
function subjectsOf(target: unknown): { mailbox: string; drives: string[] } {
  const fields = targetFields(target)
  const mailbox = targetString(fields, 'subject').trim().toLowerCase()
  if (!MAILBOX.test(mailbox)) throw new LoginMintError('not_allowed', 'target_invalid')
  const raw = Object.hasOwn(fields, 'drives') ? fields.drives : undefined
  if (raw === undefined) return { mailbox, drives: [] }
  if (!Array.isArray(raw) || raw.length > MAX_DECLARED_DRIVES || !raw.every((d): d is string => typeof d === 'string' && d !== '')) {
    throw new LoginMintError('not_allowed', 'target_invalid')
  }
  return { mailbox, drives: [...raw] }
}

/** A token memo for Google, for the registry to keep for the isolate's life. */
export function googleTokenMemo(deps: MinterClockDeps): TokenMemo<Authorization> {
  return new TokenMemo<Authorization>({ now: () => deps.now(), reuseMarginMs: GOOGLE_REUSE_MARGIN_MS })
}

export function googleDelegationAuth(deps: GoogleDelegationDeps): MinterRules {
  const scope = googleDelegationScopes(deps.catalogue ?? CATALOGUE).join(' ')
  const memo = deps.memo ?? googleTokenMemo(deps)
  return {
    expired: (response) => response.status === 401,
    authorize: async (input: AuthorizeInput): Promise<Authorization> => {
      const { mailbox, drives } = subjectsOf(input.target)
      if (scope === '') throw new LoginMintError('not_allowed', 'no_delegation_scopes')

      // F129: the organization's allowlist, before any token is minted or reused.
      let allowed: DelegationCheckOutcome
      try {
        allowed = await deps.checkDelegation(input.organizationId, mailbox, drives)
      } catch {
        throw new LoginMintError('check_unavailable', 'delegation_allowlist_unreadable')
      }
      if (allowed !== 'allowed') throw new LoginMintError('not_allowed', allowed)

      // The ops Worker's key, never the connection's login (above).
      const { clientEmail, pem } = keyOf(deps.serviceAccountKey())

      const key = { connectionId: input.connectionId, generation: input.generation, sub: mailbox, scope }
      return authorizeThroughMemo(memo, key, input, async (nowMs) => {
        let privateKey: CryptoKey
        try {
          privateKey = await importPrivateKey(pem)
        } catch {
          throw new LoginMintError('not_allowed', 'delegation_key_malformed')
        }
        const iat = Math.floor(nowMs / 1000)
        const assertion = await signRs256Jwt(privateKey, {
          iss: clientEmail, sub: mailbox, scope, aud: GOOGLE_TOKEN_URI, iat, exp: iat + GOOGLE_ASSERTION_LIFETIME_SECONDS,
        })
        // connectionFetch's fetch (AuthorizeInput.fetch, #2337): the minter holds none of its own.
        const json = await requestToken({ ...deps, fetch: input.fetch }, GOOGLE_TOKEN_URI, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }))
        const token = readAccessToken(json)
        const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : GOOGLE_ASSERTION_LIFETIME_SECONDS
        return { value: { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, expiresAtMs: nowMs + expiresIn * 1000 }
      }, { asksTokenEndpoint: true, now: () => deps.now() })
    },
  }
}
